import { PgChainArchiveStore } from "../src/postgres/chain-archive-store.js";
import type { UmbraDBSql } from "../src/postgres/client.js";
import type {
  BlockRecord,
  BridgeObservationRecord,
  ChainArchiveStore,
  Hex32,
  TransactionRecord,
  TransactionResult,
  TransactionSegmentResult,
} from "../src/interfaces/chain-archive-store.js";
import {
  IndexerClient, type IndexerBlock, type IndexerClientOptions, type IndexerTransaction,
} from "./indexer-client.js";
import { NodeRpcClient, type NodeRpcClientOptions, type SubstrateHeader } from "./node-rpc-client.js";
import { type BackoffOptions, type RetryCounters, withRetry } from "./retry.js";

/**
 * The real ingestion/sync service that populates the `chain_archive` schema from a live Midnight
 * node (JSON-RPC, raw block bytes) and indexer (GraphQL, structured transaction metadata) --
 * `design/full-chain-storage-design.md`'s Tier-1.5 archive, made real per this implementation
 * sprint's task.
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

/**
 * Project 00026 (spec FR-002): the indexer's `TransactionResultStatus` mapped onto the archive's
 * `transactions.result` enum. `undefined` = the source reported no result (a `SystemTransaction`
 * or `BridgeClaimTransaction` has no `transactionResult` field); it stays NULL, never defaulted to
 * `success`, because a consumer that cannot tell "succeeded" from "unknown" would count parts the
 * ledger discarded. An unknown status is a hard error: a new enum member must stop the sync here
 * rather than silently disarm the per-segment logic downstream.
 */
export function mapTransactionResult(status: string | undefined): TransactionResult | undefined {
  switch (status) {
    case undefined: return undefined;
    case "SUCCESS": return "success";
    case "PARTIAL_SUCCESS": return "partial_success";
    case "FAILURE": return "failure";
    default:
      throw new Error(
        `unknown indexer TransactionResultStatus ${JSON.stringify(status)} -- the archive has no ` +
        "mapping for it; extend mapTransactionResult before ingesting further",
      );
  }
}

/** Raised for a `--from`/`--to` request the archive cannot honour without a gap or a backfill
 *  (project 00026, FR-001). Never retried: the operator has to pick another range or schema. */
export class SyncRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncRangeError";
  }
}

/** The sync cursor stored under `sync_cursor:<net>`: the last archived height plus (since 00026)
 *  the first height this archive ever ingested, so a later `--from` below it is refused instead of
 *  leaving a silent hole. `startHeight` is absent on a cursor written before 00026. */
export interface SyncCursor {
  height: number;
  startHeight?: number;
}

/** Everything one height needs from the network, gathered before any store write touches it, so a
 *  window of heights can be FETCHED concurrently while blocks are still WRITTEN in height order. */
interface FetchedBlock {
  height: number;
  blockHash: Hex32;
  header: SubstrateHeader;
  extrinsics: string[];
  indexerBlock: IndexerBlock;
}

export interface ChainArchiveSyncServiceOptions {
  sql: UmbraDBSql;
  net: string;
  schema?: string;
  node: NodeRpcClientOptions;
  indexer: IndexerClientOptions;
  /** Project 00026 (FR-001, `--from`): where a FIRST run (no cursor yet) begins; default genesis
   *  (0). Once a cursor exists it is the only authority: a value inside the archived range is a
   *  no-op (resume continues at cursor + 1), a value above cursor + 1 or below the archive's first
   *  height is refused with {@link SyncRangeError}. The first archived block may therefore have no
   *  archived parent; no reader may assume the archive begins at genesis. */
  startHeight?: number;
  /** Project 00026 (FR-001, `--to`): the last height to ingest, inclusive. `syncOnce` never goes
   *  past it and reports `reachedEnd` once the cursor is there. */
  endHeight?: number;
  /** How many heights are FETCHED at once (bounded 1..16). Blocks are still WRITTEN strictly in
   *  ascending height order, one atomic checkpoint each. Default 1. */
  concurrency?: number;
  /** Per-network-call retry/back-off on throttling and outages (`retry.ts`). */
  backoff?: BackoffOptions;
  /** Ends back-off waits early on shutdown. */
  signal?: AbortSignal;
}

export interface SyncOnceResult {
  ingestedBlocks: number;
  fromHeight: number | undefined;
  toHeight: number | undefined;
  /** `min(node finalized head, indexer tip)`; `undefined` when the call returned before asking
   *  (the configured `endHeight` was already reached). */
  targetTipHeight: number | undefined;
  /** Project 00026: the cursor after this call has reached the configured `endHeight`. */
  reachedEnd: boolean;
  /** Network calls retried after a retryable failure, and how many of those were 429/403. */
  retries: number;
  throttled: number;
  elapsedMs: number;
}

const WATERMARK_KEY_PREFIX = "sync_cursor:";
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;

function checkHeight(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${value}`);
  }
}

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
  private readonly indexer: IndexerClient;
  private readonly net: string;
  private readonly sql: UmbraDBSql;
  private readonly schema: string;
  private readonly startHeight: number | undefined;
  private readonly endHeight: number | undefined;
  private readonly concurrency: number;
  private readonly backoff: BackoffOptions;
  private readonly signal: AbortSignal | undefined;
  private counters: RetryCounters = { retries: 0, throttled: 0 };
  /** Last-seen D-parameter, used to dedupe `bridge_observations` inserts so a chain with an
   *  unchanging D-parameter does not get one near-duplicate row per block. Project 00026: when it
   *  is unknown (a fresh service instance resuming an existing archive) it is re-seeded from the
   *  last archived observation before the next block is written -- at the base a restart
   *  re-inserted one observation, so a killed-and-resumed sync did not equal an uninterrupted one. */
  private lastDParameterJson: string | undefined;

  constructor(opts: ChainArchiveSyncServiceOptions) {
    this.sql = opts.sql;
    this.schema = opts.schema ?? "chain_archive";
    this.store = new PgChainArchiveStore(opts.sql, this.schema);
    this.node = new NodeRpcClient(opts.node);
    this.indexer = new IndexerClient(opts.indexer);
    this.net = opts.net;
    checkHeight("startHeight", opts.startHeight);
    checkHeight("endHeight", opts.endHeight);
    if (opts.startHeight !== undefined && opts.endHeight !== undefined && opts.endHeight < opts.startHeight) {
      throw new SyncRangeError(`endHeight ${opts.endHeight} is below startHeight ${opts.startHeight}`);
    }
    this.startHeight = opts.startHeight;
    this.endHeight = opts.endHeight;
    const requested = opts.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new RangeError(`concurrency must be a positive integer, got ${requested}`);
    }
    this.concurrency = Math.min(requested, MAX_CONCURRENCY);
    this.backoff = opts.backoff ?? {};
    this.signal = opts.signal;
  }

  /** The effective fetch concurrency after the 1..16 clamp. */
  get fetchConcurrency(): number {
    return this.concurrency;
  }

  /** The effective request spacing per endpoint (`polite-http.ts`). */
  get minIntervalMs(): { node: number; indexer: number } {
    return { node: this.node.minIntervalMs, indexer: this.indexer.minIntervalMs };
  }

  private watermarkKey(): string {
    return `${WATERMARK_KEY_PREFIX}${this.net}`;
  }

  private retry<T>(operation: string, call: () => Promise<T>): Promise<T> {
    return withRetry(operation, call, this.backoff, this.counters, this.signal);
  }

  /** The stored sync cursor, or `undefined` if this net has never been synced. */
  async getSyncCursor(): Promise<SyncCursor | undefined> {
    const wm = await this.store.getWatermark(this.watermarkKey());
    if (wm === undefined) return undefined;
    const parsed = wm as { height: number; startHeight?: number };
    return parsed.startHeight === undefined
      ? { height: parsed.height }
      : { height: parsed.height, startHeight: parsed.startHeight };
  }

  /** Resumable sync cursor -- the last successfully-ingested height, or `undefined` if this net
   *  has never been synced. A plain last-write-wins cursor with a monotonic guard, no history. */
  async getSyncedHeight(): Promise<number | undefined> {
    return (await this.getSyncCursor())?.height;
  }

  /**
   * Resolves where the next batch starts (project 00026, FR-001) and refuses a range the archive
   * cannot honour: never a gap (a `--from` above cursor + 1) and never a silent hole below the
   * archive's first height (a `--from` below it cannot be backfilled into one cursor).
   */
  private resolveStart(cursor: SyncCursor | undefined): { start: number; archiveStart: number | undefined } {
    if (cursor === undefined) {
      const start = this.startHeight ?? 0;
      return { start, archiveStart: start };
    }
    if (this.startHeight !== undefined) {
      if (this.startHeight > cursor.height + 1) {
        throw new SyncRangeError(
          `--from ${this.startHeight} would leave a gap: net ${this.net} is archived up to ${cursor.height}; ` +
          "use --from <= " + String(cursor.height + 1) + " or a fresh schema",
        );
      }
      if (cursor.startHeight !== undefined && this.startHeight < cursor.startHeight) {
        throw new SyncRangeError(
          `--from ${this.startHeight} is below this archive's first height ${cursor.startHeight} ` +
          `(net ${this.net}); heights below it cannot be backfilled into the same cursor -- use a fresh schema`,
        );
      }
    }
    return { start: cursor.height + 1, archiveStart: cursor.startHeight };
  }

  /**
   * Ingests one contiguous batch of blocks, starting right after the last watermark (or from
   * genesis on first run), up to `min(finalized head, indexer tip, watermark + maxBlocks)`. Only
   * ever ingests up to the FINALIZED head (`chain_getFinalizedHead`) and the indexer's current
   * tip -- deliberately conservative for
   * this first pass: every block this service archives is marked `is_canonical: true,
   * finalized: true` (GRANDPA-finalized blocks are canonical by construction, matching
   * `blocks`'s own `CHECK (NOT finalized OR is_canonical)` invariant), so this service does not
   * need to implement reorg/fork-following logic for the not-yet-finalized tail -- a real
   * production deployment would extend this to also track the best (non-finalized) head via
   * `setCanonical`'s reorg-flip support, which the storage layer already provides; that
   * extension is out of this sprint's scope (see the final report's judgment-calls section).
   */
  async syncOnce(opts?: { maxBlocks?: number }): Promise<SyncOnceResult> {
    const startedAt = Date.now();
    this.counters = { retries: 0, throttled: 0 };
    const finish = (r: Omit<SyncOnceResult, "retries" | "throttled" | "elapsedMs">): SyncOnceResult => ({
      ...r, retries: this.counters.retries, throttled: this.counters.throttled, elapsedMs: Date.now() - startedAt,
    });
    const maxBlocks = opts?.maxBlocks ?? 100;
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) throw new RangeError(`maxBlocks must be a positive integer, got ${maxBlocks}`);

    // Range checks before any network call: a refused range must not cost the endpoints anything.
    const cursor = await this.getSyncCursor();
    const { start: startHeight, archiveStart } = this.resolveStart(cursor);
    const synced = cursor?.height;
    if (this.endHeight !== undefined && startHeight > this.endHeight) {
      return finish({ ingestedBlocks: 0, fromHeight: undefined, toHeight: undefined, targetTipHeight: undefined, reachedEnd: true });
    }

    const finalizedHash = await this.retry("chain_getFinalizedHead", () => this.node.getFinalizedHead());
    const [nodeFinalizedHeight, indexerTipHeight] = await Promise.all([
      this.retry("chain_getHeader", () => this.node.getHeightOf(finalizedHash)),
      this.retry("indexer.tip", () => this.indexer.getTipHeight()),
    ]);
    // The indexer supplies transaction metadata/raw payloads for every block. Bounding the batch
    // here prevents the normal "node is ahead of indexer" state from entering ingestOneBlock,
    // throwing, and forcing the CLI through a 15-second error retry cycle. The lower tip is the
    // highest height both independent sources can currently serve.
    const targetTipHeight = Math.min(nodeFinalizedHeight, indexerTipHeight);

    if (startHeight > targetTipHeight) {
      // `updated_at` doubles as the dashboard liveness heartbeat. A same-height call to the
      // store's monotonic setWatermark is intentionally a no-op, so refresh it explicitly only
      // after both node and indexer probes above succeeded.
      if (synced !== undefined) {
        await this.sql`
          UPDATE ${this.sql(this.schema)}.watermarks
          SET updated_at = now()
          WHERE kind = 'chain_archive' AND key = ${this.watermarkKey()}
        `;
      }
      return finish({ ingestedBlocks: 0, fromHeight: undefined, toHeight: undefined, targetTipHeight, reachedEnd: false });
    }
    const endHeight = Math.min(
      targetTipHeight, startHeight + maxBlocks - 1, this.endHeight ?? Number.MAX_SAFE_INTEGER,
    );

    if (this.lastDParameterJson === undefined && synced !== undefined) {
      this.lastDParameterJson = await this.loadLastDParameterJson(synced);
    }

    // Fetch a window of heights concurrently (three latency-bound round trips per block), then
    // WRITE them strictly in ascending order, one atomic checkpoint (block + transactions +
    // outcomes + cursor) per block. A fetch failure inside a window does not discard the lower
    // heights already fetched: they are written first, then the failure is rethrown and the
    // caller's loop resumes from the new cursor.
    let ingested = 0;
    for (let windowStart = startHeight; windowStart <= endHeight; windowStart += this.concurrency) {
      const windowEnd = Math.min(endHeight, windowStart + this.concurrency - 1);
      const heights: number[] = [];
      for (let h = windowStart; h <= windowEnd; h++) heights.push(h);
      // allSettled, not all: a rejection on a higher height must not leave the lower heights'
      // promises unhandled while they are committed.
      const fetched = await Promise.allSettled(heights.map((h) => this.fetchBlock(h)));
      for (const outcome of fetched) {
        if (outcome.status === "rejected") throw outcome.reason;
        await this.storeFetchedBlock(outcome.value, archiveStart);
        ingested++;
      }
    }
    return finish({
      ingestedBlocks: ingested, fromHeight: startHeight, toHeight: endHeight, targetTipHeight,
      reachedEnd: this.endHeight !== undefined && endHeight >= this.endHeight,
    });
  }

  /** The last D-parameter value archived at or below `height` (as the exact JSON text stored), so
   *  a resumed service dedupes exactly like an uninterrupted one. `undefined` when none exists. */
  private async loadLastDParameterJson(height: number): Promise<string | undefined> {
    const rows = await this.sql<{ raw_blob_hash: Buffer }[]>`
      SELECT raw_blob_hash FROM ${this.sql(this.schema)}.bridge_observations
      WHERE net = ${this.net} AND kind = 'system_parameters_d' AND block_height <= ${height}
      ORDER BY block_height DESC, observation_index DESC
      LIMIT 1
    `;
    if (rows.length === 0) return undefined;
    const bytes = await this.store.getBlob(rows[0]!.raw_blob_hash.toString("hex"));
    return new TextDecoder().decode(bytes);
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
  private async ingestOneBlock(height: number): Promise<void> {
    const cursor = await this.getSyncCursor();
    await this.storeFetchedBlock(await this.fetchBlock(height), cursor === undefined ? height : cursor.startHeight);
  }

  /**
   * The NETWORK half of ingestion: performs no store write at all, which keeps Fix 1's "the
   * indexer-not-synced throw happens with zero writes" property true by construction, and lets a
   * window of heights be fetched concurrently.
   */
  private async fetchBlock(height: number): Promise<FetchedBlock> {
    const blockHash = hexNoPrefix(await this.retry("chain_getBlockHash", () => this.node.getBlockHash(height)));
    const { block } = await this.retry("chain_getBlock", () => this.node.getBlock(`0x${blockHash}`));

    // One indexer fetch per block, shared by the transaction-ingestion and bridge-observation
    // paths below. Fetched BEFORE any store write (Fix 1) so the throw immediately below never
    // leaves a partially-ingested block behind.
    const indexerBlock = await this.retry("indexer.block", () => this.indexer.getBlockByHeight(height));
    if (indexerBlock === undefined) {
      // Indexer hasn't synced this height yet -- the cursor is not advanced past it, so a later
      // syncOnce() re-attempts this exact height once the indexer catches up.
      throw new Error(`indexer has not yet synced height ${height} (node has); retry later`);
    }
    return { height, blockHash, header: block.header, extrinsics: block.extrinsics, indexerBlock };
  }

  /**
   * The STORE half: builds every record from already-fetched data and writes ONE atomic bundle --
   * block, transactions with their results and per-segment outcomes, bridge observations AND the
   * sync cursor (project 00026, FR-001). Called strictly in ascending height order, which is what
   * the D-parameter dedup cursor needs (it compares against the previous height's value).
   */
  private async storeFetchedBlock(fetched: FetchedBlock, archiveStart: number | undefined): Promise<void> {
    const { height, blockHash, header, extrinsics, indexerBlock } = fetched;
    const blockRecord: BlockRecord = {
      net: this.net,
      blockHash,
      height,
      parentHash: hexNoPrefix(header.parentHash),
      // Substrate genesis's parentHash is all-zero (32 zero bytes), which already satisfies the
      // schema's `CHECK (octet_length(parent_hash) = 32)`; no special-casing needed.
      stateRoot: hexNoPrefix(header.stateRoot),
      extrinsicsRoot: hexNoPrefix(header.extrinsicsRoot),
      headerBytes: headerBytes(header),
      bodyBytes: extrinsicsBytes(extrinsics),
      isCanonical: true,
      status: "canonical",
      finalized: true,
    };

    const transactions = this.buildTransactionRecords(height, blockHash, extrinsics, indexerBlock);
    const { records: bridgeObservations, newDParameterJson } =
      this.buildBridgeObservationRecords(height, blockHash, indexerBlock);

    // A cursor written before 00026 has no `startHeight`; it stays unknown rather than being
    // replaced by a guess (the first height of this run is not the archive's first height).
    const cursor: SyncCursor = archiveStart === undefined ? { height } : { height, startHeight: archiveStart };
    await this.store.putBlockBundle({
      block: blockRecord, transactions, bridgeObservations,
      watermark: { key: this.watermarkKey(), value: cursor },
    });

    // Fix 2 (sprint-fix round, HIGH): only advance the in-memory D-parameter dedup cursor AFTER
    // the durable write above has succeeded -- see `buildBridgeObservationRecords`'s own doc for
    // why updating it any earlier silently drops observations on retry.
    if (newDParameterJson !== undefined) {
      this.lastDParameterJson = newDParameterJson;
    }
  }

  /** Project 00026 (FR-002): the result and per-segment outcomes of one indexer transaction. A
   *  `RegularTransaction` without a result is an error (the indexer has not reported it; the block
   *  is retried rather than archived with an unknown outcome). */
  private transactionOutcome(
    height: number, tx: IndexerTransaction,
  ): { result?: TransactionResult; segments?: TransactionSegmentResult[] } {
    const reported = tx.transactionResult ?? undefined;
    if (reported === undefined) {
      if (tx.__typename === "RegularTransaction") {
        throw new Error(
          `indexer returned no transactionResult for regular transaction ${hexNoPrefix(tx.hash)} at height ${height}; retry later`,
        );
      }
      return {};
    }
    const result = mapTransactionResult(reported.status);
    const segments = reported.segments === null || reported.segments === undefined
      ? undefined
      : reported.segments.map((s) => ({ id: s.id, success: s.success }));
    return {
      ...(result === undefined ? {} : { result }),
      ...(segments === undefined ? {} : { segments }),
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
        ...this.transactionOutcome(height, tx),
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
    height: number, blockHash: Hex32, indexerBlock: IndexerBlock,
  ): { records: BridgeObservationRecord[]; newDParameterJson: string | undefined } {
    const d = indexerBlock.systemParameters.dParameter;
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
