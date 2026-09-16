import { z } from "zod";
import { StorageError } from "./storage-errors.js";

/**
 * The Tier-1.5 chain-archive storage interface (`design/full-chain-storage-design.md`,
 * `src/postgres/migrations/chain_archive/001_chain_archive_core.ts`). Mirrors this repo's
 * established interface/implementation split (`src/interfaces/checkpoint-store.ts` +
 * `src/postgres/checkpoint-store.ts`): this file declares the storage contract only -- no
 * `postgres` import, no SQL, no node-RPC/indexer-GraphQL awareness. `src/postgres/
 * chain-archive-store.ts` is the one Postgres implementation; the real ingestion/sync service
 * that talks to a Midnight node/indexer lives entirely outside `src/` (`chain-archive-sync/`,
 * AC-7) and depends on THIS interface, never on the Postgres implementation's internals.
 *
 * Deliberately narrower than the full `chain_archive` schema: `verifier_key_observations` keeps
 * minimal write-only support (a "stub/initial pass" per the implementation task), while bridge
 * observations expose only the one latest-by-kind read needed to restore change-detection state
 * after a sync-service restart. This is not a general bridge query surface.
 */

/** Lowercase 64-char hex encoding of a 32-byte hash -- every hash column in this schema
 *  (`block_hash`, `parent_hash`, `state_root`, `extrinsics_root`, `tx_hash`, blob `hash`,
 *  `vk_hash`, `author`) is exactly 32 bytes; this type documents that shape at the interface
 *  boundary instead of leaving every caller to independently remember it. */
export type Hex32 = string;
export const Hex32Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex chars (32 bytes)");

export type BlobRole =
  | "block_header" | "block_body" | "tx_raw" | "proof" | "verifier_key" | "bridge_observation"
  /** SCALE-encoded runtime metadata, kept so the archive can decode its own history without the
   *  node still serving it -- see `runtime_metadata` (migration 003). */
  | "runtime_metadata"
  /** Serialized ledger state at a checkpoint height, so replay resumes without re-applying the
   *  whole chain -- see `replay_checkpoints` (migration 004). */
  | "ledger_state";

export type BlockStatus = "seen" | "canonical" | "orphaned" | "pruned";

/** One block, as archived. `headerBytes`/`bodyBytes` are the raw content-addressed payload
 *  (stored in `chain_blobs`, classified via `chain_blob_roles`); every other field is the
 *  queryable metadata column set in `blocks`. */
export interface BlockRecord {
  net: string;
  blockHash: Hex32;
  height: number;
  parentHash: Hex32;
  stateRoot: Hex32;
  extrinsicsRoot: Hex32;
  author?: Hex32;
  headerBytes: Uint8Array;
  bodyBytes?: Uint8Array;
  isCanonical: boolean;
  status: BlockStatus;
  finalized: boolean;
  /** This block's own `Timestamp::set` value in milliseconds (migration 008, `spec/00009`
   *  FR-028). Optional, and `undefined` writes SQL `NULL`: the value lives in the block body, so
   *  a caller that has not decoded it must be able to archive the block without inventing one.
   *  The production sync writer supplies it; the backfill
   *  (`chain-archive-sync/backfill-block-timestamps.ts`) fills in rows archived before 008. */
  timestampMs?: number;
}

/** Metadata-only projection of `BlockRecord` returned by read paths -- raw bytes are fetched
 *  separately via {@link ChainArchiveStore.getBlob}, matching the schema's own metadata/blob
 *  split (`design/full-chain-storage-design.md` §4.1). */
export interface BlockMeta {
  net: string;
  blockHash: Hex32;
  height: number;
  parentHash: Hex32;
  stateRoot: Hex32;
  extrinsicsRoot: Hex32;
  author?: Hex32;
  headerBlobHash: Hex32;
  bodyBlobHash?: Hex32;
  isCanonical: boolean;
  status: BlockStatus;
  finalized: boolean;
  /** See {@link BlockRecord.timestampMs}. `undefined` means the column is `NULL` -- "not decoded
   *  yet", never "this block has no time". */
  timestampMs?: number;
}

export type TransactionKind = "regular" | "system";
export type TransactionResult = "success" | "partial_success" | "failure";

export interface TransactionRecord {
  net: string;
  txHash: Hex32;
  blockHeight: number;
  blockHash: Hex32;
  position: number;
  kind: TransactionKind;
  protocolVersion: number;
  result?: TransactionResult;
  rawBytes: Uint8Array;
}

export interface TransactionMeta {
  net: string;
  txHash: Hex32;
  blockHeight: number;
  blockHash: Hex32;
  position: number;
  kind: TransactionKind;
  protocolVersion: number;
  result?: TransactionResult;
  rawBlobHash: Hex32;
}

export type BridgeObservationKind =
  | "cnight_registration" | "system_parameters_d" | "spo_registration" | "other";

export interface BridgeObservationRecord {
  net: string;
  blockHeight: number;
  blockHash: Hex32;
  observationIndex: number;
  kind: BridgeObservationKind;
  rawBytes: Uint8Array;
}

/** Metadata projection of a bridge observation. Raw bytes retain the archive's normal
 * metadata/blob split and are read through {@link ChainArchiveStore.getBlob}. */
export interface BridgeObservationMeta {
  net: string;
  blockHeight: number;
  blockHash: Hex32;
  observationIndex: number;
  kind: BridgeObservationKind;
  rawBlobHash: Hex32;
}

/** Everything one call to `putBlockBundle` needs to ingest a single block atomically: the block
 *  row itself plus every transaction/bridge-observation row that belongs to it. `transactions`/
 *  `bridgeObservations` may be empty (e.g. a block with no `pallet_midnight` transactions, or no
 *  D-parameter change since the previous block) -- `putBlockBundle` still only writes the
 *  `blocks` row in that case, inside the same one transaction. */
export interface BlockBundle {
  block: BlockRecord;
  transactions: readonly TransactionRecord[];
  bridgeObservations: readonly BridgeObservationRecord[];
  /**
   * Owner **Rule A** (`spec/00009` User Story 5, FR-029): the replay checkpoint for THIS height,
   * when one is due, written inside the SAME transaction as everything else about the height.
   *
   * Before this, the sync service wrote it in a transaction of its own immediately after the
   * bundle committed (`chain-archive-sync/sync-service.ts`), which made a crash between the two
   * an observable third state: the height durable, its checkpoint absent. `replay_checkpoints`
   * has a real FK to `blocks`, which is why the checkpoint could not simply be written first --
   * inside one transaction the block row is already visible to the FK check, so the ordering
   * problem disappears rather than being traded for a different one.
   *
   * MUST describe this bundle's own block: `net`, `blockHeight` and `blockHash` are checked
   * against `block` and a mismatch is refused, because a checkpoint naming another block would
   * make resume fold this chain onto a state that is not its own.
   */
  replayCheckpoint?: ReplayCheckpointRecord;
  /**
   * Owner **Rule A**: the sync watermark advance for THIS height, written inside the same
   * transaction. The monotonic guard `setWatermark` applies is applied here too -- a lower height
   * never overwrites a higher one -- so folding the write in does not weaken it.
   *
   * Before this, the watermark advanced in a fourth transaction after the bundle and the
   * checkpoint, so a crash left the height durable with the cursor behind it. That state was
   * SAFE (the retry re-ingested the same height idempotently) but it was a third observable
   * state, and the owner's rule is that there are exactly two: nothing of the height, or all of
   * it including the watermark.
   */
  watermark?: { key: string; value: unknown };
  /**
   * Owner Rule A, wake-up half: `NOTIFY <channel>, '<net>:<height>'` issued inside the same
   * transaction, so it is delivered if and only if the height commits. A consumer that misses it
   * (not listening, connection dropped) loses nothing -- polling remains the contract; this only
   * removes the latency of waiting for the next poll.
   */
  notifyChannel?: string;
}

export type VerifierKeyScope = "protocol" | "contract";

export interface VerifierKeyObservationRecord {
  vkBytes: Uint8Array;
  net: string;
  scope: VerifierKeyScope;
  tag: string;
  contractAddress?: Hex32;
  firstSeenHeight: number;
}

export type ChainArchiveErrorCode = "BLOB_INTEGRITY" | "BLOB_MISSING" | "BLOCK_NOT_FOUND" | "VALIDATION_FAILED";

/**
 * @experimental Full-chain archival is deferred to 1.1 (`council/A` ruling (e)). This chain-
 * archive error type is NOT re-exported from the 1.0.0 public barrel (`src/index.ts`) and its
 * code is NOT part of the frozen 1.0.0 error catalog. Provisional; may change in 1.1.
 * @internal
 */
export abstract class ChainArchiveError extends StorageError {
  abstract readonly code: ChainArchiveErrorCode;
}

/** AC-3: a blob's recomputed hash, on read, does not match its content-addressed storage key --
 *  mirrors `ChunkIntegrityError` (`checkpoint-store.ts`)'s proven rehash-on-read contract. Never
 *  returns the corrupted bytes to the caller.
 *  @experimental Deferred to 1.1; NOT in the frozen 1.0.0 barrel or error catalog. @internal */
export class BlobIntegrityError extends ChainArchiveError {
  readonly code = "BLOB_INTEGRITY" as const;
  readonly retryable = "non-retryable" as const;
  constructor(readonly expectedHash: Hex32, readonly actualHash: Hex32) {
    super(`chain_blobs content hash mismatch: expected ${expectedHash}, recomputed ${actualHash}`);
  }
}

/** A referenced blob hash has no row in `chain_blobs` at all.
 *  @experimental Deferred to 1.1; NOT in the frozen 1.0.0 barrel or error catalog. @internal */
export class BlobMissingError extends ChainArchiveError {
  readonly code = "BLOB_MISSING" as const;
  readonly retryable = "non-retryable" as const;
  constructor(readonly hash: Hex32) { super(`chain_blobs has no row for hash ${hash}`); }
}

/**
 * @experimental Full-chain archival is deferred to 1.1 (`council/A` ruling (e)). This chain-
 * archive error type is NOT re-exported from the 1.0.0 public barrel (`src/index.ts`) and its
 * code is NOT part of the frozen 1.0.0 error catalog. Provisional; may change in 1.1.
 * @internal
 */
export class BlockNotFoundError extends ChainArchiveError {
  readonly code = "BLOCK_NOT_FOUND" as const;
  readonly retryable = "non-retryable" as const;
  constructor(readonly net: string, readonly height: number, readonly blockHash?: Hex32) {
    super(`no block found for net=${net} height=${height}${blockHash ? ` blockHash=${blockHash}` : ""}`);
  }
}

/**
 * Storage contract for the Tier-1.5 chain archive. Every write method is content/idempotency-
 * aware where the schema itself is (blob puts are naturally idempotent by content address) AND,
 * as of the sprint-fix round below, `putBlock`/`putTransactions`/`putBridgeObservations`/
 * `putBlockBundle` are now ALSO idempotent against a byte-for-byte-identical re-ingest of the
 * SAME primary-keyed rows: their terminal `INSERT`s use `ON CONFLICT ... DO NOTHING`, so retrying
 * an ingest that already durably committed is a silent no-op rather than a duplicate-key error.
 * Only `putBlockBundle` additionally serializes and rejects incompatible history; standalone
 * batch methods are low-level primitives and must not be used as a multi-writer ingest protocol.
 * This does NOT remove the need for a watermark
 * (callers driving an at-least-once sync loop still must track "last successfully ingested
 * height," exactly like every other sync consumer in this codebase,
 * `src/interfaces/watermarks.ts`) -- it removes the failure mode where retrying the SAME height
 * after a partial or already-fully-committed prior attempt wedges permanently on a duplicate-key
 * error instead of succeeding as a no-op.
 */
export interface ChainArchiveStore {
  /** Writes `header`/`body` bytes into `chain_blobs` (content-addressed by SHA-256) plus their
   *  `chain_blob_roles` rows, then the `blocks` row itself, inside one transaction. Returns the
   *  computed header/body blob hashes. A byte-identical header/body blob already present under
   *  the same role is reused, not duplicated (`chain_blobs` is a single global content-addressed
   *  pool, matching `ckpt_chunks`'s established convention). The final `blocks` insert is
   *  `ON CONFLICT (net, height, block_hash) DO NOTHING` -- re-`putBlock`-ing an already-committed
   *  block is a safe no-op, not a duplicate-key error. Prefer `putBlockBundle` over calling this
   *  standalone from an ingestion loop -- it additionally makes the block/transactions/bridge-
   *  observations write atomic as one unit, not just individually retry-safe. */
  putBlock(block: BlockRecord): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }>;

  /** Writes each transaction's raw bytes into `chain_blobs`/`chain_blob_roles` (role `tx_raw`)
   *  plus its `transactions` row, one insert per element, inside one transaction covering the
   *  whole batch (so a partial block's transaction set never becomes visible on failure). Each
   *  transaction's insert is `ON CONFLICT (net, block_height, block_hash, position) DO NOTHING` --
   *  re-`putTransactions`-ing an already-committed set (in full or in part) is a safe no-op. */
  putTransactions(txs: readonly TransactionRecord[]): Promise<void>;

  /** `ON CONFLICT (net, block_height, block_hash, observation_index) DO NOTHING` on the terminal
   *  insert -- same re-ingest-safety as `putTransactions`. */
  putBridgeObservations(obs: readonly BridgeObservationRecord[]): Promise<void>;

  /** The newest observation of `kind` at or below `maxHeight` on the finalized canonical chain.
   * Used to restore a change-detection cursor from durable history after process restart, so an
   * unchanged value immediately after a change boundary is not emitted a second time. The
   * finalized/canonical qualification matches the sync writer's deliberately narrow contract. */
  getLatestBridgeObservation(
    net: string, kind: BridgeObservationKind, maxHeight: number,
  ): Promise<BridgeObservationMeta | undefined>;

  /**
   * Ingests one full block -- `bundle.block`, `bundle.transactions`, and
   * `bundle.bridgeObservations` -- inside ONE Postgres transaction, so a partial block (e.g. the
   * `blocks` row committed but its transactions not, because the write was interrupted or the
   * caller's own upstream data source was itself inconsistent mid-ingest) can never become
   * durably visible. This is the fix for the sprint-fix round's Fix 1: previously, a real
   * ingestion caller (`chain-archive-sync/sync-service.ts`) issued `putBlock`/`putTransactions`/
   * `putBridgeObservations` as three SEPARATE, independently-committed transactions, so a retry
   * of the same height after a partial failure hit a duplicate-key error on whichever insert(s)
   * had already committed and wedged permanently. Every underlying insert additionally uses
   * `ON CONFLICT ... DO NOTHING` on its own primary key (matching `putBlock`/`putTransactions`/
   * `putBridgeObservations` above), so retrying the exact same bundle after it has ALREADY fully
   * committed (e.g. a crash between this call returning and the caller durably recording its own
   * watermark) is also a safe no-op, not an error -- both the "partial prior attempt" and
   * "fully-committed prior attempt, watermark just hadn't caught up" retry cases are covered.
   *
   * Calls are serialized in PostgreSQL by `(net, height)` for the whole transaction. Under that
   * guard the stored `(position, tx_hash, kind)` sequence is compared again immediately before
   * writes: a concurrent identical bundle is an idempotent agreement, while a different sequence
   * is refused. This is a database-level guard, not an in-process mutex, so independent service
   * processes cannot both pass a stale preflight read and report success for incompatible history.
   * The production sync writer supplies only finalized canonical blocks; arbitrary, partially
   * flipped `setCanonical` histories remain outside replay's contract.
   * Returns the same header/body blob hashes `putBlock` would.
   *
   * **Owner Rule A (`spec/00009` FR-029).** With `bundle.replayCheckpoint` and
   * `bundle.watermark` supplied, this call is the ONLY durable write for the height: block row,
   * transactions, bridge observations, the block's timestamp column, the replay checkpoint when
   * due, and the sync watermark all commit together. A crash therefore leaves either nothing of
   * the height or all of it including the watermark -- there is no third state to recover from,
   * and recovery is "continue from the last committed height".
   */
  putBlockBundle(bundle: BlockBundle): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }>;

  /**
   * This archive database's own identity for `net` (`spec/00009` FR-028): 32 lowercase hex
   * characters of cryptographically random data, minted on the first call and returned unchanged
   * by every call after it.
   *
   * Idempotent by construction (`INSERT ... ON CONFLICT DO NOTHING`, then read back), so
   * concurrent bootstraps of the same archive agree, and it is NOT routed through
   * `setWatermark`: that method's last-write-wins behaviour for non-`{height}` values would let a
   * second bootstrap silently replace an identity every consumer has already bound to.
   *
   * Dropping the archive and re-syncing the same chain mints a NEW id. That is the point: a
   * consumer's persisted coverage is a claim about a specific archive's history, and this is what
   * lets it notice the history underneath it was replaced (`stale_source`, FR-013).
   */
  ensureArchiveInstanceId(net: string): Promise<string>;

  /** Upserts via `ON CONFLICT ... DO UPDATE SET first_seen_height = LEAST(...)`, matching the
   *  schema's own documented convention (`001_chain_archive_core.ts`'s verifier_key_observations
   *  comment) -- never a plain INSERT, since a plain INSERT of a repeated context would violate
   *  the UNIQUE constraint. */
  putVerifierKeyObservation(vk: VerifierKeyObservationRecord): Promise<void>;

  /**
   * Atomically flips canonical status at `(net, height)`: un-marks whichever block currently
   * holds `is_canonical = true` at that height (if any, and if it isn't already `blockHash`),
   * then marks `blockHash` canonical -- both inside one transaction, so a concurrent reader can
   * only ever observe zero-then-new-canonical or old-then-new-canonical, never two at once
   * (AC-2's "reorg flip is a single observable state transition"). `finalized` is monotonic
   * (schema-enforced, `blocks_finalized_monotonic_trigger`) -- passing `finalized: false` on an
   * already-finalized row throws, translated from the trigger's `23514`.
   * @throws {BlockNotFoundError} if no `(net, height, blockHash)` row exists to flip onto.
   */
  setCanonical(
    net: string, height: number, blockHash: Hex32, opts?: { finalized?: boolean },
  ): Promise<void>;

  /** All blocks at `(net, height)` -- the full block tree at that height, not just canonical
   *  (§4.2's "block tree, not just the canonical chain" modeling). Empty array if none. */
  getBlocksAtHeight(net: string, height: number): Promise<BlockMeta[]>;

  /** The one canonical block at `(net, height)`, or `undefined` if none is currently canonical
   *  there (e.g. height beyond the synced tip, or a genuinely orphaned gap). */
  getCanonicalBlockAtHeight(net: string, height: number): Promise<BlockMeta | undefined>;

  /** Every transaction inclusion record for `txHash`, across every fork that carries it
   *  (AC-1: a shared tx hash across competing blocks at one height persists in full for both). */
  getTransactionsByHash(net: string, txHash: Hex32): Promise<TransactionMeta[]>;

  /** The complete transaction set THIS ARCHIVE HOLDS for one specific block (scoped by
   *  `blockHash`, so competing forks at the same height each enumerate their own set), ordered by
   *  `position` ascending.
   *
   *  **Completeness is relative to how the block was ingested, and callers must not read more
   *  into it.** Indexer-sourced ingest archives regular and system transactions. Node-only ingest
   *  archives both as well — including system transactions carried as extrinsics, keyed by the
   *  ledger's own hash — and REFUSES a block whose system transactions it cannot key, rather than
   *  writing it without them.
   *
   *  One category is still missing from node-only ingest: system transactions that the runtime
   *  GENERATES rather than receiving as extrinsics. Those surface only in the
   *  `SystemTransactionApplied` event, which is not yet decoded, and ingest does not currently
   *  detect their presence — so on a chain that produces them (any that mints block rewards) a
   *  node-only archive can be short of an indexer-sourced one without saying so. Until that is
   *  closed, treat node-only ingest as complete only for chains whose system transactions are
   *  extrinsic-borne. Empty array if the block has no transactions or does not exist. Added in the
   *  Sol-audit fix round (Finding 5): AC-1's spec text requires each fork's "full transaction
   *  set [to] be retrievable scoped to" its block, and no public method could enumerate a
   *  block's transactions to verify completeness -- read paths (replay/AC-8 cross-validation)
   *  need exactly this enumeration anyway. */
  getTransactionsForBlock(net: string, blockHash: Hex32): Promise<TransactionMeta[]>;

  /** The canonical chain's blocks within `[fromHeight, toHeight]` inclusive, ordered by height
   *  ascending. Spans a partition boundary transparently (AC-6) -- the caller never needs to know
   *  where a `CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE` boundary falls. */
  getCanonicalChainRange(net: string, fromHeight: number, toHeight: number): Promise<BlockMeta[]>;

  /**
   * Reads a blob by its content-addressed key and rehashes it before returning (AC-3) -- never
   * returns bytes whose recomputed hash disagrees with `hash`.
   * @throws {BlobMissingError} if no `chain_blobs` row exists for `hash`.
   * @throws {BlobIntegrityError} if the recomputed hash does not match `hash`.
   */
  getBlob(hash: Hex32): Promise<Uint8Array>;

  /** `chain_archive`'s own local watermark table (§5 -- deliberately NOT `tier1_wallet.
   *  watermarks`). `key` is caller-structured, matching the design doc's documented convention
   *  (e.g. `canonical_tip:<net>`). */
  getWatermark(key: string): Promise<unknown | undefined>;
  setWatermark(key: string, value: unknown): Promise<void>;

  /**
   * The archive's own copy of a runtime's SCALE metadata, or `undefined` if this runtime has not
   * been captured for this net.
   *
   * Decoding a block requires the metadata of the runtime that produced it, and that metadata is
   * derived from historical state -- a pruned node cannot serve it. Keeping a copy makes the
   * archive self-describing, so re-syncs and replay never depend on the node's state retention.
   */
  getRuntimeMetadata(
    net: string, specName: string, specVersion: number,
  ): Promise<Uint8Array | undefined>;

  /**
   * Persist a runtime's metadata the first time that runtime is seen. Idempotent: a second call
   * for the same `(net, specName, specVersion)` leaves the existing capture untouched, so the
   * recorded `first_seen_height` remains the height that genuinely introduced the runtime.
   */
  putRuntimeMetadata(record: RuntimeMetadataRecord): Promise<void>;

  /**
   * The newest replay checkpoint at or below `maxHeight` **on the canonical chain**, or
   * `undefined` if none exists.
   *
   * Replay resumes from here rather than from genesis, which is what keeps restart cost
   * proportional to the checkpoint interval instead of to the whole chain.
   *
   * CANONICAL IS PART OF THE CONTRACT, not an optimisation (T5). Migration 004 keys checkpoints by
   * `(net, block_height, block_hash)` precisely so a fork's checkpoints are distinguishable, and
   * selecting on `(net, height)` alone can therefore return a checkpoint belonging to an ORPHANED
   * block. Replay would then fold canonical successors onto a state that forked away from them --
   * a state no chain ever had, arrived at without any error. Ledger state is a fold, so the
   * damage is silent and permanent.
   *
   * The supported replay/catch-up read contract is deliberately narrower than every state the
   * public `setCanonical` primitive can construct: its writer is finalized-only and never performs
   * height-by-height reorg flips. A partially flipped `setCanonical` history is outside this
   * contract. Catch-up nevertheless validates that each selected row's `parentHash` is the hash it
   * just replayed and refuses a disconnected range, naming both hashes. Binding checkpoint lookup
   * to a complete ancestry proof remains explicit future work under O2; callers must not describe
   * this narrower contract as general reorg-safe replay.
   */
  getLatestReplayCheckpoint(
    net: string, maxHeight: number,
  ): Promise<ReplayCheckpointRecord | undefined>;

  /** Record ledger state at a checkpoint height. Idempotent for the same block. */
  putReplayCheckpoint(record: ReplayCheckpointRecord): Promise<void>;
}

/** Serialized ledger state as of after `blockHeight`'s post-block update. */
export interface ReplayCheckpointRecord {
  net: string;
  blockHeight: number;
  blockHash: Hex32;
  /** Serialized `LedgerState`. A ledger-INTERNAL encoding, hence `ledgerVersion`. */
  stateBytes: Uint8Array;
  /** The ledger build that produced `stateBytes`. Resuming under a different build must refuse:
   *  the encoding is not guaranteed stable across builds, and a silently mis-resumed state
   *  produces wrong replay outcomes rather than an error. */
  ledgerVersion: string;
  /** This block's own `Timestamp::set` value, in ms.
   *
   *  Not decoration either: the block resuming from this checkpoint is applied with it as
   *  `lastBlockTime`, which feeds the ledger's own validity rules. Without it stored, every
   *  resumed run folded its first block against a parent dated 1970 -- a defect invisible to any
   *  single-run test, because the value is only wrong across a restart (T1). */
  blockTimestampMs: number;
  /** The LEDGER network this state was folded under (`undeployed`, `devnet`, ...).
   *
   *  Recorded explicitly rather than read back from the serialized state, which embeds it but
   *  exposes no accessor. Resume must compare this against its own configured `ledgerNetworkId`
   *  and refuse a mismatch: a checkpoint from another network has the same `ledgerVersion` marker
   *  as a valid one, so the build check alone cannot tell them apart (T2). */
  ledgerNetworkId: string;
}

/** One runtime's metadata, as captured by this archive. */
export interface RuntimeMetadataRecord {
  net: string;
  specName: string;
  specVersion: number;
  /** The height at which this runtime was first observed -- diagnostic, and the answer to "which
   *  block introduced this runtime" when a decode goes wrong at an upgrade boundary. */
  firstSeenHeight: number;
  /** Raw SCALE-encoded metadata, exactly as the node served it. */
  metadataBytes: Uint8Array;
}
