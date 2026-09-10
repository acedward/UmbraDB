import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import type { UmbraDBSql } from "../src/postgres/client.js";
import { translatePostgresError } from "../src/postgres/errors.js";
import { ValidationError } from "../src/interfaces/storage-errors.js";
import { DEFAULT_SHIELDED_MONITOR_SCHEMA } from "./bootstrap.js";
import {
  MonitorFencedError,
  MonitorNotFoundError,
  MonitorRevokedError,
} from "./errors.js";
import {
  INITIAL_STATE,
  SCANNABLE_STATES,
  planDelete,
  refusesReads,
  transitionOrThrow,
  type LifecycleEvent,
  type MonitorState,
} from "./lifecycle.js";
import { NETWORK_ID_PATTERN } from "./fingerprint.js";
import type { ShieldedViewingKey } from "./viewing-key.js";

/**
 * The project-B monitor store (organizer spec FR-002..004, FR-010..016, FR-022, FR-025).
 *
 * **Owner Rule B is structural here, not conventional.** Every statement in this file is
 * schema-qualified with the schema handed to the constructor, and that schema is project B's
 * own; the string `chain_archive` does not appear in this module, and B's only knowledge of the
 * archive is the two opaque identity values a caller supplies. The rule's other half — one
 * `BEGIN … COMMIT` per block height, carrying that height's associations and its coverage
 * advance together — is {@link PgShieldedMonitorStore.advance}, and there is no other write path
 * a scanner can take.
 *
 * **The fence.** `monitors.epoch` is a monotone token bumped by every lifecycle transition. It is
 * checked inside the same `UPDATE` that advances coverage, so "check the fence" and "do the
 * write" are one statement and cannot be separated by a pause, a revoke or a scheduler. This is
 * the CAS shape of `Formal/STORAGE_ALGEBRA.md` §1's Law T2 applied to a different column; it does
 * not reopen §4's decision to keep fencing tokens out of the lease layer, because there is
 * exactly one downstream write path and it is the check itself.
 *
 * **Deferred with User Story 4** (owner, 2026-09-10): `key_serialized` is plaintext, the
 * fingerprint is unkeyed, there is no tenant column and no least-privilege role script. See
 * `SECURITY.md` and `docs/shielded-monitor-restore.md`.
 */

/** The `sql` handle `UmbraDBSql.begin(async (tx) => …)` hands its callback. Matches
 *  `src/postgres/chain-archive-store.ts`'s own `ChainArchiveTx` alias. */
type MonitorTx = TransactionSql<{ bigint: bigint }>;

// ── Boundary schemas (`design/design-interfaces.md` §1.4: Zod at the boundary) ───────────────

const NetSchema = z.string().regex(NETWORK_ID_PATTERN, "network id must match /^[A-Za-z0-9_-]{1,64}$/");
const UuidSchema = z.string().uuid();
const HeightSchema = z.bigint().nonnegative();
const OpaqueIdentitySchema = z.string().min(1).max(256);
const VersionSchema = z.string().min(1).max(64);
const LedgerBuildSchema = z.string().min(1).max(128);
const ActorSchema = z.string().min(1).max(128);

const RegisterInputSchema = z.object({
  net: NetSchema,
  requestedStartHeight: HeightSchema,
  matchingRuleVersion: VersionSchema,
  ledgerBuild: LedgerBuildSchema,
  sourceGenesisHash: OpaqueIdentitySchema.optional(),
  sourceInstanceId: OpaqueIdentitySchema.optional(),
  actor: ActorSchema,
});

const AssociationInputSchema = z.object({
  net: NetSchema,
  blockHeight: HeightSchema,
  blockHash: z.instanceof(Uint8Array).refine((b) => b.length >= 1 && b.length <= 64, "block hash must be 1..64 bytes"),
  position: z.number().int().nonnegative(),
  txHash: z.instanceof(Uint8Array).refine((b) => b.length >= 1 && b.length <= 64, "transaction hash must be 1..64 bytes"),
  protocolVersion: z.bigint().nonnegative(),
  matchedSegments: z.array(z.number().int().min(0).max(32767)).min(1),
  sourceOutcome: z.string().min(1).max(64).optional(),
  matchingRuleVersion: VersionSchema.optional(),
  ledgerBuild: LedgerBuildSchema.optional(),
});

/** The maximum number of association rows a single {@link PgShieldedMonitorStore.readAssociations}
 *  page may return. A cap belongs at the store, not only at the API, so a harness or a future
 *  in-process consumer cannot ask for an unbounded page either (organizer spec FR-021). */
export const MAX_ASSOCIATION_PAGE = 1000;

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
  readonly createdAt: Date;
}

/** The association payload a caller hands {@link PgShieldedMonitorStore.advance}. */
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
 * The outcome of {@link PgShieldedMonitorStore.advance}.
 *
 * `applied: false` is the crash-retry path, not a failure — see the class doc and the design doc
 * §6.
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

// ── Row shapes ───────────────────────────────────────────────────────────────────────────────

interface MonitorRow {
  id: string;
  net: string;
  state: string;
  epoch: bigint;
  last_assoc_seq: bigint;
  requested_start_height: bigint;
  scanned_from_height: bigint | null;
  scanned_through_height: bigint | null;
  source_genesis_hash: string | null;
  source_instance_id: string | null;
  matching_rule_version: string;
  ledger_build: string;
  last_error: MonitorLastError | null;
  created_at: Date;
  updated_at: Date;
}

interface AssociationRow {
  seq: bigint;
  net: string;
  block_height: bigint;
  block_hash: Buffer;
  position: number;
  tx_hash: Buffer;
  protocol_version: bigint;
  matched_segments: number[];
  applied_outcome: string;
  source_outcome: string | null;
  matching_rule_version: string;
  ledger_build: string;
  created_at: Date;
}

function toRecord(row: MonitorRow): MonitorRecord {
  return {
    id: row.id,
    net: row.net,
    state: row.state as MonitorState,
    epoch: row.epoch,
    coverage: {
      requestedStart: row.requested_start_height,
      ...(row.scanned_from_height !== null ? { scannedFrom: row.scanned_from_height } : {}),
      ...(row.scanned_through_height !== null ? { scannedThrough: row.scanned_through_height } : {}),
    },
    ...(row.source_genesis_hash !== null ? { sourceGenesisHash: row.source_genesis_hash } : {}),
    ...(row.source_instance_id !== null ? { sourceInstanceId: row.source_instance_id } : {}),
    matchingRuleVersion: row.matching_rule_version,
    ledgerBuild: row.ledger_build,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAssociation(row: AssociationRow): AssociationRecord {
  return {
    seq: row.seq,
    net: row.net,
    blockHeight: row.block_height,
    blockHash: row.block_hash,
    position: row.position,
    txHash: row.tx_hash,
    protocolVersion: row.protocol_version,
    matchedSegments: row.matched_segments,
    appliedOutcome: "unknown",
    ...(row.source_outcome !== null ? { sourceOutcome: row.source_outcome } : {}),
    matchingRuleVersion: row.matching_rule_version,
    ledgerBuild: row.ledger_build,
    createdAt: row.created_at,
  };
}

/**
 * Renders validated segment ids as a PostgreSQL array literal, bound as a plain text parameter
 * and cast server-side with `::smallint[]`.
 *
 * Deliberately not `sql.array(...)`: postgres.js infers the element type OID from the JavaScript
 * values and resolves the corresponding array OID from a map it populates at connect time, so a
 * plain number array can arrive as `int4[]`, and PostgreSQL has no implicit `int4[] → int2[]`
 * assignment cast. A literal plus an explicit cast has one obvious meaning and no dependency on
 * driver type inference. Every element has already been range-checked by
 * `AssociationInputSchema`, so no element can carry a quote, a brace or a sign.
 */
function segmentArrayLiteral(segments: readonly number[]): string {
  return `{${segments.join(",")}}`;
}

/** Parses `input` with `schema`, converting a Zod failure into this repository's
 *  `ValidationError` (`design/design-interfaces.md` §1.4). */
function parse<T>(schema: z.ZodType<T>, input: unknown, where: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw ValidationError.fromZod(where, result.error);
  return result.data;
}

export class PgShieldedMonitorStore {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly schema: string = DEFAULT_SHIELDED_MONITOR_SCHEMA,
  ) {}

  // ── Registration ───────────────────────────────────────────────────────────────────────────

  /**
   * Registers a viewing key, or returns the monitor that already holds it.
   *
   * Idempotent per `(net, fingerprint)` (organizer spec FR-004): the second registration of the
   * same key on the same network returns the first monitor rather than creating a duplicate.
   *
   * One case is deliberately NOT idempotent: a match in state `revoked` is refused with
   * {@link MonitorRevokedError} instead of being returned, because returning it would hand the
   * caller an id whose every read is refused, and minting a new one would let a blind retry undo
   * a revocation. Re-enabling a revoked key is an explicit `delete` (which sheds the fingerprint)
   * followed by a fresh registration. Recorded as organizer question Q11.
   */
  async register(input: RegisterMonitorInput): Promise<MonitorRecord> {
    const validated = parse(RegisterInputSchema, {
      net: input.net,
      requestedStartHeight: input.requestedStartHeight,
      matchingRuleVersion: input.matchingRuleVersion,
      ledgerBuild: input.ledgerBuild,
      sourceGenesisHash: input.sourceGenesisHash,
      sourceInstanceId: input.sourceInstanceId,
      actor: input.actor,
    }, "PgShieldedMonitorStore.register");

    if (input.key.net !== validated.net) {
      throw new ValidationError(
        "PgShieldedMonitorStore.register: the key was validated for a different network than the one supplied",
        [{ path: "net", message: `key network ${input.key.net} != requested ${validated.net}` }],
      );
    }

    const fingerprint = Buffer.from(input.key.fingerprint);
    const serialized = Buffer.from(input.key.yesIKnowTheSecurityImplicationsOfThis_serialized());

    try {
      return await this.sql.begin(async (tx) => {
        const existing = await tx<MonitorRow[]>`
          SELECT * FROM ${tx(this.schema)}.monitors
           WHERE net = ${validated.net} AND fingerprint = ${fingerprint}
           FOR UPDATE
        `;
        const found = existing[0];
        if (found !== undefined) {
          if (found.state === "revoked") throw new MonitorRevokedError(found.id);
          return toRecord(found);
        }

        const id = randomUUID();
        // `ON CONFLICT … DO NOTHING … RETURNING` returns no row when a concurrent transaction
        // inserted the same `(net, fingerprint)` between the SELECT above and this INSERT — the
        // `FOR UPDATE` there cannot lock a row that does not exist yet, so the race is real
        // however narrow. Treating it as an error would make idempotent registration (FR-004)
        // hold only when nobody registers twice at once; instead the caller falls through to
        // re-reading the winner below, which is what idempotency actually means.
        const inserted = await tx<MonitorRow[]>`
          INSERT INTO ${tx(this.schema)}.monitors (
            id, net, fingerprint, key_serialized, state, epoch, last_assoc_seq,
            requested_start_height, source_genesis_hash, source_instance_id,
            matching_rule_version, ledger_build
          ) VALUES (
            ${id}, ${validated.net}, ${fingerprint}, ${serialized}, ${INITIAL_STATE}, ${0n}, ${0n},
            ${validated.requestedStartHeight}, ${validated.sourceGenesisHash ?? null},
            ${validated.sourceInstanceId ?? null},
            ${validated.matchingRuleVersion}, ${validated.ledgerBuild}
          )
          ON CONFLICT (net, fingerprint) WHERE fingerprint IS NOT NULL DO NOTHING
          RETURNING *
        `;
        const row = inserted[0];
        if (row === undefined) {
          const winner = await tx<MonitorRow[]>`
            SELECT * FROM ${tx(this.schema)}.monitors
             WHERE net = ${validated.net} AND fingerprint = ${fingerprint}
          `;
          const raced = winner[0];
          if (raced === undefined) {
            // Unreachable under READ COMMITTED: `ON CONFLICT DO NOTHING` returning no row means
            // a committed row holds that key, and each statement in this transaction takes a
            // fresh snapshot, so the SELECT above sees it. Kept as a loud failure rather than a
            // silent `undefined` in case a future isolation-level change invalidates that.
            throw new Error(
              "PgShieldedMonitorStore.register: the insert conflicted but no monitor holds that identity",
            );
          }
          if (raced.state === "revoked") throw new MonitorRevokedError(raced.id);
          return toRecord(raced);
        }
        await this.appendLifecycleEvent(tx, id, "register", undefined, INITIAL_STATE, 0n, validated.actor);
        return toRecord(row);
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Consumer-facing read. Refuses a revoked monitor (organizer spec US3 scenario 3) and reports a
   * deleted one as not found, so a caller cannot tell a deleted monitor from one that never
   * existed (US3 scenario 4).
   */
  async get(id: string): Promise<MonitorRecord> {
    const row = await this.loadRow(id);
    if (row === undefined || row.state === "deleted") throw new MonitorNotFoundError(id);
    if (refusesReads(row.state as MonitorState)) throw new MonitorRevokedError(id);
    return toRecord(row);
  }

  /**
   * Internal/administrative read: returns the record whatever its state, including `revoked` and
   * `deleted`. Used by the lifecycle operations, the trusted harness and the tests — never to
   * serve a consumer, which is what {@link get} is for.
   */
  async getIncludingRevoked(id: string): Promise<MonitorRecord | undefined> {
    const row = await this.loadRow(id);
    return row === undefined ? undefined : toRecord(row);
  }

  /** Looks a monitor up by its registration identity. Takes the fingerprint rather than the key
   *  so no caller of this method needs to hold key material. */
  async getByFingerprint(net: string, fingerprint: Uint8Array): Promise<MonitorRecord | undefined> {
    parse(NetSchema, net, "PgShieldedMonitorStore.getByFingerprint");
    try {
      const rows = await this.sql<MonitorRow[]>`
        SELECT * FROM ${this.sql(this.schema)}.monitors
         WHERE net = ${net} AND fingerprint = ${Buffer.from(fingerprint)}
      `;
      const row = rows[0];
      return row === undefined ? undefined : toRecord(row);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Monitors a scanner may work on, oldest first. Bounded by `limit` (organizer spec FR-014). */
  async listActive(limit = 100): Promise<MonitorRecord[]> {
    const bounded = parse(z.number().int().positive().max(10_000), limit, "PgShieldedMonitorStore.listActive");
    try {
      const rows = await this.sql<MonitorRow[]>`
        SELECT * FROM ${this.sql(this.schema)}.monitors
         WHERE state IN ${this.sql(SCANNABLE_STATES as string[])}
         ORDER BY created_at, id
         LIMIT ${bounded}
      `;
      return rows.map(toRecord);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /**
   * The serialized viewing key of a scannable monitor.
   *
   * The single choke point through which key material leaves the database — which is exactly why
   * it is one small method: when at-rest encryption returns with User Story 4, decryption goes
   * here and nowhere else. Refuses revoked and deleted monitors.
   */
  async getKeyMaterial(id: string): Promise<Uint8Array> {
    parse(UuidSchema, id, "PgShieldedMonitorStore.getKeyMaterial");
    try {
      const rows = await this.sql<{ state: string; key_serialized: Buffer | null }[]>`
        SELECT state, key_serialized FROM ${this.sql(this.schema)}.monitors WHERE id = ${id}
      `;
      const row = rows[0];
      if (row === undefined || row.state === "deleted" || row.key_serialized === null) {
        throw new MonitorNotFoundError(id);
      }
      if (refusesReads(row.state as MonitorState)) throw new MonitorRevokedError(id);
      return Uint8Array.from(row.key_serialized);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /**
   * Pages a monitor's associations by the gapless per-monitor sequence, in `(blockHeight,
   * position)` order — which for this table is the same order as `seq`, because `seq` is
   * allocated in the fenced advance that writes them and coverage only moves forward.
   *
   * Refuses revoked monitors and reports deleted ones as not found (organizer spec FR-016).
   */
  async readAssociations(monitorId: string, afterSeq: bigint, limit: number): Promise<AssociationRecord[]> {
    parse(UuidSchema, monitorId, "PgShieldedMonitorStore.readAssociations");
    parse(z.bigint().nonnegative(), afterSeq, "PgShieldedMonitorStore.readAssociations");
    const bounded = parse(
      z.number().int().positive().max(MAX_ASSOCIATION_PAGE),
      limit,
      "PgShieldedMonitorStore.readAssociations",
    );
    const row = await this.loadRow(monitorId);
    if (row === undefined || row.state === "deleted") throw new MonitorNotFoundError(monitorId);
    if (refusesReads(row.state as MonitorState)) throw new MonitorRevokedError(monitorId);
    try {
      const rows = await this.sql<AssociationRow[]>`
        SELECT seq, net, block_height, block_hash, position, tx_hash, protocol_version,
               matched_segments, applied_outcome, source_outcome, matching_rule_version,
               ledger_build, created_at
          FROM ${this.sql(this.schema)}.associations
         WHERE monitor_id = ${monitorId} AND seq > ${afterSeq}
         ORDER BY seq
         LIMIT ${bounded}
      `;
      return rows.map(toAssociation);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** The full lifecycle log for a monitor, oldest first. Survives a delete. */
  async listLifecycleEvents(monitorId: string): Promise<LifecycleEventRecord[]> {
    parse(UuidSchema, monitorId, "PgShieldedMonitorStore.listLifecycleEvents");
    try {
      const rows = await this.sql<
        {
          seq: bigint; event: string; state_before: string | null; state_after: string;
          epoch_after: bigint; actor: string; at: Date;
        }[]
      >`
        SELECT seq, event, state_before, state_after, epoch_after, actor, at
          FROM ${this.sql(this.schema)}.lifecycle_events
         WHERE monitor_id = ${monitorId}
         ORDER BY seq
      `;
      return rows.map((r) => ({
        seq: r.seq,
        event: r.event as LifecycleEvent,
        ...(r.state_before !== null ? { stateBefore: r.state_before as MonitorState } : {}),
        stateAfter: r.state_after as MonitorState,
        epochAfter: r.epoch_after,
        actor: r.actor,
        at: r.at,
      }));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  // ── The fenced write path ──────────────────────────────────────────────────────────────────

  /**
   * Commits a batch of whole block heights: this batch's associations and the coverage advance to
   * `throughHeight`, in ONE transaction, fenced by `epoch` (owner Rule B; organizer spec FR-010,
   * FR-012).
   *
   * The fence and the write are the same statement. Its `WHERE` requires the stored epoch to
   * equal `epoch` and the state to be scannable, so a pause, revoke or delete that lands between
   * the caller loading the monitor and this commit matches zero rows and the whole transaction
   * aborts with nothing written.
   *
   * An empty `associations` array is normal — it is what a run of blocks with no matches looks
   * like — and still advances coverage.
   *
   * Zero updated rows has four causes, and they are not equally benign, so the method classifies
   * them inside the same transaction:
   *
   * - no such monitor → {@link MonitorNotFoundError}
   * - state not scannable → {@link MonitorFencedError} (`rejection: "state"`)
   * - epoch moved on → {@link MonitorFencedError} (`rejection: "epoch"`)
   * - coverage already at or past `throughHeight`, epoch and state fine → `{applied: false,
   *   reason: "already-advanced"}`
   *
   * That last case is the crash-retry path (organizer spec US5 scenario 2): a batch whose commit
   * succeeded but whose acknowledgement was lost is redone with the same arguments, and must be
   * told "already applied" rather than handed a fencing error it would misread as a lifecycle
   * event. Without the classification the two are indistinguishable.
   *
   * @param opts.fromHeight the first height this monitor's coverage begins at, used only on the
   *   very first advance. Defaults to the monitor's `requestedStart`; a caller passes it when the
   *   archive's earliest retained height is above the requested start, so the gap is recorded
   *   rather than hidden (organizer spec's "start height below retained history" edge case).
   */
  async advance(
    monitorId: string,
    epoch: bigint,
    throughHeight: bigint,
    associations: readonly AssociationInput[],
    opts: { readonly fromHeight?: bigint } = {},
  ): Promise<AdvanceResult> {
    parse(UuidSchema, monitorId, "PgShieldedMonitorStore.advance");
    parse(z.bigint().nonnegative(), epoch, "PgShieldedMonitorStore.advance");
    parse(HeightSchema, throughHeight, "PgShieldedMonitorStore.advance");
    if (opts.fromHeight !== undefined) parse(HeightSchema, opts.fromHeight, "PgShieldedMonitorStore.advance");
    // Sorted by (blockHeight, position) before sequence numbers are allocated, so `seq` order and
    // commit order ARE `(blockHeight, position)` order — structurally, not by trusting the caller
    // to pass a sorted batch. Organizer spec FR-019 requires matches to be returned in that
    // order with a stable cursor, and the cursor is `seq`; if the two could disagree, a page
    // boundary could skip or repeat a match for a caller whose batch happened to be unsorted.
    const rows = associations
      .map((a) => parse(AssociationInputSchema, a, "PgShieldedMonitorStore.advance"))
      .sort((a, b) => (a.blockHeight === b.blockHeight
        ? a.position - b.position
        : a.blockHeight < b.blockHeight ? -1 : 1));
    for (const a of rows) {
      if (a.blockHeight > throughHeight) {
        throw new ValidationError(
          "PgShieldedMonitorStore.advance: an association names a block height above the batch's through-height",
          [{ path: "associations", message: `blockHeight ${a.blockHeight} > throughHeight ${throughHeight}` }],
        );
      }
    }

    try {
      return await this.sql.begin(async (tx) => {
        // THE fence. Coverage advance and sequence allocation in one statement, admitted only
        // for the expected epoch, a scannable state and a strictly forward coverage move.
        const updated = await tx<MonitorRow[]>`
          UPDATE ${tx(this.schema)}.monitors
             SET scanned_from_height    = COALESCE(scanned_from_height, ${opts.fromHeight ?? null}, requested_start_height),
                 scanned_through_height = ${throughHeight},
                 last_assoc_seq         = last_assoc_seq + ${BigInt(rows.length)},
                 updated_at             = now()
           WHERE id = ${monitorId}
             AND epoch = ${epoch}
             AND state IN ${tx(SCANNABLE_STATES as string[])}
             AND (scanned_through_height IS NULL OR scanned_through_height < ${throughHeight})
          RETURNING *
        `;

        const row = updated[0];
        if (row === undefined) return await this.classifyFenceMiss(tx, monitorId, epoch);

        const base = row.last_assoc_seq - BigInt(rows.length);
        for (const [index, a] of rows.entries()) {
          await tx`
            INSERT INTO ${tx(this.schema)}.associations (
              monitor_id, seq, net, block_height, block_hash, position, tx_hash,
              protocol_version, matched_segments, applied_outcome, source_outcome,
              matching_rule_version, ledger_build
            ) VALUES (
              ${monitorId}, ${base + BigInt(index) + 1n}, ${a.net}, ${a.blockHeight},
              ${Buffer.from(a.blockHash)}, ${a.position}, ${Buffer.from(a.txHash)},
              ${a.protocolVersion}, ${segmentArrayLiteral(a.matchedSegments)}::smallint[], 'unknown',
              ${a.sourceOutcome ?? null},
              ${a.matchingRuleVersion ?? row.matching_rule_version},
              ${a.ledgerBuild ?? row.ledger_build}
            )
          `;
        }

        return {
          applied: true,
          firstSeq: base + 1n,
          lastSeq: row.last_assoc_seq,
          coverage: toRecord(row).coverage,
        } as const;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Reads the row that the fencing `UPDATE` failed to match and turns "zero rows" into the
   *  specific outcome. Runs inside the advance transaction, so the classification cannot race
   *  with a concurrent transition. */
  private async classifyFenceMiss(tx: MonitorTx, monitorId: string, epoch: bigint): Promise<AdvanceResult> {
    const current = await tx<MonitorRow[]>`
      SELECT * FROM ${tx(this.schema)}.monitors WHERE id = ${monitorId} FOR SHARE
    `;
    const row = current[0];
    if (row === undefined) throw new MonitorNotFoundError(monitorId);
    const observed = { epoch: row.epoch, state: row.state };
    if (!(SCANNABLE_STATES as string[]).includes(row.state)) {
      throw new MonitorFencedError(monitorId, "state", observed);
    }
    if (row.epoch !== epoch) throw new MonitorFencedError(monitorId, "epoch", observed);
    // Epoch and state are fine, so the only remaining cause is the monotonic coverage guard:
    // this batch has already been committed. Idempotent replay, not a failure.
    return { applied: false, reason: "already-advanced", coverage: toRecord(row).coverage } as const;
  }

  /**
   * Binds a monitor to the archive identity it is being scanned against (organizer spec FR-013),
   * first-write-wins.
   *
   * Registration may leave `(source_genesis_hash, source_instance_id)` unset — the API that
   * accepts a viewing key has no reason to hold an archive handle, and Phase 2 deliberately kept
   * the store free of any compile-time dependency on the read contract. The scanner, which does
   * hold one, binds the monitor the first time it works on it, and every later batch compares.
   *
   * **First-write-wins, never overwrite.** The `WHERE` clause requires both columns to be NULL,
   * so a monitor already bound to archive X can never be silently re-bound to archive Y: that is
   * precisely the history-mixing FR-013 exists to prevent, and it must surface as
   * {@link PgShieldedMonitorStore.markStaleSource}, not as a quiet update. A caller that finds
   * `applied: false` must re-read and compare.
   *
   * Fenced on `expectedEpoch` like every other worker write (FR-012), and restricted to
   * scannable states so a paused or revoked monitor cannot be bound underneath its consumer.
   *
   * NOT part of the Rule B per-height transaction, and deliberately so: an identity binding is
   * not a block height's data. Rule B constrains what must commit TOGETHER (a height's
   * associations and its coverage advance); it does not forbid B from making other writes to its
   * own schema.
   */
  async bindArchiveSource(
    id: string,
    expectedEpoch: bigint,
    source: { readonly genesisHash: string; readonly instanceId: string },
  ): Promise<{ readonly applied: boolean; readonly monitor: MonitorRecord }> {
    parse(UuidSchema, id, "PgShieldedMonitorStore.bindArchiveSource");
    parse(z.bigint().nonnegative(), expectedEpoch, "PgShieldedMonitorStore.bindArchiveSource");
    parse(OpaqueIdentitySchema, source.genesisHash, "PgShieldedMonitorStore.bindArchiveSource");
    parse(OpaqueIdentitySchema, source.instanceId, "PgShieldedMonitorStore.bindArchiveSource");
    try {
      return await this.sql.begin(async (tx) => {
        const updated = await tx<MonitorRow[]>`
          UPDATE ${tx(this.schema)}.monitors
             SET source_genesis_hash = ${source.genesisHash},
                 source_instance_id  = ${source.instanceId},
                 updated_at          = now()
           WHERE id = ${id}
             AND epoch = ${expectedEpoch}
             AND state IN ${tx(SCANNABLE_STATES as string[])}
             AND source_genesis_hash IS NULL
             AND source_instance_id IS NULL
          RETURNING *
        `;
        const row = updated[0];
        if (row !== undefined) return { applied: true, monitor: toRecord(row) };

        const current = await tx<MonitorRow[]>`
          SELECT * FROM ${tx(this.schema)}.monitors WHERE id = ${id} FOR SHARE
        `;
        const existing = current[0];
        if (existing === undefined) throw new MonitorNotFoundError(id);
        if (!(SCANNABLE_STATES as string[]).includes(existing.state)) {
          throw new MonitorFencedError(id, "state", { epoch: existing.epoch, state: existing.state });
        }
        if (existing.epoch !== expectedEpoch) {
          throw new MonitorFencedError(id, "epoch", { epoch: existing.epoch, state: existing.state });
        }
        // Already bound. Not an error: the caller compares and decides (bind matched → carry on;
        // bind differs → `markStaleSource`).
        return { applied: false, monitor: toRecord(existing) };
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────

  /** `backfilling → live`: coverage has reached the archive tip. Fenced, because promoting a
   *  monitor a consumer just paused would be as wrong as advancing its coverage. */
  async goLive(id: string, expectedEpoch: bigint, actor: string): Promise<MonitorRecord> {
    return this.applyEvent(id, "go_live", actor, expectedEpoch);
  }

  /** Freezes coverage. Matches stay readable (organizer spec US3 scenario 1). Idempotent. */
  async pause(id: string, actor: string): Promise<MonitorRecord> {
    return this.applyEvent(id, "pause", actor);
  }

  /** Returns a paused monitor to `backfilling`; scanning continues from the persisted
   *  `scannedThrough` (organizer spec US3 scenario 2). Idempotent in the sense that resuming a
   *  monitor that is not paused is an illegal transition, not a silent no-op — resuming something
   *  that was never paused is a caller bug worth surfacing. */
  async resume(id: string, actor: string): Promise<MonitorRecord> {
    return this.applyEvent(id, "resume", actor);
  }

  /**
   * Fail-closed stop with a typed, non-secret reason (organizer spec's unsupported-version and
   * undecodable-transaction edge cases). Idempotent.
   *
   * `expectedEpoch` is optional and exists for the scanner: organizer spec FR-012 fences *every*
   * worker write on the loaded epoch, and marking a monitor failed is a worker write. Without
   * the fence, a worker that has been paused mid-batch could still stop a monitor its consumer
   * had just taken control of. An operator acting on the current state (the harness) omits it.
   */
  async markFailed(
    id: string, actor: string, error: MonitorLastError, expectedEpoch?: bigint,
  ): Promise<MonitorRecord> {
    return this.applyEvent(id, "fail", actor, expectedEpoch, error);
  }

  /** The archive this monitor was bound to was rebuilt (organizer spec FR-013). Idempotent.
   *  `expectedEpoch` fences it for the same reason as {@link markFailed}. */
  async markStaleSource(
    id: string, actor: string, error?: MonitorLastError, expectedEpoch?: bigint,
  ): Promise<MonitorRecord> {
    return this.applyEvent(id, "mark_stale_source", actor, expectedEpoch, error);
  }

  /** Stops processing and refuses further reads (organizer spec FR-016). Idempotent. */
  async revoke(id: string, actor: string): Promise<MonitorRecord> {
    return this.applyEvent(id, "revoke", actor);
  }

  /**
   * Destroys the key and every association row, leaving a `deleted` tombstone whose fingerprint
   * is also shed (organizer spec FR-016, US3 scenario 4).
   *
   * From a non-revoked state this performs `revoke` then `delete` as two transitions with two
   * epoch bumps and two lifecycle events, so FR-015's `any → revoked → deleted` path is honoured
   * literally and the audit trail of a deleted monitor always shows the revoke. Idempotent.
   *
   * The lifecycle log survives; it is the record of what was done, and a delete is one of the
   * things that was done.
   */
  async delete(id: string, actor: string): Promise<MonitorRecord | undefined> {
    parse(UuidSchema, id, "PgShieldedMonitorStore.delete");
    parse(ActorSchema, actor, "PgShieldedMonitorStore.delete");
    try {
      return await this.sql.begin(async (tx) => {
        const rows = await tx<MonitorRow[]>`
          SELECT * FROM ${tx(this.schema)}.monitors WHERE id = ${id} FOR UPDATE
        `;
        const loaded = rows[0];
        if (loaded === undefined) return undefined;
        let row: MonitorRow = loaded;

        for (const event of planDelete(row.state as MonitorState)) {
          const from = row.state as MonitorState;
          const outcome = transitionOrThrow(from, event);
          if (outcome.kind === "noop") continue;
          const epochAfter = row.epoch + 1n;
          if (event === "delete") {
            // The key and every derived row go in the same transaction as the state change, so a
            // crash mid-delete leaves either a fully live monitor or a fully shredded one
            // (organizer spec US3 scenario 4).
            await tx`DELETE FROM ${tx(this.schema)}.associations WHERE monitor_id = ${id}`;
            const done = await tx<MonitorRow[]>`
              UPDATE ${tx(this.schema)}.monitors
                 SET state = ${outcome.to}, epoch = ${epochAfter},
                     key_serialized = NULL, fingerprint = NULL, updated_at = now()
               WHERE id = ${id} AND epoch = ${row.epoch}
              RETURNING *
            `;
            row = done[0]!;
          } else {
            const done = await tx<MonitorRow[]>`
              UPDATE ${tx(this.schema)}.monitors
                 SET state = ${outcome.to}, epoch = ${epochAfter}, updated_at = now()
               WHERE id = ${id} AND epoch = ${row.epoch}
              RETURNING *
            `;
            row = done[0]!;
          }
          await this.appendLifecycleEvent(tx, id, event, from, outcome.to, epochAfter, actor);
        }
        return toRecord(row);
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /**
   * The one place a lifecycle transition is written.
   *
   * Loads the row `FOR UPDATE`, asks the pure state machine what the event means, and — for a
   * real transition — bumps the epoch by exactly one, writes the new state and appends the
   * lifecycle event, all in one transaction. A no-op (a re-issued `pause` on an already-paused
   * monitor, a `revoke` on an already-revoked one) writes nothing at all: bumping the epoch on an
   * idempotent retry would let a client that retries on a timeout fence a healthy worker off its
   * own monitor indefinitely.
   *
   * `expectedEpoch`, when given, fences the transition itself — used by `goLive`, which is issued
   * by a scanner holding a loaded view rather than by an operator acting on the current state.
   */
  private async applyEvent(
    id: string,
    event: LifecycleEvent,
    actor: string,
    expectedEpoch?: bigint,
    lastError?: MonitorLastError,
  ): Promise<MonitorRecord> {
    parse(UuidSchema, id, `PgShieldedMonitorStore.${event}`);
    parse(ActorSchema, actor, `PgShieldedMonitorStore.${event}`);
    try {
      return await this.sql.begin(async (tx) => {
        const rows = await tx<MonitorRow[]>`
          SELECT * FROM ${tx(this.schema)}.monitors WHERE id = ${id} FOR UPDATE
        `;
        const row = rows[0];
        if (row === undefined) throw new MonitorNotFoundError(id);
        if (expectedEpoch !== undefined && row.epoch !== expectedEpoch) {
          throw new MonitorFencedError(id, "epoch", { epoch: row.epoch, state: row.state });
        }

        const from = row.state as MonitorState;
        const outcome = transitionOrThrow(from, event);
        if (outcome.kind === "noop") return toRecord(row);

        const epochAfter = row.epoch + 1n;
        // Two statements rather than one with a conditional fragment: `last_error` must be left
        // untouched when the caller did not supply one (a pause must not erase the reason a
        // monitor previously failed), and an inline `SET last_error = <fragment or value>` reads
        // as a place a future edit silently drops the distinction.
        const updated = lastError === undefined
          ? await tx<MonitorRow[]>`
              UPDATE ${tx(this.schema)}.monitors
                 SET state = ${outcome.to}, epoch = ${epochAfter}, updated_at = now()
               WHERE id = ${id} AND epoch = ${row.epoch}
              RETURNING *
            `
          : await tx<MonitorRow[]>`
              UPDATE ${tx(this.schema)}.monitors
                 SET state = ${outcome.to}, epoch = ${epochAfter},
                     last_error = ${tx.json(lastError as never)}, updated_at = now()
               WHERE id = ${id} AND epoch = ${row.epoch}
              RETURNING *
            `;
        await this.appendLifecycleEvent(tx, id, event, from, outcome.to, epochAfter, actor);
        return toRecord(updated[0]!);
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Appends one lifecycle event, allocating its per-monitor sequence inside the caller's
   *  transaction. */
  private async appendLifecycleEvent(
    tx: MonitorTx,
    monitorId: string,
    event: LifecycleEvent,
    stateBefore: MonitorState | undefined,
    stateAfter: MonitorState,
    epochAfter: bigint,
    actor: string,
  ): Promise<void> {
    await tx`
      INSERT INTO ${tx(this.schema)}.lifecycle_events
        (monitor_id, seq, event, state_before, state_after, epoch_after, actor)
      SELECT ${monitorId},
             COALESCE(MAX(seq), 0) + 1,
             ${event}, ${stateBefore ?? null}, ${stateAfter}, ${epochAfter}, ${actor}
        FROM ${tx(this.schema)}.lifecycle_events
       WHERE monitor_id = ${monitorId}
    `;
  }

  /** Writes one operator-facing audit entry. `detail` must never carry key material; the callers
   *  in this repository record failure classes and counts only. */
  async recordAudit(
    actor: string, action: string, monitorId?: string, detail?: Record<string, unknown>,
  ): Promise<void> {
    parse(ActorSchema, actor, "PgShieldedMonitorStore.recordAudit");
    parse(z.string().min(1).max(64), action, "PgShieldedMonitorStore.recordAudit");
    try {
      await this.sql`
        INSERT INTO ${this.sql(this.schema)}.audit_events (actor, action, monitor_id, detail)
        VALUES (${actor}, ${action}, ${monitorId ?? null}, ${detail === undefined ? null : this.sql.json(detail as never)})
      `;
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Every monitor whose access must stay refused after a restore (organizer spec FR-024). */
  async listRevocations(): Promise<RevocationRecord[]> {
    try {
      const rows = await this.sql<
        { id: string; net: string; state: string; epoch: bigint; updated_at: Date }[]
      >`
        SELECT id, net, state, epoch, updated_at
          FROM ${this.sql(this.schema)}.monitors
         WHERE state IN ('revoked', 'deleted')
         ORDER BY updated_at, id
      `;
      return rows.map((r) => ({
        monitorId: r.id,
        net: r.net,
        state: r.state as "revoked" | "deleted",
        epoch: r.epoch.toString(),
        at: r.updated_at.toISOString(),
      }));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  private async loadRow(id: string): Promise<MonitorRow | undefined> {
    parse(UuidSchema, id, "PgShieldedMonitorStore.loadRow");
    try {
      const rows = await this.sql<MonitorRow[]>`
        SELECT * FROM ${this.sql(this.schema)}.monitors WHERE id = ${id}
      `;
      return rows[0];
    } catch (err) {
      throw translatePostgresError(err);
    }
  }
}
