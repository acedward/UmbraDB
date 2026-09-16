import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  Bech32mError,
  MAX_BECH32M_LENGTH,
  decodeBech32m,
  decodeBech32mWords,
  encodeBech32m,
  type Bech32mDecodeFailure,
} from "../../shielded-monitor/bech32m.js";

/**
 * BIP-350's own published vectors, plus the properties this repository needs on top of them.
 *
 * The vectors are transcribed from BIP-350 ("Bech32m format for v1+ witness addresses",
 * "Test vectors for Bech32m"). They exercise the CHECKSUM layer, which is
 * `decodeBech32mWords` — several of BIP-350's "valid" strings have 5-bit payloads that do not
 * correspond to any whole-byte string, so asserting them against the byte-level
 * `decodeBech32m` would be asserting the wrong thing. The byte layer's own strictness (no
 * padding slack) is tested separately below.
 */

/** BIP-350 valid Bech32m strings. */
const BIP350_VALID: readonly string[] = [
  "A1LQFN3A",
  "a1lqfn3a",
  "an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6",
  "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
  "11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8",
  "split1checkupstagehandshakeupstreamerranterredcaperredlc445v",
  "?1v759aa",
];

/**
 * BIP-350 invalid strings, each with the discriminant this implementation must report. Asserting
 * the specific `failure` rather than "it threw" is what makes the test able to catch a decoder
 * that rejects for the wrong reason — the classic way a hand-written codec passes its vectors
 * while being subtly wrong.
 */
const BIP350_INVALID: readonly (readonly [string, Bech32mDecodeFailure, string])[] = [
  // The first three carry a non-printable HRP character, written as escapes so the vector
  // stays visible in the source instead of being an invisible byte a copy-paste can drop.
  ["\u00201xj0phk", "char-out-of-range", "HRP character out of range (0x20)"],
  ["\u007f1g6xzxy", "char-out-of-range", "HRP character out of range (0x7f)"],
  ["\u00801vctc34", "char-out-of-range", "HRP character out of range (0x80)"],
  ["qyrz8wqd2c9m", "no-separator", "no separator character"],
  ["1qyrz8wqd2c9m", "empty-hrp", "empty HRP"],
  ["y1b0jsk6g", "invalid-data-char", "invalid data character"],
  ["lt1igcx5c0", "invalid-data-char", "invalid data character"],
  ["in1muywd", "data-too-short", "too short checksum"],
  ["mm1crxm3i", "invalid-data-char", "invalid character in checksum"],
  ["au1s5cgom", "invalid-data-char", "invalid character in checksum"],
  ["M1VUXWEZ", "bad-checksum", "checksum calculated with uppercase form of HRP"],
  ["16plkw9", "empty-hrp", "empty HRP"],
  ["1p2gdwpf", "empty-hrp", "empty HRP"],
];

/** BIP-173 valid **Bech32** (not Bech32m) strings. Every one must be refused here. */
const BIP173_BECH32_VALID: readonly string[] = [
  "A12UEL5L",
  "a12uel5l",
  "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
  "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
  "?1ezyfcl",
];

function failureOf(fn: () => unknown): Bech32mDecodeFailure | "did-not-throw" {
  try {
    fn();
    return "did-not-throw";
  } catch (err) {
    if (err instanceof Bech32mError) return err.failure;
    throw err;
  }
}

describe("bech32m codec (BIP-350)", () => {
  describe("BIP-350's valid vectors", () => {
    for (const vector of BIP350_VALID) {
      it(`accepts ${JSON.stringify(vector.length > 40 ? vector.slice(0, 37) + "..." : vector)}`, () => {
        expect(() => decodeBech32mWords(vector)).not.toThrow();
      });
    }

    it("lowercases the HRP of an uppercase vector, so the network comparison is exact", () => {
      expect(decodeBech32mWords("A1LQFN3A").hrp).toBe("a");
      expect(decodeBech32mWords("a1lqfn3a")).toStrictEqual(decodeBech32mWords("A1LQFN3A"));
    });
  });

  describe("BIP-350's invalid vectors, each rejected for the RIGHT reason", () => {
    for (const [vector, failure, why] of BIP350_INVALID) {
      it(`rejects ${JSON.stringify(vector)} — ${why}`, () => {
        expect(failureOf(() => decodeBech32mWords(vector))).toBe(failure);
      });
    }

    /**
     * The one BIP-350 invalid vector this implementation deliberately does NOT reject, asserted
     * as a known and intentional divergence rather than left as prose that could rot.
     *
     * BIP-350 calls it invalid because it exceeds 90 characters. That limit is a property of the
     * addresses BIP-173/350 define, not of this HRP family: a `mn_shield-esk_<network>` key is
     * 83 characters, so the limit would constrain nothing real while making the codec refuse a
     * hypothetical longer network id for no security reason. {@link MAX_BECH32M_LENGTH} is the
     * bound that actually matters here — it stops a hostile megabyte string before the polymod
     * loop, which the 90-character rule was never about.
     *
     * If a future change adopts the 90-character rule, THIS TEST FAILS and whoever adopted it
     * updates the expectation and the codec's own doc block.
     */
    it("KNOWN DIVERGENCE: the 91-character vector decodes, because BIP-173's 90-char limit is not applied", () => {
      const overLong =
        "an84characterslonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11d6pts4";
      expect(overLong.length).toBeGreaterThan(90);
      expect(() => decodeBech32mWords(overLong)).not.toThrow();
    });
  });

  describe("Bech32 (the original checksum constant) is not Bech32m", () => {
    for (const vector of BIP173_BECH32_VALID) {
      it(`refuses the valid Bech32 string ${JSON.stringify(vector)}`, () => {
        expect(failureOf(() => decodeBech32mWords(vector))).toBe("bad-checksum");
      });
    }
  });

  describe("this repository's own bounds", () => {
    it("mixed case is refused before anything else looks at the string", () => {
      expect(failureOf(() => decodeBech32mWords("A1lqfn3a"))).toBe("mixed-case");
    });

    it("a string past the length bound is refused without decoding", () => {
      expect(failureOf(() => decodeBech32mWords("a".repeat(MAX_BECH32M_LENGTH + 1)))).toBe("too-long");
    });

    it("the empty string is refused", () => {
      expect(failureOf(() => decodeBech32mWords(""))).toBe("empty");
    });

    it("the byte layer refuses a payload whose 5-bit residue is not a whole-byte string", () => {
      // BIP-350's 82-'l' vector: valid checksum, but 82 * 5 bits leaves a non-zero residue.
      const notBytes =
        "11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8";
      expect(() => decodeBech32mWords(notBytes)).not.toThrow();
      expect(failureOf(() => decodeBech32m(notBytes))).toBe("invalid-padding");
    });
  });

  describe("round trip", () => {
    it("re-encodes every byte-decodable BIP-350 vector to itself", () => {
      const byteDecodable = BIP350_VALID.filter((v) => {
        try {
          decodeBech32m(v);
          return true;
        } catch {
          return false;
        }
      });
      expect(byteDecodable.length).toBeGreaterThan(0); // the filter is not vacuous
      for (const vector of byteDecodable) {
        const { hrp, data } = decodeBech32m(vector);
        expect(encodeBech32m(hrp, data)).toBe(vector.toLowerCase());
      }
    });

    it("round-trips arbitrary payloads under a realistic HRP", () => {
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (payload) => {
          const encoded = encodeBech32m("mn_shield-esk_undeployed", payload);
          const decoded = decodeBech32m(encoded);
          expect(decoded.hrp).toBe("mn_shield-esk_undeployed");
          expect([...decoded.data]).toStrictEqual([...payload]);
        }),
        { numRuns: 200 },
      );
    });

    it("a single flipped data character always breaks the checksum", () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 1, maxLength: 40 }),
          fc.nat(),
          fc.integer({ min: 1, max: 31 }),
          (payload, indexSeed, shift) => {
            const encoded = encodeBech32m("mn_shield-esk_undeployed", payload);
            const dataStart = encoded.lastIndexOf("1") + 1;
            const index = dataStart + (indexSeed % (encoded.length - dataStart));
            const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
            const current = charset.indexOf(encoded[index]!);
            const mutated =
              encoded.slice(0, index) + charset[(current + shift) % 32]! + encoded.slice(index + 1);
            expect(failureOf(() => decodeBech32mWords(mutated))).toBe("bad-checksum");
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe("encode refuses an HRP it would then refuse to decode", () => {
    it("rejects an empty HRP", () => {
      expect(() => encodeBech32m("", new Uint8Array(4))).toThrow(/empty hrp/);
    });

    it("rejects an uppercase HRP", () => {
      expect(() => encodeBech32m("MN_SHIELD-ESK", new Uint8Array(4))).toThrow(/lowercase/);
    });

    it("rejects an HRP character outside 33..126", () => {
      expect(() => encodeBech32m("mn shield", new Uint8Array(4))).toThrow(/out of range/);
    });

    it("rejects a payload that would push the string past the length bound", () => {
      expect(() => encodeBech32m("mn_shield-esk_undeployed", new Uint8Array(4096))).toThrow(/length bound/);
    });
  });
});
