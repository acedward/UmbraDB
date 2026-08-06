import { describe, expect, it } from "vitest";
import {
  decodeCompactU32,
  decodeMidnightExtrinsic,
  decodeProtocolVersionFromDigest,
} from "../../chain-archive-sync/extrinsic-decoder.js";

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
    const d = decodeMidnightExtrinsic(GENESIS_SYSTEM_TX_EXTRINSIC);
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
    const d = decodeMidnightExtrinsic(GENESIS_REGULAR_TX_EXTRINSIC);
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
    const d = decodeMidnightExtrinsic(height45WalletExtrinsic());
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("regular");
    expect(d!.version).toBe(4);
    expect(d!.palletIndex).toBe(5);
    expect(d!.payload.length).toBe(13846);
  });

  it("returns null for real non-midnight inherents", () => {
    expect(decodeMidnightExtrinsic(TIMESTAMP_INHERENT)).toBeNull();
    expect(decodeMidnightExtrinsic(OTHER_PALLET_INHERENT)).toBeNull();
  });

  it("returns null for signed and 'general' extrinsic types", () => {
    // Same body as the genesis regular tx but with the signed bit (0x80) set on the version byte.
    const signed = "0x8103" + "85" + GENESIS_REGULAR_TX_EXTRINSIC.slice(2 + 3 * 2);
    expect(decodeMidnightExtrinsic(signed)).toBeNull();
    const general = "0x8103" + "45" + GENESIS_REGULAR_TX_EXTRINSIC.slice(2 + 3 * 2);
    expect(decodeMidnightExtrinsic(general)).toBeNull();
  });

  it("returns null when the Vec<u8> argument does not span to the extrinsic's end", () => {
    // Truncate the payload by one byte and fix up the outer length prefix accordingly: the
    // declared arg length (219) now exceeds the remaining bytes -> shape mismatch, not midnight.
    const whole = GENESIS_REGULAR_TX_EXTRINSIC.slice(2);
    const shortened = whole.slice(0, whole.length - 2);
    // outer compact was 224 (0x8103); 223 two-byte compact = (223 << 2) | 0b01 = 0x037d -> LE 7d03
    const relen = "7d03" + shortened.slice(4);
    expect(decodeMidnightExtrinsic("0x" + relen)).toBeNull();
  });

  it("throws on a corrupted envelope (length prefix vs actual bytes)", () => {
    // Chop bytes off the end WITHOUT fixing the outer length prefix.
    const corrupted = GENESIS_REGULAR_TX_EXTRINSIC.slice(0, -10);
    expect(() => decodeMidnightExtrinsic(corrupted)).toThrow(/length prefix/);
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

  it("returns undefined when no MNSV item exists", () => {
    expect(
      decodeProtocolVersionFromDigest(["0x066175726120b225be1100000000"]),
    ).toBeUndefined();
    expect(decodeProtocolVersionFromDigest([])).toBeUndefined();
  });
});
