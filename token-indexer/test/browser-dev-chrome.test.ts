/**
 * The browser build's dev server (`npm run dev:browser`: Vite with `token-indexer/browser/vite.config.ts`, started here
 * through Vite's API on 127.0.0.1 at a random free port at or above 10000, with the engine's automatic start off and
 * the chain moved to a local server that refuses everything, so nothing reaches Stagenet). The pages link the
 * explorer's shared style and icon as `../mip0018/ui/…`, outside the dev server's root; `build-explorer.ts` serves them.
 *
 * - `[[browser.dev.assets]]` — every stylesheet and icon the explorer page (`/`) and the status page (`/system.html`)
 *   link, and the font the explorer's style names, are served as what they are: `text/css` with the style's rules,
 *   the icon as an image, the font as `font/woff2`; never `text/html` (the page the dev server answers for a path it
 *   does not have).
 * - `[[browser.dev.styles]]` — in Chromium, the main page on the dev server is styled: the explorer's style sheet is
 *   loaded with its rules, the brand font is loaded and is the body's font, the logo is the 22-pixel mark (not a page
 *   wide picture), the overview's labels and values sit side by side in its grid, and the main page's own style
 *   (`explorer.css`) applies; the status page gets the same font; the icon loads.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 */
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, findBrowser } from "./helpers/cdp-browser.ts";
import { BROWSER_CONFIG, NO_AUTO_START } from "./helpers/engine-site.ts";
import { type LocalServer, serveHandler } from "./helpers/static-site.ts";

const CHAIN_ENV = ["UMBRADB_BROWSER_NETWORK", "UMBRADB_BROWSER_NODE_URL", "UMBRADB_BROWSER_INDEXER_URL"] as const;
const browserExe = findBrowser();

/** Polls `ok` until it holds; fails naming `what` once `timeoutMs` has passed. */
async function until(what: string, ok: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The `href` of every `<link rel="…">` of a page with that `rel`. */
function links(html: string, rel: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (new RegExp(`\\brel=["']?${rel}["'\\s>]`, "i").test(tag)) out.push(/\bhref=["']([^"']+)["']/i.exec(tag)![1]!);
  }
  return out;
}

describe("the browser build's dev server", () => {
  let dev: ViteDevServer;
  let origin = "";
  let chain: LocalServer;
  let browser: Browser;

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    chain = await serveHandler((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("not a chain");
    });
    const { createServer } = await import("vite");
    const saved = CHAIN_ENV.map((k) => [k, process.env[k]] as const);
    for (const k of CHAIN_ENV) delete process.env[k];
    process.env.UMBRADB_BROWSER_NODE_URL = `${chain.origin}/rpc`;
    process.env.UMBRADB_BROWSER_INDEXER_URL = `${chain.origin}/graphql`;
    try {
      for (let attempt = 0; ; attempt++) {
        const port = 10_000 + Math.floor(Math.random() * 50_000);
        const server = await createServer({ configFile: BROWSER_CONFIG, logLevel: "silent", clearScreen: false, define: NO_AUTO_START, server: { host: "127.0.0.1", port, strictPort: true } });
        try {
          await server.listen();
          dev = server;
          origin = `http://127.0.0.1:${port}`;
          break;
        } catch (e) {
          await server.close();
          if (attempt > 20) throw e;
        }
      }
    } finally {
      for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    browser = await Browser.launch(browserExe);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await dev?.close();
    await chain?.close();
  });

  it("[[browser.dev.assets]] every stylesheet and icon the explorer and the status page link, and the explorer's font, are served as text/css, an image and font/woff2, never as text/html", async () => {
    const get = async (url: string, accept: string): Promise<{ status: number; type: string; text: string }> => {
      const r = await fetch(url, { headers: { accept } });
      return { status: r.status, type: r.headers.get("content-type") ?? "", text: await r.text() };
    };
    let fonts = 0;
    for (const page of ["/", "/system.html"]) {
      const html = await get(`${origin}${page}`, "text/html");
      expect([html.status, html.type.startsWith("text/html")], page).toEqual([200, true]);
      const sheets = links(html.text, "stylesheet");
      expect(sheets.length, page).toBeGreaterThanOrEqual(2);
      expect(sheets.some((h) => h.endsWith("/mip0018/ui/page.css")), `${page}: ${sheets.join(", ")}`).toBe(true);
      for (const href of sheets) {
        const url = new URL(href, `${origin}${page}`).href;
        const css = await get(url, "text/css,*/*;q=0.1");
        expect([css.status, css.type.split(";")[0]], url).toEqual([200, "text/css"]);
        expect(css.text.trimStart().toLowerCase().startsWith("<!doctype"), url).toBe(false);
        expect(css.text, url).toMatch(/\{[^}]*:[^}]*\}/);
        for (const m of css.text.matchAll(/url\("?([^")]+\.woff2)"?\)/g)) {
          const fontUrl = new URL(m[1]!, url).href;
          const font = await get(fontUrl, "*/*");
          expect([font.status, font.type], fontUrl).toEqual([200, "font/woff2"]);
          expect(fontUrl, fontUrl).toMatch(/Outfit-Variable-latin\.woff2$/);
          fonts++;
        }
      }
      const icons = links(html.text, "icon");
      expect(icons.length, page).toBe(1);
      const icon = await get(new URL(icons[0]!, `${origin}${page}`).href, "image/*,*/*;q=0.8");
      expect(icon.status, icons[0]).toBe(200);
      expect(icon.type, icons[0]).toMatch(/^image\//);
    }
    expect(fonts, "the explorer's style names its font on both pages").toBe(2);
  }, 120_000);

  it("[[browser.dev.styles]] in Chromium the dev server's explorer is styled: its style sheet loaded with its rules, the brand font loaded and the body's, the logo the 22-pixel mark, the overview's labels and values side by side and the main page's own style applied; the status page in the same font; the icon loaded", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/`, 60_000);
    // The dev server may reload the page once while it prepares the dependencies; wait for the styled, booted page.
    await page.waitFor("document.querySelector('#engine-panel .kv') !== null && getComputedStyle(document.body).fontFamily.startsWith('Outfit')", 90_000, "the styled explorer and its panel");
    const look = await page.eval<Record<string, unknown>>(`(async () => {
      await document.fonts.load("14px Outfit");
      const sheet = [...document.styleSheets].find((s) => (s.href ?? "").endsWith("/mip0018/ui/page.css"));
      const kv = document.querySelector("#engine-panel .kv");
      const k = kv.querySelector(".k"), v = kv.querySelector(".v");
      return {
        sheetRules: sheet ? sheet.cssRules.length : 0,
        bodyFont: getComputedStyle(document.body).fontFamily,
        outfitLoaded: [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Outfit" && f.status === "loaded"),
        logoHeight: document.querySelector(".brand svg").getBoundingClientRect().height,
        kvDisplay: getComputedStyle(kv).display,
        sideBySide: Math.abs(k.getBoundingClientRect().top - v.getBoundingClientRect().top) < 2 && k.getBoundingClientRect().right <= v.getBoundingClientRect().left,
        overviewPaddingTop: getComputedStyle(document.getElementById("overview")).paddingTop,
      };
    })()`);
    expect(look.sheetRules as number).toBeGreaterThan(20);
    expect(look).toMatchObject({ outfitLoaded: true, kvDisplay: "grid", sideBySide: true, overviewPaddingTop: "18px", logoHeight: 22 });
    expect(look.bodyFont as string).toMatch(/^Outfit,/);
    // The browser asks for the icon on its own schedule, after the page's load: wait for its answer to be recorded.
    await until("the icon's answer", () => page.requests.some((r) => r.url.endsWith("/mip0018/ui/favicon.ico") && r.status === 200), 30_000);
    for (const r of page.requests) {
      const o = new URL(r.url).origin;
      expect([origin, chain.origin, "null"], r.url).toContain(r.url.startsWith("data:") || r.url.startsWith("blob:") ? "null" : o);
    }
    expect(page.exceptions).toEqual([]);

    const system = await browser.newPage();
    await system.goto(`${origin}/system.html`, 60_000);
    await system.waitFor("getComputedStyle(document.body).fontFamily.startsWith('Outfit') && getComputedStyle(document.querySelector('.brand')).display === 'flex'", 90_000, "the styled status page");
    expect(system.exceptions).toEqual([]);
    await system.close();
    await page.close();
  }, 240_000);
});
