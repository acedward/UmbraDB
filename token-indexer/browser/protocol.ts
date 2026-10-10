/**
 * The message protocol between a page and the browser engine's worker (`worker.ts`). Every message carries the protocol
 * version `v`; every request carries an `id` and gets exactly one response with that id; every message is validated
 * where it arrives (the worker validates requests, the page's client validates responses and notices).
 *
 * Requests (page → worker), `{ v, id, type, …parameters }`:
 *
 * | `type` | Parameters | Result |
 * |---|---|---|
 * | `status` | — | {@link HostStatus} |
 * | `api` | `method`, `target` | {@link ApiResult}: the API handler's answer (`token-indexer/mip0018/api.ts`), unchanged |
 * | `start` | `config?` ({@link StartConfig}; omitted: the saved configuration) | {@link HostStatus} |
 * | `stop` | — | {@link HostStatus} |
 * | `range` | `startHeight` (a height or `"tip"`), `endHeight?` | {@link HostStatus}: the store's data is dropped and the sync starts at the new range |
 * | `reset` | — | {@link HostStatus}: the store's data is dropped and the saved configuration starts again |
 * | `export` | — | {@link ExportResult}: a snapshot file of the store, taken while the engine runs (`snapshot-store.ts`) |
 * | `import` | `snapshot` (a `Blob`: a snapshot file) | {@link ImportResult}: the store replaced by the snapshot; the engine is stopped, and a start continues from the snapshot's height + 1 |
 * | `digest` | — | {@link DigestResult}: the archive digest and the range-tables digest of the store |
 * | `system` | `watch` (with `viewer?`) or `refresh` (`{ database?, exactCounts? }`) | {@link SystemResult} |
 * | `watchdog` | `limitMs`, `heartbeatMs?`, `carried?` | {@link WatchdogResult} |
 *
 * Responses (worker → page): `{ v, type: "response", id, request, ok: true, result }` or
 * `{ v, type: "response", id, request, ok: false, error: { code, message } }`; `id` and `request` are `null` when the
 * request was too malformed to carry them. Notices (worker → page, unsolicited): `boot` (each boot phase, see
 * {@link BootState}), `engine` (the engine started, stopped or failed), `system` (one system snapshot per collection
 * while a viewer watches) and `heartbeat` (every `heartbeatMs` once a `watchdog` request has set it, so the page can
 * tell a worker that stopped answering, for example inside a statement that does not return).
 *
 * A message of another protocol version is answered `unsupported-version`, and a request type this version does not
 * know `unknown-type`, so a page and a worker from different builds fail with a clear error. New request and notice
 * types are added to the unions below under a new version.
 */
import { z } from "zod";
import type { ApiResponse } from "../mip0018/api.ts";
import type { EngineStatus } from "../engine/engine.ts";
import type { SyncCursor, SyncOnceResult } from "../../chain-archive-sync/sync-service.js";
import type { ScanCursor, ScanOnceResult } from "../mip0018/scan.ts";
import type { ArchiveDigest } from "../../chain-archive-sync/archive-digest.js";
import type { RangeTables } from "../engine/range-tables.ts";
import { SnapshotsSchema, SystemSnapshotSchema } from "../engine/system-snapshot.ts";
import { SnapshotManifestSchema } from "./snapshot.ts";
import type { ExportedSnapshot } from "./snapshot-store.ts";

export const PROTOCOL_VERSION = 1;

/** The request types of this protocol version. */
export const REQUEST_TYPES = ["status", "api", "start", "stop", "range", "reset", "export", "import", "digest", "system", "watchdog"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** The recorded Stagenet ranges a worker can replay offline (the gzip tapes in `token-indexer/browser/tapes/`). */
export const TAPE_RANGES = ["idx", "u1"] as const;
export type TapeRange = (typeof TAPE_RANGES)[number];

/** Error codes of a failed request. */
export const ERROR_CODES = [
  /** The request is not a valid message of this protocol version (missing or wrong parameters). */
  "bad-request",
  /** The message carries another protocol version. */
  "unsupported-version",
  /** The request type is not part of this protocol version. */
  "unknown-type",
  /** The request type is part of the protocol, but this worker does not perform it. */
  "not-implemented",
  /** The browser lacks a capability the engine needs; nothing was started. */
  "unsupported-browser",
  /** Opening the store, loading the ledger or migrating failed; nothing was started. */
  "boot-failed",
  /** `start` while the engine is running. */
  "already-running",
  /** The engine refused the configuration or failed while starting. */
  "start-failed",
  /** An unexpected failure inside the worker. */
  "internal",
  /** `import`: the snapshot does not match this engine or is damaged; `export`: the archive is empty. The message starts
   *  with the reason (`snapshot.ts` `REFUSAL_REASONS`). Nothing was changed. */
  "snapshot-refused",
  /** `import`: the checked snapshot could not be loaded into the store, which was opened empty instead. */
  "snapshot-failed",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ── Values ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const height = z.int().min(0);
const intIn = (min: number, max: number) => z.int().min(min).max(max);

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}
const httpUrl = z.string().max(2048).refine(isHttpUrl, "an http(s) URL without credentials");

/** Where the engine's sync reads the chain from. */
export const ChainSourceSchema = z.discriminatedUnion("kind", [
  /** The node's JSON-RPC and the indexer's GraphQL over `fetch` (default: the build's Stagenet endpoints). */
  z.strictObject({ kind: z.literal("network"), nodeUrl: httpUrl.optional(), indexerUrl: httpUrl.optional() }),
  /** A recorded range replayed inside the worker, with no network. The reported finalized height is the tape's highest
   *  height unless `finalizedHeight` is given; `advance` raises it by `by` blocks every `everyMs` up to `until`. */
  z.strictObject({
    kind: z.literal("tape"),
    range: z.enum(TAPE_RANGES),
    finalizedHeight: height.optional(),
    advance: z.strictObject({ everyMs: intIn(1, 3_600_000), by: intIn(1, 10_000).optional(), until: height.optional() }).optional(),
  }),
]);
export type ChainSource = z.infer<typeof ChainSourceSchema>;

/** What `start` runs: the sync (one archive, no gaps) and the scan following it. */
export const StartConfigSchema = z
  .strictObject({
    /** Default `{ kind: "network" }`. */
    source: ChainSourceSchema.optional(),
    /** First height of a new archive: a height, or `"tip"` (the default), the finalized tip both sources serve when the
     *  sync begins (`min(node finalized height, indexer tip)`; the engine waits with back-off while the endpoints fail
     *  and never starts at genesis by default). A store whose archive already has a cursor continues there and ignores
     *  it unless a height contradicts the archive (then the sync refuses the range). */
    startHeight: z.union([height, z.literal("tip")]).optional(),
    /** Last height to sync, inclusive. Default: follow the finalized tip. */
    endHeight: height.optional(),
    sync: z
      .strictObject({
        maxBlocks: intIn(1, 1_000).optional(),
        concurrency: intIn(1, 16).optional(),
        minIntervalMs: intIn(0, 60_000).optional(),
        idleMs: intIn(1, 3_600_000).optional(),
        /** The back-off of a failed network call and of a failed batch or tip read (default 1 s doubling to 60 s,
         *  8 attempts per call). */
        backoff: z
          .strictObject({ baseDelayMs: intIn(1, 600_000).optional(), maxDelayMs: intIn(1, 3_600_000).optional(), maxAttempts: intIn(1, 100).optional() })
          .optional(),
      })
      .optional(),
    scan: z.strictObject({ batch: intIn(1, 1_000).optional(), idleMs: intIn(100, 3_600_000).optional() }).optional(),
  })
  .refine((c) => typeof c.startHeight !== "number" || c.endHeight === undefined || c.endHeight >= c.startHeight, {
    message: "endHeight is below startHeight",
    path: ["endHeight"],
  });
export type StartConfig = z.infer<typeof StartConfigSchema>;

// ── System snapshot and watchdog ─────────────────────────────────────────────────────────────────────────────────────

/** The viewer a `system` watch counts when the request names none. */
export const DEFAULT_SYSTEM_VIEWER = "page";

/**
 * `system`: either `watch` (true: `viewer` starts watching, and while any viewer watches the worker collects a system
 * snapshot every 2 s and posts each as a `system` notice; false: `viewer` stops, and with no viewer left nothing is
 * collected) or `refresh` (collect one snapshot now and answer it: the database statistics with `database`, exact row
 * counts with `exactCounts`). Exactly one of the two.
 */
function SystemRequestSchema() {
  return z
    .strictObject({
      ...envelope,
      type: z.literal("system"),
      watch: z.boolean().optional(),
      viewer: z.string().min(1).max(64).optional(),
      refresh: z.strictObject({ database: z.boolean().optional(), exactCounts: z.boolean().optional() }).optional(),
    })
    .refine((r) => (r.watch === undefined) !== (r.refresh === undefined), { message: "give exactly one of watch and refresh" })
    .refine((r) => r.viewer === undefined || r.watch !== undefined, { message: "viewer goes with watch", path: ["viewer"] });
}

/** A `system` answer: whether any viewer watches now and how many, and the snapshot of a `refresh` (`null` for a watch;
 *  the first snapshot of a watch arrives as a notice). */
export const SystemResultSchema = z.strictObject({
  watching: z.boolean(),
  viewers: z.int().min(0),
  snapshot: SystemSnapshotSchema.nullable(),
});
export type SystemResult = z.infer<typeof SystemResultSchema>;

/** What a worker hands to the worker that replaces it after a watchdog restart. */
export const CarriedCountsSchema = z.strictObject({
  watchdogRestarts: z.int().min(0),
  lastWatchdogRestart: z.strictObject({ at: z.int().min(0), reason: z.string().max(4_096) }).nullable(),
  pgliteReopens: z.int().min(0),
});
export type CarriedCountsMessage = z.infer<typeof CarriedCountsSchema>;

/**
 * `watchdog`: the page supervises the worker. `limitMs` is how long the worker may stay silent (a statement or other
 * work that does not return) before the page terminates and restarts it; the worker shows it in its system snapshot.
 * From this request on the worker posts a `heartbeat` notice every `heartbeatMs` (default {@link DEFAULT_HEARTBEAT_MS}).
 * `carried`: the counts of the worker this one replaces (its restarts, including this one, and its PGlite reopens).
 */
function WatchdogRequestSchema() {
  return z.strictObject({
    ...envelope,
    type: z.literal("watchdog"),
    limitMs: intIn(100, 3_600_000),
    heartbeatMs: intIn(20, 60_000).optional(),
    carried: CarriedCountsSchema.optional(),
  });
}

/** Default interval of the worker's heartbeat notices. */
export const DEFAULT_HEARTBEAT_MS = 1_000;

export const WatchdogResultSchema = z.strictObject({ limitMs: z.int().min(0), heartbeatMs: z.int().min(0) });
export type WatchdogResult = z.infer<typeof WatchdogResultSchema>;

/** A heartbeat: the worker's clock, a sequence number, and the counts a replacing worker carries over. */
export const HeartbeatSchema = z.strictObject({ at: z.number().min(0), seq: z.int().min(0), carried: CarriedCountsSchema });
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const envelope = { v: z.literal(PROTOCOL_VERSION), id: intIn(1, Number.MAX_SAFE_INTEGER) };

export const REQUEST_SCHEMAS = {
  status: z.strictObject({ ...envelope, type: z.literal("status") }),
  api: z.strictObject({ ...envelope, type: z.literal("api"), method: z.string().min(1).max(32), target: z.string().min(1).max(65_536) }),
  start: z.strictObject({ ...envelope, type: z.literal("start"), config: StartConfigSchema.optional() }),
  stop: z.strictObject({ ...envelope, type: z.literal("stop") }),
  range: z.strictObject({ ...envelope, type: z.literal("range"), startHeight: z.union([height, z.literal("tip")]), endHeight: height.optional() }),
  reset: z.strictObject({ ...envelope, type: z.literal("reset") }),
  export: z.strictObject({ ...envelope, type: z.literal("export") }),
  import: z.strictObject({ ...envelope, type: z.literal("import"), snapshot: z.instanceof(Blob) }),
  digest: z.strictObject({ ...envelope, type: z.literal("digest") }),
  system: SystemRequestSchema(),
  watchdog: WatchdogRequestSchema(),
} as const satisfies Record<RequestType, z.ZodType>;

export type RequestOf<T extends RequestType> = z.infer<(typeof REQUEST_SCHEMAS)[T]>;
export type Request = { [T in RequestType]: RequestOf<T> }[RequestType];
/** A request's parameters: everything but the envelope. */
export type ParamsOf<T extends RequestType> = Omit<RequestOf<T>, "v" | "id" | "type">;

// ── Results ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ApiResultSchema = z.strictObject({ status: intIn(100, 599), headers: z.record(z.string(), z.string()), body: z.string() });
export type ApiResult = z.infer<typeof ApiResultSchema>;

export const BOOT_PHASES = ["starting", "capabilities", "store", "ledger", "migrate", "ready", "unsupported", "failed"] as const;
export type BootPhase = (typeof BOOT_PHASES)[number];

export const CapabilityReportSchema = z.strictObject({
  supported: z.boolean(),
  /** What the user is told when `supported` is false; empty otherwise. */
  message: z.string(),
  /** The names of the failed checks, in {@link CapabilityReportSchema}'s `checks` order. */
  missing: z.array(z.string()),
  checks: z.strictObject({
    chromium: z.boolean(),
    opfs: z.boolean(),
    syncAccessHandle: z.boolean(),
    webLocks: z.boolean(),
    broadcastChannel: z.boolean(),
    persistentStorage: z.boolean(),
  }),
  /** Browser brand and major version (`userAgentData`), when the browser reports one. */
  browser: z.string().nullable(),
});
export type CapabilityReport = z.infer<typeof CapabilityReportSchema>;

const ms = z.number().min(0).nullable();
export const BootStateSchema = z.strictObject({
  phase: z.enum(BOOT_PHASES),
  /** Why the boot stopped (`unsupported`, `failed`). */
  error: z.string().nullable(),
  capabilities: CapabilityReportSchema.nullable(),
  /** Duration of each phase (`store` includes creating the database on a first open), and of the whole boot. */
  timings: z.strictObject({ capabilitiesMs: ms, storeMs: ms, ledgerMs: ms, migrateMs: ms, totalMs: ms }),
});
export type BootState = z.infer<typeof BootStateSchema>;

export const StoreInfoSchema = z.strictObject({
  dataDir: z.string(),
  /** The store did not exist before this open (the database was created). */
  created: z.boolean(),
  serverVersion: z.string(),
  fsync: z.string(),
  /** The clients' durability mode (`/v1/status` reports it too). */
  durability: z.enum(["durable", "non-durable"]),
  /** Applied migrations per schema lineage, in order. */
  migrations: z.strictObject({ archive: z.array(z.string()), mip0018: z.array(z.string()) }),
});
export type StoreInfo = z.infer<typeof StoreInfoSchema>;

const n = z.number();
const opt = <T extends z.ZodType>(t: T) => t.optional();
const SyncOnceResultSchema = z.strictObject({
  ingestedBlocks: n, fromHeight: opt(n), toHeight: opt(n), targetTipHeight: opt(n), nodeFinalizedHeight: opt(n),
  indexerTipHeight: opt(n), reachedEnd: z.boolean(), retries: n, throttled: n, elapsedMs: n,
});
const ScanOnceResultSchema = z.strictObject({
  scannedBlocks: n, fromHeight: opt(n), toHeight: opt(n), archiveHeight: opt(n), reachedEnd: z.boolean(),
  transactions: n, mints: n, sightings: n, actions: n, events: n,
});
const LOOP_PHASES = ["off", "ready", "starting", "running", "idle", "backoff", "done", "stopped", "failed"] as const;
const loop = { phase: z.enum(LOOP_PHASES), lastError: opt(z.string()), failures: n, waitUntil: opt(n) };
export const EngineStatusSchema = z.strictObject({
  started: z.boolean(),
  stopping: z.boolean(),
  sync: z.strictObject({ ...loop, lastBatch: opt(SyncOnceResultSchema), startHeight: opt(n), endHeight: opt(n) }),
  scan: z.strictObject({ ...loop, lastBatch: opt(ScanOnceResultSchema), scanner: z.enum(["following", "stalled", "off"]) }),
  api: z.strictObject({ inFlight: n, maxConcurrentRequests: n }),
});

export const SyncCursorSchema = z.strictObject({ height: n, startHeight: opt(n) });
export const ScanCursorSchema = z.strictObject({ fromHeight: n, nextHeight: n, lastBlockHash: opt(z.string()) });

// ── Settings and storage ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The engine's saved configuration, kept beside the store: the last `start` configuration or `range`, and whether the
 * engine starts by itself when the worker boots (cleared by `stop`, set by `start`, `range` and `reset`). A reopened
 * store resumes with it, so a chosen range keeps its end and the default keeps following the tip.
 */
export const EngineSettingsSchema = z.strictObject({ config: StartConfigSchema, autoStart: z.boolean() });
export type EngineSettings = z.infer<typeof EngineSettingsSchema>;

const bytes = z.number().min(0).nullable();
/** The storage guard's latest reading (`quota.ts`). */
export const StorageStatusSchema = z.strictObject({
  /** `navigator.storage.estimate()`: what the browser counts against this site's quota (including the space it reserves
   *  for the store's open files), and the quota; `null` when the estimate failed or did not answer in time. */
  usageBytes: bytes,
  quotaBytes: bytes,
  /** `navigator.storage.persisted()`. */
  persisted: z.boolean().nullable(),
  /** The usage at which the sync pauses, whether it is paused, and why. */
  pauseAtBytes: bytes,
  paused: z.boolean(),
  pausedReason: z.string().nullable(),
  /** The size of the store's own files, from the latest finished OPFS walk (`null` until the first walk ends, or when
   *  it cannot be read). */
  storeBytes: bytes,
  /** Clock time of the reading. */
  checkedAt: z.number().nullable(),
});
export type StorageStatus = z.infer<typeof StorageStatusSchema>;

export const HostStatusSchema = z.strictObject({
  protocol: z.literal(PROTOCOL_VERSION),
  network: z.string(),
  boot: BootStateSchema,
  /** `null` until the store is open. */
  store: StoreInfoSchema.nullable(),
  /** The engine of the last `start` (`null` before the first): whether it still runs, what it was started with, its
   *  loops, and the error that ended it. */
  engine: z
    .strictObject({ running: z.boolean(), config: z.custom<StartConfig>((v) => StartConfigSchema.safeParse(v).success), status: EngineStatusSchema, error: z.string().nullable() })
    .nullable(),
  /** The stored cursors (`null` until the store is migrated; a cursor is `null` before its loop's first block). */
  cursors: z.strictObject({ sync: SyncCursorSchema.nullable(), scan: ScanCursorSchema.nullable() }).nullable(),
  /** What `start` without a configuration, a `reset` and the automatic start run (`null` until the store is open). */
  settings: EngineSettingsSchema.nullable(),
  /** The storage figures and the quota pause: `null` until the boot is `ready` (the boot takes the first reading before
   *  it ends `ready`), then always the latest reading. */
  storage: StorageStatusSchema.nullable(),
  /** The last snapshot exported and imported by this worker (manifest summary, file SHA-256 and size). */
  snapshots: SnapshotsSchema,
});
export type HostStatus = z.infer<typeof HostStatusSchema>;

// ── Digests ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/**
 * The `digest` result: the store's archive digest (`chain-archive-sync/archive-digest.ts`: the 7 `chain_archive`
 * tables) and its range-tables digest (`token-indexer/engine/range-tables.ts`: every table of both schemas), read in one
 * read-only transaction, so they describe one state even while the engine runs.
 */
export const DigestResultSchema = z.strictObject({
  archive: z.strictObject({ sha256, tables: z.record(z.string(), z.strictObject({ rows: n, sha256 })) }),
  tables: z.strictObject({ sha256, tables: z.record(z.string(), z.strictObject({ rows: n, sha256, excluded: z.array(z.string()) })) }),
  /** How long the reads and the hashing took. */
  elapsedMs: n,
});
export type DigestResult = z.infer<typeof DigestResultSchema>;

// ── Snapshots ────────────────────────────────────────────────────────────────────────────────────────────────────────

const duration = z.number().min(0);
/** The `export` result: the snapshot file (`snapshot.ts`), its suggested name, its manifest, its size, and timings
 *  (`holdMs`: how long the engine's session waited for the read). */
export const ExportResultSchema = z.strictObject({
  file: z.instanceof(Blob),
  name: z.string().min(1).max(255),
  manifest: SnapshotManifestSchema,
  bytes: z.int().min(0),
  timings: z.strictObject({ holdMs: duration, compressMs: duration, totalMs: duration }),
});
export type ExportResult = z.infer<typeof ExportResultSchema>;

/** The `import` result: the imported manifest, timings, and the host's status after the swap. */
export const ImportResultSchema = z.strictObject({
  manifest: SnapshotManifestSchema,
  timings: z.strictObject({ readMs: duration, checkMs: duration, unpackMs: duration, trialMs: duration, swapMs: duration, totalMs: duration }),
  status: HostStatusSchema,
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export const RESULT_SCHEMAS = {
  status: HostStatusSchema,
  api: ApiResultSchema,
  start: HostStatusSchema,
  stop: HostStatusSchema,
  range: HostStatusSchema,
  reset: HostStatusSchema,
  export: ExportResultSchema,
  import: ImportResultSchema,
  digest: DigestResultSchema,
  system: SystemResultSchema,
  watchdog: WatchdogResultSchema,
} as const satisfies Record<RequestType, z.ZodType>;
export type ResultOf<T extends RequestType> = z.infer<(typeof RESULT_SCHEMAS)[T]>;

// ── Responses and notices ────────────────────────────────────────────────────────────────────────────────────────────

export const ProtocolErrorSchema = z.strictObject({ code: z.enum(ERROR_CODES), message: z.string() });
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

const responseEnvelope = {
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("response"),
  id: intIn(1, Number.MAX_SAFE_INTEGER).nullable(),
  request: z.enum(REQUEST_TYPES).nullable(),
};
export const ResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...responseEnvelope, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ ...responseEnvelope, ok: z.literal(false), error: ProtocolErrorSchema }),
]);
export type Response = z.infer<typeof ResponseSchema>;

export const ENGINE_STATES = ["running", "stopped", "failed"] as const;
export const NoticeSchema = z.discriminatedUnion("notice", [
  z.strictObject({ v: z.literal(PROTOCOL_VERSION), type: z.literal("notice"), notice: z.literal("boot"), boot: BootStateSchema }),
  z.strictObject({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("notice"),
    notice: z.literal("engine"),
    engine: z.strictObject({ state: z.enum(ENGINE_STATES), error: z.string().nullable() }),
  }),
  z.strictObject({ v: z.literal(PROTOCOL_VERSION), type: z.literal("notice"), notice: z.literal("system"), snapshot: SystemSnapshotSchema }),
  z.strictObject({ v: z.literal(PROTOCOL_VERSION), type: z.literal("notice"), notice: z.literal("heartbeat"), heartbeat: HeartbeatSchema }),
]);
export type Notice = z.infer<typeof NoticeSchema>;

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A one-line summary of a validation failure: the first issues with their paths. */
export function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.length === 0 ? "message" : i.path.join(".")}: ${i.message}`)
    .join("; ");
}

export type ParsedRequest =
  | { ok: true; request: Request }
  | { ok: false; id: number | null; request: RequestType | null; error: ProtocolError };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Validates one incoming request. */
export function parseRequest(raw: unknown): ParsedRequest {
  if (!isRecord(raw)) return { ok: false, id: null, request: null, error: { code: "bad-request", message: "a request is an object" } };
  const id = typeof raw.id === "number" && Number.isSafeInteger(raw.id) && raw.id >= 1 ? raw.id : null;
  const type = typeof raw.type === "string" && (REQUEST_TYPES as readonly string[]).includes(raw.type) ? (raw.type as RequestType) : null;
  if (raw.v !== PROTOCOL_VERSION)
    return { ok: false, id, request: type, error: { code: "unsupported-version", message: `protocol version ${String(raw.v)} is not ${PROTOCOL_VERSION}` } };
  if (type === null) {
    const what = typeof raw.type === "string" ? JSON.stringify(raw.type.slice(0, 64)) : "missing";
    return { ok: false, id, request: null, error: { code: "unknown-type", message: `request type ${what} is not part of protocol version ${PROTOCOL_VERSION}` } };
  }
  const parsed = REQUEST_SCHEMAS[type].safeParse(raw);
  if (!parsed.success) return { ok: false, id, request: type, error: { code: "bad-request", message: issuesOf(parsed.error) } };
  return { ok: true, request: parsed.data as Request };
}

export type ParsedWorkerMessage =
  | { kind: "response"; response: Response }
  | { kind: "notice"; notice: Notice }
  | { kind: "invalid"; message: string };

/** Validates one message from the worker (a response's `result` is validated by {@link parseResult}). */
export function parseWorkerMessage(raw: unknown): ParsedWorkerMessage {
  if (!isRecord(raw)) return { kind: "invalid", message: "a message is an object" };
  if (raw.v !== PROTOCOL_VERSION) return { kind: "invalid", message: `protocol version ${String(raw.v)} is not ${PROTOCOL_VERSION}` };
  if (raw.type === "response") {
    const r = ResponseSchema.safeParse(raw);
    return r.success ? { kind: "response", response: r.data } : { kind: "invalid", message: issuesOf(r.error) };
  }
  if (raw.type === "notice") {
    const r = NoticeSchema.safeParse(raw);
    return r.success ? { kind: "notice", notice: r.data } : { kind: "invalid", message: issuesOf(r.error) };
  }
  return { kind: "invalid", message: `unknown message type ${JSON.stringify(String(raw.type).slice(0, 64))}` };
}

/** Validates the result of a successful response to a request of type `type`. */
export function parseResult<T extends RequestType>(type: T, result: unknown): { ok: true; result: ResultOf<T> } | { ok: false; message: string } {
  const r = RESULT_SCHEMAS[type].safeParse(result);
  return r.success ? { ok: true, result: r.data as ResultOf<T> } : { ok: false, message: issuesOf(r.error) };
}

// ── Compile-time agreement with the engine's types ───────────────────────────────────────────────────────────────────

/** Compiles only when every value of type `Sent` passes the schema `S` (what the worker sends is what the page accepts). */
const accepts = <S extends z.ZodType, Sent extends z.input<S>>(): void => {};
/** Compiles only when `Sent` has no key the strict schema `S` lacks (a new engine field must be added to the schema). */
const noExtraKeys = <S extends z.ZodType, Sent>(..._: [Exclude<keyof Sent, keyof z.input<S>>] extends [never] ? [] : [never]): void => {};
accepts<typeof ApiResultSchema, ApiResponse>();
accepts<typeof EngineStatusSchema, EngineStatus>();
accepts<typeof SyncCursorSchema, SyncCursor>();
accepts<typeof ScanCursorSchema, ScanCursor>();
noExtraKeys<typeof ApiResultSchema, ApiResponse>();
noExtraKeys<typeof EngineStatusSchema, EngineStatus>();
noExtraKeys<typeof EngineStatusSchema.shape.sync, EngineStatus["sync"]>();
noExtraKeys<typeof EngineStatusSchema.shape.scan, EngineStatus["scan"]>();
noExtraKeys<typeof EngineStatusSchema.shape.api, EngineStatus["api"]>();
noExtraKeys<typeof SyncOnceResultSchema, SyncOnceResult>();
noExtraKeys<typeof ScanOnceResultSchema, ScanOnceResult>();
noExtraKeys<typeof SyncCursorSchema, SyncCursor>();
noExtraKeys<typeof ScanCursorSchema, ScanCursor>();
accepts<typeof DigestResultSchema.shape.archive, ArchiveDigest>();
accepts<typeof DigestResultSchema.shape.tables, RangeTables>();
noExtraKeys<typeof DigestResultSchema.shape.archive, ArchiveDigest>();
noExtraKeys<typeof DigestResultSchema.shape.tables, RangeTables>();
accepts<typeof ExportResultSchema, ExportedSnapshot>();
noExtraKeys<typeof ExportResultSchema, ExportedSnapshot>();
