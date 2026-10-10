/**
 * The browser engine's system snapshot, watchdog and scheduling in Chrome, on OPFS: the static build served from
 * 127.0.0.1 with an OPFS reader page beside it (`fixtures/opfs-reader/`, an independent PGlite on the same store),
 * driven over the DevTools protocol (`helpers/cdp-browser.ts`), with recorded Stagenet ranges replayed in the worker.
 *
 * - `[[browser.worker.system]]` — a snapshot from the worker validates against the schema and its values equal their
 *   sources: heights equal `/v1/status`; storage equals `navigator.storage.estimate()` and `persisted()` read by the
 *   page; table sizes, row estimates, exact row counts and the database size equal `pg_total_relation_size`,
 *   `reltuples`, `count(*)` and `pg_database_size` read by the reader page from the store; the configuration shows the
 *   build's facts (`define`), the watchdog limit, the data directory and the browser's capability report. While watched
 *   a snapshot arrives every 2 s; unwatched, nothing is collected (no notice, no `/v1/status` read, no catalog read).
 *   The reader first opens the store the terminated engine worker left: replaying its WAL can add a table's free-space
 *   map (the only difference allowed then); after the reader closed the store cleanly and the engine reopened it, the
 *   two reads agree exactly.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_BROWSER_REPORT=<file>` writes the measurements as JSON (never committed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeReplay, type TapeReplay } from "../../chain-archive-sync/tape-replay.js";
import type { HostStatus } from "../browser/protocol.ts";
import { type SystemSnapshot, SystemSnapshotSchema } from "../engine/system-snapshot.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { buildSite, ROOT, serveSite } from "./helpers/browser-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const U1 = { from: 715402, to: 715433 } as const;
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };
const STORE = "opfs-ahp://umbradb-stagenet";
const APP_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const versionOf = (pkg: string): string => (JSON.parse(readFileSync(join(ROOT, "node_modules", pkg, "package.json"), "utf8")) as { version: string }).version;

const browserExe = findBrowser();

describe("browser engine in Chrome: system snapshot, watchdog, scheduling", () => {
  let site: { dir: string; remove(): void };
  let server: Awaited<ReturnType<typeof serveSite>>;
  let browser: Browser;
  let page: Page;
  let chain: TapeReplay;
  const report: Record<string, Json> = {};

  const engine = (expr: string): Promise<Json> => page.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
  const status = (): Promise<HostStatus> => engine("c.status()");
  const api = async (target: string): Promise<{ status: number; body: Json }> => {
    const r = (await engine(`c.api("GET", ${JSON.stringify(target)})`)) as { status: number; body: string };
    return { status: r.status, body: JSON.parse(r.body) };
  };
  async function until(what: string, ok: (s: HostStatus) => boolean, timeoutMs = 120_000): Promise<HostStatus> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await status();
      if (ok(s)) return s;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ boot: s.boot.phase, cursors: s.cursors, engine: s.engine?.status })}`);
      await sleep(100);
    }
  }
  async function open(query = ""): Promise<HostStatus> {
    await page.goto(`${server.origin}/engine.html${query}`);
    await page.waitFor("window.umbradbEngine !== undefined", 30_000, "the engine page");
    await page.eval("window.umbradbEngine.client.booted()");
    return status();
  }

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    site = await buildSite({ UMBRADB_APP_COMMIT: APP_COMMIT });
    chain = createTapeReplay(await readTape(new Uint8Array(readFileSync(join(ROOT, "token-indexer/browser/tapes/stagenet-715402-715433.tape.json.gz"))), "gzip"));
    server = await serveSite(site.dir, chain);
    browser = await Browser.launch(browserExe);
    report.browser = await browser.version();
    page = await browser.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    site?.remove();
    if (process.env.UMBRADB_BROWSER_REPORT) writeFileSync(process.env.UMBRADB_BROWSER_REPORT, JSON.stringify(report, null, 2));
  });

  it("[[browser.worker.system]] a snapshot from the worker validates against the schema and equals its sources: heights equal /v1/status, storage equals navigator.storage, table sizes, estimates, exact counts and database size equal the catalog read from the store by another page, the configuration shows the build, the watchdog limit, the data directory and the browser; watched it arrives every 2 s, unwatched nothing is collected", async () => {
    const first = await open();
    expect(first.boot.phase).toBe("ready");
    await engine(`c.start(${JSON.stringify({ source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST })})`);
    await until("the U1 range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);

    // Watched: one snapshot per collection, each read /v1/status once.
    await page.eval(`(() => { window.__snaps = []; window.umbradbEngine.client.onNotice((n) => { if (n.notice === "system") window.__snaps.push(n.snapshot); }); })()`);
    expect(await engine("c.system({ watch: true })")).toEqual({ watching: true, viewers: 1, snapshot: null });
    await page.waitFor("window.__snaps.length >= 3", 30_000, "three snapshots");
    const watched = ((await page.eval("window.__snaps")) as Json[]).map((s) => SystemSnapshotSchema.parse(s));
    const gaps = watched.slice(1).map((s, i) => s.generatedAt - watched[i]!.generatedAt);
    report.systemWatch = { snapshots: watched.length, gapsMs: gaps };
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(1_900);
    expect(watched[2]!.api.served - watched[1]!.api.served).toBe(1);
    expect(watched.every((s) => s.collection.watching)).toBe(true);

    // Unwatched: no notice, no /v1/status read, no catalog read.
    expect(await engine("c.system({ watch: false })")).toEqual({ watching: false, viewers: 0, snapshot: null });
    await sleep(300);
    const n = (await page.eval("window.__snaps.length")) as number;
    const lastWatched = SystemSnapshotSchema.parse(await page.eval("window.__snaps[window.__snaps.length - 1]"));
    await sleep(6_000);
    expect(await page.eval("window.__snaps.length"), "no snapshot while unwatched").toBe(n);
    const after = SystemSnapshotSchema.parse((await engine("c.system({ refresh: {} })")).snapshot);
    expect(after.api.served, "only the refresh read /v1/status").toBe(lastWatched.api.served + 1);
    expect(after.databases.collectedAt, "no catalog read while unwatched").toBe(lastWatched.databases.collectedAt);
    expect(after.collection.watching).toBe(false);

    // A snapshot of the stopped engine against its sources.
    await engine("c.stop()");
    const est0 = (await page.eval("navigator.storage.estimate().then((e) => ({ usage: e.usage, quota: e.quota }))")) as { usage: number; quota: number };
    const t0 = Date.now();
    const snap: SystemSnapshot = SystemSnapshotSchema.parse((await engine("c.system({ refresh: { database: true, exactCounts: true } })")).snapshot);
    report.systemRefreshMs = Date.now() - t0;
    const est1 = (await page.eval("navigator.storage.estimate().then((e) => ({ usage: e.usage, quota: e.quota }))")) as { usage: number; quota: number };
    const persisted = (await page.eval("navigator.storage.persisted()")) as boolean;
    report.storage = { snapshot: { usage: snap.storage.usageBytes, quota: snap.storage.quotaBytes, persisted: snap.storage.persisted }, pageBefore: est0, pageAfter: est1, pagePersisted: persisted };
    expect([est0.usage, est1.usage]).toContain(snap.storage.usageBytes);
    expect([est0.quota, est1.quota]).toContain(snap.storage.quotaBytes);
    expect(snap.storage.persisted).toBe(persisted);
    expect(snap.storage).toMatchObject({ pauseAtBytes: null, paused: false });

    const st = (await api("/v1/status")).body;
    expect(snap.overview).toMatchObject({ startHeight: st.startHeight, archiveHeight: st.archiveHeight, scanHeight: st.indexedHeight });
    expect(snap.overview.archiveHeight).toBe(U1.to);
    expect(snap.scan.scanner).toBe(st.scanner);
    const s = await status();
    expect(snap.databases).toMatchObject({ dataDir: STORE, serverVersion: s.store!.serverVersion, fsync: "off", durability: "non-durable" });
    expect(snap.databases.schemas.map((x) => x.migrations.map((m) => m.name))).toEqual([s.store!.migrations.archive, s.store!.migrations.mip0018]);
    expect(snap.browser).toEqual({ browser: s.boot.capabilities!.browser, checks: s.boot.capabilities!.checks });
    expect(snap.configuration).toMatchObject({
      watchdogLimitMs: 30_000,
      build: { appCommit: APP_COMMIT, pgliteVersion: versionOf("@electric-sql/pglite"), ledgerVersion: versionOf("@midnightntwrk/ledger-v9"), postgresVersion: s.store!.serverVersion, mip: st.mip, vendored: st.vendored },
    });
    expect(snap.engine).toMatchObject({ watchdogRestarts: 0, pgliteReopens: 0 });

    // The same store read by another page's PGlite once the engine's worker is gone. The worker was terminated, so
    // the reader's PGlite first replays the WAL it left; that replay can create a table's free-space map, the only
    // difference allowed here. Then the engine opens the store the reader closed cleanly, and the two reads must agree.
    const catalog = `SELECT n.nspname AS schema, c.relname AS name, pg_total_relation_size(c.oid)::text AS total, c.reltuples,
      pg_relation_size(c.oid, 'fsm')::text AS fsm
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('chain_archive', 'mip0018') AND c.relkind IN ('r', 'p') ORDER BY 1, 2`;
    const tablesOf = (x: SystemSnapshot) => x.databases.schemas.flatMap((sc) => sc.tables.map((t) => ({ schema: sc.name, ...t })));
    async function readStore(of: SystemSnapshot): Promise<{ rels: Json[]; size: number; counts: number[] }> {
      const counts = tablesOf(of).map((t) => `SELECT count(*)::text AS n FROM "${t.schema}"."${t.name}"`);
      await page.goto(`${server.origin}/reader/index.html`);
      await page.waitFor("typeof window.readStore === 'function'", 30_000, "the reader page");
      const [rels, sizeRows, ...countRows] = (await page.eval(`window.readStore(${JSON.stringify(STORE)}, ${JSON.stringify([catalog, "SELECT pg_database_size(current_database())::text AS size", ...counts])})`)) as Json[][];
      return { rels: rels!, size: Number(sizeRows![0].size), counts: countRows.map((r) => Number(r[0].n)) };
    }

    const round1 = await readStore(snap);
    const tables1 = tablesOf(snap);
    expect(round1.rels.map((r) => `${r.schema}.${r.name}`)).toEqual(tables1.map((t) => `${t.schema}.${t.name}`).sort());
    report.afterTermination = round1.rels
      .map((r) => ({ table: `${r.schema}.${r.name}`, reader: Number(r.total), fsm: Number(r.fsm), snapshot: tables1.find((t) => t.schema === r.schema && t.name === r.name)!.totalBytes }))
      .filter((d) => d.reader !== d.snapshot);
    for (const d of report.afterTermination as Array<{ table: string; reader: number; fsm: number; snapshot: number }>) expect(d.reader - d.fsm, d.table).toBe(d.snapshot);
    tables1.forEach((t, i) => expect(t.exactRows, `${t.schema}.${t.name} rows`).toBe(round1.counts[i]));

    const reopened = await open();
    expect(reopened.store!.created).toBe(false);
    const snap2: SystemSnapshot = SystemSnapshotSchema.parse((await engine("c.system({ refresh: { database: true, exactCounts: true } })")).snapshot);
    const round2 = await readStore(snap2);
    const tables2 = tablesOf(snap2);
    for (const r of round2.rels) {
      const t = tables2.find((x) => x.schema === r.schema && x.name === r.name)!;
      expect(t.totalBytes, `${r.schema}.${r.name} size`).toBe(Number(r.total));
      expect(t.estimatedRows, `${r.schema}.${r.name} estimate`).toBe(r.reltuples < 0 ? null : r.reltuples);
    }
    tables2.forEach((t, i) => expect(t.exactRows, `${t.schema}.${t.name} rows`).toBe(round2.counts[i]));
    report.databaseBytes = { snapshot: snap.databases.databaseBytes, reader: round1.size, snapshotAfterCleanClose: snap2.databases.databaseBytes, readerAgain: round2.size };
    const fsmAdded = (report.afterTermination as Array<{ fsm: number }>).reduce((a, d) => a + d.fsm, 0);
    expect(round1.size - snap.databases.databaseBytes!, "the database grew by the free-space maps alone").toBe(fsmAdded);
    expect(snap2.databases.databaseBytes).toBe(round2.size);
    expect(page.exceptions).toEqual([]);
  }, 300_000);
});
