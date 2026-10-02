import { describe, expect, it } from "vitest";
import { pad32 } from "../color.js";
import {
  MAX_METADATA_PARTS,
  PayloadSizeError,
  LEGACY_EVENT_NAME,
  LEGACY_NAME_HEX,
  decodeTokenMetadata,
  encodeInteger,
  encodeTokenMetadata,
  integerOfValue,
  isAbsoluteHttpUrl,
  isAbsoluteUri,
  isJsonObject,
  isKindByte,
  isTokenMetadataName,
  isWellKnownKey,
  kindLabel,
  metadataPartIndex,
  parseTokenMetadata,
  privacyOfKind,
  projectionErrorFor,
  storageOfKind,
  valueTextOf,
  type ProjectionError,
  type RejectReason,
} from "../ingest/payload.js";

/**
 * The payload parser against the **superseded PR #315 draft** — `mip-xxxx:token-metadata[v1]`.
 *
 * Written by project 00021 (Phase A task A5) against §§1, 2, 2.1, 2.2, 3, 5.1 and Appendix A of
 * that draft, and kept verbatim by project 00023 Phase F: the reference contracts deployed on
 * Stagenet emit the draft name and are not being redeployed (owner decisions Q27/Q28), so the draft
 * validator has to keep working exactly as it did. **Every `parseLegacy` below judges its payload
 * under the draft's rules, which is what this file is for** — the final standard's suite is
 * `payload-0018.test.ts` next door, and `[[token-0018-legacy-pair]]` there is the test that puts
 * one byte string through both validators at once.
 *
 * Every payload here is hand-built with the module's own encoder, from the draft's table rather
 * than from any contract: this file proves the parser's RULES. `contract-fixtures.test.ts` proves
 * that the parser reads what the compiled reference contracts really emit, which is a different
 * claim.
 */

/** The variant every payload in this file is judged under (see the note above). */
const LEGACY = "legacy-mip-xxxx" as const;
const parseLegacy = (bytes: Uint8Array): ReturnType<typeof parseTokenMetadata> =>
  parseTokenMetadata(bytes, LEGACY);

const DOMAIN = pad32("umbra:sstar");
const KIND_SHIELDED_NATIVE = 1;

/** A payload with an explicit `val-type`, defaulting to 1 (UTF-8 string) for the text cases. */
function payload(
  key: string, value: string | Uint8Array,
  opts: { kindByte?: number; valType?: number; valLen?: number } = {},
): Uint8Array {
  return encodeTokenMetadata({
    domainSep: DOMAIN,
    kindByte: opts.kindByte ?? KIND_SHIELDED_NATIVE,
    key,
    valType: opts.valType ?? 1,
    valLen: opts.valLen,
    value,
  });
}

function expectReject(bytes: Uint8Array, reason: RejectReason): void {
  const parsed = parseLegacy(bytes);
  expect(parsed.applied, `expected ${reason}`).toBe(false);
  expect(parsed.rejectReason).toBe(reason);
  // A rejected event never carries a projection verdict: Appendix A is not consulted at all.
  expect(parsed.projectionError).toBeUndefined();
}

function expectProjectionError(bytes: Uint8Array, error: ProjectionError): void {
  const parsed = parseLegacy(bytes);
  // The whole point of MIP §5.3: the event is APPLIED and the trait is kept.
  expect(parsed.applied, `${error} must not reject the event`).toBe(true);
  expect(parsed.rejectReason).toBeUndefined();
  expect(parsed.projectionError).toBe(error);
}

describe("mip-xxxx:token-metadata[v1] payload — the superseded draft (owner Q27)", () => {
  it("[[token-payload-golden]] decodes the documented layout byte for byte, for every well-known key and for a plain trait", () => {
    // The event name is the version marker (MIP §1) and this is the byte string the MIP prints:
    // 27 bytes of name followed by five NULs.
    expect(LEGACY_EVENT_NAME).toBe("mip-xxxx:token-metadata[v1]");
    expect(LEGACY_NAME_HEX).toBe(
      "6d69702d787878783a746f6b656e2d6d657461646174615b76315d0000000000",
    );
    expect(Buffer.from(LEGACY_NAME_HEX, "hex")).toHaveLength(32);
    expect(Buffer.from(LEGACY_EVENT_NAME, "utf8")).toHaveLength(27);
    expect(isTokenMetadataName(LEGACY_NAME_HEX.toUpperCase())).toBe(true);
    // A future layout is a new NAME, never a reinterpretation of this one (MIP §8).
    expect(isTokenMetadataName(Buffer.from(pad32("mip-xxxx:token-metadata[v2]")).toString("hex"))).toBe(false);

    const name = payload("name", "Shielded Star");
    expect(name).toHaveLength(256);
    const decoded = decodeTokenMetadata(name, "legacy-mip-xxxx");
    expect(Buffer.from(decoded.domainSep).toString("hex")).toBe(Buffer.from(DOMAIN).toString("hex"));
    expect(decoded.kindByte).toBe(1);
    expect(decoded.privacy).toBe("shielded");
    expect(decoded.storage).toBe("native");
    expect(decoded.keyText).toBe("name");
    expect(decoded.keyHex).toBe(Buffer.from("name", "utf8").toString("hex"));
    expect(decoded.valType).toBe(1);
    expect(decoded.valLen).toBe("Shielded Star".length);
    expect(decoded.value).toHaveLength(189);
    expect(Buffer.from(decoded.valueBytes).toString("utf8")).toBe("Shielded Star");

    // The offsets of MIP §2's table, asserted literally rather than through the decoder.
    expect(Buffer.from(name.subarray(0, 32)).toString("hex")).toBe(Buffer.from(DOMAIN).toString("hex"));
    expect(name[32]).toBe(1);
    expect(Buffer.from(name.subarray(33, 65)).toString("hex")).toBe(Buffer.from(pad32("name")).toString("hex"));
    expect(name[65]).toBe(1);  // val-type
    expect(name[66]).toBe(13); // val-len
    expect(Buffer.from(name.subarray(67, 67 + 13)).toString("utf8")).toBe("Shielded Star");
    expect(name.subarray(67 + 13).every((b) => b === 0)).toBe(true);
    expect(32 + 1 + 32 + 1 + 1 + 189).toBe(256);

    const parsedName = parseLegacy(name);
    expect(parsedName.applied).toBe(true);
    expect(parsedName.valueText).toBe("Shielded Star");
    expect(parsedName.projectionError).toBeUndefined();

    const symbol = parseLegacy(payload("symbol", "SSTAR"));
    expect(symbol.applied).toBe(true);
    expect(symbol.keyText).toBe("symbol");
    expect(symbol.valueText).toBe("SSTAR");

    // Appendix A's `decimals` is val-type 2 — an unsigned big-endian integer, not a raw byte.
    const decimals = parseLegacy(payload("decimals", encodeInteger(6), { valType: 2 }));
    expect(decimals.applied).toBe(true);
    expect(decimals.projectionError).toBeUndefined();
    expect(decimals.valLen).toBe(1);
    expect(integerOfValue(decimals.valueBytes, LEGACY)).toBe("6");

    const metadata = parseLegacy(payload("metadata", '{"website":"https://example.test"}', { valType: 3 }));
    expect(metadata.applied).toBe(true);
    expect(metadata.projectionError).toBeUndefined();

    const uri = parseLegacy(payload("tokenUri", "http://localhost:10020/constellations/orion", { valType: 4 }));
    expect(uri.applied).toBe(true);
    expect(uri.projectionError).toBeUndefined();

    const trait = parseLegacy(payload("magnitude", "1.25"));
    expect(trait.applied).toBe(true);
    expect(trait.keyText).toBe("magnitude");
    expect(trait.projectionError).toBeUndefined(); // a trait has no Appendix A rule to break
    expect(isWellKnownKey("magnitude")).toBe(false);
    expect(isWellKnownKey("tokenUri")).toBe(true);

    // The four kind bytes of MIP §3, and only those four.
    for (const [byte, privacy, storage] of [
      [0, "unshielded", "native"], [1, "shielded", "native"],
      [2, "unshielded", "ledger"], [3, "shielded", "ledger"],
    ] as const) {
      const p = parseLegacy(payload("name", "x", { kindByte: byte }));
      expect(p.applied).toBe(true);
      expect([p.privacy, p.storage]).toEqual([privacy, storage]);
      expect([privacyOfKind(byte), storageOfKind(byte)]).toEqual([privacy, storage]);
      expect(isKindByte(byte)).toBe(true);
      expect(kindLabel(byte)).toBe(`${privacy} · ${storage}`);
    }
    expect(isKindByte(4)).toBe(false);
    expect(isKindByte(255)).toBe(false);

    // `val-len = 0` is "present, empty" at the transport level (MIP §6.2) — this is how a key is
    // unset, and it is not a rejection.
    const empty = parseLegacy(payload("cleared", new Uint8Array(0)));
    expect(empty.applied).toBe(true);
    expect(empty.valLen).toBe(0);
    expect(empty.valueBytes).toHaveLength(0);
    expect(empty.valueText).toBe("");

    // A 189-byte value is the maximum and must round-trip exactly.
    const full = new Uint8Array(189).fill(0xab);
    const parsedFull = parseLegacy(payload("blob", full, { valType: 0 }));
    expect(parsedFull.applied).toBe(true);
    expect(parsedFull.valLen).toBe(189);
    expect(Buffer.from(parsedFull.valueBytes).toString("hex")).toBe(Buffer.from(full).toString("hex"));
  });

  it("[[token-payload-valtype]] every val-type rule of MIP §2.1 decides acceptance, and the type decides how a value reads", () => {
    // 0 — opaque bytes: no rule at all, so bytes that are not UTF-8 are perfectly valid.
    const opaque = parseLegacy(payload("fingerprint", new Uint8Array([0xde, 0xad, 0xbe, 0xef]), { valType: 0 }));
    expect(opaque.applied).toBe(true);
    expect(opaque.valueText).toBeUndefined(); // surfaced as hex, never guessed at as text
    expect(valueTextOf(0, opaque.valueBytes)).toBeUndefined();

    // 1 — UTF-8 string: the bytes MUST decode.
    expect(parseLegacy(payload("label", "héllo")).applied).toBe(true);
    expectReject(payload("label", new Uint8Array([0xc3, 0x28])), "val_type_rule");

    // 2 — unsigned big-endian integer, 1..16 bytes. Both ends of the range reject.
    const wide = parseLegacy(payload("supply", encodeInteger(2n ** 127n, 16), { valType: 2 }));
    expect(wide.applied).toBe(true);
    expect(integerOfValue(wide.valueBytes, LEGACY)).toBe((2n ** 127n).toString(10));
    expectReject(payload("supply", new Uint8Array(0), { valType: 2 }), "val_type_rule");
    expectReject(payload("supply", new Uint8Array(17), { valType: 2 }), "val_type_rule");

    // 3 — UTF-8 JSON: valid UTF-8 is the transport rule; "does it parse" is the KEY's rule, which
    // is why a fragment of a `metadata/<n>` document is legal on the wire (Appendix A).
    expect(parseLegacy(payload("fragment", '{"half":', { valType: 3 })).applied).toBe(true);
    expectReject(payload("fragment", new Uint8Array([0xff]), { valType: 3 }), "val_type_rule");

    // 4 — absolute URI. Note it is NOT "http(s)" at the transport level: that is Appendix A's
    // narrower rule for `tokenUri` alone, and the difference is visible here.
    expect(parseLegacy(payload("mirror", "ftp://example.test/x", { valType: 4 })).applied).toBe(true);
    expect(isAbsoluteUri("ftp://example.test/x")).toBe(true);
    expect(isAbsoluteHttpUrl("ftp://example.test/x")).toBe(false);
    expectReject(payload("mirror", "/relative/path", { valType: 4 }), "val_type_rule");
    expectReject(payload("mirror", new Uint8Array(0), { valType: 4 }), "val_type_rule");

    // 5..255 — reserved, and every one of them rejects (MIP §2.1).
    for (const reserved of [5, 6, 7, 128, 254, 255]) {
      expectReject(payload("anything", "x", { valType: reserved }), "val_type_reserved");
    }

    // The type also decides how the API renders the value.
    expect(valueTextOf(1, new TextEncoder().encode("text"))).toBe("text");
    expect(valueTextOf(3, new TextEncoder().encode("{}"))).toBe("{}");
    expect(valueTextOf(4, new TextEncoder().encode("https://a.test"))).toBe("https://a.test");
    expect(valueTextOf(2, new Uint8Array([1, 0]))).toBeUndefined();
    expect(integerOfValue(new Uint8Array([1, 0]), LEGACY)).toBe("256");
    expect(integerOfValue(new Uint8Array(0), LEGACY)).toBe("0");
  });

  it("[[token-payload-rejections]] rejects every transport violation of MIP §2.2/§3/§5.1 with its own reason and never throws (except on an over-long payload)", () => {
    // Size: only a payload LONGER than 256 leaves nothing storable. A SHORT one is the same bytes
    // with their trailing NULs trimmed by the VM, so it is zero-extended (see payload.ts's header).
    expect(() => parseLegacy(new Uint8Array(257))).toThrow(PayloadSizeError);
    expect(() => parseLegacy(new Uint8Array(257))).toThrow(/at most 256 bytes, got 257/);
    const trimmed = payload("name", "ok").subarray(0, 69); // everything after byte 69 is NUL anyway
    const padded = parseLegacy(trimmed);
    expect(padded.applied).toBe(true);
    expect(padded.paddedFrom).toBe(69);
    expect(padded.payload).toHaveLength(256);
    expect(padded.valueText).toBe("ok");
    expect(Buffer.from(padded.payload).toString("hex")).toBe(Buffer.from(payload("name", "ok")).toString("hex"));
    expect(decodeTokenMetadata(payload("name", "ok"), "legacy-mip-xxxx").paddedFrom).toBeUndefined();

    // MIP §3: the kind byte takes exactly four values. The 00020 layout read the high bits as
    // flags; they are not flags, they are simply unknown kinds.
    expectReject(payload("name", "x", { kindByte: 4 }), "kind_unknown");
    expectReject(payload("name", "x", { kindByte: 0b0000_0100 }), "kind_unknown");
    expectReject(payload("name", "x", { kindByte: 0xff }), "kind_unknown");

    // MIP §2.2: val-len > 189.
    expectReject(payload("name", "abc", { valLen: 190 }), "val_len_too_long");
    expectReject(payload("name", "abc", { valLen: 255 }), "val_len_too_long");

    // MIP §2.2: a key that is all NUL is empty after trimming, and rejects.
    expectReject(
      encodeTokenMetadata({ domainSep: DOMAIN, kindByte: 1, key: new Uint8Array(32), valType: 1, value: "x" }),
      "key_empty",
    );
  });

  it("[[token-key-nonutf8]] a key is BYTES: non-UTF-8 and interior-NUL keys are accepted and keep their identity as hex (MIP §5.1)", () => {
    // "consumers MUST NOT reject a key solely for not being valid UTF-8 (they MAY display it as hex)"
    const badKey = new Uint8Array(32);
    badKey.set([0xff, 0xfe, 0x01], 0);
    const parsed = parseLegacy(
      encodeTokenMetadata({ domainSep: DOMAIN, kindByte: 1, key: badKey, valType: 1, value: "x" }),
    );
    expect(parsed.applied).toBe(true);
    expect(parsed.rejectReason).toBeUndefined();
    expect(parsed.keyText).toBeUndefined();
    expect(parsed.keyHex).toBe("fffe01");
    // A key with no text can never be well-known, so Appendix A has nothing to say about it.
    expect(parsed.projectionError).toBeUndefined();

    // An interior NUL is part of the key (only TRAILING NULs are trimmed). The bytes are kept; the
    // text is not, because a Postgres `text` column cannot hold a NUL.
    const interior = new Uint8Array(32);
    interior.set(new TextEncoder().encode("na"), 0);
    interior.set(new TextEncoder().encode("me"), 3); // byte 2 stays NUL
    const withNul = parseLegacy(
      encodeTokenMetadata({ domainSep: DOMAIN, kindByte: 1, key: interior, valType: 1, value: "x" }),
    );
    expect(withNul.applied).toBe(true);
    expect(withNul.keyText).toBeUndefined();
    expect(withNul.keyHex).toBe("6e61006d65");
    // …and it is a DIFFERENT key from `name`, which is the whole reason the identity is the bytes.
    expect(withNul.keyHex).not.toBe(parseLegacy(payload("name", "x")).keyHex);

    // Trailing NULs are trimmed, so the same key padded differently is the same key.
    expect(parseLegacy(payload("name", "x")).keyHex)
      .toBe(parseLegacy(payload("name", "y")).keyHex);
  });

  it("[[token-payload-projection]] Appendix A decides PROJECTION, never acceptance (MIP §5.3)", () => {
    // The wrong type for a well-known key: applied, trait kept, projection flagged.
    expectProjectionError(payload("decimals", "6"), "val_type_mismatch");
    expectProjectionError(payload("name", '{"a":1}', { valType: 3 }), "val_type_mismatch");
    expectProjectionError(payload("tokenUri", "https://a.test/x"), "val_type_mismatch");
    expectProjectionError(payload("metadata", "{}"), "val_type_mismatch");

    // The right type, a value Appendix A refuses.
    expectProjectionError(payload("name", new Uint8Array(0)), "name_len");
    expectProjectionError(payload("symbol", "S".repeat(33)), "symbol_len");
    expectProjectionError(payload("decimals", new Uint8Array([6, 6]), { valType: 2 }), "decimals_len");
    expectProjectionError(payload("decimals", encodeInteger(37), { valType: 2 }), "decimals_range");
    expectProjectionError(payload("metadata", "{", { valType: 3 }), "metadata_len");
    expectProjectionError(payload("metadata", "not json", { valType: 3 }), "metadata_not_json_object");
    expectProjectionError(payload("metadata", "[1,2]", { valType: 3 }), "metadata_not_json_object");
    expectProjectionError(payload("metadata", '"a string"', { valType: 3 }), "metadata_not_json_object");
    expectProjectionError(payload("tokenUri", "ftp://example.test/x", { valType: 4 }), "token_uri_not_absolute_http");
    // Note what CANNOT be reached here: an empty `tokenUri` under its own type 4 never becomes a
    // projection failure, because "" is not an absolute URI and MIP §2.1 rejects it at the
    // transport. Unsetting a `tokenUri` therefore means emitting it under another type, which is a
    // `val_type_mismatch` above. The MIP leaves that gap (Appendix A: "keys define their own
    // handling of empty values", and `tokenUri` does not).
    expectReject(payload("tokenUri", new Uint8Array(0), { valType: 4 }), "val_type_rule");

    // `metadata/<n>`: the index must be well formed and within Appendix A's 16 parts, and each part
    // must itself be type 3 — a part of another type is a trait under its own key and the assembly
    // waits for a real part.
    expectProjectionError(payload("metadata/01", "{", { valType: 3 }), "metadata_part_index");
    expectProjectionError(payload("metadata/x", "{", { valType: 3 }), "metadata_part_index");
    expectProjectionError(payload(`metadata/${MAX_METADATA_PARTS}`, "{", { valType: 3 }), "metadata_part_index");
    expectProjectionError(payload("metadata/2", "{"), "val_type_mismatch");
    const lastPart = parseLegacy(payload(`metadata/${MAX_METADATA_PARTS - 1}`, "{", { valType: 3 }));
    expect(lastPart.applied).toBe(true);
    expect(lastPart.projectionError).toBeUndefined();

    // A value that is valid UTF-8 but carries a NUL cannot go into a `text` column: kept as bytes,
    // flagged, never a crash. (This repository's own rule, documented as such.)
    const withNul = new Uint8Array([0x61, 0x00, 0x62]);
    expectProjectionError(payload("name", withNul), "text_not_storable");

    // And the direct form of the same function, for the callers that have no payload in hand.
    expect(projectionErrorFor("name", 1, 3, new TextEncoder().encode("abc"), LEGACY)).toBeUndefined();
    expect(projectionErrorFor(undefined, 1, 3, new TextEncoder().encode("abc"), LEGACY)).toBeUndefined();
    expect(projectionErrorFor("whatever", 0, 1, new Uint8Array([1]), LEGACY)).toBeUndefined();
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

    // Trailing junk after `val-len` is tolerated (MIP §2.2 tells the CONSUMER to ignore those bytes
    // and only asks the emitter to zero them) and can never be projected.
    const bytes = encodeTokenMetadata({ domainSep: DOMAIN, kindByte: 1, key: "name", valType: 1, value: "ok", valLen: 2 });
    bytes[67 + 2] = 0x41; // an 'A' in the padding
    const parsed = parseLegacy(bytes);
    expect(parsed.applied).toBe(true);
    expect(parsed.valueText).toBe("ok");
    expect(parsed.projectionError).toBeUndefined();
  });
});
