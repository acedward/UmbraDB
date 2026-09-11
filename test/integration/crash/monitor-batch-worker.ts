/**
 * Crash worker for the scanner's per-batch transaction (owner Rule B, `spec/00009` FR-010,
 * US5 scenario 2).
 *
 * A `tsx`-launched CHILD PROCESS that scans exactly ONE batch for ONE monitor through the real
 * {@link ShieldedMonitorScanner} and, when asked, PAUSES at a named program point — a statement
 * index inside the store's advance transaction, or the moment immediately after that
 * transaction committed — then signals readiness and blocks so the parent can SIGKILL it
 * deterministically.
 *
 * Same discipline as `crash-worker.ts` and `archive-bundle-worker.ts`: the pause is a named
 * program point and never a timer; no fault code lives in `src/` or in `shielded-monitor/` (the
 * instrumentation is a proxy around the driver handle, `archive-fault-injection.ts`, shared with
 * the Rule A suite so a statement index means the same thing in both); and the work on either
 * side of the pause is the real, unmodified production path.
 *
 * **Two pools on purpose.** The archive read goes through a CLEAN handle and the store through
 * the FAULTED one, so the statement indices a test chooses describe the scanner's `shielded_monitor`
 * write transaction and nothing else. That split is also a small live demonstration of Rule B:
 * the two sides of the scanner really are separable connections.
 */
import { PgArchiveReadContract } from "../../../src/postgres/archive-read-contract.js";
import { createClient } from "../../../src/postgres/client.js";
import { ShieldedMonitorScanner } from "../../../shielded-monitor/scanner.js";
import { PgShieldedMonitorStore } from "../../../shielded-monitor/store.js";
import { withStatementFault, type FaultState } from "./archive-fault-injection.js";
import { CRASH_NET } from "./monitor-batch-fixture.js";

const READY_SENTINEL = "@@CRASH_WORKER_READY@@";
const ERROR_SENTINEL = "@@CRASH_WORKER_ERROR@@";
/** Bounds an orphaned worker if the parent never kills it (a parent bug), rather than leaking a
 *  process forever. Never the pause mechanism. */
const ORPHAN_GUARD_MS = 120_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`monitor-batch-worker: ${name} is not set`);
  return value;
}

function signalReady(payload: Record<string, unknown>): void {
  process.stdout.write(`${READY_SENTINEL} ${JSON.stringify(payload)}\n`);
}

function pauseUntilKilled(): Promise<never> {
  return new Promise<never>(() => {
    setTimeout(() => {
      process.stderr.write(`${ERROR_SENTINEL} orphan-guard: parent never SIGKILLed\n`);
      process.exit(75);
    }, ORPHAN_GUARD_MS);
  });
}

async function main(): Promise<void> {
  const connectionString = requireEnv("UMBRADB_TEST_CONNECTION_URI");
  const archiveSchema = requireEnv("UMBRADB_MONITOR_ARCHIVE_SCHEMA");
  const monitorSchema = requireEnv("UMBRADB_MONITOR_SCHEMA");
  const monitorId = requireEnv("UMBRADB_MONITOR_ID");
  const expectedHeight = Number(requireEnv("UMBRADB_MONITOR_HEIGHT"));
  /** A statement index (pause before it), the literal "after-commit", or absent (no pause). */
  const crashAt = process.env.UMBRADB_MONITOR_CRASH_AT;

  const readSql = createClient({ connectionString, schema: archiveSchema, maxConnections: 2 });
  const writeSql = createClient({ connectionString, schema: monitorSchema, maxConnections: 2 });

  const state: FaultState = {
    count: 0,
    killAtStatement: crashAt === undefined || crashAt === "after-commit" ? undefined : Number(crashAt),
    onReached: async (backendPid) => {
      // Everything before this statement has been issued inside the open advance transaction and
      // NOTHING has committed. The parent's SIGKILL lands here.
      signalReady({
        hook: `before-statement-${crashAt}`, pid: process.pid, backendPid, height: expectedHeight,
      });
      await pauseUntilKilled();
    },
  };

  const archive = new PgArchiveReadContract(readSql, archiveSchema);
  const store = new PgShieldedMonitorStore(withStatementFault(writeSql, state), monitorSchema);
  const scanner = new ShieldedMonitorScanner(archive, store, { net: CRASH_NET, batchBlocks: 1 });

  // The monitor is loaded through the CLEAN handle so the load's statements never count against
  // the fault indices; only the commit runs through the faulted one.
  const loadStore = new PgShieldedMonitorStore(readSql, monitorSchema);
  const monitor = await loadStore.get(monitorId);
  const result = await scanner.scanBatch(monitor);

  if (crashAt === "after-commit") {
    // The advance transaction COMMITTED and the call returned. Killing here proves the other
    // half of Rule B: what survives is the whole batch, coverage included.
    signalReady({ hook: "after-commit", pid: process.pid, height: expectedHeight, result: result.kind });
    await pauseUntilKilled();
  }

  signalReady({ hook: null, pid: process.pid, height: expectedHeight, result: result.kind, statements: state.count });
  await Promise.allSettled([readSql.end({ timeout: 5 }), writeSql.end({ timeout: 5 })]);
}

main().catch((err: unknown) => {
  process.stderr.write(`${ERROR_SENTINEL} ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(70);
});
