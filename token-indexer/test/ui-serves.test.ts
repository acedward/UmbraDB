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

  /**
   * ONE test carries `[[token-ui-serves]]`, deliberately: `check-required-tests.ts:165` treats an
   * id reported by more than one test as an `ambiguous` GATE VIOLATION — with every test green.
   * Project 00023 sub-plan 01 hit the same trap on `[[token-activity-decode-effects]]` and folded
   * two tests into one for the same reason. The 00023 page assertions below (sub-plan 02, task
   * B3.1) therefore live in this test's body rather than in five `it`s of their own; the file's
   * other, untagged tests are unaffected.
   *
   * They are string checks on the served document because that is what a browser gets; the
   * behaviour behind them was verified in a real browser against a throwaway fixture API (B2.5)
   * and, in master Phase C3, against the live API on `127.0.0.1:10020`.
   */
  it("[[token-ui-serves]] GET /ui answers 200 with the page, its CSP header and the 00023 contract", async () => {
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

    const script = /<script>([\s\S]*?)<\/script>/.exec(body)?.[1] ?? "";
    const style = /<style>([\s\S]*?)<\/style>/.exec(body)?.[1] ?? "";

    // ── 00023: it reads only the relative API routes of spec §5 ──────────────────────────────
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

    // ── 00023: the three new hash routes ─────────────────────────────────────────────────────
    // #/tx/<hash> (US2), #/shielded-offers (FR-018) and #/color/<color>/<kind> (US5, the page of
    // a colour whose mint predates the archive and which therefore has no contract route).
    expect(body).toContain('"#/tx/"');
    expect(body).toContain('"#/shielded-offers"');
    expect(body).toContain('"#/color/"');
    // The offers view is reachable from the chrome, not only from the disclosure panel.
    expect(body).toContain('<a id="nav-offers" href="#/shielded-offers">');
    // US5: the list can be filtered down to the colours no contract has named yet.
    expect(body).toContain('<option value="seen">seen</option>');

    // ── 00023 / Q21 + Q24: the strip says where the CHAIN is, how far behind, and how fresh ───
    // Q21 gave the strip one honest height and the chain's own head. Q24 — the owner's Phase E
    // review — cut it to four segments and nothing else:
    //     net: stagenet · chain tip 567117 · behind 1 234 · last updated 12 s ago
    // The rule behind the distance is unchanged and still pinned; what changed is that the index's
    // own height, the pending-lookup count, the archive's lead and the word "in sync" are no
    // longer on the strip. They are read on the status view, which is a full technical listing.
    // Asserted against the body of `renderStrip` itself, because "the string is somewhere in a
    // 1 500-line script" would not notice a segment that stopped being rendered.
    const stripFn = script.slice(script.indexOf("function renderStrip("));
    const strip = stripFn.slice(0, stripFn.indexOf("\nfunction "));
    expect(strip.length).toBeGreaterThan(200);
    for (const segment of ['"net: "', '"chain tip "', '"behind "', '"last updated "']) {
      expect(strip, `the strip must render ${segment}`).toContain(segment);
    }
    // The distance is printed ONLY while there is one: no word is printed to say nothing happened.
    expect(strip).toContain("if (b !== null && b > 0)");
    expect(strip).not.toContain('"in sync"');
    // …and these four are off the strip, every one of them still on the status view.
    for (const gone of ["indexedHeight(", "pendingLookups", '"(archive "', "archiveLeadNote"]) {
      expect(strip, `${gone} must not be on the strip any more`).not.toContain(gone);
    }
    expect(script).not.toContain("ARCHIVE_LEAD_NOTE");
    expect(script).not.toContain('pair("');
    // A tip the indexer would not give is said out loud, never shown as a dash or a zero distance.
    expect(strip).toContain('"chain tip unavailable"');
    expect(script).toContain("st.chainHead");
    // The status view keeps the words for both states the strip now expresses by saying nothing.
    expect(script).toContain('"chain tip unavailable"');
    expect(script).toContain('"in sync"');
    expect(script).toContain('["chain tip", st.chainHead');
    expect(script).toContain('["indexed", orDash(indexedHeight(st))]');
    // "indexed" is the SMALLER of the two positions, so a rebuilt-but-unscanned index cannot look
    // in sync: after `rebuild` the cursor is 0 while the archive still holds half a million blocks.
    expect(script).toContain("function indexedHeight(");
    expect(script).toContain("tip < cur ? tip : cur");
    // The two retired strip labels are gone from the strip itself.
    expect(strip).not.toContain('"archive tip"');
    expect(strip).not.toContain('"decode cursor"');

    // "last updated" is relative, keeps counting between refreshes, and turns red when it is old.
    expect(script).toContain("function agoText(");
    for (const unit of ['"just now"', '" s ago"', '" min ago"', '" h ago"', '"never updated"']) {
      expect(script, `the relative clock must be able to say ${unit}`).toContain(unit);
    }
    expect(script).toContain("var STALE_MS = 60000;");
    expect(strip).toContain("STALE_MS");
    expect(strip).toContain('"stale"');
    expect(style).toContain(".strip .stale");
    // A count is grouped for reading; a height is an identifier and is never grouped.
    expect(script).toContain("function groupDigits(");
    expect(strip).toContain("groupDigits(b)");
    expect(strip).toContain('node("b", String(head))');
    // The strip redraws every second on its own interval, so the clock moves between the 10 s data
    // refreshes — which themselves are untouched.
    expect(script).toContain("window.setInterval(renderStrip, STRIP_TICK_MS)");
    expect(script).toContain("window.setInterval(refresh, REFRESH_MS)");
    // The two refresh controls and the cadence note are HIDDEN, and the auto-refresh they
    // described still runs (the interval above is the page's own, not theirs).
    expect(body).toContain('<button id="now" hidden>refresh now</button>');
    expect(body).toContain('<button id="toggle" hidden>pause auto-refresh</button>');
    expect(body).toContain('<span class="note" hidden>every 10&nbsp;s</span>');

    // ── 00023 / Q22: a shielded token discloses its numbers, not a lecture ───────────────────
    // The owner removed the static two-column public/private panel: the reader is an advanced user
    // who already knows what a zswap offer publishes. What must survive is the part only this index
    // can supply — the two live counts and the link that turns the second into a real list.
    expect(body).toContain("transactions disclose this colour");
    // (the sentence is a two-part concatenation in the source, so it is read in its two halves)
    expect(body).toContain("shielded offers on this chain publish no colour at all — any of ");
    expect(body).toContain("them may be this token");
    expect(body).toContain('<a id="nav-offers" href="#/shielded-offers">');
    // …and the retired panel is really gone, not merely hidden.
    expect(body).not.toContain("public: what anyone can read from the ledger");
    expect(body).not.toContain("private: what the ledger never reveals");
    expect(body).not.toContain("who received a coin");
    expect(body).not.toContain("what this shielded token discloses");
    // The chain-wide list behind the second count keeps its own explanation on its own page.
    expect(body).toContain("these shielded offers carry no colour: the ledger does not say which token moved");

    // US7 / Q4: the note above a ledger token's calls table, verbatim.
    expect(body).toContain("only public data is listed — we do not have access to the code this executes");
    expect(body).toContain("is defined by the contract and is not readable here");

    // Q13: DUST has no per-token list and says so.
    expect(body).toContain("fees are not tracked per token");

    // Q10: an uncounted section is shown and marked, never silently dropped.
    expect(body).toContain("not counted");

    // Q18: the transaction view names the number it actually has — the DUST the wallet offered,
    // not the fee the ledger charged (which is not derivable from the archived bytes).
    expect(body).toContain("DUST offered for fees");
    expect(body).toContain("not the fee the ledger charged");

    // Q1: heights and positions, never a wall-clock time — the two wallet-set values inside a
    // transaction are labelled as such so they cannot be read as the block's time (US3).
    expect(body).toContain("wallet-set, not the block time");

    // ── 00023 / Q9: wallet addresses are shown as Bech32m only ───────────────────────────────
    // The API sends `ownerHex` for machine consumers; the page must never read it.
    expect(script).not.toContain(".ownerHex");
    // The Bech32m short form keeps the human-readable part whole and elides the data part.
    expect(script).toContain("function shortAddr(");
    expect(script).toContain("lastIndexOf");

    // ── F1.4: MIP-0018 is the standard, and a draft-name value says so ──────────────────────
    // The notice names the standard and its own PR, not the draft's.
    expect(body).toContain("<b>MIP-0018, On-Chain Token Metadata Emission</b>");
    expect(body).toContain("midnight-improvement-proposals PR&nbsp;#325");
    expect(body).not.toContain("MIP-XXXX");
    expect(body).not.toContain("pull/315");
    // The badge: one hue, one wording, and it appears wherever a draft-name value does — beside a
    // trait's key, in the events table's own `name` column, and in the notice that explains it.
    expect(style).toContain("--tag-premip-bg:");
    expect(style).toContain(".premip {");
    expect(script).toContain("function preMipBadge(");
    expect(script).toContain('node("span", "pre-MIP name", "premip")');
    expect(body).toContain('<span class="premip">pre-MIP name</span>');
    // …and only a draft-name value is marked: the standard's own name is the expected case.
    expect(script).toContain('if (variant !== "legacy-mip-xxxx") return null;');
    expect(script).toContain("function variantLabel(");
    expect(script).toContain('"MIP-0018"');
    // The events table gained a `name` column, between the block and the transaction.
    expect(script).toContain('["event id", "block", "name", "tx", "domainSep", "kind", "key", "type"');
    // A trait is badged by the variant of the event that SET it, never by the token's.
    expect(script).toContain("preMipBadge(tr.nameVariant)");
    expect(script).toContain('if (kv.nameVariant === "legacy-mip-xxxx") anyPreMip = true;');
    expect(script).toContain('if (e.nameVariant === "legacy-mip-xxxx") {');
    // MIP-0018 section 2.1's sixth type has a name on the page: Null is not "5 reserved" any more.
    expect(script).toContain('var names = ["opaque", "text", "integer", "JSON", "URI", "Null"];');
    // Both explanatory notes are present, each under the table it explains.
    expect(script).toContain("a key marked pre-MIP name was set by an event carrying the superseded draft name ");
    expect(script).toContain("an event marked pre-MIP name carried the superseded draft name ");

    // ── 00023: the CSP hashes are the hashes of the bytes it serves ──────────────────────────
    const csp = res.headers.get("content-security-policy") ?? "";
    const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("base64");
    // Not "a hash is present" but "this hash is of this block": a policy that drifted from the
    // code it authorises would leave the page blank in a browser and green in every other test.
    expect(csp).toContain(`script-src 'sha256-${sha256(script)}'`);
    expect(csp).toContain(`style-src 'sha256-${sha256(style)}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it("serves a page with no external resource of any kind", async () => {
    const body = await (await fetch(`${base}/ui`)).text();

    // No absolute URL except the notice's four outbound links: not in a tag, not in a comment, not
    // in a string the script builds a link from. Those four are <a> navigations a person follows,
    // opened in a new tab without an opener or referrer — never a resource the page loads.
    const OUTBOUND = [
      "https://github.com/midnightntwrk/midnight-improvement-proposals/pull/325",
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

  /**
   * 00023 Phase E, the owner's two style decisions after the live review: "let's make it light"
   * and "let's make the tags of different colours".
   *
   * These are not colour-taste assertions. Two things are pinned because breaking either makes the
   * page unreadable while every other test stays green: (a) the palette is **light** — one theme,
   * no `prefers-color-scheme` branch, and none of the black page's surface values left behind in a
   * rule the light palette no longer feeds; (b) every text colour the page uses clears **WCAG AA**
   * on the surface it actually sits on, computed here from the served CSS custom properties rather
   * than from a table someone kept up to date by hand. A brand pass that darkens one tint until a
   * chip stops being legible fails this test.
   */
  it("ships one light palette, a distinct hue per tag, and WCAG AA on every pair", async () => {
    const body = await (await fetch(`${base}/ui`)).text();
    const style = /<style>([\s\S]*?)<\/style>/.exec(body)?.[1] ?? "";
    const script = /<script>([\s\S]*?)<\/script>/.exec(body)?.[1] ?? "";

    // ── the custom properties, as the browser would resolve them ────────────────────────────
    const declared = new Map<string, string>();
    for (const m of style.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
      declared.set(m[1] ?? "", (m[2] ?? "").trim());
    }
    const resolve = (name: string): string => {
      let value = declared.get(name);
      for (let hop = 0; hop < 8 && value !== undefined && value.startsWith("var("); hop += 1) {
        value = declared.get(value.slice(4, -1).trim());
      }
      expect(value, `${name} must resolve to a colour`).toMatch(/^#[0-9a-f]{6}$/);
      return value ?? "";
    };
    const luminance = (hex: string): number => {
      const channel = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const r = channel(parseInt(hex.slice(1, 3), 16));
      const g = channel(parseInt(hex.slice(3, 5), 16));
      const b = channel(parseInt(hex.slice(5, 7), 16));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string): number => {
      const la = luminance(a), lb = luminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    // (a) LIGHT, and light only. The page's ground is white and its ink is black — the two roles
    // the black page had the other way round — and there is no second theme to fall into.
    expect(declared.get("--bg")).toBe("var(--md-white)");
    expect(declared.get("--ink")).toBe("var(--md-black)");
    expect(luminance(resolve("--bg"))).toBeGreaterThan(0.9);
    expect(luminance(resolve("--ink"))).toBeLessThan(0.05);
    expect(style).not.toContain("prefers-color-scheme");
    // The brand accent is untouched: the palette turned over, the one blue did not.
    expect(declared.get("--md-blue")).toBe("#0000fe");
    expect(declared.get("--accent")).toBe("var(--md-blue)");
    // …and the black page's surfaces are gone from the stylesheet, not merely unused by :root.
    for (const dark of ["#111111", "#161616", "#262626", "#333333", "#1a1a1a", "#0e0e0e",
      "#0c0c0c", "#0b0b33", "#1a0d0d", "#ffd6d6", "#5c5c5c", "#ff5c5c", "#9a9a9a"]) {
      expect(style, `${dark} is a dark-theme value and must not survive`).not.toContain(dark);
    }

    // (b) one hue per meaning, and the same hue wherever that meaning appears.
    const TAGS = ["builtin", "observed", "declared", "described", "seen", "unknown",
      "shielded", "unshielded", "ledger", "collection", "dual", "bad"];
    const fgs = new Set<string>();
    for (const tag of TAGS) {
      const fg = resolve(`--tag-${tag}-fg`);
      const bg = resolve(`--tag-${tag}-bg`);
      resolve(`--tag-${tag}-bd`);
      fgs.add(fg);
      expect(contrast(fg, bg), `tag ${tag}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // Twelve meanings, twelve hues: a tag that shares another's text colour says nothing.
    expect(fgs.size).toBe(TAGS.length);
    // Each badge and chip reads its own triple, so the block above is the only place to edit.
    for (const [selector, tag] of [[".st-builtin", "builtin"], [".st-observed", "observed"],
      [".st-declared", "declared"], [".st-described", "described"], [".st-seen", "seen"],
      [".st-unknown", "unknown"], [".fam-shielded", "shielded"], [".fam-unshielded", "unshielded"],
      [".fam-ledger", "ledger"], [".fam-collection", "collection"], [".fam-dual", "dual"],
      [".chip.nocount", "bad"]] as const) {
      const rule = style.slice(style.indexOf(`${selector} {`));
      expect(rule.slice(0, rule.indexOf("}")), `${selector} must use --tag-${tag}-*`)
        .toContain(`var(--tag-${tag}-fg)`);
    }
    // A ledger token's chip keeps its dashed edge, and so does a colour nobody has named.
    expect(style).toMatch(/\.fam-ledger \{[^}]*border-style: dashed/);
    expect(style).toMatch(/\.st-seen \{[^}]*border-style: dashed/);

    // The transactions table's "what happened" word carries the hue of the row's own direction,
    // as text only — the amount and the counterparty beside it stay uncoloured.
    expect(script).toContain("function directionClass(");
    expect(script).toContain('return "dir-mint"');
    expect(script).toContain('return "dir-pool"');
    expect(script).toContain('return "dir-in"');
    expect(script).toContain('return "dir-out"');
    for (const [rule, tag] of [[".dir-in", "described"], [".dir-out", "observed"],
      [".dir-pool", "shielded"], [".dir-mint", "collection"]] as const) {
      expect(style).toContain(`${rule} { color: var(--tag-${tag}-fg); }`);
    }
    const surfaces = ["--bg", "--panel", "--panel2", "--hover", "--zebra", "--det"].map(resolve);
    for (const name of ["--tag-described-fg", "--tag-observed-fg", "--tag-shielded-fg",
      "--tag-collection-fg"]) {
      for (const surface of surfaces) {
        expect(contrast(resolve(name), surface), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }

    // Body text, secondary text and the error colour on every surface they can land on.
    for (const surface of surfaces) {
      expect(contrast(resolve("--ink"), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(resolve("--dim"), surface), `--dim on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(resolve("--bad"), resolve("--panel"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve("--bad-fg"), resolve("--bad-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve("--ink"), resolve("--tint-notice"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve("--accent"), resolve("--tint-blue"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve("--accent"), resolve("--tint-notice"))).toBeGreaterThanOrEqual(3);
    expect(contrast(resolve("--md-white"), resolve("--accent"))).toBeGreaterThanOrEqual(4.5);
    // A control's edge is not text, so its bar is the 3:1 of WCAG 1.4.11 — and it must clear it,
    // because a hairline that vanishes on white makes an input look like a label.
    expect(contrast(resolve("--ctl"), resolve("--bg"))).toBeGreaterThanOrEqual(3);
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
