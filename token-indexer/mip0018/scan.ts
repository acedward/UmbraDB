/**
 * The MIP-0018 scan over the chain archive (project 00026, sub-plans A3/B2): ONE loop that reads the archived
 * finalized blocks in height order, decodes each regular transaction once with the applied-parts decoder, keeps only
 * the parts that took effect (the archived result and per-segment outcomes), and records — per block, atomically,
 * together with its own cursor — the mints and their colors (MIP "Lookup"), the colors seen in public data (owner Q3),
 * the contract calls, deploys and maintenance updates (sub-plan A3), and every `Misc` event of an applied part with
 * its classification under the final MIP (sub-plan B2, Q4 (c): events come from the raw transactions; the indexer's
 * `contractEvents` is only a test cross-check).
 *
 * - Source: the `chain_archive` schema written by `chain-archive-sync` (finalized blocks only, a contiguous range
 *   `[startHeight, height]` recorded in its `sync_cursor:<net>` watermark). The scan never reads past that height.
 * - Order: heights ascending; a block's transactions by archive position; within a transaction, the ledger's
 *   execution order (`applied-parts.ts`).
 * - Cursor: `mip0018.mip0018_scan` (first height, next height, last block hash). Each block's rows and the cursor
 *   advance commit in ONE Postgres transaction; the cursor moves by compare-and-set, so a second scanner on the same
 *   network fails instead of interleaving. Every insert is idempotent, so a block scanned again (after
 *   `removeAbove`) yields the same rows.
 * - Checks (never skipped silently): consecutive heights, each block's parent = the last scanned block, a stored
 *   result for every regular transaction, the outcome of every fallible segment of a partial success (audit F1), the
 *   recomputed transaction hash = the archived one, a decodable transaction, one (contract, domainSep) per color.
 * - Events: every applied `log` op whose item is a MIP-0002 `Misc` event, in the MIP's order (block, transaction,
 *   then within the transaction the guaranteed part of every intent by ascending segment id, then each successful
 *   fallible segment; actions and operations in order). `name ‖ payload` was zero-extended to 288 bytes before the
 *   split (decoder); the contract address is the call's, never the payload's. Classified with the vendored reference
 *   codec: accept, reject (reason) or ignore (another name, `[v2]`, data that is not one 288-byte item). The row keeps
 *   the chain position, classification and reason (Q15: the chain-event record; metadata values live only in the
 *   latest-value rows of sub-plan B3); `name`/`payload` stay for recomputation and are never served as metadata.
 *   `event_index` is the position among the transaction's applied `log` ops (non-`Misc` logs are not stored).
 * - Metadata state (sub-plan B3, `fields.ts`): each accepted event is applied to `mip0018_fields` (latest value per
 *   key; a Null record deletes its key's row) in the same block transaction as the event rows and the cursor.
 * - `removeAbove(height)`: deletes every scanned row above a height, recomputes the fields of the identities the
 *   removed events touched from the remaining accepted events, and moves the cursor back, so the scan can be
 *   recomputed from there (MIP S4; UmbraDB follows finalized blocks only, so this serves tests and repairs).
 */
import type { BlockMeta, TransactionMeta } from "../../src/interfaces/chain-archive-store.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { type ActivityRow, activityTransaction, type ActivityTransactionLike, removeActivityAbove, transactionActivity, writeActivity } from "./activity.ts";
import { MIP0018_SCHEMA, mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";
import {
  type AppliedParts,
  appliedParts,
  decodeTransaction,
  type DecodedTransaction,
  MISC_EVENT_TYPE_CODE,
  NIGHT_COLOR,
  partApplied,
  type TransactionOutcome,
} from "./applied-parts.ts";
import { tokenColor } from "./color.ts";
import { type EventRow, removeEventsAbove, writeEvents } from "./fields.ts";
import { classifyEvent, MISC_EVENT_TYPE } from "../vendor/mip0018/codec/src/index.ts";

/** NIGHT and DUST (owner Q3): protocol tokens, outside MIP-0018 ("their properties are fixed by the protocol"). */
export const BUILTIN_TOKENS = [
  { symbol: "NIGHT", name: "NIGHT", decimals: 6, color: NIGHT_COLOR, note: "Protocol token (outside MIP-0018): the unshielded native token, color 32 zero bytes." },
  { symbol: "DUST", name: "DUST", decimals: 15, color: null, note: "Protocol token (outside MIP-0018): the fee resource; it has no color." },
] as const;

export class ScanError extends Error {
  override name = "ScanError";
}

/** A `--from` / `--to` the scan cannot honour (refused before anything is written). */
export class ScanRangeError extends ScanError {
  override name = "ScanRangeError";
}

export interface ScanCursor {
  fromHeight: number;
  /** Everything in `[fromHeight, nextHeight)` is scanned. */
  nextHeight: number;
  lastBlockHash: string | undefined;
}

export interface Mip0018ScannerOptions {
  sql: UmbraDBSql;
  /** The archive's `net` and the network of every row written. */
  network: string;
  /** Schema of the `mip0018` lineage (default `mip0018`). */
  schema?: string;
  /** Schema of the chain archive (default `chain_archive`). */
  archiveSchema?: string;
  /** First height of a FIRST scan (default: the archive's first height). Must equal the cursor's once it exists. */
  fromHeight?: number;
  /** Last height to scan, inclusive. */
  toHeight?: number;
  /** Decodes archived bytes (default: the applied-parts decoder with ledger-v9). A test seam for synthetic parts. */
  decode?: (raw: Uint8Array) => DecodedTransaction;
  /** Test seam: runs inside a block's database transaction after its rows are written, before the cursor moves. */
  onBlockWritten?: (height: number) => void | Promise<void>;
  /** Test seam (sub-plan C2): the transaction the activity rows are read from (default: ledger-v9 deserialization; a
   *  scanner given only a `decode` seam — synthetic bytes — records no activity). */
  activityTransaction?: (raw: Uint8Array) => ActivityTransactionLike;
}

export interface ScanOnceResult {
  scannedBlocks: number;
  /** First and last height scanned by this call. */
  fromHeight: number | undefined;
  toHeight: number | undefined;
  /** The archive's last height when the call started (`undefined`: nothing archived for the network). */
  archiveHeight: number | undefined;
  /** The cursor is past `toHeight`. */
  reachedEnd: boolean;
  transactions: number;
  mints: number;
  sightings: number;
  actions: number;
  /** `Misc` events stored (any classification). */
  events: number;
}

interface ActionRow {
  network: string;
  block_height: number;
  tx_index: number;
  segment_id: number;
  action_index: number;
  tx_hash: Buffer;
  action: "call" | "deploy" | "maintenance";
  contract_address: Buffer;
  entry_point: string | null;
  applied_phases: string[] | null;
  maintenance_counter: string | null;
  maintenance_updates: string[] | null;
}

interface BlockRows {
  mints: Array<Record<string, unknown>>;
  sightings: Array<Record<string, unknown>>;
  actions: ActionRow[];
  events: EventRow[];
  activity: ActivityRow[];
  transactions: number;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const buf = (h: string): Buffer => Buffer.from(h, "hex");

/** Segment ids whose fallible part holds something the scan records (a fallible transcript, log, mint, color, deploy or update). */
export function fallibleSegments(d: DecodedTransaction): number[] {
  const ids = new Set<number>();
  for (const c of d.calls) if (c.phases.includes("fallible")) ids.add(c.segment);
  for (const xs of [d.logs, d.mints, d.sightings, d.deploys, d.maintenance] as Array<ReadonlyArray<{ phase: string; segment: number }>>)
    for (const x of xs) if (x.phase === "fallible") ids.add(x.segment);
  return [...ids].sort((a, b) => a - b);
}

export class Mip0018Scanner {
  private readonly sql: UmbraDBSql;
  private readonly network: string;
  private readonly schema: string;
  private readonly archive: PgChainArchiveStore;
  private readonly decode: (raw: Uint8Array) => DecodedTransaction;

  constructor(private readonly opts: Mip0018ScannerOptions) {
    if (opts.network.length === 0) throw new ScanRangeError("network must not be empty");
    for (const [what, h] of [["fromHeight", opts.fromHeight], ["toHeight", opts.toHeight]] as const)
      if (h !== undefined && (!Number.isSafeInteger(h) || h < 0)) throw new ScanRangeError(`${what} must be a non-negative integer, got ${h}`);
    if (opts.fromHeight !== undefined && opts.toHeight !== undefined && opts.toHeight < opts.fromHeight)
      throw new ScanRangeError(`toHeight ${opts.toHeight} is below fromHeight ${opts.fromHeight}`);
    this.sql = opts.sql;
    this.network = opts.network;
    this.schema = opts.schema ?? MIP0018_SCHEMA;
    this.archive = new PgChainArchiveStore(opts.sql, opts.archiveSchema ?? "chain_archive");
    this.decode = opts.decode ?? ((raw) => decodeTransaction(raw));
  }

  /** Creates the `mip0018` schema (idempotent) and seeds the NIGHT/DUST rows of this network. */
  async bootstrap(): Promise<void> {
    await runMigrations(this.sql, { schema: this.schema, migrations: mip0018Migrations });
    for (const t of BUILTIN_TOKENS) {
      await this.sql`
        INSERT INTO ${this.sql(this.schema)}.mip0018_builtin_tokens (network, symbol, name, decimals, color, note)
        VALUES (${this.network}, ${t.symbol}, ${t.name}, ${t.decimals}, ${t.color === null ? null : buf(t.color)}, ${t.note})
        ON CONFLICT (network, symbol) DO NOTHING`;
    }
  }

  async getCursor(): Promise<ScanCursor | undefined> {
    const rows = await this.sql<{ from_height: bigint; next_height: bigint; last_block_hash: Buffer | null }[]>`
      SELECT from_height, next_height, last_block_hash FROM ${this.sql(this.schema)}.mip0018_scan WHERE network = ${this.network}`;
    const r = rows[0];
    if (r === undefined) return undefined;
    return { fromHeight: Number(r.from_height), nextHeight: Number(r.next_height), lastBlockHash: r.last_block_hash === null ? undefined : hex(r.last_block_hash) };
  }

  /** The archive's contiguous range for this network, from its sync cursor. */
  private async archiveRange(): Promise<{ height: number; startHeight?: number } | undefined> {
    const wm = (await this.archive.getWatermark(`sync_cursor:${this.network}`)) as { height?: unknown; startHeight?: unknown } | undefined;
    if (wm === undefined || typeof wm.height !== "number") return undefined;
    return typeof wm.startHeight === "number" ? { height: wm.height, startHeight: wm.startHeight } : { height: wm.height };
  }

  /** Resolves the cursor (creating it on a first scan) and refuses a range the scan cannot honour. */
  private async ensureCursor(archive: { height: number; startHeight?: number }): Promise<ScanCursor> {
    const existing = await this.getCursor();
    if (existing !== undefined) {
      if (this.opts.fromHeight !== undefined && this.opts.fromHeight !== existing.fromHeight)
        throw new ScanRangeError(`the ${this.network} scan started at ${existing.fromHeight}; --from ${this.opts.fromHeight} would leave a gap or rescan (use removeAbove, or another schema)`);
      return existing;
    }
    const from = this.opts.fromHeight ?? archive.startHeight;
    if (from === undefined) throw new ScanRangeError(`the archive of ${this.network} does not record its first height; give --from`);
    if (archive.startHeight !== undefined && from < archive.startHeight)
      throw new ScanRangeError(`--from ${from} is below the archive's first height ${archive.startHeight}`);
    await this.sql`
      INSERT INTO ${this.sql(this.schema)}.mip0018_scan (network, from_height, next_height, last_block_hash)
      VALUES (${this.network}, ${from}, ${from}, NULL)
      ON CONFLICT (network) DO NOTHING`;
    const created = await this.getCursor();
    if (created === undefined || created.fromHeight !== from) throw new ScanError(`another scanner created the ${this.network} cursor at ${created?.fromHeight}`);
    return created;
  }

  /** Scans up to `maxBlocks` archived blocks after the cursor (never past the archive's height or `toHeight`). */
  async scanOnce(o: { maxBlocks?: number } = {}): Promise<ScanOnceResult> {
    const maxBlocks = o.maxBlocks ?? 100;
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) throw new ScanRangeError(`maxBlocks must be a positive integer, got ${maxBlocks}`);
    const result: ScanOnceResult = { scannedBlocks: 0, fromHeight: undefined, toHeight: undefined, archiveHeight: undefined, reachedEnd: false, transactions: 0, mints: 0, sightings: 0, actions: 0, events: 0 };
    const archive = await this.archiveRange();
    if (archive === undefined) return result;
    result.archiveHeight = archive.height;
    let cursor = await this.ensureCursor(archive);
    const end = Math.min(archive.height, this.opts.toHeight ?? Number.MAX_SAFE_INTEGER, cursor.nextHeight + maxBlocks - 1);
    if (cursor.nextHeight <= end) {
      const blocks = await this.archive.getCanonicalChainRange(this.network, cursor.nextHeight, end);
      for (const block of blocks) {
        if (block.height !== cursor.nextHeight) throw new ScanError(`the archive has no canonical block ${cursor.nextHeight} (next archived: ${block.height})`);
        if (cursor.lastBlockHash !== undefined && block.parentHash !== cursor.lastBlockHash)
          throw new ScanError(`block ${block.height}: parent ${block.parentHash} is not the scanned block ${block.height - 1} (${cursor.lastBlockHash})`);
        const rows = await this.blockRows(block);
        await this.writeBlock(block, cursor, rows);
        cursor = { fromHeight: cursor.fromHeight, nextHeight: block.height + 1, lastBlockHash: block.blockHash };
        result.scannedBlocks++;
        result.fromHeight ??= block.height;
        result.toHeight = block.height;
        result.transactions += rows.transactions;
        result.mints += rows.mints.length;
        result.sightings += rows.sightings.length;
        result.actions += rows.actions.length;
        result.events += rows.events.length;
      }
      if (cursor.nextHeight <= end) throw new ScanError(`the archive has no canonical block ${cursor.nextHeight} (archive cursor at ${archive.height})`);
    }
    result.reachedEnd = this.opts.toHeight !== undefined && cursor.nextHeight > this.opts.toHeight;
    return result;
  }

  /** Decodes one block's archived transactions into rows (no write). */
  private async blockRows(block: BlockMeta): Promise<BlockRows> {
    const rows: BlockRows = { mints: [], sightings: [], actions: [], events: [], activity: [], transactions: 0 };
    const txs = await this.archive.getTransactionsForBlock(this.network, block.blockHash);
    for (const tx of txs) {
      if (tx.kind !== "regular") continue; // system transactions carry no contract actions
      rows.transactions++;
      const parts = await this.applied(block, tx);
      const at = { network: this.network, block_height: block.height, tx_index: tx.position };
      const txHash = buf(tx.txHash);
      parts.applied.mints.forEach((m, mintIndex) => {
        rows.mints.push({
          ...at, mint_index: mintIndex, tx_hash: txHash, phase: m.phase, segment_id: m.segment, action_index: m.actionIndex,
          contract_address: buf(m.contractAddress), domain_sep: buf(m.domainSep), kind: m.kind, amount: m.amount.toString(),
          color: buf(tokenColor(m.domainSep, m.contractAddress)),
        });
      });
      for (const s of parts.applied.sightings) rows.sightings.push({ ...at, tx_hash: txHash, color: buf(s.color), evidence: s.evidence });
      for (const c of parts.decoded.calls) {
        const applied = c.phases.filter((phase) => partApplied({ phase, segment: c.segment }, parts.outcome));
        if (applied.length === 0) continue;
        rows.actions.push({ ...at, segment_id: c.segment, action_index: c.actionIndex, tx_hash: txHash, action: "call", contract_address: buf(c.contractAddress), entry_point: c.entryPoint, applied_phases: applied, maintenance_counter: null, maintenance_updates: null });
      }
      for (const d of parts.applied.deploys)
        rows.actions.push({ ...at, segment_id: d.segment, action_index: d.actionIndex, tx_hash: txHash, action: "deploy", contract_address: buf(d.address), entry_point: null, applied_phases: null, maintenance_counter: null, maintenance_updates: null });
      for (const l of parts.applied.logs) {
        if (l.eventTypeCode !== MISC_EVENT_TYPE_CODE) continue; // other MIP-0002 types say nothing about metadata
        const name = Buffer.from(l.name ?? "", "hex");
        const payload = Buffer.from(l.payload ?? "", "hex");
        const c = l.undecodable === undefined
          ? classifyEvent({ type: MISC_EVENT_TYPE, name, payload })
          : { result: "ignore" as const, reason: `undecodable-data: ${l.undecodable}` };
        rows.events.push({
          ...at, event_index: l.eventIndex, tx_hash: txHash, segment_id: l.segment, phase: l.phase,
          contract_address: buf(l.contractAddress), event_type: MISC_EVENT_TYPE, name, payload,
          classification: c.result, reason: c.result === "accept" ? null : c.reason,
          domain_sep: c.result === "accept" ? Buffer.from(c.header.domainSep) : null,
          kind: c.result === "accept" ? c.header.kind : null,
        });
      }
      for (const m of parts.applied.maintenance)
        rows.actions.push({ ...at, segment_id: m.segment, action_index: m.actionIndex, tx_hash: txHash, action: "maintenance", contract_address: buf(m.address), entry_point: null, applied_phases: null, maintenance_counter: m.counter.toString(), maintenance_updates: m.updates });
      // Sub-plan C2: the public token flows of the applied parts and the metadata transactions (`activity.ts`).
      const readActivity = this.opts.activityTransaction ?? (this.opts.decode === undefined ? activityTransaction : undefined);
      if (readActivity !== undefined)
        rows.activity.push(...transactionActivity({ network: this.network, height: block.height, txIndex: tx.position, txHash: tx.txHash, tx: readActivity(await this.archive.getBlob(tx.rawBlobHash)), outcome: parts.outcome, events: rows.events }));
    }
    return rows;
  }

  /** Decodes an archived regular transaction and keeps what applied; every inconsistency stops the scan. */
  private async applied(block: BlockMeta, tx: TransactionMeta): Promise<{ decoded: DecodedTransaction; outcome: TransactionOutcome; applied: AppliedParts }> {
    if (tx.result === undefined)
      throw new ScanError(`transaction ${tx.txHash} at ${block.height} has no stored result; the archive must record outcomes (chain_archive 002) before it is scanned`);
    const outcome: TransactionOutcome = { result: tx.result, segments: tx.segments ?? null };
    let decoded: DecodedTransaction;
    try {
      decoded = this.decode(await this.archive.getBlob(tx.rawBlobHash));
    } catch (e) {
      throw new ScanError(`transaction ${tx.txHash} at ${block.height}: ${(e as Error).message}`);
    }
    if (decoded.hash !== tx.txHash) throw new ScanError(`transaction at ${block.height}: recomputed hash ${decoded.hash} differs from the archived ${tx.txHash}`);
    if (outcome.result === "partial_success") {
      // Mid-project audit F1 (Q20, FR-002): a partial success must say, for every segment that holds fallible content,
      // whether it applied; a missing list or a missing segment would silently drop parts that did apply.
      const listed = new Set((outcome.segments ?? []).map((s) => s.id));
      const missing = fallibleSegments(decoded).filter((s) => !listed.has(s));
      if (outcome.segments === null || outcome.segments === undefined || outcome.segments.length === 0 || missing.length > 0)
        throw new ScanError(
          `transaction ${tx.txHash} at ${block.height} is a partial success without the outcome of ${outcome.segments === null || outcome.segments === undefined || outcome.segments.length === 0 ? "any segment" : `segment(s) ${missing.join(", ")}`}; the archive must record every fallible segment's outcome`,
        );
    }
    return { decoded, outcome, applied: appliedParts(decoded, outcome) };
  }

  /** Writes one block's rows and advances the cursor, in one transaction. */
  private async writeBlock(block: BlockMeta, cursor: ScanCursor, rows: BlockRows): Promise<void> {
    const s = this.schema;
    await this.sql.begin(async (tx) => {
      for (const m of rows.mints) {
        const owner = await tx<{ contract_address: Buffer; domain_sep: Buffer }[]>`
          SELECT contract_address, domain_sep FROM ${tx(s)}.mip0018_mints
          WHERE network = ${this.network} AND color = ${m.color as Buffer} LIMIT 1`;
        const o = owner[0];
        if (o !== undefined && !(o.contract_address.equals(m.contract_address as Buffer) && o.domain_sep.equals(m.domain_sep as Buffer)))
          throw new ScanError(`color ${hex(m.color as Buffer)} maps to two (contract, domainSep) pairs — impossible unless tokenType is broken`);
        await tx`INSERT INTO ${tx(s)}.mip0018_mints ${tx(m)} ON CONFLICT DO NOTHING`;
      }
      for (const r of rows.sightings) await tx`INSERT INTO ${tx(s)}.mip0018_color_sightings ${tx(r)} ON CONFLICT DO NOTHING`;
      await writeActivity(tx, s, rows.activity); // sub-plan C2
      for (const a of rows.actions) {
        await tx`
          INSERT INTO ${tx(s)}.mip0018_contract_actions
            (network, block_height, tx_index, segment_id, action_index, tx_hash, action, contract_address, entry_point,
             applied_phases, maintenance_counter, maintenance_updates)
          VALUES (${a.network}, ${a.block_height}, ${a.tx_index}, ${a.segment_id}, ${a.action_index}, ${a.tx_hash}, ${a.action},
                  ${a.contract_address}, ${a.entry_point}, ${a.applied_phases === null ? null : tx.array(a.applied_phases)},
                  ${a.maintenance_counter}, ${a.maintenance_updates === null ? null : tx.array(a.maintenance_updates)})
          ON CONFLICT DO NOTHING`;
      }
      // The block's events in chain order; each accepted one is applied to the latest-value rows (sub-plan B3).
      await writeEvents(tx, s, rows.events);
      await this.opts.onBlockWritten?.(block.height);
      const moved = await tx`
        UPDATE ${tx(s)}.mip0018_scan SET next_height = ${block.height + 1}, last_block_hash = ${buf(block.blockHash)}
        WHERE network = ${this.network} AND next_height = ${cursor.nextHeight}`;
      if (moved.count !== 1) throw new ScanError(`the ${this.network} scan cursor moved under this scanner (expected next height ${cursor.nextHeight})`);
    });
  }

  /**
   * Removes every scanned row above `height` and moves the cursor back to `height + 1`, so the scan recomputes from
   * there. `height` may be `fromHeight - 1` (nothing scanned).
   */
  async removeAbove(height: number): Promise<void> {
    const cursor = await this.getCursor();
    if (cursor === undefined) throw new ScanRangeError(`no ${this.network} scan to cut`);
    if (!Number.isSafeInteger(height) || height < cursor.fromHeight - 1) throw new ScanRangeError(`cannot cut the ${this.network} scan below its first height ${cursor.fromHeight}`);
    if (height + 1 >= cursor.nextHeight) return;
    const lastHash = height + 1 === cursor.fromHeight ? undefined : (await this.archive.getCanonicalBlockAtHeight(this.network, height))?.blockHash;
    if (height + 1 > cursor.fromHeight && lastHash === undefined) throw new ScanError(`the archive has no canonical block ${height}`);
    const s = this.schema;
    await this.sql.begin(async (tx) => {
      for (const table of ["mip0018_mints", "mip0018_color_sightings", "mip0018_contract_actions"])
        await tx`DELETE FROM ${tx(s)}.${tx(table)} WHERE network = ${this.network} AND block_height > ${height}`;
      // Events above the height go, and the fields of every identity they touched are recomputed from the remaining
      // accepted events (MIP S4; sub-plan B3).
      await removeEventsAbove(tx, s, this.network, height);
      const moved = await tx`
        UPDATE ${tx(s)}.mip0018_scan SET next_height = ${height + 1}, last_block_hash = ${lastHash === undefined ? null : buf(lastHash)}
        WHERE network = ${this.network} AND next_height = ${cursor.nextHeight}`;
      if (moved.count !== 1) throw new ScanError(`the ${this.network} scan cursor moved during removeAbove`);
      await removeActivityAbove(tx, s, this.network, height); // sub-plan C2
    });
  }
}
