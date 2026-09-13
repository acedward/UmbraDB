/**
 * Crash worker for the archive's per-height transaction (owner Rule A, `spec/00009` FR-029).
 *
 * A `tsx`-launched CHILD PROCESS that writes exactly ONE block height through the real
 * `PgChainArchiveStore.putBlockBundle` and, when asked, PAUSES at a named program point -- a
 * statement index inside that transaction, or the moment immediately after it committed -- then
 * signals readiness and blocks so the parent can SIGKILL it deterministically.
 *
 * Same discipline as `crash-worker.ts`, for the same reasons: the pause is a named program point
 * and never a timer; no fault code lives in `src/` (the instrumentation is a proxy around the
 * driver handle, `archive-fault-injection.ts`); and the operation on either side of the pause is
 * the real, unmodified production write path.
 *
 * This is the process-kill lane. The PostgreSQL-kill lane runs in-process in the test, because a
 * backend can be killed hundreds of times in one process while a SIGKILL can only happen once --
 * and both lanes share the same instrumentation, so a statement index means the same thing in
 * each.
 */
import { PgChainArchiveStore } from "../../../src/postgres/chain-archive-store.js";
import { createClient } from "../../../src/postgres/client.js";
import type { BlockBundle } from "../../../src/interfaces/chain-archive-store.js";
import { withStatementFault, type FaultState } from "./archive-fault-injection.js";
import { buildHeightBundle } from "./archive-bundle-fixture.js";

const READY_SENTINEL = "@@CRASH_WORKER_READY@@";
const ERROR_SENTINEL = "@@CRASH_WORKER_ERROR@@";
/** Bounds an orphaned worker if the parent never kills it (a parent bug), rather than leaking a
 *  process forever. Never the pause mechanism. */
const ORPHAN_GUARD_MS = 120_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`archive-bundle-worker: ${name} is not set`);
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
  const schema = requireEnv("UMBRADB_TEST_SCHEMA");
  const net = requireEnv("UMBRADB_ARCHIVE_NET");
  const height = Number(requireEnv("UMBRADB_ARCHIVE_HEIGHT"));
  const parentHash = requireEnv("UMBRADB_ARCHIVE_PARENT_HASH");
  const txCount = Number(process.env.UMBRADB_ARCHIVE_TX_COUNT ?? "2");
  const observationCount = Number(process.env.UMBRADB_ARCHIVE_OBS_COUNT ?? "1");
  const withCheckpoint = process.env.UMBRADB_ARCHIVE_CHECKPOINT === "1";
  /** A statement index (pause before it), the literal "after-commit", or absent (no pause: the
   *  negative control, which must land the whole height). */
  const crashAt = process.env.UMBRADB_ARCHIVE_CRASH_AT;

  const sql = createClient({ connectionString, schema, maxConnections: 2 });
  const bundle: BlockBundle = buildHeightBundle({
    net, height, parentHash, txCount, observationCount, withCheckpoint,
  });

  const state: FaultState = {
    count: 0,
    killAtStatement: crashAt === undefined || crashAt === "after-commit" ? undefined : Number(crashAt),
    onReached: async (backendPid) => {
      // Everything before this statement has been issued inside the open transaction and NOTHING
      // has committed. The parent's SIGKILL lands here.
      signalReady({ hook: `before-statement-${crashAt}`, pid: process.pid, backendPid, height });
      await pauseUntilKilled();
    },
  };

  const store = new PgChainArchiveStore(withStatementFault(sql, state), schema);
  await store.putBlockBundle(bundle);

  if (crashAt === "after-commit") {
    // The transaction has COMMITTED and the call returned. Killing here proves the other half of
    // Rule A: what survives is the WHOLE height, watermark included, with no further work left
    // for the process to do. Under the old three-transaction shape this exact point left the
    // height durable with the cursor behind it.
    signalReady({ hook: "after-commit", pid: process.pid, height, statements: state.count });
    await pauseUntilKilled();
  }

  // No hook (or an index past the end of the transaction): the negative control. The height
  // lands whole and the process exits cleanly, which is what makes a killed run's absence
  // attributable to the kill rather than to a write that never happened.
  process.stdout.write(
    `${READY_SENTINEL} ${JSON.stringify({ hook: null, pid: process.pid, height, statements: state.count })}\n`,
  );
  await sql.end({ timeout: 5 });
}

main().catch((err: unknown) => {
  process.stderr.write(`${ERROR_SENTINEL} ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(70);
});
