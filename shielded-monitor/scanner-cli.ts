#!/usr/bin/env node
/**
 * `umbradb-shielded-monitor` — the relevance scanner process (organizer spec FR-026).
 *
 * A SEPARATE process from the archive ingester (`umbradb-archive-sync`) and from the private API
 * (Phase 4), by requirement, not by convention: FR-026 says the scanner and the API run as their
 * own processes, and FR-025 keeps B's only dependency on A the read contract.
 *
 * ── Two topologies (00009-08) ───────────────────────────────────────────────────────────────
 *
 * ```text
 *   SPLIT        MONITOR_PG -> B's own PostgreSQL  (shielded_monitor and nothing else)
 *                ARCHIVE_URL -> http://archive-read-api:8790
 *                No credential for A's database. No archive schema name. One egress URL.
 *                Several instances may run: each claims a monitor lease before working on it.
 *
 *   SINGLE-HOST  MONITOR_PG -> one PostgreSQL holding BOTH schemas
 *                ARCHIVE_SCHEMA -> chain_archive (read-only, through the read contract only)
 *                The mode this repository shipped before 00009-08, unchanged.
 * ```
 *
 * Setting `ARCHIVE_URL` together with `ARCHIVE_SCHEMA`/`ARCHIVE_PG` is REFUSED at startup: they
 * describe two different deployments, and leaving the loser in the environment documents a
 * topology that is not in effect (see `scanner-config.ts`).
 *
 * It writes to `shielded_monitor.*` and nothing else (owner Rule B).
 *
 * Run:  MONITOR_PG=postgres://user:pass@host:5432/db npx tsx shielded-monitor/scanner-cli.ts
 */
import { openArchiveSource } from "./archive-source.js";
import { createClient } from "../src/postgres/client.js";
import { bootstrapShieldedMonitorSchema } from "../storage-api/bootstrap.js";
import { ShieldedMonitorDetailsBackfill } from "./details-backfill.js";
import { readScannerConfig, SCANNER_ENV_DOC } from "./scanner-config.js";
import { InMemoryScannerMetrics } from "./scanner-metrics.js";
import { ShieldedMonitorScanner } from "./scanner.js";
import { ShieldedMonitorScannerService } from "./scanner-service.js";
import { PgShieldedMonitorStore } from "../storage-api/monitor-store-pg.js";

/* eslint-disable no-console */

async function main(): Promise<void> {
  let config;
  try {
    config = readScannerConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // B's OWN database. In the split topology this connection string names a PostgreSQL server
  // that holds `shielded_monitor` and nothing else, and this process has no credential for A's.
  const sql = createClient({
    connectionString: config.connectionString,
    schema: config.monitorSchema,
    // One spare over the worker count: the workers, plus the connection a `LISTEN` subscription
    // takes in the single-host topology.
    maxConnections: config.concurrency + 2,
  });
  // Idempotent: applies zero migrations against an already-migrated schema. The scanner
  // bootstraps ITS OWN schema only — it never runs the archive's lineage, which belongs to A.
  await bootstrapShieldedMonitorSchema(sql, config.monitorSchema);

  const store = new PgShieldedMonitorStore(sql, config.monitorSchema);
  const source = await openArchiveSource({
    ...(config.archiveUrl === undefined ? {} : { archiveUrl: config.archiveUrl }),
    archiveSchema: config.archiveSchema,
    sql,
    logger: (line) => { console.error(line); },
  });
  const metrics = new InMemoryScannerMetrics();
  const scanner = new ShieldedMonitorScanner(source.archive, store, {
    net: config.net,
    batchBlocks: config.batchBlocks,
    metrics,
    // Over a network boundary the claimed identity of a transaction and the bytes under it are
    // two separate things a page asserts; in-process they came out of one row an ingest had
    // already cross-checked. See `ShieldedMonitorScannerOptions.verifyTxIdentity`.
    verifyTxIdentity: source.remote,
    lease: { owner: config.instanceId, ttlMs: config.leaseTtlMs },
    ...(config.budgetTxPerSecond === undefined ? {} : { budgetTxPerSecond: config.budgetTxPerSecond }),
  });
  const service = new ShieldedMonitorScannerService(scanner, store, source.wake, {
    net: config.net,
    concurrency: config.concurrency,
    pollMs: config.pollMs,
    maxMonitors: config.maxMonitors,
    maxBatchesPerMonitorPerCycle: config.maxBatchesPerMonitorPerCycle,
    instanceId: config.instanceId,
    leaseTtlMs: config.leaseTtlMs,
    logger: (line) => { console.error(line); },
  });

  console.error(
    `[shielded-monitor-scanner] net=${config.net} ${source.describe} ` +
      `monitorSchema=${config.monitorSchema} batchBlocks=${config.batchBlocks} ` +
      `concurrency=${config.concurrency} pollMs=${config.pollMs} wake=${source.wake.describe} ` +
      `instance=${config.instanceId} leaseTtlMs=${config.leaseTtlMs}`,
  );

  if (config.backfillDetails) {
    // 00009-07. Reads blocks ONLY through the archive read contract and writes ONLY the two
    // nullable `associations` columns migration 002 added (owner Rule B). Idempotent: a second
    // run fills nothing, because every write carries `AND details IS NULL`.
    const backfill = new ShieldedMonitorDetailsBackfill(source.archive, store, {
      net: config.net,
      batchRows: config.backfillBatchRows,
    });
    const summary = await backfill.runAll({ maxMonitors: config.maxMonitors });
    // No monitor id is printed: which wallet had how many matches is a per-wallet signal, and the
    // counts are what an operator acts on.
    console.error(`[shielded-monitor-scanner] details backfill: ${JSON.stringify(summary)}`);
    await sql.end({ timeout: 5 });
    return;
  }

  if (config.once) {
    const summary = await service.runCycle();
    console.error(`[shielded-monitor-scanner] one cycle: ${JSON.stringify(summary)}`);
    logMetrics(metrics, config.net);
    await sql.end({ timeout: 5 });
    return;
  }

  const metricsTimer = config.metricsLogSeconds > 0
    ? setInterval(() => { logMetrics(metrics, config.net); }, config.metricsLogSeconds * 1000)
    : undefined;
  metricsTimer?.unref?.();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[shielded-monitor-scanner] ${signal}: stopping after the in-flight cycle`);
    void (async () => {
      if (metricsTimer !== undefined) clearInterval(metricsTimer);
      // `stop()` waits for the in-flight cycle, whose own `finally` releases every lease this
      // instance holds — so a graceful stop hands its monitors back immediately instead of
      // leaving another instance to wait out `SCAN_LEASE_TTL_MS`.
      await service.stop();
      logMetrics(metrics, config.net);
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });

  await service.start();
}

/** The periodic metrics line. Carries counters and a lag, and NEVER a monitor id or a key
 *  (organizer spec FR-014, FR-023). */
function logMetrics(metrics: InMemoryScannerMetrics, net: string): void {
  const snapshot = metrics.snapshot(net);
  console.error(
    `[shielded-monitor-scanner] net=${net} tx=${snapshot.transactionsScanned} ` +
      `matches=${snapshot.matches} blocks=${snapshot.blocksScanned} ` +
      `tx/s=${snapshot.transactionsPerSecond.toFixed(1)} maxLagBlocks=${snapshot.maxLagBlocks} ` +
      `batches=${JSON.stringify(snapshot.batches)}`,
  );
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(SCANNER_ENV_DOC);
  process.exit(0);
}

await main();
