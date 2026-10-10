/**
 * The static build under its own Content-Security-Policy in Chrome: the build (`token-indexer/browser/vite.config.ts`,
 * built here with Vite into temporary folders) served from 127.0.0.1, headless Chromium driven over the DevTools
 * protocol (`helpers/cdp-browser.ts`) recording every request, log entry and `securitypolicyviolation` event of the page
 * and of its worker.
 *
 * - `[[browser.csp.headers]]` — served with its `_headers` rules (the policy as a header, COOP/COEP): the page and the
 *   worker are cross-origin isolated; the worker boots on OPFS (PGlite, its migrations, the ledger's WASM), replays and
 *   scans a recorded range and answers API requests with no CSP violation in the page or the worker, and every request
 *   stays on the site's origin; a second tab joins as a follower (Web Locks, BroadcastChannel) and gets the same answers
 *   through the leader, with no violation and no worker of its own.
 * - `[[browser.csp.chain-origins]]` — a build configured with a chain on another origin (a local server answering CORS
 *   like the Stagenet endpoints): the sync reads it cross-origin under COEP with no violation, and the requests are the
 *   site's and that origin's only.
 * - `[[browser.csp.meta]]` — served with no headers: the page's meta policy alone; the same boot, replay and API answers
 *   with no violation and only same-origin requests.
 * - `[[browser.csp.enforced]]` — the policy is enforced, in both forms: an inline script without a hash does not run;
 *   `eval` and `new Function` are refused in the page (and, under the header policy, in a worker) while WebAssembly
 *   compiles; a `fetch` to an origin outside the policy is refused and never reaches it (from the worker too, under the
 *   header policy); a `Worker` from a plain string, another Trusted Types policy and an HTML sink are refused; each
 *   refusal is reported as a violation.
 *
 * `eval` is checked from scripts the site serves (a probe page and worker written into the build folder), because
 * Chrome lets DevTools-evaluated code call `eval` whatever the policy says.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_CSP_REPORT=<file>` writes what each run recorded as JSON (never committed).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeReplay, type TapeReplay } from "../../chain-archive-sync/tape-replay.js";
import type { HostStatus } from "../browser/protocol.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { type LocalServer, parseHeadersFile, serveCounter, serveHandler, serveStaticSite } from "./helpers/static-site.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG = join(ROOT, "token-indexer/browser/vite.config.ts");
const CHAIN_ENV = ["UMBRADB_BROWSER_NETWORK", "UMBRADB_BROWSER_NODE_URL", "UMBRADB_BROWSER_INDEXER_URL"] as const;
const U1 = { from: 715402, to: 715433 } as const;
const MID = U1.from + 15;
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };
const MINT_TX = "173ad3b6344edc42b9468a42e001cff52dc9fb1136a51a9e3c1275ed6a2b3ad7";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The probe page's module: `eval`, `new Function` and a WebAssembly compile in the page, then the same in a worker it
 *  starts through the one allowed Trusted Types policy (the probe page runs no other script), plus two fetches there. */
const PROBE_PAGE = `const outside = new URLSearchParams(location.search).get("outside");
const r = {};
try { (0, eval)("1"); r.eval = "allowed"; } catch (e) { r.eval = e.name; }
try { new Function("return 1"); r.function = "allowed"; } catch (e) { r.function = e.name; }
r.wasm = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => "allowed", (e) => e.name);
const policy = trustedTypes.createPolicy("umbradb-engine-worker", { createScriptURL: (u) => u });
const worker = new Worker(policy.createScriptURL(new URL("./probe-worker.js", import.meta.url).href), { type: "module" });
r.worker = await new Promise((resolve) => {
  worker.onmessage = (e) => resolve(e.data);
  worker.onerror = (e) => resolve({ error: e.message || "worker error" });
  worker.postMessage({ outside });
});
window.__probe = r;
`;

const PROBE_WORKER = `const violations = [];
self.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective + " " + e.blockedURI));
self.onmessage = async (event) => {
  const r = { crossOriginIsolated: self.crossOriginIsolated };
  try { (0, eval)("1"); r.eval = "allowed"; } catch (e) { r.eval = e.name; }
  try { new Function("return 1"); r.function = "allowed"; } catch (e) { r.function = e.name; }
  r.wasm = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => "allowed", (e) => e.name);
  r.fetchOutside = await fetch(event.data.outside + "/from-worker").then((x) => "status " + x.status, (e) => e.name);
  r.fetchSelf = await fetch(new URL("../engine.html", import.meta.url)).then((x) => "status " + x.status, (e) => e.name);
  await new Promise((resolve) => setTimeout(resolve, 100));
  r.violations = violations;
  self.postMessage(r);
};
`;

/** The chain's two endpoints answered from a tape at `/chain/rpc` and `/chain/graphql`, with CORS as Stagenet answers it. */
function serveChain(chain: TapeReplay): Promise<LocalServer> {
  const cors = { "access-control-allow-origin": "*" };
  return serveHandler((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }).end();
      return;
    }
    if (!url.pathname.startsWith("/chain/")) {
      res.writeHead(404, cors).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void chain.answer(url.pathname.slice("/chain".length), Buffer.concat(chunks).toString("utf8")).then((a) => {
        res.writeHead(a.status, { ...a.headers, ...cors });
        res.end(a.body);
      });
    });
  });
}

/** Builds with Vite into a new temporary folder, with the chain environment given (and no other). */
async function buildSite(env: Partial<Record<(typeof CHAIN_ENV)[number], string>>): Promise<string> {
  const { build } = await import("vite");
  const out = mkdtempSync(join(tmpdir(), "umbradb-csp-site-"));
  const saved = CHAIN_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of CHAIN_ENV) delete process.env[k];
  Object.assign(process.env, env);
  try {
    await build({ configFile: CONFIG, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  } finally {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  // Test-only pages beside the build: engine.html without its module script, plus an inline script (no hash) or the probe.
  const engine = readFileSync(join(out, "engine.html"), "utf8");
  const moduleScript = /<script type="module" crossorigin src="\.\/assets\/engine-[^"]+"><\/script>/;
  if (!moduleScript.test(engine)) throw new Error("engine.html has no module script to replace");
  writeFileSync(join(out, "tampered.html"), engine.replace(moduleScript, "<script>window.__inlineRan = true;</script>"));
  writeFileSync(join(out, "probe.html"), engine.replace(moduleScript, '<script type="module" src="./probe/probe.js"></script>'));
  mkdirSync(join(out, "probe"));
  writeFileSync(join(out, "probe/probe.js"), PROBE_PAGE);
  writeFileSync(join(out, "probe/probe-worker.js"), PROBE_WORKER);
  return out;
}

const browserExe = findBrowser();

describe("the static build under its Content-Security-Policy in Chrome", () => {
  const temps: string[] = [];
  const servers: LocalServer[] = [];
  let browser: Browser;
  let chain: TapeReplay;
  let chainServer: LocalServer;
  let outside: LocalServer;
  let sites: { headers: LocalServer; meta: LocalServer; chain: LocalServer };
  /** The default build, served by the `headers` and `meta` sites. */
  let plain: string;
  const pages = new Map<string, Page>();
  const report: Record<string, Json> = {};

  /** One page per site (each site is its own origin, hence its own OPFS store), recording its workers. */
  async function pageOf(site: LocalServer): Promise<Page> {
    let page = pages.get(site.origin);
    if (page === undefined) {
      page = await browser.newPage({ workers: true });
      pages.set(site.origin, page);
    }
    return page;
  }

  const engine = (page: Page, expr: string): Promise<Json> => page.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
  async function until(page: Page, what: string, ok: (s: HostStatus) => boolean, timeoutMs = 120_000): Promise<HostStatus> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = (await engine(page, "c.status()")) as HostStatus;
      if (ok(s)) return s;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ boot: s.boot.phase, cursors: s.cursors, engine: s.engine?.status })}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async function api(page: Page, target: string): Promise<{ status: number; body: Json }> {
    const r = (await engine(page, `c.api("GET", ${JSON.stringify(target)})`)) as { status: number; body: string };
    return { status: r.status, body: JSON.parse(r.body) };
  }
  /** Opens the engine page and waits for the worker's boot to end. */
  async function openEngine(site: LocalServer): Promise<Page> {
    const page = await pageOf(site);
    await page.goto(`${site.origin}/engine.html`);
    await page.waitFor("window.umbradbEngine !== undefined", 30_000, "the engine page");
    const boot = (await page.eval("window.umbradbEngine.client.booted()")) as { phase: string; error: string | null };
    expect(boot, JSON.stringify(boot)).toMatchObject({ phase: "ready", error: null });
    return page;
  }
  /** Where the page and its workers went since `from` (request records), and what they reported. */
  function seen(page: Page, from: { requests: number; logs: number }) {
    const requests = page.requests.slice(from.requests);
    const logs = page.logs.slice(from.logs);
    return { requests, logs, security: logs.filter((l) => l.source === "security"), problems: logs.filter((l) => (l.level === "error" || l.level === "warning") && !(l.source === "network" && /\/favicon\.ico$/.test(l.url ?? ""))) };
  }
  const mark = (page: Page) => ({ requests: page.requests.length, logs: page.logs.length });
  const origins = (requests: Array<{ url: string }>): string[] => [...new Set(requests.map((r) => new URL(r.url).origin))].sort();

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    chain = createTapeReplay(await readTape(new Uint8Array(readFileSync(join(ROOT, "token-indexer/browser/tapes/stagenet-715402-715433.tape.json.gz"))), "gzip"));
    chainServer = await serveChain(chain);
    outside = await serveCounter();
    servers.push(chainServer, outside);
    plain = await buildSite({});
    const chained = await buildSite({ UMBRADB_BROWSER_NODE_URL: `${chainServer.origin}/chain/rpc`, UMBRADB_BROWSER_INDEXER_URL: `${chainServer.origin}/chain/graphql` });
    temps.push(plain, chained);
    const rules = (dir: string) => parseHeadersFile(readFileSync(join(dir, "_headers"), "utf8"));
    sites = {
      headers: await serveStaticSite(plain, { headers: rules(plain) }),
      meta: await serveStaticSite(plain),
      chain: await serveStaticSite(chained, { headers: rules(chained) }),
    };
    servers.push(sites.headers, sites.meta, sites.chain);
    browser = await Browser.launch(browserExe);
    report.browser = await browser.version();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    for (const s of servers) await s.close();
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    if (process.env.UMBRADB_CSP_REPORT) writeFileSync(process.env.UMBRADB_CSP_REPORT, JSON.stringify(report, null, 2));
  });

  it("[[browser.csp.headers]] with the _headers rules: page and worker are cross-origin isolated; the worker boots on OPFS, replays and scans a recorded range and answers API requests with no CSP violation in the page or the worker, and every request stays on the site's origin; a second tab follows through the leader with the same answers and no violation", async () => {
    const page = await pageOf(sites.headers);
    const from = mark(page);
    await openEngine(sites.headers);
    expect(await page.eval("self.crossOriginIsolated")).toBe(true);
    expect(await page.evalWorker("self.crossOriginIsolated")).toBe(true);

    await engine(page, `c.start(${JSON.stringify({ source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.to, ...FAST })})`);
    const done = await until(page, "the replayed range", (s) => s.engine?.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === U1.to + 1);
    expect(done.cursors).toMatchObject({ sync: { height: U1.to, startHeight: U1.from }, scan: { fromHeight: U1.from, nextHeight: U1.to + 1 } });
    expect((await api(page, "/v1/status")).body).toMatchObject({ network: "stagenet", startHeight: U1.from, indexedHeight: U1.to, durability: "non-durable" });
    const tokens = await api(page, "/v1/tokens");
    expect(tokens.status).toBe(200);
    expect((tokens.body.items as Json[]).map((t) => t.minted?.firstMint?.txHash).filter(Boolean)).toContain(MINT_TX);
    await engine(page, "c.stop()");

    // A second tab of the same profile follows: its requests reach the leader's engine over BroadcastChannel.
    const follower = await browser.newPage({ workers: true });
    await follower.goto(`${sites.headers.origin}/engine.html`);
    await follower.waitFor("window.umbradbEngine !== undefined", 30_000, "the second tab");
    expect(await follower.eval("window.umbradbEngine.tabs.ready")).toBe("follower");
    expect(await follower.eval("self.crossOriginIsolated")).toBe(true);
    expect(await engine(follower, `c.api("GET", "/v1/tokens").then((r) => JSON.parse(r.body))`)).toEqual(tokens.body);
    expect(follower.workers).toEqual([]);
    expect(await follower.eval("window.__cspViolations")).toEqual([]);
    expect(follower.exceptions).toEqual([]);
    expect(seen(follower, { requests: 0, logs: 0 }).security).toEqual([]);
    expect(origins(follower.requests)).toEqual([sites.headers.origin]);
    await follower.close();

    expect(await page.eval("window.__cspViolations")).toEqual([]);
    expect(await page.evalWorker("self.__cspViolations")).toEqual([]);
    const s = seen(page, from);
    expect(s.security).toEqual([]);
    expect(s.problems).toEqual([]);
    expect(page.exceptions).toEqual([]);
    expect(origins(s.requests)).toEqual([sites.headers.origin]);
    for (const r of s.requests) {
      expect(r.blockedReason, r.url).toBeUndefined();
      expect(r.failed, r.url).toBeUndefined();
      expect(r.method, r.url).toBe("GET");
    }
    const workerPaths = s.requests.filter((r) => r.target === "worker").map((r) => new URL(r.url).pathname);
    for (const asset of [/^\/assets\/pglite-.*\.wasm$/, /^\/assets\/initdb-.*\.wasm$/, /^\/assets\/pglite-.*\.data$/, /^\/assets\/midnight_ledger_wasm_v9_bg-.*\.wasm$/, /^\/assets\/stagenet-715402-715433\.tape\.json-.*\.gz$/])
      expect(workerPaths.some((p) => asset.test(p)), String(asset)).toBe(true);
    expect(chainServer.hits.size).toBe(0);
    expect(outside.hits.size).toBe(0);
    report.headers = { origins: origins(s.requests), requests: s.requests.map((r) => `${r.target ?? "page"} ${r.method} ${new URL(r.url).pathname} ${r.status ?? ""}`) };
  }, 240_000);

  it("[[browser.csp.chain-origins]] a build configured with a chain on another origin: the sync reads it cross-origin under COEP with no violation, and the requests are the site's and that origin's only", async () => {
    const page = await pageOf(sites.chain);
    const from = mark(page);
    await openEngine(sites.chain);
    expect(await page.evalWorker("self.crossOriginIsolated")).toBe(true);
    // No endpoints in the start: the worker uses the build's.
    await engine(page, `c.start(${JSON.stringify({ source: { kind: "network" }, startHeight: U1.from, endHeight: U1.to, ...FAST })})`);
    await until(page, "the range over the network", (s) => s.engine?.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === U1.to + 1);
    expect((await api(page, "/v1/tokens")).body.items.map((t: Json) => t.minted?.firstMint?.txHash).filter(Boolean)).toContain(MINT_TX);
    await engine(page, "c.stop()");

    expect(chain.counts.get("chain_getBlock")).toBe(U1.to - U1.from + 1);
    expect(chain.counts.get("indexer.block")).toBe(U1.to - U1.from + 1);
    expect(await page.eval("window.__cspViolations")).toEqual([]);
    expect(await page.evalWorker("self.__cspViolations")).toEqual([]);
    const s = seen(page, from);
    expect(s.security).toEqual([]);
    expect(s.problems).toEqual([]);
    expect(page.exceptions).toEqual([]);
    expect(origins(s.requests)).toEqual([sites.chain.origin, chainServer.origin].sort());
    const toChain = s.requests.filter((r) => r.url.startsWith(`${chainServer.origin}/`));
    expect(toChain.length).toBeGreaterThan(0);
    for (const r of toChain) {
      // The worker's POSTs, and the CORS preflights Chrome sends for them (reported on the page's session).
      if (r.method === "POST") expect(r.target, r.url).toBe("worker");
      else expect(r.method, r.url).toBe("OPTIONS");
      expect(r.status, `${r.method} ${r.url}`).toBe(r.method === "POST" ? 200 : 204);
      expect(new URL(r.url).pathname).toMatch(/^\/chain\/(rpc|graphql)$/);
    }
    for (const r of s.requests) expect(r.blockedReason, r.url).toBeUndefined();
    expect(outside.hits.size).toBe(0);
    report.chain = { origins: origins(s.requests), chainRequests: toChain.length, chainCounts: Object.fromEntries(chain.counts) };
  }, 240_000);

  it("[[browser.csp.meta]] with no headers, the page's meta policy alone: the same boot, replay and API answers with no violation and only same-origin requests", async () => {
    const page = await pageOf(sites.meta);
    const from = mark(page);
    await openEngine(sites.meta);
    expect(await page.eval("self.crossOriginIsolated")).toBe(false);
    await engine(page, `c.start(${JSON.stringify({ source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: MID, ...FAST })})`);
    await until(page, "the replayed part", (s) => s.engine?.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === MID + 1);
    expect((await api(page, "/v1/tokens")).status).toBe(200);
    expect((await api(page, "/v1/status")).body).toMatchObject({ indexedHeight: MID });
    await engine(page, "c.stop()");
    expect(await page.eval("window.__cspViolations")).toEqual([]);
    expect(await page.evalWorker("self.__cspViolations")).toEqual([]);
    const s = seen(page, from);
    expect(s.security).toEqual([]);
    expect(s.problems).toEqual([]);
    expect(page.exceptions).toEqual([]);
    expect(origins(s.requests)).toEqual([sites.meta.origin]);
    for (const r of s.requests) expect(r.blockedReason, r.url).toBeUndefined();
    report.meta = { origins: origins(s.requests) };
  }, 240_000);

  it("[[browser.csp.enforced]] in both forms: an inline script without a hash does not run; eval and new Function are refused in the page (and in a worker under the header policy) while WebAssembly compiles; a fetch outside the policy is refused and never arrives; a Worker from a string, another Trusted Types policy and an HTML sink are refused; each refusal is reported", async () => {
    report.enforced = {};
    for (const mode of ["headers", "meta"] as const) {
      const site = sites[mode];
      const page = await pageOf(site);
      const hitsBefore = outside.hits.size;

      // An inline script that is not in the build (so has no hash) does not run.
      await page.goto(`${site.origin}/tampered.html`);
      await page.waitFor("window.__cspViolations.length > 0", 10_000, "the inline script's report");
      expect(await page.eval("window.__inlineRan === true"), mode).toBe(false);
      const inline = (await page.eval("window.__cspViolations")) as string[];
      expect(inline.length, mode).toBeGreaterThan(0);
      expect(new Set(inline), mode).toEqual(new Set(["script-src-elem inline"]));

      // eval and new Function from the site's own scripts, in the page and in a worker it starts.
      await page.goto(`${site.origin}/probe.html?outside=${encodeURIComponent(outside.origin)}`);
      await page.waitFor("window.__probe !== undefined", 30_000, "the probe");
      const probe = (await page.eval("window.__probe")) as Json;
      expect(probe, mode).toMatchObject({ eval: "EvalError", function: "EvalError", wasm: "allowed" });
      expect(probe.worker.error, mode).toBeUndefined();
      const pageReports = (await page.eval("window.__cspViolations")) as string[];
      // A string compiled as code is a Trusted Types sink with no policy for it, refused before `script-src` is consulted.
      expect(new Set(pageReports), mode).toEqual(new Set(["require-trusted-types-for trusted-types-sink"]));
      if (mode === "headers") {
        expect(probe.worker, mode).toMatchObject({ crossOriginIsolated: true, eval: "EvalError", function: "EvalError", wasm: "allowed", fetchOutside: "TypeError", fetchSelf: "status 200" });
        expect(new Set(probe.worker.violations)).toEqual(new Set(["require-trusted-types-for trusted-types-sink", `connect-src ${outside.origin}/from-worker`]));
      }
      report.enforced[mode] = { inline, probe, pageReports };

      // On the engine page: a fetch outside the policy, a Worker from a string, another policy, an HTML sink.
      await openEngine(site);
      const worker = readdirSync(join(plain, "assets")).find((f) => /^worker-.*\.js$/.test(f))!;
      const refused = (await page.eval(`(async () => {
        const r = {};
        r.fetch = await fetch(${JSON.stringify(`${outside.origin}/from-page`)}).then((x) => "status " + x.status, (e) => e.name);
        try { new Worker("./assets/${worker}", { type: "module" }); r.worker = "allowed"; } catch (e) { r.worker = e.name; }
        try { trustedTypes.createPolicy("another", { createScriptURL: (u) => u }); r.policy = "allowed"; } catch (e) { r.policy = e.name; }
        try { document.body.innerHTML = "<b>x</b>"; r.html = "allowed"; } catch (e) { r.html = e.name; }
        await new Promise((resolve) => setTimeout(resolve, 100));
        r.violations = window.__cspViolations;
        return r;
      })()`)) as Json;
      expect(refused, mode).toMatchObject({ fetch: "TypeError", worker: "TypeError", policy: "TypeError", html: "TypeError" });
      expect(new Set(refused.violations), mode).toEqual(new Set([`connect-src ${outside.origin}/from-page`, "require-trusted-types-for trusted-types-sink", "trusted-types trusted-types-policy"]));
      expect(outside.hits.get("GET /from-page"), mode).toBeUndefined();
      if (mode === "headers") {
        // The engine's own worker is under the header policy as well.
        const fromWorker = await page.evalWorker(`fetch(${JSON.stringify(`${outside.origin}/from-engine-worker`)}).then((x) => "status " + x.status, (e) => e.name)`);
        expect(fromWorker).toBe("TypeError");
        await new Promise((r) => setTimeout(r, 100));
        expect(await page.evalWorker("self.__cspViolations")).toEqual([`connect-src ${outside.origin}/from-engine-worker`]);
        expect(outside.hits.size, "nothing reached the outside origin under the header policy").toBe(hitsBefore);
      }
      report.enforced[mode].refused = refused;
      report.enforced[mode].outsideHits = Object.fromEntries(outside.hits);
    }
    // With the meta policy alone the probe worker had no policy (Chrome takes a worker's policy from its script's
    // response); the engine's worker is confined only where the headers are sent. Recorded, not asserted.
    report.metaWorker = report.enforced.meta.probe.worker;
  }, 240_000);
});
