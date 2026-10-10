/**
 * The worker host's system side (`token-indexer/browser/host-system.ts`) in Node, on an in-memory PGlite with the
 * recorded U1 range: the `system` request, its notices and the page's helpers (`system-view.ts`), and the `watchdog`
 * request's heartbeat. The same in Chrome on OPFS is `browser-worker.test.ts`.
 *
 * - `[[browser.system.sources]]` — a refreshed snapshot validates against the schema, and its values equal their
 *   sources: heights and scanner equal `/v1/status`; table sizes, row estimates, exact counts and the database size
 *   equal the catalog read on the same store; the storage section equals the storage reading; per-endpoint requests
 *   equal the chain's own counts; the configuration shows the running engine's options, the watchdog limit, the
 *   build's facts and the data directory; the browser section is the capability report; the diagnostics file reads
 *   back as the same snapshot.
 * - `[[browser.system.watch]]` — the page follows snapshots while visible: notices every interval while watched;
 *   hidden (and after `pagehide`) the worker collects nothing (no statement on the session, no notice); visible again
 *   it resumes; two viewers keep collection running until both leave.
 * - `[[browser.watchdog.heartbeat]]` — after a `watchdog` request the worker posts a heartbeat every interval with the
 *   counts a replacing worker carries; carried counts show in the snapshot (restarts, last restart, reopens) and in the
 *   log; closing the host ends the heartbeat.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTapeFetch } from "../../chain-archive-sync/tape-replay.js";
import { type BuildInfo, placeholderStorage } from "../browser/host-system.ts";
import { DEFAULT_SYSTEM_VIEWER, type HostStatus, type Notice, type SystemResult } from "../browser/protocol.ts";
import { diagnosticsFile, followSystem, type PageLike } from "../browser/system-view.ts";
import { loadTape } from "../browser/tapes.ts";
import { type SystemSnapshot, SystemSnapshotSchema } from "../engine/system-snapshot.ts";
import { apiJson, channelClient, fileFetch, result, SUPPORTED, testHost, type TestHost, U1, until, untilStatus } from "./helpers/worker-host.ts";

const FAST = { sync: { idleMs: 100 }, scan: { idleMs: 100 } };
const BUILD: BuildInfo = { appCommit: "0123456789abcdef0123456789abcdef01234567", pgliteVersion: "0.5.8", ledgerVersion: "1.0.0-rc.3" };

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.host.close();
});
function newHost(...args: Parameters<typeof testHost>): TestHost {
  const h = testHost(...args);
  hosts.push(h);
  return h;
}

/** A page whose visibility the test sets. */
function fakePage(): PageLike & { show(visible: boolean): void; hide(): void } {
  let state = "visible";
  const vis = new Set<() => void>();
  const ph = new Set<() => void>();
  return {
    document: {
      get visibilityState() {
        return state;
      },
      addEventListener: (_t, l) => vis.add(l),
      removeEventListener: (_t, l) => vis.delete(l),
    },
    addEventListener: (_t, l) => ph.add(l),
    removeEventListener: (_t, l) => ph.delete(l),
    show(visible: boolean) {
      state = visible ? "visible" : "hidden";
      for (const l of [...vis]) l();
    },
    hide() {
      for (const l of [...ph]) l();
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("worker host system snapshot", () => {
  it("[[browser.system.sources]] a refreshed snapshot validates against the schema and every value equals its source: heights and scanner equal /v1/status, table sizes, estimates, exact counts and database size equal the catalog, storage equals the storage reading, endpoint requests equal the chain's counts, the configuration shows the running engine, the watchdog limit, the build and the data directory; the diagnostics file reads back equal", async () => {
    const storage = { estimate: async () => ({ usage: 123_456, quota: 9_876_543_210 }), persisted: async () => true };
    const replay = createTapeFetch(await loadTape("u1", fileFetch()));
    const { host, opened } = newHost({ build: BUILD, fetch: replay.fetchImpl, system: { storage: placeholderStorage(storage) } });
    expect(await result(host, "watchdog", { limitMs: 30_000 })).toEqual({ limitMs: 30_000, heartbeatMs: 1_000 });
    const mid = U1.from + 15;
    await result(host, "start", { config: { source: { kind: "network", nodeUrl: replay.nodeUrl, indexerUrl: replay.indexerUrl }, startHeight: U1.from, endHeight: mid, ...FAST } });
    await untilStatus(host, "the range", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === mid + 1);

    const r = await result<SystemResult>(host, "system", { refresh: { database: true, exactCounts: true } });
    expect(r).toMatchObject({ watching: false, viewers: 0 });
    const snap = SystemSnapshotSchema.parse(r.snapshot);
    const status = (await apiJson(host, "/v1/status")).body;

    // Heights and scanner: /v1/status.
    expect(snap.overview).toMatchObject({ startHeight: status.startHeight, archiveHeight: status.archiveHeight, scanHeight: status.indexedHeight });
    expect(snap.overview.archiveHeight).toBe(mid);
    expect(snap.scan).toMatchObject({ scanner: status.scanner, unresolvedEvents: status.unresolvedEvents, startHeight: U1.from, nextHeight: mid + 1 });
    expect(snap.sync).toMatchObject({ archiveStart: U1.from, archiveHeight: mid, phase: "done" });
    expect(snap.overview.health.state).not.toBe("error");

    // Catalog: read on the same store.
    const sql = opened[0]!.mip0018;
    const rows = await sql<{ schema: string; name: string; total: bigint; reltuples: number }[]>`
      SELECT n.nspname AS schema, c.relname AS name, pg_total_relation_size(c.oid) AS total, c.reltuples
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('chain_archive', 'mip0018') AND c.relkind IN ('r', 'p') ORDER BY 1, 2`;
    const tables = snap.databases.schemas.flatMap((s) => s.tables.map((t) => ({ schema: s.name, ...t })));
    expect(tables.map((t) => `${t.schema}.${t.name}`).sort()).toEqual(rows.map((x) => `${x.schema}.${x.name}`).sort());
    for (const row of rows) {
      const t = tables.find((x) => x.schema === row.schema && x.name === row.name)!;
      expect(t.totalBytes, `${row.schema}.${row.name}`).toBe(Number(row.total));
      expect(t.estimatedRows, `${row.schema}.${row.name}`).toBe(row.reltuples < 0 ? null : row.reltuples);
      const [c] = await sql<{ n: bigint }[]>`SELECT count(*) AS n FROM ${sql(row.schema)}.${sql(row.name)}`;
      expect(t.exactRows, `${row.schema}.${row.name}`).toBe(Number(c!.n));
    }
    const [settings] = await sql<{ size: bigint; version: string; fsync: string }[]>`
      SELECT pg_database_size(current_database()) AS size, current_setting('server_version') AS version, current_setting('fsync') AS fsync`;
    const { size, version, fsync } = settings!;
    expect(snap.databases).toMatchObject({ dataDir: "memory://", databaseBytes: Number(size), serverVersion: version, fsync, durability: "non-durable" });
    expect(snap.databases.schemas.map((s) => [s.name, s.migrations.map((m) => m.name)])).toEqual([
      ["chain_archive", (await result<HostStatus>(host, "status")).store!.migrations.archive],
      ["mip0018", (await result<HostStatus>(host, "status")).store!.migrations.mip0018],
    ]);

    // Storage: the reading.
    expect(snap.storage).toMatchObject({ usageBytes: 123_456, quotaBytes: 9_876_543_210, persisted: true, pauseAtBytes: null, paused: false, pausedReason: null, databaseBytes: Number(size) });

    // Endpoints: the chain's own counts.
    const by = (prefix: boolean) => [...replay.counts].filter(([op]) => op.startsWith("indexer.") === prefix).reduce((a, [, n]) => a + n, 0);
    expect(snap.sync.endpoints.node).toMatchObject({ requests: by(false), ok: by(false), inFlight: 0 });
    expect(snap.sync.endpoints.indexer).toMatchObject({ requests: by(true), ok: by(true), inFlight: 0 });

    // Configuration: the running engine's options, the watchdog, the build, the browser.
    expect(snap.configuration).toMatchObject({
      network: "stagenet",
      endpoints: { node: replay.nodeUrl, indexer: replay.indexerUrl },
      sync: { maxBlocks: 20, idleMs: 100 },
      scan: { mode: "follow", batch: 10, idleMs: 100 },
      start: { mode: "range", startHeight: U1.from, endHeight: mid, autoStart: false },
      durability: "non-durable",
      watchdogLimitMs: 30_000,
      build: { ...BUILD, postgresVersion: version, mip: status.mip, vendored: status.vendored },
    });
    expect(snap.browser).toEqual({ browser: SUPPORTED.browser, checks: SUPPORTED.checks });
    expect(snap.engine).toMatchObject({ watchdogRestarts: 0, lastWatchdogRestart: null, pgliteReopens: 0, failedStatementsSinceOpen: 0 });
    expect(snap.logs.some((l) => l.source === "host" && l.text.startsWith("store memory:// ready"))).toBe(true);
    expect(snap.logs.some((l) => l.source === "sync" && l.text.startsWith("range-complete"))).toBe(true);

    // Diagnostics: the same snapshot as JSON.
    const file = diagnosticsFile(snap);
    expect(file.name).toMatch(/^umbradb-diagnostics-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/);
    expect(file.type).toBe("application/json");
    expect(SystemSnapshotSchema.parse(JSON.parse(file.text))).toEqual(snap);
  }, 120_000);

  it("[[browser.system.watch]] the page follows snapshots while visible: a notice every interval while watched; hidden or gone (pagehide) nothing is collected — no statement, no notice; visible again it resumes; collection runs until the last of two viewers leaves", async () => {
    const { host, opened } = newHost({ systemIntervals: { countersEveryMs: 40, databaseEveryMs: 60_000 } });
    await host.boot();
    const { client, close } = channelClient(host);
    const page = fakePage();
    const seen: SystemSnapshot[] = [];
    const statements = () => opened[0]!.session.counts.statements;
    try {
      const stop = followSystem(client, { onSnapshot: (s) => seen.push(s), page });
      await until(() => seen.length >= 3, "three snapshots while visible");
      expect(seen.every((s) => s.collection.watching)).toBe(true);
      expect(seen[1]!.api.served).toBeGreaterThan(seen[0]!.api.served); // each collection reads /v1/status once

      // Hidden: the watch ends; nothing is collected afterwards.
      page.show(false);
      await until(async () => !(await client.system({ refresh: {} })).watching, "the unwatch");
      const [n, s] = [seen.length, statements()];
      await sleep(400); // ten intervals
      expect(seen.length, "no notice while hidden").toBe(n);
      expect(statements(), "no statement while hidden").toBe(s);

      // Visible again: collection resumes.
      page.show(true);
      await until(() => seen.length >= n + 2, "snapshots after showing the page again");

      // Two viewers: one leaving keeps collection running for the other.
      expect((await client.system({ watch: true, viewer: "other" })).viewers).toBe(2);
      stop();
      await until(async () => (await client.system({ refresh: {} })).viewers === 1, "one viewer left");
      const m = seen.length;
      const other: Notice[] = [];
      const off = client.onNotice((x) => { if (x.notice === "system") other.push(x); });
      await until(() => other.length >= 2, "snapshots for the other viewer");
      expect(seen.length, "the stopped follower gets no more snapshots").toBe(m);
      off();
      expect(await client.system({ watch: false, viewer: "other" })).toEqual({ watching: false, viewers: 0, snapshot: null });
      const t = statements();
      await sleep(300);
      expect(statements()).toBe(t);

      // pagehide unwatches too.
      const page2 = fakePage();
      const stop2 = followSystem(client, { onSnapshot: () => {}, page: page2, viewer: DEFAULT_SYSTEM_VIEWER });
      await until(async () => (await client.system({ refresh: {} })).watching, "the second follower's watch");
      page2.hide();
      await until(async () => !(await client.system({ refresh: {} })).watching, "the unwatch on pagehide");
      stop2();
    } finally {
      close();
    }
  }, 60_000);
});

describe("worker host watchdog heartbeat", () => {
  it("[[browser.watchdog.heartbeat]] after a watchdog request the worker posts a heartbeat every interval with the counts a replacing worker carries; carried counts show in the snapshot and the log; a new request changes the interval; closing the host ends the heartbeat", async () => {
    const { host, notices } = newHost();
    await host.boot();
    const beats = (): Array<Extract<Notice, { notice: "heartbeat" }>["heartbeat"]> =>
      notices.filter((n): n is Extract<Notice, { notice: "heartbeat" }> => n.notice === "heartbeat").map((n) => n.heartbeat);
    await sleep(100);
    expect(beats(), "no heartbeat before a watchdog request").toEqual([]);

    const restart = { at: 1_760_000_000_000, reason: "the engine worker sent nothing for 31000 ms (limit 30000 ms)" };
    const carried = { watchdogRestarts: 2, lastWatchdogRestart: restart, pgliteReopens: 1 };
    expect(await result(host, "watchdog", { limitMs: 5_000, heartbeatMs: 30, carried })).toEqual({ limitMs: 5_000, heartbeatMs: 30 });
    await until(() => beats().length >= 6, "six heartbeats");
    const b = beats();
    expect(b.map((x) => x.seq)).toEqual([...b.keys()]);
    expect(b.every((x) => JSON.stringify(x.carried) === JSON.stringify(carried))).toBe(true);
    const gaps = b.slice(1).map((x, i) => x.at - b[i]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(25);

    const snap = (await result<SystemResult>(host, "system", { refresh: {} })).snapshot!;
    expect(snap.engine).toMatchObject({ watchdogRestarts: 2, lastWatchdogRestart: restart, pgliteReopens: 1 });
    expect(snap.configuration.watchdogLimitMs).toBe(5_000);
    expect(snap.logs.some((l) => l.text === `watchdog restart: ${restart.reason}`)).toBe(true);

    await result(host, "watchdog", { limitMs: 5_000, heartbeatMs: 200 });
    const k = beats().length;
    await sleep(500);
    expect(beats().length - k).toBeLessThanOrEqual(4);
    await host.close();
    hosts.splice(0);
    const j = beats().length;
    await sleep(500);
    expect(beats().length).toBe(j);
  }, 60_000);
});
