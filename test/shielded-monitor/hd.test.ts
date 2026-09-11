import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HARDENED_OFFSET,
  HdDerivationError,
  MIDNIGHT_ROLES,
  deriveMidnightRoleSeed,
  deriveNode,
  derivePrivateKey,
  midnightRolePath,
} from "../../shielded-monitor/hd.js";
import { seedFor, walletHdVectors } from "./fixtures/wallet-sdk-hd-vectors.js";

/**
 * `shielded-monitor/hd.ts` — BIP-0032 over secp256k1, with Node built-ins only.
 *
 * Two independent things are checked here, and the distinction is the point:
 *
 * 1. **It is BIP-0032.** The official test vector 1 is walked node by node, and each node's
 *    private key AND chain code are compared with the published `xprv`. That catches the failure
 *    this implementation is most exposed to —
 *    getting the hardened/non-hardened split, the mod-n addition or the chain-code split subtly
 *    wrong in a way that is self-consistent and produces plausible garbage.
 * 2. **It is MIDNIGHT's path.** The path, the role and the hardened/non-hardened split are pinned
 *    against what `@midnightntwrk/wallet-sdk-hd@3.0.3` does. An implementation can be perfectly
 *    correct BIP-0032 and still derive the wrong key for this chain if the path or role is wrong.
 *
 * The end-to-end claim — that this repository reproduces the **wallet's own Zswap address** for a
 * given seed — is asserted in `derive-key.test.ts`, against the public keys captured from the SDK.
 * It lives there because it needs the ledger to turn a role seed into an address, and because the
 * intermediate role seed is secret-shaped material this repository deliberately does not commit
 * in any form (see `fixtures/wallet-sdk-hd-vectors.ts`).
 *
 * No Docker, no database, no network.
 */

// ── Decoding the official vectors ────────────────────────────────────────────────────────────
// BIP-0032 publishes its vectors as base58check `xprv` strings. The module under test deliberately
// ships no extended-key serializer — nothing in this repository needs an `xprv`, and code that
// exists only to be tested is a liability — so the vector format is decoded here, in the test,
// which is the right side of that line.

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

interface DecodedXprv {
  readonly depth: number;
  readonly index: number;
  readonly chainCode: string;
  readonly key: string;
}

function decodeXprv(text: string): DecodedXprv {
  let n = 0n;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) throw new Error(`${ch} is not base58`);
    n = n * 58n + BigInt(digit);
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let raw = Buffer.from(hex, "hex");
  for (const ch of text) {
    if (ch !== "1") break;
    raw = Buffer.concat([Buffer.from([0]), raw]);
  }
  // 4 version + 1 depth + 4 parent fingerprint + 4 index + 32 chain code + 33 key + 4 checksum.
  if (raw.length !== 82) throw new Error(`expected 82 bytes, got ${raw.length}`);
  const checksum = createHash("sha256")
    .update(createHash("sha256").update(raw.subarray(0, 78)).digest())
    .digest()
    .subarray(0, 4);
  // Guards the decoder itself: a mistyped vector in this file would otherwise become an assertion
  // about the wrong bytes, and it would be this repository's implementation that looked wrong.
  if (!checksum.equals(raw.subarray(78))) throw new Error("vector failed its own base58check");
  return {
    depth: raw[4]!,
    index: raw.readUInt32BE(9),
    chainCode: raw.subarray(13, 45).toString("hex"),
    key: raw.subarray(46, 78).toString("hex"),
  };
}

describe("shielded-monitor HD derivation (BIP-0032 / secp256k1)", () => {
  describe("BIP-0032 official test vector 1", () => {
    // https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki — "Test vector 1".
    // The path deliberately alternates hardened and non-hardened children in both orders, which is
    // exactly what a `CKDpriv` that has the two branches swapped cannot survive.
    const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const H = HARDENED_OFFSET;
    const steps: ReadonlyArray<readonly [string, readonly number[], string]> = [
      ["m", [], "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"],
      ["m/0'", [0 + H], "xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7"],
      ["m/0'/1", [0 + H, 1], "xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs"],
      ["m/0'/1/2'", [0 + H, 1, 2 + H], "xprv9z4pot5VBttmtdRTWfWQmoH1taj2axGVzFqSb8C9xaxKymcFzXBDptWmT7FwuEzG3ryjH4ktypQSAewRiNMjANTtpgP4mLTj34bhnZX7UiM"],
      ["m/0'/1/2'/2", [0 + H, 1, 2 + H, 2], "xprvA2JDeKCSNNZky6uBCviVfJSKyQ1mDYahRjijr5idH2WwLsEd4Hsb2Tyh8RfQMuPh7f7RtyzTtdrbdqqsunu5Mm3wDvUAKRHSC34sJ7in334"],
      ["m/0'/1/2'/2/1000000000", [0 + H, 1, 2 + H, 2, 1000000000], "xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76"],
    ];

    it.each(steps)("derives %s — key AND chain code", (_label, path, expected) => {
      const decoded = decodeXprv(expected);
      const node = deriveNode(seed, path);
      expect(node.key.toString("hex")).toBe(decoded.key);
      // The chain code matters as much as the key: a wrong one produces the right key here and
      // the wrong key at every child below it.
      expect(node.chainCode.toString("hex")).toBe(decoded.chainCode);
      expect(decoded.depth).toBe(path.length);
      expect(decoded.index).toBe(path.at(-1) ?? 0);
    });

    it("checked all six nodes (a vector list that emptied itself must not pass)", () => {
      expect(steps).toHaveLength(6);
    });

    it("a one-bit change in the seed changes the master key (the decoder is not comparing nothing)", () => {
      const altered = Buffer.from(seed);
      altered[0] = altered[0]! ^ 0x01;
      expect(deriveNode(altered, []).key.toString("hex")).not.toBe(decodeXprv(steps[0]![2]).key);
    });
  });

  describe("the Midnight path (@midnightntwrk/wallet-sdk-hd@3.0.3)", () => {
    it("is m/44'/2400'/<account>'/<role>/<index> with Zswap as role 3", () => {
      expect(midnightRolePath().text).toBe("m/44'/2400'/0'/3/0");
      expect(midnightRolePath({ account: 2, index: 7 }).text).toBe("m/44'/2400'/2'/3/7");
      expect(MIDNIGHT_ROLES.Zswap).toBe(3);
      // The fixture records the same path the SDK was driven with; if one moves, they disagree.
      expect(midnightRolePath({
        account: walletHdVectors.account,
        role: walletHdVectors.role,
        index: walletHdVectors.index,
      }).text).toBe(walletHdVectors.path);
    });

    it("hardens exactly the first three components", () => {
      // The first three are hardened and the last two are not. Getting this wrong yields a
      // different, perfectly valid key for every input — a failure no amount of self-consistency
      // would reveal, which is why it is asserted structurally here and end-to-end in
      // `derive-key.test.ts` against the wallet's own public keys.
      const components = midnightRolePath().components;
      expect(components.slice(0, 3).every((c) => c >= HARDENED_OFFSET)).toBe(true);
      expect(components.slice(3).every((c) => c < HARDENED_OFFSET)).toBe(true);
      expect(components).toHaveLength(5);
    });

    it("derives a distinct role seed for each fixture seed, and for each account, role and index", () => {
      const seeds = walletHdVectors.vectors.map((v) => seedFor(v.seedRecipe));
      expect(seeds.length).toBeGreaterThanOrEqual(3);
      const derived = seeds.map((s) => deriveMidnightRoleSeed(s).toString("hex"));
      expect(new Set(derived).size, "three different seeds must give three different role seeds").toBe(derived.length);

      const base = derived[0]!;
      const seed = seeds[0]!;
      expect(deriveMidnightRoleSeed(seed, { account: 1 }).toString("hex")).not.toBe(base);
      expect(deriveMidnightRoleSeed(seed, { index: 1 }).toString("hex")).not.toBe(base);
      expect(deriveMidnightRoleSeed(seed, { role: MIDNIGHT_ROLES.NightExternal }).toString("hex")).not.toBe(base);
    });
  });

  describe("refusals", () => {
    it("rejects a seed outside BIP-0032's 16..64 byte range", () => {
      expect(() => derivePrivateKey(Buffer.alloc(15), [])).toThrow(HdDerivationError);
      expect(() => derivePrivateKey(Buffer.alloc(65), [])).toThrow(HdDerivationError);
      expect(() => derivePrivateKey(Buffer.alloc(16), [])).not.toThrow();
      expect(() => derivePrivateKey(Buffer.alloc(64), [])).not.toThrow();
    });

    it("rejects a child index outside [0, 2^32)", () => {
      const seed = Buffer.alloc(32, 7);
      expect(() => derivePrivateKey(seed, [-1])).toThrow(HdDerivationError);
      expect(() => derivePrivateKey(seed, [0x100000000])).toThrow(HdDerivationError);
      expect(() => derivePrivateKey(seed, [1.5])).toThrow(HdDerivationError);
    });

    it("rejects an account, role or index at or above 2^31 (the SDK's own bound)", () => {
      expect(() => midnightRolePath({ account: HARDENED_OFFSET })).toThrow(HdDerivationError);
      expect(() => midnightRolePath({ role: HARDENED_OFFSET })).toThrow(HdDerivationError);
      expect(() => midnightRolePath({ index: HARDENED_OFFSET })).toThrow(HdDerivationError);
    });

    it("is deterministic — the same seed and path always give the same key", () => {
      const seed = seedFor("ascending-0-to-31");
      expect(deriveMidnightRoleSeed(seed).toString("hex")).toBe(deriveMidnightRoleSeed(seed).toString("hex"));
    });
  });
});
