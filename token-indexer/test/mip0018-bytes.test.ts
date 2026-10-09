/**
 * The token indexer's runtime-neutral byte helpers give exactly what the `Buffer` calls they replace give (Node's own
 * implementation is the oracle), so hex, entry points and API cursors are byte-for-byte what they were.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../mip0018/api-views.ts";
import { bytesEqual, fromBase64url, hexToBytes, latin1Text, toBase64url, toHex, utf8Bytes, utf8Text } from "../mip0018/bytes.ts";
import { entryPointBytes, entryPointJson, entryPointLabel, entryPointText } from "../mip0018/entry-point.ts";

/** Any UTF-16 code unit, lone surrogates included. */
const codeUnit = fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c));
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const base64urlText = fc.string({ unit: fc.constantFrom(...BASE64URL), maxLength: 90 });
/** Bytes that are often invalid UTF-8 or start with a byte-order mark. */
const utf8ish = fc.oneof(
  fc.uint8Array({ maxLength: 64 }),
  fc.uint8Array({ maxLength: 32 }).map((b) => Uint8Array.of(0xef, 0xbb, 0xbf, ...b)),
  fc.array(fc.constantFrom(0xc0, 0x80, 0xed, 0xa0, 0xf0, 0x9f, 0xff, 0xe2, 0x82, 0x41), { maxLength: 40 }).map((a) => Uint8Array.from(a)),
);

describe("token-indexer byte helpers equal Buffer", () => {
  it("toHex = Buffer#toString('hex'); bytesEqual = Buffer#equals; hexToBytes = Buffer.from(…, 'hex')", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 200 }), fc.uint8Array({ maxLength: 200 }), (a, b) => {
      expect(toHex(a)).toBe(Buffer.from(a).toString("hex"));
      expect(bytesEqual(a, b)).toBe(Buffer.from(a).equals(Buffer.from(b)));
      expect(bytesEqual(a, Buffer.from(a))).toBe(true);
      expect([...hexToBytes(toHex(a))]).toEqual([...a]);
    }), { numRuns: 500 });
  });

  it("toBase64url = Buffer#toString('base64url'); fromBase64url = Buffer.from(…, 'base64url') on the URL-safe alphabet, any length; any other character is refused", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 120 }), (b) => {
      expect(toBase64url(b)).toBe(Buffer.from(b).toString("base64url"));
      expect([...fromBase64url(toBase64url(b))]).toEqual([...b]);
    }), { numRuns: 500 });
    fc.assert(fc.property(base64urlText, (s) => {
      expect([...fromBase64url(s)]).toEqual([...Buffer.from(s, "base64url")]);
    }), { numRuns: 2000 });
    for (const s of ["", "Q", "QQ", "QR", "QUI", "QUJ", "QUJDR", "____", "-_-"]) expect([...fromBase64url(s)], s).toEqual([...Buffer.from(s, "base64url")]);
    for (const s of ["QQ==", "a+b", "a/b", "a b", "é"]) expect(() => fromBase64url(s), s).toThrow(SyntaxError);
  });

  it("utf8Text = Buffer#toString('utf8') (BOM kept, invalid sequences replaced); utf8Bytes = Buffer.from(…, 'utf8') (lone surrogates replaced); latin1Text = Buffer#toString('latin1')", () => {
    fc.assert(fc.property(utf8ish, (b) => {
      expect(utf8Text(b)).toBe(Buffer.from(b).toString("utf8"));
      expect(latin1Text(b)).toBe(Buffer.from(b).toString("latin1"));
    }), { numRuns: 2000 });
    fc.assert(fc.property(fc.string({ unit: fc.oneof(codeUnit, fc.string({ unit: "binary", minLength: 1, maxLength: 1 })), maxLength: 40 }), (s) => {
      expect([...utf8Bytes(s)]).toEqual([...Buffer.from(s, "utf8")]);
    }), { numRuns: 2000 });
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(latin1Text(all)).toBe(Buffer.from(all).toString("latin1"));
  });

  it("entry points: the bytes of the ledger's string or byte form (a copy), hex and text views as before", () => {
    fc.assert(fc.property(fc.string({ unit: codeUnit, maxLength: 40 }), fc.uint8Array({ maxLength: 200 }), (s, b) => {
      expect([...entryPointBytes(s)]).toEqual([...Buffer.from(s, "utf8")]);
      const copy = entryPointBytes(b);
      expect([...copy]).toEqual([...b]);
      if (b.length > 0) expect(copy.buffer).not.toBe(b.buffer);
      expect(entryPointLabel(b)).toBe(entryPointText(b) ?? `<bytes ${Buffer.from(b).toString("hex")}>`);
      const j = entryPointJson(b);
      expect(j.hex).toBe(Buffer.from(b.subarray(0, 128)).toString("hex"));
    }), { numRuns: 500 });
    expect(entryPointText(new TextEncoder().encode("publishMetadata"))).toBe("publishMetadata");
  });

  it("API cursors: the same base64url text as Buffer gave, and only that canonical text decodes", () => {
    fc.assert(fc.property(fc.jsonValue(), (v) => {
      const c = encodeCursor(v);
      expect(c).toBe(Buffer.from(JSON.stringify(v), "utf8").toString("base64url"));
      if (c.length >= 1 && c.length <= 2048) expect(decodeCursor(c)).toEqual(JSON.parse(JSON.stringify(v)));
    }), { numRuns: 500 });
    fc.assert(fc.property(base64urlText.filter((s) => s.length > 0), (s) => {
      let want: unknown;
      try {
        const value = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
        want = encodeCursor(value) === s ? value : undefined;
      } catch {
        want = undefined;
      }
      expect(decodeCursor(s)).toEqual(want);
    }), { numRuns: 2000 });
  });
});
