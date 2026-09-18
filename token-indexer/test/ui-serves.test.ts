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

    // No absolute URL at all: not in a tag, not in a comment, not in a string the script builds
    // a link from. The page talks to relative §5 routes on its own origin and to nothing else.
    expect(body).not.toContain("http://");
    expect(body).not.toContain("https://");

    // Every `src`/`href` in the document is relative (the page's own hash routes).
    const attributes = [...body.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(attributes.length).toBeGreaterThan(0);
    for (const value of attributes) {
      expect(value.startsWith("//")).toBe(false);
      expect(value).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }

    // The tags and CSS constructs that fetch from elsewhere are simply absent.
    expect(body).not.toContain("<link");
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
