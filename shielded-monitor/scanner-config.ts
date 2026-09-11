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
import { DEFAULT_ARCHIVE_SCHEMA } from "../src/postgres/archive-conventions.js";
import { normalizeArchiveBaseUrl } from "./archive-http-client.js";

export interface ScannerEnvConfig {
  /** Postgres connection string. Both schemas live in one database in the alpha; project B
   *  still only WRITES its own (Rule B), which the isolation test proves with a restricted role. */
  readonly connectionString: string;
  readonly net: string;
  /**
   * `ARCHIVE_URL` — the base URL of an `umbradb-archive-read-api`. Set means the SPLIT topology:
   * the archive is reached over HTTP, this process holds no credential for A's database, and
   * {@link archiveSchema} is not used at all (00009-08).
   */
  readonly archiveUrl?: string;
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

  MONITOR_PG            Postgres connection string for project B's OWN database (REQUIRED).
  NET                   network id / row scope, e.g. "undeployed" (default "undeployed").
  ARCHIVE_URL           base URL of an umbradb-archive-read-api, e.g.
                        http://archive-read-api:8790. SET IT for a split deployment: the
                        scanner then reaches the archive only over HTTP, needs no credential
                        for A's database, and ARCHIVE_SCHEMA/ARCHIVE_PG must NOT be set.
  ARCHIVE_SCHEMA        single-host mode only: schema the archive was ingested into in the SAME
                        database as MONITOR_PG (default "${DEFAULT_ARCHIVE_SCHEMA}").
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
  SCAN_BACKFILL_DETAILS "1" (or the flag --backfill-details) runs the match-details backfill
                        over existing associations and exits, instead of scanning. Idempotent:
                        it only ever fills rows whose details are still NULL.
  SCAN_BACKFILL_ROWS    associations filled per transaction during that backfill (default 100).
  SCAN_INSTANCE_ID      this instance's lease owner name (default: a random UUID per process).
  SCAN_LEASE_TTL_MS     how long a monitor lease survives without renewal (default 30000).
                        Several scanner instances may run against one B database: each claims a
                        monitor before scanning it and renews the claim inside the same
                        transaction as the coverage advance. Leases only avoid duplicated work —
                        epoch fencing is what makes concurrency SAFE.
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
  const archiveUrl = readArchiveUrl(env);
  return {
    connectionString: requireString(env, "MONITOR_PG"),
    net: env.NET ?? "undeployed",
    ...(archiveUrl === undefined ? {} : { archiveUrl }),
    archiveSchema: env.ARCHIVE_SCHEMA ?? DEFAULT_ARCHIVE_SCHEMA,
    monitorSchema: env.MONITOR_SCHEMA ?? "shielded_monitor",
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

/**
 * The archive DB settings that are meaningless — and dangerous — alongside `ARCHIVE_URL`.
 *
 * Dangerous because the failure they produce is silent. An operator migrating to a split
 * deployment who leaves `ARCHIVE_SCHEMA` in place would see a scanner that starts, connects,
 * reports healthy and reads the archive over HTTP — while the stale variable sits in the manifest
 * documenting a topology that is not in effect, and the next person to read it believes the
 * process has database access it does not have. Worse in the other direction: an `ARCHIVE_PG`
 * left behind is a CREDENTIAL for A's database in the environment of a container that is supposed
 * to have none, which is exactly the property the split topology exists to establish.
 *
 * So the process refuses to start and names the variables. There is no "it probably meant" here.
 */
const ARCHIVE_DB_SETTINGS = ["ARCHIVE_SCHEMA", "ARCHIVE_PG"] as const;

function readArchiveUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.ARCHIVE_URL?.trim();
  if (raw === undefined || raw === "") return undefined;

  const conflicting = ARCHIVE_DB_SETTINGS.filter(
    (name) => env[name] !== undefined && env[name]!.trim() !== "",
  );
  if (conflicting.length > 0) {
    throw new ScannerConfigError(
      `ARCHIVE_URL is set (${raw}) and so ${conflicting.length === 1 ? "is" : "are"} ` +
        `${conflicting.join(", ")}. These describe two different topologies: ARCHIVE_URL says the ` +
        "archive is another process reached over HTTP, and the database settings say it is a " +
        "schema in this process's own database. Refusing to start rather than picking one and " +
        `leaving the other in the environment as a false description of the deployment.\n\n${SCANNER_ENV_DOC}`,
    );
  }

  try {
    return normalizeArchiveBaseUrl(raw);
  } catch (err) {
    throw new ScannerConfigError(
      `ARCHIVE_URL is not a usable base URL: ${err instanceof Error ? err.message : String(err)}`,
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
