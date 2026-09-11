/**
 * Bech32m (BIP-350) encode/decode, implemented here rather than taken as a dependency.
 *
 * Why implement it: Midnight shielded viewing keys arrive Bech32m-encoded with a network-bound
 * human-readable part, and the HRP↔network binding is this repository's responsibility either way
 * — neither the vendored ledger v8 WASM (`vendor/ledger-v8-syshash/midnight_ledger_wasm.d.ts`) nor
 * the ledger v9 source (`resources/midnight-ledger-4823b53`) exposes a Bech32 helper. The
 * reference indexer uses Rust's `bech32` crate for exactly this step
 * (`indexer-api/src/infra/api/v4.rs:190-204`). The algorithm is fully specified and ~120 lines,
 * and BIP-350 publishes both valid and invalid vectors, so a local implementation is provable
 * rather than trusted; adding a runtime dependency for it would be the larger risk under
 * `design/design.md` §7's minimal-dependency posture.
 *
 * Scope: this module implements **Bech32m only** (checksum constant `0x2bc830a3`). A string that
 * is valid under the original Bech32 constant (`1`) is rejected, because the organizer spec
 * FR-001 says the key is Bech32m and silently accepting the older constant would widen the
 * accepted set for no reason.
 *
 * This module is pure and dependency-free: no I/O, no key material, no logging.
 */

/** The Bech32 data character set (BIP-173 §"Bech32"). Index = 5-bit value. */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Reverse lookup for {@link CHARSET}; `-1` for a character outside the set. */
const CHARSET_REV: readonly number[] = (() => {
  const rev = new Array<number>(128).fill(-1);
  for (let i = 0; i < CHARSET.length; i++) rev[CHARSET.charCodeAt(i)] = i;
  return rev;
})();

/** BIP-350's Bech32m checksum constant. BIP-173's original Bech32 constant is `1`. */
const BECH32M_CONST = 0x2bc830a3;

/**
 * Upper bound on an accepted string, applied before any per-character work.
 *
 * BIP-173's own 90-character limit is deliberately NOT used: it is a property of the addresses
 * BIP-173 defines, not of this HRP family, and Midnight's `mn_shield-esk_<network>` HRP with a
 * 32-byte payload lands at 83 characters — comfortably under either bound. This bound exists only
 * so a hostile multi-megabyte input is rejected before the polymod loop runs.
 */
export const MAX_BECH32M_LENGTH = 512;

/** Why a string was rejected. Stable discriminants, safe to log — none of them carries any part
 *  of the input. */
export type Bech32mDecodeFailure =
  | "too-long"
  | "empty"
  | "mixed-case"
  | "char-out-of-range"
  | "no-separator"
  | "empty-hrp"
  | "data-too-short"
  | "invalid-data-char"
  | "bad-checksum"
  | "invalid-padding";

/** Thrown by {@link decodeBech32m}. Carries a machine-readable {@link Bech32mDecodeFailure} and
 *  never echoes the offending input — a viewing key must not travel inside an error
 *  (organizer spec FR-023). */
export class Bech32mError extends Error {
  constructor(readonly failure: Bech32mDecodeFailure) {
    super(`bech32m: ${failure}`);
    this.name = "Bech32mError";
  }
}

/** BIP-173's `bech32_polymod` over 5-bit values. */
function polymod(values: readonly number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if (((top >>> i) & 1) !== 0) chk ^= GEN[i]!;
    }
  }
  return chk >>> 0;
}

/** BIP-173's `hrp_expand`: high bits of every HRP character, a zero, then the low bits. */
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** Generic base conversion (BIP-173's `convertbits`). Returns `undefined` when `pad` is false and
 *  the residue is non-canonical (leftover bits set, or more than `toBits - 1` of them). */
function convertBits(
  data: readonly number[], fromBits: number, toBits: number, pad: boolean,
): number[] | undefined {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >>> fromBits !== 0) return undefined;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return undefined;
  }
  return out;
}

/** A successfully decoded Bech32m string. `hrp` is lowercase; `data` is the 8-bit payload. */
export interface Bech32mDecoded {
  readonly hrp: string;
  readonly data: Uint8Array;
}

/** A Bech32m string whose checksum verified, before the 5→8-bit conversion. `words` are the
 *  payload's 5-bit groups with the six checksum characters already removed. */
export interface Bech32mWords {
  readonly hrp: string;
  readonly words: readonly number[];
}

/**
 * Decodes a Bech32m string into its human-readable part and 8-bit payload.
 *
 * Two layers, deliberately: {@link decodeBech32mWords} performs the character and checksum
 * validation BIP-350 specifies, and this function adds the 5→8-bit conversion with **no padding
 * slack**. BIP-350's own "valid" vector set includes strings whose 5-bit payload does not
 * correspond to any whole-byte string (they exist to exercise the checksum, not a byte payload),
 * so the split lets the test suite assert BIP-350's vectors faithfully at the layer they are
 * about while this layer stays strict about the thing a viewing key actually is: bytes.
 *
 * Rejects, with a discriminated {@link Bech32mError}: an over-long string; mixed case
 * (BIP-173/350 — this matters here because the HRP is compared case-sensitively afterwards, so
 * accepting mixed case would let `MN_SHIELD-ESK_…` slip past the network binding); any character
 * outside US-ASCII 33..126; a missing separator; an empty HRP; fewer than the six checksum
 * characters; a data character outside the charset; a failing checksum — including one that is
 * valid under the ORIGINAL Bech32 constant, which is a different encoding and is not accepted
 * here; and non-canonical padding in the 5→8-bit conversion.
 */
export function decodeBech32m(input: string): Bech32mDecoded {
  const { hrp, words } = decodeBech32mWords(input);
  const payload = convertBits(words, 5, 8, false);
  if (payload === undefined) throw new Bech32mError("invalid-padding");
  return { hrp, data: Uint8Array.from(payload) };
}

/**
 * The BIP-350 layer of {@link decodeBech32m}: character-set, case, separator and checksum
 * validation, returning the payload as 5-bit words without converting it to bytes.
 */
export function decodeBech32mWords(input: string): Bech32mWords {
  if (input.length > MAX_BECH32M_LENGTH) throw new Bech32mError("too-long");
  if (input.length === 0) throw new Bech32mError("empty");

  let hasLower = false;
  let hasUpper = false;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 33 || code > 126) throw new Bech32mError("char-out-of-range");
    if (code >= 0x61 && code <= 0x7a) hasLower = true;
    if (code >= 0x41 && code <= 0x5a) hasUpper = true;
  }
  if (hasLower && hasUpper) throw new Bech32mError("mixed-case");

  const normalized = input.toLowerCase();
  const sep = normalized.lastIndexOf("1");
  if (sep === -1) throw new Bech32mError("no-separator");
  if (sep === 0) throw new Bech32mError("empty-hrp");
  // Six checksum characters must follow the separator, plus zero or more data characters.
  if (normalized.length - sep - 1 < 6) throw new Bech32mError("data-too-short");

  const hrp = normalized.slice(0, sep);
  const dataChars = normalized.slice(sep + 1);

  const values: number[] = [];
  for (let i = 0; i < dataChars.length; i++) {
    const value = CHARSET_REV[dataChars.charCodeAt(i)] ?? -1;
    if (value === -1) throw new Bech32mError("invalid-data-char");
    values.push(value);
  }

  if (polymod([...hrpExpand(hrp), ...values]) !== BECH32M_CONST) throw new Bech32mError("bad-checksum");

  return { hrp, words: values.slice(0, values.length - 6) };
}

/**
 * Encodes an 8-bit payload as a Bech32m string under `hrp`.
 *
 * Used by the trusted harness and by the tests that build key vectors from
 * `ZswapSecretKeys.fromSeed`; the production intake path only ever decodes. Throws a plain
 * `Error` (not {@link Bech32mError}, which is the decode-side failure type) for an HRP that could
 * not round-trip: empty, out of the 33..126 range, uppercase, or long enough to push the result
 * past {@link MAX_BECH32M_LENGTH} — encoding something this module would then refuse to decode
 * would be a silent trap for the caller.
 */
export function encodeBech32m(hrp: string, data: Uint8Array): string {
  if (hrp.length === 0) throw new Error("bech32m: empty hrp");
  for (let i = 0; i < hrp.length; i++) {
    const code = hrp.charCodeAt(i);
    if (code < 33 || code > 126) throw new Error("bech32m: hrp character out of range");
    if (code >= 0x41 && code <= 0x5a) throw new Error("bech32m: hrp must be lowercase");
  }
  const values = convertBits([...data], 8, 5, true);
  // `convertBits` with `pad: true` cannot fail for 8-bit inputs, but the type says it can.
  if (values === undefined) throw new Error("bech32m: payload could not be converted to 5-bit groups");
  const checksumInput = [...hrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0];
  const mod = polymod(checksumInput) ^ BECH32M_CONST;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  const encoded = hrp + "1" + [...values, ...checksum].map((v) => CHARSET[v]!).join("");
  if (encoded.length > MAX_BECH32M_LENGTH) throw new Error("bech32m: encoded string exceeds the accepted length bound");
  return encoded;
}
