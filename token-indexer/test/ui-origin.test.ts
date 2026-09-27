import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { INTERFACE_STATUSES } from "../api/queries.js";
import { DASHBOARD_HTML } from "../ui/page.js";

/**
 * `[[token-ui-origin]]` — spec 00024 US6 / FR-016 (sub-plan 00024-03, Phase 03-B): on the token and
 * contract views, every value the page shows carries its origin — "MIP-0018 declaration", "Public
 * interface", "Chain observation", "Derived by this indexer" or "Not available" — and the link to
 * its evidence resolves.
 *
 * No browser and no DOM library (plan 03-B item 6): the page's behaviour lives in ONE inline script,
 * and this test evaluates exactly the string the page serves (read off `DASHBOARD_HTML`, not
 * imported from anywhere else) in a `node:vm` context, with a thirty-line document good for
 * `createElement`, `appendChild` and `textContent` — the only DOM the page uses, because it assigns
 * no markup. Two things are then checked on recorded API payloads
 * (`fixtures/ui/`, see its SOURCE.md) and on synthetic ones built from them:
 *
 *  1. the VIEW MODEL (`tokenModel`, `contractModel`): every item has a known origin with its label,
 *     and every evidence link is a route the page resolves — a transaction the payloads name, the
 *     contract, the token, or a section that the rendered view really has;
 *  2. the DRAWN VIEW (`renderToken`, `renderContract`): every item of the model is drawn, marked
 *     `data-o`, with its own chip — the label, and a link to the first piece of evidence — and
 *     nothing is marked that the model does not list.
 *
 * The fixtures cover every origin kind, every one of the API's seven publication statuses, both
 * roles (current / historical), multi-part packages (SNEB18's 3-part `metadata`, LMOON18's 2-part
 * `description` after a Null, UPROMPI's 2-part URL), a URL of the 262 112-byte maximum and a
 * diagnostic bounded by the indexer ("… [N characters omitted]"), which must be shown as served.
 */

const SERVED_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(DASHBOARD_HTML)?.[1] ?? "";
const FIXTURES = new URL("./fixtures/ui/", import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const read = (name: string): Json => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const LABELS = ["MIP-0018 declaration", "Public interface", "Chain observation", "Derived by this indexer", "Not available"];
const MAX_URL_BYTES = 262_112;

// ── a document just large enough for this page ─────────────────────────────────────────────────

class FakeElement {
  nodeType = 1;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  id = "";
  title = "";
  href = "";
  private text = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [prop: string]: any;
  constructor(public tagName: string) {}
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.children = []; this.text = String(v); }
  get firstChild(): FakeElement | null { return this.children[0] ?? null; }
  appendChild(child: FakeElement): FakeElement { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: FakeElement): FakeElement { this.children = this.children.filter((c) => c !== child); return child; }
  addEventListener(): void { /* the views are drawn, not clicked */ }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  *walk(): Generator<FakeElement> { yield this; for (const c of this.children) yield* c.walk(); }
}
class FakeDocument {
  body = new FakeElement("body");
  createElement(tag: string): FakeElement { return new FakeElement(tag.toLowerCase()); }
  getElementById(id: string): FakeElement | null {
    for (const el of this.body.walk()) if (el.id === id) return el;
    return new FakeElement("div"); // the chrome (#count, #strip …) is not part of these views
  }
}

interface Page { ctx: Json; doc: FakeDocument }
function loadPage(script = SERVED_SCRIPT): Page {
  const doc = new FakeDocument();
  const ctx = vm.createContext({
    window: {
      addEventListener() {}, location: { hash: "" }, setTimeout: () => 0, clearTimeout() {},
      setInterval: () => 0, clearInterval() {}, innerWidth: 1280, innerHeight: 800,
    },
    document: doc,
    navigator: {},
  });
  vm.runInContext(script, ctx, { filename: "served-page-script.js" });
  return { ctx, doc };
}

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

// ── the two checks ──────────────────────────────────────────────────────────────────────────────

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
  return `the route resolves to the ${String(r.view)} view`;
}

/** Check 1 — the model: a known origin, its label, its evidence, links that resolve. */
function checkModel(page: Page, items: Json[], where: Where, known: Known): string[] {
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
    if (o.kind === "none" && !o.reason) out.push(`${it.field}: not available without a reason`);
    if (o.kind === "public-interface" && where.address !== null
      && !o.links.some((l: Json) => l.href === `#/contract/${where.address}/interface`)) {
      out.push(`${it.field}: a public-interface value that does not link its interface section`);
    }
    for (const l of o.links) {
      const why = resolves(page, l.href, where, known);
      if (why !== null) out.push(`${it.field}: the link ${l.href.slice(0, 90)} resolves to ${why}`);
    }
  }
  return out;
}

/** Check 2 — the drawing: every item drawn with its own chip, nothing drawn that is not an item. */
function checkDrawn(root: FakeElement, items: Json[]): string[] {
  const out: string[] = [];
  const drawn = new Map<string, FakeElement[]>();
  for (const el of root.walk()) {
    const f = el.getAttribute("data-o");
    if (f !== null) drawn.set(f, [...(drawn.get(f) ?? []), el]);
  }
  const wanted = new Set(items.map((it) => it.field as string));
  for (const it of items) {
    const els = drawn.get(it.field);
    if (els === undefined) { out.push(`${it.field}: in the model but not drawn`); continue; }
    const first = it.origin.links[0];
    const ok = els.some((el) => [...el.walk()].some((c) =>
      c.className.split(" ").includes("orig") && c.textContent === it.origin.label
      && (first === undefined ? c.tagName === "span" : c.tagName === "a" && c.href === first.href)));
    if (!ok) out.push(`${it.field}: drawn without its origin "${it.origin.label}"`);
  }
  for (const f of drawn.keys()) if (!wanted.has(f)) out.push(`${f}: drawn but not in the model`);
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
  p.l3Reason = s === "verified" || s === "stale" ? null : null;
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

// ── the test ────────────────────────────────────────────────────────────────────────────────────

describe("the page shows the origin of every value", () => {
  /**
   * ONE test carries the id: an id reported by more than one test is an `ambiguous` gate violation
   * (check-required-tests.ts). Its negative controls are the untagged tests below.
   */
  it("[[token-ui-origin]] every value of the token and contract views has an origin label and an evidence link that resolves", () => {
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
      expect(checkModel(page, token.model.all, where, known), `${name}: token view model`).toEqual([]);
      expect(checkDrawn(token.root, token.model.all), `${name}: token view drawn`).toEqual([]);
      expect(checkModel(page, contract.model.all, where, known), `${name}: contract view model`).toEqual([]);
      expect(checkDrawn(contract.root, contract.model.all), `${name}: contract view drawn`).toEqual([]);
      note(token.model.all); note(contract.model.all);
      expect(token.model.all.length, `${name}: the token view lists its values`).toBeGreaterThan(20);
    }

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
      expect(checkModel(page, drawn.model.all, where, knownOf(up)), `status ${s}: model`).toEqual([]);
      expect(checkDrawn(drawn.root, drawn.model.all), `status ${s}: drawn`).toEqual([]);
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
      // both roles, each publication with its own result
      expect(drawn.model.face.rows.find((r: Json) => r.field === "iface:role").value).toBe("current");
      expect(drawn.model.face.history.map((h: Json) => h.row.role)).toEqual(INTERFACE_STATUSES.map(() => "historical"));
      expect(drawn.model.face.history.map((h: Json) => h.status.status)).toEqual([...INTERFACE_STATUSES]);
    });
    expect([...statusesDrawn].sort()).toEqual([...INTERFACE_STATUSES].sort());

    // ── the list: every status in the interface column, the part badges ───────────────────────
    const list = read("tokens.json").items as Json[];
    const lsunRow = list.find((t) => t.address === tokenFixture("lsunpi").token.address);
    page.ctx.state.list = { items: [], nextCursor: null, loaded: true, ifaces: {} };
    for (const s of INTERFACE_STATUSES) {
      const row = clone(lsunRow);
      row.interface.status = s; row.interface.levels = clone(LEVELS[s]);
      const cellView = page.ctx.listInterfaceView(row, {});
      expect(cellView.known, `list: ${s}`).toBe(true);
      expect(cellView.cls).not.toBe("if-unknown");
      const drawnCell: FakeElement = page.ctx.listIfaceCell(row);
      expect(drawnCell.textContent.startsWith(s === "failed" ? "failed at L2" : s)).toBe(true);
    }
    const ifaces = read("interfaces.json").items as Json[];
    const byAddress = Object.fromEntries(ifaces.map((x) => [x.address, { parts: x.parts, phase: x.phase }]));
    const upRow = list.find((t) => t.address === up.token.address);
    page.ctx.state.list.ifaces = byAddress;
    expect(page.ctx.listIfaceCell(upRow).textContent).toBe("verified L1/L2/L32 parts");
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
    expect(checkModel(page, hugeDrawn.model.all, { tokenIds: upTokenIds, contractIds: hugeDrawn.ids, address: up.token.address }, knownOf(up))).toEqual([]);
    expect(checkDrawn(hugeDrawn.root, hugeDrawn.model.all)).toEqual([]);
    const urlRow = [...hugeDrawn.root.walk()].find((el) => el.getAttribute("data-o") === "iface:url")!;
    const urlLink = [...urlRow.walk()].find((el) => el.tagName === "a" && el.href === MAX_URL)!;
    expect(MAX_URL.length).toBe(MAX_URL_BYTES);
    expect(urlLink.textContent.length).toBeLessThanOrEqual(101);            // head … tail
    expect(urlLink.textContent.endsWith("/index.json")).toBe(true);
    expect(urlRow.textContent).toContain("(262\u00a0112 characters)");      // grouped with U+00A0
    expect(urlLink.title).not.toContain(MAX_URL);                           // no 262 KB tooltip
    const copy = [...urlRow.walk()].find((el) => el.className.includes("cpbtn"))!;
    expect(copy.title).toBe(`copy the whole URL (${MAX_URL_BYTES} characters)`);
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
      expect(checkModel(page, drawn.model.all, where, knownOf(c, outcomes[label])), `outcome ${label}`).toEqual([]);
      expect(checkDrawn(drawn.root, drawn.model.all), `outcome ${label} drawn`).toEqual([]);
      note(drawn.model.all);
    }
    // a contract that published none: "Not available" with its reason, drawn
    const none = drawContract(page, contractState(tokenFixture("sneb18"), null));
    expect(none.model.face.rows[0].origin.label).toBe("Not available (this contract has published no public interface)");
    expect(checkDrawn(none.root, none.model.all)).toEqual([]);

    // ── every origin kind met at least once ───────────────────────────────────────────────────
    expect([...kindsSeen].sort()).toEqual(["chain", "derived", "mip-0018", "none", "public-interface"]);
  });

  // ── negative controls: the same checks on a page that breaks the rule must FAIL ─────────────

  it("negative control: a value shown without an origin fails the check", () => {
    const broken = SERVED_SCRIPT.replace(
      'facts.push(item("symbol", "symbol", t.symbol, o.symbol,',
      'facts.push(item("symbol", "symbol", t.symbol, null,',
    );
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const f = tokenFixture("sneb18");
    const contract = drawContract(page, contractState(f, null));
    const token = drawToken(page, f);
    const where: Where = { tokenIds: token.ids, contractIds: contract.ids, address: f.token.address };
    expect(checkModel(page, token.model.all, where, knownOf(f))).toEqual(["symbol: shown without an origin (Origin not given)"]);
  });

  it("negative control: a value drawn without its origin chip fails the check", () => {
    const broken = SERVED_SCRIPT.replace('cell(tr, originBlock(it.origin), "ocell");', 'cell(tr, "-", "ocell");');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const token = drawToken(page, tokenFixture("sneb18"));
    const violations = checkDrawn(token.root, token.model.all);
    expect(violations).toContain('symbol: drawn without its origin "MIP-0018 declaration"');
    expect(violations).toContain('address: drawn without its origin "Chain observation"');
  });

  it("negative control: an evidence link that does not resolve fails the check", () => {
    const broken = SERVED_SCRIPT.replace('return { href: hashTx(h), text:', 'return { href: hashTx(h.slice(2)), text:');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const f = tokenFixture("sneb18");
    const contract = drawContract(page, contractState(f, null));
    const token = drawToken(page, f);
    const violations = checkModel(page, token.model.all, { tokenIds: token.ids, contractIds: contract.ids, address: f.token.address }, knownOf(f));
    expect(violations.some((v) => v.startsWith("name: the link #/tx/") && v.endsWith("a transaction the payloads do not name"))).toBe(true);
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
