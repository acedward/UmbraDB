/* eslint-disable @typescript-eslint/no-explicit-any */
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { jsonLog } from "../../wallet-monitor/log.js";
import { countedEffects, decodeTransactionActions } from "./decode.js";
import { lookupEventsFor, type EventSource, type LookupPair } from "./events.js";
import { applyMint, upsertContract } from "./fold.js";
import { readDecodeCursor, writeDecodeCursor, type DecodeCursor } from "./store.js";

/**
 * Project 00020 — the mint & deploy scanner (spec §6.3, FR-001/FR-003/FR-014).
 *
 * Reads the archive this repo already fills, in `(block_height, position)` order, decodes each
 * transaction's own bytes with ledger-v9, and writes every row it produces **together with the
 * cursor in one database transaction** — which is the whole of the crash-safety argument: a
 * `kill -9` at any point leaves the archive's cursor exactly where the last committed rows end, so
 * a restart neither duplicates nor skips.
 *
 * ── The archive is the only source of facts ────────────────────────────────────────────────────
 * Blocks, raw transaction bytes, the transaction result and its per-segment outcomes all come from
 * `chain_archive.*`. The indexer is consulted for ONE thing only — the contents of contract events,
 * which are not in the transaction at all (spec §6.5) — and only for calls whose transcripts
 * contain `log` ops.
 *
 * ── A transaction whose result is unknown ──────────────────────────────────────────────────────
 * `chain_archive.transactions.result` was never written before this project (spec FR-002), so an
 * archive filled by an older sync has NULLs. The scanner refuses to count a mint it cannot prove
 * applied, and therefore BLOCKS on such a transaction rather than guessing or skipping: the cursor
 * stays put, `/internal/status` shows why, and `serve`'s backfill drain fills the row. Blocking is
 * bounded — after {@link UNKNOWN_RESULT_GRACE_MS} of wall time on the same transaction the scanner
 * gives up on it, counts it in `skippedUnknownResult` and moves on, so a transaction the indexer
 * can never resolve (a bridge-claim transaction, say) cannot wedge the pipeline. Recorded as
 * question Q33.
 */

/** How long the scanner waits for a transaction's result to be backfilled before skipping it. */
export const UNKNOWN_RESULT_GRACE_MS = 120_000;

export interface ArchivedTransactionRow {
  txHash: string;
  blockHeight: number;
  position: number;
  kind: "regular" | "system";
  result: "success" | "partial_success" | "failure" | null;
  segments: { id: number; success: boolean }[] | null;
  raw: Buffer;
}

export interface ScanBatchOutcome {
  transactionsScanned: number;
  deploys: number;
  calls: number;
  mints: number;
  lookups: number;
  lookupsShort: number;
  eventsApplied: number;
  eventsRejected: number;
  skippedUnknownResult: number;
  cursor: DecodeCursor;
  /** No more archived transactions past the cursor — the scanner is at the archive tip. */
  atTip: boolean;
  /** Set when the batch stopped early waiting for a transaction's result to be backfilled. */
  waitingForResult: { txHash: string; blockHeight: number } | undefined;
}

export interface ScannerOptions {
  sql: UmbraDBSql;
  schema: string;
  archiveSchema: string;
  net: string;
  /** Injected so the walk is testable and so the node-direct source of owner decision Q3 can
   *  replace it without touching the scanner. */
  eventSource: EventSource;
  /** The loaded ledger module (`loadLedgerV9()`), injected for the same reason. */
  ledger: any;
  batchSize?: number;
  /** Test seam. */
  now?: () => number;
}

export class TokenScanner {
  private readonly opts: Required<Pick<ScannerOptions, "batchSize" | "now">> & ScannerOptions;
  /** When the scanner first saw the transaction it is currently blocked on. */
  private waitingSince: { txHash: string; since: number } | undefined;

  constructor(opts: ScannerOptions) {
    this.opts = { batchSize: opts.batchSize ?? 500, now: opts.now ?? Date.now, ...opts };
  }

  /**
   * Scans one batch. Everything it writes — contracts, mints, tokens, events, the retry queue and
   * the cursor — lands in a single database transaction.
   */
  async scanOnce(): Promise<ScanBatchOutcome> {
    const { sql, schema, archiveSchema, net } = this.opts;
    const cursor = await readDecodeCursor(sql, schema, net);
    const rows = await this.readArchiveBatch(cursor);

    const outcome: ScanBatchOutcome = {
      transactionsScanned: 0, deploys: 0, calls: 0, mints: 0, lookups: 0, lookupsShort: 0,
      eventsApplied: 0, eventsRejected: 0, skippedUnknownResult: 0,
      cursor, atTip: rows.length === 0, waitingForResult: undefined,
    };
    if (rows.length === 0) return outcome;

    await sql.begin(async (tx) => {
      for (const row of rows) {
        // --- a transaction whose result the archive does not know -------------------------------
        if (row.kind === "regular" && row.result === null) {
          if (!this.shouldGiveUpOn(row.txHash)) {
            outcome.waitingForResult = { txHash: row.txHash, blockHeight: row.blockHeight };
            break;
          }
          jsonLog("token-indexer", "scan.skip-unknown-result", {
            txHash: row.txHash, blockHeight: row.blockHeight,
            waitedMs: UNKNOWN_RESULT_GRACE_MS,
            note: "no archived transaction result after the grace period; counted nothing from it",
          });
          outcome.skippedUnknownResult++;
          outcome.cursor = { height: row.blockHeight, position: row.position };
          outcome.transactionsScanned++;
          continue;
        }
        this.waitingSince = undefined;

        if (row.kind === "system") {
          // A system transaction carries no contract actions at all — nothing to decode.
          outcome.cursor = { height: row.blockHeight, position: row.position };
          outcome.transactionsScanned++;
          continue;
        }

        const decoded = decodeTransactionActions(this.opts.ledger, new Uint8Array(row.raw));
        const counted = countedEffects(decoded, row.result!, row.segments, row.txHash);

        for (const address of counted.deployAddresses) {
          await upsertContract(tx, schema, net, {
            address, height: row.blockHeight, deployTxHash: row.txHash, isDeploy: true, isCall: false,
          });
          outcome.deploys++;
        }
        for (const address of counted.callAddresses) {
          await upsertContract(tx, schema, net, {
            address, height: row.blockHeight, isDeploy: false, isCall: true,
          });
          outcome.calls++;
        }
        for (const mint of counted.mints) {
          const isNew = await applyMint(tx, schema, net, mint, {
            txHash: row.txHash, blockHeight: row.blockHeight, txPosition: row.position,
          });
          if (isNew) outcome.mints++;
        }
        for (const [address, expected] of counted.logOpsByAddress) {
          const pair: LookupPair = { txHash: row.txHash, address, blockHeight: row.blockHeight, expected };
          const result = await lookupEventsFor(tx, schema, net, this.opts.eventSource, pair);
          outcome.lookups++;
          outcome.eventsApplied += result.applied;
          outcome.eventsRejected += result.rejected;
          if (result.short) outcome.lookupsShort++;
        }

        outcome.cursor = { height: row.blockHeight, position: row.position };
        outcome.transactionsScanned++;
      }

      if (outcome.transactionsScanned > 0) {
        await writeDecodeCursor(tx, schema, net, outcome.cursor);
      }
    });

    // `atTip` only when the batch was not cut short and the archive had fewer rows than asked for.
    outcome.atTip = outcome.waitingForResult === undefined && rows.length < this.opts.batchSize;
    void archiveSchema;
    return outcome;
  }

  /** True once the scanner has been stuck on the same transaction for longer than the grace. */
  private shouldGiveUpOn(txHash: string): boolean {
    const now = this.opts.now();
    if (this.waitingSince === undefined || this.waitingSince.txHash !== txHash) {
      this.waitingSince = { txHash, since: now };
      return false;
    }
    return now - this.waitingSince.since >= UNKNOWN_RESULT_GRACE_MS;
  }

  /**
   * The next transactions after the cursor, in `(block_height, position)` order, canonical blocks
   * only, with their raw bytes.
   *
   * The `(block_height, position) > (cursor.height, cursor.position)` comparison is written as a
   * ROW comparison so Postgres can use the primary-key ordering directly, and so a cursor that sits
   * mid-block resumes exactly at the next transaction rather than re-reading the block.
   */
  private async readArchiveBatch(cursor: DecodeCursor): Promise<ArchivedTransactionRow[]> {
    const { sql, archiveSchema, net } = this.opts;
    const rows = await sql<{
      tx_hash: Buffer; block_height: string; position: number; kind: string;
      result: string | null; segments: { id: number; success: boolean }[] | null; data: Buffer;
    }[]>`
      SELECT t.tx_hash, t.block_height, t.position, t.kind, t.result, t.segments, b.data
      FROM ${sql(archiveSchema)}.transactions t
      JOIN ${sql(archiveSchema)}.blocks bl
        ON bl.net = t.net AND bl.height = t.block_height AND bl.block_hash = t.block_hash
      JOIN ${sql(archiveSchema)}.chain_blobs b ON b.hash = t.raw_blob_hash
      WHERE t.net = ${net}
        AND bl.is_canonical
        AND (t.block_height, t.position) > (${cursor.height}::bigint, ${cursor.position}::int)
      ORDER BY t.block_height, t.position
      LIMIT ${this.opts.batchSize}
    `;
    return rows.map((r) => ({
      txHash: r.tx_hash.toString("hex"),
      blockHeight: Number(r.block_height),
      position: r.position,
      kind: r.kind === "system" ? "system" : "regular",
      result: r.result as ArchivedTransactionRow["result"],
      segments: r.segments,
      raw: r.data,
    }));
  }
}
