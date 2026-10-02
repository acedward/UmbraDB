import { CompactTypeUnsignedInteger, toBinaryRepr } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";
import { pad32 } from "../color.js";
import {
  LEGACY_EVENT_NAME,
  LEGACY_NAME_HEX,
  MAX_INTEGER_BYTES_0018,
  MAX_INTEGER_BYTES_LEGACY,
  MIP_0018_EVENT_NAME,
  MIP_0018_NAME_HEX,
  VAL_TYPE_NULL,
  encodeCompactUint,
  encodeInteger,
  encodeTokenMetadata,
  encodeTokenMetadataUc1,
  eventNameOf,
  PayloadSizeError,
  splitIntoParts,
  integerOfValue,
  isCompleteJsonValue,
  isTokenMetadataName,
  isValidJsonPointer,
  maxIntegerBytes,
  maxValType,
  nameHexOf,
  nameVariantOf,
  parseTokenMetadata,
  projectionErrorFor,
  type NameVariant,
  type ProjectionError,
  type RejectReason,
} from "../ingest/payload.js";

/**
 * **MIP-0018 (final)** — the transport rules of
 * `mips/mip-0018-on-chain-token-metadata.md` of
 * https://github.com/midnightntwrk/midnight-improvement-proposals/pull/325 @ `37a3471`, §§1, 2,
 * 2.1, 2.2, 5.1, 5.4, 6.2, 7.1, 8 and Appendix A.
 *
 * `payload.test.ts` next door is the same parser's suite for the SUPERSEDED PR #315 draft name, the
 * one the reference contracts on Stagenet were deployed with (owner decisions Q27/Q28). This file
 * is the standard's, and `[[token-0018-legacy-pair]]` at the end is the one test that puts single
 * byte strings through both validators at once — which is where the divergences are easiest to read.
 *
 * Every payload here is hand-built with the module's own encoder from the MIP's own tables, so what
 * is pinned is the RULE. The one exception is deliberate and is the point of
 * `[[token-0018-integer-endianness]]`: that test does not take the MIP's example bytes on trust
 * either, it derives them from `@midnight-ntwrk/compact-runtime` 0.19.0 — the runtime the MIP names
 * as normative for v1 — and asserts our encoder and decoder agree with it byte for byte.
 */

const DOMAIN = pad32("umbra:sstar");
const KIND_SHIELDED_NATIVE = 1;
const FINAL: NameVariant = "mip-0018";
const LEGACY: NameVariant = "legacy-mip-xxxx";

/** A MIP-0018 payload on the UC-1 layout (project 00024-01: 2-byte little-endian `val-len` at 66,
 *  value from 68, the fewest 256-byte parts that hold it), with an explicit `val-type` defaulting to
 *  1 (UTF-8 string) for the text cases. */
function payload(
  key: string | Uint8Array, value: string | Uint8Array,
  opts: { kindByte?: number; valType?: number; valLen?: number; parts?: number; trailing?: Uint8Array } = {},
): Uint8Array {
  return encodeTokenMetadataUc1({
    domainSep: DOMAIN,
    kindByte: opts.kindByte ?? KIND_SHIELDED_NATIVE,
    key,
    valType: opts.valType ?? 1,
    valLen: opts.valLen,
    value,
    parts: opts.parts,
    trailing: opts.trailing,
  });
}

/** The same declaration in the superseded DRAFT's layout (one-byte `val-len`, value from 67), for
 *  the assertions about what the draft name does with it. UC-1 made the two layouts differ, so a
 *  comparison across names now compares one declaration encoded twice, not one byte string. */
function legacyPayload(
  key: string | Uint8Array, value: string | Uint8Array,
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

/** A 32-byte key built from raw bytes, NUL-padded as the layout requires. */
function keyBytes(bytes: readonly number[]): Uint8Array {
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

const parse0018 = (bytes: Uint8Array): ReturnType<typeof parseTokenMetadata> =>
  parseTokenMetadata(bytes, FINAL);
const parseLegacy = (bytes: Uint8Array): ReturnType<typeof parseTokenMetadata> =>
  parseTokenMetadata(bytes, LEGACY);

function expectReject(bytes: Uint8Array, reason: RejectReason, label = ""): void {
  const parsed = parse0018(bytes);
  expect(parsed.applied, `${label} expected ${reason}`).toBe(false);
  expect(parsed.rejectReason, label).toBe(reason);
  // A rejected event never carries a projection verdict: the projection is not consulted at all.
  expect(parsed.projectionError, label).toBeUndefined();
}

function expectApplied(bytes: Uint8Array, label = ""): ReturnType<typeof parseTokenMetadata> {
  const parsed = parse0018(bytes);
  expect(parsed.applied, `${label} was rejected: ${parsed.rejectReason}`).toBe(true);
  expect(parsed.rejectReason, label).toBeUndefined();
  return parsed;
}

describe("mip-0018:token-metadata[v1] payload — the final standard (MIP PR #325)", () => {
  it("[[token-0018-name]] the standard's name is the version: its 32 bytes are the MIP's own literal, the draft name is a SECOND recognised transport, and every other name is ignored", () => {
    // MIP §1, verbatim: "the bytes 0x6d69702d303031383a746f6b656e2d6d657461646174615b76315d
    // followed by 5 NUL bytes".
    expect(MIP_0018_EVENT_NAME).toBe("mip-0018:token-metadata[v1]");
    expect(Buffer.from(MIP_0018_EVENT_NAME, "utf8")).toHaveLength(27);
    expect(MIP_0018_NAME_HEX).toBe(
      `${"6d69702d303031383a746f6b656e2d6d657461646174615b76315d"}${"00".repeat(5)}`,
    );
    expect(Buffer.from(MIP_0018_NAME_HEX, "hex")).toHaveLength(32);
    // The padding really is NUL and really is five bytes long — the name is 27 of 32.
    expect(Buffer.from(MIP_0018_NAME_HEX, "hex").subarray(27).every((b) => b === 0)).toBe(true);

    // Two names are recognised, and each maps to its own validator. Case is irrelevant: the
    // indexer lowercases hex but a caller need not.
    expect(nameVariantOf(MIP_0018_NAME_HEX)).toBe(FINAL);
    expect(nameVariantOf(MIP_0018_NAME_HEX.toUpperCase())).toBe(FINAL);
    expect(nameVariantOf(LEGACY_NAME_HEX)).toBe(LEGACY);
    expect(isTokenMetadataName(MIP_0018_NAME_HEX)).toBe(true);
    expect(isTokenMetadataName(LEGACY_NAME_HEX)).toBe(true);
    expect(eventNameOf(FINAL)).toBe(MIP_0018_EVENT_NAME);
    expect(eventNameOf(LEGACY)).toBe(LEGACY_EVENT_NAME);
    expect(nameHexOf(FINAL)).toBe(MIP_0018_NAME_HEX);
    expect(nameHexOf(LEGACY)).toBe(LEGACY_NAME_HEX);
    // The two are genuinely different bytes, so no event can be both.
    expect(MIP_0018_NAME_HEX).not.toBe(LEGACY_NAME_HEX);

    // MIP §8: "A future, incompatible layout uses a new name and never a reinterpretation of
    // mip-0018:token-metadata[v1]" — so `[v2]`, a future MIP's own name, and the pre-MIP name this
    // project itself shipped in 00020 are all simply ignored (MIP §1), not rejected.
    for (const other of [
      "mip-0018:token-metadata[v2]", "mip-yyyy:token-metadata[v1]", "mip-xxxx:token-metadata[v2]",
      "TokenMetadata", "mip-0018:token-metadata", "MIP-0018:token-metadata[v1]",
    ]) {
      const hex = Buffer.from(pad32(other)).toString("hex");
      expect(nameVariantOf(hex), other).toBeUndefined();
      expect(isTokenMetadataName(hex), other).toBe(false);
    }
  });

  it("[[token-0018-integer-endianness]] val-type 2 is Compact Uint<8*N> at 1..31 bytes, LITTLE-endian — pinned against @midnight-ntwrk/compact-runtime 0.19.0, not against the MIP's prose", () => {
    // ── The runtime is the authority (MIP §2, "with runtime 0.19.0, for v1") ─────────────────
    // Every claim below is derived from the package itself, so a runtime that changed its
    // serialization would fail this test rather than silently change what a `decimals` means.
    const runtime = (value: bigint, byteLength: number): Uint8Array => toBinaryRepr(
      new CompactTypeUnsignedInteger((1n << BigInt(8 * byteLength)) - 1n, byteLength), value,
    );
    const runtimeBack = (bytes: Uint8Array, byteLength: number): bigint =>
      new CompactTypeUnsignedInteger((1n << BigInt(8 * byteLength)) - 1n, byteLength)
        .fromValue([Buffer.from(bytes)] as never);

    const widths = [1, 2, 3, 16, MAX_INTEGER_BYTES_0018];
    for (const width of widths) {
      const values = [0n, 6n, 255n, 256n, 1_000_000n, (1n << BigInt(8 * width)) - 1n]
        .filter((v) => v < 1n << BigInt(8 * width));
      for (const value of values) {
        const label = `Uint<${8 * width}> of ${value}`;
        const ours = encodeCompactUint(value, width);
        expect(Buffer.from(ours).toString("hex"), label).toBe(
          Buffer.from(runtime(value, width)).toString("hex"),
        );
        expect(ours, label).toHaveLength(width);
        // Our decoder and the runtime's read the same bytes as the same number.
        expect(integerOfValue(ours, FINAL), label).toBe(value.toString(10));
        expect(runtimeBack(ours, width).toString(10), label).toBe(value.toString(10));
        // …and the value survives the whole payload, not just the helper.
        const parsed = expectApplied(payload("supply", ours, { valType: 2 }), label);
        expect(integerOfValue(parsed.valueBytes, FINAL), label).toBe(value.toString(10));
      }
    }

    // ── The MIP's Appendix A examples, byte for byte ─────────────────────────────────────────
    // "`decimals` | 2 integer | 16 | 6 as Uint<128> | 0x06000000000000000000000000000000"
    expect(Buffer.from(encodeCompactUint(6, 16)).toString("hex"))
      .toBe("06000000000000000000000000000000");
    // "`count` | 2 integer | 3 | 6 as Uint<24> | 0x060000"
    expect(Buffer.from(encodeCompactUint(6, 3)).toString("hex")).toBe("060000");
    // Which is the same as saying: the least significant byte comes FIRST.
    expect(Buffer.from(encodeCompactUint(256, 3)).toString("hex")).toBe("000100");
    expect(Buffer.from(encodeCompactUint(1_000_000, 4)).toString("hex")).toBe("40420f00");

    // ── And the two names disagree about these very bytes ────────────────────────────────────
    // This is the whole reason `integerOfValue` takes a variant: 0x0001 is 256 under the standard
    // and 1 under the draft, and nothing in the bytes says which.
    const twoBytes = new Uint8Array([0x00, 0x01]);
    expect(integerOfValue(twoBytes, FINAL)).toBe("256");
    expect(integerOfValue(twoBytes, LEGACY)).toBe("1");
    expect(integerOfValue(encodeInteger(256, 2), LEGACY)).toBe("256"); // the draft's own encoder

    // ── The permitted widths, and their ends ─────────────────────────────────────────────────
    // "1 ≤ val-len ≤ 31 … Consumers MUST accept every permitted width; Uint<128> is an emitter
    // default, not a decoder fallback."
    expect(maxIntegerBytes(FINAL)).toBe(31);
    expect(maxIntegerBytes(LEGACY)).toBe(16);
    expect(MAX_INTEGER_BYTES_0018).toBe(31);
    expect(MAX_INTEGER_BYTES_LEGACY).toBe(16);
    expectApplied(payload("supply", new Uint8Array(1), { valType: 2 }), "1 byte");
    expectApplied(payload("supply", new Uint8Array(31), { valType: 2 }), "31 bytes");
    expectReject(payload("supply", new Uint8Array(0), { valType: 2 }), "val_type_rule", "0 bytes");
    expectReject(payload("supply", new Uint8Array(32), { valType: 2 }), "val_type_rule", "32 bytes");
    // 17..31 bytes are what the draft could not carry and the standard can.
    expectApplied(payload("supply", new Uint8Array(17), { valType: 2 }), "17 bytes under the standard");
    expect(parseLegacy(legacyPayload("supply", new Uint8Array(17), { valType: 2 })).rejectReason)
      .toBe("val_type_rule");

    // ── What that means for the one integer this explorer projects ───────────────────────────
    // `decimals` emitted the recommended way — `Uint<128>`, 16 bytes — projects cleanly under the
    // standard, and the SAME bytes fail the draft's one-byte rule. Neither is a rejection.
    const sixteen = encodeCompactUint(6, 16);
    expect(projectionErrorFor("decimals", 2, 16, sixteen, FINAL)).toBeUndefined();
    expect(projectionErrorFor("decimals", 2, 16, sixteen, LEGACY)).toBe("decimals_len");
    // A width the draft never allowed is fine too, at either end of the range.
    expect(projectionErrorFor("decimals", 2, 31, encodeCompactUint(18, 31), FINAL)).toBeUndefined();
    expect(projectionErrorFor("decimals", 2, 1, encodeCompactUint(6, 1), FINAL)).toBeUndefined();
    // Out of the column's range is a PROJECTION failure, never a rejection: the trait stands.
    expect(projectionErrorFor("decimals", 2, 16, encodeCompactUint(37, 16), FINAL)).toBe("decimals_range");
    const huge = expectApplied(payload("decimals", encodeCompactUint((1n << 200n) - 1n, 31), { valType: 2 }));
    expect(huge.projectionError).toBe("decimals_range");
    // …and the number itself is still readable, as a decimal string and never a JSON number.
    expect(integerOfValue(huge.valueBytes, FINAL)).toBe(((1n << 200n) - 1n).toString(10));
  });

  it("[[token-0018-valtype-null]] val-type 5 is Null: val-len MUST be zero, every value byte is ignored, and it is distinct from an empty string — while the draft name rejects it outright", () => {
    expect(VAL_TYPE_NULL).toBe(5);
    expect(maxValType(FINAL)).toBe(5);
    expect(maxValType(LEGACY)).toBe(4);

    const nulled = expectApplied(payload("name", new Uint8Array(0), { valType: 5 }));
    expect(nulled.valType).toBe(5);
    expect(nulled.valLen).toBe(0);
    expect(nulled.valueBytes).toHaveLength(0);
    // "Type 5 is an explicit null value, distinct from an empty string or byte sequence" — so it
    // has no text at all, not the empty string.
    expect(nulled.valueText).toBeUndefined();
    // …and it CLEARS its key rather than projecting anything: there is no value to reject.
    expect(nulled.clears).toBe(true);
    expect(nulled.projectionError).toBeUndefined();

    // "consumers MUST ignore all … value bytes" — a Null carrying junk is still a valid Null. Under
    // UC-1 the value field starts at 68 (the two `val-len` bytes are 66–67).
    const junk = payload("name", new Uint8Array(0), { valType: 5, valLen: 0 });
    junk.fill(0x41, 68); // 188 bytes of 'A' in a field the standard says carries no meaning
    const withJunk = expectApplied(junk, "Null with junk in the ignored bytes");
    expect(withJunk.clears).toBe(true);
    expect(withJunk.valueBytes).toHaveLength(0);

    // "`val-len` MUST be zero" — reported as `val_type_rule`, the one reason MIP §2.2 gives for
    // every per-type value rule, which is also the string the reference contracts' negative corpus
    // records for this case (`fixtures/contracts/negative-payloads.json`).
    expectReject(payload("name", "x", { valType: 5, valLen: 1 }), "val_type_rule");
    expectReject(payload("name", new Uint8Array(189), { valType: 5, valLen: 189 }), "val_type_rule");

    // Null clears EVERY key, including the ones this explorer projects, and never flags one.
    for (const key of ["name", "symbol", "decimals", "metadata", "tokenUri", "anything"]) {
      const cleared = expectApplied(payload(key, new Uint8Array(0), { valType: 5 }), key);
      expect(cleared.clears, key).toBe(true);
      expect(cleared.projectionError, key).toBeUndefined();
    }

    // The contrast the MIP draws in §6.2: "A zero-length string or opaque byte sequence is present
    // and empty, not Null."
    const emptyString = expectApplied(payload("name", new Uint8Array(0), { valType: 1 }));
    expect(emptyString.clears).toBe(false);
    expect(emptyString.valueText).toBe("");
    const emptyBytes = expectApplied(payload("blob", new Uint8Array(0), { valType: 0 }));
    expect(emptyBytes.clears).toBe(false);

    // Under the draft name 5 is reserved, so the very same payload is rejected and no value — not
    // even a cleared one — is ever recorded for it.
    const legacyNull = parseLegacy(legacyPayload("name", new Uint8Array(0), { valType: 5 }));
    expect(legacyNull.applied).toBe(false);
    expect(legacyNull.rejectReason).toBe("val_type_reserved");
    expect(legacyNull.clears).toBe(false);
  });

  it("[[token-0018-json-complete]] val-type 3 must be ONE complete RFC 8259 value — scalars included, fragments rejected — where the draft asked only for valid UTF-8", () => {
    // "object, array and scalar values are allowed"
    for (const text of [
      "{}", '{"a":1}', '{"description":"Example"}', "[]", "[1,2]", '["a",{"b":[true,null]}]',
      "6", "-1.5e10", '"a string"', "true", "false", "null", '{"nested":{"deep":[1,2,3]}}',
      '"\\u00e9"', '{"unicode":"héllo"}',
    ]) {
      const parsed = expectApplied(payload("metadata", text, { valType: 3 }), text);
      expect(parsed.valueText, text).toBe(text);
      expect(isCompleteJsonValue(new TextEncoder().encode(text)), text).toBe(true);
    }

    // "A recognized event that fails any transport rule MUST be rejected" — a fragment is exactly
    // that, and it is the rule that makes the draft's `metadata/<n>` assembly impossible here.
    for (const text of [
      '{"half":', "{", "}", "[1,", "1,2", "{}{}", '{"a":1} trailing', "", " ", "NaN", "undefined",
      "'single'", "{a:1}", '{"a":1,}', "[1,2,]", "01", "+1", ".5", "tru",
    ]) {
      expectReject(payload("metadata", text, { valType: 3 }), "val_type_rule", `type 3 ${JSON.stringify(text)}`);
      expect(isCompleteJsonValue(new TextEncoder().encode(text)), text).toBe(false);
    }
    // Bytes that are not UTF-8 at all cannot be JSON either.
    expectReject(payload("metadata", new Uint8Array([0xff]), { valType: 3 }), "val_type_rule");
    expect(isCompleteJsonValue(new Uint8Array([0xc3, 0x28]))).toBe(false);

    // The draft accepted every one of those fragments, which is what let a document be split
    // across events — and is why dropping that convention needed this rule, not a key convention.
    expect(parseLegacy(legacyPayload("metadata/0", '{"half":', { valType: 3 })).applied).toBe(true);
    expect(parseLegacy(legacyPayload("metadata", "", { valType: 3, valLen: 0 })).applied).toBe(true);

    // A transport-valid value whose SHAPE this explorer's column cannot hold is flagged, never
    // rejected (MIP §5.2, §7.1: "Accept as a typed declaration"; shape rules "belong to a
    // metadata-specific MIP").
    for (const scalar of ["6", '"a string"', "true", "null", "[1,2]"]) {
      const parsed = expectApplied(payload("metadata", scalar, { valType: 3 }), scalar);
      expect(parsed.projectionError, scalar).toBe("metadata_not_json_object");
    }
    expect(expectApplied(payload("metadata", '{"a":1}', { valType: 3 })).projectionError).toBeUndefined();
    // …and a complete JSON value under an unknown key has no rule to break at all.
    expect(expectApplied(payload("anything", "6", { valType: 3 })).projectionError).toBeUndefined();
  });

  it("[[token-0018-pointer-keys]] a key beginning /metadata/ MUST be a valid RFC 6901 pointer or the event rejects; every other key stays bytes and is never rejected for its spelling", () => {
    // §5.1's accepted forms, including the ones a reader might expect to be special and is told
    // are not: `*` is a literal property token, a trailing empty token is legal, and a nested path
    // implies no assembly.
    for (const key of [
      "/metadata/0", "/metadata/", "/metadata/*", "/metadata/name", "/metadata/x/y/z",
      "/metadata/a~0b", "/metadata/a~1b", "/metadata/~0", "/metadata/~1", "/metadata/~0~1~0",
      "/metadata/0/1", "/metadata/ ", "/metadata/héllo",
    ]) {
      const parsed = expectApplied(payload(key, "x"), key);
      expect(parsed.keyText, key).toBe(key);
      // A pointer key is an ordinary trait: the standard defines no target document and no
      // assembly, so nothing is projected from it and nothing is flagged.
      expect(parsed.projectionError, key).toBeUndefined();
    }

    // "any other `~` escape is invalid and MUST cause rejection"
    for (const key of [
      "/metadata/a~2b", "/metadata/~", "/metadata/~x", "/metadata/a~", "/metadata/~~",
      "/metadata/x/~9", "/metadata/~0~", "/metadata/~2",
    ]) {
      expectReject(payload(key, "x"), "key_pointer_invalid", key);
    }
    // `~0~` is a valid escape followed by a dangling one — the loop must not stop at the first.
    expect(parse0018(payload("/metadata/~0~", "x")).rejectReason).toBe("key_pointer_invalid");
    // The pointer keys MUST be valid UTF-8; every other key need not be, so the prefix is matched
    // on the BYTES and a broken sequence after it is a rejection rather than an unspellable trait.
    expectReject(
      payload(keyBytes([0x2f, 0x6d, 0x65, 0x74, 0x61, 0x64, 0x61, 0x74, 0x61, 0x2f, 0xff, 0xfe]), "x"),
      "key_pointer_invalid", "/metadata/ + invalid UTF-8",
    );

    // ── What is NOT a pointer key ────────────────────────────────────────────────────────────
    // The rule is keyed on the exact prefix `/metadata/`. A `~2` anywhere else is just a byte.
    for (const key of [
      "metadata/a~2b", "/metadata", "/metadatax/~2", "/meta/~2", "metadata~2", "~2",
      "x/metadata/~2", "/Metadata/~2",
    ]) {
      const parsed = expectApplied(payload(key, "x"), key);
      expect(parsed.keyText, key).toBe(key);
    }
    // And MIP §5.1's other half: "consumers MUST NOT reject another key solely for invalid UTF-8".
    const nonUtf8 = expectApplied(payload(keyBytes([0xff, 0xfe, 0x01]), "x"), "non-UTF-8 key");
    expect(nonUtf8.keyText).toBeUndefined();
    expect(nonUtf8.keyHex).toBe("fffe01");
    // An interior NUL is part of the key and keeps it valid, text or no text.
    const interior = expectApplied(payload(keyBytes([0x6e, 0x61, 0x00, 0x6d, 0x65]), "x"), "interior NUL");
    expect(interior.keyText).toBeUndefined();
    expect(interior.keyHex).toBe("6e61006d65");

    // The draft had no pointer rule at all, so every rejected key above is an ordinary trait there.
    for (const key of ["/metadata/a~2b", "/metadata/~", "/metadata/~2"]) {
      expect(parseLegacy(legacyPayload(key, "x")).applied, `${key} under the draft`).toBe(true);
    }

    // The syntax helper on its own, including the two forms a payload can never carry.
    expect(isValidJsonPointer("")).toBe(true);         // the whole-document pointer
    expect(isValidJsonPointer("/")).toBe(true);        // one empty reference token
    expect(isValidJsonPointer("/a/b")).toBe(true);
    expect(isValidJsonPointer("/a~0b")).toBe(true);
    expect(isValidJsonPointer("/a~1b")).toBe(true);
    expect(isValidJsonPointer("a")).toBe(false);       // a pointer must start with "/"
    expect(isValidJsonPointer("/a~")).toBe(false);
    expect(isValidJsonPointer("/a~2")).toBe(false);
  });

  it("[[token-0018-reserved]] val-type 6..255 is reserved and rejects, 5 no longer is, and the draft's own reserved range still starts at 5", () => {
    // MIP §2.1: "`6` to `255` | reserved | MUST reject the event", and §8: "Assigning a reserved
    // datatype or kind … requires a new event version."
    for (const reserved of [6, 7, 8, 42, 128, 254, 255]) {
      expectReject(payload("anything", "x", { valType: reserved }), "val_type_reserved", `type ${reserved}`);
    }
    // 5 is Null now, not reserved — the one boundary this change moved.
    expect(parse0018(payload("anything", new Uint8Array(0), { valType: 5 })).rejectReason).toBeUndefined();
    // …while under the draft name the range is still 5..255, so 5 and 6 reject alike there.
    for (const reserved of [5, 6, 255]) {
      const legacy = parseLegacy(legacyPayload("anything", "x", { valType: reserved }));
      expect(legacy.applied, `draft type ${reserved}`).toBe(false);
      expect(legacy.rejectReason, `draft type ${reserved}`).toBe("val_type_reserved");
    }
    // A reserved type is decided BEFORE the value, so a reserved type with an impossible length
    // still reports the type: one payload, two faults, one stable reason.
    expectReject(payload("anything", "x", { valType: 200, valLen: 250 }), "val_type_reserved");
    // The kind byte's own reserved range is untouched by all of this (MIP §3: four values).
    expectReject(payload("name", "x", { kindByte: 4 }), "kind_unknown");
    expectReject(payload("name", "x", { kindByte: 255 }), "kind_unknown");
  });

  it("[[token-0018-legacy-pair]] one declaration, two names: every rule the final standard moved (and, since UC-1, its layout), read off the same declaration encoded for each name", () => {
    /** One DECLARATION — the same key, type and value — encoded in each name's layout, parsed
     *  under that name, and the pair of verdicts reported. Since UC-1 (project 00024-01) the two
     *  names no longer share a layout, so this compares one declaration, not one byte string. */
    type Declaration = [key: string | Uint8Array, value: string | Uint8Array, opts?: { valType?: number; valLen?: number }];
    const encodeBoth = (...d: Declaration): { final: Uint8Array; legacy: Uint8Array } =>
      ({ final: payload(...d), legacy: legacyPayload(...d) });
    const both = (bytes: { final: Uint8Array; legacy: Uint8Array }): {
      final: { applied: boolean; reason: RejectReason | undefined; projection: ProjectionError | undefined };
      legacy: { applied: boolean; reason: RejectReason | undefined; projection: ProjectionError | undefined };
    } => {
      const f = parse0018(bytes.final);
      const l = parseLegacy(bytes.legacy);
      // Whatever the verdicts, the DECLARATION is the same one: same key, type, length and value.
      expect(f.keyHex).toBe(l.keyHex);
      expect(f.valType).toBe(l.valType);
      expect(f.valLen).toBe(l.valLen);
      expect(Buffer.from(f.valueBytes).toString("hex")).toBe(Buffer.from(l.valueBytes).toString("hex"));
      // …and the layouts differ exactly where UC-1 changed them: the first 66 bytes are shared,
      // then the draft has a one-byte `val-len` at 66 and the value at 67, the standard a two-byte
      // little-endian one at 66–67 and the value at 68.
      expect(Buffer.from(bytes.final.subarray(0, 66)).toString("hex"))
        .toBe(Buffer.from(bytes.legacy.subarray(0, 66)).toString("hex"));
      expect(bytes.final[66]! | (bytes.final[67]! << 8)).toBe(bytes.legacy[66]);
      expect(f.nameVariant).toBe(FINAL);
      expect(l.nameVariant).toBe(LEGACY);
      return {
        final: { applied: f.applied, reason: f.rejectReason, projection: f.projectionError },
        legacy: { applied: l.applied, reason: l.rejectReason, projection: l.projectionError },
      };
    };

    // (0) The layout change itself: the SAME 256 bytes are two different declarations. A draft
    //     payload whose value starts with 'S' reads under UC-1 as a `val-len` whose high byte is
    //     0x53 — far past one part — so the standard rejects it and the draft applies it.
    const draftBytes = legacyPayload("name", "Shielded Star");
    expect(parseLegacy(draftBytes).valueText).toBe("Shielded Star");
    const misread = parse0018(draftBytes);
    expect(misread.valLen).toBe(13 | (0x53 << 8));
    expect(misread.rejectReason).toBe("val_len_beyond_package");

    // (1) A `decimals` emitted the standard's recommended way. Both accept the bytes — 16 is
    //     within either width limit — and then they disagree about what they SAY: 6 under the
    //     standard, 6·2^120 under the draft, which is why the draft's one-byte projection rule is
    //     the thing that stops the wrong number reaching a column.
    const decimals = encodeBoth("decimals", encodeCompactUint(6, 16), { valType: 2 });
    expect(both(decimals)).toEqual({
      final: { applied: true, reason: undefined, projection: undefined },
      legacy: { applied: true, reason: undefined, projection: "decimals_len" },
    });
    expect(integerOfValue(parse0018(decimals.final).valueBytes, FINAL)).toBe("6");
    expect(integerOfValue(parseLegacy(decimals.legacy).valueBytes, LEGACY))
      .toBe((6n << 120n).toString(10));

    // (2) A JSON fragment: the draft's whole multipart convention rested on this being legal.
    const fragment = encodeBoth("metadata/0", '{"description":"a ne', { valType: 3 });
    expect(both(fragment)).toEqual({
      final: { applied: false, reason: "val_type_rule", projection: undefined },
      legacy: { applied: true, reason: undefined, projection: undefined },
    });

    // (3) Null: an explicit clear under the standard, a reserved type under the draft.
    const cleared = encodeBoth("name", new Uint8Array(0), { valType: 5 });
    expect(both(cleared)).toEqual({
      final: { applied: true, reason: undefined, projection: undefined },
      legacy: { applied: false, reason: "val_type_reserved", projection: undefined },
    });
    expect(parse0018(cleared.final).clears).toBe(true);

    // (4) A pointer key with a bad escape: a rejection under the standard, a plain trait before it.
    const badPointer = encodeBoth("/metadata/a~2b", "x");
    expect(both(badPointer)).toEqual({
      final: { applied: false, reason: "key_pointer_invalid", projection: undefined },
      legacy: { applied: true, reason: undefined, projection: undefined },
    });

    // (5) A 31-byte integer: the standard's widest permitted width, wider than the draft allowed.
    const wide = encodeBoth("supply", encodeCompactUint((1n << 240n) + 7n, 31), { valType: 2 });
    expect(both(wide)).toEqual({
      final: { applied: true, reason: undefined, projection: undefined },
      legacy: { applied: false, reason: "val_type_rule", projection: undefined },
    });

    // (6) A `metadata/<n>` key with a complete document: a malformed part name under the draft,
    //     an ordinary trait under the standard, whose long values are [Y] packages, not keys.
    const partish = encodeBoth("metadata/99", '{"a":1}', { valType: 3 });
    expect(both(partish)).toEqual({
      final: { applied: true, reason: undefined, projection: undefined },
      legacy: { applied: true, reason: undefined, projection: "metadata_part_index" },
    });

    // (7) …and the case that makes all of the above worth stating: the overwhelming majority of
    //     declarations mean exactly the same thing under both names, which is what keeps the
    //     already-deployed reference contracts displaying correctly.
    for (const same of [
      encodeBoth("name", "Shielded Star"),
      encodeBoth("symbol", "SSTAR"),
      encodeBoth("decimals", encodeInteger(6, 1), { valType: 2 }),
      encodeBoth("metadata", '{"website":"https://example.test"}', { valType: 3 }),
      encodeBoth("tokenUri", "https://example.test/token.json", { valType: 4 }),
      encodeBoth("magnitude", "1.25"),
      encodeBoth("fingerprint", new Uint8Array([0xde, 0xad]), { valType: 0 }),
    ]) {
      const pair = both(same);
      expect(pair.final).toEqual(pair.legacy);
      expect(pair.final.applied).toBe(true);
      const f = parse0018(same.final);
      const l = parseLegacy(same.legacy);
      expect(f.valueText).toBe(l.valueText);
      if (f.valType === 2) {
        // A one-byte integer is the fixed point of the endianness change: the two readings
        // coincide, which is exactly why the deployed contracts' `decimals` still reads as 6.
        expect(integerOfValue(f.valueBytes, FINAL)).toBe(integerOfValue(l.valueBytes, LEGACY));
      }
    }
  });
  it("[[multipart-0018-rules]] UC-1, every rule both ways: a 2-byte little-endian val-len (Compact Uint<16>), 188 value bytes in one part and 189 rejected, any length in more parts, beyond the package rejected with the declared length kept, bytes after the value ignored, Null, reserved types and pointer keys unchanged, the draft untouched", () => {
    // ── The layout: val-len is Compact's Uint<16>, pinned against the runtime (UC-1) ──────────
    const uint16 = (n: number): string => Buffer.from(toBinaryRepr(
      new CompactTypeUnsignedInteger(65_535n, 2), BigInt(n),
    )).toString("hex");
    for (const n of [0, 1, 188, 189, 255, 256, 700, 32_767, 32_768, 65_535]) {
      const bytes = payload("blob", new Uint8Array(0), { valType: 0, valLen: n, parts: 257 });
      expect(Buffer.from(bytes.subarray(66, 68)).toString("hex"), `val-len ${n}`).toBe(uint16(n));
      expect(parse0018(bytes).valLen, `val-len ${n}`).toBe(n);
    }
    expect(uint16(700)).toBe("bc02"); // the low byte first

    // ── One part: 188 value bytes, and not one more ───────────────────────────────────────────
    const full = expectApplied(payload("description", "a".repeat(188)), "188 bytes in one part");
    expect(full.parts).toBe(1);
    expect(full.payload).toHaveLength(256);
    expect(full.valueBytes).toHaveLength(188);
    // 189 declared in one part runs one byte past the package: rejected, the declared length kept.
    const over = parse0018(payload("description", "a".repeat(188), { valLen: 189, parts: 1 }));
    expect(over.rejectReason).toBe("val_len_beyond_package");
    expect(over.valLen).toBe(189);
    // …while the same 189 bytes in two parts are an ordinary declaration.
    const two = expectApplied(payload("description", "a".repeat(189)), "189 bytes in two parts");
    expect(two.parts).toBe(2);
    expect(two.valueBytes).toHaveLength(189);

    // ── Any length within the package (Q5: the reader sets no limit of its own) ───────────────
    const doc = JSON.stringify({ description: "d".repeat(640), website: "https://example.test" });
    expect(Buffer.byteLength(doc)).toBeGreaterThan(600);
    const long = expectApplied(payload("metadata", doc, { valType: 3 }), "a ~700-byte JSON document");
    expect(long.parts).toBe(3);
    expect(long.valueText).toBe(doc);
    expect(long.projectionError).toBeUndefined();
    const four = expectApplied(payload("description", "q".repeat(400)), "~400 bytes");
    expect(four.parts).toBe(2);
    const kb = expectApplied(payload("notes", "k".repeat(5_000)), "several KB");
    expect(kb.parts).toBe(20);
    expect(kb.valueBytes).toHaveLength(5_000);
    // The largest value the field can declare: 65 535 bytes, 257 parts.
    const max = expectApplied(payload("blob", new Uint8Array(65_535).fill(7), { valType: 0 }), "65 535 bytes");
    expect(max.parts).toBe(257);
    expect(max.valueBytes).toHaveLength(65_535);
    // …and the same declared length in one part fewer is beyond the package.
    const short = parse0018(payload("blob", new Uint8Array(65_536 - 68 - 256).fill(7), { valType: 0, valLen: 65_535, parts: 256 }));
    expect(short.rejectReason).toBe("val_len_beyond_package");
    expect(short.valLen).toBe(65_535);
    expect(short.valueBytes).toHaveLength(256 * 256 - 68); // clamped to what the package holds

    // ── Beyond the package, in a multi-part package ───────────────────────────────────────────
    const beyond = parse0018(payload("description", "b".repeat(444), { valLen: 600, parts: 2 }));
    expect(beyond.applied).toBe(false);
    expect(beyond.rejectReason).toBe("val_len_beyond_package");
    expect(beyond.valLen).toBe(600);
    expect(beyond.valueBytes).toHaveLength(444);
    // Exactly filling the package is fine: 68 + 444 = 512.
    expect(expectApplied(payload("description", "b".repeat(444), { parts: 2 })).valueBytes).toHaveLength(444);

    // ── Bytes after the value are ignored (MIP-0018 §2.2; spec Q11) ───────────────────────────
    // A publisher that put two declarations in one intent (breaking [Y] §5 and UC-1's one
    // declaration per intent) produces ONE package: the first declaration followed by the second
    // one's bytes. The first is applied; the second is not a declaration at all.
    const name = payload("name", "Shielded Star");
    const symbol = payload("symbol", "SSTAR");
    const merged = new Uint8Array(512);
    merged.set(name, 0);
    merged.set(symbol, 256);
    const firstOnly = expectApplied(merged, "two declarations merged into one package");
    expect(firstOnly.keyText).toBe("name");
    expect(firstOnly.valueText).toBe("Shielded Star");
    expect(firstOnly.parts).toBe(2);
    // Non-zero junk right after the value, in the same part, is ignored the same way.
    const junk = expectApplied(payload("name", "ok", { trailing: new Uint8Array(30).fill(0x5a) }), "junk after the value");
    expect(junk.valueText).toBe("ok");

    // ── The other rules, unchanged, now on packages ───────────────────────────────────────────
    // Null: val-len 0, in one part or in a larger package; any other length is the Null rule.
    expect(expectApplied(payload("description", new Uint8Array(0), { valType: 5 })).clears).toBe(true);
    expect(expectApplied(payload("description", new Uint8Array(0), { valType: 5, parts: 2 })).clears).toBe(true);
    expectReject(payload("description", "x", { valType: 5, valLen: 1 }), "val_type_rule", "Null with val-len 1");
    // Reserved types reject, and the TYPE is decided before the length: a reserved type with a
    // length past the package still reports the type.
    expectReject(payload("anything", "x".repeat(300), { valType: 6 }), "val_type_reserved", "type 6 in two parts");
    expectReject(payload("anything", "x", { valType: 200, valLen: 60_000 }), "val_type_reserved", "type 200, val-len past the package");
    // Pointer keys: the rule is about the key, whatever the value's length.
    expectReject(payload("/metadata/~2", "p".repeat(300)), "key_pointer_invalid", "bad pointer, long value");
    expect(expectApplied(payload("/metadata/description", "p".repeat(300))).keyText).toBe("/metadata/description");
    // Integers keep their 1..31-byte rule inside a package.
    expectApplied(payload("supply", encodeCompactUint(6, 16), { valType: 2, parts: 2 }), "Uint<128> in two parts");
    expectReject(payload("supply", new Uint8Array(32), { valType: 2 }), "val_type_rule", "32-byte integer");
    // JSON must still be ONE complete value — a long fragment is still a fragment.
    expectReject(payload("metadata", `{"description":"${"f".repeat(400)}`, { valType: 3 }), "val_type_rule", "long fragment");

    // ── A package is 256 · k bytes; anything else is not a package ────────────────────────────
    for (const size of [0, 1, 255, 257, 300, 511]) {
      expect(() => parse0018(new Uint8Array(size)), `${size} bytes`).toThrow(PayloadSizeError);
    }
    // splitIntoParts is the publisher's side: the parts, in order, that a reader concatenates back.
    const parts = splitIntoParts(long.payload);
    expect(parts).toHaveLength(3);
    expect(Buffer.concat(parts).toString("hex")).toBe(Buffer.from(long.payload).toString("hex"));

    // ── The draft name is untouched (FR-006) ──────────────────────────────────────────────────
    // One event, one-byte val-len, `val_len_too_long` above 189, a short payload zero-extended.
    expect(parseLegacy(legacyPayload("name", "x", { valLen: 190 })).rejectReason).toBe("val_len_too_long");
    expect(parseLegacy(legacyPayload("name", "a".repeat(189))).applied).toBe(true);
    expect(parseLegacy(legacyPayload("name", "ok").subarray(0, 69)).paddedFrom).toBe(69);
    expect(() => parseLegacy(new Uint8Array(512))).toThrow(PayloadSizeError);
  });
});
