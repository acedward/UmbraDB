import { describe, expect, it } from "vitest";
import {
  assertSupportedProtocolVersion,
  callIndicesForProtocolVersion,
  classifyExtrinsic,
  decodeBlockTimestampMs,
  decodeCompactU32,
  decodeMidnightExtrinsic,
  decodeProtocolVersionFromDigest,
  isSupportedProtocolVersion,
  requireCallIndices,
} from "../../chain-archive-sync/extrinsic-decoder.js";

/** The verified node-1.0.x call indices every fixture in this file was captured from. */
const V1 = callIndicesForProtocolVersion(1_000_000)!;

/**
 * Fixtures are REAL bytes captured live from the sprint-9 compose devnet
 * (`midnightntwrk/midnight-node:1.0.0`, network `undeployed`) via `chain_getBlock` /
 * `chain_getHeader` -- not synthesized. Each is annotated with its block/index of origin so a
 * future capture can refresh them against a newer node.
 */

// Genesis (height 0) extrinsic 0: bare v5, pallet 6 (MidnightSystem), call 0,
// 41-byte `midnight:system-transaction[v6]:` payload.
const GENESIS_SYSTEM_TX_EXTRINSIC =
  "0xb4050600a46d69646e696768743a73797374656d2d7472616e73616374696f6e5b76365d3a050f0080c6a47e8d03";

// Genesis (height 0) extrinsic 4: bare v5, pallet 5 (Midnight), call 0, 219-byte
// `midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1])` payload.
const GENESIS_REGULAR_TX_EXTRINSIC =
  "0x81030505006d036d69646e696768743a7472616e73616374696f6e5b76395d287369676e61747572655b76315d2c70726f6f662c706564657273656e2d7363686e6f72725b76315d293a040051020128756e6465706c6f7965640b00203d88792d86f71b8a7a21bfe16a2bb2eab74475073fa5b773854f151ed548dba77a2c58157815f0843fc0701ec174828174fbc4e03d122b40fe97741dd131c92658f533496e48e284ce47644a1d68449ce51b8e20a4c624566827c2f437120e31ec4e628b94c4bcb7dec5a1dbd186677de26fdcacb19130f4126359efe37f471bb9c2496900";

// Height-45 extrinsic 0: bare v5 Timestamp::set inherent -- NOT a midnight call.
const TIMESTAMP_INHERENT = "0x280501000be07b93d89f01";

// Height-45 extrinsic 1: bare v5, pallet 13 -- some other pallet's inherent, no midnight tag.
const OTHER_PALLET_INHERENT =
  "0xd0050d0000293e9d31fedc4796468a6bcc4e6d7f7b4368fbfc3bf5e01cb96988f0f0886764ddc13c00100e44009c01000002000000";

// Height-45 extrinsic 3 HEAD (the full extrinsic is ~14kB; the envelope + tag prefix is all the
// decoder inspects before the payload subarray, and the trailing bytes are opaque payload).
// Bare v4 (wallet-submitted), pallet 5, call 0. Reconstructed as: real captured 9-byte envelope
// `6dd804050059d8` + real captured payload head + padding to the exact declared length.
function height45WalletExtrinsic(): string {
  const envelope = "6dd8040500" + "59d8"; // compact total-len 13851 | v4 | pallet 5 | call 0 | compact arg-len 13846
  const tagHead = Buffer.from(
    "midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1]):",
    "latin1",
  ).toString("hex");
  const padLen = 13846 - tagHead.length / 2;
  return "0x" + envelope + tagHead + "00".repeat(padLen);
}

describe("decodeCompactU32", () => {
  it("decodes all four SCALE compact modes", () => {
    // single-byte: 0xb4 -> 45 (genesis extrinsic 0's length prefix)
    expect(decodeCompactU32(new Uint8Array([0xb4]), 0)).toEqual({ value: 45, size: 1 });
    // two-byte: 0x81 0x03 -> 224 (genesis extrinsic 4's length prefix)
    expect(decodeCompactU32(new Uint8Array([0x81, 0x03]), 0)).toEqual({ value: 224, size: 2 });
    // four-byte: 0x5e 0xdc 0x08 0x00 -> 145175 (genesis extrinsic 3's length prefix)
    expect(decodeCompactU32(new Uint8Array([0x5e, 0xdc, 0x08, 0x00]), 0)).toEqual({
      value: 145175,
      size: 4,
    });
    // big-integer mode: 0x03 + 4 LE bytes
    expect(decodeCompactU32(new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x01]), 0)).toEqual({
      value: 0x01000000,
      size: 5,
    });
  });

  it("throws on truncation rather than silently misreading", () => {
    expect(() => decodeCompactU32(new Uint8Array([0x81]), 0)).toThrow(/truncated/);
    expect(() => decodeCompactU32(new Uint8Array([]), 0)).toThrow(/past end/);
  });
});

describe("decodeMidnightExtrinsic", () => {
  it("extracts the system-tx payload from the real genesis MidnightSystem extrinsic", () => {
    const d = decodeMidnightExtrinsic(GENESIS_SYSTEM_TX_EXTRINSIC, V1);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("system");
    expect(d!.version).toBe(5);
    expect(d!.palletIndex).toBe(6);
    expect(d!.callIndex).toBe(0);
    expect(d!.payload.length).toBe(41);
    // The payload must be the EXACT suffix of the extrinsic (sync-service.ts's proven finding).
    expect(Buffer.from(d!.payload).toString("hex")).toBe(
      GENESIS_SYSTEM_TX_EXTRINSIC.slice(2 + 5 * 2), // strip 0x + 5 envelope bytes
    );
    expect(Buffer.from(d!.payload.subarray(0, 28)).toString("latin1")).toBe(
      "midnight:system-transaction[",
    );
  });

  it("extracts the regular-tx payload from the real genesis Midnight extrinsic", () => {
    const d = decodeMidnightExtrinsic(GENESIS_REGULAR_TX_EXTRINSIC, V1);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("regular");
    expect(d!.version).toBe(5);
    expect(d!.palletIndex).toBe(5);
    expect(d!.callIndex).toBe(0);
    expect(d!.payload.length).toBe(219);
    expect(Buffer.from(d!.payload).toString("hex")).toBe(
      GENESIS_REGULAR_TX_EXTRINSIC.slice(2 + 7 * 2), // strip 0x + 7 envelope bytes (2-byte compacts)
    );
  });

  it("decodes a bare-v4 wallet-submitted extrinsic (height-45 envelope shape)", () => {
    const d = decodeMidnightExtrinsic(height45WalletExtrinsic(), V1);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("regular");
    expect(d!.version).toBe(4);
    expect(d!.palletIndex).toBe(5);
    expect(d!.payload.length).toBe(13846);
  });

  it("returns null for real non-midnight inherents", () => {
    expect(decodeMidnightExtrinsic(TIMESTAMP_INHERENT, V1)).toBeNull();
    expect(decodeMidnightExtrinsic(OTHER_PALLET_INHERENT, V1)).toBeNull();
  });

  it("returns null for signed and 'general' extrinsic types", () => {
    // Same body as the genesis regular tx but with the signed bit (0x80) set on the version byte.
    const signed = "0x8103" + "85" + GENESIS_REGULAR_TX_EXTRINSIC.slice(2 + 3 * 2);
    expect(decodeMidnightExtrinsic(signed, V1)).toBeNull();
    const general = "0x8103" + "45" + GENESIS_REGULAR_TX_EXTRINSIC.slice(2 + 3 * 2);
    expect(decodeMidnightExtrinsic(general, V1)).toBeNull();
  });

  it("returns null when the Vec<u8> argument does not span to the extrinsic's end", () => {
    // Truncate the payload by one byte and fix up the outer length prefix accordingly: the
    // declared arg length (219) now exceeds the remaining bytes -> shape mismatch, not midnight.
    const whole = GENESIS_REGULAR_TX_EXTRINSIC.slice(2);
    const shortened = whole.slice(0, whole.length - 2);
    // outer compact was 224 (0x8103); 223 two-byte compact = (223 << 2) | 0b01 = 0x037d -> LE 7d03
    const relen = "7d03" + shortened.slice(4);
    expect(decodeMidnightExtrinsic("0x" + relen, V1)).toBeNull();
  });

  it("throws on a corrupted envelope (length prefix vs actual bytes)", () => {
    // Chop bytes off the end WITHOUT fixing the outer length prefix.
    const corrupted = GENESIS_REGULAR_TX_EXTRINSIC.slice(0, -10);
    expect(() => decodeMidnightExtrinsic(corrupted, V1)).toThrow(/length prefix/);
  });
});

describe("decodeProtocolVersionFromDigest", () => {
  // Real digest logs captured from the devnet.
  const GENESIS_DIGEST = ["0x044d4e53561040420f00"];
  const BLOCK_45_DIGEST = [
    "0x066175726120b225be1100000000", // PreRuntime "aura"
    "0x066d637368800552a4e8000000000000000000", // PreRuntime "mcsh"
    "0x044d4e53561040420f00", // Consensus "MNSV" <- the one that matters
    "0x044245454684036f4e39c60953ee1286abcd18", // Consensus "BEEF" (beefy) -- must be skipped
    "0x056175726101018627ffcf1c3c73722b762539", // Seal "aura"
  ];

  it("extracts 1_000_000 from the real genesis digest", () => {
    expect(decodeProtocolVersionFromDigest(GENESIS_DIGEST)).toBe(1_000_000);
  });

  it("finds MNSV among multiple consensus/preruntime/seal items (block 45)", () => {
    expect(decodeProtocolVersionFromDigest(BLOCK_45_DIGEST)).toBe(1_000_000);
  });

  it("returns undefined, rather than throwing, on a truncated MNSV item", () => {
    // Consensus variant + "MNSV" and nothing else: 5 bytes, one short of the minimum valid
    // item. This must be skipped like any other unusable log. Before the length floor was
    // raised to 6 it reached decodeCompactU32 at offset === length, which threw and aborted
    // ingest with an opaque decoder error instead of the caller's clear missing-digest message.
    expect(decodeProtocolVersionFromDigest(["0x044d4e5356"])).toBeUndefined();
    // Truncated one byte further into the u32 payload: also skipped, not thrown.
    expect(decodeProtocolVersionFromDigest(["0x044d4e5356104042"])).toBeUndefined();
    // A truncated item must not mask a VALID one later in the same digest.
    expect(decodeProtocolVersionFromDigest(["0x044d4e5356", "0x044d4e53561040420f00"])).toBe(1_000_000);
  });

  it("returns undefined when no MNSV item exists", () => {
    expect(
      decodeProtocolVersionFromDigest(["0x066175726120b225be1100000000"]),
    ).toBeUndefined();
    expect(decodeProtocolVersionFromDigest([])).toBeUndefined();
  });
});

describe("decodeBlockTimestampMs", () => {
  // The real block-45 inherent: bare v5, pallet 1 (Timestamp), call 0 (set), one Compact<u64>
  // moment in big-integer mode (`0x0b` -> six little-endian bytes `e0 7b 93 d8 9f 01`).
  it("decodes the moment from the real Timestamp::set inherent", () => {
    expect(decodeBlockTimestampMs([TIMESTAMP_INHERENT], V1)).toBe(1_786_044_972_000);
  });

  it("finds the inherent among a real block's other extrinsics, in any position", () => {
    expect(
      decodeBlockTimestampMs(
        [OTHER_PALLET_INHERENT, TIMESTAMP_INHERENT, GENESIS_REGULAR_TX_EXTRINSIC],
        V1,
      ),
    ).toBe(1_786_044_972_000);
  });

  it("returns undefined when the block carries no Timestamp::set", () => {
    expect(decodeBlockTimestampMs([OTHER_PALLET_INHERENT], V1)).toBeUndefined();
    expect(decodeBlockTimestampMs([], V1)).toBeUndefined();
  });

  it("classifies by dispatched call, not by argument shape", () => {
    // Same envelope and same well-formed Compact<u64> argument, but pallet 9 instead of pallet 1.
    // A decoder keying off "looks like a plausible moment" would accept this; a block timestamp
    // sourced from the wrong pallet's call would then be persisted as fact.
    const foreign = "0x28" + "05" + "09" + "00" + "0be07b93d89f01";
    expect(decodeBlockTimestampMs([foreign], V1)).toBeUndefined();
    // Right pallet, wrong call index -- same reasoning.
    const wrongCall = "0x28" + "05" + "01" + "07" + "0be07b93d89f01";
    expect(decodeBlockTimestampMs([wrongCall], V1)).toBeUndefined();
  });

  it("skips a malformed inherent rather than throwing", () => {
    // A block whose timestamp cannot be decoded must degrade to a NULL column, never halt ingest.
    // Truncated argument: the declared big-integer compact runs past the end of the extrinsic.
    expect(decodeBlockTimestampMs(["0x1005010" + "00be07b"], V1)).toBeUndefined();
    // Length prefix disagreeing with the body -- `classifyExtrinsic` throws on this shape; here
    // it must be skipped, because one corrupt extrinsic must not cost the whole block's ingest.
    expect(decodeBlockTimestampMs([TIMESTAMP_INHERENT.slice(0, -4)], V1)).toBeUndefined();
    // Non-hex garbage.
    expect(decodeBlockTimestampMs(["0xzz"], V1)).toBeUndefined();
    // A malformed extrinsic must not mask a valid inherent later in the same block.
    expect(decodeBlockTimestampMs(["0xzz", TIMESTAMP_INHERENT], V1)).toBe(1_786_044_972_000);
  });

  it("rejects a multi-argument call whose first argument merely looks like a moment", () => {
    // Same pallet/call and a valid leading compact, but trailing bytes follow it: the argument
    // does not span to the end of the extrinsic, so this is not `set(Compact<u64>)`.
    const trailing = "0x30" + "05" + "01" + "00" + "0be07b93d89f01" + "ff";
    expect(decodeBlockTimestampMs([trailing], V1)).toBeUndefined();
  });
});

describe("protocol-version gate", () => {
  it("accepts exactly the ranges the reference implementation supports", () => {
    // node 1.0.x -- the version this archive is verified against, live.
    expect(isSupportedProtocolVersion(1_000_000)).toBe(true);
    expect(isSupportedProtocolVersion(1_000_999)).toBe(true);
    // node 0.22.x (the reference's `0_022_000..0_023_000`).
    expect(isSupportedProtocolVersion(22_000)).toBe(true);
    expect(isSupportedProtocolVersion(22_999)).toBe(true);
  });

  it("rejects versions outside them, including the exclusive upper bounds", () => {
    expect(isSupportedProtocolVersion(23_000)).toBe(false); // upper bound is exclusive
    expect(isSupportedProtocolVersion(1_001_000)).toBe(false); // ditto
    expect(isSupportedProtocolVersion(21_999)).toBe(false);
    expect(isSupportedProtocolVersion(2_000_000)).toBe(false); // a future ledger v9-era version
    expect(isSupportedProtocolVersion(0)).toBe(false);
  });

  it("assert throws with the offending version and height named", () => {
    // The whole point: a protocol upgrade must halt ingest with a diagnosable error rather than
    // decode an unknown ledger with the hard-wired v8 codec and persist the result.
    expect(() => assertSupportedProtocolVersion(2_000_000, 4242)).toThrow(/2000000/);
    expect(() => assertSupportedProtocolVersion(2_000_000, 4242)).toThrow(/4242/);
    expect(() => assertSupportedProtocolVersion(1_000_000, 4242)).not.toThrow();
  });
});

describe("classification is by call, not by payload content (security)", () => {
  // Bytes carried by a call OTHER than `pallet_midnight::send_mn_transaction` were never applied
  // to the ledger, whatever they look like -- the node accepting an EXTRINSIC is not the node
  // accepting a TRANSACTION.
  //
  // Pallet 0 below stands for "not the Midnight pallet"; the call index is NOT claimed to be any
  // particular System call, since that index has not been verified against this runtime. These
  // extrinsics are constructed directly and are not submittable by a user on the 1.0 runtime
  // (pallet_midnight holds the only ValidateUnsigned) -- they exercise the classifier, and they
  // are the exact shape a pallet renumbering would give GENUINE transactions.
  const foreignCallWrapping = (payloadHex: string): string => {
    const compact = (n: number): string =>
      n < 64
        ? ((n << 2) >>> 0).toString(16).padStart(2, "0")
        : Buffer.from([((n << 2) | 1) & 0xff, (((n << 2) | 1) >> 8) & 0xff]).toString("hex");
    const inner = "05" + "00" + "01" + compact(payloadHex.length / 2) + payloadHex; // pallet 0 = not Midnight
    return "0x" + compact(inner.length / 2) + inner;
  };

  it("rejects a REAL transaction's bytes carried by a NON-Midnight call", () => {
    // The severe case: the payload is a genuine, deserializable Midnight transaction (these are
    // the real captured genesis bytes), so no amount of decoding the CONTENT can detect the
    // forgery. Only the carrying call distinguishes them. Archiving this would assert that a
    // transaction occurred in a block where the ledger never applied it.
    const realTxPayload = GENESIS_REGULAR_TX_EXTRINSIC.slice(2 + 7 * 2);
    expect(decodeMidnightExtrinsic(foreignCallWrapping(realTxPayload), V1)).toBeNull();
  });

  it("rejects junk bytes wearing the midnight self-tag", () => {
    const forged = Buffer.from("midnight:transaction[v9]:NOT-A-TRANSACTION", "latin1").toString("hex");
    expect(decodeMidnightExtrinsic(foreignCallWrapping(forged), V1)).toBeNull();
  });

  it("still accepts the genuine calls, so the check is not merely rejecting everything", () => {
    expect(decodeMidnightExtrinsic(GENESIS_REGULAR_TX_EXTRINSIC, V1)?.kind).toBe("regular");
    expect(decodeMidnightExtrinsic(GENESIS_SYSTEM_TX_EXTRINSIC, V1)?.kind).toBe("system");
  });

  it("derives kind from the call, and rejects a payload whose tag contradicts it", () => {
    // Midnight pallet (regular) carrying a SYSTEM-tagged payload: the call and the content
    // disagree, so the bytes are not what the call says they are. Fail closed.
    const systemPayload = GENESIS_SYSTEM_TX_EXTRINSIC.slice(2 + 5 * 2);
    const compact = (n: number): string => ((n << 2) >>> 0).toString(16).padStart(2, "0");
    const inner = "05" + "05" + "00" + compact(systemPayload.length / 2) + systemPayload;
    expect(decodeMidnightExtrinsic("0x" + compact(inner.length / 2) + inner, V1)).toBeNull();
  });

  it("refuses to guess call indices for a version it has never verified", () => {
    expect(callIndicesForProtocolVersion(22_500)).toBeUndefined(); // 0.22.x: decodable, unverified
    expect(() => requireCallIndices(22_500, 7)).toThrow(/no verified runtime call indices/);
    expect(requireCallIndices(1_000_000, 7).midnightPallet).toBe(5);
  });
});

describe("signed and general framings (which this build cannot decode)", () => {
  // `send_mn_transaction` ignores its origin, so a SIGNED Midnight transaction is valid and the
  // reference indexer archives it. This decoder cannot read the call out of a signed framing --
  // address, signature and signed-extension layouts come from runtime metadata -- so the best it
  // can do is NOTICE one and let the caller refuse, rather than dropping a real transaction.
  const signedWrapping = (payloadHex: string): string => {
    const compact = (n: number): string =>
      n < 64
        ? ((n << 2) >>> 0).toString(16).padStart(2, "0")
        : Buffer.from([((n << 2) | 1) & 0xff, (((n << 2) | 1) >> 8) & 0xff]).toString("hex");
    // 0x84 = signed (bit 7) + version 4, then opaque signature material, then the payload.
    const inner = "84" + "00".repeat(64) + payloadHex;
    return "0x" + compact(inner.length / 2) + inner;
  };

  it("reports a signed extrinsic carrying a midnight transaction payload", () => {
    const payload = GENESIS_REGULAR_TX_EXTRINSIC.slice(2 + 7 * 2);
    const c = classifyExtrinsic(signedWrapping(payload), V1);
    expect(c.outcome).toBe("midnight_tagged_undecodable_framing");
  });

  it("stays silent on an ordinary signed extrinsic", () => {
    // No midnight self-tag: the payload of a Midnight transaction is always self-tagged, so its
    // absence means this cannot be one. Reporting these would refuse on ordinary chain traffic.
    const c = classifyExtrinsic(signedWrapping(Buffer.from("ordinary payload").toString("hex")), V1);
    expect(c.outcome).toBe("not_midnight");
  });

  it("still rejects bare non-Midnight calls as before", () => {
    expect(decodeMidnightExtrinsic(TIMESTAMP_INHERENT, V1)).toBeNull();
  });
});
