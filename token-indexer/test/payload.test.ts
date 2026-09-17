import { describe, expect, it } from "vitest";
import { pad32 } from "../color.js";
import {
  MAX_METADATA_PARTS,
  PayloadSizeError,
  TOKEN_METADATA_NAME_HEX,
  decodeTokenMetadata,
  encodeTokenMetadata,
  isAbsoluteHttpUrl,
  isJsonObject,
  isTokenMetadataName,
  isWellKnownKey,
  metadataPartIndex,
  parseTokenMetadata,
  type RejectReason,
} from "../ingest/payload.js";

/**
 * Project 00020, sub-plan 01 Phase 5.1 — `[[token-payload-golden]]`.
 *
 * Byte-exact decoding of the §4.2 layout plus a negative fixture for **every** rejection rule
 * (SC-004). The payloads here are hand-built from the spec; master-plan Phase C swaps the positive
 * ones for the bytes recorded from the deployed reference contracts and keeps every negative.
 */

const DOMAIN = pad32("umbra:sstar");
const KIND_SHIELDED_NATIVE = 1;

function payload(key: string, value: string | Uint8Array, kindByte = KIND_SHIELDED_NATIVE, len?: number): Uint8Array {
  return encodeTokenMetadata({ domainSep: DOMAIN, kindByte, key, value, len });
}

function expectReject(bytes: Uint8Array, reason: RejectReason): void {
  const parsed = parseTokenMetadata(bytes);
  expect(parsed.applied, `expected ${reason}`).toBe(false);
  expect(parsed.rejectReason).toBe(reason);
}

describe("TokenMetadata payload (spec §4.2)", () => {
  it("[[token-payload-golden]] decodes the documented layout byte for byte, for every well-known key and for a plain trait", () => {
    // The event name is the version marker: pad(32, "TokenMetadata").
    expect(TOKEN_METADATA_NAME_HEX).toBe(
      "546f6b656e4d65746164617461000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000".slice(0, 64),
    );
    expect(isTokenMetadataName(TOKEN_METADATA_NAME_HEX.toUpperCase())).toBe(true);
    expect(isTokenMetadataName(Buffer.from(pad32("TokenMetadata2")).toString("hex"))).toBe(false);

    const name = payload("name", "Shielded Star");
    expect(name).toHaveLength(256);
    const decoded = decodeTokenMetadata(name);
    expect(Buffer.from(decoded.domainSep).toString("hex")).toBe(Buffer.from(DOMAIN).toString("hex"));
    expect(decoded.kindByte).toBe(1);
    expect(decoded.kind).toBe("shielded");
    expect(decoded.storage).toBe("native");
    expect(decoded.keyText).toBe("name");
    expect(decoded.len).toBe("Shielded Star".length);
    expect(decoded.value).toHaveLength(190);
    expect(Buffer.from(decoded.valueBytes).toString("utf8")).toBe("Shielded Star");
    // Offsets, asserted literally rather than through the decoder.
    expect(Buffer.from(name.subarray(0, 32)).toString("hex")).toBe(Buffer.from(DOMAIN).toString("hex"));
    expect(name[32]).toBe(1);
    expect(Buffer.from(name.subarray(33, 65)).toString("hex")).toBe(Buffer.from(pad32("name")).toString("hex"));
    expect(name[65]).toBe(13);
    expect(Buffer.from(name.subarray(66, 66 + 13)).toString("utf8")).toBe("Shielded Star");
    expect(name.subarray(66 + 13).every((b) => b === 0)).toBe(true);

    const parsedName = parseTokenMetadata(name);
    expect(parsedName.applied).toBe(true);
    expect(parsedName.valueText).toBe("Shielded Star");

    const symbol = parseTokenMetadata(payload("symbol", "SSTAR"));
    expect(symbol.applied).toBe(true);
    expect(symbol.keyText).toBe("symbol");
    expect(symbol.valueText).toBe("SSTAR");

    const decimals = parseTokenMetadata(payload("decimals", new Uint8Array([6])));
    expect(decimals.applied).toBe(true);
    expect(decimals.len).toBe(1);
    expect(decimals.value[0]).toBe(6);

    const metadata = parseTokenMetadata(payload("metadata", '{"website":"https://example.test"}'));
    expect(metadata.applied).toBe(true);

    const uri = parseTokenMetadata(payload("tokenUri", "http://localhost:10020/constellations/orion"));
    expect(uri.applied).toBe(true);

    const trait = parseTokenMetadata(payload("magnitude", "1.77"));
    expect(trait.applied).toBe(true);
    expect(trait.keyText).toBe("magnitude");
    expect(isWellKnownKey("magnitude")).toBe(false);
    expect(isWellKnownKey("tokenUri")).toBe(true);

    // The four kind-byte values of §4.2, and only those four.
    for (const [byte, kind, storage] of [
      [0, "unshielded", "native"], [1, "shielded", "native"],
      [2, "unshielded", "ledger"], [3, "shielded", "ledger"],
    ] as const) {
      const p = parseTokenMetadata(payload("name", "x", byte));
      expect(p.applied).toBe(true);
      expect([p.kind, p.storage]).toEqual([kind, storage]);
    }

    // An empty value is legal for a trait: `len = 0`, everything NUL.
    const empty = parseTokenMetadata(payload("cleared", new Uint8Array(0)));
    expect(empty.applied).toBe(true);
    expect(empty.len).toBe(0);
    expect(empty.valueBytes).toHaveLength(0);

    // A 190-byte value is the maximum and must round-trip exactly.
    const full = new Uint8Array(190).fill(0xab);
    const parsedFull = parseTokenMetadata(payload("blob", full));
    expect(parsedFull.applied).toBe(true);
    expect(parsedFull.len).toBe(190);
    expect(Buffer.from(parsedFull.valueBytes).toString("hex")).toBe(Buffer.from(full).toString("hex"));
  });

  it("[[token-payload-rejections]] rejects every §4.2 violation with its own reason and never throws (except on a wrong-size payload)", () => {
    // size — the one failure that leaves nothing storable.
    expect(() => decodeTokenMetadata(new Uint8Array(255))).toThrow(PayloadSizeError);
    expect(() => parseTokenMetadata(new Uint8Array(257))).toThrow(/exactly 256 bytes, got 257/);

    // reserved kind bits (spec: bits 2-7 MUST be zero)
    expectReject(payload("name", "x", 0b0000_0100), "kind_reserved_bits");
    expectReject(payload("name", "x", 0xff), "kind_reserved_bits");

    // len > 190
    expectReject(payload("name", "abc", KIND_SHIELDED_NATIVE, 200), "len_too_large");

    // key that is not valid UTF-8, and a key with an interior NUL
    const badKey = new Uint8Array(32);
    badKey.set([0xff, 0xfe], 0);
    expectReject(encodeTokenMetadata({ domainSep: DOMAIN, kindByte: 1, key: badKey, value: "x" }), "key_not_utf8");
    const interiorNul = new Uint8Array(32);
    interiorNul.set(new TextEncoder().encode("na"), 0);
    interiorNul.set(new TextEncoder().encode("me"), 3); // byte 2 stays NUL
    expectReject(encodeTokenMetadata({ domainSep: DOMAIN, kindByte: 1, key: interiorNul, value: "x" }), "key_interior_nul");
    expectReject(encodeTokenMetadata({ domainSep: DOMAIN, kindByte: 1, key: new Uint8Array(32), value: "x" }), "key_empty");

    // name / symbol / decimals
    expectReject(payload("name", new Uint8Array(0)), "name_empty");
    expectReject(payload("name", new Uint8Array([0xc3, 0x28])), "name_not_utf8");
    expectReject(payload("symbol", new Uint8Array(0)), "symbol_empty");
    expectReject(payload("symbol", "S".repeat(33)), "symbol_too_long");
    expectReject(payload("symbol", new Uint8Array([0xe2, 0x28, 0xa1])), "symbol_not_utf8");
    expectReject(payload("decimals", new Uint8Array([6, 6])), "decimals_len");
    expectReject(payload("decimals", new Uint8Array(0)), "decimals_len");
    expectReject(payload("decimals", new Uint8Array([37])), "decimals_range");

    // metadata: too short, not JSON, JSON that is not an object
    expectReject(payload("metadata", "{"), "metadata_too_short");
    expectReject(payload("metadata", "not json"), "metadata_not_json_object");
    expectReject(payload("metadata", "[1,2]"), "metadata_not_json_object");
    expectReject(payload("metadata", '"a string"'), "metadata_not_json_object");

    // metadata parts: a malformed index is a malformed claim, not an anonymous trait
    expectReject(payload("metadata/01", "{"), "metadata_part_index");
    expectReject(payload("metadata/x", "{"), "metadata_part_index");
    expectReject(payload(`metadata/${MAX_METADATA_PARTS}`, "{"), "metadata_part_index");
    expect(parseTokenMetadata(payload(`metadata/${MAX_METADATA_PARTS - 1}`, "{")).applied).toBe(true);

    // tokenUri
    expectReject(payload("tokenUri", new Uint8Array(0)), "token_uri_empty");
    expectReject(payload("tokenUri", "/relative/path"), "token_uri_not_absolute_http");
    expectReject(payload("tokenUri", "ftp://example.test/x"), "token_uri_not_absolute_http");
    expectReject(payload("tokenUri", "javascript:alert(1)"), "token_uri_not_absolute_http");
  });

  it("[[token-payload-keys]] the key helpers behave exactly as the standard describes", () => {
    expect(metadataPartIndex("metadata/0")).toBe(0);
    expect(metadataPartIndex("metadata/15")).toBe(15);
    expect(metadataPartIndex("metadata/01")).toBeUndefined();
    expect(metadataPartIndex("metadata")).toBeUndefined();
    expect(metadataPartIndex("Metadata/0")).toBeUndefined();

    expect(isJsonObject("{}")).toBe(true);
    expect(isJsonObject('{"a":1}')).toBe(true);
    expect(isJsonObject("null")).toBe(false);
    expect(isJsonObject("[]")).toBe(false);

    expect(isAbsoluteHttpUrl("https://a.test/b?c=d")).toBe(true);
    expect(isAbsoluteHttpUrl("http://localhost:10020/cnst/orion")).toBe(true);
    expect(isAbsoluteHttpUrl("data:text/plain,hi")).toBe(false);
    expect(isAbsoluteHttpUrl("localhost:10020")).toBe(false);

    // Trailing junk after `len` is tolerated (documented leniency) and can never be projected.
    const bytes = encodeTokenMetadata({ domainSep: DOMAIN, kindByte: 1, key: "name", value: "ok", len: 2 });
    bytes[66 + 2] = 0x41; // an 'A' in the padding
    const parsed = parseTokenMetadata(bytes);
    expect(parsed.applied).toBe(true);
    expect(parsed.valueText).toBe("ok");
  });
});
