import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../../shielded-monitor/api/config.js";
import {
  createShieldedMonitorApi,
  silentLogger,
  type ShieldedMonitorApi,
} from "../../shielded-monitor/api/server.js";
import { DASHBOARD_CSP, DASHBOARD_HTML } from "../../shielded-monitor/api/ui/page.js";
import { MonitorNotFoundError } from "../../shielded-monitor/errors.js";
import type { PgShieldedMonitorStore } from "../../storage-api/monitor-store-pg.js";

/**
 * The dashboard route and the page it serves (organizer sub-plan 00009-06;
 * `openspec/changes/00009-06-dashboard/specs/shielded-monitor-dashboard/spec.md`).
 *
 * **No Docker.** The dashboard touches no table, and the route-coverage check below only needs to
 * learn whether a path RESOLVES — which is decided before any handler runs. The store is therefore
 * a stub that refuses every monitor id, and the check asserts the distinction that matters: a
 * route that does not exist answers the router's own `NOT_FOUND`, while a route that exists
 * answers something else (`MONITOR_NOT_FOUND`, `VALIDATION_FAILED`, or a 200). Confusing those two
 * 404s is exactly the mistake this test is built to make impossible.
 */
describe("shielded-monitor dashboard (GET /ui)", () => {
  let api: ShieldedMonitorApi;
  let base: string;

  /** Every method the routes under test reach. Each behaves as "this deployment has nothing",
   *  which is enough to prove a route exists without a database. */
  const stubStore = {
    listAll: async () => [],
    get: async (id: string) => {
      throw new MonitorNotFoundError(id);
    },
    getIncludingRevoked: async () => undefined,
    getByFingerprint: async () => undefined,
  } as unknown as PgShieldedMonitorStore;

  beforeAll(async () => {
    api = createShieldedMonitorApi({
      store: stubStore,
      config: loadApiConfig({ API_PORT: "0", STORAGE_URL: "http://storage-api:8788" }),
      logger: silentLogger(),
    });
    const address = await api.listen();
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await api?.close();
  });

  // ── Serving ─────────────────────────────────────────────────────────────────────────────────

  it.each(["/ui", "/ui/"])("serves the page at %s", async (path) => {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toBe(DASHBOARD_HTML);
    expect(body.startsWith("<!doctype html>")).toBe(true);
  });

  it("redirects the bare root to the page", async () => {
    const response = await fetch(`${base}/`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/ui");
  });

  it("answers 405 for a method the page route does not have, not 404", async () => {
    for (const [path, method] of [["/ui", "POST"], ["/", "DELETE"]] as const) {
      const response = await fetch(`${base}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
  });

  it("carries the hardening headers", async () => {
    const response = await fetch(`${base}/ui`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
  });

  // ── The policy actually matches the bytes ───────────────────────────────────────────────────

  describe("Content Security Policy", () => {
    it("is not a decoration: no 'unsafe-inline', no 'unsafe-eval', no wildcard", () => {
      expect(DASHBOARD_CSP).toContain("default-src 'self'");
      expect(DASHBOARD_CSP).toContain("form-action 'none'");
      expect(DASHBOARD_CSP).toContain("frame-ancestors 'none'");
      expect(DASHBOARD_CSP).toContain("base-uri 'none'");
      for (const forbidden of ["unsafe-inline", "unsafe-eval", "*", "data:", "http:", "https:"]) {
        expect(DASHBOARD_CSP, `CSP must not contain ${forbidden}`).not.toContain(forbidden);
      }
    });

    it("names the SHA-256 hash of the exact inline script and style the page serves", () => {
      // A hash-based policy that does not match the served bytes is worse than no policy: the page
      // simply stops working, and only in a browser, which no other test here uses. So the hashes
      // are recomputed from the document itself.
      const blocks = [
        { open: "<style>", close: "</style>", directive: "style-src" },
        { open: "<script>", close: "</script>", directive: "script-src" },
      ];
      for (const { open, close, directive } of blocks) {
        const start = DASHBOARD_HTML.indexOf(open);
        const end = DASHBOARD_HTML.indexOf(close, start);
        expect(start, `${open} must appear exactly once`).toBeGreaterThanOrEqual(0);
        expect(DASHBOARD_HTML.indexOf(open, start + 1), `${open} must appear exactly once`).toBe(-1);
        const inline = DASHBOARD_HTML.slice(start + open.length, end);
        const hash = createHash("sha256").update(inline, "utf8").digest("base64");
        expect(DASHBOARD_CSP).toContain(`${directive} 'sha256-${hash}'`);
      }
    });
  });

  // ── Self-containment ────────────────────────────────────────────────────────────────────────

  it("[[shielded-monitor.ui.self-contained-no-external-resources]] references no external origin anywhere in the document", () => {
    // Not "no CDN we happen to know about" — no absolute URL at all, in any attribute, in any CSS
    // declaration, in any string. `//example.com` (protocol-relative) is checked too, because it
    // is the form that survives a naive `http` search.
    for (const pattern of [/https?:\/\//i, /\bsrc\s*=\s*["']\s*\/\//i, /url\(\s*["']?\s*(https?:)?\/\//i]) {
      expect(DASHBOARD_HTML, `document must not match ${pattern}`).not.toMatch(pattern);
    }
    // Positive control: the scan above can find one when it is there.
    expect(`${DASHBOARD_HTML}<img src="https://example.com/x.png">`).toMatch(/https?:\/\//i);
  });

  it("declares no attribute that loads a subresource", () => {
    for (const attribute of ["src=", "href=", "srcset=", "integrity=", "@import"]) {
      expect(DASHBOARD_HTML, `document must not use ${attribute}`).not.toContain(attribute);
    }
  });

  it("builds its DOM without innerHTML, so no response value can become markup", () => {
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
      expect(DASHBOARD_HTML, `page must not use ${sink}`).not.toContain(sink);
    }
  });

  it("never persists anything in the browser", () => {
    for (const store of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
      expect(DASHBOARD_HTML, `page must not use ${store}`).not.toContain(store);
    }
  });

  it("keeps the key field a password field with autocomplete off, and never renders it back", () => {
    expect(DASHBOARD_HTML).toContain('type="password"');
    expect(DASHBOARD_HTML).toContain('autocomplete="off"');
    // The field is cleared before the request is issued; the assignment is the guarantee.
    expect(DASHBOARD_HTML).toContain('field.value = ""');
    // Nothing reads the field into a URL.
    expect(DASHBOARD_HTML).not.toMatch(/viewingKey\s*=\s*encodeURIComponent/);
  });

  it("parses as balanced markup", () => {
    // Not a full parser — a cheap structural check that catches the failure a hand-written page
    // actually has, namely an unclosed tag introduced by an edit.
    const voidTags = new Set(["meta", "input", "br", "hr", "img", "link", "source", "i"]);
    const stack: string[] = [];
    for (const match of DASHBOARD_HTML.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
      const [, closing, rawName, selfClosing] = match;
      const name = rawName!.toLowerCase();
      if (name === "!doctype" || voidTags.has(name) || selfClosing === "/") continue;
      if (closing === "/") {
        expect(stack.pop(), `</${name}> does not close the open element`).toBe(name);
      } else {
        stack.push(name);
      }
    }
    expect(stack, `unclosed: ${stack.join(", ")}`).toEqual([]);
  });

  // ── Every path the page calls exists ────────────────────────────────────────────────────────

  describe("route coverage", () => {
    /** The route patterns the page documents in its own source, read back out of the served
     *  document so a path added to the script without a route fails here. */
    const declared = [...DASHBOARD_HTML.matchAll(/\/\/\s+(GET|POST|DELETE)\s+(\/v1\/[^\s]*)/g)].map(
      (m) => [m[1]!, m[2]!] as const,
    );

    it("declares the routes it uses (non-vacuity: the list is not empty)", () => {
      expect(declared.length).toBeGreaterThanOrEqual(8);
    });

    it("every path literal in the page appears in the declared list", () => {
      // The declared comment block is only trustworthy if it is complete, so the literals the
      // script actually builds are cross-checked against it. `"/v1/monitors/" + id + "/matches"`
      // contributes the prefix `/v1/monitors/`, which must be covered by a declared `:id` route.
      const literals = new Set(
        [...DASHBOARD_HTML.matchAll(/"(\/v1\/[^"]*)"/g)].map((m) => m[1]!.replace(/\/$/, "")),
      );
      expect(literals.size).toBeGreaterThan(0);
      for (const literal of literals) {
        const covered = declared.some(([, pattern]) => pattern === literal || pattern.startsWith(`${literal}/`));
        expect(covered, `${literal} is used by the page but not declared`).toBe(true);
      }
    });

    it.each(declared)("%s %s resolves to a real route", async (method, pattern) => {
      // A concrete, well-formed id that no monitor has. The router validates the id shape BEFORE
      // dispatch, so a malformed one would answer the router's 404 and the check would be vacuous.
      const path = pattern.replace(":id", "00000000-0000-4000-8000-000000000000");
      const init: RequestInit =
        method === "POST" && path === "/v1/monitors"
          ? { method, headers: { "content-type": "application/json" }, body: "{}" }
          : { method };
      const response = await fetch(`${base}${path}`, init);

      expect(response.status, `${method} ${path} must not be 405`).not.toBe(405);
      if (response.status >= 400) {
        const body = (await response.json()) as { error: { code: string } };
        // `NOT_FOUND` is the ROUTER's "no such resource". Anything else means the route ran.
        expect(body.error.code, `${method} ${path} did not resolve to a route`).not.toBe("NOT_FOUND");
      }
    });

    it("a path the page does NOT declare still answers the router's NOT_FOUND (control)", async () => {
      // Without this, the check above would pass even if the router answered every path.
      const response = await fetch(`${base}/v1/monitors/00000000-0000-4000-8000-000000000000/nonsense`);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    });
  });

  // ── The match-details renderer, actually executed (00009-07) ────────────────────────────────

  describe("expandable match row", () => {
    /** The page's own script, run in a sandbox against a DOM stub small enough to fit here.
     *
     *  Executing the renderer is worth the twenty lines of stub: string-matching the template
     *  would pass for a page whose summary line reads "undefined output yours", which is exactly
     *  the class of mistake a hand-written renderer makes. The stub records a tree, and the
     *  assertions read the text out of it. */
    interface StubNode {
      tag: string;
      textContent: string;
      className: string;
      children: StubNode[];
      colSpan?: number;
      title?: string;
    }
    function makeNode(tag: string): StubNode {
      const node: StubNode = { tag, textContent: "", className: "", children: [] };
      return Object.assign(node, {
        style: {},
        appendChild(child: StubNode) { node.children.push(child); return child; },
        addEventListener() { /* the renderer installs handlers; none are invoked here */ },
      });
    }
    function text(node: StubNode): string {
      return [node.textContent, ...node.children.map(text)].filter((t) => t !== "").join(" | ");
    }

    /** Pulls the page's inline script out of the SERVED document and evaluates it, so what is
     *  under test is the bytes the browser receives, not a copy. */
    function loadScript(): Record<string, any> {
      const open = DASHBOARD_HTML.indexOf("<script>");
      const close = DASHBOARD_HTML.indexOf("</script>", open);
      const source = DASHBOARD_HTML.slice(open + "<script>".length, close);
      const sandbox: Record<string, any> = {
        document: { createElement: makeNode, getElementById: () => makeNode("div") },
        window: { addEventListener: () => {}, setInterval: () => 0, clearInterval: () => {}, confirm: () => false },
        navigator: {},
        fetch: () => Promise.reject(new Error("the renderer under test must not fetch")),
        Date, Math, JSON, BigInt, Number, String, Object, Array, Boolean, isFinite, encodeURIComponent,
      };
      sandbox.globalThis = sandbox;
      createContext(sandbox);
      runInContext(source, sandbox);
      return sandbox;
    }

    const page = loadScript();

    const item = (details: unknown, blockTimestampMs: string | null) => ({
      cursor: "c1", blockHeight: "1116", position: 0, txHash: "ab".repeat(32),
      matchedSegments: [0], appliedOutcome: "unknown", protocolVersion: "1000000",
      blockTimestampMs, details,
    });

    const fullDetails = {
      version: "shielded-monitor/match-details/v1",
      ledgerBuild: "ledger-v8@8.1.0-syshash.4",
      segments: [{
        segment: 0,
        matched: true,
        outputs: [
          { index: 0, commitment: "c0".repeat(32), mine: null },
          { index: 1, commitment: "c1".repeat(32), mine: null },
          { index: 2, commitment: "c2".repeat(32), contractAddress: "ca".repeat(32), mine: false },
        ],
        inputs: [{ index: 0, nullifier: "nu".repeat(32) }],
        transients: [{ index: 0, commitment: "tc".repeat(32), nullifier: "tn".repeat(32), mine: false }],
        counts: { outputs: 3, inputs: 1, transients: 1 },
        mineAmong: 2,
      }],
      totals: { outputs: 3, inputs: 1, transients: 1, mine: 0, unattributed: 2 },
    };

    it("summarises a match with details, pluralising the counts", () => {
      expect(page.summaryOf(item(fullDetails, "1754395200000")))
        .toBe("1 of 2 yours · 3 commitments · 1 nullifier · 1 transient");
      const pinned = { ...fullDetails, totals: { outputs: 1, inputs: 0, transients: 0, mine: 1, unattributed: 0 } };
      expect(page.summaryOf(item(pinned, "1")))
        .toBe("1 output yours · 1 commitment · 0 nullifiers · 0 transients");
      const none = { ...fullDetails, totals: { outputs: 2, inputs: 2, transients: 0, mine: 0, unattributed: 0 } };
      expect(page.summaryOf(item(none, "1")))
        .toBe("none yours · 2 commitments · 2 nullifiers · 0 transients");
    });

    it("summarises a match with NO details as the backfill prompt, never as an empty transaction", () => {
      expect(page.summaryOf(item(null, null))).toBe("details not recorded yet — run the backfill");
    });

    it("renders a time only when there is one, and never a zero or a clock read", () => {
      expect(page.fmtWhen(null)).toBe("not recorded");
      expect(page.fmtWhen(undefined)).toBe("not recorded");
      expect(page.fmtWhen("not-a-number")).toBe("not recorded");
      expect(page.fmtWhen("1754395200000")).toBe("2025-08-05T12:00:00Z");
      expect(page.ago(null)).toBe("");
      expect(page.ago(String(Date.now() - 90_000))).toBe("2m ago");
    });

    it("renders the expanded panel: every commitment, every nullifier, the attribution and the legend", () => {
      const rendered = text(page.detailsPanel(item(fullDetails, "1754395200000")) as StubNode);
      // The block time and the two outcomes.
      expect(rendered).toContain("block time 2025-08-05T12:00:00Z");
      expect(rendered).toContain("applied unknown");
      expect(rendered).toContain("source not recorded");
      // The segment header, including how many candidates the one match is among.
      expect(rendered).toContain("segment 0 (guaranteed) · matched");
      expect(rendered).toContain("one of these 2 is yours");
      // Every public value reaches the panel.
      for (const value of [
        fullDetails.segments[0]!.outputs[0]!.commitment,
        fullDetails.segments[0]!.outputs[2]!.contractAddress!,
        fullDetails.segments[0]!.inputs[0]!.nullifier,
        fullDetails.segments[0]!.transients[0]!.commitment,
        fullDetails.segments[0]!.transients[0]!.nullifier,
      ]) {
        expect(rendered).toContain(value);
      }
      // The three attribution renderings, and the legend that explains them.
      expect(rendered).toContain("?");
      expect(rendered).toContain("commitment = a new shielded coin");
      expect(rendered).toContain("only outputs encrypted to your key are yours");
      expect(rendered).toContain("ledger-v8@8.1.0-syshash.4");

      const pinned = {
        ...fullDetails,
        segments: [{
          ...fullDetails.segments[0]!,
          outputs: [{ index: 0, commitment: "aa", mine: true }],
          inputs: [], transients: [],
          counts: { outputs: 1, inputs: 0, transients: 0 },
          mineAmong: undefined,
        }],
      };
      expect(text(page.detailsPanel(item(pinned, "1")) as StubNode)).toContain("yours");
    });

    it("renders the backfill placeholder when the match has no details", () => {
      const rendered = text(page.detailsPanel(item(null, null)) as StubNode);
      expect(rendered).toContain("Details not recorded yet");
      expect(rendered).toContain("umbradb-shielded-monitor --backfill-details");
      expect(rendered).toContain("block time not recorded");
    });

    it("says a segment holds nothing rather than rendering an empty table", () => {
      const empty = {
        version: "v1", ledgerBuild: "b",
        segments: [{
          segment: 2, matched: false, outputs: [], inputs: [], transients: [],
          counts: { outputs: 0, inputs: 0, transients: 0 },
        }],
        totals: { outputs: 0, inputs: 0, transients: 0, mine: 0, unattributed: 0 },
      };
      const rendered = text(page.detailsPanel(item(empty, "1")) as StubNode);
      expect(rendered).toContain("segment 2 (fallible) · not matched");
      expect(rendered).toContain("no zswap entries in this segment");
    });

    it("keeps the expansion state keyed by cursor, so the 3 s refresh cannot collapse an open row", () => {
      // Structural, because the toggle's effect is only observable through a re-render the stub
      // does not drive: the state key must be the item's own cursor, which is stable across polls.
      expect(DASHBOARD_HTML).toContain("state.expanded[m.cursor]");
      expect(DASHBOARD_HTML).toContain("function toggleRow(cursor)");
    });
  });

  // ── Size discipline ─────────────────────────────────────────────────────────────────────────

  it("stays small enough to review in one sitting", () => {
    // The design's stated bound. A page that grows past what one file can carry is the moment to
    // propose a build step as its own change, not to quietly keep appending.
    //
    // 600 -> 700 (00009-07). The expandable match row — the caret column, the per-segment output/
    // input/transient tables, the time formatters and the legend — is 165 lines, against a 479-line
    // page, and the sub-plan budgeted ~250. Raising the bound is a deliberate, recorded decision
    // made in the change that spends it (`openspec/changes/00009-07-match-details/design.md` §5),
    // not a number nudged to make a failing test pass: the page is still ONE file with no build
    // step, no framework and no external resource, which is what the bound is a proxy for. The
    // next change that wants more room owes the same paragraph — or the build step.
    expect(DASHBOARD_HTML.split("\n").length).toBeLessThan(700);
  });
});
