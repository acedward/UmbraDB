import type { LifecycleEvent, MonitorState } from "./lifecycle.js";
import type { MatchDetails } from "./match-details.js";
import type { ShieldedViewingKey } from "./viewing-key.js";

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
 * **Deferred with User Story 4** (owner, 2026-09-10): `key_serialized` is plaintext, the
 * fingerprint is unkeyed, there is no tenant column and no least-privilege role script. The
 * storage-API boundary introduced here is exactly where at-rest encryption will sit when it
 * arrives (Q25's "first divide the process, then add the encryption").
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

/** A monitor row as callers see it. Deliberately carries **no fingerprint and no key**
 *  (organizer spec FR-003: fingerprints are never returned to callers). */
export interface MonitorRecord {
  readonly id: string;
  readonly net: string;
  readonly state: MonitorState;
  readonly epoch: bigint;
  readonly coverage: MonitorCoverage;
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

/** Everything registration needs besides the key itself. */
export interface RegisterMonitorInput {
  readonly key: ShieldedViewingKey;
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
      /** Present only when the caller asked for a lease renewal (00009-08). `false` means the
       *  lease had been taken by ANOTHER instance before this commit — the commit still happened
       *  and is still correct (the epoch fence, not the lease, is what admits it), but this
       *  instance should stop working on that monitor and let its new holder continue. */
      readonly leaseHeld?: boolean;
    }
  | {
      readonly applied: false;
      readonly reason: "already-advanced";
      readonly coverage: MonitorCoverage;
      readonly leaseHeld?: boolean;
    };

/** Who holds a monitor's scan lease, and until when (00009-08). */
export interface MonitorLeaseRecord {
  readonly monitorId: string;
  readonly owner: string;
  readonly claimedAt: Date;
  readonly expiresAt: Date;
}

/** What a caller asks for when it wants a batch commit to also renew its lease. */
export interface LeaseRenewal {
  readonly owner: string;
  readonly ttlMs: number;
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
  getKeyMaterial(id: string): Promise<Uint8Array>;
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
    opts?: { readonly fromHeight?: bigint; readonly lease?: LeaseRenewal },
  ): Promise<AdvanceResult>;
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
  claimMonitorLease(
    monitorId: string, owner: string, ttlMs: number,
  ): Promise<{ readonly acquired: boolean; readonly lease?: MonitorLeaseRecord }>;
  releaseMonitorLease(monitorId: string, owner: string): Promise<{ readonly released: boolean }>;
  readMonitorLease(monitorId: string): Promise<MonitorLeaseRecord | undefined>;
}
