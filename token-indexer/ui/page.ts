import { createHash } from "node:crypto";
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
 * ── What it talks to ────────────────────────────────────────────────────────────────────────
 * Only the **relative** routes of spec §5, on its own origin:
 *
 *   GET /v1/tokens?kind&storage&status&q&limit&cursor
 *   GET /v1/contracts/:address
 *   GET /v1/contracts/:address/events?applied=false
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind/metadata
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind/mints?limit&cursor
 *   GET /internal/status
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
:root {
  --bg: #0f1115; --panel: #171a21; --panel2: #12161e; --line: #262b36; --ink: #e6e8ec;
  --dim: #9aa3b2; --accent: #6ea8fe; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
  --idle: #94a3b8; --violet: #c4b5fd;
}
* { box-sizing: border-box; }
/* A display rule on an element beats the user agent's [hidden] rule, and the filter bar is a
   flex container that the token/contract/status views hide — so say it once, loudly. */
[hidden] { display: none !important; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 13.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header { padding: 12px 18px 0; border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.02em; }
.sub { color: var(--dim); font-size: 12px; margin-top: 2px; }
nav.tabs { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 0 0; }
nav.tabs a { padding: 5px 10px; border: 1px solid var(--line); border-bottom: none;
  border-radius: 6px 6px 0 0; background: var(--panel2); color: var(--dim); }
nav.tabs a.on { background: var(--panel); color: var(--ink); border-color: var(--line); }
nav.tabs .sep { flex: 1 1 auto; }
.strip { color: var(--dim); font-size: 11.5px; white-space: nowrap; }
.strip b { color: var(--ink); font-weight: 600; }
.banner { margin: 10px 18px 0; padding: 8px 12px; border: 1px solid #7f1d1d; border-radius: 6px;
  background: #2a1416; color: #fecaca; font-size: 12px; white-space: pre-wrap; }
.filters { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; padding: 12px 18px 0; }
.filters label { color: var(--dim); font-size: 11.5px; display: flex; flex-direction: column; gap: 3px; }
main { padding: 12px 18px 48px; display: grid; gap: 14px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--dim);
  text-transform: uppercase; letter-spacing: 0.08em; }
h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; color: var(--dim); font-weight: 500; padding: 4px 8px 6px;
  border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
tr:last-child td { border-bottom: none; }
tbody tr.pick { cursor: pointer; }
tbody tr.pick:hover td { background: #1b202a; }
tr.built td { background: #141a24; }
tr.mark td { background: #1d2430; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; font-size: 12.5px; }
.kv .k { color: var(--dim); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; border: 1px solid; }
.st-builtin { color: var(--violet); border-color: #4c1d95; background: #1b1430; }
.st-observed { color: var(--accent); border-color: #1e3a8a; background: #111a2e; }
.st-declared { color: var(--warn); border-color: #78350f; background: #241a06; }
.st-described { color: var(--ok); border-color: #14532d; background: #0d2318; }
.st-inconsistent { color: var(--bad); border-color: #7f1d1d; background: #2a1416; }
.st-unknown { color: var(--idle); border-color: var(--line); background: var(--panel2); }
.fam { display: inline-block; min-width: 0; padding: 0 6px; margin-right: 6px; border-radius: 4px;
  font-size: 10.5px; border: 1px solid var(--line); color: var(--dim); }
.fam-ledger { color: #fdba74; border-color: #7c2d12; }
.fam-shielded { color: #5eead4; border-color: #115e59; }
.fam-unshielded { color: #93c5fd; border-color: #1e3a8a; }
.fam-constellations { color: var(--violet); border-color: #4c1d95; }
.fam-dual { color: #f0abfc; border-color: #701a75; }
.cp { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.cp.copied { color: var(--ok); text-decoration: none; }
.cp.copyfail { color: var(--bad); }
.cpbuf { position: fixed; top: -1000px; left: -1000px; opacity: 0; }
.note { color: var(--dim); font-size: 11.5px; }
.err { color: var(--bad); font-size: 12px; }
.empty { color: var(--dim); padding: 10px 2px; font-size: 12.5px; }
.txt { color: var(--ink); }
.hex { color: var(--dim); }
.no { color: var(--dim); }
pre { margin: 0; padding: 10px; background: var(--panel2); border: 1px solid var(--line);
  border-radius: 6px; font: inherit; font-size: 12px; white-space: pre-wrap; word-break: break-word;
  max-height: 420px; overflow: auto; }
button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 5px; cursor: pointer;
  background: #1e2430; color: var(--ink); border: 1px solid var(--line); }
button:hover:enabled { border-color: var(--accent); }
button:disabled { opacity: 0.4; cursor: default; }
input, select { font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 5px;
  background: #10141b; color: var(--ink); border: 1px solid var(--line); }
input:focus, select:focus { outline: 1px solid var(--accent); }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.crumb { color: var(--dim); font-size: 12px; margin-bottom: 8px; }
.wrapv { white-space: normal; word-break: break-word; max-width: 46ch; }
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
//   GET /v1/contracts/:address
//   GET /v1/contracts/:address/events?applied=false
//   GET /v1/contracts/:address/tokens/:domainSep/:kind
//   GET /v1/contracts/:address/tokens/:domainSep/:kind/metadata
//   GET /v1/contracts/:address/tokens/:domainSep/:kind/mints
//   GET /internal/status
var P_TOKENS = "/v1/tokens";
var P_CONTRACTS = "/v1/contracts";
var P_STATUS = "/internal/status";

var REFRESH_MS = 10000;
var LIST_LIMIT = 200;
var MINT_LIMIT = 200;

var state = {
  route: { view: "list" },
  filters: { kind: "", storage: "", status: "", q: "" },
  list: { items: [], nextCursor: null, loaded: false },
  detail: null,
  contract: null,
  status: null,
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
    var err = new Error(res.status + " " + code + " — " + path);
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
  if (parts[0] === "contract" && parts.length >= 2) return { view: "contract", address: parts[1] };
  if (parts[0] === "token" && parts.length >= 4) {
    return { view: "token", address: parts[1], domainSep: parts[2], kind: parts[3] };
  }
  return { view: "list" };
}
function hashToken(t) {
  return "#/token/" + enc(t.address) + "/" + enc(t.domainSep) + "/" + enc(t.kind);
}
function hashContract(a) { return "#/contract/" + enc(a); }
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
  a.title = (parsed.local ? "rewritten to this origin: " + parsed.href : parsed.label) + " — opens the metadata document in a new tab";
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
  // The hex form always resolves (spec §5 accepts the 64-hex address and domain separator), so it
  // is offered beside the pretty one — with a short label, because 130 characters of hex in a link
  // is not a link, it is a wall.
  if (t.address && t.domainSep) {
    out.push({
      label: "resolver (hex form)",
      path: "/" + enc(t.address) + "/" + enc(t.domainSep),
      short: "/" + shortHex(t.address, 6, 4) + "/" + shortHex(t.domainSep, 6, 4)
    });
  }
  return out;
}

// ── Token cells ─────────────────────────────────────────────────────────────────────────────

function statusBadge(s) {
  var v = s ? String(s) : "unknown";
  var known = ["builtin", "observed", "declared", "described", "inconsistent"];
  var cls = known.indexOf(v) < 0 ? "st-unknown" : "st-" + v;
  return node("span", v, "badge " + cls);
}
// The reference set names its families in the first word of the name and the first letter of the
// symbol (spec §7.1), so the page can label them without knowing anything about the deployment.
function familyOf(t) {
  var first = String(t.name || "").split(" ")[0].toLowerCase();
  var known = ["ledger", "shielded", "unshielded", "constellations", "dual"];
  if (known.indexOf(first) >= 0) return first;
  return null;
}
function nameCell(t) {
  var wrap = node("span");
  var fam = familyOf(t);
  if (fam) wrap.appendChild(node("span", fam, "fam fam-" + fam));
  wrap.appendChild(node("span", t.name ? String(t.name) : "(undescribed)", t.name ? "txt" : "no"));
  return wrap;
}
function domainCell(d) {
  var text = hexText(d);
  if (text !== null) return copyable(d, text, "txt");
  return copyable(d, shortHex(d, 8, 6), "hex");
}
// A colour is absent for exactly two reasons, and they are different facts: a ledger token never
// has one (nothing is minted, so nothing is derived), and DUST has none at all — the ledger types
// it as a unit variant, not as 32 bytes. Neither is rendered as an empty cell.
function colorCell(c, storage) {
  if (!c) {
    if (storage === "ledger") return node("span", "— ledger token", "no");
    return node("span", "— none", "no");
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
  if (!t.address) return node("span", "— built-in", "no");
  if (isZeroHex(t.address)) return node("span", "— built-in", "no");
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
function sortTokens(items) {
  var built = [];
  var rest = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i] && items[i].status === "builtin") built.push(items[i]); else rest.push(items[i]);
  }
  built.sort(function (a, b) { return String(a.symbol) < String(b.symbol) ? 1 : -1; });  // NIGHT, then DUST
  return built.concat(rest);
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
async function loadToken(r) {
  var d = { token: null, keys: [], mints: [], events: [], notes: [] };
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
      function (e) { d.notes.push("raw events unavailable: " + e.message); })
  ]);
  state.detail = d;
}
async function loadContract(address) {
  var c = { contract: null, events: [], notes: [] };
  c.contract = await api(P_CONTRACTS + "/" + enc(address));
  await api(contractEventsPath(address)).then(
    function (p) { c.events = itemsOf(p); },
    function (e) { c.notes.push("raw events unavailable: " + e.message); });
  state.contract = c;
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
  b.appendChild(node("div", "the API did not answer everything this view needs — what is shown may be stale"));
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
  el("nav-list").className = state.route.view === "status" ? "" : "on";
  el("nav-status").className = state.route.view === "status" ? "on" : "";
  el("filters").hidden = state.route.view !== "list";
}

// ── View: list ──────────────────────────────────────────────────────────────────────────────

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
      "no token matches. The indexer creates a row from an observed mint or an emitted TokenMetadata event — "
      + "on a quiet chain the built-in NIGHT and DUST rows are all there is.", "empty"));
    main.appendChild(sec);
    return;
  }
  var tbody = tableIn(sec, ["address", "domainSep", "kind", "storage", "colour", "name", "symbol",
    "dec", "mints", "first … last", "status", "tokenUri"]);
  for (var i = 0; i < items.length; i++) {
    var t = items[i];
    var tr = document.createElement("tr");
    tr.className = t.status === "builtin" ? "pick built" : "pick";
    cell(tr, addressCell(t));
    cell(tr, domainCell(t.domainSep));
    cell(tr, orDash(t.kind));
    cell(tr, orDash(t.storage));
    cell(tr, colorCell(t.color, t.storage));
    cell(tr, nameCell(t));
    cell(tr, orDash(t.symbol));
    cell(tr, t.decimals === null || t.decimals === undefined ? "-" : String(t.decimals), "num");
    cell(tr, mintsCell(t), "num");
    cell(tr, heightsCell(t));
    cell(tr, statusBadge(t.status));
    cell(tr, uriLink(t.tokenUri));
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
    + "hardcoded NIGHT and DUST entries, every other row comes from an observed mint or an emitted event",
    "note"));
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
  crumb.appendChild(node("span", "  ·  "));
  var toContract = node("a", "contract " + shortHex(r.address, 8, 6));
  toContract.href = hashContract(r.address);
  crumb.appendChild(toContract);
  main.appendChild(crumb);

  if (!d || !d.token) {
    var miss = node("section");
    miss.appendChild(node("h2", "token"));
    miss.appendChild(node("div", "not loaded — see the banner above; the route is "
      + r.address + " / " + r.domainSep + " / " + r.kind, "empty"));
    main.appendChild(miss);
    return;
  }
  var t = d.token;

  var head = node("section");
  var title = node("h3");
  title.appendChild(nameCell(t));
  head.appendChild(title);
  var sub = node("div", null, "row");
  sub.appendChild(statusBadge(t.status));
  sub.appendChild(node("span", (t.symbol ? String(t.symbol) : "no symbol")
    + " · " + orDash(t.kind) + " · " + orDash(t.storage)
    + " · decimals " + (t.decimals === null || t.decimals === undefined ? "-" : t.decimals), "note"));
  head.appendChild(sub);
  if (t.status === "inconsistent") {
    head.appendChild(node("div",
      "This contract declared something its own mints contradict (spec §6.2): the observed mint decides "
      + "kind and storage, the declared fields are still shown.", "err"));
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
    a.title = paths[i].path + " — opens the metadata document in a new tab";
    a.rel = "noreferrer noopener";
    a.target = "_blank";
    links.appendChild(a);
  }
  head.appendChild(links);
  main.appendChild(head);

  var facts = node("section");
  facts.appendChild(node("h2", "token"));
  kvInto(facts, [
    ["address", isZeroHex(t.address) ? node("span", "— built-in row, no contract", "no")
      : copyable(t.address, t.address ? String(t.address) : "-", "hex")],
    ["domainSep", domainCell(t.domainSep)],
    ["domainSep (hex)", copyable(t.domainSep, t.domainSep ? String(t.domainSep) : "-", "hex")],
    ["kind", orDash(t.kind)],
    ["storage", orDash(t.storage)],
    ["colour", t.color ? copyable(t.color, String(t.color), "hex")
      : node("span", t.storage === "ledger" ? "— ledger tokens have no derived colour" : "— none", "no")],
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
    ["deploy height", orDash(t.deployHeight)]
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
  traits.appendChild(node("h2", "traits — every key with the event that set it"));
  if (d.keys.length === 0) {
    traits.appendChild(node("div", "no key/value pairs recorded for this token", "empty"));
  } else {
    var tb = tableIn(traits, ["key", "text", "value (hex)", "len", "block", "tx", "event id"]);
    for (var k = 0; k < d.keys.length; k++) {
      var kv = d.keys[k];
      var row = document.createElement("tr");
      cell(row, orDash(kv.key && !isHex(kv.key) ? kv.key : (hexText(kv.key) || kv.key)));
      cell(row, kv.text === null || kv.text === undefined
        ? node("span", "not UTF-8", "no")
        : node("span", String(kv.text), "txt wrapv"));
      cell(row, copyable(kv.value, shortHex(kv.value, 10, 8), "hex"));
      cell(row, orDash(kv.len), "num");
      cell(row, orDash(kv.updatedHeight), "num");
      cell(row, copyable(kv.updatedTxHash, shortHex(kv.updatedTxHash, 8, 6), "hex"));
      cell(row, orDash(kv.eventId), "num");
      tb.appendChild(row);
    }
  }
  main.appendChild(traits);

  var mints = node("section");
  mints.appendChild(node("h2", "mint history"));
  if (d.mints.length === 0) {
    mints.appendChild(node("div", t.storage === "ledger"
      ? "a ledger token is never minted natively — it has no mint rows by construction"
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
      cell(mr, orDash(mi.kind));
      cell(mr, orDash(mi.amount), "num");
      mb.appendChild(mr);
    }
  }
  main.appendChild(mints);

  main.appendChild(eventsSection(d.events, t.domainSep, "raw TokenMetadata events of this contract (rejected ones included)"));

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
    sec.appendChild(node("div", "no TokenMetadata event from this contract", "empty"));
    return sec;
  }
  if (markDomain) {
    sec.appendChild(node("div",
      "this token's own events first (highlighted), then the rest of the contract's, each in event-id "
      + "order — which is the order the fold applies them in, so the last row of a key is the value in force",
      "note"));
  }
  var tb = tableIn(sec, ["event id", "block", "tx", "domainSep", "kind byte", "key", "len",
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
    cell(tr, orDash(e.len), "num");
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
    miss.appendChild(node("div", "not loaded — see the banner above; address " + state.route.address, "empty"));
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
    var tb = tableIn(toks, ["domainSep", "kind", "storage", "colour", "name", "symbol", "dec",
      "mints", "status"]);
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var tr = document.createElement("tr");
      tr.className = "pick";
      cell(tr, domainCell(t.domainSep));
      cell(tr, orDash(t.kind));
      cell(tr, orDash(t.storage));
      cell(tr, colorCell(t.color, t.storage));
      cell(tr, nameCell(t));
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
    pend.appendChild(node("div", "none — every emitting call of this contract has had its events read", "empty"));
  } else {
    pend.appendChild(pendingTable(plist));
  }
  main.appendChild(pend);

  main.appendChild(eventsSection(c.events, null, "raw TokenMetadata events of this contract (rejected ones included)"));

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

function renderStatus(main) {
  var st = state.status;
  var sec = node("section");
  sec.appendChild(node("h2", "indexer status  ·  " + P_STATUS));
  if (!st) {
    sec.appendChild(node("div", "the API did not answer — see the banner above", "empty"));
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
    ["lookups short", orDash(counters.lookupsShort)]
  ]);
  main.appendChild(sec);

  var pend = node("section");
  var plist = st.pendingLookups && st.pendingLookups.length ? st.pendingLookups : [];
  pend.appendChild(node("h2", "pending event lookups (" + plist.length + ")"));
  if (plist.length === 0) {
    pend.appendChild(node("div",
      "none — the scanner has read every event the transcripts promised", "empty"));
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
  renderBanner();
  renderStrip();
  renderTabs();
  var main = el("view");
  clear(main);
  if (state.route.view === "token") renderToken(main);
  else if (state.route.view === "contract") renderContract(main);
  else if (state.route.view === "status") renderStatus(main);
  else renderList(main);
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────

function onHashChange() {
  var next = parseHash();
  var same = next.view === state.route.view && next.address === state.route.address
    && next.domainSep === state.route.domainSep && next.kind === state.route.kind;
  state.route = next;
  if (!same) {
    if (next.view === "token") state.detail = null;
    if (next.view === "contract") state.contract = null;
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

window.addEventListener("DOMContentLoaded", function () {
  state.route = parseHash();
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

const BODY = `<header>
  <h1>Midnight token explorer</h1>
  <div class="sub">every token the indexer has seen &mdash; what was <em>observed</em> on chain (mints)
    beside what each contract <em>declared</em> about itself (<code>TokenMetadata</code> events)</div>
  <nav class="tabs">
    <a id="nav-list" href="#/">tokens</a>
    <a id="nav-status" href="#/status">status</a>
    <span class="sep"></span>
    <span id="strip" class="strip"></span>
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
      <option value="shielded">shielded</option>
      <option value="unshielded">unshielded</option>
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
      <option value="observed">observed</option>
      <option value="declared">declared</option>
      <option value="described">described</option>
      <option value="inconsistent">inconsistent</option>
    </select>
  </label>
  <button id="clear">clear</button>
  <span id="count" class="note"></span>
</section>
<main id="view"></main>`;

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
  "font-src 'none'",
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

  if (path === ROOT_PATH) {
    res.writeHead(302, { location: UI_PATH, "cache-control": "no-store", "content-length": "0" });
    res.end();
    return true;
  }

  return false;
}
