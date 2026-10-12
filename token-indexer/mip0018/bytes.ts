/**
 * Byte helpers of the token indexer that run unchanged in Node and in a browser (no `Buffer`, no `node:*` import):
 * hex (the vendored codec's `toHex` and `bytesEqual`; decoding as `Buffer.from(…, "hex")` does), UTF-8 and Latin-1
 * text, and the base64url text of the API's cursors. Each one gives exactly what the `Buffer` call it names gives.
 *
 * A `bytea` value read from the database is a `Buffer` on postgres.js and a plain `Uint8Array` on PGlite; both are
 * `Uint8Array`, which is all these helpers use.
 */
export { bytesEqual, toHex } from "../vendor/mip0018/codec/src/index.ts";
export { hexToBytes } from "../../src/postgres/bytes.js";

const utf8Encoder = new TextEncoder();
/** Keeps a leading byte-order mark and replaces invalid sequences with U+FFFD, as `Buffer#toString("utf8")` does. */
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** `Buffer.from(text, "utf8")`: a lone surrogate is written as U+FFFD. */
export function utf8Bytes(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** `Buffer#toString("utf8")`. */
export function utf8Text(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/** `Buffer#toString("latin1")`: each byte is the character of the same code (U+0000–U+00FF). */
export function latin1Text(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUE = new Map([...BASE64URL].map((c, i) => [c.charCodeAt(0), i]));

/** `Buffer#toString("base64url")`: the URL-safe alphabet, no padding. */
export function toBase64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += BASE64URL[n >> 18]! + BASE64URL[(n >> 12) & 63]! + BASE64URL[(n >> 6) & 63]! + BASE64URL[n & 63]!;
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i]! << 16;
    out += BASE64URL[n >> 18]! + BASE64URL[(n >> 12) & 63]!;
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += BASE64URL[n >> 18]! + BASE64URL[(n >> 12) & 63]! + BASE64URL[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Decodes base64url text (`A–Z a–z 0–9 - _`, no padding) as `Buffer.from(text, "base64url")` does: a last group of two
 * or three characters gives one or two bytes and its unused low bits are dropped; a single last character gives
 * nothing. Throws `SyntaxError` on any other character (callers accept only that alphabet).
 */
export function fromBase64url(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const v = BASE64URL_VALUE.get(text.charCodeAt(i));
    if (v === undefined) throw new SyntaxError("invalid base64url text");
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
