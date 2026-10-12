/**
 * Byte helpers for `bytea` values and content hashes that run unchanged in Node and in a browser: no `Buffer` and no
 * `node:*` import.
 *
 * A `bytea` value is a `Uint8Array` on every driver: postgres.js returns a `Buffer` (a `Uint8Array` subclass) and
 * PGlite a plain `Uint8Array`. Code that reads one uses these helpers or the `Uint8Array` API, never a `Buffer`
 * method. postgres.js writes any `Uint8Array` parameter as `bytea`, exactly as it writes a `Buffer`.
 */
import { sha256 } from "@noble/hashes/sha2.js";

const BYTE_HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));

/** Lowercase hex of `bytes`, as `Buffer#toString("hex")` writes it. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += BYTE_HEX[b]!;
  return out;
}

/** The value of one hex digit, or -1. Like `Buffer.from(…, "hex")`, it reads the low 8 bits of the UTF-16 code unit. */
function hexDigit(code: number): number {
  const c = code & 0xff;
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

/**
 * Decodes hex exactly as `Buffer.from(text, "hex")` does, so every input gives the same bytes: two digits per byte,
 * either case; decoding stops at the first pair that holds a non-digit; an odd last digit is ignored. Never throws.
 */
export function hexToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    const hi = hexDigit(text.charCodeAt(2 * i));
    const lo = hexDigit(text.charCodeAt(2 * i + 1));
    if (hi < 0 || lo < 0) return out.slice(0, i);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** SHA-256 of `bytes` as lowercase hex (64 digits). */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
