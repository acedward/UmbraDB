/**
 * The engine's `system` snapshot: a versioned, point-in-time, JSON-serializable record of everything the system status
 * page shows (overview and health line, configuration, sync, scan, databases, storage, API, engine, browser,
 * snapshots, logs) and what "Download diagnostics" saves. It is self-describing (`format`, `version`, `generatedAt`,
 * `role`), so a follower tab can show a snapshot its leader produced, and a diagnostics file can be read without the
 * build that wrote it.
 *
 * - **Schema:** {@link SystemSnapshotSchema} (zod). Every object is strict: an unknown key is refused, so nothing
 *   outside this schema (a page URL, a request target, a header) can travel inside a snapshot. Times are epoch
 *   milliseconds; durations are milliseconds; heights are block heights; sizes are bytes.
 * - **No secrets:** {@link redactSnapshot} runs over every string of a snapshot before it is validated and handed out.
 *   URLs lose their userinfo, query and fragment, and the path segments that look like keys (16 or more letters,
 *   digits, `-`, `_`, `.`, `~`, `+` or `=`, with both a letter and a digit); `key=value`, `key: value` and JSON
 *   `"key": value` forms whose key names a secret (API key, token, password, session id, signature, seed or mnemonic
 *   phrase, viewing key, …) lose their whole value: a JSON member its whole string, array or object, also inside
 *   JSON-escaped text (`\"key\": …`), a `key=` value its quoted text, JSON array or object, and an unquoted seed,
 *   mnemonic or passphrase every word that follows it; `Authorization` and `Cookie` headers lose the rest of their line; Bearer and Basic credentials, JWT-shaped tokens
 *   and Bech32m secret keys (`mn_…esk…`, `mn_…sk…`, `mn_…seed…`) are replaced. Request targets are never recorded (the API counters see the method, status and latency only).
 * - **Text is data:** log lines and error messages keep their characters (control, bidirectional and markup
 *   characters included) apart from the redaction and a length cap; a page renders them as text nodes, never as
 *   markup, with the explorer's hidden-character rules.
 */
import { z } from "zod";
import { publicEndpoint } from "../../wallet-monitor/log.js";

/** The `format` of every snapshot. */
export const SYSTEM_SNAPSHOT_FORMAT = "umbradb-system-snapshot";
/** The schema version this module writes and reads. */
export const SYSTEM_SNAPSHOT_VERSION = 1;
/** Lines the log section holds at most (the engine's ring buffer). */
export const LOG_CAPACITY = 200;
/** Characters a log line or an error message keeps at most; a longer one is cut and says how much was cut. */
export const TEXT_MAX_CHARS = 4_096;

// ── Building blocks ──────────────────────────────────────────────────────────────────────────────────────────────

const height = z.number().int().min(0);
const count = z.number().int().min(0);
const bytes = z.number().int().min(0);
/** Epoch milliseconds. */
const time = z.number().int().min(0);
const millis = z.number().min(0);
const rate = z.number().min(0);
const text = z.string().max(TEXT_MAX_CHARS + 64);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const HEALTH_STATES = ["running", "following", "catching-up", "waiting-network", "stalled-scan", "paused-quota", "stopped", "error"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];
/** How the status page names each state. */
export const HEALTH_LABELS: Record<HealthState, string> = {
  running: "running",
  following: "following",
  "catching-up": "catching up",
  "waiting-network": "waiting (network)",
  "stalled-scan": "stalled (scan)",
  "paused-quota": "paused (quota)",
  stopped: "stopped",
  error: "error",
};

export const LOOP_PHASES = ["off", "ready", "starting", "running", "idle", "backoff", "done", "stopped", "failed"] as const;
const loopPhase = z.enum(LOOP_PHASES);
const lastError = z.strictObject({ message: text, at: time.nullable() }).nullable();

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const HealthSchema = z.strictObject({
  state: z.enum(HEALTH_STATES),
  label: z.string(),
  /** Why: the error, the waiting call, the pause, the range end; `null` when nothing needs saying. */
  reason: text.nullable(),
});

export const OverviewSchema = z.strictObject({
  health: HealthSchema,
  /** `/v1/status` `startHeight`: the first indexed height; history before it is not indexed. */
  startHeight: height.nullable(),
  /** `/v1/status` `archiveHeight`: the chain archive's sync cursor. */
  archiveHeight: height.nullable(),
  /** `/v1/status` `indexedHeight`: the last scanned height. */
  scanHeight: height.nullable(),
  /** `min(node finalized height, indexer tip)` as the sync last read it, and when. */
  finalizedTip: height.nullable(),
  finalizedTipAt: time.nullable(),
  lag: z.strictObject({
    /** Finalized tip − scan height (blocks not yet scanned), never below 0. */
    blocks: count.nullable(),
    /** Finalized tip − archive height. */
    archiveBlocks: count.nullable(),
    /** Archive height − scan height. */
    scanBehindArchive: count.nullable(),
    /** `blocks` × the chain's measured seconds per finalized block (how far behind the chain, in time). */
    seconds: millis.nullable(),
    /** Seconds per finalized block, measured from the tip's rise over the last 10 minutes. */
    secondsPerBlock: z.number().positive().nullable(),
    /** `blocks` ÷ the scan's blocks per second over the last minute (how long until caught up at this pace). */
    catchUpSeconds: millis.nullable(),
  }),
});

const endpointConfig = z.strictObject({ node: z.string().nullable(), indexer: z.string().nullable() });

export const ConfigurationSchema = z.strictObject({
  network: z.string(),
  genesisHash: z.string().nullable(),
  /** Node and indexer URLs, without userinfo, query or fragment. */
  endpoints: endpointConfig,
  schemas: z.strictObject({ archive: z.string(), mip0018: z.string() }),
  sync: z
    .strictObject({
      maxBlocks: count,
      concurrency: count,
      /** Request spacing per endpoint as the sync applies it (`null` until the sync has started). */
      minIntervalMs: z.strictObject({ node: millis, indexer: millis }).nullable(),
      timeoutMs: millis,
      idleMs: millis,
    })
    .nullable(),
  scan: z
    .strictObject({
      mode: z.enum(["follow", "drain"]),
      batch: count,
      idleMs: millis,
      maxBackoffMs: millis,
      fromHeight: height.nullable(),
      toHeight: height.nullable(),
    })
    .nullable(),
  /** Retry of one network call and back-off of a failed sync batch. */
  retry: z.strictObject({ baseDelayMs: millis, maxDelayMs: millis, maxAttempts: count, jitter: z.boolean() }).nullable(),
  start: z.strictObject({
    /** `tip`: the first height is the finalized tip when the store is created; `range`: a chosen start (and end). */
    mode: z.enum(["tip", "range"]),
    /** The configured or resolved first height (`null`: not resolved yet). */
    startHeight: height.nullable(),
    endHeight: height.nullable(),
    autoStart: z.boolean(),
  }),
  durability: z.enum(["durable", "non-durable"]).nullable(),
  watchdogLimitMs: millis.nullable(),
  api: z.strictObject({ maxConcurrentRequests: count }),
  build: z.strictObject({
    appCommit: z.string().nullable(),
    pgliteVersion: z.string().nullable(),
    postgresVersion: z.string().nullable(),
    ledgerVersion: z.string().nullable(),
    mip: z.strictObject({ id: z.string(), commit: z.string() }).nullable(),
    vendored: z.strictObject({ repository: z.string(), commit: z.string() }).nullable(),
  }),
});

export const EndpointCountersSchema = z.strictObject({
  /** Requests started (every attempt, retries included). */
  requests: count,
  inFlight: count,
  /** Answers by status: 2xx, 429, 403, 5xx, any other. */
  ok: count,
  http429: count,
  http403: count,
  http5xx: count,
  httpOther: count,
  /** Requests that got no answer (DNS, connection, CORS, timeout), and requests aborted by the engine. */
  transportErrors: count,
  aborted: count,
  /** Calls the sync retried after a retryable failure, and how many of those were 429/403. */
  retries: count,
  throttledRetries: count,
  lastRequestAt: time.nullable(),
  lastOkAt: time.nullable(),
  lastFailureAt: time.nullable(),
});
export type EndpointCountersJson = z.infer<typeof EndpointCountersSchema>;

export const SyncSchema = z.strictObject({
  phase: loopPhase,
  /** The archive's first height (the sync cursor's start) and its current height (`/v1/status` `archiveHeight`). */
  archiveStart: height.nullable(),
  archiveHeight: height.nullable(),
  /** The node's finalized height and the indexer's tip at the last batch; the sync follows the lower one. */
  nodeFinalizedHeight: height.nullable(),
  indexerTipHeight: height.nullable(),
  finalizedTip: height.nullable(),
  /** Blocks archived per second over the last minute, and since this worker started. */
  blocksPerSecond: rate,
  ingestedSinceStart: count,
  endpoints: z.strictObject({ node: EndpointCountersSchema, indexer: EndpointCountersSchema }),
  /** The last batch that succeeded. */
  lastSuccessAt: time.nullable(),
  /** When the next batch or retried call starts (`null`: running now, or not waiting). */
  nextAttemptAt: time.nullable(),
  lastError,
  failures: count,
});

export const ScanSchema = z.strictObject({
  phase: loopPhase,
  /** `/v1/status` `scanner`. */
  scanner: z.enum(["following", "stalled", "off"]),
  /** `/v1/status` `startHeight`, and the next height to scan. */
  startHeight: height.nullable(),
  nextHeight: height.nullable(),
  /** Archive height − last scanned height. */
  lagBehindArchive: count.nullable(),
  blocksPerSecond: rate,
  scannedSinceStart: count,
  /** What the scan stored since this worker started. */
  totals: z.strictObject({ transactions: count, events: count, mints: count, sightings: count, actions: count }),
  /** `/v1/status` `unresolvedEvents`. */
  unresolvedEvents: count.nullable(),
  lastSuccessAt: time.nullable(),
  nextAttemptAt: time.nullable(),
  lastError,
  failures: count,
});

export const TableStatsSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(["table", "partitioned", "partition"]),
  partitionOf: z.string().nullable(),
  /** `pg_class.reltuples`; `null` while the table has no estimate (never vacuumed or analyzed). */
  estimatedRows: z.number().min(0).nullable(),
  /** `pg_total_relation_size` (table, indexes and TOAST). */
  totalBytes: bytes,
  /** `count(*)`, only after exact counts were asked for (`exactRowsAt`). */
  exactRows: count.nullable(),
  /** A partitioned table's partitions together: their number, estimated rows (`null` when one has none) and bytes. */
  partitions: z.strictObject({ count, estimatedRows: z.number().min(0).nullable(), totalBytes: bytes }).nullable(),
});
export type TableStatsJson = z.infer<typeof TableStatsSchema>;

export const SchemaStatsSchema = z.strictObject({
  name: z.string(),
  /** The schema has at least one table. */
  exists: z.boolean(),
  /** `<schema>._migrations`, in the order they were applied. */
  migrations: z.array(z.strictObject({ name: z.string(), appliedAt: time })),
  tables: z.array(TableStatsSchema),
});

export const DatabasesSchema = z.strictObject({
  /** The data directory as the host opened it (`opfs-ahp://…`, `memory://…`), when the host says. */
  dataDir: z.string().nullable(),
  serverVersion: z.string().nullable(),
  fsync: z.string().nullable(),
  durability: z.enum(["durable", "non-durable"]).nullable(),
  /** `pg_database_size(current_database())`. */
  databaseBytes: bytes.nullable(),
  schemas: z.array(SchemaStatsSchema),
  /** When the catalog statistics were read, and each statement of that read (one short statement at a time). */
  collectedAt: time.nullable(),
  statements: z.array(z.strictObject({ label: z.string(), ms: millis })),
  exactRowsAt: time.nullable(),
  error: text.nullable(),
});

export const StorageSchema = z.strictObject({
  /** `navigator.storage.estimate()` and `navigator.storage.persisted()` (browser only), and when they were read. */
  usageBytes: bytes.nullable(),
  quotaBytes: bytes.nullable(),
  persisted: z.boolean().nullable(),
  estimatedAt: time.nullable(),
  /** The usage at which the sync pauses, whether it is paused now, and why. */
  pauseAtBytes: bytes.nullable(),
  paused: z.boolean(),
  pausedReason: text.nullable(),
  /** `pg_database_size`: the store's own size (the browser's estimate can overstate it while the store is open). */
  databaseBytes: bytes.nullable(),
  bytesPerBlock: z.strictObject({
    /** Database size ÷ archived blocks. */
    store: z.number().min(0).nullable(),
    /** Database growth ÷ blocks archived since this worker started (once one block was archived). */
    growth: z.number().nullable(),
  }),
});

export const ApiSchema = z.strictObject({
  /** Requests admitted and not yet answered (the queue), and the cap beyond which requests are answered 503 `BUSY`. */
  inFlight: count,
  maxConcurrentRequests: count,
  /** Requests answered (`BUSY` refusals apart), by status class, and the `BUSY` refusals. */
  served: count,
  byStatus: z.strictObject({ "2xx": count, "3xx": count, "4xx": count, "5xx": count }),
  busy: count,
  /** Nearest-rank percentiles over the latest admitted requests (`samples` of at most `window`). */
  latencyMs: z.strictObject({ p50: millis.nullable(), p95: millis.nullable(), samples: count, window: count }),
});

export const EngineSchema = z.strictObject({
  /** Whether the engine's loops were started, and whether they are stopping. */
  started: z.boolean(),
  stopping: z.boolean(),
  /** Tabs connected to this engine (the leader's own included), when the host knows. */
  connectedTabs: count.nullable(),
  /** When this worker started, and for how long. */
  startedAt: time,
  uptimeMs: millis,
  /** Worker restarts by the query watchdog (carried across restarts by the host), and the last one. */
  watchdogRestarts: count,
  lastWatchdogRestart: z.strictObject({ at: time, reason: text }).nullable(),
  /** PGlite reopens, and failed statements since the database was last opened (and in total). */
  pgliteReopens: count,
  lastReopenAt: time.nullable(),
  failedStatementsSinceOpen: count,
  failedStatementsTotal: count,
});

export const BrowserSchema = z.strictObject({
  /** Brand and major version, as the browser reports it. */
  browser: z.string().nullable(),
  checks: z.strictObject({
    chromium: z.boolean(),
    opfs: z.boolean(),
    syncAccessHandle: z.boolean(),
    webLocks: z.boolean(),
    broadcastChannel: z.boolean(),
    persistentStorage: z.boolean(),
  }),
});

export const SnapshotRecordSchema = z.strictObject({
  at: time,
  sha256: hex64,
  bytes: bytes.nullable(),
  manifest: z.strictObject({
    network: z.string(),
    height: height,
    blockHash: z.string(),
    /** Applied migrations per schema. */
    schemaVersions: z.record(z.string(), z.array(z.string())),
    pgliteVersion: z.string(),
  }),
});

export const SnapshotsSchema = z.strictObject({
  lastExport: SnapshotRecordSchema.nullable(),
  lastImport: SnapshotRecordSchema.nullable(),
});

export const LogEntrySchema = z.strictObject({
  /** Increases by one per line since this worker started. */
  seq: count,
  at: time,
  level: z.enum(["info", "warn", "error"]),
  source: z.string(),
  text,
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const CollectionSchema = z.strictObject({
  /** Whether a status page is watching now (collection runs only then), and the two refresh intervals. */
  watching: z.boolean(),
  countersEveryMs: millis,
  databaseEveryMs: millis,
  /** The last good `/v1/status` read, and why the latest one failed (`null`: it did not). */
  statusAt: time.nullable(),
  statusError: text.nullable(),
});

export const SystemSnapshotSchema = z.strictObject({
  format: z.literal(SYSTEM_SNAPSHOT_FORMAT),
  version: z.literal(SYSTEM_SNAPSHOT_VERSION),
  generatedAt: time,
  /** The tab that produced or relayed this snapshot: the leader runs the engine; a follower shows the leader's. */
  role: z.enum(["leader", "follower"]),
  /** When a follower received it from the leader. */
  relayedAt: time.nullable(),
  overview: OverviewSchema,
  configuration: ConfigurationSchema,
  sync: SyncSchema,
  scan: ScanSchema,
  databases: DatabasesSchema,
  storage: StorageSchema,
  api: ApiSchema,
  engine: EngineSchema,
  /** `null` outside a browser. */
  browser: BrowserSchema.nullable(),
  snapshots: SnapshotsSchema,
  /** The latest lines first, at most {@link LOG_CAPACITY}. */
  logs: z.array(LogEntrySchema).max(LOG_CAPACITY),
  collection: CollectionSchema,
});
export type SystemSnapshot = z.infer<typeof SystemSnapshotSchema>;
export type ConfigurationJson = z.infer<typeof ConfigurationSchema>;
export type BrowserInfo = z.infer<typeof BrowserSchema>;
export type SnapshotsInfo = z.infer<typeof SnapshotsSchema>;

// ── Redaction ────────────────────────────────────────────────────────────────────────────────────────────────────

const REDACTED = "[redacted]";

/** A path segment that looks like a key or token: 16 or more token characters with both a letter and a digit. */
const KEY_LIKE_SEGMENT = /^(?=[^/]*[A-Za-z])(?=[^/]*[0-9])[A-Za-z0-9._~+=-]{16,}$/u;

/** `url`'s path with the segments that look like keys replaced. */
function publicPath(url: URL): void {
  if (url.pathname.startsWith("/")) url.pathname = url.pathname.split("/").map((seg) => (KEY_LIKE_SEGMENT.test(seg) ? REDACTED : seg)).join("/");
}

/** A URL without userinfo, query, fragment or path segments that look like keys; one that does not parse keeps only its
 *  scheme. */
export function publicUrl(value: string): string {
  try {
    const url = new URL(/^(?:https?|wss?):/iu.test(value) ? publicEndpoint(value) : value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    publicPath(url);
    return url.toString();
  } catch {
    // fall through
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1] ?? "url";
  return `${scheme}://${REDACTED}`;
}

/** Header names whose whole value (to the end of the line) is a secret. */
const SECRET_HEADER = String.raw`(?:proxy-authorization|authorization|set-cookie|cookie)`;
/** Names whose value is a phrase of words (a wallet's seed or mnemonic): an unquoted value is every word after it. */
const PHRASE_KEY = String.raw`(?:(?:seed|mnemonic|recovery|secret|backup|wallet)[-_ ]?phrase|passphrase|mnemonic|seed)`;
/** Names whose value is a secret, as a key of `key=value`, `key: value` or JSON `"key": value`. */
const SECRET_KEY = String.raw`(?:x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|bearer[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|viewing[-_]?key|${SECRET_HEADER}|session[-_]?id|sessionid|${PHRASE_KEY}|token|secret|password|passwd|pwd|signature|credentials?)`;
const IS_PHRASE_KEY = new RegExp(String.raw`^${PHRASE_KEY}$`, "iu");

const JSON_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** The character at `i` of `text` as seen through `level` (0 or 1) JSON string encodings, and the index after it. */
function charAt(text: string, i: number, level: 0 | 1): [string, number] {
  const c = text[i] ?? "";
  if (level === 0 || c !== "\\" || i + 1 >= text.length) return [c, i + 1];
  const e = text[i + 1]!;
  if (e === "u") return [String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16) || 0), i + 6];
  return [JSON_ESCAPES[e] ?? e, i + 2];
}

/** The index after the JSON value (string, array, object, or a bare word) that starts at `i`, read through `level`
 *  encodings; the end of the text when it does not end. */
function skipJsonValue(text: string, i: number, level: 0 | 1): number {
  let depth = 0;
  let inString = false;
  let j = i;
  const [first] = charAt(text, i, level);
  if (first !== '"' && first !== "[" && first !== "{") {
    while (j < text.length) {
      const [c, next] = charAt(text, j, level);
      if (/[\s,}\]]/u.test(c) || (level === 1 && c === '"')) break;
      j = next;
    }
    return j;
  }
  while (j < text.length) {
    const [c, next] = charAt(text, j, level);
    j = next;
    if (inString) {
      if (c === "\\") j = charAt(text, j, level)[1];
      else if (c === '"') {
        inString = false;
        if (depth === 0) return j;
      }
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth <= 0) return j;
    }
  }
  return text.length;
}

/** JSON members naming a secret (`"key": value`, or `\"key\": value` inside JSON-escaped text): the whole value. */
const SECRET_MEMBER = new RegExp(String.raw`(\\?)"${SECRET_KEY}\1"\s*:\s*`, "giu");
function redactMembers(text: string): string {
  let out = "";
  let last = 0;
  SECRET_MEMBER.lastIndex = 0;
  for (let m = SECRET_MEMBER.exec(text); m !== null; m = SECRET_MEMBER.exec(text)) {
    const level = m[1] === "\\" ? 1 : 0;
    const start = m.index + m[0].length;
    const end = skipJsonValue(text, start, level);
    const q = level === 1 ? '\\"' : '"';
    out += `${text.slice(last, start)}${q}${REDACTED}${q}`;
    last = end;
    SECRET_MEMBER.lastIndex = Math.max(end, start);
  }
  return out + text.slice(last);
}

/** `key=value` and `key: value` naming a secret: a quoted value, a JSON array or object, or a bare word — and for a
 *  phrase key every lower-case word after it. */
const SECRET_ASSIGNMENT = new RegExp(String.raw`(^|[^\w-])(${SECRET_KEY})(\s*[=:]\s*)`, "giu");
const PHRASE_WORDS = /(?:,?[ \t]+[\p{Ll}\p{Lo}]+)*/uy;
function redactAssignments(text: string): string {
  let out = "";
  let last = 0;
  SECRET_ASSIGNMENT.lastIndex = 0;
  for (let m = SECRET_ASSIGNMENT.exec(text); m !== null; m = SECRET_ASSIGNMENT.exec(text)) {
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    let end: number;
    if (/^"?\[redacted\]/u.test(rest)) end = start;
    else if (rest.startsWith('"')) end = start + (/^"(?:[^"\\]|\\.)*"?/u.exec(rest)![0].length);
    else if (rest.startsWith("'")) end = start + (/^'[^']*'?/u.exec(rest)![0].length);
    else if (rest.startsWith("[") || rest.startsWith("{")) end = skipJsonValue(text, start, 0);
    else {
      end = start + (/^[^\s&;,"'<>}\]]*/u.exec(rest)![0].length);
      if (end > start && IS_PHRASE_KEY.test(m[2]!)) {
        PHRASE_WORDS.lastIndex = end;
        end += PHRASE_WORDS.exec(text)?.[0].length ?? 0;
      }
    }
    if (end === start) continue;
    out += `${text.slice(last, start)}${REDACTED}`;
    last = end;
    SECRET_ASSIGNMENT.lastIndex = end;
  }
  return out + text.slice(last);
}

const RULES: ReadonlyArray<[RegExp, string | ((...m: string[]) => string)]> = [
  // URLs of any scheme: userinfo, query and fragment removed. A URL ends at a backslash too (in JSON-escaped text the
  // next character is an escape, not part of the URL).
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`\\]+/giu, (m) => publicUrl(m)],
  // JWT-shaped tokens.
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/gu, `${REDACTED} token`],
  // Bech32m secret keys (a viewing key is `mn_shield-esk…`).
  [/\bmn_[a-z0-9-]*(?:esk|sk|seed)(?:_[a-z0-9-]+)?1[02-9ac-hj-np-z]{6,}/giu, `${REDACTED} key`],
  // Bearer and Basic credentials.
  [/\b(Bearer)(\s+)[\w.~+/=-]{8,}/giu, (_m, scheme, sp) => `${scheme}${sp}${REDACTED}`],
  [/\b(Basic)(\s+)(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/gu, (_m, scheme, sp) => `${scheme}${sp}${REDACTED}`],
  // Authorization and cookie headers: the rest of the line.
  [new RegExp(String.raw`(^|[^\w-])(${SECRET_HEADER})(\s*[=:]\s*)(?!\s|\[redacted\])[^\r\n]+`, "gimu"), (_m, pre, k, sep) => `${pre}${k}${sep}${REDACTED}`],
];

/** `text` with the secrets this module knows removed (see the module documentation); idempotent. */
export function redactText(value: string): string {
  let out = value;
  for (const [re, by] of RULES) out = out.replace(re, by as (substring: string, ...args: string[]) => string);
  // JSON members, then key=value and key: value.
  return redactAssignments(redactMembers(out));
}

/** `text` cut to {@link TEXT_MAX_CHARS}, saying how many characters were cut. */
export function capText(value: string): string {
  if (value.length <= TEXT_MAX_CHARS) return value;
  return `${value.slice(0, TEXT_MAX_CHARS)}… [${value.length - TEXT_MAX_CHARS} more characters]`;
}

/** Every string of `value` (keys stay) through {@link redactText}. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/** The snapshot with every string redacted, validated against {@link SystemSnapshotSchema}. */
export function redactSnapshot(snapshot: SystemSnapshot): SystemSnapshot {
  return SystemSnapshotSchema.parse(redactDeep(snapshot));
}

/** A snapshot as a follower tab shows it: received from the leader at `relayedAt`, marked `follower`. */
export function relayedSnapshot(snapshot: SystemSnapshot, relayedAt: number): SystemSnapshot {
  return SystemSnapshotSchema.parse({ ...snapshot, role: "follower", relayedAt });
}

/** The diagnostics file: the snapshot as JSON (its log lines included), redacted and validated again. */
export function diagnosticsJson(snapshot: SystemSnapshot): string {
  return `${JSON.stringify(redactSnapshot(snapshot), null, 2)}\n`;
}
