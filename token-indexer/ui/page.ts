import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The token explorer: one self-contained HTML page, served by the token-indexer API process at
 * `GET /ui` (spec `00020-token-indexer` §8, US4; sub-plan `00020-03` Phase 1).
 *
 * ── Why a string constant and not a file, a template or a bundle ─────────────────────────────
 * The repository's dependency-minimalism rule (`design/design.md` §7) and the owner's decision
 * Q2 ("keep it there for now") both land on the same shape as the 00009 dashboard
 * (`shielded-monitor/api/ui/page.ts`, the precedent this module copies): **no framework, no
 * bundler, no CSS library, no icon font, no web font, no external resource of any kind**, and
 * `package.json` is unchanged by the change that adds it. A string compiled into the module
 * cannot be lost by `tsc`, by an asset-copy script or by `npm pack`.
 *
 * One deliberate exception, for the Midnight brand look: the brand face **Outfit** (SIL OFL,
 * `ui/fonts/OFL.txt`) is vendored beside this module and served by this same process at
 * `GET /ui/outfit.woff2` — same origin, so `font-src 'self'` and still no external resource. The
 * palette and the inline logo come from the Midnight style kit (the 2026 external presentation
 * template, p.28 colours, p.32 logo). If the font file is missing the page falls back to the
 * system sans stack and nothing else changes.
 *
 * The proof-of-concept notice at the top links out to four GitHub pages (the MIP's PR, this
 * indexer's PR, the example contracts and the deployed token addresses). Those are plain `<a>` navigations a person chooses to follow, not resources the
 * page loads: `default-src 'none'` still stops the page from fetching anything off its origin.
 *
 * ── What it talks to ────────────────────────────────────────────────────────────────────────
 * Only the **relative** routes of spec §5, on its own origin:
 *
 *   GET /v1/tokens?kind&storage&status&q&limit&cursor
 *   GET /v1/colors/:color                              (the list's "API" column links here)
 *   GET /v1/contracts/:address
 *   GET /v1/contracts/:address/events?applied=false
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind/metadata
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind/mints?limit&cursor
 *   GET /internal/status
 *
 * and, since 00023 (spec `00023-token-transactions` §5, US1/US2/US4/US5/US7):
 *
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind/transactions?role&limit&cursor
 *   GET /v1/colors/:color/transactions?kind&role&limit&cursor   (a colour with no contract yet)
 *   GET /v1/contracts/:address/calls?limit&cursor               (a ledger token's public activity)
 *   GET /v1/transactions/:hash                                  (the whole public decode)
 *   GET /v1/shielded-offers?undisclosed&limit&cursor            (what the ledger does not say)
 *
 * with four hash routes on top of the three it had: `#/tx/<hash>`, `#/shielded-offers` and
 * `#/color/<color>/<kind>` (the page of a colour whose mint predates the archive, US5).
 *
 * A `tokenUri` that points at `localhost:<any port>` is rewritten to this page's own origin
 * before it is rendered (spec §8 and FR-013: the reference Constellations pieces bake
 * `localhost:10020` into their metadata, and the API may well be listening somewhere else), so
 * clicking a piece's URI opens the resolver document `GET /{token-name}/{id}` of *this* process.
 *
 * ── Safety properties this module holds on purpose ──────────────────────────────────────────
 * Every value that reaches the document goes through `textContent`: there is no `innerHTML`
 * assignment anywhere in this file, so nothing a response carries — on a public chain every
 * payload is a stranger's bytes — can become markup. The CSP below is computed from the very
 * bytes that are served, so it admits exactly this page's own script and style and nothing else;
 * `default-src 'none'` means an injected reference to any other origin fetches nothing.
 *
 * ── Layout of this file ─────────────────────────────────────────────────────────────────────
 * `STYLE`, `SCRIPT` and `BODY` are separate constants; the first two are hashed into the CSP.
 * Note for editors: `SCRIPT` is a TypeScript template literal, so it deliberately contains **no
 * backslash escape, no backtick and no `${`** — a `\d` written here would be cooked away into a
 * plain `d` before the browser ever saw it. That is why the code below parses hex, URIs and the
 * hash route by hand instead of with regular expressions.
 */

// ── Style ────────────────────────────────────────────────────────────────────────────────────

const STYLE = `
/* Midnight brand (the 2026 external presentation template, p.28 palette): black surface, white
   type, one blue. Outfit is the brand face and is served by this process from /ui/outfit.woff2;
   hex, heights and amounts stay monospaced because they are data to compare, not prose. */
@font-face {
  font-family: "Outfit"; font-style: normal; font-weight: 100 900; font-display: swap;
  src: url("/ui/outfit.woff2") format("woff2");
}
:root {
  --md-black: #0a0a0a; --md-white: #ffffff; --md-blue: #0000fe; --md-grey: #cccccc;
  --md-grey-light: #e6e6e6; --md-muted: #9a9a9a;
  --bg: var(--md-black); --panel: #111111; --panel2: #161616; --line: #262626; --rule: #333333;
  --ink: var(--md-white); --dim: var(--md-muted); --accent: var(--md-blue);
  --bad: #ff5c5c; --violet: var(--md-grey);
  --sans: "Outfit", "Avenir Next", "Century Gothic", ui-sans-serif, system-ui, -apple-system,
    "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
/* A display rule on an element beats the user agent's [hidden] rule, and the filter bar is a
   flex container that the token/contract/status views hide — so say it once, loudly. */
[hidden] { display: none !important; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.55 var(--sans); -webkit-font-smoothing: antialiased;
}
a { color: var(--ink); text-decoration: underline; text-decoration-color: var(--rule);
  text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--ink); }
code { font-family: var(--mono); font-size: 0.92em; }
header { padding: 22px 28px 0; border-bottom: 1px solid var(--rule); }
.brand { display: flex; align-items: center; gap: 14px; color: var(--ink); }
.brand svg { height: 22px; width: auto; display: block; }
.brand .rule { width: 1px; height: 22px; background: var(--rule); }
h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.015em; }
nav.tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 18px 0 0; }
nav.tabs a { padding: 8px 16px; color: var(--dim); text-decoration: none; font-weight: 500;
  border-bottom: 2px solid transparent; margin-bottom: -1px; }
nav.tabs a:hover { color: var(--ink); }
nav.tabs a.on { color: var(--ink); border-bottom-color: var(--accent); }
nav.tabs .sep { flex: 1 1 auto; }
.strip { color: var(--dim); font-size: 12px; white-space: nowrap; }
.strip b { color: var(--ink); font-weight: 600; font-family: var(--mono); font-size: 11.5px; }
/* The proof-of-concept notice: the palette's light grey, the one surface on this page that is not
   dark, so it is read first. Blue rule on the left, as the template marks a callout. */
.poc { margin: 18px 28px 0; padding: 14px 18px 14px 16px; background: var(--md-grey-light);
  color: var(--md-black); border-left: 4px solid var(--accent); font-size: 13.5px; line-height: 1.6; }
.poc p { margin: 6px 0 0; max-width: 110ch; }
.poc-h { font-weight: 700; font-size: 14px; letter-spacing: 0.01em; color: var(--accent); }
.poc a { color: var(--md-black); text-decoration-color: var(--accent); text-decoration-thickness: 2px; }
.poc a:hover { color: var(--accent); }
.poc code { background: rgba(0, 0, 0, 0.07); padding: 0 4px; }
.poc { position: relative; padding-right: 90px; }
.poc-x { position: absolute; top: 10px; right: 12px; padding: 3px 10px; font-size: 11.5px;
  font-weight: 600; letter-spacing: 0.06em; color: var(--md-black); border-color: var(--md-black); }
.poc-x:hover:enabled { background: var(--md-black); color: var(--md-white); border-color: var(--md-black); }
.poc-links { list-style: none; margin: 10px 0 0; padding: 0; font-weight: 500; display: flex;
  flex-wrap: wrap; gap: 2px 24px; margin-right: -72px; }
.banner { margin: 14px 28px 0; padding: 10px 14px; border: 1px solid var(--bad);
  background: #1a0d0d; color: #ffd6d6; font-size: 13px; white-space: pre-wrap; }
.filters { display: flex; gap: 14px; align-items: end; flex-wrap: wrap; padding: 18px 28px 0; }
.filters label { color: var(--dim); font-size: 12px; font-weight: 500; display: flex;
  flex-direction: column; gap: 5px; }
main { padding: 18px 28px 56px; display: grid; gap: 18px; }
section { background: var(--panel); border: 1px solid var(--line); padding: 18px 20px; }
h2 { margin: 0 0 14px; font-size: 13px; font-weight: 500; color: var(--dim); letter-spacing: 0.02em; }
h3 { margin: 0 0 6px; font-size: 20px; font-weight: 700; letter-spacing: -0.012em; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--dim); font-weight: 500; font-size: 12px; padding: 6px 10px 8px;
  border-bottom: 1px solid var(--rule); white-space: nowrap; }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
tr:last-child td { border-bottom: none; }
tbody tr.pick { cursor: pointer; }
tbody tr.pick:hover td { background: #1a1a1a; }
tr.built td { background: #0e0e0e; }
tr.mark td { background: #0b0b33; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 5px 18px; font-size: 13px; }
.kv .k { color: var(--dim); }
.num { text-align: right; font-family: var(--mono); font-size: 12.5px; font-variant-numeric: tabular-nums; }
/* Status, in palette only: builtin outlined white, observed outlined grey, declared on the light
   grey, described on the brand blue — the more a contract has said, the more ink it gets. */
.badge { display: inline-block; padding: 1px 9px; font-size: 11.5px; font-weight: 500; border: 1px solid; }
.st-builtin { color: var(--ink); border-color: var(--ink); background: transparent; }
.st-observed { color: var(--dim); border-color: var(--rule); background: transparent; }
.st-declared { color: var(--md-black); border-color: var(--md-grey-light); background: var(--md-grey-light); }
.st-described { color: var(--md-white); border-color: var(--accent); background: var(--accent); }
.st-unknown { color: var(--dim); border-color: var(--line); background: var(--panel2); }
.fam { display: inline-block; min-width: 0; padding: 0 7px; margin-right: 6px; font-size: 11px;
  font-weight: 500; border: 1px solid var(--rule); color: var(--md-grey); }
.fam-ledger { border-style: dashed; }
.fam-shielded { color: var(--md-white); border-color: #5c5c5c; }
.fam-unshielded { color: var(--md-grey); }
.fam-collection { color: var(--md-white); border-color: var(--accent); }
.fam-dual { color: var(--md-white); border-color: var(--md-grey); }
.multi { display: inline-block; margin-left: 8px; padding: 0 7px; font-family: var(--sans);
  font-size: 11px; font-weight: 500; color: var(--md-white); background: rgba(0, 0, 254, 0.28);
  border: 1px solid var(--accent); cursor: default; }
.multi:focus { outline: 1px solid var(--md-white); outline-offset: 1px; }
.tip { position: fixed; z-index: 50; max-width: 380px; padding: 10px 12px; background: var(--panel2);
  border: 1px solid var(--rule); color: var(--ink); font-size: 12.5px; line-height: 1.6;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.6); pointer-events: none; }
.tip .hex, .tip .here { font-family: var(--mono); font-size: 12px; }
.tip .here { color: var(--md-white); }
.tip .hex { color: var(--dim); }
td.apicol { text-align: center; }
.api { display: inline-flex; padding: 3px; color: var(--dim); border: 1px solid transparent; }
.api:hover { color: var(--md-white); border-color: var(--accent); background: rgba(0, 0, 254, 0.28); }
.api svg { display: block; }
.cp { cursor: pointer; text-decoration: underline dotted; text-decoration-color: #5c5c5c;
  text-underline-offset: 3px; }
.cp.copied { color: var(--md-white); background: var(--accent); text-decoration: none; }
.cp.copyfail { color: var(--bad); }
.cpbuf { position: fixed; top: -1000px; left: -1000px; opacity: 0; }
.note { color: var(--dim); font-size: 12px; }
.err { color: var(--bad); font-size: 12.5px; }
.empty { color: var(--dim); padding: 12px 2px; font-size: 13px; }
.txt { color: var(--ink); }
/* A projection that Appendix A refused: the trait is real and kept, the column it would feed is
   not written. Shown as a warning, never as an error — the event itself was applied. */
.perr { color: var(--md-grey); text-decoration: underline wavy #5c5c5c; }
.vtype { color: var(--dim); font-size: 11.5px; }
.hex { color: var(--dim); font-family: var(--mono); font-size: 12.5px; }
.no { color: var(--dim); }
pre { margin: 0; padding: 12px 14px; background: var(--bg); border: 1px solid var(--line);
  font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word;
  max-height: 420px; overflow: auto; }
button { font: inherit; font-size: 13px; font-weight: 500; padding: 7px 14px; cursor: pointer;
  background: transparent; color: var(--ink); border: 1px solid var(--rule); }
button:hover:enabled { border-color: var(--ink); }
button:disabled { opacity: 0.4; cursor: default; }
button#now { background: var(--accent); border-color: var(--accent); color: var(--md-white); }
button#now:hover:enabled { background: #0000c4; border-color: #0000c4; }
input, select { font: inherit; font-size: 13.5px; padding: 7px 10px; background: var(--bg);
  color: var(--ink); border: 1px solid var(--rule); border-radius: 0; }
input::placeholder { color: #5c5c5c; }
input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.crumb { color: var(--dim); font-size: 13px; margin-bottom: 10px; }
.wrapv { white-space: normal; word-break: break-word; max-width: 46ch; }
/* ── 00023: activity rows, the disclosure panel, the calls note, the transaction view ───────
   A colour seen in public data before any mint named it (status seen, US5) is marked with a
   dashed badge: the row is real, the contract behind it is not known. */
.st-seen { color: var(--md-white); border-color: var(--md-grey); border-style: dashed;
  background: transparent; }
.pill { display: inline-block; margin-left: 8px; padding: 0 7px; font-size: 11px; font-weight: 500;
  color: var(--md-grey); border: 1px dashed var(--rule); }
/* The disclosure panel (US4): two columns, public on the brand blue rule, private on grey. It is
   the screen the owner wants to show, so it is the one place a section carries real prose. */
.disc { display: grid; grid-template-columns: 1fr 1fr; gap: 0 26px; margin-top: 14px; }
.disc > div { border-top: 2px solid var(--rule); padding-top: 10px; }
.disc .pub { border-top-color: var(--accent); }
.disc h4 { margin: 0 0 8px; font-size: 13px; font-weight: 700; letter-spacing: 0.01em; }
.disc ul { margin: 0; padding-left: 18px; }
.disc li { margin: 4px 0; font-size: 13px; }
.disc .pri li { color: var(--md-grey); }
.counts { display: flex; gap: 26px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px;
  border-top: 1px solid var(--line); align-items: baseline; }
.counts b { font-family: var(--mono); font-size: 16px; color: var(--ink); }
.warnnote { margin: 0 0 12px; padding: 11px 14px; border-left: 4px solid var(--accent);
  background: var(--panel2); color: var(--md-grey-light); font-size: 13px; line-height: 1.6; }
.warnnote b { color: var(--md-white); }
.chip { display: inline-block; padding: 0 7px; font-size: 11px; font-weight: 500;
  border: 1px solid var(--rule); color: var(--dim); }
.chip.nocount { color: var(--bad); border-color: var(--bad); }
tr.det td { background: #0c0c0c; white-space: normal; }
.det-grid { display: grid; grid-template-columns: max-content 1fr; gap: 5px 18px; font-size: 12.5px;
  margin: 6px 0 4px; }
.det-grid .k { color: var(--dim); }
.amt { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.expand { padding: 1px 9px; font-size: 11.5px; }
.txsec { margin-top: 14px; }
.txsec:first-child { margin-top: 0; }
.txsec > .h { color: var(--dim); font-size: 12px; margin-bottom: 6px; }
@media (max-width: 880px) { .disc { grid-template-columns: 1fr; } }
`;

// ── Behaviour ────────────────────────────────────────────────────────────────────────────────
//
// Plain ES2017: `var`, function declarations, `async`/`await`, no module syntax, no template
// literal, no regular expression and no backslash (see the file header for why).

const SCRIPT = `
"use strict";

// Every API path this page uses, spelled out as literals so a route-coverage test can read them
// off the served document and check each one against the server's own table:
//   GET /v1/tokens
//   GET /v1/colors/:color
//   GET /v1/contracts/:address
//   GET /v1/contracts/:address/events?applied=false
//   GET /v1/contracts/:address/tokens/:domainSep/:kind
//   GET /v1/contracts/:address/tokens/:domainSep/:kind/metadata
//   GET /v1/contracts/:address/tokens/:domainSep/:kind/mints
//   GET /v1/contracts/:address/tokens/:domainSep/:kind/transactions   (00023, FR-006)
//   GET /v1/colors/:color/transactions                                (00023, FR-008)
//   GET /v1/contracts/:address/calls                                  (00023, FR-020)
//   GET /v1/transactions/:hash                                        (00023, FR-007)
//   GET /v1/shielded-offers                                           (00023, FR-018)
//   GET /internal/status
var P_TOKENS = "/v1/tokens";
var P_COLORS = "/v1/colors";
var P_CONTRACTS = "/v1/contracts";
var P_TXS = "/v1/transactions";
var P_OFFERS = "/v1/shielded-offers";
var P_STATUS = "/internal/status";

var REFRESH_MS = 10000;
var LIST_LIMIT = 200;
var MINT_LIMIT = 200;
var ACT_LIMIT = 200;
var CALL_LIMIT = 200;
var OFFER_LIMIT = 200;

var state = {
  route: { view: "list" },
  filters: { kind: "", storage: "", status: "", q: "" },
  list: { items: [], nextCursor: null, loaded: false },
  detail: null,
  contract: null,
  status: null,
  // 00023: the transactions section's own controls, kept outside "detail" so a 10 s refresh does
  // not throw away a role filter, a loaded page or an opened offer.
  act: { role: "", pages: 1, expand: {} },
  tx: null,
  offers: { items: [], nextCursor: null, loaded: false, undisclosed: "true", pages: 1 },
  scrollTo: null,
  errors: [],
  lastOk: null,
  paused: false,
  timer: null,
  debounce: null,
  busy: false
};

// ── DOM helpers (textContent only; this file assigns no markup anywhere) ────────────────────

function el(id) { return document.getElementById(id); }
function node(tag, text, cls) {
  var n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
}
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
function cell(row, child, cls) {
  var td = document.createElement("td");
  if (cls) td.className = cls;
  if (child === null || child === undefined) td.textContent = "-";
  else if (typeof child === "object" && child.nodeType) td.appendChild(child);
  else td.textContent = String(child);
  row.appendChild(td);
  return td;
}
function headRow(table, labels) {
  var thead = document.createElement("thead");
  var tr = document.createElement("tr");
  for (var i = 0; i < labels.length; i++) tr.appendChild(node("th", labels[i]));
  thead.appendChild(tr);
  table.appendChild(thead);
  return thead;
}
function tableIn(parent, labels) {
  var wrap = node("div", null, "scroll");
  var table = document.createElement("table");
  headRow(table, labels);
  var tbody = document.createElement("tbody");
  table.appendChild(tbody);
  wrap.appendChild(table);
  parent.appendChild(wrap);
  return tbody;
}
function enc(v) { return encodeURIComponent(String(v === null || v === undefined ? "" : v)); }

// ── Values ──────────────────────────────────────────────────────────────────────────────────

function isHex(s) {
  if (typeof s !== "string" || s.length === 0 || s.length % 2 !== 0) return false;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    var ok = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!ok) return false;
  }
  return true;
}
function hexBytes(s) {
  var out = [];
  for (var i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}
// A domain separator / key / value is 32 NUL-padded bytes more often than not, and reads far
// better as its text ("cnst:orion") than as 64 hex characters. Printable ASCII only: anything
// else stays hex, so no byte string can pretend to be a name.
function hexText(s) {
  if (!isHex(s)) return null;
  var b = hexBytes(s);
  while (b.length > 0 && b[b.length - 1] === 0) b.pop();
  if (b.length === 0) return null;
  var out = "";
  for (var i = 0; i < b.length; i++) {
    var v = b[i];
    if (v < 32 || v > 126) return null;
    out += String.fromCharCode(v);
  }
  return out;
}
function shortHex(s, head, tail) {
  if (typeof s !== "string" || s.length === 0) return "-";
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}
function slug(s) {
  var out = "";
  var low = String(s === null || s === undefined ? "" : s).toLowerCase();
  for (var i = 0; i < low.length; i++) {
    var c = low.charAt(i);
    var code = low.charCodeAt(i);
    var alnum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (alnum) out += c;
    else if (out.length > 0 && out.charAt(out.length - 1) !== "-") out += "-";
  }
  while (out.length > 0 && out.charAt(out.length - 1) === "-") out = out.slice(0, out.length - 1);
  return out;
}
function orDash(v) { return v === null || v === undefined || v === "" ? "-" : String(v); }

// ── Copy to clipboard ───────────────────────────────────────────────────────────────────────

function copyable(value, label, cls) {
  var text = label === null || label === undefined ? "-" : String(label);
  var s = node("span", text, cls ? "cp " + cls : "cp");
  if (value === null || value === undefined || value === "") { s.className = cls || ""; return s; }
  s.title = String(value) + "  (click to copy)";
  s.addEventListener("click", function (ev) { ev.stopPropagation(); copyValue(String(value), s); });
  return s;
}
function copyValue(value, target) {
  var base = target.className;
  function flash(ok) {
    target.className = base + (ok ? " copied" : " copyfail");
    window.setTimeout(function () { target.className = base; }, 900);
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { flash(true); },
        function () { selectFallback(value, flash); });
      return;
    }
  } catch (e) { /* fall through to the selection fallback */ }
  selectFallback(value, flash);
}
// No clipboard API (or no permission): park the value in an off-screen read-only field and select
// it, so it can be copied with the keyboard. Nothing leaves the page either way.
function selectFallback(value, flash) {
  var ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "readonly");
  ta.className = "cpbuf";
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  flash(ok);
}

// ── Fetch ───────────────────────────────────────────────────────────────────────────────────

async function api(path) {
  var res = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
  var body = await res.text();
  var parsed = null;
  if (body !== "") { try { parsed = JSON.parse(body); } catch (e) { parsed = null; } }
  if (!res.ok) {
    var code = parsed && parsed.error && parsed.error.code ? parsed.error.code : "HTTP_" + res.status;
    var err = new Error(res.status + " " + code + ": " + path);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return parsed;
}
// The §5 collections answer { items: [...] } (and /metadata answers { keys: [...] }); a bare array
// is accepted too, so a small shape difference in the API never blanks a panel.
function itemsOf(payload) {
  if (!payload) return [];
  if (Object.prototype.toString.call(payload) === "[object Array]") return payload;
  if (payload.items && Object.prototype.toString.call(payload.items) === "[object Array]") return payload.items;
  if (payload.keys && Object.prototype.toString.call(payload.keys) === "[object Array]") return payload.keys;
  if (payload.events && Object.prototype.toString.call(payload.events) === "[object Array]") return payload.events;
  if (payload.tokens && Object.prototype.toString.call(payload.tokens) === "[object Array]") return payload.tokens;
  return [];
}
function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
function arr(v) { return isArray(v) ? v : []; }
// A collection the API may send either as an array or as a map keyed by segment (spec §4 names
// "fallibleOffer: Map<segment, ZswapOffer>" and "intents: Map<segment, Intent>"; question Q15).
// Either way this hands back a list whose items carry their segment.
function segList(v) {
  if (isArray(v)) return v;
  if (!v || typeof v !== "object") return [];
  var out = [];
  for (var k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    var item = v[k];
    if (!item || typeof item !== "object") continue;
    var copy = {};
    for (var p in item) if (Object.prototype.hasOwnProperty.call(item, p)) copy[p] = item[p];
    if (copy.segment === undefined || copy.segment === null) copy.segment = Number(k);
    out.push(copy);
  }
  return out;
}
function count(v) { return isArray(v) ? v.length : (v === null || v === undefined ? 0 : Number(v)); }

// ── 00023: amounts, roles, wallet addresses ─────────────────────────────────────────────────

// Exact by construction (FR-014): the API sends the raw integer as a decimal string and the token
// its decimals, so the point is placed by hand. No Number(), no rounding, no locale — a token with
// 18 decimals would lose its low digits to a float before it ever reached the screen.
function formatUnits(amount, decimals) {
  var s = String(amount === null || amount === undefined ? "" : amount);
  if (s === "") return "-";
  var sign = "";
  if (s.charAt(0) === "-") { sign = "-"; s = s.slice(1); }
  var d = decimals === null || decimals === undefined ? 0 : Number(decimals);
  if (!(d > 0)) return sign + s;
  while (s.length <= d) s = "0" + s;
  return sign + s.slice(0, s.length - d) + "." + s.slice(s.length - d);
}
function decimalsOf(a, t) {
  if (t && t.decimals !== null && t.decimals !== undefined) return t.decimals;
  if (a && a.token && a.token.decimals !== null && a.token.decimals !== undefined) return a.token.decimals;
  return null;
}
// The row's amount in the token's decimals; the raw units are on hover (FR-009). A shielded delta
// is stored unsigned with a direction, and the ledger's own sign is restored here: value entering
// the pool is a negative delta (spec §0), which is what a reader comparing with the chain expects.
function amountCell(a, t) {
  var dec = decimalsOf(a, t);
  var sign = a.direction === "pool_in" ? "-" : (a.direction === "pool_out" ? "+" : "");
  var s = node("span", sign + formatUnits(a.amount, dec), "amt");
  var title = String(a.amount) + " raw units";
  if (dec !== null && dec !== undefined) title += "  ·  decimals " + dec;
  if (a.role === "shielded_delta") title += "  ·  offer delta " + sign + String(a.amount);
  s.title = title;
  return s;
}
var ROLES = [
  ["", "all"],
  ["utxo_out", "UTXO created"],
  ["utxo_in", "UTXO spent"],
  ["contract_in", "received by contract"],
  ["contract_out", "paid by contract"],
  ["mint", "minted"],
  ["shielded_delta", "shielded pool delta"],
  ["reward", "reward"]
];
function roleLabel(a) {
  if (a.role === "shielded_delta") {
    return a.direction === "pool_out" ? "out of the shielded pool" : "into the shielded pool";
  }
  for (var i = 1; i < ROLES.length; i++) if (ROLES[i][0] === a.role) return ROLES[i][1];
  return String(a.role);
}
// Q9: a wallet address is shown as Bech32m and only as Bech32m. The human-readable part names the
// network and is kept whole; the data part is elided in the middle. The API also sends "ownerHex",
// which this page never displays.
function shortAddr(s) {
  var v = String(s === null || s === undefined ? "" : s);
  if (v === "") return "-";
  var cut = v.lastIndexOf("1");
  if (cut < 1 || v.length - cut < 16) return v;
  return v.slice(0, cut + 1) + v.slice(cut + 1, cut + 6) + "…" + v.slice(v.length - 5);
}
function ownerCell(owner) {
  if (!owner) return node("span", "-", "no");
  return copyable(owner, shortAddr(owner), "hex");
}
function contractLink(address, label) {
  if (!address) return node("span", "-", "no");
  var a = node("a", label === undefined || label === null ? shortHex(address, 8, 6) : label, "hex");
  a.href = hashContract(address);
  a.title = address + " (open the contract)";
  a.addEventListener("click", function (ev) { ev.stopPropagation(); });
  return a;
}
function txLink(hash) {
  if (!hash) return node("span", "-", "no");
  var a = node("a", shortHex(hash, 8, 6), "hex");
  a.href = hashTx(hash);
  a.title = hash + " (open the whole transaction)";
  a.addEventListener("click", function (ev) { ev.stopPropagation(); });
  return a;
}
function colorLink(color, kind) {
  if (!color) return node("span", "-", "no");
  var a = node("a", shortHex(color, 8, 6), "hex");
  a.href = hashColor(color, kind === null || kind === undefined ? 0 : kind);
  a.title = color + " (open the token of this colour)";
  a.addEventListener("click", function (ev) { ev.stopPropagation(); });
  return a;
}
function hexListCell(values, key) {
  var list = arr(values);
  if (list.length === 0) return node("span", "none", "no");
  var wrap = node("span");
  for (var i = 0; i < list.length; i++) {
    var v = key === undefined ? list[i] : list[i][key];
    if (i > 0) wrap.appendChild(node("span", "  "));
    if (!v) wrap.appendChild(node("span", "-", "no"));
    else wrap.appendChild(copyable(v, shortHex(String(v), 8, 6), "hex"));
  }
  return wrap;
}
function countedChip(counted) {
  if (counted === false) {
    var c = node("span", "not counted", "chip nocount");
    c.title = "this section did not count: the transaction failed or its fallible segment did "
      + "(spec FR-002, Q10). No activity row is stored for it; the transaction is shown whole.";
    return c;
  }
  return node("span", "counted", "chip");
}
// Spec §5: the API states what a token's page can honestly show. The fallback derives the same
// answer from the row itself, so the page still renders against an API that has not caught up.
function visibilityOf(t) {
  if (!t) return "full";
  if (t.shieldedVisibility) return String(t.shieldedVisibility);
  if (t.storage === "ledger") return "calls-only";
  if (t.status === "builtin" && !t.color) return "not-tracked";
  return Number(t.kind) === 1 ? "disclosed-imbalances" : "full";
}
var VISIBILITY = {
  "full": "everything: every UTXO and every contract flow of this colour is public",
  "disclosed-imbalances": "the offers whose imbalance names this colour, and nothing about the coins",
  "calls-only": "its contract's calls; balances live in contract state this indexer does not read",
  "not-tracked": "not tracked per token: every transaction pays a DUST fee"
};
function visibilityCell(t) {
  var v = visibilityOf(t);
  var s = node("span", v + " — " + (VISIBILITY[v] ? VISIBILITY[v] : "unknown"), "wrapv");
  return s;
}
// FR-013's five counters: read from "counters" first, then from the top level (question Q16).
function counterOf(st, name) {
  if (!st) return null;
  var c = st.counters || {};
  if (c[name] !== undefined && c[name] !== null) return c[name];
  if (st[name] !== undefined && st[name] !== null) return st[name];
  return null;
}

// ── Routing (hash only: the page is one document and every view is bookmarkable) ────────────

function parseHash() {
  var h = window.location.hash || "";
  if (h.charAt(0) === "#") h = h.slice(1);
  var raw = h.split("/");
  var parts = [];
  for (var i = 0; i < raw.length; i++) {
    if (raw[i] === "") continue;
    try { parts.push(decodeURIComponent(raw[i])); } catch (e) { parts.push(raw[i]); }
  }
  if (parts.length === 0) return { view: "list" };
  if (parts[0] === "status") return { view: "status" };
  if (parts[0] === "shielded-offers") return { view: "offers" };
  if (parts[0] === "tx" && parts.length >= 2) return { view: "tx", hash: parts[1] };
  if (parts[0] === "contract" && parts.length >= 2) return { view: "contract", address: parts[1] };
  if (parts[0] === "token" && parts.length >= 4) {
    return { view: "token", address: parts[1], domainSep: parts[2], kind: parts[3] };
  }
  // US5: a colour whose mint predates the archive has no (address, domainSep) to route by, so its
  // page is the colour and the kind. When a later mint names it, the token route works as well.
  if (parts[0] === "color" && parts.length >= 3) {
    return { view: "token", color: parts[1], kind: parts[2] };
  }
  return { view: "list" };
}
function hashToken(t) {
  if (!t.address || !t.domainSep) return t.color ? hashColor(t.color, t.kind) : "#/";
  return "#/token/" + enc(t.address) + "/" + enc(t.domainSep) + "/" + enc(t.kind);
}
function hashColor(color, kind) { return "#/color/" + enc(color) + "/" + enc(kind); }
function hashTx(h) { return "#/tx/" + enc(h); }
function hashContract(a) { return "#/contract/" + enc(a); }
function routeKey(r) {
  return [r.view, r.address, r.domainSep, r.kind, r.color, r.hash].join("|");
}
function go(hash) { window.location.hash = hash; }

// ── tokenUri and the resolver ───────────────────────────────────────────────────────────────
//
// A reference piece carries "localhost:10020/constellations/orion" (spec §7.1). Whatever port
// this process actually listens on, the document it names is served by THIS origin, so the link
// is rewritten to a same-origin path. A URI on any other host is left alone and rendered as it is.

function splitUri(uri) {
  var s = String(uri === null || uri === undefined ? "" : uri);
  var low = s.toLowerCase();
  var mark = ":" + "//";
  var httpPrefix = "http" + mark;
  var httpsPrefix = "https" + mark;
  var rest = null;
  if (low.indexOf(httpPrefix) === 0) rest = s.slice(httpPrefix.length);
  else if (low.indexOf(httpsPrefix) === 0) rest = s.slice(httpsPrefix.length);
  if (rest === null) return { href: null, label: s, local: false };
  var slash = rest.indexOf("/");
  var authority = slash < 0 ? rest : rest.slice(0, slash);
  var path = slash < 0 ? "/" : rest.slice(slash);
  var host = authority.split(":")[0].toLowerCase();
  var local = host === "localhost" || host === "127.0.0.1" || host === "[" + "::1]";
  return { href: local ? path : s, label: s, local: local };
}
function uriLink(uri) {
  if (uri === null || uri === undefined || uri === "") return node("span", "-", "no");
  var parsed = splitUri(uri);
  if (parsed.href === null) return node("span", parsed.label, "hex");
  var a = node("a", parsed.label);
  a.href = parsed.href;
  a.rel = "noreferrer noopener";
  a.target = "_blank";
  a.title = (parsed.local ? "rewritten to this origin: " + parsed.href : parsed.label) + " (opens the metadata document in a new tab)";
  // A row click navigates to the token view; a click on the link itself must only open the document.
  a.addEventListener("click", function (ev) { ev.stopPropagation(); });
  return a;
}
// The page's own resolver link, GET /{token-name}/{id} (spec §5). The pretty form uses the
// symbol and the piece id ("cnst:orion" under symbol CNST is the piece "orion"); the hex form
// (address / domainSep) always resolves, so both are offered.
function resolverPaths(t) {
  var out = [];
  var sym = t.symbol ? String(t.symbol).toLowerCase() : null;
  if (sym) {
    var text = hexText(t.domainSep);
    var id = null;
    if (text !== null && text.toLowerCase().indexOf(sym + ":") === 0) id = text.slice(sym.length + 1);
    else if (t.name) id = slug(t.name);
    else if (text !== null) id = text;
    if (id) {
      var pretty = "/" + enc(sym) + "/" + enc(id);
      out.push({ label: "resolver", path: pretty, short: pretty });
    }
  }
  // The hex form always resolves (the resolver accepts the 64-hex address and domain separator), so
  // it is offered beside the pretty one — with a short label, because 130 characters of hex in a
  // link is not a link, it is a wall. It carries the KIND BYTE as a third segment: since the kind
  // is part of the identity, two rows can share an address and a domain separator, and the two
  // segment form would answer 409 for both of them.
  if (t.address && t.domainSep) {
    var kindPart = t.kind === null || t.kind === undefined ? "" : "/" + enc(t.kind);
    out.push({
      label: "resolver (hex form)",
      path: "/" + enc(t.address) + "/" + enc(t.domainSep) + kindPart,
      short: "/" + shortHex(t.address, 6, 4) + "/" + shortHex(t.domainSep, 6, 4) + kindPart
    });
  }
  return out;
}

// ── Token cells ─────────────────────────────────────────────────────────────────────────────

// MIP section 7.2 has three consumer states; builtin is this indexer's own fourth, for the two
// seeded rows. There is no state for a self-contradicting row: a declaration and a mint populate
// different rows, so a row has nothing to contradict.
function statusBadge(s) {
  var v = s ? String(s) : "unknown";
  // 00023 adds the fourth row source: a colour seen in public data whose contract is not known
  // yet (US5). It is a real row with real transactions and no name.
  var known = ["builtin", "observed", "declared", "described", "seen"];
  var cls = known.indexOf(v) < 0 ? "st-unknown" : "st-" + v;
  return node("span", v, "badge " + cls);
}
// The kind byte (MIP section 3) as the two words it encodes. The byte itself goes in the title,
// because it is the identity and a reader copying a URL needs it.
function kindLabel(t) {
  if (!t) return "-";
  var privacy = t.privacy ? String(t.privacy) : "?";
  var storage = t.storage ? String(t.storage) : "?";
  return privacy + " " + String.fromCharCode(183) + " " + storage;
}
function kindCell(t) {
  var s = node("span", kindLabel(t));
  if (t.kind !== null && t.kind !== undefined) s.title = "kind byte " + String(t.kind);
  return s;
}
// The family chip is DERIVED from the rows themselves, never from the name's first word: the
// indexer sees every contract on the chain, and most of them are not this project's reference set.
//
//   ledger      the row's storage is ledger (MIP kinds 2 and 3): no colour, never minted
//   dual        the same domain separator exists as BOTH native kinds, sharing one colour
//   collection  the contract has several native domain separators, one per piece (ERC-1155 shape)
//   shielded /
//   unshielded  a plain native token, labelled by its privacy tag
//
// Built-in rows get no chip: NIGHT and DUST share a sentinel address and are already labelled.
// The index covers the rows currently on screen, which is the whole list page in practice.
function familyIndex(items) {
  var domains = {};
  var kinds = {};
  for (var i = 0; i < (items || []).length; i++) {
    var t = items[i];
    if (!t || t.status === "builtin" || t.storage !== "native") continue;
    // A "seen" row has no contract and no domain separator (US5): it cannot take part in a family,
    // and two of them would otherwise look like one asset minted under two kinds.
    if (!t.address || !t.domainSep) continue;
    var a = String(t.address);
    var d = String(t.domainSep);
    if (!domains[a]) domains[a] = {};
    domains[a][d] = true;
    var pair = a + "/" + d;
    if (!kinds[pair]) kinds[pair] = {};
    kinds[pair][String(t.kind)] = true;
  }
  return { domains: domains, kinds: kinds };
}
function countKeys(o) {
  var n = 0;
  for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++;
  return n;
}
function familyOf(t, index) {
  if (!t || t.status === "builtin") return null;
  if (!t.address || !t.domainSep) return null;
  if (t.storage === "ledger") return "ledger";
  var pair = String(t.address) + "/" + String(t.domainSep);
  var kinds = index && index.kinds ? index.kinds[pair] : null;
  if (kinds && kinds["0"] && kinds["1"]) return "dual";
  var domains = index && index.domains ? index.domains[String(t.address)] : null;
  if (domains && countKeys(domains) > 1) return "collection";
  return t.privacy ? String(t.privacy) : null;
}
function nameCell(t, index) {
  var wrap = node("span");
  var fam = familyOf(t, index);
  if (fam) wrap.appendChild(node("span", fam, "fam fam-" + fam));
  var seen = t.status === "seen";
  wrap.appendChild(node("span",
    t.name ? String(t.name) : (seen ? "colour " + shortHex(t.color, 8, 6) : "(undescribed)"),
    t.name ? "txt" : (seen ? "hex" : "no")));
  if (seen) {
    // US5: the row exists because the colour was seen moving, not because a contract said so.
    var pill = node("span", "unknown contract", "pill");
    pill.title = "this colour was seen in public transaction data before any mint or metadata "
      + "event named it: its contract and domain separator are not known (its mint predates the "
      + "archive). A later mint or metadata event completes this row in place.";
    wrap.appendChild(pill);
  }
  return wrap;
}
// One trait's value, rendered by its declared type (MIP section 2.1): text for 1/3/4, the decimal
// integer for 2, hex for opaque bytes and for anything that did not decode.
function typeLabel(vt) {
  var names = ["opaque", "text", "integer", "JSON", "URI"];
  if (vt === null || vt === undefined) return "-";
  var n = Number(vt);
  return n >= 0 && n < names.length ? String(n) + " " + names[n] : String(n) + " reserved";
}
function traitValueCell(tr) {
  if (Number(tr.valType) === 2 && tr.integer !== null && tr.integer !== undefined) {
    return node("span", String(tr.integer), "txt");
  }
  if (tr.text !== null && tr.text !== undefined) return node("span", String(tr.text), "txt wrapv");
  if (tr.value) return copyable(tr.value, shortHex(String(tr.value), 10, 8), "hex");
  return node("span", "(empty)", "no");
}
function traitKeyCell(tr) {
  if (tr.key !== null && tr.key !== undefined) return node("span", String(tr.key), "txt");
  // MIP section 5.1: a key that is not valid UTF-8 is still a key. It is shown as its bytes.
  var s = copyable(tr.keyHex, "0x" + shortHex(String(tr.keyHex), 8, 6), "hex");
  s.title = "this key is not valid UTF-8 and is shown as its bytes";
  return s;
}
function domainCell(d) {
  var text = hexText(d);
  if (text !== null) return copyable(d, text, "txt");
  return copyable(d, shortHex(d, 8, 6), "hex");
}
function domainLabel(d) {
  var text = hexText(d);
  return text !== null ? text : shortHex(d, 8, 6);
}
// One shared tooltip, fixed to the viewport: the table sits in an overflow-x wrapper that would
// clip an absolutely positioned child on the bottom rows.
function showTip(anchor, build) {
  hideTip();
  var tip = node("div", null, "tip");
  tip.id = "tip";
  build(tip);
  document.body.appendChild(tip);
  var r = anchor.getBoundingClientRect();
  var w = tip.offsetWidth, h = tip.offsetHeight;
  var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  var top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function hideTip() {
  var old = document.getElementById("tip");
  if (old && old.parentNode) old.parentNode.removeChild(old);
}
// The list's domainSep cell: the row's own separator, plus a "multiple" chip when its contract
// issues under more than one. Hover or focus the chip for the contract's first five (by first-seen
// height) and how many more there are.
function listDomainCell(t) {
  var wrap = node("span");
  wrap.appendChild(domainCell(t.domainSep));
  var ds = t.contractDomainSeps;
  if (!ds || !(ds.count > 1)) return wrap;
  var chip = node("span", "multiple", "multi");
  chip.tabIndex = 0;
  var build = function (tip) {
    tip.appendChild(node("div", ds.count + " domainSeps on this contract", "note"));
    var first = ds.first || [];
    for (var i = 0; i < first.length; i++) {
      var here = first[i] === t.domainSep;
      tip.appendChild(node("div", domainLabel(first[i]) + (here ? "  ← this row" : ""), here ? "here" : "hex"));
    }
    if (ds.count > first.length) tip.appendChild(node("div", "+" + (ds.count - first.length) + " more", "note"));
  };
  chip.addEventListener("mouseenter", function () { showTip(chip, build); });
  chip.addEventListener("focus", function () { showTip(chip, build); });
  chip.addEventListener("mouseleave", hideTip);
  chip.addEventListener("blur", hideTip);
  wrap.appendChild(chip);
  return wrap;
}
// A colour is absent for exactly two reasons, and they are different facts: a ledger token never
// has one (nothing is minted, so nothing is derived), and DUST has none at all — the ledger types
// it as a unit variant, not as 32 bytes. Neither is rendered as an empty cell.
function colorCell(c, storage) {
  if (!c) {
    if (storage === "ledger") return node("span", "ledger token", "no");
    return node("span", "none", "no");
  }
  return copyable(c, shortHex(c, 8, 6), "hex");
}
function isZeroHex(s) {
  if (!isHex(s)) return false;
  for (var i = 0; i < s.length; i++) if (s.charAt(i) !== "0") return false;
  return true;
}
// NIGHT and DUST are seeded rows with no contract behind them: their "address" is a sentinel of
// 32 zero bytes, and printing 64 zeros as if it were a deployment would be a lie in 64 characters.
function addressCell(t) {
  // Two different absences, and neither is an empty cell: a built-in row has a zero sentinel
  // instead of a contract, a "seen" row has none yet (US5).
  if (!t.address) return node("span", t.status === "seen" ? "unknown contract" : "built-in", "no");
  if (isZeroHex(t.address)) return node("span", "built-in", "no");
  return copyable(t.address, shortHex(t.address, 8, 6), "hex");
}
function mintsCell(t) {
  var wrap = node("span");
  wrap.appendChild(node("span", orDash(t.mintCount)));
  if (t.totalMinted !== null && t.totalMinted !== undefined) {
    wrap.appendChild(node("span", " · " + t.totalMinted, "note"));
  }
  return wrap;
}
function heightsCell(t) {
  if (t.firstMintHeight === null || t.firstMintHeight === undefined) return node("span", "-", "no");
  return node("span", String(t.firstMintHeight) + " … " + orDash(t.lastMintHeight));
}
// NIGHT and DUST first, then every named row, then the colours nobody has named yet (US5
// scenario 3: "seen" rows sort after named rows — they are the ones a reader can say least about).
function sortTokens(items) {
  var built = [];
  var rest = [];
  var seen = [];
  for (var i = 0; i < items.length; i++) {
    var t = items[i];
    if (!t) continue;
    if (t.status === "builtin") built.push(t);
    else if (t.status === "seen") seen.push(t);
    else rest.push(t);
  }
  built.sort(function (a, b) { return String(a.symbol) < String(b.symbol) ? 1 : -1; });  // NIGHT, then DUST
  return built.concat(rest).concat(seen);
}

// ── Loaders ─────────────────────────────────────────────────────────────────────────────────

function listQuery(cursor) {
  var qs = P_TOKENS + "?limit=" + LIST_LIMIT;
  if (state.filters.kind) qs += "&kind=" + enc(state.filters.kind);
  if (state.filters.storage) qs += "&storage=" + enc(state.filters.storage);
  if (state.filters.status) qs += "&status=" + enc(state.filters.status);
  if (state.filters.q) qs += "&q=" + enc(state.filters.q);
  if (cursor) qs += "&cursor=" + enc(cursor);
  return qs;
}
async function loadList(cursor) {
  var payload = await api(listQuery(cursor));
  var items = itemsOf(payload);
  state.list.items = cursor ? state.list.items.concat(items) : sortTokens(items);
  state.list.nextCursor = payload && payload.nextCursor ? payload.nextCursor : null;
  state.list.loaded = true;
}
function tokenBase(r) {
  return P_CONTRACTS + "/" + enc(r.address) + "/tokens/" + enc(r.domainSep) + "/" + enc(r.kind);
}
function contractEventsPath(address) {
  return P_CONTRACTS + "/" + enc(address) + "/events?applied=false";
}
// FR-006 by (address, domainSep, kind); FR-008 by colour for a row that has no address yet (US5).
function activityPath(t, cursor) {
  var p;
  if (t.address && t.domainSep) p = tokenBase(t) + "/transactions?limit=" + ACT_LIMIT;
  else p = P_COLORS + "/" + enc(t.color) + "/transactions?limit=" + ACT_LIMIT + "&kind=" + enc(t.kind);
  if (state.act.role) p += "&role=" + enc(state.act.role);
  if (cursor) p += "&cursor=" + enc(cursor);
  return p;
}
function callsPath(address, cursor) {
  var p = P_CONTRACTS + "/" + enc(address) + "/calls?limit=" + CALL_LIMIT;
  if (cursor) p += "&cursor=" + enc(cursor);
  return p;
}
// "load more" is a page count, not a saved cursor: the 10 s refresh re-reads the same number of
// pages, so a reader who asked for 600 NIGHT rows still has them after it fires.
async function loadPages(pathOf, pages) {
  var items = [];
  var cursor = null;
  var next = null;
  for (var i = 0; i < (pages > 0 ? pages : 1); i++) {
    var payload = await api(pathOf(cursor));
    items = items.concat(itemsOf(payload));
    next = payload && payload.nextCursor ? payload.nextCursor : null;
    if (!next) break;
    cursor = next;
  }
  return { items: items, nextCursor: next };
}
async function loadToken(r) {
  var d = { token: null, keys: [], mints: [], events: [], siblings: [], activity: null,
    calls: null, notes: [] };
  if (r.color) {
    await loadSeenToken(r, d);
  } else {
    await loadNamedToken(r, d);
  }
  await loadTokenActivity(d);
  state.detail = d;
}
// A "seen" row (US5) has no token route to ask, so the colour document answers for it and the row
// of the route's kind is the one shown; its traits and mints travel with it (question Q17).
async function loadSeenToken(r, d) {
  var doc = await api(P_COLORS + "/" + enc(r.color));
  var rows = itemsOf(doc && doc.tokens ? { items: doc.tokens } : null);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].kind) === String(r.kind)) d.token = rows[i];
  }
  if (d.token === null && rows.length > 0) d.token = rows[0];
  if (d.token === null) throw new Error("404 TOKEN_NOT_FOUND: no row for colour " + r.color);
  d.keys = itemsOf(d.token.traits ? { items: d.token.traits } : null);
  d.mints = itemsOf(d.token.mints);
  d.siblings = rows;
}
async function loadTokenActivity(d) {
  var t = d.token;
  var vis = visibilityOf(t);
  // DUST (Q13) asks for nothing: every transaction pays a fee, so there is no per-token list.
  if (vis === "not-tracked") return;
  if (vis === "calls-only") {
    if (!t.address) return;
    await loadPages(function (c) { return callsPath(t.address, c); }, state.act.pages).then(
      function (p) { d.calls = p; },
      function (e) { d.notes.push("contract calls unavailable: " + e.message); });
    return;
  }
  await loadPages(function (c) { return activityPath(t, c); }, state.act.pages).then(
    function (p) { d.activity = p; },
    function (e) { d.notes.push("transactions unavailable: " + e.message); });
}
async function loadNamedToken(r, d) {
  d.token = await api(tokenBase(r));
  await Promise.all([
    api(tokenBase(r) + "/metadata").then(
      function (p) { d.keys = itemsOf(p); },
      function (e) { d.notes.push("traits unavailable: " + e.message); }),
    api(tokenBase(r) + "/mints?limit=" + MINT_LIMIT).then(
      function (p) { d.mints = itemsOf(p); },
      function (e) { d.notes.push("mint history unavailable: " + e.message); }),
    api(contractEventsPath(r.address)).then(
      function (p) { d.events = itemsOf(p); },
      function (e) { d.notes.push("raw events unavailable: " + e.message); }),
    // Every token row of this contract. Two things come out of it: the rows sharing this token's
    // domain separator, which the MIP (section 4) lets a consumer link as one asset's several
    // representations, and the family chip, which is derived from how the contract's rows relate.
    // The dedicated route GET /v1/contracts/:address/tokens/:domainSep serves the first alone; the
    // contract route serves both in one request, which is why the page asks for it instead.
    api(P_CONTRACTS + "/" + enc(r.address)).then(
      function (p) { d.siblings = itemsOf(p && p.tokens ? { items: p.tokens } : null); },
      function (e) { d.notes.push("related rows unavailable: " + e.message); })
  ]);
}
async function loadContract(address) {
  var c = { contract: null, events: [], calls: null, notes: [] };
  c.contract = await api(P_CONTRACTS + "/" + enc(address));
  await Promise.all([
    api(contractEventsPath(address)).then(
      function (p) { c.events = itemsOf(p); },
      function (e) { c.notes.push("raw events unavailable: " + e.message); }),
    // US7: the same calls table the ledger-token page shows, under the same note.
    loadPages(function (cur) { return callsPath(address, cur); }, state.act.pages).then(
      function (p) { c.calls = p; },
      function (e) { c.notes.push("contract calls unavailable: " + e.message); })
  ]);
  state.contract = c;
}
// FR-007: the whole public decode of one transaction, computed on request from the archived bytes.
async function loadTx(hash) {
  var keep = state.tx && state.tx.hash === hash ? state.tx.raw : false;
  var doc = await api(P_TXS + "/" + enc(hash));
  state.tx = { hash: hash, doc: doc, raw: keep };
}
// FR-018: the chain-wide list behind the disclosure panel's number.
function offersPath(cursor) {
  var p = P_OFFERS + "?limit=" + OFFER_LIMIT;
  if (state.offers.undisclosed === "true" || state.offers.undisclosed === "false") {
    p += "&undisclosed=" + enc(state.offers.undisclosed);
  }
  if (cursor) p += "&cursor=" + enc(cursor);
  return p;
}
async function loadOffers() {
  var page = await loadPages(offersPath, state.offers.pages);
  state.offers.items = page.items;
  state.offers.nextCursor = page.nextCursor;
  state.offers.loaded = true;
}
async function loadStatus() { state.status = await api(P_STATUS); }

// ── Refresh: the status strip on every view, plus whatever the view needs ───────────────────

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  var errors = [];
  var route = state.route;
  await loadStatus().then(function () {}, function (e) { errors.push("status: " + e.message); });
  try {
    if (route.view === "list") await loadList(null);
    else if (route.view === "token") await loadToken(route);
    else if (route.view === "contract") await loadContract(route.address);
    else if (route.view === "tx") await loadTx(route.hash);
    else if (route.view === "offers") await loadOffers();
  } catch (e) {
    errors.push(route.view + ": " + e.message);
  }
  state.errors = errors;
  if (errors.length === 0) state.lastOk = new Date();
  state.busy = false;
  render();
}

// ── Chrome: banner, strip, tabs, filters ────────────────────────────────────────────────────

function renderBanner() {
  var b = el("banner");
  clear(b);
  if (state.errors.length === 0) { b.hidden = true; return; }
  b.hidden = false;
  b.appendChild(node("div", "the API did not answer everything this view needs, so what is shown may be stale"));
  for (var i = 0; i < state.errors.length; i++) b.appendChild(node("div", "• " + state.errors[i]));
  if (state.lastOk) b.appendChild(node("div", "last complete refresh: " + state.lastOk.toLocaleTimeString(), "note"));
}
function renderStrip() {
  var s = el("strip");
  clear(s);
  var st = state.status;
  if (!st) { s.appendChild(node("span", "status unavailable", "err")); return; }
  function pair(label, value) {
    s.appendChild(node("span", label + " "));
    s.appendChild(node("b", value === null || value === undefined ? "-" : String(value)));
    s.appendChild(node("span", "  ·  "));
  }
  pair("net", st.net);
  pair("archive tip", st.archiveTip);
  var cur = st.decodeCursor || {};
  pair("decode cursor", (cur.height === undefined ? "-" : cur.height) + "/" + (cur.position === undefined ? "-" : cur.position));
  var pend = st.pendingLookups ? st.pendingLookups.length : 0;
  pair("pending lookups", pend);
  s.appendChild(node("span", state.lastOk ? "updated " + state.lastOk.toLocaleTimeString() : "never updated"));
}
function renderTabs() {
  var v = state.route.view;
  el("nav-list").className = v === "status" || v === "offers" ? "" : "on";
  el("nav-offers").className = v === "offers" ? "on" : "";
  el("nav-status").className = v === "status" ? "on" : "";
  el("filters").hidden = v !== "list";
}

// ── View: list ──────────────────────────────────────────────────────────────────────────────

// The list's "API" column: a link to the raw JSON behind the row, opened in a new tab. A row with
// a colour links to everything known about that colour; a colourless one (a ledger token, DUST)
// to its own token route. The icon is cloned from a <template> in the markup so the script never
// has to name the SVG namespace.
function apiHref(t) {
  return t.color ? P_COLORS + "/" + enc(t.color) : tokenBase(t);
}
function apiCell(t) {
  var href = apiHref(t);
  var a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.className = "api";
  a.title = "raw JSON · " + href;
  a.setAttribute("aria-label", "raw JSON for this row");
  var tpl = document.getElementById("icon-link");
  if (tpl && tpl.content && tpl.content.firstElementChild) a.appendChild(tpl.content.firstElementChild.cloneNode(true));
  else a.textContent = "json";
  a.addEventListener("click", function (e) { e.stopPropagation(); });
  return a;
}
function renderList(main) {
  var sec = node("section");
  sec.appendChild(node("h2", "tokens"));
  var items = state.list.items;
  el("count").textContent = state.list.loaded
    ? items.length + " row" + (items.length === 1 ? "" : "s") + (state.list.nextCursor ? " (more available)" : "")
    : "loading…";
  if (!state.list.loaded) {
    sec.appendChild(node("div", "loading…", "empty"));
    main.appendChild(sec);
    return;
  }
  if (items.length === 0) {
    sec.appendChild(node("div",
      "no token matches. The indexer creates a row from an observed mint or an emitted token-metadata event; "
      + "on a quiet chain the built-in NIGHT and DUST rows are all there is.", "empty"));
    main.appendChild(sec);
    return;
  }
  var index = familyIndex(items);
  var tbody = tableIn(sec, ["colour", "domainSep", "address", "kind", "name", "symbol",
    "dec", "#mints (#tokens)", "first … last block", "status", "tokenUri", "API"]);
  for (var i = 0; i < items.length; i++) {
    var t = items[i];
    var tr = document.createElement("tr");
    tr.className = t.status === "builtin" ? "pick built" : "pick";
    cell(tr, colorCell(t.color, t.storage));
    cell(tr, listDomainCell(t));
    cell(tr, addressCell(t));
    cell(tr, kindCell(t));
    cell(tr, nameCell(t, index));
    cell(tr, orDash(t.symbol));
    cell(tr, t.decimals === null || t.decimals === undefined ? "-" : String(t.decimals), "num");
    cell(tr, mintsCell(t), "num");
    cell(tr, heightsCell(t));
    cell(tr, statusBadge(t.status));
    cell(tr, uriLink(t.tokenUri));
    cell(tr, apiCell(t), "apicol");
    (function (token) {
      tr.addEventListener("click", function () { go(hashToken(token)); });
    })(t);
    tbody.appendChild(tr);
  }
  if (state.list.nextCursor) {
    var more = node("button", "load more");
    more.addEventListener("click", function () {
      more.disabled = true;
      loadList(state.list.nextCursor).then(render, function (e) {
        state.errors = ["list: " + e.message];
        render();
      });
    });
    var bar = node("div", null, "row");
    bar.style.marginTop = "10px";
    bar.appendChild(more);
    sec.appendChild(bar);
  }
  sec.appendChild(node("div",
    "click a row for the token view · click a hex value to copy it · rows with status builtin are the "
    + "hardcoded NIGHT and DUST entries, rows with status seen are colours this indexer watched move "
    + "before any contract named them, every other row comes from an observed mint or an emitted event "
    + "· a token is (contract, domainSep, kind) with the whole kind byte, so one domain separator can "
    + "hold up to four rows",
    "note"));
  main.appendChild(sec);
}

// ── 00023: the transactions section, the disclosure panel and the contract calls ────────────

// One row per public occurrence of the token in an archived transaction (US1, FR-009). Heights and
// positions only: the archive holds no wall-clock time and the owner asked for none (Q1).
function activitySection(t, d) {
  var sec = node("section");
  sec.id = "activity";
  sec.appendChild(node("h2", "transactions: every public occurrence of this token"));
  var vis = visibilityOf(t);

  var bar = node("div", null, "row");
  bar.appendChild(node("span", "what happened", "note"));
  var sel = document.createElement("select");
  for (var i = 0; i < ROLES.length; i++) {
    var opt = document.createElement("option");
    opt.value = ROLES[i][0];
    opt.textContent = ROLES[i][1];
    if (ROLES[i][0] === state.act.role) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", function () {
    state.act.role = sel.value;
    state.act.pages = 1;
    refresh();
  });
  bar.appendChild(sel);
  var rows = d.activity ? d.activity.items : [];
  bar.appendChild(node("span",
    (d.activity ? rows.length + " row" + (rows.length === 1 ? "" : "s") : "loading…")
    + (d.activity && d.activity.nextCursor ? " (more available)" : "")
    + (t.activityCount === null || t.activityCount === undefined ? "" : "  ·  " + t.activityCount + " in the index"),
    "note"));
  sec.appendChild(bar);

  if (!d.activity) {
    sec.appendChild(node("div", "not loaded (see the banner above)", "empty"));
    return sec;
  }
  if (rows.length === 0) {
    sec.appendChild(node("div", state.act.role
      ? "no row of this kind for this token; clear the filter to see the rest"
      : (vis === "disclosed-imbalances"
        ? "no transaction has published this colour yet. That is not proof that nothing moved: a "
          + "balanced shielded transfer publishes no colour at all (see the panel above)."
        : "no archived transaction has touched this token yet"), "empty"));
    return sec;
  }
  var tb = tableIn(sec, ["block", "pos", "tx", "what", "amount", "counterparty", "section", ""]);
  for (var r = 0; r < rows.length; r++) {
    var a = rows[r];
    var key = String(a.txHash) + "|" + String(a.segment) + "|" + String(a.section) + "|"
      + String(a.role) + "|" + String(a.itemIndex);
    var tr = document.createElement("tr");
    cell(tr, orDash(a.blockHeight), "num");
    cell(tr, orDash(a.txPosition), "num");
    cell(tr, txLink(a.txHash));
    cell(tr, node("span", roleLabel(a)));
    cell(tr, amountCell(a, t), "num");
    cell(tr, counterpartyCell(a));
    cell(tr, node("span", String(a.section) + " · segment " + orDash(a.segment), "note"));
    if (a.role === "shielded_delta") {
      var open = state.act.expand[key] !== undefined && state.act.expand[key] !== null;
      var btn = node("button", open ? "hide offer" : "offer", "expand");
      (function (row, k) {
        btn.addEventListener("click", function (ev) { ev.stopPropagation(); toggleOffer(row, k); });
      })(a, key);
      cell(tr, btn);
    } else {
      cell(tr, node("span", "", "no"));
    }
    tb.appendChild(tr);
    if (a.role === "shielded_delta" && state.act.expand[key]) tb.appendChild(offerDetailRow(a, key, 8));
  }
  if (d.activity.nextCursor) {
    var more = node("button", "load more");
    more.addEventListener("click", function () {
      more.disabled = true;
      state.act.pages = state.act.pages + 1;
      refresh();
    });
    var holder = node("div", null, "row");
    holder.style.marginTop = "10px";
    holder.appendChild(more);
    holder.appendChild(node("span", "500 rows at most per request; NIGHT's list is long by design (Q2)", "note"));
    sec.appendChild(holder);
  }
  sec.appendChild(node("div", activityHint(vis), "note"));
  return sec;
}
function activityHint(vis) {
  if (vis === "disclosed-imbalances") {
    return "a shielded token's list holds exactly what the ledger publishes about its colour: the "
      + "offers whose net imbalance names it (mints, burns, a contract paying into or out of the "
      + "pool) and its mints. A balanced transfer between two users names no colour and cannot "
      + "appear here — open the offer of a row to see what the ledger does publish.";
  }
  return "one row per public occurrence of this token in an archived transaction, newest first · "
    + "block height and position in the block, never a wall-clock time (the archive stores none) · "
    + "amounts are shown in the token's decimals, the raw units are on hover · an owner is shown as "
    + "its Bech32m address, which is what a wallet shows";
}
function counterpartyCell(a) {
  if (a.address) {
    var wrap = node("span");
    wrap.appendChild(contractLink(a.address));
    if (a.entryPoint) {
      wrap.appendChild(node("span", " · "));
      wrap.appendChild(node("span", String(a.entryPoint)));
    }
    return wrap;
  }
  if (a.owner) {
    var holder = node("span");
    holder.appendChild(ownerCell(a.owner));
    if (a.role === "utxo_in" && a.intentHash) {
      var spent = node("span", " spends " + shortHex(String(a.intentHash), 6, 4)
        + "/" + orDash(a.outputNo), "note");
      spent.title = "the UTXO being spent: intent hash " + a.intentHash + ", output " + orDash(a.outputNo);
      holder.appendChild(spent);
    }
    return holder;
  }
  if (a.role === "shielded_delta") {
    return node("span", "a commitment, not an address", "no");
  }
  return node("span", "-", "no");
}
// FR-011: a delta row opens the offer the ledger published — its commitments, nullifiers,
// transients and contract addresses, fetched from the transaction route when it is opened.
function toggleOffer(a, key) {
  if (state.act.expand[key]) {
    state.act.expand[key] = null;
    render();
    return;
  }
  state.act.expand[key] = { loading: true, doc: null, error: null };
  render();
  api(P_TXS + "/" + enc(a.txHash)).then(function (doc) {
    var cur = state.act.expand[key];
    if (!cur) return;
    cur.loading = false;
    cur.doc = doc;
    render();
  }, function (e) {
    var cur = state.act.expand[key];
    if (!cur) return;
    cur.loading = false;
    cur.error = "offer detail unavailable: " + e.message;
    render();
  });
}
function offerDetailRow(a, key, span) {
  var tr = document.createElement("tr");
  tr.className = "det";
  var td = document.createElement("td");
  td.colSpan = span;
  var st = state.act.expand[key];
  if (!st || st.loading) td.appendChild(node("div", "reading the transaction…", "note"));
  else if (st.error) td.appendChild(node("div", st.error, "err"));
  else td.appendChild(offerDetail(st.doc, a));
  tr.appendChild(td);
  return tr;
}
function offerDetail(doc, a) {
  var wrap = node("div");
  var tx = normalizeTx(doc);
  var mine = [];
  for (var i = 0; i < tx.offers.length; i++) {
    var o = tx.offers[i];
    for (var j = 0; j < o.deltas.length; j++) {
      if (String(o.deltas[j].color) === String(a.color)) { mine.push(o); break; }
    }
  }
  if (mine.length === 0) mine = tx.offers;
  if (mine.length === 0) {
    wrap.appendChild(node("div", "this transaction carries no zswap offer", "note"));
    return wrap;
  }
  for (var k = 0; k < mine.length; k++) {
    var offer = mine[k];
    var head = node("div", null, "row");
    head.appendChild(node("div", "zswap offer · " + offer.section + " · segment " + orDash(offer.segment), "note"));
    head.appendChild(countedChip(offer.counted));
    wrap.appendChild(head);
    var grid = node("div", null, "det-grid");
    var deltas = node("span");
    if (offer.deltas.length === 0) deltas.appendChild(node("span", "none — this offer is balanced and names no colour", "no"));
    for (var dd = 0; dd < offer.deltas.length; dd++) {
      if (dd > 0) deltas.appendChild(node("span", "  "));
      deltas.appendChild(colorLink(offer.deltas[dd].color, 1));
      deltas.appendChild(node("span", " " + orDash(offer.deltas[dd].delta), "amt"));
    }
    detRow(grid, "deltas (colour and net amount)", deltas);
    detRow(grid, "inputs · nullifiers", hexListCell(offer.inputs, "nullifier"));
    detRow(grid, "outputs · commitments", hexListCell(offer.outputs, "commitment"));
    detRow(grid, "transients · commitments", hexListCell(offer.transients, "commitment"));
    detRow(grid, "contract addresses on this offer", contractsOfOffer(offer));
    wrap.appendChild(grid);
  }
  wrap.appendChild(node("div",
    "a commitment names a coin without naming its colour, its value or its owner; a nullifier "
    + "proves a coin was spent without naming which one. Only the deltas above are attributable.",
    "note"));
  return wrap;
}
function detRow(grid, label, valueNode) {
  grid.appendChild(node("div", label, "k"));
  var holder = node("div");
  holder.appendChild(valueNode);
  grid.appendChild(holder);
}
function contractsOfOffer(offer) {
  var seen = {};
  var list = [];
  var groups = [offer.inputs, offer.outputs, offer.transients];
  for (var g = 0; g < groups.length; g++) {
    for (var i = 0; i < groups[g].length; i++) {
      var addr = groups[g][i] ? groups[g][i].contractAddress : null;
      if (!addr || seen[addr]) continue;
      seen[addr] = true;
      list.push(addr);
    }
  }
  if (list.length === 0) return node("span", "none — every coin in this offer is user-owned", "no");
  var wrap = node("span");
  for (var k = 0; k < list.length; k++) {
    if (k > 0) wrap.appendChild(node("span", "  "));
    wrap.appendChild(contractLink(list[k]));
  }
  return wrap;
}

// US4: the panel that says, in words and in numbers, what this shielded token's page can and
// cannot show. The text is fixed (it is a property of the ledger, not of this index); the two
// counts come from the API.
function disclosureSection(t) {
  var sec = node("section");
  sec.appendChild(node("h2", "what this shielded token discloses"));
  sec.appendChild(node("div",
    "a zswap offer publishes its net imbalance per colour and nothing else about the coins inside "
    + "it, so an unbalanced offer — a mint, a burn, a contract paying into or out of the pool — "
    + "names this colour and its exact amount, while a balanced one names nothing at all. "
    + "Everything below is read from the ledger, not asserted by this indexer.", "note"));
  var grid = node("div", null, "disc");

  var pub = node("div", null, "pub");
  pub.appendChild(node("h4", "public: what anyone can read from the ledger"));
  var pubList = document.createElement("ul");
  var publics = [
    "this token's colour — the same 32 bytes in every transaction that names it",
    "every mint of this colour, with its amount, and the total ever minted",
    "every offer whose net imbalance names this colour, with the exact amount and its sign",
    "every commitment and every nullifier in those offers",
    "a contract address attached to an offer's input, output or transient",
    "the DUST fee each of those transactions paid, and the block it landed in"
  ];
  for (var p = 0; p < publics.length; p++) pubList.appendChild(node("li", publics[p]));
  pub.appendChild(pubList);

  var pri = node("div", null, "pri");
  pri.appendChild(node("h4", "private: what the ledger never reveals"));
  var priList = document.createElement("ul");
  var privates = [
    "who received a coin — an output is a commitment, not an address",
    "who holds how much of this token",
    "a transfer between two users: a balanced offer carries no colour at all",
    "which commitment or nullifier belongs to this colour rather than another",
    "the value of any single coin"
  ];
  for (var q = 0; q < privates.length; q++) priList.appendChild(node("li", privates[q]));
  pri.appendChild(priList);

  grid.appendChild(pub);
  grid.appendChild(pri);
  sec.appendChild(grid);

  var counts = node("div", null, "counts");
  var disclosed = t.disclosedTransactions;
  var undisclosed = t.undisclosedShieldedOffers;
  if (undisclosed === null || undisclosed === undefined) undisclosed = counterOf(state.status, "undisclosedShieldedOffers");
  var one = node("div");
  one.appendChild(node("b", disclosed === null || disclosed === undefined ? "-" : String(disclosed)));
  one.appendChild(node("span", "  transactions disclose this colour", "note"));
  counts.appendChild(one);
  var two = node("div");
  two.appendChild(node("b", undisclosed === null || undisclosed === undefined ? "-" : String(undisclosed)));
  two.appendChild(node("span", "  shielded offers on this chain publish no colour at all — any of "
    + "them may be this token  ", "note"));
  var link = node("a", "list them");
  link.href = "#/shielded-offers";
  two.appendChild(link);
  counts.appendChild(two);
  sec.appendChild(counts);
  return sec;
}

// Q13: DUST is the fee token, so it has no per-token list at all — and says so instead of
// showing an empty table that would read as "nothing happened".
function dustSection() {
  var sec = node("section");
  sec.appendChild(node("h2", "transactions"));
  var box = node("div", null, "warnnote");
  box.appendChild(node("b", "fees are not tracked per token"));
  box.appendChild(node("span",
    ". Every transaction on the chain pays a DUST fee, so a DUST activity list would be a list of "
    + "the whole chain. A transaction's own DUST spends and registrations are shown in its view, "
    + "where they belong."));
  sec.appendChild(box);
  return sec;
}

// US7 / Q4: for a ledger token there is no colour and no UTXO — its balances live in contract
// state this indexer cannot read. What is public is every call of its contract, listed here under
// the note the owner asked for.
function callsNote() {
  var box = node("div", null, "warnnote");
  box.appendChild(node("b", "only public data is listed — we do not have access to the code this executes"));
  box.appendChild(node("span",
    "; what a call means for this token's balances is defined by the contract and is not readable here."));
  return box;
}
function callsSection(page, heading, notes) {
  var sec = node("section");
  sec.id = "calls";
  sec.appendChild(node("h2", heading));
  sec.appendChild(callsNote());
  if (!page) {
    sec.appendChild(node("div", "not loaded (see the banner above)", "empty"));
    return sec;
  }
  var items = page.items;
  if (items.length === 0) {
    sec.appendChild(node("div", "no call of this contract is archived yet", "empty"));
    return sec;
  }
  var tb = tableIn(sec, ["block", "pos", "tx", "segment", "call", "entry point", "section",
    "ops", "log", "gas (compute)", "effects", ""]);
  for (var i = 0; i < items.length; i++) {
    var c = items[i];
    var sections = [["guaranteed", c.guaranteed], ["fallible", c.fallible]];
    var any = false;
    for (var s = 0; s < sections.length; s++) {
      var tr2 = sections[s][1];
      if (!tr2) continue;
      any = true;
      tb.appendChild(callRow(c, sections[s][0], tr2));
    }
    if (!any) tb.appendChild(callRow(c, "-", null));
  }
  if (page.nextCursor) {
    var more = node("button", "load more");
    more.addEventListener("click", function () {
      more.disabled = true;
      state.act.pages = state.act.pages + 1;
      refresh();
    });
    var holder = node("div", null, "row");
    holder.style.marginTop = "10px";
    holder.appendChild(more);
    sec.appendChild(holder);
  }
  sec.appendChild(node("div",
    "one row per transcript: a call may carry a guaranteed one, a fallible one or both · a row "
    + "marked not counted ran in a section that failed · click the transaction for the whole decode",
    "note"));
  if (notes) sec.appendChild(node("div", notes, "note"));
  return sec;
}
function callRow(c, section, transcript) {
  var tr = document.createElement("tr");
  cell(tr, orDash(c.blockHeight), "num");
  cell(tr, orDash(c.txPosition), "num");
  cell(tr, txLink(c.txHash));
  cell(tr, orDash(c.segment), "num");
  cell(tr, orDash(c.callIndex), "num");
  cell(tr, orDash(c.entryPoint));
  cell(tr, node("span", section, "note"));
  cell(tr, transcript ? orDash(transcript.ops) : "-", "num");
  cell(tr, transcript ? orDash(transcript.logOps) : "-", "num");
  cell(tr, gasCell(transcript ? transcript.gas : null), "num");
  cell(tr, node("span", effectsSummary(transcript ? transcript.effects : null), "wrapv"));
  cell(tr, countedChip(transcript ? transcript.counted : undefined));
  return tr;
}
function gasCell(g) {
  if (!g) return node("span", "-", "no");
  var s = node("span", orDash(g.computeTime), "amt");
  s.title = "read " + orDash(g.readTime) + "  ·  compute " + orDash(g.computeTime)
    + "  ·  bytes written " + orDash(g.bytesWritten) + "  ·  bytes deleted " + orDash(g.bytesDeleted);
  return s;
}
// An effect map may arrive as a list of {color|domainSep, amount} or as a plain object keyed by
// hex; both read the same here, and neither is dropped silently (FR-015 is the decoder's rule, and
// this is its counterpart on screen).
function mapEntries(v) {
  var out = [];
  if (isArray(v)) {
    for (var i = 0; i < v.length; i++) {
      var e = v[i] || {};
      out.push({
        key: e.color || e.domainSep || e.token || e.type || null,
        text: e.domainSepText || e.tokenName || e.name || null,
        value: e.amount === undefined ? e.value : e.amount,
        isColor: e.color ? true : false
      });
    }
    return out;
  }
  if (v && typeof v === "object") {
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      out.push({ key: k, text: null, value: v[k], isColor: false });
    }
  }
  return out;
}
var EFFECT_MAPS = [["shieldedMints", "shielded mints"], ["unshieldedMints", "unshielded mints"],
  ["unshieldedInputs", "received by the contract"], ["unshieldedOutputs", "paid by the contract"]];
var EFFECT_COUNTS = [["claimedShieldedReceives", "claimed shielded receives"],
  ["claimedShieldedSpends", "claimed shielded spends"], ["claimedNullifiers", "claimed nullifiers"],
  ["claimedContractCalls", "claimed contract calls"]];
function effectsSummary(e) {
  if (!e) return "-";
  var parts = [];
  for (var i = 0; i < EFFECT_MAPS.length; i++) {
    var n = mapEntries(e[EFFECT_MAPS[i][0]]).length;
    if (n > 0) parts.push(EFFECT_MAPS[i][1] + " " + n);
  }
  for (var j = 0; j < EFFECT_COUNTS.length; j++) {
    var c = count(e[EFFECT_COUNTS[j][0]]);
    if (c > 0) parts.push(EFFECT_COUNTS[j][1] + " " + c);
  }
  return parts.length === 0 ? "none" : parts.join(" · ");
}
function effectsBlock(e) {
  var wrap = node("div");
  if (!e) { wrap.appendChild(node("span", "-", "no")); return wrap; }
  var grid = node("div", null, "det-grid");
  var any = false;
  for (var i = 0; i < EFFECT_MAPS.length; i++) {
    var entries = mapEntries(e[EFFECT_MAPS[i][0]]);
    if (entries.length === 0) continue;
    any = true;
    var holder = node("span");
    for (var k = 0; k < entries.length; k++) {
      if (k > 0) holder.appendChild(node("span", "  "));
      var entry = entries[k];
      if (entry.isColor) holder.appendChild(colorLink(entry.key, 0));
      else if (entry.text) holder.appendChild(copyable(entry.key, entry.text, "txt"));
      else holder.appendChild(copyable(entry.key, shortHex(String(entry.key), 8, 6), "hex"));
      holder.appendChild(node("span", " " + orDash(entry.value), "amt"));
    }
    detRow(grid, EFFECT_MAPS[i][1], holder);
  }
  for (var j = 0; j < EFFECT_COUNTS.length; j++) {
    var c = count(e[EFFECT_COUNTS[j][0]]);
    if (c === 0) continue;
    any = true;
    detRow(grid, EFFECT_COUNTS[j][1], node("span", String(c), "amt"));
  }
  if (!any) { wrap.appendChild(node("span", "no effect declared by this transcript", "no")); return wrap; }
  wrap.appendChild(grid);
  return wrap;
}

// ── View: one transaction (US2, FR-010) ─────────────────────────────────────────────────────
//
// The document of spec §4, whatever spelling the API chose for its containers (question Q15): the
// shapes below are normalised once, here, so every renderer downstream reads one shape.

function normOffer(o, section, segment) {
  var v = o || {};
  return {
    section: v.section ? String(v.section) : section,
    segment: v.segment === undefined || v.segment === null ? segment : v.segment,
    counted: v.counted === undefined ? true : v.counted,
    deltas: arr(v.deltas), inputs: arr(v.inputs), outputs: arr(v.outputs), transients: arr(v.transients)
  };
}
function normalizeTx(doc) {
  var d = doc || {};
  var offers = [];
  var listed = arr(d.offers);
  if (listed.length > 0) {
    for (var i = 0; i < listed.length; i++) offers.push(normOffer(listed[i], "guaranteed", 0));
  } else {
    if (d.guaranteedOffer) offers.push(normOffer(d.guaranteedOffer, "guaranteed", 0));
    var fallible = segList(d.fallibleOffers === undefined ? d.fallibleOffer : d.fallibleOffers);
    for (var f = 0; f < fallible.length; f++) offers.push(normOffer(fallible[f], "fallible", fallible[f].segment));
  }
  var intents = [];
  var rawIntents = segList(d.intents);
  for (var n = 0; n < rawIntents.length; n++) {
    var it = rawIntents[n];
    var unshielded = arr(it.unshieldedOffers);
    if (unshielded.length === 0) {
      if (it.guaranteedUnshieldedOffer) unshielded.push(normUnshielded(it.guaranteedUnshieldedOffer, "guaranteed"));
      if (it.fallibleUnshieldedOffer) unshielded.push(normUnshielded(it.fallibleUnshieldedOffer, "fallible"));
    } else {
      var fixed = [];
      for (var u = 0; u < unshielded.length; u++) fixed.push(normUnshielded(unshielded[u], "guaranteed"));
      unshielded = fixed;
    }
    intents.push({
      segment: it.segment, ttl: it.ttl, intentHash: it.intentHash,
      unshieldedOffers: unshielded,
      dustActions: it.dustActions || null,
      actions: arr(it.actions === undefined ? it.contractActions : it.actions)
    });
  }
  var rewards = [];
  if (d.rewards) rewards = isArray(d.rewards) ? d.rewards : [d.rewards];
  return {
    head: d, offers: offers, intents: intents, dustActions: d.dustActions || null,
    rewards: rewards, activity: arr(d.activity)
  };
}
function normUnshielded(o, section) {
  var v = o || {};
  return {
    section: v.section ? String(v.section) : section,
    counted: v.counted === undefined ? true : v.counted,
    signatures: v.signatures === undefined ? null : v.signatures,
    inputs: arr(v.inputs), outputs: arr(v.outputs)
  };
}
function segmentsText(segments) {
  var list = arr(segments);
  if (list.length === 0) return "-";
  var out = [];
  for (var i = 0; i < list.length; i++) {
    out.push(String(list[i].id === undefined ? list[i].segment : list[i].id)
      + (list[i].success === false ? " failed" : " ok"));
  }
  return out.join(" · ");
}
function renderTx(main) {
  var crumb = node("div", null, "crumb");
  var back = node("a", "← all tokens");
  back.href = "#/";
  crumb.appendChild(back);
  main.appendChild(crumb);

  var holder = state.tx;
  if (!holder || !holder.doc) {
    var miss = node("section");
    miss.appendChild(node("h2", "transaction"));
    miss.appendChild(node("div", "not loaded (see the banner above). The hash is "
      + String(state.route.hash), "empty"));
    main.appendChild(miss);
    return;
  }
  var tx = normalizeTx(holder.doc);
  var d = tx.head;

  var head = node("section");
  head.appendChild(node("h2", "transaction · decoded from the archived bytes on request"));
  var feeSpeck = d.feeSpeck === undefined ? d.fee : d.feeSpeck;
  kvInto(head, [
    ["hash", copyable(d.txHash, d.txHash ? String(d.txHash) : "-", "hex")],
    ["block height", orDash(d.blockHeight)],
    ["block hash", copyable(d.blockHash, d.blockHash ? shortHex(String(d.blockHash), 12, 10) : "-", "hex")],
    ["position in block", orDash(d.txPosition)],
    ["protocol version", orDash(d.protocolVersion)],
    ["result", node("span", orDash(d.result), d.result === "success" ? "txt" : "err")],
    ["segments", segmentsText(d.segments)],
    ["raw bytes", orDash(d.rawBytes)],
    ["identifiers", hexListCell(d.identifiers)],
    ["fee", node("span", orDash(feeSpeck) + " SPECK  ·  " + formatUnits(feeSpeck, 15) + " DUST", "amt")],
    ["binding randomness", d.bindingRandomness === undefined ? "-" : (d.bindingRandomness ? "present" : "absent")]
  ]);
  main.appendChild(head);

  // zswap offers
  var offers = node("section");
  offers.appendChild(node("h2", "zswap offers"));
  if (tx.offers.length === 0) {
    offers.appendChild(node("div", "this transaction carries no zswap offer", "empty"));
  } else {
    for (var i = 0; i < tx.offers.length; i++) {
      var o = tx.offers[i];
      var block = node("div", null, "txsec");
      var title = node("div", null, "row");
      title.appendChild(node("div", o.section + " offer · segment " + orDash(o.segment), "h"));
      title.appendChild(countedChip(o.counted));
      block.appendChild(title);
      var grid = node("div", null, "det-grid");
      var deltas = node("span");
      if (o.deltas.length === 0) {
        deltas.appendChild(node("span",
          "none — this offer is balanced, so the ledger does not say which colour moved", "no"));
      }
      for (var dd = 0; dd < o.deltas.length; dd++) {
        if (dd > 0) deltas.appendChild(node("span", "  "));
        deltas.appendChild(colorLink(o.deltas[dd].color, 1));
        deltas.appendChild(node("span", " " + orDash(o.deltas[dd].delta), "amt"));
        if (o.deltas[dd].tokenName) deltas.appendChild(node("span", " " + String(o.deltas[dd].tokenName), "txt"));
      }
      detRow(grid, "deltas", deltas);
      detRow(grid, "inputs · nullifiers", hexListCell(o.inputs, "nullifier"));
      detRow(grid, "outputs · commitments", hexListCell(o.outputs, "commitment"));
      detRow(grid, "transients · commitments", hexListCell(o.transients, "commitment"));
      detRow(grid, "contract addresses", contractsOfOffer(o));
      block.appendChild(grid);
      offers.appendChild(block);
    }
  }
  main.appendChild(offers);

  // intents
  for (var n = 0; n < tx.intents.length; n++) main.appendChild(intentSection(tx.intents[n]));
  if (tx.dustActions) main.appendChild(dustActionsSection(tx.dustActions, null));

  // rewards
  if (tx.rewards.length > 0) {
    var rw = node("section");
    rw.appendChild(node("h2", "rewards"));
    var rb = tableIn(rw, ["kind", "value", "owner", "nonce"]);
    for (var r = 0; r < tx.rewards.length; r++) {
      var reward = tx.rewards[r];
      var rr = document.createElement("tr");
      cell(rr, orDash(reward.kind));
      cell(rr, node("span", formatUnits(reward.value, 6), "amt"), "num");
      cell(rr, ownerCell(reward.owner));
      cell(rr, copyable(reward.nonce, shortHex(String(reward.nonce), 8, 6), "hex"));
      rb.appendChild(rr);
    }
    main.appendChild(rw);
  }

  // this transaction's stored activity rows
  var act = node("section");
  act.appendChild(node("h2", "what this transaction did to tracked tokens"));
  if (tx.activity.length === 0) {
    act.appendChild(node("div",
      "no activity row: either nothing public in this transaction names a tracked colour, or the "
      + "sections that would have produced rows did not count (Q10).", "empty"));
  } else {
    var ab = tableIn(act, ["token", "what", "amount", "counterparty", "section"]);
    for (var a = 0; a < tx.activity.length; a++) {
      var row = tx.activity[a];
      var ar = document.createElement("tr");
      cell(ar, txTokenCell(row));
      cell(ar, node("span", roleLabel(row)));
      cell(ar, amountCell(row, row.token), "num");
      cell(ar, counterpartyCell(row));
      cell(ar, node("span", String(row.section) + " · segment " + orDash(row.segment), "note"));
      ab.appendChild(ar);
    }
  }
  main.appendChild(act);

  // the document as it arrived
  var raw = node("section");
  var bar = node("div", null, "row");
  var toggleRaw = node("button", holder.raw ? "hide raw JSON" : "raw JSON");
  toggleRaw.addEventListener("click", function () { holder.raw = !holder.raw; render(); });
  bar.appendChild(node("div", "the document this page rendered, exactly as the API returned it", "note"));
  bar.appendChild(toggleRaw);
  raw.appendChild(bar);
  if (holder.raw) {
    var pre = node("pre");
    try { pre.textContent = JSON.stringify(holder.doc, null, 2); } catch (e) { pre.textContent = String(holder.doc); }
    raw.appendChild(pre);
  }
  main.appendChild(raw);
}
function txTokenCell(a) {
  var t = a.token;
  var label = t && t.name ? String(t.name)
    : (t && t.symbol ? String(t.symbol) : "colour " + shortHex(String(a.color), 8, 6));
  var link = node("a", label);
  link.href = t && t.address && t.domainSep ? hashToken(t) : hashColor(a.color, a.kind);
  link.title = "open this token with its transactions";
  link.addEventListener("click", function () { state.scrollTo = "activity"; });
  var wrap = node("span");
  wrap.appendChild(link);
  if (!t) wrap.appendChild(node("span", "unknown contract", "pill"));
  return wrap;
}
function intentSection(it) {
  var sec = node("section");
  sec.appendChild(node("h2", "intent · segment " + orDash(it.segment)));
  var ttl = node("span", orDash(it.ttl));
  ttl.title = "the wallet's own time-to-live for this intent — a value inside the transaction, "
    + "never the block's time (the archive stores no block time)";
  kvInto(sec, [
    ["intent hash", copyable(it.intentHash, it.intentHash ? String(it.intentHash) : "-", "hex")],
    ["ttl (wallet-set, not the block time)", ttl]
  ]);
  for (var i = 0; i < it.unshieldedOffers.length; i++) {
    var offer = it.unshieldedOffers[i];
    var block = node("div", null, "txsec");
    var title = node("div", null, "row");
    title.appendChild(node("div", offer.section + " unshielded offer"
      + (offer.signatures === null ? "" : " · " + offer.signatures + " signature"
        + (Number(offer.signatures) === 1 ? "" : "s")), "h"));
    title.appendChild(countedChip(offer.counted));
    block.appendChild(title);
    if (offer.inputs.length > 0) {
      var ib = tableIn(block, ["input", "value", "colour", "owner", "spends intent", "out #"]);
      for (var n = 0; n < offer.inputs.length; n++) {
        var input = offer.inputs[n];
        var ir = document.createElement("tr");
        cell(ir, String(n), "num");
        cell(ir, node("span", orDash(input.value), "amt"), "num");
        cell(ir, colorLink(input.color === undefined ? input.type : input.color, 0));
        cell(ir, ownerCell(input.ownerAddress === undefined ? input.owner : input.ownerAddress));
        cell(ir, copyable(input.spentIntentHash, shortHex(String(input.spentIntentHash), 8, 6), "hex"));
        cell(ir, orDash(input.spentOutputNo === undefined ? input.outputNo : input.spentOutputNo), "num");
        ib.appendChild(ir);
      }
    }
    if (offer.outputs.length > 0) {
      var ob = tableIn(block, ["output", "value", "colour", "owner"]);
      for (var m = 0; m < offer.outputs.length; m++) {
        var output = offer.outputs[m];
        var or = document.createElement("tr");
        cell(or, orDash(output.index === undefined ? m : output.index), "num");
        cell(or, node("span", orDash(output.value), "amt"), "num");
        cell(or, colorLink(output.color === undefined ? output.type : output.color, 0));
        cell(or, ownerCell(output.owner));
        ob.appendChild(or);
      }
    }
    if (offer.inputs.length === 0 && offer.outputs.length === 0) {
      block.appendChild(node("div", "no input and no output", "empty"));
    }
    sec.appendChild(block);
  }
  for (var c = 0; c < it.actions.length; c++) sec.appendChild(actionBlock(it.actions[c]));
  if (it.dustActions) sec.appendChild(dustActionsBlock(it.dustActions));
  return sec;
}
function actionBlock(action) {
  var block = node("div", null, "txsec");
  var title = node("div", null, "row");
  title.appendChild(node("div", "contract " + (action.kind ? String(action.kind) : "action")
    + " · index " + orDash(action.index), "h"));
  block.appendChild(title);
  var grid = node("div", null, "det-grid");
  detRow(grid, "address", contractLink(action.address, action.address ? String(action.address) : null));
  if (action.entryPoint) detRow(grid, "entry point", node("span", String(action.entryPoint)));
  if (action.communicationCommitment) {
    detRow(grid, "communication commitment",
      copyable(action.communicationCommitment, shortHex(String(action.communicationCommitment), 10, 8), "hex"));
  }
  block.appendChild(grid);
  var transcripts = [["guaranteed", action.guaranteed], ["fallible", action.fallible]];
  for (var i = 0; i < transcripts.length; i++) {
    var t = transcripts[i][1];
    if (!t) continue;
    var line = node("div", null, "row");
    line.appendChild(node("div", transcripts[i][0] + " transcript · " + orDash(t.ops) + " ops · "
      + orDash(t.logOps) + " log", "h"));
    line.appendChild(gasCell(t.gas));
    line.appendChild(countedChip(t.counted));
    block.appendChild(line);
    block.appendChild(effectsBlock(t.effects));
  }
  return block;
}
function dustActionsBlock(dust) {
  var block = node("div", null, "txsec");
  block.appendChild(node("div",
    "DUST actions — inside the transaction; not tracked per token (Q13)", "h"));
  var ctime = node("span", orDash(dust.ctime));
  ctime.title = "the wallet's own creation time for the DUST it spends — a value inside the "
    + "transaction, never the block's time";
  var grid = node("div", null, "det-grid");
  detRow(grid, "ctime (wallet-set, not the block time)", ctime);
  block.appendChild(grid);
  var spends = arr(dust.spends);
  if (spends.length > 0) {
    var sb = tableIn(block, ["spend", "vFee (SPECK)", "old nullifier", "new commitment"]);
    for (var i = 0; i < spends.length; i++) {
      var s = spends[i];
      var tr = document.createElement("tr");
      cell(tr, String(i), "num");
      cell(tr, node("span", orDash(s.vFee), "amt"), "num");
      cell(tr, copyable(s.oldNullifier, shortHex(String(s.oldNullifier), 8, 6), "hex"));
      cell(tr, copyable(s.newCommitment, shortHex(String(s.newCommitment), 8, 6), "hex"));
      sb.appendChild(tr);
    }
  }
  var regs = arr(dust.registrations);
  if (regs.length > 0) {
    var rb = tableIn(block, ["registration", "night key", "DUST address", "may pay fees"]);
    for (var r = 0; r < regs.length; r++) {
      var g = regs[r];
      var rr = document.createElement("tr");
      cell(rr, String(r), "num");
      cell(rr, copyable(g.nightKey, shortHex(String(g.nightKey), 8, 6), "hex"));
      cell(rr, ownerCell(g.dustAddress));
      cell(rr, g.allowFeePayment === true ? "yes" : (g.allowFeePayment === false ? "no" : "-"));
      rb.appendChild(rr);
    }
  }
  if (spends.length === 0 && regs.length === 0) {
    block.appendChild(node("div", "no DUST spend and no registration in this intent", "empty"));
  }
  return block;
}
function dustActionsSection(dust) {
  var sec = node("section");
  sec.appendChild(node("h2", "DUST actions"));
  sec.appendChild(dustActionsBlock(dust));
  return sec;
}

// ── View: the shielded offers whose colour is undisclosed (FR-018, Q14) ─────────────────────

function renderOffers(main) {
  var crumb = node("div", null, "crumb");
  var back = node("a", "← all tokens");
  back.href = "#/";
  crumb.appendChild(back);
  main.appendChild(crumb);

  var sec = node("section");
  sec.appendChild(node("h2", "shielded offers whose colour is undisclosed"));
  sec.appendChild(node("div",
    "these shielded offers carry no colour: the ledger does not say which token moved. A zswap "
    + "offer publishes only its net imbalance per colour, and a balanced offer — a plain transfer "
    + "between two users — has none, so any of these may be any shielded token. This is the "
    + "measured form of the claim that Midnight is private: a number that comes from the chain.",
    "note"));
  var bar = node("div", null, "row");
  bar.appendChild(node("span", "show", "note"));
  var sel = document.createElement("select");
  var choices = [["true", "undisclosed only (no colour)"], ["false", "disclosed only (a colour and an amount)"],
    ["", "every zswap offer"]];
  for (var i = 0; i < choices.length; i++) {
    var opt = document.createElement("option");
    opt.value = choices[i][0];
    opt.textContent = choices[i][1];
    if (choices[i][0] === state.offers.undisclosed) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", function () {
    state.offers.undisclosed = sel.value;
    state.offers.pages = 1;
    state.offers.loaded = false;
    refresh();
  });
  bar.appendChild(sel);
  var items = state.offers.items;
  bar.appendChild(node("span", state.offers.loaded
    ? items.length + " offer" + (items.length === 1 ? "" : "s")
      + (state.offers.nextCursor ? " (more available)" : "")
    : "loading…", "note"));
  sec.appendChild(bar);

  if (!state.offers.loaded) {
    sec.appendChild(node("div", "loading…", "empty"));
    main.appendChild(sec);
    return;
  }
  if (items.length === 0) {
    sec.appendChild(node("div", "no offer matches", "empty"));
    main.appendChild(sec);
    return;
  }
  var tb = tableIn(sec, ["block", "pos", "tx", "section", "segment", "inputs", "outputs",
    "transients", "deltas", "colour"]);
  for (var r = 0; r < items.length; r++) {
    var o = items[r];
    var tr = document.createElement("tr");
    cell(tr, orDash(o.blockHeight), "num");
    cell(tr, orDash(o.txPosition), "num");
    cell(tr, txLink(o.txHash));
    cell(tr, node("span", orDash(o.section), "note"));
    cell(tr, orDash(o.segment), "num");
    cell(tr, orDash(o.inputs), "num");
    cell(tr, orDash(o.outputs), "num");
    cell(tr, orDash(o.transients), "num");
    cell(tr, orDash(o.deltas), "num");
    cell(tr, o.undisclosed === false
      ? node("span", "published", "txt")
      : node("span", "not published", "no"));
    tb.appendChild(tr);
  }
  if (state.offers.nextCursor) {
    var more = node("button", "load more");
    more.addEventListener("click", function () {
      more.disabled = true;
      state.offers.pages = state.offers.pages + 1;
      refresh();
    });
    var holder = node("div", null, "row");
    holder.style.marginTop = "10px";
    holder.appendChild(more);
    sec.appendChild(holder);
  }
  sec.appendChild(node("div",
    "one row per zswap offer on the chain · inputs are nullifiers, outputs are commitments, and "
    + "neither carries a colour or a value · click a transaction to see the offer itself", "note"));
  main.appendChild(sec);
}

// ── View: token ─────────────────────────────────────────────────────────────────────────────

function kvInto(parent, pairs) {
  var grid = node("div", null, "kv");
  for (var i = 0; i < pairs.length; i++) {
    grid.appendChild(node("div", pairs[i][0], "k"));
    var v = pairs[i][1];
    if (v !== null && typeof v === "object" && v.nodeType) {
      var holder = node("div");
      holder.appendChild(v);
      grid.appendChild(holder);
    } else {
      grid.appendChild(node("div", v === null || v === undefined || v === "" ? "-" : String(v)));
    }
  }
  parent.appendChild(grid);
}
function renderToken(main) {
  var d = state.detail;
  var r = state.route;
  var crumb = node("div", null, "crumb");
  var back = node("a", "← all tokens");
  back.href = "#/";
  crumb.appendChild(back);
  // A colour route (US5) has no contract to point at — that is the whole reason it exists.
  if (r.address && !isZeroHex(r.address)) {
    crumb.appendChild(node("span", "  ·  "));
    var toContract = node("a", "contract " + shortHex(r.address, 8, 6));
    toContract.href = hashContract(r.address);
    crumb.appendChild(toContract);
  } else if (r.color) {
    crumb.appendChild(node("span", "  ·  colour " + shortHex(r.color, 10, 8)
      + " · kind " + orDash(r.kind)));
  }
  main.appendChild(crumb);

  if (!d || !d.token) {
    var miss = node("section");
    miss.appendChild(node("h2", "token"));
    miss.appendChild(node("div", "not loaded (see the banner above). The route is "
      + (r.color ? "colour " + r.color + " / kind " + r.kind
        : r.address + " / " + r.domainSep + " / " + r.kind), "empty"));
    main.appendChild(miss);
    return;
  }
  var t = d.token;

  var index = familyIndex(d.siblings && d.siblings.length ? d.siblings : [t]);
  var head = node("section");
  var title = node("h3");
  title.appendChild(nameCell(t, index));
  head.appendChild(title);
  var sub = node("div", null, "row");
  sub.appendChild(statusBadge(t.status));
  sub.appendChild(node("span", (t.symbol ? String(t.symbol) : "no symbol")
    + " · kind " + orDash(t.kind) + " " + kindLabel(t)
    + " · decimals " + (t.decimals === null || t.decimals === undefined ? "-" : t.decimals), "note"));
  head.appendChild(sub);
  if (t.status === "seen") {
    head.appendChild(node("div",
      "This row exists because this colour was seen moving in public transaction data, not because "
      + "a contract named it: its mint predates the archive's first block, and a colour is a "
      + "commitment — the contract address and domain separator behind it cannot be recovered from "
      + "it. Everything below is what the chain itself shows. A later mint or metadata event for "
      + "this colour completes this row in place (US5).", "note"));
  }
  if (t.status === "declared") {
    head.appendChild(node("div",
      t.storage === "ledger"
        ? "A ledger token is a claim the chain cannot corroborate: nothing is ever minted for it, so "
          + "this row stays declared for good (MIP 7.2)."
        : "Described but not yet minted: the chain has not seen this token, only the contract's claim "
          + "about it (MIP 7.2).", "note"));
  }
  var links = node("div", null, "row");
  links.style.marginTop = "8px";
  links.appendChild(node("span", "tokenUri", "note"));
  links.appendChild(uriLink(t.tokenUri));
  var paths = resolverPaths(t);
  for (var i = 0; i < paths.length; i++) {
    links.appendChild(node("span", paths[i].label, "note"));
    var a = node("a", paths[i].short);
    a.href = paths[i].path;
    a.title = paths[i].path + " (opens the metadata document in a new tab)";
    a.rel = "noreferrer noopener";
    a.target = "_blank";
    links.appendChild(a);
  }
  head.appendChild(links);
  main.appendChild(head);

  var facts = node("section");
  facts.appendChild(node("h2", "token"));
  kvInto(facts, [
    ["address", !t.address ? node("span", t.status === "seen"
        ? "unknown: no mint or metadata event has named this colour's contract"
        : "built-in row, no contract", "no")
      : (isZeroHex(t.address) ? node("span", "built-in row, no contract", "no")
        : copyable(t.address, String(t.address), "hex"))],
    ["domainSep", t.domainSep ? domainCell(t.domainSep) : node("span", "unknown", "no")],
    ["domainSep (hex)", copyable(t.domainSep, t.domainSep ? String(t.domainSep) : "-", "hex")],
    ["kind", orDash(t.kind) + "  (" + kindLabel(t) + ")"],
    ["privacy", orDash(t.privacy)],
    ["storage", orDash(t.storage)],
    ["colour", t.color ? copyable(t.color, String(t.color), "hex")
      : node("span", t.storage === "ledger" ? "ledger tokens have no derived colour" : "none", "no")],
    ["name", orDash(t.name)],
    ["symbol", orDash(t.symbol)],
    ["decimals", t.decimals === null || t.decimals === undefined ? "-" : String(t.decimals)],
    ["status", statusBadge(t.status)],
    ["mint count", orDash(t.mintCount)],
    ["total minted", orDash(t.totalMinted)],
    ["first mint height", orDash(t.firstMintHeight)],
    ["last mint height", orDash(t.lastMintHeight)],
    ["first seen height", orDash(t.firstSeenHeight)],
    ["metadata updated height", orDash(t.metadataUpdatedHeight)],
    ["deploy height", orDash(t.deployHeight)],
    ["activity rows", orDash(t.activityCount)],
    ["last activity height", orDash(t.lastActivityHeight)],
    ["what the chain lets this page show", visibilityCell(t)]
  ]);
  main.appendChild(facts);

  var meta = node("section");
  meta.appendChild(node("h2", "metadata JSON"));
  if (t.metadata === null || t.metadata === undefined) {
    meta.appendChild(node("div", "no metadata published (or a multi-part document is still incomplete)", "empty"));
  } else {
    var pre = node("pre");
    var text;
    try { text = JSON.stringify(t.metadata, null, 2); } catch (e) { text = String(t.metadata); }
    pre.textContent = text;
    meta.appendChild(pre);
  }
  main.appendChild(meta);

  var traits = node("section");
  traits.appendChild(node("h2", "traits: every key with the event that set it"));
  if (d.keys.length === 0) {
    traits.appendChild(node("div", "no key/value pairs recorded for this token", "empty"));
  } else {
    var tb = tableIn(traits, ["key", "type", "value", "len", "projection", "block", "tx", "event id"]);
    var anyError = false;
    for (var k = 0; k < d.keys.length; k++) {
      var kv = d.keys[k];
      var row = document.createElement("tr");
      cell(row, traitKeyCell(kv));
      cell(row, node("span", typeLabel(kv.valType), "vtype"));
      cell(row, traitValueCell(kv));
      cell(row, orDash(kv.valLen), "num");
      if (kv.projectionError) {
        anyError = true;
        cell(row, node("span", String(kv.projectionError), "perr wrapv"));
      } else {
        cell(row, node("span", "-", "no"));
      }
      cell(row, orDash(kv.updatedHeight), "num");
      cell(row, copyable(kv.updatedTxHash, shortHex(kv.updatedTxHash, 8, 6), "hex"));
      cell(row, orDash(kv.eventId), "num");
      tb.appendChild(row);
    }
    if (anyError) {
      traits.appendChild(node("div",
        "a value in the projection column is a well-known key whose value does not follow the "
        + "standard's appendix A rule for it. The event was accepted and the trait is kept, only "
        + "the column it would have filled was not written",
        "note"));
    }
  }
  main.appendChild(traits);

  // The other representations of the same asset: MIP section 4 lets a consumer link the rows that
  // share (contract address, domain separator). This is where a contract that declares a ledger
  // book and mints native UTXOs reads as one asset in two forms rather than as a contradiction.
  var others = [];
  for (var sIdx = 0; sIdx < (d.siblings || []).length; sIdx++) {
    var sib = d.siblings[sIdx];
    if (sib && String(sib.domainSep) === String(t.domainSep) && Number(sib.kind) !== Number(t.kind)) {
      others.push(sib);
    }
  }
  if (others.length > 0) {
    var linked = node("section");
    linked.appendChild(node("h2", "other rows under this domain separator"));
    linked.appendChild(node("div",
      "the same contract and the same domain separator under another kind byte: the standard treats "
      + "each as its own token and lets a consumer show them as representations of one asset",
      "note"));
    var lb = tableIn(linked, ["kind", "colour", "name", "symbol", "mints", "status"]);
    for (var o = 0; o < others.length; o++) {
      var ot = others[o];
      var lr = document.createElement("tr");
      lr.className = "pick";
      cell(lr, kindCell(ot));
      cell(lr, colorCell(ot.color, ot.storage));
      cell(lr, nameCell(ot, index));
      cell(lr, orDash(ot.symbol));
      cell(lr, mintsCell(ot), "num");
      cell(lr, statusBadge(ot.status));
      (function (token) {
        lr.addEventListener("click", function () {
          go(hashToken({ address: t.address, domainSep: token.domainSep, kind: token.kind }));
        });
      })(ot);
      lb.appendChild(lr);
    }
    main.appendChild(linked);
  }

  var mints = node("section");
  mints.appendChild(node("h2", "mint history"));
  if (d.mints.length === 0) {
    mints.appendChild(node("div", t.storage === "ledger"
      ? "a ledger token is never minted natively, so it has no mint rows by construction"
      : "no mint observed for this token yet", "empty"));
  } else {
    var mb = tableIn(mints, ["block", "tx", "segment", "call", "entry point", "kind", "amount"]);
    for (var m = 0; m < d.mints.length; m++) {
      var mi = d.mints[m];
      var mr = document.createElement("tr");
      cell(mr, orDash(mi.blockHeight), "num");
      cell(mr, copyable(mi.txHash, shortHex(mi.txHash, 8, 6), "hex"));
      cell(mr, orDash(mi.segment), "num");
      cell(mr, orDash(mi.callIndex), "num");
      cell(mr, orDash(mi.entryPoint));
      cell(mr, orDash(mi.kind) + (mi.privacy ? " " + String(mi.privacy) : ""));
      cell(mr, orDash(mi.amount), "num");
      mb.appendChild(mr);
    }
  }
  main.appendChild(mints);

  // Q12: the mint table stays and the transactions table joins it — one list carries everything,
  // and the mint history the owner has seen is still where it was. What follows the mints depends
  // on what the chain publishes about this token: a shielded row gets the disclosure panel above
  // its table (US4), a ledger row gets its contract's calls under the public-data note (US7), and
  // DUST gets the note alone (Q13).
  var vis = visibilityOf(t);
  if (vis === "disclosed-imbalances") main.appendChild(disclosureSection(t));
  if (vis === "not-tracked") main.appendChild(dustSection());
  else if (vis === "calls-only") {
    main.appendChild(callsSection(d.calls, "contract calls · this is what a ledger token publishes",
      "a ledger token has no colour and no UTXO: its balances live in its contract's state, which "
      + "this indexer does not read. What is public is every call of the contract, listed above."));
  } else {
    main.appendChild(activitySection(t, d));
  }

  if (t.address) {
    main.appendChild(eventsSection(d.events, t.domainSep, "raw token-metadata events of this contract (rejected ones included)"));
  }

  if (d.notes.length > 0) {
    var notes = node("section");
    notes.appendChild(node("h2", "partial data"));
    for (var n = 0; n < d.notes.length; n++) notes.appendChild(node("div", d.notes[n], "err"));
    main.appendChild(notes);
  }
}

// ── Raw events (shared by the token and contract views) ─────────────────────────────────────

// Events of the whole contract, with this token's own lifted to the top: a five-piece collection
// emits five keys per piece, and hunting one piece's rename in 27 rows is not reading, it is work.
function orderEvents(events, markDomain) {
  var byId = events.slice().sort(function (a, b) {
    var x = Number(a.eventId === undefined ? a.id : a.eventId);
    var y = Number(b.eventId === undefined ? b.id : b.eventId);
    return (isNaN(x) ? 0 : x) - (isNaN(y) ? 0 : y);
  });
  if (!markDomain) return byId;
  var mine = [];
  var others = [];
  for (var i = 0; i < byId.length; i++) {
    var dom = byId[i].domainSep || byId[i].domain_sep;
    if (dom === markDomain) mine.push(byId[i]); else others.push(byId[i]);
  }
  return mine.concat(others);
}

function eventsSection(events, markDomain, heading) {
  var sec = node("section");
  sec.appendChild(node("h2", heading));
  if (!events || events.length === 0) {
    sec.appendChild(node("div", "no token-metadata event from this contract", "empty"));
    return sec;
  }
  if (markDomain) {
    sec.appendChild(node("div",
      "this token's own events first (highlighted), then the rest of the contract's, each in event-id "
      + "order, which is the order the fold applies them in, so the last row of a key is the value in force",
      "note"));
  }
  var tb = tableIn(sec, ["event id", "block", "tx", "domainSep", "kind", "key", "type", "len",
    "value", "applied", "reject reason"]);
  var ordered = orderEvents(events, markDomain);
  for (var i = 0; i < ordered.length; i++) {
    var e = ordered[i];
    var tr = document.createElement("tr");
    var dom = e.domainSep || e.domain_sep;
    if (markDomain && dom === markDomain) tr.className = "mark";
    cell(tr, orDash(e.eventId === undefined ? e.id : e.eventId), "num");
    cell(tr, orDash(e.blockHeight), "num");
    cell(tr, copyable(e.txHash, shortHex(e.txHash, 8, 6), "hex"));
    cell(tr, domainCell(dom));
    cell(tr, orDash(e.kindByte === undefined ? e.kind_byte : e.kindByte), "num");
    var key = e.keyText || (e.key ? hexText(e.key) : null) || e.key;
    cell(tr, orDash(key));
    cell(tr, node("span", typeLabel(e.valType), "vtype"));
    cell(tr, orDash(e.valLen === undefined ? e.len : e.valLen), "num");
    var value = e.text !== undefined && e.text !== null ? String(e.text)
      : (e.value ? (hexText(e.value) || shortHex(e.value, 10, 8)) : null);
    cell(tr, value === null ? node("span", "-", "no") : node("span", value, "wrapv"));
    cell(tr, e.applied === true ? node("span", "yes", "txt")
      : (e.applied === false ? node("span", "no", "err") : "-"));
    cell(tr, e.rejectReason ? node("span", String(e.rejectReason), "err wrapv") : node("span", "-", "no"));
    tb.appendChild(tr);
  }
  return sec;
}

// ── View: contract ──────────────────────────────────────────────────────────────────────────

function renderContract(main) {
  var c = state.contract;
  var crumb = node("div", null, "crumb");
  var back = node("a", "← all tokens");
  back.href = "#/";
  crumb.appendChild(back);
  main.appendChild(crumb);

  if (!c || !c.contract) {
    var miss = node("section");
    miss.appendChild(node("h2", "contract"));
    miss.appendChild(node("div", "not loaded (see the banner above). Address " + state.route.address, "empty"));
    main.appendChild(miss);
    return;
  }
  var d = c.contract;
  var head = node("section");
  head.appendChild(node("h2", "contract"));
  kvInto(head, [
    ["address", copyable(d.address, d.address ? String(d.address) : "-", "hex")],
    ["deploy height", orDash(d.deployHeight)],
    ["deploy tx", copyable(d.deployTxHash, d.deployTxHash ? String(d.deployTxHash) : "-", "hex")],
    ["last call height", orDash(d.lastCallHeight)]
  ]);
  main.appendChild(head);

  var toks = node("section");
  toks.appendChild(node("h2", "tokens of this contract"));
  var list = itemsOf(d.tokens ? { items: d.tokens } : null);
  if (list.length === 0) {
    toks.appendChild(node("div", "no token row for this contract yet", "empty"));
  } else {
    var index = familyIndex(list);
    var tb = tableIn(toks, ["domainSep", "kind", "colour", "name", "symbol", "dec",
      "mints", "status"]);
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var tr = document.createElement("tr");
      tr.className = "pick";
      cell(tr, domainCell(t.domainSep));
      cell(tr, kindCell(t));
      cell(tr, colorCell(t.color, t.storage));
      cell(tr, nameCell(t, index));
      cell(tr, orDash(t.symbol));
      cell(tr, t.decimals === null || t.decimals === undefined ? "-" : String(t.decimals), "num");
      cell(tr, mintsCell(t), "num");
      cell(tr, statusBadge(t.status));
      (function (token) {
        tr.addEventListener("click", function () {
          go(hashToken({ address: d.address, domainSep: token.domainSep, kind: token.kind }));
        });
      })(t);
      tb.appendChild(tr);
    }
  }
  main.appendChild(toks);

  var pend = node("section");
  pend.appendChild(node("h2", "pending event lookups"));
  var plist = d.pendingLookups && d.pendingLookups.length ? d.pendingLookups : [];
  if (plist.length === 0) {
    pend.appendChild(node("div", "none: every emitting call of this contract has had its events read", "empty"));
  } else {
    pend.appendChild(pendingTable(plist));
  }
  main.appendChild(pend);

  // US7: the same table a ledger token's page shows, under the same note — a contract's calls are
  // public whatever kind of token it issues.
  main.appendChild(callsSection(c.calls, "calls of this contract", null));

  main.appendChild(eventsSection(c.events, null, "raw token-metadata events of this contract (rejected ones included)"));

  if (c.notes.length > 0) {
    var notes = node("section");
    notes.appendChild(node("h2", "partial data"));
    for (var n = 0; n < c.notes.length; n++) notes.appendChild(node("div", c.notes[n], "err"));
    main.appendChild(notes);
  }
}

function pendingTable(plist) {
  var holder = node("div");
  var tb = tableIn(holder, ["tx", "address", "expected", "got", "attempts", "last error"]);
  for (var i = 0; i < plist.length; i++) {
    var p = plist[i];
    var tr = document.createElement("tr");
    cell(tr, copyable(p.txHash, shortHex(p.txHash, 8, 6), "hex"));
    cell(tr, copyable(p.address, shortHex(p.address, 8, 6), "hex"));
    cell(tr, orDash(p.expected), "num");
    cell(tr, orDash(p.got), "num");
    cell(tr, orDash(p.attempts), "num");
    cell(tr, p.lastError ? node("span", String(p.lastError), "err wrapv") : node("span", "-", "no"));
    tb.appendChild(tr);
  }
  return holder;
}

// ── View: status ────────────────────────────────────────────────────────────────────────────

function undisclosedCell(st) {
  var wrap = node("span");
  wrap.appendChild(node("span", orDash(counterOf(st, "undisclosedShieldedOffers")) + "  "));
  var link = node("a", "list them");
  link.href = "#/shielded-offers";
  wrap.appendChild(link);
  return wrap;
}
function renderStatus(main) {
  var st = state.status;
  var sec = node("section");
  sec.appendChild(node("h2", "indexer status  ·  " + P_STATUS));
  if (!st) {
    sec.appendChild(node("div", "the API did not answer (see the banner above)", "empty"));
    main.appendChild(sec);
    return;
  }
  var cur = st.decodeCursor || {};
  var counters = st.counters || {};
  kvInto(sec, [
    ["net", orDash(st.net)],
    ["archive tip", orDash(st.archiveTip)],
    ["decode cursor height", orDash(cur.height)],
    ["decode cursor position", orDash(cur.position)],
    ["contracts", orDash(st.contracts)],
    ["mints", orDash(counters.mints)],
    ["events applied", orDash(counters.eventsApplied)],
    ["events rejected", orDash(counters.eventsRejected)],
    ["lookups ok", orDash(counters.lookupsOk)],
    ["lookups short", orDash(counters.lookupsShort)],
    // 00023, FR-013
    ["activity rows", orDash(counterOf(st, "activityRows"))],
    ["seen tokens (colours no contract has named)", orDash(counterOf(st, "seenTokens"))],
    ["shielded offers", orDash(counterOf(st, "shieldedOffers"))],
    ["undisclosed shielded offers", undisclosedCell(st)],
    ["contract calls", orDash(counterOf(st, "contractCalls"))]
  ]);
  main.appendChild(sec);

  var pend = node("section");
  var plist = st.pendingLookups && st.pendingLookups.length ? st.pendingLookups : [];
  pend.appendChild(node("h2", "pending event lookups (" + plist.length + ")"));
  if (plist.length === 0) {
    pend.appendChild(node("div",
      "none: the scanner has read every event the transcripts promised", "empty"));
  } else {
    pend.appendChild(pendingTable(plist));
  }
  main.appendChild(pend);

  var raw = node("section");
  raw.appendChild(node("h2", "raw"));
  var pre = node("pre");
  try { pre.textContent = JSON.stringify(st, null, 2); } catch (e) { pre.textContent = String(st); }
  raw.appendChild(pre);
  main.appendChild(raw);
}

// ── Render ──────────────────────────────────────────────────────────────────────────────────

function render() {
  hideTip();
  renderBanner();
  renderStrip();
  renderTabs();
  var main = el("view");
  clear(main);
  if (state.route.view === "token") renderToken(main);
  else if (state.route.view === "contract") renderContract(main);
  else if (state.route.view === "status") renderStatus(main);
  else if (state.route.view === "tx") renderTx(main);
  else if (state.route.view === "offers") renderOffers(main);
  else renderList(main);
  // US2 scenario 3: a token opened from a transaction's activity list lands on its transactions.
  if (state.scrollTo) {
    var target = document.getElementById(state.scrollTo);
    state.scrollTo = null;
    if (target && target.scrollIntoView) target.scrollIntoView();
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────

function onHashChange() {
  var next = parseHash();
  var same = routeKey(next) === routeKey(state.route);
  state.route = next;
  if (!same) {
    if (next.view === "token") {
      state.detail = null;
      // A different token starts with an unfiltered, one-page, all-collapsed transactions section.
      state.act = { role: "", pages: 1, expand: {} };
    }
    if (next.view === "contract") { state.contract = null; state.act.pages = 1; }
    if (next.view === "tx") state.tx = null;
    if (next.view === "offers") { state.offers.loaded = false; state.offers.pages = 1; }
    if (next.view === "list") state.list.loaded = false;
  }
  render();
  refresh();
}
function applyFilters() {
  state.filters.kind = el("f-kind").value;
  state.filters.storage = el("f-storage").value;
  state.filters.status = el("f-status").value;
  state.filters.q = el("q").value.trim();
  state.list.loaded = false;
  state.list.items = [];
  render();
  refresh();
}
function schedule() {
  if (state.timer !== null) { window.clearInterval(state.timer); state.timer = null; }
  if (!state.paused) state.timer = window.setInterval(refresh, REFRESH_MS);
  el("toggle").textContent = state.paused ? "resume auto-refresh" : "pause auto-refresh";
}
function toggle() { state.paused = !state.paused; schedule(); if (!state.paused) refresh(); }

// The proof-of-concept notice can be hidden. The choice is kept in localStorage when the browser
// allows it (a private window may not), and an "about" button in the tab bar brings it back.
var POC_KEY = "umbra.poc.hidden";
function pocHidden() {
  try { return window.localStorage.getItem(POC_KEY) === "1"; } catch (e) { return false; }
}
function setPoc(hidden) {
  el("poc").hidden = hidden;
  el("poc-show").hidden = !hidden;
  try {
    if (hidden) window.localStorage.setItem(POC_KEY, "1");
    else window.localStorage.removeItem(POC_KEY);
  } catch (e) { /* not persisted; still applied for this visit */ }
}

window.addEventListener("DOMContentLoaded", function () {
  state.route = parseHash();
  setPoc(pocHidden());
  el("poc-hide").addEventListener("click", function () { setPoc(true); });
  el("poc-show").addEventListener("click", function () { setPoc(false); });
  el("now").addEventListener("click", function () { refresh(); });
  el("toggle").addEventListener("click", toggle);
  el("clear").addEventListener("click", function () {
    el("q").value = ""; el("f-kind").value = ""; el("f-storage").value = ""; el("f-status").value = "";
    applyFilters();
  });
  el("f-kind").addEventListener("change", applyFilters);
  el("f-storage").addEventListener("change", applyFilters);
  el("f-status").addEventListener("change", applyFilters);
  el("q").addEventListener("input", function () {
    if (state.debounce !== null) window.clearTimeout(state.debounce);
    state.debounce = window.setTimeout(function () { state.debounce = null; applyFilters(); }, 400);
  });
  el("q").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    if (state.debounce !== null) { window.clearTimeout(state.debounce); state.debounce = null; }
    applyFilters();
  });
  window.addEventListener("hashchange", onHashChange);
  render();
  schedule();
  refresh();
});
`;

// ── The document ─────────────────────────────────────────────────────────────────────────────

const BODY = `<aside id="poc" class="poc" role="note">
  <button id="poc-hide" class="poc-x" type="button" aria-controls="poc">HIDE</button>
  <div class="poc-h">Proof of concept</div>
  <p><b>This explorer lists every token on Midnight Stagenet</b>, with the name, symbol and
    decimals of each token whose contract publishes them.</p>
  <p>Midnight has no standard way for a token to publish its name, symbol or decimals. The draft
    standard <b>MIP-XXXX, On-Chain Token Metadata Emission</b>
    (<a href="https://github.com/midnightntwrk/midnight-improvement-proposals/pull/315" target="_blank" rel="noopener noreferrer">midnight-improvement-proposals PR&nbsp;#315</a>)
    adds one: a contract announces its token's metadata by emitting <b>events</b>, and an indexer
    like this one collects them.</p>
  <ul class="poc-links">
    <li>Indexer:
      <a href="https://github.com/acedward/UmbraDB/pull/19" target="_blank" rel="noopener noreferrer">UmbraDB PR&nbsp;#19</a></li>
    <li>Contracts:
      <a href="https://github.com/acedward/mip-erc7496-midnight-contracts" target="_blank" rel="noopener noreferrer">mip-erc7496-midnight-contracts</a></li>
    <li>Token addresses:
      <a href="https://github.com/effectstream/staging-tokens-addresses" target="_blank" rel="noopener noreferrer">staging-tokens-addresses</a></li>
  </ul>
</aside>
<header>
  <div class="brand">
    <svg viewBox="0 0 122.895 26.625" fill="currentColor" aria-hidden="true" focusable="false"> <g transform="translate(-42.52 -145.266)" fill-rule="evenodd"> <path d="M 55.832031 147.71875 C 61.816406 147.71875 66.6875 152.59375 66.6875 158.578125 C 66.6875 164.5625 61.816406 169.429688 55.832031 169.429688 C 49.847656 169.429688 44.972656 164.5625 44.972656 158.578125 C 44.972656 152.59375 49.847656 147.71875 55.832031 147.71875 Z M 55.832031 145.265625 C 48.480469 145.265625 42.519531 151.226562 42.519531 158.578125 C 42.519531 165.929688 48.480469 171.890625 55.832031 171.890625 C 63.183594 171.890625 69.144531 165.929688 69.144531 158.578125 C 69.144531 151.226562 63.183594 145.265625 55.832031 145.265625 Z M 55.832031 145.265625 "/> <path d="M 54.585938 157.328125 L 54.585938 159.824219 L 57.082031 159.824219 L 57.082031 157.328125 Z M 54.585938 157.328125 "/> <path d="M 54.585938 153.382812 L 54.585938 155.882812 L 57.082031 155.882812 L 57.082031 153.382812 Z M 54.585938 153.382812 "/> <path d="M 54.585938 149.4375 L 54.585938 151.933594 L 57.082031 151.933594 L 57.082031 149.4375 Z M 54.585938 149.4375 "/> <path d="M 82.28125 152.714844 C 81.414062 152.714844 80.636719 152.902344 79.953125 153.277344 C 79.570312 153.480469 79.226562 153.742188 78.929688 154.046875 L 78.929688 152.964844 L 75.792969 152.964844 L 75.792969 164.855469 L 78.929688 164.855469 L 78.929688 157.828125 C 78.929688 157.347656 79.035156 156.9375 79.246094 156.601562 C 79.464844 156.269531 79.742188 156.007812 80.089844 155.828125 C 80.433594 155.648438 80.828125 155.554688 81.269531 155.554688 C 81.929688 155.554688 82.480469 155.753906 82.921875 156.148438 C 83.371094 156.542969 83.59375 157.101562 83.59375 157.828125 L 83.59375 164.855469 L 86.722656 164.855469 L 86.722656 157.828125 C 86.722656 157.347656 86.828125 156.9375 87.046875 156.601562 C 87.257812 156.269531 87.542969 156.007812 87.894531 155.828125 C 88.25 155.648438 88.640625 155.554688 89.0625 155.554688 C 89.707031 155.554688 90.25 155.753906 90.695312 156.148438 C 91.136719 156.542969 91.359375 157.101562 91.359375 157.828125 L 91.359375 164.855469 L 94.515625 164.855469 L 94.515625 157.304688 C 94.515625 156.335938 94.308594 155.515625 93.898438 154.839844 C 93.488281 154.167969 92.929688 153.640625 92.222656 153.277344 C 91.515625 152.902344 90.726562 152.714844 89.859375 152.714844 C 88.980469 152.714844 88.167969 152.910156 87.449219 153.289062 C 86.859375 153.597656 86.367188 154.015625 85.957031 154.542969 C 85.585938 154 85.109375 153.574219 84.53125 153.261719 C 83.855469 152.902344 83.101562 152.714844 82.28125 152.714844 Z M 82.28125 152.714844 "/> <path d="M 95.984375 152.964844 L 95.984375 164.855469 L 99.113281 164.855469 L 99.113281 152.964844 Z M 95.984375 152.964844 "/> <path d="M 106.554688 155.605469 C 107.164062 155.605469 107.695312 155.746094 108.15625 156.039062 C 108.613281 156.324219 108.980469 156.707031 109.242188 157.191406 C 109.507812 157.683594 109.640625 158.253906 109.640625 158.914062 C 109.640625 159.570312 109.503906 160.117188 109.242188 160.613281 C 108.980469 161.105469 108.621094 161.488281 108.15625 161.769531 C 107.695312 162.046875 107.15625 162.191406 106.527344 162.191406 C 105.9375 162.191406 105.410156 162.054688 104.9375 161.78125 C 104.472656 161.515625 104.105469 161.125 103.839844 160.625 C 103.578125 160.125 103.449219 159.550781 103.449219 158.914062 C 103.449219 158.265625 103.578125 157.683594 103.839844 157.191406 C 104.105469 156.707031 104.472656 156.324219 104.9375 156.039062 C 105.410156 155.746094 105.945312 155.605469 106.554688 155.605469 Z M 109.441406 147.046875 L 109.441406 154.046875 C 109.125 153.726562 108.757812 153.46875 108.339844 153.25 C 107.660156 152.898438 106.882812 152.722656 106.011719 152.722656 C 104.910156 152.722656 103.921875 152.988281 103.050781 153.535156 C 102.183594 154.078125 101.492188 154.816406 100.996094 155.738281 C 100.492188 156.671875 100.238281 157.734375 100.238281 158.9375 C 100.238281 160.136719 100.492188 161.148438 100.996094 162.078125 C 101.492188 163.011719 102.183594 163.742188 103.050781 164.289062 C 103.925781 164.832031 104.910156 165.101562 106.011719 165.101562 C 106.863281 165.101562 107.644531 164.917969 108.339844 164.542969 C 108.769531 164.320312 109.144531 164.042969 109.464844 163.71875 L 109.464844 164.855469 L 112.570312 164.855469 L 112.570312 147.046875 Z M 109.441406 147.046875 "/> <path d="M 120.667969 152.722656 C 119.796875 152.722656 118.960938 152.914062 118.25 153.3125 C 117.847656 153.535156 117.5 153.808594 117.191406 154.132812 L 117.191406 152.964844 L 114.058594 152.964844 L 114.058594 164.855469 L 117.191406 164.855469 L 117.191406 158.023438 C 117.191406 157.546875 117.300781 157.117188 117.511719 156.738281 C 117.722656 156.359375 118.015625 156.070312 118.386719 155.863281 C 118.761719 155.660156 119.183594 155.558594 119.65625 155.558594 C 120.363281 155.558594 120.945312 155.789062 121.40625 156.25 C 121.871094 156.707031 122.101562 157.300781 122.101562 158.023438 L 122.101562 164.855469 L 125.230469 164.855469 L 125.230469 157.328125 C 125.230469 156.542969 125.03125 155.796875 124.640625 155.089844 C 124.242188 154.378906 123.703125 153.808594 123.011719 153.375 C 122.316406 152.941406 121.542969 152.722656 120.667969 152.722656 Z M 120.667969 152.722656 "/> <path d="M 126.675781 152.964844 L 126.675781 164.855469 L 129.804688 164.855469 L 129.804688 152.964844 Z M 126.675781 152.964844 "/> <path d="M 137.320312 155.578125 C 137.925781 155.578125 138.4375 155.714844 138.890625 155.976562 C 139.335938 156.238281 139.691406 156.597656 139.9375 157.050781 C 140.179688 157.503906 140.304688 158.03125 140.304688 158.640625 C 140.304688 159.25 140.179688 159.757812 139.9375 160.214844 C 139.691406 160.675781 139.34375 161.035156 138.890625 161.292969 C 138.4375 161.546875 137.902344 161.667969 137.292969 161.667969 C 136.683594 161.667969 136.183594 161.539062 135.730469 161.277344 C 135.277344 161.019531 134.921875 160.652344 134.667969 160.191406 C 134.414062 159.734375 134.289062 159.21875 134.289062 158.640625 C 134.289062 158.03125 134.414062 157.503906 134.667969 157.050781 C 134.921875 156.597656 135.277344 156.238281 135.730469 155.976562 C 136.183594 155.714844 136.710938 155.578125 137.320312 155.578125 Z M 136.679688 152.722656 C 135.628906 152.722656 134.671875 152.976562 133.816406 153.5 C 132.964844 154.015625 132.296875 154.714844 131.8125 155.605469 C 131.328125 156.492188 131.078125 157.496094 131.078125 158.613281 C 131.078125 159.734375 131.320312 160.738281 131.8125 161.640625 C 132.296875 162.53125 132.964844 163.242188 133.816406 163.769531 C 134.671875 164.296875 135.636719 164.558594 136.703125 164.558594 C 137.578125 164.558594 138.355469 164.382812 139.050781 164.03125 C 139.449219 163.824219 139.800781 163.570312 140.105469 163.269531 L 140.105469 164.316406 C 140.105469 165.214844 139.816406 165.929688 139.230469 166.445312 C 138.648438 166.964844 137.839844 167.21875 136.804688 167.21875 C 135.996094 167.21875 135.308594 167.078125 134.730469 166.792969 C 134.160156 166.5 133.636719 166.078125 133.175781 165.519531 L 131.179688 167.519531 C 131.753906 168.339844 132.523438 168.976562 133.488281 169.429688 C 134.449219 169.882812 135.566406 170.109375 136.851562 170.109375 C 138.136719 170.109375 139.207031 169.867188 140.167969 169.382812 C 141.132812 168.898438 141.882812 168.21875 142.429688 167.34375 C 142.96875 166.476562 143.242188 165.457031 143.242188 164.289062 L 143.242188 152.964844 L 140.132812 152.964844 L 140.132812 154.007812 C 139.828125 153.710938 139.472656 153.457031 139.0625 153.25 C 138.363281 152.898438 137.566406 152.722656 136.679688 152.722656 Z M 136.679688 152.722656 "/> <path d="M 144.578125 147.046875 L 144.578125 164.855469 L 147.707031 164.855469 L 147.707031 158.023438 C 147.707031 157.546875 147.816406 157.117188 148.03125 156.738281 C 148.242188 156.359375 148.539062 156.070312 148.90625 155.863281 C 149.277344 155.660156 149.699219 155.554688 150.179688 155.554688 C 150.878906 155.554688 151.464844 155.789062 151.929688 156.25 C 152.386719 156.707031 152.617188 157.300781 152.617188 158.023438 L 152.617188 164.855469 L 155.746094 164.855469 L 155.746094 157.328125 C 155.746094 156.429688 155.554688 155.628906 155.167969 154.925781 C 154.785156 154.230469 154.238281 153.683594 153.542969 153.300781 C 152.839844 152.914062 152.039062 152.714844 151.140625 152.714844 C 150.234375 152.714844 149.433594 152.914062 148.730469 153.3125 C 148.347656 153.53125 148.003906 153.796875 147.707031 154.105469 L 147.707031 147.046875 Z M 144.578125 147.046875 "/> <path d="M 159.496094 148.011719 L 159.496094 152.964844 L 156.683594 152.964844 L 156.683594 155.703125 L 159.496094 155.703125 L 159.496094 164.855469 L 162.632812 164.855469 L 162.632812 155.703125 L 165.414062 155.703125 L 165.414062 152.964844 L 162.632812 152.964844 L 162.632812 148.011719 Z M 159.496094 148.011719 "/> <path d="M 97.539062 147.414062 C 96.558594 147.414062 95.761719 148.207031 95.761719 149.191406 C 95.761719 150.171875 96.558594 150.964844 97.539062 150.964844 C 98.519531 150.964844 99.3125 150.171875 99.3125 149.191406 C 99.3125 148.207031 98.519531 147.414062 97.539062 147.414062 Z M 97.539062 147.414062 "/> <path d="M 128.242188 147.414062 C 127.261719 147.414062 126.464844 148.207031 126.464844 149.191406 C 126.464844 150.171875 127.261719 150.964844 128.242188 150.964844 C 129.222656 150.964844 130.015625 150.171875 130.015625 149.191406 C 130.015625 148.207031 129.222656 147.414062 128.242188 147.414062 Z M 128.242188 147.414062 "/> </g> </svg>
    <span class="rule"></span>
    <h1>Token explorer</h1>
  </div>
  <nav class="tabs">
    <a id="nav-list" href="#/">tokens</a>
    <a id="nav-offers" href="#/shielded-offers">shielded offers</a>
    <a id="nav-status" href="#/status">status</a>
    <span class="sep"></span>
    <span id="strip" class="strip"></span>
    <button id="poc-show" type="button" aria-controls="poc" hidden>about</button>
    <button id="now">refresh now</button>
    <button id="toggle">pause auto-refresh</button>
    <span class="note">every 10&nbsp;s</span>
  </nav>
</header>
<div id="banner" class="banner" hidden></div>
<section id="filters" class="filters">
  <label>search
    <input id="q" type="search" size="30" spellcheck="false" autocomplete="off"
           placeholder="name, symbol, colour or address">
  </label>
  <label>kind
    <select id="f-kind">
      <option value="">any</option>
      <option value="0">0 &middot; unshielded &middot; native</option>
      <option value="1">1 &middot; shielded &middot; native</option>
      <option value="2">2 &middot; unshielded &middot; ledger</option>
      <option value="3">3 &middot; shielded &middot; ledger</option>
    </select>
  </label>
  <label>storage
    <select id="f-storage">
      <option value="">any</option>
      <option value="native">native</option>
      <option value="ledger">ledger</option>
    </select>
  </label>
  <label>status
    <select id="f-status">
      <option value="">any</option>
      <option value="builtin">builtin</option>
      <option value="seen">seen</option>
      <option value="observed">observed</option>
      <option value="declared">declared</option>
      <option value="described">described</option>
    </select>
  </label>
  <button id="clear">clear</button>
  <span id="count" class="note"></span>
</section>
<main id="view"></main>
<template id="icon-link"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5l3-3"/><path d="M7.2 4.6l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7l-1.1 1.1"/><path d="M8.8 11.4l-1.1 1.1a2.6 2.6 0 0 1-3.7-3.7l1.1-1.1"/></svg></template>`;

function sha256Source(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/**
 * The page's Content Security Policy.
 *
 * Computed from the very bytes served below, so the hashes cannot drift from the code they
 * authorise — the same construction as the 00009 dashboard, and stricter than the
 * `script-src 'unsafe-inline'` floor the sub-plan allows: a policy that admits all inline code
 * would be a decoration, one that names this page's own two blocks is a control.
 *
 * `default-src 'none'` is the clause that makes "no external resource" a property of the browser
 * rather than a promise of this file: no script, style, image, font, frame or connection is
 * permitted unless a directive below names it. `connect-src 'self'` keeps every `fetch` on this
 * origin (the §5 routes); `img-src 'self' data:` allows a token's inline `data:` image from its
 * metadata document without allowing a remote tracking pixel; `form-action 'none'` and
 * `base-uri 'none'` remove the two ways an injected element could redirect a submission.
 */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  `script-src ${sha256Source(SCRIPT)}`,
  `style-src ${sha256Source(STYLE)}`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The whole explorer: one document, no external reference, no build step. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Midnight token explorer</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/ui/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script>${SCRIPT}</script>
</body>
</html>
`;

const HTML_BYTES = Buffer.byteLength(DASHBOARD_HTML, "utf8");

/** The path of the page, and the one path that redirects to it. */
const UI_PATH = "/ui";
const ROOT_PATH = "/";

/** `/ui` and `/ui/` are the same page; a query string is ignored. */
function pathOf(url: string): string {
  const noHash = url.split("#")[0] ?? "";
  const noQuery = noHash.split("?")[0] ?? "";
  if (noQuery === "") return ROOT_PATH;
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery;
}

/**
 * Serves the explorer.
 *
 * The token API (`token-indexer/api/server.ts`) calls this first for every request:
 *
 * - `GET|HEAD /ui` (and `/ui/`) → 200, the page, with {@link DASHBOARD_CSP} — returns `true`.
 * - `GET|HEAD /ui/outfit.woff2` → 200, the vendored brand font (cached for a day) — returns `true`.
 * - `GET|HEAD /ui/favicon.svg` and `/favicon.ico` → 200, the Midnight mark — returns `true`.
 * - `GET|HEAD /` → 302 to `/ui`, so typing the bare host and port lands on the page while the
 *   page itself keeps exactly one URL — returns `true`.
 * - anything else → returns `false` **without touching `res`**, so the API's own router answers
 *   it (including a non-GET method on `/ui`, which is the router's 405 to give, not this
 *   module's — the page has no business deciding the API's method policy).
 *
 * The headers are the whole security story of this route, because the page is static:
 * `content-security-policy` (above), `x-content-type-options: nosniff` (the payload is declared
 * HTML and must be read as HTML), `referrer-policy: no-referrer` (there is no external origin to
 * leak to today and there must not be one tomorrow) and `cache-control: no-store` (the page is
 * one string in the process; caching buys nothing and a stale explorer after an upgrade is a
 * support call).
 */
/** The favicon: the Midnight mark (style kit, p.32 vector) in white on a black rounded square,
 *  so it reads on light and dark tab bars alike. A standalone SVG document, so it carries its own
 *  namespace — it is served at its own path, never inlined into the page. */
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0a0a0a"/><g transform="translate(4.5 4.5) scale(0.863850) translate(-42.52 -145.266)" fill="#ffffff" fill-rule="evenodd"><path d="M 55.832031 147.71875 C 61.816406 147.71875 66.6875 152.59375 66.6875 158.578125 C 66.6875 164.5625 61.816406 169.429688 55.832031 169.429688 C 49.847656 169.429688 44.972656 164.5625 44.972656 158.578125 C 44.972656 152.59375 49.847656 147.71875 55.832031 147.71875 Z M 55.832031 145.265625 C 48.480469 145.265625 42.519531 151.226562 42.519531 158.578125 C 42.519531 165.929688 48.480469 171.890625 55.832031 171.890625 C 63.183594 171.890625 69.144531 165.929688 69.144531 158.578125 C 69.144531 151.226562 63.183594 145.265625 55.832031 145.265625 Z M 55.832031 145.265625"/><path d="M 54.585938 157.328125 L 54.585938 159.824219 L 57.082031 159.824219 L 57.082031 157.328125 Z M 54.585938 157.328125"/><path d="M 54.585938 153.382812 L 54.585938 155.882812 L 57.082031 155.882812 L 57.082031 153.382812 Z M 54.585938 153.382812"/><path d="M 54.585938 149.4375 L 54.585938 151.933594 L 57.082031 151.933594 L 57.082031 149.4375 Z M 54.585938 149.4375"/></g></svg>';
const FAVICON_SVG_PATH = "/ui/favicon.svg";
/** The same mark as a 16/32/48 px ICO, for browsers and tools that only ask for `/favicon.ico`. */
const FAVICON_ICO_PATH = "/favicon.ico";
let icoCache: Buffer | null | undefined;
function icoBytes(): Buffer | null {
  if (icoCache === undefined) {
    try {
      icoCache = readFileSync(new URL("./favicon.ico", import.meta.url));
    } catch {
      icoCache = null;
    }
  }
  return icoCache;
}

/** The brand font, read once. `null` when the file is absent, so the route falls through to the
 *  API's 404 and the page renders in its fallback stack. */
const FONT_PATH = "/ui/outfit.woff2";
let fontCache: Buffer | null | undefined;
function fontBytes(): Buffer | null {
  if (fontCache === undefined) {
    try {
      fontCache = readFileSync(new URL("./fonts/Outfit-Variable-latin.woff2", import.meta.url));
    } catch {
      fontCache = null;
    }
  }
  return fontCache;
}

export function serveUi(req: IncomingMessage, res: ServerResponse): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const path = pathOf(req.url ?? ROOT_PATH);

  if (path === UI_PATH) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(HTML_BYTES),
      "content-security-policy": DASHBOARD_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
    if (method === "HEAD") res.end();
    else res.end(DASHBOARD_HTML);
    return true;
  }

  if (path === FAVICON_SVG_PATH) {
    res.writeHead(200, {
      "content-type": "image/svg+xml",
      "content-length": String(Buffer.byteLength(FAVICON_SVG, "utf8")),
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=86400",
    });
    if (method === "HEAD") res.end();
    else res.end(FAVICON_SVG);
    return true;
  }

  if (path === FAVICON_ICO_PATH) {
    const ico = icoBytes();
    if (ico === null) return false;
    res.writeHead(200, {
      "content-type": "image/x-icon",
      "content-length": String(ico.length),
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=86400",
    });
    if (method === "HEAD") res.end();
    else res.end(ico);
    return true;
  }

  if (path === FONT_PATH) {
    const font = fontBytes();
    if (font === null) return false;
    res.writeHead(200, {
      "content-type": "font/woff2",
      "content-length": String(font.length),
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=86400",
    });
    if (method === "HEAD") res.end();
    else res.end(font);
    return true;
  }

  if (path === ROOT_PATH) {
    res.writeHead(302, { location: UI_PATH, "cache-control": "no-store", "content-length": "0" });
    res.end();
    return true;
  }

  return false;
}
