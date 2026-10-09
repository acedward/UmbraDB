/**
 * The token indexer's engine: the chain-archive sync, the MIP-0018 scan and the read-only API composed in one place,
 * from injected dependencies only, so the same module runs under Node (the CLIs in `token-indexer/mip0018/` and
 * `chain-archive-sync/` are thin wrappers over it) and in a browser worker.
 *
 * - **Injected:** the database client(s) (`sql` for the `mip0018` schema and the API, `archiveSql` for the chain
 *   archive, default `sql`), `fetch` for the node and indexer clients, a clock (`now`, `sleep`), a random source for
 *   back-off jitter, a scheduler for the loops' steps, and an event listener that receives every log line. The engine
 *   imports no Node built-in and reads no Node global; it takes the `Sql` as a type only.
 * - **Sync loop** (`sync`): `ChainArchiveSyncService.syncOnce` batches of finalized blocks, one atomic checkpoint per
 *   block; at the tip it waits `sync.idleMs`; a failed batch is retried after an exponential back-off with jitter
 *   (`sync.backoff`); a range it cannot honour (`SyncRangeError`) ends it; with `sync.endHeight` it ends once the cursor
 *   is there. `sync.startHeight` is the first height of a first run: a number, or a function the engine calls only
 *   when the archive has no cursor yet (a resumed archive continues at its cursor and never asks).
 * - **Scan loop** (`scan`): `Mip0018Scanner.scanOnce` steps of `scan.batch` blocks, one database transaction per
 *   block. `"follow"` (default) never ends by itself: at the archive's tip it waits `scan.idleMs`, and a failed step
 *   marks the scanner `stalled` and is retried after `idleMs × 5^min(failures − 1, 4)`, never more than 60 s, while the
 *   API keeps serving. `"drain"` ends once a step reaches `scan.toHeight` or scans nothing,
 *   and a failed step ends it.
 * - **API:** `handle(method, target)` answers through `api.ts`'s handler (routes, errors, the request cap with 503
 *   `BUSY`); it is always available, also before `start()`, and is never queued by the engine.
 * - **Lifecycle:** `start()` creates the schemas the configured loops write (the archive's, then the scan's), then
 *   starts the loops and resolves. `stop()` ends them and resolves once the step each loop has in flight has ended: a
 *   sync batch (up to `sync.maxBlocks` heights) or a scan step (up to `scan.batch` blocks). Every block commits in
 *   its own transaction, so a stop leaves both cursors at the last fully written block; a host that needs a quicker
 *   stop uses smaller batches. `finished` settles when every loop has ended: it rejects with the error that ended a
 *   loop (a refused range, a failed drain), the sync's first.
 * - **Events:** every log line and every counter update is an {@link EngineEvent}, given synchronously to `onEvent`
 *   and to each `subscribe` listener in order. A listener must not throw: a throw inside a loop counts as that step's
 *   error. The Node CLIs print the events they always printed, in their own formats.
 */
import type { RetryInfo } from "../../chain-archive-sync/retry.js";
import type { ChainArchiveSyncService, SyncCursor, SyncOnceResult } from "../../chain-archive-sync/sync-service.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { publicEndpoint, publicErrorMessage } from "../../wallet-monitor/log.js";
import { type ApiResponse, createMip0018Handler, DEFAULT_MAX_CONCURRENT_REQUESTS } from "../mip0018/api.ts";
import type { ScannerState } from "../mip0018/api-views.ts";
import type { Mip0018Scanner, ScanCursor, ScanOnceResult } from "../mip0018/scan.ts";

// ── Injected dependencies ────────────────────────────────────────────────────────────────────────────────────────

/** Time as the engine sees it. */
export interface EngineClock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Resolves after `ms` milliseconds, or at once when `signal` aborts; never rejects. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** The host's own clock and timers. A sleep removes its abort listener when it ends, so long runs keep none. */
export const systemClock: EngineClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    }),
};

/** The background steps a scheduler admits: one sync batch (network waits included) or one scan step. */
export type EngineStepKind = "sync" | "scan";

/**
 * Runs one step of a background loop and returns its result. The default runs it at once. A scheduler may delay a
 * step (for example while API requests are waiting for a single database session) and may time it; it must run each
 * step exactly once and pass its result or error through. API requests never go through it. When the database and
 * `fetch` answer without I/O (an in-memory or in-worker database, a fetch answered in process), the loops never give
 * the event loop a turn by themselves: such a host's scheduler yields to it before each step, or timers and incoming
 * messages wait until the loops are idle.
 */
export type EngineScheduler = <T>(kind: EngineStepKind, step: () => Promise<T>) => Promise<T>;

// ── Options ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EngineSyncOptions {
  /** Substrate JSON-RPC endpoint of the node. */
  nodeUrl: string;
  /** GraphQL endpoint of the indexer. */
  indexerUrl: string;
  /**
   * First height of a first run (no cursor yet): a height, or a function the engine calls with its abort signal only
   * when the archive has no cursor, before the first batch. Default genesis (0). A resumed archive continues at its
   * cursor; a height above cursor + 1 or below the archive's first height is refused (`range-refused`).
   */
  startHeight?: number | ((signal: AbortSignal) => Promise<number>);
  /** Last height, inclusive: the loop ends (`range-complete`) once the cursor is there. Default: follow the tip. */
  endHeight?: number;
  /** Heights per batch. Default 200. */
  maxBlocks?: number;
  /** Heights fetched at once (1..16); blocks are written in height order. Default 4. */
  concurrency?: number;
  /** Minimum spacing of request starts per endpoint. Default 250 ms for a public Midnight host, else 0. */
  minIntervalMs?: number;
  /** Per-request timeout. Default 30 000 ms. */
  timeoutMs?: number;
  /** Back-off of a failed network call (`retry.ts`) and of a failed batch. */
  backoff?: { baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number; jitter?: boolean };
  /** Wait at the finalized tip before the next batch. Default 10 000 ms. */
  idleMs?: number;
}

export interface EngineScanOptions {
  /** `"follow"` (default): never ends, retries a failed step. `"drain"`: ends when caught up; a failed step ends it. */
  mode?: "follow" | "drain";
  /** First height of a first scan (default: the archive's first height). */
  fromHeight?: number;
  /** Last height to scan, inclusive. */
  toHeight?: number;
  /** Blocks per scan step, passed to `scanOnce` unchanged. Default 100. */
  batch?: number;
  /** Wait at the archive's tip, and the base of the error back-off. Default 2 000 ms. */
  idleMs?: number;
}

export interface EngineOptions {
  /** Client of the `mip0018` schema: the scan and the API; also the sync's unless `archiveSql` is given. */
  sql: UmbraDBSql;
  /** Client the sync writes the chain archive with. Default `sql`. */
  archiveSql?: UmbraDBSql;
  /** The archive's `net` and the network of the scan and the API. */
  network: string;
  /** Schema of the `mip0018` lineage (default `mip0018`). */
  schema?: string;
  /** Schema of the chain archive (default `chain_archive`). */
  archiveSchema?: string;
  /** Genesis hash `/v1/status` reports (default: the known network's, else `null`). */
  genesisHash?: string | null;
  /** API requests admitted at once (default 8); more are answered 503 `BUSY`. */
  maxConcurrentRequests?: number;
  /** The sync loop; absent: no sync. */
  sync?: EngineSyncOptions;
  /** The scan loop; absent: no scan and no migration (the API alone, read-only). */
  scan?: EngineScanOptions;
  /** `fetch` of the node and indexer clients (default the global one); always called as a plain function. */
  fetch?: typeof fetch;
  clock?: EngineClock;
  /** Uniform draws in [0, 1) for the sync loop's back-off jitter. Default `Math.random`. */
  random?: () => number;
  schedule?: EngineScheduler;
  /** Ends the loops as `stop()` does. */
  signal?: AbortSignal;
  /** Receives every event; the first listener. */
  onEvent?: (event: EngineEvent) => void;
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Fields of the sync loop's `start` event. */
export interface SyncStartFields {
  net: string;
  schema: string;
  /** Endpoints without userinfo, query or fragment. */
  nodeUrl: string;
  indexerUrl: string;
  from: number | "genesis";
  to: number | "follow";
  maxBlocks: number;
  concurrency: number;
  minIntervalMs: { node: number; indexer: number };
  cursor: SyncCursor | null;
}

/** Fields of the sync loop's `batch` event (`height`: the cursor after the batch). */
export interface SyncBatchFields {
  height: number | undefined;
  ingested: number;
  from: number | undefined;
  to: number | undefined;
  tip: number | undefined;
  retries: number;
  throttled: number;
  elapsedMs: number;
}

type Ev<S extends string, E extends string, F> = { at: number; source: S; event: E; fields: F };

export type EngineEvent =
  | Ev<"sync", "start", SyncStartFields>
  /** A network call is retried after `delayMs`. */
  | Ev<"sync", "backoff", RetryInfo>
  | Ev<"sync", "batch", SyncBatchFields>
  | Ev<"sync", "range-complete", { to: number | undefined; height: number | undefined }>
  | Ev<"sync", "range-refused", { message: string }>
  /** A batch failed; the next one starts after about `retryMs` (jittered). */
  | Ev<"sync", "error", { message: string; retryMs: number }>
  | Ev<"sync", "stop", Record<string, never>>
  /** One scan step's result, also when it scanned nothing. */
  | Ev<"scan", "batch", ScanOnceResult>
  /** A scan step failed; `retryMs` is the wait before the next one (`null` in drain mode, where it ends the loop). */
  | Ev<"scan", "error", { error: string; failures: number; retryMs: number | null }>
  /** One API request answered: `busy` is a 503 refused by the cap. */
  | Ev<"api", "request", { method: string; status: number; busy: boolean; ms: number }>
  /** A line the API handler logs (an error it answered generically). */
  | Ev<"api", "log", { line: string }>;

type EventOf<S extends EngineEvent["source"], N extends EngineEvent["event"]> = Extract<EngineEvent, { source: S; event: N }>;

// ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a loop is: not configured (`off`), configured but not started (`ready`), creating its schema or resolving its
 * first height (`starting`), in a step (`running`), waiting at the tip (`idle`), waiting after a failed step
 * (`backoff`), or ended: its range complete or caught up (`done`), stopped, or ended by an error (`failed`).
 */
export type LoopPhase = "off" | "ready" | "starting" | "running" | "idle" | "backoff" | "done" | "stopped" | "failed";

export interface LoopStatus<B> {
  phase: LoopPhase;
  lastBatch: B | undefined;
  /** The last error, endpoints without userinfo, query or fragment; cleared by a successful step. */
  lastError: string | undefined;
  /** Consecutive failed steps. */
  failures: number;
  /** Clock time the current wait ends (phase `idle` or `backoff`). */
  waitUntil: number | undefined;
}

export interface EngineStatus {
  started: boolean;
  stopping: boolean;
  sync: LoopStatus<SyncOnceResult> & {
    /** The configured or resolved first height of a first run (`undefined`: genesis, or not resolved yet). */
    startHeight: number | undefined;
    endHeight: number | undefined;
  };
  scan: LoopStatus<ScanOnceResult> & { scanner: ScannerState };
  api: { inFlight: number; maxConcurrentRequests: number };
}

// ── Engine ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface IndexerEngine {
  /** Creates the configured loops' schemas and starts the loops. Rejects (and `finished` with it) when that fails. */
  start(): Promise<void>;
  /** Ends the loops; resolves once their steps in flight have ended. */
  stop(): Promise<void>;
  /** Settles once every loop has ended; rejects with the error that ended one (the sync's first). */
  readonly finished: Promise<void>;
  /** One API request (see `api.ts`). */
  handle(method: string, target: string): Promise<ApiResponse>;
  /** What `/v1/status` reports as `scanner`. */
  scannerState(): ScannerState;
  status(): EngineStatus;
  /** The archive's stored sync cursor (the archive schema must exist), or `undefined` without a sync. */
  syncCursor(): Promise<SyncCursor | undefined>;
  /** The scan's stored cursor (the `mip0018` schema must exist), or `undefined` without a scan. */
  scanCursor(): Promise<ScanCursor | undefined>;
  /** Adds a listener; returns the function that removes it. */
  subscribe(listener: (event: EngineEvent) => void): () => void;
}

const DEFAULTS = {
  syncMaxBlocks: 200,
  syncConcurrency: 4,
  syncTimeoutMs: 30_000,
  syncIdleMs: 10_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  backoffMaxAttempts: 8,
  scanBatch: 100,
  scanIdleMs: 2_000,
} as const;

/** Ceiling of the scan loop's error back-off. */
const SCAN_MAX_BACKOFF_MS = 60_000;

function checkHeight(what: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    throw new RangeError(`${what} must be a non-negative safe integer, got ${value}`);
}

function checkPositive(what: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    throw new RangeError(`${what} must be a positive integer of milliseconds, got ${value}`);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type SyncModule = typeof import("../../chain-archive-sync/sync-service.js");

export function createIndexerEngine(opts: EngineOptions): IndexerEngine {
  const syncCfg = opts.sync;
  const scanCfg = opts.scan;
  if (syncCfg !== undefined) {
    if (typeof syncCfg.startHeight !== "function") checkHeight("sync.startHeight", syncCfg.startHeight);
    checkHeight("sync.endHeight", syncCfg.endHeight);
    if (typeof syncCfg.startHeight === "number" && syncCfg.endHeight !== undefined && syncCfg.endHeight < syncCfg.startHeight)
      throw new RangeError(`sync.endHeight ${syncCfg.endHeight} is below sync.startHeight ${syncCfg.startHeight}`);
    checkPositive("sync.idleMs", syncCfg.idleMs);
  }
  if (scanCfg !== undefined) {
    if (scanCfg.mode !== undefined && scanCfg.mode !== "follow" && scanCfg.mode !== "drain")
      throw new RangeError(`scan.mode must be "follow" or "drain", got ${String(scanCfg.mode)}`);
    checkPositive("scan.idleMs", scanCfg.idleMs);
  }

  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? Math.random;
  const schedule: EngineScheduler = opts.schedule ?? ((_kind, step) => step());
  const archiveSql = opts.archiveSql ?? opts.sql;
  const archiveSchema = opts.archiveSchema ?? "chain_archive";
  // The node and indexer clients call their fetch as a method; a browser's global fetch refuses that, so the clients
  // always get this plain function.
  const fetchImpl: typeof fetch = (input, init) => (opts.fetch ?? globalThis.fetch)(input, init);

  const stopper = new AbortController();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) stopper.abort();
    else opts.signal.addEventListener("abort", () => stopper.abort(), { once: true });
  }

  const listeners = new Set<(event: EngineEvent) => void>();
  if (opts.onEvent !== undefined) listeners.add(opts.onEvent);
  function emit<S extends EngineEvent["source"], N extends EventOf<S, EngineEvent["event"]>["event"]>(
    source: S, event: N, fields: EventOf<S, N>["fields"],
  ): void {
    const e = { at: clock.now(), source, event, fields } as EngineEvent;
    for (const l of [...listeners]) l(e);
  }

  // State read by status().
  let started = false;
  let starting: Promise<void> | undefined;
  let loops: Promise<unknown> | undefined;
  let scanner: ScannerState = scanCfg === undefined ? "off" : "following";
  const loopStatus = <B>(configured: boolean): LoopStatus<B> =>
    ({ phase: configured ? "ready" : "off", lastBatch: undefined, lastError: undefined, failures: 0, waitUntil: undefined });
  const syncStatus = loopStatus<SyncOnceResult>(syncCfg !== undefined);
  const scanStatus = loopStatus<ScanOnceResult>(scanCfg !== undefined);
  let syncStart = typeof syncCfg?.startHeight === "number" ? syncCfg.startHeight : undefined;
  let apiInFlight = 0;
  let syncService: ChainArchiveSyncService | undefined;
  let scanService: Mip0018Scanner | undefined;
  let syncModule: Promise<SyncModule> | undefined;

  const handler = createMip0018Handler({
    sql: opts.sql,
    network: opts.network,
    ...(opts.schema === undefined ? {} : { schema: opts.schema }),
    ...(opts.archiveSchema === undefined ? {} : { archiveSchema: opts.archiveSchema }),
    ...(opts.genesisHash === undefined ? {} : { genesisHash: opts.genesisHash }),
    ...(opts.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: opts.maxConcurrentRequests }),
    scannerState: () => scanner,
    log: (line) => emit("api", "log", { line }),
  });

  let settle!: { resolve: () => void; reject: (e: unknown) => void };
  const finished = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
  finished.catch(() => {}); // a host that never awaits it gets no unhandled rejection; awaiting it still rejects

  async function wait(status: LoopStatus<unknown>, phase: "idle" | "backoff", ms: number): Promise<void> {
    status.phase = phase;
    status.waitUntil = clock.now() + ms;
    try {
      await clock.sleep(ms, stopper.signal);
    } finally {
      status.waitUntil = undefined;
    }
  }

  const loadSync = (): Promise<SyncModule> => (syncModule ??= import("../../chain-archive-sync/sync-service.js"));

  function newSyncService(mod: SyncModule, startHeight: number | undefined, withLoopOptions: boolean): ChainArchiveSyncService {
    const c = syncCfg!;
    const pacing = c.minIntervalMs === undefined ? {} : { minIntervalMs: c.minIntervalMs };
    const endpoints = [c.nodeUrl, c.indexerUrl];
    const b = c.backoff ?? {};
    return new mod.ChainArchiveSyncService({
      sql: archiveSql,
      net: opts.network,
      schema: archiveSchema,
      node: { url: c.nodeUrl, fetchImpl, timeoutMs: c.timeoutMs ?? DEFAULTS.syncTimeoutMs, ...pacing },
      indexer: { url: c.indexerUrl, fetchImpl, timeoutMs: c.timeoutMs ?? DEFAULTS.syncTimeoutMs, ...pacing },
      ...(startHeight === undefined ? {} : { startHeight }),
      ...(withLoopOptions && c.endHeight !== undefined ? { endHeight: c.endHeight } : {}),
      concurrency: c.concurrency ?? DEFAULTS.syncConcurrency,
      signal: stopper.signal,
      backoff: {
        baseDelayMs: b.baseDelayMs ?? DEFAULTS.backoffBaseMs,
        maxDelayMs: b.maxDelayMs ?? DEFAULTS.backoffMaxMs,
        maxAttempts: b.maxAttempts ?? DEFAULTS.backoffMaxAttempts,
        ...(b.jitter === undefined ? {} : { jitter: b.jitter }),
        sleep: (ms) => clock.sleep(ms, stopper.signal),
        // Every throttling answer is reported, with the status that caused the wait.
        onRetry: (info) => emit("sync", "backoff", {
          operation: info.operation, attempt: info.attempt, maxAttempts: info.maxAttempts,
          delayMs: info.delayMs, httpStatus: info.httpStatus, throttled: info.throttled,
          message: publicErrorMessage(info.message, endpoints),
        }),
      },
    });
  }

  /** The sync loop: resolves the first height when asked to, then batches until stopped, refused or complete. */
  async function runSync(mod: SyncModule): Promise<void> {
    const c = syncCfg!;
    const signal = stopper.signal;
    const endpoints = [c.nodeUrl, c.indexerUrl];
    const maxBlocks = c.maxBlocks ?? DEFAULTS.syncMaxBlocks;
    const backoffBaseMs = c.backoff?.baseDelayMs ?? DEFAULTS.backoffBaseMs;
    const backoffMaxMs = c.backoff?.maxDelayMs ?? DEFAULTS.backoffMaxMs;
    try {
      syncStatus.phase = "starting";
      const resolveStart = typeof c.startHeight === "function" ? c.startHeight : undefined;
      const cursor = resolveStart !== undefined && !signal.aborted ? await newSyncService(mod, undefined, false).getSyncCursor() : undefined;
      // A resumed archive reports its own first height; only a new one asks for it.
      if (cursor !== undefined) syncStart = cursor.startHeight;
      else if (resolveStart !== undefined && !signal.aborted) {
        let resolved: number;
        try {
          resolved = await resolveStart(signal);
        } catch (e) {
          if (signal.aborted) {
            syncStatus.phase = "stopped";
            return;
          }
          throw e;
        }
        if (signal.aborted) {
          syncStatus.phase = "stopped";
          return;
        }
        checkHeight("the resolved sync start height", resolved);
        syncStart = resolved;
      }
      const service = newSyncService(mod, syncStart, true);
      syncService = service;
      emit("sync", "start", {
        net: opts.network,
        schema: archiveSchema,
        nodeUrl: publicEndpoint(c.nodeUrl),
        indexerUrl: publicEndpoint(c.indexerUrl),
        from: syncStart ?? "genesis",
        to: c.endHeight ?? "follow",
        maxBlocks,
        concurrency: service.fetchConcurrency,
        minIntervalMs: service.minIntervalMs,
        cursor: (await service.getSyncCursor()) ?? null,
      });
      // A failed batch backs off exponentially (with jitter) instead of hammering a throttling endpoint, and the
      // back-off resets once a batch succeeds. Only a stop, a completed range or a refused range ends the loop.
      let loopBackoffMs = backoffBaseMs;
      while (!signal.aborted) {
        syncStatus.phase = "running";
        try {
          const result = await schedule("sync", () => service.syncOnce({ maxBlocks }));
          const height = await service.getSyncedHeight();
          syncStatus.lastBatch = result;
          syncStatus.lastError = undefined;
          syncStatus.failures = 0;
          emit("sync", "batch", {
            height, ingested: result.ingestedBlocks,
            from: result.fromHeight, to: result.toHeight, tip: result.targetTipHeight,
            retries: result.retries, throttled: result.throttled, elapsedMs: result.elapsedMs,
          });
          loopBackoffMs = backoffBaseMs;
          if (result.reachedEnd) {
            emit("sync", "range-complete", { to: c.endHeight, height: await service.getSyncedHeight() });
            syncStatus.phase = "done";
            return;
          }
          if (result.ingestedBlocks === 0) await wait(syncStatus, "idle", c.idleMs ?? DEFAULTS.syncIdleMs);
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof mod.SyncRangeError) {
            emit("sync", "range-refused", { message: error.message });
            throw error;
          }
          const message = publicErrorMessage(error, endpoints);
          syncStatus.lastError = message;
          syncStatus.failures++;
          emit("sync", "error", { message, retryMs: loopBackoffMs });
          await wait(syncStatus, "backoff", Math.round(loopBackoffMs / 2 + random() * (loopBackoffMs / 2)));
          loopBackoffMs = Math.min(loopBackoffMs * 2, backoffMaxMs);
        }
      }
      syncStatus.phase = "stopped";
    } catch (e) {
      syncStatus.phase = "failed";
      syncStatus.lastError = publicErrorMessage(e, endpoints);
      throw e;
    } finally {
      emit("sync", "stop", {});
    }
  }

  /** The scan loop: steps until stopped (follow) or until caught up (drain). */
  async function runScan(s: Mip0018Scanner): Promise<void> {
    const c = scanCfg!;
    const signal = stopper.signal;
    const drain = c.mode === "drain";
    const batch = c.batch ?? DEFAULTS.scanBatch;
    const idle = c.idleMs ?? DEFAULTS.scanIdleMs;
    let failures = 0;
    while (!signal.aborted) {
      scanStatus.phase = "running";
      try {
        const r = await schedule("scan", () => s.scanOnce({ maxBlocks: batch }));
        scanner = "following";
        failures = 0;
        scanStatus.lastBatch = r;
        scanStatus.lastError = undefined;
        scanStatus.failures = 0;
        emit("scan", "batch", r);
        if (drain) {
          if (r.reachedEnd || r.scannedBlocks === 0) {
            scanStatus.phase = "done";
            return;
          }
          continue;
        }
        if (r.scannedBlocks > 0) continue;
        await wait(scanStatus, "idle", idle);
      } catch (e) {
        scanner = "stalled";
        failures++;
        scanStatus.lastError = messageOf(e);
        scanStatus.failures = failures;
        if (drain) {
          scanStatus.phase = "failed";
          emit("scan", "error", { error: messageOf(e), failures, retryMs: null });
          throw e;
        }
        const retryMs = Math.min(SCAN_MAX_BACKOFF_MS, idle * 5 ** Math.min(failures - 1, 4));
        emit("scan", "error", { error: messageOf(e), failures, retryMs });
        await wait(scanStatus, "backoff", retryMs);
      }
    }
    scanStatus.phase = "stopped";
  }

  async function newScanner(): Promise<Mip0018Scanner> {
    // Loaded only when scanning: the scan needs ledger-v9 (WASM); the API alone does not.
    const { Mip0018Scanner: Scanner } = await import("../mip0018/scan.ts");
    const c = scanCfg!;
    return new Scanner({
      sql: opts.sql,
      network: opts.network,
      ...(opts.schema === undefined ? {} : { schema: opts.schema }),
      ...(opts.archiveSchema === undefined ? {} : { archiveSchema: opts.archiveSchema }),
      ...(c.fromHeight === undefined ? {} : { fromHeight: c.fromHeight }),
      ...(c.toHeight === undefined ? {} : { toHeight: c.toHeight }),
    });
  }

  async function boot(): Promise<void> {
    let mod: SyncModule | undefined;
    // The archive first: the scan reads it.
    if (syncCfg !== undefined) {
      syncStatus.phase = "starting";
      try {
        mod = await loadSync();
        const { bootstrapChainArchiveSchema } = await import("../../chain-archive-sync/bootstrap.js");
        await bootstrapChainArchiveSchema(archiveSql, archiveSchema);
      } catch (e) {
        syncStatus.phase = "failed";
        syncStatus.lastError = publicErrorMessage(e, [syncCfg.nodeUrl, syncCfg.indexerUrl]);
        emit("sync", "stop", {});
        throw e;
      }
    }
    let s: Mip0018Scanner | undefined;
    if (scanCfg !== undefined) {
      scanStatus.phase = "starting";
      try {
        s = await newScanner();
        await s.bootstrap();
        scanService = s;
      } catch (e) {
        scanStatus.phase = "failed";
        scanStatus.lastError = messageOf(e);
        if (mod !== undefined) {
          syncStatus.phase = "stopped";
          emit("sync", "stop", {});
        }
        throw e;
      }
    }
    const tasks: Promise<void>[] = [];
    if (mod !== undefined) tasks.push(runSync(mod));
    if (s !== undefined) tasks.push(runScan(s));
    // Settles when every loop has ended (a loop that failed does not end the others).
    loops = Promise.allSettled(tasks).then((results) => {
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed === undefined) settle.resolve();
      else settle.reject(failed.reason);
    });
  }

  return {
    start(): Promise<void> {
      if (started) return Promise.reject(new Error("the engine has already been started"));
      started = true;
      starting = boot();
      starting.catch((e: unknown) => settle.reject(e));
      return starting;
    },

    async stop(): Promise<void> {
      stopper.abort();
      if (starting !== undefined) await starting.catch(() => {});
      if (loops !== undefined) await loops;
    },

    finished,

    async handle(method: string, target: string): Promise<ApiResponse> {
      const startedAt = clock.now();
      apiInFlight++;
      let r: ApiResponse;
      try {
        r = await handler.handle(method, target);
      } finally {
        apiInFlight--;
      }
      emit("api", "request", { method, status: r.status, busy: r.status === 503 && r.headers["retry-after"] !== undefined, ms: clock.now() - startedAt });
      return r;
    },

    scannerState: () => scanner,

    status(): EngineStatus {
      return {
        started,
        stopping: stopper.signal.aborted,
        sync: { ...syncStatus, startHeight: syncStart, endHeight: syncCfg?.endHeight },
        scan: { ...scanStatus, scanner },
        api: { inFlight: apiInFlight, maxConcurrentRequests: opts.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS },
      };
    },

    async syncCursor(): Promise<SyncCursor | undefined> {
      if (syncCfg === undefined) return undefined;
      return (syncService ?? newSyncService(await loadSync(), undefined, false)).getSyncCursor();
    },

    async scanCursor(): Promise<ScanCursor | undefined> {
      if (scanCfg === undefined) return undefined;
      return (scanService ?? (await newScanner())).getCursor();
    },

    subscribe(listener: (event: EngineEvent) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
