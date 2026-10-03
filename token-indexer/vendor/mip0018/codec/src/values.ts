// Value-type rules (MIP "Value types"). A value that breaks its type's rule rejects the whole event.
import { type RejectReason, UINT_MAX_BYTES, UINT_MIN_BYTES, ValType } from './constants.ts';
import { ALL_CODEC_RULES, type CodecRules } from './rules.ts';
import { isRfc3986Uri } from './uri.ts';

// Strict UTF-8 (RFC 3629): fatal on any ill-formed sequence (overlong forms, surrogates, > U+10FFFF, truncation).
// ignoreBOM: true keeps a leading U+FEFF as a character instead of silently dropping it, so the decoded text always
// corresponds to every byte of the value.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/** The value as text if it is valid UTF-8, otherwise `undefined`. Never throws. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Little-endian unsigned integer (the Compact serialization of `Uint<8 × length>`). */
export function decodeUint(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] as number);
  return v;
}

/** Big-endian reading — only used by the rule-mutation test (`littleEndian: false`). */
function decodeUintBigEndian(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i] as number);
  return v;
}

export function decodeUintWith(bytes: Uint8Array, rules: CodecRules): bigint {
  return rules.littleEndian ? decodeUint(bytes) : decodeUintBigEndian(bytes);
}

/** Encodes `value` as a `width`-byte little-endian unsigned integer (width 1–31). Throws `RangeError` if it does not fit. */
export function encodeUint(value: bigint | number, width: number): Uint8Array {
  let v = BigInt(value);
  if (!Number.isInteger(width) || width < UINT_MIN_BYTES || width > UINT_MAX_BYTES)
    throw new RangeError(`integer width must be 1-31 bytes, got ${width}`);
  if (v < 0n) throw new RangeError('integer must be unsigned');
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`integer does not fit in ${width} bytes`);
  return out;
}

/** Smallest width (≥ 1 byte) that holds `value`. */
export function minimalUintWidth(value: bigint | number): number {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError('integer must be unsigned');
  let w = 1;
  while ((v >>= 8n) > 0n) w++;
  return w;
}

/** Checks a value against its type's rule. Returns `undefined` when valid, otherwise the reject reason. */
export function checkValue(valType: number, value: Uint8Array, rules: CodecRules = ALL_CODEC_RULES): RejectReason | undefined {
  switch (valType) {
    case ValType.Bytes:
      return undefined;
    case ValType.Utf8:
      if (rules.utf8 && decodeUtf8(value) === undefined) return 'invalid-utf8';
      return undefined;
    case ValType.UInt:
      if (rules.integerLength && (value.length < UINT_MIN_BYTES || value.length > UINT_MAX_BYTES)) return 'bad-integer-length';
      return undefined;
    case ValType.Json: {
      const text = rules.utf8 ? decodeUtf8(value) : lossyUtf8.decode(value);
      if (text === undefined) return 'invalid-utf8';
      if (rules.json) {
        // Owner ruling F2: the platform JSON parser on the strictly decoded text decides "one complete JSON value".
        try {
          JSON.parse(text);
        } catch {
          return 'invalid-json';
        }
      }
      return undefined;
    }
    case ValType.Uri: {
      const text = rules.utf8 ? decodeUtf8(value) : lossyUtf8.decode(value);
      if (text === undefined) return 'invalid-utf8';
      if (rules.uri && !isRfc3986Uri(text)) return 'invalid-uri';
      return undefined;
    }
    case ValType.Null:
      if (rules.nullLength && value.length !== 0) return 'bad-null-length';
      return undefined;
    default:
      return rules.reservedTypes ? 'reserved-valtype' : undefined;
  }
}
