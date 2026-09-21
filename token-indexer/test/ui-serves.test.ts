import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_CSP, DASHBOARD_HTML, serveUi } from "../ui/page.js";

/**
 * `[[token-ui-serves]]` — the explorer page is served, carries its Content Security Policy, pulls
 * nothing from the network, and keeps its hands off every route that is not its own
 * (spec `00020-token-indexer` §6.7, SC-006; sub-plan `00020-03` Phase 1).
 *
 * The server under test is a throwaway `node:http` server on a random free port ≥ 10000 whose
 * whole handler is `serveUi` plus a 404 — exactly the contract the token API implements
 * (`serveUi` first, the API's own router for everything it declines). A route that reaches the
 * 404 therefore proves `serveUi` returned `false`, which is the half of the contract a page test
 * usually forgets and an API integration test never isolates.
 *
 * No browser, no jsdom: the page's behaviour is compiled (`new Function`) rather than run, which
 * catches the realistic failure — a syntax error in a 900-line inline script that no unit test
 * imports — without pulling a DOM implementation into this repository's dependency set.
 */

/** The handler the token API is contracted to install: `serveUi` first, 404 for the rest. */
function handler(req: IncomingMessage, res: ServerResponse): void {
  if (serveUi(req, res)) return;
  const body = JSON.stringify({ error: { code: "TOKEN_NOT_FOUND", message: "no such resource" } });
  res.writeHead(404, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

/** Binds to a random free port ≥ 10000 (the workspace rule), retrying past a busy one. */
async function listenOnFreePort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 10_000 + Math.floor(Math.random() * 40_000);
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (): void => {
        server.removeListener("listening", onListening);
        resolve(false);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (bound) return port;
  }
  throw new Error("no free port >= 10000 found after 40 attempts");
}

describe("the token explorer page", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer(handler);
    const port = await listenOnFreePort(server);
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("[[token-ui-serves]] GET /ui answers 200 with the page and its CSP header", async () => {
    const res = await fetch(`${base}/ui`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const body = await res.text();
    expect(body).toBe(DASHBOARD_HTML);
    expect(body.startsWith("<!doctype html>")).toBe(true);

    // The policy must actually forbid the network, not merely exist.
    expect(DASHBOARD_CSP).toContain("default-src 'none'");
    expect(DASHBOARD_CSP).toContain("connect-src 'self'");
    expect(DASHBOARD_CSP).toContain("form-action 'none'");
    expect(DASHBOARD_CSP).toContain("base-uri 'none'");
    // …and it must admit this page's own inline blocks by hash, so they still run.
    expect(DASHBOARD_CSP).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(DASHBOARD_CSP).toMatch(/style-src 'sha256-[A-Za-z0-9+/]+=*'/);
  });

  it("serves a page with no external resource of any kind", async () => {
    const body = await (await fetch(`${base}/ui`)).text();

    // No absolute URL except the notice's two outbound links: not in a tag, not in a comment, not
    // in a string the script builds a link from. Those two are <a> navigations a person follows,
    // opened in a new tab without an opener or referrer — never a resource the page loads.
    const OUTBOUND = [
      "https://github.com/midnightntwrk/midnight-improvement-proposals/pull/315",
      "https://github.com/acedward/UmbraDB/pull/19",
    ];
    const anchors = [...body.matchAll(/<a href="(https:[^"]*)"([^>]*)>/g)];
    expect(anchors.map((m) => m[1]).sort()).toEqual([...OUTBOUND].sort());
    for (const m of anchors) {
      expect(m[2]).toContain('target="_blank"');
      expect(m[2]).toContain('rel="noopener noreferrer"');
    }
    const rest = OUTBOUND.reduce((text, url) => text.split(`href="${url}"`).join('href="#"'), body);
    expect(rest).not.toContain("http://");
    expect(rest).not.toContain("https://");

    // Every other `src`/`href` in the document is relative (the page's own hash routes).
    const attributes = [...rest.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(attributes.length).toBeGreaterThan(0);
    for (const value of attributes) {
      expect(value.startsWith("//")).toBe(false);
      expect(value).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }

    // The tags and CSS constructs that fetch from elsewhere are simply absent.
    // The only <link>s are the two favicons, both on this origin (their hrefs pass the relative
    // check above). A stylesheet or preload link would fetch code or content, so none exists.
    const links = [...body.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toMatch(/\brel="icon"/);
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<iframe");
    expect(body).not.toContain("@import");
    expect(body).not.toMatch(/url\(\s*["']?[a-z]+:/i);
  });

  it("compiles its inline script and ships a non-empty inline style", async () => {
    const body = await (await fetch(`${base}/ui`)).text();

    const script = /<script>([\s\S]*?)<\/script>/.exec(body)?.[1];
    expect(script, "the page must carry exactly one inline script block").toBeTypeOf("string");
    expect((script ?? "").length).toBeGreaterThan(1_000);
    // A syntax error in the inline script is the one defect that makes the page a blank screen
    // with a green test suite everywhere else. Compile it; do not run it (there is no DOM here).
    expect(() => new Function(script ?? "")).not.toThrow();

    const style = /<style>([\s\S]*?)<\/style>/.exec(body)?.[1];
    expect((style ?? "").length).toBeGreaterThan(100);

    // The page reads only from the relative routes of spec §5.
    expect(script ?? "").toContain('"/v1/tokens"');
    expect(script ?? "").toContain('"/v1/contracts"');
    expect(script ?? "").toContain('"/internal/status"');
    // The list's "API" column links each row to its raw JSON; the icon is a <template> in the markup.
    expect(script ?? "").toContain('"/v1/colors"');
    expect(body).toContain('<template id="icon-link"><svg ');
    // Every value that reaches the document goes through textContent.
    expect(script ?? "").not.toContain("innerHTML");

    // 00021: the kind filter offers the MIP's four kind bytes, and the 00020 status for a
    // self-contradicting row is gone from the whole document — the option, the badge class and the
    // warning text alike.
    for (const kind of ["0", "1", "2", "3"]) {
      expect(body, `the kind filter must offer ${kind}`).toContain(`<option value="${kind}">`);
    }
    expect(body).not.toContain("inconsistent");
  });

  it("serves the vendored brand font from its own origin", async () => {
    const res = await fetch(`${base}/ui/outfit.woff2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(DASHBOARD_CSP).toContain("font-src 'self'");
    const body = await (await fetch(`${base}/ui`)).text();
    expect(body).toContain('url("/ui/outfit.woff2")');
  });

  it("serves the favicon, as SVG and as ICO, from its own origin", async () => {
    const svg = await fetch(`${base}/ui/favicon.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(await svg.text()).toMatch(/^<svg\b[\s\S]*<\/svg>$/);
    const ico = await fetch(`${base}/favicon.ico`);
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
    // ICONDIR: reserved 0, type 1 (icon), three images.
    const head = Buffer.from(await ico.arrayBuffer()).subarray(0, 6);
    expect([...head]).toEqual([0, 0, 1, 0, 3, 0]);
  });

  it("redirects GET / to /ui", async () => {
    const res = await fetch(`${base}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui");
    expect(await res.text()).toBe("");
  });

  it("serves /ui/ as the same page", async () => {
    const res = await fetch(`${base}/ui/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DASHBOARD_HTML);
  });

  it("declines every other route, so the API answers it", async () => {
    for (const path of ["/v1/tokens", "/v1/contracts/aa/tokens/bb/shielded", "/internal/status", "/constellations/orion"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, `${path} must fall through to the API`).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "TOKEN_NOT_FOUND", message: "no such resource" } });
    }
    // A non-GET method on /ui is the API router's 405 to give, not the page's.
    const posted = await fetch(`${base}/ui`, { method: "POST" });
    expect(posted.status).toBe(404);
  });

  it("does not touch the response object for a route it declines", () => {
    const untouchable = new Proxy({} as ServerResponse, {
      get(_target, property) {
        throw new Error(`serveUi touched res.${String(property)} for a declined route`);
      },
      set(_target, property) {
        throw new Error(`serveUi assigned res.${String(property)} for a declined route`);
      },
    });
    for (const url of ["/v1/tokens?limit=10", "/internal/status", "/uix", "/ui/extra", "/v1/registry.json"]) {
      expect(serveUi({ method: "GET", url } as IncomingMessage, untouchable)).toBe(false);
    }
    expect(serveUi({ method: "DELETE", url: "/ui" } as IncomingMessage, untouchable)).toBe(false);
  });
});
