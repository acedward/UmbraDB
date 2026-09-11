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
 *
 * The one default this module does NOT own is the archive's schema name: it is A's, imported from
 * A's conventions module, because B holds no archive schema knowledge of its own (owner Rule B /
 * FR-025, enforced by `test/shielded-monitor/schema-isolation.integration.test.ts`).
 */
import { randomUUID } from "node:crypto";
import { assertNoDatabaseEnvironment } from "./no-database.js";
import { normalizeStorageBaseUrl } from "./storage-http-client.js";

export interface ScannerEnvConfig {
  /**
   * `STORAGE_URL` — the base URL of the `umbradb-storage-api` that owns the main database
   * (00009-08 v2, owner question Q25). This is project B's ENTIRE egress surface and its entire
   * persistence surface: monitors, associations, coverage, lifecycle and leases all travel over
   * it, and this process holds no database credential of any kind.
   */
  readonly storageUrl: string;
  readonly net: string;
  /**
   * Where `/v1/archive/*` is served. Defaults to {@link storageUrl}, because
   * `umbradb-storage-api` serves both route families on one port; a deployment running the
   * standalone `umbradb-archive-read-api` on its own port sets `ARCHIVE_URL`.
   */
  readonly archiveUrl: string;
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
  /**
   * Run the 00009-07 DETAILS backfill and exit, instead of scanning at all.
   *
   * A one-shot maintenance command, deliberately not a mode the tailing worker also runs: the
   * normal worker already records details for every NEW match, so the only thing the backfill
   * adds is filling rows written before migration 002 — work that finishes, and whose completion
   * an operator wants to see rather than have folded into a process that never exits.
   */
  readonly backfillDetails: boolean;
  /** Associations filled per store transaction during that backfill (default 100). */
  readonly backfillBatchRows: number;
  /**
   * This scanner instance's name, recorded as the owner of every monitor lease it holds
   * (00009-08). Defaults to a random UUID, so two containers started from the same image and the
   * same environment do NOT collide — a shared owner string would let each renew the other's
   * lease and both would scan the same monitor.
   */
  readonly instanceId: string;
  /**
   * How long a claimed monitor lease stays valid without renewal (default 30 s).
   *
   * The ONLY thing this bounds is how long another instance waits before taking over the work of
   * an instance that died mid-turn. It is not a correctness parameter: epoch fencing and the
   * monotonic coverage guard are what make a concurrent commit safe, and they do not consult the
   * lease at all.
   */
  readonly leaseTtlMs: number;
}

export const SCANNER_ENV_DOC = `
Environment (umbradb-shielded-monitor):

  STORAGE_URL           base URL of the umbradb-storage-api that owns the main database
                        (REQUIRED), e.g. http://storage-api:8788. The scanner reads the archive
                        AND persists every monitor record through it. This process has no
                        database connection: it refuses to start if any *_PG variable, or an
                        ARCHIVE_SCHEMA/MONITOR_SCHEMA, is present in its environment.
  ARCHIVE_URL           optional: serve /v1/archive/* from a different base URL (a standalone
                        umbradb-archive-read-api). Defaults to STORAGE_URL.
  NET                   network id / row scope, e.g. "undeployed" (default "undeployed").
  SCAN_BATCH_BLOCKS     whole blocks per batch, and therefore per commit (default 1).
  SCAN_CONCURRENCY      monitors scanned in parallel (default 4).
  SCAN_POLL_MS          fallback wake-up interval when no NOTIFY arrives (default 2000).
  MAX_MONITORS          monitors picked up per cycle (default 100).
  SCAN_MAX_BATCHES      batches one monitor may run per cycle before others get a turn
                        (default 64).
  SCAN_BUDGET_TX_PER_S  optional per-monitor throughput ceiling; unset means unlimited.
  SCAN_METRICS_LOG_S    seconds between the metrics log line; 0 disables (default 30).
  SCAN_ONCE             "1" runs a single cycle and exits.
  SCAN_BACKFILL_DETAILS "1" (or the flag --backfill-details) runs the match-details backfill
                        over existing associations and exits, instead of scanning. Idempotent:
                        it only ever fills rows whose details are still NULL.
  SCAN_BACKFILL_ROWS    associations filled per transaction during that backfill (default 100).
  SCAN_INSTANCE_ID      this instance's lease owner name (default: a random UUID per process).
  SCAN_LEASE_TTL_MS     how long a monitor lease survives without renewal (default 30000).
                        Several scanner instances may run against one storage API: each claims a
                        monitor before scanning it and renews the claim inside the same
                        server-side transaction as the coverage advance. Leases only avoid
                        duplicated work — epoch fencing is what makes concurrency SAFE.
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
export function readScannerConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): ScannerEnvConfig {
  const budget = optionalPositiveNumber(env, "SCAN_BUDGET_TX_PER_S");
  // Before anything else: a database credential in this process's environment is a refusal, not
  // a warning (see `no-database.ts`).
  assertNoDatabaseEnvironment(env, "umbradb-shielded-monitor");
  const storageUrl = readBaseUrl(env, "STORAGE_URL", requireString(env, "STORAGE_URL"));
  const archiveUrl = env.ARCHIVE_URL?.trim();
  return {
    storageUrl,
    net: env.NET ?? "undeployed",
    archiveUrl: archiveUrl === undefined || archiveUrl === "" ? storageUrl : readBaseUrl(env, "ARCHIVE_URL", archiveUrl),
    batchBlocks: positiveInt(env, "SCAN_BATCH_BLOCKS", 1),
    concurrency: positiveInt(env, "SCAN_CONCURRENCY", 4),
    pollMs: positiveInt(env, "SCAN_POLL_MS", 2000),
    maxMonitors: positiveInt(env, "MAX_MONITORS", 100),
    maxBatchesPerMonitorPerCycle: positiveInt(env, "SCAN_MAX_BATCHES", 64),
    ...(budget === undefined ? {} : { budgetTxPerSecond: budget }),
    metricsLogSeconds: nonNegativeInt(env, "SCAN_METRICS_LOG_S", 30),
    once: env.SCAN_ONCE === "1",
    // Accepted as a flag as well as an environment variable, because it is the one setting an
    // operator types by hand, once, on a machine whose env is already configured for the worker.
    backfillDetails: env.SCAN_BACKFILL_DETAILS === "1" || argv.includes("--backfill-details"),
    backfillBatchRows: positiveInt(env, "SCAN_BACKFILL_ROWS", 100),
    instanceId: readInstanceId(env),
    leaseTtlMs: positiveInt(env, "SCAN_LEASE_TTL_MS", 30_000),
  };
}

/** Normalises a base URL, naming the variable when it is unusable. */
function readBaseUrl(env: NodeJS.ProcessEnv, name: string, raw: string): string {
  try {
    return normalizeStorageBaseUrl(raw.trim());
  } catch (err) {
    throw new ScannerConfigError(
      `${name} is not a usable base URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readInstanceId(env: NodeJS.ProcessEnv): string {
  const raw = env.SCAN_INSTANCE_ID?.trim();
  if (raw === undefined || raw === "") return randomUUID();
  if (raw.length > 128) {
    throw new ScannerConfigError(`SCAN_INSTANCE_ID must be at most 128 characters (got ${raw.length}).`);
  }
  return raw;
}
