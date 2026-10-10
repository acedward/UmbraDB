/**
 * The worker's PGlite session (`token-indexer/browser/session.ts`) and the host's reopen rule
 * (`token-indexer/browser/host.ts`), in Node on PGlite with the recorded ranges replayed in the host.
 *
 * - `[[browser.session.monitor]]` — the session monitor gives the event loop one turn per time slice while statements
 *   run back to back, counts statements and the failures the database reports (with their SQLSTATE; a closed database
 *   is not a failed statement), and knows the statement in flight.
 * - `[[browser.session.close]]` — closing waits for the statements in flight and refuses new ones (the PGlite client
 *   answers `CONNECTION_CLOSED`): in PGlite 0.5.8 a statement queued inside PGlite when it closes never returns (its
 *   thread spins), so nothing may reach PGlite once closing has begun.
 * - `[[browser.scheduler.interleave]]` — while the IDX range replays in the host, API requests sent from a page-side
 *   client are answered between block transactions, with a bounded round trip; without the time slices they wait for
 *   whole steps. The replay's tables are the same either way.
 * - `[[browser.reopen.threshold]]` — at 1,000 failed statements since the store was opened the host reopens PGlite
 *   (on a directory store, so the data stays): requests are held, the engine stops at a full block and starts again
 *   with the same configuration, and the replay ends with the same tables as an uninterrupted one; the telemetry counts
 *   the reopen and the failed statements start again from zero.
 * - `[[browser.reopen.stack-depth]]` — with the count rule off, PGlite's own defect appears (every statement fails with
 *   "stack depth limit exceeded", SQLSTATE 54001, after about 1,870 failures); the first such failure reopens the store
 *   at once and the engine continues to the same tables.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { REOPEN_AFTER_FAILED_STATEMENTS } from "../browser/host.ts";
import type { HostStatus, SystemResult } from "../browser/protocol.ts";
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";
import { monitorSession } from "../browser/session.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA } from "../browser/store.ts";
import { rangeTables } from "../dev/range-tables.ts";
import { percentile } from "../engine/telemetry.ts";
import { channelClient, IDX, result, testHost, type TestHost, U1, until, untilStatus } from "./helpers/worker-host.ts";

const FAST = { sync: { idleMs: 100 }, scan: { idleMs: 100 } };

const hosts: TestHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.host.close();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function newHost(...args: Parameters<typeof testHost>): TestHost {
  const h = testHost(...args);
  hosts.push(h);
  return h;
}
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "umbradb-session-"));
  dirs.push(d);
  return d;
}

/** The 37-table digest of a host's current store. */
async function tablesOf(h: TestHost): Promise<string> {
  const s = h.opened[h.opened.length - 1]!;
  return (await rangeTables(s.mip0018, ARCHIVE_SCHEMA, MIP0018_SCHEMA)).digest.sha256;
}

/** The digest of the U1 range replayed without interruption. */
let reference: Promise<string> | undefined;
function u1Reference(): Promise<string> {
  reference ??= (async () => {
    const h = newHost();
    await result(h.host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST } });
    await untilStatus(h.host, "the U1 range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
    await result(h.host, "stop");
    return tablesOf(h);
  })();
  return reference;
}

describe("worker session monitor", () => {
  it("[[browser.session.monitor]] one turn of the event loop per time slice while statements run back to back; statements and database failures counted (with their SQLSTATE), a closed database is not a failed statement; the statement in flight is known", async () => {
    const pglite = await PGlite.create();
    let t = 0;
    let turns = 0;
    const failed: string[] = [];
    const s = monitorSession(pglite, { sliceMs: 10, now: () => t, yieldNow: async () => { turns++; }, onFailedStatement: (c) => failed.push(c) });
    for (let i = 0; i < 25; i++) {
      t += 3; // 3 ms per statement: a turn every fourth statement
      await s.query("select 1");
    }
    expect(s.counts).toMatchObject({ statements: 25, failed: 0 });
    expect(turns).toBe(6); // at 12, 24, 36, 48, 60 and 72 ms
    expect(s.counts.turns).toBe(6);

    await expect(s.query("select 1/0")).rejects.toThrow("division by zero");
    await expect(s.exec("select * from no_such_table")).rejects.toThrow("does not exist");
    expect(failed).toEqual(["22012", "42P01"]);
    expect(s.counts.failed).toBe(2);

    let seen: number | null = null;
    const slow = monitorSession(pglite, { now: () => 42, yieldNow: async () => {} });
    const q = slow.query("select pg_sleep(0.05)");
    seen = slow.statementSince;
    await q;
    expect(seen).toBe(42);
    expect(slow.statementSince).toBeNull();

    // A real turn: a timer set before a run of statements fires during it, at one of the session's first turns (the
    // statements alone never let it run). Counted in turns and statements, not milliseconds: on a slow or throttled
    // machine one statement can take longer than any fixed time bound, but the turn still comes once a slice has
    // passed. The run goes on for at least two statements after the timer fired, so it fired during the run.
    const real = monitorSession(pglite, { sliceMs: 5 });
    let fired: { turns: number; statements: number } | undefined;
    setTimeout(() => { fired = { turns: real.counts.turns, statements: real.counts.statements }; }, 0);
    const start = performance.now();
    while ((performance.now() - start < 200 || fired === undefined || real.counts.statements < fired.statements + 2) && real.counts.statements < 500) {
      await real.query("select count(*) from generate_series(1, 20000)");
    }
    expect(fired, "the timer fired while the statements ran").toBeDefined();
    expect(fired!.turns, "not before the session gave a turn").toBeGreaterThanOrEqual(1);
    expect(fired!.turns, "at one of the session's first turns").toBeLessThanOrEqual(2);
    expect(real.counts.statements).toBeGreaterThanOrEqual(fired!.statements + 2);

    await pglite.close();
    await expect(s.query("select 1")).rejects.toThrow();
    expect(s.counts.failed).toBe(2);
  }, 60_000);
});

describe("worker session close", () => {
  it("[[browser.session.close]] closing waits for the statements in flight and refuses new ones (the client answers CONNECTION_CLOSED); PGlite closes once they have ended", async () => {
    const pglite = await PGlite.create();
    const s = monitorSession(pglite, { sliceMs: Number.POSITIVE_INFINITY });
    const sql = createPgliteClient({ pglite: s, schema: "public" });
    await sql`select 1`;
    const inFlight = s.query("select count(*)::int as n from generate_series(1, 300000)");
    const closing = s.close();
    expect(s.closed).toBe(true);
    expect(pglite.closed).toBe(false);
    await expect(s.query("select 1")).rejects.toThrow("PGlite is closed");
    await expect(sql`select 1`).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
    expect((await inFlight).rows).toEqual([{ n: 300000 }]);
    await closing;
    expect(pglite.closed).toBe(true);
    expect(s.counts.failed).toBe(0);
    await s.close(); // again: the same promise, no error
  }, 30_000);
});

describe("worker scheduling", () => {
  it("[[browser.scheduler.interleave]] while the IDX range replays, a page's API requests are answered between block transactions with a bounded round trip; without the time slices they wait for whole steps; the tables are the same either way", async () => {
    const run = async (sliceMs: number) => {
      const h = newHost({ sliceMs });
      await h.host.boot();
      const { client, close } = channelClient(h.host);
      try {
        await result(h.host, "start", { config: { source: { kind: "tape", range: "idx" }, startHeight: IDX.from, ...FAST } });
        const lat: number[] = [];
        let done = false;
        const t0 = performance.now();
        const watcher = untilStatus(h.host, "the IDX range", (s) => s.cursors?.sync?.height === IDX.to && s.cursors?.scan?.nextHeight === IDX.to + 1, 120_000).then(() => { done = true; });
        while (!done) {
          const a = performance.now();
          const r = await client.api("GET", "/v1/status");
          lat.push(performance.now() - a);
          expect(r.status).toBe(200);
        }
        await watcher;
        const replayMs = performance.now() - t0;
        await result(h.host, "stop");
        const digest = await tablesOf(h);
        return { sliceMs, requests: lat.length, p50: percentile(lat, 0.5)!, p95: percentile(lat, 0.95)!, max: Math.max(...lat), replayMs, digest };
      } finally {
        close();
      }
    };
    const sliced = await run(10);
    const whole = await run(Number.POSITIVE_INFINITY);
    console.log("scheduler interleave (Node, in-memory PGlite, IDX replay)", JSON.stringify({ sliced: { ...sliced, digest: undefined }, whole: { ...whole, digest: undefined } }));
    expect(sliced.digest).toBe(whole.digest);
    expect(sliced.p95).toBeLessThan(100);
    expect(sliced.requests).toBeGreaterThan(whole.requests);
  }, 300_000);
});

describe("worker reopen", () => {
  it("[[browser.reopen.threshold]] at 1,000 failed statements since the store was opened PGlite is reopened: requests are held, the engine stops at a full block and continues with the same configuration, and the replay ends with the same tables as an uninterrupted one; the reopen is counted and the failed statements start again from zero", async () => {
    expect(REOPEN_AFTER_FAILED_STATEMENTS).toBe(1_000);
    const expected = await u1Reference();
    const h = newHost({ dataDir: tempDir() });
    const config = { source: { kind: "tape", range: "u1", finalizedHeight: U1.from + 4, advance: { everyMs: 150, by: 2 } }, startHeight: U1.from, ...FAST };
    await result(h.host, "start", { config });
    await untilStatus(h.host, "a first part", (s) => (s.cursors?.scan?.nextHeight ?? 0) > U1.from + 2);

    const first = h.opened[0]!;
    for (let i = 0; i < REOPEN_AFTER_FAILED_STATEMENTS - 1; i++) await first.mip0018`select 1/0`.catch(() => {});
    expect(h.opened).toHaveLength(1);
    // The last failure, with API requests on their way: they are held through the reopen and answered.
    const last = first.mip0018`select 1/0`.catch(() => {});
    const held = Promise.all([0, 1, 2].map(() => result<{ status: number }>(h.host, "api", { method: "GET", target: "/v1/tokens" })));
    await last;
    await until(() => h.opened.length === 2, "the reopen");
    expect((await held).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(first.pglite.closed).toBe(true);

    const end = await untilStatus(h.host, "the rest of the range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
    expect(end.engine).toMatchObject({ running: true, config, error: null });
    const snap = (await result<SystemResult>(h.host, "system", { refresh: {} })).snapshot!;
    expect(snap.engine.pgliteReopens).toBe(1);
    expect(snap.engine.failedStatementsSinceOpen).toBeLessThan(REOPEN_AFTER_FAILED_STATEMENTS);
    expect(snap.engine.failedStatementsTotal).toBeGreaterThanOrEqual(REOPEN_AFTER_FAILED_STATEMENTS);
    expect(snap.logs.some((l) => /^PGlite reopened in \d+ ms: 1000 statements failed since the store was opened$/.test(l.text))).toBe(true);
    expect(h.notices.filter((n) => n.notice === "engine").map((n) => (n as { engine: { state: string } }).engine.state), "the reopen is not a stop").toEqual(["running"]);
    await result(h.host, "stop");
    expect(await tablesOf(h)).toBe(expected);
  }, 180_000);

  it("[[browser.reopen.stack-depth]] with the count rule off PGlite's own defect appears (every statement fails with stack depth limit exceeded, 54001) after about 1,870 failures; the first such failure reopens the store at once and the engine continues to the same tables", async () => {
    const expected = await u1Reference();
    const h = newHost({ dataDir: tempDir(), reopenAfterFailedStatements: Number.POSITIVE_INFINITY });
    await result(h.host, "start", { config: { source: { kind: "tape", range: "u1", finalizedHeight: U1.from + 4, advance: { everyMs: 150, by: 2 } }, startHeight: U1.from, ...FAST } });
    await untilStatus(h.host, "a first part", (s) => (s.cursors?.scan?.nextHeight ?? 0) > U1.from + 2);
    const first = h.opened[0]!;
    let failures = 0;
    let stackDepth: string | undefined;
    while (stackDepth === undefined && failures < 3_000) {
      const e = await first.mip0018`select 1/0`.then(() => undefined, (x: { code?: string; message?: string }) => x);
      failures++;
      if (e?.code === "54001") stackDepth = e.message;
    }
    console.log("PGlite fails with 54001 at failed statement", failures, stackDepth);
    expect(stackDepth).toBe("stack depth limit exceeded");
    expect(failures).toBeGreaterThan(1_500);
    expect(failures).toBeLessThan(2_000);
    await until(() => h.opened.length === 2, "the reopen");
    await untilStatus(h.host, "the rest of the range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
    const snap = (await result<SystemResult>(h.host, "system", { refresh: {} })).snapshot!;
    expect(snap.engine.pgliteReopens).toBe(1);
    expect(snap.logs.some((l) => l.text.includes('a statement failed with "stack depth limit exceeded" (54001)'))).toBe(true);
    const s = await result<HostStatus>(h.host, "status");
    expect(s.engine).toMatchObject({ running: true, error: null });
    await result(h.host, "stop");
    expect(await tablesOf(h)).toBe(expected);
  }, 180_000);
});
