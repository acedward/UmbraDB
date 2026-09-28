import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type FakeElement, type Json, type Page, SERVED_SCRIPT, loadPage } from "./helpers/ui-page.js";

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
    const honest = P.ctx.urlView(`https://bundles.example/${"p".repeat(300)}/index.json`);
    expect(honest.href).not.toBeNull();
    expect(P.ctx.urlNode(honest).textContent).toContain("→ bundles.example");
    // tokenUri: the same parser; a localhost URI rewritten to this origin never becomes "//host/…"
    const rewrite: FakeElement = P.ctx.uriLink("http://localhost//evil.example/x");
    expect(rewrite.href).toBe("/evil.example/x");
    expect(P.ctx.uriLink("http://localhost:10020/constellations/orion").href).toBe("/constellations/orion");
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
  });

  it("negative control (E1a-F4): without the summary key the publication is read on every refresh", async () => {
    const broken = SERVED_SCRIPT.replace("} else if (c.ifaceKey !== null && prev !== null && prev.ifaceKey === c.ifaceKey && prev.iface) {",
      "} else if (false) {");
    expect(broken).not.toBe(SERVED_SCRIPT);
    const live = await bootAt(`#/contract/${UP.contract.address}`, contractRoutes(), broken);
    await live.ctx.refresh(); await live.ctx.refresh();
    expect(live.requests.filter((r) => r.endsWith("/interface")).length).toBe(3);
  });

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
    const broken = SERVED_SCRIPT.replace("  if (v.length <= max) return { text: v, cut: false, length: v.length };",
      "  return { text: v, cut: false, length: v.length };").replace('field: "iface:circuit:" + c,', 'field: "iface:circuit:" + txt(cl[c].name),');
    expect(broken).not.toBe(SERVED_SCRIPT);
    const drawn = drawContract(broken, hugeNames().iface);
    const sizes = budgetOf(drawn.root);
    expect(sizes.text).toBeGreaterThan(sizes.baseline + 3_000_000);
    expect(sizes.longestAttribute).toBeGreaterThan(3_000_000);
  });

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
