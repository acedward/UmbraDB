#!/usr/bin/env node
/**
 * `umbradb-shielded-monitor` — the relevance scanner process (organizer spec FR-026).
 *
 * A SEPARATE process from the archive ingester (`umbradb-archive-sync`) and from the private API
 * (Phase 4), by requirement, not by convention: FR-026 says the scanner and the API run as their
 * own processes, and FR-025 keeps B's only dependency on A the read contract, so this binary
 * could be pointed at a remote archive implementation without a code change.
 *
 * It writes to `shielded_monitor.*` and nothing else (owner Rule B). Running it against a
 * database where its role has only `USAGE`/`SELECT` on the archive schema is supported and is
 * what `test/shielded-monitor/scanner-isolation.integration.test.ts` actually does.
 *
 * Run:  MONITOR_PG=postgres://user:pass@host:5432/db npx tsx shielded-monitor/scanner-cli.ts
 */
import { createClient } from "../src/postgres/client.js";
import { PgArchiveReadContract } from "../src/postgres/archive-read-contract.js";
import { bootstrapShieldedMonitorSchema } from "./bootstrap.js";
import { ShieldedMonitorDetailsBackfill } from "./details-backfill.js";
import { readScannerConfig, SCANNER_ENV_DOC } from "./scanner-config.js";
import { InMemoryScannerMetrics } from "./scanner-metrics.js";
import { ShieldedMonitorScanner } from "./scanner.js";
import { ShieldedMonitorScannerService } from "./scanner-service.js";
import { PgShieldedMonitorStore } from "./store.js";

/* eslint-disable no-console */

async function main(): Promise<void> {
  let config;
  try {
    config = readScannerConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const sql = createClient({
    connectionString: config.connectionString,
    schema: config.monitorSchema,
    // One spare over the worker count: the workers, plus the LISTEN connection postgres.js
    // dedicates to the subscription.
    maxConnections: config.concurrency + 2,
  });
  // Idempotent: applies zero migrations against an already-migrated schema. The scanner
  // bootstraps ITS OWN schema only — it never runs the archive's lineage, which belongs to A.
  await bootstrapShieldedMonitorSchema(sql, config.monitorSchema);

  const store = new PgShieldedMonitorStore(sql, config.monitorSchema);
  const archive = new PgArchiveReadContract(sql, config.archiveSchema);
  const metrics = new InMemoryScannerMetrics();
  const scanner = new ShieldedMonitorScanner(archive, store, {
    net: config.net,
    batchBlocks: config.batchBlocks,
    metrics,
    ...(config.budgetTxPerSecond === undefined ? {} : { budgetTxPerSecond: config.budgetTxPerSecond }),
  });
  const service = new ShieldedMonitorScannerService(scanner, store, sql, {
    net: config.net,
    concurrency: config.concurrency,
    pollMs: config.pollMs,
    maxMonitors: config.maxMonitors,
    maxBatchesPerMonitorPerCycle: config.maxBatchesPerMonitorPerCycle,
    logger: (line) => { console.error(line); },
  });

  console.error(
    `[shielded-monitor-scanner] net=${config.net} archiveSchema=${config.archiveSchema} ` +
      `monitorSchema=${config.monitorSchema} batchBlocks=${config.batchBlocks} ` +
      `concurrency=${config.concurrency} pollMs=${config.pollMs}`,
  );

  if (config.backfillDetails) {
    // 00009-07. Reads blocks ONLY through the archive read contract and writes ONLY the two
    // nullable `associations` columns migration 002 added (owner Rule B). Idempotent: a second
    // run fills nothing, because every write carries `AND details IS NULL`.
    const backfill = new ShieldedMonitorDetailsBackfill(archive, store, {
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
