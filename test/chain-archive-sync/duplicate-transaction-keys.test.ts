import { describe, expect, it } from "vitest";
import { assertNoDuplicateTransactionKeys } from "../../chain-archive-sync/sync-service.js";

/**
 * The archive keys transactions by `(net, block_height, block_hash, tx_hash)`, so two rows sharing
 * a hash within one block cannot both be stored -- and since every terminal insert is
 * `ON CONFLICT DO NOTHING`, the loser is dropped in SILENCE rather than raising.
 *
 * This is not hypothetical. The reference indexer does not deduplicate: `runtimes/v1_0_0.rs:160`
 * prepends event-borne system transactions and plain-`extend`s the extrinsic-derived list, with no
 * hash comparison anywhere on the path, and its own `transactions` table has no unique constraint
 * on `hash` (`indexer-common/migrations/postgres/001_initial.sql` -- `id BIGSERIAL` primary key,
 * plain index on `hash`). A successful direct system call is therefore present in BOTH sources and
 * legitimately becomes two rows there. Byte-parity means it must become two rows here too.
 *
 * The approved fix is widening the key with `position` (plan §3(c)). Until that migration lands,
 * refusing is the honest interim: storing one of the two copies would look like a complete block
 * while silently disagreeing with the source this archive is defined against.
 *
 * Tested as a free function because the situation cannot be produced on any reachable devnet -- no
 * chain in reach emits runtime-generated system transactions -- so waiting for a live specimen
 * would leave the guard permanently unverified.
 */
const tx = (txHash: string, position: number, kind = "system") => ({ txHash, position, kind });
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("assertNoDuplicateTransactionKeys", () => {
  it("permits distinct hashes", () => {
    expect(() =>
      assertNoDuplicateTransactionKeys(7, [tx(HASH_A, 0), tx(HASH_B, 1, "regular")]),
    ).not.toThrow();
  });

  it("permits an empty block", () => {
    expect(() => assertNoDuplicateTransactionKeys(7, [])).not.toThrow();
  });

  it("refuses the dual-source case: one hash at two positions", () => {
    // The shape the indexer produces for a successful direct system call: the event-borne copy
    // first (position 0), the extrinsic-derived copy after.
    expect(() => assertNoDuplicateTransactionKeys(42, [tx(HASH_A, 0), tx(HASH_A, 1)])).toThrow(
      /positions 0 and 1 share the hash/,
    );
  });

  it("names the height and both positions, so the failure is actionable", () => {
    // A refusal that does not say WHICH block and WHICH rows leaves an operator with a stalled
    // sync and nowhere to start; the message is part of the contract here, not decoration.
    expect(() => assertNoDuplicateTransactionKeys(42, [tx(HASH_A, 3), tx(HASH_A, 9)])).toThrow(
      /height 42: transactions at positions 3 and 9/,
    );
  });

  it("refuses a duplicate that is not adjacent", () => {
    // Guards against an implementation that only compares neighbours -- event-borne copies are
    // prepended as a group, so the two copies of one transaction need not end up side by side.
    expect(() =>
      assertNoDuplicateTransactionKeys(42, [tx(HASH_A, 0), tx(HASH_B, 1), tx(HASH_A, 2)]),
    ).toThrow(/positions 0 and 2 share the hash/);
  });
});
