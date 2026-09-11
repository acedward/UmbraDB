import type { ArchiveReadContract, ArchivedBlock } from "../src/interfaces/archive-read-contract.js";
import { MonitorFencedError, MonitorNotFoundError, MonitorRevokedError } from "./errors.js";
import type { MatchDetails } from "./match-details.js";
import { deserializeEncryptionSecretKey, type EncryptionSecretKeyHandle } from "./offers.js";
import { evaluateRelevance } from "./relevance.js";
import type { AssociationDetailsUpdate, AssociationRecord, MonitorRecord } from "./store.js";

/**
 * The details backfill (organizer sub-plan 00009-07): fills `associations.details` and
 * `associations.block_timestamp_ms` for matches that were recorded before those columns existed.
 *
 * A monitor that has been running since Phase 3 has associations that are correct and complete for
 * what they claimed — height, position, transaction hash, matched segments — and empty in the two
 * columns migration 002 added. Re-scanning is the wrong instrument: it would re-derive matches
 * that are already committed, and coverage cannot move backwards without either reopening the
 * fence or inventing a second notion of "scanned". This walks the EXISTING rows instead.
 *
 * **Owner Rule B is untouched, and that is the load-bearing property.** The only way this module
 * reaches project A is {@link ArchiveReadContract} — the same interface the scanner uses, no
 * schema name, no SQL, no archive handle — and the only rows it writes are
 * `shielded_monitor.associations` columns that were `NULL`. It cannot change a height, a position,
 * a transaction hash, a matched-segment list, an outcome or any coverage value: those are not in
 * the `SET` list of {@link PgShieldedMonitorStore.updateAssociationDetails}.
 *
 * **It refuses to write a detail it cannot tie to the recorded match.** For each row it re-reads
 * the block through the read contract and checks three things before deriving anything: the block
 * at that height must still carry the recorded block HASH (a rebuilt archive is a different
 * history, and FR-013's `stale_source` exists for exactly that); a transaction must sit at the
 * recorded POSITION with the recorded HASH; and re-evaluating it against the monitor's key must
 * still produce a match with the same segments. A row failing any of those is SKIPPED and counted,
 * never filled with a best guess — a detail record that describes a different transaction than the
 * association it hangs off would be worse than the `NULL` it replaced.
 *
 * **Idempotent by predicate, not by bookkeeping.** Every write carries `AND details IS NULL`, so a
 * second run fills nothing and reports zero. A skipped row is walked past by `seq` rather than
 * re-read, so one unfillable row cannot stall a monitor.
 */

/** Exactly the store operations a details backfill may perform — and therefore, by construction,
 *  exactly the writes it can make. One write method, and it sets two columns. */
export interface DetailsBackfillStore {
  listAll(limit: number): Promise<MonitorRecord[]>;
  get(id: string): Promise<MonitorRecord>;
  getKeyMaterial(id: string): Promise<Uint8Array>;
  readAssociationsMissingDetails(
    monitorId: string, afterSeq: bigint, limit: number,
  ): Promise<AssociationRecord[]>;
  updateAssociationDetails(
    monitorId: string, expectedEpoch: bigint, updates: readonly AssociationDetailsUpdate[],
  ): Promise<{ readonly applied: number }>;
}

/** Why a row could not be filled. Counted rather than thrown: one unreadable block must not stop a
 *  backfill over thousands of good rows, and an operator needs the shape of what was left. */
export type DetailsBackfillSkipReason =
  /** The archive holds no canonical block at that height any more. */
  | "block-missing"
  /** The block at that height is not the one the association names. A rebuilt or re-synced
   *  archive: filling from it would mix two histories. */
  | "block-hash-differs"
  /** No transaction sits at the recorded position, or it carries a different hash. */
  | "transaction-missing"
  /** Re-evaluating the transaction against the monitor's key no longer reproduces the recorded
   *  match. Either the key changed under the monitor or the matching rule did; both are questions
   *  for an operator, not something to paper over with a detail record. */
  | "match-not-reproduced";

/** What one monitor's backfill did. Carries no monitor id: a scanner log line naming which
 *  monitor did what is a per-wallet signal (the finding Phase 3 recorded when it redacted monitor
 *  ids from the scheduler's logs). Callers that already hold the id can pair it up themselves. */
export interface DetailsBackfillSummary {
  /** Rows read with `details IS NULL`. */
  readonly examined: number;
  /** Rows actually filled by this run. */
  readonly filled: number;
  /** Rows deliberately left `NULL`, by reason. */
  readonly skipped: Record<DetailsBackfillSkipReason, number>;
  /** True when a lifecycle transition landed under the run and a commit was refused. The run
   *  stops for that monitor; a later run continues from the rows still `NULL`. */
  readonly fenced: boolean;
  /** True when the monitor could not be worked on at all (revoked, deleted, or gone). */
  readonly refused: boolean;
}

export interface DetailsBackfillOptions {
  /** The one network this backfill serves. A monitor for another net is skipped. */
  readonly net: string;
  /** Associations read — and therefore filled — per store transaction. Default 100. */
  readonly batchRows?: number;
  /** Injectable for tests and for a future TEE deployment, exactly as the scanner's is. */
  readonly deserializeKey?: (bytes: Uint8Array) => Promise<EncryptionSecretKeyHandle>;
}

const DEFAULT_BATCH_ROWS = 100;

function emptySkips(): Record<DetailsBackfillSkipReason, number> {
  return {
    "block-missing": 0,
    "block-hash-differs": 0,
    "transaction-missing": 0,
    "match-not-reproduced": 0,
  };
}

/** `Buffer`/`Uint8Array` → lowercase hex, so a stored `bytea` can be compared with the hex the
 *  read contract speaks. The archive's side is authoritative about case; both are lowercased. */
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex").toLowerCase();
}

export class ShieldedMonitorDetailsBackfill {
  private readonly net: string;
  private readonly batchRows: number;
  private readonly deserializeKey: (bytes: Uint8Array) => Promise<EncryptionSecretKeyHandle>;

  constructor(
    private readonly archive: ArchiveReadContract,
    private readonly store: DetailsBackfillStore,
    options: DetailsBackfillOptions,
  ) {
    this.net = options.net;
    this.batchRows = options.batchRows ?? DEFAULT_BATCH_ROWS;
    if (!Number.isSafeInteger(this.batchRows) || this.batchRows < 1) {
      throw new Error(`batchRows must be a positive integer; got ${String(options.batchRows)}`);
    }
    this.deserializeKey = options.deserializeKey ?? deserializeEncryptionSecretKey;
  }

  /**
   * Fills every fillable association of every monitor on this net, then returns.
   *
   * `maxMonitors` bounds the list the same way the scanner's `MAX_MONITORS` does. Monitors that
   * refuse work (revoked, deleted, another net) are counted and passed over, never thrown on: an
   * operator running the backfill after a revoke should get the other monitors done.
   */
  async runAll(opts: { readonly maxMonitors?: number } = {}): Promise<{
    readonly monitors: number;
    readonly examined: number;
    readonly filled: number;
    readonly skipped: Record<DetailsBackfillSkipReason, number>;
    readonly refused: number;
    readonly fenced: number;
  }> {
    const monitors = await this.store.listAll(opts.maxMonitors ?? 100);
    const totals = { monitors: 0, examined: 0, filled: 0, refused: 0, fenced: 0 };
    const skipped = emptySkips();
    for (const monitor of monitors) {
      if (monitor.net !== this.net) continue;
      totals.monitors += 1;
      const summary = await this.runMonitor(monitor.id);
      totals.examined += summary.examined;
      totals.filled += summary.filled;
      if (summary.refused) totals.refused += 1;
      if (summary.fenced) totals.fenced += 1;
      for (const reason of Object.keys(skipped) as DetailsBackfillSkipReason[]) {
        skipped[reason] += summary.skipped[reason];
      }
    }
    return { ...totals, skipped };
  }

  /** Fills every fillable association of ONE monitor, paging forward by `seq`. */
  async runMonitor(monitorId: string): Promise<DetailsBackfillSummary> {
    const skipped = emptySkips();
    let examined = 0;
    let filled = 0;

    let monitor: MonitorRecord;
    try {
      monitor = await this.store.get(monitorId);
    } catch (err) {
      if (err instanceof MonitorNotFoundError || err instanceof MonitorRevokedError) {
        return { examined: 0, filled: 0, skipped, fenced: false, refused: true };
      }
      throw err;
    }
    if (monitor.net !== this.net) {
      return { examined: 0, filled: 0, skipped, fenced: false, refused: true };
    }

    let afterSeq = 0n;
    for (;;) {
      let page: AssociationRecord[];
      try {
        page = await this.store.readAssociationsMissingDetails(monitorId, afterSeq, this.batchRows);
      } catch (err) {
        if (err instanceof MonitorNotFoundError || err instanceof MonitorRevokedError) {
          return { examined, filled, skipped, fenced: false, refused: true };
        }
        throw err;
      }
      if (page.length === 0) break;
      examined += page.length;
      afterSeq = page[page.length - 1]!.seq;

      const { updates, skips } = await this.deriveForPage(monitorId, page);
      for (const reason of skips) skipped[reason] += 1;

      if (updates.length > 0) {
        try {
          // Re-read the monitor so the fence carries the epoch as it stands NOW. A backfill can
          // run for a long time; using the epoch loaded at the start would turn every legitimate
          // pause/resume during the run into a permanent refusal.
          const fresh = await this.store.get(monitorId);
          const result = await this.store.updateAssociationDetails(monitorId, fresh.epoch, updates);
          filled += result.applied;
        } catch (err) {
          if (err instanceof MonitorFencedError) {
            return { examined, filled, skipped, fenced: true, refused: false };
          }
          if (err instanceof MonitorNotFoundError || err instanceof MonitorRevokedError) {
            return { examined, filled, skipped, fenced: false, refused: true };
          }
          throw err;
        }
      }
    }

    return { examined, filled, skipped, fenced: false, refused: false };
  }

  /**
   * Derives the details for one page of associations.
   *
   * The key is deserialized ONCE for the page and `clear()`ed in a `finally`, exactly as the
   * scanner does — and it is not loaded at all when no row of the page has a readable block, so a
   * page that can produce nothing never puts key material in the WASM heap.
   */
  private async deriveForPage(
    monitorId: string, page: readonly AssociationRecord[],
  ): Promise<{ updates: AssociationDetailsUpdate[]; skips: DetailsBackfillSkipReason[] }> {
    const updates: AssociationDetailsUpdate[] = [];
    const skips: DetailsBackfillSkipReason[] = [];

    // One read-contract call per DISTINCT height, not per row: a block with several of this
    // monitor's matches is read once. `readBlocksSince(height - 1, 1)` is the contract's own way
    // to ask for exactly one height (the bound is exclusive), so no new read method is needed.
    const blocks = new Map<string, ArchivedBlock | undefined>();
    const blockFor = async (height: bigint): Promise<ArchivedBlock | undefined> => {
      const cacheKey = height.toString(10);
      if (blocks.has(cacheKey)) return blocks.get(cacheKey);
      const after = height === 0n ? -1 : Number(height - 1n);
      const read = await this.archive.readBlocksSince(this.net, after, 1);
      const block = read.blocks.find((b) => BigInt(b.height) === height);
      blocks.set(cacheKey, block);
      return block;
    };

    interface Candidate {
      readonly association: AssociationRecord;
      readonly block: ArchivedBlock;
      readonly tx: ArchivedBlock["transactions"][number];
    }
    const candidates: Candidate[] = [];
    for (const association of page) {
      const block = await blockFor(association.blockHeight);
      if (block === undefined) { skips.push("block-missing"); continue; }
      if (block.hash.toLowerCase() !== toHex(association.blockHash)) {
        skips.push("block-hash-differs");
        continue;
      }
      const tx = block.transactions.find((t) => t.position === association.position);
      if (tx === undefined || tx.txHash.toLowerCase() !== toHex(association.txHash)) {
        skips.push("transaction-missing");
        continue;
      }
      candidates.push({ association, block, tx });
    }
    if (candidates.length === 0) return { updates, skips };

    const keyBytes = await this.store.getKeyMaterial(monitorId);
    const key = await this.deserializeKey(keyBytes);
    try {
      for (const candidate of candidates) {
        let details: MatchDetails | undefined;
        try {
          const outcome = await evaluateRelevance(candidate.tx, key, { details: true });
          if (outcome.kind === "match" && sameSegments(outcome.segments, candidate.association.matchedSegments)) {
            details = outcome.details;
          }
        } catch {
          // An undecodable transaction here is not a fail-closed event the way it is during a
          // scan: coverage is already committed and this row's match is already recorded. Leave
          // the row NULL and say so.
          details = undefined;
        }
        if (details === undefined) { skips.push("match-not-reproduced"); continue; }
        updates.push({
          seq: candidate.association.seq,
          details,
          ...(candidate.block.timestampMs === undefined
            ? {}
            : { blockTimestampMs: BigInt(candidate.block.timestampMs) }),
        });
      }
    } finally {
      key.clear();
      keyBytes.fill(0);
    }
    return { updates, skips };
  }
}

/** Segment lists compared as SETS of ids, order-insensitively. Both sides are produced sorted
 *  ascending today; comparing as sets means a future ordering change surfaces as a real
 *  disagreement rather than as a spurious one. */
function sameSegments(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, index) => value === right[index]);
}
