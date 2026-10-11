/**
 * The Chromium tests' own driver (`helpers/cdp-browser.ts`) explains a failure: what a page and its workers did is
 * printed when a test fails, so a failure on another machine (a CI runner's Chrome) can be read from its log.
 *
 * - `[[browser.harness.failure-report]]` — in Chromium, a page whose dedicated worker fails while it runs, and one whose
 *   worker script does not load: each worker `error` event is recorded with its message, file, line and column (and
 *   the page's own scripts see the same worker as before: its class and its error event); the page's diagnostics
 *   hold it, its uncaught exception, its console calls and its workers' (the last lines only, each cut), and the
 *   report a failed test prints is every such page's diagnostics.
 * - `[[browser.harness.load-retry]]` — in Chromium, page loads the machine's network aborted are loaded again, at most
 *   three times, and nothing else is: a stylesheet, a module import (a dev server's `/@fs/…` path) or a later fetch
 *   failed once with an error taken for the network's (here `net::ERR_CONNECTION_ABORTED`, which DevTools can produce,
 *   standing for `net::ERR_NETWORK_CHANGED`) is loaded again once, at once, with one printed line, and dropped from what
 *   the page recorded; failing every time fails after three attempts, with a printed line for each of the two retries;
 *   another error, a missing module (404) or a failed step is not retried, also while the machine's interfaces change;
 *   a worker's script aborted while the machine's interfaces changed (the state injected) is loaded again, and the same
 *   abort with no change is not.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Browser, failureReport, findBrowser, LOAD_ATTEMPTS, type Page, type PageOptions } from "./helpers/cdp-browser.ts";
import { type LocalServer, serveHandler } from "./helpers/static-site.ts";

const browserExe = findBrowser();

const PAGE = `<!doctype html><meta charset="utf-8"><title>harness</title><script>
for (let i = 0; i < 50; i++) console.log("page line " + i);
window.seen = [];
const w = new Worker("/w.js");
window.isWorker = w instanceof Worker && Object.getPrototypeOf(w) === Worker.prototype;
w.addEventListener("error", (e) => window.seen.push(e.message));
const missing = new Worker("/missing.js");
missing.addEventListener("error", () => window.seen.push("missing"));
setTimeout(() => { throw new Error("page boom"); }, 0);
</script>`;
// The worker logs, then throws at line 3, column 9.
const WORKER = `for (let i = 0; i < 40; i++) console.log("worker line " + i);
const x = 1;
throw new Error("worker boom " + x);
`;

// A page that imports a module the way a dev server serves source files, and one whose module is missing.
const MODULE = `<!doctype html><meta charset="utf-8"><title>module</title><script type="module">import { value } from "/@fs/repo/mod.ts"; window.value = value;</script>`;
const MISSING_MODULE = `<!doctype html><meta charset="utf-8"><title>missing</title><script type="module">import "/@fs/repo/missing.ts"; window.value = 1;</script>`;

// A page with a stylesheet, a fetch after it loads and a worker; each sets what it got.
const LOADS = `<!doctype html><meta charset="utf-8"><title>loads</title><link rel="stylesheet" href="/style.css"><script>
window.late = null;
fetch("/late.json").then((r) => r.json()).then((j) => { window.late = j.ok; }, () => { window.late = false; });
window.workerSaid = null;
new Worker("/hello.js").onmessage = (e) => { window.workerSaid = e.data; };
</script>`;

describe("the Chromium tests' driver", () => {
  let site: LocalServer;
  let browser: Browser;

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium: set MIP0018_UI_BROWSER or CHROME_BIN");
    site = await serveHandler((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
      } else if (path === "/loads") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(LOADS);
      } else if (path === "/module" || path === "/missing-module") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(path === "/module" ? MODULE : MISSING_MODULE);
      } else if (path === "/@fs/repo/mod.ts") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("export const value = 7;");
      } else if (path === "/style.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end("body { color: rgb(1, 2, 3); }");
      } else if (path === "/late.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      } else if (path === "/hello.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end('postMessage("hi");');
      } else if (path === "/w.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(WORKER);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });
    browser = await Browser.launch(browserExe);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it("[[browser.harness.failure-report]] a worker's error event is recorded with its message, file, line and column, the page's own scripts see the same worker; a page's diagnostics and the failed-test report hold it with the page's exception and the last console lines of the page and its workers", async () => {
    const page = await browser.newPage({ workers: true });
    await page.goto(`${site.origin}/`);
    await page.waitFor("window.seen.length === 2", 30_000, "both workers' error events");
    const deadline = Date.now() + 10_000;
    while (page.workerErrors.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

    // The page's own listeners and checks see the worker as before.
    expect(await page.eval("window.isWorker")).toBe(true);
    expect(((await page.eval("window.seen")) as string[]).sort()).toEqual(["Uncaught Error: worker boom 1", "missing"].sort());

    const failed = page.workerErrors.find((e) => e.message.includes("worker boom"))!;
    expect(failed).toMatchObject({ message: "Uncaught Error: worker boom 1", file: `${site.origin}/w.js`, line: 3, column: 7, worker: "/w.js" });
    expect(page.workerErrors.find((e) => e.worker === "/missing.js")).toMatchObject({ message: "" });

    const text = page.diagnostics();
    expect(text).toContain(`page ${page.targetId.slice(0, 8)} at ${site.origin}/`);
    expect(text).toContain(`Uncaught Error: worker boom 1 at ${site.origin}/w.js:3:7`);
    expect(text).toContain("(no message: the script did not load or did not start) at /missing.js:0:0");
    expect(text).toContain("Error: page boom");
    // The page's 50 console lines, then its worker's 40: the last 30 of the 90 are shown.
    expect(text).toContain("console (90, the last 30):");
    expect(text).toContain("[worker] log: worker line 10\n");
    expect(text).toContain("[worker] log: worker line 39\n");
    expect(text).not.toContain("worker line 9\n");
    expect(text).not.toContain("page line");
    expect(failureReport([page])).toBe(text);
    expect(page.ended).toBe(false);
    await page.close();
    expect(page.diagnostics()).toContain("(closed)");
  }, 120_000);

  /** A page whose requests matching `path` fail with `reason` the first `times` times (`Infinity`: always); `onFail` is
   *  called at each failure. */
  async function failingPage(path: string, times: number, reason: string, opts: PageOptions = {}, onFail: () => void = () => {}): Promise<{ page: Page; failed: () => number }> {
    const page = await browser.newPage(opts);
    let failed = 0;
    page.onEvent("Fetch.requestPaused", (p: { requestId: string; request: { url: string } }) => {
      if (new URL(p.request.url).pathname === path && failed < times) {
        failed++;
        onFail();
        void page.send("Fetch.failRequest", { requestId: p.requestId, errorReason: reason });
      } else void page.send("Fetch.continueRequest", { requestId: p.requestId });
    });
    await page.send("Fetch.enable", { patterns: [{ urlPattern: `*${path}*` }] });
    return { page, failed: () => failed };
  }

  it("[[browser.harness.load-retry]] loads the machine's network aborted are loaded again (at most three times, one printed line each, the aborted attempt dropped); a load that fails every time fails after three attempts; another error, a missing module, a failed step, or an aborted worker script with no network change, is not retried; a worker script aborted while the interfaces changed is", async () => {
    const printed = vi.spyOn(console, "error");
    /** The lines printed for retries of `page`. */
    const retryLines = (page: Page): string[] =>
      printed.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`browser page ${page.targetId.slice(0, 8)} `) && l.includes("loading it again"));
    const aborted = { environmentalErrors: ["net::ERR_CONNECTION_ABORTED"] };
    try {
      // A stylesheet aborted once: loaded again at once; the second attempt's page is what the test sees.
      const css = await failingPage("/style.css", 1, "ConnectionAborted", aborted);
      await css.page.goto(`${site.origin}/loads`);
      expect(css.failed()).toBe(1);
      expect(css.page.loadRetries).toEqual([{ url: `${site.origin}/loads`, reason: expect.stringContaining("1 load failed with net::ERR_CONNECTION_ABORTED") }]);
      expect(await css.page.eval("getComputedStyle(document.body).color")).toBe("rgb(1, 2, 3)");
      expect(css.page.requests.filter((r) => r.failed !== undefined)).toEqual([]);
      expect(retryLines(css.page)).toEqual([expect.stringMatching(/: 1 load failed with net::ERR_CONNECTION_ABORTED \(.*\/style\.css\): loading it again \(attempt 2 of 3, /u)]);
      expect(css.page.diagnostics()).toContain("loaded again (1):");
      await css.page.close();

      // A module import (a dev server's source file) aborted once: the page is loaded again and the module runs.
      const mod = await failingPage("/@fs/repo/mod.ts", 1, "ConnectionAborted", aborted);
      await mod.page.goto(`${site.origin}/module`, 30_000, () => mod.page.waitFor("window.value === 7", 10_000, "the module"));
      expect(mod.failed()).toBe(1);
      expect(mod.page.loadRetries).toEqual([{ url: `${site.origin}/module`, reason: expect.stringContaining("/@fs/repo/mod.ts") }]);
      expect(retryLines(mod.page)).toHaveLength(1);
      await mod.page.close();

      // A missing module (404) is the page's: not retried, the step fails.
      const missing = await browser.newPage(aborted);
      await expect(missing.goto(`${site.origin}/missing-module`, 30_000, () => missing.waitFor("window.value === 1", 2_000, "the module")))
        .rejects.toThrow("timed out waiting for the module");
      expect(missing.loadRetries).toEqual([]);
      expect(missing.requests.find((r) => r.url.endsWith("/@fs/repo/missing.ts"))).toMatchObject({ status: 404 });
      await missing.close();

      // A fetch after the load aborted once: the ready step is left as soon as the abort is seen, not at its timeout.
      const late = await failingPage("/late.json", 1, "ConnectionAborted", aborted);
      const t0 = Date.now();
      await late.page.goto(`${site.origin}/loads`, 30_000, () => late.page.waitFor("window.late === true", 30_000, "the late load"));
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(late.page.loadRetries).toHaveLength(1);
      await late.page.close();

      // Aborted every time: three attempts, then the load fails.
      const always = await failingPage("/late.json", Number.POSITIVE_INFINITY, "ConnectionAborted", aborted);
      await expect(always.page.goto(`${site.origin}/loads`, 30_000, () => always.page.waitFor("window.late === true", 30_000, "the late load")))
        .rejects.toThrow(new RegExp(`load failed with net::ERR_CONNECTION_ABORTED .*in each of ${LOAD_ATTEMPTS} attempts`, "u"));
      expect(always.failed()).toBe(LOAD_ATTEMPTS);
      expect(retryLines(always.page).map((l) => /attempt (\d) of 3/u.exec(l)![1])).toEqual(["2", "3"]);
      await always.page.close();

      // Another error is the page's: not retried, the ready step's own failure is the result.
      const refused = await failingPage("/late.json", 1, "ConnectionRefused", aborted);
      await expect(refused.page.goto(`${site.origin}/loads`, 30_000, () => refused.page.waitFor("window.late === true", 2_000, "the late load")))
        .rejects.toThrow("timed out waiting for the late load");
      expect(refused.page.loadRetries).toEqual([]);
      expect(retryLines(refused.page)).toEqual([]);
      await refused.page.close();

      // A failed step while the machine's interfaces change, with no load failed: the page's, not retried.
      let moving = "eth0=10.0.0.2";
      const stepFails = await browser.newPage({ networkState: () => moving });
      const timer = setTimeout(() => { moving = "eth0=10.0.0.2;br-test=10.97.0.1"; }, 300);
      await expect(stepFails.goto(`${site.origin}/loads`, 30_000, () => stepFails.waitFor("window.never === true", 2_000, "the step")))
        .rejects.toThrow("timed out waiting for the step");
      clearTimeout(timer);
      expect(moving).toContain("br-test");
      expect(stepFails.loadRetries).toEqual([]);
      await stepFails.close();

      // A worker's script aborted (Chrome reports net::ERR_ABORTED for it) while the machine's interfaces changed: the
      // network's; the same abort with no change: the page's.
      let state = "eth0=10.0.0.2";
      const changing = await failingPage("/hello.js", 1, "Aborted", { networkState: () => state }, () => { state = "eth0=10.0.0.2;br-test=10.97.0.1"; });
      await changing.page.goto(`${site.origin}/loads`, 30_000, () => changing.page.waitFor("window.workerSaid === 'hi'", 10_000, "the worker"));
      expect(changing.page.loadRetries).toEqual([{ url: `${site.origin}/loads`, reason: expect.stringContaining("the machine's network interfaces changed while it loaded and 1 worker script failed with net::ERR_ABORTED") }]);
      expect(retryLines(changing.page)).toHaveLength(1);
      await changing.page.close();
      const still = await failingPage("/hello.js", 1, "Aborted", { networkState: () => "eth0=10.0.0.2" });
      await expect(still.page.goto(`${site.origin}/loads`, 30_000, () => still.page.waitFor("window.workerSaid === 'hi'", 2_000, "the worker")))
        .rejects.toThrow("timed out waiting for the worker");
      expect(still.page.loadRetries).toEqual([]);
      await still.page.close();
    } finally {
      printed.mockRestore();
    }
  }, 180_000);
});
