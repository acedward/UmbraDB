/**
 * The Chromium tests' own driver (`helpers/cdp-browser.ts`) explains a failure: what a page and its workers did is
 * printed when a test fails, so a failure on another machine (a CI runner's Chrome) can be read from its log.
 *
 * - `[[browser.harness.failure-report]]` — in Chromium, a page whose dedicated worker fails while it runs, and one whose
 *   worker script does not load: each worker `error` event is recorded with its message, file, line and column (and
 *   the page's own scripts see the same worker as before: its class and its error event); the page's diagnostics
 *   hold it, its uncaught exception, its console calls and its workers' (the last lines only, each cut), and the
 *   report a failed test prints is every such page's diagnostics.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, failureReport, findBrowser } from "./helpers/cdp-browser.ts";
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
});
