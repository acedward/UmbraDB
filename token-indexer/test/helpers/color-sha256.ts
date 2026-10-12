/**
 * The independent SHA-256 form of a token color, used by the tests to cross-check `tokenColor` (which runs ledger-v9's
 * `rawTokenType`): `color = SHA-256(pad(32, "midnight:derive_token") ‖ domainSep ‖ contractAddress)`.
 *
 * Port of `tokenColorSha256` in `packages/midnight/src/color.ts` of https://github.com/midnight-experiments/mip-0018
 * @ daec1f1 (Apache-2.0; see `token-indexer/vendor/mip0018/LICENSE` and `NOTICE`).
 */
import { createHash } from "node:crypto";

const DERIVE_TOKEN = (() => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode("midnight:derive_token"));
  return b;
})();

function bytes32(hexOrBytes: string | Uint8Array, what: string): Uint8Array {
  const b = typeof hexOrBytes === "string"
    ? (/^(0x)?[0-9a-fA-F]{64}$/.test(hexOrBytes) ? Buffer.from(hexOrBytes.replace(/^0x/, ""), "hex") : undefined)
    : hexOrBytes;
  if (b === undefined || b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return Uint8Array.from(b);
}

/** `tokenType(domainSep, contractAddress)` computed with SHA-256, as lowercase hex (64 digits). */
export function tokenColorSha256(domainSep: string | Uint8Array, contractAddress: string | Uint8Array): string {
  return createHash("sha256").update(DERIVE_TOKEN).update(bytes32(domainSep, "domainSep")).update(bytes32(contractAddress, "contractAddress")).digest("hex");
}
