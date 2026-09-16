import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEDGER_SURFACE, WASM_BINDGEN_UNIVERSALS } from "../src/ledger.js";

/**
 * **The client runs on the STANDARD ledger package** (`spec/00016-dust-wallet-sync.md` §6 last
 * line, plan D3.1).
 *
 * This repository's `@midnight-ntwrk/ledger-v8` resolves to the vendored FORK build, which carries
 * three exports no published package has (`replayRawEventsRetainingAll`,
 * `collapsedCommitmentUpdate`, `collapsedGenerationUpdate`) plus two `firstFree` getters. They
 * exist for the NODE's mirror. A wallet has none of them — so a client that reached for one would
 * work perfectly here, in every test, and fail in every real wallet.
 *
 * The control is the published declaration file itself: `ledger-v8.d.ts` of
 * `@midnight-ntwrk/ledger-v8@8.1.0`, copied out of the wallet SDK image
 * (`midnight-1-offers/shielded-night-deploy:local`) on 2026-09-15 and committed here unmodified.
 * It is a hand-curated façade — properly typed, and deliberately narrower than the wasm-bindgen
 * output — which makes it the right oracle for "what may a wallet rely on".
 */

const published = readFileSync(
  fileURLToPath(new URL("./published-ledger-v8-8.1.0.d.ts", import.meta.url)),
  "utf8",
);

/** The body of `export class <name> { … }` in the published declarations. */
function classBody(name: string): string {
  const start = published.indexOf(`export class ${name} {`);
  expect(start, `published ledger-v8.d.ts has no class ${name}`).toBeGreaterThan(-1);
  const end = published.indexOf("\n}", start);
  return published.slice(start, end);
}

describe("every ledger member the client uses exists in the published 8.1.0 package", () => {
  it("is a real published file, not the vendored fork's", () => {
    // The negative control: if this ever fails, someone replaced the oracle with the fork's own
    // declarations and the whole suite would become vacuous.
    for (const forkOnly of [
      "replayRawEventsRetainingAll",
      "collapsedCommitmentUpdate",
      "collapsedGenerationUpdate",
      "commitmentTreeFirstFree",
      "generatingTreeFirstFree",
    ]) {
      expect(published, `the oracle must NOT contain the fork export ${forkOnly}`).not.toContain(forkOnly);
    }
    expect(published).toContain("export class DustLocalState {");
  });

  it.each(LEDGER_SURFACE.DustLocalState)("DustLocalState.%s", (member) => {
    expect(classBody("DustLocalState")).toContain(member);
  });

  it("DustParameters takes the three DUST parameters the tip route reports", () => {
    expect(classBody("DustParameters")).toContain(
      "constructor(nightDustRatio: bigint, generationDecayRate: bigint, dustGracePeriodSeconds: bigint)",
    );
  });

  it("DustStateMerkleTreeCollapsedUpdate.deserialize", () => {
    expect(classBody("DustStateMerkleTreeCollapsedUpdate")).toContain("static deserialize(raw: Uint8Array)");
  });

  it.each(LEDGER_SURFACE.DustSecretKey)("DustSecretKey.%s", (member) => {
    expect(classBody("DustSecretKey")).toContain(member);
  });

  it.each(LEDGER_SURFACE.functions)("the free function %s", (name) => {
    expect(published).toContain(`export function ${name}(`);
  });

  it("free() is wasm-bindgen's, present on an independently published build", () => {
    // The published façade omits `free()` and `[Symbol.dispose]`; the generated declarations do
    // not. Proving it against a SECOND published package (`ledger-v8-stock`, 8.0.3 — a different
    // version from a different build, and not the fork) is what makes "this is wasm-bindgen's,
    // not ours" a fact rather than an assertion.
    const stock = readFileSync(
      fileURLToPath(new URL("../../node_modules/ledger-v8-stock/midnight_ledger_wasm_bg.js", import.meta.url)),
      "utf8",
    );
    const dustLocalState = stock.slice(stock.indexOf("export class DustLocalState"));
    for (const member of WASM_BINDGEN_UNIVERSALS) {
      expect(dustLocalState.slice(0, 4_000)).toContain(`${member}()`);
    }
  });
});
