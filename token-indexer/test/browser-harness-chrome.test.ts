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
 *   abort with no change is not. The driver's own list of the network's errors is `net::ERR_NETWORK_CHANGED` alone: with
 *   it, the refused fetch and the missing module are not retried either, nor is a stylesheet failed with
 *   `net::ERR_CONNECTION_ABORTED`, `net::ERR_CONNECTION_REFUSED`, `net::ERR_FAILED` or `net::ERR_ABORTED` while the
 *   interfaces change.
 * - `[[browser.harness.load-retry-independent]]` — an aborted load never hides a failure of the page's own: the ready
 *   step always runs and a step that fails is never loaded again — a boot that fails with an exception of the
 *   application, with a running worker's error, or that only reports it ended "failed" (no exception, no worker error),
 *   while a stylesheet is aborted fails the load with the step's error and one printed line, the attempt's exceptions,
 *   worker errors and boot state kept in what the page recorded; a polling step still waiting after its wait goes on
 *   watching the page while the network settles: a boot that reports "failed" then fails the load with the step's error
 *   (not loaded again), and a boot that reports "ready" then stands (not loaded again), but a step that returns once
 *   its signal is set has not seen the page ready (loaded again), and a boot that reports "ready" then after an
 *   exception of its own fails with the exception (not loaded again); a failure of the page's own that comes while the
 *   network settles stops the reload too, and so do the late step's own failure when a question it asked before answers
 *   then (a boot that ended "failed"), an error on the console of a first boot whose step is still waiting, and a load
 *   that never ends (its load event never comes); a boot that succeeds although a stylesheet was aborted stands, not
 *   loaded again; an exception that names the aborted load (a dynamic import of it) is the abort's: loaded again, and
 *   what the aborted attempt recorded is kept in the page's report and counted in the printed line; an image aborted is
 *   no reason to load again; a step still waiting when the network has settled gets its abort signal and stops (its
 *   DevTools commands fail) before the page is loaded again, so its action runs once, on the attempt that is kept.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Browser, ENVIRONMENTAL_LOAD_ERRORS, failureReport, findBrowser, LOAD_ATTEMPTS, type Page, type PageOptions, READY_SETTLE_MS } from "./helpers/cdp-browser.ts";
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

// Pages whose first load boots badly (each answered once so, then well): an exception of the application, a running
// worker's error; and a page whose dynamic import, when it fails, is an exception naming the import.
const BOOT_FAILS = `<!doctype html><meta charset="utf-8"><title>boot</title><link rel="stylesheet" href="/style-b.css"><script>
window.booted = "failed"; setTimeout(() => { throw new Error("the application's boot failed"); }, 0);
</script>`;
const WORKER_FAILS = `<!doctype html><meta charset="utf-8"><title>boot</title><link rel="stylesheet" href="/style-b.css"><script>
window.booted = "failed"; new Worker("/w.js");
</script>`;
// A boot that fails and says so, as the engine's host does (its state "failed"), with no exception.
const BOOT_REPORTS_FAILURE = `<!doctype html><meta charset="utf-8"><title>boot</title><link rel="stylesheet" href="/style-b.css"><script>
window.booted = "failed";
</script>`;
// A page that fetches at once and fails on its own 2.5 s later (first answer only; then it boots well).
const LATE_FAILURE = `<!doctype html><meta charset="utf-8"><title>late</title><script>
fetch("/late.json").catch(() => {});
setTimeout(() => { throw new Error("a later failure of the page"); }, 2_500);
</script>`;
// A first boot that only says it failed on the console; a page whose image never answers (its load event never comes).
const CONSOLE_FAILURE = `<!doctype html><meta charset="utf-8"><title>console</title><link rel="stylesheet" href="/style-b.css"><script>
console.error("the first boot failed quietly");
</script>`;
const HANGS = `<!doctype html><meta charset="utf-8"><title>hangs</title><link rel="stylesheet" href="/style-b.css"><img src="/hang.svg"><script>window.booted = "ready";</script>`;
// A boot whose result comes 2.2 s after the page runs: "failed" on the first answer (then it boots well).
const LATE_BOOT = `<!doctype html><meta charset="utf-8"><title>late boot</title><link rel="stylesheet" href="/style-b.css"><script>
window.lateBoot = new Promise((resolve) => setTimeout(() => resolve("failed"), 2_200));
</script>`;
// Boots that report their result on the page 2.5 s after it runs (as the engine's host sets its state), on the first
// answer: "failed", and "ready" (then they boot well).
const LATE_REPORT = `<!doctype html><meta charset="utf-8"><title>late report</title><link rel="stylesheet" href="/style-b.css"><script>
setTimeout(() => { window.booted = "failed"; }, 2_500);
</script>`;
const LATE_READY = `<!doctype html><meta charset="utf-8"><title>late ready</title><link rel="stylesheet" href="/style-b.css"><script>
setTimeout(() => { window.booted = "ready"; }, 2_500);
</script>`;
// A first boot that never ends (then it boots well).
const NEVER_READY = `<!doctype html><meta charset="utf-8"><title>never ready</title><link rel="stylesheet" href="/style-b.css">`;
// A first boot that throws an exception of its own at 2 s and reports "ready" at 3 s (then it boots well).
const ERROR_THEN_READY = `<!doctype html><meta charset="utf-8"><title>error then ready</title><link rel="stylesheet" href="/style-b.css"><script>
setTimeout(() => { throw new Error("an unrelated failure of the page"); }, 2_000);
setTimeout(() => { window.booted = "ready"; }, 3_000);
</script>`;
const BOOT_WELL = `<!doctype html><meta charset="utf-8"><title>boot</title><link rel="stylesheet" href="/style-b.css"><script>window.booted = "ready"; window.lateBoot = "ready";</script>`;
// A page whose fetch starts 300 ms after it loads, and one with an image.
const DELAYED = `<!doctype html><meta charset="utf-8"><title>delayed</title><script>
window.late = null;
setTimeout(() => fetch("/late.json").then((r) => r.json()).then((j) => { window.late = j.ok; }, () => { window.late = false; }), 300);
</script>`;
const PICTURE = `<!doctype html><meta charset="utf-8"><title>picture</title><img src="/pic.svg"><script>window.booted = "ready";</script>`;
const DYNAMIC = `<!doctype html><meta charset="utf-8"><title>dynamic</title><script type="module">window.value = (await import("/@fs/repo/dyn.ts")).value;</script>`;

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
  const answered = new Map<string, number>();

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
      } else if (["/boot-fails", "/worker-fails", "/boot-reports-failure", "/boot-well", "/late-failure", "/console-failure", "/hangs", "/late-boot", "/late-report", "/late-ready", "/never-ready", "/error-then-ready"].includes(path)) {
        const n = (answered.get(path) ?? 0) + 1;
        answered.set(path, n);
        const first: Record<string, string> = {
          "/boot-fails": BOOT_FAILS, "/worker-fails": WORKER_FAILS, "/boot-reports-failure": BOOT_REPORTS_FAILURE, "/late-failure": LATE_FAILURE,
          "/console-failure": CONSOLE_FAILURE, "/hangs": HANGS, "/late-boot": LATE_BOOT, "/late-report": LATE_REPORT, "/late-ready": LATE_READY,
          "/never-ready": NEVER_READY, "/error-then-ready": ERROR_THEN_READY,
        };
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(n > 1 || path === "/boot-well" ? BOOT_WELL : first[path]!);
      } else if (path === "/delayed" || path === "/picture") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(path === "/delayed" ? DELAYED : PICTURE);
      } else if (path === "/pic.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      } else if (path === "/dynamic") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DYNAMIC);
      } else if (path === "/style-b.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end("body { color: rgb(4, 5, 6); }");
      } else if (path === "/@fs/repo/dyn.ts") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("export const value = 8;");
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

  it("[[browser.harness.load-retry]] loads the machine's network aborted are loaded again (at most three times, one printed line each, the aborted attempt dropped); a load that fails every time fails after three attempts; another error, a missing module, a failed step, or an aborted worker script with no network change, is not retried; a worker script aborted while the interfaces changed is; the driver's own list is the network's error alone", async () => {
    const printed = vi.spyOn(console, "error");
    /** The lines printed for retries of `page`. */
    const retryLines = (page: Page): string[] =>
      printed.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`browser page ${page.targetId.slice(0, 8)} `) && l.includes("loading it again"));
    // The network's error as DevTools can produce it, and a short wait for a step once its attempt is seen aborted.
    const aborted = { environmentalErrors: ["net::ERR_CONNECTION_ABORTED"], readySettleMs: 2_000 };
    try {
      // A stylesheet aborted once: loaded again at once; the second attempt's page is what the test sees.
      const css = await failingPage("/style.css", 1, "ConnectionAborted", aborted);
      await css.page.goto(`${site.origin}/loads`);
      expect(css.failed()).toBe(1);
      expect(css.page.loadRetries).toEqual([{ url: `${site.origin}/loads`, reason: expect.stringContaining("1 load failed with net::ERR_CONNECTION_ABORTED"), dropped: expect.any(Array) }]);
      expect(await css.page.eval("getComputedStyle(document.body).color")).toBe("rgb(1, 2, 3)");
      expect(css.page.requests.filter((r) => r.failed !== undefined)).toEqual([]);
      expect(retryLines(css.page)).toEqual([expect.stringMatching(/: 1 load failed with net::ERR_CONNECTION_ABORTED \(.*\/style\.css\): loading it again \(attempt 2 of 3, /u)]);
      expect(css.page.diagnostics()).toContain("loaded again (1):");
      await css.page.close();

      // A module import (a dev server's source file) aborted once: the page is loaded again and the module runs.
      const mod = await failingPage("/@fs/repo/mod.ts", 1, "ConnectionAborted", aborted);
      await mod.page.goto(`${site.origin}/module`, 30_000, () => mod.page.waitFor("window.value === 7", 10_000, "the module"));
      expect(mod.failed()).toBe(1);
      expect(mod.page.loadRetries).toEqual([{ url: `${site.origin}/module`, reason: expect.stringContaining("/@fs/repo/mod.ts"), dropped: expect.any(Array) }]);
      expect(retryLines(mod.page)).toHaveLength(1);
      await mod.page.close();

      // A missing module (404) is the page's: not retried, the step fails.
      for (const options of [aborted, {}]) {
        const missing = await browser.newPage(options);
        await expect(missing.goto(`${site.origin}/missing-module`, 30_000, () => missing.waitFor("window.value === 1", 2_000, "the module")))
          .rejects.toThrow("timed out waiting for the module");
        expect(missing.loadRetries).toEqual([]);
        expect(missing.requests.find((r) => r.url.endsWith("/@fs/repo/missing.ts"))).toMatchObject({ status: 404 });
        await missing.close();
      }

      // A fetch after the load aborted once: the ready step, still waiting for it, is left the short wait after the abort
      // is seen, not at its own timeout.
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
      for (const options of [aborted, {}]) {
        const refused = await failingPage("/late.json", 1, "ConnectionRefused", options);
        await expect(refused.page.goto(`${site.origin}/loads`, 30_000, () => refused.page.waitFor("window.late === true", 2_000, "the late load")))
          .rejects.toThrow("timed out waiting for the late load");
        expect(refused.page.loadRetries).toEqual([]);
        expect(retryLines(refused.page)).toEqual([]);
        await refused.page.close();
      }

      // The tests' own list: the network's error only. With it, a stylesheet that fails with any other error — the one
      // the cases above take for the network's among them, a cancelled load (net::ERR_ABORTED: only a worker's script
      // is the network's with it, while the interfaces change), even while the interfaces change — is not loaded again.
      expect(ENVIRONMENTAL_LOAD_ERRORS).toEqual(["net::ERR_NETWORK_CHANGED"]);
      // And a step has fifteen seconds once its attempt is seen aborted: less than the steps' own waits (30 s and more).
      expect(READY_SETTLE_MS).toBe(15_000);
      for (const [reason, error] of [["ConnectionAborted", "net::ERR_CONNECTION_ABORTED"], ["ConnectionRefused", "net::ERR_CONNECTION_REFUSED"], ["Failed", "net::ERR_FAILED"], ["Aborted", "net::ERR_ABORTED"]] as const) {
        let state = "eth0=10.0.0.2";
        const other = await failingPage("/style.css", 1, reason, { networkState: () => state }, () => { state = "eth0=10.0.0.2;br-test=10.97.0.1"; });
        await other.page.goto(`${site.origin}/loads`, 30_000, () => other.page.waitFor("window.workerSaid === 'hi'", 10_000, "the worker"));
        expect(other.failed(), reason).toBe(1);
        expect(state).toContain("br-test");
        expect(other.page.requests.find((r) => r.url.endsWith("/style.css"))?.failed, reason).toBe(error);
        expect(other.page.loadRetries, reason).toEqual([]);
        expect(retryLines(other.page), reason).toEqual([]);
        await other.page.close();
      }

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
      const changing = await failingPage("/hello.js", 1, "Aborted", { networkState: () => state, readySettleMs: 2_000 }, () => { state = "eth0=10.0.0.2;br-test=10.97.0.1"; });
      await changing.page.goto(`${site.origin}/loads`, 30_000, () => changing.page.waitFor("window.workerSaid === 'hi'", 10_000, "the worker"));
      expect(changing.page.loadRetries).toEqual([{ url: `${site.origin}/loads`, reason: expect.stringContaining("the machine's network interfaces changed while it loaded and 1 worker script failed with net::ERR_ABORTED"), dropped: expect.any(Array) }]);
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

  it("[[browser.harness.load-retry-independent]] an aborted load never hides a failure of the page's own: the ready step always runs and a step that fails is never loaded again — a boot that fails with an application exception, with a running worker's error, or that only reports it failed, while a stylesheet is aborted, keeps what the attempt recorded; a polling step still waiting after its wait watches the page while the network settles: a boot that reports failed then is not loaded again, one that reports ready then stands, a step returning once its signal is set is loaded again, a late ready after an exception of the page's own fails; a failure of the page's own while the network settles stops the reload too, as do the late step's own failure, an error on the console and a load that never ends; a boot that succeeds stands; an exception naming the aborted load is the abort's: loaded again when the step cannot end, the aborted attempt kept in the report and counted in the printed line; an aborted image is no reason to load again; a step still waiting when the network has settled gets its abort signal and stops before the page is loaded again", async () => {
    const printed = vi.spyOn(console, "error");
    const lines = (page: Page): string[] =>
      printed.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`browser page ${page.targetId.slice(0, 8)} `) && /loading it again|not loaded again/u.test(l));
    // The network's error as DevTools can produce it, and a short wait for a step once its attempt is seen aborted.
    const aborted = { environmentalErrors: ["net::ERR_CONNECTION_ABORTED"], readySettleMs: 2_000 };
    /** The boot check of these pages: booted, and booted well. */
    const bootedWell = (page: Page) => async (): Promise<void> => {
      await page.waitFor("window.booted !== undefined", 10_000, "the boot");
      const booted = await page.eval<string>("window.booted");
      if (booted !== "ready") throw new Error(`the boot ended ${booted}`);
    };
    try {
      for (const [path, own] of [["/boot-fails", "the application's boot failed"], ["/worker-fails", "worker boom 1"]] as const) {
        answered.delete(path);
        const { page, failed } = await failingPage("/style-b.css", 1, "ConnectionAborted", aborted);
        await expect(page.goto(`${site.origin}${path}`, 30_000, bootedWell(page))).rejects.toThrow("the boot ended failed");
        expect(failed()).toBe(1);
        expect(answered.get(path)).toBe(1);
        expect(page.loadRetries).toEqual([]);
        expect([...page.exceptions, ...page.workerErrors.map((e) => e.message)].join("\n")).toContain(own);
        expect(await page.eval("window.booted")).toBe("failed");
        expect(page.diagnostics()).toContain(own);
        expect(lines(page)).toEqual([expect.stringMatching(/1 load failed with net::ERR_CONNECTION_ABORTED .*style-b\.css.*: not loaded again/u)]);
        await page.close();
      }

      // A boot that reports its failure without throwing (no exception, no worker error) while a stylesheet is aborted:
      // the step sees the failure, the attempt's own — not loaded again, although the next boot would succeed.
      answered.delete("/boot-reports-failure");
      const handled = await failingPage("/style-b.css", 1, "ConnectionAborted", aborted);
      await expect(handled.page.goto(`${site.origin}/boot-reports-failure`, 30_000, bootedWell(handled.page))).rejects.toThrow("the boot ended failed");
      expect(handled.failed()).toBe(1);
      expect(answered.get("/boot-reports-failure")).toBe(1);
      expect(handled.page.loadRetries).toEqual([]);
      expect([handled.page.exceptions, handled.page.workerErrors]).toEqual([[], []]);
      expect(lines(handled.page)).toEqual([expect.stringMatching(/1 load failed with net::ERR_CONNECTION_ABORTED .*style-b\.css.*: not loaded again/u)]);
      await handled.page.close();

      // The same report 2.5 s after the page runs: after the step's 1 s wait, while the network settles. The step, still
      // polling, sees it: a failed step, not loaded again (the next load would boot well).
      answered.delete("/late-report");
      const lateReport = await failingPage("/style-b.css", 1, "ConnectionAborted", { ...aborted, readySettleMs: 1_000 });
      await expect(lateReport.page.goto(`${site.origin}/late-report`, 30_000, bootedWell(lateReport.page))).rejects.toThrow("the boot ended failed");
      expect(lateReport.failed()).toBe(1);
      expect(answered.get("/late-report")).toBe(1);
      expect(lateReport.page.loadRetries).toEqual([]);
      expect(await lateReport.page.eval("window.booted")).toBe("failed");
      expect(lines(lateReport.page)).toEqual([expect.stringMatching(/1 load failed with net::ERR_CONNECTION_ABORTED .*style-b\.css.*the step failed late: the boot ended failed.*not loaded again/u)]);
      await lateReport.page.close();

      // A boot that reports "ready" 2.5 s after the page runs, while the network settles: the step, still polling, sees
      // it; the page booted and the attempt stands — not loaded again.
      answered.delete("/late-ready");
      const lateReady = await failingPage("/style-b.css", 1, "ConnectionAborted", { ...aborted, readySettleMs: 1_000 });
      await lateReady.page.goto(`${site.origin}/late-ready`, 30_000, bootedWell(lateReady.page));
      expect(lateReady.failed()).toBe(1);
      expect(answered.get("/late-ready")).toBe(1);
      expect(lateReady.page.loadRetries).toEqual([]);
      expect(lines(lateReady.page)).toEqual([]);
      expect(await lateReady.page.eval("[document.title, window.booted]")).toEqual(["late ready", "ready"]);
      await lateReady.page.close();

      // A step that polls while its signal is unset and returns once it is set, its first page never ready: that return
      // shows nothing of the page — loaded again, and the second page's boot is what the step sees.
      answered.delete("/never-ready");
      const returning = await failingPage("/style-b.css", 1, "ConnectionAborted", { ...aborted, readySettleMs: 1_000 });
      let readySeen = 0;
      await returning.page.goto(`${site.origin}/never-ready`, 30_000, async (signal) => {
        while (!signal.aborted) {
          if (await returning.page.eval<boolean>("window.booted === 'ready'")) {
            readySeen++;
            return;
          }
          await new Promise<void>((r) => {
            const t = setTimeout(r, 100);
            signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
          });
        }
      });
      expect(answered.get("/never-ready")).toBe(2);
      expect(returning.page.loadRetries).toHaveLength(1);
      expect(readySeen).toBe(1);
      expect(lines(returning.page)).toEqual([expect.stringMatching(/style-b\.css.*loading it again \(attempt 2 of 3, /u)]);
      await returning.page.close();

      // An exception of the page's own 2 s after it runs, after the step's 1 s wait, then the boot reports "ready" at 3 s,
      // while the network settles: the late success does not stand over the exception — the load fails with it, not
      // loaded again.
      answered.delete("/error-then-ready");
      const errorThenReady = await failingPage("/style-b.css", 1, "ConnectionAborted", { ...aborted, readySettleMs: 1_000 });
      await expect(errorThenReady.page.goto(`${site.origin}/error-then-ready`, 30_000, bootedWell(errorThenReady.page)))
        .rejects.toThrow(/the page failed on its own .*exception: .*an unrelated failure of the page.*not loaded again/u);
      expect(answered.get("/error-then-ready")).toBe(1);
      expect(errorThenReady.page.loadRetries).toEqual([]);
      expect(await errorThenReady.page.eval("window.booted")).toBe("ready");
      expect(errorThenReady.page.exceptions.join("\n")).toContain("an unrelated failure of the page");
      await errorThenReady.page.close();

      // A failure of the page's own that comes after the step was abandoned, while the network settles: it counts too —
      // not loaded again (the next load would boot well).
      answered.delete("/late-failure");
      const later = await failingPage("/late.json", 1, "ConnectionAborted", { ...aborted, readySettleMs: 1_000 });
      await expect(later.page.goto(`${site.origin}/late-failure`, 30_000, () => later.page.waitFor("window.booted === 'ready'", 30_000, "the boot")))
        .rejects.toThrow(/the page failed on its own .*a later failure of the page.*not loaded again/u);
      expect(answered.get("/late-failure")).toBe(1);
      expect(later.page.loadRetries).toEqual([]);
      expect(later.page.exceptions.join("\n")).toContain("a later failure of the page");
      await later.page.close();

      // A first boot that only reports its failure on the console, its step still waiting when the stylesheet is
      // aborted: the console's error is the page's own — not loaded again (the next load would boot well).
      answered.delete("/console-failure");
      const quiet = await failingPage("/style-b.css", 1, "ConnectionAborted", aborted);
      await expect(quiet.page.goto(`${site.origin}/console-failure`, 30_000, () => quiet.page.waitFor("window.booted === 'ready'", 30_000, "the boot")))
        .rejects.toThrow(/the page failed on its own .*console error: the first boot failed quietly.*not loaded again/u);
      expect(answered.get("/console-failure")).toBe(1);
      expect(quiet.page.loadRetries).toEqual([]);
      expect(quiet.page.console.filter((c) => c.type === "error").map((c) => c.text)).toEqual(["the first boot failed quietly"]);
      await quiet.page.close();

      // A load that never ends (an image that never answers) while a stylesheet is aborted: the load's failure is the
      // page's own — not loaded again, and its error says so.
      answered.delete("/hangs");
      const hanging = await browser.newPage(aborted);
      let styleFailed = false;
      hanging.onEvent("Fetch.requestPaused", (p: { requestId: string; request: { url: string } }) => {
        const path = new URL(p.request.url).pathname;
        if (path === "/hang.svg") return; // never answered
        if (path === "/style-b.css" && !styleFailed) {
          styleFailed = true;
          void hanging.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionAborted" });
        } else void hanging.send("Fetch.continueRequest", { requestId: p.requestId });
      });
      await hanging.send("Fetch.enable", { patterns: [{ urlPattern: "*/hang.svg*" }, { urlPattern: "*/style-b.css*" }] });
      await expect(hanging.goto(`${site.origin}/hangs`, 3_000, bootedWell(hanging)))
        .rejects.toThrow(/the page failed on its own .*the load failed: load of .*timed out.*not loaded again/u);
      expect(answered.get("/hangs")).toBe(1);
      expect(hanging.loadRetries).toEqual([]);
      await hanging.close();

      // A boot whose failure the step's one question to the page (sent at once) answers only after the 1 s wait, while
      // the network settles: a failed step, not loaded again.
      answered.delete("/late-boot");
      const lateBoot = await failingPage("/style-b.css", 1, "ConnectionAborted", { ...aborted, readySettleMs: 1_000 });
      await expect(lateBoot.page.goto(`${site.origin}/late-boot`, 30_000, async () => {
        const booted = await lateBoot.page.eval<string>("window.lateBoot");
        if (booted !== "ready") throw new Error(`the boot ended ${booted}`);
      })).rejects.toThrow("the boot ended failed");
      expect(answered.get("/late-boot")).toBe(1);
      expect(lateBoot.page.loadRetries).toEqual([]);
      expect(lines(lateBoot.page)).toEqual([expect.stringMatching(/style-b\.css.*the step failed late: the boot ended failed.*not loaded again/u)]);
      await lateBoot.page.close();

      // A boot that succeeds although a stylesheet was aborted: the attempt stands, not loaded again.
      const stands = await failingPage("/style-b.css", 1, "ConnectionAborted", aborted);
      await stands.page.goto(`${site.origin}/boot-well`, 30_000, bootedWell(stands.page));
      expect(stands.failed()).toBe(1);
      expect(stands.page.loadRetries).toEqual([]);
      expect(lines(stands.page)).toEqual([]);
      await stands.page.close();

      // The aborted dynamic import throws an exception naming it: the abort's own, loaded again once.
      const dyn = await failingPage("/@fs/repo/dyn.ts", 1, "ConnectionAborted", aborted);
      await dyn.page.goto(`${site.origin}/dynamic`, 30_000, () => dyn.page.waitFor("window.value === 8", 10_000, "the import"));
      expect(dyn.failed()).toBe(1);
      expect(dyn.page.loadRetries).toEqual([expect.objectContaining({ url: `${site.origin}/dynamic`, reason: expect.stringContaining("/@fs/repo/dyn.ts") })]);
      expect(dyn.page.exceptions).toEqual([]);
      expect(dyn.page.diagnostics()).toMatch(/loaded again \(1\):[^]*dropped: exception: .*dyn\.ts/u);
      expect(lines(dyn.page)).toEqual([expect.stringMatching(/loading it again \(attempt 2 of 3, .*the aborted attempt's records \(kept in the page's report\): \d+, the first: /u)]);
      await dyn.page.close();

      // An image aborted: no load the page needs, not loaded again.
      const pic = await failingPage("/pic.svg", 1, "ConnectionAborted", aborted);
      await pic.page.goto(`${site.origin}/picture`, 30_000, bootedWell(pic.page));
      expect(pic.failed()).toBe(1);
      expect(pic.page.loadRetries).toEqual([]);
      await pic.page.close();

      // A step still waiting (for its signal, or 10 s) when the network has settled after its page's fetch was aborted:
      // its signal is set then and its next command fails, so its action runs once, in the attempt that is kept.
      const delayed = await failingPage("/late.json", 1, "ConnectionAborted", aborted);
      const signals: AbortSignal[] = [];
      let acted = 0;
      await delayed.page.goto(`${site.origin}/delayed`, 30_000, async (signal) => {
        signals.push(signal);
        await new Promise((r) => {
          setTimeout(r, 10_000);
          signal.addEventListener("abort", r, { once: true });
        });
        await delayed.page.eval("window.acts = (window.acts || 0) + 1");
        acted++;
      });
      expect(delayed.failed()).toBe(1);
      expect(delayed.page.loadRetries).toHaveLength(1);
      expect(signals.map((s) => s.aborted)).toEqual([true, false]);
      expect(acted).toBe(1);
      expect(await delayed.page.eval("window.acts")).toBe(1);
      await delayed.page.close();
    } finally {
      printed.mockRestore();
    }
  }, 120_000);
});
