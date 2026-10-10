/**
 * A whole system snapshot (`../../engine/system-snapshot.ts`) with distinctive values, for the tests of the pages that
 * draw one (each test changes what it looks at): validated against the schema.
 */
import { type SystemSnapshot, SystemSnapshotSchema } from "../../engine/system-snapshot.ts";

export const T0 = Date.UTC(2026, 9, 10, 8, 15, 2, 0);

/** The snapshot, with `over` replacing whole sections. */
export function snapshotFixture(over: Partial<SystemSnapshot> = {}): SystemSnapshot {
  const endpoint = (n: number) => ({
    requests: 1000 + n, inFlight: 1, ok: 990 + n, http429: 2, http403: 1, http5xx: 3, httpOther: 0, transportErrors: 4, aborted: 0, retries: 7,
    throttledRetries: 3, lastRequestAt: T0 - 1_500, lastOkAt: T0 - 1_500, lastFailureAt: T0 - 65_000,
  });
  const base: SystemSnapshot = {
    format: "umbradb-system-snapshot",
    version: 1,
    generatedAt: T0,
    role: "leader",
    relayedAt: null,
    overview: {
      health: { state: "catching-up", label: "catching up", reason: "scan 1234 blocks behind the finalized tip" },
      startHeight: 714485,
      archiveHeight: 715183,
      scanHeight: 714900,
      finalizedTip: 716134,
      finalizedTipAt: T0 - 2_000,
      lag: { blocks: 1234, archiveBlocks: 951, scanBehindArchive: 283, seconds: 7404, secondsPerBlock: 6, catchUpSeconds: 61.7 },
    },
    configuration: {
      network: "stagenet",
      genesisHash: "0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491",
      endpoints: { node: "https://rpc.stagenet.shielded.tools/", indexer: "https://indexer.stagenet.shielded.tools/api/v4/graphql" },
      schemas: { archive: "chain_archive", mip0018: "mip0018" },
      sync: { maxBlocks: 20, concurrency: 4, minIntervalMs: { node: 250, indexer: 250 }, timeoutMs: 30_000, idleMs: 6_000 },
      scan: { mode: "follow", batch: 10, idleMs: 2_000, maxBackoffMs: 60_000, fromHeight: null, toHeight: null },
      retry: { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 8, jitter: true },
      start: { mode: "tip", startHeight: 714485, endHeight: null, autoStart: true },
      durability: "non-durable",
      watchdogLimitMs: 30_000,
      api: { maxConcurrentRequests: 8 },
      build: {
        appCommit: "0123456789abcdef0123456789abcdef01234567", pgliteVersion: "0.5.8", postgresVersion: "18.3", ledgerVersion: "1.0.0-rc.3",
        mip: { id: "MIP-0018", commit: "274a84f221bcfc17e4b73e2c8b32fd8c028ea092" }, vendored: { repository: "https://github.com/midnight-experiments/mip-0018", commit: "daec1f19747b09f4e245885ab0dd9ecc789a82ce" },
      },
    },
    sync: {
      phase: "running", archiveStart: 714485, archiveHeight: 715183, nodeFinalizedHeight: 716140, indexerTipHeight: 716134, finalizedTip: 716134,
      blocksPerSecond: 1.3712, ingestedSinceStart: 699, endpoints: { node: endpoint(10), indexer: endpoint(5) }, lastSuccessAt: T0 - 800, nextAttemptAt: T0 + 3_000,
      lastError: { message: "chain_getBlock: HTTP 503 from https://rpc.stagenet.shielded.tools/", at: T0 - 65_000 }, failures: 0,
    },
    scan: {
      phase: "running", scanner: "following", startHeight: 714485, nextHeight: 714901, lagBehindArchive: 283, blocksPerSecond: 12.5, scannedSinceStart: 416,
      totals: { transactions: 69, events: 31, mints: 9, sightings: 12, actions: 140 }, unresolvedEvents: 0, lastSuccessAt: T0 - 300, nextAttemptAt: null, lastError: null, failures: 0,
    },
    databases: {
      dataDir: "opfs-ahp://umbradb-stagenet", serverVersion: "18.3", fsync: "off", durability: "non-durable", databaseBytes: 10_551_419,
      schemas: [
        {
          name: "chain_archive", exists: true,
          migrations: [{ name: "000_schema", appliedAt: T0 - 3_600_000 }, { name: "001_chain_archive_core", appliedAt: T0 - 3_599_000 }],
          tables: [
            { name: "blocks", kind: "partitioned", partitionOf: null, estimatedRows: null, totalBytes: 0, exactRows: 699, partitions: { count: 2, estimatedRows: 699, totalBytes: 4_259_840 } },
            { name: "blocks_p0", kind: "partition", partitionOf: "blocks", estimatedRows: 699, totalBytes: 4_218_880, exactRows: 699, partitions: null },
            { name: "watermarks", kind: "table", partitionOf: null, estimatedRows: 1, totalBytes: 16_384, exactRows: null, partitions: null },
          ],
        },
        { name: "mip0018", exists: false, migrations: [], tables: [] },
      ],
      collectedAt: T0 - 12_000, statements: [{ label: "settings", ms: 1.2 }, { label: "tables:chain_archive", ms: 3.9 }], exactRowsAt: T0 - 11_000, error: null,
    },
    storage: {
      usageBytes: 1_239_700_000, quotaBytes: 11_977_000_000, persisted: false, estimatedAt: T0 - 400, pauseAtBytes: 10_779_300_000, paused: false, pausedReason: null,
      databaseBytes: 10_551_419, bytesPerBlock: { store: 15_095.02, growth: 5_918.4 },
    },
    api: { inFlight: 2, maxConcurrentRequests: 8, served: 12_345, byStatus: { "2xx": 12_000, "3xx": 0, "4xx": 340, "5xx": 5 }, busy: 3, latencyMs: { p50: 1.04, p95: 15.66, samples: 1000, window: 1000 } },
    engine: {
      started: true, stopping: false, connectedTabs: 2, startedAt: T0 - 3_725_000, uptimeMs: 3_725_000, watchdogRestarts: 1,
      lastWatchdogRestart: { at: T0 - 90_000, reason: "the engine worker sent nothing for 4487 ms (limit 2000 ms)" }, pgliteReopens: 0, lastReopenAt: null,
      failedStatementsSinceOpen: 3, failedStatementsTotal: 5,
    },
    browser: { browser: "Chromium 153", checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: false } },
    snapshots: {
      lastExport: {
        at: T0 - 60_000, sha256: "a".repeat(64), bytes: 10_407_424,
        manifest: { network: "stagenet", height: 715183, blockHash: "90893e25", schemaVersions: { chain_archive: ["000", "001", "002"], mip0018: ["000", "001"] }, pgliteVersion: "0.5.8" },
      },
      lastImport: null,
    },
    logs: [
      { seq: 9, at: T0 - 1_000, level: "error", source: "sync", text: "newest \u202Eline" },
      { seq: 8, at: T0 - 5_000, level: "info", source: "scan", text: "older line" },
    ],
    collection: { watching: true, countersEveryMs: 2_000, databaseEveryMs: 30_000, statusAt: T0 - 100, statusError: null },
  };
  return SystemSnapshotSchema.parse({ ...base, ...over });
}

