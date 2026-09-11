import { createHash } from "node:crypto";

/**
 * The shielded-monitor dashboard: one self-contained HTML page, served by the API process
 * (organizer sub-plan 00009-06; `openspec/changes/00009-06-dashboard/design.md` §1, §3, §5).
 *
 * ── Why this is a string constant and not a file, a template or a bundle ────────────────────
 * `design/design.md` §7 makes dependency minimalism a rule of this repository. A front end is
 * exactly where that rule is usually waived, so it is stated here: this page has **no framework,
 * no bundler, no CSS library, no icon font, no web font and no external resource of any kind**,
 * and `package.json`'s `dependencies` is unchanged by the change that added it.
 *
 * It is a string rather than a `.html` read at startup because a runtime file has to survive
 * `tsc` (which emits only TypeScript), `scripts/copy-cli-assets.mjs` and `npm pack` — three
 * chances to ship a binary whose dashboard is a stack trace. A string constant compiled into the
 * module cannot go missing.
 *
 * ── The key never touches this module ───────────────────────────────────────────────────────
 * The page holds a viewing key in one `<input type="password">` for the duration of one `fetch`,
 * sends it as the `viewingKey` field of a `POST /v1/monitors` body, and clears the field on both
 * success and failure. It is never placed in a URL, never written to `localStorage` or
 * `sessionStorage`, never rendered back into the DOM, and never included in an error message the
 * page prints (registration failures render the server's `error.code`, which FR-001 already makes
 * one generic value). Every value that reaches the document goes through `textContent` — this
 * module contains no `innerHTML` assignment at all — so nothing a server response carries can
 * become markup.
 *
 * ── Layout of this file ─────────────────────────────────────────────────────────────────────
 * `STYLE` and `SCRIPT` are separate constants so their SHA-256 hashes can be computed from the
 * same bytes that are served, and the Content Security Policy can name those hashes instead of
 * `'unsafe-inline'`. A policy that admits all inline code would be a decoration; one that admits
 * exactly this page's own two blocks is a control.
 */

// ── Style ────────────────────────────────────────────────────────────────────────────────────

const STYLE = `
:root {
  --bg: #0f1115; --panel: #171a21; --line: #262b36; --ink: #e6e8ec; --dim: #9aa3b2;
  --accent: #6ea8fe; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; --idle: #94a3b8;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
header { padding: 14px 18px; border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.02em; }
.sub { color: var(--dim); font-size: 12px; margin-top: 2px; }
.warnbar {
  margin: 10px 18px 0; padding: 8px 12px; border: 1px solid #7f1d1d; border-radius: 6px;
  background: #2a1416; color: #fecaca; font-size: 12px;
}
main { padding: 14px 18px 40px; display: grid; gap: 14px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; color: var(--dim); font-weight: 500; padding: 4px 8px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
tr.sel td { background: #1d222c; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; border: 1px solid; }
.s-live { color: var(--ok); border-color: #14532d; background: #0d2318; }
.s-backfilling { color: var(--accent); border-color: #1e3a8a; background: #111a2e; }
.s-paused { color: var(--warn); border-color: #78350f; background: #241a06; }
.s-failed, .s-stale_source { color: var(--bad); border-color: #7f1d1d; background: #2a1416; }
.s-revoked { color: var(--idle); border-color: #334155; background: #161b22; }
.bar { position: relative; height: 8px; border-radius: 4px; background: #10141b; border: 1px solid var(--line); overflow: hidden; min-width: 130px; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.nums { color: var(--dim); font-size: 11.5px; margin-top: 3px; white-space: nowrap; }
.mono { font-family: inherit; }
.hash { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
button { font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 5px; cursor: pointer;
  background: #1e2430; color: var(--ink); border: 1px solid var(--line); }
button:hover:enabled { border-color: var(--accent); }
button:disabled { opacity: 0.4; cursor: default; }
button.danger { color: #fca5a5; }
input, select { font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 5px;
  background: #10141b; color: var(--ink); border: 1px solid var(--line); }
input:focus, select:focus { outline: 1px solid var(--accent); }
label { display: block; color: var(--dim); font-size: 11.5px; margin-bottom: 3px; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.grow { flex: 1 1 360px; }
.note { color: var(--dim); font-size: 11.5px; }
.err { color: var(--bad); font-size: 12px; }
.ok { color: var(--ok); font-size: 12px; }
.empty { color: var(--dim); padding: 10px 2px; font-size: 12.5px; }
.tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--idle); }
.dot.up { background: var(--ok); } .dot.down { background: var(--bad); }
.wide { width: 100%; }
.mt8 { margin-top: 8px; }
`;

// ── Behaviour ────────────────────────────────────────────────────────────────────────────────

const SCRIPT = `
"use strict";
// Every API path this page uses. They are literals so the route-coverage test can find them and
// check each one against the server's own route table.
var PATH_HEALTH = "/v1/health";
var PATH_MONITORS = "/v1/monitors";
function pathMonitor(id) { return "/v1/monitors/" + id; }
function pathMatches(id) { return "/v1/monitors/" + id + "/matches"; }
function pathAction(id, action) { return "/v1/monitors/" + id + "/" + action; }
function matchesQuery(id, cursor) {
  return pathMatches(id) + "?limit=" + MATCH_PAGE + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
}

// Every route pattern this page calls, spelled out so the route-coverage test can read them off
// the served HTML and check each against the server's own table:
//   GET    /v1/health
//   GET    /v1/monitors
//   POST   /v1/monitors
//   GET    /v1/monitors/:id/matches
//   POST   /v1/monitors/:id/pause
//   POST   /v1/monitors/:id/resume
//   POST   /v1/monitors/:id/revoke
//   DELETE /v1/monitors/:id

var REFRESH_MS = 3000;
var MATCH_PAGE = 50;

var state = {
  timer: null, paused: false, selected: null, inflight: false,
  monitors: [], sourceTip: null, net: null, health: null,
  matches: [], cursor: "", exhausted: false, matchesFor: null, matchCoverage: null, matchesError: null,
};

function el(id) { return document.getElementById(id); }
function node(tag, text, className) {
  var n = document.createElement(tag);
  // textContent only. This page assigns no markup anywhere, so nothing a response carries can
  // become HTML — a property the served document is tested for by literal search, which is why
  // even this comment avoids naming the sink.
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (className) n.className = className;
  return n;
}

async function api(method, path, body) {
  var init = { method: method, headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  var res = await fetch(path, init);
  var text = await res.text();
  var parsed = null;
  if (text !== "") { try { parsed = JSON.parse(text); } catch (e) { parsed = null; } }
  if (!res.ok) {
    var code = parsed && parsed.error && parsed.error.code ? parsed.error.code : "HTTP_" + res.status;
    var err = new Error(code);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  return parsed;
}

// ── Coverage rendering (FR-011 / FR-020) ────────────────────────────────────────────────────
// "not scanned" and "unknown" are spelled out. A null is never drawn as 0, and the bar is drawn
// only when both ends of the ratio are actually known — an unscanned range must never be able to
// look like a completed empty one.
function big(v) { try { return v === null || v === undefined ? null : BigInt(v); } catch (e) { return null; } }

function percent(coverage) {
  var start = big(coverage.requestedStart), through = big(coverage.scannedThrough), tip = big(coverage.sourceTip);
  if (through === null || tip === null) return null;
  var from = start === null ? 0n : start;
  if (tip <= from) return through >= tip ? 100 : 0;
  var done = through < from ? 0n : through - from;
  var span = tip - from;
  if (done >= span) return 100;
  return Number((done * 10000n) / span) / 100;
}

function coverageCell(coverage) {
  var wrap = node("div");
  var pct = percent(coverage);
  if (pct === null) {
    wrap.appendChild(node("div", coverage.sourceTip === null ? "tip unknown" : "not scanned", "note"));
  } else {
    var bar = node("div", null, "bar");
    var fill = document.createElement("i");
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    wrap.appendChild(bar);
  }
  wrap.appendChild(node("div",
    "start " + coverage.requestedStart +
    " · from " + (coverage.scannedFrom === null ? "not scanned" : coverage.scannedFrom) +
    " · through " + (coverage.scannedThrough === null ? "not scanned" : coverage.scannedThrough) +
    " · tip " + (coverage.sourceTip === null ? "unknown" : coverage.sourceTip) +
    (pct === null ? "" : " (" + pct.toFixed(1) + "%)"), "nums"));
  return wrap;
}

// ── Monitors ────────────────────────────────────────────────────────────────────────────────

function actionButton(label, kind, monitor, handler) {
  var b = node("button", label, kind);
  b.addEventListener("click", function (ev) { ev.stopPropagation(); handler(monitor); });
  return b;
}

async function lifecycle(monitor, action) {
  if (action === "revoke" || action === "delete") {
    if (!window.confirm(action + " monitor " + monitor.monitorId + "? This cannot be undone.")) return;
  }
  try {
    if (action === "delete") await api("DELETE", pathMonitor(monitor.monitorId));
    else await api("POST", pathAction(monitor.monitorId, action));
    if (action === "delete" && state.selected === monitor.monitorId) selectMonitor(null);
    say("ok", action + " applied");
  } catch (e) { say("err", action + " refused: " + e.message); }
  await refresh();
}

function renderMonitors() {
  var host = el("monitors");
  host.textContent = "";
  if (state.monitors.length === 0) {
    host.appendChild(node("div", "No monitors yet. Register a viewing key below.", "empty"));
    return;
  }
  var table = node("table");
  var head = node("tr");
  ["", "monitor", "state", "coverage", "last error", ""].forEach(function (h) { head.appendChild(node("th", h)); });
  table.appendChild(head);
  state.monitors.forEach(function (m) {
    var tr = node("tr");
    if (m.monitorId === state.selected) tr.className = "sel";
    tr.addEventListener("click", function () { selectMonitor(m.monitorId); });

    var pick = node("td");
    var b = node("button", m.monitorId === state.selected ? "shown" : "matches");
    b.addEventListener("click", function (ev) { ev.stopPropagation(); selectMonitor(m.monitorId); });
    pick.appendChild(b);
    tr.appendChild(pick);

    var idCell = node("td");
    idCell.appendChild(node("div", m.monitorId, "mono"));
    idCell.appendChild(node("div", "net " + m.net + " · " + m.ledgerBuild + " · " + m.matchingRuleVersion, "nums"));
    tr.appendChild(idCell);

    var stateCell = node("td");
    stateCell.appendChild(node("span", m.state, "badge s-" + m.state));
    tr.appendChild(stateCell);

    var cov = node("td");
    cov.appendChild(coverageCell(m.coverage));
    tr.appendChild(cov);

    tr.appendChild(node("td", m.lastError ? m.lastError.code + (m.lastError.atHeight ? " @" + m.lastError.atHeight : "") : "—"));

    var actions = node("td");
    var tools = node("div", null, "tools");
    var running = m.state === "backfilling" || m.state === "live";
    if (running) tools.appendChild(actionButton("pause", "", m, function (x) { lifecycle(x, "pause"); }));
    if (m.state === "paused") tools.appendChild(actionButton("resume", "", m, function (x) { lifecycle(x, "resume"); }));
    if (m.state !== "revoked") tools.appendChild(actionButton("revoke", "danger", m, function (x) { lifecycle(x, "revoke"); }));
    tools.appendChild(actionButton("delete", "danger", m, function (x) { lifecycle(x, "delete"); }));
    actions.appendChild(tools);
    tr.appendChild(actions);

    table.appendChild(tr);
  });
  host.appendChild(table);
}

// ── Matches ─────────────────────────────────────────────────────────────────────────────────

function selectMonitor(id) {
  state.selected = id;
  state.matches = []; state.cursor = ""; state.exhausted = false; state.matchesFor = id;
  state.matchCoverage = null; state.matchesError = null;
  renderMonitors();
  renderMatches();
  if (id !== null) loadMoreMatches();
}

async function loadMoreMatches() {
  var id = state.selected;
  if (id === null) return;
  var query = matchesQuery(id, state.cursor);
  try {
    var page = await api("GET", query);
    if (state.matchesFor !== id) return;               // selection changed mid-flight
    // The stream is paged FORWARD from a cursor, so loading more walks towards the newest match;
    // the rendering below reverses what has been loaded so the newest sits at the top.
    page.items.forEach(function (item) { state.matches.push(item); });
    state.cursor = page.nextCursor;
    state.exhausted = page.items.length === 0;
    state.matchCoverage = page.coverage;
    renderMatches();
  } catch (e) {
    if (state.matchesFor !== id) return;
    // A revoked or deleted monitor is a settled answer, not a transient fault: stop asking, and
    // render the reason where the matches would be. Without this the 3 s poll would repeat the
    // same refusal into the status line forever.
    if (e.code === "MONITOR_REVOKED" || e.code === "MONITOR_NOT_FOUND") {
      state.matchesError = e.code;
      state.exhausted = true;
      renderMatches();
      return;
    }
    say("err", "matches: " + e.message);
  }
}

function copyable(text) {
  var span = node("span", text, "hash");
  span.title = "click to copy";
  span.addEventListener("click", function () {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { say("ok", "copied"); }, function () {});
  });
  return span;
}

function renderMatches() {
  var host = el("matches");
  var title = el("matches-title");
  host.textContent = "";
  if (state.selected === null) {
    title.textContent = "matches";
    host.appendChild(node("div", "Select a monitor to see its matches.", "empty"));
    return;
  }
  title.textContent = "matches · " + state.selected;
  if (state.matchCoverage) {
    host.appendChild(coverageCell(state.matchCoverage));
  }
  if (state.matchesError !== null) {
    host.appendChild(node("div",
      state.matchesError === "MONITOR_REVOKED"
        ? "This monitor is revoked; its matches are no longer readable."
        : "This monitor no longer exists.", "empty"));
  } else if (state.matches.length === 0) {
    // Never a bare "no matches": the coverage line above says whether anything has been looked at
    // at all, which is the FR-020 distinction this panel exists to keep visible.
    host.appendChild(node("div", "No matches in the scanned range yet.", "empty"));
  } else {
    var table = node("table");
    var head = node("tr");
    ["height", "pos", "tx hash", "segments", "source", "applied"].forEach(function (h) { head.appendChild(node("th", h)); });
    table.appendChild(head);
    for (var i = state.matches.length - 1; i >= 0; i--) {       // newest first
      var m = state.matches[i];
      var tr = node("tr");
      tr.appendChild(node("td", m.blockHeight));
      tr.appendChild(node("td", String(m.position)));
      var h = node("td");
      h.appendChild(copyable(m.txHash));
      tr.appendChild(h);
      tr.appendChild(node("td", m.matchedSegments.join(", ")));
      tr.appendChild(node("td", m.sourceOutcome === undefined ? "—" : m.sourceOutcome));
      tr.appendChild(node("td", m.appliedOutcome));
      table.appendChild(tr);
    }
    host.appendChild(table);
  }
  var foot = node("div", null, "tools");
  var more = node("button", state.exhausted ? "no more (polling)" : "load more");
  more.disabled = state.exhausted;
  more.addEventListener("click", function () { loadMoreMatches(); });
  foot.appendChild(more);
  foot.appendChild(node("span", state.matches.length + " loaded, newest first", "note"));
  host.appendChild(foot);
}

// ── Registration ────────────────────────────────────────────────────────────────────────────

async function register(ev) {
  ev.preventDefault();
  var field = el("key");
  var key = field.value.trim();
  var start = el("start").value.trim();
  // Cleared before the request is even issued: the value lives in one local for the duration of
  // one fetch and is never written anywhere else — not to storage, not to a URL, not to the DOM.
  field.value = "";
  if (key === "") { say("err", "paste a viewing key first"); return; }
  try {
    var monitor = await api("POST", PATH_MONITORS, { viewingKey: key, startHeight: start === "" ? "earliest" : start });
    key = "";
    say("ok", "registered " + monitor.monitorId + " (" + monitor.state + ")");
    await refresh();
    selectMonitor(monitor.monitorId);
  } catch (e) {
    key = "";
    // The server's stable code, never the submitted value.
    say("err", "registration refused: " + e.message);
  }
}

function say(kind, text) {
  var box = el("say");
  box.textContent = text;
  box.className = kind === "err" ? "err" : "ok";
}

// ── Refresh loop ────────────────────────────────────────────────────────────────────────────

async function refresh() {
  if (state.inflight) return;
  state.inflight = true;
  try {
    var health = await api("GET", PATH_HEALTH);
    state.health = health;
    var list = await api("GET", PATH_MONITORS + "?limit=200");
    state.monitors = list.items;
    state.sourceTip = list.sourceTip;
    state.net = list.net;
    // A monitor that disappeared (deleted elsewhere) must not keep a stale panel open.
    if (state.selected !== null && !state.monitors.some(function (m) { return m.monitorId === state.selected; })) {
      selectMonitor(null);
    }
    renderHeader(true);
    renderMonitors();
    if (state.selected !== null) await loadMoreMatches();
  } catch (e) {
    renderHeader(false);
  } finally {
    state.inflight = false;
  }
}

function renderHeader(up) {
  el("dot").className = "dot " + (up ? "up" : "down");
  el("status").textContent = up
    ? "net " + (state.net || "?") + " · archive tip " + (state.sourceTip === null ? "unknown" : state.sourceTip) +
      " · " + state.monitors.length + " monitor(s)"
    : "API unreachable";
}

function toggle() {
  state.paused = !state.paused;
  el("toggle").textContent = state.paused ? "resume auto-refresh" : "pause auto-refresh";
  if (state.paused) { window.clearInterval(state.timer); state.timer = null; }
  else { state.timer = window.setInterval(refresh, REFRESH_MS); refresh(); }
}

window.addEventListener("DOMContentLoaded", function () {
  el("form").addEventListener("submit", register);
  el("toggle").addEventListener("click", toggle);
  el("now").addEventListener("click", refresh);
  state.timer = window.setInterval(refresh, REFRESH_MS);
  refresh();
});
`;

// ── The document ─────────────────────────────────────────────────────────────────────────────

const BODY = `<header>
  <h1>UmbraDB · shielded monitor</h1>
  <div class="sub">private dashboard for <code>umbradb-shielded-monitor-api</code></div>
</header>
<div class="warnbar">
  <strong>No authentication.</strong> Anyone who can reach this port can register a viewing key,
  read every monitor&rsquo;s matches and delete any monitor. This is a recorded alpha decision; the
  deployment &mdash; not this service &mdash; must restrict network access. Registered keys and
  associations are stored unencrypted.
</div>
<main>
  <section>
    <h2>service</h2>
    <div class="tools">
      <span id="dot" class="dot"></span>
      <span id="status">connecting&hellip;</span>
      <button id="now">refresh now</button>
      <button id="toggle">pause auto-refresh</button>
      <span class="note">auto-refresh every 3&nbsp;s</span>
    </div>
  </section>

  <section>
    <h2>monitors</h2>
    <div id="monitors"></div>
  </section>

  <section>
    <h2>register a viewing key</h2>
    <form id="form" autocomplete="off">
      <div class="row">
        <div class="grow">
          <label for="key">Bech32m viewing key (<code>mn_shield-esk_&lt;net&gt;</code>)</label>
          <input id="key" name="key" type="password" autocomplete="off" spellcheck="false"
                 class="wide" placeholder="mn_shield-esk_undeployed1&hellip;">
        </div>
        <div>
          <label for="start">start height</label>
          <input id="start" name="start" type="text" inputmode="numeric" value="earliest" size="10">
        </div>
        <div><button type="submit">register</button></div>
      </div>
      <div class="note mt8">
        Derive one with <code>umbradb-shielded-monitor-derive-key --seed-file &lt;path&gt;</code>.
        The key is sent once, in the request body; it is never put in a URL, stored in this
        browser, or written to a server log.
      </div>
      <div id="say" class="mt8"></div>
    </form>
  </section>

  <section>
    <h2 id="matches-title">matches</h2>
    <div id="matches"></div>
  </section>
</main>`;

function sha256Source(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/**
 * The page's Content Security Policy.
 *
 * Computed from the very bytes served below, so the hashes cannot drift from the code they
 * authorise. `'unsafe-inline'` would make this header a decoration; naming the two hashes makes it
 * a control — the browser runs exactly this script and this style and nothing an injection could
 * add. `form-action 'none'` is the one clause that protects the viewing-key field specifically:
 * a browser will refuse to submit a form anywhere, so an injected `<form action="https://…">`
 * has nowhere to send it. `connect-src 'self'` keeps every `fetch` on this origin.
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  `script-src ${sha256Source(SCRIPT)}`,
  `style-src ${sha256Source(STYLE)}`,
  "connect-src 'self'",
  "img-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The whole dashboard: one document, no external reference, no build step. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>UmbraDB shielded monitor</title>
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script>${SCRIPT}</script>
</body>
</html>
`;
