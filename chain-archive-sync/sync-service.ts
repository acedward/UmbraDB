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
  decodeMidnightExtrinsic,
  decodeProtocolVersionFromDigest,
  requireCallIndices,
} from "./extrinsic-decoder.js";
import { decodeArchivedTransaction, loadLedgerV8 } from "./tx-replay-decoder.js";

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
}

export interface SyncOnceResult {
  ingestedBlocks: number;
  fromHeight: number | undefined;
  toHeight: number | undefined;
  targetTipHeight: number;
  /** Node-only mode: payloads that carried a `midnight:` self-tag but did not deserialize as a
   *  Midnight transaction, and were therefore skipped rather than archived (see
   *  `buildNodeOnlyTransactionRecords`). Normally 0. A non-zero value means someone is putting
   *  midnight-tagged bytes into non-Midnight calls -- worth looking at, not worth halting for. */
  skippedUndecodablePayloads: number;
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
  private readonly net: string;
  /** Last-seen D-parameter, in-memory, this instance's lifetime only -- used to dedupe
   *  `bridge_observations` inserts (§"stub/initial pass") so a healthy chain with an unchanging
   *  D-parameter doesn't get one near-duplicate row per block. Deliberately not persisted: a
   *  fresh service instance re-inserting one observation on its first synced block after a
   *  restart is a correct, harmless re-observation, not a bug (`bridge_observations` has no
   *  uniqueness constraint on content, only on `(net, block_height, block_hash,
   *  observation_index)`, so this can never produce a duplicate-key error either way). */
  private lastDParameterJson: string | undefined;

  constructor(opts: ChainArchiveSyncServiceOptions) {
    this.store = new PgChainArchiveStore(opts.sql, opts.schema ?? "chain_archive");
    this.node = new NodeRpcClient(opts.node);
    this.indexer = opts.indexer === undefined ? undefined : new IndexerClient(opts.indexer);
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
  private async assertChainIdentity(): Promise<void> {
    const genesisHash = hexNoPrefix(await this.node.getBlockHash(0));
    const key = `chain_identity:${this.net}`;
    const stored = (await this.store.getWatermark(key)) as { genesisHash?: string } | undefined;
    if (stored?.genesisHash === undefined) {
      await this.store.setWatermark(key, { genesisHash });
      return;
    }
    if (stored.genesisHash !== genesisHash) {
      throw new Error(
        `chain identity mismatch for net=${this.net}: this archive was built from genesis ` +
          `${stored.genesisHash}, but the configured node serves genesis ${genesisHash}. Refusing ` +
          "to splice a different chain into an existing archive -- use a different NET, or point " +
          "at the original chain.",
      );
    }
  }

  async syncOnce(opts?: { maxBlocks?: number }): Promise<SyncOnceResult> {
    const maxBlocks = opts?.maxBlocks ?? 100;
    this.skippedUndecodablePayloads = 0;
    await this.assertChainIdentity();
    const finalizedHash = await this.node.getFinalizedHead();
    const targetTipHeight = await this.node.getHeightOf(finalizedHash);

    const synced = await this.getSyncedHeight();
    const startHeight = synced === undefined ? 0 : synced + 1;
    if (startHeight > targetTipHeight) {
      return {
        ingestedBlocks: 0, fromHeight: undefined, toHeight: undefined, targetTipHeight,
        skippedUndecodablePayloads: this.skippedUndecodablePayloads,
      };
    }
    const endHeight = Math.min(targetTipHeight, startHeight + maxBlocks - 1);

    let ingested = 0;
    for (let height = startHeight; height <= endHeight; height++) {
      await this.ingestOneBlock(height);
      await this.store.setWatermark(this.watermarkKey(), { height });
      ingested++;
    }
    return {
      ingestedBlocks: ingested, fromHeight: startHeight, toHeight: endHeight, targetTipHeight,
      skippedUndecodablePayloads: this.skippedUndecodablePayloads,
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
  private skippedUndecodablePayloads = 0;

  private async assertParentContinuity(height: number, header: SubstrateHeader): Promise<void> {
    if (height === 0) return; // genesis parent is all-zero by construction
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

  private async ingestOneBlock(height: number): Promise<void> {
    const blockHash = hexNoPrefix(await this.node.getBlockHash(height));
    const { block } = await this.node.getBlock(`0x${blockHash}`);
    const header = block.header;
    await this.assertParentContinuity(height, header);

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
    // Classification is driven by the runtime's own call numbering for this protocol version.
    // A supported ledger version with no verified index mapping halts here rather than guessing.
    const nodePayloads =
      nodeProtocolVersion === undefined
        ? []
        : block.extrinsics
            .map((e) => decodeMidnightExtrinsic(e, requireCallIndices(nodeProtocolVersion, height)))
            .filter((d): d is NonNullable<typeof d> => d !== null);

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
      this.oracleCrossCheck(height, nodePayloads, nodeProtocolVersion, indexerBlock);
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
      transactions = await this.buildNodeOnlyTransactionRecords(
        height, blockHash, nodePayloads, nodeProtocolVersion,
      );
      bridge = this.buildBridgeObservationRecords(
        height, blockHash, await this.fetchDParameterFromNode(blockHash),
      );
    }

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

    await this.store.putBlockBundle({
      block: blockRecord,
      transactions,
      bridgeObservations: bridge.records,
    });

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
      if (p.kind !== "regular") continue;
      // Audit finding (HIGH/DoS): the envelope decoder classifies by the payload's `midnight:`
      // self-tag, which any caller can forge -- a bare `System::remark(Vec<u8>)` whose bytes
      // merely START with that tag reaches here (proven with a PoC). Previously the ledger's
      // rejection of those bytes propagated out, aborting the block; because the watermark only
      // advances on success, ingest retried that height forever. Any user could permanently wedge
      // a node-only archive for the price of one remark.
      //
      // The ledger itself is the authoritative classifier: bytes that do not deserialize as a
      // Midnight transaction ARE NOT ONE, whoever framed them. So a decode failure means "not a
      // transaction, skip it", not "abort the chain". This is safe precisely because the
      // protocol-version gate above already rejected unsupported ledger versions -- a GENUINE
      // transaction failing to decode under a SUPPORTED version cannot silently reach this path.
      //
      // Skips are counted and surfaced on SyncOnceResult rather than swallowed, so a spike is
      // visible to operators instead of quietly shrinking the archive.
      //
      // This does not remove the need for exact runtime-metadata call matching (the real fix for
      // classification); it removes the denial of service that misclassification enabled.
      let decoded;
      try {
        decoded = decodeArchivedTransaction(ledger, p.payload);
      } catch {
        this.skippedUndecodablePayloads++;
        continue;
      }
      if (decoded.transactionHash === undefined) {
        // Not a standard transaction after all (e.g. a system-tagged payload): same reasoning.
        this.skippedUndecodablePayloads++;
        continue;
      }
      records.push({
        net: this.net,
        txHash: hexNoPrefix(decoded.transactionHash).toLowerCase(),
        blockHeight: height,
        blockHash,
        position: position++,
        kind: "regular",
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
