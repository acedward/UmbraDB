import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type FakeElement, type Json, type Page, SERVED_SCRIPT, loadPage } from "./helpers/ui-page.js";

/** The heavy tests build megabytes of synthetic payload: a deadline the shared host (load ≈ 30 while
 *  another runner proves) cannot trip — vitest's default is 5 s. */
const HEAVY_MS = 120_000;

/**
 * `[[token-ui-hostile-values]]` — spec 00024 FR-016 / FR-013b and the 03-E1a Codex audit: every string
 * the explorer page draws comes from data anyone can publish on chain or serve from a bundle host.
 * The page must draw such values without breaking, hiding, disguising or flooding anything:
 *
 *  - E1a-F3: a bundle field the API passes through as published (package.json `compact.language`,
 *    `runtime`, `interface`, `flags`) may be any JSON — `{"toString": null}` made `String()` throw and
 *    the contract view was never drawn; a view that still cannot be drawn says so (render boundary).
 *  - E1a-F4: the list no longer asks `/v1/interfaces` (whole publications with URLs of up to 262 112
 *    bytes, ~131 MB for 500 contracts, on every 10 s refresh) — Q30; the contract view reads
 *    `/interface` again only when the contract route's summary of it changed; no answer is read past
 *    MAX_RESPONSE_BYTES (an announced length is refused, a streamed body is cancelled).
 *  - E1a-F5: bundle-derived text (circuit, argument and witness names, file paths, build fields) may
 *    be megabytes (contract-info.json ≤ 8 MiB): drawn as head … tail with its length, copied whole;
 *    items are keyed by position, so no published name reaches an attribute.
 *  - E1a-F13: a URL is parsed as a browser does (tabs and newlines dropped, extra slashes and
 *    backslashes after the scheme skipped, the host after the last "@"); its host is always shown,
 *    and a URL with user information before its host is not a link; a tokenUri rewritten to this
 *    origin keeps one leading slash (never a protocol-relative "//host").
 *  - E1a-F14: bidi and invisible characters (U+202E, U+200B, tags …) are drawn as visible marks
 *    "⟨U+202E⟩" in text and tooltips — two distinct identifiers never look the same — while copying
 *    keeps the original characters; every piece of published text is a bidi-isolated island.
 *  - E1a-R2D: up to 2 000 events are read; an earlier declaration and a raw event are drawn within
 *    160 characters — the marks of hidden characters counted — and copied whole.
 *  - E1a-R6D: an earlier opaque value (and a raw event's) keeps its whole bytes in the model: two
 *    values that differ in the middle are told apart, a long one is drawn bounded and copied whole.
 *  - E1a-R6E: a tokenUri is drawn within 160 characters in a list row and 1 000 on the token view
 *    (head … tail, its length, where it leads, copied whole); its link is the whole URI.
 *  - E1a-R3E: at most 500 keys of a token are drawn (the rest named, with a link); a current value
 *    is drawn whole up to 2 048 drawn characters and past that on the reader's request.
 *  - E1a-R4F: a contract's token rows (at most 500, the count named with its origin) and the list's
 *    rows draw a name or a symbol within 160 characters, copied whole.
 *
 * The page script runs in `node:vm` exactly as served (`helpers/ui-page.ts`).
 */

const FIXTURES = new URL("./fixtures/ui/", import.meta.url);
const read = (name: string): Json => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

const UP = read("token-uprompi.json");
function contractState(iface: Json): Json {
  return { contract: UP.contract, iface, ifaceLoaded: true, events: UP.events.items, calls: UP.calls ?? null, notes: [] };
}
function drawContract(script: string, iface: Json): { root: FakeElement; error: unknown } {
  const page = loadPage(script);
  page.ctx.state.route = { view: "contract", address: UP.contract.address };
  page.ctx.state.contract = contractState(iface);
  const root = page.doc.createElement("main");
  try { page.ctx.renderContract(root); return { root, error: null }; } catch (e) { return { root, error: e }; }
}
/** The UPROMPI contract view's API, as the page asks it. */
function contractRoutes(): Map<string, Json> {
  const a = UP.contract.address;
  return new Map<string, Json>([
    ["/internal/status", { net: "undeployed" }],
    [`/v1/contracts/${a}`, UP.contract],
    [`/v1/contracts/${a}/interface`, UP.interface],
    [`/v1/contracts/${a}/events?limit=500`, UP.events],
    [`/v1/contracts/${a}/calls?limit=200`, { items: [], nextCursor: null }],
  ]);
}
async function bootAt(hash: string, routes: Map<string, Json>, script = SERVED_SCRIPT): Promise<Page> {
  const live = loadPage(script, routes);
  live.window.location.hash = hash;
  live.boot();
  await live.settle();
  return live;
}
const MiB = 1024 * 1024;
/** A response whose body streams `chunks` MiB (one reused 1 MiB buffer), and records a cancel. */
function streamed(chunks: number, announced: number | null): Json {
  const buf = new Uint8Array(MiB).fill(0x20);
  let sent = 0;
  const res = {
    ok: true, status: 200, cancelled: false, textCalled: false,
    headers: { get: (k: string) => (k === "content-length" && announced !== null ? String(announced) : null) },
    text: async () => { res.textCalled = true; return " ".repeat(chunks * MiB); },
    body: { getReader: () => ({
      read: async () => (sent < chunks ? (sent++, { done: false, value: buf }) : { done: true, value: undefined }),
      cancel: () => { res.cancelled = true; },
    }) },
  };
  return res;
}
/** UPROMPI's interface with megabyte names where a bundle chooses them (E1a-F5). */
function hugeNames(): { iface: Json; name: string } {
  const iface = JSON.parse(JSON.stringify(UP.interface));
  const name = `c${"x".repeat(3_000_000)}`;
  iface.circuits[0].name = name;
  iface.circuits[0].arguments = [{ name: "a".repeat(1_000_000), type: "Field" }];
  iface.keys[0].circuit = name;
  iface.files[0].path = `src/${"d/".repeat(50_000)}f.compact`;
  iface.witnesses = ["w".repeat(1_000_000)];
  iface.build = { ...(iface.build ?? {}), language: "l".repeat(2_000_000) };
  return { iface, name };
}
/** The drawn view's text length and its longest attribute (title, href, data-o), against the
 *  recorded (small-name) interface as the baseline. */
function budgetOf(root: FakeElement): { text: number; longestAttribute: number; baseline: number } {
  let longest = 0;
  for (const el of root.walk()) {
    for (const v of [el.title, el.href, ...Object.values(el.attrs)]) longest = Math.max(longest, String(v).length);
  }
  const base = drawContract(SERVED_SCRIPT, UP.interface).root.textContent.length;
  return { text: root.textContent.length, longestAttribute: longest, baseline: base };
}
const groupedCount = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
/** LMOON18 whose key "custom" was declared `n` + 1 times, each value `len` U+202E characters. */
function floodedToken(n: number, len: number): Json {
  const lm = read("token-lmoon18.json");
  const t = lm.token;
  const model = lm.events.items[0];
  const keyHex = Buffer.from("custom").toString("hex");
  const events = Array.from({ length: n + 1 }, (_, i) => ({ ...model, eventId: 100_000 + i, blockHeight: 10_000 + i, txPosition: 0,
    domainSep: t.domainSep, kindByte: t.kind, key: keyHex.padEnd(64, "0"), keyHex, keyText: "custom", valType: 1, valLen: len * 3,
    text: "\u202E".repeat(len), value: "e280ae".repeat(len), applied: true,
    origin: { origin: "mip-0018", evidence: { ...model.origin.evidence, eventIds: [100_000 + i] } } }));
  const current = events[n]!;
  const keys = [{ key: "custom", keyHex, valType: 1, valLen: len * 3, value: current.value, text: current.text, integer: null,
    projectionError: null, updatedHeight: current.blockHeight, updatedTxHash: current.txHash, eventId: current.eventId,
    segment: current.segment, parts: 1, phase: "guaranteed", origin: current.origin }];
  return { token: t, keys, mints: [], events, siblings: lm.contract.tokens, activity: null, calls: lm.calls ?? null, notes: [] };
}
/** LMOON18 with `n` current keys, each a text of `len` DEL (U+007F) characters. */
function manyKeys(n: number, len: number): Json {
  const lm = read("token-lmoon18.json");
  const model = lm.metadata.keys[0];
  const keys = Array.from({ length: n }, (_, i) => {
    const keyHex = Buffer.from(`k${i}`).toString("hex");
    return { ...model, key: `k${i}`, keyHex, valType: 1, valLen: len, text: "\u007F".repeat(len), value: "7f".repeat(len),
      integer: null, eventId: 500_000 + i };
  });
  return { token: lm.token, keys, mints: [], events: [], siblings: lm.contract.tokens, activity: null, calls: lm.calls ?? null, notes: [] };
}
/** LMOON18's contract with `n` token rows, each named (and symbolled) with `len` DEL characters. */
function crowdedContract(n: number, len: number): Json {
  const lm = read("token-lmoon18.json");
  const row = lm.contract.tokens[0];
  const tokens = Array.from({ length: n }, (_, i) => ({ ...row, domainSep: i.toString(16).padStart(64, "0"),
    name: "\u007F".repeat(len), symbol: "\u007F".repeat(len) }));
  return { contract: { ...lm.contract, tokens }, iface: null, ifaceLoaded: true, events: [], calls: null, notes: [] };
}
/** LMOON18 with earlier opaque (valType 0) declarations of one key, oldest first, then a current one. */
function opaqueHistory(values: string[]): Json {
  const lm = read("token-lmoon18.json");
  const t = lm.token;
  const model = lm.events.items[0];
  const keyHex = Buffer.from("blob").toString("hex");
  const all = [...values, "00"];
  const events = all.map((v, i) => ({ ...model, eventId: 200_000 + i, blockHeight: 20_000 + i, txPosition: 0,
    domainSep: t.domainSep, kindByte: t.kind, key: keyHex.padEnd(64, "0"), keyHex, keyText: "blob", valType: 0, valLen: v.length / 2,
    text: null, integer: null, value: v, applied: true,
    origin: { origin: "mip-0018", evidence: { ...model.origin.evidence, eventIds: [200_000 + i] } } }));
  const current = events[events.length - 1]!;
  const keys = [{ key: "blob", keyHex, valType: 0, valLen: 1, value: current.value, text: null, integer: null,
    projectionError: null, updatedHeight: current.blockHeight, updatedTxHash: current.txHash, eventId: current.eventId,
    segment: current.segment, parts: 1, phase: "guaranteed", origin: current.origin }];
  return { token: t, keys, mints: [], events, siblings: lm.contract.tokens, activity: null, calls: lm.calls ?? null, notes: [] };
}
/** `n` list rows (the recorded described row, each its own domain separator) with one tokenUri. */
function uriRows(n: number, uri: string): Json[] {
  const row0 = read("tokens.json").items.find((r: Json) => r.status === "described");
  return Array.from({ length: n }, (_, i) => ({ ...row0, domainSep: i.toString(16).padStart(64, "0"), tokenUri: uri }));
}
function drawTokenState(page: Page, detail: Json): FakeElement {
  const t = detail.token;
  page.ctx.state.route = { view: "token", address: t.address, domainSep: t.domainSep, kind: String(t.kind) };
  page.ctx.state.detail = detail;
  const root = page.doc.createElement("main");
  page.ctx.renderToken(root);
  return root;
}
/** Valid JSON, as a bundle's package.json may publish it: objects whose toString is not callable. */
const HOSTILE_BUILD = JSON.parse('{"compiler":"0.34.0","language":{"toString":null},"runtime":{"toString":null,"valueOf":null},'
  + '"interface":[1,{"toString":null}],"flags":[{"toString":null},"--vscode"]}');

describe("the page draws hostile values without breaking", () => {
  it("[[token-ui-hostile-values]] untrusted values are drawn safely", async () => {
    // ── E1a-F3: non-string bundle fields ──────────────────────────────────────────────────────
    const iface = JSON.parse(JSON.stringify(UP.interface));
    iface.build = HOSTILE_BUILD;
    const drawn = drawContract(SERVED_SCRIPT, iface);
    expect(drawn.error, "the contract view is drawn").toBeNull();
    const build = [...drawn.root.walk()].find((el) => el.getAttribute("data-o") === "iface:build")!;
    expect(build.textContent).toContain('language {"toString":null}');
    expect(build.textContent).toContain('runtime {"toString":null,"valueOf":null}');
    expect(build.textContent).toContain('flags {"toString":null} --vscode');
    // …and a view that still cannot be drawn says so instead of leaving the page blank
    const page = loadPage(SERVED_SCRIPT);
    const broken = JSON.parse(JSON.stringify(UP.interface));
    broken.history = [null];
    page.ctx.state.route = { view: "contract", address: UP.contract.address };
    page.ctx.state.contract = contractState(broken);
    expect(() => page.ctx.render()).not.toThrow();
    const view = page.doc.getElementById("view")!;
    expect(view.textContent).toContain("this view could not be drawn");

    // ── E1a-F4: no publisher-sized download on every refresh ──────────────────────────────────
    const tokens = read("tokens.json");
    const list = await bootAt("#/", new Map<string, Json>([["/internal/status", { net: "undeployed" }], ["/v1/tokens?limit=200", tokens]]));
    expect(list.requests.some((r) => r.startsWith("/v1/interfaces")), "the list asks no /v1/interfaces").toBe(false);
    const upRow = [...list.doc.getElementById("view")!.walk()].find((el) => el.tagName === "tr" && el.textContent.includes("verified L1/L2/L3"));
    expect(upRow, "the list's interface column still shows the status").toBeDefined();
    // the contract view reads /interface once, and again only when its summary changed
    const routes = contractRoutes();
    const live = await bootAt(`#/contract/${UP.contract.address}`, routes);
    const ifaceReads = (): number => live.requests.filter((r) => r.endsWith("/interface")).length;
    expect(ifaceReads()).toBe(1);
    await live.ctx.refresh(); await live.ctx.refresh();
    expect(ifaceReads(), "an unchanged summary: the publication is not read again").toBe(1);
    expect([...live.doc.getElementById("view")!.walk()].some((el) => el.id === "interface")).toBe(true);
    const changed = JSON.parse(JSON.stringify(UP.contract));
    changed.interface.checkedAt = "2026-09-28T00:00:00.000Z";
    routes.set(`/v1/contracts/${UP.contract.address}`, changed);
    await live.ctx.refresh();
    expect(ifaceReads(), "a changed summary: read again").toBe(2);
    // E1a-R2C: an older publication can finish its own check while the current summary stays the
    // same — the kept document is read again once it is a minute old, and the new result is drawn
    const later = JSON.parse(JSON.stringify(UP.interface));
    later.history = [{ ...JSON.parse(JSON.stringify(UP.interface)), eventId: 1, role: "historical", status: "failed", failedLevel: 1,
      levels: { l1: "failed", l2: "not_run", l3: "not_run" }, reason: "Level 1: tampered", origin: UP.interface.origin }];
    routes.set(`/v1/contracts/${UP.contract.address}/interface`, later);
    await live.ctx.refresh();
    expect(ifaceReads(), "younger than a minute: kept").toBe(2);
    expect(live.ctx.IFACE_MAX_AGE_MS).toBe(60_000);
    live.ctx.state.contract.ifaceAt -= 61_000;
    await live.ctx.refresh();
    expect(ifaceReads(), "a minute old: read again").toBe(3);
    expect(live.ctx.contractModel(live.ctx.state.contract).face.history.map((h: Json) => h.status.text)).toEqual(["failed at L1"]);
    // no answer is read past MAX_RESPONSE_BYTES (64 MiB)
    const capped = loadPage();
    expect(capped.ctx.MAX_RESPONSE_BYTES).toBe(64 * MiB);
    const announced = streamed(1, 65 * MiB);
    capped.ctx.fetch = async () => announced;
    await expect(capped.ctx.api("/v1/contracts/x/interface")).rejects.toThrow(/larger than this page reads/);
    expect(announced.textCalled).toBe(false);
    const flood = streamed(65, null);
    capped.ctx.fetch = async () => flood;
    await expect(capped.ctx.api("/v1/contracts/x/interface")).rejects.toThrow(/larger than this page reads/);
    expect(flood.cancelled, "the stream is cancelled at the bound").toBe(true);
    const fine = streamed(2, null);
    capped.ctx.fetch = async () => fine;
    await expect(capped.ctx.api("/ok"), "an answer under the bound is read whole").resolves.toBeNull(); // spaces: no JSON
    expect(fine.cancelled).toBe(false);

    // ── E1a-F5: megabyte names from a bundle are drawn bounded and copied whole ───────────────
    const hugeIface = hugeNames();
    const huge = drawContract(SERVED_SCRIPT, hugeIface.iface);
    expect(huge.error).toBeNull();
    const sizes = budgetOf(huge.root);
    expect(sizes.longestAttribute, "no attribute carries a published name").toBeLessThan(1_000);
    expect(sizes.text, "the drawn text stays small").toBeLessThan(sizes.baseline + 20_000);
    const circuitRow = [...huge.root.walk()].find((el) => el.getAttribute("data-o") === "iface:circuit:0")!;
    expect(circuitRow.textContent).toContain(`(${groupedCount(hugeIface.name.length)} characters)`);
    const copyName = [...circuitRow.walk()].find((el) => el.className.includes("cpbtn"))!;
    const livePage = loadPage();
    livePage.ctx.state.route = { view: "contract", address: UP.contract.address };
    livePage.ctx.state.contract = contractState(hugeIface.iface);
    const liveRoot = livePage.doc.createElement("main");
    livePage.ctx.renderContract(liveRoot);
    const liveRow = [...liveRoot.walk()].find((el) => el.getAttribute("data-o") === "iface:circuit:0")!;
    [...liveRow.walk()].find((el) => el.className.includes("cpbtn"))!.click();
    await livePage.settle();
    expect(livePage.copied[0], "the copy control copies the whole name").toBe(hugeIface.name);
    expect(copyName.title).toBe(`copy the whole value (${hugeIface.name.length} characters)`);

    // ── E1a-F13: where a URL leads is always in view ──────────────────────────────────────────
    const P = loadPage();
    const disguised = `https://trusted.example${" ".repeat(80)}@evil.example/${"x".repeat(80)}/index.json`;
    const dv = P.ctx.urlView(disguised);
    expect([dv.href, dv.host, dv.userinfo]).toEqual([null, "evil.example", true]);
    const dn: FakeElement = P.ctx.urlNode(dv);
    expect(dn.textContent).toContain("→ evil.example");
    expect(dn.textContent).toContain("not a link: user information before the host");
    expect([...dn.walk()].some((el) => el.tagName === "a")).toBe(false);
    expect(dn.textContent).not.toContain("@evil.example"); // the shortened text hides it — the host line does not
    for (const [url, host] of [
      [`https://\\\\evil.example/${"p".repeat(200)}`, "evil.example"],       // backslashes after the scheme
      [`https://trus\tted.example@evil.example/`, "evil.example"],               // a tab inside user information
      [`HTTPS://Bundles.Example:8443/${"p".repeat(200)}/index.json`, "bundles.example"],
      ["https://[::1]:8080/x", "[::1]"],
      ["https://evil.example   ", "evil.example"],                                   // trailing spaces
      ["https://ev\til.example/x", "evil.example"],                                 // a tab in the host
    ] as const) {
      expect(P.ctx.urlView(url).host, url.slice(0, 40)).toBe(host);
      expect(P.ctx.urlNode(P.ctx.urlView(url)).textContent).toContain(`→ ${host}`);
    }
    // parsed once per publication: the interface payload is kept across refreshes (E1a-F4), so the
    // re-render must not parse up to 101 URLs of 262 112 bytes again
    const pub = { url: `https://bundles.example/${"p".repeat(262_000)}` };
    expect(P.ctx.urlViewOf(pub)).toBe(P.ctx.urlViewOf(pub));
    // E1a-R3F: the host a browser goes to — percent-decoded, IDNA-mapped; an unparseable URL is no link
    for (const [url, host] of [
      ["https://%65%76%69%6c.example/x", "evil.example"],
      ["https://ＥＶＩＬ.example/x", "evil.example"],
    ] as const) {
      expect(P.ctx.urlView(url).host, url).toBe(host);
      expect(P.ctx.urlNode(P.ctx.urlView(url)).textContent).toContain(`→ ${host}`);
    }
    expect(P.ctx.urlView("https://exa mple.com/x").href).toBeNull();
    const honest = P.ctx.urlView(`https://bundles.example/${"p".repeat(300)}/index.json`);
    expect(honest.href).not.toBeNull();
    expect(P.ctx.urlNode(honest).textContent).toContain("→ bundles.example");
    // tokenUri: the same parser; a localhost URI rewritten to this origin never becomes "//host/…"
    const rewrite: FakeElement = P.ctx.uriLink("http://localhost//evil.example/x");
    expect(rewrite.href).toBe("/evil.example/x");
    expect(P.ctx.uriLink("http://localhost:10020/constellations/orion").href).toBe("/constellations/orion");
    // E1a-R2B: tabs and newlines are dropped BEFORE the slashes are counted, as a browser does
    for (const cc of ["\t", "\n", "\r", "\t\\\n"]) {
      const href: string = P.ctx.uriLink(`http://localhost/${cc}/evil.example/x`).href;
      expect(href, JSON.stringify(cc)).toBe("/evil.example/x");
    }
    expect(P.ctx.localPath("/\t/")).toBe("/");
    const userinfo: FakeElement = P.ctx.uriLink("https://good.example@evil.example/meta.json");
    expect([...userinfo.walk()].some((el) => el.tagName === "a")).toBe(false);
    expect(userinfo.textContent).toContain("it leads to evil.example");

    // ── E1a-F14: bidi and invisible characters are drawn as visible marks ─────────────────────
    const spoof = JSON.parse(JSON.stringify(UP.interface));
    spoof.witnesses = ["safeAmount", "safe\u202EtnuomA\u202C", "safe\u200BAmount"];
    spoof.reason = "Level 2: circuit mint\u2066 differs";
    spoof.status = "failed"; spoof.failedLevel = 2; spoof.levels = { l1: "passed", l2: "failed", l3: "not_run" };
    const sp = drawContract(SERVED_SCRIPT, spoof);
    const witnessTexts = [0, 1, 2].map((i) => [...sp.root.walk()].find((el) => el.getAttribute("data-o") === `iface:witness:${i}`)!.textContent);
    expect(witnessTexts.map((t) => t.split("Public interface")[0])).toEqual(["safeAmount", "safe⟨U+202E⟩tnuomA⟨U+202C⟩", "safe⟨U+200B⟩Amount"]);
    expect(new Set(witnessTexts).size, "three identifiers, three different drawings").toBe(3);
    const failure = [...sp.root.walk()].find((el) => el.getAttribute("data-o") === "iface:failure")!;
    expect(failure.textContent).toContain("mint⟨U+2066⟩ differs");
    for (const el of sp.root.walk()) {
      expect(el.title, "no tooltip carries a raw bidi or zero-width character").not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/);
      if (el.children.length === 0) expect(el.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/);
    }
    // ordinary text of every script is left alone: an emoji with its variation selector, Arabic, CJK
    const P2 = loadPage();
    for (const plain of ["❤️ Heart", "رمز", "漢字", "Ünïcödé", "tab\there"]) expect(P2.ctx.shown(plain)).toBe(plain);
    expect(P2.ctx.shown("a\u0000b\u{E0041}c")).toBe("a⟨U+0000⟩b⟨U+E0041⟩c");
    // …and a copy keeps the original characters
    const longSpoof = `x\u202E${"y".repeat(400)}`;
    const cp = [...P2.ctx.boundedNode(longSpoof, 160, "txt").walk()].find((el: FakeElement) => el.className.includes("cpbtn"))!;
    cp.click();
    await P2.settle();
    expect(P2.copied[0]).toBe(longSpoof);

    // ── E1a-R2D: many long declarations of one key stay a bounded drawing ─────────────────────
    const declared = floodedToken(600, 12_000);
    const fp = loadPage();
    const drawnFlood = drawTokenState(fp, declared);
    const floodText = drawnFlood.textContent.length;
    expect(floodText, "600 earlier declarations + 601 raw events of 12 000 hidden characters each").toBeLessThan(600_000);
    expect(drawTokenState(loadPage(), floodedToken(100, 4_000)).textContent.length, "the negative control's view, bounded").toBeLessThan(100_000);
    const histRows = [...drawnFlood.walk()].filter((el) => el.className === "hist");
    expect(histRows.length).toBe(600);
    for (const r of histRows.slice(0, 5)) expect(r.textContent.length).toBeLessThan(700);
    const histCopy = [...histRows[0]!.walk()].find((el) => el.className.includes("cpbtn"))!;
    histCopy.click();
    await fp.settle();
    expect(fp.copied[0], "the earlier value is copied whole").toBe("\u202E".repeat(12_000));

    // ── E1a-R6D: an earlier opaque value keeps its bytes: told apart, bounded, copied whole ───
    {
      const a32 = "0011223344" + "aa".repeat(23) + "ccddeeff";
      const b32 = "0011223344" + "bb".repeat(23) + "ccddeeff";
      const long = "0011223344" + "cd".repeat(191) + "ccddeeff";
      const op = loadPage();
      const detail = opaqueHistory([long, a32, b32]);
      const blob = op.ctx.tokenModel(detail).traits.find((i: Json) => i.label === "blob");
      expect(blob.history.map((h: Json) => h.value), "newest first, the whole bytes").toEqual(["0x" + b32, "0x" + a32, "0x" + long]);
      const root = drawTokenState(op, detail);
      const hist = [...root.walk()].filter((el) => el.className === "hist");
      expect(hist[0]!.textContent).toContain("0x" + b32);
      expect(hist[1]!.textContent).toContain("0x" + a32);
      // a long one: head … tail with its length, and a copy control that copies every byte
      expect(hist[2]!.textContent).not.toContain("0x" + long);
      expect(hist[2]!.textContent).toContain(`(${(2 + long.length).toString()} characters)`);
      [...hist[2]!.walk()].find((el) => el.className.includes("cpbtn"))!.click();
      await op.settle();
      expect(op.copied[0], "the earlier opaque value is copied whole").toBe("0x" + long);
      // the raw events keep them too — in the model and in the drawn cells (E1a-R7B)
      const ev = op.ctx.tokenModel(detail).all.filter((i: Json) => String(i.field).startsWith("event:"));
      expect(ev.map((i: Json) => i.value)).toContain("0x" + a32);
      const evSec = [...root.walk()].find((el) => el.id === "events")!;
      const evRow = (id: number): FakeElement => [...evSec.walk()].find((el) => el.tagName === "tr" && el.getAttribute("data-o") === `event:${id}`)!;
      expect(evRow(200_001).textContent).toContain("0x" + a32);
      expect(evRow(200_002).textContent).toContain("0x" + b32);
      expect(evRow(200_000).textContent).not.toContain("0x" + long);
      [...evRow(200_000).walk()].find((el) => el.className.includes("cpbtn"))!.click();
      await op.settle();
      expect(op.copied[op.copied.length - 1], "the raw event's opaque value is copied whole").toBe("0x" + long);
    }

    // ── E1a-R3E: 2 000 current keys of 8 000 hidden characters each ───────────────────────────
    const keyed = manyKeys(2_000, 8_000);
    const kp = loadPage();
    kp.ctx.state.route = { view: "token", address: keyed.token.address, domainSep: keyed.token.domainSep, kind: String(keyed.token.kind) };
    kp.ctx.state.detail = keyed;
    kp.ctx.render();
    const kview = kp.doc.getElementById("view")!;
    expect(kview.textContent.length, "2 000 keys × 8 000 marks each, drawn").toBeLessThan(2_000_000);
    const traitsSec = [...kview.walk()].find((el) => el.id === "traits")!;
    expect([...traitsSec.walk()].filter((el) => el.tagName === "tr" && (el.getAttribute("data-o") ?? "").startsWith("trait:")).length).toBe(500);
    expect(traitsSec.textContent).toContain("the first 500 of 2\u00a0000 keys are listed — all of them: every key (API)");
    // the count is a value of the token's: a marked occurrence with its derived origin (E1a-R4C)
    const countNote = [...traitsSec.walk()].find((el) => el.getAttribute("data-o") === "traits:count")!;
    expect([...countNote.walk()].some((el) => el.className.includes("orig") && el.textContent === "Derived by this indexer")).toBe(true);
    // the reader asks for the whole value: it is drawn whole, and stays so across a re-render
    const firstRow = [...traitsSec.walk()].find((el) => el.tagName === "tr" && (el.getAttribute("data-o") ?? "").startsWith("trait:"))!;
    [...firstRow.walk()].find((el) => el.tagName === "button" && el.textContent === "show all")!.click();
    const opened = [...kp.doc.getElementById("view")!.walk()].find((el) => el.getAttribute("data-o") === firstRow.getAttribute("data-o"))!;
    expect(opened.textContent).toContain("⟨U+007F⟩".repeat(8_000));
    kp.ctx.render();
    expect([...kp.doc.getElementById("view")!.walk()].find((el) => el.getAttribute("data-o") === firstRow.getAttribute("data-o"))!.textContent)
      .toContain("show less");
    // ── E1a-R4F: 2 000 token rows of one contract, each named with 8 000 hidden characters ────
    const crowd = crowdedContract(2_000, 8_000);
    const crp = loadPage();
    crp.ctx.state.route = { view: "contract", address: crowd.contract.address };
    crp.ctx.state.contract = crowd;
    crp.ctx.render();
    const cview = crp.doc.getElementById("view")!;
    expect(cview.textContent.length, "2 000 rows × 8 000 marks each, drawn").toBeLessThan(2_000_000);
    const toks = [...cview.walk()].find((el) => el.id === "tokens")!;
    expect([...toks.walk()].filter((el) => el.tagName === "tr" && el.className === "pick").length).toBe(500);
    expect(toks.textContent).toContain("the first 500 of 2\u00a0000 token rows are listed — all of them: every token row (API)");
    const tcount = [...toks.walk()].find((el) => el.getAttribute("data-o") === "tokens:count")!;
    expect([...tcount.walk()].some((el) => el.className.includes("orig") && el.textContent === "Derived by this indexer")).toBe(true);
    // the list draws the same names bounded too
    const lpage = loadPage();
    lpage.ctx.state.list = { items: crowd.contract.tokens.slice(0, 500), nextCursor: null, loaded: true };
    lpage.ctx.state.route = { view: "list" };
    lpage.ctx.render();
    expect(lpage.doc.getElementById("view")!.textContent.length, "500 list rows").toBeLessThan(1_000_000);

    // ── E1a-R6E: 500 list rows whose tokenUri is 8 000 DEL characters ─────────────────────────
    {
      const uri = `https://example.org/${"\u007f".repeat(8_000)}x`;
      const up = loadPage();
      up.ctx.state.list = { items: uriRows(500, uri), nextCursor: null, loaded: true };
      up.ctx.state.route = { view: "list" };
      up.ctx.render();
      const lv = up.doc.getElementById("view")!;
      expect(lv.textContent.length, "500 rows × an 8 000-DEL tokenUri, drawn").toBeLessThan(1_000_000);
      const links = [...lv.walk()].filter((el) => el.tagName === "a" && el.href === uri);
      expect(links.length, "each row still links the whole URI").toBe(500);
      const wrap = links[0]!.parentNode!;
      expect(wrap.textContent).toContain("(8\u00a0021 characters)");
      expect(wrap.textContent, "where it leads").toContain("→ example.org");
      [...wrap.walk()].find((el) => el.className.includes("cpbtn"))!.click();
      await up.settle();
      expect(up.copied[0], "the whole URI is copied").toBe(uri);
      // E1a-R7C: a cut localhost URI rewritten to this origin says so, not "→ localhost"
      const lp = loadPage();
      const local = `http://localhost/${"a".repeat(200)}`;
      lp.ctx.state.list = { items: uriRows(1, local), nextCursor: null, loaded: true };
      lp.ctx.state.route = { view: "list" };
      lp.ctx.render();
      const la = [...lp.doc.getElementById("view")!.walk()].find((el) => el.tagName === "a" && el.href === `/${"a".repeat(200)}`)!;
      expect(la, "rewritten to a same-origin path").toBeDefined();
      expect(la.parentNode!.textContent).toContain("→ this page's origin (rewritten from localhost)");
      expect(la.parentNode!.textContent).not.toContain("→ localhost");
      // the token's own view draws it within TEXT_MAX, twice (the heading's line and the facts)
      const tp = loadPage();
      const lm = read("token-lmoon18.json");
      const detail = { token: { ...lm.token, tokenUri: uri }, keys: lm.metadata.keys, mints: [], events: lm.events.items,
        siblings: lm.contract.tokens, activity: null, calls: lm.calls ?? null, notes: [] };
      const tv = drawTokenState(tp, detail);
      const tl = [...tv.walk()].filter((el) => el.tagName === "a" && el.href === uri);
      expect(tl.length).toBe(2);
      for (const a of tl) expect(a.textContent.length).toBeLessThanOrEqual(1_001);
    }

    // ── E1a-R12B: a deeply nested metadata document is not pretty-printed into millions of characters
    {
      const nestedText = '{"x":' + "[".repeat(127) + "0,".repeat(15_999) + "0" + "]".repeat(127) + "}";
      const lm = read("token-lmoon18.json");
      const detail = { token: { ...lm.token, metadata: JSON.parse(nestedText) }, keys: lm.metadata.keys, mints: [], events: [],
        siblings: lm.contract.tokens, activity: null, calls: lm.calls ?? null, notes: [] };
      const np = loadPage();
      const root = drawTokenState(np, detail);
      const metaSec = [...root.walk()].find((el) => el.id === "metadata")!;
      expect(metaSec.textContent.length, "a 32 KB document nested 128 deep, drawn").toBeLessThan(10_000);
      const value = np.ctx.tokenModel(detail).metadata.value;
      expect(value, "kept compact: its pretty form would be millions of characters").toBe(nestedText);
      [...metaSec.walk()].find((el) => el.className.includes("cpbtn"))!.click();
      await np.settle();
      expect(np.copied[np.copied.length - 1], "copied whole").toBe(nestedText);
      expect([...metaSec.walk()].some((el) => el.tagName === "button" && el.textContent === "show all")).toBe(true);
      // SNEB18's real 677-byte document is still pretty-printed and drawn whole
      const sn = read("token-sneb18.json");
      const snDetail = { token: sn.token, keys: sn.metadata.keys, mints: [], events: [], siblings: sn.contract.tokens, activity: null, calls: null, notes: [] };
      const snMeta = [...drawTokenState(loadPage(), snDetail).walk()].find((el) => el.id === "metadata")!;
      expect(snMeta.textContent).toContain(JSON.stringify(sn.token.metadata, null, 2));
    }

    // a realistic long value (SNEB18's 677-byte metadata, LMOON18's 377-byte description) is drawn whole
    expect(read("token-lmoon18.json").metadata.keys.every((k: Json) => (k.text ?? "").length < 2_048)).toBe(true);
  }, HEAVY_MS);

  it("negative control (E1a-F4): without the summary key the publication is read on every refresh", async () => {
    const broken = SERVED_SCRIPT.replace("} else if (c.ifaceKey !== null && prev !== null && prev.ifaceKey === c.ifaceKey && prev.iface",
      "} else if (false");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const live = await bootAt(`#/contract/${UP.contract.address}`, contractRoutes(), broken);
    await live.ctx.refresh(); await live.ctx.refresh();
    expect(live.requests.filter((r) => r.endsWith("/interface")).length).toBe(3);
  });

  it("negative control (E1a-R2C): without the age bound an older publication's new result is never read", async () => {
    const broken = SERVED_SCRIPT.replace("      && Date.now() - prev.ifaceAt < IFACE_MAX_AGE_MS) {", "      && true) {");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const live = await bootAt(`#/contract/${UP.contract.address}`, contractRoutes(), broken);
    live.ctx.state.contract.ifaceAt -= 61_000;
    await live.ctx.refresh();
    expect(live.requests.filter((r) => r.endsWith("/interface")).length).toBe(1);
  });

  it("negative control (E1a-R4F): every contract token row drawn whole floods the view", () => {
    const broken = SERVED_SCRIPT.replace("var CONTRACT_TOKEN_ROWS = 500;", "var CONTRACT_TOKEN_ROWS = 100000000;")
      .replace('    else if (fields[i] === "name") v = it.value === null ? node("span", "(undescribed)", "no") : boundedNode(it.value, NAME_MAX, "txt");',
        '    else if (fields[i] === "name") v = node("span", it.value === null ? "(undescribed)" : it.value, "txt");');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    page.ctx.state.route = { view: "contract", address: "x" };
    page.ctx.state.contract = crowdedContract(600, 2_000);
    page.ctx.render();
    expect(page.doc.getElementById("view")!.textContent.length).toBeGreaterThan(9_000_000);
  }, HEAVY_MS);

  it("negative control (E1a-R3E): every key drawn whole floods the view", () => {
    const broken = SERVED_SCRIPT.replace("var TRAIT_MAX = 2048;", "var TRAIT_MAX = 100000000;").replace("var TRAIT_ROWS = 500;", "var TRAIT_ROWS = 100000000;");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const drawn = drawTokenState(loadPage(broken), manyKeys(600, 2_000));
    expect(drawn.textContent.length).toBeGreaterThan(9_000_000); // bounded: < 600 × ~2 300
  }, HEAVY_MS);

  it("negative control (E1a-R6D): shortened in the model, two earlier opaque values look the same", () => {
    const broken = SERVED_SCRIPT.replace('  if (e.value) return "0x" + txt(e.value);', '  if (e.value) return "0x" + shortHex(txt(e.value), 10, 8);');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const detail = opaqueHistory(["0011223344" + "aa".repeat(23) + "ccddeeff", "0011223344" + "bb".repeat(23) + "ccddeeff"]);
    const blob = loadPage(broken).ctx.tokenModel(detail).traits.find((i: Json) => i.label === "blob");
    expect(blob.history[0].value).toBe(blob.history[1].value);
  });

  it("negative control (E1a-R6E): a tokenUri drawn whole floods the list", () => {
    const broken = SERVED_SCRIPT.replace("  var c = clipText(parsed.label, max || TEXT_MAX);", "  var c = { text: parsed.label, cut: false, length: parsed.label.length };");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const bp = loadPage(broken);
    bp.ctx.state.list = { items: uriRows(100, `https://example.org/${"\u007f".repeat(8_000)}x`), nextCursor: null, loaded: true };
    bp.ctx.state.route = { view: "list" };
    bp.ctx.render();
    expect(bp.doc.getElementById("view")!.textContent.length).toBeGreaterThan(6_000_000);
  });

  it("negative control (E1a-R7B): raw events shortened by their renderer look the same", () => {
    const broken = SERVED_SCRIPT.replace("    var value = items[i].value;\n",
      "    var value = e.text !== undefined && e.text !== null ? txt(e.text) : (e.value ? (hexText(e.value) || shortHex(e.value, 10, 8)) : null);\n");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const detail = opaqueHistory(["0011223344" + "aa".repeat(23) + "ccddeeff", "0011223344" + "bb".repeat(23) + "ccddeeff"]);
    const root = drawTokenState(loadPage(broken), detail);
    const evSec = [...root.walk()].find((el) => el.id === "events")!;
    const cellOf = (id: number): string => [...evSec.walk()].find((el) => el.tagName === "tr" && el.getAttribute("data-o") === `event:${id}`)!.textContent;
    expect(cellOf(200_000)).not.toContain("aaaaaa");
    expect(cellOf(200_001)).not.toContain("bbbbbb");
  });

  it("negative control (E1a-R7C): a rewritten localhost URI labelled with the host it names", () => {
    const broken = SERVED_SCRIPT.replace("  if (parsed.href !== null && parsed.local) {\n", "  if (false) {\n");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const bp = loadPage(broken);
    bp.ctx.state.list = { items: uriRows(1, `http://localhost/${"a".repeat(200)}`), nextCursor: null, loaded: true };
    bp.ctx.state.route = { view: "list" };
    bp.ctx.render();
    expect(bp.doc.getElementById("view")!.textContent).toContain("→ localhost");
  });

  it("negative control (E1a-R12B): the metadata pretty-printed and drawn whole floods the view", () => {
    const broken = SERVED_SCRIPT.replace("  if (compact.length > METADATA_PRETTY_MAX) return compact;\n", "")
      .replace("  return pretty.length <= 4 * METADATA_PRETTY_MAX ? pretty : compact;", "  return pretty;")
      .replace('    pre.appendChild(boundedNode(m.metadata.value, TRAIT_MAX, null, "metadata:document"));', "    pre.textContent = shown(m.metadata.value);");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const nestedText = '{"x":' + "[".repeat(127) + "0,".repeat(15_999) + "0" + "]".repeat(127) + "}";
    const lm = read("token-lmoon18.json");
    const detail = { token: { ...lm.token, metadata: JSON.parse(nestedText) }, keys: lm.metadata.keys, mints: [], events: [],
      siblings: lm.contract.tokens, activity: null, calls: lm.calls ?? null, notes: [] };
    const metaSec = [...drawTokenState(loadPage(broken), detail).walk()].find((el) => el.id === "metadata")!;
    expect(metaSec.textContent.length).toBeGreaterThan(4_000_000);
  });

  it("negative control (E1a-R2D): earlier declarations and raw events drawn whole flood the view", () => {
    const hist = "      cell(hr, hi.value === null ? node(\"span\", \"-\", \"no\")\n        : boundedNode(hi.value, HISTORY_MAX,";
    expect(SERVED_SCRIPT).toContain(hist);
    const broken = SERVED_SCRIPT.replace("var HISTORY_MAX = 160;", "var HISTORY_MAX = 100000000;");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const drawn = drawTokenState(loadPage(broken), floodedToken(100, 4_000));
    expect(drawn.textContent.length).toBeGreaterThan(5_000_000); // bounded, the same view draws < 100 000
  }, HEAVY_MS);

  it("negative control (E1a-F4): without the byte bound a flood is read whole", async () => {
    const broken = SERVED_SCRIPT.replace("if (n > MAX_RESPONSE_BYTES) {", "if (false) {");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const flood = streamed(65, null);
    page.ctx.fetch = async () => flood;
    await page.ctx.api("/v1/contracts/x/interface").catch(() => null);
    expect(flood.cancelled).toBe(false);
  });

  it("negative control (E1a-F5): drawn whole, a megabyte name floods the view and its attributes", () => {
    const cut = "  if (whole !== null && whole.length <= max) return { text: whole, cut: false, length: v.length };";
    const key = 'field: "iface:circuit:" + c,';
    expect(SERVED_SCRIPT).toContain(cut);
    expect(SERVED_SCRIPT).toContain(key);
    const broken = SERVED_SCRIPT.replace(cut, "  return { text: v, cut: false, length: v.length };")
      .replace(key, 'field: "iface:circuit:" + txt(cl[c].name),');
    const drawn = drawContract(broken, hugeNames().iface);
    const sizes = budgetOf(drawn.root);
    expect(sizes.text).toBeGreaterThan(sizes.baseline + 3_000_000);
    expect(sizes.longestAttribute).toBeGreaterThan(3_000_000);
  }, HEAVY_MS);

  it("negative control (E1a-F13): a URL linked by its prefix alone hides where it leads", () => {
    const broken = SERVED_SCRIPT.replace("    href: dest !== null && !dest.userinfo && dest.host !== \"\" ? s : null,", "    href: linkable ? s : null,")
      .replace("  if (uv.host !== null) {", "  if (false) {");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const P = loadPage(broken);
    const disguised = `https://trusted.example${" ".repeat(80)}@evil.example/${"x".repeat(80)}/index.json`;
    const dn: FakeElement = P.ctx.urlNode(P.ctx.urlView(disguised));
    expect([...dn.walk()].some((el) => el.tagName === "a" && el.href === disguised)).toBe(true);
    expect(dn.textContent).not.toContain("evil.example");
  });

  it("negative control (E1a-F13): without the per-publication cache a URL is parsed on every render", () => {
    const broken = SERVED_SCRIPT.replace("  if (URL_VIEWS !== null && URL_VIEWS.has(p)) return URL_VIEWS.get(p);", "");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const P = loadPage(broken);
    const pub = { url: "https://bundles.example/index.json" };
    expect(P.ctx.urlViewOf(pub)).not.toBe(P.ctx.urlViewOf(pub));
  });

  it("negative control (E1a-R2B, R3F): a destination read from the text, not the platform parser, is wrong", () => {
    // the host taken from the text: the percent-encoded host is shown as it is, not where it leads
    const broken = SERVED_SCRIPT.replace("return { host: u.hostname,", "return { host: txt(url).split(\"/\")[2],");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const P = loadPage(broken);
    expect(P.ctx.urlNode(P.ctx.urlView("https://%65%76%69%6c.example/x")).textContent).not.toContain("→ evil.example");
    // and without a parser at all nothing is made a link (the page never guesses a destination)
    const bare = loadPage(SERVED_SCRIPT, new Map(), { url: false });
    expect(bare.ctx.urlView("https://bundles.example/index.json").href).toBeNull();
    expect(bare.ctx.uriLink("http://localhost/\t/evil.example/x").href).toBe("");
  });

  it("negative control (E1a-F13): the old tokenUri rewrite leaves this origin", () => {
    const broken = SERVED_SCRIPT.replace("(local ? localPath(dest.path) : s)", "(local ? dest.path : s)");
    expect(broken).not.toBe(SERVED_SCRIPT);
    expect(loadPage(broken).ctx.uriLink("http://localhost//evil.example/x").href).toBe("//evil.example/x");
  });

  it("negative control (E1a-F14): without the marks, a reversed identifier draws its raw controls", () => {
    const broken = SERVED_SCRIPT.replace("    if (hiddenChar(c)) {", "    if (false) {");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const spoof = JSON.parse(JSON.stringify(UP.interface));
    spoof.witnesses = ["safe\u202EtnuomA\u202C"];
    const drawn = drawContract(broken, spoof);
    const w = [...drawn.root.walk()].find((el) => el.getAttribute("data-o") === "iface:witness:0")!;
    expect(w.textContent).toContain("\u202E");
  });

  it("negative control (E1a-F3): String() on a published object stops the contract view", () => {
    const broken = SERVED_SCRIPT.replace('arr(x.build.flags).map(txt).join(" ")', 'arr(x.build.flags).join(" ")');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const iface = JSON.parse(JSON.stringify(UP.interface));
    iface.build = HOSTILE_BUILD;
    expect(String(drawContract(broken, iface).error)).toContain("TypeError");
  });

  it("negative control (E1a-F3): without the render boundary a bad payload throws out of render()", () => {
    const broken = SERVED_SCRIPT.replace("  } catch (e) {\n    clear(main);\n    var failed", "  } catch (e) {\n    throw e;\n    var failed");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const page = loadPage(broken);
    const iface = JSON.parse(JSON.stringify(UP.interface));
    iface.history = [null];
    page.ctx.state.route = { view: "contract", address: UP.contract.address };
    page.ctx.state.contract = contractState(iface);
    expect(() => page.ctx.render()).toThrow();
  });
});
