/**
 * The pages refuse to run inside a frame (`token-indexer/browser/frame-guard.ts`), so on a host that sends no headers
 * (no `frame-ancestors`) another site still cannot steer clicks onto their controls.
 *
 * - `[[browser.frame.rules]]` — a window whose top is another window, or whose top cannot be read, is framed; a top-level
 *   window, or none (a worker, Node), is not; a framed page stops with `FramedPageError`.
 * - `[[browser.frame.refused]]` — in Chromium, the static build served with no headers: the main page (opened on each of
 *   its tabs: the overview, the Token Indexer tab by its query and by an explorer route, the Database tab), the status
 *   page and the engine page inside a frame each show the notice with a link to open the page in its own tab, start no
 *   engine (no `window.umbradbEngine`, no worker, no Web Lock), while the same page at the top level starts as before.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FramedPageError, isFramed, refuseFramed } from "../browser/frame-guard.ts";
import { Browser, findBrowser } from "./helpers/cdp-browser.ts";
import { buildEngineSite, NO_AUTO_START, serveEngineSite, type EngineSite } from "./helpers/engine-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe("pages inside a frame", () => {
  it("[[browser.frame.rules]] a window whose top is another (or cannot be read) is framed; a top-level window or none is not; a framed page stops with FramedPageError", () => {
    const top = {};
    expect(isFramed({ top, self: top })).toBe(false);
    expect(isFramed({ top, self: {} })).toBe(true);
    expect(isFramed(Object.defineProperty({ self: {} }, "top", { get: () => { throw new Error("blocked"); } }) as never)).toBe(true);
    expect(isFramed(undefined)).toBe(false);
    expect(() => refuseFramed(undefined, undefined)).not.toThrow();
    expect(() => refuseFramed({ top, self: top }, undefined)).not.toThrow();
    expect(() => refuseFramed({ top, self: {} }, undefined)).toThrow(FramedPageError);
  });

  describe("in Chromium", () => {
    let dir: string;
    let site: EngineSite;
    let browser: Browser;
    beforeAll(async () => {
      const exe = findBrowser();
      if (exe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN");
      dir = await buildEngineSite(NO_AUTO_START);
      writeFileSync(join(dir, "framing.html"), "<!doctype html><title>framing</title><body></body>"); // another page of the origin
      site = await serveEngineSite(dir);
      browser = await Browser.launch(exe);
    }, 180_000);
    afterAll(async () => {
      await browser?.close();
      await site?.close();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    });

    it("[[browser.frame.refused]] served with no headers, each page inside a frame shows the notice and starts no engine; at the top level it starts as before", async () => {
      for (const page of ["index.html", "index.html?tab=tokens", "index.html#/builtin/DUST", "index.html?tab=database", "system.html", "engine.html"]) {
        const p = await browser.newPage({ workers: true });
        try {
          await p.goto(`${site.origin}/framing.html`);
          await p.eval(`new Promise((resolve) => { const f = document.createElement("iframe"); f.src = ${JSON.stringify(`${site.origin}/${page}`)}; f.onload = () => resolve(true); document.body.append(f); })`);
          await p.waitFor(`document.querySelector("iframe").contentDocument?.querySelector("[role=alert]") !== null`, 30_000, `the notice in the framed ${page}`);
          await new Promise((r) => setTimeout(r, 1_000)); // anything the page would start has had time to start
          const framed = (await p.eval(`(async () => {
            const w = document.querySelector("iframe").contentWindow;
            const d = w.document;
            const link = d.querySelector("[role=alert] a");
            return {
              notice: d.querySelector("[role=alert]").textContent,
              link: link && { href: link.getAttribute("href"), target: link.getAttribute("target"), rel: link.getAttribute("rel") },
              bodyChildren: d.body.children.length,
              engine: w.umbradbEngine === undefined ? null : "present",
              locks: (await navigator.locks.query()).held.map((l) => l.name),
            };
          })()`)) as Json;
          expect(framed, page).toEqual({
            notice: "This page does not run inside a frame. Open it in its own tab.",
            link: { href: `${site.origin}/${page}`, target: "_blank", rel: "noopener noreferrer" },
            bodyChildren: 1,
            engine: null,
            locks: [],
          });
          expect(p.workers, `${page}: no engine worker`).toEqual([]);
          expect(p.exceptions.filter((e) => !e.includes("FramedPageError") && !e.includes("does not run inside a frame")), page).toEqual([]);
        } finally {
          await p.close();
        }
      }
      // The same page at the top level connects to the engine as before.
      const top = await browser.newPage({ workers: true });
      try {
        await top.goto(`${site.origin}/engine.html`);
        await top.waitFor("window.umbradbEngine !== undefined", 30_000, "the engine page");
        expect((await top.eval("window.umbradbEngine.client.booted()") as { phase: string }).phase).toBe("ready");
        expect(await top.eval("document.querySelector('[role=alert]')")).toBeNull();
      } finally {
        await top.close();
      }
    }, 180_000);
  });
});
