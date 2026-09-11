import { StorageError } from "./storage-errors.js";
import type { Hex32, TransactionKind, TransactionResult } from "./chain-archive-store.js";

/**
 * The archive's READ contract for a second process (`spec/00009` User Story 7, FR-027/FR-028).
 *
 * `ChainArchiveStore` (`src/interfaces/chain-archive-store.ts`) is the archive WRITER's storage
 * contract: it exposes blocks at a height, a canonical header range, and a block's transactions
 * by hash -- three calls a consumer would have to stitch together, plus a `chain_blobs` fetch per
 * transaction, to answer the one question every scanner actually asks: *"give me everything after
 * height H, in order, as whole blocks."*
 *
 * This file is that one question. It is deliberately a SEPARATE interface rather than more methods
 * on `ChainArchiveStore`, for two reasons the spec names:
 *
 *  1. **No SQL, no schema, no storage types leak.** Nothing here mentions blob hashes, partitions,
 *     `is_canonical`, watermark rows, or `postgres`. A consumer typed against this interface has
 *     no way to reach into the archive's tables, which is what makes project B's
 *     "read-only through the contract" rule (FR-025) mechanically checkable rather than a promise.
 *  2. **It can move across a process boundary.** The in-process Postgres implementation
 *     (`src/postgres/archive-read-contract.ts`) is one implementation; an RPC implementation
 *     serving a consumer in a separate process -- or a TEE -- implements the same interface with
 *     the same guarantees. Every type below is therefore plain data: numbers, strings, byte
 *     arrays. No handles, no cursors that are secretly database state, no lazily-loaded fields.
 *
 * **The unit is a whole block height, always.** A page holds N whole blocks, never part of one.
 * That is not an implementation convenience: it is what makes the archive's write unit (owner
 * Rule A -- one height, one `BEGIN…COMMIT`, FR-029) and a scanner's own commit unit (owner Rule B
 * -- one height's associations plus its coverage advance, FR-010) the same thing. A page that
 * could split a block would force a consumer to invent a sub-block commit unit, and a crash in the
 * middle of one would leave a height half-scanned with nothing able to say so.
 */

/** Who this archive is, so a consumer can tell one archive from another that holds the same
 *  chain (FR-028, US7 scenario 3, US5 scenario 5).
 *
 *  `net` and `genesisHash` identify the CHAIN. `archiveInstanceId` identifies THIS ARCHIVE
 *  DATABASE: it is minted once, when the schema is bootstrapped, and never changes for the life of
 *  that database. Dropping the archive and re-syncing the same chain therefore yields the same
 *  `net` and `genesisHash` with a DIFFERENT `archiveInstanceId` -- which is exactly the signal a
 *  consumer needs, because its own persisted coverage ("I have scanned through height 900") is a
 *  claim about a specific archive's history, not about the chain in the abstract. Without it, a
 *  re-synced archive that had only reached height 300 would silently look like the same archive
 *  having gone backwards. */
export interface ArchiveIdentity {
  net: string;
  /** The hash of the archived block at height 0. */
  genesisHash: Hex32;
  /** 32 lowercase hex characters (128 random bits), minted once per archive database per net. */
  archiveInstanceId: string;
}

/** One archived transaction, as a reader sees it: stable identity, the bytes, and the outcome the
 *  archive already computed -- never a blob hash, never a row. */
export interface ArchivedTransaction {
  txHash: Hex32;
  /** Position within its block. The archive's identity key is (net, height, blockHash, position),
   *  NOT the transaction hash: the same hash can legitimately appear at two positions. */
  position: number;
  kind: TransactionKind;
  protocolVersion: number;
  /** The archive's own replay outcome for this transaction, when it computed one. `undefined`
   *  means "this archive did not record an outcome" (replay validation was off when the block was
   *  ingested), NEVER "the transaction did not succeed". A consumer must not present it as an
   *  applied outcome of its own (`spec/00009` FR-009: it is `sourceOutcome`, with its own
   *  provenance, alongside `appliedOutcome = "unknown"`). */
  result?: TransactionResult;
  /** The raw ledger bytes exactly as archived, hash-verified on read: the implementation
   *  recomputes the content address before returning and refuses bytes that disagree with it. */
  rawBytes: Uint8Array;
}

/** One whole archived block. */
export interface ArchivedBlock {
  net: string;
  height: number;
  hash: Hex32;
  parentHash: Hex32;
  /** The block's own `Timestamp::set` value in milliseconds (FR-028), so a consumer never has to
   *  re-decode the block body to date a transaction. `undefined` only for blocks archived before
   *  migration 008 that the backfill has not visited yet -- never a guessed value. */
  timestampMs?: number;
  /** Every transaction of this block THAT THIS ARCHIVE HOLDS, in ascending `position` order. See
   *  `ChainArchiveStore.getTransactionsForBlock`'s doc for what "holds" means for node-only
   *  ingest: an empty array is a block with no transactions, not an unread block. */
  transactions: readonly ArchivedTransaction[];
}

/** Where the archive currently ends: the highest canonical FINALIZED block it holds. */
export interface ArchiveTip {
  height: number;
  hash: Hex32;
}

/** One page of whole blocks plus where the archive ended when the page was read. */
export interface ArchiveBlockPage {
  /** Ascending by height. Empty when the reader is already at the tip. */
  blocks: readonly ArchivedBlock[];
  /** `undefined` when the archive holds no canonical finalized block for this net at all. Read in
   *  the SAME snapshot as `blocks`, so `blocks` never runs past `sourceTip`. A consumer compares
   *  its own coverage against this to distinguish "scanned, nothing matched" from "not scanned
   *  yet" (FR-011, FR-020) -- the distinction the spec forbids collapsing. */
  sourceTip?: ArchiveTip;
}

export type ArchiveReadErrorCode = "ARCHIVE_DISCONTINUITY";

/**
 * The canonical rows a page spans are not parent-linked: block `H`'s `parentHash` is not the hash
 * of block `H-1` in the same page, or a height inside the page's span is missing.
 *
 * Fail-CLOSED, deliberately. The alternative -- returning the rows as found -- hands a consumer a
 * sequence that LOOKS contiguous (heights ascend, every block is whole) while silently omitting
 * history, and the consumer would then record coverage over a range it never saw. The archive's
 * own writer cannot produce this state (it ingests `watermark + 1` only, under a parent-continuity
 * check), so it means the archive was assembled by something else, or damaged.
 *
 * @experimental Part of the deferred full-chain-archival track; NOT re-exported from the 1.0.0
 * public barrel (`src/index.ts`) and NOT part of the frozen 1.0.0 error catalog. @internal
 */
export class ArchiveDiscontinuityError extends StorageError {
  readonly code = "ARCHIVE_DISCONTINUITY" as const;
  readonly retryable = "non-retryable" as const;
  constructor(
    readonly net: string,
    readonly height: number,
    readonly expectedParentHash: Hex32,
    readonly actualParentHash: Hex32,
  ) {
    super(
      `archive discontinuity for net=${net} at height ${height}: the canonical block there names ` +
        `parent ${actualParentHash}, but the canonical block at ${height - 1} is ` +
        `${expectedParentHash}. Refusing to return a page that would read as contiguous history.`,
    );
  }
}

/**
 * Read-only, whole-block access to the archive's canonical finalized history, plus the archive's
 * own identity. The ONLY dependency project B (`shielded_monitor`) has on project A.
 */
export interface ArchiveReadContract {
  /**
   * The next whole blocks of canonical finalized history after `afterHeight`, ascending, with each
   * block's transactions in position order and their raw bytes hash-verified.
   *
   * - `afterHeight` is EXCLUSIVE. Pass `-1` to start from genesis; pass the height a previous page
   *   ended at to resume. A remembered height therefore resumes exactly, across restarts
   *   (US7 scenario 2).
   * - `maxBlocks` counts BLOCKS, never transactions. A block with several hundred transactions is
   *   a one-block page, not a split one (US7 scenario 4).
   * - The returned blocks are the canonical FINALIZED ones. Non-finalized or orphaned rows are
   *   never returned, so a page never has to be retracted.
   * - Heights are explicit on every block. A reader resumes from the LAST RETURNED HEIGHT, never
   *   from `afterHeight + blocks.length`: the first block of a page need not be `afterHeight + 1`
   *   (an archive whose earliest retained height is above the reader's start is a legitimate,
   *   visible state -- see `spec/00009`'s "start height below retained history" edge case).
   * - Within one page the blocks are parent-linked; a break is thrown, not smoothed over.
   *
   * @throws {ArchiveDiscontinuityError} if the canonical rows the page spans are not parent-linked.
   * @throws {BlobIntegrityError} if an archived blob's recomputed hash disagrees with its key.
   * @throws {BlobMissingError} if a referenced blob row is absent.
   */
  readBlocksSince(net: string, afterHeight: number, maxBlocks: number): Promise<ArchiveBlockPage>;

  /**
   * Who this archive is, or `undefined` when it cannot yet answer -- which is the case until BOTH
   * the schema has been bootstrapped for `net` (minting `archiveInstanceId`) AND block 0 has been
   * archived (fixing `genesisHash`). "Undefined" is the honest answer for an archive that has not
   * started; there is no partially-known identity, precisely so a consumer cannot bind to half of
   * one and later see the other half change under it.
   */
  getArchiveIdentity(net: string): Promise<ArchiveIdentity | undefined>;
}
