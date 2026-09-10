import type { TransactionRecord, TransactionResult } from "../src/interfaces/chain-archive-store.js";
import type { ReplayOutcome } from "./ledger-replay.js";

/**
 * Attaching the ledger's replay verdict to the archive's rows (`spec/00009` FR-009, question Q12).
 *
 * Two orderings of the same block exist and they are NOT the same list:
 *
 *  - the ARCHIVE's row order is reference-compatible -- event-borne system transactions first, in
 *    event order, then the extrinsic-derived ones in body order
 *    (`sync-service.ts`'s `buildNodeOnlyRecordsFromMetadata`);
 *  - the LEDGER's execution order is Substrate's -- initialization-phase events, then per
 *    extrinsic its own transaction followed by the events it emitted, then finalization events
 *    (`sync-service.ts`'s `replayTransactionsInExecutionOrder`).
 *
 * They also differ in CONTENT: a direct system extrinsic produces two archive rows (its
 * application event and the extrinsic itself) against one execution entry, because replay must
 * not apply the same transaction twice.
 *
 * The two agree exactly on one subsequence: the REGULAR transactions. Both are "this block's
 * Midnight regular calls, in body order", derived from the same extrinsic list with the same call
 * indices. So the correspondence is taken there, positionally -- and then verified byte-for-byte,
 * because a positional mapping that is merely probably right is worse than no mapping at all: an
 * outcome attributed to the wrong transaction is indistinguishable, downstream, from a correct
 * one.
 *
 * Anything that does not verify leaves the WHOLE block unmapped. `transactions.result` has always
 * been nullable, and `NULL` is the state every row was in before this existed, so declining to
 * map costs nothing and guessing could cost correctness.
 */

/** One regular transaction's replay verdict, in execution order. */
export interface RegularReplayOutcome {
  rawBytes: Uint8Array;
  outcome: ReplayOutcome | undefined;
}

export type ReplayOutcomeMapping =
  | { readonly mapped: true; readonly transactions: TransactionRecord[] }
  | { readonly mapped: false; readonly reason: string };

/**
 * Pair `regularOutcomes` (execution order, regular transactions only) with the regular rows of
 * `transactions` (archive order), or explain why they cannot be paired.
 *
 * Pure: no ledger, no database, no service state -- which is what makes the mapping rule itself
 * testable without a chain.
 */
export function mapReplayOutcomes(
  transactions: readonly TransactionRecord[],
  regularOutcomes: readonly RegularReplayOutcome[],
): ReplayOutcomeMapping {
  const regularRows = transactions.filter((t) => t.kind === "regular");
  if (regularRows.length !== regularOutcomes.length) {
    return {
      mapped: false,
      reason:
        `${regularRows.length} regular archive rows against ${regularOutcomes.length} regular ` +
        "replay outcomes -- the archive's row order and the ledger's execution order disagree " +
        "about this block's regular transactions",
    };
  }

  for (const [index, row] of regularRows.entries()) {
    const paired = regularOutcomes[index]!;
    if (!Buffer.from(row.rawBytes).equals(Buffer.from(paired.rawBytes))) {
      return {
        mapped: false,
        reason: `regular transaction ${index} differs in bytes between the two orderings`,
      };
    }
    // `system_applied` cannot occur for a regular transaction, and `undefined` means replay
    // produced no verdict for it. Both are excluded explicitly rather than cast away:
    // `transactions.result`'s CHECK admits exactly three values, and a fourth would fail the
    // insert at the very END of the bundle transaction, discarding an otherwise valid block.
    if (paired.outcome === undefined || paired.outcome === "system_applied") {
      return {
        mapped: false,
        reason: `regular transaction ${index} has outcome ${String(paired.outcome)}, which is not ` +
          "one of the three values transactions.result admits",
      };
    }
  }

  let regularIndex = 0;
  return {
    mapped: true,
    transactions: transactions.map((t) =>
      t.kind === "regular"
        ? { ...t, result: regularOutcomes[regularIndex++]!.outcome as TransactionResult }
        : t
    ),
  };
}
