/**
 * Bech32m (BIP-350) and the Midnight wallet-address form built on it: every wallet address is served as Bech32m.
 *
 * - The checksum layer is BIP-173's algorithm with BIP-350's constant `0x2bc830a3`; a string that is only valid under
 *   the original Bech32 constant (1) is rejected (no string is valid under both).
 * - Length: BIP-173/350 cap a string at 90 characters. Midnight's own encodings are longer (a shielded address under
 *   `mn_shield-addr_<network>` is ≈ 140 characters), so every function takes a `limit`; the default is BIP's 90, and
 *   the unshielded wallet address (75 characters on Stagenet) fits it.
 * - The Midnight unshielded wallet address is the raw 32-byte `UserAddress` (no version byte, no prefix) under the
 *   HRP `mn_addr` + `_<networkId>` (the network segment is dropped on mainnet). Proven on recorded Stagenet data: the
 *   output of case C03's mint (block 714617) pays `UserAddress` `63a9ed57…a5e8`, and the MIP-0018 reference records
 *   that wallet as `mn_addr_stagenet1vw57646su9y5z6myarm93m6kcn62j97z0yma94lfkhmta6pz5h5q6utr3k`
 *   (`deployments/stagenet/README.md` of midnight-experiments/mip-0018 @ daec1f1; test `[[mip0018.bech32m.recorded]]`).
 *   The Stagenet network id is `stagenet` (the reference's `packages/midnight/src/network.ts`).
 * - Scope: Bech32m for wallet addresses only — never for contract addresses, colors, transaction or intent
 *   hashes, which stay hex. Shielded (`mn_shield-addr_…`) and DUST (`mn_dust_…`) addresses never appear in the public
 *   data the activity rows are built from (a shielded output is a commitment; DUST has no activity rows), so only the
 *   unshielded form has a helper here; the generic encoder covers the others if they are ever needed.
 *
 * Pure and dependency-free. Errors never echo the input.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_REV: readonly number[] = (() => {
  const rev = new Array<number>(128).fill(-1);
  for (let i = 0; i < CHARSET.length; i++) rev[CHARSET.charCodeAt(i)] = i;
  return rev;
})();

/** BIP-350's checksum constant (BIP-173's Bech32 uses 1). */
export const BECH32M_CONST = 0x2bc830a3;
/** BIP-173/350's maximum string length — the default `limit`. */
export const BIP173_MAX_LENGTH = 90;
/** Upper bound for Midnight's longer encodings (a shielded address is ≈ 140 characters); also caps hostile input. */
export const MIDNIGHT_MAX_LENGTH = 512;

export type Bech32mFailure =
  | "too-long"
  | "char-out-of-range"
  | "mixed-case"
  | "no-separator"
  | "empty-hrp"
  | "checksum-too-short"
  | "invalid-data-char"
  | "bad-checksum"
  | "invalid-padding"
  | "wrong-hrp"
  | "wrong-length";

/** A decode failure; `failure` is a stable discriminant and the message never contains the input. */
export class Bech32mError extends Error {
  override name = "Bech32mError";
  constructor(readonly failure: Bech32mFailure) {
    super(`bech32m: ${failure}`);
  }
}

export interface LengthLimit {
  /** Maximum string length (default {@link BIP173_MAX_LENGTH}). */
  limit?: number;
}

function polymod(values: readonly number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i] as number;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** BIP-173 `convertbits`; `undefined` when `pad` is false and the leftover bits are non-zero or too many. */
export function convertBits(data: readonly number[], fromBits: number, toBits: number, pad: boolean): number[] | undefined {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) return undefined;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return undefined;
  }
  return out;
}

function checkHrp(hrp: string): void {
  if (hrp.length === 0) throw new Error("bech32m: empty hrp");
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) throw new Error("bech32m: hrp character out of range");
    if (c >= 0x41 && c <= 0x5a) throw new Error("bech32m: hrp must be lowercase");
  }
}

/** Encodes 5-bit words under `hrp` (lowercase), with the Bech32m checksum. */
export function encodeBech32mWords(hrp: string, words: readonly number[], o: LengthLimit = {}): string {
  checkHrp(hrp);
  for (const w of words) if (!Number.isInteger(w) || w < 0 || w > 31) throw new Error("bech32m: a word is not 5 bits");
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  const out = `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
  if (out.length > (o.limit ?? BIP173_MAX_LENGTH)) throw new Error(`bech32m: result longer than ${o.limit ?? BIP173_MAX_LENGTH} characters`);
  return out;
}

/** Decodes a Bech32m string into its lowercase HRP and 5-bit data words (checksum removed). */
export function decodeBech32mWords(input: string, o: LengthLimit = {}): { hrp: string; words: number[] } {
  if (input.length > (o.limit ?? BIP173_MAX_LENGTH)) throw new Bech32mError("too-long");
  let lower = false;
  let upper = false;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 33 || c > 126) throw new Bech32mError("char-out-of-range");
    if (c >= 0x61 && c <= 0x7a) lower = true;
    if (c >= 0x41 && c <= 0x5a) upper = true;
  }
  if (lower && upper) throw new Bech32mError("mixed-case");
  const s = input.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep === -1) throw new Bech32mError("no-separator");
  if (sep === 0) throw new Bech32mError("empty-hrp");
  if (s.length - sep - 1 < 6) throw new Bech32mError("checksum-too-short");
  const hrp = s.slice(0, sep);
  const values: number[] = [];
  for (let i = sep + 1; i < s.length; i++) {
    const v = CHARSET_REV[s.charCodeAt(i)] ?? -1;
    if (v === -1) throw new Bech32mError("invalid-data-char");
    values.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...values]) !== BECH32M_CONST) throw new Bech32mError("bad-checksum");
  return { hrp, words: values.slice(0, -6) };
}

/** Encodes bytes under `hrp` as Bech32m (8-bit → 5-bit words, zero-padded). */
export function encodeBech32m(hrp: string, data: Uint8Array, o: LengthLimit = {}): string {
  return encodeBech32mWords(hrp, convertBits([...data], 8, 5, true) as number[], o);
}

/** Decodes a Bech32m string carrying bytes (5-bit → 8-bit words, canonical padding required). */
export function decodeBech32m(input: string, o: LengthLimit = {}): { hrp: string; data: Uint8Array } {
  const { hrp, words } = decodeBech32mWords(input, o);
  const bytes = convertBits(words, 5, 8, false);
  if (bytes === undefined) throw new Bech32mError("invalid-padding");
  return { hrp, data: Uint8Array.from(bytes) };
}

/** The network id whose addresses carry no network segment. */
export const MAINNET_NETWORK_ID = "mainnet";

/** HRP of an unshielded wallet address: `mn_addr_<network>`, or `mn_addr` on mainnet. */
export function unshieldedAddressHrp(network: string): string {
  const id = network.toLowerCase();
  if (id.length === 0) throw new Error("bech32m: empty network id");
  const hrp = id === MAINNET_NETWORK_ID ? "mn_addr" : `mn_addr_${id}`;
  checkHrp(hrp);
  return hrp;
}

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;

/** The Bech32m wallet address of a 32-byte `UserAddress` (hex) on `network`. */
export function walletAddress(network: string, userAddressHex: string): string {
  if (!HEX32.test(userAddressHex)) throw new Error("bech32m: a wallet address is 32 bytes of hex");
  return encodeBech32m(unshieldedAddressHrp(network), Buffer.from(userAddressHex.replace(/^0x/, ""), "hex"));
}

/** The 32-byte `UserAddress` (lowercase hex) of a Bech32m wallet address of `network`. */
export function decodeWalletAddress(network: string, address: string): string {
  const { hrp, data } = decodeBech32m(address);
  if (hrp !== unshieldedAddressHrp(network)) throw new Bech32mError("wrong-hrp");
  if (data.length !== 32) throw new Bech32mError("wrong-length");
  return Buffer.from(data).toString("hex");
}
