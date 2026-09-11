import { describe, expect, it } from "vitest";
import { loadLedgerV8 } from "../../chain-archive-sync/tx-replay-decoder.js";
import { deserializeEncryptionSecretKey, UnsupportedProtocolVersionError } from "../../shielded-monitor/offers.js";
import { evaluateRelevance, GUARANTEED_SEGMENT_ID, isUnsupportedProtocolVersion } from "../../shielded-monitor/relevance.js";
import { buildCorpus, type BuiltCorpus } from "../fixtures/shielded-monitor/build-corpus.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The relevance predicate against the fixture manifest (organizer spec SC-001, FR-006, FR-008).
 *
 * No database, no Docker, no scanner: this file tests only "given these bytes and this key, does
 * the ledger's predicate say yes, and for which segments". The scanner's own suites
 * (`scanner.integration.test.ts`) then show that the same answers survive the archive round-trip
 * and the commit.
 *
 * The oracle is `test/fixtures/shielded-monitor/corpus.manifest.json`, which DECLARES the
 * expectation. It is deliberately not derived from the builder: an expectation computed by the
 * same code that produced the bytes would agree with itself no matter what the predicate did.
 */

let corpus: BuiltCorpus | undefined;
async function theCorpus(): Promise<BuiltCorpus> {
  corpus ??= await buildCorpus();
  return corpus;
}

describe("relevance predicate — the fixture manifest is the oracle (SC-001)", () => {
  it("every transaction matches exactly the keys and segments the manifest declares", async () => {
    const built = await theCorpus();
    for (const key of built.manifest.keys) {
      const handle = await deserializeEncryptionSecretKey(built.keyBytes.get(key.id)!);
      try {
        for (const tx of built.transactions) {
          const outcome = await evaluateRelevance(
            {
              kind: tx.spec.kind,
              protocolVersion: built.manifest.protocolVersion,
              rawBytes: tx.rawBytes,
            },
            handle,
          );
          const expected = tx.spec.expected[key.id] ?? [];
          const actual = outcome.kind === "match" ? [...outcome.segments] : [];
          expect(
            actual,
            `key ${key.id} vs ${tx.spec.id}: expected segments ${JSON.stringify(expected)}, got ` +
              `${JSON.stringify(actual)} (outcome ${outcome.kind})`,
          ).toEqual(expected);
        }
      } finally {
        handle.clear();
      }
    }
  }, 180_000);

  it("the manifest is non-vacuous: it declares positives, negatives, a fallible-only positive and a multi-output transaction", async () => {
    const built = await theCorpus();
    const positivesForK = built.expectedMatches.get("K") ?? [];
    // Without this the suite above could pass against a manifest that expected nothing at all.
    expect(positivesForK.length).toBeGreaterThanOrEqual(4);
    expect(built.manifest.transactions.some((t) => (t.expected.K ?? []).length === 0)).toBe(true);
    expect(
      built.manifest.transactions.some(
        (t) => (t.expected.K ?? []).length > 0 && !(t.expected.K ?? []).includes(GUARANTEED_SEGMENT_ID),
      ),
      "the manifest must contain a positive whose ONLY matching output is in a fallible segment (US1 scenario 3)",
    ).toBe(true);
    expect(
      built.manifest.transactions.some(
        (t) => t.outputs.filter((o) => o.to === "K").length > 1,
      ),
      "the manifest must contain a transaction with two matching outputs (FR-008)",
    ).toBe(true);
  });

  it("a system transaction is skipped WITHOUT being deserialized", async () => {
    const built = await theCorpus();
    const handle = await deserializeEncryptionSecretKey(built.keyBytes.get("K")!);
    try {
      // Bytes that are not a transaction at all. If the predicate tried to decode them it would
      // throw; skipping on `kind` is what makes this pass, which is the property under test.
      const outcome = await evaluateRelevance(
        { kind: "system", protocolVersion: 1_000_000, rawBytes: new TextEncoder().encode("not a transaction") },
        handle,
      );
      expect(outcome).toEqual({ kind: "skipped", reason: "system-transaction" });
    } finally {
      handle.clear();
    }
  });

  it("a REAL reward-claim transaction carries no zswap offer at all — which is why it can never be relevant", async () => {
    // The archivable half of the reward-claim case lives in the corpus (`h4p3`, a standard
    // transaction with no offers). This is the other half: the actual ledger object.
    //
    // Its bytes cannot be put through the ARCHIVED marker triple, and that is a property of the
    // ledger rather than a gap in the test: `Transaction.fromRewards` yields an already-bound
    // transaction tagged `(signature[v1],proof-preimage,pedersen-schnorr[v1])`, and `mockProve()`
    // refuses it ("cannot prove bound transaction"). So it is deserialized here with the markers
    // its own bytes carry, and what is asserted is the fact the exclusion rests on: there is no
    // offer for any key to be tested against.
    const ledger: any = await loadLedgerV8();
    const signingKey = ledger.sampleSigningKey();
    const claim = ledger.ClaimRewardsTransaction
      .new("undeployed", 1000n, ledger.signatureVerifyingKey(signingKey), "77".repeat(32), "Reward")
      .addSignature(ledger.signData(signingKey, new Uint8Array([1, 2, 3])));
    const raw = ledger.Transaction.fromRewards(claim).serialize();

    const tx = ledger.Transaction.deserialize("signature", "pre-proof", "binding", raw);
    expect(tx.rewards, "a rewards transaction must actually carry its claim").toBeDefined();
    expect(tx.guaranteedOffer).toBeUndefined();
    expect(tx.fallibleOffer).toBeUndefined();
  }, 120_000);

  it("a transaction with no offers is reported as skipped, not as a no-match", async () => {
    const built = await theCorpus();
    const offerless = built.transactions.find((t) => t.spec.shape === "no-offers")!;
    const handle = await deserializeEncryptionSecretKey(built.keyBytes.get("K")!);
    try {
      const outcome = await evaluateRelevance(
        { kind: "regular", protocolVersion: built.manifest.protocolVersion, rawBytes: offerless.rawBytes },
        handle,
      );
      expect(outcome).toEqual({ kind: "skipped", reason: "no-zswap-offers" });
    } finally {
      handle.clear();
    }
  }, 120_000);

  it("an output with no ciphertext (contract-owned) is invisible to EVERY key — the documented false-negative class", async () => {
    const built = await theCorpus();
    const invisible = built.transactions.find((t) => t.spec.shape === "contract-owned")!;
    for (const key of built.manifest.keys) {
      const handle = await deserializeEncryptionSecretKey(built.keyBytes.get(key.id)!);
      try {
        const outcome = await evaluateRelevance(
          { kind: "regular", protocolVersion: built.manifest.protocolVersion, rawBytes: invisible.rawBytes },
          handle,
        );
        expect(outcome.kind, `${key.id} must not match a contract-owned output`).toBe("no-match");
      } finally {
        handle.clear();
      }
    }
  }, 120_000);

  it("an unsupported protocol version throws the typed refusal rather than decoding anyway (FR-007)", async () => {
    const built = await theCorpus();
    const positive = built.transactions.find((t) => t.spec.id === "h1p0-guaranteed-to-K")!;
    const handle = await deserializeEncryptionSecretKey(built.keyBytes.get("K")!);
    try {
      await expect(
        evaluateRelevance({ kind: "regular", protocolVersion: 2_000_000, rawBytes: positive.rawBytes }, handle),
      ).rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
      // ...and the same bytes DO match at a supported version, so the refusal above is about the
      // version and not about the bytes.
      const ok = await evaluateRelevance(
        { kind: "regular", protocolVersion: built.manifest.protocolVersion, rawBytes: positive.rawBytes },
        handle,
      );
      expect(ok).toEqual({ kind: "match", segments: [0] });
    } finally {
      handle.clear();
    }
  }, 120_000);

  it("undecodable bytes throw rather than reporting a no-match", async () => {
    const built = await theCorpus();
    const handle = await deserializeEncryptionSecretKey(built.keyBytes.get("K")!);
    try {
      await expect(
        evaluateRelevance(
          { kind: "regular", protocolVersion: built.manifest.protocolVersion, rawBytes: new Uint8Array([1, 2, 3, 4]) },
          handle,
        ),
      ).rejects.toThrow();
    } finally {
      handle.clear();
    }
  }, 120_000);

  it("isUnsupportedProtocolVersion recognises the error by code as well as by class", () => {
    expect(isUnsupportedProtocolVersion(new UnsupportedProtocolVersionError(42))).toBe(true);
    expect(isUnsupportedProtocolVersion({ code: "UNSUPPORTED_PROTOCOL_VERSION" })).toBe(true);
    expect(isUnsupportedProtocolVersion(new Error("something else"))).toBe(false);
    expect(isUnsupportedProtocolVersion(undefined)).toBe(false);
  });

  it("the fixture corpus round-trips through the ARCHIVED marker triple — no fixture-only codec relaxation was needed", async () => {
    const built = await theCorpus();
    const ledger: any = await loadLedgerV8();
    const standard = built.transactions.filter((t) => t.spec.shape !== "system-opaque");
    expect(standard.length).toBeGreaterThan(0);
    for (const tx of standard) {
      // The exact call `extractOffers` makes, and the exact call ingest makes for real chain
      // bytes (`chain-archive-sync/tx-replay-decoder.ts`).
      expect(
        () => ledger.Transaction.deserialize("signature", "proof", "binding", tx.rawBytes),
        `${tx.spec.id} must deserialize with the archived markers`,
      ).not.toThrow();
      expect(
        new TextDecoder().decode(tx.rawBytes.subarray(0, 20)),
        `${tx.spec.id} must carry the standard transaction self-tag`,
      ).toBe("midnight:transaction");
    }
  }, 120_000);
});
