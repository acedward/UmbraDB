/**
 * The page's watchdog over the engine worker (`token-indexer/browser/supervisor.ts`), in Node: worker hosts on PGlite in
 * a directory (so a restarted worker finds the store), as a worker thread running a real slow statement, or in this
 * thread behind a channel that the test can silence, with the supervisor's clock driven by the test.
 *
 * - `[[browser.watchdog.unavailable]]` — the answer an API request in flight gets on a restart equals the API handler's
 *   own 503 `UNAVAILABLE` answer (GET and HEAD).
 * - `[[browser.watchdog.slow-query]]` — a statement that does not return (`pg_sleep` on the worker thread's session)
 *   silences the worker; after the limit and the grace the page terminates it and starts a new one: the API request in
 *   flight gets the 503, a status request in flight `restarted`; the new worker gets the carried counts, boots on the
 *   same store and continues the engine with the same configuration at the stored cursors, and the range ends with the
 *   same tables as an uninterrupted replay.
 * - `[[browser.watchdog.rules]]` — a late check (a frozen tab) is not a restart when the worker answers within the
 *   grace; a silent worker is restarted once, with the system viewers and the engine restored; an engine the page
 *   stopped is not started again; a boot that fails right after a restart is retried; more than the allowed restarts
 *   within the window close the client with `worker-error`.
 * - `[[browser.watchdog.long-requests]]` — while a `reset` (which drops and recreates the store's schemas) is in flight
 *   the worker may stay silent up to the longer limit; past it, it is restarted, and the `reset` fails `restarted`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";
import { EngineError, unavailableAnswer } from "../browser/client.ts";
import { createWorkerHost, type WorkerHost } from "../browser/host.ts";
import type { StartConfig } from "../browser/protocol.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA, openStore } from "../browser/store.ts";
import { DEFAULT_LONG_LIMIT_MS, LONG_REQUESTS, superviseWorker, type WorkerLike } from "../browser/supervisor.ts";
import { loadTape } from "../browser/tapes.ts";
import { rangeTables } from "../dev/range-tables.ts";
import { createMip0018Handler } from "../mip0018/api.ts";
import { fileFetch, result, SUPPORTED, testHost, U1, until, untilStatus } from "./helpers/worker-host.ts";

const FAST = { sync: { idleMs: 100 }, scan: { idleMs: 100 } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "umbradb-watchdog-"));
  dirs.push(d);
  return d;
}

/** The 37-table digest of the store in `dir` (opened here once no worker holds it). */
async function digestOf(dir: string): Promise<string> {
  const s = await openStore(dir);
  try {
    return (await rangeTables(s.mip0018, ARCHIVE_SCHEMA, MIP0018_SCHEMA)).digest.sha256;
  } finally {
    await s.close();
  }
}

let reference: Promise<string> | undefined;
function u1Reference(): Promise<string> {
  reference ??= (async () => {
    const h = testHost();
    await result(h.host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST } });
    await untilStatus(h.host, "the U1 range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
    await result(h.host, "stop");
    const d = (await rangeTables(h.opened[0]!.mip0018, ARCHIVE_SCHEMA, MIP0018_SCHEMA)).digest.sha256;
    await h.host.close();
    return d;
  })();
  return reference;
}

/** Each new worker waits until the previous one is gone (as the store's lock makes a browser worker wait). */
let previousGone: Promise<unknown> = Promise.resolve();

/** The host on a Node worker thread (`helpers/node-engine-worker.ts`). */
function threadWorker(dataDir: string, onError: (message: string) => void): WorkerLike & { thread: Promise<Worker> } {
  const listeners = new Set<(event: MessageEvent) => void>();
  const thread = previousGone.then(() => {
    const w = new Worker(new URL("./helpers/node-engine-worker.ts", import.meta.url), { workerData: { dataDir }, execArgv: ["--import", "tsx"] });
    w.on("message", (data: unknown) => { for (const l of [...listeners]) l({ data } as MessageEvent); });
    w.on("error", (e: Error) => onError(e.message));
    return w;
  });
  previousGone = thread.then((w) => new Promise((done) => w.once("exit", done)));
  return {
    thread,
    postMessage: (m) => void thread.then((w) => w.postMessage(m)),
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
    terminate: () => void thread.then((w) => w.terminate()),
  };
}

/** A host in this thread behind a channel the test can silence (both ways), standing in for a worker. */
interface ChannelWorker extends WorkerLike {
  silent: boolean;
  readonly host: WorkerHost;
  readonly terminated: boolean;
  received: Array<{ type?: string }>;
}
function channelWorker(make: () => WorkerHost): ChannelWorker {
  const before = previousGone;
  const host = make();
  const channel = new MessageChannel();
  const w: ChannelWorker = {
    silent: false,
    host,
    terminated: false,
    received: [],
    postMessage: (m) => channel.port1.postMessage(m),
    addEventListener: (_t, l) => channel.port1.addEventListener("message", l as (e: MessageEvent) => void),
    removeEventListener: (_t, l) => channel.port1.removeEventListener("message", l as (e: MessageEvent) => void),
    terminate() {
      if (w.terminated) return;
      (w as { terminated: boolean }).terminated = true;
      channel.port1.close();
      channel.port2.close();
      previousGone = host.close();
    },
  };
  const live = (): boolean => !w.silent && !w.terminated;
  channel.port2.onmessage = (e: MessageEvent) => {
    if (!live()) return;
    w.received.push(e.data as { type?: string });
    void before.then(() => host.receive(e.data)).then((r) => { if (live()) channel.port2.postMessage(r); });
  };
  host.onNotice((n) => { if (live()) channel.port2.postMessage(n); });
  channel.port1.start();
  void before.then(() => host.boot());
  previousGone = new Promise(() => {}); // until terminated
  return w;
}

describe("page watchdog", () => {
  it("[[browser.watchdog.unavailable]] an API request in flight on a restart gets exactly the API handler's 503 UNAVAILABLE answer, for GET and HEAD", async () => {
    const pglite = await PGlite.create();
    const sql = createPgliteClient({ pglite, schema: "mip0018" });
    await pglite.close();
    const handler = createMip0018Handler({ sql, network: "stagenet", log: () => {} });
    for (const method of ["GET", "HEAD"]) {
      const real = await handler.handle(method, "/v1/tokens");
      expect(real.status).toBe(503);
      expect(JSON.parse(real.body || "{}").error?.code ?? "UNAVAILABLE").toBe("UNAVAILABLE");
      expect(unavailableAnswer(method)).toEqual(real);
    }
  });

  it("[[browser.watchdog.slow-query]] a statement that does not return silences the worker; the page terminates it and starts a new one: the API request in flight gets the 503, a status request restarted; the new worker carries the counts, continues the engine at the cursors, and the range ends with the same tables", async () => {
    const expected = await u1Reference();
    const dir = tempDir();
    const threads: Array<ReturnType<typeof threadWorker>> = [];
    const restarts: number[] = [];
    // The limit is short for a test, yet long enough that a thread starved by a busy machine (loading the engine's
    // modules through the TypeScript loader, booting PGlite) is not taken for a stuck one: only the slow statement
    // below may be the restart this test counts.
    const LIMIT_MS = 5_000;
    const engine = superviseWorker({
      createWorker: (onError) => {
        const w = threadWorker(dir, onError);
        threads.push(w);
        return w;
      },
      limitMs: LIMIT_MS,
      heartbeatMs: 100,
      onRestart: (r) => restarts.push(r.count),
    });
    const c = engine.client;
    try {
      expect((await c.booted()).phase).toBe("ready");
      const config: StartConfig = { source: { kind: "tape", range: "u1", finalizedHeight: U1.from + 4, advance: { everyMs: 200, by: 2 } }, startHeight: U1.from, ...FAST };
      await c.start(config);
      await until(async () => ((await c.status()).cursors?.scan?.nextHeight ?? 0) > U1.from + 4, "a first part");
      const before = (await c.status()).cursors!;
      // The slow statement goes to the worker running now (a restart before this point would have replaced the first).
      const earlier = restarts.length;
      const running = threads.length;
      (await threads[running - 1]!.thread).postMessage({ test: "slow-statement", seconds: 60 });
      await sleep(50);
      const t0 = performance.now();
      const inflight = c.api("GET", "/v1/tokens");
      const statusInFlight = c.status().then(() => "answered", (e: EngineError) => e.code);
      expect(await inflight).toEqual(unavailableAnswer("GET"));
      const detectedMs = performance.now() - t0;
      expect(await statusInFlight).toBe("restarted");
      expect(restarts).toEqual(Array.from({ length: earlier + 1 }, (_, i) => i + 1));
      expect(engine.restarts()).toHaveLength(earlier + 1);
      const reason = engine.restarts()[earlier]!.reason;
      const silence = /^the engine worker sent nothing for (\d+) ms \(limit 5000 ms\)$/.exec(reason);
      expect(silence, reason).not.toBeNull();
      expect(Number(silence![1])).toBeGreaterThanOrEqual(LIMIT_MS);
      expect(threads).toHaveLength(running + 1);
      console.log("watchdog: the slow statement was detected and the worker replaced after", Math.round(detectedMs), `ms (limit ${LIMIT_MS}, heartbeat 100, grace 200; ${earlier} earlier restarts)`);
      expect(detectedMs).toBeLessThan(LIMIT_MS + 5_000);

      // The new worker: same store, the engine continues at the cursors with the same configuration.
      const s = await until(async () => {
        const x = await c.status().catch(() => undefined);
        return x?.boot.phase === "ready" && x.engine?.running === true;
      }, "the engine on the new worker", 60_000).then(() => c.status());
      expect(s.engine!.config).toEqual(config);
      expect(s.cursors!.sync!.height).toBeGreaterThanOrEqual(before.sync!.height);
      expect(s.cursors!.scan!.nextHeight).toBeGreaterThanOrEqual(before.scan!.nextHeight);
      await until(async () => {
        const x = await c.status();
        return x.cursors?.sync?.height === U1.to && x.cursors?.scan?.nextHeight === U1.to + 1;
      }, "the rest of the range", 60_000);
      const snap = (await c.system({ refresh: {} })).snapshot!;
      expect(snap.engine.watchdogRestarts).toBe(engine.restarts().length);
      expect(snap.engine.lastWatchdogRestart?.reason).toBe(engine.restarts().at(-1)!.reason);
      expect(snap.logs.some((l) => l.text === `watchdog restart: ${reason}`)).toBe(true);
      expect((await c.api("GET", "/v1/tokens")).status).toBe(200);
      await c.stop();
    } finally {
      engine.close();
    }
    await previousGone;
    expect(await digestOf(dir)).toBe(expected);
  }, 180_000);

  it("[[browser.watchdog.rules]] a late check is not a restart when the worker answers within the grace; a silent worker is restarted once with the viewers and the engine restored; an engine the page stopped stays stopped; a boot failing right after a restart is retried; too many restarts close the client", async () => {
    const dir = tempDir();
    let now = 0;
    let check: () => void = () => {};
    const workers: ChannelWorker[] = [];
    let failNextOpen = false;
    const problems: string[] = [];
    const engine = superviseWorker<ChannelWorker>({
      createWorker: () => {
        const fail = failNextOpen;
        failNextOpen = false;
        const w = channelWorker(() => createWorkerHost({
          network: "stagenet",
          dataDir: dir,
          nodeUrl: "https://node.invalid/",
          indexerUrl: "https://indexer.invalid/",
          checkCapabilities: async () => SUPPORTED,
          openStore: async (d, o) => {
            if (fail) throw new Error("NoModificationAllowedError: the store's files are still open in another worker");
            return openStore(d, o);
          },
          loadTape: (range) => loadTape(range, fileFetch()),
          log: () => {},
        }));
        workers.push(w);
        return w;
      },
      limitMs: 1_000,
      heartbeatMs: 20,
      graceMs: 100,
      maxRestarts: 3,
      restartWindowMs: 60_000,
      now: () => now,
      setInterval: (fn) => { check = fn; return 1; },
      clearInterval: () => {},
      sleep: () => Promise.resolve(),
      onProblem: (m) => problems.push(m),
    });
    const c = engine.client;
    const silentFor = async (ms: number) => {
      now += ms;
      check();
    };
    try {
      expect((await c.booted()).phase).toBe("ready");
      expect(workers[0]!.received[0]).toMatchObject({ type: "watchdog", limitMs: 1_000, heartbeatMs: 20 });
      await c.system({ watch: true, viewer: "status-page" });
      const config: StartConfig = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.from + 9, ...FAST };
      await c.start(config);

      // A late check (the tab was frozen with its worker): the worker's next heartbeat arrives within the grace.
      await silentFor(5_000);
      await sleep(100); // a heartbeat arrives (the worker is alive)
      await silentFor(150);
      expect(engine.restarts()).toEqual([]);

      // A silent worker: suspect, then restarted after the grace.
      workers[0]!.silent = true;
      await silentFor(1_001);
      expect(engine.restarts()).toEqual([]);
      await silentFor(101);
      expect(engine.restarts()).toHaveLength(1);
      expect(workers).toHaveLength(2);
      await until(() => workers[1]!.received.some((m) => m.type === "start"), "the engine restored on the new worker", 30_000);
      const first = workers[1]!.received;
      expect(first[0]).toMatchObject({ type: "watchdog", carried: { watchdogRestarts: 1, pgliteReopens: 0, lastWatchdogRestart: { reason: engine.restarts()[0]!.reason } } });
      expect(first.filter((m) => m.type === "system")).toEqual([expect.objectContaining({ watch: true, viewer: "status-page" })]);
      expect(first.find((m) => m.type === "start")).toMatchObject({ config });
      await until(async () => (await c.status()).engine?.status.sync.phase === "done", "the restored engine's range");

      // The page stops the engine; a restart does not start it again.
      await c.stop();
      workers[1]!.silent = true;
      await silentFor(1_001);
      await silentFor(101);
      expect(engine.restarts()).toHaveLength(2);
      await until(async () => (await c.status().catch(() => undefined))?.boot.phase === "ready", "the third worker");
      await until(() => workers[2]!.received.some((m) => m.type === "system"), "the viewer restored on the third worker");
      expect(workers[2]!.received.some((m) => m.type === "start")).toBe(false);
      expect((await c.status()).engine).toBeNull();

      // A boot that fails right after a restart (the store still held) is retried with another worker: not a restart.
      failNextOpen = true;
      workers[2]!.silent = true;
      await silentFor(1_001);
      await silentFor(101);
      await until(() => workers.length === 5 && workers[4]!.received.some((m) => m.type === "system"), "the worker after the failed boot", 30_000);
      expect(engine.restarts()).toHaveLength(3);
      expect(workers[3]!.terminated).toBe(true);
      expect(workers[4]!.received[0]).toMatchObject({ type: "watchdog", carried: { watchdogRestarts: 3 } });
      expect((await c.status()).boot.phase).toBe("ready");
      expect(problems).toEqual([]);

      // One restart more than allowed within the window closes the client.
      workers[4]!.silent = true;
      await silentFor(1_001);
      await silentFor(101);
      const err = await c.status().then(() => undefined, (e: EngineError) => e);
      expect(err).toBeInstanceOf(EngineError);
      expect(err!.code).toBe("worker-error");
      expect(err!.message).toMatch(/stopped answering 4 times within 60 s; it is not restarted again/);
      expect(workers[4]!.terminated).toBe(true);
      expect(workers).toHaveLength(5);
    } finally {
      engine.close();
    }
    await previousGone;
  }, 120_000);

  it("[[browser.watchdog.long-requests]] while a reset is in flight the worker may stay silent up to the longer limit; past it the worker is restarted and the reset fails restarted", async () => {
    expect([...LONG_REQUESTS].sort()).toEqual(["export", "import", "range", "reset"]);
    expect(DEFAULT_LONG_LIMIT_MS).toBe(600_000);
    let now = 0;
    let check: () => void = () => {};
    const workers: ChannelWorker[] = [];
    const engine = superviseWorker<ChannelWorker>({
      createWorker: () => {
        const w = channelWorker(() => testHost().host);
        workers.push(w);
        return w;
      },
      limitMs: 1_000,
      heartbeatMs: 20,
      graceMs: 100,
      longLimitMs: 30_000,
      now: () => now,
      setInterval: (fn) => { check = fn; return 1; },
      clearInterval: () => {},
    });
    const c = engine.client;
    try {
      expect((await c.booted()).phase).toBe("ready");
      workers[0]!.silent = true; // the reset below is never answered, as while its wipe runs
      const reset = c.reset().then(() => "answered", (e: EngineError) => e.code);
      now += 1_001;
      check();
      now += 101;
      check();
      now += 20_000;
      check();
      now += 101;
      check();
      expect(engine.restarts(), "within the longer limit").toEqual([]);
      now += 10_000;
      check();
      now += 101;
      check();
      expect(engine.restarts()).toHaveLength(1);
      expect(engine.restarts()[0]!.reason).toMatch(/\(limit 30000 ms\)$/);
      expect(await reset).toBe("restarted");
      await until(async () => (await c.status().catch(() => undefined))?.boot.phase === "ready", "the new worker");
      // No long request in flight any more: the ordinary limit applies again.
      workers[1]!.silent = true;
      now += 1_001;
      check();
      now += 101;
      check();
      expect(engine.restarts()).toHaveLength(2);
    } finally {
      engine.close();
    }
    await previousGone;
  }, 60_000);
});
