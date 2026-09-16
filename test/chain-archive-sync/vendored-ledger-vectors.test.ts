import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  loadLedgerV8,
  ledgerSupportsBlockFullness,
  ledgerSupportsSystemTransactionHash,
} from "../../chain-archive-sync/tx-replay-decoder.js";

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

  it("exposes SystemTransaction.cost, clampAndNormalizeFullness, and closeBlock", async () => {
    // Stated separately from the hash export above because they arrived in a different build:
    // `…syshash.1` could hash a system transaction but not cost one. A build with only the older
    // export must fail HERE, naming the missing capability, rather than in the arithmetic below.
    // `closeBlock` is part of the same capability: splitting close across JS recreates the Q64
    // rounding divergence even when the older two exports are present.
    await expect(ledgerSupportsBlockFullness()).resolves.toBe(true);
  });

  /**
   * The fullness half of the gate.
   *
   * There is no external ground truth for these the way the indexer's records are ground truth for
   * the hashes -- the indexer stores hashes, not costs. So this pins them against the NODE's
   * definition instead, in the one place where being wrong is silent rather than loud: genesis.
   *
   * Genesis is nothing but system transactions. Before `cost` was exported there was no way to
   * account for any of it, so a consumer recorded its fullness as zero -- a plausible-looking
   * number that no assertion caught. Asserting the real value is what makes zero a detectable
   * regression rather than an unverified guess.
   */
  const DIMENSIONS = ["readTime", "computeTime", "blockUsage", "bytesWritten", "bytesChurned"] as const;

  it("folds genesis's system transactions into a non-zero fullness", async () => {
    const ledger = await loadLedgerV8();
    const params = ledger.LedgerParameters.initialParameters();

    // The node's `apply_system_tx` adds each transaction's cost to the running block fullness.
    const accumulated: Record<string, bigint> = Object.fromEntries(DIMENSIONS.map((d) => [d, 0n]));
    for (const v of vectors) {
      const tx = ledger.SystemTransaction.deserialize(new Uint8Array(Buffer.from(v.rawHex, "hex")));
      const cost = tx.cost(params);
      for (const d of DIMENSIONS) accumulated[d]! += BigInt(cost[d]);
    }
    expect(
      DIMENSIONS.some((d) => accumulated[d]! > 0n),
      "genesis's system transactions must cost something",
    ).toBe(true);

    // Overall fullness is the max across dimensions, per the node's `compute_overall_fullness`.
    const normalized = params.clampAndNormalizeFullness(accumulated);
    const overall = Math.max(...DIMENSIONS.map((d) => Number(normalized[d])));
    expect(overall, "genesis's overall fullness -- the value zero was standing in for").toBeCloseTo(
      0.903322,
      6,
    );
  });

  it("clamps to the limits where the node clamps, instead of throwing", async () => {
    const ledger = await loadLedgerV8();
    const params = ledger.LedgerParameters.initialParameters();
    const limits = params.blockLimits;

    // Within the limits the clamping variant must be the SAME normalization, not merely a close
    // one -- otherwise it would quietly change every ordinary block, not just overfull ones.
    const half = Object.fromEntries(DIMENSIONS.map((d) => [d, BigInt(limits[d]) / 2n]));
    const plain = params.normalizeFullness(half);
    const clamped = params.clampAndNormalizeFullness(half);
    for (const d of DIMENSIONS) expect(clamped[d], `dimension ${d}`).toBe(plain[d]);

    // Over the limits they must diverge, and the clamping one is what `post_block_update` does:
    // report the block as exactly full. `normalizeFullness` throwing here is the bug it exists to
    // avoid -- a consumer would fail on a block the chain itself accepted.
    const over = Object.fromEntries(DIMENSIONS.map((d) => [d, BigInt(limits[d]) * 2n + 1n]));
    expect(() => params.normalizeFullness(over)).toThrow();
    const overClamped = params.clampAndNormalizeFullness(over);
    for (const d of DIMENSIONS) expect(Number(overClamped[d]), `dimension ${d}`).toBe(1);
  });
});
