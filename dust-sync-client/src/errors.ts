/**
 * The failures `syncDust` reports, and the one rule that governs all of them
 * (`spec/00016-dust-wallet-sync.md` FR-030).
 *
 * **A failed sync returns NO state.** Every throw below happens before a state is handed back,
 * and the partially built `DustLocalState` is freed on the way out. That is not tidiness: a DUST
 * state whose commitment root does not match the chain's is a state whose Merkle paths are wrong,
 * and a wallet that spent from it would build a transaction the node refuses — after the fee has
 * been computed and the proof paid for. "No state" is the only safe answer to "these trees do not
 * match what the chain committed".
 *
 * Nothing here ever carries a nullifier, a secret key or a derived public key into its message.
 * An error message is the easiest way for a secret to reach a log (SC-006).
 */

/** Stable codes a caller can switch on. */
export type DustSyncErrorCode =
  /** A rebuilt tree's root differs from the root the node reported for the same event id. */
  | "DUST_SYNC_ROOT_MISMATCH"
  /** The node's trees stayed behind an event the table already showed, for longer than allowed. */
  | "DUST_SYNC_INDEX_LAG"
  /** A leaf was offered to the ledger at an index that is not the tree's next free one. */
  | "DUST_SYNC_NONLINEAR"
  /** The chain moved under the client more times than the algorithm's restart budget allows. */
  | "DUST_SYNC_RESTART_LIMIT"
  /** The node answered something other than a 200 with the body §4 specifies. */
  | "DUST_SYNC_HTTP"
  /** The caller's own inputs are wrong (bad base URL, a ledger module missing a member). */
  | "DUST_SYNC_INVALID_INPUT";

export class DustSyncError extends Error {
  constructor(
    readonly code: DustSyncErrorCode,
    message: string,
    readonly detail: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "DustSyncError";
  }
}

/**
 * Wraps a ledger throw that is really a linearity violation.
 *
 * `NonLinearInsertion` is the ledger's own error for "this index is not the tree's next free
 * one". It reaches the client in exactly one situation that is not a bug: the node's trees are
 * behind a row the table already returned, so an own leaf's index is past the tree's end. FR-030
 * names it as a must-throw for that reason — the alternative, catching it and retrying blindly,
 * would loop forever against a mirror that has genuinely stopped.
 */
export function asNonLinear(error: unknown, where: string): DustSyncError {
  const message = error instanceof Error ? error.message : String(error);
  if (/nonlinearinsertion|non-linear|NonLinear/i.test(message)) {
    return new DustSyncError(
      "DUST_SYNC_NONLINEAR",
      `the ledger refused a leaf at ${where}: the tree's next free index is not the one offered`,
      { where, ledgerMessage: message },
    );
  }
  return new DustSyncError("DUST_SYNC_INVALID_INPUT", `the ledger refused an operation at ${where}`, {
    where,
    ledgerMessage: message,
  });
}
