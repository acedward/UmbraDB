/**
 * The static deploy recipe in Chrome: the site `npm run build:browser` writes, served by `npm run serve:browser`, opened
 * as a user opens it.
 *
 * - `[[browser.deploy.served-build]]` — the build made as `npm run build:browser` makes it (Vite with
 *   `token-indexer/browser/vite.config.ts` and nothing defined, so the engine starts by itself at the finalized tip, then
 *   `dev/browser-snapshot.ts`'s published snapshot), with only the chain moved to a local server through
 *   `UMBRADB_BROWSER_NODE_URL` / `UMBRADB_BROWSER_INDEXER_URL` (a test never reaches Stagenet; the server answers 503,
 *   as an unreachable chain does), served by `serveBrowserBuild` with the build's `_headers` (what `npm run
 *   serve:browser` runs). In headless Chromium with a new profile: the site's root is the explorer; its tab leads, the
 *   worker boots on OPFS and starts by itself at the tip; the page and the worker are cross-origin isolated; the system
 *   status page in a second tab is a follower with all eleven sections and shows "waiting (network)" while the chain
 *   answers 503; the published IDX snapshot (`snapshots/`) imports and gives the recorded digests, and the status page
 *   then shows the engine stopped; reloaded, the explorer lists the tokens with "history before block 714485 is not
 *   indexed". Every request goes to the site (GET) or to the build's chain (from the worker); no CSP violation in either
 *   page or the worker; no exception.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DigestResult, HostStatus } from "../browser/protocol.ts";
import { writePublishedSnapshots } from "../dev/browser-snapshot.ts";
import { type ServedSite, serveBrowserBuild } from "../dev/serve-browser.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { BROWSER_CONFIG } from "./helpers/engine-site.ts";
import { type LocalServer, serveHandler } from "./helpers/static-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IDX = { from: 714485, to: 715183 } as const;
const ARCHIVE = "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119";
const TABLES = "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c";
const CHAIN_ENV = ["UMBRADB_BROWSER_NETWORK", "UMBRADB_BROWSER_NODE_URL", "UMBRADB_BROWSER_INDEXER_URL"] as const;
const SECTIONS = ["overview", "configuration", "sync", "scan", "databases", "storage", "API", "engine", "browser", "snapshots", "logs"];

const browserExe = findBrowser();

const engine = (page: Page, expr: string): Promise<Json> => page.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);

describe("the static deploy recipe in Chrome", () => {
  let dir = "";
  let chain: LocalServer;
  let site: ServedSite;
  let browser: Browser;

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    // An unreachable chain: CORS preflights pass, every call answers 503.
    chain = await serveHandler((req, res) => {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
      if (req.method === "OPTIONS") res.writeHead(204, cors).end();
      else res.writeHead(503, { ...cors, "content-type": "text/plain" }).end("unavailable");
    });
    // `npm run build:browser`: Vite with the configuration as it is, then the published snapshot.
    const { build } = await import("vite");
    dir = mkdtempSync(join(tmpdir(), "umbradb-deploy-site-"));
    const saved = CHAIN_ENV.map((k) => [k, process.env[k]] as const);
    for (const k of CHAIN_ENV) delete process.env[k];
    process.env.UMBRADB_BROWSER_NODE_URL = `${chain.origin}/rpc`;
    process.env.UMBRADB_BROWSER_INDEXER_URL = `${chain.origin}/api/v4/graphql`;
    try {
      await build({ configFile: BROWSER_CONFIG, logLevel: "silent", build: { outDir: dir, emptyOutDir: true } });
    } finally {
      for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await writePublishedSnapshots(dir);
    site = await serveBrowserBuild({ dir, port: 0 });
    browser = await Browser.launch(browserExe);
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    await chain?.close();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  /** Requests only to the site (GET) and, from the worker, to the build's chain; none blocked. */
  function expectAllowedRequests(page: Page): void {
    for (const r of page.requests) {
      if (r.url.startsWith("data:") || r.url.startsWith("blob:") || r.url === "about:blank") continue;
      const origin = new URL(r.url).origin;
      if (origin === site.origin) {
        expect(r.method, r.url).toBe("GET");
        expect(r.blockedReason, r.url).toBeUndefined();
        expect(r.status === undefined || r.status < 400 || r.url === `${site.origin}/favicon.ico`, `${r.url} ${r.status}`).toBe(true);
      } else {
        expect(origin, r.url).toBe(chain.origin);
        expect(["POST", "OPTIONS"], r.url).toContain(r.method);
        expect(r.blockedReason, r.url).toBeUndefined();
      }
    }
  }

  it("[[browser.deploy.served-build]] the site npm run build:browser writes, served by npm run serve:browser: the explorer at the root leads, boots on OPFS and starts by itself, cross-origin isolated; the status page is a follower with every section, waiting (network) while the chain is down; the published snapshot imports with the recorded digests and the explorer lists its tokens from block 714485; only the site and the build's chain are requested; no CSP violation", async () => {
    // What the build wrote: the pages, the assets, the headers file and the published snapshot.
    expect(readdirSync(dir).sort()).toEqual(["THIRD-PARTY-NOTICES.txt", "_headers", "assets", "engine.html", "index.html", "snapshots", "system.html"]);
    expect(readdirSync(join(dir, "snapshots")).sort()).toEqual(["index.json", `umbradb-stagenet-${IDX.from}-${IDX.to}.snapshot.tar`]);
    const headers = readFileSync(join(dir, "_headers"), "utf8");
    expect(headers).toContain(`connect-src 'self' ${chain.origin};`);
    expect(site.rules).toHaveLength(1);
    expect(site.rules[0]!.pattern).toBe("/*");

    const page = await browser.newPage({ workers: true });
    await page.goto(`${site.origin}/`);
    await page.waitFor("window.umbradbEngine !== undefined && window.umbradbExplorerHost !== undefined", 30_000, "the explorer page");
    expect(await page.eval("document.title")).toBe("MIP-0018 token explorer");
    expect(await engine(page, "c.booted()")).toMatchObject({ phase: "ready", error: null });
    expect(await page.eval("window.umbradbEngine.tabs.role()")).toBe("leader");
    await page.waitFor("document.getElementById('engine-panel').getAttribute('data-role') === 'leader'", 30_000, "the panel's leader mark");
    // The automatic start: a new store's saved configuration starts by itself at the tip, and waits for the chain. The
    // leader tab sends the start once its worker has booted, so the page waits for it (bounded) rather than reading once.
    const startedBy = Date.now() + 60_000;
    let st = (await engine(page, "c.status()")) as HostStatus;
    while (st.engine?.status.started !== true && Date.now() < startedBy) {
      await new Promise((r) => setTimeout(r, 100));
      st = (await engine(page, "c.status()")) as HostStatus;
    }
    expect(st.store?.dataDir).toBe("opfs-ahp://umbradb-stagenet");
    expect(st.settings).toMatchObject({ autoStart: true });
    expect(st.engine?.status.started, "the engine started by itself within 60 s of the boot").toBe(true);
    expect(st.cursors).toEqual({ sync: null, scan: null });
    expect(await page.eval("self.crossOriginIsolated")).toBe(true);
    expect(await page.evalWorker("self.crossOriginIsolated")).toBe(true);

    // The system status page beside it: a follower showing the leader's state, waiting for the chain.
    const system = await browser.newPage({ workers: true });
    await system.goto(`${site.origin}/system.html`);
    await system.waitFor("window.umbradbSystem !== undefined && window.umbradbSystem.latest() !== null && window.umbradbSystem.latest().overview.health.state === 'waiting-network'", 90_000, "the status page's waiting (network)");
    expect(await system.eval("window.umbradbEngine.tabs.role()")).toBe("follower");
    expect(await system.eval<string[]>("[...document.querySelectorAll('section h2')].map((h) => h.textContent)")).toEqual(SECTIONS);
    expect(await system.eval("self.crossOriginIsolated")).toBe(true);
    expect(system.workers).toEqual([]);
    expect(chain.hits.get("POST /rpc") ?? 0, JSON.stringify([...chain.hits])).toBeGreaterThan(0);

    // The published snapshot, as the panel's user would load it: fetched from the site, checked, imported.
    const r = await engine(page, `window.umbradbEngine.snapshots.published("idx").then((f) => c.import(f)).then((r) => ({ ok: true, height: r.manifest.archive.height }), (e) => ({ ok: false, message: e.code + " " + e.message }))`);
    expect(r, JSON.stringify(r)).toEqual({ ok: true, height: IDX.to });
    const digest = (await engine(page, "c.digest()")) as DigestResult;
    expect([digest.archive.sha256, digest.tables.sha256]).toEqual([ARCHIVE, TABLES]);
    expect(page.requests.some((q) => q.url === `${site.origin}/snapshots/umbradb-stagenet-${IDX.from}-${IDX.to}.snapshot.tar` && q.status === 200)).toBe(true);
    await system.waitFor("window.umbradbSystem.latest().overview.health.state === 'stopped'", 60_000, "the status page's stopped engine after the import");
    expectAllowedRequests(system);
    expect(await system.eval("window.__cspViolations")).toEqual([]);
    expect(system.exceptions).toEqual([]);
    expect(system.logs.filter((l) => l.source === "security")).toEqual([]);
    await system.close();
    expect(await page.eval("window.__cspViolations")).toEqual([]);
    expect(await page.evalWorker("self.__cspViolations")).toEqual([]);

    // The explorer, reloaded on the imported store (its tab leads again and starts a new worker).
    const workersBefore = page.workerSessions.length;
    await page.goto(`${site.origin}/`);
    await page.waitFor("document.body.getAttribute('data-route') === 'list' && document.body.getAttribute('data-state') === 'ready'", 60_000, "the token list");
    expect(await page.eval("window.umbradbEngine.tabs.role()")).toBe("leader");
    const tokens = JSON.parse(((await engine(page, `c.api("GET", "/v1/tokens?limit=100")`)) as { body: string }).body) as { items: unknown[] };
    expect(tokens.items.length).toBeGreaterThan(0);
    expect(await page.eval<number>("document.querySelectorAll('#view tbody tr').length")).toBe(tokens.items.length);
    expect(await page.eval<string[]>("[...document.querySelectorAll('#view .range-note')].map((n) => n.textContent)")).toEqual([
      `indexed from block ${IDX.from} \u00b7 history before block ${IDX.from} is not indexed`,
    ]);

    expectAllowedRequests(page);
    expect(page.workerSessions.length).toBe(workersBefore + 1);
    expect(await page.eval("window.__cspViolations")).toEqual([]);
    expect(await page.evalWorker("self.__cspViolations")).toEqual([]);
    expect(page.exceptions).toEqual([]);
    expect(page.logs.filter((l) => l.source === "security")).toEqual([]);
    await page.close();
  }, 300_000);
});
