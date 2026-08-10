import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadLedgerV8, ledgerSupportsSystemTransactionHash } from "../../chain-archive-sync/tx-replay-decoder.js";

/**
 * The acceptance gate for the vendored ledger build (`vendor/ledger-v8-syshash`).
 *
 * Node-only ingest archives system transactions under the ledger's own hash, which the published
 * `@midnight-ntwrk/ledger-v8` cannot compute -- it never exported
 * `SystemTransaction.transactionHash()`. This repo therefore depends on a committed build that
 * does. That build is decode-critical: if it is wrong, every archived system transaction is keyed
 * wrongly, and `ON CONFLICT DO NOTHING` means the damage is not repairable by re-ingesting.
 *
 * Why this test and not a byte comparison against a rebuild: the build is NOT bit-reproducible.
 * Rebuilding from the same commit with the same `wasm-pack 0.15.0` and `rustc 1.93.0` on the same
 * machine yields a different `.wasm` hash (measured 2026-08-08). Bytes therefore cannot attest the
 * artifact, and the exact verified bytes cannot be regenerated -- which is why they are committed.
 *
 * What attests it is behavioural equivalence with an INDEPENDENT implementation. The fixture holds
 * the five system transactions `midnight-indexer 4.3.2` archived from a 1.0.0 devnet's genesis
 * block: for each, the hash the indexer recorded and the raw bytes it recorded it from. Recomputing
 * those hashes here compares our build against the reference, not against itself, which is what
 * makes it evidence rather than a tautology.
 *
 * It also settles a version question: the indexer's ledger and this build differ in patch version
 * (8.0.3 vs 8.1.0), and matching hashes show that gap does not affect transaction hashing.
 *
 * Deliberately NOT skippable. Every other ledger-dependent suite gates on capability so that a
 * missing export produces a visible SKIP rather than a false pass; this one is the gate that proves
 * the capability is present in the first place, so skipping it would defeat its own purpose. A
 * fresh clone has the vendored build by construction, so there is no honest reason for it to be
 * absent.
 */
interface Vector {
  height: string;
  position: string;
  expectedHash: string;
  rawHex: string;
}

const vectors: Vector[] = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => {
    const [height, position, expectedHash, rawHex] = line.trim().split(/\s+/);
    return { height: height!, position: position!, expectedHash: expectedHash!, rawHex: rawHex! };
  });

describe("vendored ledger build reproduces the indexer's system-transaction hashes", () => {
  it("has the fixture it claims to check", () => {
    // A fixture that silently emptied would make every assertion below vacuous.
    expect(vectors.length).toBe(5);
    for (const v of vectors) {
      expect(v.expectedHash, "each vector carries a 32-byte hash").toMatch(/^[0-9a-f]{64}$/i);
      expect(v.rawHex.length, "each vector carries raw bytes").toBeGreaterThan(0);
    }
  });

  it("exposes SystemTransaction.transactionHash", async () => {
    // Stated as its own assertion rather than being implied by the hashes below, so that a build
    // missing the export reports THAT rather than a confusing deserialization error.
    await expect(ledgerSupportsSystemTransactionHash()).resolves.toBe(true);
  });

  it("recomputes all five indexer-recorded hashes exactly", async () => {
    const ledger = await loadLedgerV8();
    for (const v of vectors) {
      const tx = ledger.SystemTransaction.deserialize(new Uint8Array(Buffer.from(v.rawHex, "hex")));
      const got = String(tx.transactionHash()).replace(/^0x/, "").toLowerCase();
      expect(got, `genesis height ${v.height} position ${v.position}`).toBe(
        v.expectedHash.toLowerCase(),
      );
    }
  });
});
