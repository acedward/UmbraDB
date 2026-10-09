/**
 * Token colors (MIP-0018 "Terminology", "Lookup"): `color = tokenType(domainSep, contractAddress)`, the Compact
 * standard library's
 *
 *   tokenType(domainSep, contractAddress) = persistentCommit<Vector<2, Bytes<32>>>([domainSep, contractAddress],
 *                                                                                   pad(32, "midnight:derive_token"))
 *
 * computed with ledger-v9's `rawTokenType` (the code the ledger itself runs). One color serves the shielded (kind 1)
 * and the unshielded (kind 2) representation; a ledger token (kind 3) never has one. A color MUST always be computed,
 * never read from a value.
 *
 * Port of `packages/midnight/src/color.ts` of https://github.com/midnight-experiments/mip-0018 @ daec1f1
 * (Apache-2.0; see `token-indexer/vendor/mip0018/LICENSE` and `NOTICE`): `tokenColor` (the reference's
 * `tokenTypeHex`). The tests cross-check it with the reference's independent SHA-256 form of the same commitment
 * (`token-indexer/test/helpers/color-sha256.ts`).
 */
import { rawTokenType } from "@midnightntwrk/ledger-v9";
import { hexToBytes, toHex } from "./bytes.ts";

export class ColorError extends Error {
  override name = "ColorError";
}

function bytes32(hexOrBytes: string | Uint8Array, what: string): Uint8Array {
  const b = typeof hexOrBytes === "string"
    ? (/^(0x)?[0-9a-fA-F]{64}$/.test(hexOrBytes) ? hexToBytes(hexOrBytes.replace(/^0x/, "")) : undefined)
    : hexOrBytes;
  if (b === undefined || b.length !== 32) throw new ColorError(`${what} must be 32 bytes`);
  return Uint8Array.from(b);
}

/** `tokenType(domainSep, contractAddress)` as lowercase hex (64 digits). */
export function tokenColor(domainSep: string | Uint8Array, contractAddress: string | Uint8Array): string {
  const address = toHex(bytes32(contractAddress, "contractAddress"));
  return String(rawTokenType(bytes32(domainSep, "domainSep"), address)).toLowerCase();
}
