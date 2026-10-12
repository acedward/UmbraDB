/**
 * The engine's telemetry (`token-indexer/engine/telemetry.ts`) and the `system` snapshot's schema and redaction
 * (`token-indexer/engine/system-snapshot.ts`), without a database: every counter from hand-made engine events and an
 * instrumented `fetch`, the rolling rates and percentiles on a manual clock, the log ring buffer, the hooks a host
 * calls, the health rule state by state, the redaction of hostile values, and the schema's strictness.
 */
import { describe, expect, it } from "vitest";
import type { EngineEvent, LoopPhase } from "../engine/engine.ts";
import {
  diagnosticsJson,
  HEALTH_STATES,
  LOG_CAPACITY,
  publicUrl,
  redactSnapshot,
  redactText,
  redactWhole,
  relayedSnapshot,
  type SystemSnapshot,
  SystemSnapshotSchema,
  TEXT_MAX_CHARS,
} from "../engine/system-snapshot.ts";
import { createEngineTelemetry, deriveHealth, type HealthInput, percentile, RollingRate } from "../engine/telemetry.ts";

const NODE = "https://rpc.example.test/";
const INDEXER = "https://indexer.example.test/api/v4/graphql";

class Clock {
  constructor(public t = 1_760_000_000_000) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

type Fields<S extends EngineEvent["source"], N extends EngineEvent["event"]> = Extract<EngineEvent, { source: S; event: N }>["fields"];
const ev = <S extends EngineEvent["source"], N extends Extract<EngineEvent, { source: S }>["event"]>(
  at: number, source: S, event: N, fields: Fields<S, N>,
): EngineEvent => ({ at, source, event, fields }) as EngineEvent;

const syncStart = (at: number): EngineEvent => ev(at, "sync", "start", {
  net: "stagenet", schema: "chain_archive", nodeUrl: NODE, indexerUrl: INDEXER, from: 100, to: "follow", maxBlocks: 20,
  concurrency: 4, minIntervalMs: { node: 250, indexer: 250 }, cursor: null,
});
const syncBatch = (at: number, ingested: number, tip: number | undefined, height?: number): EngineEvent => ev(at, "sync", "batch", {
  height, ingested, from: undefined, to: undefined, tip, retries: 0, throttled: 0, elapsedMs: 1,
});
const scanBatch = (at: number, scannedBlocks: number, extra: Partial<Record<"transactions" | "events" | "mints" | "sightings" | "actions", number>> = {}): EngineEvent =>
  ev(at, "scan", "batch", {
    scannedBlocks, fromHeight: undefined, toHeight: undefined, archiveHeight: undefined, reachedEnd: false,
    transactions: 0, events: 0, mints: 0, sightings: 0, actions: 0, ...extra,
  });
const backoff = (at: number, operation: string, httpStatus: number | undefined, delayMs = 1_000): EngineEvent => ev(at, "sync", "backoff", {
  operation, attempt: 1, maxAttempts: 8, delayMs, httpStatus, throttled: httpStatus === 429 || httpStatus === 403, message: `HTTP ${httpStatus}`,
});
const apiRequest = (at: number, status: number, ms: number, busy = false): EngineEvent => ev(at, "api", "request", { method: "GET", status, busy, ms });

/** A fetch answering each URL with the next scripted outcome. */
function scripted(outcomes: Array<number | "reject" | "abort">): typeof fetch {
  return async (_input, init) => {
    const o = outcomes.shift();
    if (o === "reject") throw new TypeError("Failed to fetch");
    if (o === "abort" || init?.signal?.aborted === true) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return new Response("{}", { status: o ?? 200 });
  };
}

describe("engine telemetry", () => {
  it("[[engine.telemetry.endpoint-counters]] an instrumented fetch counts each request to the node and to the indexer (same origin and path): started, in flight, 2xx, 429, 403, 5xx, other statuses, no answer and aborted; other URLs are not counted; answers and rejections pass through unchanged; retries come from the sync's backoff events (indexer.* operations are the indexer's)", async () => {
    const clock = new Clock();
    const t = createEngineTelemetry({ clock, endpoints: { node: NODE, indexer: INDEXER } });
    const f = t.instrumentFetch(scripted([200, 429, 403, 503, 404, "reject", 200, 200, "abort", 500]));

    expect((await f(NODE, { method: "POST" })).status).toBe(200);
    expect((await f(`${NODE}`)).status).toBe(429);
    expect((await f(new URL(NODE))).status).toBe(403);
    expect((await f(new Request(NODE, { method: "POST", body: "{}" }))).status).toBe(503);
    expect((await f(INDEXER)).status).toBe(404);
    await expect(f(INDEXER)).rejects.toThrow("Failed to fetch");
    expect((await f("https://elsewhere.example.test/")).status).toBe(200); // not an endpoint
    expect((await f(`${INDEXER}?q=1`)).status).toBe(200); // same origin and path: the indexer's
    const ac = new AbortController();
    ac.abort();
    await expect(f(NODE, { signal: ac.signal })).rejects.toThrow("aborted");
    // A plain call (no `this`), as the engine's clients make it.
    const plain = f;
    expect((await plain.call(undefined, INDEXER)).status).toBe(500);

    // In flight while a request waits.
    let release!: () => void;
    const slow = t.instrumentFetch(() => new Promise<Response>((r) => { release = () => r(new Response("{}")); }));
    const pending = slow(NODE);
    expect(t.counters().sync.endpoints.node.inFlight).toBe(1);
    release();
    await pending;

    t.observe(backoff(clock.t, "chain_getBlock", 429));
    t.observe(backoff(clock.t, "chain_getFinalizedHead", 503));
    t.observe(backoff(clock.t, "indexer.block", 403));
    t.observe(backoff(clock.t, "indexer.tip", undefined));

    const { node, indexer } = t.counters().sync.endpoints;
    expect(node).toEqual({
      requests: 6, inFlight: 0, ok: 2, http429: 1, http403: 1, http5xx: 1, httpOther: 0, transportErrors: 0, aborted: 1,
      retries: 2, throttledRetries: 1, lastRequestAt: clock.t, lastOkAt: clock.t, lastFailureAt: clock.t,
    });
    expect(indexer).toEqual({
      requests: 4, inFlight: 0, ok: 1, http429: 0, http403: 0, http5xx: 1, httpOther: 1, transportErrors: 1, aborted: 0,
      retries: 2, throttledRetries: 1, lastRequestAt: clock.t, lastOkAt: clock.t, lastFailureAt: clock.t,
    });
    expect(t.counters().sync.lastRequestFailed).toBe(false); // the last answered request (the slow node one) was 2xx
  });

  it("[[engine.telemetry.rates]] blocks per second over the last minute: each batch's blocks spread over the time since the loop's previous batch (or the sync's start), divided by the window or by the time since the start when shorter; totals since the start; the chain's seconds per block from the tip's rise", () => {
    const clock = new Clock();
    const t0 = clock.t;
    const t = createEngineTelemetry({ clock });
    t.observe(syncStart(t0));
    clock.advance(10_000);
    t.observe(syncBatch(clock.t, 100, 1_000, 199)); // 100 blocks over [0 s, 10 s]
    t.observe(scanBatch(clock.t, 50, { transactions: 3, events: 4, mints: 1, sightings: 2, actions: 5 }));
    expect(t.counters().sync.blocksPerSecond).toBeCloseTo(10, 9); // 100 blocks / 10 s since the start
    expect(t.counters().scan.blocksPerSecond).toBeCloseTo(5, 9);

    clock.advance(30_000);
    t.observe(syncBatch(clock.t, 60, 1_005, 259)); // 60 blocks over [10 s, 40 s]
    t.observe(scanBatch(clock.t, 0)); // nothing scanned: no rate, but the next span starts here
    clock.advance(30_000); // now 70 s: window [10 s, 70 s]
    expect(t.counters().sync.blocksPerSecond).toBeCloseTo(60 / 60, 9);
    expect(t.counters().scan.blocksPerSecond).toBeCloseTo(0, 9);
    t.observe(scanBatch(clock.t, 60)); // 60 blocks over [40 s, 70 s]
    clock.advance(20_000); // now 90 s: window [30 s, 90 s]: sync span [10, 40] → 10/30 of 60; scan span [40, 70] → all 60
    expect(t.counters().sync.blocksPerSecond).toBeCloseTo(20 / 60, 9);
    expect(t.counters().scan.blocksPerSecond).toBeCloseTo(60 / 60, 9);
    clock.advance(60_000); // nothing in the last minute
    expect(t.counters().sync.blocksPerSecond).toBe(0);
    expect(t.counters().scan.blocksPerSecond).toBe(0);

    const c = t.counters();
    expect(c.sync.ingestedSinceStart).toBe(160);
    expect(c.scan.scannedSinceStart).toBe(110);
    expect(c.scan.totals).toEqual({ transactions: 3, events: 4, mints: 1, sightings: 2, actions: 5 });
    expect(c.sync.tip).toEqual({ height: 1_005, at: t0 + 40_000 });
    // The tip rose 5 blocks in 30 s: 6 s per block.
    expect(c.sync.secondsPerBlock).toBeCloseTo(6, 9);
    expect(c.sync.minIntervalMs).toEqual({ node: 250, indexer: 250 });
    expect(c.sync.lastSuccessAt).toBe(t0 + 40_000);

    // The rate primitive on its own: a zero-length span counts once, inside the window.
    const r = new RollingRate(60_000);
    r.add(5_000, 5_000, 7);
    expect(r.perSecond(10_000, 0)).toBeCloseTo(7 / 10, 9);
    expect(r.perSecond(70_000, 0)).toBe(0);
  });

  it("[[engine.telemetry.api]] the API counters: answered requests by status class, BUSY refusals apart, and nearest-rank p50/p95 latency over the latest 1,000 admitted requests", () => {
    const clock = new Clock();
    const t = createEngineTelemetry({ clock });
    expect(t.counters().api).toEqual({ served: 0, busy: 0, byStatus: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }, latencyMs: { p50: null, p95: null, samples: 0, window: 1_000 } });
    for (let i = 1; i <= 100; i++) t.observe(apiRequest(clock.t, 200, i));
    t.observe(apiRequest(clock.t, 404, 1));
    t.observe(apiRequest(clock.t, 400, 1));
    t.observe(apiRequest(clock.t, 503, 2));
    t.observe(apiRequest(clock.t, 503, 0, true));
    t.observe(apiRequest(clock.t, 503, 0, true));
    let api = t.counters().api;
    expect(api.served).toBe(103);
    expect(api.busy).toBe(2);
    expect(api.byStatus).toEqual({ "2xx": 100, "3xx": 0, "4xx": 2, "5xx": 1 });
    // 103 samples (1..100, 1, 1, 2): ranks 52 and 98 of the sorted list are 49 and 95.
    expect(api.latencyMs).toEqual({ p50: 49, p95: 95, samples: 103, window: 1_000 });
    // Only the latest 1,000 admitted requests count.
    for (let i = 0; i < 1_000; i++) t.observe(apiRequest(clock.t, 200, 7));
    api = t.counters().api;
    expect(api.latencyMs).toEqual({ p50: 7, p95: 7, samples: 1_000, window: 1_000 });
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("[[engine.telemetry.log-ring]] the log ring keeps the latest 200 lines, newest first with increasing sequence numbers; every sync and scan event is a line except a batch of zero blocks; API requests are not lines, the handler's error lines are; text is kept as given (control, bidirectional and markup characters included) up to the length cap", () => {
    const clock = new Clock();
    const t = createEngineTelemetry({ clock });
    t.observe(syncStart(clock.t));
    t.observe(syncBatch(clock.t, 0, 10));
    t.observe(scanBatch(clock.t, 0));
    t.observe(apiRequest(clock.t, 200, 1));
    t.observe(syncBatch(clock.t, 3, 10, 9));
    t.observe(scanBatch(clock.t, 2));
    t.observe(backoff(clock.t, "chain_getBlock", 429));
    t.observe(ev(clock.t, "sync", "error", { message: "HTTP 503", retryMs: 1_000 }));
    t.observe(ev(clock.t, "scan", "error", { error: "bad block", failures: 1, retryMs: 2_000 }));
    t.observe(ev(clock.t, "api", "log", { line: '{"event":"api-error","status":503}' }));
    t.observe(ev(clock.t, "sync", "range-refused", { message: "gap" }));
    t.observe(ev(clock.t, "sync", "range-complete", { to: 9, height: 9 }));
    t.observe(ev(clock.t, "sync", "stop", {}));
    const hostile = "a\u0000b\u202ec<script>alert(1)</script>\u200b\nline";
    t.log("warn", "host", hostile);
    const lines = t.logs();
    expect(lines.map((l) => [l.source, l.level, l.text.split(" ")[0]])).toEqual([
      ["host", "warn", hostile.split(" ")[0]],
      ["sync", "info", "stop"],
      ["sync", "info", "range-complete"],
      ["sync", "error", "range-refused"],
      ["api", "error", '{"event":"api-error","status":503}'],
      ["scan", "error", "error"],
      ["sync", "error", "error"],
      ["sync", "warn", "backoff"],
      ["scan", "info", "batch"],
      ["sync", "info", "batch"],
      ["sync", "info", "start"],
    ]);
    expect(lines[0]!.text).toBe(hostile);
    expect(lines.map((l) => l.seq)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(lines[9]!.text).toBe(`batch ${JSON.stringify({ height: 9, ingested: 3, from: undefined, to: undefined, tip: 10, retries: 0, throttled: 0, elapsedMs: 1 })}`);

    for (let i = 0; i < 250; i++) t.log("info", "host", `line ${i}`);
    const full = t.logs();
    expect(full).toHaveLength(LOG_CAPACITY);
    expect(full[0]!.text).toBe("line 249");
    expect(full[199]!.text).toBe("line 50");
    expect(full[0]!.seq).toBe(260);

    t.log("info", "host", "x".repeat(TEXT_MAX_CHARS + 10));
    expect(t.logs()[0]!.text).toBe(`${"x".repeat(TEXT_MAX_CHARS)}… [10 more characters]`);
  });

  it("[[engine.telemetry.hooks]] the hooks a host calls: watchdog restarts (and counts carried from the previous worker), PGlite reopens that restart the failed-statement count since the open, failed statements in total, and a fatal failure; each hook leaves a log line", () => {
    const clock = new Clock();
    const carried = { watchdogRestarts: 2, lastWatchdogRestart: { at: clock.t - 5_000, reason: "query over 30 s" }, pgliteReopens: 1 };
    const t = createEngineTelemetry({ clock, carried });
    expect(t.counters().engine).toEqual({
      watchdogRestarts: 2, lastWatchdogRestart: carried.lastWatchdogRestart, pgliteReopens: 1, lastReopenAt: null,
      failedStatementsSinceOpen: 0, failedStatementsTotal: 0, fatal: null,
    });
    t.noteFailedStatement();
    t.noteFailedStatement();
    t.noteFailedStatement();
    clock.advance(1_000);
    t.notePgliteReopen();
    t.noteFailedStatement();
    clock.advance(1_000);
    t.noteWatchdogRestart("a statement ran past 30000 ms");
    t.noteFatal("the database did not open");
    expect(t.counters().engine).toEqual({
      watchdogRestarts: 3, lastWatchdogRestart: { at: clock.t, reason: "a statement ran past 30000 ms" }, pgliteReopens: 2,
      lastReopenAt: clock.t - 1_000, failedStatementsSinceOpen: 1, failedStatementsTotal: 4, fatal: "the database did not open",
    });
    expect(t.logs().map((l) => l.text)).toEqual([
      "the database did not open", "watchdog restart: a statement ran past 30000 ms", "PGlite reopened after 3 failed statements",
    ]);
    t.noteFatal(null);
    expect(t.counters().engine.fatal).toBeNull();
    expect(t.counters().startedAt).toBe(clock.t - 2_000);
  });

  it("[[engine.telemetry.network-signals]] the network signals the health rule reads: a retry newer than the last batch means a call is being retried; a batch error after a retry, or after a failed request, failed on the network; a batch error with neither did not", async () => {
    const clock = new Clock();
    const t = createEngineTelemetry({ clock, endpoints: { node: NODE, indexer: INDEXER } });
    t.observe(syncStart(clock.t));
    clock.advance(10);
    t.observe(syncBatch(clock.t, 1, 5, 1));
    expect(t.counters().sync).toMatchObject({ retryingNow: false, failedOnNetwork: false, lastRequestFailed: false });
    clock.advance(10);
    t.observe(backoff(clock.t, "chain_getBlock", 503, 2_000));
    expect(t.counters().sync).toMatchObject({ retryingNow: true, lastRetry: { at: clock.t, delayMs: 2_000, operation: "chain_getBlock" } });
    clock.advance(10);
    t.observe(ev(clock.t, "sync", "error", { message: "HTTP 503", retryMs: 1_000 }));
    expect(t.counters().sync).toMatchObject({ retryingNow: false, failedOnNetwork: true, lastErrorAt: clock.t });
    clock.advance(10);
    t.observe(ev(clock.t, "sync", "error", { message: "duplicate key", retryMs: 1_000 })); // no retry, no failed request since
    expect(t.counters().sync.failedOnNetwork).toBe(false);
    const f = t.instrumentFetch(scripted(["reject", 200]));
    await expect(f(NODE)).rejects.toThrow();
    expect(t.counters().sync.lastRequestFailed).toBe(true);
    t.observe(ev(clock.t, "sync", "error", { message: "Failed to fetch", retryMs: 1_000 }));
    expect(t.counters().sync.failedOnNetwork).toBe(true);
    await f(NODE);
    expect(t.counters().sync.lastRequestFailed).toBe(false);
    t.observe(syncBatch(clock.t, 0, 5));
    expect(t.counters().sync.failedOnNetwork).toBe(false);
  });
});

describe("health rule", () => {
  const base = (over: Partial<HealthInput> & { sync?: Partial<HealthInput["engine"]["sync"]>; scan?: Partial<HealthInput["engine"]["scan"]>; started?: boolean; stopping?: boolean } = {}): HealthInput => {
    const { sync, scan, started, stopping, ...rest } = over;
    return {
      fatal: null,
      engine: {
        started: started ?? true,
        stopping: stopping ?? false,
        sync: { phase: "idle" as LoopPhase, lastError: undefined, endHeight: undefined, ...sync },
        scan: { phase: "idle" as LoopPhase, lastError: undefined, scanner: "following", ...scan },
      },
      network: { retryingNow: false, failedOnNetwork: false, lastRequestFailed: false, lastRetryMessage: null },
      quota: { paused: false, reason: null },
      tip: 1_000,
      archiveHeight: 1_000,
      scanHeight: 998,
      startHeight: 900,
      ...rest,
    };
  };
  const state = (i: HealthInput): string => deriveHealth(i).state;

  it("[[engine.telemetry.health]] the health line: error (fatal or a failed loop) before paused (quota) before stopped before stalled (scan) before waiting (network) before a non-network sync error, then running / catching up / following from the heights", () => {
    // 1. error
    expect(deriveHealth(base({ fatal: "the database did not open" }))).toEqual({ state: "error", label: "error", reason: "the database did not open" });
    expect(deriveHealth(base({ sync: { phase: "failed", lastError: "range refused" } }))).toEqual({ state: "error", label: "error", reason: "range refused" });
    expect(state(base({ scan: { phase: "failed", lastError: "drain failed", scanner: "stalled" }, quota: { paused: true, reason: "q" } }))).toBe("error");
    // 2. paused (quota), before stopped (a pause may stop the engine)
    expect(deriveHealth(base({ quota: { paused: true, reason: "usage 95% of the quota" }, started: false }))).toEqual({ state: "paused-quota", label: "paused (quota)", reason: "usage 95% of the quota" });
    // 3. stopped
    expect(state(base({ started: false }))).toBe("stopped");
    expect(state(base({ stopping: true, scan: { scanner: "stalled", phase: "backoff" } }))).toBe("stopped");
    expect(state(base({ sync: { phase: "stopped" }, scan: { phase: "done" } }))).toBe("stopped");
    expect(deriveHealth(base({ sync: { phase: "done", endHeight: 1_000 }, scanHeight: 1_000 }))).toEqual({ state: "stopped", label: "stopped", reason: "the range is complete at 1000" });
    expect(state(base({ sync: { phase: "done", endHeight: 1_000 }, scanHeight: 990 }))).toBe("running"); // the scan still works
    // 4. stalled (scan), before waiting (network)
    expect(deriveHealth(base({ scan: { scanner: "stalled", phase: "backoff", lastError: "parent mismatch" }, sync: { phase: "backoff" }, network: { retryingNow: false, failedOnNetwork: true, lastRequestFailed: true, lastRetryMessage: null } })))
      .toEqual({ state: "stalled-scan", label: "stalled (scan)", reason: "parent mismatch" });
    // 5. waiting (network)
    const down = { retryingNow: true, failedOnNetwork: false, lastRequestFailed: true, lastRetryMessage: "chain_getBlock: HTTP 429" };
    expect(deriveHealth(base({ sync: { phase: "running" }, network: down }))).toEqual({ state: "waiting-network", label: "waiting (network)", reason: "chain_getBlock: HTTP 429" });
    expect(state(base({ sync: { phase: "backoff", lastError: "fetch failed" }, network: { ...down, retryingNow: false, failedOnNetwork: true } }))).toBe("waiting-network");
    expect(state(base({ sync: { phase: "starting" }, network: { ...down, retryingNow: false }, tip: null }))).toBe("waiting-network");
    // 6. error: a sync batch that failed for another reason
    expect(deriveHealth(base({ sync: { phase: "backoff", lastError: "duplicate key value" } }))).toEqual({ state: "error", label: "error", reason: "duplicate key value" });
    // 7. running: no loop, or nothing to compare yet
    expect(deriveHealth(base({ sync: { phase: "off" }, scan: { phase: "off", scanner: "off" } }))).toEqual({ state: "running", label: "running", reason: "the API alone (no sync or scan)" });
    expect(state(base({ tip: null }))).toBe("running");
    expect(state(base({ scanHeight: null, startHeight: null }))).toBe("running");
    // 8. catching up: more than followLagBlocks behind the tip (or the range's end, or the archive without a sync)
    expect(deriveHealth(base({ scanHeight: 989 }))).toEqual({ state: "catching-up", label: "catching up", reason: "11 blocks behind 1000" });
    expect(state(base({ scanHeight: null, startHeight: 980 }))).toBe("catching-up"); // nothing scanned yet: 21 behind
    expect(state(base({ scanHeight: 995, followLagBlocks: 2 }))).toBe("catching-up");
    expect(state(base({ sync: { phase: "off" }, archiveHeight: 1_000, scanHeight: 900 }))).toBe("catching-up");
    expect(state(base({ sync: { phase: "running", endHeight: 950 }, scanHeight: 930 }))).toBe("catching-up");
    // 9. following: within followLagBlocks, no end height
    expect(deriveHealth(base())).toEqual({ state: "following", label: "following", reason: null });
    expect(state(base({ scanHeight: 990 }))).toBe("following");
    expect(state(base({ tip: 990, scanHeight: 998 }))).toBe("following"); // a stale tip below the scan counts as 0 behind
    // 10. running: within followLagBlocks of a range's end
    expect(deriveHealth(base({ sync: { phase: "running", endHeight: 1_005 } }))).toEqual({ state: "running", label: "running", reason: "2 blocks before the range end" });

    // Every state is reachable.
    const reached = new Set([
      base({ fatal: "x" }), base({ quota: { paused: true, reason: null } }), base({ started: false }), base({ scan: { scanner: "stalled" } }),
      base({ sync: { phase: "running" }, network: down }), base({ tip: null }), base({ scanHeight: 900 }), base(),
    ].map(state));
    expect([...reached].sort()).toEqual([...HEALTH_STATES].sort());
  });
});

describe("system snapshot schema and redaction", () => {
  const endpoint = {
    requests: 0, inFlight: 0, ok: 0, http429: 0, http403: 0, http5xx: 0, httpOther: 0, transportErrors: 0, aborted: 0,
    retries: 0, throttledRetries: 0, lastRequestAt: null, lastOkAt: null, lastFailureAt: null,
  };
  const minimal = (): SystemSnapshot => ({
    format: "umbradb-system-snapshot", version: 1, generatedAt: 1, role: "leader", relayedAt: null,
    overview: {
      health: { state: "stopped", label: "stopped", reason: null }, startHeight: null, archiveHeight: null, scanHeight: null, finalizedTip: null, finalizedTipAt: null,
      lag: { blocks: null, archiveBlocks: null, scanBehindArchive: null, seconds: null, secondsPerBlock: null, catchUpSeconds: null },
    },
    configuration: {
      network: "stagenet", genesisHash: null, endpoints: { node: null, indexer: null }, schemas: { archive: "chain_archive", mip0018: "mip0018" },
      sync: null, scan: null, retry: null, start: { mode: "tip", startHeight: null, endHeight: null, autoStart: true }, durability: null,
      watchdogLimitMs: null, api: { maxConcurrentRequests: 8 },
      build: { appCommit: null, pgliteVersion: null, postgresVersion: null, ledgerVersion: null, mip: null, vendored: null },
    },
    sync: {
      phase: "off", archiveStart: null, archiveHeight: null, nodeFinalizedHeight: null, indexerTipHeight: null, finalizedTip: null, blocksPerSecond: 0,
      ingestedSinceStart: 0, endpoints: { node: endpoint, indexer: endpoint }, lastSuccessAt: null, nextAttemptAt: null, lastError: null, failures: 0,
    },
    scan: {
      phase: "off", scanner: "off", startHeight: null, nextHeight: null, lagBehindArchive: null, blocksPerSecond: 0, scannedSinceStart: 0,
      totals: { transactions: 0, events: 0, mints: 0, sightings: 0, actions: 0 }, unresolvedEvents: null, lastSuccessAt: null, nextAttemptAt: null, lastError: null, failures: 0,
    },
    databases: { dataDir: null, serverVersion: null, fsync: null, durability: null, databaseBytes: null, schemas: [], collectedAt: null, statements: [], exactRowsAt: null, error: null },
    storage: {
      usageBytes: null, quotaBytes: null, persisted: null, estimatedAt: null, pauseAtBytes: null, paused: false, pausedReason: null, databaseBytes: null,
      bytesPerBlock: { store: null, growth: null },
    },
    api: { inFlight: 0, maxConcurrentRequests: 8, served: 0, byStatus: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }, busy: 0, latencyMs: { p50: null, p95: null, samples: 0, window: 1_000 } },
    engine: {
      started: false, stopping: false, connectedTabs: null, startedAt: 1, uptimeMs: 0, watchdogRestarts: 0, lastWatchdogRestart: null, pgliteReopens: 0,
      lastReopenAt: null, failedStatementsSinceOpen: 0, failedStatementsTotal: 0,
    },
    browser: null,
    snapshots: { lastExport: null, lastImport: null },
    logs: [],
    collection: { watching: false, countersEveryMs: 2_000, databaseEveryMs: 30_000, statusAt: null, statusError: null },
  });

  it("[[engine.telemetry.schema]] the snapshot schema is versioned and strict: a complete snapshot validates; an unknown key at any depth, a missing section, a wrong version or more than 200 log lines is refused; a follower relays the leader's snapshot marked follower; the diagnostics file is the redacted snapshot as JSON", () => {
    const s = minimal();
    expect(SystemSnapshotSchema.parse(s)).toEqual(s);
    expect(SystemSnapshotSchema.safeParse({ ...s, pageUrl: "https://app.example/?q=1" }).success).toBe(false);
    expect(SystemSnapshotSchema.safeParse({ ...s, browser: { browser: "Chrome 153", checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: true }, history: [] } }).success).toBe(false);
    expect(SystemSnapshotSchema.safeParse({ ...s, api: { ...s.api, lastTarget: "/v1/tokens/ab" } }).success).toBe(false);
    const { storage: _storage, ...noStorage } = s;
    expect(SystemSnapshotSchema.safeParse(noStorage).success).toBe(false);
    expect(SystemSnapshotSchema.safeParse({ ...s, version: 2 }).success).toBe(false);
    const line = { seq: 0, at: 1, level: "info" as const, source: "host", text: "x" };
    expect(SystemSnapshotSchema.safeParse({ ...s, logs: Array.from({ length: 200 }, (_, i) => ({ ...line, seq: i })) }).success).toBe(true);
    expect(SystemSnapshotSchema.safeParse({ ...s, logs: Array.from({ length: 201 }, (_, i) => ({ ...line, seq: i })) }).success).toBe(false);

    const relayed = relayedSnapshot(s, 5);
    expect(relayed).toEqual({ ...s, role: "follower", relayedAt: 5 });

    const withSecret = { ...s, logs: [{ ...line, text: "GET https://u:p@host.example/x?token=abc password=hunter2" }] };
    const file = diagnosticsJson(withSecret);
    expect(file).not.toContain("hunter2");
    expect(file).not.toContain("u:p@");
    expect(file).not.toContain("token=abc");
    expect(JSON.parse(file)).toEqual({ ...s, logs: [{ ...line, text: "GET https://host.example/x password=[redacted]" }] });
  });

  it("[[engine.telemetry.redaction]] redaction removes secrets from hostile values — URL userinfo, query and fragment of any scheme, key=value / key: value / JSON members naming a secret, Authorization and Cookie headers, Bearer and Basic credentials, JWTs, Bech32m secret keys — idempotently, and keeps public chain data, data directories and ordinary messages", () => {
    const cases: Array<[string, string]> = [
      ["https://user:pa55@rpc.example.test/path?apikey=SECRET1#frag", "https://rpc.example.test/path"],
      ["wss://rpc.example.test/?token=SECRET2", "wss://rpc.example.test/"],
      ["postgres://admin:SECRET3@db.internal:5432/umbra?sslmode=require&password=SECRET4", "postgres://db.internal:5432/umbra"],
      ["connecting to http://[::1 failed", "connecting to http://[redacted] failed"],
      ["api_key=SECRET5&x=1", "api_key=[redacted]&x=1"],
      ["X-API-Key: SECRET6", "X-API-Key: [redacted]"],
      ["Authorization: Digest username=\"me\", response=\"SECRET7\"", "Authorization: [redacted]"],
      ["cookie: sid=SECRET8; theme=dark", "cookie: [redacted]"],
      ["sent Bearer eyJabc.SECRET9.zzz to the node", "sent Bearer [redacted] to the node"],
      ["Basic dXNlcjpTRUNSRVQxMA==", "Basic [redacted]"],
      ['{"password":"SECRET11","n":1}', '{"password":"[redacted]","n":1}'],
      ['{"accessToken": "SECRET12"}', '{"accessToken": "[redacted]"}'],
      ['{"client_secret": 12345}', '{"client_secret": "[redacted]"}'],
      ["jwt eyJhbGciOi.eyJzdWIiOiIx.SECRET13 end", "jwt [redacted] token end"],
      ["key mn_shield-esk_preview1qqqsyqcyq5rqwzqfsecr3t9 leaked", "key [redacted] key leaked"],
      ["seed=abandon abandon", "seed=[redacted]"],
      ["passphrase: 'SECRET14'", "passphrase: [redacted]"],
    ];
    for (const [input, out] of cases) {
      expect(redactText(input), input).toBe(out);
      expect(redactText(out), `idempotent: ${out}`).toBe(out);
      expect(redactText(input)).not.toMatch(/SECRET|pa55|hunter|sr3t9/);
    }
    const kept = [
      "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c",
      "opfs-ahp://umbradb",
      "memory://",
      "https://rpc.stagenet.shielded.tools/",
      "tokens: 5, mints: 1",
      "no token with this color in the indexed range",
      "scan error: transaction c3c3 is not a ledger transaction",
      "the session is held by a transaction",
      "Basic validation failed",
      "mn_shield-addr_preview1qqqsyqcyq5rqwzqf",
      "a\u0000b\u202ec<script>alert(1)</script>",
    ];
    for (const k of kept) expect(redactText(k), k).toBe(k);
    expect(publicUrl("http://u:p@h.example:8080/a/b?x=1#y")).toBe("http://h.example:8080/a/b");
    expect(publicUrl("not a url")).toBe("url://[redacted]");

    // The whole snapshot: every string, at any depth.
    const s = minimal();
    s.configuration.endpoints.node = "https://u:SECRET15@rpc.example.test/?k=v";
    s.sync.lastError = { message: "HTTP 403 from https://rpc.example.test/?api_key=SECRET16", at: 1 };
    s.logs = [{ seq: 0, at: 1, level: "error", source: "sync", text: 'error {"message":"token=SECRET17"}' }];
    const r = redactSnapshot(s);
    expect(JSON.stringify(r)).not.toMatch(/SECRET1[567]/);
    expect(r.configuration.endpoints.node).toBe("https://rpc.example.test/");
    expect(r.logs[0]!.text).toBe('error {"message":"token=[redacted]"}');

    // A URL ends at a backslash: in JSON-escaped text what follows is an escape, not the URL.
    expect(redactText('error {"message":"see https://u:SECRET18@h.example.test/p?k=v\\n{\\"n\\": 1}"}')).toBe('error {"message":"see https://h.example.test/p\\n{\\"n\\": 1}"}');
    // An event's log line: its fields are redacted before they become JSON, where a line break or a quote is an
    // escape and a header on a line of its own or a JSON member could no longer be recognized.
    const t = createEngineTelemetry({ clock: new Clock() });
    const message = 'RPC error: token=SECRET19\nAuthorization: Basic not-base64-SECRET20\n{"apiKey": "SECRET21"}\ncookie=SECRET22\nsee https://u:SECRET23@h.example.test/p?k=SECRET24';
    t.observe(ev(1, "sync", "error", { message, retryMs: 1_000 }));
    t.log("error", "host", message);
    for (const line of t.logs()) expect(line.text).not.toMatch(/SECRET/);
    const fields = JSON.parse(t.logs().find((l) => l.source === "sync")!.text.slice("error ".length)) as { message: string };
    expect(fields.message).toBe('RPC error: token=[redacted]\nAuthorization: [redacted]\n{"apiKey": "[redacted]"}\ncookie=[redacted]\nsee https://h.example.test/p');
    expect(t.logs().find((l) => l.source === "host")!.text).toBe(fields.message);
  });

  it("[[engine.telemetry.redaction-phrases]] redaction removes a whole secret phrase or structured value: every word of an unquoted seed, mnemonic or passphrase, a JSON member's array or object, also inside JSON-escaped text, in the diagnostics file too", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
    const phrase = words.join(" ");
    const forms = [
      `restoring seed=${phrase}`,
      `mnemonic: ${phrase}`,
      `seed phrase: ${phrase}`,
      `recovery phrase = ${phrase}`,
      `passphrase=${phrase}`,
      `seed: ${words.join(", ")}`,
      `mnemonic:\n${words.join("\n")}`,
      `seed = ${words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ")}`,
      `seed phrase: ${words.map((w, i) => `${i + 1}. ${w}`).join(" ")}`,
      `{"seed":${JSON.stringify(words)}}`,
      `{"mnemonic": {"words": ${JSON.stringify(words)}, "language": "english"}, "n": 1}`,
      `seed=${JSON.stringify(words)}`,
      JSON.stringify({ message: `wallet ${JSON.stringify({ seed: words, password: "hunter2-SECRET" })}` }),
      `error ${JSON.stringify(JSON.stringify({ mnemonic: phrase, accessToken: "SECRET-TOKEN" }))}`,
    ];
    for (const input of forms) {
      const out = redactText(input);
      for (const w of words) expect(out, `${input} → ${out}`).not.toMatch(new RegExp(`\\b${w}\\b`, "i"));
      expect(out, input).not.toMatch(/hunter2|SECRET/);
      expect(out, input).toContain("[redacted]");
      expect(redactText(out), `idempotent: ${out}`).toBe(out);
    }
    // The rest of a JSON text stays readable.
    expect(redactText(`{"seed":${JSON.stringify(words)},"n":1}`)).toBe('{"seed":"[redacted]","n":1}');
    expect(redactText('{"mnemonic": {"words": ["a", "b"]}, "n": 1}')).toBe('{"mnemonic": "[redacted]", "n": 1}');
    expect(redactText('x {\\"seed\\":[\\"abandon\\",\\"ability\\"],\\"n\\":1}')).toBe('x {\\"seed\\":\\"[redacted]\\",\\"n\\":1}');
    expect(redactText("seed=abandon ability. Then 3 blocks")).toBe("seed=[redacted]. Then 3 blocks");

    // The diagnostics file: every log line and message, at any depth.
    const s = minimal();
    s.logs = forms.map((text, seq) => ({ seq, at: 1, level: "error" as const, source: "host" as const, text }));
    s.sync.lastError = { message: `seed=${phrase}`, at: 1 };
    const file = diagnosticsJson(s);
    for (const w of words) expect(file).not.toMatch(new RegExp(`\\b${w}\\b`, "i"));
    expect(file).not.toMatch(/hunter2|SECRET/);
  });

  it("[[engine.telemetry.redaction-phrase-forms]] an unquoted seed, mnemonic or passphrase loses every word whatever its case, line breaks or separators (commas, tabs, several spaces, CR LF, an ideographic space, a numbered list, JSON-escaped line breaks inside a log field), in the diagnostics file too; text after the value of any other key stays", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
    const upper = words.map((w) => w.toUpperCase());
    const mixed = words.map((w, i) => (i % 2 === 0 ? w[0]!.toUpperCase() + w.slice(1) : w.toUpperCase()));
    const forms = [
      `seed=${words[0]}\n${words.slice(1).join(" ")}`,
      `mnemonic: ${words.slice(0, 6).join(" ")}\n${words.slice(6).join(" ")}`,
      `seed phrase:\r\n${words.slice(0, 4).join(" ")}\r\n${words.slice(4, 8).join(" ")}\r\n${words.slice(8).join(" ")}`,
      `seed=${upper.join(" ")}`,
      `passphrase: ${mixed.join(" ")}`,
      `recovery phrase = ${words.join("\t")}`,
      `seed: ${words.join("   ")}`,
      `seed=${words.join(",")}`,
      `SEED PHRASE: ${upper.join(", ")}`,
      `mnemonic:\n  ${words.join("\n  ")}`,
      `seed words: ${mixed.join(" ")}`,
      `mnemonic: ${words.map((w, i) => `${i + 1}. ${w}`).join(" ")}`,
      `mnemonic:\n${upper.map((w, i) => `${i + 1}) ${w}`).join("\n")}`,
      `seed=${words.join("\u3000")}`,
      `error ${JSON.stringify({ message: `seed=${words.slice(0, 6).join(" ")}\n${upper.slice(6).join(" ")}` })}`,
      `error ${JSON.stringify({ message: `mnemonic: ${mixed.join("\r\n")}` })}`,
      `error ${JSON.stringify(JSON.stringify({ message: `seed=${words.join("\n")}` }))}`,
      `error ${JSON.stringify({ message: `restoring with passphrase="${upper.join(" ")}" failed` })}`,
    ];
    const leaked = (text: string): string[] => words.filter((w) => new RegExp(`\\b${w}\\b`, "iu").test(text));
    for (const input of forms) {
      const out = redactText(input);
      expect(leaked(out), `${input} → ${out}`).toEqual([]);
      expect(out, input).toContain("[redacted]");
      expect(redactText(out), `idempotent: ${out}`).toBe(out);
    }

    // Text after the value of a key that names no phrase, or after a phrase that ends, stays.
    for (const [input, out] of [
      ["token=x1 Then Sync Resumed\nAt Block 5", "token=[redacted] Then Sync Resumed\nAt Block 5"],
      ["height: 5\nSeed Phrase Restored From Backup", "height: 5\nSeed Phrase Restored From Backup"],
      [`seed=${words.join(" ")}\nstatus: Synced To Block 5`, "seed=[redacted]\nstatus: Synced To Block 5"],
      [`mnemonic: ${upper.join(" ")} height=5`, "mnemonic: [redacted] height=5"],
      [`seed=${mixed.join(" ")}. Then 3 Blocks`, "seed=[redacted]. Then 3 Blocks"],
    ]) expect(redactText(input!), input).toBe(out);

    // The diagnostics file: the forms as log lines, as an event's error and as a host log line, and as the sync error.
    const t = createEngineTelemetry({ clock: new Clock() });
    forms.forEach((message, i) => {
      t.observe(ev(i, "sync", "error", { message, retryMs: 1_000 }));
      t.log("error", "host", message);
    });
    const s = minimal();
    s.logs = [...forms.map((text, seq) => ({ seq, at: 1, level: "error" as const, source: "host" as const, text })), ...t.logs().slice(-100)]
      .slice(0, 200).map((l, seq) => ({ ...l, seq }));
    s.sync.lastError = { message: forms[0]!, at: 1 };
    const file = diagnosticsJson(s);
    expect(leaked(file)).toEqual([]);
  });

  it("[[engine.telemetry.redaction-nested-json]] a secret member of JSON text written as a JSON string once or more (one to four encodings, also inside a log line and an error message) loses its whole value — every word, string, array or object — in the diagnostics file too; the rest of the JSON at every depth stays as it was, and a long run of backslashes is read in linear time", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
    const phrase = words.join(" ");
    /** `value` as JSON, then written as a JSON string `times` more times. */
    const encoded = (value: unknown, times: number): string => {
      let t = JSON.stringify(value);
      for (let i = 0; i < times; i++) t = JSON.stringify(t);
      return t;
    };
    /** The value back from `times` more encodings than the JSON. */
    const decoded = (text: string, times: number): unknown => {
      let v: unknown = text;
      for (let i = 0; i <= times; i++) v = JSON.parse(v as string);
      return v;
    };
    const leaked = (text: string): string[] => words.filter((w) => new RegExp(`\\b${w}\\b`, "iu").test(text));
    // A seed phrase in three encodings first, then one to four encodings of every kind of value.
    expect(leaked(redactText(encoded({ seed: phrase }, 2)))).toEqual([]);
    for (let times = 1; times <= 4; times++) {
      for (const [value, want] of [
        [{ seed: phrase, note: "seed phrase restored from backup", n: 1 }, { seed: "[redacted]", note: "seed phrase restored from backup", n: 1 }],
        [{ message: "wallet", mnemonic: words, height: 715183 }, { message: "wallet", mnemonic: "[redacted]", height: 715183 }],
        [{ wallet: { "recovery phrase": { words, language: "english" }, label: "main" }, ok: true }, { wallet: { "recovery phrase": "[redacted]", label: "main" }, ok: true }],
        [{ passphrase: 12345, list: ["a\"b", "c\\d", "line\nbreak"] }, { passphrase: "[redacted]", list: ["a\"b", "c\\d", "line\nbreak"] }],
      ] as const) {
        const input = encoded(value, times);
        const out = redactText(input);
        expect(leaked(out), `${times}: ${out}`).toEqual([]);
        expect(out, input).not.toContain("12345");
        expect(decoded(out, times), `${times}: ${out}`).toEqual(want);
        expect(redactText(out), `idempotent: ${out}`).toBe(out);
        // Inside a log line and an error message.
        expect(leaked(redactText(`sync error ${input} retrying`))).toEqual([]);
      }
    }
    // Ordinary escaped text stays as it was, at every depth.
    for (let times = 1; times <= 4; times++) {
      const plain = encoded({ message: "token count 5", path: "C:\\data\\seed", note: "the \"seed\" was restored", n: [1, 2] }, times);
      expect(redactText(plain), plain).toBe(plain);
    }

    // The diagnostics file: the shapes above in log lines and the sync error.
    const s = minimal();
    s.logs = [1, 2, 3, 4].map((times, seq) => ({ seq, at: 1, level: "error" as const, source: "sync" as const, text: `error ${encoded({ seed: phrase, mnemonic: words }, times)}` }));
    s.sync.lastError = { message: encoded({ error: encoded({ seed: phrase }, 1) }, 1), at: 1 };
    expect(leaked(diagnosticsJson(s))).toEqual([]);

    // A long run of backslashes before a quote is read once.
    const run = `${"\\".repeat(200_000)}"seed" x`;
    const t0 = performance.now();
    expect(redactWhole(run)).toBe(run);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it("[[engine.telemetry.redaction-linear]] redaction costs time in proportion to the text: on 1 MB hostile texts (backslash runs, open escaped quotes, scheme, JWT and key look-alikes, quotes, brackets, many keys, a long phrase, nested JSON) the whole redaction stays far from quadratic, and a text the snapshot keeps is cut first (well under 100 ms); a 1 MB error from the node reaches the log and the snapshot cut, and the snapshot validates", () => {
    const MB = 1_000_000;
    const encoded = (value: unknown, times: number): string => {
      let t = JSON.stringify(value);
      for (let i = 0; i < times; i++) t = JSON.stringify(t);
      return t;
    };
    const hostile: Record<string, string> = {
      backslashes: `token=${"\\".repeat(MB)}`,
      "open escaped quote": `token=\\"${"\\".repeat(MB)}`,
      "scheme characters": "a.".repeat(MB / 2),
      "JWT look-alike": "eyJ-".repeat(MB / 4),
      "key look-alike": ` mn_${"sk".repeat(20)}`.repeat(MB / 44),
      quotes: '"'.repeat(MB),
      "escaped quotes": `x ${'\\\\\\"'.repeat(MB / 4)}`,
      brackets: `{"seed":${"[".repeat(MB)}`,
      "many keys": "a: ".repeat(MB / 3),
      "many secret keys": "token: x ".repeat(MB / 9),
      "many members": '{"a":1,'.repeat(MB / 7),
      "a long phrase": `seed: ${"abandon ".repeat(MB / 8)}`,
      "a phrase over lines": `mnemonic:\n${"abandon\n".repeat(MB / 8)}`,
      "nested JSON": encoded({ seed: "abandon ".repeat(MB / 64), n: 1 }, 4),
    };
    for (const [name, text] of Object.entries(hostile)) {
      let t0 = performance.now();
      redactWhole(text);
      const whole = performance.now() - t0;
      t0 = performance.now();
      const capped = redactText(text);
      const cut = performance.now() - t0;
      // Linear costs a few hundred milliseconds at most for 1 MB; a quadratic expression would take minutes.
      expect(whole, `${name}: the whole redaction`).toBeLessThan(3_000);
      expect(cut, `${name}: the redaction of the text the snapshot keeps`).toBeLessThan(100);
      expect(capped.length, name).toBeLessThanOrEqual(TEXT_MAX_CHARS + 64);
      expect(redactText(capped), `${name}: idempotent`).toBe(capped);
    }

    // A node's error of 1 MB: the log line and the snapshot's last error are cut, and the snapshot validates.
    const huge = `RPC error: token=${"\\".repeat(MB)}`;
    const t = createEngineTelemetry({ clock: new Clock() });
    const t0 = performance.now();
    t.observe(ev(1, "sync", "error", { message: huge, retryMs: 1_000 }));
    expect(performance.now() - t0).toBeLessThan(100);
    const line = t.logs().find((l) => l.source === "sync")!;
    expect(line.text.length).toBeLessThanOrEqual(TEXT_MAX_CHARS + 64);
    const s = minimal();
    s.sync.lastError = { message: huge, at: 1 };
    s.logs = [{ seq: 0, at: 1, level: "error", source: "sync", text: huge }];
    const r = redactSnapshot(s);
    // No whitespace or quote in the backslashes: the text is cut before the last one there is, after "RPC error:".
    expect(r.sync.lastError!.message).toMatch(/^RPC error:… \[\d+ more characters\]$/u);
    expect(r.logs[0]!.text.length).toBeLessThanOrEqual(TEXT_MAX_CHARS + 64);
    expect(() => JSON.parse(diagnosticsJson(s))).not.toThrow();
    // Any long text: redacted whole, then cut, saying how many characters of the redacted text were left out; what is
    // cut never reaches the snapshot.
    const long = `ok ${"x".repeat(10_000)} token=tail-of-a-long-text`;
    expect(redactText(long)).toBe(`ok ${"x".repeat(TEXT_MAX_CHARS - 3)}… [${redactWhole(long).length - TEXT_MAX_CHARS} more characters]`);
  });

  it("[[engine.telemetry.redaction-key-forms]] a seed or mnemonic phrase loses every word under any key spelling — prefixed, suffixed, camelCase, kebab or snake case, plural, a JSON member at any depth, a full-width colon — and with any separator or list numbering (;, |, -, <br>, words quoted one by one, 1.word, 1-word, #1, (1), [1]); a password under a prefixed name too; a key named only words is not a secret, and text after other keys stays", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
    const phrase = words.join(" ");
    const leaked = (text: string): string[] => words.filter((w) => new RegExp(`\\b${w}\\b`, "iu").test(text));
    const forms = [
      `WALLET_MNEMONIC=${phrase}`,
      `MY_SEED_PHRASE=${phrase}`,
      `walletSeed=${phrase}`,
      `userMnemonic: ${phrase}`,
      `x-seed: ${phrase}`,
      `mnemonics: ${phrase}`,
      `phrase: ${phrase}`,
      `seed words: ${phrase}`,
      `recovery_words=${phrase}`,
      `secret recovery phrase: ${phrase}`,
      `seed：${phrase}`,
      JSON.stringify({ walletSeed: phrase }),
      JSON.stringify({ WALLET_MNEMONIC: phrase, n: 1 }),
      JSON.stringify({ mnemonics: phrase }),
      JSON.stringify({ seedWords: words }),
      JSON.stringify(JSON.stringify({ "backup-words": words })),
      `seed: ${words.join("; ")}`,
      `seed: ${words.join(" | ")}`,
      `seed: ${words.join(" - ")}`,
      `seed: ${words.join("<br>")}`,
      `seed: ${words.map((w) => `"${w}"`).join(" ")}`,
      `seed: ${words.map((w) => `'${w}'`).join(", ")}`,
      `seed: ${words.map((w, i) => `${i + 1}.${w}`).join(" ")}`,
      `seed: ${words.map((w, i) => `${i + 1}-${w}`).join(" ")}`,
      `seed: ${words.map((w, i) => `#${i + 1} ${w}`).join(" ")}`,
      `seed: ${words.map((w, i) => `(${i + 1}) ${w}`).join(" ")}`,
      `seed: ${words.map((w, i) => `[${i + 1}] ${w}`).join(" ")}`,
      `error ${JSON.stringify({ message: `walletSeed: ${words.map((w) => `"${w}"`).join(", ")}` })}`,
    ];
    for (const input of forms) {
      const out = redactText(input);
      expect(leaked(out), `${input} → ${out}`).toEqual([]);
      expect(out, input).toContain("[redacted]");
      expect(redactText(out), `idempotent: ${out}`).toBe(out);
    }
    // A secret under a prefixed name.
    expect(redactText("DB_PASSWORD=pw x")).toBe("DB_PASSWORD=[redacted] x");
    expect(redactText("clientSecret: s3 then")).toBe("clientSecret: [redacted] then");
    // A key named only words is not taken for a secret (too common a name); text after other keys stays.
    for (const kept of [
      "words: alpha beta gamma",
      JSON.stringify({ words: ["alpha", "beta"], n: 1 }),
      "tokens: 5, mints: 1",
      "mnemonic restored at height: 715183",
      "token count: 12",
      "seedless grapes, then height: 5",
    ]) expect(redactText(kept), kept).toBe(kept);
  });

  it("[[engine.telemetry.redaction-bounds]] a phrase ends where the text stops looking like one — a next line that is not phrase words, a blank line, a word of fewer than three Latin letters, the end of the string around it, 36 words — and a quoted value that is never closed ends at its line or at the end of the string around it, so the error lines a diagnostics file exists for stay", () => {
    for (const [input, out] of [
      ["seed=x1\nthe engine stopped at block 5 after 3 retries", "seed=[redacted]\nthe engine stopped at block 5 after 3 retries"],
      ["seed: 42\nSync Resumed At Block 715402", "seed: [redacted]\nSync Resumed At Block 715402"],
      ["mnemonic: x\n\nERROR the node refused the request", "mnemonic: [redacted]\n\nERROR the node refused the request"],
      ["seed: abandon ability at block 5", "seed: [redacted] at block 5"],
      [JSON.stringify({ message: "seed=abandon ability", note: "other words" }), JSON.stringify({ message: "seed=[redacted]", note: "other words" })],
      [`seed: ${"alpha ".repeat(40).trim()}`, `seed: [redacted] ${"alpha ".repeat(4).trim()}`],
      ['token="abc\nthe next line stays', "token=[redacted]\nthe next line stays"],
    ]) expect(redactText(input!), input).toBe(out);
    // An escaped quote that is never closed: to the end of the string around it; the JSON after it stays.
    const open = JSON.stringify({ message: 'login failed password="abc', code: 7 });
    expect(JSON.parse(redactText(open))).toEqual({ message: "login failed password=[redacted]", code: 7 });
    expect(JSON.parse(redactText(JSON.stringify({ message: 'refused: token=\\"x', next: "kept" })))).toEqual({ message: "refused: token=[redacted]", next: "kept" });
  });

  it("[[engine.telemetry.redaction-cut]] a text longer than 4,096 characters is cut to at most them before redaction, saying how much was cut; a cut text (at most 4,096 characters, then the mark) is not cut again, and a forged mark after more does not stop the cut; and a member's secret is removed at every depth of JSON encoding a cut text can hold", () => {
    // Exactly 4,096 is the limit: a longer text is cut, whatever the margin the snapshot's bound leaves for the mark.
    for (const n of [4_095, 4_096]) expect(redactText("x".repeat(n))).toBe("x".repeat(n));
    for (const n of [4_097, 4_100, 4_159, 4_160, 4_161, 10_000]) {
      const out = redactText("x".repeat(n));
      expect(out, `${n}`).toBe(`${"x".repeat(TEXT_MAX_CHARS)}… [${n - TEXT_MAX_CHARS} more characters]`);
      expect(redactText(out), `${n}: idempotent`).toBe(out);
    }
    // A text whose redaction is longer than the limit is cut after it, and stays within the snapshot's bound.
    const grown = redactText("token=x ".repeat(512));
    expect(grown.length).toBeLessThanOrEqual(TEXT_MAX_CHARS + 64);
    expect(grown).toMatch(/… \[\d+ more characters\]$/u);
    expect(redactText(grown)).toBe(grown);
    // A forged cut mark does not stop the cut: a text is a cut text only when at most 4,096 characters come before its
    // mark, also within the 4,097–4,160 characters the snapshot's bound allows.
    for (const before of [4_097, 4_100, 4_120, 4_139, 5_000]) {
      const forged = `${"y".repeat(before)}… [3 more characters]`;
      const out = redactText(forged);
      expect(out, `${before}`).toBe(`${"y".repeat(TEXT_MAX_CHARS)}… [${forged.length - TEXT_MAX_CHARS} more characters]`);
      expect(redactText(out)).toBe(out);
    }
    // At most 4,096 characters before a mark: a cut text, kept as it is but redacted.
    const short = `${"y".repeat(4_000)} token=abc… [3 more characters]`;
    expect(redactText(short)).toBe(`${"y".repeat(4_000)} token=[redacted]… [3 more characters]`);
    expect(redactText(`${"y".repeat(4_096)}… [3 more characters]`)).toBe(`${"y".repeat(4_096)}… [3 more characters]`);

    // A member written as a JSON string again and again: removed at every depth a cut text can hold.
    const secret = ["private", "secret", "value"].join("-");
    let t = JSON.stringify({ token: secret, n: 1 });
    let depth = 0;
    while (t.length <= TEXT_MAX_CHARS) {
      const out = redactText(t);
      expect(out, `${depth} encodings`).not.toContain(secret);
      expect(redactText(out)).toBe(out);
      let v: unknown = out;
      for (let i = 0; i <= depth; i++) v = JSON.parse(v as string);
      expect(v, `${depth} encodings`).toEqual({ token: "[redacted]", n: 1 });
      t = JSON.stringify(t);
      depth++;
    }
    expect(depth).toBeGreaterThanOrEqual(9); // up to 8 encodings fit in 4,096 characters here
    // Eight encodings: 127 backslashes before the key's quotes.
    let eight = JSON.stringify({ token: secret });
    for (let i = 0; i < 7; i++) eight = JSON.stringify(eight);
    expect(redactText(eight)).not.toContain(secret);
  });

  it("[[engine.telemetry.redaction-cut-mark]] the mark of a cut is added after the redaction: a value the cut splits is removed and the mark kept whole, so redacting the result again gives it back with the same count, for every kind of secret form and whatever count a mark already stated (at most 15 digits), and it stays within the snapshot's bound", () => {
    const forms = ["token=a ", "t=a ", "password=b;", "apiKey: c\n", '"secret":"d",', "Bearer abcdefghijklmnopq ", "https://u:p@h.invalid/?k=v#f ", "seed: a b c d e f g h i j k l\n", "cookie: z=1\n", '\\"token\\":\\"v\\",', "authorization: Basic QWxhZGRpbjpvcGVu\n"];
    let cut = 0;
    for (const form of forms) {
      for (let pad = 0; pad < form.length + 3; pad++) {
        for (const n of [4_090, 4_096, 4_097, 4_160, 4_161, 8_000, 20_000]) {
          const input = ("x".repeat(pad) + form.repeat(Math.ceil(n / form.length))).slice(0, n);
          const once = redactText(input);
          expect(redactText(once), `${JSON.stringify(form)} ${pad} ${n}`).toBe(once);
          expect(once.length).toBeLessThanOrEqual(TEXT_MAX_CHARS + 64);
          if (/… \[\d+ more characters\]$/u.test(once)) cut++;
        }
      }
    }
    expect(cut).toBeGreaterThan(0);
    // The value the cut splits is removed whole; when its redaction would make what is kept longer than 4,096 characters,
    // less of the text is kept, and the count says how much of the text was left out.
    const text = `${"x".repeat(TEXT_MAX_CHARS - 9)} token=abcdefghij rest`;
    const split = redactText(text);
    const kept = split.slice(0, split.indexOf("… ["));
    expect(kept.length).toBeLessThanOrEqual(TEXT_MAX_CHARS);
    expect(split).not.toContain("abc");
    expect(split.endsWith(`… [${text.length - kept.length} more characters]`)).toBe(true);
    expect(redactText(split)).toBe(split);
    // A mark's count, however large the mark already on the text stated, stays one the next pass reads as a mark: at
    // most 15 digits.
    for (const count of ["3", "999999999999", "999999999999999"]) {
      for (const form of forms) {
        const once = redactText(`${form.repeat(Math.ceil(TEXT_MAX_CHARS / form.length)).slice(0, TEXT_MAX_CHARS)}… [${count} more characters]`);
        expect(redactText(once), `${JSON.stringify(form)} ${count}`).toBe(once);
        expect(once, `${JSON.stringify(form)} ${count}`).toMatch(/… \[[1-9]\d{0,14} more characters\]$/u);
      }
    }
    expect(redactText(`${"token=x ".repeat(512)}… [999999999999999 more characters]`)).toMatch(/… \[999999999999999 more characters\]$/u);
    // Kept parts never exceed 4,096 characters, for every form above.
    for (const form of forms) {
      const once = redactText(form.repeat(Math.ceil(9_000 / form.length)));
      expect(once.indexOf("… ["), JSON.stringify(form)).toBeLessThanOrEqual(TEXT_MAX_CHARS);
    }
  });

  it("[[engine.telemetry.redaction-cut-secrets]] a secret the cut falls in is never shown in part: a Bearer or Basic credential, a URL's user name and password, a key-like path segment, a viewing key, a key=value and a JWT straddling the 4,096th character at every offset from 0 to 20, or the 16,384 characters redaction reads (also with no whitespace near it, or with the last whitespace or double quote 2,000 characters before it: all before that kept), show nothing of themselves, not four characters in a row; and a text whose redacted start sits just over 4,096 characters keeps that start, never only the mark", () => {
    const forms: Array<[string, string, string, RegExp]> = [
      ["Bearer ", "AbCdEfGh1234567890secretTOKEN", " tail", /AbCd|secretTOKEN/u],
      ["Basic ", "QWxhZGRpbjpvcGVuc2VzYW1l", " tail", /QWxh/u],
      ["https://alice:", "123456789", "@host.example/x tail", /alice|1234/u],
      ["https://alice:", "s3cretpassw0rd", "@host.example/x tail", /alice|s3cr/u],
      ["see https://h.example.test/v1/", "9aa3d95b3bc440fa88ea12eaa4456161", "/x tail", /9aa3d95b/u],
      ["key mn_shield-esk_test1", "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", " tail", /qqqqqq/u],
      ["token=", "abcdefghij0123456789", " tail", /abcdefgh/u],
      ["", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0In0", "c2lnbmF0dXJl"].join("."), " tail", /eyJhbGciOi/u],
    ];
    // A long secret value first puts what reaches the 16,384th character inside the 4,096 characters kept.
    for (const [head, limit] of [["", TEXT_MAX_CHARS], [`token=${"v".repeat(12_500)} `, 16_384]] as const) {
      for (const [pre, secret, post, shows] of forms) {
        for (let at = 0; at <= 20; at++) {
          const fill = limit - head.length - pre.length - at - 1;
          const text = `${head}${"z ".repeat(Math.ceil(fill / 2)).slice(0, fill)} ${pre}${secret}${post}${" more".repeat(50)}`;
          const out = redactText(text);
          const where = `${JSON.stringify(pre)} at ${at} of ${limit}`;
          expect(out, where).not.toMatch(shows);
          expect(redactText(out), where).toBe(out);
          expect(out.length, where).toBeLessThanOrEqual(TEXT_MAX_CHARS + 64);
        }
      }
    }
    // No whitespace near the 16,384th character: the text is never cut inside a token before it is read, whatever
    // redaction does to what comes first (here a long value it shortens to `[redacted]`). Nothing of a secret is shown:
    // no four characters of it in a row, in what is kept before the mark.
    const value = ["abcdefghij", "0123456789"].join("");
    const glued: Array<[string, string[]]> = [
      [";https://aliceSecret@host.example/x", ["aliceSecret"]],
      [";https://alice:s3cretpassw0rd@host.example/x", ["alice", "s3cretpassw0rd"]],
      [";Bearer AbCdEfGh1234567890secretTOKEN", ["AbCdEfGh1234567890secretTOKEN"]],
      [`;token=${value}`, [value]],
      [`;{"token":"${value}"}`, [value]],
      [`;apiKey:${value}`, [value]],
    ];
    /** The parts of `secrets` four characters long that `out` shows before its mark. */
    const shown = (out: string, secrets: readonly string[]): string[] => {
      const kept = out.replace(/… \[\d+ more characters\]$/u, "");
      return secrets.flatMap((secret) => [...secret].map((_, i) => secret.slice(i, i + 4)).filter((part) => part.length === 4 && kept.includes(part)));
    };
    // The raw cut at 16,384 characters falls at each character of the tail in turn: the tail's first `at` are within.
    for (const [tail, secrets] of glued) {
      for (let at = 0; at < tail.length; at++) {
        const text = `token=${"v".repeat(15_000)};${"z".repeat(1_377 - at)}${tail}`;
        const out = redactText(text);
        expect(shown(out, secrets), `${tail} ${at}`).toEqual([]);
        expect(redactText(out), `${tail} ${at}`).toBe(out);
      }
    }
    // The text's last whitespace or double quote 2,000 characters before the raw cut at 16,384, and the same tails
    // across the cut: the text is cut before that character, so everything before it is kept (what redaction leaves).
    for (const separator of [" ", '"']) {
      for (const [tail, secrets] of glued.filter(([t]) => !/[\s"]/u.test(t))) {
        for (let at = 0; at < tail.length; at++) {
          const before = `token=${"v".repeat(14_000)};${"z".repeat(377)}`;
          const text = `${before}${separator}${"y".repeat(1_999 - at)}${tail}`;
          expect(before.length, "where the separator is").toBe(16_384 - 2_000);
          const out = redactText(text);
          const where = `${JSON.stringify(separator)} ${tail} ${at}`;
          expect(out, where).toBe(`token=[redacted];${"z".repeat(377)}… [${text.length - before.length} more characters]`);
          expect(shown(out, secrets), where).toEqual([]);
          expect(redactText(out), where).toBe(out);
        }
      }
    }
    // Short secrets at the start, each longer once redacted, then filler up to just over 4,096 characters once
    // redacted, then a long value across the cut: the start is kept.
    for (let k = 1; k <= 40; k++) {
      for (let over = 1; over <= 6; over++) {
        const head = `error from the endpoint: ${"pwd=a; ".repeat(k)}`;
        const fill = TEXT_MAX_CHARS - 16 + over - redactWhole(head).length;
        if (fill < 10) continue;
        const out = redactText(`${head}${"y".repeat(fill)} token=${"v".repeat(400)} the rest of the message`);
        expect(out.startsWith("error from the endpoint: pwd=[redacted];"), `${k} ${over}`).toBe(true);
        expect(out.indexOf("… ["), `${k} ${over}`).toBeGreaterThan(TEXT_MAX_CHARS - 40);
        expect(redactText(out)).toBe(out);
      }
    }
  });

  it("[[engine.telemetry.redaction-url-paths]] a URL keeps its origin and its path but path segments that look like keys: an endpoint key in the path does not reach the snapshot or the diagnostics file", () => {
    const key = "9aa3d95b3bc440fa88ea12eaa4456161";
    expect(publicUrl(`https://mainnet.example.test/v3/${key}`)).toBe("https://mainnet.example.test/v3/[redacted]");
    expect(publicUrl(`https://rpc.example.test/v1/${key}/rpc?x=1`)).toBe("https://rpc.example.test/v1/[redacted]/rpc");
    expect(publicUrl("https://x.example.test/ab12CD34ef56GH78ij90KL12/")).toBe("https://x.example.test/[redacted]/");
    expect(publicUrl("wss://ws.example.test/1b4e28ba-2fa1-41d2-883f-0016d3cca427")).toBe("wss://ws.example.test/[redacted]");
    // Public paths stay.
    for (const kept of [INDEXER, NODE, "https://indexer.stagenet.shielded.tools/api/v4/graphql", "http://h.example:8080/a/b", "https://h.example.test/transactions_default_staging/block/12345"])
      expect(publicUrl(kept), kept).toBe(kept);
    expect(publicUrl("postgres://admin:pw@db.internal:5432/umbra")).toBe("postgres://db.internal:5432/umbra");
    expect(redactText(`HTTP 403 from https://rpc.example.test/v1/${key}/rpc`)).toBe("HTTP 403 from https://rpc.example.test/v1/[redacted]/rpc");
    expect(redactText(redactText(`see https://rpc.example.test/v1/${key}`))).toBe("see https://rpc.example.test/v1/[redacted]");

    const s = minimal();
    s.configuration.endpoints.node = `https://rpc.example.test/v1/${key}`;
    s.configuration.endpoints.indexer = `https://indexer.example.test/${key}/api/v4/graphql`;
    s.logs = [{ seq: 0, at: 1, level: "error", source: "sync", text: `fetch https://rpc.example.test/v1/${key} failed` }];
    const r = redactSnapshot(s);
    expect(r.configuration.endpoints).toEqual({ ...r.configuration.endpoints, node: "https://rpc.example.test/v1/[redacted]", indexer: "https://indexer.example.test/[redacted]/api/v4/graphql" });
    expect(diagnosticsJson(s)).not.toContain(key);
  });
});
