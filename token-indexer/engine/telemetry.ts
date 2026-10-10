/**
 * The engine's telemetry: counters, rolling rates and a log ring buffer built from the engine's events, from the
 * requests of an instrumented `fetch`, and from the hooks a host calls (watchdog restarts, PGlite reopens, failed
 * statements, a fatal error). Everything is in memory and costs O(1) per event; nothing here touches the database.
 * The system snapshot (`system-collector.ts`) reads it.
 *
 * - **Endpoints:** {@link EngineTelemetry.instrumentFetch} wraps the `fetch` the engine gets. A request to the node URL
 *   or the indexer URL (same origin and path) counts for that endpoint: started, in flight, answered 2xx / 429 / 403 /
 *   5xx / other, no answer (transport error), aborted. Retries come from the sync's `backoff` events (an operation
 *   `indexer.*` is the indexer's, any other the node's).
 * - **Rates:** blocks per second over the last minute ({@link RATE_WINDOW_MS}), for the sync and the scan: each
 *   batch's blocks are spread evenly over the time since the loop's previous batch ended (or since the telemetry
 *   started), and the blocks inside the window are divided by the window (or by the time since the telemetry started,
 *   when that is shorter).
 * - **API:** requests answered and refused (`BUSY`), answers by status class, and nearest-rank p50/p95 latency over
 *   the latest {@link LATENCY_SAMPLES} admitted requests. Request targets are never seen (the engine's events carry
 *   the method, status and latency only).
 * - **Logs:** the latest {@link LOG_CAPACITY} lines: every sync and scan event except a batch of zero blocks, the API
 *   handler's error lines, the host's own lines and the hooks' notes. A line is redacted as it is written (an event's
 *   fields before they become JSON) and capped at {@link TEXT_MAX_CHARS}; otherwise it keeps its characters (control,
 *   bidirectional and markup characters included), the snapshot redacts it again, and a page renders it as text.
 * - **Health:** {@link deriveHealth} is the rule behind the overview's health line.
 */
import type { EngineClock, EngineEvent, EngineStatus, LoopPhase } from "./engine.ts";
import { capText, type HealthState, HEALTH_LABELS, LOG_CAPACITY, type LogEntry, redactDeep, redactText, TEXT_MAX_CHARS } from "./system-snapshot.ts";

export { LOG_CAPACITY, TEXT_MAX_CHARS };

/** Width of the rolling rate window. */
export const RATE_WINDOW_MS = 60_000;
/** Admitted requests the latency percentiles are taken over. */
export const LATENCY_SAMPLES = 1_000;
/** How far back the tip's rise is measured for the chain's seconds per block. */
export const TIP_WINDOW_MS = 10 * 60_000;
/** Blocks behind the finalized tip within which the engine counts as following. */
export const DEFAULT_FOLLOW_LAG_BLOCKS = 10;

export type EndpointName = "node" | "indexer";
export type LogLevel = LogEntry["level"];

export interface EndpointCounters {
  requests: number;
  inFlight: number;
  ok: number;
  http429: number;
  http403: number;
  http5xx: number;
  httpOther: number;
  transportErrors: number;
  aborted: number;
  retries: number;
  throttledRetries: number;
  lastRequestAt: number | null;
  lastOkAt: number | null;
  lastFailureAt: number | null;
}

/** What the telemetry knows at one instant (plain data). */
export interface TelemetryCounters {
  at: number;
  startedAt: number;
  sync: {
    /** The sync's `start` event: when, and the effective request spacing. */
    startedAt: number | null;
    minIntervalMs: { node: number; indexer: number } | null;
    lastSuccessAt: number | null;
    ingestedSinceStart: number;
    blocksPerSecond: number;
    /** The finalized tip as the latest batch read it (`min(node finalized height, indexer tip)`), and when. */
    tip: { height: number; at: number } | null;
    /** Seconds per finalized block, from the tip's rise over {@link TIP_WINDOW_MS}; `null` until it rose. */
    secondsPerBlock: number | null;
    lastErrorAt: number | null;
    /** The latest retried network call (its wait ends at `at + delayMs`). */
    lastRetry: { at: number; operation: string; delayMs: number; message: string } | null;
    /** A network call of the batch in flight is being retried (a retry newer than the last batch or batch error). */
    retryingNow: boolean;
    /** The latest failed batch saw a network failure (a retry in that batch, or a failed latest request). */
    failedOnNetwork: boolean;
    /** The latest request to either endpoint got no 2xx answer. */
    lastRequestFailed: boolean;
    endpoints: Record<EndpointName, EndpointCounters>;
  };
  scan: {
    lastSuccessAt: number | null;
    scannedSinceStart: number;
    blocksPerSecond: number;
    totals: { transactions: number; events: number; mints: number; sightings: number; actions: number };
    lastErrorAt: number | null;
  };
  api: {
    served: number;
    busy: number;
    byStatus: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
    latencyMs: { p50: number | null; p95: number | null; samples: number; window: number };
  };
  engine: {
    watchdogRestarts: number;
    lastWatchdogRestart: { at: number; reason: string } | null;
    pgliteReopens: number;
    lastReopenAt: number | null;
    failedStatementsSinceOpen: number;
    failedStatementsTotal: number;
    /** A failure the host reported that ends the engine (for example a database that does not open). */
    fatal: string | null;
  };
}

/** Counts a host carries from the previous worker of the same tab (after a watchdog restart). */
export interface CarriedCounts {
  watchdogRestarts?: number;
  lastWatchdogRestart?: { at: number; reason: string } | null;
  pgliteReopens?: number;
}

export interface EngineTelemetryOptions {
  /** The engine's clock (default the system clock). */
  clock?: Pick<EngineClock, "now">;
  /** The sync's endpoints: requests to them are counted per endpoint. */
  endpoints?: { node: string; indexer: string };
  /** Counts carried over from a previous worker. */
  carried?: CarriedCounts;
}

export interface EngineTelemetry {
  /** One engine event (subscribe this, or use {@link attach}). */
  observe(event: EngineEvent): void;
  /** Observes every event of `engine`; returns the function that stops observing. */
  attach(engine: { subscribe(listener: (event: EngineEvent) => void): () => void }): () => void;
  /** `inner` (default the global `fetch`) counting each request to the node and the indexer; a plain function. */
  instrumentFetch(inner?: typeof fetch): typeof fetch;
  /** The sync's endpoints from now on (a host whose next engine reads other URLs); each endpoint's counters go on. */
  setEndpoints(endpoints: { node: string; indexer: string }): void;
  /** Counts carried over from a previous worker, for a host that learns them after it started (they replace these). */
  carry(carried: CarriedCounts): void;
  /** A line from the host. */
  log(level: LogLevel, source: string, text: string): void;
  /** The query watchdog restarted the worker (a host calls this in the new worker, or carries the count). */
  noteWatchdogRestart(reason: string): void;
  /** PGlite was reopened: the failed-statement count since the last open starts again from zero. */
  notePgliteReopen(): void;
  /** A statement failed on the database. */
  noteFailedStatement(): void;
  /** A failure that ends the engine (`null` clears it). */
  noteFatal(message: string | null): void;
  counters(): TelemetryCounters;
  /** The log lines, the latest first. */
  logs(): LogEntry[];
}

// ── Pieces ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Blocks over time: spans of blocks, each spread evenly over its own interval. */
export class RollingRate {
  private spans: Array<{ from: number; to: number; blocks: number }> = [];

  constructor(private readonly windowMs: number) {}

  add(from: number, to: number, blocks: number): void {
    if (blocks > 0) this.spans.push({ from: Math.min(from, to), to, blocks });
  }

  /** Blocks per second over `[now − window, now]`; the window starts no earlier than `since`. */
  perSecond(now: number, since: number): number {
    const lo = Math.max(now - this.windowMs, since);
    this.spans = this.spans.filter((s) => s.to > now - this.windowMs);
    let sum = 0;
    for (const s of this.spans) {
      const len = s.to - s.from;
      if (len <= 0) {
        if (s.to > lo && s.to <= now) sum += s.blocks;
        continue;
      }
      const overlap = Math.max(0, Math.min(s.to, now) - Math.max(s.from, lo));
      sum += (s.blocks * overlap) / len;
    }
    const span = now - lo;
    return span > 0 ? sum / (span / 1000) : 0;
  }
}

/** The latest `size` values, oldest overwritten first. */
export class Ring<T> {
  private items: T[] = [];
  private next = 0;

  constructor(readonly size: number) {}

  push(item: T): void {
    if (this.items.length < this.size) this.items.push(item);
    else this.items[this.next] = item;
    this.next = (this.next + 1) % this.size;
  }

  /** Oldest first. */
  values(): T[] {
    return this.items.length < this.size ? [...this.items] : [...this.items.slice(this.next), ...this.items.slice(0, this.next)];
  }

  get length(): number {
    return this.items.length;
  }
}

/** Nearest-rank percentile `q` (0 < q ≤ 1) of `values`; `null` when there are none. */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

const newEndpoint = (): EndpointCounters => ({
  requests: 0, inFlight: 0, ok: 0, http429: 0, http403: 0, http5xx: 0, httpOther: 0, transportErrors: 0, aborted: 0,
  retries: 0, throttledRetries: 0, lastRequestAt: null, lastOkAt: null, lastFailureAt: null,
});

/** Origin and path of a URL (what identifies an endpoint), or `undefined` when it does not parse. */
function endpointKey(value: string): string | undefined {
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const isAbort = (e: unknown, init: RequestInit | undefined): boolean =>
  init?.signal?.aborted === true || (e instanceof Error && e.name === "AbortError");

/**
 * One line per event; a batch of zero blocks is not logged (a loop at its tip would fill the buffer). The event's
 * fields are redacted before they are written as JSON: inside JSON a line break or a quote is an escape, so a secret
 * on a line of its own in an error message (an `Authorization` header) or in a JSON member could no longer be
 * recognized in the written line.
 */
function logLine(e: EngineEvent): { level: LogLevel; text: string } | undefined {
  const json = (v: unknown): string => JSON.stringify(redactDeep(v));
  switch (`${e.source}:${e.event}`) {
    case "sync:start":
    case "sync:range-complete":
    case "sync:stop":
      return { level: "info", text: `${e.event} ${json(e.fields)}` };
    case "sync:batch":
      return (e.fields as { ingested: number }).ingested > 0 ? { level: "info", text: `batch ${json(e.fields)}` } : undefined;
    case "sync:backoff":
      return { level: "warn", text: `backoff ${json(e.fields)}` };
    case "sync:range-refused":
    case "sync:error":
    case "scan:error":
      return { level: "error", text: `${e.event} ${json(e.fields)}` };
    case "scan:batch":
      return (e.fields as { scannedBlocks: number }).scannedBlocks > 0 ? { level: "info", text: `batch ${json(e.fields)}` } : undefined;
    case "api:log":
      return { level: "error", text: redactText((e.fields as { line: string }).line) };
    default:
      return undefined;
  }
}

// ── Telemetry ────────────────────────────────────────────────────────────────────────────────────────────────────

export function createEngineTelemetry(opts: EngineTelemetryOptions = {}): EngineTelemetry {
  const clock = opts.clock ?? { now: () => Date.now() };
  const startedAt = clock.now();
  let nodeKey = opts.endpoints === undefined ? undefined : endpointKey(opts.endpoints.node);
  let indexerKey = opts.endpoints === undefined ? undefined : endpointKey(opts.endpoints.indexer);

  const endpoints: Record<EndpointName, EndpointCounters> = { node: newEndpoint(), indexer: newEndpoint() };
  let lastRequestFailed = false;

  const logRing = new Ring<LogEntry>(LOG_CAPACITY);
  let seq = 0;
  const addLog = (level: LogLevel, source: string, text: string): void => {
    logRing.push({ seq: seq++, at: clock.now(), level, source, text: capText(redactText(text)) });
  };

  // Sync.
  let syncStartedAt: number | null = null;
  let minIntervalMs: { node: number; indexer: number } | null = null;
  let syncLastEnd: number | null = null; // end of the previous batch or batch error
  let syncLastSuccessAt: number | null = null;
  let syncLastErrorAt: number | null = null;
  let ingestedSinceStart = 0;
  let tip: { height: number; at: number } | null = null;
  const tipFirstSeen: Array<{ height: number; at: number }> = [];
  let lastRetry: TelemetryCounters["sync"]["lastRetry"] = null;
  let failedOnNetwork = false;
  const syncRate = new RollingRate(RATE_WINDOW_MS);

  // Scan.
  let scanLastEnd: number | null = null;
  let scanLastSuccessAt: number | null = null;
  let scanLastErrorAt: number | null = null;
  let scannedSinceStart = 0;
  const totals = { transactions: 0, events: 0, mints: 0, sightings: 0, actions: 0 };
  const scanRate = new RollingRate(RATE_WINDOW_MS);

  // API.
  let served = 0;
  let busy = 0;
  const byStatus = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  const latencies = new Ring<number>(LATENCY_SAMPLES);

  // Engine.
  let watchdogRestarts = opts.carried?.watchdogRestarts ?? 0;
  let lastWatchdogRestart = opts.carried?.lastWatchdogRestart ?? null;
  let pgliteReopens = opts.carried?.pgliteReopens ?? 0;
  let lastReopenAt: number | null = null;
  let failedSinceOpen = 0;
  let failedTotal = 0;
  let fatal: string | null = null;

  const endpointOfOperation = (operation: string): EndpointName => (operation.startsWith("indexer") ? "indexer" : "node");

  function observe(e: EngineEvent): void {
    const line = logLine(e);
    if (line !== undefined) logRing.push({ seq: seq++, at: e.at, level: line.level, source: e.source, text: capText(line.text) });
    switch (e.source) {
      case "sync":
        switch (e.event) {
          case "start":
            syncStartedAt = e.at;
            syncLastEnd = e.at;
            minIntervalMs = { ...e.fields.minIntervalMs };
            break;
          case "backoff": {
            const ep = endpoints[endpointOfOperation(e.fields.operation)];
            ep.retries++;
            if (e.fields.throttled) ep.throttledRetries++;
            lastRetry = { at: e.at, operation: e.fields.operation, delayMs: e.fields.delayMs, message: e.fields.message };
            break;
          }
          case "batch": {
            const f = e.fields;
            syncRate.add(syncLastEnd ?? startedAt, e.at, f.ingested);
            ingestedSinceStart += f.ingested;
            syncLastEnd = e.at;
            syncLastSuccessAt = e.at;
            failedOnNetwork = false;
            if (f.tip !== undefined) {
              tip = { height: f.tip, at: e.at };
              const last = tipFirstSeen[tipFirstSeen.length - 1];
              if (last === undefined || f.tip > last.height) tipFirstSeen.push({ height: f.tip, at: e.at });
              while (tipFirstSeen.length > 2 && tipFirstSeen[1]!.at < e.at - TIP_WINDOW_MS) tipFirstSeen.shift();
            }
            break;
          }
          case "error":
            failedOnNetwork = (lastRetry !== null && lastRetry.at >= (syncLastEnd ?? startedAt)) || lastRequestFailed;
            syncLastEnd = e.at;
            syncLastErrorAt = e.at;
            break;
          case "range-refused":
            syncLastErrorAt = e.at;
            break;
          default:
            break;
        }
        break;
      case "scan":
        if (e.event === "batch") {
          const r = e.fields;
          scanRate.add(scanLastEnd ?? syncStartedAt ?? startedAt, e.at, r.scannedBlocks);
          scannedSinceStart += r.scannedBlocks;
          totals.transactions += r.transactions;
          totals.events += r.events;
          totals.mints += r.mints;
          totals.sightings += r.sightings;
          totals.actions += r.actions;
          scanLastEnd = e.at;
          scanLastSuccessAt = e.at;
        } else {
          scanLastEnd = e.at;
          scanLastErrorAt = e.at;
        }
        break;
      case "api":
        if (e.event === "request") {
          if (e.fields.busy) busy++;
          else {
            served++;
            const cls = `${Math.floor(e.fields.status / 100)}xx`;
            if (cls === "2xx" || cls === "3xx" || cls === "4xx" || cls === "5xx") byStatus[cls]++;
            latencies.push(e.fields.ms);
          }
        }
        break;
    }
  }

  function classify(url: string): EndpointName | undefined {
    const key = endpointKey(url);
    if (key === undefined) return undefined;
    if (key === nodeKey) return "node";
    if (key === indexerKey) return "indexer";
    return undefined;
  }

  return {
    observe,

    attach(engine) {
      return engine.subscribe(observe);
    },

    instrumentFetch(inner?: typeof fetch): typeof fetch {
      return async (input, init) => {
        const name = classify(urlOf(input));
        const ep = name === undefined ? undefined : endpoints[name];
        if (ep !== undefined) {
          ep.requests++;
          ep.inFlight++;
          ep.lastRequestAt = clock.now();
        }
        try {
          const res = await (inner ?? globalThis.fetch)(input, init);
          if (ep !== undefined) {
            const s = res.status;
            if (s >= 200 && s < 300) {
              ep.ok++;
              ep.lastOkAt = clock.now();
              lastRequestFailed = false;
            } else {
              if (s === 429) ep.http429++;
              else if (s === 403) ep.http403++;
              else if (s >= 500) ep.http5xx++;
              else ep.httpOther++;
              ep.lastFailureAt = clock.now();
              lastRequestFailed = true;
            }
          }
          return res;
        } catch (e) {
          if (ep !== undefined) {
            if (isAbort(e, init)) ep.aborted++;
            else {
              ep.transportErrors++;
              ep.lastFailureAt = clock.now();
              lastRequestFailed = true;
            }
          }
          throw e;
        } finally {
          if (ep !== undefined) ep.inFlight--;
        }
      };
    },

    setEndpoints(e) {
      nodeKey = endpointKey(e.node);
      indexerKey = endpointKey(e.indexer);
    },

    carry(carried) {
      if (carried.watchdogRestarts !== undefined) watchdogRestarts = carried.watchdogRestarts;
      if (carried.pgliteReopens !== undefined) pgliteReopens = carried.pgliteReopens;
      if (carried.lastWatchdogRestart !== undefined) {
        lastWatchdogRestart = carried.lastWatchdogRestart === null ? null : { ...carried.lastWatchdogRestart, reason: capText(carried.lastWatchdogRestart.reason) };
        if (lastWatchdogRestart !== null) addLog("warn", "engine", `watchdog restart: ${lastWatchdogRestart.reason}`);
      }
    },

    log(level, source, text) {
      addLog(level, source, text);
    },

    noteWatchdogRestart(reason) {
      watchdogRestarts++;
      lastWatchdogRestart = { at: clock.now(), reason: capText(reason) };
      addLog("warn", "engine", `watchdog restart: ${reason}`);
    },

    notePgliteReopen() {
      pgliteReopens++;
      lastReopenAt = clock.now();
      addLog("warn", "engine", `PGlite reopened after ${failedSinceOpen} failed statements`);
      failedSinceOpen = 0;
    },

    noteFailedStatement() {
      failedSinceOpen++;
      failedTotal++;
    },

    noteFatal(message) {
      fatal = message === null ? null : capText(message);
      if (message !== null) addLog("error", "engine", message);
    },

    counters(): TelemetryCounters {
      const now = clock.now();
      const first = tipFirstSeen[0];
      const last = tipFirstSeen[tipFirstSeen.length - 1];
      const secondsPerBlock = first !== undefined && last !== undefined && last.height > first.height && last.at > first.at
        ? (last.at - first.at) / 1000 / (last.height - first.height)
        : null;
      const admitted = latencies.values();
      return {
        at: now,
        startedAt,
        sync: {
          startedAt: syncStartedAt,
          minIntervalMs,
          lastSuccessAt: syncLastSuccessAt,
          ingestedSinceStart,
          blocksPerSecond: syncRate.perSecond(now, syncStartedAt ?? startedAt),
          tip,
          secondsPerBlock,
          lastErrorAt: syncLastErrorAt,
          lastRetry,
          retryingNow: lastRetry !== null && lastRetry.at >= (syncLastEnd ?? startedAt),
          failedOnNetwork,
          lastRequestFailed,
          endpoints: { node: { ...endpoints.node }, indexer: { ...endpoints.indexer } },
        },
        scan: {
          lastSuccessAt: scanLastSuccessAt,
          scannedSinceStart,
          blocksPerSecond: scanRate.perSecond(now, syncStartedAt ?? startedAt),
          totals: { ...totals },
          lastErrorAt: scanLastErrorAt,
        },
        api: {
          served,
          busy,
          byStatus: { ...byStatus },
          latencyMs: { p50: percentile(admitted, 0.5), p95: percentile(admitted, 0.95), samples: admitted.length, window: LATENCY_SAMPLES },
        },
        engine: {
          watchdogRestarts,
          lastWatchdogRestart,
          pgliteReopens,
          lastReopenAt,
          failedStatementsSinceOpen: failedSinceOpen,
          failedStatementsTotal: failedTotal,
          fatal,
        },
      };
    },

    logs(): LogEntry[] {
      return logRing.values().reverse();
    },
  };
}

// ── Health ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HealthInput {
  /** A failure the host reported that ends the engine. */
  fatal: string | null;
  engine: Pick<EngineStatus, "started" | "stopping"> & {
    sync: { phase: LoopPhase; lastError: string | undefined; endHeight: number | undefined };
    scan: { phase: LoopPhase; lastError: string | undefined; scanner: "following" | "stalled" | "off" };
  };
  network: { retryingNow: boolean; failedOnNetwork: boolean; lastRequestFailed: boolean; lastRetryMessage: string | null };
  quota: { paused: boolean; reason: string | null };
  /** The finalized tip as the sync last read it; the archive's and the scan's heights (`/v1/status`). */
  tip: number | null;
  archiveHeight: number | null;
  scanHeight: number | null;
  /** `/v1/status` `startHeight` (the scan's first height). */
  startHeight: number | null;
  /** Blocks behind the target within which the engine counts as following (default {@link DEFAULT_FOLLOW_LAG_BLOCKS}). */
  followLagBlocks?: number;
}

export interface Health {
  state: HealthState;
  label: string;
  reason: string | null;
}

const health = (state: HealthState, reason: string | null): Health => ({ state, label: HEALTH_LABELS[state], reason });

/**
 * The overview's health line. The first rule that holds decides:
 *
 * 1. `error` — the host reported a fatal failure, or a configured loop ended with an error (phase `failed`: a refused
 *    range, a failed drain, a schema that could not be created).
 * 2. `paused (quota)` — the host paused the sync before the storage quota.
 * 3. `stopped` — the engine was not started, is stopping, or every configured loop has ended; or the sync's range is
 *    complete (phase `done`) and the scan has reached the archive.
 * 4. `stalled (scan)` — the scanner is `stalled` (a scan step failed; it is retried with back-off).
 * 5. `waiting (network)` — the sync waits on the node or the indexer: a network call of the current batch is being
 *    retried; or the sync backs off after a batch that failed on the network (a retry in that batch, or a failed latest
 *    request); or the sync is resolving its first height and the latest request failed.
 * 6. `error` — the sync backs off after a batch that failed for another reason (a database or protocol error).
 * 7. `running` — nothing to compare yet: no loop is configured (the API alone), or the tip or the scan's height is not
 *    known.
 * 8. `catching up` — the scan is more than `followLagBlocks` behind its target: the finalized tip (with a sync), capped
 *    by the sync's end height; the archive's height (without one).
 * 9. `following` — within `followLagBlocks` of the target, with no end height: new finalized blocks are followed.
 * 10. `running` — within `followLagBlocks` of a range's end, still working.
 */
export function deriveHealth(input: HealthInput): Health {
  const { engine } = input;
  const syncOn = engine.sync.phase !== "off";
  const scanOn = engine.scan.phase !== "off";
  const loops = [syncOn ? engine.sync : undefined, scanOn ? engine.scan : undefined].filter((l) => l !== undefined);

  if (input.fatal !== null) return health("error", input.fatal);
  const failed = loops.find((l) => l.phase === "failed");
  if (failed !== undefined) return health("error", failed.lastError ?? "a loop ended with an error");
  if (input.quota.paused) return health("paused-quota", input.quota.reason);
  if (!engine.started) return health("stopped", "the engine has not been started");
  if (engine.stopping) return health("stopped", "the engine is stopping or stopped");
  if (loops.length > 0 && loops.every((l) => l.phase === "stopped" || l.phase === "done")) return health("stopped", "every loop has ended");
  const caughtUp = input.scanHeight !== null && input.archiveHeight !== null && input.scanHeight >= input.archiveHeight;
  if (syncOn && engine.sync.phase === "done" && (!scanOn || caughtUp))
    return health("stopped", input.archiveHeight === null ? "the range is complete" : `the range is complete at ${input.archiveHeight}`);
  if (scanOn && engine.scan.scanner === "stalled") return health("stalled-scan", engine.scan.lastError ?? null);
  if (syncOn) {
    const n = input.network;
    const reason = engine.sync.lastError ?? n.lastRetryMessage;
    if (engine.sync.phase === "running" && n.retryingNow) return health("waiting-network", n.lastRetryMessage ?? reason ?? null);
    if (engine.sync.phase === "backoff" && n.failedOnNetwork) return health("waiting-network", reason ?? null);
    if (engine.sync.phase === "starting" && n.lastRequestFailed) return health("waiting-network", reason ?? "resolving the first height");
    if (engine.sync.phase === "backoff") return health("error", reason ?? "a sync batch failed");
  }
  if (loops.length === 0) return health("running", "the API alone (no sync or scan)");
  const target = syncOn
    ? (input.tip === null ? null : Math.min(input.tip, engine.sync.endHeight ?? Number.MAX_SAFE_INTEGER))
    : input.archiveHeight;
  const scanned = scanOn
    ? (input.scanHeight ?? (input.startHeight === null ? null : input.startHeight - 1))
    : input.archiveHeight;
  if (target === null || scanned === null) return health("running", null);
  const behind = Math.max(0, target - scanned);
  const lagLimit = input.followLagBlocks ?? DEFAULT_FOLLOW_LAG_BLOCKS;
  if (behind > lagLimit) return health("catching-up", `${behind} blocks behind ${target}`);
  if (syncOn && engine.sync.endHeight === undefined) return health("following", null);
  return health("running", `${behind} blocks before the range end`);
}
