import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NIGHT_COLOR_HEX, hexToBytes, pad, pad32, tokenColor, tokenColorHex } from "../color.js";

/**
 * Project 00020, sub-plan 01 Phase 3 — `[[token-color-derivation]]`.
 *
 * The vectors are RECORDED FROM THE LIVE CHAIN (2026-09-17), not invented, and each one is
 * cross-checked against two independent authorities:
 *
 *  - `registryTokenId` — the colour `effectstream/mint-test-tokens` publishes for that exact
 *    contract address in `metadata/metadata.stagenet.json`, produced by the contract's own
 *    `tokenColor()` circuit at deploy time;
 *  - `observedUtxoTokenType` — for the two UNSHIELDED issuers, the `tokenType` of a UTXO the mint
 *    transaction actually created on chain, as the indexer reports it (a shielded mint reveals no
 *    public token type, hence `null` there).
 *
 * That makes this test SC-003's core equality on real data: derived colour == circuit colour ==
 * the token type the recipient's wallet sees.
 */

interface ColorVector {
  label: string;
  source: string;
  address: string;
  domainSep: string;
  domainSepText: string;
  kind: "shielded" | "unshielded";
  expectedColor: string;
  registryTokenId: string | null;
  observedUtxoTokenType: string | null;
  registryDomainSeparator: string | null;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/color-vectors.json", import.meta.url), "utf8"),
) as { net: string; registryRevision: string; vectors: ColorVector[] };

describe("token colour derivation (spec §6.4)", () => {
  it("[[token-color-derivation]] reproduces every recorded Stagenet colour, and each one agrees with the published registry and (for unshielded mints) with the token type of the UTXO the mint created", () => {
    expect(fixture.vectors.length).toBe(6);
    for (const v of fixture.vectors) {
      const derived = tokenColorHex(v.domainSep, v.address);
      expect(derived, `${v.label} (${v.source})`).toBe(v.expectedColor);
      // The domain separator really is pad(32, "<registry domain separator>") — so the derivation
      // is reproducible by anyone from the published registry alone.
      expect(Buffer.from(pad32(v.registryDomainSeparator!)).toString("hex")).toBe(v.domainSep);
      // Authority 1: the contract's own tokenColor() circuit, as published.
      expect(v.registryTokenId, `${v.label} has no published registry colour`).not.toBeNull();
      expect(derived).toBe(v.registryTokenId);
      // Authority 2: the chain itself, for the unshielded issuers.
      if (v.kind === "unshielded") {
        expect(v.observedUtxoTokenType, `${v.label} should carry an observed UTXO token type`).toBe(derived);
      } else {
        expect(v.observedUtxoTokenType).toBeNull();
      }
    }
    // Two unshielded issuers, four shielded — the recorded set covers both tags.
    expect(fixture.vectors.filter((v) => v.kind === "unshielded")).toHaveLength(2);
  });

  it("[[token-color-night]] NIGHT is 32 zero bytes by definition and is never derived; one changed byte changes the colour", () => {
    expect(NIGHT_COLOR_HEX).toBe("0".repeat(64));
    const ledger = { nativeToken: (): { raw: string } => ({ raw: NIGHT_COLOR_HEX }) };
    expect(ledger.nativeToken().raw).toBe(NIGHT_COLOR_HEX);
    // The all-zero (address, domainSep) pair does NOT derive to the NIGHT colour — that is exactly
    // why NIGHT is a seeded row and not a derived one.
    expect(tokenColorHex("0".repeat(64), "0".repeat(64))).not.toBe(NIGHT_COLOR_HEX);

    const v = fixture.vectors[0]!;
    const flippedDomain = Buffer.from(v.domainSep, "hex");
    flippedDomain[0] = flippedDomain[0]! ^ 0x01;
    expect(tokenColorHex(flippedDomain.toString("hex"), v.address)).not.toBe(v.expectedColor);

    const flippedAddress = Buffer.from(v.address, "hex");
    flippedAddress[31] = flippedAddress[31]! ^ 0x01;
    expect(tokenColorHex(v.domainSep, flippedAddress.toString("hex"))).not.toBe(v.expectedColor);

    // The two arguments are NOT interchangeable — a swapped pair must not collide.
    expect(tokenColorHex(v.address, v.domainSep)).not.toBe(v.expectedColor);
  });

  it("[[token-color-guards]] the helpers refuse malformed input rather than deriving a plausible wrong colour", () => {
    expect(() => tokenColor(new Uint8Array(31), new Uint8Array(32))).toThrow(/domainSep must be exactly 32 bytes/);
    expect(() => tokenColor(new Uint8Array(32), new Uint8Array(33))).toThrow(/address must be exactly 32 bytes/);
    // Buffer.from(s, "hex") truncates silently at the first bad nibble; hexToBytes must not.
    expect(() => hexToBytes("zz", "domainSep")).toThrow(/not valid unprefixed hex/);
    expect(() => hexToBytes("abc", "domainSep")).toThrow(/not valid unprefixed hex/);
    expect(Buffer.from(hexToBytes("0xAB", "x")).toString("hex")).toBe("ab");
    expect(() => pad(4, "toolong")).toThrow(/do not fit/);
    expect(Buffer.from(pad32("name")).toString("hex")).toBe("6e616d65".padEnd(64, "0"));
  });
});
