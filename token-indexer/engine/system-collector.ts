/**
 * The `system` snapshot collector: assembles {@link SystemSnapshot}s from the engine (`status()`, `/v1/status` through
 * its own API handler), the telemetry's counters and logs, the database's catalog statistics and what the host
 * supplies (storage figures, browser capabilities, snapshot records, connected tabs, the tab's role).
 *
 * - **Cadence:** while at least one viewer {@link SystemCollector.watch}es, the counters and `/v1/status` are read
 *   every `countersEveryMs` (default 2 s) and the catalog statistics every `databaseEveryMs` (default 30 s); each
 *   collection hands the viewers one snapshot. With no viewer nothing is collected: no statement, no timer (a host
 *   stops watching when its status page is hidden or closed). {@link SystemCollector.refresh} collects once on demand
 *   (for example for "Download diagnostics"), with exact row counts only when asked.
 * - **Cost:** collections never overlap. The heights come from one `/v1/status` request, which counts as an API
 *   request like any other (it takes a slot of the request cap and is refused `BUSY` when the cap is full; the
 *   previous answer is then kept and the failure reported). The catalog statistics are separate autocommit statements
 *   with a turn of the event loop between them (`database-stats.ts`).
 * - **Output:** every snapshot is redacted and validated against `SystemSnapshotSchema` before it leaves.
 */
import { DEFAULT_BACKOFF } from "../../chain-archive-sync/retry.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { type DurabilityMode, durabilityModeOf } from "../../src/postgres/durability-probe.js";
import { z } from "zod";
import { DEFAULT_SCHEMAS } from "../mip0018/api-views.ts";
import { collectDatabaseStats, countRowsExact, type DatabaseStats, type StatementTiming } from "./database-stats.ts";
import { ENGINE_DEFAULTS, type EngineClock, type EngineOptions, type IndexerEngine, SCAN_MAX_BACKOFF_MS, systemClock } from "./engine.ts";
import {
  type BrowserInfo,
  type ConfigurationJson,
  publicUrl,
  redactSnapshot,
  type SnapshotsInfo,
  SYSTEM_SNAPSHOT_FORMAT,
  SYSTEM_SNAPSHOT_VERSION,
  type SystemSnapshot,
} from "./system-snapshot.ts";
import { deriveHealth, type EngineTelemetry, type TelemetryCounters } from "./telemetry.ts";

export const DEFAULT_COUNTERS_EVERY_MS = 2_000;
export const DEFAULT_DATABASE_EVERY_MS = 30_000;

/** What the configuration section shows beyond the engine's options. */
export interface ConfigurationExtras {
  /** `tip`: the first height is resolved at the finalized tip when the store is created; `range`: a chosen start. */
  startMode: "tip" | "range";
  autoStart: boolean;
  /** Default: `/v1/status` `durability`, else the mode the client was created with. */
  durability?: DurabilityMode | null;
  watchdogLimitMs?: number | null;
  build?: { appCommit?: string | null; pgliteVersion?: string | null; ledgerVersion?: string | null };
}

/** What a browser host reads from `navigator.storage` and its quota pause. */
export interface StorageReading {
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
  pauseAtBytes: number | null;
  paused: boolean;
  pausedReason: string | null;
}

export interface SystemCollectorOptions {
  engine: Pick<IndexerEngine, "status" | "handle">;
  telemetry: EngineTelemetry;
  /** The options the engine was created with (the configuration section describes them). */
  engineOptions: EngineOptions;
  extras: ConfigurationExtras;
  /** Client the catalog statistics are read with (default the engine's `sql`). */
  sql?: UmbraDBSql;
  clock?: EngineClock;
  /** Monotonic milliseconds for statement durations (default `performance.now`). */
  monotonic?: () => number;
  /** Runs between two statistics statements (default: one macrotask). */
  between?: () => Promise<void>;
  countersEveryMs?: number;
  databaseEveryMs?: number;
  /** Blocks behind the target within which the engine counts as following. */
  followLagBlocks?: number;
  /** The data directory as the host opened it. */
  dataDir?: string | null;
  role?: () => "leader" | "follower";
  connectedTabs?: () => number | null;
  storage?: () => Promise<StorageReading>;
  browser?: () => BrowserInfo | null;
  snapshots?: () => SnapshotsInfo;
}

export interface SystemCollector {
  /**
   * Adds a viewer: collection runs while at least one watches, and each collection is handed to every viewer (the
   * first at once). `onError` receives a collection that failed. Returns the function that removes the viewer.
   */
  watch(listener: (snapshot: SystemSnapshot) => void, onError?: (error: unknown) => void): () => void;
  /** Collects once now: the counters and `/v1/status`, the catalog statistics when `database` is set or due, and exact
   *  row counts only when `exactCounts` is set. */
  refresh(opts?: { database?: boolean; exactCounts?: boolean }): Promise<SystemSnapshot>;
  /** The latest snapshot, or `null` before the first collection. */
  latest(): SystemSnapshot | null;
  watching(): boolean;
  /** Ends collection for good. */
  close(): void;
}

/** The part of `/v1/status` the snapshot reads (other fields are ignored). */
const StatusReadSchema = z.object({
  network: z.string(),
  genesisHash: z.string().nullable(),
  startHeight: z.number().nullable(),
  indexedHeight: z.number().nullable(),
  archiveHeight: z.number().nullable(),
  mip: z.object({ id: z.string(), commit: z.string() }),
  vendored: z.object({ repository: z.string(), commit: z.string() }),
  scanner: z.enum(["following", "stalled", "off"]),
  unresolvedEvents: z.number().nullable(),
  durability: z.enum(["durable", "non-durable"]).optional(),
});
type StatusRead = z.infer<typeof StatusReadSchema>;

/** The configuration section from the engine's options, its defaults and the host's extras. */
export function describeConfiguration(
  o: EngineOptions,
  extras: ConfigurationExtras,
  live: { status: StatusRead | null; counters: TelemetryCounters | null; db: DatabaseStats | null; startHeight: number | undefined; maxConcurrentRequests: number },
): ConfigurationJson {
  const s = o.sync;
  const c = o.scan;
  const b = s?.backoff ?? {};
  return {
    network: live.status?.network ?? o.network,
    genesisHash: live.status?.genesisHash ?? o.genesisHash ?? null,
    endpoints: { node: s === undefined ? null : publicUrl(s.nodeUrl), indexer: s === undefined ? null : publicUrl(s.indexerUrl) },
    schemas: { archive: o.archiveSchema ?? DEFAULT_SCHEMAS.archiveSchema, mip0018: o.schema ?? DEFAULT_SCHEMAS.schema },
    sync: s === undefined ? null : {
      maxBlocks: s.maxBlocks ?? ENGINE_DEFAULTS.syncMaxBlocks,
      concurrency: Math.min(s.concurrency ?? ENGINE_DEFAULTS.syncConcurrency, 16),
      minIntervalMs: live.counters?.sync.minIntervalMs ?? null,
      timeoutMs: s.timeoutMs ?? ENGINE_DEFAULTS.syncTimeoutMs,
      idleMs: s.idleMs ?? ENGINE_DEFAULTS.syncIdleMs,
    },
    scan: c === undefined ? null : {
      mode: c.mode ?? "follow",
      batch: c.batch ?? ENGINE_DEFAULTS.scanBatch,
      idleMs: c.idleMs ?? ENGINE_DEFAULTS.scanIdleMs,
      maxBackoffMs: SCAN_MAX_BACKOFF_MS,
      fromHeight: c.fromHeight ?? null,
      toHeight: c.toHeight ?? null,
    },
    retry: s === undefined ? null : {
      baseDelayMs: b.baseDelayMs ?? ENGINE_DEFAULTS.backoffBaseMs,
      maxDelayMs: b.maxDelayMs ?? ENGINE_DEFAULTS.backoffMaxMs,
      maxAttempts: b.maxAttempts ?? ENGINE_DEFAULTS.backoffMaxAttempts,
      jitter: b.jitter ?? DEFAULT_BACKOFF.jitter,
    },
    start: {
      mode: extras.startMode,
      startHeight: live.startHeight ?? null,
      endHeight: s?.endHeight ?? null,
      autoStart: extras.autoStart,
    },
    durability: live.status?.durability ?? extras.durability ?? durabilityModeOf(o.sql),
    watchdogLimitMs: extras.watchdogLimitMs ?? null,
    api: { maxConcurrentRequests: live.maxConcurrentRequests },
    build: {
      appCommit: extras.build?.appCommit ?? null,
      pgliteVersion: extras.build?.pgliteVersion ?? live.db?.pgliteVersion ?? null,
      postgresVersion: live.db?.serverVersion ?? null,
      ledgerVersion: extras.build?.ledgerVersion ?? null,
      mip: live.status === null ? null : { ...live.status.mip },
      vendored: live.status === null ? null : { ...live.status.vendored },
    },
  };
}

const sub = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a === null || a === undefined || b === null || b === undefined ? null : Math.max(0, a - b);

export function createSystemCollector(opts: SystemCollectorOptions): SystemCollector {
  const clock = opts.clock ?? systemClock;
  const sql = opts.sql ?? opts.engineOptions.sql;
  const schemas = [opts.engineOptions.archiveSchema ?? DEFAULT_SCHEMAS.archiveSchema, opts.engineOptions.schema ?? DEFAULT_SCHEMAS.schema];
  const countersEveryMs = opts.countersEveryMs ?? DEFAULT_COUNTERS_EVERY_MS;
  const databaseEveryMs = opts.databaseEveryMs ?? DEFAULT_DATABASE_EVERY_MS;
  const statsOpts = {
    ...(opts.monotonic === undefined ? {} : { monotonic: opts.monotonic }),
    ...(opts.between === undefined ? {} : { between: opts.between }),
  };

  let status: { json: StatusRead; at: number } | null = null;
  let statusError: string | null = null;
  let db: DatabaseStats | null = null;
  let dbAt: number | null = null;
  let dbError: string | null = null;
  let dbStatements: StatementTiming[] = [];
  let exact: Map<string, number> | null = null;
  let exactAt: number | null = null;
  let storage: { reading: StorageReading; at: number } | null = null;
  let growthBase: { bytes: number; archiveHeight: number } | null = null;
  let latest: SystemSnapshot | null = null;

  const viewers = new Map<(s: SystemSnapshot) => void, ((e: unknown) => void) | undefined>();
  let stopper = new AbortController();
  let looping = false;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function readStatus(): Promise<void> {
    const r = await opts.engine.handle("GET", "/v1/status");
    if (r.status !== 200) {
      let code = "";
      try {
        code = (JSON.parse(r.body) as { error?: { code?: string } }).error?.code ?? "";
      } catch {
        // a HEAD-like or empty body
      }
      statusError = `/v1/status answered ${r.status}${code === "" ? "" : ` ${code}`}`;
      return;
    }
    status = { json: StatusReadSchema.parse(JSON.parse(r.body)), at: clock.now() };
    statusError = null;
  }

  async function readDatabase(exactCounts: boolean): Promise<void> {
    try {
      const stats = await collectDatabaseStats(sql, schemas, statsOpts);
      db = stats;
      dbAt = clock.now();
      dbError = null;
      dbStatements = [...stats.statements];
      if (exactCounts) {
        const r = await countRowsExact(sql, stats, statsOpts);
        exact = r.counts;
        exactAt = clock.now();
        dbStatements.push(...r.statements);
      }
    } catch (e) {
      dbError = message(e);
    }
  }

  function assemble(): SystemSnapshot {
    const now = clock.now();
    const c = opts.telemetry.counters();
    const es = opts.engine.status();
    const st = status?.json ?? null;
    const startHeight = st?.startHeight ?? null;
    const archiveHeight = st?.archiveHeight ?? null;
    const scanHeight = st?.indexedHeight ?? null;
    const scanned = scanHeight ?? (startHeight === null ? null : startHeight - 1);
    const tip = c.sync.tip?.height ?? null;
    const lagBlocks = sub(tip, scanned);
    const quota = storage?.reading;
    const archiveStart = es.sync.startHeight ?? null;
    const archived = archiveHeight === null || archiveStart === null ? null : archiveHeight - archiveStart + 1;
    const databaseBytes = db?.databaseBytes ?? null;
    if (growthBase === null && databaseBytes !== null && archiveHeight !== null) growthBase = { bytes: databaseBytes, archiveHeight };
    const grown = growthBase === null || archiveHeight === null ? 0 : archiveHeight - growthBase.archiveHeight;
    const lastRetry = c.sync.lastRetry;
    const errorOf = (m: string | undefined, at: number | null) => (m === undefined ? null : { message: m, at });

    const snapshot: SystemSnapshot = {
      format: SYSTEM_SNAPSHOT_FORMAT,
      version: SYSTEM_SNAPSHOT_VERSION,
      generatedAt: now,
      role: opts.role?.() ?? "leader",
      relayedAt: null,
      overview: {
        health: deriveHealth({
          fatal: c.engine.fatal,
          engine: {
            started: es.started,
            stopping: es.stopping,
            sync: { phase: es.sync.phase, lastError: es.sync.lastError, endHeight: es.sync.endHeight },
            scan: { phase: es.scan.phase, lastError: es.scan.lastError, scanner: es.scan.scanner },
          },
          network: {
            retryingNow: c.sync.retryingNow,
            failedOnNetwork: c.sync.failedOnNetwork,
            lastRequestFailed: c.sync.lastRequestFailed,
            lastRetryMessage: lastRetry?.message ?? null,
          },
          quota: { paused: quota?.paused ?? false, reason: quota?.pausedReason ?? null },
          tip,
          archiveHeight,
          scanHeight,
          startHeight,
          ...(opts.followLagBlocks === undefined ? {} : { followLagBlocks: opts.followLagBlocks }),
        }),
        startHeight,
        archiveHeight,
        scanHeight,
        finalizedTip: tip,
        finalizedTipAt: c.sync.tip?.at ?? null,
        lag: {
          blocks: lagBlocks,
          archiveBlocks: sub(tip, archiveHeight),
          scanBehindArchive: sub(archiveHeight, scanned),
          seconds: lagBlocks === null || c.sync.secondsPerBlock === null ? null : lagBlocks * c.sync.secondsPerBlock,
          secondsPerBlock: c.sync.secondsPerBlock,
          catchUpSeconds: lagBlocks === null ? null : lagBlocks === 0 ? 0 : c.scan.blocksPerSecond > 0 ? lagBlocks / c.scan.blocksPerSecond : null,
        },
      },
      configuration: describeConfiguration(opts.engineOptions, opts.extras, {
        status: st, counters: c, db, startHeight: es.sync.startHeight, maxConcurrentRequests: es.api.maxConcurrentRequests,
      }),
      sync: {
        phase: es.sync.phase,
        archiveStart,
        archiveHeight,
        nodeFinalizedHeight: es.sync.lastBatch?.nodeFinalizedHeight ?? null,
        indexerTipHeight: es.sync.lastBatch?.indexerTipHeight ?? null,
        finalizedTip: tip,
        blocksPerSecond: c.sync.blocksPerSecond,
        ingestedSinceStart: c.sync.ingestedSinceStart,
        endpoints: c.sync.endpoints,
        lastSuccessAt: c.sync.lastSuccessAt,
        nextAttemptAt: es.sync.waitUntil ?? (c.sync.retryingNow && lastRetry !== null ? lastRetry.at + lastRetry.delayMs : null),
        lastError: errorOf(es.sync.lastError, c.sync.lastErrorAt),
        failures: es.sync.failures,
      },
      scan: {
        phase: es.scan.phase,
        scanner: st?.scanner ?? es.scan.scanner,
        startHeight,
        nextHeight: scanHeight === null ? startHeight : scanHeight + 1,
        lagBehindArchive: sub(archiveHeight, scanned),
        blocksPerSecond: c.scan.blocksPerSecond,
        scannedSinceStart: c.scan.scannedSinceStart,
        totals: c.scan.totals,
        unresolvedEvents: st?.unresolvedEvents ?? null,
        lastSuccessAt: c.scan.lastSuccessAt,
        nextAttemptAt: es.scan.waitUntil ?? null,
        lastError: errorOf(es.scan.lastError, c.scan.lastErrorAt),
        failures: es.scan.failures,
      },
      databases: {
        dataDir: opts.dataDir ?? null,
        serverVersion: db?.serverVersion ?? null,
        fsync: db?.fsync ?? null,
        durability: st?.durability ?? opts.extras.durability ?? durabilityModeOf(sql),
        databaseBytes,
        schemas: (db?.schemas ?? []).map((s) => ({
          name: s.name,
          exists: s.exists,
          migrations: s.migrations,
          tables: s.tables.map((t) => ({ ...t, exactRows: exact?.get(`${s.name}.${t.name}`) ?? null })),
        })),
        collectedAt: dbAt,
        statements: dbStatements,
        exactRowsAt: exactAt,
        error: dbError,
      },
      storage: {
        usageBytes: quota?.usageBytes ?? null,
        quotaBytes: quota?.quotaBytes ?? null,
        persisted: quota?.persisted ?? null,
        estimatedAt: storage?.at ?? null,
        pauseAtBytes: quota?.pauseAtBytes ?? null,
        paused: quota?.paused ?? false,
        pausedReason: quota?.pausedReason ?? null,
        databaseBytes,
        bytesPerBlock: {
          store: databaseBytes === null || archived === null || archived <= 0 ? null : databaseBytes / archived,
          growth: growthBase === null || databaseBytes === null || grown <= 0 ? null : (databaseBytes - growthBase.bytes) / grown,
        },
      },
      api: {
        inFlight: es.api.inFlight,
        maxConcurrentRequests: es.api.maxConcurrentRequests,
        served: c.api.served,
        byStatus: c.api.byStatus,
        busy: c.api.busy,
        latencyMs: c.api.latencyMs,
      },
      engine: {
        started: es.started,
        stopping: es.stopping,
        connectedTabs: opts.connectedTabs?.() ?? null,
        startedAt: c.startedAt,
        uptimeMs: Math.max(0, now - c.startedAt),
        watchdogRestarts: c.engine.watchdogRestarts,
        lastWatchdogRestart: c.engine.lastWatchdogRestart,
        pgliteReopens: c.engine.pgliteReopens,
        lastReopenAt: c.engine.lastReopenAt,
        failedStatementsSinceOpen: c.engine.failedStatementsSinceOpen,
        failedStatementsTotal: c.engine.failedStatementsTotal,
      },
      browser: opts.browser?.() ?? null,
      snapshots: opts.snapshots?.() ?? { lastExport: null, lastImport: null },
      logs: opts.telemetry.logs(),
      collection: {
        watching: viewers.size > 0,
        countersEveryMs,
        databaseEveryMs,
        statusAt: status?.at ?? null,
        statusError,
      },
    };
    return redactSnapshot(snapshot);
  }

  function collect(o: { database?: boolean; exactCounts?: boolean }): Promise<SystemSnapshot> {
    const run = async (): Promise<SystemSnapshot> => {
      try {
        await readStatus();
      } catch (e) {
        statusError = message(e);
      }
      const due = dbAt === null || clock.now() - dbAt >= databaseEveryMs;
      if (o.database === true || o.exactCounts === true || due) await readDatabase(o.exactCounts === true);
      if (opts.storage !== undefined) {
        try {
          storage = { reading: await opts.storage(), at: clock.now() };
        } catch {
          // the previous reading stays
        }
      }
      latest = assemble();
      return latest;
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  async function loop(): Promise<void> {
    looping = true;
    try {
      while (viewers.size > 0 && !closed) {
        try {
          const s = await collect({});
          for (const l of [...viewers.keys()]) l(s);
        } catch (e) {
          for (const onError of [...viewers.values()]) onError?.(e);
        }
        if (viewers.size === 0 || closed) break;
        await clock.sleep(countersEveryMs, stopper.signal);
      }
    } finally {
      looping = false;
    }
  }

  return {
    watch(listener, onError) {
      if (closed) throw new Error("the system collector is closed");
      viewers.set(listener, onError);
      if (stopper.signal.aborted) stopper = new AbortController();
      if (!looping) void loop();
      return () => {
        viewers.delete(listener);
        if (viewers.size === 0) stopper.abort();
      };
    },

    refresh(o = {}) {
      return collect(o);
    },

    latest: () => latest,

    watching: () => viewers.size > 0,

    close() {
      closed = true;
      viewers.clear();
      stopper.abort();
    },
  };
}
