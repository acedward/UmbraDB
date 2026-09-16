import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadLedger } from "../../shielded-monitor/offers.js";
import {
  readDustNodeFixtureBlob,
  readDustNodeFixtureEvents,
  readDustNodeFixtureMeta,
} from "./dust-fixture.js";

/**
 * The 5 000-event preprod DUST fixture is what it says it is, and the vendored ledger still
 * reproduces the roots recorded beside it (plan 00016 task 2.2, D2.7).
 *
 * This is the fixture's own integrity test, not the mirror's: it proves the committed bytes are
 * the ones that were measured and that `8.1.0-syshash.6` folds them to the recorded roots. The
 * mirror's behaviour — batching, snapshots, and the cut that only an uncollapsed tree can serve —
 * is `dust-mirror.test.ts`.
 */

const meta = readDustNodeFixtureMeta();

describe("the committed preprod DUST fixture", () => {
  it("has the recorded size, checksum and event count", () => {
    const blob = readDustNodeFixtureBlob();
    expect(blob.byteLength).toBe(meta.bytes);
    expect(createHash("sha256").update(blob).digest("hex")).toBe(meta.sha256);
    expect(readDustNodeFixtureEvents()).toHaveLength(meta.events);
  });

  it("frames every event exactly, leaving no trailing bytes", () => {
    const events = readDustNodeFixtureEvents();
    const framedBytes = events.reduce((sum, event) => sum + 4 + event.byteLength, 0);
    expect(framedBytes).toBe(readDustNodeFixtureBlob().byteLength);
    expect(events.every((event) => event.byteLength > 0)).toBe(true);
  });

  it("carries all three DUST kinds, so a route test can exercise each", () => {
    // Genesis alone cannot: a `dustSpendProcessed` needs a fee-paying transaction.
    expect(meta.tags.dustInitialUtxo).toBeGreaterThan(1_000);
    expect(meta.tags.dustGenerationDtimeUpdate).toBeGreaterThan(500);
    expect(meta.tags.dustSpendProcessed).toBeGreaterThan(2_000);
  });

  it("replays to the recorded roots after every 500 events, with the retain-all replay", async () => {
    const ledger = await loadLedger();
    const events = readDustNodeFixtureEvents();
    const key = ledger.sampleDustSecretKey();
    let state = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
    try {
      for (const expected of meta.rootsAfterEveryFiveHundredDustEvents) {
        const from = expected.dustEvents - 500;
        const batch = Buffer.concat(events.slice(from, expected.dustEvents).map((e) => Buffer.from(e)));
        const withChanges = state.replayRawEventsRetainingAll(key, new Uint8Array(batch));
        const next = withChanges.state;
        // Free the superseded handle at once: wasm-bindgen handles are not collected promptly by
        // V8, and a 5 000-event replay that keeps ten of them holds ten copies of the trees.
        state.free();
        withChanges.free();
        state = next;
        expect(String(state.commitmentTreeRoot())).toBe(expected.commitmentRoot);
        expect(String(state.generatingTreeRoot())).toBe(expected.generatingRoot);
        expect(String(state.commitmentTreeFirstFree)).toBe(expected.commitmentFirstFree);
        expect(String(state.generatingTreeFirstFree)).toBe(expected.generationFirstFree);
      }
      expect(String(state.commitmentTreeFirstFree)).toBe(meta.finalCommitmentFirstFree);
      expect(String(state.generatingTreeFirstFree)).toBe(meta.finalGenerationFirstFree);
    } finally {
      state.free();
      key.free?.();
    }
  }, 120_000);

  it("records that the STOCK replay reaches the same roots — which is why roots cannot police the mirror", () => {
    // Not a curiosity: it is the reason `dust-mirror.test.ts` cuts a single-leaf range instead of
    // comparing roots. A mirror built with `replayRawEvents` would pass every root assertion in
    // this file and then fail the first wallet that asked for a segment.
    expect(meta.stockReplayRootsAreIdentical).toBe(true);
  });
});
