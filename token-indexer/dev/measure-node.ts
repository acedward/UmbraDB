/**
 * Node measurements beside the browser build's (`token-indexer/browser/MEASUREMENTS.md`). Development tool, not a
 * test: it prints JSON lines on stdout.
 *
 *   PG_URL=postgres://… node --import tsx token-indexer/dev/measure-node.ts replay postgresql [--node-batches]
 *   node --import tsx token-indexer/dev/measure-node.ts replay pglite-dir|pglite-memory
 *   node --import tsx token-indexer/dev/measure-node.ts planner pglite [N]
 *   PG_URL=postgres://… node --import tsx token-indexer/dev/measure-node.ts planner postgresql [N]
 *
 * - `replay`: one replay of the recorded IDX range (714485–715183, 699 blocks) from its tape (no network), timed by
 *   the engine itself: its sync `start` event to the scan step that reached 715183. `postgresql` runs the engine
 *   (`../engine/engine.ts`) on PostgreSQL in new schemas, with the browser's batch sizes (20 heights per sync batch, 10
 *   blocks per scan step) or, with `--node-batches`, the Node commands' (200 / 100); `pglite-dir` and `pglite-memory` run
 *   the browser's worker host (`../browser/host.ts`, its scheduler and session included) in Node, PGlite on a new
 *   directory or in memory. Then the digests are checked and the store's growth is read (`pg_total_relation_size` of
 *   both schemas; on PGlite also `pg_database_size` and, on a directory, its files). Run it once per process.
 * - `planner`: the cost of the activity listings and the API's latency on a large store: contract Y mints token T,
 *   publishes its metadata N times (default 100 000), withdraws it and emits one rejected event; a second identity of
 *   the same contract then publishes N times (seeded as `token-indexer/test/helpers/hidden-history.ts` does). Each
 *   listing's statements are run again under `EXPLAIN (ANALYZE, BUFFERS)` in one read-only transaction (their
 *   transaction-local planner settings applied), and the buffers they read are compared with the bound
 *   `100 + 20 × rows the page may read`; the API routes are timed through the handler (20 requests each). Four planner
 *   states: `natural` (never vacuumed or analyzed: PGlite runs no autovacuum, so a browser store stays in it),
 *   `vacuumed` (the three listing tables vacuumed, no column statistics), `fresh` (every table analyzed) and `stale`
 *   (the listed events analyzed while they held two live rows, then filled again). On PostgreSQL the scenario's tables
 *   have autovacuum off.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { archiveDigest, dumpArchive } from "../../chain-archive-sync/archive-digest.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { createTapeFetch } from "../../chain-archive-sync/tape-replay.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";
import { loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import type { DigestResult, HostStatus } from "../browser/protocol.ts";
import { createIndexerEngine, type EngineEvent } from "../engine/engine.ts";
import { rangeTables } from "../engine/range-tables.ts";
import type { SystemSnapshot } from "../engine/system-snapshot.ts";
import { activityForColor, type ActivityItem, metadataTransactionsForContract, transactionActivity, writeActivity } from "../mip0018/activity.ts";
import { createMip0018Handler } from "../mip0018/api.ts";
import { tokenColor } from "../mip0018/color.ts";
import type { Queryable } from "../mip0018/fields.ts";
import { eventAt, seedPublishes, txHashAt, writeMetadataTx } from "../test/helpers/hidden-history.ts";
import { syntheticActivityTx } from "../test/helpers/synthetic-activity.ts";
import { result, testHost } from "../test/helpers/worker-host.ts";
import { record } from "../vendor/mip0018/codec/src/index.ts";

const FROM = 714485;
const TO = 715183;
const BLOCKS = TO - FROM + 1;
const ARCHIVE_SHA = "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119";
const TABLES_SHA = "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c";
const NET = "stagenet";
const [command = "", target = "", third] = process.argv.slice(2);
const print = (o: object): void => console.log(JSON.stringify({ command, target, at: new Date().toISOString(), load: loadavg(), ...o }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const round2 = (x: number) => Math.round(x * 100) / 100;

// ── Replay ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function relationBytes(sql: UmbraDBSql, schemas: string[]): Promise<number> {
  const [r] = await sql<{ b: string }[]>`
    SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::text AS b FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(${schemas}) AND c.relkind IN ('r', 'p', 'm')`;
  return Number(r!.b);
}

async function replayPostgresql(nodeBatches: boolean): Promise<void> {
  const tag = `measure_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const archive = `${tag}_archive`;
  const mip = `${tag}_mip`;
  const sql = createClient({ connectionString: process.env.PG_URL, schema: mip });
  try {
    await bootstrapChainArchiveSchema(sql, archive);
    await runMigrations(sql, { schema: mip, migrations: mip0018Migrations });
    const empty = await relationBytes(sql, [archive, mip]);
    const tape = createTapeFetch(loadRangeTape("idx"));
    const events: EngineEvent[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const isLastScan = (e: EngineEvent) => e.source === "scan" && e.event === "batch" && (e.fields as { toHeight?: number }).toHeight === TO;
    const engine = createIndexerEngine({
      sql, network: NET, schema: mip, archiveSchema: archive, fetch: tape.fetchImpl,
      sync: { nodeUrl: tape.nodeUrl, indexerUrl: tape.indexerUrl, startHeight: FROM, endHeight: TO, maxBlocks: nodeBatches ? 200 : 20, idleMs: 200 },
      scan: { mode: "follow", batch: nodeBatches ? 100 : 10, idleMs: 200 },
      onEvent: (e) => { events.push(e); if (isLastScan(e)) done(); },
    });
    await engine.start();
    await finished;
    await engine.stop();
    const start = events.find((e) => e.source === "sync" && e.event === "start")!;
    const syncDone = events.find((e) => e.source === "sync" && e.event === "batch" && (e.fields as { to?: number }).to === TO);
    const engineMs = events.find(isLastScan)!.at - start.at;
    const full = await relationBytes(sql, [archive, mip]);
    const digests = { archive: archiveDigest(await dumpArchive(sql, archive)).sha256 === ARCHIVE_SHA, tables: (await rangeTables(sql, archive, mip)).digest.sha256 === TABLES_SHA };
    const [v] = await sql<{ v: string }[]>`SELECT current_setting('server_version') AS v`;
    await sql.unsafe(`DROP SCHEMA "${mip}" CASCADE`);
    await sql.unsafe(`DROP SCHEMA "${archive}" CASCADE`);
    print({
      server: `PostgreSQL ${v!.v}`, batches: nodeBatches ? "200/100" : "20/10", engineMs, syncMs: (syncDone?.at ?? NaN) - start.at, blocksPerSecond: BLOCKS / (engineMs / 1000),
      relationBytes: { empty, full, perBlock: (full - empty) / BLOCKS }, digests,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function du(dir: string): { bytes: number; files: number } {
  return {
    bytes: Number(execFileSync("du", ["-sb", dir], { encoding: "utf8" }).split("\t")[0]),
    files: Number(execFileSync("sh", ["-c", `find '${dir}' -type f | wc -l`], { encoding: "utf8" }).trim()),
  };
}

async function replayPglite(onDisk: boolean): Promise<void> {
  const dir = onDisk ? mkdtempSync(join(tmpdir(), "umbradb-measure-pglite-")) : undefined;
  const { host } = testHost({ dataDir: dir ?? "memory://" });
  try {
    const boot = await host.boot();
    if (boot.phase !== "ready") throw new Error(boot.error ?? boot.phase);
    const status = await result<HostStatus>(host, "status");
    const snapshot = async () => (await result<{ snapshot: SystemSnapshot }>(host, "system", { refresh: { database: true } })).snapshot;
    const relations = (s: SystemSnapshot) => s.databases.schemas.reduce((a, sc) => a + sc.tables.reduce((b, t) => b + t.totalBytes, 0), 0);
    const empty = await snapshot();
    const diskEmpty = dir === undefined ? null : du(dir);
    await result(host, "start", { config: { source: { kind: "tape", range: "idx" }, startHeight: FROM, endHeight: TO, sync: { idleMs: 200 }, scan: { idleMs: 200 } } });
    for (;;) {
      const s = await result<HostStatus>(host, "status");
      if (s.cursors?.scan?.nextHeight === TO + 1) break;
      if (s.engine?.error) throw new Error(s.engine.error);
      await sleep(250);
    }
    const full = await snapshot();
    const lines = [...full.logs].reverse();
    const start = lines.find((l) => l.source === "sync" && l.text.startsWith("start "))!;
    const syncDone = lines.find((l) => l.source === "sync" && l.text.startsWith("batch ") && JSON.parse(l.text.slice(6)).to === TO);
    const scanDone = lines.find((l) => l.source === "scan" && l.text.startsWith("batch ") && JSON.parse(l.text.slice(6)).toHeight === TO)!;
    const engineMs = scanDone.at - start.at;
    const digest = await result<DigestResult>(host, "digest");
    await result(host, "stop");
    print({
      server: status.store?.serverVersion, boot: boot.timings, engineMs, syncMs: (syncDone?.at ?? NaN) - start.at, blocksPerSecond: BLOCKS / (engineMs / 1000),
      databaseBytes: { empty: empty.databases.databaseBytes, full: full.databases.databaseBytes, perBlock: (full.databases.databaseBytes! - empty.databases.databaseBytes!) / BLOCKS },
      relationBytes: { empty: relations(empty), full: relations(full), perBlock: (relations(full) - relations(empty)) / BLOCKS },
      largestTables: full.databases.schemas.flatMap((sc) => sc.tables.map((t) => ({ table: `${sc.name}.${t.name}`, bytes: t.totalBytes })))
        .sort((a, b) => b.bytes - a.bytes).slice(0, 8),
      files: dir === undefined ? null : { empty: diskEmpty, full: du(dir) },
      digests: { archive: digest.archive.sha256 === ARCHIVE_SHA, tables: digest.tables.sha256 === TABLES_SHA },
    });
  } finally {
    await host.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

// ── Planner ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function planner(backend: string, N: number): Promise<void> {
  const mip = "measure_planner_mip";
  const archive = "measure_planner_archive";
  const captured: Array<{ text: string; params: unknown[] }> = [];
  let capturing = false;
  const debug = (_id: unknown, text: string, params: readonly unknown[]) => { if (capturing) captured.push({ text, params: [...params] }); };
  let sql: UmbraDBSql;
  let close: () => Promise<void>;
  let dir: string | undefined;
  if (backend === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    dir = mkdtempSync(join(tmpdir(), "umbradb-measure-planner-"));
    const pglite = await PGlite.create({ dataDir: dir });
    sql = createPgliteClient({ pglite, schema: mip, debug }) as unknown as UmbraDBSql;
    close = async () => { await pglite.close(); };
  } else if (backend === "postgresql") {
    const raw = postgres(process.env.PG_URL!, { max: 1, debug, connection: { search_path: mip }, types: { bigint: postgres.BigInt }, onnotice: () => {} });
    await raw.unsafe(`DROP SCHEMA IF EXISTS ${mip} CASCADE`);
    await raw.unsafe(`DROP SCHEMA IF EXISTS ${archive} CASCADE`);
    sql = Object.assign(raw, { umbradbSchema: mip }) as unknown as UmbraDBSql;
    close = async () => { await raw.end({ timeout: 5 }); };
  } else throw new Error("planner: pglite or postgresql");
  try {
    const server = (await sql<{ v: string }[]>`SELECT version() AS v`)[0]!.v;
    const s = sql(mip);
    await bootstrapChainArchiveSchema(sql, archive);
    await runMigrations(sql, { schema: mip, migrations: mip0018Migrations });
    const baseTables = async () => (await sql<{ t: string }[]>`
      SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ${mip} AND table_type = 'BASE TABLE'`).map((x) => x.t);
    if (backend === "postgresql") for (const t of await baseTables()) await sql.unsafe(`ALTER TABLE "${mip}"."${t}" SET (autovacuum_enabled = false)`);

    const Y = { network: NET, contract: "c4".repeat(32), domainSep: "d4".repeat(32), kind: 1 as const };
    const Z = { ...Y, domainSep: "d5".repeat(32), kind: 3 as const };
    const T = tokenColor(Y.domainSep, Y.contract);
    const seed0 = now();
    await sql`
      INSERT INTO ${s}.mip0018_mints (network, block_height, tx_index, mint_index, tx_hash, phase, segment_id, action_index, contract_address, domain_sep, kind, amount, color)
      VALUES (${NET}, 999, 0, 0, ${Buffer.from(txHashAt(999), "hex")}, 'guaranteed', 1, 0, ${Buffer.from(Y.contract, "hex")}, ${Buffer.from(Y.domainSep, "hex")}, 1, 100, ${Buffer.from(T, "hex")})`;
    await writeActivity(sql as unknown as Queryable, mip, transactionActivity({
      network: NET, height: 999, txIndex: 0, txHash: txHashAt(999), outcome: { result: "success", segments: null }, events: [],
      tx: syntheticActivityTx({ hash: txHashAt(999), intents: [{ segment: 1, calls: [{ address: Y.contract, entryPoint: "mint", guaranteed: { shieldedMints: [[Y.domainSep, "100"]] } }] }] }),
    }));
    await seedPublishes(sql, mip, Y, 1000, N);
    const w0 = now();
    await sql.begin((tx) => writeMetadataTx(tx as unknown as Queryable, mip, [eventAt(Y, 1000 + N, [record.tombstone("name")])]));
    const withdrawMs = now() - w0;
    await sql.begin((tx) => writeMetadataTx(tx as unknown as Queryable, mip, [eventAt(Y, 1001 + N, "reject")]));
    await seedPublishes(sql, mip, Z, 200_000, N);
    const count = async (table: string) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${s}.${sql(table)} WHERE network = ${NET}`)[0]!.n);
    const databaseBytes = async () => Number((await sql<{ b: string }[]>`SELECT pg_database_size(current_database())::text AS b`)[0]!.b);
    print({ server, N, seedMs: round2(now() - seed0), withdrawMs: round2(withdrawMs), rows: { events: await count("mip0018_events"), activity: await count("mip0018_activity"), listed: await count("mip0018_listed_events") }, databaseBytes: await databaseBytes() });

    /** A listing's captured statements under EXPLAIN in one read-only transaction (its set_config statements run as
     *  they are); the buffers every statement read (shared hit + read), summed, and each plan's node path. */
    const explain = async (statements: typeof captured) => {
      let buffers = 0;
      let ms = 0;
      let planningMs = 0;
      const plans: string[] = [];
      await sql.begin("read only", async (tx) => {
        for (const st of statements) {
          if (/^\s*(begin|commit|rollback|savepoint|release|set transaction)/i.test(st.text)) continue;
          if (st.text.includes("set_config(")) {
            await tx.unsafe(st.text, st.params as never[]);
            continue;
          }
          const [row] = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${st.text}`, st.params as never[]);
          const top = (Object.values(row as Record<string, unknown>)[0] as Array<{ Plan: Record<string, unknown>; "Planning Time"?: number; "Execution Time"?: number }>)[0]!;
          const plan = top.Plan;
          buffers += Number(plan["Shared Hit Blocks"] ?? 0) + Number(plan["Shared Read Blocks"] ?? 0);
          ms += Number(top["Planning Time"] ?? 0) + Number(top["Execution Time"] ?? 0);
          planningMs += Number(top["Planning Time"] ?? 0);
          const nodes: string[] = [];
          const walk = (p: Record<string, unknown>) => {
            nodes.push(`${p["Node Type"]}${p["Index Name"] ? `(${p["Index Name"]})` : p["Relation Name"] ? `(${p["Relation Name"]})` : ""}`);
            for (const c of (p.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
          };
          walk(plan);
          plans.push(nodes.join(">"));
        }
      });
      return { buffers, plans, ms, planningMs };
    };
    const label = (i: ActivityItem) => `${i.height}:${i.role === "metadata-event" ? `${i.events!.accepted}/${i.events!.rejected}` : i.role}`;
    const measure = async (state: string, q: string, read: () => Promise<{ items: ActivityItem[]; nextCursor?: string }>, rowsRead: number) => {
      captured.length = 0;
      capturing = true;
      const t0 = now();
      const page = await read();
      const ms = now() - t0;
      capturing = false;
      const statements = [...captured];
      const { buffers, plans } = await explain(statements);
      const bound = 100 + 20 * rowsRead;
      const items = page.items.map(label);
      print({ state, q, ms: round2(ms), buffers, bound, withinBound: buffers <= bound, statements: statements.length, items: items.length, first: items[0], plans });
      return page;
    };
    const contract = (o: Parameters<typeof metadataTransactionsForContract>[3]) => () => metadataTransactionsForContract(sql as unknown as Queryable, NET, Y.contract, o, mip);
    const colorOf = (o: Parameters<typeof activityForColor>[3]) => () => activityForColor(sql as unknown as Queryable, NET, T, o, mip);
    const pages = async (state: string) => {
      await measure(state, "contract limit=1", contract({ limit: 1 }), 2);
      const first = await measure(state, "contract limit=100", contract({ limit: 100 }), 101);
      await measure(state, "contract limit=100 page 2", contract({ limit: 100, cursor: first.nextCursor! }), 101);
      await measure(state, "contract limit=1 desc", contract({ limit: 1, order: "desc" }), 2);
      await measure(state, "color limit=100 desc", colorOf({ limit: 100, order: "desc" }), 202);
      const colorFirst = await measure(state, "color limit=1", colorOf({ limit: 1 }), 4);
      await measure(state, "color limit=2 page 2", colorOf({ limit: 2, cursor: colorFirst.nextCursor! }), 6);
    };
    const handler = createMip0018Handler({ sql, network: NET, schema: mip, archiveSchema: archive });
    const routes = [
      "/v1/status", "/v1/tokens?limit=50", `/v1/tokens/${T}`, `/v1/tokens/${T}/activity?limit=50`, `/v1/tokens/${T}/activity?limit=100&order=desc`,
      `/v1/contracts/${Y.contract}/tokens?limit=50`, `/v1/contracts/${Y.contract}/activity?limit=50`, `/v1/contracts/${Y.contract}/activity?limit=100&order=desc`,
      `/v1/events?contract=${Y.contract}&limit=50`,
    ];
    /** The statements of one API request under EXPLAIN: their buffers and planning + execution time, summed per route,
     *  and the plan of any statement that read more than a page of 100 may (2,120 buffers) or took more than 20 ms (with
     *  its planning time apart). */
    const apiBuffers = async (state: string) => {
      const out: Record<string, { buffers: number; ms: number; statements: number; heavy: Array<{ buffers: number; ms: number; planningMs: number; plan: string; text: string }> }> = {};
      for (const path of routes.slice(2)) {
        captured.length = 0;
        capturing = true;
        await handler.handle("GET", path);
        capturing = false;
        const statements = [...captured];
        let buffers = 0;
        let ms = 0;
        const heavy: Array<{ buffers: number; ms: number; planningMs: number; plan: string; text: string }> = [];
        for (const [i, st] of statements.entries()) {
          if (/^\s*(begin|commit|rollback|savepoint|release|set transaction)/i.test(st.text) || st.text.includes("set_config(")) continue;
          // Each statement with the transaction-local settings in force before it (the set_config statements before it).
          const r = await explain([...statements.slice(0, i).filter((x) => x.text.includes("set_config(")), st]);
          buffers += r.buffers;
          ms += r.ms;
          if (r.buffers > 2120 || r.ms > 20) heavy.push({ buffers: r.buffers, ms: round2(r.ms), planningMs: round2(r.planningMs), plan: r.plans.at(-1) ?? "", text: st.text.replace(/\s+/g, " ").slice(0, 160) });
        }
        out[path.replace(/[0-9a-f]{64}/g, "…")] = { buffers, ms: round2(ms), statements: statements.length, heavy };
      }
      print({ state, apiBuffers: out });
    };
    const api = async (state: string) => {
      await apiBuffers(state);
      const out: Record<string, { p50: number; p95: number; max: number; status: number }> = {};
      for (const path of routes) {
        await handler.handle("GET", path);
        const ms: number[] = [];
        let status = 0;
        for (let i = 0; i < 20; i++) {
          const t0 = now();
          status = (await handler.handle("GET", path)).status;
          ms.push(now() - t0);
        }
        ms.sort((a, b) => a - b);
        out[path.replace(/[0-9a-f]{64}/g, "…")] = { p50: round2(ms[9]!), p95: round2(ms[18]!), max: round2(ms[19]!), status };
      }
      print({ state, api: out });
    };
    const estimates = async () => (await sql<{ n: string; r: number }[]>`
      SELECT c.relname AS n, c.reltuples::float8 AS r FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = ${mip} AND c.relname IN ('mip0018_listed_events', 'mip0018_activity', 'mip0018_events') ORDER BY 1`).map((x) => `${x.n}=${x.r}`);
    const listing = ["mip0018_listed_events", "mip0018_activity", "mip0018_events"].map((x) => `"${mip}"."${x}"`);

    print({ state: "natural", estimates: await estimates() });
    await pages("natural");
    await api("natural");

    const v0 = now();
    for (const t of listing) await sql.unsafe(`VACUUM ${t}`);
    print({ state: "vacuumed", vacuumMs: round2(now() - v0), estimates: await estimates() });
    await pages("vacuumed");
    await api("vacuumed");

    const a0 = now();
    for (const t of await baseTables()) await sql.unsafe(`ANALYZE "${mip}"."${t}"`);
    print({ state: "fresh", analyzeMs: round2(now() - a0), estimates: await estimates(), databaseBytes: await databaseBytes() });
    await pages("fresh");
    await api("fresh");

    const listed = `"${mip}".mip0018_listed_events`;
    await sql.unsafe(`CREATE TABLE "${mip}".measure_refill AS SELECT * FROM ${listed} WHERE network = $1 AND block_height > 200000`, [NET]);
    await sql.unsafe(`DELETE FROM ${listed} WHERE network = $1 AND block_height > 200000`, [NET]);
    await sql.unsafe(`VACUUM ${listed}`);
    for (const t of listing) await sql.unsafe(`ANALYZE ${t}`);
    await sql.unsafe(`INSERT INTO ${listed} SELECT * FROM "${mip}".measure_refill`);
    await sql.unsafe(`DROP TABLE "${mip}".measure_refill`);
    const [stats] = await sql.unsafe<{ reltuples: number; relpages: number }[]>(`SELECT reltuples::int AS reltuples, relpages FROM pg_class WHERE oid = '${listed}'::regclass`);
    print({ state: "stale", listedStatistics: stats, listedRows: await count("mip0018_listed_events") });
    await pages("stale");
    await api("stale");
    if (backend === "postgresql") {
      await sql.unsafe(`DROP SCHEMA ${mip} CASCADE`);
      await sql.unsafe(`DROP SCHEMA ${archive} CASCADE`);
    }
  } finally {
    await close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

if (command === "replay" && target === "postgresql") await replayPostgresql(process.argv.includes("--node-batches"));
else if (command === "replay" && (target === "pglite-dir" || target === "pglite-memory")) await replayPglite(target === "pglite-dir");
else if (command === "planner") await planner(target, Number(third ?? 100_000));
else throw new Error("usage: replay postgresql [--node-batches] | replay pglite-dir | replay pglite-memory | planner pglite|postgresql [N]");
process.exit(0);
