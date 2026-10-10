/**
 * The system status page (`token-indexer/browser/system.html`) in Chrome, on the static build served from 127.0.0.1
 * with its `_headers` (the Content-Security-Policy with Trusted Types, cross-origin isolation), driven over the
 * DevTools protocol (`helpers/cdp-browser.ts`). The chain is the site's own `/chain/rpc` and `/chain/graphql` (a
 * recorded range, a refusal, or an answer the test writes), or a recorded range replayed inside the worker; an OPFS
 * reader page beside the build (`fixtures/opfs-reader/`, served without the headers) reads and changes the store as an
 * independent PGlite once the engine's worker is gone. The build never starts the engine by itself.
 *
 * - `[[browser.status.sources]]` — every section of the page shows values, the page draws exactly its view of the
 *   snapshot it shows (`system-model.ts`), and the values equal their sources: heights, scanner and unresolved events
 *   equal `/v1/status`; storage equals `navigator.storage.estimate()`/`persisted()` read by the page and the engine's
 *   storage reading; table sizes, row estimates (after `ANALYZE`), exact row counts (on demand), the database size,
 *   the server version and the applied migrations equal `pg_total_relation_size`, `pg_class.reltuples`, `count(*)`,
 *   `pg_database_size`, `server_version` and `_migrations` read from the store by the reader page. No CSP violation in
 *   the page or the worker, and every request goes to the site.
 * - `[[browser.status.states]]` — the page shows each driven state with its details: waiting (network) while the
 *   endpoints answer 503, with the sync's last error and next retry; catching up and following once a chain answers;
 *   paused (quota) with its reason while the storage estimate is near the quota; a watchdog restart (the restart count
 *   rises, with its reason, and the engine goes on); stopped; stalled (scan) with the scan's error after the stored
 *   scan cursor's block hash no longer matches the next block's parent.
 * - `[[browser.status.follower]]` — a second tab's status page shows the leader's engine, marked follower, with the
 *   leader's heights and two connected tabs; when the leader tab closes it becomes leader and shows its own engine.
 * - `[[browser.status.hidden]]` — while the page is hidden it watches nothing: no snapshot arrives, the engine reads
 *   neither `/v1/status` nor the catalog for it, and the page says it is paused; visible again, it follows again.
 * - `[[browser.status.hostile-text]]` — an error message with control, bidi, zero-width and markup characters (here a
 *   node's JSON-RPC error) is drawn as text: every hidden character as its visible mark, markup as characters; no
 *   element, script or request comes from it, and no raw hidden character reaches the drawn text or an attribute.
 * - `[[browser.status.links]]` — the explorer's engine panel links to the status page and the status page links back to
 *   the explorer, both followed in one tab under the headers' policy: every request answered, no violation.
 * - `[[browser.status.diagnostics]]` — "Download diagnostics" under the headers' policy saves the snapshot the page
 *   shows as JSON: it validates against the versioned schema, equals that snapshot, holds its log lines, and holds
 *   none of the secrets the engine was given (credentials and a key in a URL, a token, a password, a bearer
 *   credential, an authorization header, a viewing key) nor the page's own address.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_BROWSER_REPORT=<file>` writes what was observed as JSON (never committed).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeReplay } from "../../chain-archive-sync/tape-replay.js";
import type { HostStatus } from "../browser/protocol.ts";
import { bytesText, countText, startText, statusSections } from "../browser/system-model.ts";
import { visibleText } from "../browser/visible-text.ts";
import { diagnosticsJson, HEALTH_LABELS, type SystemSnapshot, SystemSnapshotSchema } from "../engine/system-snapshot.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { buildEngineSite, type ChainAnswer, chainDown, REPO_ROOT } from "./helpers/engine-site.ts";
import { type LocalServer, parseHeadersFile, serveStaticSite } from "./helpers/static-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const U1 = { from: 715402, to: 715433 } as const;
const IDX = { from: 714485, to: 715183 } as const;
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };
const STORE = "opfs-ahp://umbradb-stagenet";
const APP_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const L = HEALTH_LABELS;
// Raw characters that must never reach the drawn text (tab and newline excepted in innerText, which uses them for
// layout) or an attribute: the explorer's rule, in Node's Unicode data.
const HIDDEN_RAW = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const HIDDEN_RAW_ATTR = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const browserExe = findBrowser();

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".data": "application/octet-stream", ".css": "text/css" };

/** What the page draws: every `[data-field]` element's text (table cells grouped by field, in row order). */
const DRAWN = `(() => {
  const fields = {};
  for (const e of document.querySelectorAll("[data-field]")) {
    if (e.tagName === "TABLE") continue;
    const k = e.getAttribute("data-field");
    (fields[k] = fields[k] || []).push(e.textContent);
  }
  return { snapshot: window.umbradbSystem.latest(), fields, renders: window.umbradbSystem.renders,
    health: document.body.getAttribute("data-health"), role: document.body.getAttribute("data-role"), live: document.body.getAttribute("data-live") };
})()`;

interface Drawn {
  snapshot: SystemSnapshot | null;
  fields: Record<string, string[]>;
  renders: number;
  health: string | null;
  role: string | null;
  live: string | null;
}

describe("the system status page in Chrome (static build with its headers)", () => {
  let out: string;
  let site: LocalServer;
  let chain: ChainAnswer = chainDown;
  let idxTape: Awaited<ReturnType<typeof readTape>>;
  const report: Record<string, Json> = {};

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    const saved = process.env.UMBRADB_APP_COMMIT;
    process.env.UMBRADB_APP_COMMIT = APP_COMMIT;
    try {
      out = await buildEngineSite({ __UMBRADB_BROWSER_CONFIG__: JSON.stringify({ autoStart: false, quota: { checkEveryMs: 0, recheckMs: 300, storeEveryMs: 1_000 } }) });
    } finally {
      if (saved === undefined) delete process.env.UMBRADB_APP_COMMIT;
      else process.env.UMBRADB_APP_COMMIT = saved;
    }
    const { build } = await import("vite");
    await build({
      logLevel: "silent",
      configFile: false,
      root: join(REPO_ROOT, "token-indexer/test/fixtures/opfs-reader"),
      base: "./",
      worker: { format: "es" },
      optimizeDeps: { exclude: ["@electric-sql/pglite"] },
      build: { outDir: join(out, "reader"), emptyOutDir: true, target: "esnext", assetsInlineLimit: 0, reportCompressedSize: false, chunkSizeWarningLimit: 20_000 },
    });
    idxTape = await readTape(new Uint8Array(readFileSync(join(REPO_ROOT, "token-indexer/browser/tapes/stagenet-714485-715183.tape.json.gz"))), "gzip");
    const headers = parseHeadersFile(readFileSync(join(out, "_headers"), "utf8"));
    const route = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
      if (url.pathname.startsWith("/chain/")) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void chain(url.pathname.slice("/chain".length), Buffer.concat(chunks).toString("utf8")).then((a) => {
            res.writeHead(a.status, a.headers);
            res.end(a.body);
          }, () => res.writeHead(500).end());
        });
        return true;
      }
      if (url.pathname.startsWith("/reader/")) {
        // The test-only reader page creates its worker without the build's Trusted Types policy: served without headers.
        const file = normalize(join(out, decodeURIComponent(url.pathname)));
        if (!file.startsWith(out + sep) || !existsSync(file)) res.writeHead(404).end();
        else res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
        return true;
      }
      return false;
    };
    site = await serveStaticSite(out, { headers, route });
  }, 240_000);

  afterAll(async () => {
    await site?.close();
    if (out !== undefined) rmSync(out, { recursive: true, force: true });
    if (process.env.UMBRADB_BROWSER_REPORT) writeFileSync(process.env.UMBRADB_BROWSER_REPORT, JSON.stringify(report, null, 2));
  });

  const on = (p: Page) => (expr: string): Promise<Json> => p.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
  const drawn = (p: Page): Promise<Drawn> => p.eval<Drawn>(DRAWN);
  const one = (d: Drawn, field: string): string => {
    const v = d.fields[field];
    if (v === undefined || v.length !== 1) throw new Error(`the page draws ${field} ${v === undefined ? "nowhere" : `${v.length} times`}`);
    return v[0]!;
  };

  /** Opens the status page in a new tab of `b` and waits for its first drawn snapshot. */
  async function openStatus(b: Browser, query = "", opts: { workers?: boolean } = {}): Promise<Page> {
    const p = await b.newPage(opts);
    await p.goto(`${site.origin}/system.html${query}`);
    await p.waitFor("window.umbradbEngine !== undefined && window.umbradbSystem !== undefined", 30_000, "the status page");
    await p.eval("window.umbradbEngine.tabs.ready");
    await p.eval("window.umbradbEngine.client.booted()");
    await p.waitFor("window.umbradbSystem.renders >= 1", 30_000, "the first drawn snapshot");
    return p;
  }

  async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 120_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await read();
      if (ok(v)) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 800)}`);
      await sleep(100);
    }
  }

  /** Waits until the page draws the health `label`; returns what it draws then. */
  const untilHealth = (p: Page, label: string, timeoutMs = 60_000): Promise<Drawn> =>
    waitFor(`the health line "${label}"`, () => drawn(p), (d) => d.fields["overview.health"]?.[0] === label, timeoutMs);

  /** The page draws its view of the snapshot it holds: every value and every table cell with a field. */
  function expectDrawnFromSnapshot(d: Drawn): SystemSnapshot {
    expect(d.snapshot).not.toBeNull();
    const s = SystemSnapshotSchema.parse(d.snapshot);
    const expected: Record<string, string[]> = {};
    for (const sec of statusSections(s)) {
      for (const v of sec.values) (expected[v.field] ??= []).push(visibleText(v.text));
      for (const t of sec.tables) for (const r of t.rows) for (const c of r) if (c.field !== undefined) (expected[c.field] ??= []).push(visibleText(c.text));
    }
    expect(d.fields).toEqual(expected);
    expect(d.health).toBe(s.overview.health.state);
    expect(d.role).toBe(s.role);
    return s;
  }

  /** The store read by the reader page (the engine's worker must be gone). */
  async function readStore(p: Page, statements: string[]): Promise<Json[][]> {
    await p.goto(`${site.origin}/reader/index.html`);
    await p.waitFor("typeof window.readStore === 'function'", 30_000, "the reader page");
    return p.eval<Json[][]>(`window.readStore(${JSON.stringify(STORE)}, ${JSON.stringify(statements)})`);
  }

  async function noViolations(p: Page, worker: boolean): Promise<void> {
    expect(await p.eval("window.__cspViolations")).toEqual([]);
    if (worker) expect(await p.evalWorker("self.__cspViolations")).toEqual([]);
    expect(p.logs.filter((l) => /Content Security Policy|Trusted Type|content security/i.test(l.text))).toEqual([]);
    expect(p.exceptions).toEqual([]);
  }

  /** Every request of the page (and its workers) went to the site. */
  const offSite = (p: Page): string[] => p.requests.filter((r) => !r.url.startsWith(`${site.origin}/`)).map((r) => r.url);

  it("[[browser.status.sources]] every section shows values; the page draws its view of the snapshot; heights equal /v1/status, storage equals navigator.storage, table sizes, estimates, exact counts, database size, server version and migrations equal the store's catalog; no CSP violation, every request to the site", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      let p = await openStatus(b, "", { workers: true });
      const inP = on(p);
      expect(await p.eval("window.umbradbEngine.tabs.role()")).toBe("leader");
      await inP(`c.start(${JSON.stringify({ source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST })})`);
      await waitFor("the U1 range", () => inP("c.status()"), (s: HostStatus) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
      await inP("c.stop()");
      await noViolations(p, true);
      expect(offSite(p)).toEqual([]);

      // The store as an independent PGlite sees it once the engine's worker is gone: give it planner statistics, so the
      // estimates are numbers, and close it cleanly (the engine then reopens a store with nothing to replay).
      await readStore(p, ["ANALYZE"]);

      // The page again, with the store just analyzed: exact counts on demand.
      p = await openStatus(b, "", { workers: true });
      const inP2 = on(p);
      const est0 = await p.eval<{ usage: number; quota: number }>("navigator.storage.estimate().then((e) => ({ usage: e.usage, quota: e.quota }))");
      const t0 = Date.now();
      await p.eval("document.querySelector('[data-action=count-rows]').click()");
      const d = await waitFor("the exact counts", () => drawn(p), (x) => x.snapshot !== null && x.snapshot.databases.exactRowsAt !== null);
      report.countRowsMs = Date.now() - t0;
      const est1 = await p.eval<{ usage: number; quota: number }>("navigator.storage.estimate().then((e) => ({ usage: e.usage, quota: e.quota }))");
      const persisted = await p.eval<boolean>("navigator.storage.persisted()");
      const s = expectDrawnFromSnapshot(d);
      const st = JSON.parse(((await inP2(`c.api("GET", "/v1/status")`)) as { body: string }).body) as Json;
      const host = (await inP2("c.status()")) as HostStatus;

      // Every section shows values.
      for (const id of ["overview", "configuration", "sync", "scan", "databases", "storage", "api", "engine", "browser", "snapshots", "logs"]) {
        const shown = await p.eval<string[]>(`[...document.querySelectorAll('section[data-section="${id}"] .kv [data-field]')].map((e) => e.textContent)`);
        expect(shown.filter((x) => x !== "\u2014").length, id).toBeGreaterThan(0);
      }
      expect(d.fields["logs.text"]!.length).toBe(s.logs.length);
      expect(s.logs.length).toBeGreaterThan(0);

      // Heights, scanner and unresolved events: /v1/status.
      expect(one(d, "overview.startHeight")).toBe(startText(st.startHeight));
      expect(st.startHeight).toBe(U1.from);
      expect(one(d, "overview.archiveHeight")).toBe(String(st.archiveHeight));
      expect(one(d, "sync.archiveHeight")).toBe(String(st.archiveHeight));
      expect(st.archiveHeight).toBe(U1.to);
      expect(one(d, "overview.scanHeight")).toBe(String(st.indexedHeight));
      expect(one(d, "scan.scanner")).toBe(st.scanner);
      expect(one(d, "scan.unresolvedEvents")).toBe(countText(st.unresolvedEvents));
      expect(one(d, "configuration.mip")).toBe(`${st.mip.id} @ ${st.mip.commit}`);
      expect(one(d, "configuration.appCommit")).toBe(APP_COMMIT);
      expect(one(d, "databases.durability")).toBe(st.durability);
      expect(one(d, "overview.health")).toBe(L.stopped);

      // Storage: the page's navigator.storage and the engine's storage reading.
      expect([bytesText(est0.usage), bytesText(est1.usage)]).toContain(one(d, "storage.usageBytes"));
      expect([bytesText(est0.quota), bytesText(est1.quota)]).toContain(one(d, "storage.quotaBytes"));
      expect(one(d, "storage.persisted")).toBe(persisted ? "yes" : "no");
      expect(one(d, "storage.pauseAtBytes")).toBe(bytesText(host.storage!.pauseAtBytes));
      expect(one(d, "databases.dataDir")).toBe(STORE);
      report.storage = { drawn: [one(d, "storage.usageBytes"), one(d, "storage.quotaBytes")], page: [est0, est1], persisted };

      // The catalog, read from the store by the reader once this page's worker is gone.
      const tables = s.databases.schemas.flatMap((sc) => sc.tables.map((t) => ({ schema: sc.name, name: t.name })));
      const [rels, size, version, archiveMigrations, mipMigrations, ...counts] = await readStore(p, [
        `SELECT n.nspname AS schema, c.relname AS name, pg_total_relation_size(c.oid)::text AS total, c.reltuples
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname IN ('chain_archive', 'mip0018') AND c.relkind IN ('r', 'p') ORDER BY 1, 2`,
        "SELECT pg_database_size(current_database())::text AS size",
        "SELECT current_setting('server_version') AS v",
        "SELECT name FROM chain_archive._migrations ORDER BY applied_at, name",
        "SELECT name FROM mip0018._migrations ORDER BY applied_at, name",
        ...tables.map((t) => `SELECT count(*)::text AS n FROM "${t.schema}"."${t.name}"`),
      ]);
      expect(rels!.map((r) => `${r.schema}.${r.name}`)).toEqual(tables.map((t) => `${t.schema}.${t.name}`).sort());
      let estimated = 0;
      for (const r of rels!) {
        const f = (k: string): string => one(d, `databases.${r.schema}.${r.name}.${k}`);
        expect(f("totalBytes"), `${r.schema}.${r.name} size`).toBe(bytesText(Number(r.total)));
        expect(f("estimatedRows"), `${r.schema}.${r.name} estimate`).toBe(r.reltuples < 0 ? "no estimate" : countText(Math.round(r.reltuples)));
        if (r.reltuples >= 0) estimated++;
      }
      expect(estimated, "tables with an estimate after ANALYZE").toBeGreaterThan(10);
      tables.forEach((t, i) => expect(one(d, `databases.${t.schema}.${t.name}.exactRows`), `${t.schema}.${t.name} rows`).toBe(countText(Number(counts[i]![0].n))));
      expect(one(d, "databases.databaseBytes")).toBe(bytesText(Number(size![0].size)));
      expect(one(d, "databases.serverVersion")).toBe(version![0].v);
      expect(d.fields["databases.chain_archive.migration"]).toEqual(archiveMigrations!.map((m) => m.name));
      expect(d.fields["databases.mip0018.migration"]).toEqual(mipMigrations!.map((m) => m.name));
      report.sources = { tables: tables.length, estimated, databaseBytes: Number(size![0].size) };

      expect(p.exceptions).toEqual([]);
      expect(offSite(p)).toEqual([]);
      await p.close();
    } finally {
      await b.close();
    }
  }, 300_000);

  it("[[browser.status.states]] the page shows each driven state: waiting (network) with the last error and the next retry, catching up and following, paused (quota) with its reason, a watchdog restart counted with its reason, stopped, and stalled (scan) with the scan's error", async () => {
    const b = await Browser.launch(browserExe!);
    const seen: string[] = [];
    try {
      let p = await openStatus(b, "?watchdogLimitMs=2000", { workers: true });
      const inP = on(p);
      const network = {
        source: { kind: "network", nodeUrl: `${site.origin}/chain/rpc`, indexerUrl: `${site.origin}/chain/graphql` },
        startHeight: "tip",
        sync: { idleMs: 300, backoff: { baseDelayMs: 200, maxDelayMs: 1_000, maxAttempts: 2 } },
        scan: { idleMs: 200 },
      };

      // Waiting: the endpoints answer 503.
      chain = chainDown;
      await inP(`c.start(${JSON.stringify(network)})`);
      const waiting = await untilHealth(p, L["waiting-network"]);
      const sw = expectDrawnFromSnapshot(waiting);
      expect(sw.sync.lastError?.message).toMatch(/HTTP 503/);
      expect(one(waiting, "sync.lastError")).toContain("HTTP 503");
      const retry = await waitFor("the next retry", () => drawn(p), (x) => x.fields["overview.health"]?.[0] === L["waiting-network"] && x.snapshot?.sync.nextAttemptAt !== null);
      expect(one(retry, "sync.nextAttemptAt")).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \((in .+|now|.+ ago)\)$/);
      expect(one(retry, "sync.endpoints.node.http5xx")).not.toBe("0");
      seen.push(waiting.health!);

      // The chain answers (the IDX range, its tip rising 2 blocks/s): catching up, then following.
      const tape = createTapeReplay(idxTape, { finalizedHeight: 714600, advance: { everyMs: 500, by: 1 } });
      chain = (path, body) => tape.answer(path, body);
      const following = await waitFor("following", async () => {
        const x = await drawn(p);
        if (x.health !== null && seen.at(-1) !== x.health) seen.push(x.health);
        return x;
      }, (x) => x.fields["overview.health"]?.[0] === L.following, 90_000);
      const sf = expectDrawnFromSnapshot(following);
      expect(sf.overview.finalizedTip).toBeGreaterThanOrEqual(714600);
      expect(one(following, "sync.lastError")).toBe("\u2014");
      report.statesToFollowing = [...seen];

      // Paused: the storage estimate near the quota (replaced in the worker).
      await p.evalWorker(`(() => { self.__estimate = { usage: 9.5e9, quota: 1e10 }; StorageManager.prototype.estimate = async function () { return self.__estimate; }; return true; })()`);
      const paused = await untilHealth(p, L["paused-quota"], 30_000);
      seen.push(paused.health!);
      const sp = expectDrawnFromSnapshot(paused);
      expect(one(paused, "storage.paused")).toBe("yes");
      expect(one(paused, "storage.pausedReason")).toContain("the sync pauses at");
      expect(one(paused, "storage.usageBytes")).toBe(bytesText(9.5e9));
      expect(one(paused, "overview.reason")).toBe(visibleText(sp.overview.health.reason!));
      await p.evalWorker(`(() => { self.__estimate = { usage: 1e8, quota: 1e10 }; return true; })()`);
      await untilHealth(p, L.following, 30_000);

      // A watchdog restart: the worker's thread held busy; the page shows the restart and the engine goes on.
      const before = await drawn(p);
      expect(one(before, "engine.watchdogRestarts")).toBe("0");
      await p.evalWorker("setTimeout(() => { const end = Date.now() + 600000; while (Date.now() < end) {} }, 0); true");
      const restarted = await waitFor("the restart on the page", () => drawn(p), (x) => x.fields["engine.watchdogRestarts"]?.[0] === "1", 60_000);
      const sr = expectDrawnFromSnapshot(restarted);
      const restarts = (await p.eval("window.umbradbEngine.restarts()")) as Array<{ reason: string }>;
      expect(restarts).toHaveLength(1);
      expect(sr.engine.lastWatchdogRestart?.reason).toBe(restarts[0]!.reason);
      expect(one(restarted, "engine.lastWatchdogRestart")).toContain(restarts[0]!.reason);
      expect(restarted.fields["logs.text"]).toContain(`watchdog restart: ${restarts[0]!.reason}`);
      const goingOn = await untilHealth(p, L.following, 60_000);
      expect(Number(one(goingOn, "overview.archiveHeight"))).toBeGreaterThan(Number(one(following, "overview.archiveHeight")));
      seen.push("watchdog restart");

      // Stopped.
      await inP("c.stop()");
      await untilHealth(p, L.stopped, 30_000);
      seen.push("stopped");
      await noViolations(p, true);
      expect(offSite(p)).toEqual([]);

      // Stalled: the stored scan cursor's block hash no longer matches the next block's parent.
      await readStore(p, [`UPDATE mip0018.mip0018_scan SET last_block_hash = decode(repeat('00', 32), 'hex')`]);
      p = await openStatus(b, "", { workers: true });
      await on(p)("c.start()");
      const stalled = await untilHealth(p, L["stalled-scan"], 60_000);
      const ss = expectDrawnFromSnapshot(stalled);
      expect(one(stalled, "scan.scanner")).toBe("stalled");
      expect(ss.scan.lastError?.message).toMatch(/parent .* is not the scanned block/);
      expect(one(stalled, "scan.lastError")).toContain("is not the scanned block");
      expect(one(stalled, "overview.reason")).toContain("is not the scanned block");
      seen.push(stalled.health!);
      report.states = seen;
      await noViolations(p, true);
      expect(offSite(p)).toEqual([]);
      await p.close();
    } finally {
      chain = chainDown;
      await b.close();
    }
  }, 400_000);

  it("[[browser.status.follower]] the leader's page shows its engine catching up then following; a second tab's status page shows the leader's engine marked follower, with the leader's heights and two connected tabs; it becomes leader when the leader tab closes", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const a = await openStatus(b);
      // The IDX range replayed in the worker in small batches: the leader's page shows it catching up, then following.
      await on(a)(`c.start(${JSON.stringify({ source: { kind: "tape", range: "idx" }, startHeight: IDX.from, sync: { idleMs: 200, maxBlocks: 5, concurrency: 1 }, scan: { idleMs: 200 } })})`);
      const running: string[] = [];
      const followed = await waitFor("the IDX range on the leader's page", async () => {
        const x = await drawn(a);
        if (x.health !== null && running.at(-1) !== x.health) running.push(x.health);
        return x;
      }, (x) => x.fields["overview.health"]?.[0] === L.following && x.fields["overview.scanHeight"]?.[0] === String(IDX.to), 180_000);
      expectDrawnFromSnapshot(followed);
      expect(running).toContain("catching-up");
      expect(running.at(-1)).toBe("following");
      report.leaderStates = running;
      const done = (await on(a)("c.status()")) as HostStatus;
      expect(done.cursors).toMatchObject({ sync: { height: IDX.to }, scan: { nextHeight: IDX.to + 1 } });
      const f = await openStatus(b);
      expect(await f.eval("window.umbradbEngine.tabs.role()")).toBe("follower");
      expect(await f.eval("window.umbradbEngine.worker === undefined")).toBe(true);
      const d = await waitFor("the follower's view", () => drawn(f), (x) => x.snapshot !== null && x.snapshot.engine.connectedTabs === 2);
      const s = expectDrawnFromSnapshot(d);
      expect(s.role).toBe("follower");
      expect(s.relayedAt).toBeGreaterThanOrEqual(s.generatedAt);
      expect(d.role).toBe("follower");
      expect(one(d, "overview.role")).toMatch(/^follower: this tab shows the leader tab's engine \(received /);
      expect(one(d, "engine.role")).toBe("follower");
      expect(one(d, "engine.connectedTabs")).toBe("2");
      expect(one(d, "overview.archiveHeight")).toBe(String(done.cursors!.sync!.height));
      expect(one(d, "overview.scanHeight")).toBe(String(done.cursors!.scan!.nextHeight - 1));
      expect(await f.eval("document.getElementById('role').textContent")).toBe("follower tab: the leader's engine");
      await noViolations(f, false);

      // The leader tab closes: this tab leads, runs its own worker, and shows its own engine.
      await a.close();
      const led = await waitFor("the new leader's view", () => drawn(f), (x) => x.role === "leader" && x.snapshot !== null && x.snapshot.engine.connectedTabs === 1, 60_000);
      expectDrawnFromSnapshot(led);
      expect(one(led, "overview.role")).toBe("leader: this tab runs the engine");
      expect(one(led, "overview.archiveHeight")).toBe(String(IDX.to));
      expect(await f.eval("window.umbradbEngine.tabs.role()")).toBe("leader");
      expect(f.exceptions).toEqual([]);
      expect(offSite(f)).toEqual([]);
      await f.close();
    } finally {
      await b.close();
    }
  }, 200_000);

  it("[[browser.status.hidden]] while hidden the page watches nothing: no snapshot, no /v1/status or catalog read for it, and it says it is paused; visible again it follows again", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await openStatus(b);
      const inP = on(p);
      await inP(`c.start(${JSON.stringify({ source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST })})`);
      await p.eval(`(() => { window.__sys = 0; window.umbradbEngine.client.onNotice((n) => { if (n.notice === "system") { window.__sys++; window.__lastSys = n.snapshot; } }); })()`);
      await p.waitFor("window.__sys >= 2", 30_000, "two snapshots while visible");
      expect(await p.eval("document.body.getAttribute('data-live')")).toBe("watching");

      // Another tab in front: this page is hidden.
      const other = await b.newPage();
      await other.send("Page.bringToFront");
      await p.waitFor("document.visibilityState === 'hidden'", 10_000, "the page hidden");
      expect(await p.eval("document.body.getAttribute('data-live')")).toBe("paused");
      expect(await p.eval("document.getElementById('live').textContent")).toBe("paused: nothing is read while this page is hidden");
      await sleep(500);
      const n0 = await p.eval<number>("window.__sys");
      const r0 = await p.eval<number>("window.umbradbSystem.renders");
      const last = SystemSnapshotSchema.parse(await p.eval("window.__lastSys"));
      await sleep(6_000);
      expect(await p.eval("window.__sys"), "no snapshot while hidden").toBe(n0);
      expect(await p.eval("window.umbradbSystem.renders"), "nothing drawn while hidden").toBe(r0);
      const r = (await inP("c.system({ refresh: {} })")) as { watching: boolean; viewers: number; snapshot: Json };
      expect([r.watching, r.viewers]).toEqual([false, 0]);
      const after = SystemSnapshotSchema.parse(r.snapshot);
      expect(after.api.served, "only this refresh read /v1/status").toBe(last.api.served + 1);
      expect(after.databases.collectedAt, "no catalog read while hidden").toBe(last.databases.collectedAt);

      // In front again: it follows again.
      await p.send("Page.bringToFront");
      await p.waitFor("document.visibilityState === 'visible'", 10_000, "the page visible");
      await p.waitFor(`window.umbradbSystem.renders > ${r0}`, 30_000, "a snapshot drawn again");
      expect(await p.eval("document.body.getAttribute('data-live')")).toBe("watching");
      expect(((await inP("c.system({ refresh: {} })")) as { viewers: number }).viewers).toBe(1);
      report.hidden = { snapshotsBefore: n0, servedBefore: last.api.served, servedAfter: after.api.served };
      expect(p.exceptions).toEqual([]);
      await other.close();
      await p.close();
    } finally {
      await b.close();
    }
  }, 120_000);

  it("[[browser.status.links]] the explorer's engine panel links to the status page and the status page back to the explorer; both followed in one tab under the headers' policy, every request answered and no violation", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await b.newPage();
      await p.goto(`${site.origin}/index.html`);
      await p.waitFor("document.querySelector('.engine-panel .system-link') !== null", 30_000, "the engine panel");
      expect(await p.eval("document.querySelector('.engine-panel .system-link').getAttribute('href')")).toBe("./system.html");
      await p.eval("document.querySelector('.engine-panel .system-link').click()");
      await p.waitFor("location.pathname === '/system.html' && window.umbradbSystem !== undefined && window.umbradbSystem.renders >= 1", 30_000, "the status page");
      expect(await p.eval("window.umbradbEngine.tabs.role()")).toBe("leader");
      expect(await p.eval("document.getElementById('explorer-link').getAttribute('href')")).toBe("./index.html");
      expect(await p.eval("window.__cspViolations")).toEqual([]);
      await p.eval("document.getElementById('explorer-link').click()");
      await p.waitFor("location.pathname === '/index.html' && document.querySelector('.engine-panel .system-link') !== null", 30_000, "the explorer again");
      expect(await p.eval("window.__cspViolations")).toEqual([]);
      expect(p.requests.filter((r) => r.failed !== undefined || (r.status ?? 200) >= 400).map((r) => `${r.url} ${r.status ?? r.failed}`)).toEqual([]);
      expect(p.requests.some((r) => r.url.endsWith(".woff2") && r.status === 200), "the explorer's font, also on the status page").toBe(true);
      expect(p.exceptions).toEqual([]);
      expect(offSite(p)).toEqual([]);
      await p.close();
    } finally {
      await b.close();
    }
  }, 120_000);

  /** A node whose every JSON-RPC answer is an error with `message`. */
  const rpcError = (message: string): ChainAnswer => async (path, body) => {
    if (path !== "/rpc") return { status: 503, headers: { "content-type": "text/plain" }, body: "down" };
    const id = (JSON.parse(body) as { id?: number }).id ?? 1;
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) };
  };
  const SLOW = { sync: { idleMs: 300, backoff: { baseDelayMs: 300, maxDelayMs: 1_000, maxAttempts: 2 } }, scan: { idleMs: 200 } };

  it("[[browser.status.hostile-text]] an error message with control, bidi, zero-width and markup characters is drawn as text: hidden characters as visible marks, markup as characters; nothing comes alive and no raw hidden character is drawn", async () => {
    const hostile = "\u202Egnp.exe\u200B\u0000<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=2</script>\u001b[31mred\u001b[0m \u2066iso\u2069 line\nbreak\ttab";
    const b = await Browser.launch(browserExe!);
    try {
      const p = await openStatus(b);
      chain = rpcError(hostile);
      await on(p)(`c.start(${JSON.stringify({ source: { kind: "network", nodeUrl: `${site.origin}/chain/rpc`, indexerUrl: `${site.origin}/chain/graphql` }, startHeight: "tip", ...SLOW })})`);
      const d = await waitFor("the hostile error", () => drawn(p), (x) => x.snapshot?.sync.lastError?.message.includes("gnp.exe") === true && (x.fields["logs.text"] ?? []).some((t) => t.includes("gnp.exe")), 60_000);
      const s = expectDrawnFromSnapshot(d);
      const marked = "\u27e8U+202E\u27e9gnp.exe\u27e8U+200B\u27e9\u27e8U+0000\u27e9<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=2</script>\u27e8U+001B\u27e9[31mred\u27e8U+001B\u27e9[0m \u27e8U+2066\u27e9iso\u27e8U+2069\u27e9 line\u27e8U+000A\u27e9break\u27e8U+0009\u27e9tab";
      expect(s.sync.lastError!.message).toContain(hostile);
      expect(one(d, "sync.lastError")).toContain(marked);
      // The log line holds the event's fields as JSON (controls and quotes escaped there); what JSON keeps raw (bidi,
      // zero-width) is drawn as marks, the markup as characters.
      const line = s.logs.find((l) => l.text.includes("gnp.exe"))!;
      expect(line.text).toContain("\u202Egnp.exe\u200B\\u0000<img src=x onerror=\\\"window.__pwned=1\\\">");
      expect(d.fields["logs.text"]).toContain(visibleText(line.text));
      expect(d.fields["logs.text"]!.some((t) => t.includes("\u27e8U+202E\u27e9gnp.exe\u27e8U+200B\u27e9\\u0000<img src=x onerror=\\\"window.__pwned=1\\\">"))).toBe(true);
      // Each mark is an element of its own; the text around it is text.
      const marks = await p.eval<string[]>(`[...document.querySelectorAll('[data-field="sync.lastError"] .mark-vis')].map((e) => e.textContent)`);
      expect(marks).toEqual(["\u27e8U+202E\u27e9", "\u27e8U+200B\u27e9", "\u27e8U+0000\u27e9", "\u27e8U+001B\u27e9", "\u27e8U+001B\u27e9", "\u27e8U+2066\u27e9", "\u27e8U+2069\u27e9", "\u27e8U+000A\u27e9", "\u27e8U+0009\u27e9"]);
      expect(await p.eval(`document.querySelector('[data-field="sync.lastError"] .d').getAttribute('class')`)).toBe("d");
      // Nothing came alive: no element from the text, no script ran, no request left for it.
      expect(await p.eval("({ scripts: document.scripts.length, media: document.querySelectorAll('img, iframe, object, embed, video, audio, svg').length, pwned: window.__pwned === undefined ? null : window.__pwned })")).toEqual({ scripts: 1, media: 0, pwned: null });
      expect(p.requests.some((r) => /\/x$/.test(r.url))).toBe(false);
      const text = await p.eval<string>("document.body.innerText");
      expect(text).not.toMatch(HIDDEN_RAW);
      const attrs = await p.eval<string[]>("[...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value))");
      for (const a of attrs) expect(a).not.toMatch(HIDDEN_RAW_ATTR);
      expect(await p.eval("window.__cspViolations")).toEqual([]);
      expect(p.exceptions).toEqual([]);
      await p.close();
    } finally {
      chain = chainDown;
      await b.close();
    }
  }, 120_000);

  it("[[browser.status.diagnostics]] Download diagnostics under the headers' policy saves the snapshot shown as JSON: it validates against the schema, equals that snapshot with its log lines, and holds none of the secrets the engine was given nor the page's address", async () => {
    const secrets = ["s3cret-token-0001", "hunter2-pass-0002", "bearer-cred-0003abcdef", "cookie-val-0004", "userinfo-pw-0005", "query-key-0006", "frag-0007", "auth-hdr-0008xyz"];
    const esk = "mn_shield-esk_stagenet1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7l";
    // One secret per line, so that each redaction rule is exercised on its own.
    const message = [
      `upstream said token=${secrets[0]} and password: ${secrets[1]}`,
      `retry with Bearer ${secrets[2]}`,
      `see https://admin:${secrets[4]}@example.invalid/path?apikey=${secrets[5]}#${secrets[6]}`,
      `{"apiKey": "x-${secrets[0]}"} viewing key ${esk}`,
      `Authorization: Basic ${secrets[7]}`,
      `cookie=${secrets[3]}`,
    ].join("\n");
    const downloads = mkdtempSync(join(tmpdir(), "umbradb-diagnostics-"));
    const b = await Browser.launch(browserExe!);
    try {
      await b.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
      const p = await openStatus(b, "", { workers: true });
      chain = rpcError(message);
      // The node's URL carries a key in its query too (the configuration and every log line show it without).
      const config = { source: { kind: "network", nodeUrl: `${site.origin}/chain/rpc?apikey=${secrets[5]}`, indexerUrl: `${site.origin}/chain/graphql` }, startHeight: "tip", ...SLOW };
      await on(p)(`c.start(${JSON.stringify(config)})`);
      await waitFor("the error with secrets", () => drawn(p), (x) => (x.fields["logs.text"] ?? []).some((t) => t.includes("upstream said")), 60_000);
      const shown = await p.eval<SystemSnapshot>("(() => { const s = window.umbradbSystem.latest(); document.getElementById('download').click(); return s; })()");
      const file = await waitFor("the downloaded file", async () => readdirSync(downloads).filter((n) => !n.endsWith(".crdownload")), (names) => names.length === 1, 30_000);
      const name = file[0]!;
      expect(name).toMatch(/^umbradb-diagnostics-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/);
      const text = await waitFor("the whole file", async () => readFileSync(join(downloads, name), "utf8"), (t) => t.endsWith("}\n"), 10_000);
      const parsed = SystemSnapshotSchema.parse(JSON.parse(text));
      expect(parsed.format).toBe("umbradb-system-snapshot");
      expect(parsed.version).toBe(1);
      expect(text).toBe(diagnosticsJson(SystemSnapshotSchema.parse(shown)));
      expect(parsed).toEqual(shown);
      expect(parsed.logs.length).toBeGreaterThan(0);
      expect(parsed.logs.some((l) => l.text.includes("upstream said"))).toBe(true);
      expect(parsed.configuration.endpoints.node).toBe(`${site.origin}/chain/rpc`);
      for (const secret of [...secrets, esk, "admin:"]) expect(text, secret).not.toContain(secret);
      expect(text).toContain("[redacted]");
      for (const page of ["system.html", "index.html", "engine.html"]) expect(text, page).not.toContain(page);
      // The page shows none of them either.
      const body = await p.eval<string>("document.body.innerText");
      for (const secret of [...secrets, esk]) expect(body, secret).not.toContain(secret);
      expect(await p.eval(`document.getElementById('message').textContent`)).toBe(`saved ${name}`);
      await noViolations(p, true);
      expect(offSite(p)).toEqual([]);
      report.diagnostics = { name, bytes: text.length, logs: parsed.logs.length };
      await p.close();
    } finally {
      chain = chainDown;
      await b.close();
      rmSync(downloads, { recursive: true, force: true });
    }
  }, 120_000);
});
