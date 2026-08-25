import { describe, expect, it } from "vitest";
import { DEFAULT_ALICE_SEED, deriveUnshieldedAddress, evmAddressHex, midnightAddressBytes } from "./address.js";

describe("genesis wallet address derivation", () => {
  it("derives the rc.4 alice address through the three-role HD path", () => {
    const address = deriveUnshieldedAddress(DEFAULT_ALICE_SEED);
    expect(address).toBe("mn_addr_undeployed1h3ssm5ru2t6eqy4g3she78zlxn96e36ms6pq996aduvmateh9p9sk96u7s");
    expect(midnightAddressBytes(address).toString("hex")).toBe(
      "bc610dd07c52f59012a88c2f9f1c5f34cbacc75b868202975d6f19beaf37284b",
    );
  });

  it("maps alice to the stable 20-byte EVM address", () => {
    expect(evmAddressHex(deriveUnshieldedAddress(DEFAULT_ALICE_SEED))).toBe(
      "0x178c5bad4ded7d8455542f8e6bd667e3d986f3a0",
    );
  });
});
