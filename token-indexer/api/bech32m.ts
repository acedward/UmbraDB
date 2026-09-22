/**
 * Bech32m (BIP-350) encode/decode, and the Midnight wallet-address rule on top of it.
 *
 * ── Why this file exists (project 00023, owner decision Q9) ────────────────────────────────────
 * The ledger gives a wallet address as 32 raw bytes; every wallet and the indexer itself show it
 * as `mn_addr_<network>1…`. The owner's decision, confirmed twice on 2026-09-21, is that Bech32m
 * **replaces** the hex wherever Bech32m is the standard display — unshielded owner addresses,
 * shielded addresses, DUST addresses — and is **never** used for contract addresses, colours,
 * transaction hashes, commitments, nullifiers or keys, which stay hex. The JSON additionally
 * carries `ownerHex` for machine consumers that join by address; the page never shows it.
 *
 * ── Why it is implemented rather than taken as a dependency ────────────────────────────────────
 * Spec FR-016: no new runtime dependency. The algorithm is fully specified in BIP-350, is ~120
 * lines, and publishes both valid and invalid vectors, so a local implementation is provable
 * rather than trusted. This module is a straight port of the dependency-free
 * `shielded-monitor/bech32m.ts` written for project 00009 on the other lineage, with the address
 * helpers of {@link ownerAddress} / {@link decodeOwnerAddress} added on top.
 *
 * ── The layout, VERIFIED against the chain (2026-09-21, sub-plan task A4.3) ────────────────────
 * `data` is the raw 32-byte `UserAddress`, with **no version byte and no prefix**. Proven on two
 * real Stagenet UTXOs whose owner the public indexer serves as Bech32m and whose owner the ledger
 * reports as hex:
 *
 * ```
 * mn_addr_stagenet1mdtrcaank64kwqnjpa7pm83dp075ypxrlpq5vzmdq09sq7d0tp0s967v0h
 *   ↔ db563c77b3b6ab6702720f7c1d9e2d0bfd4204c3f841460b6d03cb0079af585f   (deposit-toMap's spender)
 * mn_addr_stagenet127xnp9uuxwhh7a8an77mxv02ypt6u09xkk63c9zvdkjsrj4mj68qg7c5ad
 *   ↔ 578d30979c33af7f74fd9fbdb331ea2057ae3ca6b5b51c144c6da501cabb968e   (night-passthrough's owner)
 * ```
 *
 * and on the recorded Stagenet test wallet's own address. `[[token-activity-bech32m]]` pins all
 * three. The HRP is `mn` + `_addr` + (`_<network>` unless mainnet), per the wallet SDK's
 * `@midnight-ntwrk/wallet-sdk-address-format` (`address-format/src/index.ts:60-115`).
 *
 * Scope: **Bech32m only** (checksum constant `0x2bc830a3`). A string valid under the original
 * Bech32 constant (`1`) is rejected — it is a different encoding, and silently accepting it would
 * widen the accepted set for no reason.
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
 * BIP-173 defines, not of this HRP family. Midnight's longest HRP in public data,
 * `mn_addr_stagenet` with a 32-byte payload, lands at 75 characters — comfortably under either
 * bound. This bound exists only
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
 *  never echoes the offending input. (That rule was written for 00009's viewing keys; nothing
 *  this indexer decodes is secret, but an error that quotes user input back is a habit worth
 *  keeping out of a public API.) */
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
 * about while this layer stays strict about the thing a wallet address actually is: 32 bytes.
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

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * The Midnight wallet-address layer (owner decision Q9).
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The type segment of an unshielded wallet address. The package also defines `shield-addr`,
 *  `shield-esk`, `shield-cpk` and `shield-epk`; none of them appears in public transaction data,
 *  so this indexer only ever needs this one. */
export const ADDRESS_TYPE_SEGMENT = "addr";

/**
 * The human-readable part for a network: `mn_addr` on mainnet, `mn_addr_<network>` everywhere
 * else. The network segment is the indexer's configured `NET` (`stagenet` today), which is the
 * same string the wallet SDK writes.
 */
export function addressHrp(net: string): string {
  const network = net.trim().toLowerCase();
  return network === "mainnet" || network === ""
    ? `mn_${ADDRESS_TYPE_SEGMENT}`
    : `mn_${ADDRESS_TYPE_SEGMENT}_${network}`;
}

/**
 * A 32-byte `UserAddress` (lowercase unprefixed hex) as the Bech32m string a wallet shows.
 *
 * @throws if the hex is not exactly 32 bytes — a truncated address that still encoded would be a
 *   plausible-looking lie, which is worse than an error.
 */
export function ownerAddress(net: string, ownerHex: string): string {
  const clean = ownerHex.startsWith("0x") ? ownerHex.slice(2) : ownerHex;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`ownerAddress: expected 32 bytes of hex, got ${clean.length / 2}`);
  }
  return encodeBech32m(addressHrp(net), Uint8Array.from(Buffer.from(clean.toLowerCase(), "hex")));
}

/**
 * The inverse: a `mn_addr…` string back to its 32-byte hex, with the HRP it carried.
 *
 * Used by the round-trip test and by any caller that needs to look a pasted address up by hex.
 * The HRP is returned rather than checked, so a caller can decide for itself whether an address
 * from another network is an error or merely a different network.
 */
export function decodeOwnerAddress(address: string): { hrp: string; hex: string } {
  const decoded = decodeBech32m(address);
  if (decoded.data.length !== 32) {
    throw new Bech32mError("invalid-padding");
  }
  return { hrp: decoded.hrp, hex: Buffer.from(decoded.data).toString("hex") };
}
