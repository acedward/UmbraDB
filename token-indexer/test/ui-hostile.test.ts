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
