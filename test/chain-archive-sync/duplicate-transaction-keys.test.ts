import { describe, expect, it } from "vitest";
import { assertNoDuplicateTransactionKeys } from "../../chain-archive-sync/sync-service.js";

/**
 * Since `002_transaction_position_key`, the archive keys transactions by
 * `(net, block_height, block_hash, position)`. This guard enforces what that key forbids, and --
 * just as importantly -- permits what it now allows.
 *
 * The inversion is the point. This suite previously asserted that two rows sharing a HASH were
 * refused. That shape is now legal and required: the reference indexer does not deduplicate a
 * system transaction that arrives both as an extrinsic and as a `SystemTransactionApplied` event
 * (`runtimes/v1_0_0.rs:160-163`, and no unique constraint on `hash` in its own schema), so a
 * successful direct system call legitimately becomes two rows there. Byte-parity means two rows
 * here. Had this guard been left alone, it would have refused exactly the blocks Stage 2 exists to
 * archive.
 *
 * What remains forbidden is two transactions at one position: an unstorable row, and a sign the
 * block's ordering is wrong. Ordering is part of what this archive guarantees -- two archives
 * holding the same transactions in a different order are not interchangeable for anything reading
 * by position.
 */
const tx = (txHash: string, position: number, kind = "system") => ({ txHash, position, kind });
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("assertNoDuplicateTransactionKeys", () => {
  it("permits distinct positions", () => {
    expect(() =>
      assertNoDuplicateTransactionKeys(7, [tx(HASH_A, 0), tx(HASH_B, 1, "regular")]),
    ).not.toThrow();
  });

  it("permits an empty block", () => {
    expect(() => assertNoDuplicateTransactionKeys(7, [])).not.toThrow();
  });

  it("PERMITS the dual-source case: one hash at two positions", () => {
    // The shape the reference produces for a successful direct system call -- the event-borne copy
    // first, the extrinsic-derived copy after. Refusing this was correct only while the key made
    // it unstorable; now it is the behaviour parity requires.
    expect(() =>
      assertNoDuplicateTransactionKeys(42, [tx(HASH_A, 0), tx(HASH_A, 1)]),
    ).not.toThrow();
  });

  it("refuses two different transactions at one position", () => {
    expect(() => assertNoDuplicateTransactionKeys(42, [tx(HASH_A, 3), tx(HASH_B, 3)])).toThrow(
      /both claim position 3/,
    );
  });

  it("names the height and both hashes, so the failure is actionable", () => {
    // A refusal that does not say WHICH block and WHICH rows leaves an operator with a stalled
    // sync and nowhere to start; the message is part of the contract here, not decoration.
    expect(() => assertNoDuplicateTransactionKeys(42, [tx(HASH_A, 3), tx(HASH_B, 3)])).toThrow(
      /height 42: two transactions both claim position 3/,
    );
  });

  it("refuses a position clash that is not adjacent", () => {
    // Guards against an implementation that only compares neighbours. Event-borne copies are
    // prepended as a group, so a mis-numbering need not put the clashing pair side by side.
    expect(() =>
      assertNoDuplicateTransactionKeys(42, [tx(HASH_A, 0), tx(HASH_B, 1), tx("c".repeat(64), 0)]),
    ).toThrow(/both claim position 0/);
  });
});
