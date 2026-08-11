import { describe, expect, it } from "vitest";
import { keccak256 as ethersKeccak } from "ethers";
import { keccak256, keccak256Utf8 } from "../keccak256.js";
import { TRANSFER_TOPIC0 } from "../event-map.js";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * The whole log-mapping layer is only as correct as this hash: every topic0, and every
 * bytes32 -> 20-byte EVM address mapping, is a keccak256 output. `sha3-256` from Node's crypto
 * would pass a naive "it hashes something" test while producing wrong topics everywhere, so the
 * published Keccak vectors are asserted directly rather than only cross-checking a second
 * implementation.
 */
describe("keccak256 (evm-rpc/logs/keccak256.ts)", () => {
  it("matches the published Keccak-256 vectors for the empty string and \"abc\"", () => {
    expect(hex(keccak256Utf8(""))).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(hex(keccak256Utf8("abc"))).toBe(
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("is NOT FIPS-202 SHA3-256 (the 0x01-vs-0x06 domain suffix actually differs)", async () => {
    const { createHash } = await import("node:crypto");
    const sha3 = createHash("sha3-256").update("").digest("hex");
    // If these ever coincided, this file would be computing the wrong hash for every EVM topic.
    expect(hex(keccak256Utf8(""))).not.toBe(sha3);
  });

  it("agrees with ethers.keccak256 across every padding boundary around the 136-byte rate", () => {
    // 0..300 bytes covers: the empty message, sub-rate, the exact rate (136), rate-1 and rate-2
    // (the one-free-byte 0x81 padding case), the two-block boundary (272) and beyond.
    for (let length = 0; length <= 300; length++) {
      const input = new Uint8Array(length).map((_, i) => (i * 37 + length) & 0xff);
      expect(`0x${hex(keccak256(input))}`, `length ${length}`).toBe(ethersKeccak(input));
    }
  });

  it("produces the canonical ERC20 Transfer signature hash that LOGMAP.md pins as topic0", () => {
    expect(hex(keccak256Utf8("Transfer(address,address,uint256)"))).toBe(
      "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
    // ...and the exported constant is that hash, not a hand-copied literal that could drift.
    expect(hex(TRANSFER_TOPIC0)).toBe(
      "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
  });
});
