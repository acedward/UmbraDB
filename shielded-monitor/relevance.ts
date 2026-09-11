import type { ArchivedTransaction } from "../src/interfaces/archive-read-contract.js";
import { buildMatchDetails, type MatchDetails } from "./match-details.js";
import {
  extractOffers,
  GUARANTEED_SEGMENT_ID,
  UnsupportedProtocolVersionError,
  type EncryptionSecretKeyHandle,
} from "./offers.js";

/**
 * The relevance predicate (organizer spec FR-006, FR-008), and nothing else.
 *
 * Pure in everything but the two WASM calls it makes: given one archived transaction and one
 * deserialized viewing key, decide whether the transaction is relevant to that key and, if so,
 * WHICH segments matched. It owns no database handle, no monitor, no coverage and no lifecycle,
 * so the rule "what counts as a match" is one small readable function that a fixture manifest
 * can be compared against directly (SC-001).
 *
 * **What the ledger's `test(offer)` actually examines.** It trial-decrypts the ciphertext of
 * every OUTPUT and every TRANSIENT of the offer under the key; inputs are never examined
 * (reference parity: `indexer-common/src/domain/ledger/transaction.rs:250-304`). That makes the
 * predicate strictly receive-side: it answers "was something encrypted to me here", never "did I
 * spend here" and never "did this succeed". Which is exactly why every association this module
 * feeds carries `appliedOutcome: "unknown"` (FR-009).
 *
 * **Documented false-negative class.** An output with no ciphertext is invisible to the
 * predicate — there is nothing to trial-decrypt. In practice that is the contract-owned output
 * (`ZswapOutput.newContractOwned`), whose coin data is delivered to a contract rather than
 * encrypted to a user key. Such an output cannot be matched by ANY viewing key, ours included;
 * a monitor will never see it. This is a property of the ledger's own encryption model, not of
 * this implementation, and it is asserted as a test (`relevance.test.ts`) so that a future
 * ledger that DID make them visible would fail loudly rather than change coverage silently.
 */

/** Segment id the guaranteed section is recorded under — the ledger's own numbering, defined in
 *  `offers.ts` (the module that owns the ledger call) and re-exported here, which is where it was
 *  first published. It keeps `matchedSegments` a single flat list of ledger segment ids rather
 *  than a list plus a boolean. */
export { GUARANTEED_SEGMENT_ID } from "./offers.js";

/** Why a transaction was not evaluated at all. Recorded so a scan can report "skipped" as a
 *  distinct outcome from "evaluated, no match" — the spec forbids collapsing the two anywhere
 *  coverage is concerned, and the same discipline is cheap here. */
export type RelevanceSkipReason =
  /** `kind = "system"`: system transactions carry no zswap offers (organizer spec's edge cases,
   *  FR-006). Skipped WITHOUT deserializing — the bytes are not even a standard transaction
   *  payload, so handing them to the standard codec would be a category error. */
  | "system-transaction"
  /** The transaction deserialized but holds no zswap offer at all. A reward-claim transaction is
   *  the canonical case (`Transaction.fromRewards` produces a transaction whose `guaranteedOffer`
   *  and `fallibleOffer` are both absent), and so is an intent-only transaction. Nothing can be
   *  encrypted to a key in a transaction with no offers, so the predicate is vacuously false —
   *  reported as a skip rather than a no-match so a scan's counters stay honest. */
  | "no-zswap-offers";

/** The outcome of evaluating one archived transaction against one key. */
export type RelevanceOutcome =
  | {
      readonly kind: "match";
      readonly segments: readonly number[];
      /** The transaction's public zswap data, present only when the caller asked for it
       *  ({@link EvaluateRelevanceOptions.details}). Computed from the SAME extracted offers and
       *  the SAME per-segment `test` results that decided the match, so a stored detail record
       *  can never describe a different evaluation than the association it hangs off. */
      readonly details?: MatchDetails;
    }
  | { readonly kind: "no-match" }
  | { readonly kind: "skipped"; readonly reason: RelevanceSkipReason };

/** Options for {@link evaluateRelevance}. */
export interface EvaluateRelevanceOptions {
  /** Also collect the matched transaction's public zswap data (organizer sub-plan 00009-07).
   *
   *  Off by default, and only ever does work for a transaction that actually matched: a
   *  non-matching transaction costs nothing, so the scanner can ask for details on every
   *  transaction it evaluates without paying for the overwhelming majority that do not match. */
  readonly details?: boolean;
}

/**
 * Evaluate one archived transaction against one viewing key.
 *
 * Every offer is tested — the guaranteed one and every fallible segment — even after the first
 * hit, because FR-008 requires the association to name ALL matched segments, and stopping early
 * would silently drop the rest.
 *
 * @throws {UnsupportedProtocolVersionError} when the transaction's protocol version is outside
 *   the vendored ledger build's supported set. Fail-closed by contract: the caller must stop the
 *   monitor, never treat the transaction as irrelevant (FR-007).
 * @throws {Error} when the bytes do not deserialize. Same contract, same reason.
 */
export async function evaluateRelevance(
  tx: Pick<ArchivedTransaction, "kind" | "protocolVersion" | "rawBytes">,
  key: EncryptionSecretKeyHandle,
  options: EvaluateRelevanceOptions = {},
): Promise<RelevanceOutcome> {
  if (tx.kind === "system") return { kind: "skipped", reason: "system-transaction" };

  const offers = await extractOffers(tx.rawBytes, tx.protocolVersion);
  const segments: number[] = [];
  if (offers.guaranteed !== undefined && key.test(offers.guaranteed)) {
    segments.push(GUARANTEED_SEGMENT_ID);
  }
  for (const [segmentId, offer] of offers.fallible) {
    if (key.test(offer)) segments.push(segmentId);
  }
  if (offers.guaranteed === undefined && offers.fallible.size === 0) {
    return { kind: "skipped", reason: "no-zswap-offers" };
  }
  if (segments.length === 0) return { kind: "no-match" };
  // Ascending, so a manifest comparison and a stored `matched_segments` array have one order.
  segments.sort((a, b) => a - b);
  if (options.details !== true) return { kind: "match", segments };
  return { kind: "match", segments, details: await buildMatchDetails(offers, key, segments) };
}

/** True when `err` is the fail-closed protocol-version refusal, narrowed without `instanceof`
 *  across a module boundary that a bundler could duplicate. */
export function isUnsupportedProtocolVersion(err: unknown): err is UnsupportedProtocolVersionError {
  return (
    err instanceof UnsupportedProtocolVersionError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "UNSUPPORTED_PROTOCOL_VERSION")
  );
}
