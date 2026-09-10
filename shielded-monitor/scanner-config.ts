/**
 * The scanner process's configuration, read from the environment ONCE and validated eagerly.
 *
 * Separate from `scanner-cli.ts` so the parsing is testable without spawning a process, and so
 * every default is a value a reader can find in one place rather than an `??` buried in a
 * constructor call.
 *
 * **Every numeric setting fails closed on a bad value.** A `SCAN_BATCH_BLOCKS=0` that silently
 * became the default is exactly the class of bug the archive CLI's own audit finding T6 records
 * (`chain-archive-sync/sync-cli.ts`): a mistyped bound that disables the thing it was meant to
 * limit, with no message. Here a bad value stops the process with the name of the variable.
 */

export interface ScannerEnvConfig {
  /** Postgres connection string. Both schemas live in one database in the alpha; project B
   *  still only WRITES its own (Rule B), which the isolation test proves with a restricted role. */
  readonly connectionString: string;
  readonly net: string;
  readonly archiveSchema: string;
  readonly monitorSchema: string;
  readonly batchBlocks: number;
  readonly concurrency: number;
  readonly pollMs: number;
  readonly maxMonitors: number;
  readonly maxBatchesPerMonitorPerCycle: number;
  readonly budgetTxPerSecond?: number;
  /** Seconds between the process's own metrics log line. 0 disables it. */
  readonly metricsLogSeconds: number;
  /** Run one cycle and exit, instead of following the tip. For scripted backfills and tests. */
  readonly once: boolean;
}

export const SCANNER_ENV_DOC = `
Environment (umbradb-shielded-monitor):

  MONITOR_PG            Postgres connection string (REQUIRED).
  NET                   network id / row scope, e.g. "undeployed" (default "undeployed").
  ARCHIVE_SCHEMA        schema the archive was ingested into (default "chain_archive").
                        Read-only: the scanner reaches it ONLY through the archive read
                        contract, and never writes to it (owner Rule B).
  MONITOR_SCHEMA        schema project B owns and writes (default "shielded_monitor").
  SCAN_BATCH_BLOCKS     whole blocks per batch, and therefore per commit (default 1).
  SCAN_CONCURRENCY      monitors scanned in parallel (default 4).
  SCAN_POLL_MS          fallback wake-up interval when no NOTIFY arrives (default 2000).
  MAX_MONITORS          monitors picked up per cycle (default 100).
  SCAN_MAX_BATCHES      batches one monitor may run per cycle before others get a turn
                        (default 64).
  SCAN_BUDGET_TX_PER_S  optional per-monitor throughput ceiling; unset means unlimited.
  SCAN_METRICS_LOG_S    seconds between the metrics log line; 0 disables (default 30).
  SCAN_ONCE             "1" runs a single cycle and exits.
`.trim();

class ScannerConfigError extends Error {}

function requireString(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new ScannerConfigError(`${name} is required.\n\n${SCANNER_ENV_DOC}`);
  }
  return raw;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ScannerConfigError(
      `${name} must be a whole number >= 1 (got ${JSON.stringify(raw)}). Refusing to fall back ` +
        `to the default ${fallback}: a bound that silently becomes something else is worse than ` +
        "no bound at all.",
    );
  }
  return value;
}

function nonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ScannerConfigError(`${name} must be a whole number >= 0 (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

function optionalPositiveNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScannerConfigError(`${name} must be a positive number (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

/** Parse and validate. Throws with a message naming the variable; the CLI prints it and exits. */
export function readScannerConfig(env: NodeJS.ProcessEnv = process.env): ScannerEnvConfig {
  const budget = optionalPositiveNumber(env, "SCAN_BUDGET_TX_PER_S");
  return {
    connectionString: requireString(env, "MONITOR_PG"),
    net: env.NET ?? "undeployed",
    archiveSchema: env.ARCHIVE_SCHEMA ?? "chain_archive",
    monitorSchema: env.MONITOR_SCHEMA ?? "shielded_monitor",
    batchBlocks: positiveInt(env, "SCAN_BATCH_BLOCKS", 1),
    concurrency: positiveInt(env, "SCAN_CONCURRENCY", 4),
    pollMs: positiveInt(env, "SCAN_POLL_MS", 2000),
    maxMonitors: positiveInt(env, "MAX_MONITORS", 100),
    maxBatchesPerMonitorPerCycle: positiveInt(env, "SCAN_MAX_BATCHES", 64),
    ...(budget === undefined ? {} : { budgetTxPerSecond: budget }),
    metricsLogSeconds: nonNegativeInt(env, "SCAN_METRICS_LOG_S", 30),
    once: env.SCAN_ONCE === "1",
  };
}
