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
 * | `start` | `config` ({@link StartConfig}) | {@link HostStatus} |
 * | `stop` | — | {@link HostStatus} |
 * | `range` | `startHeight` (a height or `"tip"`), `endHeight?` | error `not-implemented` |
 * | `reset` | — | error `not-implemented` |
 * | `export` | — | error `not-implemented` |
 * | `import` | `snapshot` (a `Blob`) | error `not-implemented` |
 *
 * Responses (worker → page): `{ v, type: "response", id, request, ok: true, result }` or
 * `{ v, type: "response", id, request, ok: false, error: { code, message } }`; `id` and `request` are `null` when the
 * request was too malformed to carry them. Notices (worker → page, unsolicited): `boot` (each boot phase, see
 * {@link BootState}) and `engine` (the engine started, stopped or failed).
 *
 * A message of another protocol version is answered `unsupported-version`, and a request type this version does not
 * know `unknown-type`, so a page and a worker from different builds fail with a clear error. New request and notice
 * types are added to the unions below under a new version.
 */
import { z } from "zod";
import type { ApiResponse } from "../mip0018/api.ts";
import type { EngineStatus } from "../engine/engine.ts";
import type { SyncCursor } from "../../chain-archive-sync/sync-service.js";
import type { ScanCursor } from "../mip0018/scan.ts";

export const PROTOCOL_VERSION = 1;

/** The request types of this protocol version. */
export const REQUEST_TYPES = ["status", "api", "start", "stop", "range", "reset", "export", "import"] as const;
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
    /** First height of a new archive. A store whose archive already has a cursor continues there and ignores it unless
     *  it contradicts the archive (then the sync refuses the range). Required while the archive is empty. */
    startHeight: height.optional(),
    /** Last height to sync, inclusive. Default: follow the finalized tip. */
    endHeight: height.optional(),
    sync: z
      .strictObject({
        maxBlocks: intIn(1, 1_000).optional(),
        concurrency: intIn(1, 16).optional(),
        minIntervalMs: intIn(0, 60_000).optional(),
        idleMs: intIn(1, 3_600_000).optional(),
      })
      .optional(),
    scan: z.strictObject({ batch: intIn(1, 1_000).optional(), idleMs: intIn(100, 3_600_000).optional() }).optional(),
  })
  .refine((c) => c.startHeight === undefined || c.endHeight === undefined || c.endHeight >= c.startHeight, {
    message: "endHeight is below startHeight",
    path: ["endHeight"],
  });
export type StartConfig = z.infer<typeof StartConfigSchema>;

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const envelope = { v: z.literal(PROTOCOL_VERSION), id: intIn(1, Number.MAX_SAFE_INTEGER) };

export const REQUEST_SCHEMAS = {
  status: z.strictObject({ ...envelope, type: z.literal("status") }),
  api: z.strictObject({ ...envelope, type: z.literal("api"), method: z.string().min(1).max(32), target: z.string().min(1).max(65_536) }),
  start: z.strictObject({ ...envelope, type: z.literal("start"), config: StartConfigSchema }),
  stop: z.strictObject({ ...envelope, type: z.literal("stop") }),
  range: z.strictObject({ ...envelope, type: z.literal("range"), startHeight: z.union([height, z.literal("tip")]), endHeight: height.optional() }),
  reset: z.strictObject({ ...envelope, type: z.literal("reset") }),
  export: z.strictObject({ ...envelope, type: z.literal("export") }),
  import: z.strictObject({ ...envelope, type: z.literal("import"), snapshot: z.instanceof(Blob) }),
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
  ingestedBlocks: n, fromHeight: opt(n), toHeight: opt(n), targetTipHeight: opt(n), reachedEnd: z.boolean(),
  retries: n, throttled: n, elapsedMs: n,
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
});
export type HostStatus = z.infer<typeof HostStatusSchema>;

export const RESULT_SCHEMAS = {
  status: HostStatusSchema,
  api: ApiResultSchema,
  start: HostStatusSchema,
  stop: HostStatusSchema,
  range: z.never(),
  reset: z.never(),
  export: z.never(),
  import: z.never(),
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
accepts<typeof ApiResultSchema, ApiResponse>();
accepts<typeof EngineStatusSchema, EngineStatus>();
accepts<typeof SyncCursorSchema, SyncCursor>();
accepts<typeof ScanCursorSchema, ScanCursor>();
