/**
 * The system status page's view of a system snapshot (`../engine/system-snapshot.ts`): pure functions from one
 * snapshot to the page's sections, each a list of labelled values and tables of text. The page (`system-page.ts`)
 * draws them; nothing here touches the document, so the same text can be computed outside a browser.
 *
 * Sections, in order: Overview, Configuration, Sync, Scan, Databases, Storage, API, Engine, Browser, Snapshots, Logs.
 * Every value has a stable `field` name (the page sets it as the element's `data-field`). Numbers are written in full
 * (heights as plain digits, counts and bytes with thousands separators, bytes also in binary units); times are UTC with
 * their distance from the snapshot's own time, so the text depends on the snapshot alone; a missing value is "—".
 * Text that came from the engine (error messages, log lines, URLs, names) is drawn by the page with the explorer's
 * hidden-character rules (`visible-text.ts`).
 */
import { HEALTH_LABELS, type HealthState, LOG_CAPACITY, type SystemSnapshot } from "../engine/system-snapshot.ts";

export const SECTION_IDS = ["overview", "configuration", "sync", "scan", "databases", "storage", "api", "engine", "browser", "snapshots", "logs"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export type Tone = "ok" | "warn" | "bad";

/** One labelled value. */
export interface StatusValue {
  field: string;
  label: string;
  text: string;
  tone?: Tone;
}

/** One cell of a table; `field` names the cells a reader compares with a source. */
export interface StatusCell {
  text: string;
  field?: string;
  numeric?: boolean;
}

export interface StatusTable {
  field: string;
  caption: string;
  columns: string[];
  rows: StatusCell[][];
  /** What the table says when it has no row. */
  empty: string;
}

export interface StatusSection {
  id: SectionId;
  title: string;
  values: StatusValue[];
  tables: StatusTable[];
}

/** What a missing value is drawn as. */
export const NONE = "—";

// ── Numbers, sizes, durations, times ─────────────────────────────────────────────────────────────────────────────

/** An integer with thousands separators (`1,234,567`). */
export function grouped(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A block height: plain digits. */
export const heightText = (n: number | null): string => (n === null ? NONE : String(n));

/** A count with thousands separators. */
export const countText = (n: number | null): string => (n === null ? NONE : grouped(n));

const UNITS = ["KiB", "MiB", "GiB", "TiB"];

/** Bytes in full, with the binary unit beside from 1 KiB: `10,551,419 B (10.1 MiB)`. */
export function bytesText(n: number | null): string {
  if (n === null) return NONE;
  if (n < 1024) return `${grouped(n)} B`;
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${grouped(n)} B (${v.toFixed(1)} ${UNITS[u]})`;
}

/** A duration in milliseconds: `250 ms`, `2.5 s`, `4 min 10 s`, `3 h 2 min`, `2 d 4 h`. */
export function durationText(ms: number | null): string {
  if (ms === null) return NONE;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const s = ms / 1_000;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
  const total = Math.round(s);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const sec = total % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return sec === 0 ? `${m} min` : `${m} min ${sec} s`;
}

/** An epoch-milliseconds time in UTC with its distance from `ref` (the snapshot's time): `2026-10-10 08:15:02 UTC (3 s ago)`. */
export function timeText(at: number | null, ref: number): string {
  if (at === null) return NONE;
  const iso = new Date(at).toISOString();
  const when = `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
  const d = at - ref;
  if (Math.abs(d) < 500) return `${when} (now)`;
  return d < 0 ? `${when} (${durationText(-d)} ago)` : `${when} (in ${durationText(d)})`;
}

/** Blocks per second, two decimals. */
export const rateText = (r: number): string => `${r.toFixed(2)} blocks/s`;

const yesNo = (b: boolean | null): string => (b === null ? NONE : b ? "yes" : "no");
const str = (s: string | null | undefined): string => (s === null || s === undefined || s === "" ? NONE : s);
const supported = (b: boolean): string => (b ? "supported" : "not supported");

/** The tone of a health state on the page. */
export function healthTone(state: HealthState): Tone | undefined {
  if (state === "running" || state === "following") return "ok";
  if (state === "stalled-scan" || state === "error") return "bad";
  if (state === "stopped") return undefined;
  return "warn";
}

/** The health line: the label the status page names the state by, and the reason when there is one. */
export function healthLine(s: SystemSnapshot): { label: string; reason: string | null; tone: Tone | undefined } {
  const h = s.overview.health;
  return { label: HEALTH_LABELS[h.state], reason: h.reason, tone: healthTone(h.state) };
}

/** Who shows this snapshot: the leader tab's own engine, or a follower tab showing the leader's. */
export function roleText(s: SystemSnapshot): string {
  if (s.role === "leader") return "leader: this tab runs the engine";
  return `follower: this tab shows the leader tab's engine (received ${timeText(s.relayedAt, s.generatedAt)})`;
}

/** The first indexed height and what it means. */
export function startText(start: number | null): string {
  return start === null ? "nothing indexed yet" : `${start} · history before block ${start} is not indexed`;
}

const v = (field: string, label: string, text: string, tone?: Tone): StatusValue => (tone === undefined ? { field, label, text } : { field, label, text, tone });
const num = (text: string, field?: string): StatusCell => (field === undefined ? { text, numeric: true } : { text, field, numeric: true });
const cell = (text: string, field?: string): StatusCell => (field === undefined ? { text } : { text, field });

function errorText(e: { message: string; at: number | null } | null, ref: number): string {
  if (e === null) return NONE;
  return e.at === null ? e.message : `${e.message} (${timeText(e.at, ref)})`;
}

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────────────────────

function overview(s: SystemSnapshot): StatusSection {
  const o = s.overview;
  const ref = s.generatedAt;
  const health = healthLine(s);
  return {
    id: "overview",
    title: "overview",
    values: [
      v("overview.health", "health", health.label, health.tone),
      v("overview.reason", "why", str(health.reason)),
      v("overview.role", "tab", roleText(s), s.role === "follower" ? "warn" : undefined),
      v("overview.startHeight", "start height", startText(o.startHeight)),
      v("overview.archiveHeight", "archive height", heightText(o.archiveHeight)),
      v("overview.scanHeight", "scan height", heightText(o.scanHeight)),
      v("overview.finalizedTip", "finalized tip", o.finalizedTip === null ? NONE : `${o.finalizedTip} (read ${timeText(o.finalizedTipAt, ref)})`),
      v("overview.lagBlocks", "lag (blocks)", o.lag.blocks === null ? NONE : `${countText(o.lag.blocks)} not scanned yet (archive ${countText(o.lag.archiveBlocks)} behind the tip, scan ${countText(o.lag.scanBehindArchive)} behind the archive)`),
      v("overview.lagTime", "lag (time)", o.lag.seconds === null ? NONE : `${durationText(o.lag.seconds * 1_000)} behind the chain (${o.lag.secondsPerBlock === null ? NONE : `${durationText(o.lag.secondsPerBlock * 1_000)}`} per block)`),
      v("overview.catchUp", "caught up in", o.lag.catchUpSeconds === null ? NONE : o.lag.catchUpSeconds === 0 ? "caught up" : `about ${durationText(o.lag.catchUpSeconds * 1_000)} at the scan's pace`),
    ],
    tables: [],
  };
}

function configuration(s: SystemSnapshot): StatusSection {
  const c = s.configuration;
  const b = c.build;
  const pacing = c.sync?.minIntervalMs ?? null;
  return {
    id: "configuration",
    title: "configuration",
    values: [
      v("configuration.network", "network", c.network),
      v("configuration.genesisHash", "genesis hash", str(c.genesisHash)),
      v("configuration.nodeUrl", "node", str(c.endpoints.node)),
      v("configuration.indexerUrl", "indexer", str(c.endpoints.indexer)),
      v("configuration.schemas", "schemas", `${c.schemas.archive}, ${c.schemas.mip0018}`),
      v("configuration.start", "start", c.start.mode === "tip" ? "at the finalized tip, then following" : "a chosen range"),
      v("configuration.startHeight", "start height", heightText(c.start.startHeight)),
      v("configuration.endHeight", "end height", c.start.endHeight === null ? "none (follows new blocks)" : String(c.start.endHeight)),
      v("configuration.autoStart", "starts by itself", yesNo(c.start.autoStart)),
      v("configuration.pacing", "pacing", pacing === null ? NONE : `node ${durationText(pacing.node)}, indexer ${durationText(pacing.indexer)} between requests`),
      v("configuration.syncBatch", "sync batch", c.sync === null ? NONE : `${countText(c.sync.maxBlocks)} heights, ${countText(c.sync.concurrency)} at a time, timeout ${durationText(c.sync.timeoutMs)}, idle ${durationText(c.sync.idleMs)}`),
      v("configuration.scanBatch", "scan", c.scan === null ? NONE : `${c.scan.mode}, ${countText(c.scan.batch)} blocks per step, idle ${durationText(c.scan.idleMs)}, back-off up to ${durationText(c.scan.maxBackoffMs)}`),
      v("configuration.retry", "retry", c.retry === null ? NONE : `${countText(c.retry.maxAttempts)} attempts, ${durationText(c.retry.baseDelayMs)} doubling to ${durationText(c.retry.maxDelayMs)}${c.retry.jitter ? ", with jitter" : ""}`),
      v("configuration.durability", "durability", str(c.durability)),
      v("configuration.watchdogLimit", "watchdog limit", durationText(c.watchdogLimitMs)),
      v("configuration.apiCap", "API queue cap", countText(c.api.maxConcurrentRequests)),
      v("configuration.appCommit", "app commit", str(b.appCommit)),
      v("configuration.pglite", "PGlite", str(b.pgliteVersion)),
      v("configuration.postgres", "Postgres", str(b.postgresVersion)),
      v("configuration.ledger", "ledger", str(b.ledgerVersion)),
      v("configuration.mip", "MIP", b.mip === null ? NONE : `${b.mip.id} @ ${b.mip.commit}`),
      v("configuration.vendored", "vendored reference", b.vendored === null ? NONE : `${b.vendored.repository} @ ${b.vendored.commit}`),
    ],
    tables: [],
  };
}

const ENDPOINT_COLUMNS = ["endpoint", "requests", "in flight", "2xx", "429", "403", "5xx", "other", "no answer", "aborted", "retries", "throttled retries", "last request", "last success", "last failure"];

function sync(s: SystemSnapshot): StatusSection {
  const y = s.sync;
  const ref = s.generatedAt;
  const endpoint = (name: "node" | "indexer"): StatusCell[] => {
    const e = y.endpoints[name];
    const f = (k: string): string => `sync.endpoints.${name}.${k}`;
    return [
      cell(name),
      num(countText(e.requests), f("requests")),
      num(countText(e.inFlight), f("inFlight")),
      num(countText(e.ok), f("ok")),
      num(countText(e.http429), f("http429")),
      num(countText(e.http403), f("http403")),
      num(countText(e.http5xx), f("http5xx")),
      num(countText(e.httpOther), f("httpOther")),
      num(countText(e.transportErrors), f("transportErrors")),
      num(countText(e.aborted), f("aborted")),
      num(countText(e.retries), f("retries")),
      num(countText(e.throttledRetries), f("throttledRetries")),
      cell(timeText(e.lastRequestAt, ref), f("lastRequestAt")),
      cell(timeText(e.lastOkAt, ref), f("lastOkAt")),
      cell(timeText(e.lastFailureAt, ref), f("lastFailureAt")),
    ];
  };
  return {
    id: "sync",
    title: "sync",
    values: [
      v("sync.phase", "phase", y.phase),
      v("sync.archiveStart", "archive start", heightText(y.archiveStart)),
      v("sync.archiveHeight", "archive height", heightText(y.archiveHeight)),
      v("sync.nodeFinalizedHeight", "node finalized height", heightText(y.nodeFinalizedHeight)),
      v("sync.indexerTipHeight", "indexer tip", heightText(y.indexerTipHeight)),
      v("sync.finalizedTip", "finalized tip (the lower)", heightText(y.finalizedTip)),
      v("sync.blocksPerSecond", "blocks/s (last minute)", rateText(y.blocksPerSecond)),
      v("sync.ingestedSinceStart", "archived since the worker started", countText(y.ingestedSinceStart)),
      v("sync.lastSuccessAt", "last success", timeText(y.lastSuccessAt, ref)),
      v("sync.nextAttemptAt", "next attempt", timeText(y.nextAttemptAt, ref)),
      v("sync.lastError", "last error", errorText(y.lastError, ref), y.lastError === null ? undefined : "bad"),
      v("sync.failures", "failures in a row", countText(y.failures)),
    ],
    tables: [{ field: "sync.endpoints", caption: "requests per endpoint (every attempt; throttled = 429/403)", columns: ENDPOINT_COLUMNS, rows: [endpoint("node"), endpoint("indexer")], empty: NONE }],
  };
}

function scan(s: SystemSnapshot): StatusSection {
  const c = s.scan;
  const ref = s.generatedAt;
  const t = c.totals;
  return {
    id: "scan",
    title: "scan",
    values: [
      v("scan.phase", "phase", c.phase),
      v("scan.scanner", "scanner (/v1/status)", c.scanner, c.scanner === "stalled" ? "bad" : undefined),
      v("scan.startHeight", "scan start", heightText(c.startHeight)),
      v("scan.nextHeight", "next height", heightText(c.nextHeight)),
      v("scan.lagBehindArchive", "behind the archive", countText(c.lagBehindArchive)),
      v("scan.blocksPerSecond", "blocks/s (last minute)", rateText(c.blocksPerSecond)),
      v("scan.scannedSinceStart", "scanned since the worker started", countText(c.scannedSinceStart)),
      v("scan.totals", "stored since the worker started", `${countText(t.transactions)} transactions, ${countText(t.events)} events, ${countText(t.mints)} mints, ${countText(t.sightings)} sightings, ${countText(t.actions)} actions`),
      v("scan.unresolvedEvents", "unresolved events (/v1/status)", countText(c.unresolvedEvents)),
      v("scan.lastSuccessAt", "last success", timeText(c.lastSuccessAt, ref)),
      v("scan.nextAttemptAt", "next attempt", timeText(c.nextAttemptAt, ref)),
      v("scan.lastError", "last error", errorText(c.lastError, ref), c.lastError === null ? undefined : "bad"),
      v("scan.failures", "failures in a row", countText(c.failures)),
    ],
    tables: [],
  };
}

function partitionedText(p: { count: number; estimatedRows: number | null; totalBytes: number } | null): string {
  if (p === null) return "partitioned";
  const rows = p.estimatedRows === null ? "no estimate" : `${countText(Math.round(p.estimatedRows))} estimated rows`;
  return `partitioned: ${countText(p.count)} partitions, ${rows}, ${bytesText(p.totalBytes)}`;
}

function databases(s: SystemSnapshot): StatusSection {
  const d = s.databases;
  const ref = s.generatedAt;
  const statementsMs = d.statements.reduce((a, x) => a + x.ms, 0);
  const longest = d.statements.reduce((a, x) => Math.max(a, x.ms), 0);
  const tables: StatusTable[] = [];
  for (const sc of d.schemas) {
    tables.push({
      field: `databases.${sc.name}.migrations`,
      caption: `${sc.name}: applied migrations`,
      columns: ["migration", "applied"],
      rows: sc.migrations.map((m) => [cell(m.name, `databases.${sc.name}.migration`), cell(timeText(m.appliedAt, ref))]),
      empty: sc.exists ? "no migration recorded" : "the schema has no table",
    });
    tables.push({
      field: `databases.${sc.name}.tables`,
      caption: `${sc.name}: tables (estimated rows from pg_class.reltuples, size from pg_total_relation_size)`,
      columns: ["table", "kind", "estimated rows", "size", "exact rows"],
      rows: sc.tables.map((t) => {
        const f = (k: string): string => `databases.${sc.name}.${t.name}.${k}`;
        const kind = t.kind === "partition" ? `partition of ${str(t.partitionOf)}` : t.kind === "partitioned" ? partitionedText(t.partitions) : "table";
        return [
          cell(t.name, f("name")),
          cell(kind),
          num(t.estimatedRows === null ? "no estimate" : countText(Math.round(t.estimatedRows)), f("estimatedRows")),
          num(bytesText(t.totalBytes), f("totalBytes")),
          num(t.exactRows === null ? "not counted" : countText(t.exactRows), f("exactRows")),
        ];
      }),
      empty: "no table",
    });
  }
  return {
    id: "databases",
    title: "databases",
    values: [
      v("databases.dataDir", "data directory", str(d.dataDir)),
      v("databases.serverVersion", "server_version", str(d.serverVersion)),
      v("databases.fsync", "fsync", str(d.fsync)),
      v("databases.durability", "durability", str(d.durability)),
      v("databases.databaseBytes", "database size (pg_database_size)", bytesText(d.databaseBytes)),
      v("databases.collectedAt", "statistics read", timeText(d.collectedAt, ref)),
      v("databases.statements", "statements of that read", d.statements.length === 0 ? NONE : `${countText(d.statements.length)}, ${durationText(statementsMs)} in all, the longest ${durationText(longest)}`),
      v("databases.exactRowsAt", "rows counted exactly", d.exactRowsAt === null ? "not yet (on demand)" : timeText(d.exactRowsAt, ref)),
      v("databases.error", "last error", str(d.error), d.error === null ? undefined : "bad"),
    ],
    tables,
  };
}

function storage(s: SystemSnapshot): StatusSection {
  const t = s.storage;
  const ref = s.generatedAt;
  const share = t.usageBytes === null || t.quotaBytes === null || t.quotaBytes === 0 ? null : (t.usageBytes / t.quotaBytes) * 100;
  return {
    id: "storage",
    title: "storage",
    values: [
      v("storage.usageBytes", "usage (navigator.storage.estimate)", bytesText(t.usageBytes)),
      v("storage.quotaBytes", "quota", bytesText(t.quotaBytes)),
      v("storage.share", "used", share === null ? NONE : `${share.toFixed(1)} %`),
      v("storage.persisted", "persistent (navigator.storage.persisted)", yesNo(t.persisted)),
      v("storage.estimatedAt", "read", timeText(t.estimatedAt, ref)),
      v("storage.pauseAtBytes", "the sync pauses at", bytesText(t.pauseAtBytes)),
      v("storage.paused", "paused", t.paused ? "yes" : "no", t.paused ? "warn" : undefined),
      v("storage.pausedReason", "why", str(t.pausedReason)),
      v("storage.databaseBytes", "the store's database", bytesText(t.databaseBytes)),
      v("storage.bytesPerBlock", "bytes per block", t.bytesPerBlock.store === null ? NONE : `${grouped(Math.round(t.bytesPerBlock.store))} B (database size ÷ archived blocks)`),
      v("storage.growthPerBlock", "growth per block", t.bytesPerBlock.growth === null ? NONE : `${grouped(Math.round(t.bytesPerBlock.growth))} B (since this worker started)`),
    ],
    tables: [],
  };
}

function api(s: SystemSnapshot): StatusSection {
  const a = s.api;
  return {
    id: "api",
    title: "API",
    values: [
      v("api.queue", "queue (in flight / cap)", `${countText(a.inFlight)} / ${countText(a.maxConcurrentRequests)}`),
      v("api.served", "requests served", countText(a.served)),
      v("api.byStatus", "by status", `2xx ${countText(a.byStatus["2xx"])}, 3xx ${countText(a.byStatus["3xx"])}, 4xx ${countText(a.byStatus["4xx"])}, 5xx ${countText(a.byStatus["5xx"])}`),
      v("api.busy", "503 BUSY", countText(a.busy), a.busy > 0 ? "warn" : undefined),
      v("api.p50", "latency p50", a.latencyMs.p50 === null ? NONE : `${a.latencyMs.p50.toFixed(1)} ms`),
      v("api.p95", "latency p95", a.latencyMs.p95 === null ? NONE : `${a.latencyMs.p95.toFixed(1)} ms`),
      v("api.samples", "over", `the latest ${countText(a.latencyMs.samples)} requests (at most ${countText(a.latencyMs.window)})`),
    ],
    tables: [],
  };
}

function engine(s: SystemSnapshot): StatusSection {
  const e = s.engine;
  const ref = s.generatedAt;
  const last = e.lastWatchdogRestart;
  return {
    id: "engine",
    title: "engine",
    values: [
      v("engine.role", "this tab", s.role === "leader" ? "leader" : "follower", s.role === "follower" ? "warn" : undefined),
      v("engine.connectedTabs", "connected tabs", countText(e.connectedTabs)),
      v("engine.loops", "sync and scan", e.stopping ? "stopping" : e.started ? "started" : "not started"),
      v("engine.startedAt", "worker started", timeText(e.startedAt, ref)),
      v("engine.uptime", "worker uptime", durationText(e.uptimeMs)),
      v("engine.watchdogRestarts", "watchdog restarts", countText(e.watchdogRestarts), e.watchdogRestarts > 0 ? "warn" : undefined),
      v("engine.lastWatchdogRestart", "last restart", last === null ? NONE : `${last.reason} (${timeText(last.at, ref)})`),
      v("engine.pgliteReopens", "PGlite reopens", countText(e.pgliteReopens)),
      v("engine.lastReopenAt", "last reopen", timeText(e.lastReopenAt, ref)),
      v("engine.failedStatements", "failed statements since the last open", countText(e.failedStatementsSinceOpen)),
      v("engine.failedStatementsTotal", "failed statements in all", countText(e.failedStatementsTotal)),
    ],
    tables: [],
  };
}

function browser(s: SystemSnapshot): StatusSection {
  const b = s.browser;
  if (b === null) return { id: "browser", title: "browser", values: [v("browser.browser", "browser", "not reported")], tables: [] };
  const c = b.checks;
  return {
    id: "browser",
    title: "browser",
    values: [
      v("browser.browser", "browser", str(b.browser)),
      v("browser.chromium", "Chromium", c.chromium ? "yes" : "no"),
      v("browser.opfs", "Origin Private File System", supported(c.opfs)),
      v("browser.syncAccessHandle", "OPFS sync access handles", supported(c.syncAccessHandle)),
      v("browser.webLocks", "Web Locks", supported(c.webLocks)),
      v("browser.broadcastChannel", "BroadcastChannel", supported(c.broadcastChannel)),
      v("browser.persistentStorage", "persistent storage", supported(c.persistentStorage)),
    ],
    tables: [],
  };
}

function snapshots(s: SystemSnapshot): StatusSection {
  const ref = s.generatedAt;
  const values: StatusValue[] = [];
  for (const [key, label] of [["lastExport", "last export"], ["lastImport", "last import"]] as const) {
    const r = s.snapshots[key];
    if (r === null) {
      values.push(v(`snapshots.${key}`, label, "none"));
      continue;
    }
    const m = r.manifest;
    const versions = Object.entries(m.schemaVersions).map(([schema, names]) => `${schema} ${names.join(", ")}`).join("; ");
    values.push(
      v(`snapshots.${key}`, label, timeText(r.at, ref)),
      v(`snapshots.${key}.sha256`, "SHA-256", r.sha256),
      v(`snapshots.${key}.bytes`, "size", bytesText(r.bytes)),
      v(`snapshots.${key}.manifest`, "manifest", `${m.network}, height ${m.height}, block ${m.blockHash}, PGlite ${m.pgliteVersion}`),
      v(`snapshots.${key}.schemaVersions`, "schema versions", versions === "" ? NONE : versions),
    );
  }
  return { id: "snapshots", title: "snapshots", values, tables: [] };
}

function logs(s: SystemSnapshot): StatusSection {
  const ref = s.generatedAt;
  return {
    id: "logs",
    title: "logs",
    values: [v("logs.count", "lines", `${countText(s.logs.length)} (the latest ${LOG_CAPACITY} at most, newest first)`)],
    tables: [{
      field: "logs.lines",
      caption: "engine log",
      columns: ["#", "time", "level", "source", "text"],
      rows: s.logs.map((l) => [num(String(l.seq), "logs.seq"), cell(timeText(l.at, ref)), cell(l.level, "logs.level"), cell(l.source, "logs.source"), cell(l.text, "logs.text")]),
      empty: "no log line yet",
    }],
  };
}

/** The page's sections for one snapshot, in the page's order. */
export function statusSections(s: SystemSnapshot): StatusSection[] {
  return [overview(s), configuration(s), sync(s), scan(s), databases(s), storage(s), api(s), engine(s), browser(s), snapshots(s), logs(s)];
}

/** The line above the sections: what is shown and how fresh it is. */
export function collectionText(s: SystemSnapshot): string {
  const c = s.collection;
  const status = c.statusError === null ? "" : ` · the last /v1/status read failed: ${c.statusError}`;
  return `snapshot of ${timeText(s.generatedAt, s.generatedAt).replace(" (now)", "")} · counters every ${durationText(c.countersEveryMs)}, database statistics every ${durationText(c.databaseEveryMs)} while a status page is visible${status}`;
}
