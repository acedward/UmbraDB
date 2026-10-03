// Hex helpers (lowercase output; strict input).

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += (HEX[b >> 4] as string) + (HEX[b & 15] as string);
  }
  return out;
}

/** Parses an even-length hex string (optionally `0x`-prefixed). Throws `SyntaxError` on anything else. */
export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new SyntaxError('invalid hex string');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * MIP "Consuming": "Some sources drop trailing zero bytes; consumers MUST treat missing trailing bytes as zero, so that
 * every `name` is 32 bytes and every `payload` 256 bytes, before decoding." Returns `bytes` zero-extended to `size`
 * (a copy when shorter, the input itself when exactly `size`), or `undefined` when `bytes` is longer than `size`.
 */
export function zeroExtend(bytes: Uint8Array, size: number): Uint8Array | undefined {
  if (bytes.length === size) return bytes;
  if (bytes.length > size) return undefined;
  const out = new Uint8Array(size);
  out.set(bytes, 0);
  return out;
}
