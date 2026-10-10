/**
 * The indexer's modules and the store's tables in the browser engine, in Node: the engine (`../engine/engine.ts`) and
 * the worker host (`../browser/host.ts`) on PGlite (in memory, or a directory that outlives a host as an OPFS store
 * outlives a tab), with the recorded IDX and U1 ranges replayed inside the host (no network).
 *
 * - `[[engine.scan-switch]]` — the engine's scan switch: a scan configured off starts off (phase `off`, `scanner:
 *   "off"`) while the sync archives; switched on it catches up from its cursor; switched off while it runs, the answer
 *   comes once it waits at a block boundary; switching twice changes nothing; a stop while it waits ends the loops.
 * - `[[browser.host.module-toggle]]` — the `module` request on a running engine whose finalized tip advances: off, the
 *   scan's cursor stays where it stopped while the archive advances by more than a hundred blocks, `/v1/status` says
 *   `scanner: "off"` and still answers, the system snapshot shows the scan off and the health line follows the archive;
 *   on, the scan catches up; the finished store's digests equal the recorded uninterrupted replay's.
 * - `[[browser.host.module-saved]]` — the choice is saved with the settings: a new host on the same store (a reload, the
 *   next leader tab) starts its engine with the scan off and the archive syncing; `module` refuses a module that is not
 *   switchable; `module` is never sent again to a new leader (it changes state), `tables` and `rows` are.
 * - `[[browser.host.store-replaced]]` — a store replaced by `range`, `reset` or `import` keeps the saved switch: the new
 *   store's engine runs with the scan off; `tables` and `rows` sent while the store is replaced are answered (they wait
 *   for the new store) and, once it is in place, from it; when a replacement fails they get an error answer, never a
 *   rejection, and the switch stays saved.
 * - `[[browser.host.tables]]` — `tables` lists every table of both schemas, as the catalog has them, with their
 *   estimated rows and sizes.
 * - `[[browser.host.rows]]` — `rows` of every table equals the same page read with SQL by the test (the primary key's
 *   columns, descending; bytes as their first 16 bytes and length; other values as their text form, first 256
 *   characters and length); the pages follow one another; the bounds hold.
 * - `[[browser.host.rows-refused]]` — a schema or table that is not the store's (another schema, a catalog table, an
 *   index, a name with quotes and SQL in it, a table of the other schema) is refused as a bad request and the store is
 *   unchanged; a `rows`, `tables` or `module` request whose values cannot be read or turned into text (a throwing getter
 *   or `Symbol.toPrimitive`, no usable `toString`) gets a bad-request answer, never a rejection, and changes nothing.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTapeFetch } from "../../chain-archive-sync/tape-replay.js";
import { createWorkerHost, type WorkerHost, type WorkerHostOptions } from "../browser/host.ts";
import {
  type CapabilityReport,
  type DigestResult,
  type ExportResult,
  type HostStatus,
  parseRequest,
  PROTOCOL_VERSION,
  type Response,
  ROWS_LIMITS,
  type RowsResult,
  type StartConfig,
  type SystemResult,
  type TablesResult,
} from "../browser/protocol.ts";
import { memorySettingsStore } from "../browser/settings.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA, migrateStore, openStore, type Store } from "../browser/store.ts";
import { REPEATABLE_REQUEST_TYPES } from "../browser/tabs.ts";
import { loadTape } from "../browser/tapes.ts";
import { createIndexerEngine } from "../engine/engine.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IDX = { from: 714485, to: 715183 } as const;
const U1 = { from: 715402, to: 715433 } as const;
const IDX_ARCHIVE = "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119";
const IDX_TABLES = "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c";
const FAST = { sync: { idleMs: 100 }, scan: { idleMs: 100 } };

const SUPPORTED: CapabilityReport = {
  supported: true,
  message: "",
  missing: [],
  checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: true },
  browser: "Chromium 153",
};

/** `fetch` for the tape catalog's `file:` URLs. */
const fileFetch: typeof fetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(fileURLToPath(input instanceof Request ? input.url : String(input)))))) as typeof fetch;

const hosts: WorkerHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function storeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "umbradb-modules-store-"));
  dirs.push(d);
  return d;
}

function newHost(over: Partial<WorkerHostOptions> = {}): { host: WorkerHost; stores: Store[]; logs: string[] } {
  const stores: Store[] = [];
  const logs: string[] = [];
  const host = createWorkerHost({
    network: "stagenet",
    dataDir: "memory://",
    nodeUrl: "https://node.invalid/",
    indexerUrl: "https://indexer.invalid/",
    checkCapabilities: async () => SUPPORTED,
    loadTape: (range) => loadTape(range, fileFetch),
    openStore: async (dir, o) => {
      const s = await openStore(dir, o);
      stores.push(s);
      return s;
    },
    log: (level, message) => logs.push(`${level} ${message}`),
    ...over,
  });
  hosts.push(host);
  return { host, stores, logs };
}

async function closeHost(h: WorkerHost): Promise<void> {
  hosts.splice(hosts.indexOf(h), 1);
  await h.close();
}

let nextId = 1;
async function result<T = unknown>(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<T> {
  const r: Response = await host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
  if (!r.ok) throw new Error(`${type}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
}
async function errorOf(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<{ code: string; message: string }> {
  const r: Response = await host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
  if (r.ok) throw new Error(`${type} should fail`);
  return r.error;
}
const apiJson = async (host: WorkerHost, target: string): Promise<{ status: number; body: Json }> => {
  const r = await result<{ status: number; body: string }>(host, "api", { method: "GET", target });
  return { status: r.status, body: JSON.parse(r.body) };
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(host: WorkerHost, what: string, ok: (s: HostStatus) => boolean, timeoutMs = 120_000): Promise<HostStatus> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await result<HostStatus>(host, "status");
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ cursors: s.cursors, engine: s.engine?.status })}`);
    await sleep(20);
  }
}

/** The IDX range with a finalized tip that starts 60 blocks in and rises 10 blocks every 100 ms. */
const RISING_IDX: StartConfig = {
  source: { kind: "tape", range: "idx", finalizedHeight: IDX.from + 60, advance: { everyMs: 100, by: 10 } },
  startHeight: IDX.from,
  ...FAST,
};

describe("the indexer's modules and the store's tables in the browser engine", () => {
  it("[[engine.scan-switch]] a scan configured off starts off while the sync archives; on, it catches up from its cursor; off while it runs, the answer comes once it waits at a block boundary; switching twice changes nothing; a stop while it waits ends the loops", async () => {
    const s = await openStore("memory://");
    try {
      const { bootstrapChainArchiveSchema } = await import("../../chain-archive-sync/bootstrap.js");
      await bootstrapChainArchiveSchema(s.archive, ARCHIVE_SCHEMA);
      const replay = createTapeFetch(await loadTape("u1", fileFetch));
      const engine = createIndexerEngine({
        sql: s.mip0018,
        archiveSql: s.archive,
        network: "stagenet",
        schema: MIP0018_SCHEMA,
        archiveSchema: ARCHIVE_SCHEMA,
        sync: { nodeUrl: replay.nodeUrl, indexerUrl: replay.indexerUrl, startHeight: U1.from, idleMs: 50, maxBlocks: 5 },
        scan: { idleMs: 50, batch: 3, enabled: false },
        fetch: replay.fetchImpl,
      });
      expect(engine.status().scan).toMatchObject({ phase: "off", scanner: "off" });
      expect(engine.scannerState()).toBe("off");
      await engine.start();
      for (let i = 0; i < 500 && (await engine.syncCursor())?.height !== U1.to; i++) await sleep(20);
      expect((await engine.syncCursor())?.height).toBe(U1.to);
      await sleep(200);
      expect(await engine.scanCursor()).toBeUndefined(); // nothing scanned while off
      expect(engine.status().scan).toMatchObject({ phase: "off", scanner: "off" });
      expect(JSON.parse((await engine.handle("GET", "/v1/status")).body)).toMatchObject({ scanner: "off", archiveHeight: U1.to, indexedHeight: null });

      // On: the scan catches up from its (absent) cursor, the archive's first height.
      await engine.setScanEnabled(true);
      expect(engine.scannerState()).toBe("following");
      for (let i = 0; i < 500 && (await engine.scanCursor())?.nextHeight !== U1.to + 1; i++) await sleep(20);
      expect((await engine.scanCursor())?.nextHeight).toBe(U1.to + 1);

      // Off while it runs: answered once it waits; the cursor is a whole block; twice is once.
      await engine.setScanEnabled(false);
      expect(engine.status().scan).toMatchObject({ phase: "off", scanner: "off" });
      await engine.setScanEnabled(false);
      expect(engine.status().scan.phase).toBe("off");
      expect(engine.status().sync.phase).not.toBe("stopped");

      // A stop while the scan waits switched off ends both loops.
      await engine.stop();
      await engine.finished;
      expect(engine.status().scan.phase).toBe("stopped");
      expect(engine.status().sync.phase).toBe("stopped");
      // Without a scan configured the switch does nothing.
      const apiOnly = createIndexerEngine({ sql: s.mip0018, archiveSql: s.archive, network: "stagenet", schema: MIP0018_SCHEMA, archiveSchema: ARCHIVE_SCHEMA });
      await apiOnly.setScanEnabled(true);
      expect(apiOnly.status().scan.phase).toBe("off");
    } finally {
      await s.close();
    }
  }, 120_000);

  it("[[browser.host.module-toggle]] module off: the scan cursor stays while the archive advances, /v1/status says scanner off and answers, the system snapshot shows the scan off; module on: the scan catches up; the finished digests equal the uninterrupted replay's", async () => {
    const { host, logs } = newHost({ settings: memorySettingsStore() });
    await result(host, "start", { config: RISING_IDX });
    await until(host, "a first part of the scan", (s) => (s.cursors?.scan?.nextHeight ?? 0) > IDX.from + 30);

    const off = await result<HostStatus>(host, "module", { module: "token-indexer", enabled: false });
    expect(off.engine!.status.scan).toMatchObject({ phase: "off", scanner: "off" });
    expect(off.settings!.modules).toEqual({ "token-indexer": false });
    const frozen = off.cursors!.scan!;
    expect(frozen.nextHeight).toBeGreaterThan(IDX.from + 30);
    // The archive goes on: more than a hundred blocks past the frozen scan.
    const ahead = await until(host, "the archive to advance", (s) => (s.cursors?.sync?.height ?? 0) >= frozen.nextHeight + 120);
    expect(ahead.cursors!.scan).toEqual(frozen);
    await sleep(300);
    const still = await result<HostStatus>(host, "status");
    expect(still.cursors!.scan).toEqual(frozen);
    expect(still.engine!.status.sync.phase).not.toBe("stopped");
    const st = await apiJson(host, "/v1/status");
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ scanner: "off", indexedHeight: frozen.nextHeight - 1 });
    expect(st.body.archiveHeight).toBeGreaterThanOrEqual(frozen.nextHeight + 120);
    expect((await apiJson(host, "/v1/tokens?limit=5")).status).toBe(200);
    const snap = (await result<SystemResult>(host, "system", { refresh: {} })).snapshot!;
    expect(snap.scan).toMatchObject({ phase: "off", scanner: "off" });
    expect(["following", "catching-up"]).toContain(snap.overview.health.state);
    expect(logs.some((l) => l.includes("the token indexer is off"))).toBe(true);

    // On: the scan continues from its cursor and catches up with the archive, to the recorded digests.
    const on = await result<HostStatus>(host, "module", { module: "token-indexer", enabled: true });
    expect(on.settings!.modules).toEqual({ "token-indexer": true });
    expect(on.engine!.status.scan.scanner).toBe("following");
    const end = await until(host, "the range's end", (s) => s.cursors?.sync?.height === IDX.to && s.cursors?.scan?.nextHeight === IDX.to + 1, 300_000);
    expect(end.cursors!.sync!.startHeight).toBe(IDX.from);
    const d = await result<DigestResult>(host, "digest");
    expect([d.archive.sha256, d.tables.sha256]).toEqual([IDX_ARCHIVE, IDX_TABLES]);
  }, 400_000);

  it("[[browser.host.module-saved]] the module's state is saved with the settings: a new host on the same store starts with the scan off and the archive syncing, and on again catches up; a module that is not switchable is refused; module is never sent again to a new leader, tables and rows are", async () => {
    const dir = storeDir();
    const settings = memorySettingsStore();
    const config: StartConfig = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST };
    const a = newHost({ dataDir: dir, settings });
    // Off before any start: saved, and the engine of the next start runs without the scan.
    expect((await result<HostStatus>(a.host, "module", { module: "token-indexer", enabled: false })).settings).toMatchObject({ modules: { "token-indexer": false } });
    expect((await settings.load())?.modules).toEqual({ "token-indexer": false });
    await result(a.host, "start", { config });
    const synced = await until(a.host, "the archive", (s) => s.cursors?.sync?.height === U1.to);
    expect(synced.cursors!.scan).toBeNull();
    expect(synced.engine!.status.scan).toMatchObject({ phase: "off", scanner: "off" });
    await closeHost(a.host);

    // The next host (a reload, or the next leader tab): the saved choice holds.
    const b = newHost({ dataDir: dir, settings });
    await b.host.boot();
    const booted = await result<HostStatus>(b.host, "status");
    expect(booted.settings).toMatchObject({ config, autoStart: true, modules: { "token-indexer": false } });
    await result(b.host, "start");
    await sleep(500);
    const s2 = await result<HostStatus>(b.host, "status");
    expect(s2.engine!.status.scan).toMatchObject({ phase: "off", scanner: "off" });
    expect(s2.cursors!.scan).toBeNull();
    // A start, a stop and a range keep the choice.
    await result(b.host, "stop");
    expect((await settings.load())?.modules).toEqual({ "token-indexer": false });
    await result(b.host, "module", { module: "token-indexer", enabled: true });
    await result(b.host, "start");
    await until(b.host, "the scan to catch up", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);
    expect((await settings.load())?.modules).toEqual({ "token-indexer": true });

    // Only the token indexer can be switched; a planned module is not a module of the engine.
    for (const params of [{ module: "explorer", enabled: true }, { module: "token-indexer" }, { module: "token-indexer", enabled: "no" }])
      expect((await errorOf(b.host, "module", params)).code, JSON.stringify(params)).toBe("bad-request");
    // The tabs' hand-over rule: module changes state; tables and rows only read.
    expect(REPEATABLE_REQUEST_TYPES.has("module")).toBe(false);
    expect(REPEATABLE_REQUEST_TYPES.has("tables")).toBe(true);
    expect(REPEATABLE_REQUEST_TYPES.has("rows")).toBe(true);
  }, 120_000);

  it("[[browser.host.store-replaced]] a store replaced by range, reset or import keeps the saved switch (the new store's engine runs with the scan off); tables and rows sent while the store is replaced are answered, from the new store once it is in place; when a replacement fails they get an error answer, never a rejection", async () => {
    const config: StartConfig = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST };
    const { host, stores } = newHost();
    await result(host, "start", { config });
    await until(host, "the U1 range", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);
    const exported = await result<ExportResult>(host, "export");
    await result(host, "module", { module: "token-indexer", enabled: false });
    const raw = (type: string, params: Record<string, unknown> = {}): Promise<Response> => host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
    /** Sends a tables and a rows request, then the next pair once both are answered (as the Database tab sends its
     *  requests one at a time), until `replacing` settles: the first pair goes out before it has; every answer must
     *  come, as an answer. */
    async function readWhile(replacing: Promise<Response>): Promise<Response[]> {
      const answers: Response[] = [];
      let settled = false;
      void replacing.finally(() => (settled = true));
      do {
        answers.push(...(await Promise.all([raw("tables"), raw("rows", { schema: ARCHIVE_SCHEMA, table: "blocks", limit: 100 })])));
        await sleep(5);
      } while (!settled);
      return answers;
    }
    const blocksIn = async (s: Store): Promise<number> => Number((await s.pglite.query<{ n: string }>("SELECT count(*)::text AS n FROM chain_archive.blocks")).rows[0]!.n);

    // range: a new store; tables and rows during the replacement are answered.
    const ranging = raw("range", { startHeight: U1.from + 10, endHeight: U1.to });
    const during = await readWhile(ranging);
    expect((await ranging).ok).toBe(true);
    expect(during.length).toBeGreaterThan(0);
    for (const r of during) expect(r.ok, r.ok ? "" : `${r.request}: ${r.error.code} ${r.error.message}`).toBe(true);
    const ranged = await until(host, "the new range's archive", (s) => s.cursors?.sync?.height === U1.to);
    expect(ranged.settings?.modules).toEqual({ "token-indexer": false });
    expect(ranged.engine!.status.scan).toMatchObject({ phase: "off", scanner: "off" });
    expect(ranged.cursors!.scan).toBeNull();
    // The Database tab reads the new store: its tables, and rows of the new range only.
    const newStore = stores.at(-1)!;
    expect(newStore).not.toBe(stores[0]);
    const t = await result<TablesResult>(host, "tables");
    expect(t.schemas.map((x) => x.name)).toEqual([ARCHIVE_SCHEMA, MIP0018_SCHEMA]);
    const blocks = await result<RowsResult>(host, "rows", { schema: ARCHIVE_SCHEMA, table: "blocks", limit: 100 });
    expect(blocks.rows.length).toBe(await blocksIn(newStore));
    expect(blocks.rows.length).toBe(U1.to - (U1.from + 10) + 1);
    expect(blocks.more).toBe(false);

    // reset: a new, empty store again, the saved range started with the scan off.
    const resetting = raw("reset");
    for (const r of await readWhile(resetting)) expect(r.ok).toBe(true);
    expect((await resetting).ok).toBe(true);
    const reset = await until(host, "the reset store's archive", (s) => s.cursors?.sync?.height === U1.to);
    expect(reset.settings?.modules).toEqual({ "token-indexer": false });
    expect(reset.engine!.status.scan).toMatchObject({ phase: "off", scanner: "off" });
    expect(reset.cursors!.scan).toBeNull();

    // import: the snapshot's store; the switch stays saved and the next start runs with the scan off.
    const importing = raw("import", { snapshot: exported.file });
    for (const r of await readWhile(importing)) expect(r.ok).toBe(true);
    const imported = await importing;
    expect(imported.ok).toBe(true);
    const afterImport = await result<HostStatus>(host, "status");
    expect(afterImport.settings).toMatchObject({ autoStart: false, modules: { "token-indexer": false } });
    expect(afterImport.cursors).toEqual({ sync: { height: U1.to, startHeight: U1.from }, scan: expect.objectContaining({ nextHeight: U1.to + 1 }) });
    await result(host, "start");
    const started = await result<HostStatus>(host, "status");
    expect(started.engine!.status.scan).toMatchObject({ phase: "off", scanner: "off" });
    const rowsAfterImport = await result<RowsResult>(host, "rows", { schema: ARCHIVE_SCHEMA, table: "blocks", limit: 100 });
    expect(rowsAfterImport.rows.length).toBe(U1.to - U1.from + 1);
    await result(host, "stop");

    // A replacement that fails (the new store's migrations): tables and rows get an error answer, the switch stays saved.
    const settings = memorySettingsStore();
    let migrations = 0;
    const f = newHost({ settings, migrate: async (s) => { if (++migrations > 1) throw new Error("the migrations failed"); await migrateStore(s); } });
    await result(f.host, "module", { module: "token-indexer", enabled: false });
    const failing = f.host.receive({ v: PROTOCOL_VERSION, id: nextId++, type: "reset" });
    const failedReads: Response[] = [];
    let done = false;
    void failing.finally(() => (done = true));
    // One pair in flight at a time, as in readWhile.
    do {
      failedReads.push(...(await Promise.all([f.host.receive({ v: PROTOCOL_VERSION, id: nextId++, type: "tables" }), f.host.receive({ v: PROTOCOL_VERSION, id: nextId++, type: "rows", schema: ARCHIVE_SCHEMA, table: "blocks" })])));
      await sleep(5);
    } while (!done);
    const failed = await failing;
    expect(failed).toMatchObject({ ok: false, error: { code: "boot-failed" } });
    for (const r of [...failedReads, await f.host.receive({ v: PROTOCOL_VERSION, id: nextId++, type: "tables" }), await f.host.receive({ v: PROTOCOL_VERSION, id: nextId++, type: "rows", schema: ARCHIVE_SCHEMA, table: "blocks" })])
      if (!r.ok) expect(r.error.code).toBe("boot-failed");
    const last = await f.host.receive({ v: PROTOCOL_VERSION, id: nextId++, type: "rows", schema: ARCHIVE_SCHEMA, table: "blocks" });
    expect(last).toMatchObject({ ok: false, error: { code: "boot-failed" } });
    expect((await result<HostStatus>(f.host, "status")).boot).toMatchObject({ phase: "failed", storeProblem: "unusable" });
    expect((await settings.load())?.modules).toEqual({ "token-indexer": false });
  }, 240_000);

  it("[[browser.host.tables]] tables lists every table of both schemas as the catalog has them, with estimated rows and sizes", async () => {
    const { host, stores } = newHost();
    await result(host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST } });
    await until(host, "the U1 range", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);
    await result(host, "stop");
    const t = await result<TablesResult>(host, "tables");
    const db = stores[0]!.pglite;
    const catalog = (await db.query<{ schema: string; name: string; kind: string; parent: string | null; bytes: string }>(`
      SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, p.relname AS parent, pg_total_relation_size(c.oid)::text AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_inherits i ON c.relispartition AND i.inhrelid = c.oid LEFT JOIN pg_class p ON p.oid = i.inhparent
      WHERE n.nspname IN ('chain_archive', 'mip0018') AND c.relkind IN ('r', 'p') ORDER BY n.nspname, c.relname`)).rows;
    expect(t.schemas.map((s) => s.name)).toEqual([ARCHIVE_SCHEMA, MIP0018_SCHEMA]);
    const listed = t.schemas.flatMap((s) => s.tables.map((x) => ({ schema: s.name, ...x })));
    expect(listed.map((x) => `${x.schema}.${x.name}`).sort()).toEqual(catalog.map((c) => `${c.schema}.${c.name}`).sort());
    expect(listed.length).toBeGreaterThan(20);
    for (const c of catalog) {
      const x = listed.find((l) => l.schema === c.schema && l.name === c.name)!;
      expect(x.kind, c.name).toBe(c.kind === "p" ? "partitioned" : c.parent !== null ? "partition" : "table");
      expect(x.partitionOf, c.name).toBe(c.parent);
      if (c.kind === "r") expect(x.totalBytes, c.name).toBe(Number(c.bytes));
      else {
        const parts = catalog.filter((p) => p.parent === c.name && p.schema === c.schema);
        expect(x.totalBytes, c.name).toBe(parts.reduce((a, p) => a + Number(p.bytes), 0));
      }
    }
    expect(t.databaseBytes).toBeGreaterThan(0);
  }, 120_000);

  it("[[browser.host.rows]] rows of every table equals the same page read with SQL: newest first by the primary key, bytes cut to their first 16 bytes with the length, other values to their first 256 characters with the length; pages follow one another; the bounds hold", async () => {
    const { host, stores } = newHost();
    await result(host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST } });
    await until(host, "the U1 range", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);
    await result(host, "stop");
    const db = stores[0]!.pglite;
    const t = await result<TablesResult>(host, "tables");
    const cut = (text: string): { text: string; chars: number } => {
      const cps = [...text];
      return { text: cps.slice(0, ROWS_LIMITS.textChars).join(""), chars: cps.length };
    };
    const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
    let checked = 0;
    let nonEmpty = 0;
    for (const s of t.schemas) {
      for (const table of s.tables) {
        // The test's own reading: the key from information_schema, each column as its raw bytes or its text form.
        const cols = (await db.query<{ name: string; type: string }>(
          `SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [s.name, table.name])).rows;
        const key = (await db.query<{ name: string }>(
          `SELECT k.column_name AS name FROM information_schema.table_constraints c JOIN information_schema.key_column_usage k
             ON k.constraint_name = c.constraint_name AND k.table_schema = c.table_schema AND k.table_name = c.table_name
           WHERE c.constraint_type = 'PRIMARY KEY' AND c.table_schema = $1 AND c.table_name = $2 ORDER BY k.ordinal_position`, [s.name, table.name])).rows.map((r) => r.name);
        const q = (n: string): string => `"${n.replaceAll('"', '""')}"`;
        const select = cols.map((c) => (c.type === "bytea" ? `${q(c.name)} AS ${q(c.name)}` : `${q(c.name)}::text AS ${q(c.name)}`)).join(", ");
        const order = key.length === 0 ? "ctid DESC" : key.map((k) => `${q(k)} DESC`).join(", ");
        const sqlRows = (await db.query<Record<string, unknown>>(`SELECT ${select} FROM ${q(s.name)}.${q(table.name)} ORDER BY ${order} LIMIT 26`)).rows;
        const expected = sqlRows.slice(0, 25).map((r) => cols.map((c) => {
          const v = r[c.name];
          if (v === null || v === undefined) return { kind: "null" };
          if (c.type === "bytea") return { kind: "bytes", hex: hex((v as Uint8Array).subarray(0, ROWS_LIMITS.hexBytes)), bytes: (v as Uint8Array).length };
          return { kind: "text", ...cut(String(v)) };
        }));
        const page = await result<RowsResult>(host, "rows", { schema: s.name, table: table.name });
        expect(page.columns.map((c) => c.name), `${s.name}.${table.name}`).toEqual(cols.map((c) => c.name));
        expect(page.orderBy, `${s.name}.${table.name}`).toEqual(key);
        expect(page.rows, `${s.name}.${table.name}`).toEqual(expected);
        expect(page.more, `${s.name}.${table.name}`).toBe(sqlRows.length > 25);
        expect([page.schema, page.table, page.offset, page.limit]).toEqual([s.name, table.name, 0, ROWS_LIMITS.defaultLimit]);
        checked++;
        if (page.rows.length > 0) nonEmpty++;
      }
    }
    expect(checked).toBe(t.schemas.reduce((a, s) => a + s.tables.length, 0));
    expect(nonEmpty).toBeGreaterThan(8);

    // blocks: newest first; the pages follow one another.
    const p1 = await result<RowsResult>(host, "rows", { schema: ARCHIVE_SCHEMA, table: "blocks", limit: 10 });
    const p2 = await result<RowsResult>(host, "rows", { schema: ARCHIVE_SCHEMA, table: "blocks", limit: 10, offset: 10 });
    const p4 = await result<RowsResult>(host, "rows", { schema: ARCHIVE_SCHEMA, table: "blocks", limit: 10, offset: 30 });
    const heightAt = p1.columns.findIndex((c) => c.name === "height");
    const heights = (p: RowsResult): number[] => p.rows.map((r) => Number((r[heightAt] as { text: string }).text));
    expect(heights(p1)).toEqual(Array.from({ length: 10 }, (_, i) => U1.to - i));
    expect(heights(p2)).toEqual(Array.from({ length: 10 }, (_, i) => U1.to - 10 - i));
    expect(heights(p4)).toEqual([U1.from + 1, U1.from]);
    expect([p1.more, p2.more, p4.more]).toEqual([true, true, false]);
    // A bytes value: its first 16 bytes as hex and its whole length.
    const hashAt = p1.columns.findIndex((c) => c.name === "block_hash");
    expect(p1.rows[0]![hashAt]).toMatchObject({ kind: "bytes", bytes: 32 });
    expect((p1.rows[0]![hashAt] as { hex: string }).hex).toMatch(/^[0-9a-f]{32}$/);
    // The bounds.
    for (const params of [{ limit: 0 }, { limit: ROWS_LIMITS.maxLimit + 1 }, { offset: -1 }, { offset: ROWS_LIMITS.maxOffset + 1 }, { limit: 1.5 }])
      expect((await errorOf(host, "rows", { schema: ARCHIVE_SCHEMA, table: "blocks", ...params })).code, JSON.stringify(params)).toBe("bad-request");
    expect((await result<RowsResult>(host, "rows", { schema: ARCHIVE_SCHEMA, table: "blocks", limit: ROWS_LIMITS.maxLimit, offset: ROWS_LIMITS.maxOffset })).rows).toEqual([]);
  }, 120_000);

  it("[[browser.host.rows-refused]] a schema or table that is not the store's is refused as a bad request, before any statement names it, and the store is unchanged; rows, tables and module requests whose values cannot be read or turned into text get a bad-request answer, never a rejection, and change nothing", async () => {
    const { host } = newHost();
    await result(host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST } });
    await until(host, "the U1 range", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);
    await result(host, "stop");
    const before = await result<DigestResult>(host, "digest");
    const forged: Array<[string, string, RegExp]> = [
      ["pg_catalog", "pg_class", /is not a schema of the store/],
      ["information_schema", "tables", /is not a schema of the store/],
      ["public", "blocks", /is not a schema of the store/],
      ["chain_archive", "pg_class", /is not a table of the schema chain_archive/],
      ["chain_archive", "mip0018_events", /is not a table of the schema chain_archive/],
      ["mip0018", "blocks", /is not a table of the schema mip0018/],
      ["chain_archive", "blocks_pkey", /is not a table of the schema chain_archive/],
      ["chain_archive", "blocks\"; DROP TABLE chain_archive.watermarks; --", /is not a table of the schema chain_archive/],
      ["chain_archive", "BLOCKS", /is not a table of the schema chain_archive/],
      ["chain_archive\".\"blocks", "blocks", /is not a schema of the store/],
    ];
    for (const [schema, table, message] of forged) {
      const e = await errorOf(host, "rows", { schema, table });
      expect(e.code, `${schema}.${table}`).toBe("bad-request");
      expect(e.message, `${schema}.${table}`).toMatch(message);
    }
    for (const params of [{ schema: "", table: "blocks" }, { schema: "chain_archive", table: "x".repeat(64) }, { schema: "chain_archive" }, { schema: "chain_archive", table: "blocks", sql: "select 1" }])
      expect((await errorOf(host, "rows", params)).code, JSON.stringify(params)).toBe("bad-request");
    // Values that cannot be read or turned into text: a bad-request answer (the host never rejects), nothing switched.
    const noText = { toString: 0 };
    const throwing = { [Symbol.toPrimitive]: () => { throw new Error("no primitive"); } };
    const withGetter = (name: string, rest: Record<string, unknown>): Record<string, unknown> =>
      Object.defineProperty({ v: PROTOCOL_VERSION, id: nextId++, ...rest }, name, { get: () => { throw new Error(`no ${name}`); }, enumerable: true });
    const hostile: Array<Record<string, unknown>> = [
      { v: PROTOCOL_VERSION, id: nextId++, type: "rows", schema: noText, table: "blocks" },
      { v: PROTOCOL_VERSION, id: nextId++, type: "rows", schema: "chain_archive", table: throwing },
      { v: PROTOCOL_VERSION, id: nextId++, type: "rows", schema: "chain_archive", table: "blocks", limit: throwing, offset: noText },
      { v: PROTOCOL_VERSION, id: nextId++, type: "tables", extra: throwing },
      { v: PROTOCOL_VERSION, id: nextId++, type: "module", module: noText, enabled: false },
      { v: PROTOCOL_VERSION, id: nextId++, type: "module", module: "token-indexer", enabled: throwing },
      withGetter("schema", { type: "rows", table: "blocks" }),
      withGetter("table", { type: "rows", schema: "chain_archive" }),
      withGetter("limit", { type: "rows", schema: "chain_archive", table: "blocks" }),
      withGetter("enabled", { type: "module", module: "token-indexer" }),
      withGetter("type", { schema: "chain_archive", table: "blocks" }),
    ];
    for (const raw of hostile) {
      const r: Response = await host.receive(raw);
      expect(r.ok, Object.keys(raw).join(",")).toBe(false);
      if (!r.ok) expect(r.error.code, Object.keys(raw).join(",")).toBe("bad-request");
      expect(parseRequest(raw).ok).toBe(false);
    }
    expect((await result<HostStatus>(host, "status")).settings?.modules).toBeUndefined();
    const after = await result<DigestResult>(host, "digest");
    expect({ archive: after.archive, tables: after.tables }).toEqual({ archive: before.archive, tables: before.tables });
  }, 120_000);
});
