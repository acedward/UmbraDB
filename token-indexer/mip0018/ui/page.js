/*
 * MIP-0018 token explorer: the page script.
 *
 * Served inline in the one document of GET /ui (ui/page.ts) and allowed by its SHA-256 in the page's
 * Content-Security-Policy. It is a plain script file (no template literal around it), so a backtick,
 * a backslash or a dollar-brace here is ordinary JavaScript \u2014 a stray character cannot break the build;
 * the guard test still loads the generated document and compiles this script.
 *
 * Transport: on GET /ui every API read is a same-origin fetch. The static browser build (token-indexer/browser/,
 * index.html) bundles this same script after installing window.umbradbExplorerHost: its api(path) answers a /v1 path
 * through the browser engine with a fetch Response, read here exactly as a fetched one (the same 8 MiB cap and the
 * same error rendering); with startHeightNotes set, every list also states the first indexed height, because that
 * index may start mid-chain.
 *
 * Every API path this page reads (relative, this origin only; contract: token-indexer/API.md):
 *   GET /v1/status
 *   GET /v1/tokens?limit=&cursor=
 *   GET /v1/tokens/{color}
 *   GET /v1/identities/{contract}/{domainSep}/{kind}
 *   GET /v1/contracts/{address}/tokens?limit=&cursor=
 *   GET /v1/events?contract=&tx=&limit=&cursor=
 *   GET /v1/tokens/{color}/activity?limit=&cursor=        (a 404 means "not served by this API")
 *   GET /v1/contracts/{address}/activity?limit=&cursor=   (a 404 means "not served by this API")
 *
 * Safety properties (MIP-0018 Security considerations, "Untrusted input"): every value reaches the
 * document as a text node or through a DOM property (textContent, title) \u2014 nothing is ever parsed as
 * markup; characters that change the layout of the text around them or cannot be seen (bidi controls,
 * zero-width characters, C0/C1 controls incl. NUL, tag characters, lone surrogates \u2026) are drawn as a
 * visible mark such as "\u27e8U+202E\u27e9"; every value has a drawing budget; a URI value is text, never fetched
 * and never a link; the only links are this page's own hash routes, built from validated hex. Heights
 * only: this script reads no clock and draws no date.
 */
(function () {
  "use strict";

  var API = "/v1";
  var PAGE = 100;                         // rows per API page
  var MAX_PAGES = 50;                     // "load more" stops here (5 000 rows of one list)
  var MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  var CELL_MAX = 48;                      // drawn characters of a name, symbol or tag in a table row
  var HEAD_MAX = 160;                     // drawn characters of a name in a view's heading
  var VALUE_MAX = 600;                    // drawn characters of a field value before "show all"
  var TITLE_MAX = 400;                    // characters of a tooltip
  var FIELDS_MAX = 500;                   // fields read and drawn per identity (the API pages them)
  var REASONS_MAX = 20;                   // rejection reasons named in a tooltip
  var ZERO = "0000000000000000000000000000000000000000000000000000000000000000";
  var REFRESH_MS = refreshInterval();
  var HOST = explorerHost();

  var state = {
    route: { view: "list" },
    key: "list",
    gen: 0,
    busyGen: 0,
    data: null,          // what the last load of the current route returned
    status: null,
    statusFailed: false,
    errors: [],
    pages: {},           // list / events / activity / tokens \u2192 pages to read
    expanded: {},        // values drawn whole on the reader's request
    renders: 0,
    inflight: null       // the route key of the read in progress
  };

  // \u2500\u2500 Text: visible marks for hidden characters, budgets \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
  function arr(v) { return isArray(v) ? v : []; }
  function own(o, k) { return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }

  // Every value becomes text through txt(): a string as it is, a number/boolean as its digits or word,
  // anything else as its JSON (never String() on an object a payload chose).
  function txt(v) {
    if (v === null || v === undefined) return "";
    var t = typeof v;
    if (t === "string") return v;
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    try {
      var j = JSON.stringify(v);
      return typeof j === "string" ? j : "";
    } catch (e) {
      return "(a value this page cannot show)";
    }
  }

  // Characters drawn as a visible mark (by Unicode property, not a hand-written list): every
  // control (Cc: C0 incl. NUL, tab, newline; DEL; C1), format character (Cf: bidi embeddings, overrides, isolates and
  // marks, zero-width characters, Arabic number signs U+0600\u2013U+0605, shorthand format controls U+1BCA0\u2013U+1BCA3,
  // tag characters, \u2026), private-use (Co), unassigned (Cn) and surrogate (Cs) code point, line and paragraph
  // separators (Zl, Zp), and every Default_Ignorable_Code_Point (variation selectors incl. Mongolian U+180B\u2013U+180F,
  // Hangul fillers, combining grapheme joiner, Khmer inherent vowels, soft hyphen, \u2026): whatever a browser may draw
  // as nothing, or let change the text around it.
  var HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
  function hiddenChar(c) {
    return HIDDEN.test(String.fromCodePoint(c));
  }
  function hex4(c) {
    var h = c.toString(16).toUpperCase();
    while (h.length < 4) h = "0" + h;
    return h;
  }
  // The text split into ordinary runs and visible marks.
  function parts(v) {
    var out = [];
    var buf = "";
    for (var i = 0; i < v.length; i++) {
      var c = v.codePointAt(i);
      var w = c > 65535 ? 2 : 1;
      if (hiddenChar(c)) {
        if (buf !== "") { out.push({ m: false, s: buf }); buf = ""; }
        out.push({ m: true, s: "\u27e8U+" + hex4(c) + "\u27e9" });
      } else {
        buf += v.substr(i, w);
      }
      i += w - 1;
    }
    if (buf !== "") out.push({ m: false, s: buf });
    return out;
  }
  function shown(v) {
    var p = parts(txt(v));
    var s = "";
    for (var i = 0; i < p.length; i++) s += p[i].s;
    return s;
  }
  // Cuts a string at a code-point boundary.
  function cut(s, n) {
    if (s.length <= n) return s;
    var c = s.charCodeAt(n - 1);
    return s.slice(0, c >= 55296 && c <= 56319 ? n - 1 : n);
  }
  function clipPlain(s, max) {
    return s.length <= max ? s : cut(s, max) + "\u2026 (" + s.length + " characters)";
  }
  function setTitle(n, t) { n.title = clipPlain(shown(t), TITLE_MAX); return n; }

  // \u2500\u2500 DOM (text nodes only) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function el(id) { return document.getElementById(id); }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function add(n, kids) {
    if (kids === null || kids === undefined) return n;
    if (!isArray(kids)) kids = [kids];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k === null || k === undefined || k === false) continue;
      if (typeof k === "object" && k.nodeType) n.appendChild(k);
      else n.appendChild(document.createTextNode(shown(k)));
    }
    return n;
  }
  function h(tag, cls, kids) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return add(n, kids);
  }
  function link(hash, kids, cls) {
    var a = h("a", cls || null, kids);
    a.href = hash;
    return a;
  }
  // A value a publisher chose: its own bidi island, hidden characters as marks, at most `max` drawn
  // characters (whole on request when `key` names it).
  function data(value, max, key) {
    var p = parts(txt(value));
    var total = 0;
    for (var i = 0; i < p.length; i++) total += p[i].s.length;
    var limit = key && state.expanded[key] ? Infinity : max;
    var span = h("span", "d");
    var used = 0;
    var clipped = false;
    for (var j = 0; j < p.length; j++) {
      var s = p[j].s;
      if (used + s.length > limit) {
        if (!p[j].m) {
          var piece = cut(s, limit - used);
          span.appendChild(document.createTextNode(piece));
          used += piece.length;
        }
        clipped = true;
        break;
      }
      if (p[j].m) span.appendChild(h("span", "mark-vis", null)).textContent = s;
      else span.appendChild(document.createTextNode(s));
      used += s.length;
    }
    if (clipped) {
      span.appendChild(document.createTextNode("\u2026"));
      setTitle(span, "drawn " + used + " of " + total + " characters");
      if (key) {
        var wrap = h("span", null, span);
        var b = h("button", "mini", "show all (" + total + " characters)");
        b.type = "button";
        b.addEventListener("click", function (ev) {
          ev.stopPropagation();
          state.expanded[key] = true;
          render();
        });
        wrap.appendChild(b);
        return wrap;
      }
    }
    return span;
  }
  function dash(title) { return setTitle(h("span", "no", "\u2014"), title); }
  // A contract entry point (arbitrary bytes on the ledger): the API serves its hex always and a text form only
  // when it is printable; the text is drawn as data, anything else as its hex.
  function entryPointNode(ep) {
    if (!ep || typeof ep !== "object") return null;
    if (ep.truncated === true) return h("span", "ep-bytes", [hexNode(txt(ep.hex)), h("span", "note", " (bytes; the first " + (txt(ep.hex).length / 2) + " of " + txt(ep.length) + ")")]);
    if (typeof ep.text === "string" && ep.text !== "") return data(ep.text, 40);
    var hx = txt(ep.hex);
    if (hx === "") return setTitle(h("span", "no", "(empty)"), "an empty entry point");
    return h("span", "ep-bytes", [hexNode(hx), h("span", "note", " (bytes, not printable)")]);
  }

  // \u2500\u2500 Hex \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function isHex(s, len) {
    if (typeof s !== "string" || s.length === 0 || s.length % 2 !== 0) return false;
    if (len !== undefined && s.length !== len) return false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) return false;
    }
    return true;
  }
  function hex64(s) { return isHex(s, 64); }
  function short(s, head, tail) {
    if (s.length <= head + tail + 1) return s;
    return s.slice(0, head) + "\u2026" + s.slice(s.length - tail);
  }
  // A 32-byte value that is printable ASCII once trailing zero bytes are dropped (a domain separator such
  // as "mip-0018:example:fungible") reads better as that text; anything else stays hex.
  function asciiOf(hex) {
    if (!isHex(hex)) return null;
    var b = [];
    for (var i = 0; i + 1 < hex.length; i += 2) b.push(parseInt(hex.substr(i, 2), 16));
    while (b.length > 0 && b[b.length - 1] === 0) b.pop();
    if (b.length === 0) return null;
    var out = "";
    for (var j = 0; j < b.length; j++) {
      if (b[j] < 32 || b[j] > 126) return null;
      out += String.fromCharCode(b[j]);
    }
    return out;
  }
  // Hex drawn short (head\u2026tail), whole in the tooltip, copied whole on click.
  function hexNode(hex, head, tail) {
    var s = txt(hex);
    if (!isHex(s)) return data(s, CELL_MAX);
    var n = h("span", "hex cp", short(s.toLowerCase(), head || 8, tail || 6));
    setTitle(n, s.toLowerCase() + "  (click to copy)");
    n.addEventListener("click", function (ev) { ev.stopPropagation(); copy(s.toLowerCase(), n); });
    return n;
  }
  function hexFull(hex) {
    var s = txt(hex);
    if (!isHex(s)) return data(s, VALUE_MAX);
    var n = h("span", "hex cp", s.toLowerCase());
    setTitle(n, "click to copy");
    n.addEventListener("click", function (ev) { ev.stopPropagation(); copy(s.toLowerCase(), n); });
    return n;
  }
  function domainNode(ds) {
    var a = asciiOf(ds);
    if (a === null) return hexNode(ds);
    var n = h("span", "mono cp", data(a, CELL_MAX));
    setTitle(n, txt(ds) + "  (click to copy)");
    n.addEventListener("click", function (ev) { ev.stopPropagation(); copy(txt(ds), n); });
    return n;
  }
  function copy(value, target) {
    var base = target.className;
    function flash() {
      target.className = base + " copied";
      window.setTimeout(function () { target.className = base; }, 700);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(flash, function () { fallbackCopy(value, flash); });
        return;
      }
    } catch (e) { /* the selection fallback below */ }
    fallbackCopy(value, flash);
  }
  function fallbackCopy(value, flash) {
    var ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "readonly");
    ta.className = "cpbuf";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* nothing leaves the page either way */ }
    document.body.removeChild(ta);
    flash();
  }

  // \u2500\u2500 Routes (hash only; built from validated hex) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function tokenHash(c, d, k) { return "#/token/" + c + "/" + d + "/" + k; }
  function colorHash(c) { return "#/color/" + c; }
  function contractHash(a) { return "#/contract/" + a; }
  function txHash(t) { return "#/tx/" + t; }
  var DUST_HASH = "#/builtin/DUST";

  function parseRoute(hash) {
    var s = hash.charAt(0) === "#" ? hash.slice(1) : hash;
    if (s === "" || s === "/") return { view: "list" };
    var p = s.split("/");
    if (p[0] !== "") return { view: "unknown" };
    p = p.slice(1);
    if (p.length === 1 && p[0] === "status") return { view: "status" };
    if (p.length === 4 && p[0] === "token" && hex64(p[1]) && hex64(p[2]) && (p[3] === "1" || p[3] === "2" || p[3] === "3"))
      return { view: "identity", contract: p[1].toLowerCase(), domainSep: p[2].toLowerCase(), kind: Number(p[3]) };
    if (p.length === 2 && p[0] === "color" && hex64(p[1])) return { view: "color", color: p[1].toLowerCase() };
    if (p.length === 2 && p[0] === "builtin" && p[1] === "DUST") return { view: "dust" };
    if (p.length === 2 && p[0] === "contract" && hex64(p[1])) return { view: "contract", address: p[1].toLowerCase() };
    if (p.length === 2 && p[0] === "tx" && hex64(p[1])) return { view: "tx", hash: p[1].toLowerCase() };
    return { view: "unknown" };
  }
  function routeKey(r) {
    if (r.view === "identity") return "identity/" + r.contract + "/" + r.domainSep + "/" + r.kind;
    if (r.view === "color") return "color/" + r.color;
    if (r.view === "contract") return "contract/" + r.address;
    if (r.view === "tx") return "tx/" + r.hash;
    return r.view;
  }
  function go(hash) { window.location.hash = hash; }
  // The route of a token-list row.
  function rowHash(t) {
    if (t.source === "builtin") return hex64(txt(t.color)) ? colorHash(txt(t.color).toLowerCase()) : DUST_HASH;
    if (t.source === "identity" && hex64(txt(t.contractAddress)) && hex64(txt(t.domainSep)) && (t.kind === 1 || t.kind === 2 || t.kind === 3))
      return tokenHash(t.contractAddress.toLowerCase(), t.domainSep.toLowerCase(), t.kind);
    if (hex64(txt(t.color))) return colorHash(txt(t.color).toLowerCase());
    return null;
  }

  // \u2500\u2500 API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function apiPath(segments, query) {
    var p = API;
    for (var i = 0; i < segments.length; i++) p += "/" + encodeURIComponent(txt(segments[i]));
    var q = new URLSearchParams();
    var keys = query ? Object.keys(query) : [];
    for (var j = 0; j < keys.length; j++) if (query[keys[j]] !== null && query[keys[j]] !== undefined) q.set(keys[j], txt(query[keys[j]]));
    var qs = q.toString();
    return qs === "" ? p : p + "?" + qs;
  }
  function apiError(path, status, code) {
    var e = new Error(path + " answered " + (status === 0 ? "nothing" : status) + " " + code);
    e.status = status;
    e.code = code;
    e.path = path;
    return e;
  }
  async function readBody(res, path) {
    var announced = Number(res.headers.get("content-length"));
    if (announced > MAX_RESPONSE_BYTES) throw apiError(path, res.status, "TOO_LARGE");
    if (!res.body || !res.body.getReader) {
      var whole = await res.text();
      if (whole.length > MAX_RESPONSE_BYTES) throw apiError(path, res.status, "TOO_LARGE");
      return whole;
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder("utf-8");
    var out = [];
    var n = 0;
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      n += chunk.value.byteLength;
      if (n > MAX_RESPONSE_BYTES) {
        try { reader.cancel(); } catch (e) { /* closed */ }
        throw apiError(path, res.status, "TOO_LARGE");
      }
      out.push(dec.decode(chunk.value, { stream: true }));
    }
    out.push(dec.decode());
    return out.join("");
  }
  // The static browser build's host (see the header), or null on GET /ui. An object with an api function only: an
  // element that happens to carry the same id is not one.
  function explorerHost() {
    var x = window.umbradbExplorerHost;
    return x !== null && typeof x === "object" && typeof x.api === "function" ? x : null;
  }
  // The one API call of this page: GET of a relative /v1 path, fetched on this origin or answered by the host.
  async function api(path) {
    if (path.slice(0, API.length + 1) !== API + "/") throw apiError(path, 0, "NOT_AN_API_PATH");
    var res;
    try {
      res = HOST !== null ? await HOST.api(path)
        : await fetch(path, { method: "GET", headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin", redirect: "error" });
      if (!(res instanceof Response)) throw new TypeError("the host answered something other than a Response");
    } catch (e) {
      throw apiError(path, 0, "UNREACHABLE");
    }
    var body = await readBody(res, path);
    var json = null;
    try { json = body === "" ? null : JSON.parse(body); } catch (e) { json = null; }
    if (!res.ok) {
      var code = json && json.error && typeof json.error.code === "string" ? json.error.code : "HTTP_" + res.status;
      throw apiError(path, res.status, code);
    }
    if (json === null || typeof json !== "object") throw apiError(path, res.status, "NOT_JSON");
    return json;
  }
  // Up to `pages` pages of a keyset list: { items, more, extra } (extra = the first page's other keys).
  async function readPages(pathOf, pages) {
    var items = [];
    var cursor = null;
    var first = null;
    var all = [];
    var n = 0;
    do {
      var page = await api(pathOf(cursor));
      if (first === null) first = page;
      all.push(page);
      items = items.concat(arr(page.items));
      cursor = typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : null;
      n++;
    } while (cursor !== null && n < pages);
    return { items: items, more: cursor !== null, first: first, pages: all };
  }
  // An identity's fields come in keyset pages: read as many pages as the reader asked for, at most
  // FIELDS_MAX fields; the rest of the answer is the first page's.
  async function identityPages(r) {
    var pathOf = function (c) { return apiPath(["identities", r.contract, r.domainSep, r.kind], { limit: PAGE, cursor: c }); };
    var first = await api(pathOf(null));
    var fields = arr(first.fields);
    var next = function (p) { return typeof p.fieldsNextCursor === "string" && p.fieldsNextCursor !== "" ? p.fieldsNextCursor : null; };
    var cursor = next(first);
    var n = 1;
    while (cursor !== null && n < pagesOf("fields") && fields.length < FIELDS_MAX) {
      var page = await api(pathOf(cursor));
      fields = fields.concat(arr(page.fields));
      cursor = next(page);
      n++;
    }
    first.fields = fields;
    first.moreFields = cursor !== null;
    return first;
  }
  function pagesOf(name) { return state.pages[name] || 1; }
  async function soft(promise, errors) {
    try {
      return await promise;
    } catch (e) {
      errors.push(e && e.message ? e.message : txt(e));
      return { failed: true, status: e && e.status, error: e };
    }
  }
  // An activity endpoint that answers 404 is "not served"; any other failure is "could not be read".
  async function activity(segments, errors) {
    try {
      return await readPages(function (c) { return apiPath(segments, { limit: PAGE, cursor: c }); }, pagesOf("activity"));
    } catch (e) {
      if (e && e.status === 404) return { unavailable: true, path: apiPath(segments) };
      errors.push(e && e.message ? e.message : txt(e));
      return { failed: true };
    }
  }
  function events(filter, errors) {
    return soft(readPages(function (c) {
      return apiPath(["events"], { contract: filter.contract, tx: filter.tx, limit: PAGE, cursor: c });
    }, pagesOf("events")), errors);
  }

  async function load(r) {
    var errors = [];
    var d = { errors: errors };
    if (r.view === "list") {
      d.list = await soft(readPages(function (c) { return apiPath(["tokens"], { limit: PAGE, cursor: c }); }, pagesOf("list")), errors);
    } else if (r.view === "identity") {
      try {
        d.identity = await identityPages(r);
      } catch (e) {
        if (e.status === 404) d.notFound = true;
        else { errors.push(e.message); d.failed = true; }
      }
      if (d.identity) {
        var c = txt(d.identity.color);
        var acts = hex64(c) ? activity(["tokens", c.toLowerCase(), "activity"], errors)
          : activity(["contracts", r.contract, "activity"], errors);
        var res = await Promise.all([acts, events({ contract: r.contract }, errors)]);
        d.activity = res[0];
        d.events = res[1];
      }
    } else if (r.view === "color") {
      try {
        d.color = await api(apiPath(["tokens", r.color]));
      } catch (e) {
        if (e.status === 404) d.notFound = true;
        else { errors.push(e.message); d.failed = true; }
      }
      if (d.color) d.activity = await activity(["tokens", r.color, "activity"], errors);
    } else if (r.view === "dust") {
      d.list = await soft(api(apiPath(["tokens"], { limit: 2 })), errors);
    } else if (r.view === "contract") {
      try {
        d.tokens = await readPages(function (cur) { return apiPath(["contracts", r.address, "tokens"], { limit: PAGE, cursor: cur }); }, pagesOf("tokens"));
      } catch (e) {
        if (e.status === 404) d.notFound = true;
        else { errors.push(e.message); d.failed = true; }
      }
      if (d.tokens) {
        var both = await Promise.all([activity(["contracts", r.address, "activity"], errors), events({ contract: r.address }, errors)]);
        d.activity = both[0];
        d.events = both[1];
      }
    } else if (r.view === "tx") {
      d.events = await events({ tx: r.hash }, errors);
    }
    return d;
  }

  // \u2500\u2500 Refresh \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function refreshInterval() {
    var raw = new URLSearchParams(window.location.search).get("refresh");
    if (raw === null || !/^[0-9]{3,7}$/.test(raw)) return 10000;
    var n = Number(raw);
    return n >= 500 && n <= 3600000 ? n : 10000;
  }
  async function refresh() {
    var gen = ++state.gen;
    state.inflight = state.key;
    var r = state.route;
    var errors = [];
    var st = await soft(api(apiPath(["status"])), errors);
    var d = await load(r);
    if (gen !== state.gen) return; // the route moved or a newer refresh started: drop this one
    state.inflight = null;
    state.statusFailed = !!st.failed;
    if (!st.failed) state.status = st;
    state.errors = errors.concat(d.errors);
    if (d.failed && state.data && state.data.key === state.key) {
      state.data.stale = true; // keep what was drawn for this route; the banner says it may be stale
    } else {
      d.key = state.key;
      state.data = d;
    }
    render();
  }
  function onRoute() {
    var r = parseRoute(window.location.hash || "");
    var k = routeKey(r);
    if (k !== state.key) {
      state.pages = {};
      state.expanded = {};
      state.data = null;
    }
    state.route = r;
    state.key = k;
    render();
    refresh();
  }
  function more(name) {
    return function () {
      var n = pagesOf(name);
      if (n < MAX_PAGES) state.pages[name] = n + 1;
      refresh();
    };
  }

  // \u2500\u2500 Shared pieces \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function table(parent, labels) {
    var wrap = h("div", "scroll");
    var t = h("table");
    var tr = h("tr");
    for (var i = 0; i < labels.length; i++) {
      var l = labels[i];
      var th = h("th", null, typeof l === "string" ? l : l.label);
      if (typeof l !== "string" && l.title) setTitle(th, l.title);
      tr.appendChild(th);
    }
    t.appendChild(h("thead", null, tr));
    var body = h("tbody");
    t.appendChild(body);
    wrap.appendChild(t);
    parent.appendChild(wrap);
    return body;
  }
  function td(tr, kid, cls) { var c = h("td", cls || null, kid); tr.appendChild(c); return c; }
  function kv(parent) { var g = h("div", "kv"); parent.appendChild(g); return g; }
  function kvRow(g, k, v) { g.appendChild(h("div", "k", k)); g.appendChild(h("div", "v", v === null || v === undefined ? dash("") : v)); }
  function section(title, id) { var s = h("section", null, h("h2", null, title)); if (id) s.id = id; return s; }
  function moreButton(parent, name, has, what) {
    if (!has) return;
    var bar = h("div", "row gap");
    if (pagesOf(name) >= MAX_PAGES) {
      bar.appendChild(h("span", "note", "more " + what + " exist; this page reads at most " + (MAX_PAGES * PAGE) + " of them"));
    } else {
      var b = h("button", null, "load more " + what);
      b.type = "button";
      b.addEventListener("click", more(name));
      bar.appendChild(b);
    }
    parent.appendChild(bar);
  }
  // Next to every list when the host asks for it (the static browser build, whose index may start mid-chain): the first
  // indexed height (/v1/status startHeight), so a partial mark, a missing mint or a short history is not read as the
  // token's whole state.
  function rangeNote() {
    if (HOST === null || HOST.startHeightNotes !== true) return null;
    var st = state.status;
    var from = st && typeof st.startHeight === "number" ? st.startHeight : null;
    var n = h("div", "note range-note", from === null ? "nothing indexed yet"
      : "indexed from block " + from + " \u00b7 history before block " + from + " is not indexed");
    n.setAttribute("data-start-height", from === null ? "" : String(from));
    return n;
  }
  function crumb(main, extra) {
    var c = h("div", "crumb", link("#/", "\u2190 all tokens"));
    for (var i = 0; i < extra.length; i++) { c.appendChild(document.createTextNode("  \u00b7  ")); c.appendChild(extra[i]); }
    main.appendChild(c);
  }
  var KIND_NAMES = { 1: "shielded", 2: "unshielded", 3: "ledger" };
  function kindChip(t) {
    if (t.source === "builtin") return setTitle(h("span", "chip k-builtin", "built-in"), "a protocol token (outside MIP-0018)");
    if (t.source === "seen") return setTitle(h("span", "chip k-seen", "seen"), "a color seen in public data with no indexed mint: its contract is not known");
    var name = KIND_NAMES[t.kind];
    if (!name) return h("span", "chip", txt(t.kind));
    return setTitle(h("span", "chip k-" + name, t.kind + " \u00b7 " + name), "kind " + t.kind + ": native " + (t.kind === 3 ? "ledger token (no color)" : name + " token"));
  }

  // The MIP-0018 mark (decided by the API): \u2713 correct, \u26a0 partial, incorrect or unresolved with the
  // reason in its tooltip, nothing when the token has no MIP-0018 event.
  var MARK_HEAD = "MIP-0018 mark: \u2713 usable name, symbol and decimals, no rejected MIP-0018 event and no unresolved log from the token's contract; "
    + "\u26a0 partial (one of the three missing or unusable), incorrect (its contract has a rejected MIP-0018 event) or "
    + "unresolved (its contract has a log op whose logged value the indexer cannot read, so its metadata here may differ from the ledger's events); "
    + "empty: no MIP-0018 event";
  var MARK_KINDS = { ok: 1, partial: 1, incorrect: 1, unresolved: 1, none: 1 };
  function markOf(m) { return m && typeof m.mark === "string" && MARK_KINDS[m.mark] ? m.mark : null; }
  // Unresolved logs of the token's contract: how many, and the reason "unresolved-log".
  function unresolvedCount(m) {
    var u = m && m.unresolved;
    return u && typeof u.count === "number" && u.count > 0 ? u.count : 0;
  }
  function unresolvedText(m) {
    var n = unresolvedCount(m);
    return n + " unresolved log" + (n === 1 ? "" : "s") + " (unresolved-log: a log op whose logged value the indexer cannot read from the raw "
      + "transaction; the contract may have published, renamed or withdrawn metadata not shown here)";
  }
  function markText(m) {
    var k = markOf(m);
    var miss = m && arr(m.missing).length > 0 ? "; also missing or unusable: " + arr(m.missing).map(txt).join(", ") : "";
    if (k === "ok") return "\u2713 correct: usable name, symbol and decimals, and no rejected MIP-0018 event or unresolved log from its contract";
    if (k === "partial") return "\u26a0 partial: missing or unusable: " + arr(m.missing).map(txt).join(", ");
    if (k === "incorrect") {
      var rs = arr(m.reasons).filter(function (r) { return r !== "unresolved-log"; }).map(txt);
      var n = typeof m.reasonCount === "number" ? m.reasonCount : rs.length;
      var named = rs.slice(0, REASONS_MAX).join(", ") + (n > Math.min(rs.length, REASONS_MAX) ? ", \u2026" : "");
      var un = unresolvedCount(m) > 0 ? "; and " + unresolvedText(m) : "";
      return "\u26a0 incorrect: its contract has " + n + " rejected MIP-0018 event" + (n === 1 ? "" : "s") + ": " + named + un + miss;
    }
    if (k === "unresolved") return "\u26a0 unresolved: its contract has " + unresolvedText(m) + miss;
    return "no MIP-0018 event: no mark";
  }
  function markNode(m) {
    var k = markOf(m);
    var n;
    if (k === "ok") n = h("span", "mk mk-ok", "\u2713");
    else if (k === "partial") n = h("span", "mk mk-partial", "\u26a0");
    else if (k === "incorrect") n = h("span", "mk mk-incorrect", "\u26a0");
    else if (k === "unresolved") n = h("span", "mk mk-unresolved", "\u26a0");
    else n = h("span", "mk", "");
    n.setAttribute("data-mark", k || "none");
    return setTitle(n, markText(m));
  }
  function markBadge(m) {
    var k = markOf(m);
    var cls = k === "ok" ? "badge ok" : k === "partial" || k === "unresolved" ? "badge warn" : k === "incorrect" ? "badge bad" : "badge";
    var label = k === "ok" ? "\u2713 MIP-0018 correct" : k === "partial" ? "\u26a0 MIP-0018 partial" : k === "incorrect" ? "\u26a0 MIP-0018 incorrect"
      : k === "unresolved" ? "\u26a0 MIP-0018 unresolved" : "no MIP-0018 event";
    var b = h("span", cls, label);
    b.setAttribute("data-mark", k || "none");
    return setTitle(b, markText(m));
  }
  function tagChips(m) {
    var tags = m ? arr(m.tags) : [];
    if (tags.length === 0) return null;
    var w = h("span");
    for (var i = 0; i < tags.length && i < 20; i++) {
      w.appendChild(setTitle(h("span", "chip std", data(tags[i], 32)), "standards (self-declared; never proof of conformance): " + txt(tags[i])));
    }
    if (tags.length > 20) w.appendChild(h("span", "note", "+" + (tags.length - 20)));
    return w;
  }
  function amountNode(minted) {
    if (!minted) return dash("no indexed mint");
    var a = minted.amountDisplay !== null && minted.amountDisplay !== undefined
      ? h("span", "mono", data(minted.amountDisplay, 40))
      : setTitle(h("span", "mono", [data(minted.amount, 40), h("span", "note", " base units")]), "no usable decimals: shown in base units");
    return a;
  }

  // \u2500\u2500 Views \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function tokenRows(sec, items, withContract) {
    var labels = [{ label: "MIP-0018", title: MARK_HEAD }, "name", "symbol", "kind"];
    // The domainSep is on every identity row: several identities of one contract may share a name, symbol and kind
    // (C05's three "Acme Medals"), and only it tells them apart. Its printable label, else its short hex.
    if (withContract) labels.push({ label: "contract / domainSep / color", title: "the minting contract, the token's domainSep (its printable label, else hex) and its color" });
    else labels.push("domainSep / color");
    labels.push({ label: "standards", title: "usable standards identifiers (self-declared tags)" }, "decimals", "minted");
    var body = table(sec, labels);
    for (var i = 0; i < items.length; i++) {
      var t = items[i] || {};
      var tr = h("tr", t.source === "builtin" ? "pick built" : "pick");
      var target = rowHash(t);
      td(tr, t.source === "builtin" ? setTitle(h("span", "mk", ""), "a protocol token, outside MIP-0018: no mark") : markNode(t.mark), "mipcol");
      var name;
      if (t.name !== null && t.name !== undefined) name = data(t.name, CELL_MAX);
      else if (t.source === "seen") name = h("span", "no", "seen color \u2014 no contract known");
      else name = dash(t.described ? "no usable name" : "not described: no metadata");
      td(tr, target ? link(target, name) : name);
      td(tr, t.symbol !== null && t.symbol !== undefined ? data(t.symbol, CELL_MAX) : dash("no usable symbol"));
      td(tr, kindChip(t));
      var where = h("span");
      if (withContract && hex64(txt(t.contractAddress))) {
        where.appendChild(link(contractHash(t.contractAddress.toLowerCase()), hexNode(t.contractAddress)));
        where.appendChild(document.createTextNode(" "));
      }
      if (t.source === "identity" && hex64(txt(t.domainSep))) {
        var ds = domainNode(t.domainSep.toLowerCase());
        ds.setAttribute("data-domainsep", t.domainSep.toLowerCase());
        where.appendChild(ds);
        where.appendChild(document.createTextNode(" "));
      }
      if (hex64(txt(t.color))) where.appendChild(link(colorHash(t.color.toLowerCase()), hexNode(t.color)));
      else if (t.source === "builtin") where.appendChild(h("span", "no", "no color"));
      else if (t.source === "identity" && t.kind !== 3) where.appendChild(setTitle(h("span", "no", "no indexed mint"), "described, but no mint of this identity in the indexed range"));
      td(tr, where);
      td(tr, tagChips(t.mark));
      td(tr, t.decimals !== null && t.decimals !== undefined ? data(t.decimals, 24) : dash("no usable decimals"), "num");
      td(tr, t.minted ? amountNode(t.minted) : dash(t.source === "builtin" ? "protocol token" : "no indexed mint"), "num");
      if (target) {
        (function (hash) { tr.addEventListener("click", function () { go(hash); }); })(target);
      }
      body.appendChild(tr);
    }
  }

  function renderList(main, d) {
    var sec = section("tokens", "tokens");
    add(sec, rangeNote());
    if (!d) { sec.appendChild(h("div", "empty", "loading\u2026")); main.appendChild(sec); return; }
    if (!d.list || d.list.failed) { sec.appendChild(h("div", "err", "the token list could not be read (see the banner)")); main.appendChild(sec); return; }
    var items = d.list.items;
    if (items.length === 0) sec.appendChild(h("div", "empty", "no token yet"));
    else tokenRows(sec, items, true);
    moreButton(sec, "list", d.list.more, "tokens");
    sec.appendChild(h("div", "note gap",
      "NIGHT and DUST are the protocol's tokens (outside MIP-0018), then every token identity that is minted or described "
      + "(by contract, domainSep, kind), then colors seen in public data without an indexed mint. \u2713 / \u26a0 as decided "
      + "by the indexer (hover for the reason). A name or symbol is a claim bound to its contract, not curation: anyone can "
      + "copy one (MIP-0018 Security considerations). Click a row for the token."));
    main.appendChild(sec);
  }

  function fieldValue(f, key) {
    if (f.usable === false) {
      return setTitle(h("span", "badge warn", "unusable \u2014 no value shown"),
        "MIP-0018 Common fields: a field whose current value lacks the required type or form is unusable; no value is shown and no earlier value is used");
    }
    var v = f.value || {};
    if (own(v, "text") && v.text !== null) {
      var n = h("span", "val", data(v.text, VALUE_MAX, key));
      if (f.valTypeName === "uri") n.appendChild(h("span", "note", "  (URI: text only, never fetched or followed)"));
      return n;
    }
    if (own(v, "integer") && v.integer !== null) return h("span", "mono", data(v.integer, 80));
    var hx = txt(v.hex);
    var len = isHex(hx) ? hx.length / 2 : 0;
    var b = h("span", "hex val", data(hx, VALUE_MAX, key));
    b.appendChild(h("span", "note", "  (" + len + " byte" + (len === 1 ? "" : "s") + ")"));
    return b;
  }
  function commonValue(d, k) {
    var c = d.common || {};
    var v = c[k];
    if (v !== null && v !== undefined) {
      if (k === "standards") return arr(v).length === 0 ? h("span", "no", "none claimed (empty value)") : tagChips({ tags: v });
      return data(v, HEAD_MAX, "common:" + k);
    }
    var fields = arr(d.commonFields).concat(arr(d.fields));
    for (var i = 0; i < fields.length; i++) {
      if (fields[i] && fields[i].key && fields[i].key.utf8 === k) return fieldValue(fields[i], null);
    }
    return h("span", "no", k === "standards" ? "not set: no standards claimed" : "not set (no default is assumed)");
  }

  function eventsSection(main, ev, withContract, title) {
    var sec = section(title, "events");
    add(sec, rangeNote());
    if (!ev || ev.failed) { sec.appendChild(h("div", "err", "the events could not be read")); main.appendChild(sec); return; }
    if (ev.items.length === 0) {
      sec.appendChild(h("div", "empty", "no MIP-0018 event"));
    } else {
      var labels = ["height", "transaction", "event", "phase"];
      if (withContract) labels.push("contract");
      labels.push("classification", "reason");
      var body = table(sec, labels);
      for (var i = 0; i < ev.items.length; i++) {
        var e = ev.items[i] || {};
        var tr = h("tr");
        td(tr, txt(e.height), "num");
        td(tr, hex64(txt(e.txHash)) ? link(txHash(e.txHash.toLowerCase()), hexNode(e.txHash)) : dash(""));
        td(tr, txt(e.eventIndex), "num");
        td(tr, txt(e.phase) + (e.segment !== null && e.segment !== undefined ? " \u00b7 segment " + txt(e.segment) : ""));
        if (withContract) td(tr, hex64(txt(e.contractAddress)) ? link(contractHash(e.contractAddress.toLowerCase()), hexNode(e.contractAddress)) : dash(""));
        var cl = txt(e.classification);
        var badge = h("span", cl === "accept" ? "badge ok" : cl === "reject" ? "badge bad" : cl === "unresolved" ? "badge warn" : "badge",
          cl === "accept" ? "accepted" : cl === "reject" ? "rejected" : cl === "unresolved" ? "unresolved" : cl);
        badge.setAttribute("data-class", cl === "accept" || cl === "reject" || cl === "unresolved" ? cl : "other");
        if (cl === "unresolved") setTitle(badge, "a log op whose logged value the raw transaction does not show; the ledger may have emitted a MIP-0018 event here; never applied");
        td(tr, badge);
        td(tr, e.reason === null || e.reason === undefined ? h("span", "no", "") : data(e.reason, CELL_MAX));
        body.appendChild(tr);
      }
    }
    moreButton(sec, "events", ev.more, "events");
    sec.appendChild(h("div", "note gap",
      "Chain events named mip-0018:token-metadata[v1], with their position and classification only: an event carries no value "
      + "here (the current values are the fields above), and other events are not listed. An unresolved row is a log op whose "
      + "logged value the raw transaction does not show: the indexer cannot tell which event it was and never applies it."));
    main.appendChild(sec);
  }

  var ROLES = {
    "mint": ["mint", "dir-mint"],
    "utxo-created": ["UTXO created", "dir-in"],
    "utxo-spent": ["UTXO spent", "dir-out"],
    "contract-in": ["into contract", "dir-in"],
    "contract-out": ["out of contract", "dir-out"],
    "shielded-offer": ["shielded offer delta", ""],
    "metadata-event": ["metadata event", "dir-meta"]
  };
  function activitySection(main, act, showColor) {
    var sec = section("activity: transactions that touched it", "activity");
    add(sec, rangeNote());
    if (!act) { sec.appendChild(h("div", "empty", "loading\u2026")); main.appendChild(sec); return; }
    if (act.unavailable) {
      var na = h("div", "empty", "activity is not served by this API (" + act.path + " answered 404)");
      na.setAttribute("data-activity", "unavailable");
      sec.appendChild(na);
      main.appendChild(sec);
      return;
    }
    if (act.failed) { sec.appendChild(h("div", "err", "the activity could not be read")); main.appendChild(sec); return; }
    if (act.items.length === 0) {
      var none = h("div", "empty", "no activity in the indexed range");
      none.setAttribute("data-activity", "empty");
      sec.appendChild(none);
    } else {
      var labels = ["height", "transaction", "what", "amount", "wallet / counterparty", "details"];
      if (showColor) labels.splice(4, 0, "color");
      var body = table(sec, labels);
      for (var i = 0; i < act.items.length; i++) {
        var a = act.items[i] || {};
        var tr = h("tr");
        tr.setAttribute("data-role", own(ROLES, txt(a.role)) ? txt(a.role) : "other");
        td(tr, txt(a.height), "num");
        td(tr, hex64(txt(a.txHash)) ? link(txHash(a.txHash.toLowerCase()), hexNode(a.txHash)) : dash(""));
        var role = own(ROLES, txt(a.role)) ? ROLES[txt(a.role)] : [txt(a.role), ""];
        var what = h("span", role[1] || null, role[0]);
        if (a.direction === "in" || a.direction === "out") what.appendChild(h("span", "note", a.direction === "in" ? " \u00b7 in" : " \u00b7 out"));
        td(tr, what);
        td(tr, a.amount !== undefined && a.amount !== null ? h("span", "mono", data(a.amount, 40)) : h("span", "no", ""), "num");
        if (showColor) td(tr, hex64(txt(a.color)) ? link(colorHash(a.color.toLowerCase()), hexNode(a.color)) : h("span", "no", ""));
        var party = h("span");
        if (a.wallet !== undefined && a.wallet !== null) party.appendChild(setTitle(h("span", "wallet", data(a.wallet, 200)), "wallet address (Bech32m, as the API serves it)"));
        if (hex64(txt(a.contract)) && a.role !== "metadata-event") { party.appendChild(h("span", "note", " contract ")); party.appendChild(link(contractHash(a.contract.toLowerCase()), hexNode(a.contract))); }
        if (hex64(txt(a.recipientContract))) { party.appendChild(h("span", "note", " to contract ")); party.appendChild(link(contractHash(a.recipientContract.toLowerCase()), hexNode(a.recipientContract))); }
        if (a.role === "metadata-event" && hex64(txt(a.contract))) party.appendChild(link(contractHash(a.contract.toLowerCase()), hexNode(a.contract)));
        td(tr, party, "wide");
        var det = [];
        if (a.phase) det.push(txt(a.phase) + (a.segment !== undefined && a.segment !== null ? " \u00b7 segment " + txt(a.segment) : ""));
        if (a.kind === 1 || a.kind === 2) det.push("kind " + a.kind);
        if (a.events && typeof a.events === "object") det.push(txt(a.events.accepted) + " accepted \u00b7 " + txt(a.events.rejected) + " rejected");
        var dn = h("span", null, det.join(" \u00b7 "));
        if (a.utxo && typeof a.utxo === "object") { dn.appendChild(h("span", "note", " UTXO ")); dn.appendChild(hexNode(a.utxo.intentHash)); dn.appendChild(h("span", "mono", "#" + txt(a.utxo.outputIndex))); }
        var ep = entryPointNode(a.entryPoint);
        if (ep !== null) { dn.appendChild(h("span", "note", " entry point ")); dn.appendChild(ep); }
        td(tr, dn, "wide");
        body.appendChild(tr);
      }
    }
    moreButton(sec, "activity", act.more, "rows");
    sec.appendChild(h("div", "note gap",
      "Public token flows of applied transaction parts and the metadata transactions of the minting contract, by block height. "
      + "Amounts are base units; wallet addresses are Bech32m."));
    main.appendChild(sec);
  }

  function renderIdentity(main, r, d) {
    crumb(main, [link(contractHash(r.contract), "its contract")]);
    if (!d) { main.appendChild(h("section", null, h("div", "empty", "loading\u2026"))); return; }
    if (d.notFound) {
      var nf = section("token");
      nf.appendChild(h("div", "empty", "no such token identity in the indexed range"));
      main.appendChild(nf);
      return;
    }
    if (!d.identity) { main.appendChild(h("section", null, h("div", "err", "the token could not be read (see the banner)"))); return; }
    var t = d.identity;
    var c = t.common || {};
    var head = h("section");
    head.appendChild(h("h3", null, c.name !== null && c.name !== undefined ? data(c.name, HEAD_MAX, "head:name") : h("span", "no", "unnamed token")));
    var sub = h("div", "row");
    sub.appendChild(kindChip({ source: "identity", kind: t.kind }));
    sub.appendChild(markBadge(t.mark));
    var tags = tagChips(t.mark);
    if (tags) sub.appendChild(tags);
    if (c.symbol !== null && c.symbol !== undefined) sub.appendChild(h("span", null, ["symbol ", data(c.symbol, HEAD_MAX, "head:symbol")]));
    head.appendChild(sub);
    if (!t.described) head.appendChild(h("div", "note gap", "Not described: this token has no MIP-0018 metadata; it is listed because a mint of it was indexed."));
    main.appendChild(head);

    var id = section("identity");
    var g = kv(id);
    kvRow(g, "contract", link(contractHash(r.contract), hexFull(t.contractAddress)));
    kvRow(g, "domainSep", h("span", null, [domainNode(t.domainSep), " ", hexFull(t.domainSep)]));
    kvRow(g, "kind", kindChip({ source: "identity", kind: t.kind }));
    if (hex64(txt(t.color))) kvRow(g, "color", link(colorHash(t.color.toLowerCase()), hexFull(t.color)));
    else kvRow(g, "color", h("span", "no", t.kind === 3 ? "none (a ledger token has no color)" : "none: no mint of this identity in the indexed range"));
    if (t.minted) {
      var fm = t.minted.firstMint || {};
      kvRow(g, "first mint", h("span", null, ["block " + txt(fm.height) + " ", hex64(txt(fm.txHash)) ? link(txHash(fm.txHash.toLowerCase()), hexNode(fm.txHash)) : null]));
      kvRow(g, "mints", txt(t.minted.mints));
      kvRow(g, "minted", h("span", null, [amountNode(t.minted), h("span", "note", "  (" + txt(t.minted.amount) + " base units)")]));
    }
    kvRow(g, "network", txt(t.network));
    main.appendChild(id);

    var cs = section("common fields");
    var cg = kv(cs);
    kvRow(cg, "name", commonValue(t, "name"));
    kvRow(cg, "symbol", commonValue(t, "symbol"));
    kvRow(cg, "decimals", commonValue(t, "decimals"));
    kvRow(cg, "standards", commonValue(t, "standards"));
    main.appendChild(cs);

    var fs = section("current fields", "fields");
    add(fs, rangeNote());
    var fields = arr(t.fields);
    var fieldCount = typeof t.fieldCount === "number" ? t.fieldCount : fields.length;
    if (fieldCount > 0) fs.appendChild(h("div", "note", fieldCount + " field" + (fieldCount === 1 ? "" : "s") + ", in key byte order"));
    if (fields.length === 0) fs.appendChild(h("div", "empty", "no field"));
    else {
      var fb = table(fs, ["key", "type", "value", "usable", "set at"]);
      for (var i = 0; i < fields.length && i < FIELDS_MAX; i++) {
        var f = fields[i] || {};
        var k = f.key || {};
        var tr = h("tr");
        var keyNode = k.utf8 !== null && k.utf8 !== undefined ? data(k.utf8, CELL_MAX) : h("span", null, [hexNode(k.hex), h("span", "note", " (not UTF-8)")]);
        td(tr, setTitle(h("span", null, keyNode), "key bytes: " + txt(k.hex)));
        td(tr, txt(f.valTypeName) + " (" + txt(f.valType) + ")");
        td(tr, fieldValue(f, "field:" + txt(k.hex)), "wide");
        td(tr, f.usable === true ? h("span", "dir-in", "usable") : f.usable === false ? h("span", "err", "unusable") : h("span", "no", ""));
        var u = f.updatedAt || {};
        td(tr, "block " + txt(u.height) + " \u00b7 tx " + txt(u.txIndex) + " \u00b7 event " + txt(u.eventIndex) + " \u00b7 record " + txt(u.record));
        fb.appendChild(tr);
      }
      if (t.moreFields) {
        if (fields.length >= FIELDS_MAX) fs.appendChild(h("div", "note", (fieldCount - fields.length) + " more fields exist; this page reads at most " + FIELDS_MAX + " of them"));
        else moreButton(fs, "fields", true, "fields");
      }
    }
    fs.appendChild(h("div", "note gap", "Only the latest value of each key is kept; a deleted field and its earlier values are never shown."));
    main.appendChild(fs);

    var gs = section("symbol group");
    if (t.group && typeof t.group === "object") {
      var sym = t.group.symbol || {};
      gs.appendChild(h("div", null, ["symbol ", sym.utf8 !== null && sym.utf8 !== undefined ? data(sym.utf8, CELL_MAX) : hexNode(sym.hex)]));
      var gl = h("div", "row gap");
      var members = arr(t.group.members);
      for (var m = 0; m < members.length; m++) {
        var mb = members[m] || {};
        if (!hex64(txt(mb.domainSep)) || !(mb.kind === 1 || mb.kind === 2 || mb.kind === 3)) continue;
        var here = mb.domainSep.toLowerCase() === r.domainSep && mb.kind === r.kind;
        var lab = h("span", null, [domainNode(mb.domainSep), " \u00b7 " + KIND_NAMES[mb.kind]]);
        gl.appendChild(here ? h("b", null, lab) : link(tokenHash(r.contract, mb.domainSep.toLowerCase(), mb.kind), lab));
      }
      gs.appendChild(gl);
      if (typeof t.group.memberCount === "number" && t.group.memberCount > members.length)
        gs.appendChild(h("div", "note", "the first " + members.length + " of " + t.group.memberCount + " members"));
      gs.appendChild(h("div", "note gap", "Presentation only: identities of this contract with the same usable symbol. A group never spans contracts."));
    } else {
      gs.appendChild(h("div", "empty", "no group (a group is two or more identities of one contract with the same usable symbol)"));
    }
    main.appendChild(gs);

    var ms = section("MIP-0018 mark");
    add(ms, rangeNote());
    ms.appendChild(h("div", "row", [markBadge(t.mark), h("span", null, markText(t.mark))]));
    var reasons = t.mark ? arr(t.mark.reasons).filter(function (r) { return r !== "unresolved-log"; }) : [];
    if (reasons.length > 0) {
      var rl = h("ol", "gap");
      for (var j = 0; j < reasons.length; j++) rl.appendChild(h("li", "mono", data(reasons[j], CELL_MAX)));
      ms.appendChild(rl);
      if (typeof t.mark.reasonCount === "number" && t.mark.reasonCount > reasons.length) ms.appendChild(h("div", "note", "the first " + reasons.length + " of " + t.mark.reasonCount + " rejections; every rejected event is in the events below"));
    }
    var un = unresolvedCount(t.mark);
    if (un > 0) {
      var ul = h("ul", "gap unresolved-at");
      var at = arr(t.mark.unresolved.positions);
      for (var u = 0; u < at.length && u < REASONS_MAX; u++)
        ul.appendChild(h("li", "mono", "unresolved-log at height " + txt(at[u].height) + ", transaction " + txt(at[u].txIndex) + ", event " + txt(at[u].eventIndex)));
      ms.appendChild(ul);
      if (un > Math.min(at.length, REASONS_MAX)) ms.appendChild(h("div", "note", "the first " + Math.min(at.length, REASONS_MAX) + " of " + un + " unresolved logs; every one is in the events below"));
    }
    ms.appendChild(h("div", "note gap", "Standards tags are self-declared: a claim, never proof of conformance."));
    main.appendChild(ms);

    activitySection(main, d.activity, false);
    eventsSection(main, d.events, false, "MIP-0018 events of its contract");
  }

  function renderColor(main, r, d) {
    crumb(main, []);
    if (!d) { main.appendChild(h("section", null, h("div", "empty", "loading\u2026"))); return; }
    if (d.notFound) { main.appendChild(h("section", null, h("div", "empty", "no token with this color in the indexed range"))); return; }
    if (!d.color) { main.appendChild(h("section", null, h("div", "err", "the color could not be read (see the banner)"))); return; }
    var c = d.color;
    var head = h("section");
    if (c.builtin) {
      head.appendChild(h("h3", null, data(c.builtin.name, HEAD_MAX)));
      head.appendChild(h("div", "row", [kindChip({ source: "builtin" }), h("span", null, ["symbol ", data(c.builtin.symbol, CELL_MAX)])]));
      var bg = kv(head);
      bg.className = "kv gap";
      kvRow(bg, "color", hexFull(c.color));
      kvRow(bg, "decimals", data(c.builtin.decimals, 24));
      kvRow(bg, "note", data(c.builtin.note, VALUE_MAX));
      main.appendChild(head);
      activitySection(main, d.activity, false);
      return;
    }
    head.appendChild(h("h3", null, ["color ", hexNode(c.color, 12, 8)]));
    var g = kv(head);
    g.className = "kv gap";
    kvRow(g, "color", hexFull(c.color));
    if (hex64(txt(c.contractAddress))) {
      kvRow(g, "contract", link(contractHash(c.contractAddress.toLowerCase()), hexFull(c.contractAddress)));
      kvRow(g, "domainSep", h("span", null, [domainNode(c.domainSep), " ", hexFull(c.domainSep)]));
    } else {
      kvRow(g, "contract", h("span", "no", "not known: seen in public data, no mint of it in the indexed range"));
    }
    if (c.firstSeen) kvRow(g, "first seen", h("span", null, ["block " + txt(c.firstSeen.height) + " ", hex64(txt(c.firstSeen.txHash)) ? link(txHash(c.firstSeen.txHash.toLowerCase()), hexNode(c.firstSeen.txHash)) : null]));
    if (arr(c.evidence).length > 0) kvRow(g, "seen in", arr(c.evidence).map(txt).join(", "));
    main.appendChild(head);
    var ids = arr(c.identities);
    if (ids.length > 0) {
      var s = section("tokens of this color");
      add(s, rangeNote());
      var rows = [];
      for (var i = 0; i < ids.length; i++) {
        var x = ids[i] || {};
        var cm = x.common || {};
        rows.push({ source: "identity", kind: x.kind, color: x.color, contractAddress: x.contractAddress, domainSep: x.domainSep, name: cm.name, symbol: cm.symbol, decimals: cm.decimals, described: x.described, minted: x.minted, mark: x.mark });
      }
      tokenRows(s, rows, false);
      s.appendChild(h("div", "note gap", "One color, one or two kinds: the kind is given by what is held (a shielded coin \u2192 kind 1, an unshielded UTXO \u2192 kind 2), not by the color."));
      main.appendChild(s);
    }
    var rel = arr(c.related);
    if (rel.length > 0) {
      var rs = section("related identities of the same contract and domainSep");
      var rl = h("div", "row");
      for (var j = 0; j < rel.length; j++) {
        var y = rel[j] || {};
        if (hex64(txt(y.contractAddress)) && hex64(txt(y.domainSep)) && (y.kind === 1 || y.kind === 2 || y.kind === 3))
          rl.appendChild(link(tokenHash(y.contractAddress.toLowerCase(), y.domainSep.toLowerCase(), y.kind), [domainNode(y.domainSep), " \u00b7 " + KIND_NAMES[y.kind]]));
      }
      rs.appendChild(rl);
      main.appendChild(rs);
    }
    activitySection(main, d.activity, false);
  }

  function renderDust(main, d) {
    crumb(main, []);
    if (!d) { main.appendChild(h("section", null, h("div", "empty", "loading\u2026"))); return; }
    var items = d.list && !d.list.failed ? arr(d.list.items) : [];
    var dust = null;
    for (var i = 0; i < items.length; i++) if (items[i] && items[i].source === "builtin" && items[i].symbol === "DUST") dust = items[i];
    if (!dust) { main.appendChild(h("section", null, h("div", "err", "DUST could not be read (see the banner)"))); return; }
    var head = h("section");
    head.appendChild(h("h3", null, data(dust.name, HEAD_MAX)));
    head.appendChild(h("div", "row", [kindChip({ source: "builtin" }), h("span", null, ["symbol ", data(dust.symbol, CELL_MAX)])]));
    var g = kv(head);
    g.className = "kv gap";
    kvRow(g, "color", h("span", "no", "none"));
    kvRow(g, "decimals", data(dust.decimals, 24));
    kvRow(g, "note", data(dust.note, VALUE_MAX));
    head.appendChild(h("div", "note gap", "DUST has no color and no activity rows."));
    main.appendChild(head);
  }

  function renderContract(main, r, d) {
    crumb(main, []);
    if (!d) { main.appendChild(h("section", null, h("div", "empty", "loading\u2026"))); return; }
    if (d.notFound) { main.appendChild(h("section", null, h("div", "empty", "this contract is not known to the index (no applied call, deploy, update, mint or field in the indexed range)"))); return; }
    if (!d.tokens) { main.appendChild(h("section", null, h("div", "err", "the contract could not be read (see the banner)"))); return; }
    var head = h("section");
    head.appendChild(h("h3", null, ["contract ", hexNode(r.address, 12, 8)]));
    var g = kv(head);
    kvRow(g, "address", hexFull(r.address));
    main.appendChild(head);
    var ts = section("token identities", "tokens");
    add(ts, rangeNote());
    if (d.tokens.items.length === 0) ts.appendChild(h("div", "empty", "no token identity (called, but nothing minted or described)"));
    else tokenRows(ts, d.tokens.items, false);
    moreButton(ts, "tokens", d.tokens.more, "tokens");
    main.appendChild(ts);
    var gs = section("symbol groups");
    // Each page of tokens carries the groups of its identities: merge the pages read, by symbol.
    var groups = [];
    var seenSymbols = {};
    var tokenPages = arr(d.tokens.pages);
    for (var pi = 0; pi < tokenPages.length; pi++) {
      var pg = arr(tokenPages[pi] && tokenPages[pi].groups);
      for (var gi = 0; gi < pg.length; gi++) {
        var key = txt(pg[gi] && pg[gi].symbol && pg[gi].symbol.hex);
        if (own(seenSymbols, key)) continue;
        seenSymbols[key] = true;
        groups.push(pg[gi]);
      }
    }
    if (groups.length === 0) gs.appendChild(h("div", "empty", "no group (a group is two or more identities with the same usable symbol)"));
    for (var i = 0; i < groups.length; i++) {
      var gr = groups[i] || {};
      var sym = gr.symbol || {};
      var row = h("div", "row", [h("b", null, sym.utf8 !== null && sym.utf8 !== undefined ? data(sym.utf8, CELL_MAX) : hexNode(sym.hex))]);
      var members = arr(gr.members);
      for (var m = 0; m < members.length; m++) {
        var mb = members[m] || {};
        if (hex64(txt(mb.domainSep)) && (mb.kind === 1 || mb.kind === 2 || mb.kind === 3))
          row.appendChild(link(tokenHash(r.address, mb.domainSep.toLowerCase(), mb.kind), [domainNode(mb.domainSep), " \u00b7 " + KIND_NAMES[mb.kind]]));
      }
      if (typeof gr.memberCount === "number" && gr.memberCount > members.length) row.appendChild(h("span", "note", "the first " + members.length + " of " + gr.memberCount + " members"));
      gs.appendChild(row);
    }
    main.appendChild(gs);
    activitySection(main, d.activity, true);
    eventsSection(main, d.events, false, "MIP-0018 events");
  }

  function renderTx(main, r, d) {
    crumb(main, []);
    var head = h("section");
    head.appendChild(h("h3", null, ["transaction ", hexNode(r.hash, 12, 8)]));
    var g = kv(head);
    kvRow(g, "hash", hexFull(r.hash));
    head.appendChild(h("div", "note gap", "The API serves the MIP-0018 events of a transaction; its token flows are on the token and contract views."));
    main.appendChild(head);
    if (!d) { main.appendChild(h("section", null, h("div", "empty", "loading\u2026"))); return; }
    eventsSection(main, d.events, true, "MIP-0018 events of this transaction");
  }

  function renderStatus(main) {
    var st = state.status;
    var sec = section("status");
    if (!st) { sec.appendChild(h("div", "err", "the status could not be read")); main.appendChild(sec); return; }
    var g = kv(sec);
    kvRow(g, "network", txt(st.network));
    kvRow(g, "genesis", data(st.genesisHash, 80));
    kvRow(g, "first scanned height", txt(st.startHeight));
    kvRow(g, "indexed height", txt(st.indexedHeight));
    kvRow(g, "archive height", txt(st.archiveHeight));
    kvRow(g, "scanner", txt(st.scanner));
    if (typeof st.unresolvedEvents === "number")
      kvRow(g, "unresolved logs", setTitle(h("span", st.unresolvedEvents > 0 ? "badge warn" : null, txt(st.unresolvedEvents)),
        "log ops whose logged value the raw transaction does not show; never applied (see the events of their contracts)"));
    kvRow(g, "MIP", st.mip ? txt(st.mip.id) + " @ " + txt(st.mip.commit) : null);
    kvRow(g, "vendored reference", st.vendored ? txt(st.vendored.repository) + " @ " + txt(st.vendored.commit) : null);
    kvRow(g, "page refresh", "every " + (REFRESH_MS / 1000) + " s");
    main.appendChild(sec);
  }

  function renderStrip() {
    var s = el("strip");
    clear(s);
    var st = state.status;
    function sep() { s.appendChild(document.createTextNode("  \u00b7  ")); }
    if (st) {
      s.appendChild(document.createTextNode("net: "));
      s.appendChild(h("b", null, txt(st.network)));
      sep();
      s.appendChild(document.createTextNode("indexed "));
      s.appendChild(h("b", null, st.indexedHeight === null || st.indexedHeight === undefined ? "\u2014" : txt(st.indexedHeight)));
      if (st.scanner === "stalled") { sep(); s.appendChild(h("span", "stale", "scanner stalled")); }
    }
    if (state.statusFailed || !st) { if (st) sep(); s.appendChild(h("span", "stale", "API unreachable")); }
  }
  function renderBanner() {
    var b = el("banner");
    clear(b);
    if (state.errors.length === 0) { b.hidden = true; return; }
    b.hidden = false;
    b.appendChild(h("div", null, "the API did not answer everything this view needs, so what is shown may be stale or missing"));
    for (var i = 0; i < state.errors.length && i < 10; i++) b.appendChild(h("div", null, "\u2022 " + state.errors[i]));
  }

  function render() {
    var r = state.route;
    var d = state.data && state.data.key === state.key ? state.data : null;
    el("nav-list").className = r.view === "status" ? "" : "on";
    el("nav-status").className = r.view === "status" ? "on" : "";
    renderStrip();
    renderBanner();
    var y = window.scrollY;
    var main = el("view");
    var frag = document.createDocumentFragment();
    if (r.view === "list") renderList(frag, d);
    else if (r.view === "identity") renderIdentity(frag, r, d);
    else if (r.view === "color") renderColor(frag, r, d);
    else if (r.view === "dust") renderDust(frag, d);
    else if (r.view === "contract") renderContract(frag, r, d);
    else if (r.view === "tx") renderTx(frag, r, d);
    else if (r.view === "status") renderStatus(frag);
    else { crumb(frag, []); frag.appendChild(h("section", null, h("div", "empty", "no such page"))); }
    clear(main);
    main.appendChild(frag);
    window.scrollTo(0, y);
    state.renders++;
    document.body.setAttribute("data-route", state.key);
    document.body.setAttribute("data-state", d === null && r.view !== "status" && r.view !== "unknown" ? "loading" : state.errors.length > 0 ? "partial" : "ready");
    document.body.setAttribute("data-renders", String(state.renders));
  }

  function start() {
    el("now").addEventListener("click", function () { refresh(); });
    window.addEventListener("hashchange", onRoute);
    // Periodic refresh; a tick is skipped while the previous read of the same route is still running.
    window.setInterval(function () { if (state.inflight !== state.key) refresh(); }, REFRESH_MS);
    onRoute();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
