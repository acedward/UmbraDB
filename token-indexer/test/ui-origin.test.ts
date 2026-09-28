import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTERFACE_STATUSES } from "../api/queries.js";
import {
  type FakeElement, type Json, type Page, Reply, SERVED_SCRIPT, loadPage, markedAncestor, marksOf,
} from "./helpers/ui-page.js";

/**
 * `[[token-ui-origin]]` — spec 00024 US6 / FR-016 (sub-plan 00024-03, Phase 03-B; hardened by the
 * 03-E1a audit): on the token and contract views, every value the page shows carries its origin —
 * "MIP-0018 declaration", "Public interface", "Chain observation", "Derived by this indexer" or "Not
 * available" — and the link to ITS OWN evidence.
 *
 * No browser and no DOM library (plan 03-B item 6): the served script runs in `node:vm` with the
 * small browser of `helpers/ui-page.ts` (listeners, fetch, clipboard, hash navigation and scrolling
 * kept — audit finding E1a-F15). Checked on recorded API payloads (`fixtures/ui/`, see its SOURCE.md)
 * and on synthetic ones built from them:
 *
 *  1. the VIEW MODEL (`tokenModel`, `contractModel`): every item has a known origin with its label,
 *     and every evidence link is a route the page resolves; where the API gave the value an origin,
 *     the item's origin is of the same kind and its first link is the evidence THAT origin names —
 *     computed here from the payloads alone, so a link to another (known) transaction fails;
 *  2. the DRAWN VIEW (`renderToken`, `renderContract`): every item is drawn, marked `data-o`, and
 *     EVERY occurrence carries its own chip; nothing is marked that the model does not list; no value
 *     cell of a table is drawn outside a marked element;
 *  3. the PAGE AS A BROWSER RUNS IT: boot on a deep link scrolls to the section, following an
 *     evidence link navigates and scrolls, the copy control copies the whole value.
 */

const FIXTURES = new URL("./fixtures/ui/", import.meta.url);
const read = (name: string): Json => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const LABELS = ["MIP-0018 declaration", "Public interface", "Chain observation", "Derived by this indexer", "Not available"];
const MAX_URL_BYTES = 262_112;

// ── fixtures → the page's own state ─────────────────────────────────────────────────────────────

interface TokenFixture { token: Json; metadata: Json; mints: Json; contract: Json; events: Json; activity?: Json; calls?: Json; interface?: Json }
const TOKEN_FIXTURES = ["sneb18", "lmoon18", "lsunpi", "uprompi", "sstarpi"] as const;
const tokenFixture = (name: string): TokenFixture => read(`token-${name}.json`) as TokenFixture;

function tokenDetail(f: TokenFixture): Json {
  return {
    token: f.token, keys: f.metadata.keys, mints: f.mints.items, events: f.events.items,
    siblings: f.contract.tokens, activity: f.activity ?? null, calls: f.calls ?? null, notes: [],
  };
}
function contractState(f: { contract: Json; events?: Json; calls?: Json }, iface: Json): Json {
  return { contract: f.contract, iface, ifaceLoaded: true, events: f.events ? f.events.items : [], calls: f.calls ?? null, notes: [] };
}

interface Drawn { root: FakeElement; ids: Set<string>; model: Json }
function drawToken(page: Page, f: TokenFixture): Drawn {
  const t = f.token;
  page.ctx.state.route = { view: "token", address: t.address, domainSep: t.domainSep, kind: String(t.kind) };
  page.ctx.state.detail = tokenDetail(f);
  const root = page.doc.createElement("main");
  page.ctx.renderToken(root);
  return { root, ids: idsOf(root), model: page.ctx.tokenModel(page.ctx.state.detail) };
}
function drawContract(page: Page, state: Json): Drawn {
  page.ctx.state.route = { view: "contract", address: state.contract.address };
  page.ctx.state.contract = state;
  const root = page.doc.createElement("main");
  page.ctx.renderContract(root);
  return { root, ids: idsOf(root), model: page.ctx.contractModel(state) };
}
/** A token row of the list (tokens.json) as its own token view: a colour route for a `seen` row. */
function rowFixture(row: Json): TokenFixture {
  return { token: row, metadata: { keys: row.traits ?? [] }, mints: { items: [] }, contract: { tokens: [row] }, events: { items: [] },
    activity: { items: [], nextCursor: null } };
}
function drawRow(page: Page, row: Json): Drawn {
  const f = rowFixture(row);
  page.ctx.state.route = row.address
    ? { view: "token", address: row.address, domainSep: row.domainSep, kind: String(row.kind) }
    : { view: "token", color: row.color, kind: String(row.kind) };
  page.ctx.state.detail = tokenDetail(f);
  const root = page.doc.createElement("main");
  page.ctx.renderToken(root);
  return { root, ids: idsOf(root), model: page.ctx.tokenModel(page.ctx.state.detail) };
}
function idsOf(root: FakeElement): Set<string> {
  const ids = new Set<string>();
  for (const el of root.walk()) if (el.id) ids.add(el.id);
  return ids;
}

// Every transaction, contract and token the payloads name — what an evidence link may point at.
interface Known { txs: Set<string>; contracts: Set<string>; tokens: Set<string> }
function knownOf(...docs: Json[]): Known {
  const k: Known = { txs: new Set(), contracts: new Set(), tokens: new Set() };
  const visit = (v: Json): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v === null || typeof v !== "object") return;
    for (const [key, val] of Object.entries(v)) {
      if ((key === "txHash" || key === "deployTxHash") && typeof val === "string") k.txs.add(val);
      if ((key === "address" || key === "contract") && typeof val === "string" && /^[0-9a-f]{64}$/.test(val)) k.contracts.add(val);
      visit(val);
    }
    if (typeof v.address === "string" && typeof v.domainSep === "string" && v.kind !== undefined) {
      k.tokens.add(`${v.address}/${v.domainSep}/${v.kind}`);
    }
  };
  docs.forEach(visit);
  return k;
}

// ── the API origin behind each value, computed from the payloads alone (independent of the page) ─

type Sources = Map<string, Json>;
/** An API origin tagged with the token it belongs to, so a derived value's section links can be
 *  expected exactly (E1a-R3C) — the tag is the test's, never the page's. */
const ofToken = (o: Json, token: Json): Json => ({ ...o, __token: token });
const hexOf = (s: string): string => Buffer.from(s, "utf8").toString("hex");
function tokenSources(f: TokenFixture): Sources {
  const m: Sources = new Map();
  const o = f.token.origins ?? {};
  for (const k of ["name", "symbol", "decimals", "tokenUri", "color", "status", "metadata"]) if (o[k]) m.set(k, ofToken(o[k], f.token));
  for (const k of ["mintCount", "totalMinted", "firstMintHeight", "lastMintHeight"]) if (o.mints) m.set(k, o.mints);
  if (f.token.interface) m.set("interface", f.token.interface.origin);
  for (const kv of f.metadata.keys ?? []) m.set(`trait:${kv.keyHex ?? hexOf(kv.key)}`, kv.origin);
  for (const e of f.events.items ?? []) {
    m.set(`event:${e.eventId}`, e.origin);
    if (e.keyHex) m.set(`trait:${e.keyHex}:${e.eventId}`, e.origin);
  }
  for (const r of f.mints.items ?? []) m.set(`mint:${r.txHash}:${r.segment}:${r.callIndex}`, r.origin);
  for (const r of f.activity?.items ?? []) m.set(`activity:${[r.txHash, r.segment, r.section, r.role, r.itemIndex].join(":")}`, r.origin);
  for (const s of f.contract.tokens ?? []) rowSources(m, s);
  return m;
}
function rowSources(m: Sources, s: Json): void {
  const o = s.origins ?? {};
  for (const k of ["color", "name", "symbol", "decimals", "status"]) if (o[k]) m.set(`row:${s.domainSep}:${s.kind}:${k}`, ofToken(o[k], s));
  if (o.mints) m.set(`row:${s.domainSep}:${s.kind}:mints`, o.mints);
}
function contractSources(c: Json, x: Json, events: Json[] = []): Sources {
  const m: Sources = new Map();
  for (const s of c.tokens ?? []) rowSources(m, s);
  for (const e of events) m.set(`event:${e.eventId}`, e.origin);
  // The deploy facts and the calls come without an origin (Q28): their evidence is the payload's own.
  if (c.deployTxHash) {
    const deploy = { origin: "chain", evidence: { txHash: c.deployTxHash } };
    m.set("deployHeight", deploy); m.set("deployTxHash", deploy); m.set("address", deploy);
  }
  if (x) {
    for (const r of ["status", "levels", "failure", "reason", "l3", "commitment", "url", "publication", "payload", "checkedAt",
      "checks", "lastVerifiedAt", "verifiedUntil", "nextCheckAt", "state", "compiler", "build", "publications"]) m.set(`iface:${r}`, x.origin);
    (x.files ?? []).forEach((f: Json, i: number) => m.set(`iface:file:${i}`, f.origin));
    (x.keys ?? []).forEach((k: Json, i: number) => m.set(`iface:key:${i}`, k.origin));
    (x.circuits ?? []).forEach((k: Json, i: number) => m.set(`iface:circuit:${i}`, k.origin));
    (x.history ?? []).forEach((h: Json) => m.set(`iface:history:${h.eventId}`, h.origin));
  }
  return m;
}
function callSources(m: Sources, calls: Json): void {
  for (const c of calls?.items ?? []) m.set(`call:${c.txHash}:${c.segment}:${c.callIndex}`, { origin: "chain", evidence: { txHash: c.txHash } });
}
/** Every evidence link an origin of the API names, in order — computed from the payload alone
 *  (E1a-R2F: every link is checked, not only the first). A string must equal the link; a RegExp
 *  must match it. null when the origin names nothing the page can link by itself (the page then
 *  links the section its context names, which the resolution check covers). */
type Want = string | RegExp;
const HEX64 = /^[0-9a-f]{64}$/;
function expectedLinks(o: Json, address: string | null): Want[] | null {
  if (!o || typeof o !== "object") return null;
  const ev = o.evidence;
  if (o.origin === "mip-0018" || (o.origin === "none" && ev)) {
    const pks = (Array.isArray(ev) ? ev : ev ? [ev] : []).filter((p: Json) => p && typeof p.txHash === "string" && HEX64.test(p.txHash));
    return pks.length === 0 ? null : pks.map((p: Json) => `#/tx/${p.txHash}`);
  }
  if (o.origin === "public-interface") {
    if (address === null) return null;
    const out: Want[] = [`#/contract/${address}/interface`];
    if (ev && typeof ev.txHash === "string" && HEX64.test(ev.txHash)) out.push(`#/tx/${ev.txHash}`);
    return out;
  }
  if (o.origin === "chain") {
    const out: Want[] = [];
    if (ev && typeof ev.txHash === "string" && HEX64.test(ev.txHash)) out.push(`#/tx/${ev.txHash}`);
    if (ev && typeof ev.contract === "string" && HEX64.test(ev.contract)) out.push(`#/contract/${ev.contract}`);
    if (ev && ev.list === "shielded-offers") out.push("#/shielded-offers");
    return out.length === 0 ? null : out;
  }
  if (o.origin === "derived") {
    const out: Want[] = [];
    if (ev && typeof ev === "object" && !Array.isArray(ev)) {
      if (typeof ev.address === "string" && HEX64.test(ev.address)) out.push(`#/contract/${ev.address}`);
      // the token's own sections, its route computed here (a colour route for a row with no contract)
      const t = o.__token;
      const route = t ? (t.address && t.domainSep ? `#/token/${t.address}/${t.domainSep}/${t.kind}` : `#/color/${t.color}/${t.kind}`) : null;
      if ("mintCount" in ev) out.push(route ? `${route}/mints` : /\/mints$/);
      if ("declared" in ev) out.push(route ? `${route}/traits` : /\/traits$/);
      if (typeof ev.txHash === "string" && HEX64.test(ev.txHash)) out.push(`#/tx/${ev.txHash}`);
    }
    return out.length === 0 ? null : out;
  }
  return null;
}
const wantText = (w: Want[]): string => w.map((x) => (typeof x === "string" ? x : String(x))).join(" ").slice(0, 200);

// ── the checks ──────────────────────────────────────────────────────────────────────────────────

interface Where { tokenIds: Set<string>; contractIds: Set<string>; address: string | null }

function resolves(page: Page, href: string, where: Where, known: Known): string | null {
  const r = page.ctx.routeOf(href);
  if (r.view === "tx") return /^[0-9a-f]{64}$/.test(r.hash) && known.txs.has(r.hash) ? null : "a transaction the payloads do not name";
  if (r.view === "contract") {
    if (!known.contracts.has(r.address)) return "a contract the payloads do not name";
    if (r.focus && !where.contractIds.has(r.focus)) return `the contract view has no section "${r.focus}"`;
    return null;
  }
  if (r.view === "token") {
    if (r.color === undefined && !known.tokens.has(`${r.address}/${r.domainSep}/${r.kind}`)) return "a token the payloads do not name";
    if (r.focus && !where.tokenIds.has(r.focus)) return `the token view has no section "${r.focus}"`;
    return null;
  }
  if (r.view === "offers") return null; // the chain-wide list of undisclosed shielded offers
  if (href === "/v1/tokens?status=builtin") return null; // the API's own seeded rows (E1a-R3A)
  return `the route resolves to the ${String(r.view)} view`;
}

/** Check 1 — the model: a known origin, its label, its OWN evidence, links that resolve. */
function checkModel(page: Page, items: Json[], where: Where, known: Known, sources: Sources = new Map()): string[] {
  const out: string[] = [];
  const fields = new Set<string>();
  for (const it of items) {
    if (fields.has(it.field)) out.push(`${it.field}: listed twice`);
    fields.add(it.field);
    const o = it.origin;
    if (!o || o.known !== true) { out.push(`${it.field}: shown without an origin (${o ? o.label : "none"})`); continue; }
    if (!LABELS.some((l) => o.label === l || o.label.startsWith(`${l}, `) || o.label.startsWith(`${l} (`))) {
      out.push(`${it.field}: label "${o.label}" is not one of the five`);
    }
    if (o.kind === "mip-0018" || o.kind === "public-interface" || o.kind === "chain") {
      if (o.links.length === 0) out.push(`${it.field}: ${o.kind} without an evidence link`);
    }
    if (o.kind === "derived" && !o.rule) out.push(`${it.field}: derived without its rule`);
    // a derived value links the inputs it names, or the section that shows them (E1a-F7, E1a-R2A)
    if (o.kind === "derived" && o.links.length === 0) out.push(`${it.field}: derived without an evidence link`);
    if (o.kind === "none" && !o.reason) out.push(`${it.field}: not available without a reason`);
    if (o.kind === "public-interface" && where.address !== null
      && !o.links.some((l: Json) => l.href === `#/contract/${where.address}/interface`)) {
      out.push(`${it.field}: a public-interface value that does not link its interface section`);
    }
    for (const l of o.links) {
      const why = resolves(page, l.href, where, known);
      if (why !== null) out.push(`${it.field}: the link ${l.href.slice(0, 90)} resolves to ${why}`);
    }
    const src = sources.get(it.field);
    if (src !== undefined) {
      if (src.origin !== o.kind) out.push(`${it.field}: origin ${o.kind}, but the API gave ${String(src.origin)}`);
      // a derived value whose evidence names its inputs links them (E1a-F7)
      const inputs = src.origin === "derived" && src.evidence && typeof src.evidence === "object" && !Array.isArray(src.evidence)
        ? Object.keys(src.evidence).length : 0;
      if (inputs > 0 && o.links.length === 0) out.push(`${it.field}: derived from ${inputs} inputs without a link to them`);
      const want = expectedLinks(src, where.address);
      const got: string[] = o.links.map((l: Json) => l.href);
      if (want !== null) {
        const ok = got.length === want.length && want.every((w, i) => (typeof w === "string" ? got[i] === w : w.test(got[i]!)));
        if (!ok) out.push(`${it.field}: evidence links ${got.join(" ").slice(0, 200)}, but its evidence is ${wantText(want)}`);
      }
    }
  }
  return out;
}

/** Check 2 — the drawing: every occurrence of every item with its own chip; nothing drawn that is
 *  not an item; no value cell of a table outside a marked element. */
function checkDrawn(root: FakeElement, items: Json[]): string[] {
  const out: string[] = [];
  const drawn = marksOf(root);
  const wanted = new Set(items.map((it) => it.field as string));
  for (const it of items) {
    const els = drawn.get(it.field);
    if (els === undefined) { out.push(`${it.field}: in the model but not drawn`); continue; }
    const first = it.origin.links[0];
    const hasChip = (el: FakeElement): boolean => [...el.walk()].some((c) =>
      c.className.split(" ").includes("orig") && c.textContent === it.origin.label
      && (first === undefined ? c.tagName === "span" : c.tagName === "a" && c.href === first.href));
    els.forEach((el, i) => { if (!hasChip(el)) out.push(`${it.field}: drawn (occurrence ${i + 1} of ${els.length}) without its origin "${it.origin.label}"`); });
    // every evidence line drawn for it links exactly the model's links, in order (E1a-R3C)
    const want = it.origin.links.map((l: Json) => l.href).join(" ");
    for (const el of els) {
      for (const line of [...el.walk()].filter((c) => c.className === "oev")) {
        if (markedAncestor(line) !== el) continue;
        const got = [...line.walk()].filter((c) => c.tagName === "a").map((c) => c.href).join(" ");
        if (got !== want) out.push(`${it.field}: its evidence line links ${got.slice(0, 160)}, not ${want.slice(0, 160)}`);
      }
    }
  }
  for (const f of drawn.keys()) if (!wanted.has(f)) out.push(`${f}: drawn but not in the model`);
  for (const el of root.walk()) {
    if (el.tagName !== "td" || markedAncestor(el) !== null) continue;
    let inBody = false;
    for (let n: FakeElement | null = el; n !== null; n = n.parentNode) if (n.tagName === "tbody") inBody = true;
    if (inBody) out.push(`a value cell drawn outside any marked element: "${el.textContent.slice(0, 60)}"`);
  }
  // Wherever a value of the view is drawn — a table cell, a heading, a line of the header — its text
  // lies inside a marked element, i.e. next to an origin (E1a-R2E: the check no longer depends on
  // the page marking every place it draws a value).
  const values = new Map<string, string>();
  for (const it of items) {
    const v = it.value === null || it.value === undefined ? "" : String(it.value);
    if (v.trim().length >= 3 && !values.has(v)) values.set(v, it.field);
  }
  for (const el of root.walk()) {
    if (el.children.length > 0 || markedAncestor(el) !== null) continue;
    const field = values.get(el.textContent);
    if (field !== undefined) out.push(`${field}: its value "${el.textContent.slice(0, 40)}" is drawn outside any marked element`);
  }
  return out;
}

/** Check 3 — the payload: no DISTINCTIVE piece of the data a view was drawn from — a text of four
 *  characters or more, the head of a hash, a number of two digits or more — appears in any drawn
 *  text outside a marked element, i.e. away from an origin (E1a-R3B: a value is found wherever and
 *  however it is drawn — a breadcrumb, a summary line, "(shielded)" — not only as an exact leaf).
 *  Values of an enumeration (statuses, kinds, phases …) also name themselves in the page's own prose,
 *  so they are matched only as a whole word-for-word leaf (punctuation around it ignored). */
const ENUM_KEYS = new Set(["status", "role", "privacy", "storage", "phase", "section", "l1", "l2", "l3", "trigger",
  "shieldedVisibility", "direction", "nameVariant", "result", "origin", "kind", "kindByte", "valType", "level", "failedLevel"]);
const TEXT_KEYS = new Set(["rule", "reason", "l3Reason", "help"]); // the API's explanations: evidence lines, inside marks
function payloadPieces(payload: Json): { pieces: Set<string>; words: Set<string> } {
  const pieces = new Set<string>();
  const words = new Set<string>();
  const add = (key: string, v: Json): void => {
    if (typeof v === "number" && Number.isInteger(v)) { if (Math.abs(v) >= 10 && !ENUM_KEYS.has(key)) pieces.add(String(v)); return; }
    if (typeof v !== "string" || TEXT_KEYS.has(key)) return;
    if (ENUM_KEYS.has(key)) { if (v.length >= 3) words.add(v); return; }
    if (/^[0-9a-f]{16,}$/i.test(v)) { pieces.add(v.slice(0, 8)); return; } // a hash: its head, as shortHex draws it
    if (/^-?\d+$/.test(v)) { if (v.replace("-", "").length >= 2) pieces.add(v); return; }
    // a word the page itself also writes ("mint", "name", "parts" …) is matched as a whole leaf only
    if (SERVED_SCRIPT.includes(v)) { if (v.length >= 3) words.add(v); return; }
    if (v.length >= 4) pieces.add(v.length > 80 ? v.slice(0, 80) : v);
  };
  const visit = (key: string, v: Json): void => {
    if (Array.isArray(v)) { for (const x of v) visit(key, x); return; }
    if (v !== null && typeof v === "object") { for (const [k, x] of Object.entries(v)) visit(k, x); return; }
    add(key, v);
  };
  visit("", payload);
  return { pieces, words };
}
function checkPayloadShown(root: FakeElement, payload: Json): string[] {
  const out: string[] = [];
  const { pieces, words } = payloadPieces(payload);
  for (const el of root.walk()) {
    if (el.children.length > 0 || markedAncestor(el) !== null) continue;
    // a column heading names a field; a table's caption names it and counts its (marked) rows
    if (el.tagName === "th" || el.className === "h") continue;
    const text = el.textContent;
    if (text.trim() === "") continue;
    const bare = text.trim().replace(/^[(\[·\s]+|[)\]·,:\s]+$/g, "");
    if (words.has(bare)) { out.push(`"${text.slice(0, 60)}": a value drawn outside any marked element`); continue; }
    const grouped = text.replace(/\u00a0/g, "");
    for (const p of pieces) {
      if (text.includes(p) || (p.length >= 4 && /^\d+$/.test(p) && grouped.includes(p))) {
        out.push(`"${text.slice(0, 60)}": holds "${p.slice(0, 20)}" of the payload outside any marked element`);
        break;
      }
    }
  }
  return out;
}

// ── synthetic payloads, built from the recorded ones ────────────────────────────────────────────

const DIAGNOSTIC_CHARS = 2000; // token-indexer/interface/verify.ts MAX_DIAGNOSTIC_CHARS
function bounded(text: string): string {
  const marker = (n: number): string => `… [${n} characters omitted]`;
  if (text.length <= DIAGNOSTIC_CHARS) return text;
  const kept = DIAGNOSTIC_CHARS - marker(text.length).length;
  return `${text.slice(0, kept)}${marker(text.length - kept)}`;
}
const BOUNDED_REASON = bounded(`Level 2: the verifier key of circuit mint differs: ${"0123456789abcdef".repeat(6_250)}`);
const MAX_URL = (() => {
  const head = "https://bundles.example/";
  const tail = "/index.json";
  return head + "p".repeat(MAX_URL_BYTES - head.length - tail.length) + tail;
})();

type Status = (typeof INTERFACE_STATUSES)[number];
const LEVELS: Record<Status, Json> = {
  pending: { l1: "not_run", l2: "not_run", l3: "not_run" },
  verified: { l1: "passed", l2: "passed", l3: "passed" },
  failed: { l1: "passed", l2: "failed", l3: "not_run" },
  unchecked: { l1: "not_run", l2: "not_run", l3: "not_run" },
  unfetchable: { l1: "not_run", l2: "not_run", l3: "not_run" },
  unreachable: { l1: "not_run", l2: "not_run", l3: "not_run" },
  stale: { l1: "passed", l2: "passed", l3: "passed" },
};
/** A publication of `base`'s contract with status `s` (and the matching levels, reason, times). */
function publicationAs(base: Json, s: Status, role: "current" | "historical", eventId: number): Json {
  const p = clone(base);
  delete p.files; delete p.keys; delete p.circuits; delete p.checkHistory; delete p.history; delete p.witnesses;
  p.eventId = eventId; p.partEventIds = [eventId]; p.role = role; p.status = s; p.levels = clone(LEVELS[s]);
  p.level = s === "verified" || s === "stale" ? 3 : s === "failed" ? 1 : 0;
  p.failedLevel = s === "failed" ? 2 : null;
  p.l3Reason = null;
  p.reason = s === "failed" ? BOUNDED_REASON
    : s === "unchecked" ? "Level 1: index.json: the 30000 ms deadline was reached after 30001 ms; the bundle was not checked"
      : s === "unfetchable" ? "the URL is not http(s): ipfs"
        : s === "unreachable" ? "the host did not deliver: index.json: HTTP 503" : null;
  if (s === "unfetchable") p.url = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/index.json";
  if (s === "pending") { p.checkedAt = null; p.checks = 0; p.nextCheckAt = null; p.lastVerifiedAt = null; }
  p.origin = clone(base.origin);
  Object.assign(p.origin.evidence, { eventId, partEventIds: [eventId], status: s, level: p.level, levels: clone(LEVELS[s]), checkedAt: p.checkedAt });
  return p;
}

// ── the API as the page asks it, for the boot / navigation checks ───────────────────────────────

function apiRoutes(f: TokenFixture): Map<string, Json> {
  const t = f.token;
  const a = t.address;
  const base = `/v1/contracts/${a}/tokens/${t.domainSep}/${t.kind}`;
  const routes = new Map<string, Json>([
    ["/internal/status", { net: "undeployed" }],
    [`/v1/contracts/${a}`, f.contract],
    [`/v1/contracts/${a}/events?limit=500`, f.events],
    [`/v1/contracts/${a}/calls?limit=200`, f.calls ?? { items: [], nextCursor: null }],
    [base, t],
    [`${base}/metadata`, f.metadata],
    [`${base}/mints?limit=200`, f.mints],
    [`${base}/transactions?limit=200`, f.activity ?? { items: [], nextCursor: null }],
  ]);
  if (f.interface) routes.set(`/v1/contracts/${a}/interface`, f.interface);
  return routes;
}

/** Every event id in `v` moved by `by` (eventId, eventIds, partEventIds), so recorded events can be
 *  placed after synthetic ones without changing anything else. */
function shiftIds(v: Json, by: number): Json {
  if (Array.isArray(v)) return v.map((x) => shiftIds(x, by));
  if (v === null || typeof v !== "object") return v;
  const out: Json = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "eventId" && typeof x === "number") out[k] = x + by;
    else if ((k === "eventIds" || k === "partEventIds") && Array.isArray(x)) out[k] = x.map((n: number) => n + by);
    else out[k] = shiftIds(x, by);
  }
  return out;
}
/** LMOON18 behind `fillerPages` pages of 500 unrelated declarations (another domain separator):
 *  the recorded description history (a text, a Null, a 2-part value) starts on page fillerPages + 1. */
function lmoonBehindFillers(fillerPages: number): { f: TokenFixture; routes: Map<string, Json> } {
  const f = shiftIds(tokenFixture("lmoon18"), 1_000_000) as TokenFixture;
  const a = f.token.address;
  const routes = apiRoutes(f);
  const model = f.events.items[0];
  for (let p = 0; p < fillerPages; p++) {
    const items = Array.from({ length: 500 }, (_, i) => ({ ...model, eventId: p * 500 + i + 1, keyText: "filler", keyHex: "66696c6c6572",
      domainSep: "ff".repeat(32), origin: { ...model.origin, evidence: { ...model.origin.evidence, eventIds: [p * 500 + i + 1] } } }));
    routes.set(`/v1/contracts/${a}/events?limit=500${p === 0 ? "" : `&cursor=c${p}`}`, { items, nextCursor: `c${p + 1}` });
  }
  routes.set(`/v1/contracts/${a}/events?limit=500&cursor=c${fillerPages}`, { items: f.events.items, nextCursor: null });
  return { f, routes };
}
async function bootToken(f: TokenFixture, routes: Map<string, Json>, script = SERVED_SCRIPT): Promise<Page> {
  const live = loadPage(script, routes);
  live.window.location.hash = `#/token/${f.token.address}/${f.token.domainSep}/${f.token.kind}`;
  live.boot();
  await live.settle();
  return live;
}

// ── the test ────────────────────────────────────────────────────────────────────────────────────

describe("the page shows the origin of every value", () => {
  /**
   * ONE test carries the id: an id reported by more than one test is an `ambiguous` gate violation
   * (check-required-tests.ts). Its negative controls are the untagged tests below.
   */
  it("[[token-ui-origin]] every value of the token and contract views has an origin label and an evidence link that resolves", async () => {
    expect(SERVED_SCRIPT.length).toBeGreaterThan(10_000);
    const page = loadPage();
    const kindsSeen = new Set<string>();
    const note = (items: Json[]): void => { for (const it of items) kindsSeen.add(it.origin.kind); };

    // ── every recorded token: its token view and its contract view ────────────────────────────
    for (const name of TOKEN_FIXTURES) {
      const f = tokenFixture(name);
      const known = knownOf(f);
      const contract = drawContract(page, contractState(f, f.interface ?? null));
      const token = drawToken(page, f);
      const where: Where = { tokenIds: token.ids, contractIds: contract.ids, address: f.token.address };
      const tSrc = tokenSources(f); callSources(tSrc, f.calls);
      const cSrc = contractSources(f.contract, f.interface ?? null, f.events.items); callSources(cSrc, f.calls);
      expect(checkModel(page, token.model.all, where, known, tSrc), `${name}: token view model`).toEqual([]);
      expect(checkDrawn(token.root, token.model.all), `${name}: token view drawn`).toEqual([]);
      expect(checkModel(page, contract.model.all, where, known, cSrc), `${name}: contract view model`).toEqual([]);
      expect(checkDrawn(contract.root, contract.model.all), `${name}: contract view drawn`).toEqual([]);
      expect(checkPayloadShown(token.root, tokenDetail(f)), `${name}: token view payload`).toEqual([]);
      expect(checkPayloadShown(contract.root, contractState(f, f.interface ?? null)), `${name}: contract view payload`).toEqual([]);
      note(token.model.all); note(contract.model.all);
      expect(token.model.all.length, `${name}: the token view lists its values`).toBeGreaterThan(20);
      // the independent map really covered the view (a check over nothing proves nothing)
      expect(token.model.all.filter((it: Json) => tSrc.has(it.field)).length, `${name}: values with an API origin`).toBeGreaterThan(8);
    }

    // ── E1a-F7: every derived value with inputs links them; a `seen` colour links its movements ─
    {
      const rows = read("tokens.json").items as Json[];
      for (const row of [...["seen", "observed", "declared", "described"].map((st) => rows.find((r) => r.status === st)!),
        ...rows.filter((r) => r.status === "builtin")]) {
        const status = `${row.status} ${row.symbol ?? ""}`;
        const drawn = drawRow(page, row);
        const where: Where = { tokenIds: drawn.ids, contractIds: new Set(["interface", "calls", "events", "facts"]), address: row.address ?? null };
        expect(checkModel(page, drawn.model.all, where, knownOf(row), tokenSources(rowFixture(row))), `${status} row: model`).toEqual([]);
        expect(checkDrawn(drawn.root, drawn.model.all), `${status} row: drawn`).toEqual([]);
        expect(checkPayloadShown(drawn.root, tokenDetail(rowFixture(row))), `${status} row: payload`).toEqual([]);
      }
      // E1a-F8: the identity (domainSep, kind) links where it is carried — declarations, or mints for
      // a token that was only minted, or a seen colour's movements
      const want: Record<string, string> = { seen: "activity", observed: "mints", declared: "events", described: "events" };
      for (const row of rows.filter((r) => want[r.status] !== undefined)) {
        const facts = drawRow(page, row).model.facts;
        for (const field of row.address ? ["domainSep", "kind"] : ["kind"]) {
          const first = facts.find((i: Json) => i.field === field).origin.links[0]?.href ?? "(none)";
          expect(first, `${row.status} row: ${field}`).toMatch(new RegExp(`/${want[row.status]}$`));
        }
      }
      // E1a-R3A: a built-in row's seeded values cite the seed itself (the API's built-in rows)
      for (const b of rows.filter((r) => r.status === "builtin")) {
        const facts = drawRow(page, b).model.facts;
        for (const field of ["address", "domainSep", "kind", "firstSeenHeight", "deployHeight", "visibility"]) {
          expect(facts.find((i: Json) => i.field === field).origin.links.map((l: Json) => l.href), `${b.symbol} ${field}`)
            .toEqual(["/v1/tokens?status=builtin"]);
        }
      }
      // E1a-R2A: the visibility links the section it decides; a pending lookup links its transaction
      const upV = drawToken(page, tokenFixture("uprompi")).model.facts.find((i: Json) => i.field === "visibility");
      expect(upV.origin.links.map((l: Json) => l.href)).toEqual([`#/token/${tokenFixture("uprompi").token.address}/${tokenFixture("uprompi").token.domainSep}/${tokenFixture("uprompi").token.kind}/activity`]);
      const lm = tokenFixture("lmoon18");
      expect(drawToken(page, lm).model.facts.find((i: Json) => i.field === "visibility").origin.links[0].href).toMatch(/\/calls$/);
      const pendingTx = lm.contract.deployTxHash as string;
      const stuck = clone(lm.contract);
      stuck.pendingLookups = [{ txHash: pendingTx, address: stuck.address, expected: 3, got: 1, attempts: 2, lastError: null }];
      const pend = drawContract(page, contractState({ contract: stuck, events: lm.events, calls: lm.calls }, null));
      const pendItem = pend.model.pending[0];
      expect(pendItem.origin.kind).toBe("derived");
      expect(pendItem.origin.links.map((l: Json) => l.href)).toEqual([`#/tx/${pendingTx}`]);
      expect(checkModel(page, pend.model.all, { tokenIds: drawToken(page, lm).ids, contractIds: pend.ids, address: stuck.address }, knownOf(lm, stuck))).toEqual([]);
      expect(checkDrawn(pend.root, pend.model.all)).toEqual([]);
      expect(checkPayloadShown(pend.root, { contract: stuck })).toEqual([]);
      // E1a-R2I: first seen links the observation that set it — a mint before the first declaration
      {
        const f = clone(tokenFixture("sneb18"));
        const firstDecl = Math.min(...f.events.items.filter((e: Json) => e.domainSep === f.token.domainSep).map((e: Json) => Number(e.blockHeight)));
        f.token.firstMintHeight = firstDecl - 50; f.token.firstSeenHeight = firstDecl - 50;
        expect(drawToken(page, f).model.facts.find((i: Json) => i.field === "firstSeenHeight").origin.links[0].href).toMatch(/\/mints$/);
        f.token.firstMintHeight = firstDecl + 50; f.token.firstSeenHeight = firstDecl;
        expect(drawToken(page, f).model.facts.find((i: Json) => i.field === "firstSeenHeight").origin.links[0].href).toMatch(/\/events$/);
      }
      const seenRow = rows.find((r) => r.status === "seen")!;
      const seenColor = drawRow(page, seenRow).model.facts.find((i: Json) => i.field === "color");
      expect(seenColor.origin.links[0].href).toBe(`#/color/${seenRow.color}/${seenRow.kind}/activity`);
      const sneb = drawToken(page, tokenFixture("sneb18")).model.facts;
      expect(sneb.find((i: Json) => i.field === "color").origin.links[0].href).toBe(`#/contract/${tokenFixture("sneb18").token.address}`);
      expect(sneb.find((i: Json) => i.field === "status").origin.links.map((l: Json) => l.text))
        .toEqual(["input: the mint history", "input: the declarations"]);
    }

    // ── E1a-R2E: an opened shielded offer is drawn as an occurrence of its activity row ────────
    {
      const ss = tokenFixture("sstarpi");
      const row = ss.activity!.items.find((a: Json) => a.role === "shielded_delta");
      const key = [row.txHash, row.segment, row.section, row.role, row.itemIndex].join("|");
      page.ctx.state.act = { role: "", pages: 1, expand: { [key]: { loading: false, error: null, doc: {
        offers: [{ section: "guaranteed", segment: 0, counted: true, deltas: [{ color: row.color, delta: "-5000000" }],
          inputs: [{ nullifier: "ab".repeat(32) }], outputs: [{ commitment: "cd".repeat(32) }], transients: [] }] } } } };
      const drawn = drawToken(page, ss);
      page.ctx.state.act = { role: "", pages: 1, expand: {} };
      const field = `activity:${[row.txHash, row.segment, row.section, row.role, row.itemIndex].join(":")}`;
      const det = [...drawn.root.walk()].find((el) => el.className === "det")!;
      expect(det.getAttribute("data-o")).toBe(field);
      expect(det.textContent).toContain("the offer, as decoded from this archived transaction");
      expect(checkDrawn(drawn.root, drawn.model.all)).toEqual([]);
      // the nullifier and the commitment it shows lie inside the marked row
      for (const hex of ["abababab", "cdcdcdcd"]) {
        const leaf = [...det.walk()].find((el) => el.children.length === 0 && el.textContent.startsWith(hex))!;
        expect(markedAncestor(leaf)?.getAttribute("data-o")).toBe(field);
      }
    }

    // ── E1a-F2: a key's history past the first page of the contract's events ─────────────────
    // 500 unrelated declarations first: the description (a text, a Null, a 2-part value) is on page 2.
    {
      const { f, routes } = lmoonBehindFillers(1);
      const live = await bootToken(f, routes);
      const m = live.ctx.tokenModel(live.ctx.state.detail);
      const d2 = m.traits.find((i: Json) => i.label === "description");
      expect(d2.history.map((h: Json) => h.eventId), "the history is read past the first page").toEqual([1_000_080, 1_000_078]);
      expect(d2.origin.p1).toBe(true);
      expect(d2.origin.detail).toContain("the latest of 3 declarations of this key");
      expect(live.requests.filter((r) => r.includes("/events?")).length).toBe(2);
      // more pages than the page reads (4 x 500): it stops, and says so where the history is shown
      const far = lmoonBehindFillers(5);
      const cut = await bootToken(far.f, far.routes);
      expect(cut.requests.filter((r) => r.includes("/events?")).length).toBe(4);
      expect(cut.ctx.state.detail.eventsMore).toBe(true);
      const view = cut.doc.getElementById("view")!;
      const traitsSec = [...view.walk()].find((el) => el.id === "traits")!;
      expect(traitsSec.textContent).toContain("this contract has more token-metadata events than the page reads a contract's first 2\u00a0000 events");
      const eventsSec = [...view.walk()].find((el) => el.id === "events")!;
      expect(eventsSec.textContent).toContain("the rows below come from those read");
    }

    // ── E1a-R3B: the heading and its summary line — every value drawn there is a marked occurrence
    // with its own chip, counted independently of the checkers above (a mutation that drops a mark
    // AND its chip for a formatted value such as "(shielded)" or "decimals 0" fails here) ──────
    for (const name of TOKEN_FIXTURES) {
      const f = tokenFixture(name);
      const drawn = drawToken(page, f);
      const marks = marksOf(drawn.root);
      const head = drawn.root.children.find((c) => c.tagName === "section")!; // the heading section
      const inHead = (field: string): number => [...head.walk()].filter((el) => el.getAttribute("data-o") === field).length;
      for (const field of ["status", "symbol", "kind", "privacy", "storage", "decimals"]) {
        expect(inHead(field), `${name}: ${field} in the heading`).toBe(1);
        expect(marks.get(field)?.length, `${name}: ${field} drawn twice (heading, facts)`).toBe(2);
      }
      expect(inHead(f.token.status === "seen" ? "color" : "name"), `${name}: the heading's name`).toBe(1);
      const fam = drawn.model.facts.find((i: Json) => i.field === "family");
      if (fam) {
        expect(inHead("family"), `${name}: the family badge is its own value`).toBe(1);
        expect(fam.origin.kind).toBe("derived");
        expect(fam.origin.links.map((l: Json) => l.href)).toEqual([`#/contract/${f.token.address}`]);
      }
    }
    expect(drawToken(page, tokenFixture("lsunpi")).model.facts.find((i: Json) => i.field === "family").value).toBe("ledger");

    // ── US6 scenario 1's half that exists before 03-A (SNEB18 = SNEBDU's MIP-0018 twin) ───────
    const sneb = drawToken(page, tokenFixture("sneb18"));
    const name = sneb.model.facts.find((i: Json) => i.field === "name");
    expect(name.origin.label).toBe("MIP-0018 declaration");
    expect(name.origin.detail).toMatch(/tx 591d1c45…94bb2c · block 221 · position 0 · segment 23651 · 1 part · guaranteed · event 97/);
    expect(name.origin.links[0].href).toBe("#/tx/591d1c459115e158dd2448b04ab3f374f854e807741701c42a758f3bc894bb2c");
    const meta = sneb.model.metadata;
    expect(meta.origin.label).toBe("MIP-0018 declaration, 3 parts");
    expect(meta.origin.detail).toContain("3 parts · guaranteed · events 105, 106, 107");

    // ── US6 scenario 2 (LSUNPI): repository from MIP-0018, the rest interface / chain / n/a ──
    const lsun = drawToken(page, tokenFixture("lsunpi"));
    const repo = lsun.model.traits.find((i: Json) => i.label === "repository");
    expect(repo.origin.label).toBe("MIP-0018 declaration");
    for (const field of ["name", "symbol"]) {
      expect(lsun.model.facts.find((i: Json) => i.field === field).origin.label).toBe("Not available (no declaration)");
    }
    expect(lsun.model.iface.origin.label).toBe("Public interface, failed at L1");

    // ── US6 scenario 3's rule (LMOON18 = LMOONDU's twin): the 2-part description after a Null ─
    const lmoon = drawToken(page, tokenFixture("lmoon18"));
    const desc = lmoon.model.traits.find((i: Json) => i.label === "description");
    expect(desc.origin.label).toBe("MIP-0018 declaration, 2 parts");
    expect(desc.origin.p1).toBe(true);
    expect(desc.origin.detail).toContain("P1: last write, positioned by the first part");
    expect(desc.history.map((h: Json) => [h.eventId, h.value])).toEqual([
      [80, "Null (the key was cleared)"],
      [78, "A ledger token that renamed itself in a later block."],
    ]);
    expect(desc.history.every((h: Json) => h.origin.label === "MIP-0018 declaration")).toBe(true);
    // …and the P1 mark is drawn beside it, with the rule on hover.
    const descRow = [...lmoon.root.walk()].find((el) => el.getAttribute("data-o") === desc.field)!;
    expect([...descRow.walk()].some((el) => el.className === "p1" && el.title.startsWith("P1 (spec 00024 §9.2)"))).toBe(true);
    expect(lmoon.model.facts.find((i: Json) => i.field === "name").origin.p1).toBe(true); // renamed once

    // ── every status of the API, current and historical, on the contract view ─────────────────
    const up = tokenFixture("uprompi");
    const base = up.interface;
    const upTokenIds = drawToken(page, up).ids; // where the contract's token row links to
    const statusesDrawn = new Set<string>();
    INTERFACE_STATUSES.forEach((s, i) => {
      const current = publicationAs(base, s, "current", 9_000 + i);
      current.files = s === "verified" || s === "stale" ? base.files : [];
      current.keys = s === "verified" || s === "stale" ? base.keys : [];
      current.circuits = s === "verified" || s === "stale" ? base.circuits : [];
      current.witnesses = base.witnesses;
      current.checkHistory = [{ checkNo: 1, checkedAt: base.checkedAt, trigger: "initial", status: s, level: current.level,
        levels: current.levels, l3Reason: null, reason: current.reason, stateBlockHeight: 714 }];
      current.history = INTERFACE_STATUSES.map((h, j) => publicationAs(base, h, "historical", 8_000 + j));
      const drawn = drawContract(page, contractState(up, current));
      const where: Where = { tokenIds: upTokenIds, contractIds: drawn.ids, address: up.token.address };
      const src = contractSources(up.contract, current, up.events.items); callSources(src, up.calls);
      expect(checkModel(page, drawn.model.all, where, knownOf(up), src), `status ${s}: model`).toEqual([]);
      expect(checkDrawn(drawn.root, drawn.model.all), `status ${s}: drawn`).toEqual([]);
      expect(checkPayloadShown(drawn.root, contractState(up, current)), `status ${s}: payload`).toEqual([]);
      note(drawn.model.all);
      // the badge: a known class and a word that says it
      const badges = [...drawn.root.walk()].filter((el) => el.className.startsWith("badge ifb "));
      expect(badges.length).toBeGreaterThan(INTERFACE_STATUSES.length);
      for (const b of badges) {
        expect(b.className, `a ${b.textContent} badge must be a status the page knows`).not.toContain("if-unknown");
        statusesDrawn.add(b.textContent.split(" ")[0]!);
      }
      expect(drawn.model.face.status.text).toBe(s === "verified" ? "verified L1/L2/L3" : s === "failed" ? "failed at L2"
        : s === "stale" ? "stale (was L1/L2/L3)" : s);
      // both roles, each publication with its own result; the role itself is a P2 choice of this
      // indexer, labelled "Derived by this indexer" (E1a-F9), linking the interface section
      const roleRow = drawn.model.face.rows.find((r: Json) => r.field === "iface:role");
      expect(roleRow.value).toBe("current");
      expect(roleRow.origin.kind).toBe("derived");
      expect(roleRow.origin.rule).toMatch(/^P2 \(spec 00024 §9\.2\)/);
      expect(roleRow.origin.links[0].href).toBe(`#/contract/${up.token.address}/interface`);
      expect(drawn.model.face.roles.map((r: Json) => [r.value, r.origin.kind])).toEqual(INTERFACE_STATUSES.map(() => ["historical", "derived"]));
      expect(drawn.model.face.history.map((h: Json) => h.row.role)).toEqual(INTERFACE_STATUSES.map(() => "historical"));
      expect(drawn.model.face.history.map((h: Json) => h.status.status)).toEqual([...INTERFACE_STATUSES]);
    });
    expect([...statusesDrawn].sort()).toEqual([...INTERFACE_STATUSES].sort());

    // ── E1a-F6: past the API's 100 older publications and 100 checks, the section says so ──────
    {
      const many = publicationAs(base, "verified", "current", 9_500);
      many.files = base.files; many.keys = base.keys; many.circuits = base.circuits; many.witnesses = base.witnesses;
      many.history = Array.from({ length: 100 }, (_, j) => publicationAs(base, "failed", "historical", 7_000 + j));
      many.publications = 102;
      many.checks = 250;
      many.checkHistory = [{ checkNo: 250, checkedAt: base.checkedAt, trigger: "recheck", status: "verified", level: 3,
        levels: LEVELS.verified, l3Reason: null, reason: null, stateBlockHeight: 714 }];
      const drawn = drawContract(page, contractState(up, many));
      expect(checkModel(page, drawn.model.all, { tokenIds: upTokenIds, contractIds: drawn.ids, address: up.token.address }, knownOf(up),
        contractSources(up.contract, many))).toEqual([]);
      expect(checkDrawn(drawn.root, drawn.model.all)).toEqual([]);
      expect(checkPayloadShown(drawn.root, contractState(up, many))).toEqual([]);
      const sec = [...drawn.root.walk()].find((el) => el.id === "interface")!;
      expect(sec.textContent).toContain("the newest 100 of 101 older publications are shown — all of them: every publication (API, paginated)");
      expect(sec.textContent).toContain("the newest 1 of 250 checks are shown");
      const all = [...sec.walk()].find((el) => el.tagName === "a" && el.textContent === "every publication (API, paginated)")!;
      expect(all.href).toBe(`/v1/contracts/${up.token.address}/interface/events?limit=500`);
      // …and says nothing when every one is shown
      const one = drawContract(page, contractState(up, base));
      expect([...one.root.walk()].find((el) => el.id === "interface")!.textContent).not.toContain("the newest");
    }

    // ── the list: every status in the interface column; the MIP-0018 part badges ──────────────
    const list = read("tokens.json").items as Json[];
    const lsunRow = list.find((t) => t.address === tokenFixture("lsunpi").token.address);
    page.ctx.state.list = { items: [], nextCursor: null, loaded: true };
    for (const s of INTERFACE_STATUSES) {
      const row = clone(lsunRow);
      row.interface.status = s; row.interface.levels = clone(LEVELS[s]);
      const cellView = page.ctx.listInterfaceView(row);
      expect(cellView.known, `list: ${s}`).toBe(true);
      expect(cellView.cls).not.toBe("if-unknown");
      const drawnCell: FakeElement = page.ctx.listIfaceCell(row);
      expect(drawnCell.textContent.startsWith(s === "failed" ? "failed at L2" : s)).toBe(true);
    }
    // no interface part badge in the list (E1a-F4, Q30): the part count is on the contract view
    const upRow = list.find((t) => t.address === up.token.address);
    expect(page.ctx.listIfaceCell(upRow).textContent).toBe("verified L1/L2/L3");
    const snebRow = list.find((t) => t.symbol === "SNEB18");
    expect(JSON.parse(JSON.stringify(page.ctx.multipartOf(snebRow)))).toEqual([{ field: "metadata", parts: 3, phase: "guaranteed" }]);
    expect(page.ctx.mipCell(snebRow).textContent).toBe("✅3 parts");

    // ── a 262 112-byte URL: shortened for the eye, copied whole; a bounded diagnostic as served ─
    const huge = clone(base);
    huge.url = MAX_URL; huge.parts = 1024; huge.partEventIds = Array.from({ length: 1024 }, (_, i) => 20_000 + i);
    huge.origin.evidence.parts = 1024; huge.origin.evidence.partEventIds = huge.partEventIds;
    huge.status = "failed"; huge.levels = clone(LEVELS.failed); huge.failedLevel = 2; huge.reason = BOUNDED_REASON;
    huge.origin.evidence.status = "failed"; huge.origin.evidence.levels = clone(LEVELS.failed);
    const hugeDrawn = drawContract(page, contractState(up, huge));
    expect(checkModel(page, hugeDrawn.model.all, { tokenIds: upTokenIds, contractIds: hugeDrawn.ids, address: up.token.address }, knownOf(up),
      contractSources(up.contract, huge))).toEqual([]);
    expect(checkDrawn(hugeDrawn.root, hugeDrawn.model.all)).toEqual([]);
    const urlRow = [...hugeDrawn.root.walk()].find((el) => el.getAttribute("data-o") === "iface:url")!;
    const urlLink = [...urlRow.walk()].find((el) => el.tagName === "a" && el.href === MAX_URL)!;
    expect(MAX_URL.length).toBe(MAX_URL_BYTES);
    expect(urlLink.textContent.length).toBeLessThanOrEqual(101);            // head … tail
    expect(urlLink.textContent.endsWith("/index.json")).toBe(true);
    expect(urlRow.textContent).toContain("(262 112 characters)");      // grouped with U+00A0
    expect(urlLink.title).not.toContain(MAX_URL);                           // no 262 KB tooltip
    const copy = [...urlRow.walk()].find((el) => el.className.includes("cpbtn"))!;
    expect(copy.title).toBe(`copy the whole URL (${MAX_URL_BYTES} characters)`);
    // …and the copy control really copies the whole URL (its listener runs, E1a-F15)
    copy.click();
    await page.settle();
    expect(page.copied.at(-1)).toBe(MAX_URL);
    // the evidence line names 1 024 parts without listing 1 024 ids
    const hugeOrigin = hugeDrawn.model.face.rows[0].origin;
    expect(hugeOrigin.detail).toContain("1024 parts");
    expect(hugeOrigin.detail).toContain("events 20000, 20001, 20002, … 21023 (1024 ids)");
    // the diagnostic exactly as served, marker included, in a wrapping cell
    // at most 2 000 characters, the marker included (the indexer's own rule: the marker's digit
    // count can shrink once the cut is made, so a bounded text may end one character short)
    expect(BOUNDED_REASON.length).toBeLessThanOrEqual(DIAGNOSTIC_CHARS);
    expect(BOUNDED_REASON.length).toBeGreaterThan(DIAGNOSTIC_CHARS - 5);
    const failure = [...hugeDrawn.root.walk()].find((el) => el.getAttribute("data-o") === "iface:failure")!;
    const diag = [...failure.walk()].find((el) => el.className.includes("diag"))!;
    expect(diag.textContent).toBe(`L2: ${BOUNDED_REASON}`);
    expect(diag.textContent).toMatch(/… \[\d+ characters omitted\]$/);

    // ── the recorded outcomes of 02-D's seven fixture instances, each on its contract view ─────
    const outcomes = read("interface-outcomes.json");
    for (const label of Object.keys(outcomes).filter((k) => !k.endsWith(".contract"))) {
      const c = outcomes[`${label}.contract`];
      const drawn = drawContract(page, contractState({ contract: c }, outcomes[label]));
      const where: Where = { tokenIds: new Set(), contractIds: drawn.ids, address: c.address };
      expect(checkModel(page, drawn.model.all, where, knownOf(c, outcomes[label]), contractSources(c, outcomes[label])), `outcome ${label}`).toEqual([]);
      expect(checkDrawn(drawn.root, drawn.model.all), `outcome ${label} drawn`).toEqual([]);
      expect(checkPayloadShown(drawn.root, contractState({ contract: c }, outcomes[label])), `outcome ${label} payload`).toEqual([]);
      note(drawn.model.all);
    }
    // E1a-F11: `unchecked` after L1 passed (state unavailable, a Level 2 limit) says what passed
    {
      const partly = publicationAs(base, "unchecked", "current", 9_700);
      partly.levels = { l1: "passed", l2: "not_run", l3: "not_run" }; partly.level = 1;
      partly.reason = "Level 2: the contract state is unavailable (timeout); Level 2 was not run";
      partly.origin.evidence.levels = clone(partly.levels);
      const drawn = drawContract(page, contractState(up, partly));
      expect(drawn.model.face.status.text).toBe("unchecked (L1 passed)");
      expect(drawn.model.face.status.help).not.toContain("no level is claimed");
      expect(drawn.model.face.status.help).toContain("only the levels shown passed");
      expect(drawn.model.face.rows[0].origin.label).toBe("Public interface, unchecked (L1 passed)");
      expect(checkDrawn(drawn.root, drawn.model.all)).toEqual([]);
      expect(page.ctx.interfaceStatusView({ status: "unchecked", levels: LEVELS.unchecked }).text).toBe("unchecked");
    }

    // E1a-F12: a circuit summary the indexer cut short says so
    {
      const cut = clone(base);
      cut.report = { levels: { l2: { status: "passed", circuitsTruncated: true } } };
      const drawn = drawContract(page, contractState(up, cut));
      expect(drawn.model.face.circuitsTruncated).toBe(true);
      expect([...drawn.root.walk()].find((el) => el.id === "interface")!.textContent)
        .toContain(`the interface lists more named circuits than the indexer summarises: the first ${base.circuits.length} are shown`);
      const whole = drawContract(page, contractState(up, base));
      expect([...whole.root.walk()].find((el) => el.id === "interface")!.textContent).not.toContain("more named circuits");
    }

    // E1a-F10: a failed interface read (503) is not "none published"
    {
      const routes = apiRoutes(up);
      routes.set(`/v1/contracts/${up.token.address}/interface`, new Reply(503, { error: { code: "UNAVAILABLE" } }));
      const live = loadPage(SERVED_SCRIPT, routes);
      live.window.location.hash = `#/contract/${up.token.address}`;
      live.boot();
      await live.settle();
      const sec = live.doc.getElementById("interface")!;
      expect(sec.textContent).toContain("the public interface could not be read");
      expect(sec.textContent).not.toContain("no public interface published");
      expect(live.doc.getElementById("view")!.textContent).toContain("public interface unavailable: 503 UNAVAILABLE");
      const unavailable = live.ctx.contractModel(live.ctx.state.contract).face.rows[0].origin;
      expect(unavailable.label).toBe("Not available (the interface could not be read: see partial data)");
    }
    // a contract that published none: "Not available" with its reason, drawn
    const none = drawContract(page, contractState(tokenFixture("sneb18"), null));
    expect(none.model.face.rows[0].origin.label).toBe("Not available (this contract has published no public interface)");
    expect(checkDrawn(none.root, none.model.all)).toEqual([]);

    // ── every origin kind met at least once ───────────────────────────────────────────────────
    expect([...kindsSeen].sort()).toEqual(["chain", "derived", "mip-0018", "none", "public-interface"]);

    // ── the page as a browser runs it (E1a-F15): boot on a deep link, follow an evidence link ─
    const live = loadPage(SERVED_SCRIPT, apiRoutes(up));
    live.window.location.hash = `#/contract/${up.token.address}/interface`;
    live.boot();
    await live.settle();
    expect(live.ctx.state.route.view).toBe("contract");
    expect(live.requests).toContain(`/v1/contracts/${up.token.address}/interface`);
    const section = live.doc.getElementById("interface");
    expect(section, "the interface section is drawn in the document").not.toBeNull();
    expect(section!.scrolled, "boot on #/contract/…/interface scrolls to the section").toBeGreaterThan(0);
    // follow a value's evidence link from the token view: it navigates and lands on its section
    live.navigate(`#/token/${up.token.address}/${up.token.domainSep}/${up.token.kind}`);
    await live.settle();
    const tokenView = live.doc.getElementById("view")!;
    const ifaceChip = [...tokenView.walk()].find((el) => el.getAttribute("data-o") === "interface")!;
    const ifaceLink = [...ifaceChip.walk()].find((el) => el.tagName === "a" && el.className.includes("orig"))!;
    expect(ifaceLink.href).toBe(`#/contract/${up.token.address}/interface`);
    // the click itself follows the link (its default action), and stays on the chip (a row's own
    // click handler does not run) — nothing is navigated by hand (E1a-R2G)
    const clicked = ifaceLink.click();
    expect(clicked.stopped, "a chip's click stays on the chip").toBe(true);
    expect(clicked.defaultPrevented, "a chip's click follows its link").toBe(false);
    expect(live.window.location.hash).toBe(`#/contract/${up.token.address}/interface`);
    await live.settle();
    // the same evidence link again: no fragment change, no hashchange — the page scrolls itself (R3K)
    const sec2 = live.doc.getElementById("interface")!;
    const before = sec2.scrolled;
    const again = [...live.doc.getElementById("view")!.walk()].find((el) => el.tagName === "a" && el.className.includes("orig")
      && el.href === `#/contract/${up.token.address}/interface`)!;
    again.click();
    expect(live.doc.getElementById("interface")!.scrolled, "the same link scrolls again").toBe(before + 1);
    expect(live.ctx.state.route.view).toBe("contract");
    expect(live.doc.getElementById("interface")!.scrolled).toBeGreaterThan(0);
  });

  // ── negative controls: the same checks on a page that breaks the rule must FAIL ─────────────

  const snebChecks = (script: string): { model: string[]; drawn: string[] } => {
    const page = loadPage(script);
    const f = tokenFixture("sneb18");
    const contract = drawContract(page, contractState(f, null));
    const token = drawToken(page, f);
    const where: Where = { tokenIds: token.ids, contractIds: contract.ids, address: f.token.address };
    return { model: checkModel(page, token.model.all, where, knownOf(f), tokenSources(f)), drawn: checkDrawn(token.root, token.model.all) };
  };

  it("negative control: a value shown without an origin fails the check", () => {
    const broken = SERVED_SCRIPT.replace(
      'facts.push(item("symbol", "symbol", t.symbol, o.symbol,',
      'facts.push(item("symbol", "symbol", t.symbol, null,',
    );
    expect(broken).not.toBe(SERVED_SCRIPT);
    expect(snebChecks(broken).model).toContain("symbol: shown without an origin (Origin not given)");
  });

  it("negative control: a value drawn without its origin chip fails the check", () => {
    const broken = SERVED_SCRIPT.replace('cell(tr, originBlock(it.origin), "ocell");', 'cell(tr, "-", "ocell");');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const violations = snebChecks(broken).drawn;
    expect(violations.some((v) => /^symbol: drawn \(occurrence \d of \d\) without its origin "MIP-0018 declaration"/.test(v))).toBe(true);
    expect(violations.some((v) => v.startsWith('address: drawn (occurrence 1 of 1) without its origin "Chain observation"'))).toBe(true);
  });

  it("negative control: an evidence link that does not resolve fails the check", () => {
    const broken = SERVED_SCRIPT.replace('return { href: hashTx(h), text:', 'return { href: hashTx(h.slice(2)), text:');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const violations = snebChecks(broken).model;
    expect(violations.some((v) => v.startsWith("name: the link #/tx/") && v.endsWith("a transaction the payloads do not name"))).toBe(true);
  });

  it("negative control (E1a-F15): a link to ANOTHER transaction the payloads name fails the check", () => {
    // decimals cites the name's declaration: a known transaction, but not the one that declared the
    // decimals (the round-1 check accepted it: every link resolved to a transaction the payloads name)
    const broken = SERVED_SCRIPT.replace('facts.push(item("decimals", "decimals", t.decimals, o.decimals,',
      'facts.push(item("decimals", "decimals", t.decimals, o.name,');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const violations = snebChecks(broken).model;
    expect(violations.some((v) => v.startsWith("decimals: evidence links #/tx/591d1c45") && v.includes("but its evidence is #/tx/"))).toBe(true);
  });

  it("negative control (E1a-R3C): a drawn evidence line whose second link differs from the model fails the check", () => {
    const broken = SERVED_SCRIPT.replace("    evidenceHref(a, ov.links[i].href);", "    evidenceHref(a, ov.links[0].href);");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const up = tokenFixture("uprompi");
    const drawn = drawContract(page, contractState(up, up.interface));
    expect(checkDrawn(drawn.root, drawn.model.all).some((v) => v.startsWith("iface:status: its evidence line links"))).toBe(true);
  });

  it("negative control (E1a-R3C): a derived section link to another token's route fails the check", () => {
    const zero = `#/color/${"0".repeat(64)}/1`;
    const broken = SERVED_SCRIPT.replace('      if (dl) { dl.text = "input: the declarations"; v.links.push(dl); }',
      `      if (dl) { dl.text = "input: the declarations"; dl.href = "${zero}/traits"; v.links.push(dl); }`);
    expect(broken).not.toBe(SERVED_SCRIPT);
    const v0 = snebChecks(broken).model;
    expect(v0.some((v) => v.startsWith("status: evidence links") && v.includes("#/color/0000000000")), JSON.stringify(v0).slice(0, 600)).toBe(true);
  });

  it("negative control (E1a-R2F): a SECOND evidence link to another known transaction fails the check", () => {
    const up = tokenFixture("uprompi");
    // the interface section stays the first link; the publication link cites the contract's deploy
    const broken = SERVED_SCRIPT.replace('var pl = txEvidence(e.txHash, "publication tx");',
      `var pl = txEvidence("${up.contract.deployTxHash}", "publication tx");`);
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const drawn = drawContract(page, contractState(up, up.interface));
    const where: Where = { tokenIds: new Set(["mints", "traits", "events", "activity", "metadata", "facts"]), contractIds: drawn.ids, address: up.token.address };
    const violations = checkModel(page, drawn.model.all, where, knownOf(up), contractSources(up.contract, up.interface, up.events.items));
    expect(violations.some((v) => v.startsWith(`iface:status: evidence links #/contract/${up.token.address}/interface #/tx/${up.contract.deployTxHash}`))).toBe(true);
    expect(violations.some((v) => v.includes("resolves to"))).toBe(false); // every link still resolves: only the new check sees it
  });

  it("negative control (E1a-F15): a value drawn with its chip in one place but not in another fails the check", () => {
    // the heading draws the name without its chip; the facts table still draws it with one
    const broken = SERVED_SCRIPT.replace("  v.appendChild(originChip(which.origin));\n", "");
    expect(broken).not.toBe(SERVED_SCRIPT);
    expect(snebChecks(broken).drawn.some((v) => v.startsWith('name: drawn (occurrence 1 of 2) without its origin'))).toBe(true);
  });

  it("negative control (E1a-R2E): a heading drawn without its mark AND its chip fails the check", () => {
    const broken = SERVED_SCRIPT.replace('  var v = marked(node("span", null, "vo"), which.field);', '  var v = node("span", null, "vo");')
      .replace("  v.appendChild(originChip(which.origin));\n", "");
    expect(broken).not.toBe(SERVED_SCRIPT);
    expect(snebChecks(broken).drawn.some((v) => v.startsWith('name: its value "') && v.endsWith("is drawn outside any marked element"))).toBe(true);
  });

  it("negative control (E1a-R3B): a formatted heading value without its mark and chip fails the check", () => {
    // "(shielded)" and "decimals 0": neither is an exact value string, so only the payload check and
    // the heading's own count can see them
    const broken = SERVED_SCRIPT.replace('  part("privacy", "(" + (t.privacy ? txt(t.privacy) : "?") + ")");',
      '  wrap.appendChild(node("span", "(" + (t.privacy ? txt(t.privacy) : "?") + ")"));');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const drawn = drawToken(page, tokenFixture("sneb18"));
    expect(checkPayloadShown(drawn.root, tokenDetail(tokenFixture("sneb18")))).toContain('"(shielded)": a value drawn outside any marked element');
    expect(marksOf(drawn.root).get("privacy")?.length).toBe(1);
  });

  it("negative control (E1a-R3B): the family badge under the name's origin fails the check", () => {
    const broken = SERVED_SCRIPT.replace('    var f = marked(node("span", null, "vo"), "family");', '    var f = node("span", null, "vo");')
      .replace("    f.appendChild(originChip(fam.origin));\n", "");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const f = tokenFixture("lsunpi");
    const drawn = drawToken(page, f);
    expect(marksOf(drawn.root).get("family")?.length).toBe(1); // the facts row only: the heading's is unmarked
  });

  it("negative control (E1a-R2E): the header's status drawn without its origin fails the check", () => {
    const broken = SERVED_SCRIPT.replace('var st = marked(node("span", null, "vo"), "status");', 'var st = node("span", null, "vo");')
      .replace('st.appendChild(originChip(factOf(m, "status").origin));', "");
    expect(broken).not.toBe(SERVED_SCRIPT);
    expect(snebChecks(broken).drawn).toContain('status: its value "described" is drawn outside any marked element');
  });

  it("negative control (E1a-F15): a value cell drawn outside any marked element fails the check", () => {
    // an extra table with the deploy transaction, drawn with no origin and no mark
    const broken = SERVED_SCRIPT.replace('main.appendChild(interfaceSection(m.face));',
      'main.appendChild(interfaceSection(m.face)); var xtb = tableIn(main, ["deploy tx"]); var xtr = document.createElement("tr"); cell(xtr, txLink(d.deployTxHash)); xtb.appendChild(xtr);');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const f = tokenFixture("sneb18");
    const drawn = drawContract(page, contractState(f, null));
    expect(checkDrawn(drawn.root, drawn.model.all).some((v) => v.startsWith("a value cell drawn outside any marked element"))).toBe(true);
  });

  it("negative control (E1a-F15): a copy control that does not copy fails the check", async () => {
    const broken = SERVED_SCRIPT.replace('s.addEventListener("click", function (ev) { ev.stopPropagation(); copyValue(txt(value), s); });',
      's.addEventListener("click", function (ev) { ev.stopPropagation(); });');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const up = tokenFixture("uprompi");
    const drawn = drawContract(page, contractState(up, up.interface));
    const urlRow = [...drawn.root.walk()].find((el) => el.getAttribute("data-o") === "iface:url")!;
    [...urlRow.walk()].find((el) => el.className.includes("cpbtn"))!.click();
    await page.settle();
    expect(page.copied).toEqual([]);
  });

  it("negative control (E1a-R2G): a chip whose click prevents navigation fails the check", async () => {
    const broken = SERVED_SCRIPT.replace("  return function (ev) {\n    ev.stopPropagation();",
      "  return function (ev) {\n    ev.preventDefault(); ev.stopPropagation();");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const up = tokenFixture("uprompi");
    const live = loadPage(broken, apiRoutes(up));
    live.window.location.hash = `#/token/${up.token.address}/${up.token.domainSep}/${up.token.kind}`;
    live.boot();
    await live.settle();
    const chip = [...live.doc.getElementById("view")!.walk()].find((el) => el.getAttribute("data-o") === "interface")!;
    const link = [...chip.walk()].find((el) => el.tagName === "a" && el.className.includes("orig"))!;
    expect(link.click().defaultPrevented).toBe(true);
    await live.settle();
    expect(live.ctx.state.route.view).toBe("token");
  });

  it("negative control (E1a-R3K): following the same evidence link again does not scroll without the page's own scroll", async () => {
    const broken = SERVED_SCRIPT.replace("    if (target && target.scrollIntoView) target.scrollIntoView();\n  };", "  };");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const up = tokenFixture("uprompi");
    const live = loadPage(broken, apiRoutes(up));
    live.window.location.hash = `#/contract/${up.token.address}/interface`;
    live.boot();
    await live.settle();
    const sec = live.doc.getElementById("interface")!;
    const before = sec.scrolled;
    [...live.doc.getElementById("view")!.walk()].find((el) => el.tagName === "a" && el.className.includes("orig")
      && el.href === `#/contract/${up.token.address}/interface`)!.click();
    expect(sec.scrolled).toBe(before);
  });

  it("negative control (E1a-F15): a page that does not scroll to the section fails the check", async () => {
    const broken = SERVED_SCRIPT.replace("if (target.scrollIntoView) target.scrollIntoView();", "");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const up = tokenFixture("uprompi");
    const live = loadPage(broken, apiRoutes(up));
    live.window.location.hash = `#/contract/${up.token.address}/interface`;
    live.boot();
    await live.settle();
    expect(live.doc.getElementById("interface")!.scrolled).toBe(0);
  });

  it("negative control (E1a-F7): a derived value that does not link its inputs fails the check", () => {
    const broken = SERVED_SCRIPT.replace("    if (din.address && isHex(txt(din.address))) {", "    if (false) {")
      .replace('    if (own(din, "mintCount") && c.token) {', "    if (false) {")
      .replace('    if (own(din, "declared") && c.token) {', "    if (false) {");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const violations = snebChecks(broken).model;
    expect(violations).toContain("color: derived from 2 inputs without a link to them");
    expect(violations).toContain("status: derived from 2 inputs without a link to them");
  });

  it("negative control (E1a-F12): a cut circuit summary drawn as whole fails the check", () => {
    const broken = SERVED_SCRIPT.replace("    circuitsTruncated: circuitsTruncated,", "    circuitsTruncated: false,");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const up = tokenFixture("uprompi");
    const cut = clone(up.interface);
    cut.report = { levels: { l2: { status: "passed", circuitsTruncated: true } } };
    const drawn = drawContract(page, contractState(up, cut));
    expect([...drawn.root.walk()].find((el) => el.id === "interface")!.textContent).not.toContain("more named circuits");
  });

  it("negative control (E1a-F11): an unchecked badge that denies the level it passed fails the check", () => {
    const broken = SERVED_SCRIPT.replace('  else if (status === "unchecked" && passed !== "") text = "unchecked (" + passed + " passed)";', "");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    expect(page.ctx.interfaceStatusView({ status: "unchecked", levels: { l1: "passed", l2: "not_run", l3: "not_run" } }).text).toBe("unchecked");
  });

  it("negative control (E1a-F10): a failed read drawn as none published fails the check", async () => {
    const broken = SERVED_SCRIPT.replace("none.appendChild(node(\"span\", face.unavailable", "none.appendChild(node(\"span\", false");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const up = tokenFixture("uprompi");
    const routes = apiRoutes(up);
    routes.set(`/v1/contracts/${up.token.address}/interface`, new Reply(503, { error: { code: "UNAVAILABLE" } }));
    const live = loadPage(broken, routes);
    live.window.location.hash = `#/contract/${up.token.address}`;
    live.boot();
    await live.settle();
    expect(live.doc.getElementById("interface")!.textContent).toContain("no public interface published");
  });

  it("negative control (E1a-F9): a role labelled with the publication's origin fails the check", () => {
    const broken = SERVED_SCRIPT.replace('row("role", "role", x.role, { help: ROLE_HELP[x.role] || null }, roleOrigin(x));',
      'row("role", "role", x.role, { help: ROLE_HELP[x.role] || null });');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const up = tokenFixture("uprompi");
    const drawn = drawContract(page, contractState(up, up.interface));
    expect(drawn.model.face.rows.find((r: Json) => r.field === "iface:role").origin.kind).toBe("public-interface");
  });

  it("negative control (E1a-R3A): a built-in row's seeded values without the seed as evidence fail the check", () => {
    const broken = SERVED_SCRIPT.replace("    if (v.links.length === 0 && c.seed) v.links.push(SEED_EVIDENCE);", "");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const dust = (read("tokens.json").items as Json[]).find((r) => r.status === "builtin" && !r.color)!;
    const drawn = drawRow(page, dust);
    const v = checkModel(page, drawn.model.all, { tokenIds: drawn.ids, contractIds: new Set(), address: null }, knownOf(dust));
    expect(v).toContain("visibility: derived without an evidence link");
    expect(v).toContain("address: derived without an evidence link");
  });

  it("negative control (E1a-R2A): a derived value that links nothing fails the check", () => {
    const broken = SERVED_SCRIPT.replace('    var dt = txEvidence(din.txHash, "input: tx");', '    var dt = null;')
      .replace('{ token: t, section: vis === "calls-only" ? (t.address ? "calls" : null) : (vis === "not-tracked" ? null : "activity") }));', "{ token: t }));");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const lm = tokenFixture("lmoon18");
    const stuck = clone(lm.contract);
    stuck.pendingLookups = [{ txHash: lm.contract.deployTxHash, address: stuck.address, expected: 3, got: 1, attempts: 2, lastError: null }];
    const pend = drawContract(page, contractState({ contract: stuck, events: lm.events }, null));
    const token = drawToken(page, lm);
    const where: Where = { tokenIds: token.ids, contractIds: pend.ids, address: stuck.address };
    expect(checkModel(page, pend.model.all, where, knownOf(lm, stuck))).toContain(`pending:${lm.contract.deployTxHash}: derived without an evidence link`);
    expect(checkModel(page, token.model.all, where, knownOf(lm))).toContain("visibility: derived without an evidence link");
  });

  it("negative control (E1a-R2I): first seen cited by status, not by its observation, fails the check", () => {
    const broken = SERVED_SCRIPT.replace("    { token: t, section: firstSeenSection(t, events) }));", "    idCtx));");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const f = clone(tokenFixture("sneb18"));
    const firstDecl = Math.min(...f.events.items.filter((e: Json) => e.domainSep === f.token.domainSep).map((e: Json) => Number(e.blockHeight)));
    f.token.firstMintHeight = firstDecl - 50; f.token.firstSeenHeight = firstDecl - 50;
    expect(drawToken(page, f).model.facts.find((i: Json) => i.field === "firstSeenHeight").origin.links[0].href).toMatch(/\/events$/);
  });

  it("negative control (E1a-F8): identity evidence that always cites the declarations fails for a minted-only token", () => {
    const broken = SERVED_SCRIPT.replace('  return t.status === "observed" ? "mints" : "events";', '  return "events";');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const row = (read("tokens.json").items as Json[]).find((r) => r.status === "observed")!;
    expect(drawRow(page, row).model.facts.find((i: Json) => i.field === "domainSep").origin.links[0].href).toMatch(/\/events$/);
  });

  it("negative control (E1a-F6): a capped history drawn as if complete fails the check", () => {
    const broken = SERVED_SCRIPT.replace("historyMore: olderTotal > hl.length ? olderTotal : null,", "historyMore: null,");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const up = tokenFixture("uprompi");
    const many = publicationAs(up.interface, "verified", "current", 9_500);
    many.history = Array.from({ length: 100 }, (_, j) => publicationAs(up.interface, "failed", "historical", 7_000 + j));
    many.publications = 102;
    const drawn = drawContract(page, contractState(up, many));
    expect([...drawn.root.walk()].find((el) => el.id === "interface")!.textContent).not.toContain("older publications are shown");
  });

  it("negative control (E1a-F2): one page of events loses the history past it", async () => {
    const broken = SERVED_SCRIPT.replace("loadPages(function (c) { return contractEventsPath(r.address, c); }, EVENT_PAGES)",
      "loadPages(function (c) { return contractEventsPath(r.address, c); }, 1)");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const { f, routes } = lmoonBehindFillers(1);
    const live = await bootToken(f, routes, broken);
    const d2 = live.ctx.tokenModel(live.ctx.state.detail).traits.find((i: Json) => i.label === "description");
    expect(d2.history).toEqual([]);
    expect(d2.origin.p1).toBe(false);
  });

  it("negative control: a status the page does not render fails the check", () => {
    const broken = SERVED_SCRIPT.replace('"stale": { cls: "if-wait",', '"stale-renamed": { cls: "if-wait",');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const up = tokenFixture("uprompi");
    const stale = publicationAs(up.interface, "stale", "current", 9_999);
    const drawn = drawContract(page, contractState(up, stale));
    const badges = [...drawn.root.walk()].filter((el) => el.className.startsWith("badge ifb "));
    expect(badges.some((b) => b.className.includes("if-unknown"))).toBe(true);
    expect(page.ctx.interfaceStatusView({ status: "stale", levels: LEVELS.stale }).known).toBe(false);
  });

  it("the page knows exactly the API's publication statuses", () => {
    const page = loadPage();
    expect(Object.keys(page.ctx.INTERFACE_STATUS).sort()).toEqual([...INTERFACE_STATUSES].sort());
    expect(Object.keys(page.ctx.ORIGIN_LABELS).sort()).toEqual(["chain", "derived", "mip-0018", "none", "public-interface"]);
  });
});
