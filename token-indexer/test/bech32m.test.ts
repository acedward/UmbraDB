import { describe, expect, it } from "vitest";
import {
  Bech32mError, addressHrp, decodeBech32m, decodeOwnerAddress, encodeBech32m, ownerAddress,
} from "../api/bech32m.js";
import { loadActivityFixture } from "./helpers/archive-fixture.js";

/**
 * Project 00023, sub-plan 01 task A4.3 — the VERIFICATION the spec asked for.
 *
 * Spec §0 and the plan both say: **VERIFY** that a Midnight wallet address's Bech32m payload is the
 * raw 32-byte `UserAddress` with no version byte, against a known pair — and if it is not, ship hex
 * and record the finding. It is. This test is that proof, and it is deliberately not written
 * against the encoder's own output: every pair below has one half that came from **the public
 * indexer** (which serves `owner` as Bech32m) and the other half from **the ledger** (which reports
 * the same UTXO's owner as hex), so the two independent sources are what agree, not this module
 * with itself.
 */

/** The recorded Stagenet test wallet's own address (00020 master plan, "Stagenet test wallet").
 *  Only the ADDRESS is here — the seed is not in this repository and never will be. */
const TEST_WALLET_ADDRESS =
  "mn_addr_stagenet1m4gv99gjckxx3gmrsjmvguqy7fuzffdjm8z7k5j3uyxc2nl63xksrda9fm";

describe("Bech32m wallet addresses (owner decision Q9)", () => {
  it("[[token-activity-bech32m]] a Midnight address is the raw 32 bytes with no version byte: the indexer's Bech32m and the ledger's hex are the same address, and every pair round-trips", () => {
    // ---- the two pairs the chain itself provides ------------------------------------------
    // `deposit-toMap`'s spender, and `night-passthrough`'s owner. The Bech32m string is the
    // indexer's; the hex is what `decodeTokenFlows` read off the transaction bytes and what
    // `[[token-activity-decode-utxo]]` / `[[token-activity-decode-effects]]` pin.
    const pairs: { bech32m: string; hex: string; from: string }[] = [
      {
        bech32m: loadActivityFixture("deposit-toMap").unshieldedSpentOutputs![0]!.owner,
        hex: "db563c77b3b6ab6702720f7c1d9e2d0bfd4204c3f841460b6d03cb0079af585f",
        from: "deposit-toMap unshieldedSpentOutputs[0]",
      },
      {
        bech32m: loadActivityFixture("night-passthrough").unshieldedCreatedOutputs[0]!.owner,
        hex: "578d30979c33af7f74fd9fbdb331ea2057ae3ca6b5b51c144c6da501cabb968e",
        from: "night-passthrough unshieldedCreatedOutputs[0]",
      },
    ];

    for (const pair of pairs) {
      const decoded = decodeBech32m(pair.bech32m);
      // No version byte, no prefix, no padding slack: exactly the 32 bytes the ledger reports.
      expect(decoded.data, `${pair.from} width`).toHaveLength(32);
      expect(Buffer.from(decoded.data).toString("hex"), `${pair.from} bytes`).toBe(pair.hex);
      expect(decoded.hrp, `${pair.from} hrp`).toBe("mn_addr_stagenet");
      // …and the encoder reproduces the indexer's own string from the ledger's own hex.
      expect(ownerAddress("stagenet", pair.hex), `${pair.from} encode`).toBe(pair.bech32m);
      expect(encodeBech32m(decoded.hrp, decoded.data)).toBe(pair.bech32m);
      expect(decodeOwnerAddress(pair.bech32m)).toEqual({ hrp: "mn_addr_stagenet", hex: pair.hex });
    }
    // The two addresses really are different, so a bug that returned a constant would be caught.
    expect(pairs[0]!.hex).not.toBe(pairs[1]!.hex);

    // ---- the recorded test wallet's own address --------------------------------------------
    const wallet = decodeOwnerAddress(TEST_WALLET_ADDRESS);
    expect(wallet.hrp).toBe("mn_addr_stagenet");
    expect(wallet.hex).toBe("dd50c29512c58c68a36384b6c47004f27824a5b2d9c5eb5251e10d854ffa89ad");
    expect(ownerAddress("stagenet", wallet.hex)).toBe(TEST_WALLET_ADDRESS);

    // ---- the HRP rule (wallet SDK `address-format/src/index.ts:60-115`) ---------------------
    // `mn` + `_addr` + `_<network>` unless mainnet, where the network segment is dropped.
    expect(addressHrp("stagenet")).toBe("mn_addr_stagenet");
    expect(addressHrp("testnet")).toBe("mn_addr_testnet");
    expect(addressHrp("mainnet")).toBe("mn_addr");
    expect(addressHrp("MainNet")).toBe("mn_addr");
    expect(ownerAddress("mainnet", pairs[0]!.hex).startsWith("mn_addr1")).toBe(true);
    // The same bytes on two networks are two different strings — which is the point of the HRP.
    expect(ownerAddress("mainnet", pairs[0]!.hex)).not.toBe(ownerAddress("stagenet", pairs[0]!.hex));

    // ---- BIP-350's own vectors, at the layer they are about --------------------------------
    // A valid Bech32m string with an arbitrary payload decodes; the SAME string under the older
    // Bech32 checksum constant does not, because this module implements Bech32m only.
    expect(decodeBech32m("a1lqfn3a").hrp).toBe("a");
    expect(() => decodeBech32m("A1LQFN3A".toLowerCase() + "x")).toThrow(Bech32mError);
    // BIP-173's own example, valid under the ORIGINAL constant and therefore rejected here.
    expect(() => decodeBech32m("a12uel5l")).toThrow(/bad-checksum/);

    // ---- refusals ---------------------------------------------------------------------------
    expect(() => decodeBech32m("mn_addr_stagenet1qqqqqq")).toThrow(Bech32mError);       // bad checksum
    expect(() => decodeBech32m(TEST_WALLET_ADDRESS.toUpperCase().slice(0, 10) + TEST_WALLET_ADDRESS.slice(10)))
      .toThrow(/mixed-case/);
    expect(() => decodeBech32m("nohrpseparator")).toThrow(/no-separator/);
    // An address that is not 32 bytes is never an address, however well-formed its checksum is.
    expect(() => decodeOwnerAddress(encodeBech32m("mn_addr_stagenet", new Uint8Array(31))))
      .toThrow(Bech32mError);
    expect(() => ownerAddress("stagenet", "00".repeat(31))).toThrow(/expected 32 bytes/);
    expect(() => ownerAddress("stagenet", "not hex")).toThrow(/expected 32 bytes/);
    // The encoder refuses an HRP it would then refuse to decode.
    expect(() => encodeBech32m("MN_ADDR", new Uint8Array(32))).toThrow(/lowercase/);
    expect(() => encodeBech32m("", new Uint8Array(32))).toThrow(/empty hrp/);
  });
});
