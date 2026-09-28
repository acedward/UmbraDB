import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type FakeElement, type Json, SERVED_SCRIPT, loadPage } from "./helpers/ui-page.js";

/**
 * `[[token-ui-hostile-values]]` — spec 00024 FR-016 / FR-013b and the 03-E1a Codex audit: every string
 * the explorer page draws comes from data anyone can publish on chain or serve from a bundle host.
 * The page must draw such values without breaking, hiding, disguising or flooding anything:
 *
 *  - E1a-F3: a bundle field the API passes through as published (package.json `compact.language`,
 *    `runtime`, `interface`, `flags`) may be any JSON — `{"toString": null}` made `String()` throw and
 *    the contract view was never drawn; a view that still cannot be drawn says so (render boundary).
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
