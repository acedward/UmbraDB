import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The Midnight wallet-SDK HD vectors, and the seeds they were captured with.
 *
 * ── Why the seeds are code and not data ─────────────────────────────────────────────────────
 * `wallet-sdk-hd-vectors.json` deliberately records no seed, no derived role seed and no
 * serialized secret key — only public keys. This repository's own gitleaks rule
 * `umbradb-wallet-seed-hex` catches a 64-hex value in a seed- or secret-named field, and
 * `.gitleaks.toml` records, as a fixed audit finding, that a path allowlist is a permanent global
 * exemption and must not exist. Committing synthetic secret material and then suppressing the
 * scanner would disarm that gate for every future secret on that path; committing none keeps it
 * armed.
 *
 * So the three seeds are **constructed here from a recipe**, exactly as `helpers.ts`'s
 * `fixtureSeed(n)` already does for every other suite in this module. A recipe is also simply
 * more legible than a hex blob: "all zero but the last byte" says what it is; the hex does not.
 *
 * None of these is a key. They are inputs to a derivation inside a test process, and nothing
 * derived from them is used on any network.
 */

export type SeedRecipe = "zeros-with-last-byte-1" | "ascending-0-to-31" | "repeated-deadbeef";

export interface WalletHdVector {
  readonly seedRecipe: SeedRecipe;
  /** Public. Half of the shielded address a funder pays. */
  readonly coinPublicKey: string;
  /** Public. The other half. */
  readonly encryptionPublicKey: string;
}

export interface WalletHdVectorFile {
  readonly account: number;
  readonly role: number;
  readonly index: number;
  readonly path: string;
  readonly vectors: readonly WalletHdVector[];
}

export const walletHdVectors: WalletHdVectorFile = JSON.parse(
  readFileSync(fileURLToPath(new URL("./wallet-sdk-hd-vectors.json", import.meta.url)), "utf8"),
) as WalletHdVectorFile;

/** The 32-byte seed a recipe names. Throws on an unknown recipe rather than returning a default:
 *  a typo that silently derived from zeros would make a vector pass against the wrong input. */
export function seedFor(recipe: SeedRecipe): Buffer {
  switch (recipe) {
    case "zeros-with-last-byte-1": {
      const seed = Buffer.alloc(32);
      seed[31] = 1;
      return seed;
    }
    case "ascending-0-to-31":
      return Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    case "repeated-deadbeef":
      return Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0xde, 0xad, 0xbe, 0xef])));
    default: {
      const exhaustive: never = recipe;
      throw new Error(`unknown seed recipe ${JSON.stringify(exhaustive)}`);
    }
  }
}
