import { describe, expect, it } from "vitest";
import {
  buildMatchDetails,
  MATCH_DETAILS_VERSION,
  MAX_DETAIL_ENTRIES,
  type MatchDetails,
} from "../../shielded-monitor/match-details.js";
import {
  deserializeEncryptionSecretKey,
  extractOffers,
  LEDGER_BUILD_ID,
  loadLedger,
  type EncryptionSecretKeyHandle,
} from "../../shielded-monitor/offers.js";
import { evaluateRelevance } from "../../shielded-monitor/relevance.js";
import { buildCorpus, type BuiltCorpus, type BuiltTransaction } from "../fixtures/shielded-monitor/build-corpus.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The match-details extractor (organizer sub-plan 00009-07), over the SAME fixture corpus SC-001
 * uses — so what the dashboard shows is checked against the manifest that decides what a match is,
 * not against a second description of the corpus written for this test.
 *
 * No Docker: this is the ledger and one function.
 *
 * **What this file is really for.** The sub-plan specified `mine` as
 * `esk.test(ZswapOffer.fromOutput(output))` per output, and that call does not work on archived
 * bytes — the ledger refuses to build an offer from a proven output. The refusal is not a detail
 * of an implementation choice; it is the reason `mine` is three-valued, and a project that forgets
 * it will "fix" the null attributions by reaching for something unsound. So the refusal is
 * asserted here as a fact about the vendored build, with a positive control proving the same call
 * DOES attribute exactly when the output is unproven.
 */
describe("match details", () => {
  let corpus: BuiltCorpus | undefined;
  const corpusOnce = async (): Promise<BuiltCorpus> => (corpus ??= await buildCorpus());

  /** Runs the production path — the predicate with `details: true` — for one fixture transaction
   *  and one corpus key, and returns the details it recorded (or `undefined` for a non-match). */
  async function detailsFor(tx: BuiltTransaction, keyId: string): Promise<MatchDetails | undefined> {
    const built = await corpusOnce();
    const key = await deserializeEncryptionSecretKey(built.keyBytes.get(keyId)!);
    try {
      const outcome = await evaluateRelevance(
        {
          kind: tx.spec.kind,
          protocolVersion: built.manifest.protocolVersion,
          rawBytes: tx.rawBytes,
        },
        key,
        { details: true },
      );
      return outcome.kind === "match" ? outcome.details : undefined;
    } finally {
      key.clear();
    }
  }

  const txById = async (id: string): Promise<BuiltTransaction> => {
    const built = await corpusOnce();
    const tx = built.transactions.find((t) => t.spec.id === id);
    if (tx === undefined) throw new Error(`fixture ${id} is missing from the corpus`);
    return tx;
  };

  // ── The public data is the offer's own ──────────────────────────────────────────────────────

  it("[[shielded-monitor.match-details.attribution-is-sound-on-the-fixture-manifest]] records every commitment and nullifier the offer holds, and attributes `mine` soundly for every corpus transaction", async () => {
    const built = await corpusOnce();
    let sawPinned = false;
    let sawAmbiguous = false;
    let sawUnmatchedSegment = false;
    let sawTransient = false;
    let sawInput = false;
    let sawContractOwned = false;

    for (const tx of built.transactions) {
      for (const keySpec of built.manifest.keys) {
        const expectedSegments = tx.spec.expected[keySpec.id] ?? [];
        const details = await detailsFor(tx, keySpec.id);
        if (expectedSegments.length === 0) {
          // A non-match records no details at all: the row this would hang off does not exist.
          expect(details, `${tx.spec.id}/${keySpec.id} must not match`).toBeUndefined();
          continue;
        }
        expect(details, `${tx.spec.id}/${keySpec.id} must match`).toBeDefined();
        const record = details!;
        expect(record.version).toBe(MATCH_DETAILS_VERSION);
        expect(record.ledgerBuild).toBe(LEDGER_BUILD_ID);

        // The segments the details describe are exactly the segments the offer holds, and the
        // `matched` flags are exactly the manifest's expectation — the same booleans that decided
        // the association.
        const offers = await extractOffers(tx.rawBytes, built.manifest.protocolVersion);
        const offerSegments = [
          ...(offers.guaranteed === undefined ? [] : [0]),
          ...[...offers.fallible.keys()],
        ].sort((a, b) => a - b);
        expect(record.segments.map((s) => s.segment)).toEqual(offerSegments);
        for (const segment of record.segments) {
          expect(segment.matched, `${tx.spec.id}/${keySpec.id} segment ${segment.segment}`)
            .toBe(expectedSegments.includes(segment.segment));

          // The commitment list equals the commitments read straight off the offer.
          const offer: any = segment.segment === 0
            ? offers.guaranteed
            : offers.fallible.get(segment.segment);
          expect(segment.outputs.map((o) => o.commitment))
            .toEqual((offer.outputs as any[]).map((o) => String(o.commitment)));
          expect(segment.inputs.map((i) => i.nullifier))
            .toEqual((offer.inputs as any[]).map((i) => String(i.nullifier)));
          expect(segment.transients.map((t) => [t.commitment, t.nullifier]))
            .toEqual((offer.transients as any[]).map((t) => [String(t.commitment), String(t.nullifier)]));
          expect(segment.counts).toEqual({
            outputs: (offer.outputs as any[]).length,
            inputs: (offer.inputs as any[]).length,
            transients: (offer.transients as any[]).length,
          });

          if (segment.inputs.length > 0) sawInput = true;
          if (segment.transients.length > 0) sawTransient = true;

          const entries = [...segment.outputs, ...segment.transients];
          if (!segment.matched) {
            // `test(offer)` is an `any()` over every ciphertext of the offer, so a `false` there
            // is a proven `false` for every entry in it. No nulls are permitted here.
            for (const entry of entries) {
              expect(entry.mine, `${tx.spec.id}/${keySpec.id} unmatched segment ${segment.segment}`)
                .toBe(false);
            }
            if (entries.length > 0) sawUnmatchedSegment = true;
            expect(segment.mineAmong).toBeUndefined();
            continue;
          }

          const candidates = entries.filter((e) => e.contractAddress === undefined);
          for (const entry of entries) {
            if (entry.contractAddress !== undefined) {
              // Contract-owned: no user ciphertext exists, so no key can own it.
              expect(entry.mine).toBe(false);
              sawContractOwned = true;
            }
          }
          if (candidates.length === 1) {
            expect(candidates[0]!.mine, `${tx.spec.id}/${keySpec.id}`).toBe(true);
            expect(segment.mineAmong).toBeUndefined();
            sawPinned = true;
          } else {
            for (const candidate of candidates) expect(candidate.mine).toBeNull();
            expect(segment.mineAmong).toBe(candidates.length);
            sawAmbiguous = true;
          }
        }

        // Totals are the sum over segments, and `mine`/`unattributed` count what they say.
        const flat = record.segments.flatMap((s) => [...s.outputs, ...s.transients]);
        expect(record.totals.mine).toBe(flat.filter((e) => e.mine === true).length);
        expect(record.totals.unattributed).toBe(flat.filter((e) => e.mine === null).length);
        expect(record.totals.outputs).toBe(record.segments.reduce((n, s) => n + s.counts.outputs, 0));
        expect(record.totals.inputs).toBe(record.segments.reduce((n, s) => n + s.counts.inputs, 0));
        expect(record.totals.transients).toBe(record.segments.reduce((n, s) => n + s.counts.transients, 0));
        expect(record.truncated).toBeUndefined();
      }
    }

    // Non-vacuity: the corpus really did exercise every branch of the attribution rule. Without
    // these, a bug that made `mine` always `null` would pass everything above.
    expect(sawPinned, "no segment pinned an output as `mine: true`").toBe(true);
    expect(sawAmbiguous, "no segment produced the ambiguous (`null`) case").toBe(true);
    expect(sawUnmatchedSegment, "no unmatched segment carried entries").toBe(true);
    expect(sawTransient, "the corpus carried no transient").toBe(true);
    expect(sawInput, "the corpus carried no spent input").toBe(true);
    expect(sawContractOwned, "the corpus carried no contract-owned entry inside a matched segment").toBe(true);
  }, 120_000);

  // ── The specific shapes the sub-plan named ─────────────────────────────────────────────────

  it("pins the single matching output of a one-output transaction as `mine: true`", async () => {
    const details = (await detailsFor(await txById("h1p0-guaranteed-to-K"), "K"))!;
    expect(details.segments).toHaveLength(1);
    const [segment] = details.segments;
    expect(segment!.segment).toBe(0);
    expect(segment!.matched).toBe(true);
    expect(segment!.outputs).toHaveLength(1);
    expect(segment!.outputs[0]!.mine).toBe(true);
    expect(segment!.outputs[0]!.commitment).toMatch(/^[0-9a-f]{2,}$/);
    expect(details.totals.mine).toBe(1);
    expect(details.totals.unattributed).toBe(0);
  }, 120_000);

  it("names the fallible segment for a positive whose only output sits in one, and marks the other segment's entries `mine: false`", async () => {
    const onlyFallible = (await detailsFor(await txById("h3p0-fallible-segment-2-only-to-K"), "K"))!;
    expect(onlyFallible.segments.map((s) => [s.segment, s.matched])).toEqual([[2, true]]);
    expect(onlyFallible.segments[0]!.outputs[0]!.mine).toBe(true);

    // The two-wallet transaction: K owns the fallible segment 1 output, K' owns the guaranteed
    // one. Each key must see its own segment matched and the other's entries as NOT its own.
    const shared = (await detailsFor(await txById("h3p1-guaranteed-Kprime-fallible-1-K"), "K"))!;
    expect(shared.segments.map((s) => [s.segment, s.matched])).toEqual([[0, false], [1, true]]);
    expect(shared.segments[0]!.outputs.every((o) => o.mine === false)).toBe(true);
    expect(shared.segments[1]!.outputs[0]!.mine).toBe(true);
  }, 120_000);

  it("records a spent input's nullifier and a transient's commitment/nullifier pair, and never claims either is yours", async () => {
    const details = (await detailsFor(await txById("h4p4-input-transient-and-two-outputs"), "K"))!;
    const [segment] = details.segments;
    expect(segment!.matched).toBe(true);
    expect(segment!.inputs).toHaveLength(1);
    expect(segment!.inputs[0]!.nullifier).toMatch(/^[0-9a-f]{2,}$/);
    expect(segment!.transients).toHaveLength(1);
    expect(segment!.transients[0]!.commitment).toMatch(/^[0-9a-f]{2,}$/);
    expect(segment!.transients[0]!.nullifier).toMatch(/^[0-9a-f]{2,}$/);
    // Contract-owned, so it carries no user ciphertext and cannot be anybody's.
    expect(segment!.transients[0]!.contractAddress).toBeDefined();
    expect(segment!.transients[0]!.mine).toBe(false);
    // Two ciphertext-bearing outputs remain: this is the ambiguous case, and it must be reported
    // as unknown rather than guessed.
    expect(segment!.outputs.map((o) => o.mine)).toEqual([null, null]);
    expect(segment!.mineAmong).toBe(2);
    expect(details.totals.mine).toBe(0);
    expect(details.totals.unattributed).toBe(2);
  }, 120_000);

  // ── Truncation ──────────────────────────────────────────────────────────────────────────────

  it("caps each list and flags the truncation, keeping the true count", async () => {
    // A stand-in offer rather than 300 real ledger outputs: `buildMatchDetails` reads these lists
    // through the same property accesses it uses on a WASM handle, and building 300 real outputs
    // would cost minutes of elliptic-curve work to test a slice. The WASM reads themselves are
    // covered by every other case in this file.
    const oversized = {
      guaranteed: {
        outputs: Array.from({ length: MAX_DETAIL_ENTRIES + 44 }, (_, i) => ({ commitment: `c${i}` })),
        inputs: Array.from({ length: MAX_DETAIL_ENTRIES + 1 }, (_, i) => ({ nullifier: `n${i}` })),
        transients: [],
      },
      fallible: new Map<number, unknown>(),
    };
    const key: EncryptionSecretKeyHandle = { test: () => false, clear: () => {} };
    const details = await buildMatchDetails(oversized, key, [0]);

    expect(details.truncated).toBe(true);
    const [segment] = details.segments;
    expect(segment!.truncated).toBe(true);
    expect(segment!.outputs).toHaveLength(MAX_DETAIL_ENTRIES);
    expect(segment!.inputs).toHaveLength(MAX_DETAIL_ENTRIES);
    // The TRUE sizes survive, so a truncated list can never read as a short one.
    expect(segment!.counts).toEqual({
      outputs: MAX_DETAIL_ENTRIES + 44,
      inputs: MAX_DETAIL_ENTRIES + 1,
      transients: 0,
    });
    expect(details.totals.outputs).toBe(MAX_DETAIL_ENTRIES + 44);
  });

  it("refuses to pin or to count candidates in a TRUNCATED segment, because the answer may not be among the entries listed", async () => {
    // The whole-segment deductions — "exactly one candidate left, so it is the one" and "one of
    // these n is yours" — are statements about a COMPLETE candidate set. A truncated list is not
    // one: the entry that actually decrypted may sit past the cap, so a pin would be wrong and a
    // count would name a set the answer is not in. Both must therefore go silent.
    const oneVisibleCandidate = {
      guaranteed: {
        outputs: [
          { commitment: "aa" },
          ...Array.from({ length: MAX_DETAIL_ENTRIES }, (_, i) => ({
            commitment: `c${i}`, contractAddress: "ca",
          })),
        ],
        inputs: [],
        transients: [],
      },
      fallible: new Map<number, unknown>(),
    };
    const key: EncryptionSecretKeyHandle = { test: () => true, clear: () => {} };
    const details = await buildMatchDetails(oneVisibleCandidate, key, [0]);
    const [segment] = details.segments;

    expect(segment!.truncated).toBe(true);
    expect(segment!.matched).toBe(true);
    // Exactly one of the 256 listed entries is a candidate — the deduction WOULD have pinned it
    // had the list been complete.
    expect(segment!.outputs.filter((o) => o.contractAddress === undefined)).toHaveLength(1);
    expect(segment!.outputs.filter((o) => o.mine === true)).toHaveLength(0);
    expect(segment!.outputs[0]!.mine).toBeNull();
    expect(segment!.mineAmong).toBeUndefined();
    // The CERTAIN negatives survive truncation untouched: a contract-owned entry carries no user
    // ciphertext whether or not the list was cut.
    expect(segment!.outputs.slice(1).every((o) => o.mine === false)).toBe(true);
    expect(details.totals.mine).toBe(0);
  });

  it("still marks every entry of an UNMATCHED segment `false` even when the list was truncated", async () => {
    // `test` returning false is a fact about every ciphertext in the offer, seen or not, so this
    // deduction is unaffected by the cap.
    const big = {
      guaranteed: {
        outputs: Array.from({ length: MAX_DETAIL_ENTRIES + 10 }, (_, i) => ({ commitment: `c${i}` })),
        inputs: [],
        transients: [],
      },
      fallible: new Map<number, unknown>(),
    };
    const details = await buildMatchDetails(big, { test: () => false, clear: () => {} }, []);
    expect(details.segments[0]!.truncated).toBe(true);
    expect(details.segments[0]!.outputs.every((o) => o.mine === false)).toBe(true);
  });

  it("leaves `truncated` absent when nothing was cut", async () => {
    const small = {
      guaranteed: { outputs: [{ commitment: "aa" }], inputs: [], transients: [] },
      fallible: new Map<number, unknown>(),
    };
    const details = await buildMatchDetails(small, { test: () => false, clear: () => {} }, []);
    expect(details.truncated).toBeUndefined();
    expect(details.segments[0]!.truncated).toBeUndefined();
    expect(details.segments[0]!.matched).toBe(false);
    expect(details.segments[0]!.outputs[0]!.mine).toBe(false);
  });

  // ── The Q22 pin ─────────────────────────────────────────────────────────────────────────────

  describe("per-output isolation against the vendored ledger", () => {
    it("[[shielded-monitor.match-details.per-output-isolation-is-refused-for-archived-bytes]] is REFUSED for an output read out of an archived (proven) transaction", async () => {
      // This is the measurement organizer question Q22 rests on. If a future ledger allows it, this
      // test fails — which is the point: the deduction that replaces it is a fallback, and the day
      // the exact call works again is a day someone should notice.
      const built = await corpusOnce();
      const ledger: any = await loadLedger();
      const tx = await txById("h4p4-input-transient-and-two-outputs");
      const offers = await extractOffers(tx.rawBytes, built.manifest.protocolVersion);
      const offer: any = offers.guaranteed;

      expect(() => ledger.ZswapOffer.fromOutput(offer.outputs[0])).toThrow(
        /proven or proof-erased output/,
      );
      expect(() => ledger.ZswapOffer.fromTransient(offer.transients[0])).toThrow(
        /proven or proof-erased transient/,
      );
      expect(() => ledger.ZswapOffer.fromInput(offer.inputs[0])).toThrow(
        /proven or proof-erased input/,
      );
    }, 120_000);

    it("WORKS, and attributes exactly, for an unproven output (the positive control)", async () => {
      // Without this half, the refusal above would be consistent with "the call is simply broken".
      // It is not: it is exact, and it is exactness we are prevented from having on archived bytes.
      const ledger: any = await loadLedger();
      const built = await corpusOnce();
      const secretsK = ledger.ZswapSecretKeys.fromSeed(
        new Uint8Array(32).fill(built.manifest.keys.find((k) => k.id === "K")!.seed & 0xff),
      );
      const secretsOther = ledger.ZswapSecretKeys.fromSeed(
        new Uint8Array(32).fill(built.manifest.keys.find((k) => k.id === "Kprime")!.seed & 0xff),
      );
      const coin = { type: "0".repeat(64), nonce: "11".repeat(32), value: 1000n };
      const unproven = ledger.ZswapOutput.new(
        coin, 0, secretsK.coinPublicKey, secretsK.encryptionPublicKey,
      );

      // Both optional-argument forms the v8 typings advertise.
      for (const singleton of [
        ledger.ZswapOffer.fromOutput(unproven),
        ledger.ZswapOffer.fromOutput(unproven, "0".repeat(64), 1000n),
      ]) {
        expect(singleton.outputs).toHaveLength(1);
        expect(String(singleton.outputs[0].commitment)).toBe(String(unproven.commitment));
        expect(secretsK.encryptionSecretKey.test(singleton)).toBe(true);
        expect(secretsOther.encryptionSecretKey.test(singleton)).toBe(false);
      }
    }, 120_000);
  });
});
