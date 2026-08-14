import { PgChainArchiveStore } from "../src/postgres/chain-archive-store.js";
import type { UmbraDBSql } from "../src/postgres/client.js";
import type {
  BlockRecord,
  BridgeObservationRecord,
  ChainArchiveStore,
  Hex32,
  TransactionRecord,
} from "../src/interfaces/chain-archive-store.js";
import { IndexerClient, type IndexerBlock, type IndexerClientOptions } from "./indexer-client.js";
import { NodeRpcClient, type NodeRpcClientOptions, type SubstrateHeader } from "./node-rpc-client.js";
import {
  assertSupportedProtocolVersion,
  callIndicesForProtocolVersion,
  classifyExtrinsic,
  decodeProtocolVersionFromDigest,
  requireCallIndices,
} from "./extrinsic-decoder.js";
import { decodeArchivedTransaction, loadLedgerV8 } from "./tx-replay-decoder.js";
import { LedgerReplay } from "./ledger-replay.js";
import {
  BlockScopedMetadata,
  decodeBlockTimestampMs,
  decodeEventSystemTransactions,
  decodeExtrinsicWithMetadata,
  type ResolvedRuntimeMetadata,
} from "./runtime-metadata.js";

/**
 * The real ingestion/sync service that populates the `chain_archive` schema from a live Midnight
 * node (JSON-RPC, raw block bytes) and OPTIONALLY an indexer (GraphQL, structured transaction
 * metadata) -- `design/full-chain-storage-design.md`'s Tier-1.5 archive, made real per this
 * implementation sprint's task.
 *
 * **Sprint 9 (indexer independence):** the indexer is no longer a required dependency. With no
 * `indexer` option the service runs NODE-ONLY -- regular-transaction ingest derived entirely
 * from the node (extrinsic-envelope decode via `extrinsic-decoder.ts`, tx hashes recomputed
 * locally via the ledger WASM, protocol version from the header's MNSV consensus digest,
 * D-parameter via `state_call`). With the `indexer` option present, behavior is the pre-sprint-9
 * ingest plus a hard ORACLE CROSS-CHECK of the node-derived view against the indexer's on every
 * block. See `ChainArchiveSyncServiceOptions`'s field docs for the full
 * mode table and scope boundaries (system transactions stay out of node-only scope).
 *
 * **Dependency shape, stated precisely (Sol-audit fix round, Finding 7 -- an earlier version of
 * this comment overclaimed "interface injection")**: this module directly imports and constructs
 * the concrete `PgChainArchiveStore` (`src/postgres/chain-archive-store.ts`) in its constructor,
 * and imports the `UmbraDBSql` type from `src/postgres/client.ts` -- there is no runtime
 * dependency injection of the store. `ChainArchiveStore`
 * (`src/interfaces/chain-archive-store.ts`) serves as a TYPE-ONLY contract: the `store` field is
 * typed against the interface, so everything after construction goes through the interface
 * surface, but the implementation choice is hard-wired here, not injected by the caller. That is
 * an allowed, deliberate arrangement -- the architectural boundary (AC-7) is DIRECTIONAL:
 * `chain-archive-sync/* -> src/postgres/*` is the permitted direction, and what the guard
 * (`test/postgres/no-chain-sync-import-guard.test.ts`) enforces is that `src/*` never imports
 * anything from this directory back.
 *
 * **Judgment call, documented (no design-doc precedent covers this exactly)**: the node's
 * `chain_getBlock` JSON-RPC response does not hand back literal on-wire SCALE bytes for the
 * header as a single blob (Substrate's JSON-RPC layer decodes the header into named fields
 * before returning it) -- there is no `chain_getHeaderBytes`-equivalent call. This service
 * content-addresses a **canonical JSON serialization of exactly what the node authoritatively
 * returned** for `header` (`headerBytes`) and for the `extrinsics` array (`bodyBytes`) as the
 * "raw" payload chain_blobs stores for those two roles -- deterministic, reconstructable byte-
 * for-byte from what the node handed back, hash-verified on every read (AC-3), but NOT a
 * from-scratch re-implementation of Substrate's own header SCALE codec. Each individual
 * transaction's `tx_raw` blob, by contrast, IS real on-wire bytes straight from the indexer's
 * `Transaction.raw` field, not a JSON reconstruction -- but (a second empirical judgment call,
 * see `ingestTransactionsForBlock`'s own doc below for the full byte-level finding) it is the
 * INNER opaque `pallet_midnight::send_mn_transaction` payload specifically, not the node's outer
 * per-extrinsic SCALE envelope bytes (confirmed live: the indexer's `raw` is an exact suffix of
 * the corresponding node extrinsic's bytes, not byte-identical to it) -- cross-checked below by
 * substring containment against the node's own block body, not by exact-string membership.
 */

/** Deterministic canonical-JSON encode that also sorts NESTED object keys, not just the
 *  top-level ones `JSON.stringify(value, Object.keys(...).sort())` alone would cover -- header/
 *  digest objects nest one level (`digest.logs`), and `Array.isArray`-checked recursion keeps
 *  array element order (order is semantically meaningful for `logs`/`extrinsics`) while still
 *  making key order deterministic within each object. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function headerBytes(header: SubstrateHeader): Uint8Array {
  return new TextEncoder().encode(stableStringify(header));
}

function extrinsicsBytes(extrinsics: string[]): Uint8Array {
  return new TextEncoder().encode(stableStringify(extrinsics));
}

function hexNoPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

const SYSTEM_TX_TAG = "midnight:system-transaction";

/** Identifies the ledger build whose encoding a checkpoint's bytes are in. Bumping the vendored
 *  ledger MUST bump this: serialized state is a ledger-internal encoding, and resuming it under a
 *  build that reads it differently produces wrong replay outcomes rather than an error. */
const LEDGER_STATE_VERSION = "ledger-v8@8.1.0-syshash.3";

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hexNoPrefix(hex), "hex"));
}

/**
 * Refuse a block whose transactions would collide on the archive's transaction key -- which, since
 * `002_transaction_position_key`, is `position` rather than `tx_hash`.
 *
 * This guard used to reject two rows sharing a HASH. That is now the legal, required shape: the
 * reference indexer stores a dual-source system transaction twice, so byte-parity means this
 * archive must too, and the migration re-keyed the table precisely to allow it. Left unchanged,
 * this function would have refused exactly the blocks Stage 2 exists to archive.
 *
 * What it checks instead is what the new key actually forbids: two transactions at one position.
 * That is both an unstorable row and a sign the block's ordering is wrong -- and ordering is part
 * of what this archive guarantees, since two archives holding the same transactions in different
 * order are not interchangeable for anything reading by position.
 *
 * Split out as a free function so it can be unit-tested without standing up a service, a schema
 * and a fake chain: the property is purely about a list of records, and the case that produces it
 * in the wild (a system transaction present in both an extrinsic and an event) cannot be produced
 * on any reachable devnet.
 */
export function assertNoDuplicateTransactionKeys(
  height: number,
  transactions: readonly { txHash: string; position: number; kind: string }[],
): void {
  const seen = new Map<number, string>();
  for (const t of transactions) {
    const previous = seen.get(t.position);
    if (previous !== undefined) {
      throw new Error(
        `height ${height}: two transactions both claim position ${t.position} (${previous} and ` +
          `${t.txHash}). Position is the archive's primary key within a block, so only one could ` +
          "be stored, and because inserts are ON CONFLICT DO NOTHING the other would be dropped " +
          "in silence. Two different transactions at one position also means the block's ordering " +
          "is wrong, and ordering is part of what this archive guarantees.",
      );
    }
    seen.set(t.position, t.txHash);
  }
}

export interface ChainArchiveSyncServiceOptions {
  sql: UmbraDBSql;
  net: string;
  schema?: string;
  node: NodeRpcClientOptions;
  /**
   * OPTIONAL as of sprint 9 (indexer independence). Three modes fall out of this one option:
   *
   *   - **absent** -> NODE-ONLY ingest: every archived field is derived from the node alone
   *     (extrinsic-envelope decode + ledger-WASM `transactionHash()` + MNSV header digest +
   *     `state_call`). Scope: REGULAR transactions only -- runtime-generated system
   *     transactions are not in `chain_getBlock.extrinsics` (they surface via the
   *     `SystemTransactionApplied` event, whose decode needs runtime metadata -- a recorded
   *     deferral, not a structural impossibility), and extrinsic-borne system payloads
   *     (genesis) are skipped too because the ledger WASM exposes no
   *     `SystemTransaction.hash()` accessor to compute their `tx_hash` PK with.
   *   - **present** -> the pre-sprint-9 indexer-sourced ingest, UNCHANGED in what it writes,
   *     plus the ORACLE CROSS-CHECK: node-derived records are computed anyway and any
   *     disagreement with the indexer's (tx hash, raw bytes, protocolVersion, per-regular-tx)
   *     throws before anything is written -- every synced block becomes a continuous Run-B-style
   *     differential check for free while the indexer still exists.
   *   - at indexer shutdown, the cutover is: stop passing this option.
   */
  indexer?: IndexerClientOptions;
  /**
   * Cross-check the node-derived view against the indexer's on every block, throwing on any
   * disagreement. A VALIDATION mode, off by default.
   *
   * It was briefly mandatory whenever an indexer was configured, which was wrong: it made a
   * node-side decode path a hard dependency of the long-standing indexer-sourced ingest, so a
   * runtime this build cannot classify would fail a sync that never needed classification. The
   * indexer path is now behaviourally unchanged unless this is explicitly turned on.
   */
  oracleCrossCheck?: boolean;
  /**
   * Apply each block's transactions to real ledger state as it is ingested, and refuse a block
   * the reference would refuse (audit A2). Off by default: it makes ingest strictly slower and
   * requires an unbroken run from genesis, so it is a deliberate choice rather than a surprise.
   *
   * When on, restart resumes from the newest `replay_checkpoints` row at or below the watermark;
   * a checkpoint written by a different ledger build is refused rather than resumed.
   */
  replayValidation?: boolean;
  /**
   * The LEDGER's network id, e.g. `"undeployed"`. Required when `replayValidation` is on.
   *
   * Not derivable from anything this service already knows. `net` is this archive's own row-scope
   * label ("preprod", "devnet-3") and has no relationship to the ledger's network id, which the
   * reference takes from configuration (`network_id: "undeployed"`) and which transactions embed
   * in their own bytes. Initialising ledger state with the wrong one makes every `wellFormed`
   * check evaluate against a network the transactions were not built for.
   */
  ledgerNetworkId?: string;
  /** Blocks between replay checkpoints. Serialized state is unbounded in size (~37 KB after
   *  genesis alone), so this trades restart time against storage; per-block would dwarf the
   *  archive. */
  replayCheckpointInterval?: number;
  /**
   * The genesis hash this archive is expected to be built from. Optional, and only load-bearing
   * on the FIRST sync of an empty archive -- after that the archived genesis block is the anchor.
   * Set it when an archive is being created against an endpoint that could be misconfigured, so
   * a wrong chain is refused before any row is written rather than becoming the archive's
   * identity.
   */
  expectedGenesisHash?: string;
}

export interface SyncOnceResult {
  ingestedBlocks: number;
  fromHeight: number | undefined;
  toHeight: number | undefined;
  targetTipHeight: number;
  /** Extrinsics whose payload carried a `midnight:` self-tag but whose DISPATCHED CALL was not a
   *  Midnight transaction call, so the ledger never applied them. Normally 0 and unreachable for
   *  an ordinary user on the 1.0 runtime. Surfaced rather than dropped because the same signal
   *  fires if a runtime renumbers its pallets -- in which case genuine transactions would
   *  otherwise vanish from the archive without a word. */
  midnightTaggedForeignCalls: number;
}

const WATERMARK_KEY_PREFIX = "sync_cursor:";

export class ChainArchiveSyncService {
  /** Honest scope declaration (Sol-audit fix round, Finding 5): this service does NOT ingest
   *  verifier-key observations -- nothing here ever calls
   *  `ChainArchiveStore.putVerifierKeyObservation`. Sync-side VK ingestion is out of scope for
   *  this sprint: neither the local devnet nor the captured testnet has ever had a contract
   *  deployed (design doc §3.6; `contract_actions: 0`), so no VK-bearing data source exists to
   *  ingest from or to test against. The STORE-level write path is real and covered
   *  (`test/postgres/chain-archive-store.test.ts`); flip this to `true` only alongside an actual
   *  ingestion implementation and a data source that exercises it. */
  static readonly INGESTS_VERIFIER_KEYS = false as const;

  /** Typed against the `ChainArchiveStore` INTERFACE (type-only contract), but constructed
   *  concretely as `PgChainArchiveStore` in the constructor below -- see the module doc's
   *  "Dependency shape" note (Finding 7). */
  readonly store: ChainArchiveStore;
  private readonly node: NodeRpcClient;
  /** `undefined` -> node-only mode (sprint 9); present -> indexer-sourced ingest + oracle
   *  cross-check. See `ChainArchiveSyncServiceOptions.indexer`'s doc for the full mode table. */
  private readonly indexer: IndexerClient | undefined;
  /** Lazily-loaded `@midnight-ntwrk/ledger-v8` WASM module (`loadLedgerV8`). Required in
   *  node-only mode (transaction hashes); never loaded otherwise, so a plain indexer-sourced
   *  deployment keeps working without the sibling wallet checkout. */
  private ledgerPromise: Promise<unknown> | undefined;
  /** See `ChainArchiveSyncServiceOptions.oracleCrossCheck`. */
  private readonly oracleCrossCheckEnabled: boolean;
  /** See `ChainArchiveSyncServiceOptions.expectedGenesisHash`. */
  private readonly expectedGenesisHash: string | undefined;
  private readonly net: string;
  /** Last-seen D-parameter, in-memory, this instance's lifetime only -- used to dedupe
   *  `bridge_observations` inserts (§"stub/initial pass") so a healthy chain with an unchanging
   *  D-parameter doesn't get one near-duplicate row per block. Deliberately not persisted: a
   *  fresh service instance re-inserting one observation on its first synced block after a
   *  restart is a correct, harmless re-observation, not a bug (`bridge_observations` has no
   *  uniqueness constraint on content, only on `(net, block_height, block_hash,
   *  observation_index)`, so this can never produce a duplicate-key error either way). */
  private lastDParameterJson: string | undefined;

  /** Block-scoped runtime metadata, used by node-only ingest to classify calls and decode events.
   *  Constructed always but only exercised in node-only mode, so indexer-sourced ingest issues no
   *  metadata request at all and keeps working against a pruned node. */
  private readonly metadata: BlockScopedMetadata;

  /** The height currently being ingested, so a metadata capture records the block that actually
   *  introduced the runtime rather than whatever height a later re-sync happened to reach. */
  private currentIngestHeight: number | undefined;

  private readonly replayValidation: boolean;
  private readonly ledgerNetworkId: string | undefined;
  private readonly replayCheckpointInterval: number;
  /** Live replay state, built lazily on first use so plain ingest pays nothing for it. */
  private replay: LedgerReplay | undefined;
  /** Height of the last block replay has applied, so a gap is detected rather than skipped. */
  private replayHeight: number | undefined;
  /** Set on resume when the newest checkpoint is behind the resume point; drives catch-up. */
  private replayCatchUpFrom: number | undefined;
  /** Hash of the block replay applied most recently. During catch-up this binds each independently
   *  selected canonical height to the state actually being folded, preventing fork splices. */
  private lastReplayedBlockHash: Hex32 | undefined;
  /** The timestamp of the block replay applied most recently -- the `last_block_time` the
   *  reference passes when applying the NEXT one. Carried in memory across blocks within a run,
   *  and restored from the checkpoint on resume, which is what stops the first block after a
   *  restart from being folded against a parent dated 1970 (T1). */
  private lastReplayedBlockTimestampMs: number | undefined;

  constructor(opts: ChainArchiveSyncServiceOptions) {
    this.store = new PgChainArchiveStore(opts.sql, opts.schema ?? "chain_archive");
    this.node = new NodeRpcClient(opts.node);
    // The archive is the resolver's first-choice metadata source and the destination for anything
    // it fetches, so a runtime is retrieved from the node exactly once per net and the archive
    // becomes self-describing from then on.
    this.metadata = new BlockScopedMetadata(this.node, {
      load: (identity) =>
        this.store.getRuntimeMetadata(this.net, identity.specName, identity.specVersion),
      save: (identity, bytes) =>
        this.store.putRuntimeMetadata({
          net: this.net,
          specName: identity.specName,
          specVersion: identity.specVersion,
          firstSeenHeight: this.currentIngestHeight ?? 0,
          metadataBytes: bytes,
        }),
    });
    this.indexer = opts.indexer === undefined ? undefined : new IndexerClient(opts.indexer);
    this.oracleCrossCheckEnabled = opts.oracleCrossCheck ?? false;
    this.replayValidation = opts.replayValidation ?? false;
    this.ledgerNetworkId = opts.ledgerNetworkId;
    if (this.replayValidation && this.ledgerNetworkId === undefined) {
      throw new Error(
        "replayValidation requires ledgerNetworkId (e.g. \"undeployed\"). It cannot be inferred " +
          "from `net`, which is this archive's row-scope label rather than the ledger's network " +
          "id, and initialising ledger state against the wrong network silently invalidates every " +
          "well-formedness check.",
      );
    }
    this.replayCheckpointInterval = opts.replayCheckpointInterval ?? 1000;
    // T6. `checkpointReplayIfDue` tests `height % interval === 0`. With `0` that is NaN, with a
    // fractional interval it is almost never true, and with a negative one it is meaningless --
    // in every case checkpointing is silently OFF while the service reports normal operation. The
    // only symptom surfaces much later, as a restart that has to replay the entire chain. Checked
    // in the constructor as well as in the CLI because this is the reusable API: a caller that
    // never goes through the CLI must not be able to configure the feature into doing nothing.
    if (
      !Number.isInteger(this.replayCheckpointInterval) || this.replayCheckpointInterval < 1
    ) {
      throw new Error(
        `replayCheckpointInterval must be a whole number >= 1; got ` +
          `${this.replayCheckpointInterval}. Zero, fractional, negative and non-finite values ` +
          "disable checkpointing entirely rather than adjusting it, so they are rejected instead " +
          "of being treated as configuration.",
      );
    }
    this.expectedGenesisHash =
      opts.expectedGenesisHash === undefined ? undefined : hexNoPrefix(opts.expectedGenesisHash);
    this.net = opts.net;
  }

  /** Loads the ledger WASM exactly once, on first need. Throws `loadLedgerV8`'s own descriptive
   *  error (which names the checkout candidates and the `MIDNIGHT_WALLET_REPO` override) if no
   *  built wallet checkout exists -- a hard requirement of node-only mode,
   *  deliberately NOT of plain indexer-sourced ingest. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ledger(): Promise<any> {
    this.ledgerPromise ??= loadLedgerV8();
    return this.ledgerPromise;
  }

  private watermarkKey(): string {
    return `${WATERMARK_KEY_PREFIX}${this.net}`;
  }

  /** Resumable sync cursor -- the last successfully-ingested height, or `undefined` if this net
   *  has never been synced. Matches this codebase's existing watermark convention
   *  (`src/interfaces/watermarks.ts`): a plain last-write-wins cursor, no history. */
  async getSyncedHeight(): Promise<number | undefined> {
    const wm = await this.store.getWatermark(this.watermarkKey());
    if (wm === undefined) return undefined;
    const parsed = wm as { height: number };
    return parsed.height;
  }

  /**
   * Ingests one contiguous batch of blocks, starting right after the last watermark (or from
   * genesis on first run), up to `min(finalized head, watermark + maxBlocks)`. Only ever
   * ingests up to the FINALIZED head (`chain_getFinalizedHead`) -- deliberately conservative for
   * this first pass: every block this service archives is marked `is_canonical: true,
   * finalized: true` (GRANDPA-finalized blocks are canonical by construction, matching
   * `blocks`'s own `CHECK (NOT finalized OR is_canonical)` invariant), so this service does not
   * need to implement reorg/fork-following logic for the not-yet-finalized tail -- a real
   * production deployment would extend this to also track the best (non-finalized) head via
   * `setCanonical`'s reorg-flip support, which the storage layer already provides; that
   * extension is out of this sprint's scope (see the final report's judgment-calls section).
   */
  /**
   * Audit finding (HIGH): `net` is an operator-supplied label with no binding to the chain the
   * node actually serves, so pointing NODE_URL at a different network and reusing the same `net`
   * silently comingles two chains in one archive -- the exact failure the `net` column was added
   * to prevent, reintroduced through configuration.
   *
   * Genesis hash is the chain's identity: it is stable for the life of a network, differs across
   * networks by construction, and costs one `chain_getBlockHash(0)` per batch. First sync for a
   * `net` records it; every later sync must match. Stored in the archive's own watermarks table
   * (arbitrary key/JSON value), so this needs no migration.
   */
  /**
   * Refuse to ingest a chain other than the one this archive already holds.
   *
   * The anchor is the archive's OWN archived genesis block, not a metadata record written
   * alongside it. An earlier revision stored a `chain_identity:<net>` watermark on first sync,
   * which was wrong twice over: Part A is meant to add no stored data, and an EMPTY archive
   * pointed at the wrong node once would record that foreign identity permanently -- after which
   * returning to the correct node was rejected forever, with the operator's only recourse being
   * to hand-edit a watermark. Deriving the anchor from block 0 has neither problem: an empty
   * archive has nothing to poison, and a populated one carries its own proof.
   *
   * `expectedGenesisHash` covers the one case the archive cannot self-anchor: the very first
   * sync, where there is no archived block to compare against. Configure it and a misdirected
   * first run is caught before anything is written; leave it unset and the first sync establishes
   * the anchor by archiving genesis, which every later run is then checked against.
   */
  private async assertChainIdentity(): Promise<void> {
    const nodeGenesis = hexNoPrefix(await this.node.getBlockHash(0));

    if (this.expectedGenesisHash !== undefined && nodeGenesis !== this.expectedGenesisHash) {
      throw new Error(
        `chain identity: the configured node serves genesis ${nodeGenesis}, but this sync is ` +
          `configured to expect ${this.expectedGenesisHash}. Refusing to ingest.`,
      );
    }

    const archivedGenesis = await this.store.getCanonicalBlockAtHeight(this.net, 0);
    if (archivedGenesis !== undefined && archivedGenesis.blockHash !== nodeGenesis) {
      throw new Error(
        `chain identity mismatch for net=${this.net}: this archive holds genesis ` +
          `${archivedGenesis.blockHash}, but the configured node serves ${nodeGenesis}. Refusing ` +
          "to splice a different chain into an existing archive -- use a different NET, or point " +
          "at the original chain.",
      );
    }
  }

  async syncOnce(opts?: { maxBlocks?: number }): Promise<SyncOnceResult> {
    const maxBlocks = opts?.maxBlocks ?? 100;
    this.midnightTaggedForeignCalls = 0;
    await this.assertChainIdentity();
    const finalizedHash = await this.node.getFinalizedHead();
    const targetTipHeight = await this.node.getHeightOf(finalizedHash);

    const synced = await this.getSyncedHeight();
    const startHeight = synced === undefined ? 0 : synced + 1;
    if (startHeight > targetTipHeight) {
      return {
        ingestedBlocks: 0, fromHeight: undefined, toHeight: undefined, targetTipHeight,
        midnightTaggedForeignCalls: this.midnightTaggedForeignCalls,
      };
    }
    const endHeight = Math.min(targetTipHeight, startHeight + maxBlocks - 1);

    let ingested = 0;
    for (let height = startHeight; height <= endHeight; height++) {
      await this.ingestOneBlock(height);
      ingested++;
    }
    return {
      ingestedBlocks: ingested, fromHeight: startHeight, toHeight: endHeight, targetTipHeight,
      midnightTaggedForeignCalls: this.midnightTaggedForeignCalls,
    };
  }

  /**
   * Fix 1 (sprint-fix round, HIGH): previously this method issued `putBlock`/`putTransactions`/
   * `putBridgeObservations` as three SEPARATE, independently-committed Postgres transactions,
   * with `setWatermark` (in `syncOnce`) as a fourth step after this whole method returned. None
   * of the three writes used `ON CONFLICT`, so retrying the same height after ANY partial
   * failure -- the documented "indexer hasn't caught up" case, but also a transient indexer
   * inconsistency after the block-write committed, a transient Postgres error on a later write,
   * or a process crash/SIGKILL between any two of the four writes -- hit a duplicate-key error on
   * whichever insert(s) had already committed and wedged the sync service at that height
   * permanently.
   *
   * Fixed by (a) fetching the indexer's view of this block, and building every record this block
   * needs to write, BEFORE issuing a single store write, so the "indexer hasn't synced this
   * height yet" throw (below) happens with zero writes having occurred at all; and (b) writing
   * the block/transactions/bridge-observations as ONE atomic bundle via
   * `ChainArchiveStore.putBlockBundle` (`src/postgres/chain-archive-store.ts`), which both makes
   * the three logically-one-block writes commit-or-fail together AND makes each underlying insert
   * `ON CONFLICT ... DO NOTHING` on its own primary key -- so retrying this exact height, whether
   * the previous attempt never got this far, partially wrote, or (e.g. a crash between this
   * method returning and `syncOnce`'s `setWatermark` call) fully committed, is always a safe
   * no-op rather than a wedge.
   */
  /**
   * Audit finding (HIGH): blocks were resolved independently by height and the cursor advanced
   * without ever checking that a block's parent is the block already archived beneath it. That
   * makes two silent corruptions possible -- a reorg between the height lookup and the fetch, and
   * an operator repointing NODE_URL at a different chain mid-archive, which would splice foreign
   * history into an existing `net` with no error anywhere.
   *
   * The reference indexer verifies exactly this (`subxt_node.rs`, `ParentHashMismatch`).
   *
   * The previous hash is kept in memory across a run and only read from the store on the first
   * block after a restart, so the common path costs nothing. A missing predecessor at height > 0
   * is itself an error: `syncOnce` only ever ingests `watermark + 1`, so contiguity is its own
   * invariant and a hole means something outside this service moved the cursor.
   */
  private lastArchived: { height: number; blockHash: Hex32 } | undefined;

  /** Reset at the start of each `syncOnce` and reported in its result. */
  private midnightTaggedForeignCalls = 0;

  private async assertParentContinuity(
    height: number,
    header: SubstrateHeader,
    blockHash: Hex32,
  ): Promise<void> {
    if (height === 0) {
      // The one block with no parent to check, and therefore the one place the identity check
      // above can be raced: it resolves genesis at the START of a batch, and an endpoint or load
      // balancer that switches chains between then and now would commit a different chain's
      // genesis under an identity already recorded. Binding the check to the block actually being
      // committed closes that. Every block ABOVE genesis is already bound transitively, because
      // parent continuity chains each one back to this block.
      if (this.expectedGenesisHash !== undefined && blockHash !== this.expectedGenesisHash) {
        throw new Error(
          `chain identity race at genesis (net=${this.net}): the block being committed at height ` +
            `0 is ${blockHash}, but ${this.expectedGenesisHash} was expected. The node endpoint ` +
            "changed chains between the identity check and this write.",
        );
      }
      return;
    }
    const parentHash = hexNoPrefix(header.parentHash);
    const expected =
      this.lastArchived?.height === height - 1
        ? this.lastArchived.blockHash
        : (await this.store.getCanonicalBlockAtHeight(this.net, height - 1))?.blockHash;
    if (expected === undefined) {
      throw new Error(
        `chain continuity: no archived block at height ${height - 1} to attach height ${height} ` +
          `to (net=${this.net}). Ingest is contiguous by construction, so this indicates the ` +
          "sync cursor was moved externally or the archive was partially deleted.",
      );
    }
    if (parentHash !== expected) {
      throw new Error(
        `chain continuity BROKEN at height ${height} (net=${this.net}): this block's parent is ` +
          `${parentHash} but the archived block at height ${height - 1} is ${expected}. Either a ` +
          "reorg occurred below the finalized head, or the node endpoint now serves a different " +
          "chain than the one already archived under this net.",
      );
    }
  }

  /**
   * `System::Events` storage key: twox128("System") ++ twox128("Events"). A well-known Substrate
   * constant, not derived at runtime -- computing it would need a twox128 implementation for no
   * benefit, since it is fixed for every Substrate chain.
   */
  private static readonly SYSTEM_EVENTS_KEY =
    "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";

  /**
   * Refuse a block whose events carry system transactions this build did not archive.
   *
   * The gap being guarded: system transactions reach the node two ways. Extrinsic-borne ones are
   * archived (they are in `chain_getBlock.extrinsics`). Runtime-GENERATED ones exist only as
   * `SystemTransactionApplied` events, which this build does not decode -- so on a chain that
   * mints block rewards, a node-only archive would be short of an indexer-sourced one WITHOUT
   * SAYING SO. That silence is the problem: `ON CONFLICT DO NOTHING` means such an archive cannot
   * be repaired by re-ingesting later.
   *
   * The check locates each occurrence of the system-transaction self-tag in the raw events blob
   * and asks whether an ARCHIVED system transaction's bytes begin at that exact offset. Byte
   * matching, not decoding: delimiting an event payload needs runtime metadata, which is exactly
   * what this build lacks. It is deliberately a DETECTION, not a classification -- the tag is
   * never used to decide what something IS, only to notice something we did not account for.
   *
   * This used to COUNT tagged payloads and refuse when the count exceeded the archived count.
   * That had a false negative, and it is worth spelling out because it is not obvious. Let
   * `S` = successful direct system extrinsics (archived, and also present as events),
   * `F` = valid direct system calls rejected before ledger execution (archived, but emitting no
   * event), and `R` = runtime-generated event-only system transactions. Counting compared
   * `S + R > S + F`, which detects an omission only when `R > F` -- so one failed direct call
   * plus one runtime-generated event produced EQUAL counts, the guard passed, the runtime
   * transaction was omitted, and the watermark advanced.
   *
   * Matching bytes instead separates the two populations that counting conflated: `F` contributes
   * an archived transaction with no event occurrence (nothing to flag, correctly), while `R`
   * contributes an event occurrence matching nothing archived (flagged, correctly). The masking
   * disappears rather than being made less likely.
   *
   * Residual limits, stated rather than implied. This assumes the event's
   * `serialized_system_transaction` bytes are identical to the bytes archived from the
   * corresponding extrinsic, which is what the reference indexer's own handling implies but has
   * not been observed on a chain that actually produces both -- if they ever differ, this
   * over-refuses. Over-refusal is the direction this archive deliberately errs in: a refusal is
   * visible and fixable, whereas the omission it replaces is silent and, under
   * `ON CONFLICT DO NOTHING`, unrepairable. It also still cannot tell WHAT an unmatched payload
   * is, only that it exists; that needs block-scoped metadata decoding.
   *
   * Genesis emits no events at all, so the case that works today is unaffected.
   */
  private async assertNoUnarchivedEventSystemTransactions(
    height: number,
    blockHash: Hex32,
    archivedSystemRaw: readonly Uint8Array[],
  ): Promise<void> {
    const raw = await this.node.storageAt(ChainArchiveSyncService.SYSTEM_EVENTS_KEY, `0x${blockHash}`);
    if (raw === undefined) return; // no events recorded for this block (genesis, notably)
    const events = Buffer.from(hexNoPrefix(raw), "hex");
    const tag = Buffer.from(SYSTEM_TX_TAG, "latin1");
    const archived = archivedSystemRaw.map((b) => Buffer.from(b));
    let unaccounted = 0;
    for (let i = events.indexOf(tag); i !== -1; i = events.indexOf(tag, i + 1)) {
      const accountedFor = archived.some(
        (b) => i + b.length <= events.length && events.subarray(i, i + b.length).equals(b),
      );
      if (!accountedFor) unaccounted++;
    }
    if (unaccounted > 0) {
      throw new Error(
        `height ${height}: the block's events carry ${unaccounted} system-transaction payload(s) ` +
          `matching none of the ${archived.length} archived from extrinsics. Runtime-generated ` +
          "system transactions exist only in the SystemTransactionApplied event, which this build " +
          "does not decode, so archiving this block would silently omit them -- and inserts are ON " +
          "CONFLICT DO NOTHING, so re-ingesting later would not repair it. Use indexer-sourced " +
          "ingest for this range until event decoding lands.",
      );
    }
  }

  private async ingestOneBlock(height: number): Promise<void> {
    const blockHash = hexNoPrefix(await this.node.getBlockHash(height));
    const { block } = await this.node.getBlock(`0x${blockHash}`);
    const header = block.header;
    await this.assertParentContinuity(height, header, blockHash);

    // Sprint 9: the node-derived view is ALWAYS computed -- it is the source of truth in
    // node-only mode and the oracle comparand in indexer mode. `decodeMidnightExtrinsic`
    // throws (rather than skipping) on a corrupted envelope, so a malformed node response
    // aborts the block before any write, same as every other pre-write failure here.
    // Order matters: the protocol version decides which runtime call indices are authoritative,
    // and those indices are what classify an extrinsic as a Midnight transaction. Classifying
    // first and resolving the version afterwards would mean deciding what the bytes are before
    // knowing which runtime produced them.
    const nodeProtocolVersion = decodeProtocolVersionFromDigest(header.digest.logs);
    // Gate the version BEFORE any payload reaches the ledger WASM, in BOTH modes. The archive
    // wires exactly one ledger codec (v8); a protocol upgrade outside the known ranges must halt
    // ingest with a version-named error rather than decode an unknown ledger with the v8
    // deserializer and persist whatever comes out. Placed here, ahead of the mode split, so
    // indexer-sourced ingest is gated identically -- the indexer would keep serving rows across
    // an upgrade, and silently trusting them is the same failure by a different route.
    if (nodeProtocolVersion !== undefined) {
      assertSupportedProtocolVersion(nodeProtocolVersion, height);
    }
    /**
     * Classify this block's extrinsics with the runtime's own call numbering.
     *
     * Called only where node-derived payloads are actually NEEDED -- node-only ingest, and the
     * opt-in oracle cross-check -- never unconditionally. An earlier revision ran it ahead of the
     * source split so both modes were gated identically, which read as defensive but was a
     * regression: `requireCallIndices` refuses a protocol version with no verified index mapping,
     * and 0.22 is a SUPPORTED ledger version with no such mapping. An indexer-backed sync of a
     * 0.22 chain that worked before would have started failing before it ever consulted the
     * indexer -- a node-side gate breaking a path that does not depend on the node's call
     * numbering at all.
     *
     * A foreign-call anomaly ABORTS the block rather than being counted and written past. The
     * shape it detects is a runtime that renumbered its pallets, in which case the "anomalies"
     * are genuine transactions about to be dropped; completing the block would persist a
     * silently incomplete archive and advance the watermark past it.
     */
    const classifyBlock = (): { kind: "regular" | "system"; payload: Uint8Array }[] => {
      if (nodeProtocolVersion === undefined) return [];
      const indices = requireCallIndices(nodeProtocolVersion, height);
      const payloads: { kind: "regular" | "system"; payload: Uint8Array }[] = [];
      let foreign = 0;
      for (const e of block.extrinsics) {
        const c = classifyExtrinsic(e, indices);
        if (c.outcome === "midnight") payloads.push(c.extrinsic);
        else if (c.outcome === "midnight_tagged_foreign_call") foreign++;
        else if (c.outcome === "midnight_tagged_undecodable_framing") {
          // A signed or "general" extrinsic carrying a Midnight transaction payload. The pallet
          // ignores its origin, so this is a VALID transaction that the reference indexer archives
          // -- reading its call needs runtime metadata this build does not have. Refuse rather
          // than drop it silently: inserts are ON CONFLICT DO NOTHING, so a block written without
          // it could not be repaired by re-ingesting once metadata decoding lands.
          throw new Error(
            `height ${height}: an extrinsic with v${c.version} signed/general framing carries a ` +
              "Midnight transaction payload. Such transactions are valid and the indexer archives " +
              "them, but reading the call out of a signed framing needs runtime metadata this " +
              "build does not decode. Refusing rather than omitting it. Use indexer-sourced " +
              "ingest for this range until metadata decoding lands.",
          );
        }
      }
      if (foreign > 0) {
        this.midnightTaggedForeignCalls += foreign;
        throw new Error(
          `height ${height}: ${foreign} extrinsic(s) carry a midnight transaction payload under a ` +
            `call this build does not recognize as a Midnight call (protocol ${nodeProtocolVersion}). ` +
            "The most likely cause is a runtime that renumbered its pallets, which would make GENUINE " +
            "transactions vanish from the archive. Refusing to write the block. Verify the call " +
            "indices for this runtime and add them to CALL_INDICES_BY_PROTOCOL.",
        );
      }
      return payloads;
    };

    let transactions: TransactionRecord[];
    let bridge: { records: BridgeObservationRecord[]; newDParameterJson: string | undefined };

    if (this.indexer !== undefined) {
      // ── INDEXER-SOURCED MODE (pre-sprint-9 behavior, plus the oracle cross-check) ──
      // One indexer fetch per block, shared by the transaction-ingestion and bridge-observation
      // paths below. Fetched BEFORE any store write (Fix 1) so the throw immediately below never
      // leaves a partially-ingested block behind.
      const indexerBlock = await this.indexer.getBlockByHeight(height);
      if (indexerBlock === undefined) {
        // Indexer hasn't synced this height yet -- do NOT advance the watermark past it (syncOnce
        // only advances the watermark after this whole method returns successfully), so a later
        // syncOnce() call re-attempts this exact height once the indexer catches up. No store
        // write has happened yet at this point, so that retry starts completely fresh.
        throw new Error(`indexer has not yet synced height ${height} (node has); retry later`);
      }
      if (this.oracleCrossCheckEnabled) {
        this.oracleCrossCheck(height, classifyBlock(), nodeProtocolVersion, indexerBlock);
      }
      transactions = this.buildTransactionRecords(height, blockHash, block.extrinsics, indexerBlock);
      bridge = this.buildBridgeObservationRecords(
        height, blockHash, indexerBlock.systemParameters.dParameter,
      );
    } else {
      // ── NODE-ONLY MODE (sprint 9) -- no network call to any indexer endpoint anywhere. ──
      if (nodeProtocolVersion === undefined) {
        // Same hard-failure stance as the reference indexer's own MissingProtocolVersionHeader:
        // a block without the MNSV consensus digest cannot be attributed to a protocol version,
        // and guessing one would poison every downstream decode-version decision.
        throw new Error(`no MNSV protocol-version digest item in header at height ${height}`);
      }
      // Stage 2: the block's own runtime metadata drives classification and event decoding.
      //
      // This replaces `buildNodeOnlyTransactionRecords` + `assertNoUnarchivedEventSystemTransactions`
      // -- a pinned-index classifier that could not read signed framings, plus a byte-counting
      // guard that could only NOTICE an event-borne system transaction and refuse. Both were
      // interim measures whose whole purpose was to avoid silently omitting what they could not
      // decode; decoding it removes the need for either.
      transactions = await this.buildNodeOnlyRecordsFromMetadata(
        height, blockHash, block.extrinsics, nodeProtocolVersion,
      );
      bridge = this.buildBridgeObservationRecords(
        height, blockHash, await this.fetchDParameterFromNode(blockHash),
      );
    }

    // The archive's transaction key is (net, block_height, block_hash, tx_hash), so two rows
    // sharing a hash inside one block cannot BOTH be stored -- and every terminal insert is
    // `ON CONFLICT DO NOTHING`, so the second is dropped in silence rather than erroring.
    // Applies to BOTH modes, and is reachable today in indexer-sourced mode: the reference
    // indexer does not deduplicate (`runtimes/v1_0_0.rs:160-163` prepends event-borne system
    // transactions and plain-`extend`s the extrinsic list), and its own `transactions` table has
    // no unique constraint on `hash`, so a successful direct system call legitimately appears
    // TWICE. Storing one of the two would look like a complete block while silently disagreeing
    // with the source we are defined against.
    //
    // Refusing is the interim. The approved fix is widening the key with `position` (plan §3(c),
    // owner-approved), which lets both copies be stored the way the indexer stores them; until
    // that migration lands, a collision must stop the block rather than quietly lose a row.
    assertNoDuplicateTransactionKeys(height, transactions);
    await this.assertNoConflictingExistingRows(height, blockHash, transactions);
    // Audit A2: replay gates the write. A block the reference would refuse must not be archived,
    // and that verdict comes from actually applying the transactions -- so this runs BEFORE
    // putBlockBundle, like every other refusal condition here.
    await this.replayBlockIfEnabled(
      height, blockHash, header, transactions, block.extrinsics, nodeProtocolVersion ?? 0,
    );
    // From here on, replay has ADVANCED in memory but nothing about this block is durable yet.
    // See `commitOrDiscardReplay` below for why every exit from this window must go through it.
    const replayAdvanced = this.replayValidation && this.replay !== undefined;

    const blockRecord: BlockRecord = {
      net: this.net,
      blockHash,
      height,
      parentHash: hexNoPrefix(header.parentHash),
      // Substrate genesis's parentHash is all-zero (32 zero bytes) -- 000...0 (32 bytes = 64
      // hex chars), which already satisfies the schema's `CHECK (octet_length(parent_hash)
      // = 32)`; no special-casing needed.
      stateRoot: hexNoPrefix(header.stateRoot),
      extrinsicsRoot: hexNoPrefix(header.extrinsicsRoot),
      headerBytes: headerBytes(header),
      bodyBytes: extrinsicsBytes(block.extrinsics),
      isCanonical: true,
      status: "canonical",
      finalized: true,
    };

    try {
      await this.store.putBlockBundle({
        block: blockRecord,
        transactions,
        bridgeObservations: bridge.records,
      });

      // After the write, because a checkpoint references the block it describes.
      await this.checkpointReplayIfDue(height, blockHash);

      // The watermark is the final durable step for this height and therefore belongs inside the
      // same replay-recovery boundary. A failure here leaves the block (and possibly checkpoint)
      // durable while the cursor stays behind; discarding the in-memory engine makes retry rebuild
      // from those durable records instead of trying to apply this height twice to stale state.
      await this.store.setWatermark(this.watermarkKey(), { height });
    } catch (err) {
      // T3. Replay is atomic INSIDE the engine but was not atomic across the ingest block: the
      // fold advanced above, and if any durable write here failed, the in-memory replay sat one
      // block ahead of everything persisted. The next attempt at this same height then hit the
      // consecutive-height guard -- "replay is at N but this block is N" -- and refused, forever,
      // because nothing ever moved the archive forward to match. A long-lived CLI wedged on that
      // height permanently, from a single transient write failure.
      //
      // Discarding the in-memory state converts that into a retry: the next attempt rebuilds from
      // the newest canonical checkpoint and catches up over the archived blocks, which is exactly
      // the cold-start path and is already exercised. Bounded by the checkpoint interval.
      if (replayAdvanced) this.discardReplayState();
      throw err;
    }

    // Only remember this block as the continuity anchor once it is durably written -- same
    // discipline as the D-parameter cursor below. Advancing it earlier would let a failed write
    // still satisfy the next block's parent check against a block that isn't in the archive.
    this.lastArchived = { height, blockHash };

    // Fix 2 (sprint-fix round, HIGH): only advance the in-memory D-parameter dedup cursor AFTER
    // the durable write above has succeeded -- see `buildBridgeObservationRecords`'s own doc for
    // why updating it any earlier silently drops observations on retry.
    if (bridge.newDParameterJson !== undefined) {
      this.lastDParameterJson = bridge.newDParameterJson;
    }
  }

  /**
   * Sprint 9 oracle cross-check: with the indexer still configured, every block's node-derived
   * view must agree with the indexer's before anything is written. Two comparisons, neither
   * needing the ledger WASM:
   *
   *   1. The SEQUENCE of regular-transaction raw payloads must be byte-identical, element for
   *      element -- the node's extrinsic-envelope decode against the indexer's `Transaction.raw`.
   *      (Byte equality subsumes hash equality: the tx hash is a pure function of these bytes,
   *      proven by `test/integration/chain-archive-replay-decode.integration.test.ts`.) System
   *      transactions are deliberately outside this check: runtime-generated ones exist only on
   *      the indexer side (event-borne), so the two sides' system-tx sets differ by design.
   *   2. Every indexer-reported per-tx `protocolVersion` must equal the header's MNSV digest
   *      value -- and that digest must exist at all.
   *
   * Throwing here (before any store write) makes every synced block a continuous Run-B-style
   * differential check for free, for as long as the indexer exists to compare against.
   */
  private oracleCrossCheck(
    height: number,
    nodePayloads: readonly { kind: "regular" | "system"; payload: Uint8Array }[],
    nodeProtocolVersion: number | undefined,
    indexerBlock: IndexerBlock,
  ): void {
    if (nodeProtocolVersion === undefined) {
      throw new Error(`oracle cross-check: no MNSV protocol-version digest at height ${height}`);
    }
    const nodeRegular = nodePayloads
      .filter((p) => p.kind === "regular")
      .map((p) => Buffer.from(p.payload).toString("hex"));
    const indexerRegular = indexerBlock.transactions
      .map((t) => hexNoPrefix(t.raw))
      .filter((raw) => !Buffer.from(raw, "hex")
        .subarray(0, SYSTEM_TX_TAG.length).toString("utf8").startsWith(SYSTEM_TX_TAG));
    if (nodeRegular.length !== indexerRegular.length) {
      throw new Error(
        `oracle cross-check FAILED at height ${height}: node-derived regular tx count ` +
          `${nodeRegular.length} != indexer's ${indexerRegular.length}`,
      );
    }
    for (let i = 0; i < nodeRegular.length; i++) {
      if (nodeRegular[i] !== indexerRegular[i]) {
        throw new Error(
          `oracle cross-check FAILED at height ${height}, regular tx ${i}: node-derived payload ` +
            `bytes differ from indexer raw (${nodeRegular[i]!.length / 2} vs ` +
            `${indexerRegular[i]!.length / 2} bytes)`,
        );
      }
    }
    for (const t of indexerBlock.transactions) {
      if (t.protocolVersion !== nodeProtocolVersion) {
        throw new Error(
          `oracle cross-check FAILED at height ${height}: indexer protocolVersion ` +
            `${t.protocolVersion} != MNSV digest ${nodeProtocolVersion} (tx ${hexNoPrefix(t.hash)})`,
        );
      }
    }
  }

  /**
   * Sprint 9 node-only transaction records. Scope: REGULAR transactions only (see
   * `ChainArchiveSyncServiceOptions.indexer`'s mode table for why system payloads are excluded
   * -- no WASM hash accessor for the `tx_hash` PK, and runtime-generated ones aren't in the
   * block body at all). `position` therefore numbers the REGULAR transactions of the block
   * 0..n-1; in blocks that also carry system transactions the indexer-sourced ingest assigns
   * different absolute positions, so cross-mode comparison joins on `tx_hash`, never on
   * `position` (recorded in the Run-B differ's own docs).
   *
   * `tx_hash` is the ledger's own transaction hash, recomputed locally from the payload bytes
   * via the WASM `Transaction.transactionHash()` -- the SAME method (and therefore the same
   * value) the indexer's `hash` field comes from
   * (`chain-indexer/src/infra/subxt_node.rs:675`, `make_regular_transaction`).
   */
  /**
   * Build a block's transaction records from the node alone, using the block's own runtime
   * metadata. This is the Stage-2 path that replaces three refusals with actual ingest.
   *
   * WHAT CHANGES relative to the pinned-constant path it supersedes:
   *
   *   - every extrinsic FRAMING is decodable, so a signed Midnight call is archived rather than
   *     refused (§5.2). `send_mn_transaction` ignores its origin, so such a transaction is valid
   *     and the reference archives it;
   *   - runtime-GENERATED system transactions are recovered from `SystemTransactionApplied`
   *     events, which is the only place they exist (§5.1);
   *   - classification uses the runtime's own pallet/call indices, so a renumbered runtime is
   *     followed rather than refused (§5.3).
   *
   * ORDERING. Event-borne system transactions are PREPENDED, before the extrinsic-derived list,
   * matching `midnight-indexer/chain-indexer/src/infra/subxt_node/runtimes/v1_0_0.rs:160-163`
   * exactly. Substrate applies inherents before regular transactions, so this is execution order,
   * and `position` is part of this archive's contract -- getting it wrong makes two archives that
   * hold the same transactions non-interchangeable for anything reading by position.
   *
   * HASHES come from different places by necessity, and that is not a shortcut: an event carries
   * the runtime's OWN authoritative hash alongside the payload, so event-borne transactions need
   * no ledger at all, while an extrinsic carries only bytes and must be hashed with the ledger.
   */
  /**
   * Apply this block through real ledger state, refusing what the reference would refuse.
   *
   * The reference does not merely extract transactions: it deserializes and applies each one, and
   * that outcome decides row-versus-refusal. Until this ran during ingest, the engine existed but
   * nothing consulted it, so an archive could contain blocks the reference would have aborted on
   * (audit A2).
   *
   * RESUME, not restart-from-genesis. Replay state is built from the newest checkpoint at or below
   * the last archived height; only if there is none does it start blank at genesis. A checkpoint
   * written by a different ledger build is refused rather than resumed -- serialized state is a
   * ledger-internal encoding, and a mis-resumed state yields wrong outcomes instead of an error.
   *
   * GAPS ARE FATAL. Replay is a fold over consecutive blocks, so applying block N+2 to a state
   * that stopped at N silently computes against the wrong state. If the block being ingested is
   * not the immediate successor of what replay last applied, this refuses.
   */
  private async replayBlockIfEnabled(
    height: number,
    blockHash: Hex32,
    header: SubstrateHeader,
    transactions: readonly TransactionRecord[],
    extrinsics: readonly string[],
    protocolVersion: number,
  ): Promise<void> {
    if (!this.replayValidation) return;
    const ledger = await this.ledger();

    if (this.replay === undefined) {
      const resumeFrom = height > 0
        ? await this.store.getLatestReplayCheckpoint(this.net, height - 1)
        : undefined;
      // Audit round 3: sparse checkpoints and a per-block watermark are not aligned. Crash at 1500
      // with a 1000-block interval and the archive resumes ingest at 1501 while the newest
      // checkpoint is 1000 -- a 500-block hole that the gap check below would (correctly) refuse,
      // making replay unusable with any interval above 1. Requiring interval 1 would defeat sparse
      // checkpointing, whose whole justification is that ledger state is unbounded.
      //
      // The blocks in that hole are already archived, so replay CATCHES UP over them rather than
      // failing: their transactions are read back from the archive in position order, and their
      // timestamps re-decoded from the node. Catch-up is bounded by the checkpoint interval and
      // happens once per process start.
      this.replayCatchUpFrom = resumeFrom === undefined ? undefined : resumeFrom.blockHeight;
      if (resumeFrom !== undefined) {
        if (resumeFrom.ledgerVersion !== LEDGER_STATE_VERSION) {
          throw new Error(
            `replay checkpoint at height ${resumeFrom.blockHeight} was written by ledger build ` +
              `"${resumeFrom.ledgerVersion}" but this process uses "${LEDGER_STATE_VERSION}". ` +
              "Serialized ledger state is a ledger-internal encoding, so resuming it under a " +
              "different build would compute against a state this ledger may not read the same " +
              "way. Re-run replay from genesis into a fresh schema, or use the matching build.",
          );
        }
        // T2: the ledger BUILD matching is not enough. Every checkpoint written for any network
        // carries the same `ledger_version` marker, so the check above cannot tell a wrong-network
        // checkpoint from a right one -- and the network embedded in the serialized state was
        // being trusted implicitly while the configured `ledgerNetworkId` was ignored entirely.
        // Resuming across networks folds this chain's blocks onto another chain's state.
        if (resumeFrom.ledgerNetworkId !== this.ledgerNetworkId) {
          throw new Error(
            `replay checkpoint at height ${resumeFrom.blockHeight} was written for ledger network ` +
              `"${resumeFrom.ledgerNetworkId}" but this process is configured for ` +
              `"${this.ledgerNetworkId}". Ledger state is network-specific -- resuming across ` +
              "networks would fold this chain's blocks onto another chain's state, which produces " +
              "wrong outcomes rather than an error. Re-run replay from genesis into a fresh " +
              "schema, or correct LEDGER_NETWORK_ID.",
          );
        }
        this.replay = LedgerReplay.fromSerialized(ledger, resumeFrom.stateBytes);
        this.replayHeight = resumeFrom.blockHeight;
        this.lastReplayedBlockHash = resumeFrom.blockHash;
        // The checkpointed block's own time becomes the parent time for the block after it (T1).
        // Without this the first block of every resumed run was folded with lastBlockTime=0 --
        // invisible in a single-run test, and wrong on every restart.
        this.lastReplayedBlockTimestampMs = resumeFrom.blockTimestampMs;
      } else {
        if (height !== 0) {
          throw new Error(
            `replay validation was asked to start at height ${height} with no checkpoint at or ` +
              "below it. Ledger state is a fold from genesis -- starting mid-chain would apply " +
              "this block to a blank state and compute against the wrong one. Sync this net from " +
              "genesis with replay enabled, or provide a checkpoint.",
          );
        }
        this.replay = LedgerReplay.fromGenesis(ledger, this.ledgerNetworkId!);
        this.replayHeight = undefined;
        this.lastReplayedBlockHash = undefined;
      }
    }

    if (this.replayCatchUpFrom !== undefined) {
      const from = this.replayCatchUpFrom;
      this.replayCatchUpFrom = undefined;
      try {
        for (let h = from + 1; h < height; h++) {
          await this.replayArchivedBlock(h);
        }
      } catch (err) {
        // T5's second half. `replayCatchUpFrom` is cleared before the loop, so a failure partway
        // through used to leave the engine advanced to some intermediate height with catch-up
        // already marked done -- the next attempt skipped catch-up entirely and refused on the
        // height gap, permanently. Discarding makes the retry start over from the checkpoint.
        this.discardReplayState();
        throw err;
      }
    }

    const expected = this.replayHeight === undefined ? 0 : this.replayHeight + 1;
    if (height !== expected) {
      throw new Error(
        `replay validation is at height ${this.replayHeight ?? "genesis"} but this block is ` +
          `${height}; expected ${expected}. Replay is a fold over consecutive blocks, so applying ` +
          "out of order would compute against a state that never existed. Refusing.",
      );
    }

    // The block's OWN time, decoded from its Timestamp::set inherent. Replay is time-dependent at
    // three points (wellFormed, apply, postBlockUpdate), and an earlier revision of this method
    // read a field that was never assigned -- so every block replayed at time 0.
    //
    // GENESIS IS NOT EXEMPT (T1). This used to skip the check for height 0, on the belief that
    // genesis has no time. That is wrong for the target node: 1.0 always emits `Timestamp::set`
    // in genesis, and the committed devnet genesis decodes to 1754395200000 ms. The belief
    // survived because the SYNTHETIC test fixtures omitted the inherent while the real chain
    // includes it -- so the fixtures agreed with the bug. Exempting genesis means replaying the
    // one block that seeds every later state at time 0, roughly 55 years early.
    const resolved = await this.metadata.forBlock(`0x${blockHash}`, protocolVersion);
    const blockTimestampMs = decodeBlockTimestampMs(resolved, extrinsics);
    if (blockTimestampMs === undefined) {
      throw new Error(
        `height ${height}: no Timestamp::set inherent, so this block's time is unknown. Ledger ` +
          "replay is time-dependent, and substituting zero would silently produce a different " +
          "fold. Refusing rather than guessing. This applies to genesis too: the target node " +
          "emits Timestamp::set in genesis, so its absence there is a decode failure, not a " +
          "property of genesis.",
      );
    }

    // Throws ReplayRefusalError where the reference aborts -- and this is before any write, so a
    // refused block leaves nothing behind, same as every other refusal condition.
    this.replay.applyBlock({
      transactions: transactions.map((t) => ({
        kind: t.kind === "system" ? "system" : "regular",
        rawBytes: t.rawBytes,
      })),
      blockTimestampMs,
      parentBlockHashHex: hexNoPrefix(header.parentHash),
      parentBlockTimestampMs: this.parentTimestampFor(height),
    });
    this.replayHeight = height;
    this.lastReplayedBlockHash = blockHash;
    this.lastReplayedBlockTimestampMs = blockTimestampMs;
  }

  /**
   * Throw away the in-memory replay engine so the next attempt rebuilds it from storage.
   *
   * The recovery move for every case where in-memory replay progress has run ahead of what is
   * durable (T3) or stopped partway through catch-up (T5). Nothing is lost: the engine's entire
   * content is reconstructible from the newest canonical checkpoint plus the archived blocks
   * above it, which is precisely what a cold start already does.
   *
   * All five fields must go together. Leaving any one behind is what made these bugs permanent
   * rather than transient -- a stale `replayHeight` alone is enough to wedge the height guard.
   */
  private discardReplayState(): void {
    this.replay = undefined;
    this.replayHeight = undefined;
    this.replayCatchUpFrom = undefined;
    this.lastReplayedBlockHash = undefined;
    this.lastReplayedBlockTimestampMs = undefined;
  }

  /**
   * The `lastBlockTime` to replay `height` under: the timestamp of the block replay applied
   * immediately before it.
   *
   * Genesis is the one block with no parent, so zero there is the absence of a parent rather than
   * a guess about one. At any other height an unknown parent time is a bug -- it means either a
   * resume that did not restore it (checkpoints now carry it) or a gap in the fold -- and
   * substituting zero would move the parent 55 years into the past while still "working".
   */
  private parentTimestampFor(height: number): number {
    if (height === 0) return 0;
    if (this.lastReplayedBlockTimestampMs === undefined) {
      throw new Error(
        `height ${height}: replay has no timestamp for the parent block. Replay is time-dependent ` +
          "-- `lastBlockTime` feeds the ledger's own validity rules -- and substituting zero " +
          "would silently fold this block against a parent dated 1970. Refusing rather than " +
          "guessing.",
      );
    }
    return this.lastReplayedBlockTimestampMs;
  }

  /**
   * Re-apply one ALREADY-ARCHIVED block to replay state, to close a checkpoint/watermark gap.
   *
   * Reads the transactions back from the archive in position order -- so the fold sees exactly what
   * was stored, not a fresh decode that might differ -- and re-decodes the block's timestamp from
   * the node, since the archive does not store it. A refusal here is a genuine finding: it means
   * the archived block does not replay, which is precisely the inconsistency this validation
   * exists to surface.
   */
  private async replayArchivedBlock(height: number): Promise<void> {
    const block = await this.store.getCanonicalBlockAtHeight(this.net, height);
    if (block === undefined) {
      throw new Error(
        `replay catch-up: height ${height} lies between the last checkpoint and the resume point, ` +
          "but no canonical block is archived there. The archive has a hole, so replay cannot " +
          "reconstruct the state the next block must be applied to.",
      );
    }
    const replayedParent = this.lastReplayedBlockHash;
    if (replayedParent === undefined) {
      throw new Error(
        `replay catch-up at height ${height} has no hash for the block just replayed. ` +
          "Without that ancestry anchor, independently canonical rows could be spliced across " +
          "forks. Refusing.",
      );
    }
    if (block.parentHash !== replayedParent) {
      throw new Error(
        `replay catch-up ancestry mismatch at height ${height}: canonical block ` +
          `${block.blockHash} names parent ${block.parentHash}, but the block just replayed was ` +
          `${replayedParent}. Refusing to splice disconnected canonical rows.`,
      );
    }
    const stored = await this.store.getTransactionsForBlock(this.net, block.blockHash);
    const ordered = [...stored].sort((a, b) => a.position - b.position);
    const withBytes = await Promise.all(
      ordered.map(async (t) => ({
        kind: t.kind === "system" ? ("system" as const) : ("regular" as const),
        rawBytes: await this.store.getBlob(t.rawBlobHash),
      })),
    );

    const { block: nodeBlock } = await this.node.getBlock(`0x${block.blockHash}`);
    const resolved = await this.metadata.forBlock(`0x${block.blockHash}`);
    const ts = decodeBlockTimestampMs(resolved, nodeBlock.extrinsics);
    // The same refusal as the ingest path (T1). Catch-up used to substitute zero here -- the exact
    // guess the ingest path refuses to make -- so a block whose timestamp failed to decode was
    // folded at 1970 instead of failing, and only on the restart path, where nothing looks.
    if (ts === undefined) {
      throw new Error(
        `replay catch-up at height ${height}: no Timestamp::set inherent, so this block's time is ` +
          "unknown. Ledger replay is time-dependent and substituting zero would silently produce " +
          "a different fold than the ingest path would have. Refusing rather than guessing.",
      );
    }

    this.replay!.applyBlock({
      transactions: withBytes,
      blockTimestampMs: ts,
      parentBlockHashHex: hexNoPrefix(nodeBlock.header.parentHash),
      parentBlockTimestampMs: this.parentTimestampFor(height),
    });
    this.replayHeight = height;
    this.lastReplayedBlockHash = block.blockHash;
    this.lastReplayedBlockTimestampMs = ts;
  }

  /**
   * Persist replay state, AFTER the block is durably written.
   *
   * Deliberately not part of the gating step above. `replay_checkpoints` has a foreign key to
   * `blocks` -- a checkpoint describes a block, so it must not outlive one -- and gating runs
   * before the block row exists. Writing the checkpoint there violates the FK, which is exactly
   * what the first run of this suite discovered. Splitting the two also gets the ordering right on
   * its own terms: a checkpoint may only record state for a block that was actually archived.
   */
  private async checkpointReplayIfDue(height: number, blockHash: Hex32): Promise<void> {
    if (!this.replayValidation || this.replay === undefined) return;
    if (height % this.replayCheckpointInterval !== 0) return;
    // Set by the replay of this very block, immediately before this runs.
    const blockTimestampMs = this.lastReplayedBlockTimestampMs;
    if (blockTimestampMs === undefined) {
      throw new Error(
        `refusing to checkpoint height ${height} with no recorded block timestamp: a checkpoint ` +
          "without one cannot supply `lastBlockTime` to the block that resumes after it.",
      );
    }
    await this.store.putReplayCheckpoint({
      net: this.net,
      blockHeight: height,
      blockHash,
      stateBytes: this.replay.serialize(),
      ledgerVersion: LEDGER_STATE_VERSION,
      blockTimestampMs,
      ledgerNetworkId: this.ledgerNetworkId!,
    });
  }

  /**
   * Refuse when this block is already archived with DIFFERENT contents (audit A4).
   *
   * Every terminal insert is `ON CONFLICT DO NOTHING`, which is exactly right for an idempotent
   * retry -- re-ingesting a byte-identical block must be a no-op. But it is silent about the case
   * that matters: a re-ingest producing DIFFERENT rows at the same keys. The new rows are
   * discarded, the run reports success, and the archive keeps contents that whatever produced them
   * now disagrees with. Nothing anywhere records that two answers existed.
   *
   * That is not hypothetical after this sprint. Blocks archived by the pre-metadata implementation
   * lack event-borne system transactions and number positions differently, so re-ingesting such a
   * range with the current code produces genuinely different rows -- which is precisely the
   * "history written by an older implementation" A4 asks to detect. Comparing what is there
   * against what we would write catches that without needing a version marker to be trusted: the
   * rows themselves are the evidence.
   *
   * Comparison is by `(position, tx_hash, kind)`, the fields that define the archive's contract.
   */
  private async assertNoConflictingExistingRows(
    height: number,
    blockHash: Hex32,
    incoming: readonly TransactionRecord[],
  ): Promise<void> {
    const existing = await this.store.getTransactionsForBlock(this.net, blockHash);
    if (existing.length === 0) return; // nothing archived here yet -- the ordinary path

    const shape = (rows: readonly { position: number; txHash: string; kind: string }[]) =>
      [...rows]
        .sort((a, b) => a.position - b.position)
        .map((r) => `${r.position}:${r.txHash.toLowerCase()}:${r.kind}`)
        .join(" ");
    const before = shape(existing);
    const after = shape(incoming);
    if (before === after) return; // a genuine idempotent retry

    throw new Error(
      `height ${height}: this block is already archived with different contents. Stored: ` +
        `[${before}]. Re-ingest would write: [${after}]. Inserts are ON CONFLICT DO NOTHING, so ` +
        "continuing would silently keep the stored rows and report success while the two versions " +
        "disagree. This is what an archive written by an older implementation looks like -- one " +
        "that predates event-borne system transactions or numbered positions differently. Re-sync " +
        "this net into a fresh schema rather than extending a history whose completeness cannot " +
        "be established.",
    );
  }

  private async buildNodeOnlyRecordsFromMetadata(
    height: number,
    blockHash: Hex32,
    extrinsics: readonly string[],
    protocolVersion: number,
  ): Promise<TransactionRecord[]> {
    this.currentIngestHeight = height;
    // The protocol version comes from the block HEADER, so it stays available even where the
    // historical state behind `state_getRuntimeVersion` has been pruned -- which is precisely when
    // the committed capture registry is the only remaining source.
    const resolved = await this.metadata.forBlock(`0x${blockHash}`, protocolVersion);
    this.assertPinnedIndicesAgree(height, protocolVersion, resolved);
    const { callIndices } = resolved;

    // ── event-borne system transactions, which come FIRST ──
    const eventsRaw = await this.node.storageAt(
      ChainArchiveSyncService.SYSTEM_EVENTS_KEY, `0x${blockHash}`,
    );
    const eventBorne = eventsRaw === undefined
      ? []
      : decodeEventSystemTransactions(resolved, hexToBytes(eventsRaw));

    const records: TransactionRecord[] = [];
    let position = 0;
    const ledgerForEvents = eventBorne.length > 0 ? await this.ledger() : undefined;
    for (const ev of eventBorne) {
      // Audit A1. The event states a hash AND carries the bytes; those are two claims that can
      // disagree, and an archive keyed by the wrong hash is wrong in the one field everything else
      // joins on. `SystemTransaction.transactionHash()` -- the export vendored precisely so this is
      // possible -- recomputes it from the bytes we are about to store, so what we key on is
      // derived from what we archive rather than asserted alongside it.
      const decoded = decodeArchivedTransaction(ledgerForEvents, ev.payload);
      if (decoded.kind !== "system") {
        throw new Error(
          `height ${height}: a SystemTransactionApplied event carried a payload that is not a ` +
            `system transaction (decoded as ${decoded.kind}). Refusing rather than archiving it ` +
            "under a kind the bytes contradict.",
        );
      }
      if (decoded.transactionHash === undefined) {
        throw new Error(
          `height ${height}: cannot recompute the hash of an event-borne system transaction -- ` +
            "this ledger build exposes no SystemTransaction.transactionHash(). Refusing rather " +
            "than trusting the hash the event claims, which nothing here can check.",
        );
      }
      const recomputed = hexNoPrefix(decoded.transactionHash).toLowerCase();
      const claimed = hexNoPrefix(ev.txHash).toLowerCase();
      if (recomputed !== claimed) {
        throw new Error(
          `height ${height}: a SystemTransactionApplied event claims hash ${claimed}, but the ` +
            `payload it carries hashes to ${recomputed}. The event's two halves disagree, so one ` +
            "of them is not what the runtime applied. Refusing rather than choosing.",
        );
      }
      records.push({
        net: this.net,
        txHash: recomputed,
        blockHeight: height,
        blockHash,
        position: position++,
        kind: "system",
        protocolVersion,
        rawBytes: ev.payload,
      });
    }

    // ── extrinsic-derived transactions, in extrinsic order, after the event-borne ones ──
    const ledger = await this.ledger();
    for (const e of extrinsics) {
      // Throws on anything undecodable rather than skipping: "not a Midnight call" and "could not
      // be read" must not collapse into one outcome, or corruption reads as absence.
      const call = decodeExtrinsicWithMetadata(resolved, e);
      const isRegular =
        call.palletIndex === callIndices.midnightPallet &&
        call.callIndex === callIndices.sendTransactionCall;
      const isSystem =
        call.palletIndex === callIndices.midnightSystemPallet &&
        call.callIndex === callIndices.sendSystemTransactionCall;
      if (!isRegular && !isSystem) continue;
      if (call.payload === undefined) {
        throw new Error(
          `height ${height}: a Midnight call carried no payload argument. Refusing rather than ` +
            "archiving a transaction with no bytes.",
        );
      }

      const decoded = decodeArchivedTransaction(ledger, call.payload);
      if (decoded.transactionHash === undefined) {
        throw new Error(
          `height ${height}: an extrinsic-borne ${isSystem ? "system " : ""}transaction did not ` +
            "decode to a hash. Refusing to archive the block incomplete. For system transactions " +
            "this usually means the ledger build exposes no SystemTransaction.transactionHash().",
        );
      }
      // Audit A1. `kind` was taken from the dispatched CALL alone, so a payload reaching the wrong
      // call -- `send_mn_transaction` carrying system-tagged bytes, or the reverse -- would be
      // archived under a kind its own bytes contradict, and every consumer filtering on `kind`
      // would then read it as something it is not. The reference derives type from the payload it
      // deserializes, so the two sources must agree here or the block is refused; ingest must not
      // pick a winner between the runtime's dispatch and the transaction's own self-description.
      const payloadKind = decoded.kind === "system" ? "system" : "regular";
      const callKind = isSystem ? "system" : "regular";
      if (payloadKind !== callKind) {
        throw new Error(
          `height ${height}: an extrinsic dispatched to the ${callKind} Midnight call carries a ` +
            `payload that decodes as a ${payloadKind} transaction. Call and payload disagree ` +
            "about what this transaction is, so archiving it would record a kind its own bytes " +
            "contradict. Refusing.",
        );
      }
      records.push({
        net: this.net,
        txHash: hexNoPrefix(decoded.transactionHash).toLowerCase(),
        blockHeight: height,
        blockHash,
        position: position++,
        kind: payloadKind,
        protocolVersion,
        rawBytes: call.payload,
      });
    }
    return records;
  }

  /**
   * Cross-check the runtime's own indices against the pinned table, where the table has an entry.
   *
   * The pinned constants are no longer authoritative -- metadata is -- but they were verified by
   * live observation, so a disagreement means one of two independent sources is wrong about how to
   * classify a Midnight transaction. Refusing is the only safe response: classifying wrongly makes
   * genuine transactions vanish, and `ON CONFLICT DO NOTHING` makes that permanent.
   *
   * Silent where the table has no entry (0.22.x deliberately has none): metadata is sufficient on
   * its own, which is exactly why it replaces the table rather than supplementing it.
   */
  private assertPinnedIndicesAgree(
    height: number,
    protocolVersion: number,
    resolved: ResolvedRuntimeMetadata,
  ): void {
    const pinned = callIndicesForProtocolVersion(protocolVersion);
    if (pinned === undefined) return;
    const m = resolved.callIndices;
    const same =
      pinned.midnightPallet === m.midnightPallet &&
      pinned.midnightSystemPallet === m.midnightSystemPallet &&
      pinned.sendTransactionCall === m.sendTransactionCall &&
      pinned.sendSystemTransactionCall === m.sendSystemTransactionCall;
    if (!same) {
      throw new Error(
        `height ${height}: this block's runtime metadata reports call indices ` +
          `${JSON.stringify(m)} but the pinned table for protocol ${protocolVersion} says ` +
          `${JSON.stringify(pinned)}. Two independent sources disagree about how to classify a ` +
          "Midnight transaction, so one of them would make genuine transactions vanish. Refusing.",
      );
    }
  }

  private async buildNodeOnlyTransactionRecords(
    height: number,
    blockHash: Hex32,
    nodePayloads: readonly { kind: "regular" | "system"; payload: Uint8Array }[],
    protocolVersion: number,
  ): Promise<TransactionRecord[]> {
    const ledger = await this.ledger();
    const records: TransactionRecord[] = [];
    let position = 0;
    for (const p of nodePayloads) {
      // Bytes reaching here have already passed the node's own validation, so a decode failure is
      // a real defect -- a version mismatch, or a bug here -- not hostile input. Fail loud: an
      // earlier revision skipped and advanced the watermark, which wrote a permanently incomplete
      // block and recorded nothing about it.
      const decoded = decodeArchivedTransaction(ledger, p.payload);

      if (p.kind === "system") {
        // System transactions are archived only when their AUTHORITATIVE hash is available.
        // `SystemTransaction.transactionHash()` exists on the Rust ledger and is what the
        // reference indexer keys them by, but the published wasm-bindgen wrapper does not export
        // it (see MIDNIGHT_LEDGER_WASM in tx-replay-decoder.ts). Without it the row cannot be
        // written under the key every other consumer uses.
        //
        // Refuse rather than omit. Every terminal insert is `ON CONFLICT DO NOTHING`, so an
        // archive written without these could not be repaired by re-ingesting later -- the rows
        // already present would be skipped and corrected positions would collide. An incomplete
        // archive that looks complete is the worse failure.
        if (decoded.transactionHash === undefined) {
          throw new Error(
            `height ${height}: node-only ingest found a system transaction but this ledger build ` +
              "exposes no SystemTransaction.transactionHash(), so it cannot be archived under its " +
              "real key. Refusing rather than writing an archive that silently omits it and cannot " +
              "be repaired in place. Set MIDNIGHT_LEDGER_WASM to a build carrying that export, or " +
              "use indexer-sourced ingest for this range.",
          );
        }
      } else if (decoded.transactionHash === undefined) {
        throw new Error(
          `node-only ingest at height ${height}: a payload dispatched to the Midnight transaction ` +
            "call did not decode to a transaction hash. Refusing to archive the block incomplete.",
        );
      }

      // ONE counter across both kinds, advancing in extrinsic order. The indexer numbers a
      // block's transactions across its whole list, so genesis -- whose system transactions are
      // extrinsic-borne and whose blocks carry no events -- yields exactly the same positions
      // this produces. Numbering only regular transactions, as an earlier revision did, made the
      // two modes disagree on `position` for every block containing a system transaction.
      records.push({
        net: this.net,
        txHash: hexNoPrefix(decoded.transactionHash!).toLowerCase(),
        blockHeight: height,
        blockHash,
        position: position++,
        kind: p.kind,
        protocolVersion,
        rawBytes: p.payload,
      });
    }
    return records;
  }

  /** SCALE-decodes `SystemParametersApi_get_d_parameter` at `blockHash`:
   *  `DParameter { num_permissioned_candidates: u16, num_registered_candidates: u16 }`
   *  (`midnight-node/partner-chains/toolkit/sidechain/domain/src/lib.rs:1165`), two
   *  little-endian u16s. Verified live against this devnet: node bytes `0x0a000000` == the
   *  indexer-reported `{"numPermissionedCandidates":10,"numRegisteredCandidates":0}`. */
  private async fetchDParameterFromNode(
    blockHash: Hex32,
  ): Promise<{ numPermissionedCandidates: number; numRegisteredCandidates: number }> {
    const resultHex = hexNoPrefix(
      await this.node.stateCall("SystemParametersApi_get_d_parameter", "0x", `0x${blockHash}`),
    );
    const bytes = Buffer.from(resultHex, "hex");
    if (bytes.length < 4) {
      throw new Error(
        `SystemParametersApi_get_d_parameter returned ${bytes.length} bytes (need >= 4): 0x${resultHex}`,
      );
    }
    return {
      numPermissionedCandidates: bytes.readUInt16LE(0),
      numRegisteredCandidates: bytes.readUInt16LE(2),
    };
  }

  /**
   * Transaction metadata + raw bytes come from the INDEXER (`Transaction.hash`/`raw`), not
   * recomputed by this service -- Substrate's real extrinsic-hash algorithm (blake2b-256 over
   * the encoded extrinsic) has no implementation in Node's built-in `node:crypto`, and the
   * indexer already computes and serves it authoritatively.
   *
   * **Two judgment calls, both discovered empirically against the real devnet, neither assumed
   * in advance:**
   *
   * 1. The node's `chain_getBlock` `extrinsics` count is NOT always equal to the indexer's
   *    per-block `transactions` count for the SAME block -- confirmed live on genesis (height
   *    0): the node reports 28 raw extrinsics, the indexer reports 26 transactions. The two
   *    extra node-side extrinsics are Substrate-framework-level (an inherent such as
   *    `Timestamp::set`, and/or a consensus-related extrinsic) that never get wrapped as a
   *    `pallet_midnight` ledger transaction at all -- the indexer's `Transaction` entity is
   *    specifically scoped to `pallet_midnight`'s own transactions, not literally every SCALE
   *    extrinsic in the block body.
   * 2. A node extrinsic's raw bytes are NOT byte-equal to the indexer's `Transaction.raw` for
   *    the same logical transaction, even when one genuinely corresponds to the other --
   *    confirmed live on genesis tx 0: the indexer reports `raw = "6d69646e...4a7e8d03"` (42
   *    bytes, begins with the ASCII `midnight:system-transaction[v6]:` tag per §3.2 of
   *    `design/full-chain-storage-design.md`), while the node's corresponding extrinsic is
   *    `0xb4050600a4` + THAT SAME 42-byte string (47 bytes) -- the extra 5-byte prefix is the
   *    outer Substrate extrinsic envelope (length/version/call-index framing around
   *    `pallet_midnight::send_mn_transaction`'s own `Vec<u8>` argument), which the node's RPC
   *    layer does not strip but the indexer's `raw` field already does (it stores the INNER
   *    opaque payload, not the outer extrinsic). Confirmed by direct byte inspection, not
   *    inferred: the indexer's reported bytes are an exact SUFFIX of the corresponding node
   *    extrinsic's bytes, not an equal string.
   *
   * Both findings are why this cross-check is CONTAINS (`node extrinsic bytes include indexer's
   * reported raw bytes as a substring`), not an exact-match membership or positional check: this
   * is the correct, real relationship between the two data sources, not a loosened check for its
   * own sake. It still proves the property this cross-check exists to establish -- the indexer's
   * reported bytes genuinely originate from this block's real body, not a stale/wrong value --
   * without requiring the two lists to be the same length, in the same order, or byte-identical
   * at the outer-envelope level. `position` is taken from the INDEXER's own transaction ordering
   * (stable, and what a `tx_hash`-based lookup actually needs to disambiguate multiple
   * transactions in one block), not the node's raw extrinsic index.
   */
  private buildTransactionRecords(
    height: number, blockHash: Hex32, nodeExtrinsics: string[], indexerBlock: IndexerBlock,
  ): TransactionRecord[] {
    if (hexNoPrefix(indexerBlock.hash) !== blockHash) {
      throw new Error(
        `indexer/node block-hash mismatch at height ${height}: node=${blockHash} indexer=${hexNoPrefix(indexerBlock.hash)}`,
      );
    }

    const nodeExtrinsicHexes = nodeExtrinsics.map(hexNoPrefix);

    return indexerBlock.transactions.map((tx, position) => {
      const rawHex = hexNoPrefix(tx.raw);
      const rawBytes = Buffer.from(rawHex, "hex");
      const decodedTag = rawBytes.subarray(0, SYSTEM_TX_TAG.length).toString("utf8");
      const kind: "regular" | "system" = decodedTag === SYSTEM_TX_TAG ? "system" : "regular";
      // The CONTAINS cross-check applies only to REGULAR (user-submitted) transactions, which are
      // carried as on-wire extrinsics in the node's block body. Runtime-generated SYSTEM
      // transactions (e.g. a block-reward `midnight:system-transaction[v6]`) are produced during
      // block execution and are NOT present in `chain_getBlock.extrinsics` -- confirmed live on
      // preprod block 1, where the indexer reports one system tx contained in none of the node's
      // extrinsics. Genesis is the exception: its system txs are seeded inline into the genesis
      // extrinsic and DO satisfy CONTAINS. For a runtime-generated system tx the indexer is the
      // sole authoritative source of its raw bytes, so requiring node-body containment there is
      // wrong -- it aborted a real sync from block 1 onward. Regular txs still MUST be contained.
      if (kind === "regular" && !nodeExtrinsicHexes.some((e) => e.includes(rawHex))) {
        throw new Error(
          `indexer-reported transaction raw bytes not found within any of the node's own extrinsics ` +
          `for height ${height} (hash ${hexNoPrefix(tx.hash)}): indexer bytes not present in node block body`,
        );
      }
      return {
        net: this.net,
        txHash: hexNoPrefix(tx.hash),
        blockHeight: height,
        blockHash,
        position,
        kind,
        protocolVersion: tx.protocolVersion,
        rawBytes,
      };
    });
  }

  /**
   * Bridge/governance observations (`bridge_observations`, §4.4 of the design) -- a genuine
   * first-pass build: one `system_parameters_d` observation per block whose D-parameter differs
   * from the previous block's (deduplicated via an in-memory-per-call comparison against the
   * PREVIOUS block's indexer-reported `dParameter`, not against every historical row -- a real
   * production pass would want a cheaper "did this change" check, out of scope here). Raw bytes
   * are a canonical JSON encoding of the reported `{numPermissionedCandidates,
   * numRegisteredCandidates}` pair -- there is no separate raw-inherent-bytes RPC surface exposed
   * by either the node or the indexer for this category (§3.7's own finding: this data lives in
   * Substrate inherents, in the block BODY, which this service does not separately decode), so
   * this is a metadata-level observation, not a literal on-chain-byte capture -- documented
   * honestly as a judgment call in the final report, not silently assumed equivalent to the
   * `tx_raw`/header/body blobs' stronger byte-fidelity guarantee.
   *
   * **Fix 2 (sprint-fix round, HIGH)**: this method does NOT mutate `this.lastDParameterJson`
   * itself anymore -- it only returns the candidate new value (`newDParameterJson`), which
   * `ingestOneBlock` applies to the field ONLY after `putBlockBundle`'s durable write has
   * resolved successfully. Previously, the cursor was set to the new value BEFORE the write was
   * confirmed durable; if that write then failed transiently and the same height was retried on
   * the same live service instance, the dedup check above would already see the cursor as
   * "unchanged" and skip re-inserting the observation on retry -- silently dropping it forever,
   * with no error and no log line. Returning `undefined` for `newDParameterJson` when the value
   * is unchanged (the normal dedup-skip case) means the caller correctly leaves the cursor alone
   * either way -- there is nothing new to remember, and the previously-stored value is already
   * correct.
   */
  private buildBridgeObservationRecords(
    height: number, blockHash: Hex32,
    d: { numPermissionedCandidates: number; numRegisteredCandidates: number },
  ): { records: BridgeObservationRecord[]; newDParameterJson: string | undefined } {
    // Sprint 9: `d` is source-agnostic -- the indexer's reported `systemParameters.dParameter`
    // in indexer mode, or `fetchDParameterFromNode`'s SCALE decode in node-only mode (verified
    // live to produce identical values, so the dedupe cursor and the stored JSON bytes are
    // mode-independent).
    const json = JSON.stringify({
      numPermissionedCandidates: d.numPermissionedCandidates,
      numRegisteredCandidates: d.numRegisteredCandidates,
    });
    if (json === this.lastDParameterJson) {
      return { records: [], newDParameterJson: undefined }; // unchanged since the last block -- skip
    }
    const raw = new TextEncoder().encode(json);
    return {
      records: [{
        net: this.net,
        blockHeight: height,
        blockHash,
        observationIndex: 0,
        kind: "system_parameters_d",
        rawBytes: raw,
      }],
      newDParameterJson: json,
    };
  }
}

export { hexNoPrefix, headerBytes, extrinsicsBytes };
