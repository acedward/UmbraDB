import type { LifecycleEvent, MonitorState } from "./lifecycle.js";
import type { MatchDetails } from "./match-details.js";

/**
 * **The monitor store CONTRACT** — project B's record shapes and the one interface every
 * implementation of them satisfies (organizer spec FR-002..004, FR-010..016, FR-022, FR-025;
 * sub-plan 00009-08 v2).
 *
 * ── Why this file holds no SQL any more (00009-08 v2, owner question Q25) ────────────────────
 * Project B has **no database connection at all**. It reads and writes its state through one HTTP
 * channel to `umbradb-storage-api`, an A-side process that owns the single main PostgreSQL and
 * executes each of these operations as exactly one database transaction on B's behalf. So the
 * PostgreSQL implementation moved to `storage-api/monitor-store-pg.ts` — the A side — and what
 * stays here is the part both ends share: the records, and {@link ShieldedMonitorStore}.
 *
 * The split is mechanically checked, not merely intended: `test/shielded-monitor/import-boundary.
 * test.ts` walks the static import graph of every module under `shielded-monitor/**` and fails if
 * it reaches `postgres` or anything under `src/postgres/**`. This module imports three things,
 * all of them B's own, and none of them touches a driver.
 *
 * ── Owner Rule B, restated for the v2 topology ──────────────────────────────────────────────
 * Rule B says B never writes to an archive table and commits each block height's associations
 * together with that height's coverage advance. Both still hold, and both are now properties of
 * ONE storage-API command: `advance`. It is the only write path a scanner has, it is one
 * `BEGIN … COMMIT` on the server, and its epoch fence is inside the same statement that moves
 * coverage.
 *
 * ── 00009-09: no key material crosses this interface at all ─────────────────────────────────
 * `register` takes a FINGERPRINT, not a key: the viewing key lives in the RAM of exactly one
 * monitor-node and is never persisted (owner decision Q28). `getKeyMaterial` and the three lease
 * methods are gone — there is no key to fetch, and what a node holds in RAM is the truth about who
 * scans a monitor. `advanceBatch` is the block-centric commit (one node, one block, every held
 * monitor, one transaction) and `fillGap` is how a back-sync fills a hole without moving coverage.
 *
 * **Deferred with User Story 4** (owner, 2026-09-10): the fingerprint is unkeyed, associations are
 * plaintext, there is no tenant column and no least-privilege role script. The storage-API
 * boundary is exactly where at-rest encryption will sit when it arrives (Q25's "first divide the
 * process, then add the encryption").
 */

// ── Public record shapes ─────────────────────────────────────────────────────────────────────

/** Coverage as block heights (organizer spec FR-011). `scannedFrom`/`scannedThrough` are absent
 *  until the first advance, which is what distinguishes "not scanned yet" from "scanned, empty". */
export interface MonitorCoverage {
  readonly requestedStart: bigint;
  readonly scannedFrom?: bigint;
  readonly scannedThrough?: bigint;
}

/** A typed, non-secret description of why a monitor failed. Never carries key material. */
export interface MonitorLastError {
  readonly code: string;
  readonly message: string;
  readonly atHeight?: string;
  readonly atPosition?: number;
}

/**
 * One contiguous range of block heights BELOW a monitor's `scannedThrough` that was never
 * actually read for it (00009-09).
 *
 * Block-centric scanning is what makes these possible: a key that joins the live set at height H
 * starts having every new block committed for it, even though its own coverage may still stand
 * below H − 1. Moving `scannedThrough` to H would claim the range in between as covered, so
 * instead the range is recorded here, a `back-sync` job reads it, and `fillGap` shrinks or deletes
 * the row. "Complete" is `scannedThrough = tip AND gaps.length === 0`.
 */
export interface MonitorGap {
  readonly from: bigint;
  readonly to: bigint;
  readonly recordedAt: Date;
}

/** A monitor row as callers see it. Deliberately carries **no fingerprint and no key**
 *  (organizer spec FR-003: fingerprints are never returned to callers). */
export interface MonitorRecord {
  readonly id: string;
  readonly net: string;
  readonly state: MonitorState;
  readonly epoch: bigint;
  readonly coverage: MonitorCoverage;
  /** The holes in {@link MonitorCoverage}, lowest first (00009-09). Always present — an empty
   *  array is the normal, healthy shape and is a different statement from "unknown". */
  readonly gaps: readonly MonitorGap[];
  readonly sourceGenesisHash?: string;
  readonly sourceInstanceId?: string;
  readonly matchingRuleVersion: string;
  readonly ledgerBuild: string;
  readonly lastError?: MonitorLastError;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One relevant transaction observation (organizer spec FR-009). */
export interface AssociationRecord {
  readonly seq: bigint;
  readonly net: string;
  readonly blockHeight: bigint;
  readonly blockHash: Buffer;
  readonly position: number;
  readonly txHash: Buffer;
  readonly protocolVersion: bigint;
  readonly matchedSegments: readonly number[];
  readonly appliedOutcome: "unknown";
  readonly sourceOutcome?: string;
  readonly matchingRuleVersion: string;
  readonly ledgerBuild: string;
  /** The matched transaction's public zswap data (00009-07). **Absent** means "not recorded yet"
   *  — a row written before migration 002, or one the details backfill has not visited. It never
   *  means "this transaction had no outputs"; a transaction with no outputs records an empty
   *  list, which is a different, visible thing. */
  readonly details?: MatchDetails;
  /** The time of the block this observation sits in, in milliseconds. Absent for the same reason
   *  `details` can be absent, and additionally for a block the ARCHIVE itself has no timestamp
   *  for (migration 008's unbackfilled rows) — never a guessed value. */
  readonly blockTimestampMs?: bigint;
  readonly createdAt: Date;
}

/** The association payload a caller hands {@link ShieldedMonitorStore.advance}. */
export interface AssociationInput {
  readonly net: string;
  readonly blockHeight: bigint;
  readonly blockHash: Uint8Array;
  readonly position: number;
  readonly txHash: Uint8Array;
  readonly protocolVersion: bigint;
  readonly matchedSegments: readonly number[];
  readonly sourceOutcome?: string;
  readonly matchingRuleVersion?: string;
  readonly ledgerBuild?: string;
  /** 00009-07, optional: omitting it writes exactly the pre-00009-07 row. */
  readonly details?: MatchDetails;
  readonly blockTimestampMs?: bigint;
}

/** One row of a details backfill (00009-07). `seq` names the association; the two payload fields
 *  are the only columns the backfill may write. */
export interface AssociationDetailsUpdate {
  readonly seq: bigint;
  readonly details: MatchDetails;
  /** Absent when the ARCHIVE itself has no timestamp for that block — never a guessed value. */
  readonly blockTimestampMs?: bigint;
}

/**
 * Everything registration needs — and, since 00009-09, **no key material**.
 *
 * The caller (a monitor-node) has already decoded, validated and fingerprinted the key; what it
 * sends the storage API is the 32-byte fingerprint. The key itself stays in that node's RAM. A
 * second registration of the same key on the same network is an upsert on `(net, fingerprint)`
 * that returns the existing record with its coverage and gaps, which is how a node learns where to
 * resume after a restart.
 */
export interface RegisterMonitorInput {
  /** SHA-256("umbradb/shielded-monitor/fp/v1" ‖ net ‖ serialized key) — `monitorFingerprint`. */
  readonly fingerprint: Uint8Array;
  readonly net: string;
  readonly requestedStartHeight: bigint;
  readonly matchingRuleVersion: string;
  readonly ledgerBuild: string;
  /** Opaque archive identity, supplied by the caller. This module never derives it and has no
   *  compile-time dependency on the Phase-1 archive read contract. */
  readonly sourceGenesisHash?: string;
  readonly sourceInstanceId?: string;
  readonly actor: string;
}

/**
 * The outcome of {@link ShieldedMonitorStore.advance}.
 *
 * `applied: false` is the crash-retry path, not a failure — see `storage-api/monitor-store-pg.ts`.
 *
 * On `applied: true`, `firstSeq`..`lastSeq` is the **inclusive** range of association sequence
 * numbers this batch wrote. A batch with no matches — the normal shape for a run of empty blocks
 * — still applies, and reports the empty range `firstSeq = lastSeq + 1`: `lastSeq` is the
 * monitor's counter, unchanged, and `firstSeq` is the next number that would be handed out.
 */
export type AdvanceResult =
  | {
      readonly applied: true;
      readonly firstSeq: bigint;
      readonly lastSeq: bigint;
      readonly coverage: MonitorCoverage;
    }
  | {
      readonly applied: false;
      readonly reason: "already-advanced";
      readonly coverage: MonitorCoverage;
    };

// ── Block-centric commit (00009-09) ──────────────────────────────────────────────────────────

/** One monitor's share of one block, inside an {@link ShieldedMonitorStore.advanceBatch}. */
export interface AdvanceBatchItem {
  readonly monitorId: string;
  /** The fence, per monitor: the epoch the node's in-RAM view of this monitor carries. */
  readonly expectedEpoch: bigint;
  /** This monitor's matches in this block. Empty is normal and still advances its coverage. */
  readonly associations: readonly AssociationInput[];
  /** Ranges to record as unscanned for this monitor, recorded in the SAME transaction as the
   *  coverage move that would otherwise have hidden them (the `HAS_SCANNED_ONCE` check). */
  readonly newGaps?: readonly { readonly from: bigint; readonly to: bigint }[];
}

/** Why one item of an {@link ShieldedMonitorStore.advanceBatch} was not applied.
 *
 *  None of these fails the batch (OP-2): one paused monitor must not stall a block for every other
 *  monitor the node holds. The node acts on the reason — `state`/`not-found` drop the key,
 *  `epoch` re-reads it, `already-advanced` is the idempotent replay path. */
export type AdvanceBatchFenceReason = "epoch" | "state" | "not-found" | "already-advanced";

/** The outcome of one block's commit for every monitor a node holds. */
export interface AdvanceBatchResult {
  /** Monitor ids whose coverage now stands at the batch's height, with this block's associations
   *  and gap rows written. */
  readonly advanced: readonly string[];
  /** Monitor ids that were not advanced, each with the reason. Never empty-by-convention: a
   *  caller reads this list rather than diffing `advanced` against what it sent. */
  readonly fenced: readonly { readonly id: string; readonly reason: AdvanceBatchFenceReason }[];
}

/** What a `back-sync` commits for one monitor: a range it has now actually read, and that range's
 *  matches. Coverage is NOT moved — it is already above this range, which is why the gap existed. */
export interface FillGapInput {
  readonly expectedEpoch: bigint;
  readonly from: bigint;
  readonly to: bigint;
  readonly associations: readonly AssociationInput[];
}

/** The outcome of {@link ShieldedMonitorStore.fillGap}. */
export interface FillGapResult {
  /** How many association rows this call wrote. */
  readonly written: number;
  /** The monitor's gaps after the fill, lowest first. */
  readonly gaps: readonly MonitorGap[];
}

/** One entry of the lifecycle log. */
export interface LifecycleEventRecord {
  readonly seq: bigint;
  readonly event: LifecycleEvent;
  readonly stateBefore?: MonitorState;
  readonly stateAfter: MonitorState;
  readonly epochAfter: bigint;
  readonly actor: string;
  readonly at: Date;
}

/** A revocation record, exported so it can be kept OUTSIDE the database snapshot's rollback
 *  domain (organizer spec FR-024). Deliberately carries no key material, no fingerprint and no
 *  association data, so it is safe to store next to the backups. */
export interface RevocationRecord {
  readonly monitorId: string;
  readonly net: string;
  readonly state: "revoked" | "deleted";
  readonly epoch: string;
  readonly at: string;
}

// ── Bounds, shared by both implementations ───────────────────────────────────────────────────

/**
 * The largest `details` document a store will write, measured on its JSON encoding.
 *
 * `shielded-monitor/match-details.ts` already caps each list at `MAX_DETAIL_ENTRIES`, so this is
 * the second, independent bound: the producer's cap is a promise, and a store that accepts a
 * caller's object should not rely on a promise made in another module. A document over the bound
 * is refused with a `ValidationError` rather than silently truncated — a truncated detail record
 * that still claims to describe a transaction is worse than none.
 */
export const MAX_ASSOCIATION_DETAILS_BYTES = 256 * 1024;

/** The maximum number of association rows a single {@link ShieldedMonitorStore.readAssociations}
 *  page may return. A cap belongs at the store, not only at the API, so a harness or a future
 *  in-process consumer cannot ask for an unbounded page either (organizer spec FR-021). */
export const MAX_ASSOCIATION_PAGE = 1000;

// ── The interface ────────────────────────────────────────────────────────────────────────────

/**
 * Every operation project B performs on its own state.
 *
 * Two implementations satisfy it: `PgShieldedMonitorStore` (`storage-api/monitor-store-pg.ts`,
 * A side, one database transaction per method) and `HttpMonitorStore`
 * (`shielded-monitor/storage-http-client.ts`, B side, one HTTP request per method that the
 * storage API turns back into exactly that transaction). The narrow per-consumer interfaces —
 * `ScannerStore`, `ScannerServiceStore`, `DetailsBackfillStore` — are subsets of this one, and
 * stay subsets deliberately: a reader checking "what can the scanner write" reads seven method
 * names rather than this whole surface.
 */
export interface ShieldedMonitorStore {
  register(input: RegisterMonitorInput): Promise<MonitorRecord>;
  get(id: string): Promise<MonitorRecord>;
  getIncludingRevoked(id: string): Promise<MonitorRecord | undefined>;
  getByFingerprint(net: string, fingerprint: Uint8Array): Promise<MonitorRecord | undefined>;
  listActive(limit?: number): Promise<MonitorRecord[]>;
  listAll(limit?: number): Promise<MonitorRecord[]>;
  /** A monitor's unscanned ranges, lowest first. Also embedded in every {@link MonitorRecord};
   *  this route exists so a back-sync worker can re-read them without re-reading the monitor. */
  listGaps(monitorId: string): Promise<MonitorGap[]>;
  readAssociations(monitorId: string, afterSeq: bigint, limit: number): Promise<AssociationRecord[]>;
  readAssociationsMissingDetails(
    monitorId: string, afterSeq: bigint, limit: number,
  ): Promise<AssociationRecord[]>;
  listLifecycleEvents(monitorId: string): Promise<LifecycleEventRecord[]>;
  advance(
    monitorId: string,
    epoch: bigint,
    throughHeight: bigint,
    associations: readonly AssociationInput[],
    opts?: { readonly fromHeight?: bigint },
  ): Promise<AdvanceResult>;
  /**
   * ONE block, every monitor a node holds, ONE transaction (00009-09; owner Rule B).
   *
   * This is the live path: the node deserializes each transaction of block `height` once, tests
   * every held key against it, and commits the whole block's outcome — each monitor's associations,
   * each monitor's coverage move to `height`, and any gap rows the `HAS_SCANNED_ONCE` check
   * produced — in a single `BEGIN … COMMIT`. Rule B is therefore stronger than before, not weaker:
   * one height is one commit for the node as a whole rather than one commit per monitor.
   *
   * Per-item fences are reported, never thrown (OP-2).
   */
  advanceBatch(
    net: string,
    height: bigint,
    blockHash: Uint8Array,
    items: readonly AdvanceBatchItem[],
  ): Promise<AdvanceBatchResult>;
  /**
   * A back-sync's commit for one monitor: this range's associations, and the gap rows shrunk,
   * split or deleted to match — ONE transaction, fenced on `expectedEpoch`.
   *
   * Coverage is deliberately untouched: the range is BELOW `scannedThrough`, which is exactly why
   * a gap row existed for it.
   */
  fillGap(monitorId: string, input: FillGapInput): Promise<FillGapResult>;
  updateAssociationDetails(
    monitorId: string, expectedEpoch: bigint, updates: readonly AssociationDetailsUpdate[],
  ): Promise<{ readonly applied: number }>;
  bindArchiveSource(
    id: string,
    expectedEpoch: bigint,
    source: { readonly genesisHash: string; readonly instanceId: string },
  ): Promise<{ readonly applied: boolean; readonly monitor: MonitorRecord }>;
  goLive(id: string, expectedEpoch: bigint, actor: string): Promise<MonitorRecord>;
  pause(id: string, actor: string): Promise<MonitorRecord>;
  resume(id: string, actor: string): Promise<MonitorRecord>;
  markFailed(
    id: string, actor: string, error: MonitorLastError, expectedEpoch?: bigint,
  ): Promise<MonitorRecord>;
  markStaleSource(
    id: string, actor: string, error?: MonitorLastError, expectedEpoch?: bigint,
  ): Promise<MonitorRecord>;
  revoke(id: string, actor: string): Promise<MonitorRecord>;
  delete(id: string, actor: string): Promise<MonitorRecord | undefined>;
  recordAudit(
    actor: string, action: string, monitorId?: string, detail?: Record<string, unknown>,
  ): Promise<void>;
  listRevocations(): Promise<RevocationRecord[]>;
}
