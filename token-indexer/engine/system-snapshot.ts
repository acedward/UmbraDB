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
 *   A text longer than 4,096 characters (`TEXT_MAX_CHARS`), unless it is already a cut text (at most 4,096 characters
 *   and the mark of a cut), is cut to at most that many first, so redaction reads at most a few kilobytes and every
 *   expression and scan of it is linear in the text's length; the mark saying how many characters were cut is added
 *   after the redaction, which never reads it (so redacting a redacted text gives it back). Then:
 *   URLs lose their userinfo, query and fragment, and the path segments that look like keys (16 or more letters,
 *   digits, `-`, `_`, `.`, `~`, `+` or `=`, with both a letter and a digit); `key=value`, `key: value` and JSON
 *   `"key": value` forms whose key names a secret ({@link keyKind}: a name ending in password, token, secret,
 *   signature, credentials, cookie, an API, secret, private or viewing key or a session id, or naming a seed, mnemonic
 *   or phrase, whatever its case, prefix or suffix — `DB_PASSWORD`, `walletSeed`, `WALLET_MNEMONIC`, `x-seed`) lose
 *   their whole value: a JSON member its whole string, array or object, also inside JSON text written as a JSON string
 *   once or more (`\"key\": …`, `\\\"key\\\": …`, at any depth a cut text can hold); a `key=` value its quoted text (also `\"…\"`
 *   inside JSON-escaped text, to the end of the string around it when it is never closed), JSON array or object, or
 *   bare word; and after a seed or mnemonic key every word of the phrase, of any case, across white space, commas,
 *   `;`, `|`, `-`, `<br>`, words quoted one by one, list numbers (`1.`, `1)`, `1-`, `#1`, `(1)`, `[1]`) and line
 *   breaks (also JSON-escaped), onto a next line only when it holds nothing but such words, and at most 36 words; a
 *   phrase ends before a blank line, a Latin word of fewer than 3 letters, the next `key:` or `key=`, or other
 *   punctuation. A key named only `words` is not a secret (too common a name). `Authorization` and `Cookie` headers lose
 *   the rest of their line; Bearer and Basic credentials, JWT-shaped tokens and Bech32m secret keys (`mn_…esk…`,
 *   `mn_…sk…`, `mn_…seed…`) are replaced. Request targets are never recorded (the API counters see the method, status
 *   and latency only).
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

/** The words of a key's name, lower-case: split at anything but a letter or a digit and at camelCase boundaries
 *  (`walletSeed` → wallet, seed; `WALLET_MNEMONIC` → wallet, mnemonic; `APIKey` → api, key). */
function keyWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w !== "");
}

/** Last words of a name whose value is a secret. */
const SECRET_LAST_WORDS: ReadonlySet<string> = new Set([
  "password", "passwd", "pwd", "passcode", "token", "secret", "signature", "credential", "credentials", "cookie",
  "authorization", "sessionid", "apikey",
]);
/** Last two words of a name whose value is a secret. */
const SECRET_LAST_PAIRS: ReadonlySet<string> = new Set(["api key", "secret key", "private key", "viewing key", "session id"]);
/** Words before `words` in a name whose value is a phrase (`recovery words`, `backup_words`); `words` alone is not one. */
const PHRASE_WORDS_BEFORE: ReadonlySet<string> = new Set(["seed", "mnemonic", "recovery", "secret", "backup", "wallet"]);

/**
 * What a key's name (up to four space-separated parts: `secret recovery phrase`) says of its value: `phrase` — a
 * wallet's seed or mnemonic phrase: its last part has a word containing `seed`, `mnemonic` or `phrase` (`passphrase`
 * included), whatever its case, prefix or suffix (`WALLET_MNEMONIC`, `walletSeed`, `x-seed`, `mnemonics`, `phrase`), or
 * it ends with `words` after seed, mnemonic, recovery, secret, backup or wallet (`words` alone is not a secret: too
 * common a name); `secret` — a name that ends with password, token, secret, signature, credentials, cookie,
 * authorization, an API key, a secret, private or viewing key or a session id (`DB_PASSWORD`, `x-api-key`,
 * `clientSecret`); else `undefined`.
 */
export function keyKind(name: string): "phrase" | "secret" | undefined {
  const words = keyWords(name);
  if (words.length === 0) return undefined;
  const lastPart = keyWords(name.slice(name.lastIndexOf(" ") + 1));
  if (lastPart.some((w) => w.includes("seed") || w.includes("mnemonic") || w.includes("phrase"))) return "phrase";
  const last = words[words.length - 1]!;
  if ((last === "words" || last === "word") && words.length >= 2 && PHRASE_WORDS_BEFORE.has(words[words.length - 2]!)) return "phrase";
  if (SECRET_LAST_WORDS.has(last)) return "secret";
  if (words.length >= 2 && SECRET_LAST_PAIRS.has(`${words[words.length - 2]} ${last}`)) return "secret";
  return undefined;
}

const JSON_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** The deepest JSON string encoding read ({@link SECRET_MEMBER}): text inside a JSON string inside … twelve times. A
 *  key's quotes under 12 encodings are 4,095 backslashes each, more than a text the snapshot keeps ({@link
 *  TEXT_MAX_CHARS}) can hold, so every member such a text can hold is read. */
const MAX_ENCODINGS = 12;

/** The character at `i` of `text` as seen through `level` JSON string encodings (0: the text as it is; each level
 *  decodes one: `\"` → `"`, `\\` → `\`, `\n` → a line break, …), and the index after it in `text`. */
function charAt(text: string, i: number, level: number): [string, number] {
  if (level === 0) return [text[i] ?? "", i + 1];
  const [c, next] = charAt(text, i, level - 1);
  if (c !== "\\" || next >= text.length) return [c, next];
  const [e, after] = charAt(text, next, level - 1);
  if (e !== "u") return [JSON_ESCAPES[e] ?? e, after];
  let hex = "";
  let j = after;
  for (let k = 0; k < 4 && j < text.length; k++) {
    const [h, n] = charAt(text, j, level - 1);
    hex += h;
    j = n;
  }
  return [String.fromCharCode(Number.parseInt(hex, 16) || 0), j];
}

const JSON_BARE_END: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r", "\f", "\v", ",", "}", "]"]);

/** The index after the JSON value (string, array, object, or a bare word) that starts at `i`, read through `level`
 *  encodings; the end of the text when it does not end. */
function skipJsonValue(text: string, i: number, level: number): number {
  let depth = 0;
  let inString = false;
  let j = i;
  const [first] = charAt(text, i, level);
  if (first !== '"' && first !== "[" && first !== "{") {
    while (j < text.length) {
      const [c, next] = charAt(text, j, level);
      if (JSON_BARE_END.has(c) || /\s/u.test(c) || (level > 0 && c === '"')) break;
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

/**
 * JSON members: `"key": value`, or the same inside JSON text that was itself written as a JSON string, once or more
 * (`\"key\": value`, `\\\"key\\\": value`, …, up to {@link MAX_ENCODINGS} encodings: a quote under `n` encodings is
 * `2^n - 1` backslashes and `"`). A member whose key names a secret or a phrase ({@link keyKind}) loses its whole
 * value, read through as many encodings. A match starts only at the first backslash of a run (linear time).
 */
const SECRET_MEMBER = new RegExp(String.raw`(?<!\\)(\\{0,${2 ** MAX_ENCODINGS - 1}})"([^"\\]{1,64})\1"\s*:\s*`, "gu");
function redactMembers(text: string): string {
  let out = "";
  let last = 0;
  SECRET_MEMBER.lastIndex = 0;
  for (let m = SECRET_MEMBER.exec(text); m !== null; m = SECRET_MEMBER.exec(text)) {
    const level = Math.log2(m[1]!.length + 1);
    if (!Number.isInteger(level) || keyKind(m[2]!) === undefined) continue; // not a quote under whole encodings; not a secret
    const start = m.index + m[0].length;
    const end = skipJsonValue(text, start, level);
    const q = `${m[1]}"`;
    out += `${text.slice(last, start)}${q}${REDACTED}${q}`;
    last = end;
    SECRET_MEMBER.lastIndex = Math.max(end, start);
  }
  return out + text.slice(last);
}

/**
 * `key=value` and `key: value` (also `key：value`, a full-width colon): the key a name of up to four words, the value
 * after it. Each match is checked with {@link keyKind}; a key that names nothing secret is passed over. A match starts
 * only where a name starts, and every part is bounded (linear time).
 */
const ASSIGNMENT = /(?<![\w-])([\w-]{1,64}(?: [\w-]{1,64}){0,3})(\s*[=:：]\s*)/gu;
/** Characters that end a bare value. */
const BARE_END: ReadonlySet<string> = new Set([..."&;,\"'<>}]"]);

/** The end of a bare value at `i`: up to white space or a delimiter, or a run of backslashes before a quote (the end of
 *  a JSON-escaped string). */
function bareValueEnd(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      let j = i;
      while (j < text.length && text[j] === "\\") j++;
      if (text[j] === '"') return i;
      i = j;
      continue;
    }
    if (BARE_END.has(c) || /\s/u.test(c)) return i;
    i++;
  }
  return i;
}

/** The end of a quoted value at `i` (its opening quote): after the closing quote, else at a line break or the end. */
function quotedValueEnd(text: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (c === "\r" || c === "\n") return j;
    if (c === quote) return j + 1;
    j += quote === '"' && c === "\\" ? 2 : 1;
  }
  return text.length;
}

/** The backslashes before a quote at `i` (a quote escaped inside JSON-escaped text, at any depth), or 0. */
function escapedQuoteRun(text: string, i: number): number {
  let j = i;
  while (text[j] === "\\") j++;
  return text[j] === '"' ? j - i : 0;
}

/** The end of a value quoted inside JSON-escaped text at `i` (`\"…\"`, its opening quote `run` backslashes and `"`):
 *  after the same escaped quote; else where the string around it ends (a quote under fewer backslashes) or at a line
 *  break; else at the end. */
function escapedValueEnd(text: string, i: number, run: number): number {
  let j = i + run + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (c === "\r" || c === "\n") return j;
    if (c === "\\") {
      let k = j;
      while (k < text.length && text[k] === "\\") k++;
      if (text[k] === '"') {
        if (k - j === run) return k + 1;
        if (k - j < run) return j;
      }
      j = k;
      continue;
    }
    if (c === '"') return j;
    j++;
  }
  return text.length;
}

/** The most words a phrase is followed for after its key (a SLIP-39 share has 33, a BIP-39 phrase at most 24). */
const PHRASE_MAX_WORDS = 36;
/** A phrase word: letters only, at most 9 of them; Latin letters at least 3 (every BIP-39 list's words). */
const PHRASE_WORD = /[\p{L}\p{M}]{1,9}(?![\p{L}\p{M}\p{N}_])/uy;
/** A list number before a word: `1.`, `2)`, `3:`, `4-`, `#5`, `(6)`, `[7]`, or the number alone. */
const LIST_NUMBER = /(?:#|\(|\[)?\d{1,3}(?!\d)(?:[.):\]-])?/uy;
/** The next key after a phrase: a word followed by `=` or `:` (or by its closing quote and then `:`). */
const NEXT_KEY = /(?:\\*["'])?[ \t]*[=:：]/uy;

/** Whether `word` can be a phrase word: Latin letters only when 3 or more. */
function phraseWord(word: string): boolean {
  return /[^A-Za-z]/u.test(word) || word.length >= 3;
}

/**
 * Separators between a phrase's words from `i`: white space, `,`, `;`, `|`, `-`, `<br>`, line breaks and tabs written
 * as JSON escapes (at any escape depth), and — for a phrase whose words are quoted one by one (`quoted`) — quotes and
 * escaped quotes. Returns where the next word starts and how many line breaks were crossed (a blank line is two).
 */
function phraseSeparators(text: string, i: number, quoted: boolean): { at: number; lines: number } {
  let lines = 0;
  for (;;) {
    const c = text[i];
    if (c === undefined) return { at: i, lines };
    if (c === "\n") lines++;
    else if (c === "\r") {
      if (text[i + 1] !== "\n") lines++;
    } else if (c === "," || c === ";" || c === "|" || c === "-" || /\s/u.test(c) || (quoted && (c === "'" || c === '"'))) {
      // a separator
    } else if (c === "<" && /^<br\s*\/?>/iu.test(text.slice(i, i + 6))) {
      i = text.indexOf(">", i);
    } else if (c === "\\") {
      let k = i;
      while (k < text.length && text[k] === "\\") k++;
      const e = text[k];
      if (e === "n") lines++;
      else if (e !== "r" && e !== "t" && !(quoted && e === '"')) return { at: i, lines };
      i = k;
    } else return { at: i, lines };
    i++;
  }
}

/** One phrase token at `i` — a word, a list number, or a list number then a word: its end and whether it holds a
 *  word; `null` when there is none. */
function phraseToken(text: string, i: number): { end: number; word: boolean } | null {
  LIST_NUMBER.lastIndex = i;
  const n = LIST_NUMBER.exec(text);
  let at = i;
  let word = true;
  if (n !== null && n[0].length > 0) {
    at = i + n[0].length;
    PHRASE_WORD.lastIndex = at;
    const w = PHRASE_WORD.exec(text);
    if (w === null || !phraseWord(w[0])) {
      if (/[\p{L}\p{N}_]/u.test(text[at] ?? "")) return null;
      word = false;
    } else at += w[0].length;
  } else {
    PHRASE_WORD.lastIndex = at;
    const w = PHRASE_WORD.exec(text);
    if (w === null || !phraseWord(w[0])) return null;
    at += w[0].length;
  }
  NEXT_KEY.lastIndex = at;
  return NEXT_KEY.test(text) ? null : { end: at, word };
}

/** Whether `i` is where a string (a quote, after any run of backslashes) or a structure (`}` or `]`) ends. */
function stringOrStructureEnd(text: string, i: number): boolean {
  let j = i;
  while (text[j] === "\\") j++;
  const c = text[j];
  return c === '"' || c === "'" || (j === i && (c === "}" || c === "]"));
}

/** Whether the line from `i` holds only phrase tokens (a line a phrase goes on to), to its end: a line break, the end
 *  of the text, or the end of the string or structure around it (a quote, an escaped quote, `}` or `]`). */
function phraseLine(text: string, i: number, quoted: boolean): boolean {
  for (let tokens = 0; ; tokens++) {
    const token = phraseToken(text, i);
    if (token === null) return tokens > 0 && stringOrStructureEnd(text, i);
    const sep = phraseSeparators(text, token.end, quoted);
    if (sep.at >= text.length || sep.lines > 0) return true;
    i = sep.at;
  }
}

/**
 * The end of a phrase whose first value ends at `i`: the words and list numbers after it, across the separators of
 * {@link phraseSeparators}, onto a next line only when that line holds only phrase tokens, never across a blank line,
 * for at most {@link PHRASE_MAX_WORDS} words. It ends before anything else: a word joined to a digit or `_`, a word
 * followed by `=` or `:` (the next key), a Latin word of fewer than 3 letters, other punctuation.
 */
function phraseEnd(text: string, i: number, quoted: boolean): number {
  let end = i;
  for (let words = 1; words < PHRASE_MAX_WORDS; ) {
    const sep = phraseSeparators(text, end, quoted);
    if (sep.lines > 1 || sep.at >= text.length) break;
    if (sep.lines === 1 && !phraseLine(text, sep.at, quoted)) break;
    const token = phraseToken(text, sep.at);
    if (token === null) break;
    end = token.end;
    if (token.word) words++;
  }
  return end;
}

function redactAssignments(text: string): string {
  let out = "";
  let last = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m !== null; m = ASSIGNMENT.exec(text)) {
    const kind = keyKind(m[1]!);
    if (kind === undefined) continue;
    const start = m.index + m[0].length;
    let end: number;
    let single = false; // one word: a phrase goes on after it
    let quoted = false; // the word quoted: so are the phrase's next words
    const c = text[start];
    if (text.startsWith(REDACTED, start) || text.startsWith(`"${REDACTED}`, start)) end = start;
    else if (c === '"' || c === "'") {
      end = quotedValueEnd(text, start, c);
      single = quoted = !/\s/u.test(text.slice(start + 1, end - 1));
    } else if (kind === "phrase" && c === "[" && /^\[\d{1,3}\]/u.test(text.slice(start, start + 5))) end = phraseEnd(text, start + text.slice(start, start + 5).indexOf("]") + 1, false);
    else if (c === "[" || c === "{") end = skipJsonValue(text, start, 0);
    else if (c === "\\" && escapedQuoteRun(text, start) > 0) {
      const run = escapedQuoteRun(text, start);
      end = escapedValueEnd(text, start, run);
      single = quoted = !/\s/u.test(text.slice(start + run + 1, Math.max(start + run + 1, end - run - 1)));
    } else {
      end = bareValueEnd(text, start);
      single = end > start;
    }
    if (kind === "phrase" && single && end > start) end = phraseEnd(text, end, quoted);
    if (end === start) continue;
    out += `${text.slice(last, start)}${REDACTED}`;
    last = end;
    ASSIGNMENT.lastIndex = end;
  }
  return out + text.slice(last);
}

const RULES: ReadonlyArray<[RegExp, string | ((...m: string[]) => string)]> = [
  // URLs of any scheme: userinfo, query and fragment removed. A URL ends at a backslash too (in JSON-escaped text the
  // next character is an escape, not part of the URL). It starts only where a run of scheme characters starts.
  [/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`\\]+/giu, (m) => publicUrl(m)],
  // JWT-shaped tokens.
  [/(?<![\w-])eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/gu, `${REDACTED} token`],
  // Bech32m secret keys (a viewing key is `mn_shield-esk…`).
  [/(?<![\w-])mn_[a-z0-9-]{0,40}(?:esk|sk|seed)(?:_[a-z0-9-]{1,40})?1[02-9ac-hj-np-z]{6,}/giu, `${REDACTED} key`],
  // Bearer and Basic credentials.
  [/\b(Bearer)(\s+)[\w.~+/=-]{8,}/giu, (_m, scheme, sp) => `${scheme}${sp}${REDACTED}`],
  [/\b(Basic)(\s+)(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/gu, (_m, scheme, sp) => `${scheme}${sp}${REDACTED}`],
  // Authorization and cookie headers: the rest of the line.
  [new RegExp(String.raw`(^|[^\w-])(${SECRET_HEADER})(\s*[=:]\s*)(?!\s|\[redacted\])[^\r\n]+`, "gimu"), (_m, pre, k, sep) => `${pre}${k}${sep}${REDACTED}`],
];

/** The longest text the snapshot keeps (its schema's bound): {@link TEXT_MAX_CHARS} and the mark of a cut. */
const TEXT_LIMIT = TEXT_MAX_CHARS + 64;
/** The mark {@link capText} and {@link redactText} end a cut text with: how many characters of the text were cut. */
const CUT_MARK = /… \[([1-9]\d{0,14}) more characters\]$/u;
/** The largest count a mark states (15 digits, as {@link CUT_MARK} reads it): a larger one is stated as this. */
const MAX_CUT_COUNT = 999_999_999_999_999;
/**
 * The mark ending `text` when `text` is a cut text — at most {@link TEXT_MAX_CHARS} characters, then {@link CUT_MARK},
 * within the snapshot's bound — with where it starts and the count it states; otherwise `undefined`. A text with more
 * than {@link TEXT_MAX_CHARS} characters before a mark is not a cut text, whatever it ends with.
 */
function cutMarkOf(text: string): { at: number; mark: string; more: number } | undefined {
  if (text.length > TEXT_LIMIT) return undefined;
  const m = CUT_MARK.exec(text);
  if (m === null || m.index > TEXT_MAX_CHARS) return undefined;
  return { at: m.index, mark: m[0], more: Number(m[1]) };
}

/**
 * The redaction of {@link redactText} without its length cap: every expression and scan is linear in the text's
 * length (tests measure it on long texts).
 */
export function redactWhole(value: string): string {
  let out = value;
  for (const [re, by] of RULES) out = out.replace(re, by as (substring: string, ...args: string[]) => string);
  // JSON members, then key=value and key: value.
  return redactAssignments(redactMembers(out));
}

/**
 * `text` with the secrets this module knows removed (see the module documentation); idempotent. A text longer than
 * {@link TEXT_MAX_CHARS} characters, unless it is already a cut text ({@link cutMarkOf}), is cut first: to that many
 * characters, fewer when redaction would make what is kept longer than that (`[redacted]` is longer than some values),
 * and what is kept is redacted on its own (so a value cut in two is removed whole). The mark saying how many characters
 * of the text were cut is added after the redaction, which never reads it: a cut text keeps its mark, and only what
 * comes before it is redacted (cut again, its count grown, if redaction makes it longer). What it gives always fits the
 * snapshot, and holds at most {@link TEXT_MAX_CHARS} characters before a mark.
 */
export function redactText(value: string): string {
  const cut = cutMarkOf(value);
  if (cut !== undefined) {
    const kept = redactWhole(value.slice(0, cut.at));
    return kept.length <= TEXT_MAX_CHARS ? `${kept}${cut.mark}` : cutAndRedact(value.slice(0, cut.at), cut.more);
  }
  if (value.length > TEXT_MAX_CHARS) return cutAndRedact(value);
  const out = redactWhole(value);
  return out.length > TEXT_MAX_CHARS ? cutAndRedact(value) : out;
}

/**
 * The longest start of `text` whose redaction holds at most {@link TEXT_MAX_CHARS} characters (at most that many
 * characters of `text`; shorter when redaction lengthens it), redacted, then the mark with how many characters of the
 * text it leaves out (plus `earlier`, those a mark already on it counted; at most {@link MAX_CUT_COUNT}, so that the
 * next pass reads the mark as one). Each redaction reads at most {@link TEXT_MAX_CHARS} characters, a bounded number
 * of times.
 */
function cutAndRedact(text: string, earlier = 0): string {
  let keep = Math.min(text.length, TEXT_MAX_CHARS);
  let out = redactWhole(text.slice(0, keep));
  for (let tries = 0; out.length > TEXT_MAX_CHARS; tries++) {
    keep = tries < 32 ? Math.min(keep - 1, Math.floor((keep * TEXT_MAX_CHARS) / out.length)) : 0;
    out = redactWhole(text.slice(0, keep));
  }
  return `${out}… [${Math.min(text.length - keep + earlier, MAX_CUT_COUNT)} more characters]`;
}

/** `text` cut to {@link TEXT_MAX_CHARS}, saying how many characters were cut; a cut text stays as it is. */
export function capText(value: string): string {
  if (value.length <= TEXT_MAX_CHARS || cutMarkOf(value) !== undefined) return value;
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
