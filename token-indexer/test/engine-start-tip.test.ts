/**
 * The engine's start at the finalized tip (`sync.startHeight: "tip"`): the recorded U1 range answered by the fake
 * chain as a `fetch` function with a movable tip, a manual clock, and Postgres 17 or PGlite
 * (`test/helpers/test-database.ts`).
 *
 * - `[[engine.start-tip]]` — a new archive starts at `min(node finalized height, indexer tip)` read when the sync
 *   begins; while the endpoints fail, the engine waits with a doubling back-off (an `error` event per failed attempt,
 *   phase `backoff`), asks for no block and never starts at genesis; once they answer it starts at the tip they serve
 *   then and follows it; a later engine on the same store resumes at the cursor and fetches every height of the gap
 *   since (no jump to the new tip, no hole).
 * - `[[engine.start-tip.stop]]` — a stop while it waits for the tip ends the sync cleanly, with nothing archived; a
 *   start height that is not a height, `"tip"` or a function is refused.
 * - `[[engine.start-tip.stale-node]]` — a node endpoint behind a load balancer, one of whose backends is 38,000 blocks
 *   behind the chain (one answer in three, and every answer of the first reading): the start reads the tip several
 *   times, takes the highest answer, and reads again while even that is far below the indexer's tip (an `error` event
 *   says so), so the archive starts at the true finalized tip, never at the stale height; while it follows, the
 *   finalized tip the telemetry reports never goes back; block hashes the stale backend answers `null` for are asked
 *   again; every height is archived once.
 * - `[[engine.start-tip.follows]]` — the archive and scan heights follow the finalized tip for 10 minutes, in simulated
 *   time: the recorded IDX range with a finalized tip that rises one block every 6 s of the manual clock (Midnight's
 *   block time; the live Stagenet runs saw about one every 8.7 s, so this is the faster case), the engine with the browser's settings (20 heights per sync batch, 10 blocks per scan step) and the
 *   engine's own waits (10 s at the tip for the sync, 2 s for the scan), for 10 simulated minutes: the archive starts
 *   at the tip and every time both loops wait, the archive is within the blocks one sync wait lets pass (2) and the
 *   scan within that of the archive; at the end both are at the tip, with every height archived once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, type TestDatabase } from "../../test/helpers/test-database.ts";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { fakeChainFetch } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { DEFAULT_SCAN_BATCH, DEFAULT_SYNC_MAX_BLOCKS } from "../browser/host.ts";
import { createIndexerEngine, ENGINE_DEFAULTS, type EngineEvent, type EngineOptions, type IndexerEngine, TIP_SAMPLES } from "../engine/engine.ts";
import { createEngineTelemetry } from "../engine/telemetry.ts";
import { ManualClock } from "./helpers/manual-clock.ts";

const NET = "stagenet";
const U1 = { from: 715402, to: 715433 } as const;

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The fake chain behind a switch: while `down`, every request is answered 503. Records the heights asked for. */
function switchedChain(finalizedHeight: number) {
  const c = fakeChainFetch(loadRangeTape("u1"), { finalizedHeight });
  const state = { down: false, requests: [] as Array<{ op: string; height: number | null }> };
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string; params?: unknown[]; variables?: { height?: number } }) : {};
    const op = body.method ?? "graphql";
    const height = typeof body.params?.[0] === "number" ? body.params[0] : typeof body.variables?.height === "number" ? body.variables.height : null;
    state.requests.push({ op, height });
    if (state.down) return new Response("down", { status: 503 });
    return c.fetch(input, init);
  };
  return { c, state, fetchImpl };
}

/**
 * The fake chain behind a load-balanced node endpoint, one of whose backends is 38,000 blocks behind the chain: the
 * n-th finalized head it answers (from 1) comes from that backend when `stale(n)` says so (its head's header has the
 * stale height), and every third block hash it answers comes from it too (it has no block at those heights: null). The
 * indexer is current. Records the requests.
 */
function staleBackendChain(finalizedHeight: number, stale: (n: number) => boolean) {
  const c = fakeChainFetch(loadRangeTape("u1"), { finalizedHeight });
  const STALE_HASH = `0x${"5a".repeat(32)}`;
  const state = { heads: 0, hashes: 0, requests: [] as Array<{ op: string; height: number | null }> };
  const answer = (id: unknown, result: unknown): Response => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: unknown; method?: string; params?: unknown[]; variables?: { height?: number } }) : {};
    const op = body.method ?? "graphql";
    const height = typeof body.params?.[0] === "number" ? body.params[0] : typeof body.variables?.height === "number" ? body.variables.height : null;
    state.requests.push({ op, height });
    if (op === "chain_getFinalizedHead" && stale(++state.heads)) return answer(body.id, STALE_HASH);
    if (op === "chain_getHeader" && body.params?.[0] === STALE_HASH) {
      const h = c.finalizedHeight() - 38_000;
      return answer(body.id, { parentHash: STALE_HASH, number: `0x${h.toString(16)}`, stateRoot: STALE_HASH, extrinsicsRoot: STALE_HASH, digest: { logs: [] } });
    }
    if (op === "chain_getBlockHash" && ++state.hashes % 3 === 0) return answer(body.id, null);
    return c.fetch(input, init);
  };
  return { c, state, fetchImpl };
}

describe("indexer engine: start at the finalized tip", () => {
  let database: TestDatabase;
  const clients: UmbraDBSql[] = [];
  const engines: IndexerEngine[] = [];

  beforeAll(async () => {
    database = await openTestDatabase();
  }, 180_000);

  afterAll(async () => {
    for (const e of engines) await e.stop();
    for (const c of clients) await c.end({ timeout: 5 });
    await database?.stop();
  }, 60_000);

  function engine(sql: UmbraDBSql, mip: string, archive: string, o: Partial<EngineOptions>): IndexerEngine {
    const e = createIndexerEngine({ sql, network: NET, schema: mip, archiveSchema: archive, ...o });
    engines.push(e);
    return e;
  }

  it("[[engine.start-tip]] a new archive starts at the finalized tip both sources serve, waits with back-off while they fail (never genesis), follows the tip, and a later engine catches up the gap from its cursor", async () => {
    const sql = database.client("tip_mip");
    clients.push(sql);
    const { c, state, fetchImpl } = switchedChain(715410);
    const urls = { nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl };
    const backoff = { baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 2, jitter: false };

    // 1. The endpoints fail: the sync waits, asks for no block, and has no first height.
    state.down = true;
    const clock = new ManualClock();
    const events: EngineEvent[] = [];
    const first = engine(sql, "tip_mip", "tip_arch", {
      fetch: fetchImpl, clock, random: () => 0.5, onEvent: (e) => events.push(e),
      sync: { ...urls, startHeight: "tip", maxBlocks: 5, idleMs: 1_000, backoff },
    });
    await first.start();
    for (let i = 0; i < 9; i++) {
      await clock.untilWaiting(1);
      clock.next();
    }
    await clock.untilWaiting(1);
    const waiting = first.status();
    expect(waiting.sync).toMatchObject({ startHeight: undefined, lastBatch: undefined });
    expect(["backoff", "starting"]).toContain(waiting.sync.phase);
    expect(waiting.sync.failures).toBeGreaterThanOrEqual(4);
    expect(waiting.sync.lastError).toMatch(/503/);
    expect(await first.syncCursor()).toBeUndefined();
    // Each attempt: the call retried once after 1 s (per-call back-off), then the loop waits 750, 1500, 3000, 3000 ms
    // (base 1 s doubling to 4 s, half of it jittered by 0.5).
    expect(clock.sleeps.slice(0, 9)).toEqual([1_000, 750, 1_000, 1_500, 1_000, 3_000, 1_000, 3_000, 1_000]);
    const errors = events.filter((e) => e.source === "sync" && e.event === "error").map((e) => (e.fields as { retryMs: number }).retryMs);
    expect(errors.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(events.some((e) => e.source === "sync" && e.event === "start")).toBe(false);
    expect(new Set(state.requests.map((r) => r.op))).toEqual(new Set(["chain_getFinalizedHead"]));

    // 2. The endpoints answer: the archive starts at the tip they serve now, and follows it.
    state.down = false;
    c.setFinalizedHeight(715412);
    const undrive = clock.drive();
    await until(async () => (await first.syncCursor())?.height === 715412, "the tip block to be archived");
    expect(await first.syncCursor()).toEqual({ height: 715412, startHeight: 715412 });
    expect(first.status().sync.startHeight).toBe(715412);
    const start = events.find((e) => e.source === "sync" && e.event === "start")!;
    expect(start.fields).toMatchObject({ from: 715412, to: "follow", cursor: null });
    c.advanceFinalizedHeight(4);
    await until(async () => (await first.syncCursor())?.height === 715416, "the archive to follow the tip");
    await first.stop();
    undrive();
    const asked = state.requests.filter((r) => r.op === "chain_getBlockHash").map((r) => r.height!);
    expect(Math.min(...asked)).toBe(715412); // never genesis, never below the tip it started at

    // 3. Reopened later, with the tip moved on: the archive resumes at its cursor and fetches the whole gap.
    c.setFinalizedHeight(715425);
    state.requests.length = 0;
    const clock2 = new ManualClock();
    const undrive2 = clock2.drive();
    const second = engine(sql, "tip_mip", "tip_arch", {
      fetch: fetchImpl, clock: clock2,
      sync: { ...urls, startHeight: "tip", maxBlocks: 5, idleMs: 1_000, backoff },
      scan: { batch: 5, idleMs: 1_000 },
    });
    await second.start();
    await until(async () => (await second.syncCursor())?.height === 715425 && (await second.scanCursor())?.nextHeight === 715426, "the gap to be synced and scanned");
    await second.stop();
    undrive2();
    const gap = state.requests.filter((r) => r.op === "chain_getBlockHash").map((r) => r.height!).sort((a, b) => a - b);
    expect(gap).toEqual(Array.from({ length: 715425 - 715416 }, (_, i) => 715417 + i));
    expect(await second.syncCursor()).toEqual({ height: 715425, startHeight: 715412 });
    const [blocks] = await sql<{ n: number; lo: string; hi: string }[]>`
      SELECT count(*)::int AS n, min(height)::text AS lo, max(height)::text AS hi FROM ${sql("tip_arch")}.blocks`;
    expect(blocks).toEqual({ n: 715425 - 715412 + 1, lo: "715412", hi: "715425" }); // contiguous: no hole
    const status = JSON.parse((await second.handle("GET", "/v1/status")).body) as { startHeight: number; archiveHeight: number };
    expect(status).toMatchObject({ startHeight: 715412, archiveHeight: 715425 });
  }, 120_000);

  it("[[engine.start-tip.stop]] a stop while the engine waits for the tip ends the sync cleanly; an invalid start height is refused", async () => {
    const sql = database.client("tip2_mip");
    clients.push(sql);
    const { c, state, fetchImpl } = switchedChain(U1.to);
    state.down = true;
    const clock = new ManualClock();
    const e = engine(sql, "tip2_mip", "tip2_arch", {
      fetch: fetchImpl, clock,
      sync: { nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl, startHeight: "tip", backoff: { baseDelayMs: 1_000, maxAttempts: 1, jitter: false } },
    });
    await e.start();
    await clock.untilWaiting(1);
    expect(e.status().sync.phase).toBe("backoff");
    await e.stop();
    await expect(e.finished).resolves.toBeUndefined();
    expect(e.status().sync.phase).toBe("stopped");
    expect(await e.syncCursor()).toBeUndefined();
    expect(() => createIndexerEngine({ sql, network: NET, sync: { nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl, startHeight: "top" as "tip" } }))
      .toThrow(/sync.startHeight must be a height, "tip" or a function/);
  }, 60_000);

  it("[[engine.start-tip.follows]] ten simulated minutes of a finalized tip rising one block every 6 s: the archive starts at the tip and, with the browser's batch sizes and the engine's waits, the archive and the scan follow it within one sync wait; every height is archived once", async () => {
    const sql = database.client("follow_mip");
    clients.push(sql);
    const clock = new ManualClock();
    const BLOCK_MS = 6_000;
    const MINUTES = 10;
    const H = 714600;
    const c = fakeChainFetch(loadRangeTape("idx"), { finalizedHeight: H, advance: { everyMs: BLOCK_MS, by: 1 }, now: () => clock.now() });
    const e = engine(sql, "follow_mip", "follow_arch", {
      fetch: c.fetch,
      clock,
      sync: { nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl, startHeight: "tip", maxBlocks: DEFAULT_SYNC_MAX_BLOCKS },
      scan: { batch: DEFAULT_SCAN_BATCH },
    });
    // Within one sync wait at the tip the finalized tip can rise this many blocks.
    const slack = Math.ceil(ENGINE_DEFAULTS.syncIdleMs / BLOCK_MS);
    const t0 = clock.now();
    await e.start();
    const samples: Array<{ at: number; tip: number; archive: number; scanned: number }> = [];
    const sample = async (): Promise<void> => {
      await clock.untilWaiting(2); // both loops wait: the sync at the tip, the scan at the archive's tip
      const archive = (await e.syncCursor())?.height ?? H - 1;
      const scanned = ((await e.scanCursor())?.nextHeight ?? H) - 1;
      samples.push({ at: clock.now() - t0, tip: c.finalizedHeight(), archive, scanned });
    };
    while (clock.now() - t0 < MINUTES * 60_000) {
      await sample();
      clock.next();
    }
    await sample(); // past the tenth minute
    await e.stop();

    expect(await e.syncCursor()).toMatchObject({ startHeight: H });
    const lags = samples.map((x) => ({ ...x, archiveLag: x.tip - x.archive, scanLag: x.archive - x.scanned }));
    const worst = { archive: Math.max(...lags.map((x) => x.archiveLag)), scan: Math.max(...lags.map((x) => x.scanLag)) };
    expect(samples.length).toBeGreaterThan(MINUTES * 60_000 / ENGINE_DEFAULTS.syncIdleMs);
    expect(lags.filter((x) => x.archiveLag > slack), `the archive within ${slack} blocks of the tip`).toEqual([]);
    expect(lags.filter((x) => x.scanLag > slack), `the scan within ${slack} blocks of the archive`).toEqual([]);
    for (let m = 1; m <= MINUTES; m++) expect(lags.some((x) => x.at >= (m - 1) * 60_000 && x.at < m * 60_000), `samples in minute ${m}`).toBe(true);
    const end = lags.at(-1)!;
    expect(end.at).toBeGreaterThanOrEqual(MINUTES * 60_000);
    expect(end.tip).toBeGreaterThanOrEqual(H + (MINUTES * 60_000) / BLOCK_MS);
    expect(end.archive).toBeGreaterThanOrEqual(end.tip - slack);
    expect(c.counts.get("chain_getBlock")).toBe(end.archive - H + 1); // each height once
    const [blocks] = await sql<{ n: number; lo: string; hi: string }[]>`
      SELECT count(*)::int AS n, min(height)::text AS lo, max(height)::text AS hi FROM ${sql("follow_arch")}.blocks`;
    expect(blocks).toEqual({ n: end.archive - H + 1, lo: String(H), hi: String(end.archive) });
    console.log(`following the finalized tip, simulated: ${MINUTES} min, tip ${H} → ${end.tip}, ${samples.length} samples, worst archive lag ${worst.archive} and scan lag ${worst.scan} blocks (allowed ${slack})`);
  }, 120_000);
  it("[[engine.start-tip.stale-node]] a node endpoint with a backend 38,000 blocks behind (one answer in three; every answer of the first reading): the archive starts at the true finalized tip, never at the stale height; while it follows, the finalized tip it reports never goes back, and block hashes the stale backend cannot give are asked again, every height archived once", async () => {
    const sql = database.client("stale_mip");
    clients.push(sql);
    const TIP = 715412;
    // The first reading's three answers are all stale; afterwards one in three.
    const { c, state, fetchImpl } = staleBackendChain(TIP, (n) => n <= TIP_SAMPLES || n % 3 === 2);
    const clock = new ManualClock();
    const events: EngineEvent[] = [];
    const telemetry = createEngineTelemetry({ clock, endpoints: { node: c.nodeUrl, indexer: c.indexerUrl } });
    const e = engine(sql, "stale_mip", "stale_arch", {
      fetch: fetchImpl, clock, random: () => 0.5, onEvent: (x) => events.push(x),
      sync: { nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl, startHeight: "tip", maxBlocks: 3, idleMs: 1_000, backoff: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 8, jitter: false } },
      scan: { batch: 5, idleMs: 1_000 },
    });
    telemetry.attach(e);
    const undrive = clock.drive();
    await e.start();
    await until(() => events.some((x) => x.source === "sync" && x.event === "start"), "the sync's start");
    const start = events.find((x) => x.source === "sync" && x.event === "start")!;
    expect(start.fields).toMatchObject({ from: TIP, cursor: null });
    const stale = events.filter((x) => x.source === "sync" && x.event === "error").map((x) => String(x.fields.message));
    expect(stale[0]).toMatch(new RegExp(`^the node's finalized height ${TIP - 38_000} \\(the highest of ${TIP_SAMPLES} answers\\) is 38000 blocks below the indexer's tip ${TIP}: the node answered from a backend behind the chain; asked again$`));

    // Following: the tip rises; the reported finalized tip never goes back while stale answers keep coming.
    const tips: number[] = [];
    let following = true;
    const watch = (async () => {
      while (following) {
        const t = telemetry.counters().sync.tip?.height;
        if (t !== undefined) tips.push(t);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    for (let h = TIP + 1; h <= U1.to; h += 3) {
      c.setFinalizedHeight(Math.min(h, U1.to));
      await until(async () => ((await e.syncCursor())?.height ?? 0) >= Math.min(h, U1.to) - 3, `the archive near ${h}`);
    }
    c.setFinalizedHeight(U1.to);
    await until(async () => (await e.syncCursor())?.height === U1.to, "the archive at the tip");
    // The batch's event (with the tip it read) comes once its blocks are written.
    await until(() => telemetry.counters().sync.tip?.height === U1.to, "the reported tip at the chain's tip");
    following = false;
    await watch;
    await e.stop();
    undrive();
    expect(tips.length).toBeGreaterThan(10);
    for (let i = 1; i < tips.length; i++) expect(tips[i]!, `the reported tip at sample ${i}`).toBeGreaterThanOrEqual(tips[i - 1]!);
    expect(tips.at(-1)).toBe(U1.to);
    expect(state.heads, "stale finalized heads were answered while following").toBeGreaterThan(TIP_SAMPLES + 3);
    // Nothing was fetched from the stale height; null block hashes were asked again; every height archived once.
    const asked = state.requests.filter((r) => r.op === "chain_getBlockHash").map((r) => r.height!);
    expect(Math.min(...asked)).toBe(TIP);
    expect(state.hashes).toBeGreaterThan(U1.to - TIP + 1);
    // Each null was asked again by the call itself (a back-off of chain_getBlockHash), never a failed batch.
    const afterStart = events.slice(events.indexOf(start));
    expect(afterStart.filter((x) => x.source === "sync" && x.event === "error").map((x) => x.fields.message)).toEqual([]);
    expect(afterStart.some((x) => x.source === "sync" && x.event === "backoff" && x.fields.operation === "chain_getBlockHash" && /answered null/.test(String(x.fields.message)))).toBe(true);
    const [blocks] = await sql<{ n: number; lo: string; hi: string }[]>`
      SELECT count(*)::int AS n, min(height)::text AS lo, max(height)::text AS hi FROM ${sql("stale_arch")}.blocks`;
    expect(blocks).toEqual({ n: U1.to - TIP + 1, lo: String(TIP), hi: String(U1.to) });
  }, 120_000);
});
