/**
 * The static build's explorer page (`token-indexer/browser/index.html`) in Chrome: the build (Vite, into a temporary
 * folder) served from 127.0.0.1 with its `_headers` rules (the Content-Security-Policy as a header, COOP/COEP), headless
 * Chromium driven over the DevTools protocol (`helpers/cdp-browser.ts`) recording every request, log entry and
 * `securitypolicyviolation` of the page and of its worker. The engine replays the recorded Stagenet tapes inside its
 * worker: no network. The build's chain is a local server that refuses everything and must never be asked (a start that
 * reached for the network would fail there, never on Stagenet), and the engine does not start by itself.
 *
 * The explorer's own checks (`helpers/explorer-checks.ts`) are the ones the Node-served page `GET /ui` passes
 * (`mip0018-ui-browser.test.ts`), with the API answered by the engine in the page's worker:
 * - `[[browser.explorer.routes]]` — `[[mip0018.ui.browser-routes]]`'s checks on the IDX range replayed in the worker;
 *   the note "history before block H is not indexed" next to the lists and in the panel; one module script; only
 *   same-origin requests (no `/v1` request: the API is the engine's), the font loaded; no CSP violation in the page or
 *   the worker, no exception, no console error.
 * - `[[browser.explorer.activity]]` — `[[mip0018.ui.browser-activity-shape]]`'s recorded part, the same way.
 * - `[[browser.explorer.withdrawn]]` — `[[mip0018.ui.browser-withdrawn]]`'s recorded part (C06 step by step, the page
 *   open and refreshing on its own) with the engine replaying the IDX tape up to each step.
 * The synthetic parts of those tests and `[[mip0018.ui.browser-hostile-text]]` / `[[mip0018.ui.browser-bounded]]` need
 * blocks the Node tests write into the archive with test decoders (`helpers/synthetic-*.ts`); the browser engine only
 * ingests a chain (a tape or the network) and decodes with the real ledger, so they run on the Node page only. The
 * explorer script is the same file in both builds; `[[browser.explorer.seam]]` covers its rendering of hostile and
 * failing answers through the engine.
 *
 * And the static build's own:
 * - `[[browser.explorer.seam]]` — through the engine: an answer announced over 8 MiB and one streamed over 8 MiB are
 *   `TOO_LARGE`, a 503 is its error code, a failed engine request is `UNREACHABLE`, each exactly as the explorer renders a
 *   fetched answer; hostile text in an engine answer is drawn as visible marks and markup as text, no script runs.
 * - `[[browser.explorer.panel]]` — the engine panel: an empty store (nothing indexed yet, not started, leader,
 *   storage); after a replay the start height, "history before block H is not indexed" in the panel and next to the
 *   lists, synced and scanned heights, durability, configuration; a second tab is marked follower; each control sends
 *   its one request (recorded on the tabs' channel when a follower sends it: `stop`, `start`, `range` with the typed
 *   heights, `reset`, `export`, `import` with the chosen file); a range change, a reset and an import on a store with
 *   blocks first ask, offering the export (cancel sends nothing); the engine's answers are shown (the range replays and
 *   the start height follows; export and import answer as the worker does); when the leader closes, the follower is
 *   marked leader; the system status link.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `MIP0018_UI_SCREENSHOTS=<dir>` saves PNGs (never committed).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostStatus } from "../browser/protocol.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { BROWSER_CONFIG, NO_AUTO_START } from "./helpers/engine-site.ts";
import { checkC06Lifecycle, checkRecordedActivity, checkRecordedRoutes, contractOf, type ExplorerTarget, HIDDEN_RAW, type Json, LIST_ROWS, visit } from "./helpers/explorer-checks.ts";
import { type LocalServer, parseHeadersFile, serveHandler, serveStaticSite } from "./helpers/static-site.ts";

const IDX = { from: 714485, to: 715183 } as const;
const U1 = { from: 715402, to: 715433 } as const;
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };
const CHAIN_ENV = ["UMBRADB_BROWSER_NETWORK", "UMBRADB_BROWSER_NODE_URL", "UMBRADB_BROWSER_INDEXER_URL"] as const;
const STORE_CHANNEL = "umbradb-engine:opfs-ahp://umbradb-stagenet";
const SHOTS = process.env.MIP0018_UI_SCREENSHOTS;

/** Builds with Vite into a new temporary folder: the chain at `chain` (a local origin), no automatic start. */
async function buildSite(chain: string): Promise<string> {
  const { build } = await import("vite");
  const out = mkdtempSync(join(tmpdir(), "umbradb-explorer-site-"));
  const saved = CHAIN_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of CHAIN_ENV) delete process.env[k];
  process.env.UMBRADB_BROWSER_NODE_URL = `${chain}/rpc`;
  process.env.UMBRADB_BROWSER_INDEXER_URL = `${chain}/graphql`;
  try {
    await build({ configFile: BROWSER_CONFIG, logLevel: "silent", define: NO_AUTO_START, build: { outDir: out, emptyOutDir: true } });
  } finally {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return out;
}

const engine = (page: Page, expr: string): Promise<Json> => page.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
const status = (page: Page): Promise<HostStatus> => engine(page, "c.status()");

async function until(page: Page, what: string, ok: (s: HostStatus) => boolean, timeoutMs = 120_000): Promise<HostStatus> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await status(page);
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ boot: s.boot.phase, cursors: s.cursors, engine: s.engine?.status })}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Loads the explorer and waits until this tab's engine connection has a booted engine behind it. */
async function openExplorer(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitFor("window.umbradbEngine !== undefined && window.umbradbExplorerHost !== undefined", 30_000, "the explorer page");
  const boot = (await page.eval("window.umbradbEngine.client.booted()")) as { phase: string; error: string | null };
  expect(boot, JSON.stringify(boot)).toMatchObject({ phase: "ready", error: null });
}

/** Replays `range` from `from` to `to` in the worker, waits until both loops reached `to`, then stops the engine. */
async function replay(page: Page, range: "idx" | "u1", from: number, to: number): Promise<void> {
  await engine(page, `c.start(${JSON.stringify({ source: { kind: "tape", range }, startHeight: from, endHeight: to, ...FAST })})`);
  await until(page, `the replay to ${to}`, (s) => s.engine?.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === to + 1);
  await engine(page, "c.stop()");
}

/** The API the page reads, answered by the engine in the page. */
function target(page: Page, name: string): ExplorerTarget {
  return {
    page,
    async api(path: string) {
      const r = (await engine(page, `c.api("GET", ${JSON.stringify(path)})`)) as { status: number; body: string };
      return { status: r.status, json: r.body === "" ? undefined : JSON.parse(r.body) };
    },
    shot: (file: string) => shot(page, `${name}-${file}`),
  };
}

function shot(page: Page, name: string): Promise<void> | undefined {
  if (SHOTS === undefined || SHOTS === "") return undefined;
  return page.screenshot().then((png) => {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, name), png);
  });
}

/** What the engine panel shows now. */
interface PanelSnap {
  role: string | null;
  state: string | null;
  fields: Record<string, string>;
  startHeight: string | null;
  message: string;
  confirm: string | null;
  disabled: Record<string, boolean>;
  systemHref: string | null;
}
const PANEL = `(() => {
  const p = document.getElementById('engine-panel');
  const fields = {};
  for (const f of p.querySelectorAll('.kv [data-field]')) fields[f.getAttribute('data-field')] = f.textContent;
  const disabled = {};
  for (const b of p.querySelectorAll('[data-action]')) disabled[b.getAttribute('data-action')] = b.disabled;
  const confirm = p.querySelector('[data-field="confirm"]');
  return { role: p.getAttribute('data-role'), state: p.getAttribute('data-state'), fields,
    startHeight: p.querySelector('[data-field="history"]').getAttribute('data-start-height'),
    message: p.querySelector('[data-field="message"]').textContent, confirm: confirm.hidden ? null : confirm.firstChild.textContent,
    disabled, systemHref: p.querySelector('[data-link="system"]').href };
})()`;
const panel = (page: Page): Promise<PanelSnap> => page.eval<PanelSnap>(PANEL);
const click = (page: Page, action: string): Promise<void> => page.eval(`document.querySelector('#engine-panel [data-action="${action}"]').click()`);
const type = (page: Page, input: string, value: string): Promise<void> =>
  page.eval(`(() => { const i = document.querySelector('#engine-panel [data-input="${input}"]'); i.value = ${JSON.stringify(value)}; })()`);
const history = (h: number): string => `indexed from block ${h} \u00b7 history before block ${h} is not indexed`;

const browserExe = findBrowser();

describe("the static build's explorer page in Chrome", () => {
  const servers: LocalServer[] = [];
  let browser: Browser;
  let dir = "";
  /** The build's chain: refuses everything; no test may reach it. */
  let chain: LocalServer;
  let sites: { idx: LocalServer; c06: LocalServer; panel: LocalServer };

  /** Requests only to the site's origin, never blocked, none to the API over HTTP; the explorer's font loaded. */
  function expectOnlySite(page: Page, site: LocalServer): void {
    for (const r of page.requests) {
      if (r.url.startsWith("data:") || r.url.startsWith("blob:") || r.url === "about:blank") continue;
      const u = new URL(r.url);
      expect(u.origin, r.url).toBe(site.origin);
      expect(r.method, r.url).toBe("GET");
      expect(r.blockedReason, r.url).toBeUndefined();
      expect(u.pathname.startsWith("/v1/"), r.url).toBe(false);
    }
  }
  /** No CSP violation in the page or its worker, no exception, no console error or warning, no error log entry. */
  async function expectClean(page: Page, opts: { worker: boolean }): Promise<void> {
    expect(await page.eval("window.__cspViolations")).toEqual([]);
    if (opts.worker) expect(await page.evalWorker("self.__cspViolations")).toEqual([]);
    expect(page.exceptions).toEqual([]);
    expect(page.console.filter((c) => c.type === "error" || c.type === "warning" || c.type === "assert")).toEqual([]);
    expect(page.logs.filter((l) => l.level === "error" || l.level === "warning")).toEqual([]);
    expect(chain.hits.size, "the build's chain was never asked").toBe(0);
  }

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    chain = await serveHandler((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("not a chain");
    });
    servers.push(chain);
    dir = await buildSite(chain.origin);
    const headers = parseHeadersFile(readFileSync(join(dir, "_headers"), "utf8"));
    // One origin per test group: each origin is its own OPFS store, Web Locks and tabs.
    sites = { idx: await serveStaticSite(dir, { headers }), c06: await serveStaticSite(dir, { headers }), panel: await serveStaticSite(dir, { headers }) };
    servers.push(sites.idx, sites.c06, sites.panel);
    browser = await Browser.launch(browserExe);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    for (const s of servers) await s.close();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("[[browser.explorer.routes]] the IDX range replayed in the worker: the explorer's route checks of the Node page pass with the API answered by the engine; 'history before block H is not indexed' next to the lists and in the panel; one module script; only same-origin requests, none to /v1; the font loaded; no CSP violation in the page or the worker, no exception or console error", async () => {
    const page = await browser.newPage({ workers: true });
    await openExplorer(page, `${sites.idx.origin}/index.html`);
    await replay(page, "idx", IDX.from, IDX.to);
    // A fresh load reads the finished store (a new engine worker on the same OPFS store).
    await openExplorer(page, `${sites.idx.origin}/index.html`);
    expect(await page.eval("self.crossOriginIsolated")).toBe(true);
    await checkRecordedRoutes(target(page, "static"));

    // The start height next to every list, here and in the panel.
    await visit(page, "#/");
    expect(await page.eval<string[]>("[...document.querySelectorAll('#view .range-note')].map((n) => n.textContent + '|' + n.getAttribute('data-start-height'))")).toEqual([`${history(IDX.from)}|${IDX.from}`]);
    const c04 = contractOf("C04");
    await visit(page, `#/contract/${c04}`);
    expect(await page.eval<number>("document.querySelectorAll('#view .range-note').length")).toBe(3); // token identities, activity, events
    await page.waitFor(`document.querySelector('#engine-panel [data-field="scanned"]').textContent === '${IDX.to}'`, 15_000, "the panel");
    const p = await panel(page);
    expect([p.role, p.fields.history, p.startHeight, p.fields.synced, p.fields.scanned, p.fields.durability, p.fields.network]).toEqual(
      ["leader", history(IDX.from), String(IDX.from), String(IDX.to), String(IDX.to), "non-durable", "stagenet"]);
    expect(p.state).toBe("not started"); // a new worker on the finished store: nothing started since the load
    await shot(page, "static-panel.png");

    expect(await page.eval<number>("document.scripts.length")).toBe(1);
    expectOnlySite(page, sites.idx);
    const font = page.requests.find((r) => /\/assets\/Outfit-Variable-latin-[\w-]+\.woff2$/.test(r.url));
    expect(font?.status).toBe(200);
    expect(page.requests.some((r) => r.target === "worker" && /\/assets\/stagenet-714485-715183\.tape\.json-[\w-]+\.gz$/.test(r.url))).toBe(true);
    await expectClean(page, { worker: true });
    await page.close();
  }, 300_000);

  it("[[browser.explorer.activity]] the explorer's recorded activity checks of the Node page pass with the API answered by the engine; only same-origin requests; no CSP violation, exception or console error", async () => {
    const page = await browser.newPage({ workers: true });
    await openExplorer(page, `${sites.idx.origin}/index.html`);
    await checkRecordedActivity(target(page, "static"));
    expectOnlySite(page, sites.idx);
    await expectClean(page, { worker: true });
    await page.close();
  }, 240_000);

  it("[[browser.explorer.withdrawn]] C06 step by step with the page open and refreshing on its own, the engine replaying the IDX tape up to each step: the withdrawn name is on no reachable view after the tombstone and stays absent after the revive; no CSP violation", async () => {
    const page = await browser.newPage({ workers: true });
    await openExplorer(page, `${sites.c06.origin}/index.html?refresh=600#/`);
    await page.waitFor("document.body.getAttribute('data-route') === 'list' && document.body.getAttribute('data-state') !== 'loading'");
    await checkC06Lifecycle(target(page, "static"), async (height) => {
      await replay(page, "idx", 714789, height);
    });
    expectOnlySite(page, sites.c06);
    await expectClean(page, { worker: true });
    await page.close();
  }, 300_000);

  it("[[browser.explorer.seam]] through the engine: an answer announced or streamed over 8 MiB is TOO_LARGE, a 503 is its error code, a failed engine request is UNREACHABLE (each as a fetched answer is rendered); hostile text in an engine answer is drawn as marks and markup as text, no script runs; no CSP violation", async () => {
    const page = await browser.newPage({ workers: true });
    await openExplorer(page, `${sites.idx.origin}/index.html`);
    await page.waitFor("document.body.getAttribute('data-route') === 'list' && document.body.getAttribute('data-state') === 'ready'");
    const banner = (): Promise<string | null> => page.eval("document.getElementById('banner').hidden ? null : document.getElementById('banner').innerText");
    /** The engine client's `api` replaced for the token list (the rest answered by the engine), then a refresh. */
    async function tokensAnswer(fn: string, expectBanner: string | null): Promise<void> {
      await page.eval(`(() => {
        const c = window.umbradbEngine.client;
        window.__realApi ??= c.api;
        const list = ${fn};
        c.api = (m, t) => (t.startsWith("/v1/tokens?") ? list(m, t) : window.__realApi(m, t));
        document.getElementById('now').click();
      })()`);
      if (expectBanner === null) await page.waitFor("document.getElementById('banner').hidden && document.body.getAttribute('data-state') === 'ready'", 15_000, "no banner");
      else await page.waitFor(`(document.getElementById('banner').innerText || '').includes(${JSON.stringify(expectBanner)})`, 15_000, expectBanner);
    }
    const json = { "content-type": "application/json; charset=utf-8" };
    await tokensAnswer(`async () => ({ status: 200, headers: { ...${JSON.stringify(json)}, "content-length": String(8 * 1024 * 1024 + 1) }, body: "{}" })`, "/v1/tokens?limit=100 answered 200 TOO_LARGE");
    expect(await page.eval<string>("document.getElementById('view').innerText")).toContain("the token list could not be read (see the banner)");
    await tokensAnswer(`async () => ({ status: 200, headers: ${JSON.stringify(json)}, body: JSON.stringify({ items: [], pad: "x".repeat(8 * 1024 * 1024) }) })`, "/v1/tokens?limit=100 answered 200 TOO_LARGE");
    await tokensAnswer(`async () => ({ status: 503, headers: { ...${JSON.stringify(json)}, "retry-after": "1" }, body: JSON.stringify({ error: { code: "BUSY", message: "busy" } }) })`, "/v1/tokens?limit=100 answered 503 BUSY");
    await tokensAnswer("async () => { throw new Error('the engine is gone'); }", "/v1/tokens?limit=100 answered nothing UNREACHABLE");
    expect(await banner()).toMatch(/^the API did not answer everything this view needs/);
    // Hostile text in a real answer: marks, markup as text, no element and no script.
    const hostile = "\u202egnp.exe\u200b<script>window.__pwned=1</script><img src=x>";
    await tokensAnswer(`async (m, t) => {
      const r = await window.__realApi(m, t);
      const j = JSON.parse(r.body);
      const i = j.items.findIndex((x) => x.source === "identity" && typeof x.name === "string");
      j.items[i].name = ${JSON.stringify(hostile)};
      window.__hostileRow = i;
      const body = JSON.stringify(j);
      return { ...r, headers: { ...r.headers, "content-length": String(new TextEncoder().encode(body).length) }, body };
    }`, null);
    const rows = await page.eval<Json[]>(LIST_ROWS);
    const row = rows[await page.eval<number>("window.__hostileRow")]!;
    expect(row.cells[1]).toBe("\u27e8U+202E\u27e9gnp.exe\u27e8U+200B\u27e9<script>window.__pwned=1<\u2026"); // 48 drawn characters
    expect(await page.eval<string>("document.getElementById('view').innerText")).not.toMatch(HIDDEN_RAW);
    expect(await page.eval<Json>("({ scripts: document.scripts.length, media: document.querySelectorAll('#view img, #view script').length, pwned: window.__pwned === undefined ? null : window.__pwned })")).toEqual({ scripts: 1, media: 0, pwned: null });
    // The engine again: no banner, the 16 rows.
    await page.eval("(() => { window.umbradbEngine.client.api = window.__realApi; document.getElementById('now').click(); })()");
    await page.waitFor(`document.getElementById('banner').hidden && document.querySelectorAll('#tokens tbody tr').length === 16`, 15_000, "the engine's list");
    expectOnlySite(page, sites.idx);
    await expectClean(page, { worker: true });
    await page.close();
  }, 240_000);

  it("[[browser.explorer.panel]] the engine panel: empty store, then the start height and its 'history before' sentence next to the lists, heights, durability, configuration and storage; a second tab is marked follower; each control sends its one request (range with the typed heights, import with the chosen file), a drop of data first offers the export and cancel sends nothing; the engine's answers are shown; the follower is marked leader when the leader closes; the system status link; no CSP violation", async () => {
    const site = sites.panel;
    const leader = await browser.newPage({ workers: true });
    await openExplorer(leader, `${site.origin}/index.html`);
    // An empty store: nothing indexed, the engine not started, this tab leads.
    await leader.waitFor("document.querySelector('#engine-panel').getAttribute('data-state') === 'not started' && document.querySelector('#engine-panel [data-field=\"storage\"]').textContent !== 'unknown'", 15_000, "the empty panel");
    let p = await panel(leader);
    expect([p.role, p.fields.history, p.startHeight, p.fields.synced, p.fields.scanned, p.fields.network, p.fields.durability]).toEqual(
      ["leader", "nothing indexed yet", "", "none", "none", "stagenet", "non-durable"]);
    expect(p.fields.role).toBe("leader (this tab runs the engine) \u00b7 1 tab open");
    expect(p.disabled).toMatchObject({ start: false, stop: true, range: false, reset: false, export: false, import: false });
    expect(p.systemHref).toBe(`${site.origin}/system.html`);
    const st0 = await status(leader);
    const quota = st0.storage?.quotaBytes ?? (await leader.eval<number>("navigator.storage.estimate().then((e) => e.quota)"));
    expect(p.fields.storage).toContain(` used of ${(quota / 1_000_000).toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} MB`);
    expect(p.fields.storage).toMatch(/persistent: (yes|no|unknown)/);
    expect(await leader.eval<string>("document.querySelector('#tokens .range-note').textContent")).toBe("nothing indexed yet");

    // After a replay: the start height everywhere, the heights, the configuration.
    await replay(leader, "u1", U1.from, U1.to);
    await engine(leader, `c.start()`); // the saved configuration: the same replay, continuing at the cursors
    await leader.waitFor(`document.querySelector('#engine-panel [data-field="scanned"]').textContent === '${U1.to}' && document.querySelector('#engine-panel').getAttribute('data-state') === 'running'`, 15_000, "the panel after the replay");
    p = await panel(leader);
    expect([p.fields.history, p.startHeight, p.fields.synced, p.fields.scanned]).toEqual([history(U1.from), String(U1.from), String(U1.to), String(U1.to)]);
    expect(p.fields.configuration).toBe(`from block ${U1.from} \u00b7 to block ${U1.to} \u00b7 recorded range u1, replayed offline \u00b7 starts by itself`);
    expect(p.fields.state).toMatch(/^running \u00b7 sync (starting|running|idle|done) \u00b7 scan following$/);
    expect(p.disabled).toMatchObject({ start: true, stop: false });
    await leader.eval("document.getElementById('now').click()");
    await leader.waitFor(`document.querySelector('#tokens .range-note').textContent === ${JSON.stringify(history(U1.from))}`, 15_000, "the list's note");
    const mintRow = await leader.eval<string | null>("(document.querySelector('#tokens tbody tr.pick a[href^=\"#/token/\"]') || {}).getAttribute ? document.querySelector('#tokens tbody tr.pick a[href^=\"#/token/\"]').getAttribute('href') : null");
    expect(mintRow).not.toBe(null);
    await visit(leader, mintRow!);
    // An identity: its current fields, its mark, its activity and its contract's events each carry the note.
    expect(await leader.eval<string[]>("[...document.querySelectorAll('#view .range-note')].map((n) => n.closest('section').querySelector('h2').textContent)")).toEqual(
      ["current fields", "MIP-0018 mark", "activity: transactions that touched it", "MIP-0018 events of its contract"]);
    await shot(leader, "static-panel-u1.png");

    // A second tab: a follower, the same start height.
    const follower = await browser.newPage({ workers: true });
    await openExplorer(follower, `${site.origin}/index.html`);
    await follower.waitFor(`document.querySelector('#engine-panel').getAttribute('data-role') === 'follower' && document.querySelector('#engine-panel [data-field="history"]').textContent === ${JSON.stringify(history(U1.from))}`, 15_000, "the follower's panel");
    p = await panel(follower);
    expect(p.fields.role).toBe("follower (the engine runs in another tab) \u00b7 2 tabs open");
    expect(follower.workers).toEqual([]);
    // The leader's tab is in the background now: its panel waits until it is shown again (no refresh while hidden).
    expect(await leader.eval("document.visibilityState")).toBe("hidden");
    await leader.send("Page.bringToFront");
    await leader.waitFor("/2 tabs open/.test(document.querySelector('#engine-panel [data-field=\"role\"]').textContent)", 15_000, "the leader's tab count");
    await follower.send("Page.bringToFront");

    // The follower's controls: each one request on the tabs' channel (recorded in the leader's page).
    await leader.eval(`(() => {
      window.__seen = [];
      window.__recorder = new BroadcastChannel(${JSON.stringify(STORE_CHANNEL)});
      window.__recorder.onmessage = (e) => {
        const m = e.data;
        if (!m || m.kind !== "request" || m.type === "status" || m.type === "api") return; // the reads every tab makes
        const params = {};
        for (const [k, v] of Object.entries(m.params)) params[k] = v instanceof Blob ? { blob: v.size, name: v.name ?? null, text: null } : v;
        window.__seen.push({ type: m.type, params });
      };
    })()`);
    const seen = (): Promise<Array<{ type: string; params: Json }>> => leader.eval("window.__seen");
    const waitMessage = (page: Page, re: RegExp, what: string): Promise<void> =>
      page.waitFor(`${re.toString()}.test(document.querySelector('#engine-panel [data-field="message"]').textContent)`, 60_000, what);

    await click(follower, "stop");
    await waitMessage(follower, /^stopped$/, "stop answered");
    expect((await status(leader)).engine?.running).toBe(false);
    await follower.waitFor("document.querySelector('#engine-panel').getAttribute('data-state') === 'stopped'", 15_000, "stopped shown");

    await click(follower, "start");
    await waitMessage(follower, /^started$/, "start answered");
    expect((await status(leader)).engine?.running).toBe(true);
    expect(await seen()).toEqual([{ type: "stop", params: {} }, { type: "start", params: {} }]);

    // A typed range that is not one is not sent.
    await type(follower, "range-start", "abc");
    await click(follower, "range");
    await waitMessage(follower, /^range not sent \u00b7 /, "range refused in the page");
    // A range change on a store that holds blocks: the question first, with the export offered.
    await follower.waitFor("document.querySelector('#engine-panel').getAttribute('data-state') === 'running'", 15_000, "running shown");
    await type(follower, "range-start", "715410");
    await type(follower, "range-end", "715420");
    await click(follower, "range");
    p = await panel(follower);
    expect(p.confirm).toBe(`This store holds blocks ${U1.from}\u2013${U1.to}. Changing the range drops them; export a snapshot first to keep them.`);
    expect((await seen()).length).toBe(2); // nothing sent yet
    await click(follower, "confirm-export");
    await waitMessage(follower, /^export failed \u00b7 not-implemented: /, "export answered");
    expect((await panel(follower)).confirm).not.toBe(null); // still asking
    await click(follower, "confirm-go");
    await waitMessage(follower, /^the store now indexes from block 715410 to block 715420$/, "range answered");
    expect((await seen()).slice(2)).toEqual([{ type: "export", params: {} }, { type: "range", params: { startHeight: 715410, endHeight: 715420 } }]);
    await until(leader, "the new range", (s) => s.cursors?.scan?.nextHeight === 715421);
    await follower.waitFor(`document.querySelector('#engine-panel [data-field="history"]').textContent === ${JSON.stringify(history(715410))}`, 15_000, "the new start height in the panel");
    expect((await target(leader, "x").api("/v1/status")).json.startHeight).toBe(715410);

    // Reset: asked first; cancel sends nothing; then the reset.
    const syncedShown = (page: Page, h: number): Promise<void> =>
      page.waitFor(`document.querySelector('#engine-panel [data-field="synced"]').textContent === '${h}' && document.querySelector('#engine-panel [data-field="history"]').textContent === ${JSON.stringify(history(715410))}`, 15_000, `synced ${h} shown`);
    await syncedShown(follower, 715420);
    await click(follower, "reset");
    expect((await panel(follower)).confirm).toBe("This store holds blocks 715410\u2013715420. Resetting drops them; export a snapshot first to keep them.");
    await click(follower, "confirm-cancel");
    await waitMessage(follower, /^cancelled: nothing was sent$/, "cancel");
    expect((await seen()).length).toBe(4);
    await click(follower, "reset");
    await click(follower, "confirm-go");
    await waitMessage(follower, /^reset: the store's data was dropped and the saved configuration started again$/, "reset answered");
    expect((await seen()).slice(4)).toEqual([{ type: "reset", params: {} }]);
    await until(leader, "the range again", (s) => s.cursors?.scan?.nextHeight === 715421 && s.cursors?.sync?.startHeight === 715410);

    // Import: no file, nothing sent; a file: asked first, then one import request carrying the file.
    await syncedShown(follower, 715420);
    await click(follower, "import");
    await waitMessage(follower, /^import not sent \u00b7 choose a snapshot file first$/, "import without a file");
    await follower.eval(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1, 2, 3, 4, 5])], "umbradb-stagenet-715410-715420.snapshot.tar", { type: "application/x-tar" }));
      document.querySelector('#engine-panel [data-input="snapshot"]').files = dt.files;
    })()`);
    await click(follower, "import");
    expect((await panel(follower)).confirm).toBe("This store holds blocks 715410\u2013715420. Importing a snapshot drops them; export a snapshot first to keep them.");
    await click(follower, "confirm-go");
    await waitMessage(follower, /^import failed \u00b7 not-implemented: /, "import answered");
    expect((await seen()).slice(5)).toEqual([{ type: "import", params: { snapshot: { blob: 5, name: "umbradb-stagenet-715410-715420.snapshot.tar", text: null } } }]);

    // The export control alone: one request, the worker's answer shown.
    await click(follower, "export");
    await waitMessage(follower, /^export failed \u00b7 not-implemented: /, "export answered");
    expect((await seen()).slice(6)).toEqual([{ type: "export", params: {} }]);

    // The leader's own stop goes to its worker directly.
    await click(leader, "stop");
    await waitMessage(leader, /^stopped$/, "the leader's stop");
    expect((await status(leader)).engine?.running).toBe(false);
    expect((await seen()).length).toBe(7);

    for (const page of [leader, follower]) {
      expectOnlySite(page, site);
      expect(await page.eval("window.__cspViolations")).toEqual([]);
      expect(page.exceptions).toEqual([]);
    }
    expect(await leader.evalWorker("self.__cspViolations")).toEqual([]);

    // The leader closes: the follower takes over and is marked leader.
    await leader.close();
    await follower.waitFor("document.querySelector('#engine-panel').getAttribute('data-role') === 'leader' && /^leader \\(this tab runs the engine\\) \u00b7 1 tab open$/.test(document.querySelector('#engine-panel [data-field=\"role\"]').textContent)", 30_000, "the follower leads");
    await follower.waitFor(`document.querySelector('#engine-panel [data-field="history"]').textContent === ${JSON.stringify(history(715410))}`, 15_000, "the same store");
    expect(follower.workers.length).toBe(1);
    expect(await follower.eval("window.__cspViolations")).toEqual([]);
    expect(chain.hits.size).toBe(0);
    await follower.close();
  }, 300_000);
});
