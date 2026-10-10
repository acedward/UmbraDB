/**
 * The browser engine's system snapshot, watchdog and scheduling in Chrome, on OPFS: the static build served from
 * 127.0.0.1 with an OPFS reader page beside it (`fixtures/opfs-reader/`, an independent PGlite on the same store),
 * driven over the DevTools protocol (`helpers/cdp-browser.ts`), with recorded Stagenet ranges replayed in the worker.
 *
 * - `[[browser.worker.system]]` — a snapshot from the worker validates against the schema and its values equal their
 *   sources: heights equal `/v1/status`; storage equals `navigator.storage.estimate()` and `persisted()` read by the
 *   page and the storage guard's reading (its pause threshold); table sizes, row estimates, exact row counts and the database size equal `pg_total_relation_size`,
 *   `reltuples`, `count(*)` and `pg_database_size` read by the reader page from the store; the configuration shows the
 *   build's facts (`define`), the watchdog limit, the data directory and the browser's capability report. While watched
 *   a snapshot arrives every 2 s; unwatched, nothing is collected (no notice, no `/v1/status` read, no catalog read).
 *   The reader first opens the store the terminated engine worker left: replaying its WAL can add a table's free-space
 *   map (the only difference allowed then); after the reader closed the store cleanly and the engine reopened it, the
 *   two reads agree exactly.
 * - `[[browser.worker.system-tabs]]` — a follower tab watches the leader's snapshots through the leader: it receives
 *   them marked `follower` with the time it received them; when it closes without unwatching, its viewer is released and
 *   the leader's worker stops collecting.
 * - `[[browser.worker.watchdog]]` — the worker's thread is held busy (as by a statement that does not return) while it
 *   replays the IDX range: the page terminates it after the watchdog's limit (a short one: three times the page's boot
 *   measured on the machine, at least 2 s) and grace, the API request in flight gets the API's 503 `UNAVAILABLE`
 *   answer, a new worker boots on the same store and continues the engine at the stored cursors; the finished store has
 *   the recorded archive digest and 37-table digest, and the snapshot counts the one restart with its reason.
 * - `[[browser.worker.api-latency]]` — the round trip of `/v1/status`, `/v1/tokens` and a contract's activity page from
 *   the page while the worker replays the IDX range (sync and scan running) and with the engine stopped: p95 bounded,
 *   and no heartbeat missed during the replay (every gap under two intervals; the largest measured and reported).
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_BROWSER_REPORT=<file>` writes the measurements as JSON (never committed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeReplay, type TapeReplay } from "../../chain-archive-sync/tape-replay.js";
import { DEFAULT_HEARTBEAT_MS, type HostStatus } from "../browser/protocol.ts";
import { pauseThresholdBytes } from "../browser/quota.ts";
import { type SystemSnapshot, SystemSnapshotSchema } from "../engine/system-snapshot.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { buildSite, ROOT, serveSite } from "./helpers/browser-site.ts";
import { unavailableAnswer } from "../browser/client.ts";
import { percentile } from "../engine/telemetry.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const U1 = { from: 715402, to: 715433 } as const;
const IDX = { from: 714485, to: 715183 } as const;
/** The recorded live digests of the IDX range: the archive (7 tables) and every table of both schemas (37). */
const IDX_ARCHIVE = "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119";
const IDX_TABLES = "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c";
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

    // Unwatched: no notice, no /v1/status read, no catalog read. A collection already under way when the watch ends
    // still finishes (its snapshot is not posted); a refresh waits behind it, so the refreshed snapshot (catalog read
    // included) is where the unwatched time starts.
    expect(await engine("c.system({ watch: false })")).toEqual({ watching: false, viewers: 0, snapshot: null });
    const unwatched = SystemSnapshotSchema.parse((await engine("c.system({ refresh: { database: true } })")).snapshot);
    const n = (await page.eval("window.__snaps.length")) as number;
    await sleep(6_000);
    expect(await page.eval("window.__snaps.length"), "no snapshot while unwatched").toBe(n);
    const after = SystemSnapshotSchema.parse((await engine("c.system({ refresh: {} })")).snapshot);
    expect(after.api.served, "only the refresh read /v1/status").toBe(unwatched.api.served + 1);
    expect(after.databases.collectedAt, "no catalog read while unwatched").toBe(unwatched.databases.collectedAt);
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
    const guard = (await status()).storage!;
    expect(snap.storage).toMatchObject({ usageBytes: guard.usageBytes, quotaBytes: guard.quotaBytes, persisted: guard.persisted, pauseAtBytes: guard.pauseAtBytes, paused: false, pausedReason: null });
    expect(guard.pauseAtBytes).toBe(pauseThresholdBytes(guard.quotaBytes!));

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

  /** Loads the engine page in `p` and waits for its boot (and, for a leader, its worker's boot). */
  async function load(p: Page, query = ""): Promise<void> {
    await p.goto(`${server.origin}/engine.html${query}`);
    await p.waitFor("window.umbradbEngine !== undefined", 30_000, "the engine page");
    await p.eval("window.umbradbEngine.tabs.ready");
    await p.eval("window.umbradbEngine.client.booted()");
  }
  /** Opens the engine page in a tab of `b` and waits for its boot (and, for a leader, its worker's boot). */
  async function engineTab(b: Browser, query = "", opts: { workers?: boolean } = {}): Promise<Page> {
    const p = await b.newPage(opts);
    await load(p, query);
    return p;
  }
  const on = (p: Page) => (expr: string): Promise<Json> => p.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
  async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 120_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await read();
      if (ok(v)) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 500)}`);
      await sleep(100);
    }
  }

  it("[[browser.worker.system-tabs]] a follower tab watches the leader's snapshots through the leader and gets them marked follower; closing it without unwatching releases its viewer, and the leader's worker stops collecting", async () => {
    const a = await engineTab(browser);
    const b = await engineTab(browser);
    expect(await a.eval("window.umbradbEngine.tabs.role()")).toBe("leader");
    expect(await b.eval("window.umbradbEngine.tabs.role()")).toBe("follower");
    const inA = on(a);
    const inB = on(b);
    await b.eval(`(() => { window.__snaps = []; window.umbradbEngine.client.onNotice((n) => { if (n.notice === "system") window.__snaps.push(n.snapshot); }); })()`);
    expect(await inB(`c.system({ watch: true, viewer: "tab-b" })`)).toEqual({ watching: true, viewers: 1, snapshot: null });
    await b.waitFor("window.__snaps.length >= 2", 30_000, "two relayed snapshots");
    const relayed = ((await b.eval("window.__snaps")) as Json[]).map((x) => SystemSnapshotSchema.parse(x));
    for (const x of relayed) {
      expect(x.role).toBe("follower");
      expect(x.relayedAt).toBeGreaterThanOrEqual(x.generatedAt);
    }
    const refreshed = SystemSnapshotSchema.parse((await inB("c.system({ refresh: {} })")).snapshot);
    expect(refreshed.role).toBe("follower");
    expect(refreshed.engine.connectedTabs).toBe(2);
    expect((await inA("c.system({ refresh: {} })")).viewers).toBe(1);

    await b.close();
    await waitFor("the closed tab's viewer to be released", () => inA("c.system({ refresh: {} })"), (r: Json) => r.viewers === 0 && r.watching === false, 30_000);
    await a.close();
  }, 120_000);

  it("[[browser.worker.watchdog]] the worker's thread held busy during the IDX replay is terminated after the limit and grace; the API request in flight gets the 503; a new worker continues at the stored cursors to the recorded digests; the snapshot counts the restart", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      // The limit is short for a test, yet well above the time the engine page takes to boot its worker on this machine
      // (measured first in the same tab, on the default limit), so a slow machine's boot of the replacement worker is
      // not taken for a stuck worker: the held thread below is the one restart this test is about.
      const p = await b.newPage({ workers: true });
      const t0 = performance.now();
      await load(p);
      const bootMs = performance.now() - t0;
      const LIMIT_MS = Math.max(2_000, Math.ceil(3 * bootMs));
      await load(p, `?watchdogLimitMs=${LIMIT_MS}`);
      const inP = on(p);
      await inP(`c.start(${JSON.stringify({ source: { kind: "tape", range: "idx" }, startHeight: IDX.from, ...FAST })})`);
      const before = await waitFor("a first part of the range", () => inP("c.status()"), (s: HostStatus) => (s.cursors?.scan?.nextHeight ?? 0) > IDX.from + 150);
      // Hold the worker's thread, as a statement that does not return holds it.
      await p.evalWorker("setTimeout(() => { const end = Date.now() + 600000; while (Date.now() < end) {} }, 0); true");
      await sleep(50);
      const t1 = performance.now();
      const answer = (await inP(`c.api("GET", "/v1/tokens")`)) as Json;
      const detectedMs = performance.now() - t1;
      expect(answer).toEqual(unavailableAnswer("GET"));
      const restarts = (await p.eval("window.umbradbEngine.restarts()")) as Array<{ at: number; reason: string }>;
      expect(restarts).toHaveLength(1);
      expect(restarts[0]!.reason).toMatch(new RegExp(`^the engine worker sent nothing for \\d+ ms \\(limit ${LIMIT_MS} ms\\)$`));
      expect((await inP("c.booted()")).phase, "the new worker's boot").toBe("ready");
      const replacementBootMs = performance.now() - t1 - detectedMs;
      report.watchdog = { bootMs: Math.round(bootMs), limitMs: LIMIT_MS, detectedMs: Math.round(detectedMs), replacementBootMs: Math.round(replacementBootMs), reason: restarts[0]!.reason, cursorsBefore: before.cursors };
      console.log("watchdog in Chrome", JSON.stringify(report.watchdog));

      const end = await waitFor("the rest of the range on the new worker", () => inP("c.status()"), (s: HostStatus) => s.cursors?.sync?.height === IDX.to && s.cursors?.scan?.nextHeight === IDX.to + 1, 180_000);
      expect(end.engine).toMatchObject({ running: true });
      expect(end.cursors!.sync!.startHeight).toBe(IDX.from);
      const d = (await inP("c.digest()")) as Json;
      expect(d.archive.sha256).toBe(IDX_ARCHIVE);
      expect(d.tables.sha256).toBe(IDX_TABLES);
      const snap = SystemSnapshotSchema.parse((await inP("c.system({ refresh: {} })")).snapshot);
      expect(snap.engine.watchdogRestarts).toBe(1);
      expect(snap.engine.lastWatchdogRestart?.reason).toBe(restarts[0]!.reason);
      expect(snap.configuration.watchdogLimitMs).toBe(LIMIT_MS);
      expect(snap.logs.some((l) => l.text === `watchdog restart: ${restarts[0]!.reason}`)).toBe(true);
      expect(p.exceptions).toEqual([]);
      await p.close();
    } finally {
      await b.close();
    }
  }, 300_000);

  it("[[browser.worker.api-latency]] the page's API round trips are bounded while the worker replays the IDX range (sync and scan running), and measured with the engine stopped", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await engineTab(b);
      const inP = on(p);
      await p.eval(`(() => { window.__beats = []; window.umbradbEngine.client.onNotice((n) => { if (n.notice === "heartbeat") window.__beats.push(performance.now()); }); })()`);
      // Requests in a loop inside the page: status, tokens and (once a contract is known) its activity page.
      const loop = `(async () => {
        const c = window.umbradbEngine.client;
        const lat = { status: [], tokens: [], activity: [] };
        let contract = null;
        const done = () => c.status().then((s) => s.cursors?.sync?.height === ${IDX.to} && s.cursors?.scan?.nextHeight === ${IDX.to + 1});
        const t0 = performance.now();
        const timed = async (k, target) => { const a = performance.now(); const r = await c.api("GET", target); lat[k].push(performance.now() - a); return r; };
        for (let i = 0; ; i++) {
          if (i % 10 === 0 && (await done())) break;
          await timed("status", "/v1/status");
          const t = await timed("tokens", "/v1/tokens?limit=50");
          if (contract === null) { const item = JSON.parse(t.body).items?.find((x) => x.contractAddress); if (item) contract = item.contractAddress; }
          if (contract !== null) await timed("activity", "/v1/contracts/" + contract + "/activity?limit=50");
          if (performance.now() - t0 > 240000) break;
        }
        return { lat, contract, replayMs: performance.now() - t0 };
      })()`;
      const beatsFrom = (await p.eval("performance.now()")) as number;
      await inP(`c.start(${JSON.stringify({ source: { kind: "tape", range: "idx" }, startHeight: IDX.from, ...FAST })})`);
      const during = (await p.eval(loop)) as { lat: Record<string, number[]>; contract: string | null; replayMs: number };
      const beats = ((await p.eval("window.__beats")) as number[]).filter((t) => t >= beatsFrom);
      const gaps = beats.slice(1).map((t, i) => t - beats[i]!);
      await inP("c.stop()");
      expect(during.contract).not.toBeNull();
      const activity = JSON.stringify(`/v1/contracts/${during.contract}/activity?limit=50`);
      const idle = (await p.eval(`(async () => {
        const c = window.umbradbEngine.client;
        const lat = { status: [], tokens: [], activity: [] };
        const timed = async (k, target) => { const a = performance.now(); await c.api("GET", target); lat[k].push(performance.now() - a); };
        for (let i = 0; i < 100; i++) {
          await timed("status", "/v1/status");
          await timed("tokens", "/v1/tokens?limit=50");
          await timed("activity", ${activity});
        }
        return lat;
      })()`)) as Record<string, number[]>;
      const stats = (xs: number[]) => ({ n: xs.length, p50: Math.round(percentile(xs, 0.5)! * 10) / 10, p95: Math.round(percentile(xs, 0.95)! * 10) / 10, max: Math.round(Math.max(...xs) * 10) / 10 });
      const result = {
        replayMs: Math.round(during.replayMs),
        during: Object.fromEntries(Object.entries(during.lat).map(([k, v]) => [k, stats(v)])),
        stopped: Object.fromEntries(Object.entries(idle).map(([k, v]) => [k, stats(v)])),
        heartbeat: { beats: beats.length, maxGapMs: Math.round(Math.max(...gaps)), p95GapMs: Math.round(percentile(gaps, 0.95)!) },
      };
      report.apiLatency = result;
      console.log("API latency in Chrome (IDX replay in the worker, OPFS)", JSON.stringify(result));
      for (const k of ["status", "tokens", "activity"]) {
        expect(during.lat[k]!.length, k).toBeGreaterThan(10);
        expect(percentile(during.lat[k]!, 0.95)!, `${k} p95 during the replay`).toBeLessThan(250);
      }
      // The heartbeat keeps coming: no beat is missed (a gap of two intervals would be one). A beat comes late by as long
      // as the worker's thread is not given the processor, which a loaded machine stretches; the watchdog allows far more.
      expect(Math.max(...gaps), "no heartbeat missed during the replay").toBeLessThan(2 * DEFAULT_HEARTBEAT_MS);
      await p.close();
    } finally {
      await b.close();
    }
  }, 400_000);
});
