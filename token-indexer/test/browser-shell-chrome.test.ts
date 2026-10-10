/**
 * The static build's main page (`token-indexer/browser/index.html`) in Chrome: the build (Vite, into a temporary
 * folder; the engine never starts by itself, and a new store's default start is a recorded range) served from
 * 127.0.0.1 through the static host's handler (`dev/serve-browser.ts`, as `npm run serve:browser`) with its `_headers`
 * (the Content-Security-Policy with Trusted Types, cross-origin isolation), driven over the DevTools protocol
 * (`helpers/cdp-browser.ts`). The chain is a recorded range replayed inside the worker, or the site's own `/chain/rpc`
 * and `/chain/graphql` answering what the test writes; an OPFS reader page beside the build (`fixtures/opfs-reader/`,
 * served without the headers) reads the store as an independent PGlite once the engine's worker is gone. Never Stagenet.
 *
 * - `[[browser.shell.overview]]` — the page opens on the Overview: the header's tabs (Overview, Token Indexer,
 *   JSON RPC, Database) and the system status link; the Modules section lists the indexer's ten modules with Token
 *   Indexer and JSON RPC checked and switchable and the eight others unchecked, disabled and "planned"; after a replay the overview draws its
 *   view of its sources and the sources agree: heights, network and durability with `/v1/status`, the health line,
 *   finalized tip, lag, blocks/s and uptime with the system snapshot, whose heights equal `/v1/status`; the storage line
 *   is one short line (store size, quota, pause threshold, persistence) equal to the engine's reading and the page's
 *   `navigator.storage.estimate()`, with its explanation in the tooltip; the tab is in the URL (picked, reloaded, back,
 *   an explorer route); the overview watches the system snapshot only while it is shown. No CSP violation, every
 *   request to the site.
 * - `[[browser.shell.module-toggle]]` — Token Indexer switched off from its checkbox while the finalized tip rises: the
 *   scan's cursor stays at a block boundary while the archive advances by more than a hundred blocks, `/v1/status`
 *   says `scanner: "off"` and answers, the system snapshot shows the scan off, the tab is gone (a URL naming it shows
 *   the overview), the scan height says so; a second tab shows the same; the choice holds when the leader tab closes
 *   (the next leader's engine runs without the scan) and after a reload; switched on again from the checkbox, the scan
 *   catches up and the finished store's digests equal the uninterrupted replay's.
 * - `[[browser.shell.database]]` — the Database tab lists every table of the store as the system snapshot's catalog
 *   statistics do, with estimates and sizes; a picked table shows a page of rows newest first, each value drawn from
 *   the engine's answer, and the pages follow one another; the rows equal the store read with SQL by the reader page; a
 *   table name that is not the catalog's is refused (by the request and by a forged picker value) and the refusal is
 *   shown; hostile text in rows is drawn as text; a second tab lists the same tables and rows.
 * - `[[browser.shell.hostile-text]]` — text from the engine and from a file, drawn by the overview, with control, bidi,
 *   zero-width and markup characters: a node's error message (the engine's state and the health line while it waits on
 *   the network) and a snapshot whose manifest names a hostile network (the import's refusal): every hidden character
 *   is a visible mark, markup stays characters; nothing comes alive, no raw hidden character reaches the drawn text or
 *   an attribute.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `MIP0018_UI_SCREENSHOTS=<dir>` saves PNGs (never committed).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cellText } from "../browser/database-model.ts";
import { INDEXER_MODULES } from "../browser/modules.ts";
import { formatBytes, type PanelInputs, panelView } from "../browser/panel-model.ts";
import type { DigestResult, HostStatus, RowsResult, SystemResult, TablesResult } from "../browser/protocol.ts";
import { pauseThresholdBytes } from "../browser/quota.ts";
import { decodeSnapshotFile, encodeSnapshotFile } from "../browser/snapshot.ts";
import { durationText } from "../browser/system-model.ts";
import { visibleText } from "../browser/visible-text.ts";
import { HEALTH_LABELS, type SystemSnapshot } from "../engine/system-snapshot.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { buildEngineSite, type ChainAnswer, chainDown, REPO_ROOT } from "./helpers/engine-site.ts";
import { type LocalServer, parseHeadersFile, serveStaticSite } from "./helpers/static-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IDX = { from: 714485, to: 715183 } as const;
const U1 = { from: 715402, to: 715433 } as const;
const IDX_ARCHIVE = "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119";
const IDX_TABLES = "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c";
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };
const U1_CONFIG = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST };
const STORE = "opfs-ahp://umbradb-stagenet";
const SHOTS = process.env.MIP0018_UI_SCREENSHOTS;
// Raw characters that must never reach the drawn text (tab and newline excepted in innerText) or an attribute.
const HIDDEN_RAW = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const HIDDEN_RAW_ATTR = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".data": "application/octet-stream", ".css": "text/css" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const browserExe = findBrowser();

/** The overview's fields as drawn (text), the storage line's tooltip, and the sources it drew them from. */
const OVERVIEW = `(() => {
  const p = document.getElementById('engine-panel');
  const fields = {};
  for (const f of p.querySelectorAll('.kv [data-field]')) fields[f.getAttribute('data-field')] = f.textContent;
  return { fields, storageTitle: p.querySelector('[data-field="storage"]').title, inputs: window.umbradbOverview.inputs(),
    tab: document.body.getAttribute('data-tab-shown'), title: document.title, search: location.search, hash: location.hash };
})()`;
type OverviewField = "health" | "role" | "network" | "state" | "configuration" | "history" | "synced" | "scanned" | "tip" | "lag" | "rate" | "uptime" | "durability" | "storage";
interface Overview {
  fields: Record<OverviewField, string>;
  storageTitle: string;
  inputs: PanelInputs;
  tab: string;
  title: string;
  search: string;
  hash: string;
}
/** The Modules section as drawn. */
const MODULES = `[...document.querySelectorAll('#modules tr')].map((tr) => {
  const box = tr.querySelector('input[type=checkbox]');
  return { id: tr.getAttribute('data-module'), name: tr.querySelector('label').textContent, description: tr.querySelector('[data-field=module-description]').textContent,
    checked: box.checked, disabled: box.disabled, state: tr.getAttribute('data-state'), chip: tr.querySelector('[data-field="module-state"]').textContent };
})`;
interface ModuleRow { id: string; name: string; description: string; checked: boolean; disabled: boolean; state: string; chip: string }

describe("the static build's main page in Chrome (served with its headers)", () => {
  let out: string;
  let site: LocalServer;
  let chain: ChainAnswer = chainDown;

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    out = await buildEngineSite({
      __UMBRADB_BROWSER_CONFIG__: JSON.stringify({ autoStart: false, start: U1_CONFIG, quota: { checkEveryMs: 0, recheckMs: 300, storeEveryMs: 1_000 } }),
    });
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
  });

  const on = (p: Page) => (expr: string): Promise<Json> => p.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
  const status = (p: Page): Promise<HostStatus> => on(p)("c.status()");
  const overview = (p: Page): Promise<Overview> => p.eval<Overview>(OVERVIEW);
  const modules = (p: Page): Promise<ModuleRow[]> => p.eval<ModuleRow[]>(MODULES);
  const apiStatus = async (p: Page): Promise<Json> => JSON.parse(((await on(p)(`c.api("GET", "/v1/status")`)) as { body: string }).body);

  async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 120_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await read();
      if (ok(v)) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 1200)}`);
      await sleep(100);
    }
  }
  const untilStatus = (p: Page, what: string, ok: (s: HostStatus) => boolean, timeoutMs = 120_000): Promise<HostStatus> => waitFor(what, () => status(p), ok, timeoutMs);

  /** Opens `path` in a new tab of `b`, in a window of its own (visible), and waits for the engine's boot. */
  async function open(b: Browser, path: string): Promise<Page> {
    const p = await b.newPage({ workers: true, newWindow: true });
    await p.goto(`${site.origin}${path}`);
    await p.waitFor("window.umbradbEngine !== undefined && window.umbradbOverview !== undefined", 30_000, "the main page");
    await p.eval("window.umbradbEngine.tabs.ready");
    expect(await p.eval("window.umbradbEngine.client.booted()")).toMatchObject({ phase: "ready", error: null });
    return p;
  }
  /** Loads the page's own URL again (a new document, also when the URL has a fragment) and waits for the boot. */
  async function reload(p: Page): Promise<void> {
    const href = await p.eval<string>("location.href");
    await p.goto("about:blank");
    await p.goto(href);
    await p.waitFor("window.umbradbEngine !== undefined && window.umbradbOverview !== undefined", 30_000, "the main page again");
    expect(await p.eval("window.umbradbEngine.client.booted()")).toMatchObject({ phase: "ready" });
  }

  /** The store read by the reader page (the engine's workers must be gone). */
  async function readStore(b: Browser, statements: string[]): Promise<Json[][]> {
    const p = await b.newPage();
    try {
      await p.goto(`${site.origin}/reader/index.html`);
      await p.waitFor("typeof window.readStore === 'function'", 30_000, "the reader page");
      return await p.eval<Json[][]>(`window.readStore(${JSON.stringify(STORE)}, ${JSON.stringify(statements)})`);
    } finally {
      await p.close();
    }
  }

  async function clean(p: Page, worker: boolean): Promise<void> {
    expect(await p.eval("window.__cspViolations")).toEqual([]);
    if (worker && p.workers.some((w) => w.running)) expect(await p.evalWorker("self.__cspViolations")).toEqual([]);
    expect(p.logs.filter((l) => /Content Security Policy|Trusted Type|content security/i.test(l.text))).toEqual([]);
    expect(p.exceptions).toEqual([]);
    expect(p.console.filter((c) => c.type === "error" || c.type === "assert")).toEqual([]);
    expect(p.requests.filter((r) => !r.url.startsWith(`${site.origin}/`) && !r.url.startsWith("blob:") && !r.url.startsWith("data:")).map((r) => r.url)).toEqual([]);
  }

  async function shot(p: Page, name: string): Promise<void> {
    if (SHOTS === undefined || SHOTS === "") return;
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, name), await p.screenshot());
  }

  /** The overview draws its view of the sources it holds, field by field. */
  function expectDrawnFromInputs(o: Overview): ReturnType<typeof panelView> {
    const view = panelView(o.inputs);
    for (const k of ["health", "role", "network", "configuration", "history", "synced", "scanned", "tip", "lag", "rate", "uptime", "durability", "storage"] as const)
      expect(o.fields[k], k).toBe(visibleText(view[k]));
    expect(o.fields.state).toBe(visibleText(view.stateDetail === "" ? view.state : `${view.state} · ${view.stateDetail}`));
    expect(o.storageTitle).toBe(visibleText(view.storageTitle));
    return view;
  }

  it("[[browser.shell.overview]] the page opens on the overview: tabs, the system status link and the Modules section; its figures are its view of its sources, and the sources agree (/v1/status, the system snapshot, navigator.storage); the storage line and its explanation; the tab in the URL; the snapshot watched only while the overview is shown; no CSP violation", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html");
      const tabsDrawn = await p.eval<Json[]>("[...document.querySelectorAll('header.product nav a')].map((a) => [a.id, a.textContent, a.getAttribute('href'), a.hidden, a.className])");
      expect(tabsDrawn).toEqual([
        ["tab-overview", "Overview", "?tab=overview", false, "on"],
        ["tab-tokens", "Token Indexer", "?tab=tokens", false, ""],
        ["tab-jsonrpc", "JSON RPC", "?tab=jsonrpc", false, ""],
        ["tab-database", "Database", "?tab=database", false, ""],
        ["system-link", "system status", "./system.html", false, "system-link"],
      ]);
      let o = await overview(p);
      expect([o.tab, o.title, o.search]).toEqual(["overview", "UmbraDB indexer", ""]);
      expect(await p.eval("[...document.querySelectorAll('[id^=tab-panel-]')].map((e) => e.id + ':' + e.hidden)")).toEqual(
        ["tab-panel-overview:false", "tab-panel-tokens:true", "tab-panel-jsonrpc:true", "tab-panel-database:true"]);

      // The Modules section: the ten modules; Token Indexer and JSON RPC checked and switchable, the others planned.
      await p.waitFor("document.getElementById('module-token-indexer').disabled === false", 30_000, "the token indexer's switch");
      expect(await modules(p)).toEqual(INDEXER_MODULES.map((m) => m.engineModule === null
        ? { id: m.id, name: m.name, description: m.description, checked: false, disabled: true, state: "planned", chip: "planned" }
        : { id: m.id, name: m.name, description: m.description, checked: true, disabled: false, state: "on", chip: "on" }));

      // A replay that follows the recorded range's tip; the overview with a snapshot of the finished range.
      await on(p)(`c.start(${JSON.stringify(U1_CONFIG)})`);
      await untilStatus(p, "the U1 range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
      o = await waitFor("the overview's snapshot of the range", () => overview(p), (x) => x.inputs.snapshot?.overview.scanHeight === U1.to && x.inputs.snapshot.overview.finalizedTip === U1.to
        && x.inputs.snapshot.overview.archiveHeight === U1.to && x.inputs.api?.indexedHeight === U1.to && x.inputs.status?.storage?.storeBytes != null);
      await shot(p, "shell-overview.png");
      const view = expectDrawnFromInputs(o);
      const st = await apiStatus(p);
      const snap = o.inputs.snapshot as SystemSnapshot;
      // /v1/status: the heights, the network, durability.
      for (const k of ["network", "startHeight", "indexedHeight", "archiveHeight", "durability"]) expect((o.inputs.api as Json)[k], k).toEqual(st[k]);
      expect([o.fields.history, o.fields.synced, o.fields.scanned, o.fields.network, o.fields.durability]).toEqual([
        `indexed from block ${U1.from} · history before block ${U1.from} is not indexed`, String(U1.to), String(U1.to), "stagenet", "non-durable"]);
      // The system snapshot: its heights equal /v1/status; the health line, the tip, the lag, the rates and the uptime.
      expect([snap.overview.startHeight, snap.overview.archiveHeight, snap.overview.scanHeight]).toEqual([st.startHeight, st.archiveHeight, st.indexedHeight]);
      expect(snap.overview.health.state).toBe("following");
      expect(o.fields.health).toBe(HEALTH_LABELS.following);
      expect(o.fields.tip).toBe(String(U1.to));
      expect(o.fields.lag).toBe("none: caught up with the finalized tip");
      expect(o.fields.rate).toBe(`archive ${snap.sync.blocksPerSecond.toFixed(2)} blocks/s · scan ${snap.scan.blocksPerSecond.toFixed(2)} blocks/s (last minute)`);
      expect(snap.sync.blocksPerSecond).toBeGreaterThan(0);
      expect(o.fields.uptime).toBe(durationText(snap.engine.uptimeMs));
      expect([o.fields.role, snap.role, snap.engine.connectedTabs]).toEqual(["leader (this tab runs the engine) · 1 tab open", "leader", 1]);
      expect(o.fields.state).toMatch(/^running · sync (idle|running) · scan following$/);
      // The storage line: one short line from the engine's reading, whose quota is the page's own estimate's (the browser
      // computes it from the free disk space, so two readings a moment apart may differ slightly).
      const reading = o.inputs.status!.storage!;
      const quota = reading.quotaBytes!;
      const pageQuota = await p.eval<number>("navigator.storage.estimate().then((e) => e.quota)");
      expect(Math.abs(quota - pageQuota) / pageQuota).toBeLessThan(0.01);
      expect(reading.pauseAtBytes).toBe(pauseThresholdBytes(quota));
      expect(o.fields.storage).toBe(`${formatBytes(reading.storeBytes)} · quota ${formatBytes(quota)} · pauses at ${formatBytes(pauseThresholdBytes(quota))} · ${reading.persisted ? "persistent" : "not persistent"}`);
      expect(o.fields.storage.length).toBeLessThan(80);
      expect(o.storageTitle).toContain(`The browser counts ${formatBytes(reading.usageBytes)} against this site's quota of ${formatBytes(quota)}; while the store is open that count includes the space Chrome reserves`);
      expect(o.storageTitle).toContain(reading.persisted ? "Persistent:" : "Not persistent: ");
      expect(view.tokenIndexer).toBe(true);

      // The snapshot is watched while the overview is shown, and not on another tab.
      const viewers = (): Promise<number> => on(p)(`c.system({ watch: false, viewer: "probe" }).then((r) => r.viewers)`);
      expect(await viewers()).toBe(1);

      // The tab in the URL: picked (no reload), reloaded, back; an explorer route opens the Token Indexer tab.
      const loads = await p.eval<number>("window.umbradbEngine.loadedAt");
      await p.eval("document.getElementById('tab-database').click()");
      o = await overview(p);
      expect([o.tab, o.title, o.search]).toEqual(["database", "UmbraDB database", "?tab=database"]);
      expect(await p.eval<number>("window.umbradbEngine.loadedAt")).toBe(loads);
      await waitFor("the overview's watch to end", viewers, (n) => n === 0, 15_000);
      await p.eval("history.back()");
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'overview' && location.search === ''", 15_000, "back to the overview");
      await waitFor("the overview's watch again", viewers, (n) => n === 1, 15_000);
      await p.eval("history.forward()");
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'database' && location.search === '?tab=database'", 15_000, "forward to the database");
      expect(await p.eval<number>("window.umbradbEngine.loadedAt")).toBe(loads);
      await reload(p);
      expect((await overview(p)).tab).toBe("database");
      await p.eval("location.hash = '#/'");
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'tokens' && document.body.getAttribute('data-route') === 'list' && document.body.getAttribute('data-state') === 'ready'", 30_000, "the explorer's list");
      o = await overview(p);
      // The URL names the tab: with no tab parameter, an explorer route is the Token Indexer tab.
      expect([o.title, o.hash]).toEqual(["MIP-0018 token explorer", "#/"]);
      expect(["", "?tab=tokens"]).toContain(o.search);
      expect(await p.eval<number>("document.querySelectorAll('#tokens tbody tr').length")).toBe(JSON.parse(((await on(p)(`c.api("GET", "/v1/tokens?limit=100")`)) as { body: string }).body).items.length);
      await reload(p);
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'tokens' && document.body.getAttribute('data-state') === 'ready'", 30_000, "the explorer after a reload");
      await p.eval("document.getElementById('tab-overview').click()");
      expect((await overview(p)).search).toBe("?tab=overview");
      expect(await p.eval("location.hash")).toBe("#/");
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 240_000);

  it("[[browser.shell.module-toggle]] Token Indexer off from its checkbox: the scan cursor stays while the archive advances, /v1/status scanner off, the system snapshot shows it, the tab is gone; a second tab shows the same; the choice holds through a leader change and a reload; on again, the scan catches up to the uninterrupted replay's digests", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      let leader = await open(b, "/index.html");
      const rising = { source: { kind: "tape", range: "idx", finalizedHeight: IDX.from + 60, advance: { everyMs: 100, by: 5 } }, startHeight: IDX.from, ...FAST };
      await on(leader)(`c.start(${JSON.stringify(rising)})`);
      await untilStatus(leader, "a first part of the scan", (s) => (s.cursors?.scan?.nextHeight ?? 0) > IDX.from + 40);
      await leader.waitFor("document.getElementById('module-token-indexer').disabled === false", 30_000, "the switch");

      // Off.
      await leader.eval("document.getElementById('module-token-indexer').click()");
      await leader.waitFor("/^the token indexer is off/.test(document.querySelector('#modules [data-field=modules-message]').textContent)", 30_000, "the switch's answer");
      const off = await status(leader);
      expect(off.settings?.modules).toEqual({ "token-indexer": false });
      expect(off.engine!.status.scan).toMatchObject({ phase: "off", scanner: "off" });
      const frozen = off.cursors!.scan!;
      expect((await modules(leader))[0]).toMatchObject({ id: "token-indexer", checked: false, disabled: false, state: "off", chip: "off" });
      expect(await leader.eval("document.getElementById('tab-tokens').hidden")).toBe(true);
      const ahead = await untilStatus(leader, "the archive to advance", (s) => (s.cursors?.sync?.height ?? 0) >= frozen.nextHeight + 120);
      expect(ahead.cursors!.scan).toEqual(frozen);
      const st = await apiStatus(leader);
      expect(st).toMatchObject({ scanner: "off", indexedHeight: frozen.nextHeight - 1 });
      expect(st.archiveHeight).toBeGreaterThanOrEqual(frozen.nextHeight + 120);
      const snap = ((await on(leader)("c.system({ refresh: {} })")) as SystemResult).snapshot!;
      expect(snap.scan).toMatchObject({ phase: "off", scanner: "off" });
      await leader.waitFor(`document.querySelector('#engine-panel [data-field=scanned]').textContent === '${frozen.nextHeight - 1} · token indexer off'`, 15_000, "the scan height");
      await shot(leader, "shell-module-off.png");
      // A URL naming the Token Indexer tab shows the overview, and says so.
      await leader.goto(`${site.origin}/index.html?tab=tokens`);
      await leader.waitFor("window.umbradbOverview !== undefined && document.body.getAttribute('data-tab-shown') === 'overview' && location.search === '?tab=overview'", 30_000, "the overview instead of the hidden tab");
      expect(await leader.eval("document.getElementById('tab-tokens').hidden")).toBe(true);
      // The reload ended the engine (nothing starts by itself in this build): run it again; the scan stays off.
      await leader.eval("window.umbradbEngine.client.booted()");
      await on(leader)("c.start()");
      expect((await untilStatus(leader, "the engine again", (s) => s.engine?.running === true)).engine!.status.scan).toMatchObject({ phase: "off", scanner: "off" });

      // A second tab: the same choice drawn.
      const follower = await open(b, "/index.html");
      expect(await follower.eval("window.umbradbEngine.tabs.role()")).toBe("follower");
      await follower.waitFor("document.getElementById('module-token-indexer').checked === false && document.getElementById('tab-tokens').hidden === true", 30_000, "the follower's module state");

      // The leader closes: the follower leads and runs the engine without the scan.
      await leader.close();
      await follower.waitFor("window.umbradbEngine.tabs.role() === 'leader'", 30_000, "the follower to lead");
      const resumed = await untilStatus(follower, "the next leader's engine", (s) => s.engine?.running === true && (s.cursors?.sync?.height ?? 0) > ahead.cursors!.sync!.height);
      expect(resumed.engine!.status.scan).toMatchObject({ phase: "off", scanner: "off" });
      expect(resumed.cursors!.scan).toEqual(frozen);

      // A reload keeps it too.
      leader = follower;
      await reload(leader);
      await leader.waitFor("document.getElementById('module-token-indexer').disabled === false && document.getElementById('module-token-indexer').checked === false && document.getElementById('tab-tokens').hidden === true", 30_000, "the choice after a reload");
      expect((await status(leader)).settings?.modules).toEqual({ "token-indexer": false });

      // On, from the checkbox: the scan catches up from its cursor; the tab is back.
      await on(leader)("c.start()");
      await leader.eval("document.getElementById('module-token-indexer').click()");
      await leader.waitFor("/^the token indexer is on/.test(document.querySelector('#modules [data-field=modules-message]').textContent)", 30_000, "the switch's answer");
      expect(await leader.eval("document.getElementById('tab-tokens').hidden")).toBe(false);
      const end = await untilStatus(leader, "the range's end", (s) => s.cursors?.sync?.height === IDX.to && s.cursors?.scan?.nextHeight === IDX.to + 1, 300_000);
      expect(end.engine!.status.scan.scanner).toBe("following");
      const d = (await on(leader)("c.digest()")) as DigestResult;
      expect([d.archive.sha256, d.tables.sha256]).toEqual([IDX_ARCHIVE, IDX_TABLES]);
      expect((await modules(leader))[0]).toMatchObject({ checked: true, state: "on" });
      await clean(leader, true);
      await leader.close();
    } finally {
      await b.close();
    }
  }, 400_000);

  it("[[browser.shell.database]] the Database tab lists every table as the catalog has it; a picked table's rows newest first, drawn from the engine's answer and equal to the store read with SQL; pages follow; a forged table name is refused and the refusal shown; hostile text in rows drawn as text; a second tab shows the same; no CSP violation", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html?tab=database");
      await on(p)(`c.start(${JSON.stringify({ ...U1_CONFIG, endHeight: U1.to })})`);
      await untilStatus(p, "the U1 range", (s) => s.engine?.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === U1.to + 1);
      await on(p)("c.stop()");
      await p.eval("document.querySelector('[data-action=db-refresh]').click()");
      const tablesDrawn = async (): Promise<string[][]> => p.eval<string[][]>("[...document.querySelectorAll('[data-field=db-tables] tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent))");
      // Every table of the store, as the system snapshot's catalog statistics list them.
      const snap = ((await on(p)("c.system({ refresh: { database: true } })")) as SystemResult).snapshot!;
      const catalog = snap.databases.schemas.flatMap((s) => s.tables.map((t) => `${s.name}.${t.name}`)).sort();
      expect(catalog.length).toBeGreaterThan(20);
      const listed = await waitFor("the tables", tablesDrawn, (rows) => rows.length === catalog.length);
      expect(listed.map((r) => `${r[0]}.${r[1]}`).sort()).toEqual(catalog);
      const tables = (await p.eval<{ tables: TablesResult }>("window.umbradbOverview.database()")).tables;
      expect(listed.map((r) => `${r[0]}.${r[1]}`)).toEqual(tables.schemas.flatMap((s) => s.tables.map((t) => `${s.name}.${t.name}`)));
      expect(listed.find((r) => r[1] === "blocks")!.slice(2)).toEqual(["partitioned", "no estimate", expect.stringMatching(/^\d+\.\d kB$|^\d+\.\d MB$/)]);
      expect(await p.eval<string[]>("[...document.querySelectorAll('#db-table option')].map((o) => o.textContent).slice(0, 3)")).toEqual(["pick a table", expect.stringMatching(/^_migrations · /), expect.stringMatching(/^blocks · /)]);

      // A table picked: its first page, newest first, each value drawn from the answer.
      const pick = (schema: string, table: string): Promise<void> => p.eval(`(() => { const s = document.getElementById('db-table'); s.value = ${JSON.stringify(JSON.stringify([schema, table]))}; s.dispatchEvent(new Event('change')); })()`);
      const rowsDrawn = (): Promise<{ title: string; page: string; head: string[]; cells: string[][]; message: string }> => p.eval(`({
        title: document.querySelector('[data-field="db-rows.title"]').textContent, page: document.querySelector('[data-field="db-rows.page"]').textContent,
        head: [...document.querySelectorAll('[data-field="db-rows.table"] thead th')].map((t) => t.textContent),
        cells: [...document.querySelectorAll('[data-field="db-rows.table"] tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent)),
        message: document.querySelector('[data-field=db-message]').textContent })`);
      const answer = async (): Promise<RowsResult> => (await p.eval<{ rows: RowsResult }>("window.umbradbOverview.database()")).rows;
      await pick("chain_archive", "blocks");
      let drawn = await waitFor("the blocks' rows", rowsDrawn, (d) => d.title === "chain_archive.blocks" && d.cells.length === 25);
      let page = await answer();
      expect(drawn.head).toEqual(page.columns.map((c) => c.name));
      expect(drawn.cells).toEqual(page.rows.map((r) => r.map((c) => visibleText(cellText(c).text))));
      const heightAt = page.columns.findIndex((c) => c.name === "height");
      expect(drawn.cells.map((r) => Number(r[heightAt]))).toEqual(Array.from({ length: 25 }, (_, i) => U1.to - i));
      expect(drawn.page).toBe("rows 1–25, more follow · newest first: by net, height, block_hash, descending · up to 25 rows a page");
      const blocksPage = page;
      // The next page and back.
      await p.eval("document.querySelector('[data-action=db-older]').click()");
      drawn = await waitFor("the older page", rowsDrawn, (d) => d.page.startsWith("rows 26–32"));
      expect(drawn.cells.map((r) => Number(r[heightAt]))).toEqual(Array.from({ length: 7 }, (_, i) => U1.to - 25 - i));
      expect(await p.eval("document.querySelector('[data-action=db-older]').disabled")).toBe(true);
      await p.eval("document.querySelector('[data-action=db-newer]').click()");
      await waitFor("the first page again", rowsDrawn, (d) => d.page.startsWith("rows 1–25"));
      await pick("mip0018", "mip0018_scan");
      drawn = await waitFor("the scan's row", rowsDrawn, (d) => d.title === "mip0018.mip0018_scan" && d.cells.length === 1);
      const scanPage = await answer();
      expect(drawn.cells).toEqual(scanPage.rows.map((r) => r.map((c) => visibleText(cellText(c).text))));

      // A table name that is not the catalog's: refused by the engine; a forged picker value shows the refusal.
      const refused = await on(p)(`c.request("rows", { schema: "pg_catalog", table: "pg_authid" }).then(() => null, (e) => [e.code, e.message])`);
      expect(refused).toEqual(["bad-request", "\"pg_catalog\" is not a schema of the store (chain_archive, mip0018)"]);
      const forged = 'blocks"; DROP TABLE chain_archive.watermarks; --';
      await p.eval(`(() => { const s = document.getElementById('db-table'); const o = s.options[1]; o.value = ${JSON.stringify(JSON.stringify(["chain_archive", forged]))}; s.value = o.value; s.dispatchEvent(new Event('change')); })()`);
      drawn = await waitFor("the refusal", rowsDrawn, (d) => d.message.includes("could not be read"));
      expect(drawn.message).toBe(`chain_archive.${forged} could not be read · bad-request: ${JSON.stringify(forged)} is not a table of the schema chain_archive`);
      expect(drawn.title).toBe("mip0018.mip0018_scan"); // the page shown stays
      expect((await status(p)).cursors!.sync!.height).toBe(U1.to);

      // Hostile text in rows (an answer the test writes into the page's client): drawn as text with visible marks.
      const hostile = "\u202Egnp.exe\u200B\u0000<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=2</script>\u001b[31m\u2066iso\u2069";
      await p.eval(`(() => {
        const c = window.umbradbEngine.client;
        const real = c.request;
        c.request = (type, params) => type !== "rows" ? real.call(c, type, params) : Promise.resolve({
          schema: params.schema, table: params.table, columns: [{ name: ${JSON.stringify(hostile)}, type: ${JSON.stringify(hostile)} }, { name: "b", type: "bytea" }],
          orderBy: [${JSON.stringify(hostile)}], offset: 0, limit: 25, more: false, elapsedMs: 1,
          rows: [[{ kind: "text", text: ${JSON.stringify(hostile)}, chars: 9999 }, { kind: "bytes", hex: "00ff", bytes: 2 }]],
        });
        window.__restore = () => { c.request = real; };
      })()`);
      await pick("chain_archive", "watermarks");
      drawn = await waitFor("the hostile rows", rowsDrawn, (d) => d.title === "chain_archive.watermarks");
      const marked = "⟨U+202E⟩gnp.exe⟨U+200B⟩⟨U+0000⟩<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=2</script>⟨U+001B⟩[31m⟨U+2066⟩iso⟨U+2069⟩";
      expect(drawn.head).toEqual([marked, "b"]);
      const longCell = cellText({ kind: "text", text: hostile, chars: 9999 });
      expect(drawn.cells).toEqual([[visibleText(longCell.text), "00ff \u00b7 2 bytes"]]);
      expect(drawn.cells[0]![0]!.endsWith("<img src=x onerror=\"window.__pwned=1\">\u2026 (9,999 characters)")).toBe(true);
      expect(await p.eval("document.querySelector('[data-field=\"db-rows.table\"] tbody td').title")).toBe(visibleText(longCell.title!));
      expect(drawn.page).toContain(`by primary key (${marked}), descending`);
      expect(await p.eval<number>("document.querySelectorAll('[data-field=\"db-rows.table\"] .mark-vis').length")).toBeGreaterThan(5);
      expect(await p.eval("({ scripts: document.scripts.length, media: document.querySelectorAll('img, iframe, object, embed, video, audio').length, pwned: window.__pwned === undefined ? null : window.__pwned })")).toEqual({ scripts: 1, media: 0, pwned: null });
      expect(await p.eval<string>("document.body.innerText")).not.toMatch(HIDDEN_RAW);
      for (const a of await p.eval<string[]>("[...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value))")) expect(a).not.toMatch(HIDDEN_RAW_ATTR);
      await p.eval("window.__restore()");
      await shot(p, "shell-database.png");

      // A second tab: the same tables and the same rows, through the leader.
      const follower = await open(b, "/index.html?tab=database");
      expect(await follower.eval("window.umbradbEngine.tabs.role()")).toBe("follower");
      await follower.waitFor(`document.querySelectorAll('[data-field=db-tables] tbody tr').length === ${catalog.length}`, 30_000, "the follower's tables");
      await follower.eval(`(() => { const s = document.getElementById('db-table'); s.value = ${JSON.stringify(JSON.stringify(["chain_archive", "blocks"]))}; s.dispatchEvent(new Event('change')); })()`);
      await follower.waitFor("document.querySelectorAll('[data-field=\"db-rows.table\"] tbody tr').length === 25", 30_000, "the follower's rows");
      const followerCells = await follower.eval<string[][]>("[...document.querySelectorAll('[data-field=\"db-rows.table\"] tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent))");
      expect(followerCells).toEqual(blocksPage.rows.map((r) => r.map((c) => visibleText(cellText(c).text))));
      await clean(p, true);
      await clean(follower, false);
      await follower.close();
      await p.close();

      // The rows equal the store read with SQL (the reader page, once the engine's worker is gone).
      const q = (n: string): string => `"${n.replaceAll('"', '""')}"`;
      const sqlOf = (r: RowsResult, schema: string, table: string): string =>
        `SELECT ${r.columns.map((c) => (c.type === "bytea" ? q(c.name) : `${q(c.name)}::text AS ${q(c.name)}`)).join(", ")} FROM ${q(schema)}.${q(table)} ORDER BY ${r.orderBy.map((k) => `${q(k)} DESC`).join(", ")} LIMIT 25`;
      const [blocksSql, scanSql] = await readStore(b, [sqlOf(blocksPage, "chain_archive", "blocks"), sqlOf(scanPage, "mip0018", "mip0018_scan")]);
      const expected = (r: RowsResult, sqlRows: Json[]): Json[] => sqlRows.map((row) => r.columns.map((c) => {
        const v = row[c.name];
        if (v === null) return { kind: "null" };
        if (c.type === "bytea") {
          const bytes = Object.values(v as Record<string, number>);
          return { kind: "bytes", hex: Buffer.from(bytes.slice(0, 16)).toString("hex"), bytes: bytes.length };
        }
        const cps = [...String(v)];
        return { kind: "text", text: cps.slice(0, 256).join(""), chars: cps.length };
      }));
      expect(blocksPage.rows).toEqual(expected(blocksPage, blocksSql!));
      expect(scanPage.rows).toEqual(expected(scanPage, scanSql!));
    } finally {
      await b.close();
    }
  }, 300_000);

  /** A node whose every JSON-RPC answer is an error with `message`. */
  const rpcError = (message: string): ChainAnswer => async (path, body) => {
    if (path !== "/rpc") return { status: 503, headers: { "content-type": "text/plain" }, body: "down" };
    const id = (JSON.parse(body) as { id?: number }).id ?? 1;
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) };
  };

  it("[[browser.shell.hostile-text]] text from the engine and from a file, with control, bidi, zero-width and markup characters, is drawn by the overview as text: a node's error (the engine's state and the health line) and a snapshot's hostile network name (the import's refusal); nothing comes alive and no raw hidden character is drawn", async () => {
    const hostile = "\u202Egnp.exe\u200B\u0000<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=2</script>\u001b[31mred \u2066iso\u2069 line\nbreak";
    const marked = "⟨U+202E⟩gnp.exe⟨U+200B⟩⟨U+0000⟩<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=2</script>⟨U+001B⟩[31mred ⟨U+2066⟩iso⟨U+2069⟩ line⟨U+000A⟩break";
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html");
      await on(p)(`c.start(${JSON.stringify({ ...U1_CONFIG, endHeight: U1.to })})`);
      await untilStatus(p, "the U1 range", (s) => s.engine?.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === U1.to + 1);
      await on(p)("c.stop()");
      // The archive continues from the node, which answers every call with the hostile error.
      chain = rpcError(hostile);
      await on(p)(`c.start(${JSON.stringify({ source: { kind: "network", nodeUrl: `${site.origin}/chain/rpc`, indexerUrl: `${site.origin}/chain/graphql` }, startHeight: "tip", sync: { idleMs: 300, backoff: { baseDelayMs: 300, maxDelayMs: 1_000, maxAttempts: 2 } }, scan: { idleMs: 200 } })})`);
      const o = await waitFor("the hostile error drawn", () => overview(p), (x) => x.fields.state.includes("gnp.exe") && x.fields.health.includes("gnp.exe"), 60_000);
      expect(o.fields.state.startsWith("waiting (network) · ")).toBe(true);
      expect(o.fields.state).toContain(marked);
      expect(o.fields.health).toContain(marked);
      expectDrawnFromInputs(o);
      const marks = await p.eval<string[]>("[...document.querySelectorAll('#engine-panel [data-field=state] .mark-vis')].map((e) => e.textContent)");
      expect(marks).toEqual(["⟨U+202E⟩", "⟨U+200B⟩", "⟨U+0000⟩", "⟨U+001B⟩", "⟨U+2066⟩", "⟨U+2069⟩", "⟨U+000A⟩"]);
      expect(await p.eval("document.querySelector('#engine-panel [data-field=state] .d').getAttribute('class')")).toBe("d");
      await on(p)("c.stop()");
      chain = chainDown;

      // A snapshot whose manifest names a hostile network: refused, and the refusal drawn as text.
      const b64 = (await on(p)(`c.export().then(async (r) => { const b = new Uint8Array(await r.file.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })`)) as string;
      const { manifest, data } = decodeSnapshotFile(new Uint8Array(Buffer.from(b64, "base64")));
      const network = "\u202Egnp.exe\u200B<img src=x onerror=\"window.__pwned=3\">";
      const crafted = Buffer.from(encodeSnapshotFile({ ...manifest, network }, data)).toString("base64");
      await p.eval(`(() => {
        const s = atob(${JSON.stringify(crafted)}); const bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
        const dt = new DataTransfer(); dt.items.add(new File([bytes], "crafted.snapshot.tar", { type: "application/x-tar" }));
        document.querySelector('#engine-panel [data-input="snapshot"]').files = dt.files;
        document.querySelector('#engine-panel [data-action="import"]').click();
      })()`);
      await p.waitFor("document.querySelector('#engine-panel [data-field=confirm]').hidden === false", 15_000, "the question before the drop");
      await p.eval("document.querySelector('#engine-panel [data-action=confirm-go]').click()");
      await p.waitFor("/^import failed/.test(document.querySelector('#engine-panel [data-field=message]').textContent)", 60_000, "the refusal");
      const message = await p.eval<string>("document.querySelector('#engine-panel [data-field=message]').textContent");
      expect(message).toBe(`import failed · snapshot-refused: network: the snapshot is of the network "⟨U+202E⟩gnp.exe⟨U+200B⟩<img src=x onerror=\\"window.__pwned=3\\">"; this engine indexes "stagenet"`);
      expect(await p.eval<string[]>("[...document.querySelectorAll('#engine-panel [data-field=message] .mark-vis')].map((e) => e.textContent)")).toEqual(["⟨U+202E⟩", "⟨U+200B⟩"]);
      expect((await status(p)).cursors!.sync!.height).toBe(U1.to); // nothing changed

      // Nothing came alive, no raw hidden character drawn or in an attribute.
      expect(await p.eval("({ scripts: document.scripts.length, media: document.querySelectorAll('img, iframe, object, embed, video, audio').length, pwned: window.__pwned === undefined ? null : window.__pwned })")).toEqual({ scripts: 1, media: 0, pwned: null });
      expect(p.requests.some((r) => /\/x$/.test(r.url))).toBe(false);
      expect(await p.eval<string>("document.body.innerText")).not.toMatch(HIDDEN_RAW);
      for (const a of await p.eval<string[]>("[...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value))")) expect(a).not.toMatch(HIDDEN_RAW_ATTR);
      await shot(p, "shell-hostile.png");
      await clean(p, true);
      await p.close();
    } finally {
      chain = chainDown;
      await b.close();
    }
  }, 240_000);
});
