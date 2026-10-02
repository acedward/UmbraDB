import { PgChainArchiveStore } from "../src/postgres/chain-archive-store.js";
import type { UmbraDBSql } from "../src/postgres/client.js";
import type {
  BlockRecord,
  BridgeObservationRecord,
  ChainArchiveStore,
  Hex32,
  TransactionRecord,
  TransactionResult,
} from "../src/interfaces/chain-archive-store.js";
import { IndexerClient, IndexerClientError, IndexerClientParseError, type IndexerBlock, type IndexerClientOptions } from "./indexer-client.js";
import { NodeRpcClient, NodeRpcError, NodeRpcParseError, type NodeRpcClientOptions, type SubstrateHeader } from "./node-rpc-client.js";

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

/** Everything one height needs from the network, gathered before any store write touches it
 *  (00020, FR-016 -- the concurrent-fetch / ordered-write split). */
interface FetchedBlock {
  height: number;
  blockHash: Hex32;
  header: SubstrateHeader;
  extrinsics: string[];
  indexerBlock: IndexerBlock;
}

/**
 * Where a FIRST run (no watermark for this net yet) begins. Project 00020, spec FR-015: a number
 * is that exact height; `"head"` is the finalized head at the moment of the first batch; omitted
 * keeps the historical behaviour (genesis). Honoured ONLY while the archive has no watermark --
 * once one exists it is the sole authority, so a stale `START_HEIGHT` in a service manager's
 * environment can never rewind or fork a running archive.
 *
 * **Consequence for every downstream reader** (also FR-015): the first archived block may have no
 * archived parent, and no archive query, scanner or rebuild may assume the archive begins at
 * genesis or that `parent_hash` resolves to an archived row.
 */
export type SyncStartHeight = number | "head";

/** Why `fromHeight` is what it is -- carried out of `syncOnce` so the CLI can log the start
 *  height and its provenance once, instead of the service depending on a logger. */
export type StartHeightSource = "watermark" | "configured" | "head" | "genesis";

/**
 * Project 00020, spec FR-002: the indexer's `TransactionResultStatus` enum (`SUCCESS`,
 * `PARTIAL_SUCCESS`, `FAILURE`) mapped onto the archive's own
 * `transactions.result CHECK (result IN ('success','partial_success','failure'))`.
 *
 * `undefined` means "the source said nothing" -- a `SystemTransaction` or `BridgeClaimTransaction`,
 * neither of which declares `transactionResult` in the v4 SDL. That is a real absence, not a
 * failure, and it must stay NULL in the archive rather than being defaulted to `success`: a
 * consumer that cannot tell "succeeded" from "unknown" would count mints the ledger rejected.
 *
 * An unrecognised status is a hard error, not a silent NULL -- a new enum member in a future
 * indexer must surface here rather than silently disarm the segment logic downstream.
 */
export function mapTransactionResult(
  result: { status: string } | null | undefined,
): TransactionResult | undefined {
  if (result === null || result === undefined) return undefined;
  switch (result.status) {
    case "SUCCESS": return "success";
    case "PARTIAL_SUCCESS": return "partial_success";
    case "FAILURE": return "failure";
    default:
      throw new Error(
        `unknown indexer TransactionResultStatus ${JSON.stringify(result.status)} -- the archive's ` +
        "result column has no mapping for it; update mapTransactionResult before ingesting further",
      );
  }
}

/**
 * Exponential back-off for the PUBLIC endpoints (spec FR-016). Applied per network call inside
 * `syncOnce`, so one throttled block does not abort a batch that has already committed work, and
 * the service resumes without operator action. Retryable: HTTP 429/403/5xx, a failed transport,
 * and a 2xx whose body is not JSON (a proxy error page). Never retried: a JSON-RPC/GraphQL
 * protocol error, a malformed block number, or any store/database error -- those are surfaced.
 */
export interface SyncBackoffOptions {
  /** Total attempts per network call, including the first. Default 8 (≈ 2 min of waiting at the
   *  default schedule) -- after that the error is thrown and the CLI's own outer loop backs off. */
  maxAttempts?: number;
  /** First delay; doubles per attempt. Default 1_000. */
  baseDelayMs?: number;
  /** Ceiling for one delay. Default 60_000. */
  maxDelayMs?: number;
  /** Full jitter (a uniform draw in `[delay/2, delay]`). Default true; set false in tests. */
  jitter?: boolean;
  /** Injection seam for tests -- default sleeps for real (and returns early if `signal` aborts). */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, so the CLI can log throttling as FR-016 requires. */
  onRetry?: (info: {
    operation: string; attempt: number; maxAttempts: number; delayMs: number;
    httpStatus: number | undefined; throttled: boolean; message: string;
  }) => void;
}

export interface ChainArchiveSyncServiceOptions {
  sql: UmbraDBSql;
  net: string;
  schema?: string;
  node: NodeRpcClientOptions;
  indexer: IndexerClientOptions;
  /** FR-015. */
  startHeight?: SyncStartHeight;
  /** FR-016: how many heights are FETCHED at once. Blocks are still WRITTEN strictly in
   *  ascending height order, one watermark advance per block, so the watermark semantics and the
   *  crash-safety argument are unchanged. Default 1 (the historical sequential behaviour);
   *  `sync-cli.ts` defaults the deployed sync to 8. Bounded to 1..32. */
  concurrency?: number;
  /** FR-016. */
  backoff?: SyncBackoffOptions;
  /** Ends a back-off wait early on shutdown so SIGTERM is not stuck behind a 60 s sleep. */
  signal?: AbortSignal;
}

export interface SyncOnceResult {
  ingestedBlocks: number;
  fromHeight: number | undefined;
  toHeight: number | undefined;
  targetTipHeight: number;
  /** Additive (00020): FR-016 evidence -- what the batch cost and whether the endpoints pushed
   *  back. All four are per-`syncOnce`-call, never cumulative. */
  elapsedMs: number;
  blocksPerSecond: number;
  /** Network calls retried after a retryable failure (not the number of failed calls). */
  retries: number;
  /** Of those, the ones the endpoint threw back as 429/403. */
  throttled: number;
  /** Where `fromHeight` came from; `undefined` when nothing was ingested. */
  startHeightSource: StartHeightSource | undefined;
}

const WATERMARK_KEY_PREFIX = "sync_cursor:";
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;
const DEFAULT_BACKOFF: Required<Pick<SyncBackoffOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "jitter">> = {
  maxAttempts: 8, baseDelayMs: 1_000, maxDelayMs: 60_000, jitter: true,
};

/** 429 (rate limited) and 403 (what a WAF in front of a public endpoint answers when it decides a
 *  client is abusive -- observed on the public preprod indexer, memory note "Midnight preprod node
 *  and RPC facts") are the throttling statuses; 5xx is a transient server/proxy outage. */
function retryableHttpStatus(status: number): boolean {
  return status === 429 || status === 403 || status >= 500;
}

function throttlingHttpStatus(status: number | undefined): boolean {
  return status === 429 || status === 403;
}

/** The classification FR-016 rests on. Deliberately narrow: only the two endpoint clients'
 *  own error types, and only their transport/HTTP-status failure shapes. A GraphQL/JSON-RPC
 *  protocol error (no `httpStatus`, no `cause`), `NodeRpcInvalidHeightError`, the "indexer has not
 *  yet synced height N" signal and every store error stay non-retryable here -- they are either
 *  real bugs to surface or handled by the caller's own loop. */
export function isRetryableEndpointError(error: unknown): { retryable: boolean; httpStatus: number | undefined; retryAfterMs: number | undefined } {
  if (error instanceof NodeRpcError || error instanceof IndexerClientError) {
    if (error.httpStatus !== undefined) {
      return { retryable: retryableHttpStatus(error.httpStatus), httpStatus: error.httpStatus, retryAfterMs: error.retryAfterMs };
    }
    // A failed transport (DNS, connection reset, timeout abort) -- the client sets `cause` only
    // on that path. A protocol error has neither field and is not retried.
    return { retryable: error.cause !== undefined, httpStatus: undefined, retryAfterMs: undefined };
  }
  if (error instanceof NodeRpcParseError || error instanceof IndexerClientParseError) {
    // HTTP 200 carrying a non-JSON body: in practice a load balancer's error page, i.e. the
    // endpoint is unhealthy right now -- retryable, bounded by `maxAttempts`.
    return { retryable: true, httpStatus: undefined, retryAfterMs: undefined };
  }
  return { retryable: false, httpStatus: undefined, retryAfterMs: undefined };
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
  /** Last-seen D-parameter, in-memory, this instance's lifetime only -- used to dedupe
   *  `bridge_observations` inserts (§"stub/initial pass") so a healthy chain with an unchanging
   *  D-parameter doesn't get one near-duplicate row per block. Deliberately not persisted: a
   *  fresh service instance re-inserting one observation on its first synced block after a
   *  restart is a correct, harmless re-observation, not a bug (`bridge_observations` has no
   *  uniqueness constraint on content, only on `(net, block_height, block_hash,
   *  observation_index)`, so this can never produce a duplicate-key error either way). */
  private lastDParameterJson: string | undefined;
  /** FR-015/FR-016 configuration, resolved and validated once in the constructor. */
  private readonly startHeight: SyncStartHeight | undefined;
  private readonly concurrency: number;
  private readonly backoff: SyncBackoffOptions;
  private readonly signal: AbortSignal | undefined;
  /** Per-`syncOnce` counters, reset at the top of each call. */
  private retries = 0;
  private throttled = 0;

  constructor(opts: ChainArchiveSyncServiceOptions) {
    this.sql = opts.sql;
    this.schema = opts.schema ?? "chain_archive";
    this.store = new PgChainArchiveStore(opts.sql, this.schema);
    this.node = new NodeRpcClient(opts.node);
    this.indexer = new IndexerClient(opts.indexer);
    this.net = opts.net;
    if (typeof opts.startHeight === "number"
        && (!Number.isSafeInteger(opts.startHeight) || opts.startHeight < 0)) {
      throw new RangeError(`startHeight must be "head" or a non-negative safe integer, got ${opts.startHeight}`);
    }
    this.startHeight = opts.startHeight;
    const requested = opts.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new RangeError(`concurrency must be a positive integer, got ${requested}`);
    }
    this.concurrency = Math.min(requested, MAX_CONCURRENCY);
    this.backoff = opts.backoff ?? {};
    this.signal = opts.signal;
  }

  /** The effective fetch concurrency after the 1..32 clamp -- read by the CLI for its start log. */
  get fetchConcurrency(): number {
    return this.concurrency;
  }

  private async sleep(ms: number): Promise<void> {
    if (this.backoff.sleep !== undefined) return this.backoff.sleep(ms);
    if (this.signal?.aborted === true) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  /**
   * FR-016: runs one network call against a public endpoint, retrying the retryable failures
   * (429/403/5xx, transport, non-JSON 2xx body) on an exponential schedule with jitter and
   * honouring a `Retry-After` header when the endpoint sends one. Everything else -- protocol
   * errors, the "indexer has not yet synced height N" signal, store errors -- propagates
   * immediately. Never swallows the final failure: after `maxAttempts` the last error is rethrown
   * and the caller's own loop (the CLI) takes over.
   */
  private async withRetry<T>(operation: string, call: () => Promise<T>): Promise<T> {
    const maxAttempts = this.backoff.maxAttempts ?? DEFAULT_BACKOFF.maxAttempts;
    const baseDelayMs = this.backoff.baseDelayMs ?? DEFAULT_BACKOFF.baseDelayMs;
    const maxDelayMs = this.backoff.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs;
    const jitter = this.backoff.jitter ?? DEFAULT_BACKOFF.jitter;
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const { retryable, httpStatus, retryAfterMs } = isRetryableEndpointError(error);
        if (!retryable || attempt >= maxAttempts || this.signal?.aborted === true) throw error;
        const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        const jittered = jitter ? exponential / 2 + Math.random() * (exponential / 2) : exponential;
        const delayMs = Math.round(Math.min(Math.max(retryAfterMs ?? jittered, jittered), maxDelayMs));
        this.retries++;
        if (throttlingHttpStatus(httpStatus)) this.throttled++;
        this.backoff.onRetry?.({
          operation, attempt, maxAttempts, delayMs, httpStatus,
          throttled: throttlingHttpStatus(httpStatus),
          message: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(delayMs);
      }
    }
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
    this.retries = 0;
    this.throttled = 0;
    const finish = (r: Omit<SyncOnceResult, "elapsedMs" | "blocksPerSecond" | "retries" | "throttled">): SyncOnceResult => {
      const elapsedMs = Date.now() - startedAt;
      return {
        ...r,
        elapsedMs,
        blocksPerSecond: elapsedMs > 0 ? Number((r.ingestedBlocks / (elapsedMs / 1000)).toFixed(3)) : 0,
        retries: this.retries,
        throttled: this.throttled,
      };
    };
    const maxBlocks = opts?.maxBlocks ?? 100;
    const finalizedHash = await this.withRetry("chain_getFinalizedHead", () => this.node.getFinalizedHead());
    const [nodeFinalizedHeight, indexerTipHeight] = await Promise.all([
      this.withRetry("chain_getHeader", () => this.node.getHeightOf(finalizedHash)),
      this.withRetry("indexer.tipHeight", () => this.indexer.getTipHeight()),
    ]);
    // The indexer supplies transaction metadata/raw payloads for every block. Bounding the batch
    // here prevents the normal "node is ahead of indexer" state from entering ingestOneBlock,
    // throwing, and forcing the CLI through a 15-second error retry cycle. The lower tip is the
    // highest height both independent sources can currently serve.
    const targetTipHeight = Math.min(nodeFinalizedHeight, indexerTipHeight);

    const synced = await this.getSyncedHeight();
    // FR-015: the watermark always wins; `START_HEIGHT` only chooses where a NEVER-synced net
    // begins. `"head"` resolves against the tip both sources can serve right now, so the first
    // archived block is one the indexer can already hand transactions for.
    let startHeightSource: StartHeightSource;
    let startHeight: number;
    if (synced !== undefined) {
      startHeightSource = "watermark";
      startHeight = synced + 1;
    } else if (this.startHeight === "head") {
      startHeightSource = "head";
      startHeight = targetTipHeight;
    } else if (typeof this.startHeight === "number") {
      startHeightSource = "configured";
      startHeight = this.startHeight;
    } else {
      startHeightSource = "genesis";
      startHeight = 0;
    }
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
      return finish({
        ingestedBlocks: 0, fromHeight: undefined, toHeight: undefined, targetTipHeight,
        startHeightSource: undefined,
      });
    }
    const endHeight = Math.min(targetTipHeight, startHeight + maxBlocks - 1);

    // FR-016: fetch a window of heights concurrently (three latency-bound round trips per block
    // against the public endpoints), then WRITE them strictly in ascending height order, one
    // watermark advance per block -- exactly the sequential write sequence the pre-existing
    // crash-safety argument (Fix 1/Fix 2 above) is built on. The window, not the whole batch, is
    // what is held in memory, so `MAX_BLOCKS` can stay large on a memory-constrained host.
    //
    // A fetch failure inside a window does not discard the window's already-fetched lower
    // heights: everything below the first failure is written and its watermark advanced, then the
    // failure is rethrown for the caller's loop to retry from the new watermark.
    let ingested = 0;
    let lastIngested: number | undefined;
    try {
      for (let windowStart = startHeight; windowStart <= endHeight; windowStart += this.concurrency) {
        const windowEnd = Math.min(endHeight, windowStart + this.concurrency - 1);
        const heights: number[] = [];
        for (let h = windowStart; h <= windowEnd; h++) heights.push(h);
        // allSettled, not all: a rejection on a higher height must not leave the lower heights'
        // promises unhandled while we commit them.
        const fetched = await Promise.allSettled(heights.map((h) => this.fetchBlock(h)));
        for (const outcome of fetched) {
          if (outcome.status === "rejected") throw outcome.reason;
          await this.storeFetchedBlock(outcome.value);
          await this.store.setWatermark(this.watermarkKey(), { height: outcome.value.height });
          ingested++;
          lastIngested = outcome.value.height;
        }
      }
    } catch (error) {
      // Some of this batch may already be durably archived; report that progress through the same
      // error the caller would have seen anyway, with the committed range attached. Guarded:
      // a rejection reason is not necessarily an object (`Promise.allSettled` hands back whatever
      // was thrown), and attaching a property to a string or null would itself throw.
      if (ingested > 0 && (typeof error === "object" || typeof error === "function") && error !== null) {
        (error as { partialSync?: unknown }).partialSync = {
          ingestedBlocks: ingested, fromHeight: startHeight, toHeight: lastIngested,
        };
      }
      throw error;
    }
    return finish({
      ingestedBlocks: ingested, fromHeight: startHeight, toHeight: endHeight, targetTipHeight,
      startHeightSource,
    });
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
    await this.storeFetchedBlock(await this.fetchBlock(height));
  }

  /**
   * The NETWORK half of `ingestOneBlock`, split out (00020, FR-016) so a window of heights can be
   * fetched concurrently while the write half stays strictly ordered. Performs no store write at
   * all, which is what keeps Fix 1's "the indexer-not-synced throw happens with zero writes"
   * property true by construction rather than by reading the method body.
   */
  private async fetchBlock(height: number): Promise<FetchedBlock> {
    const blockHash = hexNoPrefix(await this.withRetry("chain_getBlockHash", () => this.node.getBlockHash(height)));
    const { block } = await this.withRetry("chain_getBlock", () => this.node.getBlock(`0x${blockHash}`));

    // One indexer fetch per block, shared by the transaction-ingestion and bridge-observation
    // paths below -- avoids two redundant GraphQL round trips for the same block. Fetched BEFORE
    // any store write (Fix 1) so the throw immediately below never leaves a partially-ingested
    // block behind.
    const indexerBlock = await this.withRetry("indexer.block", () => this.indexer.getBlockByHeight(height));
    if (indexerBlock === undefined) {
      // Indexer hasn't synced this height yet -- do NOT advance the watermark past it (syncOnce
      // only advances the watermark after this whole method returns successfully), so a later
      // syncOnce() call re-attempts this exact height once the indexer catches up. No store write
      // has happened yet at this point, so that retry starts completely fresh.
      throw new Error(`indexer has not yet synced height ${height} (node has); retry later`);
    }
    return { height, blockHash, header: block.header, extrinsics: block.extrinsics, indexerBlock };
  }

  /**
   * The STORE half: builds every record from already-fetched data and writes the one atomic
   * bundle. Called strictly in ascending height order by `syncOnce`, which is what the
   * D-parameter dedup cursor (`lastDParameterJson`) needs -- it compares against the PREVIOUS
   * height's value, so concurrency must never reach this method.
   */
  private async storeFetchedBlock(fetched: FetchedBlock): Promise<void> {
    const { height, blockHash, header, extrinsics, indexerBlock } = fetched;

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
      bodyBytes: extrinsicsBytes(extrinsics),
      isCanonical: true,
      status: "canonical",
      finalized: true,
    };

    const transactions = this.buildTransactionRecords(height, blockHash, extrinsics, indexerBlock);
    const { records: bridgeObservations, newDParameterJson } =
      this.buildBridgeObservationRecords(height, blockHash, indexerBlock);

    await this.store.putBlockBundle({ block: blockRecord, transactions, bridgeObservations });

    // Project 00020 (FR-002) -- before the watermark advances, so a crash in between re-runs it.
    await this.storeTransactionResults(height, blockHash, indexerBlock);

    // Fix 2 (sprint-fix round, HIGH): only advance the in-memory D-parameter dedup cursor AFTER
    // the durable write above has succeeded -- see `buildBridgeObservationRecords`'s own doc for
    // why updating it any earlier silently drops observations on retry.
    if (newDParameterJson !== undefined) {
      this.lastDParameterJson = newDParameterJson;
    }
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
        // Project 00020, spec FR-002: the column existed but was never written. A system
        // transaction has no `transactionResult` in the SDL at all, so it stays undefined (NULL).
        ...(mapTransactionResult(tx.transactionResult) !== undefined
          ? { result: mapTransactionResult(tx.transactionResult)! }
          : {}),
        rawBytes,
      };
    });
  }

  /**
   * Project 00020, spec FR-002. `putBlockBundle` writes `result` on INSERT but is a bare
   * `ON CONFLICT DO NOTHING`, and the archive schema's `segments` column is not part of
   * `TransactionRecord` (nothing under `src/` may change). So the per-segment detail — and, on a
   * re-ingest of an already-present block, the status too — is written here, by one statement per
   * block, against the same connection the store uses.
   *
   * **Crash safety**: this runs INSIDE `storeFetchedBlock`, i.e. BEFORE `syncOnce` advances the
   * watermark for that height. A crash between the bundle commit and this update therefore leaves
   * the watermark below the block, the block is re-ingested on the next run, and this update runs
   * again — idempotent by construction (it sets absolute values, never increments).
   *
   * Only rows whose value actually changes are touched (`IS DISTINCT FROM`), so a steady-state
   * re-ingest writes nothing.
   */
  private async storeTransactionResults(
    height: number, blockHash: Hex32, indexerBlock: IndexerBlock,
  ): Promise<void> {
    for (const tx of indexerBlock.transactions) {
      const result = mapTransactionResult(tx.transactionResult);
      if (result === undefined) continue;
      const segments = tx.transactionResult?.segments ?? null;
      await this.sql`
        UPDATE ${this.sql(this.schema)}.transactions
        SET result = ${result},
            segments = ${segments === null ? null : this.sql.json(segments.map((s) => ({ id: s.id, success: s.success })))}
        WHERE net = ${this.net}
          AND block_height = ${height}
          AND block_hash = ${Buffer.from(blockHash, "hex")}
          AND tx_hash = ${Buffer.from(hexNoPrefix(tx.hash), "hex")}
          AND (result IS DISTINCT FROM ${result}
               OR segments IS DISTINCT FROM ${segments === null ? null : this.sql.json(segments.map((s) => ({ id: s.id, success: s.success })))})
      `;
    }
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
