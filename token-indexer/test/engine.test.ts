/**
 * The indexer engine (`token-indexer/engine/engine.ts`) composed from injected parts: the recorded Stagenet tapes are
 * answered by the fake chain as a `fetch` function (no socket), time is a manual clock (`helpers/manual-clock.ts`),
 * and the database is Postgres 17 or PGlite (`test/helpers/test-database.ts`). Covered: the composition over a
 * recorded range (archive and 37-table digests equal to the recorded live sync's), the first-height seam, the loops'
 * timing and back-off, a graceful stop and the scheduler, refused ranges and drain mode, the API through the engine,
 * and the option checks.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, type TestDatabase } from "../../test/helpers/test-database.ts";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { NodeRpcClient } from "../../chain-archive-sync/node-rpc-client.js";
import { ChainArchiveSyncService, SyncRangeError } from "../../chain-archive-sync/sync-service.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { archiveDigest, dumpArchive } from "../../test/integration/fixtures/stagenet-archive/archive-digest.js";
import { fakeChainFetch, type FakeChainOptions } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadManifest, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { rangeTables } from "../dev/range-tables.ts";
import { createIndexerEngine, type EngineEvent, type EngineOptions, type EngineScheduler, type IndexerEngine } from "../engine/engine.ts";
import { createMip0018Handler } from "../mip0018/api.ts";
import { ScanError } from "../mip0018/scan.ts";
import { ManualClock } from "./helpers/manual-clock.ts";
import { putSyntheticBlocks } from "./helpers/synthetic-archive.ts";

const NET = "stagenet";
const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/live-range/stagenet-714485-715183.json", import.meta.url), "utf8")) as {
  range: { from: number; to: number }; liveTables: { sha256: string };
};
const U1 = { from: 715402, to: 715433 } as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** A fetch that fails as a browser's global fetch does when it is called as a method (`this` is not the global). */
function plainCallOnly(f: typeof fetch): typeof fetch {
  return function (this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch': Illegal invocation");
    return f(input, init);
  } as typeof fetch;
}

/** Polls `cond` with real timers (the engine's own time is the manual clock). */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const of = <S extends EngineEvent["source"], N extends EngineEvent["event"]>(events: EngineEvent[], source: S, event: N) =>
  events.filter((e): e is Extract<EngineEvent, { source: S; event: N }> => e.source === source && e.event === event);

async function json(engine: IndexerEngine, target: string): Promise<Json> {
  const r = await engine.handle("GET", target);
  expect(r.status, `${target}: ${r.body}`).toBe(200);
  return JSON.parse(r.body);
}

describe("indexer engine", () => {
  let database: TestDatabase;
  const clients: UmbraDBSql[] = [];
  const engines: IndexerEngine[] = [];
  let counter = 0;

  beforeAll(async () => {
    database = await openTestDatabase();
  }, 180_000);

  afterAll(async () => {
    for (const e of engines) await e.stop();
    for (const c of clients) await c.end({ timeout: 5 });
    await database?.stop();
  }, 60_000);

  function fresh(prefix: string): { sql: UmbraDBSql; archive: string; mip: string } {
    const n = counter++;
    const mip = `${prefix}_mip_${n}`;
    const sql = database.client(mip);
    clients.push(sql);
    return { sql, archive: `${prefix}_arch_${n}`, mip };
  }

  function engine(db: { sql: UmbraDBSql; archive: string; mip: string }, o: Partial<EngineOptions>): IndexerEngine {
    const e = createIndexerEngine({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, ...o });
    engines.push(e);
    return e;
  }

  const chain = (opts: FakeChainOptions = {}) => fakeChainFetch(loadRangeTape("u1"), opts);
  const syncOf = (c: ReturnType<typeof chain>) => ({ nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl });

  it("[[engine.compose]] one engine syncs the recorded IDX range through an injected fetch (called as a plain function), scans it and answers the API: the archive digest equals the recorded live sync's, the 37 tables equal the recorded live range, every block is fetched once, and the events carry the sync's start, batches, range-complete and stop", async () => {
    const db = fresh("idx");
    const c = fakeChainFetch(loadRangeTape("idx"));
    const clock = new ManualClock();
    const undrive = clock.drive();
    const events: EngineEvent[] = [];
    const { from, to } = RECORDED.range;
    const e = engine(db, {
      fetch: plainCallOnly(c.fetch), clock, onEvent: (ev) => events.push(ev),
      sync: { ...syncOf(c), startHeight: from, endHeight: to, maxBlocks: 100, backoff: { jitter: false } },
      scan: { batch: 100 },
    });
    expect(e.status()).toMatchObject({ started: false, sync: { phase: "ready" }, scan: { phase: "ready", scanner: "following" } });
    await e.start();
    await until(async () => e.status().sync.phase === "done" && (await e.scanCursor())?.nextHeight === to + 1, "the range to be synced and scanned");
    undrive();

    const live = loadManifest().ranges.find((r) => r.name === "idx")!;
    expect(archiveDigest(await dumpArchive(db.sql, db.archive))).toEqual(live.liveSync.archiveDigest);
    expect((await rangeTables(db.sql, db.archive, db.mip)).digest.sha256).toBe(RECORDED.liveTables.sha256);
    expect([c.counts.get("chain_getBlock"), c.counts.get("indexer.block")]).toEqual([to - from + 1, to - from + 1]);
    expect(await e.syncCursor()).toEqual({ height: to, startHeight: from });
    expect(await json(e, "/v1/status")).toMatchObject({ startHeight: from, indexedHeight: to, archiveHeight: to, scanner: "following" });

    const sync = events.filter((ev) => ev.source === "sync").map((ev) => ev.event);
    expect(sync[0]).toBe("start");
    expect(sync.slice(-2)).toEqual(["range-complete", "stop"]);
    expect(of(events, "sync", "start")[0]!.fields).toEqual({
      net: NET, schema: db.archive, nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl, from, to, maxBlocks: 100, concurrency: 4,
      minIntervalMs: { node: 0, indexer: 0 }, cursor: null,
    });
    expect(of(events, "sync", "batch").reduce((n, b) => n + b.fields.ingested, 0)).toBe(to - from + 1);
    expect(of(events, "sync", "range-complete")[0]!.fields).toEqual({ to, height: to });
    expect(of(events, "scan", "batch").reduce((n, b) => n + b.fields.scannedBlocks, 0)).toBe(to - from + 1);
    expect(of(events, "api", "request").at(-1)!.fields).toMatchObject({ method: "GET", status: 200, busy: false });
    expect(events.every((ev) => typeof ev.at === "number")).toBe(true);

    await e.stop();
    await expect(e.finished).resolves.toBeUndefined();
    expect(e.status()).toMatchObject({ stopping: true, sync: { phase: "done" }, scan: { phase: "stopped" } });

    // Negative control: the node client calls its fetch as a method, which this fetch refuses.
    await expect(new NodeRpcClient({ url: c.nodeUrl, fetchImpl: plainCallOnly(c.fetch) }).getFinalizedHead())
      .rejects.toMatchObject({ cause: { message: expect.stringContaining("Illegal invocation") } });
  }, 300_000);

  it("[[engine.start-height]] a start-height function is asked only for a new archive, with the engine's signal; the archive, the scan and /v1/status start there; a later engine on the same store resumes at the cursor without asking and reports the archive's own first height", async () => {
    const db = fresh("start");
    const c = chain();
    const clock = new ManualClock();
    const undrive = clock.drive();
    const asked: boolean[] = [];
    const startAt = async (signal: AbortSignal): Promise<number> => {
      asked.push(signal.aborted);
      return 715420;
    };
    const a = engine(db, { fetch: c.fetch, clock, sync: { ...syncOf(c), startHeight: startAt, endHeight: 715425 }, scan: {} });
    await a.start();
    await until(async () => a.status().sync.phase === "done" && (await a.scanCursor())?.nextHeight === 715426, "715420–715425");
    expect(asked).toEqual([false]);
    expect(a.status().sync).toMatchObject({ startHeight: 715420, endHeight: 715425 });
    expect(await a.syncCursor()).toEqual({ height: 715425, startHeight: 715420 });
    expect(await json(a, "/v1/status")).toMatchObject({ startHeight: 715420, indexedHeight: 715425, archiveHeight: 715425 });
    await a.stop();

    const events: EngineEvent[] = [];
    const b = engine(db, { fetch: c.fetch, clock, sync: { ...syncOf(c), startHeight: startAt }, scan: {}, onEvent: (ev) => events.push(ev) });
    await b.start();
    await until(async () => (await b.scanCursor())?.nextHeight === U1.to + 1 && b.status().sync.phase === "idle", "the follow run to reach the tip");
    undrive();
    expect(asked).toEqual([false]); // not asked again
    expect(of(events, "sync", "start")[0]!.fields).toMatchObject({ from: 715420, to: "follow", cursor: { height: 715425, startHeight: 715420 } });
    expect(of(events, "sync", "batch")[0]!.fields).toMatchObject({ from: 715426, to: U1.to, ingested: U1.to - 715425 });
    expect(await json(b, "/v1/status")).toMatchObject({ startHeight: 715420, indexedHeight: U1.to, archiveHeight: U1.to });
    await b.stop();
    expect(b.status().sync.phase).toBe("stopped");
  }, 120_000);

  it("[[engine.timing]] the loops wait through the injected clock: the sync at the tip waits sync.idleMs and the scan at the archive's tip scan.idleMs; a failed batch backs off ×2 with injected jitter (750, 1500, 3000 for 1000 × 0.75) and resets after a success; a network call is retried through the same clock; a stalled scan backs off idleMs × 5^k up to 60 s, reports stalled in /v1/status and recovers", async () => {
    // At the tips.
    {
      const db = fresh("tip");
      const c = chain();
      const clock = new ManualClock();
      const e = engine(db, { fetch: c.fetch, clock, sync: { ...syncOf(c), startHeight: U1.from, idleMs: 7_000 }, scan: { idleMs: 3_000 } });
      await e.start();
      await until(() => e.status().sync.phase === "idle" && e.status().scan.phase === "idle", "both loops idle");
      const t0 = clock.now();
      expect(e.status().sync.waitUntil).toBe(t0 + 7_000);
      expect(e.status().scan.waitUntil).toBe(t0 + 3_000);
      expect([...clock.waiting].sort()).toEqual([3_000, 7_000]);
      expect(e.status().sync.lastBatch).toMatchObject({ ingestedBlocks: 0, targetTipHeight: U1.to });
      // The scan wakes first, scans what the sync archived, and waits again; the sync is still waiting.
      expect(clock.next()).toBe(3_000);
      await until(() => clock.sleeps.length === 3 && clock.waiting.length === 2, "the scan to wait again");
      expect(e.status().scan).toMatchObject({ phase: "idle", waitUntil: t0 + 6_000, lastBatch: { scannedBlocks: 0, archiveHeight: U1.to } });
      expect(e.status().sync).toMatchObject({ phase: "idle", waitUntil: t0 + 7_000 });
      expect(await e.scanCursor()).toMatchObject({ nextHeight: U1.to + 1 });
      await e.stop();
      expect(clock.waiting).toEqual([]); // a stop ends every wait
    }

    // A failing batch: exponential back-off with the injected jitter, then a reset.
    {
      const db = fresh("backoff");
      const c = chain({ throttles: [{ operation: "chain_getFinalizedHead", times: 3, status: 500 }] });
      const clock = new ManualClock();
      const events: EngineEvent[] = [];
      const e = engine(db, {
        fetch: c.fetch, clock, random: () => 0.5, onEvent: (ev) => events.push(ev),
        sync: { ...syncOf(c), startHeight: U1.from, endHeight: U1.to, backoff: { maxAttempts: 1 } },
      });
      await e.start();
      for (const [i, wait] of [750, 1_500, 3_000].entries()) {
        await clock.untilWaiting();
        expect(clock.waiting).toEqual([wait]);
        expect(e.status().sync).toMatchObject({ phase: "backoff", failures: i + 1, lastError: expect.stringContaining("HTTP 500") });
        clock.next();
      }
      await e.finished;
      expect(of(events, "sync", "error").map((ev) => ev.fields.retryMs)).toEqual([1_000, 2_000, 4_000]);
      expect(e.status().sync).toMatchObject({ phase: "done", failures: 0, lastError: undefined });
      expect(clock.sleeps).toEqual([750, 1_500, 3_000]);
    }

    // A throttled network call is retried inside the batch, through the clock.
    {
      const db = fresh("retry");
      const c = chain({ throttles: [{ operation: "chain_getBlock", times: 2, status: 429, retryAfter: "0" }] });
      const clock = new ManualClock();
      const undrive = clock.drive();
      const events: EngineEvent[] = [];
      const e = engine(db, {
        fetch: c.fetch, clock, onEvent: (ev) => events.push(ev),
        sync: { ...syncOf(c), startHeight: U1.from, endHeight: U1.from + 3, concurrency: 1, backoff: { maxAttempts: 3, jitter: false, baseDelayMs: 100, maxDelayMs: 150 } },
      });
      await e.start();
      await e.finished;
      undrive();
      expect(of(events, "sync", "backoff").map((ev) => ev.fields)).toEqual([
        { operation: "chain_getBlock", attempt: 1, maxAttempts: 3, delayMs: 100, httpStatus: 429, throttled: true, message: expect.stringContaining("HTTP 429") },
        { operation: "chain_getBlock", attempt: 2, maxAttempts: 3, delayMs: 150, httpStatus: 429, throttled: true, message: expect.stringContaining("HTTP 429") },
      ]);
      expect(clock.sleeps).toEqual([100, 150]);
      expect(of(events, "sync", "batch")[0]!.fields).toMatchObject({ ingested: 4, retries: 2, throttled: 2 });
    }

    // A stalled scan: an archived transaction that is not a ledger transaction.
    {
      const db = fresh("stall");
      await bootstrapChainArchiveSchema(db.sql, db.archive);
      await putSyntheticBlocks(db.sql, db.archive, NET, 50, [[{ result: "success", tx: { hash: "c3".repeat(32), intents: [] } }]]);
      const clock = new ManualClock();
      const events: EngineEvent[] = [];
      const e = engine(db, { clock, scan: { idleMs: 2_000 }, onEvent: (ev) => events.push(ev) });
      await e.start();
      for (const wait of [2_000, 10_000, 50_000, 60_000, 60_000]) {
        await clock.untilWaiting();
        expect(clock.waiting).toEqual([wait]);
        clock.next();
      }
      await clock.untilWaiting();
      expect(of(events, "scan", "error").map((ev) => [ev.fields.failures, ev.fields.retryMs])).toEqual([[1, 2_000], [2, 10_000], [3, 50_000], [4, 60_000], [5, 60_000], [6, 60_000]]);
      expect(e.scannerState()).toBe("stalled");
      expect(e.status().scan).toMatchObject({ phase: "backoff", failures: 6, scanner: "stalled", lastError: expect.stringContaining("c3c3") });
      expect(await json(e, "/v1/status")).toMatchObject({ scanner: "stalled", startHeight: 50, indexedHeight: null, archiveHeight: 50 });
      // The transaction is re-marked as a system transaction, which the scan skips: the next step succeeds and the
      // scanner follows again.
      await db.sql`UPDATE ${db.sql(db.archive)}.transactions SET kind = 'system'`;
      clock.next();
      await until(() => e.scannerState() === "following" && e.status().scan.phase === "idle", "the scan to recover");
      expect(e.status().scan).toMatchObject({ failures: 0, lastError: undefined, lastBatch: { scannedBlocks: 0, archiveHeight: 50 } });
      expect(of(events, "scan", "batch").map((ev) => ev.fields.scannedBlocks)).toEqual([1, 0]);
      expect(await e.scanCursor()).toMatchObject({ fromHeight: 50, nextHeight: 51 });
      await e.stop();
    }
  }, 180_000);

  it("[[engine.stop-scheduler]] every sync batch and scan step goes through the injected scheduler and API requests never do; stop() during a held scan step resolves only after that step has written all its blocks, and no step starts after it", async () => {
    const db = fresh("sched");
    const c = chain();
    const kinds: string[] = [];
    const a = engine(db, {
      fetch: c.fetch, clock: new ManualClock(),
      sync: { ...syncOf(c), startHeight: U1.from, endHeight: U1.to, maxBlocks: 10 },
      schedule: (kind, step) => { kinds.push(kind); return step(); },
    });
    await a.start();
    await a.finished;
    expect(kinds).toEqual(["sync", "sync", "sync", "sync"]); // 32 heights in batches of 10

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const steps: string[] = [];
    const schedule: EngineScheduler = async (kind, step) => {
      steps.push(kind);
      if (steps.length === 1) {
        held();
        await gate;
      }
      return step();
    };
    const e = engine(db, { clock: new ManualClock(), scan: { batch: 10 }, schedule });
    await e.start();
    await isHeld;
    // The API answers while the scan step is held.
    expect(await json(e, "/v1/status")).toMatchObject({ indexedHeight: null, archiveHeight: U1.to, scanner: "following" });
    let stopped = false;
    const stopping = e.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 200));
    expect(stopped).toBe(false);
    expect(e.status().stopping).toBe(true);
    release();
    await stopping;
    expect(steps).toEqual(["scan"]);
    expect(await e.scanCursor()).toMatchObject({ fromHeight: U1.from, nextHeight: U1.from + 10 });
    expect(e.status().scan).toMatchObject({ phase: "stopped", lastBatch: { scannedBlocks: 10 } });
  }, 120_000);

  it("[[engine.range-drain]] a sync start above cursor + 1 is refused (range-refused, then stop; finished rejects with SyncRangeError); drain mode ends at scan.toHeight or when caught up, and a failed drain step ends it (finished rejects, the error event has no retry)", async () => {
    const db = fresh("range");
    const c = chain();
    const a = engine(db, { fetch: c.fetch, clock: new ManualClock(), sync: { ...syncOf(c), startHeight: U1.from, endHeight: 715410 } });
    await a.start();
    await a.finished;

    const events: EngineEvent[] = [];
    const refused = engine(db, { fetch: c.fetch, clock: new ManualClock(), sync: { ...syncOf(c), startHeight: 715420 }, onEvent: (ev) => events.push(ev) });
    await refused.start();
    await expect(refused.finished).rejects.toBeInstanceOf(SyncRangeError);
    expect(events.map((ev) => `${ev.source}.${ev.event}`)).toEqual(["sync.start", "sync.range-refused", "sync.stop"]);
    expect(refused.status().sync).toMatchObject({ phase: "failed", lastError: expect.stringContaining("would leave a gap") });
    expect(c.counts.get("chain_getFinalizedHead")).toBe(1); // a refused range costs the endpoints nothing

    const to = engine(db, { clock: new ManualClock(), scan: { mode: "drain", toHeight: 715405, batch: 2 } });
    await to.start();
    await to.finished;
    expect(await to.scanCursor()).toMatchObject({ nextHeight: 715406 });
    expect(to.status().scan).toMatchObject({ phase: "done", lastBatch: { reachedEnd: true } });

    const rest = engine(db, { clock: new ManualClock(), scan: { mode: "drain" } });
    await rest.start();
    await rest.finished;
    expect(await rest.scanCursor()).toMatchObject({ nextHeight: 715411 });
    expect(rest.status().scan.lastBatch).toMatchObject({ scannedBlocks: 0, archiveHeight: 715410 });

    const bad = fresh("drainbad");
    await bootstrapChainArchiveSchema(bad.sql, bad.archive);
    await putSyntheticBlocks(bad.sql, bad.archive, NET, 7, [[{ result: "success", tx: { hash: "d4".repeat(32), intents: [] } }]]);
    const bevents: EngineEvent[] = [];
    const failing = engine(bad, { clock: new ManualClock(), scan: { mode: "drain" }, onEvent: (ev) => bevents.push(ev) });
    await failing.start();
    await expect(failing.finished).rejects.toBeInstanceOf(ScanError);
    expect(of(bevents, "scan", "error").map((ev) => ev.fields)).toEqual([{ error: expect.stringContaining("d4d4"), failures: 1, retryMs: null }]);
    expect(failing.status().scan).toMatchObject({ phase: "failed", scanner: "stalled" });
  }, 120_000);

  it("[[engine.api]] handle() answers exactly as the API handler, also before start(), and reports each request (status, busy, duration); the request cap answers 503 BUSY while requests are in flight; the handler's error lines arrive as api log events", async () => {
    const db = fresh("api");
    const c = chain();
    for (const o of [{ fetch: c.fetch, sync: { ...syncOf(c), startHeight: U1.from, endHeight: U1.to } }, { scan: { mode: "drain" as const } }]) {
      const s = engine(db, { clock: new ManualClock(), ...o });
      await s.start();
      await s.finished;
    }

    const events: EngineEvent[] = [];
    const e = engine(db, { onEvent: (ev) => events.push(ev) });
    const direct = createMip0018Handler({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive });
    const targets: Array<[string, string]> = [
      ["GET", "/v1/status"], ["GET", "/v1/tokens?limit=2"], ["HEAD", "/v1/tokens"], ["GET", "/v1/tokens/zz"], ["POST", "/v1/status"],
      ["GET", "/v1/nope"], ["GET", "/v1/tokens?bogus=1"],
    ];
    for (const [m, t] of targets) expect(await e.handle(m, t), `${m} ${t}`).toEqual(await direct.handle(m, t));
    expect(of(events, "api", "request").map((ev) => [ev.fields.method, ev.fields.status, ev.fields.busy])).toEqual([
      ["GET", 200, false], ["GET", 200, false], ["HEAD", 200, false], ["GET", 400, false], ["POST", 405, false], ["GET", 404, false], ["GET", 400, false],
    ]);
    expect(of(events, "api", "request").every((ev) => ev.fields.ms >= 0)).toBe(true);

    // The cap: one request held inside its database work, the next refused at once.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated = new Proxy(db.sql, {
      get(target, p, recv) {
        if (p !== "begin") return Reflect.get(target, p, recv);
        return async (...args: unknown[]) => {
          await gate;
          return (target.begin as (...a: unknown[]) => unknown)(...args);
        };
      },
    });
    const cevents: EngineEvent[] = [];
    const capped = engine({ ...db, sql: gated }, { maxConcurrentRequests: 1, onEvent: (ev) => cevents.push(ev) });
    const first = capped.handle("GET", "/v1/status");
    expect(capped.status().api).toEqual({ inFlight: 1, maxConcurrentRequests: 1 });
    const busy = await capped.handle("GET", "/v1/tokens");
    expect([busy.status, busy.headers["retry-after"], JSON.parse(busy.body).error.code]).toEqual([503, "1", "BUSY"]);
    release();
    expect((await first).status).toBe(200);
    expect(capped.status().api.inFlight).toBe(0);
    expect(of(cevents, "api", "request").map((ev) => [ev.fields.status, ev.fields.busy])).toEqual([[503, true], [200, false]]);

    // A database error: a generic 503 to the caller, the cause as a log line.
    const missing = fresh("missing");
    const levents: EngineEvent[] = [];
    const m = engine(missing, { onEvent: (ev) => levents.push(ev) });
    const r = await m.handle("GET", "/v1/tokens");
    expect([r.status, JSON.parse(r.body).error.code]).toEqual([503, "UNAVAILABLE"]);
    const lines = of(levents, "api", "log").map((ev) => JSON.parse(ev.fields.line) as Json);
    expect(lines).toEqual([expect.objectContaining({ event: "api-error", status: 503 })]);
    expect(of(levents, "api", "request").map((ev) => [ev.fields.status, ev.fields.busy])).toEqual([[503, false]]);
  }, 120_000);

  it("[[engine.options]] options are checked when the engine is made; start() runs once; without loops start() and stop() do nothing and the cursors are undefined; an aborted signal stops the loops; a listener can be removed", async () => {
    const db = fresh("opts");
    const sync = { nodeUrl: "http://n.invalid/rpc", indexerUrl: "http://i.invalid/graphql" };
    const base = { sql: db.sql, network: NET };
    expect(() => createIndexerEngine({ ...base, sync: { ...sync, startHeight: -1 } })).toThrow(/sync.startHeight must be a non-negative safe integer/);
    expect(() => createIndexerEngine({ ...base, sync: { ...sync, endHeight: 1.5 } })).toThrow(/sync.endHeight/);
    expect(() => createIndexerEngine({ ...base, sync: { ...sync, startHeight: 10, endHeight: 9 } })).toThrow(/below sync.startHeight 10/);
    expect(() => createIndexerEngine({ ...base, sync: { ...sync, idleMs: 0 } })).toThrow(/sync.idleMs must be a positive integer/);
    expect(() => createIndexerEngine({ ...base, scan: { idleMs: 0 } })).toThrow(/scan.idleMs must be a positive integer/);
    expect(() => createIndexerEngine({ ...base, scan: { mode: "once" as "drain" } })).toThrow(/scan.mode/);
    expect(() => createIndexerEngine({ ...base, maxConcurrentRequests: 0 })).toThrow(/maxConcurrentRequests/);

    const idle = engine(db, {});
    expect(idle.status()).toMatchObject({ sync: { phase: "off" }, scan: { phase: "off", scanner: "off" }, api: { inFlight: 0, maxConcurrentRequests: 8 } });
    expect(idle.scannerState()).toBe("off");
    await idle.start();
    await expect(idle.start()).rejects.toThrow(/already been started/);
    await expect(idle.finished).resolves.toBeUndefined();
    expect([await idle.syncCursor(), await idle.scanCursor()]).toEqual([undefined, undefined]);
    await idle.stop();

    // A signal aborted before start: the sync creates its schema, reports start and stop, and makes no request.
    const c = chain();
    const ctl = new AbortController();
    ctl.abort();
    const events: EngineEvent[] = [];
    const aborted = engine(db, { fetch: c.fetch, signal: ctl.signal, sync: { ...syncOf(c), startHeight: U1.from }, onEvent: (ev) => events.push(ev) });
    await aborted.start();
    await aborted.finished;
    expect(events.map((ev) => ev.event)).toEqual(["start", "stop"]);
    expect([...c.counts.values()].reduce((n, x) => n + x, 0)).toBe(0);
    expect(await aborted.syncCursor()).toBeUndefined();
    expect(aborted.status().sync.phase).toBe("stopped");

    // subscribe / unsubscribe.
    const seen: string[] = [];
    const listen = engine(db, {});
    const off = listen.subscribe((ev) => seen.push(ev.event));
    await listen.handle("GET", "/v1/nope");
    off();
    await listen.handle("GET", "/v1/nope");
    expect(seen).toEqual(["request"]);

    // A store that the archive sync service wrote is read back by the engine's cursor read.
    const svc = new ChainArchiveSyncService({ sql: db.sql, net: NET, schema: db.archive, node: { url: c.nodeUrl, fetchImpl: c.fetch }, indexer: { url: c.indexerUrl, fetchImpl: c.fetch }, startHeight: U1.from, endHeight: U1.from });
    await svc.syncOnce();
    expect(await aborted.syncCursor()).toEqual({ height: U1.from, startHeight: U1.from });
  }, 120_000);
});
