/* eslint-disable @typescript-eslint/no-explicit-any */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { seedFor, type SeedRecipe } from "../../test/shielded-monitor/fixtures/wallet-sdk-hd-vectors.js";
import { DUST_KEY_PATH, SeedFileError, dustSecretKeyFromSeed, readSeedFile } from "../src/keys.js";
import { loadLedger } from "./fake-node.js";

/**
 * The client derives the DUST key a WALLET would (`spec/00016-dust-wallet-sync.md` FR-031, plan
 * D3.2), and refuses a seed file anyone else can read (SC-006).
 *
 * The vectors are the wallet SDK's own output, captured out of tree from
 * `midnight-1-offers/shielded-night-deploy:local` with
 * `dust-sync-client/devnet/sdk/dust-public-key.ts` — the same method and the same
 * public-keys-only discipline `test/shielded-monitor/fixtures/wallet-sdk-hd-vectors.json` uses for
 * the shielded role. The seeds are rebuilt from that file's recipes, so no secret material is
 * committed and this repository's `umbradb-wallet-seed-hex` gitleaks rule stays armed.
 */

interface DustVectorFile {
  readonly role: number;
  readonly path: string;
  readonly vectors: readonly { readonly seedRecipe: SeedRecipe; readonly dustPublicKey: string }[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/wallet-sdk-dust-vectors.json", import.meta.url)), "utf8"),
) as DustVectorFile;

let ledger: any;

beforeAll(async () => {
  ledger = await loadLedger();
}, 120_000);

describe("the DUST key derivation matches the wallet SDK's", () => {
  it("derives at m/44'/2400'/0'/2/0 — role 2, not the shielded role 3", () => {
    expect(DUST_KEY_PATH).toBe("m/44'/2400'/0'/2/0");
    expect(vectors.path).toBe(DUST_KEY_PATH);
    expect(vectors.role).toBe(2);
  });

  it("reproduces the SDK's DUST public key for every captured seed", () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(3);
    for (const vector of vectors.vectors) {
      const secretKey = dustSecretKeyFromSeed(ledger, new Uint8Array(seedFor(vector.seedRecipe)));
      expect(secretKey.publicKey.toString(10), vector.seedRecipe).toBe(vector.dustPublicKey);
    }
  });

  it("gives a different key from the shielded role, on the same seed", async () => {
    // The whole risk this test exists for: a correct BIP-0032 implementation on the WRONG role
    // produces a perfectly valid key for a different purpose, and nothing downstream notices —
    // the SDK vectors above would then all fail together, which is exactly the signal, but this
    // case says WHY in one line.
    const { deriveMidnightRoleSeed } = await import("../../shielded-monitor/hd.js");
    const seed = new Uint8Array(seedFor("ascending-0-to-31"));
    const dustRole2 = dustSecretKeyFromSeed(ledger, seed).publicKey.toString(10);
    const asRole3 = ledger.DustSecretKey.fromSeed(
      new Uint8Array(deriveMidnightRoleSeed(seed, { role: 3 })),
    ).publicKey.toString(10);
    expect(dustRole2).not.toBe(asRole3);
    expect(dustRole2).toBe(vectors.vectors.find((v) => v.seedRecipe === "ascending-0-to-31")?.dustPublicKey);
  });
});

describe("the seed file is owner-only or the run does not start", () => {
  const dir = mkdtempSync(join(tmpdir(), "dust-seed-"));

  it("reads a mode-600 hex seed", async () => {
    const path = join(dir, "ok.hex");
    writeFileSync(path, `${"ab".repeat(32)}\n`, { mode: 0o600 });
    const seed = await readSeedFile(path);
    expect(seed).toHaveLength(32);
  });

  it("refuses a group- or world-readable seed file", async () => {
    const path = join(dir, "loose.hex");
    writeFileSync(path, `${"ab".repeat(32)}\n`, { mode: 0o600 });
    chmodSync(path, 0o644);
    await expect(readSeedFile(path)).rejects.toBeInstanceOf(SeedFileError);
    // …and the refusal does not quote the file's contents.
    await readSeedFile(path).catch((error: unknown) => {
      expect(String(error)).not.toContain("abab");
    });
  });

  it("refuses a file that is not plain hex, and one of an implausible length", async () => {
    const bad = join(dir, "bad.hex");
    writeFileSync(bad, "0xdeadbeef\n", { mode: 0o600 });
    await expect(readSeedFile(bad)).rejects.toBeInstanceOf(SeedFileError);

    const short = join(dir, "short.hex");
    writeFileSync(short, "abcd\n", { mode: 0o600 });
    await expect(readSeedFile(short)).rejects.toBeInstanceOf(SeedFileError);
  });

  it("refuses a missing file with a message, not a stack", async () => {
    await expect(readSeedFile(join(dir, "nope.hex"))).rejects.toBeInstanceOf(SeedFileError);
  });
});
