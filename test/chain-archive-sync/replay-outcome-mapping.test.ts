import { describe, expect, it } from "vitest";
import {
  mapReplayOutcomes, type RegularReplayOutcome,
} from "../../chain-archive-sync/replay-outcome-mapping.js";
import type { TransactionRecord } from "../../src/interfaces/chain-archive-store.js";

/**
 * The rule that decides whether the ledger's replay verdict may be written onto an archived row
 * (`spec/00009` FR-009, question Q12).
 *
 * Pure unit tests, no chain and no database: what is under test is the CORRESPONDENCE between two
 * orderings of the same block, and building a real block to exercise it would only make the
 * disagreement cases hard to construct. The orderings themselves are covered by the decoder and
 * replay suites; this file covers what happens when they line up and what happens when they do
 * not.
 *
 * The failure this guards against is silent: an outcome attributed to the wrong transaction is
 * indistinguishable downstream from a correct one, which is why every negative case below must
 * leave the whole block unmapped rather than mapping "as much as it can".
 */
describe("mapping replay outcomes onto archived transaction rows", () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

  function row(position: number, kind: "regular" | "system", payload: string): TransactionRecord {
    return {
      net: "undeployed",
      txHash: position.toString(16).padStart(64, "0"),
      blockHeight: 7,
      blockHash: "ab".repeat(32),
      position,
      kind,
      protocolVersion: 1_000_000,
      rawBytes: bytes(payload),
    };
  }

  function outcome(payload: string, verdict: RegularReplayOutcome["outcome"]): RegularReplayOutcome {
    return { rawBytes: bytes(payload), outcome: verdict };
  }

  it("attaches each regular transaction's own outcome and leaves system rows untouched", () => {
    // The realistic shape: event-borne system transactions FIRST (archive order), then the
    // extrinsic-derived regular ones. Replay saw only the two regular ones, in the same relative
    // order.
    const transactions = [
      row(0, "system", "sys-a"),
      row(1, "system", "sys-b"),
      row(2, "regular", "reg-1"),
      row(3, "regular", "reg-2"),
    ];
    const mapping = mapReplayOutcomes(transactions, [
      outcome("reg-1", "success"),
      outcome("reg-2", "failure"),
    ]);

    expect(mapping.mapped).toBe(true);
    if (!mapping.mapped) return;
    expect(mapping.transactions.map((t) => t.result)).toEqual([
      undefined, undefined, "success", "failure",
    ]);
    // Nothing else about a row may change: this writes one column, not a new row set.
    expect(mapping.transactions.map((t) => t.position)).toEqual([0, 1, 2, 3]);
    expect(mapping.transactions[2]!.txHash).toBe(transactions[2]!.txHash);
  });

  it("maps a partial_success verdict, which the archive keeps rather than collapsing to failure", () => {
    const mapping = mapReplayOutcomes([row(0, "regular", "reg")], [outcome("reg", "partial_success")]);
    expect(mapping.mapped && mapping.transactions[0]!.result).toBe("partial_success");
  });

  it("maps a block with no regular transactions at all to itself", () => {
    const transactions = [row(0, "system", "sys")];
    const mapping = mapReplayOutcomes(transactions, []);
    expect(mapping.mapped).toBe(true);
    expect(mapping.mapped && mapping.transactions[0]!.result).toBeUndefined();
  });

  it("refuses the WHOLE block when the two orderings disagree on how many regular transactions there are", () => {
    // The direct-system-extrinsic shape, exaggerated: the archive holds two regular rows, replay
    // reports one. Mapping "as far as it can" would attach reg-1's verdict to reg-1 and leave
    // reg-2 unexplained -- but the disagreement means the correspondence itself is unknown, so
    // the first pairing is no more trustworthy than the missing one.
    const mapping = mapReplayOutcomes(
      [row(0, "regular", "reg-1"), row(1, "regular", "reg-2")],
      [outcome("reg-1", "success")],
    );
    expect(mapping.mapped).toBe(false);
    expect(mapping.mapped === false && mapping.reason).toMatch(/2 regular archive rows against 1/);
  });

  it("refuses the WHOLE block when a pair's bytes differ, even though the counts line up", () => {
    // The case a count check alone would miss, and the reason the byte comparison exists: same
    // number of regular transactions, different order. A positional mapping here would attach
    // every verdict to the wrong transaction and look entirely healthy.
    const mapping = mapReplayOutcomes(
      [row(0, "regular", "reg-1"), row(1, "regular", "reg-2")],
      [outcome("reg-2", "failure"), outcome("reg-1", "success")],
    );
    expect(mapping.mapped).toBe(false);
    expect(mapping.mapped === false && mapping.reason).toMatch(/differs in bytes/);
  });

  it("refuses a `system_applied` verdict rather than writing a value the column's CHECK rejects", () => {
    // `transactions.result` admits success / partial_success / failure. A fourth value would fail
    // the INSERT at the very end of the bundle transaction and discard an otherwise valid block,
    // so it is refused here, before the write is attempted.
    const mapping = mapReplayOutcomes([row(0, "regular", "reg")], [outcome("reg", "system_applied")]);
    expect(mapping.mapped).toBe(false);
    expect(mapping.mapped === false && mapping.reason).toMatch(/system_applied/);
  });

  it("refuses a missing verdict rather than writing NULL for some rows and values for others", () => {
    const mapping = mapReplayOutcomes(
      [row(0, "regular", "reg-1"), row(1, "regular", "reg-2")],
      [outcome("reg-1", "success"), outcome("reg-2", undefined)],
    );
    expect(mapping.mapped).toBe(false);
    expect(mapping.mapped === false && mapping.reason).toMatch(/undefined/);
  });

  it("does not mutate the input rows", () => {
    const transactions = [row(0, "regular", "reg")];
    mapReplayOutcomes(transactions, [outcome("reg", "success")]);
    expect(transactions[0]!.result).toBeUndefined();
  });
});
