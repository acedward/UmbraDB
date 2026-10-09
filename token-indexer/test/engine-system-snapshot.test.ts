/**
 * The `system` snapshot collected from a running engine (`token-indexer/engine/system-collector.ts`), on the test
 * database (`UMBRADB_BACKEND`: PostgreSQL 17 with autovacuum off so the catalog holds still, or in-memory PGlite, which
 * never vacuums or analyzes by itself): every value equals
 * its source (`/v1/status`, `pg_class.reltuples`, `pg_total_relation_size`, `pg_database_size`, `count(*)`,
 * `_migrations`, the fake chain's request counts, the engine's events); the statistics are read one autocommit
 * statement at a time, timed, with other work running between them; collection follows the viewers (2 s counters,
 * 30 s statistics, nothing while no one watches); the health line follows the engine through its states; and the
 * diagnostics file carries no secret.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { fakeChainFetch } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { openTestDatabase, type TestDatabase } from "../../test/helpers/test-database.ts";
import { createIndexerEngine, type EngineEvent, type EngineOptions, type EngineScheduler, type IndexerEngine } from "../engine/engine.ts";
import { createSystemCollector, type StorageReading, type SystemCollectorOptions } from "../engine/system-collector.ts";
import { type BrowserInfo, diagnosticsJson, relayedSnapshot, type SystemSnapshot, SystemSnapshotSchema } from "../engine/system-snapshot.ts";
import { createEngineTelemetry, type EngineTelemetry } from "../engine/telemetry.ts";
import { ManualClock } from "./helpers/manual-clock.ts";
import { putSyntheticBlocks } from "./helpers/synthetic-archive.ts";

const NET = "stagenet";
const U1 = { from: 715402, to: 715433 } as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Yields one macrotask before each loop step (a database and a fetch that answer without I/O never yield). */
const yielding: EngineScheduler = async (_kind, step) => {
  await new Promise((r) => setTimeout(r, 0));
  return step();
};

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function json(engine: Pick<IndexerEngine, "handle">, target: string): Promise<Json> {
  const r = await engine.handle("GET", target);
  expect(r.status, `${target}: ${r.body}`).toBe(200);
  return JSON.parse(r.body);
}

const num = (v: unknown): number => Number(v);

/** Records every tagged-template statement made through the returned client: its duration, the concurrency, and any
 *  use of a transaction, a reservation or a multi-statement text; marks each statement's end in `timeline`. */
function probe(sql: UmbraDBSql, timeline: string[] = []) {
  const statements: Array<{ text: string; ms: number }> = [];
  const forbidden: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client = new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      const result = Reflect.apply(target as never, thisArg, args) as PromiseLike<unknown>;
      const first = args[0];
      if (!Array.isArray(first) || !("raw" in first)) return result; // sql(identifier)
      const t0 = performance.now();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const done = (): void => {
        inFlight--;
        statements.push({ text: (first as string[]).join("$").replace(/\s+/g, " ").trim(), ms: performance.now() - t0 });
        timeline.push("statement");
      };
      return Promise.resolve(result).then((v) => { done(); return v; }, (e: unknown) => { done(); throw e; });
    },
    get(target, prop, receiver) {
      if (prop === "begin" || prop === "reserve" || prop === "unsafe" || prop === "file" || prop === "listen") forbidden.push(String(prop));
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as UmbraDBSql;
  return { client, statements, forbidden, maxInFlight: () => maxInFlight };
}

/** `sql` whose transactions mark their start (the session is held) and the end of their work in `timeline`. */
function transactionMarks(sql: UmbraDBSql, timeline: string[]): UmbraDBSql {
  return new Proxy(sql, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== "begin" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const cb = args[args.length - 1] as (tx: unknown) => Promise<unknown>;
        const marked = async (tx: unknown): Promise<unknown> => {
          timeline.push("tx-start");
          try {
            return await cb(tx);
          } finally {
            timeline.push("tx-end");
          }
        };
        return (value as (...a: unknown[]) => unknown).apply(target, [...args.slice(0, -1), marked]);
      };
    },
  }) as UmbraDBSql;
}

/** The catalog as the snapshot must show it. */
async function catalog(sql: UmbraDBSql, schemas: string[]) {
  const out = new Map<string, { reltuples: number; bytes: number; count: number }>();
  for (const s of schemas) {
    const rows = await sql<{ name: string; reltuples: number; bytes: unknown }[]>`
      SELECT c.relname AS name, c.reltuples, pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${s} AND c.relkind IN ('r', 'p')`;
    for (const r of rows) {
      const [c] = await sql<{ n: unknown }[]>`SELECT count(*) AS n FROM ${sql(s)}.${sql(r.name)}`;
      out.set(`${s}.${r.name}`, { reltuples: r.reltuples, bytes: num(r.bytes), count: num(c!.n) });
    }
  }
  const [d] = await sql<{ size: unknown; server_version: string; fsync: string }[]>`
    SELECT pg_database_size(current_database()) AS size, current_setting('server_version') AS server_version, current_setting('fsync') AS fsync`;
  return { tables: out, databaseBytes: num(d!.size), serverVersion: d!.server_version, fsync: d!.fsync };
}

describe("system snapshot", () => {
  let database: TestDatabase;
  const engines: IndexerEngine[] = [];
  let counter = 0;

  beforeAll(async () => {
    database = await openTestDatabase();
    if (database.backend === "postgres") {
      const admin = database.client("public");
      await admin`ALTER SYSTEM SET autovacuum = off`;
      await admin`SELECT pg_reload_conf()`;
    }
  }, 180_000);

  afterAll(async () => {
    for (const e of engines) await e.stop();
    await database?.stop();
  }, 60_000);

  function open(prefix: string): { sql: UmbraDBSql; archive: string; mip: string } {
    const n = counter++;
    const mip = `${prefix}_mip_${n}`;
    return { sql: database.client(mip), archive: `${prefix}_arch_${n}`, mip };
  }

  interface Rig {
    engine: IndexerEngine;
    telemetry: EngineTelemetry;
    options: EngineOptions;
    clock: ManualClock;
    events: EngineEvent[];
    collector(extra?: Partial<SystemCollectorOptions>): ReturnType<typeof createSystemCollector>;
  }

  function rig(db: { sql: UmbraDBSql; archive: string; mip: string }, o: Partial<EngineOptions> & { endpoints?: { node: string; indexer: string } }, clock = new ManualClock()): Rig {
    const { endpoints, ...engineOpts } = o;
    const telemetry = createEngineTelemetry({ clock, ...(endpoints === undefined ? {} : { endpoints }) });
    const options: EngineOptions = {
      sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, clock, schedule: yielding, ...engineOpts,
      ...(engineOpts.fetch === undefined ? {} : { fetch: telemetry.instrumentFetch(engineOpts.fetch) }),
    };
    const engine = createIndexerEngine(options);
    engines.push(engine);
    telemetry.attach(engine);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    return {
      engine, telemetry, options, clock, events,
      collector: (extra = {}) => createSystemCollector({
        engine, telemetry, engineOptions: options, clock, extras: { startMode: "range", autoStart: false }, ...extra,
      }),
    };
  }

  it("[[engine.system.sources]] a snapshot of an engine that synced and scanned the recorded U1 range validates against the schema, and every value equals its source: heights, scanner, unresolved events, durability and build references equal /v1/status; table sizes, row estimates, exact counts, database size, server version, fsync and migrations equal the catalog; per-endpoint requests equal the fake chain's; scan totals equal the scan events; the configuration shows the engine's effective options", async () => {
    const db = open("src");
    const c = fakeChainFetch(loadRangeTape("u1"));
    const r = rig(db, {
      fetch: c.fetch, endpoints: { node: c.nodeUrl, indexer: c.indexerUrl },
      sync: { nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl, startHeight: U1.from, endHeight: U1.to, maxBlocks: 8, backoff: { jitter: false } },
      scan: { batch: 10 },
    });
    const undrive = r.clock.drive();
    await r.engine.start();
    await until(async () => r.engine.status().sync.phase === "done" && r.engine.status().scan.phase === "idle" && (await r.engine.scanCursor())?.nextHeight === U1.to + 1, "the range to be synced and scanned");
    undrive();
    const collector = r.collector({
      dataDir: database.backend === "pglite" ? "memory://" : null,
      extras: { startMode: "range", autoStart: false, watchdogLimitMs: 30_000, build: { appCommit: "0123abc", ledgerVersion: "1.0.0-rc.3" } },
    });
    const schemas = [db.archive, db.mip];

    for (const phase of ["before ANALYZE", "after ANALYZE"]) {
      if (phase === "after ANALYZE") await db.sql`ANALYZE`;
      // PostgreSQL also counts files a new backend writes into the database directory (its relation cache file) in
      // pg_database_size: compare a snapshot taken while the size held still.
      let snap: SystemSnapshot;
      let cat: Awaited<ReturnType<typeof catalog>>;
      for (let attempt = 1; ; attempt++) {
        const [before] = await db.sql<{ size: unknown }[]>`SELECT pg_database_size(current_database()) AS size`;
        snap = await collector.refresh({ database: true, exactCounts: true });
        cat = await catalog(db.sql, schemas);
        if (num(before!.size) === cat.databaseBytes || attempt === 5) break;
      }
      expect(SystemSnapshotSchema.parse(snap)).toEqual(snap);
      const tables = snap.databases.schemas.flatMap((s) => s.tables.map((t) => [`${s.name}.${t.name}`, t] as const));
      expect(tables.map(([k]) => k).sort()).toEqual([...cat.tables.keys()].sort());
      for (const [key, t] of tables) {
        const src = cat.tables.get(key)!;
        expect(t.totalBytes, `${phase} ${key} pg_total_relation_size`).toBe(src.bytes);
        expect(t.estimatedRows, `${phase} ${key} reltuples`).toBe(src.reltuples < 0 ? null : src.reltuples);
        expect(t.exactRows, `${phase} ${key} count(*)`).toBe(src.count);
      }
      for (const s of snap.databases.schemas)
        for (const t of s.tables.filter((x) => x.kind === "partitioned")) {
          const parts = s.tables.filter((x) => x.partitionOf === t.name);
          expect(t.partitions).toEqual({
            count: parts.length,
            estimatedRows: parts.some((p) => p.estimatedRows === null) ? null : parts.reduce((a, p) => a + p.estimatedRows!, 0),
            totalBytes: parts.reduce((a, p) => a + p.totalBytes, 0),
          });
          expect(parts.length).toBeGreaterThan(0);
        }
      expect(snap.databases).toMatchObject({ databaseBytes: cat.databaseBytes, serverVersion: cat.serverVersion, fsync: cat.fsync });
      if (phase === "before ANALYZE" && database.backend === "pglite")
        expect(tables.filter(([, t]) => t.estimatedRows === null).length).toBeGreaterThan(0); // PGlite never analyzes by itself
      if (phase === "after ANALYZE")
        expect(tables.some(([k, t]) => k.startsWith(`${db.archive}.blocks_`) && (t.estimatedRows ?? 0) > 0)).toBe(true);
      for (const s of snap.databases.schemas) {
        const m = await db.sql<{ name: string }[]>`SELECT name FROM ${db.sql(s.name)}._migrations ORDER BY applied_at, name`;
        expect(s.migrations.map((x) => x.name)).toEqual(m.map((x) => x.name));
        expect(s.migrations.length).toBeGreaterThan(1);
        expect(s.exists).toBe(true);
      }
      expect(snap.databases.statements.map((x) => x.label)).toEqual([
        "settings", `tables:${db.archive}`, `migrations:${db.archive}`, `tables:${db.mip}`, `migrations:${db.mip}`,
        ...snap.databases.schemas.flatMap((s) => s.tables.map((t) => `count:${s.name}.${t.name}`)),
      ]);

      const status = await json(r.engine, "/v1/status");
      expect(snap.overview).toMatchObject({
        startHeight: status.startHeight, archiveHeight: status.archiveHeight, scanHeight: status.indexedHeight, finalizedTip: U1.to,
        lag: { blocks: 0, archiveBlocks: 0, scanBehindArchive: 0, catchUpSeconds: 0 },
      });
      expect([status.startHeight, status.archiveHeight, status.indexedHeight]).toEqual([U1.from, U1.to, U1.to]);
      expect(snap.scan).toMatchObject({ scanner: status.scanner, unresolvedEvents: status.unresolvedEvents, startHeight: U1.from, nextHeight: U1.to + 1, lagBehindArchive: 0, phase: "idle" });
      expect(snap.configuration).toMatchObject({ network: status.network, genesisHash: status.genesisHash, durability: status.durability, build: { mip: status.mip, vendored: status.vendored } });
      expect(snap.databases.durability).toBe(status.durability);
      expect(status.durability).toBe(database.backend === "pglite" ? "non-durable" : "durable");
    }

    const snap = collector.latest()!;
    // Sync: heights, tips and per-endpoint requests.
    const nodeCalls = [...c.counts].filter(([op]) => !op.startsWith("indexer")).reduce((a, [, n]) => a + n, 0);
    const indexerCalls = [...c.counts].filter(([op]) => op.startsWith("indexer")).reduce((a, [, n]) => a + n, 0);
    expect(snap.sync).toMatchObject({
      phase: "done", archiveStart: U1.from, archiveHeight: U1.to, nodeFinalizedHeight: U1.to, indexerTipHeight: U1.to, finalizedTip: U1.to,
      ingestedSinceStart: U1.to - U1.from + 1, failures: 0, lastError: null, nextAttemptAt: null,
      endpoints: { node: { requests: nodeCalls, ok: nodeCalls, inFlight: 0, retries: 0 }, indexer: { requests: indexerCalls, ok: indexerCalls, inFlight: 0, retries: 0 } },
    });
    expect(nodeCalls).toBeGreaterThan(64);
    expect(indexerCalls).toBeGreaterThan(32);
    // Scan totals: the sum of the scan's batch events.
    const batches = r.events.filter((e): e is Extract<EngineEvent, { source: "scan"; event: "batch" }> => e.source === "scan" && e.event === "batch");
    const sum = (k: "scannedBlocks" | "transactions" | "events" | "mints" | "sightings" | "actions") => batches.reduce((a, b) => a + b.fields[k], 0);
    expect(snap.scan.scannedSinceStart).toBe(sum("scannedBlocks"));
    expect(snap.scan.totals).toEqual({ transactions: sum("transactions"), events: sum("events"), mints: sum("mints"), sightings: sum("sightings"), actions: sum("actions") });
    expect(snap.scan.scannedSinceStart).toBe(U1.to - U1.from + 1);
    // API: the requests the engine answered (the collector's own /v1/status reads included; the test's last read came
    // after the snapshot).
    const answered = r.events.filter((e) => e.source === "api" && e.event === "request");
    expect(snap.api).toMatchObject({ inFlight: 0, maxConcurrentRequests: 8, busy: 0, served: answered.length - 1, byStatus: { "2xx": answered.length - 1 } });
    // Storage and engine.
    expect(snap.storage).toMatchObject({ databaseBytes: snap.databases.databaseBytes, bytesPerBlock: { store: snap.databases.databaseBytes! / 32 }, usageBytes: null, paused: false });
    expect(snap.engine).toMatchObject({ started: true, stopping: false, watchdogRestarts: 0, pgliteReopens: 0, failedStatementsSinceOpen: 0 });
    expect(snap.overview.health).toEqual({ state: "stopped", label: "stopped", reason: `the range is complete at ${U1.to}` });
    // Configuration: the engine's effective options.
    expect(snap.configuration).toMatchObject({
      endpoints: { node: c.nodeUrl, indexer: c.indexerUrl },
      schemas: { archive: db.archive, mip0018: db.mip },
      sync: { maxBlocks: 8, concurrency: 4, minIntervalMs: { node: 0, indexer: 0 }, timeoutMs: 30_000, idleMs: 10_000 },
      scan: { mode: "follow", batch: 10, idleMs: 2_000, maxBackoffMs: 60_000, fromHeight: null, toHeight: null },
      retry: { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 8, jitter: false },
      start: { mode: "range", startHeight: U1.from, endHeight: U1.to, autoStart: false },
      watchdogLimitMs: 30_000,
      api: { maxConcurrentRequests: 8 },
      build: { appCommit: "0123abc", ledgerVersion: "1.0.0-rc.3", postgresVersion: snap.databases.serverVersion, pgliteVersion: database.backend === "pglite" ? "0.5.8" : null },
    });
    expect(snap.databases.dataDir).toBe(database.backend === "pglite" ? "memory://" : null);
    // Logs: the latest first, the engine's lines.
    expect(snap.logs[snap.logs.length - 1]!.text.startsWith("start ")).toBe(true);
    expect(snap.logs.map((l) => l.seq)).toEqual([...snap.logs.map((l) => l.seq)].sort((a, b) => b - a));
    await r.engine.stop();
  }, 240_000);

  it("[[engine.system.cost]] the statistics are read one autocommit statement at a time — no transaction, reservation or multi-statement text, never two at once — each one timed; on PGlite another request's transaction runs on the session between two of them and none runs inside one", async () => {
    const timeline: string[] = [];
    const base = open("cost");
    const db = { ...base, sql: transactionMarks(base.sql, timeline) };
    const c = fakeChainFetch(loadRangeTape("u1"));
    const r = rig(db, {
      fetch: c.fetch, endpoints: { node: c.nodeUrl, indexer: c.indexerUrl },
      sync: { nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl, startHeight: U1.from, endHeight: U1.to, backoff: { jitter: false } },
      scan: {},
    });
    const undrive = r.clock.drive();
    await r.engine.start();
    await until(async () => r.engine.status().sync.phase === "done" && (await r.engine.scanCursor())?.nextHeight === U1.to + 1, "the range");
    undrive();
    await until(() => r.engine.status().scan.phase === "idle", "the scan to idle");

    const p = probe(base.sql, timeline);
    let api: Promise<unknown> | undefined;
    const collector = r.collector({
      sql: p.client,
      between: async () => {
        if (api === undefined) {
          timeline.push("between");
          api = r.engine.handle("GET", "/v1/tokens").then((x) => { timeline.push(`api ${x.status}`); });
        }
        await new Promise((res) => setTimeout(res, 0));
      },
    });
    timeline.length = 0;
    const snap = await collector.refresh({ database: true, exactCounts: true });
    await api;

    expect(p.forbidden).toEqual([]);
    expect(p.maxInFlight()).toBe(1);
    expect(p.statements.length).toBe(snap.databases.statements.length);
    expect(snap.databases.statements.length).toBeGreaterThan(5);
    for (const s of snap.databases.statements) expect(s.ms, s.label).toBeLessThan(2_000);
    const ms = snap.databases.statements.map((s) => s.ms);
    const catalogMs = snap.databases.statements.filter((s) => !s.label.startsWith("count:")).map((s) => s.ms);
    console.info(`system-snapshot statement cost ${JSON.stringify({
      backend: database.backend, statements: ms.length, catalogStatements: catalogMs.length,
      catalogMaxMs: Number(Math.max(...catalogMs).toFixed(2)), catalogTotalMs: Number(catalogMs.reduce((a, b) => a + b, 0).toFixed(2)),
      countMaxMs: Number(Math.max(...ms.slice(catalogMs.length)).toFixed(2)), allTotalMs: Number(ms.reduce((a, b) => a + b, 0).toFixed(2)),
    })}`);

    if (database.backend === "pglite") {
      // One session: no statistics statement ends while a transaction holds it (the collector's own /v1/status read is
      // one of the API's transactions).
      let held = 0;
      for (const t of timeline) {
        if (t === "tx-start") held++;
        else if (t === "tx-end") held--;
        else if (t === "statement") expect(held, timeline.join(" ")).toBe(0);
      }
      // One session: the request made between two statistics statements runs its whole transaction before the next one.
      const between = timeline.indexOf("between");
      const txStart = timeline.indexOf("tx-start", between);
      const txEnd = timeline.indexOf("tx-end", txStart);
      const next = timeline.indexOf("statement", between);
      expect(between, timeline.join(" ")).toBeGreaterThan(0);
      expect([txStart > between, txEnd > txStart, next > txEnd], timeline.join(" ")).toEqual([true, true, true]);
    }
    await r.engine.stop();
  }, 240_000);

  it("[[engine.system.visibility]] collection follows the viewers: nothing while no one watches (no statement, no request, no timer); a viewer gets a snapshot at once, then one every 2 s with the catalog read again every 30 s; when the last viewer leaves collection stops, and a new viewer starts it again; a refresh on demand still works", async () => {
    const db = open("vis");
    const clock = new ManualClock();
    const r = rig(db, {}, clock); // the API alone
    const p = probe(db.sql);
    const collector = r.collector({ sql: p.client, countersEveryMs: 2_000, databaseEveryMs: 30_000 });
    const served = (): number => r.telemetry.counters().api.served;

    await new Promise((res) => setTimeout(res, 20));
    expect([collector.watching(), p.statements.length, served(), clock.waiting.length, collector.latest()]).toEqual([false, 0, 0, 0, null]);

    const got: SystemSnapshot[] = [];
    const unwatch = collector.watch((s) => got.push(s));
    await until(() => got.length === 1 && clock.waiting.length === 1, "the first snapshot");
    const perRead = p.statements.length;
    expect(perRead).toBe(3); // settings and two schemas without tables
    expect([served(), clock.waiting]).toEqual([1, [2_000]]);
    expect(got[0]!.collection).toMatchObject({ watching: true, countersEveryMs: 2_000, databaseEveryMs: 30_000, statusError: null });
    for (let i = 1; i < 15; i++) {
      clock.next();
      await until(() => got.length === i + 1 && clock.waiting.length === 1, `snapshot ${i + 1}`);
      expect(p.statements.length, `no catalog read at ${2 * i} s`).toBe(perRead);
    }
    expect(served()).toBe(15);
    clock.next(); // 30 s
    await until(() => got.length === 16 && clock.waiting.length === 1, "snapshot 16");
    expect(p.statements.length).toBe(2 * perRead);
    expect(got[15]!.generatedAt - got[0]!.generatedAt).toBe(30_000);
    expect(got[15]!.databases.collectedAt).toBe(got[15]!.generatedAt);
    expect(got[14]!.databases.collectedAt).toBe(got[0]!.generatedAt);

    unwatch();
    await until(() => clock.waiting.length === 0, "the collector's timer to end");
    const before = [p.statements.length, served(), got.length];
    clock.advance(600_000);
    await new Promise((res) => setTimeout(res, 50));
    expect([p.statements.length, served(), got.length, collector.watching()]).toEqual([...before, false]);

    const again: SystemSnapshot[] = [];
    const unwatch2 = collector.watch((s) => again.push(s));
    await until(() => again.length === 1, "a snapshot for the new viewer");
    expect(p.statements.length).toBe(3 * perRead); // the catalog read was due again
    unwatch2();
    await until(() => clock.waiting.length === 0, "the timer to end again");
    const onDemand = await collector.refresh();
    expect(onDemand.collection.watching).toBe(false);
    expect(served()).toBe(18);
    collector.close();
    expect(() => collector.watch(() => {})).toThrow("closed");
  }, 120_000);

  it("[[engine.system.states]] the health line follows the engine: catching up while the archive and the scan are behind the tip, following at the tip, waiting (network) while a call is retried and while the sync backs off after a network failure (with the last error and the next attempt), stalled (scan) after a failed scan step, paused (quota) from the host's storage reading, error from a fatal failure, stopped; watchdog restarts are counted; a follower shows the leader's snapshot", async () => {
    // Catching up, then following: a sync that stops after its first batch until let go.
    {
      const db = open("follow");
      const c = fakeChainFetch(loadRangeTape("u1"));
      let gate!: () => void;
      const held = new Promise<void>((res) => { gate = res; });
      let batches = 0;
      const schedule: EngineScheduler = async (kind, step) => {
        await new Promise((res) => setTimeout(res, 0));
        if (kind === "sync" && batches++ === 1) await held;
        return step();
      };
      const r = rig(db, {
        fetch: c.fetch, endpoints: { node: c.nodeUrl, indexer: c.indexerUrl }, schedule,
        sync: { nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl, startHeight: U1.from, maxBlocks: 4 }, scan: {},
      });
      const undrive = r.clock.drive();
      const collector = r.collector({ extras: { startMode: "tip", autoStart: true } });
      expect((await collector.refresh()).overview.health.state).toBe("stopped");
      await r.engine.start();
      await until(async () => batches === 2 && (await r.engine.scanCursor())?.nextHeight === U1.from + 4, "the first batch to be scanned");
      let s = await collector.refresh();
      expect(s.overview).toMatchObject({ health: { state: "catching-up" }, finalizedTip: U1.to, archiveHeight: U1.from + 3, scanHeight: U1.from + 3, lag: { blocks: U1.to - U1.from - 3, archiveBlocks: U1.to - U1.from - 3 } });
      expect(s.overview.health.reason).toBe(`${U1.to - U1.from - 3} blocks behind ${U1.to}`);
      gate();
      await until(async () => r.engine.status().sync.phase === "idle" && (await r.engine.scanCursor())?.nextHeight === U1.to + 1, "the tip");
      await until(() => r.engine.status().scan.phase === "idle", "the scan to idle");
      undrive();
      s = await collector.refresh();
      expect(s.overview).toMatchObject({ health: { state: "following", label: "following" }, lag: { blocks: 0 }, scanHeight: U1.to });
      expect(s.configuration.start).toEqual({ mode: "tip", startHeight: U1.from, endHeight: null, autoStart: true });
      // Quota pause, a fatal failure, a watchdog restart and the follower view on the same engine.
      const reading: StorageReading = { usageBytes: 9_500, quotaBytes: 10_000, persisted: true, pauseAtBytes: 9_000, paused: true, pausedReason: "usage 9500 of 10000 bytes" };
      const paused = r.collector({ storage: async () => reading });
      s = await paused.refresh();
      expect(s.overview.health).toEqual({ state: "paused-quota", label: "paused (quota)", reason: "usage 9500 of 10000 bytes" });
      expect(s.storage).toMatchObject({ usageBytes: 9_500, quotaBytes: 10_000, persisted: true, pauseAtBytes: 9_000, paused: true, estimatedAt: s.generatedAt });
      r.telemetry.noteWatchdogRestart("a statement ran past 30000 ms");
      r.telemetry.noteFatal("the database did not open");
      s = await collector.refresh();
      expect(s.overview.health).toEqual({ state: "error", label: "error", reason: "the database did not open" });
      expect(s.engine).toMatchObject({ watchdogRestarts: 1, lastWatchdogRestart: { reason: "a statement ran past 30000 ms" } });
      expect(s.logs[1]!.text).toBe("watchdog restart: a statement ran past 30000 ms");
      r.telemetry.noteFatal(null);
      const follower = relayedSnapshot(s, s.generatedAt + 5);
      expect([follower.role, follower.relayedAt, follower.overview]).toEqual(["follower", s.generatedAt + 5, s.overview]);
      expect((await r.collector({ role: () => "follower" }).refresh()).role).toBe("follower");
      await r.engine.stop();
      expect((await collector.refresh()).overview.health).toEqual({ state: "stopped", label: "stopped", reason: "the engine is stopping or stopped" });
    }

    // Waiting (network): the node and the indexer do not answer.
    {
      const db = open("down");
      const c = fakeChainFetch(loadRangeTape("u1"));
      const down: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
      const r = rig(db, {
        fetch: down, endpoints: { node: c.nodeUrl, indexer: c.indexerUrl },
        sync: { nodeUrl: c.nodeUrl, indexerUrl: c.indexerUrl, startHeight: U1.from, backoff: { maxAttempts: 2, baseDelayMs: 1_000, jitter: false } },
        scan: {},
      });
      const collector = r.collector();
      await r.engine.start();
      await until(() => r.clock.waiting.includes(1_000), "the retry's wait");
      let s = await collector.refresh();
      expect(s.overview.health).toMatchObject({ state: "waiting-network", label: "waiting (network)" });
      expect(s.overview.health.reason).toBe(`chain_getFinalizedHead: request to ${c.nodeUrl} failed`);
      expect(s.sync).toMatchObject({ phase: "running", nextAttemptAt: s.generatedAt + 1_000, endpoints: { node: { requests: 1, transportErrors: 1, retries: 1 } } });
      r.clock.advance(1_000); // the retry fails too: the batch fails and the loop backs off
      await until(() => r.engine.status().sync.phase === "backoff", "the sync to back off");
      s = await collector.refresh();
      expect(s.overview.health.state).toBe("waiting-network");
      expect(s.sync).toMatchObject({ phase: "backoff", failures: 1, nextAttemptAt: r.engine.status().sync.waitUntil, endpoints: { node: { requests: 2, transportErrors: 2 } } });
      expect(s.sync.lastError?.message).toContain(`request to ${c.nodeUrl} failed`);
      expect(s.sync.lastError?.at).toBe(s.generatedAt);
      await r.engine.stop();
    }

    // Stalled (scan): an archived transaction that is not a ledger transaction.
    {
      const db = open("stall");
      await bootstrapChainArchiveSchema(db.sql, db.archive);
      await putSyntheticBlocks(db.sql, db.archive, NET, 50, [[{ result: "success", tx: { hash: "c3".repeat(32), intents: [] } }]]);
      const r = rig(db, { scan: { idleMs: 2_000 } });
      const collector = r.collector();
      await r.engine.start();
      await until(() => r.engine.status().scan.phase === "backoff", "the scan to fail");
      const s = await collector.refresh();
      expect(s.overview.health.state).toBe("stalled-scan");
      expect(s.overview.health.reason).toContain("c3c3");
      expect(s.scan).toMatchObject({ scanner: "stalled", phase: "backoff", failures: 1, nextAttemptAt: r.engine.status().scan.waitUntil });
      expect(s.scan.lastError?.message).toContain("c3c3");
      expect(s.logs[0]).toMatchObject({ source: "scan", level: "error" });
      await r.engine.stop();
    }
  }, 240_000);

  it("[[engine.system.diagnostics]] the diagnostics file holds no secret from hostile configuration, errors and log lines (URL credentials and query secrets, API keys, tokens, passwords, cookies), keeps hostile text as text (control, bidirectional and markup characters), validates against the schema and reads back equal; host data outside the schema (a browsing history) is refused", async () => {
    const db = open("diag");
    const nodeUrl = "https://alice:SECRET-PW@rpc.example.test/rpc?apikey=SECRET-KEY#SECRET-FRAG";
    const indexerUrl = "https://indexer.example.test/api/v4/graphql?token=SECRET-TOKEN";
    const r = rig(db, { fetch: () => Promise.reject(new TypeError("never called")), endpoints: { node: nodeUrl, indexer: indexerUrl }, sync: { nodeUrl, indexerUrl }, scan: {} });
    const hostile = "\u0000\u001b[31m‮evil‬ <img src=x onerror=alert(1)> ​";
    r.telemetry.log("error", "host", `fetch ${nodeUrl} failed: Authorization: Bearer SECRET-BEARER`);
    r.telemetry.log("warn", "host", `retry with api_key=SECRET-API and {"password":"SECRET-JSON"} cookie: session=SECRET-COOKIE`);
    r.telemetry.log("info", "host", hostile);
    r.telemetry.noteFatal(`open failed: postgres://u:SECRET-DB@db/x ${hostile}`);
    const browser: BrowserInfo = { browser: "Google Chrome 153", checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: true } };
    const collector = r.collector({ browser: () => browser, connectedTabs: () => 2, dataDir: "opfs-ahp://umbradb" });
    const snap = await collector.refresh({ database: true });
    const file = diagnosticsJson(snap);
    expect(file).not.toMatch(/SECRET/);
    expect(file).not.toContain("alice");
    const back = SystemSnapshotSchema.parse(JSON.parse(file));
    expect(back).toEqual(snap);
    expect(back.configuration.endpoints).toEqual({ node: "https://rpc.example.test/rpc", indexer: "https://indexer.example.test/api/v4/graphql" });
    expect(back.logs.find((l) => l.source === "host" && l.level === "info")!.text).toBe(hostile);
    expect(back.overview.health.reason).toBe(`open failed: postgres://db/x ${hostile}`);
    expect(back.browser).toEqual(browser);
    expect(back.engine.connectedTabs).toBe(2);
    expect(back.databases.dataDir).toBe("opfs-ahp://umbradb");

    const leaky = r.collector({ browser: () => ({ ...browser, history: ["https://bank.example/"] }) as unknown as BrowserInfo });
    await expect(leaky.refresh()).rejects.toThrow(/unrecognized key/i);
  }, 120_000);
});
