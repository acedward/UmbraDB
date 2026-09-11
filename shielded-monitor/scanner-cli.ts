#!/usr/bin/env node
/**
 * `umbradb-shielded-monitor` — the relevance scanner process (organizer spec FR-026).
 *
 * A SEPARATE process from the archive ingester (`umbradb-archive-sync`) and from the private API
 * (Phase 4), by requirement, not by convention: FR-026 says the scanner and the API run as their
 * own processes, and FR-025 keeps B's only dependency on A the read contract.
 *
 * ── One topology (00009-08 v2, owner question Q25) ──────────────────────────────────────────
 *
 * ```text
 *   STORAGE_URL -> http://storage-api:8788
 *
 *   Everything this process reads and everything it writes travels over that one base URL:
 *   the archive pages it scans (/v1/archive/*) and every monitor record it persists
 *   (/v1/monitor-store/*). It has NO database connection, no driver, no schema name and no
 *   credential — and it refuses to start if any *_PG variable is in its environment.
 *
 *   Several instances may run against one storage API: each claims a monitor lease before
 *   working on it, and the renewal rides inside the same server-side transaction as the
 *   coverage advance.
 * ```
 *
 * It writes to `shielded_monitor.*` and nothing else (owner Rule B) — through commands the
 * storage API executes, each one exactly one transaction.
 *
 * Run:  STORAGE_URL=http://127.0.0.1:8788 npx tsx shielded-monitor/scanner-cli.ts
 */
import { openArchiveSource } from "./archive-source.js";
import { ShieldedMonitorDetailsBackfill } from "./details-backfill.js";
import { readScannerConfig, SCANNER_ENV_DOC } from "./scanner-config.js";
import { InMemoryScannerMetrics } from "./scanner-metrics.js";
import { ShieldedMonitorScanner } from "./scanner.js";
import { ShieldedMonitorScannerService } from "./scanner-service.js";
import { HttpMonitorStore } from "./storage-http-client.js";

/* eslint-disable no-console */

async function main(): Promise<void> {
  let config;
  try {
    config = readScannerConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Project B's whole persistence surface. No pool, no migration, no schema: the storage API
  // owns the database and runs each command as one transaction on this process's behalf.
  const store = new HttpMonitorStore(config.storageUrl, { userAgent: "umbradb-shielded-monitor" });
  const source = openArchiveSource({
    archiveUrl: config.archiveUrl,
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
      `storage=${store.baseUrl} batchBlocks=${config.batchBlocks} ` +
      `concurrency=${config.concurrency} pollMs=${config.pollMs} wake=${source.wake.describe} ` +
      `instance=${config.instanceId} leaseTtlMs=${config.leaseTtlMs} database=none`,
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
    return;
  }

  if (config.once) {
    const summary = await service.runCycle();
    console.error(`[shielded-monitor-scanner] one cycle: ${JSON.stringify(summary)}`);
    logMetrics(metrics, config.net);
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
