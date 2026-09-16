import type { ArchivedBlock, ArchivedTransaction } from "../../src/interfaces/archive-read-contract.js";
import type { MatchDetails } from "../match-details.js";
import {
  ArchiveTransactionIdentityError,
  extractOffers,
  LEDGER_BUILD_ID,
  MATCHING_RULE_VERSION,
  normalizeTxHash,
  type ExtractedOffers,
} from "../offers.js";
import { evaluateExtractedOffers } from "../relevance.js";
import { hexToBytes } from "../scanner.js";
import type { AssociationInput } from "../store.js";
import type { HeldKey } from "./key-store.js";

/**
 * **One block, deserialized once, tested against every held key** (00009-09; owner decision Q28).
 *
 * ── What changed, and why it matters ────────────────────────────────────────────────────────
 * Phase 8 scanned per monitor: N monitors meant N passes over the same block and N
 * deserializations of the same transaction. Deserialization is the expensive part of scanning — it
 * is a WASM call over the whole transaction — and the predicate is a trial decryption per key per
 * offer, which is cheap by comparison. So the loop is inverted here: for each transaction, extract
 * the offers ONCE, then run every key against those offers.
 *
 * The predicate itself is not re-implemented. `evaluateExtractedOffers` is the same function
 * `evaluateRelevance` calls after its own deserialization, so "what counts as a match" has exactly
 * one definition and the single-key sync path and the many-key live path cannot drift.
 *
 * ── Fail-closed is still per-monitor, but the failure is per-BLOCK ─────────────────────────
 * A transaction that will not deserialize stops the whole block for every key, because none of
 * them can be told anything truthful about it: the difference between "no match" and "could not
 * look" is invisible afterwards (FR-007). {@link BlockScanError} carries the position so the node
 * can record it, and the node decides what to do with the monitors — this module commits nothing
 * and knows nothing about coverage.
 */

/** A transaction in a block could not be evaluated. Carries the position, because "the node
 *  stopped" is useless to an operator without "at which transaction". */
export class BlockScanError extends Error {
  readonly code = "BLOCK_SCAN_FAILED" as const;
  constructor(
    readonly atHeight: bigint,
    readonly atPosition: number,
    override readonly cause: unknown,
  ) {
    super(
      `failed to evaluate the transaction at height ${atHeight}, position ${atPosition}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "BlockScanError";
  }
}

export interface BlockScanOptions {
  readonly net: string;
  /** Check every regular transaction's claimed `txHash` against the hash its bytes actually have
   *  (Q23). On whenever the archive is remote, which in this topology is always. */
  readonly verifyTxIdentity?: boolean;
  /** Collect each match's public zswap data (00009-07). On by default — the dashboard and every
   *  human reader want it, and it costs nothing for a transaction that does not match. */
  readonly details?: boolean;
}

/** What one block produced: each key's matches, by fingerprint. A key with no matches is ABSENT
 *  from the map rather than present with an empty list — the caller advances every live key
 *  regardless, so "did this key match" is the only question this answer has to settle. */
export type BlockMatches = Map<string, AssociationInput[]>;

/**
 * Scans one block for every key in `keys`.
 *
 * @throws {BlockScanError} when a transaction cannot be deserialized or its protocol version is
 *   unsupported — fail closed, for the whole block.
 * @throws {ArchiveTransactionIdentityError} when the page's claimed transaction hash disagrees
 *   with the bytes. Deliberately NOT wrapped: it is a transport fault that would hit every block
 *   equally, and the node must treat it as "do not advance" rather than "this wallet failed" (see
 *   that error's own doc).
 */
export async function scanBlock(
  block: ArchivedBlock,
  keys: readonly HeldKey[],
  options: BlockScanOptions,
): Promise<BlockMatches> {
  const matches: BlockMatches = new Map();
  if (keys.length === 0) return matches;

  for (const tx of block.transactions) {
    // System transactions carry no zswap offers at all, and their bytes are not a standard
    // transaction payload — handing them to the standard codec would be a category error, not a
    // failure to look (`relevance.ts`'s `system-transaction` skip).
    if (tx.kind === "system") continue;

    let offers: ExtractedOffers;
    try {
      offers = await extractOffers(tx.rawBytes, tx.protocolVersion);
    } catch (err) {
      throw new BlockScanError(BigInt(block.height), tx.position, err);
    }
    if (options.verifyTxIdentity === true) {
      const claimed = normalizeTxHash(tx.txHash);
      if (claimed !== offers.transactionHash) {
        throw new ArchiveTransactionIdentityError(claimed, offers.transactionHash);
      }
    }

    for (const key of keys) {
      let outcome;
      try {
        outcome = await evaluateExtractedOffers(offers, key.esk, options.details !== false);
      } catch (err) {
        // A predicate failure is about the OFFERS, not about this one key — a trial decryption
        // does not depend on which key is trying — so it stops the block exactly as a failed
        // deserialization does rather than singling out one wallet.
        throw new BlockScanError(BigInt(block.height), tx.position, err);
      }
      if (outcome.kind !== "match") continue;
      const list = matches.get(key.fingerprintHex);
      const association = associationFor(options.net, block, tx, outcome.segments, outcome.details);
      if (list === undefined) matches.set(key.fingerprintHex, [association]);
      else list.push(association);
    }
  }
  return matches;
}

/** One association per (monitor, transaction observation), naming every matched segment (FR-008)
 *  and carrying FR-009 provenance. The same shape `ShieldedMonitorScanner` writes, deliberately:
 *  a match found by the live pass and the same match found by a back-sync must be one row. */
export function associationFor(
  net: string,
  block: ArchivedBlock,
  tx: ArchivedTransaction,
  segments: readonly number[],
  details?: MatchDetails,
): AssociationInput {
  return {
    net,
    blockHeight: BigInt(block.height),
    blockHash: hexToBytes(block.hash),
    position: tx.position,
    txHash: hexToBytes(tx.txHash),
    protocolVersion: BigInt(tx.protocolVersion),
    matchedSegments: segments,
    ...(details === undefined ? {} : { details }),
    ...(block.timestampMs === undefined ? {} : { blockTimestampMs: BigInt(block.timestampMs) }),
    // `appliedOutcome` is fixed at "unknown" by the store; the archive's replay outcome is
    // surfaced only as `sourceOutcome`, and only when the archive actually recorded one (FR-009).
    ...(tx.result === undefined ? {} : { sourceOutcome: tx.result }),
    matchingRuleVersion: MATCHING_RULE_VERSION,
    ledgerBuild: LEDGER_BUILD_ID,
  };
}
