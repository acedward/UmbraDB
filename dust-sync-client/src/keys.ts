import { readFile, stat } from "node:fs/promises";
import { MIDNIGHT_ROLES, deriveMidnightRoleSeed, midnightRolePath } from "../../shielded-monitor/hd.js";
import type { DustSecretKeyLike } from "./ledger.js";

/**
 * The wallet's DUST secret key, derived exactly as the Midnight wallet SDK derives it
 * (`spec/00016-dust-wallet-sync.md` FR-031, plan D3.2).
 *
 * ── The path, and where it was read from ────────────────────────────────────────────────────
 * `m/44'/2400'/0'/2/0`. The SDK's own chain is
 * `HDWallet.fromSeed(seed).selectAccount(0).selectRoles([…, Dust]).deriveKeysAt(0)` →
 * `@scure/bip32`'s `HDKey.fromMasterSeed(seed).derive("m/44'/2400'/0'/2/0")`, then
 * `DustSecretKey.fromSeed(<the 32-byte private key>)`
 * (`@midnightntwrk/wallet-sdk-hd/dist/HDWallet.js`, and `wallet-sdk-dust-wallet/dist/DustWallet.js`
 * line 75, both read from the SDK image on 2026-09-15). `Roles.Dust = 2`, and neither the role nor
 * the index is hardened.
 *
 * This repository already implements that derivation for the shielded role
 * (`shielded-monitor/hd.ts`, whose BIP-0032 arithmetic is pinned against the official test vector
 * AND against three key vectors captured from the SDK). Reusing it with `role = 2` is therefore
 * not a re-implementation — it is the same proven code with a different role number.
 *
 * ── It is still proved, not assumed ─────────────────────────────────────────────────────────
 * FR-031 says the derivation MUST be verified against the SDK's, so
 * `dust-sync-client/devnet/sdk/dust-public-key.ts` prints `DustSecretKey.fromSeed(keys[Roles.Dust])
 * .publicKey` inside the SDK image for a given seed, and the devnet run compares it with what this
 * module produces. A DUST public key is public (it is the identity the wallet sends the node, Q-1),
 * so the comparison can be made in the open; the seed it came from cannot.
 *
 * ── Custody (SC-006) ────────────────────────────────────────────────────────────────────────
 * {@link readSeedFile} refuses a seed file that anyone but its owner can read, because the
 * alternative is a 32-byte spending secret sitting world-readable in a shared machine's
 * filesystem. Nothing here logs, returns or serializes the seed or the derived key; the only
 * thing that leaves is a `DustSecretKey` handle and its public key.
 */

/** The BIP-0044 path this module derives, for printing next to a public key. */
export const DUST_KEY_PATH = midnightRolePath({ role: MIDNIGHT_ROLES.Dust }).text;

/** What the ledger module must expose for {@link dustSecretKeyFromSeed}. */
export interface DustSecretKeyFactory {
  readonly DustSecretKey: { fromSeed(seed: Uint8Array): DustSecretKeyLike };
}

/** `seed` (the wallet's 32-byte master seed) → the DUST secret key at `m/44'/2400'/0'/2/0`. */
export function dustSecretKeyFromSeed(ledger: DustSecretKeyFactory, seed: Uint8Array): DustSecretKeyLike {
  const roleSeed = deriveMidnightRoleSeed(seed, { role: MIDNIGHT_ROLES.Dust });
  return ledger.DustSecretKey.fromSeed(new Uint8Array(roleSeed));
}

export class SeedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedFileError";
  }
}

/**
 * Reads a hex seed from a file that only its owner may read.
 *
 * The mode check is a real gate, not advice: this CLI is run on a shared host where the plan's
 * own rule is "seeds mode 600, never printed". The file's CONTENT never reaches a log, an error
 * message or the returned value's description — only its length is ever mentioned.
 */
export async function readSeedFile(path: string): Promise<Uint8Array> {
  const info = await stat(path).catch((error: unknown) => {
    throw new SeedFileError(`cannot read the seed file: ${error instanceof Error ? error.message : String(error)}`);
  });
  // eslint-disable-next-line no-bitwise
  if ((info.mode & 0o077) !== 0) {
    throw new SeedFileError(
      `the seed file is mode ${(info.mode & 0o777).toString(8)}; it must be 600 (owner-only) — ` +
        "a DUST secret key is derived from it",
    );
  }
  const text = (await readFile(path, "utf8")).trim();
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) {
    throw new SeedFileError("the seed file must hold hex (no 0x), nothing else");
  }
  const bytes = Buffer.from(text, "hex");
  if (bytes.length < 16 || bytes.length > 64) {
    throw new SeedFileError(`the seed must be 16..64 bytes, got ${bytes.length}`);
  }
  return new Uint8Array(bytes);
}
