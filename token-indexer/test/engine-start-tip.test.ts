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
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, type TestDatabase } from "../../test/helpers/test-database.ts";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { fakeChainFetch } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { createIndexerEngine, type EngineEvent, type EngineOptions, type IndexerEngine } from "../engine/engine.ts";
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
});
