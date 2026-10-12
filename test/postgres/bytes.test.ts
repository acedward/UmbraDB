import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, sha256Hex } from "../../src/postgres/bytes.js";

/**
 * The runtime-neutral byte helpers give exactly what the `Buffer` / `node:crypto` calls they replace give, on every
 * input (Node's own implementation is the oracle), and return plain `Uint8Array`s.
 */

/** Any UTF-16 code unit, lone surrogates included. */
const codeUnit = fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c));
/** Mostly hex digits, with junk, prefixes and high code units whose low byte is a hex digit (`Ł` = U+0141). */
const hexish = fc.string({ unit: fc.oneof(fc.constantFrom(..."0123456789abcdefABCDEF"), fc.constantFrom("x", "0x", " ", "g", "Ł", "İ", "ǅ", "\u0000"), codeUnit), maxLength: 70 });

const isPlain = (b: Uint8Array): boolean => Object.getPrototypeOf(b) === Uint8Array.prototype;

describe("runtime-neutral byte helpers equal Buffer and node:crypto", () => {
  it("bytesToHex = Buffer#toString('hex') for any bytes, a Buffer or a plain Uint8Array", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
      const want = Buffer.from(b).toString("hex");
      expect(bytesToHex(b)).toBe(want);
      expect(bytesToHex(Buffer.from(b))).toBe(want);
    }), { numRuns: 500 });
    expect(bytesToHex(new Uint8Array(0))).toBe("");
    expect(bytesToHex(Uint8Array.of(0, 9, 10, 255))).toBe("00090aff");
  });

  it("hexToBytes = Buffer.from(text, 'hex') for any text: stops at the first non-hex pair, drops an odd last digit, reads the low byte of each code unit", () => {
    fc.assert(fc.property(fc.oneof(hexish, fc.string({ unit: codeUnit, maxLength: 40 })), (s) => {
      const got = hexToBytes(s);
      expect(Buffer.from(got).equals(Buffer.from(s, "hex"))).toBe(true);
      expect(isPlain(got)).toBe(true);
    }), { numRuns: 2000 });
    for (const s of ["", "a", "abc", "ABcd", "0xab", "ab zz cd", "abg0", "Ł1", "zz", "00ff"])
      expect([...hexToBytes(s)], s).toEqual([...Buffer.from(s, "hex")]);
    expect([...hexToBytes("Ł1")]).toEqual([0xa1]);
  });

  it("sha256Hex = node:crypto sha256 hex for any bytes", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 2000 }), (b) => {
      expect(sha256Hex(b)).toBe(createHash("sha256").update(b).digest("hex"));
    }), { numRuns: 300 });
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
