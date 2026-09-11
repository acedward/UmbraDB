import { z } from "zod";
import { LIFECYCLE_EVENTS, MONITOR_STATES, type LifecycleEvent, type MonitorState } from "./lifecycle.js";
import type { MatchDetails } from "./match-details.js";
import {
  MAX_ASSOCIATION_PAGE,
  type AdvanceResult,
  type AssociationDetailsUpdate,
  type AssociationInput,
  type AssociationRecord,
  type LifecycleEventRecord,
  type MonitorCoverage,
  type MonitorLastError,
  type MonitorLeaseRecord,
  type MonitorRecord,
  type RevocationRecord,
} from "./store.js";

/**
 * The JSON encoding of {@link ShieldedMonitorStore} — one module, imported by BOTH ends
 * (sub-plan 00009-08 v2; owner question Q25; `spec/00009` FR-010, FR-012, FR-025, FR-026).
 *
 * ── What this wire is ───────────────────────────────────────────────────────────────────────
 * Project B has no database. Every operation it used to perform against PostgreSQL is now one
 * HTTP request to `umbradb-storage-api`, which performs exactly that operation as exactly one
 * database transaction. The encoding is **command-shaped, not table-shaped**: there is no
 * `PATCH /rows`, no SQL, no schema name. `advance` is one call because Rule B says a height's
 * associations and its coverage advance are one commit; `transition` is one call because a
 * lifecycle change is one commit with an epoch bump and a lifecycle event in it.
 *
 * ── Written once, for both sides ────────────────────────────────────────────────────────────
 * The same reasoning as `src/interfaces/archive-read-wire.ts`: two hand-written codecs is how a
 * boundary like this rots — the server starts sending `block_height`, the client keeps reading
 * `blockHeight`, every field decodes to `undefined`, and a scanner records associations with
 * height 0. So the encoding is written once, the decoder IS the schema's output, and both ends
 * import it.
 *
 * It lives under `shielded-monitor/` rather than `src/interfaces/` because it mentions project
 * B's own vocabulary (`MonitorState`, `LifecycleEvent`, `MatchDetails`) and `src/**` may not name
 * project B at all (`test/postgres/no-shielded-monitor-import-guard.test.ts`, FR-025: "A MUST NOT
 * depend on B"). The A-side storage process is not under `src/` and imports it directly. Nothing
 * here imports `postgres` or anything under `src/postgres/**`, which
 * `test/shielded-monitor/import-boundary.test.ts` enforces.
 *
 * ── Scalars ─────────────────────────────────────────────────────────────────────────────────
 * - **bigints are decimal strings.** Heights, epochs and sequence numbers are `bigint` in the
 *   record types and JSON has no bigint. A JSON number would silently lose precision above 2^53,
 *   and the one value where that matters (an association `seq`) is the cursor a consumer pages
 *   with — a rounded cursor skips or repeats matches.
 * - **bytes are base64**, strictly validated (see `Base64Schema`): block hashes, transaction
 *   hashes, fingerprints and the serialized viewing key.
 * - **timestamps are ISO 8601 strings**, decoded back to `Date`.
 * - **absent means absent.** A field the record omits is omitted on the wire, never `null`, so
 *   the two ends agree on one spelling of "not recorded" (`AssociationRecord.details` is the
 *   case that matters: absent means "not backfilled yet", and a `null` that decoded to an empty
 *   object would claim the transaction had no outputs).
 */

/** The protocol marker. Bumped only for a change a 00009-08 client could not read; it is
 *  returned by `/v1/health` so a client can refuse a server it does not understand rather than
 *  mis-parsing it. */
export const MONITOR_STORE_WIRE_VERSION = 1;

/** The route prefix every monitor-store command sits under. */
export const MONITOR_STORE_PREFIX = "/v1/monitor-store";

/** The fixed routes. Parameterised ones are built by {@link monitorRoute}. */
export const MONITOR_STORE_ROUTES = {
  health: "/v1/health",
  monitors: `${MONITOR_STORE_PREFIX}/monitors`,
  byFingerprint: `${MONITOR_STORE_PREFIX}/monitors/by-fingerprint`,
  revocations: `${MONITOR_STORE_PREFIX}/revocations`,
  audit: `${MONITOR_STORE_PREFIX}/audit`,
  leaseClaim: `${MONITOR_STORE_PREFIX}/leases/claim`,
  leaseRelease: `${MONITOR_STORE_PREFIX}/leases/release`,
} as const;

/** `/v1/monitor-store/monitors/<id>[/<suffix>]`. The id is percent-encoded even though it is a
 *  UUID: an id is caller-supplied until the server has validated it, and a router that trusts
 *  its shape before checking it is a router that can be walked with `..`. */
export function monitorRoute(id: string, suffix?: string): string {
  const base = `${MONITOR_STORE_PREFIX}/monitors/${encodeURIComponent(id)}`;
  return suffix === undefined ? base : `${base}/${suffix}`;
}

/**
 * Error codes the storage API returns. A client switches on these, never on messages.
 *
 * They map one-to-one onto project B's own error classes, which is what lets
 * `HttpMonitorStore` throw the SAME error a `PgShieldedMonitorStore` would throw for the same
 * input — the property the parity suite checks.
 */
export const MONITOR_STORE_ERROR_CODES = [
  "VALIDATION_FAILED",
  "MONITOR_NOT_FOUND",
  "MONITOR_REVOKED",
  "MONITOR_FENCED",
  "MONITOR_ILLEGAL_TRANSITION",
  "INVALID_VIEWING_KEY",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL_ERROR",
] as const;

export type MonitorStoreErrorCode = (typeof MONITOR_STORE_ERROR_CODES)[number];

/**
 * The error envelope.
 *
 * `detail` carries the small, non-secret payload a typed error needs in order to be RECONSTRUCTED
 * on the client — the fence rejection and the observed epoch/state, the monitor id, the illegal
 * transition's from/event. It never carries key material: the one error that could
 * (`InvalidViewingKeyError`) deliberately reports no detail at all, because FR-001 requires every
 * intake failure to be one indistinguishable client error.
 */
export const MonitorStoreErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(4096),
    requestId: z.string().max(64).optional(),
    detail: z
      .object({
        monitorId: z.string().max(128).optional(),
        rejection: z.enum(["epoch", "state"]).optional(),
        epoch: z.string().regex(/^\d{1,39}$/).optional(),
        state: z.string().max(64).optional(),
        from: z.string().max(64).optional(),
        event: z.string().max(64).optional(),
      })
      .optional(),
  }),
});

export type MonitorStoreErrorBody = z.infer<typeof MonitorStoreErrorSchema>;

// ── Scalars ──────────────────────────────────────────────────────────────────────────────────

/** Strict base64, for exactly the reason `archive-read-wire.ts` gives: `Buffer.from(s,"base64")`
 *  silently truncates at the first character outside the alphabet, so a corrupted hash would
 *  arrive as SHORT bytes that still look like a hash. */
const Base64Schema = z
  .string()
  .max(4 * 1024 * 1024)
  .refine(
    (s) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s),
    "expected canonical base64 (RFC 4648, padded)",
  );

/** A non-negative bigint as a decimal string. The 39-digit bound is `2^128`'s width: far beyond
 *  any real height or sequence, and small enough that a hostile body cannot make the server
 *  allocate a megabyte-long integer. */
const BigintStringSchema = z.string().regex(/^\d{1,39}$/, "expected a non-negative decimal integer string");

const IsoDateSchema = z
  .string()
  .max(64)
  .refine((s) => !Number.isNaN(Date.parse(s)), "expected an ISO-8601 timestamp");

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Decodes to a Node `Buffer`, which is what `AssociationRecord.blockHash`/`txHash` are typed
 *  as. Copies rather than viewing Node's pooled slab, so a decoded hash a scanner keeps for the
 *  life of an association does not pin 8 KiB of shared buffer. */
export function base64ToBuffer(value: string): Buffer {
  return Buffer.from(Buffer.from(value, "base64"));
}

export function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

// ── Record schemas ───────────────────────────────────────────────────────────────────────────

const MonitorStateSchema = z.enum(MONITOR_STATES as unknown as [MonitorState, ...MonitorState[]]);
const LifecycleEventSchema = z.enum(
  LIFECYCLE_EVENTS as unknown as [LifecycleEvent, ...LifecycleEvent[]],
);

export const WireLastErrorSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().max(4096),
  atHeight: z.string().max(40).optional(),
  atPosition: z.number().int().min(0).optional(),
});

export const WireCoverageSchema = z.object({
  requestedStart: BigintStringSchema,
  scannedFrom: BigintStringSchema.optional(),
  scannedThrough: BigintStringSchema.optional(),
});

export const WireMonitorSchema = z.object({
  id: z.string().min(1).max(128),
  net: z.string().min(1).max(64),
  state: MonitorStateSchema,
  epoch: BigintStringSchema,
  coverage: WireCoverageSchema,
  sourceGenesisHash: z.string().max(256).optional(),
  sourceInstanceId: z.string().max(256).optional(),
  matchingRuleVersion: z.string().min(1).max(64),
  ledgerBuild: z.string().min(1).max(128),
  lastError: WireLastErrorSchema.optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});

/** `details` is passed through as an opaque JSON object, exactly as the store treats it: the
 *  producer (`match-details.ts`) owns the shape, and restating it here would create a second
 *  definition that could drift. What the wire checks is that it IS an object — a string or an
 *  array reaching the `jsonb` column is what would produce an opaque database error. */
const DetailsSchema = z.custom<MatchDetails>(
  (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  "details must be a JSON object",
);

export const WireAssociationSchema = z.object({
  seq: BigintStringSchema,
  net: z.string().min(1).max(64),
  blockHeight: BigintStringSchema,
  blockHash: Base64Schema,
  position: z.number().int().min(0),
  txHash: Base64Schema,
  protocolVersion: BigintStringSchema,
  matchedSegments: z.array(z.number().int().min(0).max(32767)),
  appliedOutcome: z.literal("unknown"),
  sourceOutcome: z.string().min(1).max(64).optional(),
  matchingRuleVersion: z.string().min(1).max(64),
  ledgerBuild: z.string().min(1).max(128),
  details: DetailsSchema.optional(),
  blockTimestampMs: BigintStringSchema.optional(),
  createdAt: IsoDateSchema,
});

export const WireLifecycleEventSchema = z.object({
  seq: BigintStringSchema,
  event: LifecycleEventSchema,
  stateBefore: MonitorStateSchema.optional(),
  stateAfter: MonitorStateSchema,
  epochAfter: BigintStringSchema,
  actor: z.string().min(1).max(128),
  at: IsoDateSchema,
});

export const WireLeaseSchema = z.object({
  monitorId: z.string().min(1).max(128),
  owner: z.string().min(1).max(128),
  claimedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
});

export const WireRevocationSchema = z.object({
  monitorId: z.string().min(1).max(128),
  net: z.string().min(1).max(64),
  state: z.enum(["revoked", "deleted"]),
  epoch: BigintStringSchema,
  at: z.string().max(64),
});

export const WireAdvanceResultSchema = z.union([
  z.object({
    applied: z.literal(true),
    firstSeq: BigintStringSchema,
    lastSeq: BigintStringSchema,
    coverage: WireCoverageSchema,
    leaseHeld: z.boolean().optional(),
  }),
  z.object({
    applied: z.literal(false),
    reason: z.literal("already-advanced"),
    coverage: WireCoverageSchema,
    leaseHeld: z.boolean().optional(),
  }),
]);

// ── Request bodies ───────────────────────────────────────────────────────────────────────────

export const WireAssociationInputSchema = z.object({
  net: z.string().min(1).max(64),
  blockHeight: BigintStringSchema,
  blockHash: Base64Schema,
  position: z.number().int().min(0),
  txHash: Base64Schema,
  protocolVersion: BigintStringSchema,
  matchedSegments: z.array(z.number().int().min(0).max(32767)),
  sourceOutcome: z.string().min(1).max(64).optional(),
  matchingRuleVersion: z.string().min(1).max(64).optional(),
  ledgerBuild: z.string().min(1).max(128).optional(),
  details: DetailsSchema.optional(),
  blockTimestampMs: BigintStringSchema.optional(),
});

export const WireLeaseRenewalSchema = z.object({
  owner: z.string().min(1).max(128),
  ttlMs: z.number().int().min(1).max(3_600_000),
});

/**
 * `POST /v1/monitor-store/monitors/<id>/advance` — ONE transaction (owner Rule B, FR-010,
 * FR-012).
 *
 * The whole of a height's work travels in one body: the expected epoch (the fence), the
 * through-height, the associations, the optional first-advance `fromHeight`, and the optional
 * lease renewal that must land inside the same commit.
 */
export const WireAdvanceRequestSchema = z.object({
  expectedEpoch: BigintStringSchema,
  throughHeight: BigintStringSchema,
  associations: z.array(WireAssociationInputSchema).max(100_000),
  fromHeight: BigintStringSchema.optional(),
  lease: WireLeaseRenewalSchema.optional(),
});

export const WireRegisterRequestSchema = z.object({
  net: z.string().min(1).max(64),
  /** The serialized viewing key. Plaintext on this hop: the alpha has no encryption anywhere
   *  (owner Q10/Q25) and the storage API is loopback-by-default and unauthenticated (Q3). The
   *  server RE-DERIVES the fingerprint from these bytes rather than trusting a client-supplied
   *  one, so registration identity (FR-003) is computed by the side that writes the row. */
  keySerialized: Base64Schema,
  requestedStartHeight: BigintStringSchema,
  matchingRuleVersion: z.string().min(1).max(64),
  ledgerBuild: z.string().min(1).max(128),
  sourceGenesisHash: z.string().min(1).max(256).optional(),
  sourceInstanceId: z.string().min(1).max(256).optional(),
  actor: z.string().min(1).max(128),
});

export const WireTransitionRequestSchema = z.object({
  event: z.enum(["goLive", "pause", "resume", "revoke", "delete", "markFailed", "markStaleSource"]),
  actor: z.string().min(1).max(128),
  expectedEpoch: BigintStringSchema.optional(),
  error: WireLastErrorSchema.optional(),
});

export type WireTransitionEvent = z.infer<typeof WireTransitionRequestSchema>["event"];

export const WireBindSourceRequestSchema = z.object({
  expectedEpoch: BigintStringSchema,
  genesisHash: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256),
});

export const WireDetailsUpdateSchema = z.object({
  seq: BigintStringSchema,
  details: DetailsSchema,
  blockTimestampMs: BigintStringSchema.optional(),
});

export const WireAssociationDetailsRequestSchema = z.object({
  expectedEpoch: BigintStringSchema,
  updates: z.array(WireDetailsUpdateSchema).max(MAX_ASSOCIATION_PAGE),
});

export const WireLeaseClaimRequestSchema = z.object({
  monitorId: z.string().min(1).max(128),
  owner: z.string().min(1).max(128),
  ttlMs: z.number().int().min(1).max(3_600_000),
});

export const WireLeaseReleaseRequestSchema = z.object({
  monitorId: z.string().min(1).max(128),
  owner: z.string().min(1).max(128),
});

export const WireAuditRequestSchema = z.object({
  actor: z.string().min(1).max(128),
  action: z.string().min(1).max(64),
  monitorId: z.string().min(1).max(128).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

// ── Response envelopes ───────────────────────────────────────────────────────────────────────

export const WireMonitorListSchema = z.object({ monitors: z.array(WireMonitorSchema).max(10_000) });
export const WireAssociationListSchema = z.object({
  associations: z.array(WireAssociationSchema).max(MAX_ASSOCIATION_PAGE),
});
export const WireLifecycleListSchema = z.object({
  events: z.array(WireLifecycleEventSchema).max(100_000),
});
export const WireRevocationListSchema = z.object({
  revocations: z.array(WireRevocationSchema).max(100_000),
});
export const WireKeyMaterialSchema = z.object({ keySerialized: Base64Schema });
export const WireBindSourceResultSchema = z.object({
  applied: z.boolean(),
  monitor: WireMonitorSchema,
});
export const WireDetailsResultSchema = z.object({ applied: z.number().int().min(0) });
export const WireLeaseClaimResultSchema = z.object({
  acquired: z.boolean(),
  lease: WireLeaseSchema.optional(),
});
export const WireLeaseReleaseResultSchema = z.object({ released: z.boolean() });
export const WireLeaseReadSchema = z.object({ lease: WireLeaseSchema.optional() });
export const WireMonitorOptionalSchema = z.object({ monitor: WireMonitorSchema.optional() });
export const WireHealthSchema = z.object({
  status: z.literal("ok"),
  net: z.string().min(1).max(64),
  wireVersion: z.number().int().min(1).optional(),
  monitorStoreWireVersion: z.number().int().min(1).optional(),
});

// ── Encode (server side) ─────────────────────────────────────────────────────────────────────

function encodeCoverage(coverage: MonitorCoverage): z.infer<typeof WireCoverageSchema> {
  return {
    requestedStart: coverage.requestedStart.toString(),
    ...(coverage.scannedFrom === undefined ? {} : { scannedFrom: coverage.scannedFrom.toString() }),
    ...(coverage.scannedThrough === undefined ? {} : { scannedThrough: coverage.scannedThrough.toString() }),
  };
}

export function encodeMonitor(record: MonitorRecord): z.infer<typeof WireMonitorSchema> {
  return {
    id: record.id,
    net: record.net,
    state: record.state,
    epoch: record.epoch.toString(),
    coverage: encodeCoverage(record.coverage),
    ...(record.sourceGenesisHash === undefined ? {} : { sourceGenesisHash: record.sourceGenesisHash }),
    ...(record.sourceInstanceId === undefined ? {} : { sourceInstanceId: record.sourceInstanceId }),
    matchingRuleVersion: record.matchingRuleVersion,
    ledgerBuild: record.ledgerBuild,
    ...(record.lastError === undefined ? {} : { lastError: { ...record.lastError } }),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function encodeAssociation(record: AssociationRecord): z.infer<typeof WireAssociationSchema> {
  return {
    seq: record.seq.toString(),
    net: record.net,
    blockHeight: record.blockHeight.toString(),
    blockHash: bytesToBase64(record.blockHash),
    position: record.position,
    txHash: bytesToBase64(record.txHash),
    protocolVersion: record.protocolVersion.toString(),
    matchedSegments: [...record.matchedSegments],
    appliedOutcome: "unknown",
    ...(record.sourceOutcome === undefined ? {} : { sourceOutcome: record.sourceOutcome }),
    matchingRuleVersion: record.matchingRuleVersion,
    ledgerBuild: record.ledgerBuild,
    ...(record.details === undefined ? {} : { details: record.details }),
    ...(record.blockTimestampMs === undefined ? {} : { blockTimestampMs: record.blockTimestampMs.toString() }),
    createdAt: record.createdAt.toISOString(),
  };
}

export function encodeLifecycleEvent(
  record: LifecycleEventRecord,
): z.infer<typeof WireLifecycleEventSchema> {
  return {
    seq: record.seq.toString(),
    event: record.event,
    ...(record.stateBefore === undefined ? {} : { stateBefore: record.stateBefore }),
    stateAfter: record.stateAfter,
    epochAfter: record.epochAfter.toString(),
    actor: record.actor,
    at: record.at.toISOString(),
  };
}

export function encodeLease(record: MonitorLeaseRecord): z.infer<typeof WireLeaseSchema> {
  return {
    monitorId: record.monitorId,
    owner: record.owner,
    claimedAt: record.claimedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
}

export function encodeRevocation(record: RevocationRecord): z.infer<typeof WireRevocationSchema> {
  return { ...record };
}

export function encodeAdvanceResult(result: AdvanceResult): z.infer<typeof WireAdvanceResultSchema> {
  if (result.applied) {
    return {
      applied: true,
      firstSeq: result.firstSeq.toString(),
      lastSeq: result.lastSeq.toString(),
      coverage: encodeCoverage(result.coverage),
      ...(result.leaseHeld === undefined ? {} : { leaseHeld: result.leaseHeld }),
    };
  }
  return {
    applied: false,
    reason: "already-advanced",
    coverage: encodeCoverage(result.coverage),
    ...(result.leaseHeld === undefined ? {} : { leaseHeld: result.leaseHeld }),
  };
}

export function encodeAssociationInput(
  input: AssociationInput,
): z.infer<typeof WireAssociationInputSchema> {
  return {
    net: input.net,
    blockHeight: input.blockHeight.toString(),
    blockHash: bytesToBase64(input.blockHash),
    position: input.position,
    txHash: bytesToBase64(input.txHash),
    protocolVersion: input.protocolVersion.toString(),
    matchedSegments: [...input.matchedSegments],
    ...(input.sourceOutcome === undefined ? {} : { sourceOutcome: input.sourceOutcome }),
    ...(input.matchingRuleVersion === undefined ? {} : { matchingRuleVersion: input.matchingRuleVersion }),
    ...(input.ledgerBuild === undefined ? {} : { ledgerBuild: input.ledgerBuild }),
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.blockTimestampMs === undefined ? {} : { blockTimestampMs: input.blockTimestampMs.toString() }),
  };
}

export function encodeDetailsUpdate(
  update: AssociationDetailsUpdate,
): z.infer<typeof WireDetailsUpdateSchema> {
  return {
    seq: update.seq.toString(),
    details: update.details,
    ...(update.blockTimestampMs === undefined ? {} : { blockTimestampMs: update.blockTimestampMs.toString() }),
  };
}

// ── Decode ───────────────────────────────────────────────────────────────────────────────────

/** A payload that does not match the schema. Fail-closed: a body that cannot be fully validated
 *  is refused, never partially used. */
export class MonitorStoreWireError extends Error {
  readonly code = "MONITOR_STORE_WIRE_INVALID" as const;
  constructor(what: string, readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(
      `the storage API returned a ${what} this client cannot read: ` +
        issues.map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.message}`).join("; "),
    );
    this.name = "MonitorStoreWireError";
  }
}

export function decodeWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new MonitorStoreWireError(
      what,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

function decodeCoverage(wire: z.infer<typeof WireCoverageSchema>): MonitorCoverage {
  return {
    requestedStart: BigInt(wire.requestedStart),
    ...(wire.scannedFrom === undefined ? {} : { scannedFrom: BigInt(wire.scannedFrom) }),
    ...(wire.scannedThrough === undefined ? {} : { scannedThrough: BigInt(wire.scannedThrough) }),
  };
}

export function decodeMonitor(value: unknown): MonitorRecord {
  const wire = decodeWith(WireMonitorSchema, value, "monitor");
  return monitorFromWire(wire);
}

function monitorFromWire(wire: z.infer<typeof WireMonitorSchema>): MonitorRecord {
  const lastError: MonitorLastError | undefined = wire.lastError;
  return {
    id: wire.id,
    net: wire.net,
    state: wire.state,
    epoch: BigInt(wire.epoch),
    coverage: decodeCoverage(wire.coverage),
    ...(wire.sourceGenesisHash === undefined ? {} : { sourceGenesisHash: wire.sourceGenesisHash }),
    ...(wire.sourceInstanceId === undefined ? {} : { sourceInstanceId: wire.sourceInstanceId }),
    matchingRuleVersion: wire.matchingRuleVersion,
    ledgerBuild: wire.ledgerBuild,
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: new Date(wire.createdAt),
    updatedAt: new Date(wire.updatedAt),
  };
}

export function decodeMonitorList(value: unknown): MonitorRecord[] {
  return decodeWith(WireMonitorListSchema, value, "monitor list").monitors.map(monitorFromWire);
}

function associationFromWire(wire: z.infer<typeof WireAssociationSchema>): AssociationRecord {
  return {
    seq: BigInt(wire.seq),
    net: wire.net,
    blockHeight: BigInt(wire.blockHeight),
    blockHash: base64ToBuffer(wire.blockHash),
    position: wire.position,
    txHash: base64ToBuffer(wire.txHash),
    protocolVersion: BigInt(wire.protocolVersion),
    matchedSegments: wire.matchedSegments,
    appliedOutcome: "unknown",
    ...(wire.sourceOutcome === undefined ? {} : { sourceOutcome: wire.sourceOutcome }),
    matchingRuleVersion: wire.matchingRuleVersion,
    ledgerBuild: wire.ledgerBuild,
    ...(wire.details === undefined ? {} : { details: wire.details }),
    ...(wire.blockTimestampMs === undefined ? {} : { blockTimestampMs: BigInt(wire.blockTimestampMs) }),
    createdAt: new Date(wire.createdAt),
  };
}

export function decodeAssociationList(value: unknown): AssociationRecord[] {
  return decodeWith(WireAssociationListSchema, value, "association page").associations.map(
    associationFromWire,
  );
}

export function decodeLifecycleList(value: unknown): LifecycleEventRecord[] {
  return decodeWith(WireLifecycleListSchema, value, "lifecycle log").events.map((wire) => ({
    seq: BigInt(wire.seq),
    event: wire.event,
    ...(wire.stateBefore === undefined ? {} : { stateBefore: wire.stateBefore }),
    stateAfter: wire.stateAfter,
    epochAfter: BigInt(wire.epochAfter),
    actor: wire.actor,
    at: new Date(wire.at),
  }));
}

export function decodeRevocationList(value: unknown): RevocationRecord[] {
  return decodeWith(WireRevocationListSchema, value, "revocation list").revocations.map((r) => ({
    monitorId: r.monitorId,
    net: r.net,
    state: r.state,
    epoch: r.epoch,
    at: r.at,
  }));
}

export function decodeLease(wire: z.infer<typeof WireLeaseSchema>): MonitorLeaseRecord {
  return {
    monitorId: wire.monitorId,
    owner: wire.owner,
    claimedAt: new Date(wire.claimedAt),
    expiresAt: new Date(wire.expiresAt),
  };
}

export function decodeAdvanceResult(value: unknown): AdvanceResult {
  const wire = decodeWith(WireAdvanceResultSchema, value, "advance result");
  if (wire.applied) {
    return {
      applied: true,
      firstSeq: BigInt(wire.firstSeq),
      lastSeq: BigInt(wire.lastSeq),
      coverage: decodeCoverage(wire.coverage),
      ...(wire.leaseHeld === undefined ? {} : { leaseHeld: wire.leaseHeld }),
    };
  }
  return {
    applied: false,
    reason: "already-advanced",
    coverage: decodeCoverage(wire.coverage),
    ...(wire.leaseHeld === undefined ? {} : { leaseHeld: wire.leaseHeld }),
  };
}

/** Server side: the association payloads of one `advance` body, back into store inputs. */
export function decodeAssociationInput(
  wire: z.infer<typeof WireAssociationInputSchema>,
): AssociationInput {
  return {
    net: wire.net,
    blockHeight: BigInt(wire.blockHeight),
    blockHash: base64ToBytes(wire.blockHash),
    position: wire.position,
    txHash: base64ToBytes(wire.txHash),
    protocolVersion: BigInt(wire.protocolVersion),
    matchedSegments: wire.matchedSegments,
    ...(wire.sourceOutcome === undefined ? {} : { sourceOutcome: wire.sourceOutcome }),
    ...(wire.matchingRuleVersion === undefined ? {} : { matchingRuleVersion: wire.matchingRuleVersion }),
    ...(wire.ledgerBuild === undefined ? {} : { ledgerBuild: wire.ledgerBuild }),
    ...(wire.details === undefined ? {} : { details: wire.details }),
    ...(wire.blockTimestampMs === undefined ? {} : { blockTimestampMs: BigInt(wire.blockTimestampMs) }),
  };
}

export function decodeDetailsUpdate(
  wire: z.infer<typeof WireDetailsUpdateSchema>,
): AssociationDetailsUpdate {
  return {
    seq: BigInt(wire.seq),
    details: wire.details,
    ...(wire.blockTimestampMs === undefined ? {} : { blockTimestampMs: BigInt(wire.blockTimestampMs) }),
  };
}
