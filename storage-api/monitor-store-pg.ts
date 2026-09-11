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
} from "../shielded-monitor/errors.js";
import {
  INITIAL_STATE,
  SCANNABLE_STATES,
  planDelete,
  refusesReads,
  transitionOrThrow,
  type LifecycleEvent,
  type MonitorState,
} from "../shielded-monitor/lifecycle.js";
import { NETWORK_ID_PATTERN } from "../shielded-monitor/fingerprint.js";
import type { MatchDetails } from "../shielded-monitor/match-details.js";
import {
  MAX_ASSOCIATION_DETAILS_BYTES,
  MAX_ASSOCIATION_PAGE,
  type AdvanceResult,
  type AssociationDetailsUpdate,
  type AssociationInput,
  type AssociationRecord,
  type LeaseRenewal,
  type LifecycleEventRecord,
  type MonitorLastError,
  type MonitorLeaseRecord,
  type MonitorRecord,
  type RegisterMonitorInput,
  type RevocationRecord,
  type ShieldedMonitorStore,
} from "../shielded-monitor/store.js";

/**
 * The project-B monitor store, as **project A executes it** (organizer spec FR-002..004,
 * FR-010..016, FR-022, FR-025; sub-plan 00009-08 v2).
 *
 * ── Why this file is on A's side of the line (00009-08 v2, owner question Q25) ───────────────
 * Project B has no database connection. This class is what `umbradb-storage-api` runs on B's
 * behalf, one method per storage-API command, one command per `BEGIN … COMMIT`. Its record
 * shapes and its interface live in `shielded-monitor/store.ts`, which both sides import; nothing
 * under `shielded-monitor/**` imports THIS file, and `test/shielded-monitor/import-boundary.
 * test.ts` fails if anything ever does.
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

/** `details` is validated as a bounded JSON OBJECT, not against the full {@link MatchDetails}
 *  shape. Restating that shape here would create a second definition of it that could drift from
 *  the producer's, and the column is `jsonb`: what the database must be protected from is a
 *  non-object, an unbounded document, or one carrying an escaped NUL (which PostgreSQL's `jsonb`
 *  rejects at write time with an opaque error). Those three are exactly what this checks. */
const DetailsSchema = z
  .custom<MatchDetails>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    "details must be a JSON object",
  )
  .refine((value) => {
    const encoded = JSON.stringify(value);
    return (
      encoded !== undefined &&
      encoded.length <= MAX_ASSOCIATION_DETAILS_BYTES &&
      !encoded.includes("\\u0000")
    );
  }, `details must encode to at most ${MAX_ASSOCIATION_DETAILS_BYTES} JSON characters and must not contain an escaped NUL`);

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
  // 00009-07, both additive and both optional: an association written without them is exactly the
  // pre-00009-07 row, which is what keeps the migration additive in behaviour as well as in DDL.
  details: DetailsSchema.optional(),
  blockTimestampMs: z.bigint().nonnegative().optional(),
});

const AssociationDetailsUpdateSchema = z.object({
  seq: z.bigint().positive(),
  details: DetailsSchema,
  blockTimestampMs: z.bigint().nonnegative().optional(),
});

/** A lease owner is an operator-chosen label or a random UUID (`SCAN_INSTANCE_ID`). Bounded so a
 *  caller cannot write an arbitrary blob into a column an operator reads. */
const LeaseOwnerSchema = z.string().min(1).max(128);
/** 1 s .. 1 h. A sub-second lease would expire inside a single batch on a slow block; an
 *  hour-long one would make a crashed instance's monitors unreachable for an hour. */
const LeaseTtlSchema = z.number().int().min(1_000).max(3_600_000);

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

interface LeaseRow {
  monitor_id: string;
  owner: string;
  claimed_at: Date;
  expires_at: Date;
}

function toLease(row: LeaseRow): MonitorLeaseRecord {
  return {
    monitorId: row.monitor_id,
    owner: row.owner,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
  };
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
  details: MatchDetails | null;
  block_timestamp_ms: bigint | null;
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
    // `null` in the column becomes ABSENT in the record, so every consumer has one spelling for
    // "not recorded yet" and none of them has to decide whether `null` and `undefined` differ.
    ...(row.details !== null ? { details: row.details } : {}),
    ...(row.block_timestamp_ms !== null ? { blockTimestampMs: row.block_timestamp_ms } : {}),
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

export class PgShieldedMonitorStore implements ShieldedMonitorStore {
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
   * Every monitor this deployment holds, oldest first, for an OPERATOR view (organizer spec
   * FR-017's list surface, 00009-06). Bounded by `limit`, exactly as {@link listActive} is.
   *
   * Two differences from {@link listActive}, both deliberate:
   *
   * - **Every state except `deleted`** — including `paused`, `failed`, `stale_source` and
   *   `revoked`. `listActive` answers a scanner's question ("what may I work on?"); this answers
   *   an operator's ("what exists?"), and a monitor that stopped is precisely the one they need
   *   to see. A `revoked` monitor is listed even though {@link get} refuses it: the refusal
   *   protects that monitor's *data*, and hiding the row instead would leave the operator with a
   *   revoked monitor they can no longer name in order to delete it. See the change's design §2.
   * - **`deleted` is excluded, and that is not negotiable.** Organizer spec US3 scenario 4
   *   requires a deleted monitor to be indistinguishable from one that never existed; listing a
   *   tombstone would break that literally.
   *
   * Ordered `created_at, id`: `created_at` is the order an operator registered them in and is
   * stable as states change, and `id` is the tiebreak that keeps the order total when two rows
   * share a timestamp (`Formal/STORAGE_ALGEBRA.md` §3 — a paged read needs a total order or a
   * page boundary can repeat or drop a row).
   */
  async listAll(limit = 100): Promise<MonitorRecord[]> {
    const bounded = parse(z.number().int().positive().max(10_000), limit, "PgShieldedMonitorStore.listAll");
    try {
      const rows = await this.sql<MonitorRow[]>`
        SELECT * FROM ${this.sql(this.schema)}.monitors
         WHERE state <> 'deleted'
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
               ledger_build, details, block_timestamp_ms, created_at
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

  /**
   * The details backfill's work list: this monitor's associations that carry no `details` yet,
   * oldest first (00009-07).
   *
   * Ordered by `seq`, which is `(blockHeight, position)` order, so a backfill that walks pages of
   * this list visits history forwards and its progress is describable as a height. Rows already
   * carrying details are never returned, which is what makes a re-run cheap rather than a
   * re-scan: the partial index `associations_details_missing` shrinks to nothing as the backfill
   * completes.
   *
   * `afterSeq` is an EXCLUSIVE lower bound on the sequence, exactly like
   * {@link PgShieldedMonitorStore.readAssociations}. It exists so a backfill that legitimately
   * cannot fill a row — a block the archive no longer holds, a re-evaluation that disagrees with
   * the recorded match — walks PAST it instead of re-reading the same head page forever. Without
   * it, one unfillable row would stall the whole monitor.
   *
   * Refuses revoked monitors and reports deleted ones as not found, exactly like
   * {@link PgShieldedMonitorStore.readAssociations} — a backfill must not become a way to read a
   * monitor the lifecycle has closed.
   */
  async readAssociationsMissingDetails(
    monitorId: string, afterSeq: bigint, limit: number,
  ): Promise<AssociationRecord[]> {
    parse(UuidSchema, monitorId, "PgShieldedMonitorStore.readAssociationsMissingDetails");
    parse(z.bigint().nonnegative(), afterSeq, "PgShieldedMonitorStore.readAssociationsMissingDetails");
    const bounded = parse(
      z.number().int().positive().max(MAX_ASSOCIATION_PAGE),
      limit,
      "PgShieldedMonitorStore.readAssociationsMissingDetails",
    );
    const row = await this.loadRow(monitorId);
    if (row === undefined || row.state === "deleted") throw new MonitorNotFoundError(monitorId);
    if (refusesReads(row.state as MonitorState)) throw new MonitorRevokedError(monitorId);
    try {
      const rows = await this.sql<AssociationRow[]>`
        SELECT seq, net, block_height, block_hash, position, tx_hash, protocol_version,
               matched_segments, applied_outcome, source_outcome, matching_rule_version,
               ledger_build, details, block_timestamp_ms, created_at
          FROM ${this.sql(this.schema)}.associations
         WHERE monitor_id = ${monitorId} AND seq > ${afterSeq} AND details IS NULL
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
    opts: { readonly fromHeight?: bigint; readonly lease?: LeaseRenewal } = {},
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
              matching_rule_version, ledger_build, details, block_timestamp_ms
            ) VALUES (
              ${monitorId}, ${base + BigInt(index) + 1n}, ${a.net}, ${a.blockHeight},
              ${Buffer.from(a.blockHash)}, ${a.position}, ${Buffer.from(a.txHash)},
              ${a.protocolVersion}, ${segmentArrayLiteral(a.matchedSegments)}::smallint[], 'unknown',
              ${a.sourceOutcome ?? null},
              ${a.matchingRuleVersion ?? row.matching_rule_version},
              ${a.ledgerBuild ?? row.ledger_build},
              -- 00009-07: written INSIDE this same transaction, so a match's details and the
              -- coverage advance that admits it are one commit unit (owner Rule B). A crash can
              -- therefore never leave a match whose details describe a different scan.
              ${a.details === undefined ? null : tx.json(a.details as never)},
              ${a.blockTimestampMs ?? null}
            )
          `;
        }

        // 00009-08: the lease renewal rides in THIS transaction, with the associations and the
        // coverage advance. Not "soon after" and not in a timer: if the renewal were a separate
        // statement, a crash between the two would leave a height committed under a lease that
        // had already lapsed, and the takeover would begin while the previous holder still
        // believed it was mid-turn. One commit, one observable state — the same rule the height's
        // own data follows (owner Rule B), extended to the claim that produced it.
        const leaseHeld = opts.lease === undefined
          ? undefined
          : await this.renewLeaseInTx(tx, monitorId, opts.lease);

        return {
          applied: true,
          firstSeq: base + 1n,
          lastSeq: row.last_assoc_seq,
          coverage: toRecord(row).coverage,
          ...(leaseHeld === undefined ? {} : { leaseHeld }),
        } as const;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /**
   * Fills in `details`/`block_timestamp_ms` for associations that were written before this data
   * existed (00009-07's backfill), for ONE monitor, in ONE transaction, fenced by `epoch`.
   *
   * **Fill-only, and that is what makes it idempotent.** Each row is updated under
   * `WHERE … AND details IS NULL`, so a second run over the same range updates zero rows and
   * reports `applied: 0` — the plan's "fills NULL rows exactly once" is a property of the
   * predicate, not of the caller remembering where it got to. A details record whose
   * `MATCH_DETAILS_VERSION` later changes is therefore NOT re-derived by re-running the
   * backfill; that would be a deliberate re-derivation and needs its own opt-in, which this alpha
   * does not ship.
   *
   * **What it may NOT change.** Nothing about the match itself: not the height, the position, the
   * transaction hash, the matched segments, the outcome or the coverage. The `SET` list is two
   * columns that were `NULL`, so a backfill cannot rewrite history even if it is wrong about the
   * bytes — the worst it can do is record a detail row that a later fix overwrites via `NULL`ing.
   *
   * **The fence.** The monitor row is locked `FOR UPDATE` and its epoch compared inside the same
   * transaction, so a pause, resume, revoke or delete landing under a running backfill either
   * happens before the lock (and the commit is refused with {@link MonitorFencedError}) or after
   * it (and sees a committed, consistent set of rows). Revoked and deleted monitors are refused
   * outright — the backfill is not a hole in US3's "stop processing".
   *
   * Deliberately NOT restricted to {@link SCANNABLE_STATES}: a `paused`, `failed` or
   * `stale_source` monitor's already-recorded matches are still readable through the API
   * (FR-020), so leaving them permanently detail-less would make the placeholder the dashboard
   * shows for them a lie about what the operator can do.
   *
   * @returns how many rows this call actually filled.
   */
  async updateAssociationDetails(
    monitorId: string,
    expectedEpoch: bigint,
    updates: readonly AssociationDetailsUpdate[],
  ): Promise<{ readonly applied: number }> {
    parse(UuidSchema, monitorId, "PgShieldedMonitorStore.updateAssociationDetails");
    parse(z.bigint().nonnegative(), expectedEpoch, "PgShieldedMonitorStore.updateAssociationDetails");
    const rows = parse(
      z.array(AssociationDetailsUpdateSchema).max(MAX_ASSOCIATION_PAGE),
      updates,
      "PgShieldedMonitorStore.updateAssociationDetails",
    );
    if (rows.length === 0) return { applied: 0 };

    try {
      return await this.sql.begin(async (tx) => {
        const current = await tx<MonitorRow[]>`
          SELECT * FROM ${tx(this.schema)}.monitors WHERE id = ${monitorId} FOR UPDATE
        `;
        const monitor = current[0];
        if (monitor === undefined || monitor.state === "deleted") throw new MonitorNotFoundError(monitorId);
        if (refusesReads(monitor.state as MonitorState)) throw new MonitorRevokedError(monitorId);
        if (monitor.epoch !== expectedEpoch) {
          throw new MonitorFencedError(monitorId, "epoch", { epoch: monitor.epoch, state: monitor.state });
        }

        let applied = 0;
        for (const update of rows) {
          const updated = await tx<{ seq: bigint }[]>`
            UPDATE ${tx(this.schema)}.associations
               SET details            = ${tx.json(update.details as never)},
                   -- COALESCE, not an assignment: when the archive has no timestamp for that
                   -- height the update carries none, and overwriting an existing value with NULL
                   -- would DELETE a recorded fact to record a different one. A backfill may add,
                   -- never remove.
                   block_timestamp_ms = COALESCE(${update.blockTimestampMs ?? null}::bigint,
                                                 block_timestamp_ms)
             WHERE monitor_id = ${monitorId}
               AND seq = ${update.seq}
               AND details IS NULL
            RETURNING seq
          `;
          if (updated.length > 0) applied += 1;
        }
        return { applied } as const;
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

  // ── Monitor leases (00009-08) ──────────────────────────────────────────────────────────────

  /**
   * Claim a monitor for this scanner instance, or report that someone else holds it.
   *
   * ONE statement, so the read and the write cannot race: `INSERT … ON CONFLICT DO UPDATE`
   * where the update is admitted only when the existing lease has EXPIRED or is already ours.
   * `RETURNING` therefore yields a row exactly when the claim succeeded, and no rows when another
   * instance's unexpired lease stood in the way — which is the whole answer, with no second query
   * whose result could have changed in between.
   *
   * "…or is already ours" is not a convenience: a scanner re-claims the monitor it is already
   * working on at the top of every cycle, and without that clause it would lose its own monitor
   * to itself the moment the first TTL elapsed.
   *
   * **This is not a lock** (see `003_monitor_leases.ts`): a successful claim does not make a
   * commit safe, and a failed one does not make it unsafe. It decides who does the WORK.
   */
  async claimMonitorLease(
    monitorId: string, owner: string, ttlMs: number,
  ): Promise<{ readonly acquired: boolean; readonly lease?: MonitorLeaseRecord }> {
    parse(UuidSchema, monitorId, "PgShieldedMonitorStore.claimMonitorLease");
    parse(LeaseOwnerSchema, owner, "PgShieldedMonitorStore.claimMonitorLease");
    parse(LeaseTtlSchema, ttlMs, "PgShieldedMonitorStore.claimMonitorLease");
    try {
      const rows = await this.sql<LeaseRow[]>`
        INSERT INTO ${this.sql(this.schema)}.monitor_leases (monitor_id, owner, claimed_at, expires_at)
        VALUES (${monitorId}, ${owner}, now(), now() + make_interval(secs => ${ttlMs / 1000}))
        ON CONFLICT (monitor_id) DO UPDATE
           SET owner = EXCLUDED.owner, claimed_at = now(), expires_at = EXCLUDED.expires_at
         WHERE ${this.sql(this.schema)}.monitor_leases.expires_at < now()
            OR ${this.sql(this.schema)}.monitor_leases.owner = EXCLUDED.owner
        RETURNING monitor_id, owner, claimed_at, expires_at
      `;
      const row = rows[0];
      return row === undefined ? { acquired: false } : { acquired: true, lease: toLease(row) };
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /**
   * Give a monitor back, so another instance need not wait out the TTL.
   *
   * Scoped to `owner`: releasing someone else's lease would be a way for a departing instance to
   * hand a monitor to a third party mid-batch. A release that matches nothing is not an error —
   * the lease may already have expired and been re-claimed, which is exactly the case where the
   * caller must NOT be told something went wrong.
   */
  async releaseMonitorLease(monitorId: string, owner: string): Promise<{ readonly released: boolean }> {
    parse(UuidSchema, monitorId, "PgShieldedMonitorStore.releaseMonitorLease");
    parse(LeaseOwnerSchema, owner, "PgShieldedMonitorStore.releaseMonitorLease");
    try {
      const rows = await this.sql<{ monitor_id: string }[]>`
        DELETE FROM ${this.sql(this.schema)}.monitor_leases
         WHERE monitor_id = ${monitorId} AND owner = ${owner}
        RETURNING monitor_id
      `;
      return { released: rows.length > 0 };
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** The current lease, for an operator view and for the tests that assert takeover. Reads the
   *  row as stored; an EXPIRED lease is still returned, because "expired but not yet reclaimed"
   *  is a real and interesting state. */
  async readMonitorLease(monitorId: string): Promise<MonitorLeaseRecord | undefined> {
    parse(UuidSchema, monitorId, "PgShieldedMonitorStore.readMonitorLease");
    try {
      const rows = await this.sql<LeaseRow[]>`
        SELECT monitor_id, owner, claimed_at, expires_at
          FROM ${this.sql(this.schema)}.monitor_leases WHERE monitor_id = ${monitorId}
      `;
      const row = rows[0];
      return row === undefined ? undefined : toLease(row);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** The renewal {@link advance} performs inside its own transaction. Scoped to `owner`, so a
   *  lease another instance took over is NOT silently stolen back by the commit. */
  private async renewLeaseInTx(
    tx: MonitorTx, monitorId: string, lease: LeaseRenewal,
  ): Promise<boolean> {
    parse(LeaseOwnerSchema, lease.owner, "PgShieldedMonitorStore.advance");
    parse(LeaseTtlSchema, lease.ttlMs, "PgShieldedMonitorStore.advance");
    const rows = await tx<{ monitor_id: string }[]>`
      UPDATE ${tx(this.schema)}.monitor_leases
         SET expires_at = now() + make_interval(secs => ${lease.ttlMs / 1000})
       WHERE monitor_id = ${monitorId} AND owner = ${lease.owner}
      RETURNING monitor_id
    `;
    return rows.length > 0;
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
