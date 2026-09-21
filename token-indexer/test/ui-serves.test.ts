import { createHash } from "node:crypto";
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

    // No absolute URL except the notice's four outbound links: not in a tag, not in a comment, not
    // in a string the script builds a link from. Those four are <a> navigations a person follows,
    // opened in a new tab without an opener or referrer — never a resource the page loads.
    const OUTBOUND = [
      "https://github.com/midnightntwrk/midnight-improvement-proposals/pull/315",
      "https://github.com/acedward/UmbraDB/pull/19",
      "https://github.com/acedward/mip-erc7496-midnight-contracts",
      "https://github.com/effectstream/staging-tokens-addresses",
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

  // ── 00023: the transactions section, the transaction view, the disclosure panel ───────────
  //
  // These assertions are about the page's *contract with the reader*: the routes it calls, the
  // words the owner decided on (Q4, Q13), and the two headings that make the privacy claim
  // legible. They are string checks on the served document because that is what a browser gets;
  // the behaviour behind them was verified in a browser against the throwaway fixture API
  // (sub-plan 00023-02, task B2.5).

  it("[[token-ui-serves]] reads only the relative API routes of spec 00023 section 5", async () => {
    const body = await (await fetch(`${base}/ui`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(body)?.[1] ?? "";

    // The route bases, spelled as literals so this test can read them off the document.
    expect(script).toContain('"/v1/transactions"');
    expect(script).toContain('"/v1/shielded-offers"');
    // …and the paths built from them.
    expect(script).toContain('"/transactions?limit="');
    expect(script).toContain('"/calls?limit="');
    expect(script).toContain('"&role="');
    expect(script).toContain('"&cursor="');
    expect(script).toContain('"&kind="');
    expect(script).toContain('"&undisclosed="');

    // Still no absolute URL anywhere in the script, and still nothing built into markup.
    expect(script).not.toContain("http://");
    expect(script).not.toContain("https://");
    expect(script).not.toContain("innerHTML");
  });

  it("[[token-ui-serves]] carries the three new hash routes", async () => {
    const body = await (await fetch(`${base}/ui`)).text();
    // #/tx/<hash> (US2), #/shielded-offers (FR-018) and #/color/<color>/<kind> (US5, the page of
    // a colour whose mint predates the archive and which therefore has no contract route).
    expect(body).toContain('"#/tx/"');
    expect(body).toContain('"#/shielded-offers"');
    expect(body).toContain('"#/color/"');
    // The offers view is reachable from the chrome, not only from the disclosure panel.
    expect(body).toContain('<a id="nav-offers" href="#/shielded-offers">');
    // US5: the list can be filtered down to the colours no contract has named yet.
    expect(body).toContain('<option value="seen">seen</option>');
  });

  it("[[token-ui-serves]] states, in the owner's words, what is public and what is private", async () => {
    const body = await (await fetch(`${base}/ui`)).text();

    // US4: the two columns of the disclosure panel. The wording is the point of the screen.
    expect(body).toContain("public: what anyone can read from the ledger");
    expect(body).toContain("private: what the ledger never reveals");
    expect(body).toContain("a transfer between two users: a balanced offer carries no colour at all");
    expect(body).toContain("who received a coin");
    // …and the chain-wide figure behind it (FR-018) with its explanation.
    expect(body).toContain("these shielded offers carry no colour: the ledger does not say which token moved");

    // US7 / Q4: the note above a ledger token's calls table, verbatim.
    expect(body).toContain("only public data is listed — we do not have access to the code this executes");
    expect(body).toContain("is defined by the contract and is not readable here");

    // Q13: DUST has no per-token list and says so.
    expect(body).toContain("fees are not tracked per token");

    // Q10: an uncounted section is shown and marked, never silently dropped.
    expect(body).toContain("not counted");

    // Q1: heights and positions, never a wall-clock time — the two wallet-set values inside a
    // transaction are labelled as such so they cannot be read as the block's time (US3).
    expect(body).toContain("wallet-set, not the block time");
  });

  it("[[token-ui-serves]] shows wallet addresses as Bech32m only (Q9)", async () => {
    const body = await (await fetch(`${base}/ui`)).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(body)?.[1] ?? "";
    // The API sends `ownerHex` for machine consumers; the page must never read it.
    expect(script).not.toContain(".ownerHex");
    // The Bech32m short form keeps the human-readable part whole and elides the data part.
    expect(script).toContain("function shortAddr(");
    expect(script).toContain("lastIndexOf");
  });

  it("[[token-ui-serves]] the CSP hashes are the hashes of the bytes it serves", async () => {
    const res = await fetch(`${base}/ui`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const body = await res.text();

    const script = /<script>([\s\S]*?)<\/script>/.exec(body)?.[1] ?? "";
    const style = /<style>([\s\S]*?)<\/style>/.exec(body)?.[1] ?? "";
    const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("base64");

    // Not "a hash is present" but "this hash is of this block": a policy that drifted from the
    // code it authorises would leave the page blank in a browser and green in every other test.
    expect(csp).toContain(`script-src 'sha256-${sha256(script)}'`);
    expect(csp).toContain(`style-src 'sha256-${sha256(style)}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
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
