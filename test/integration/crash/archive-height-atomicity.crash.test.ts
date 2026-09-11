import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgChainArchiveStore } from "../../../src/postgres/chain-archive-store.js";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { pgTerminateBackend } from "../../postgres/setup.js";
import { chainArchiveMigrations } from "../../../src/postgres/migrations/chain_archive/index.js";
import {
  blockHashFor, buildHeightBundle, GENESIS_PARENT_HASH, WATERMARK_KEY_PREFIX,
} from "./archive-bundle-fixture.js";
import {
  classifyRuleAState, observeHeight, withStatementFault, type FaultState, type RuleAState,
} from "./archive-fault-injection.js";

/**
 * **Owner Rule A** (`spec/00009` User Story 5 scenario 1, FR-029): everything the archive writes
 * for one block height -- the block row, its transactions, its bridge observations, its replay
 * checkpoint when one is due, the decoded block timestamp and the sync watermark -- commits in
 * ONE `BEGIN … COMMIT`. After a crash at ANY point, exactly two states are observable: nothing of
 * that height with the watermark behind it, or all of it including the watermark. There is no
 * third state.
 *
 * Before this change there demonstrably WAS a third state, and a fourth: PR #1's ingest path
 * committed the bundle, then the replay checkpoint, then the watermark, in three separate
 * transactions. This suite would have failed against it -- which is what makes it a test of the
 * fix rather than a restatement of it. The negative-control leg at the end reconstructs that old
 * three-transaction shape and shows the partial state appearing, so a future refactor that
 * silently un-folds the writes cannot pass by luck.
 *
 * TWO FAULT LANES, one shared instrumentation (`archive-fault-injection.ts`), so a statement
 * index means the same thing in both:
 *
 *  - **PostgreSQL kill, in-process, many points.** A backend can be terminated hundreds of times
 *    in one process, so this lane carries the randomized-point volume the plan asks for
 *    (`ARCHIVE_CRASH_POINTS`, default 200). Each point picks a random height shape and a random
 *    statement index inside its bundle transaction, kills the writer's backend with the
 *    transaction open, and classifies what survived.
 *  - **Process SIGKILL, child process, named points.** The repo's crash-worker shape
 *    (`crash-worker.ts`): a real separate OS process, killed with a real signal, at named
 *    statement indices AND at the moment immediately after COMMIT returned. A SIGKILL can only
 *    happen once per process, so this lane is a handful of points rather than hundreds -- but it
 *    is the one that proves the writer process dying (not merely its connection) leaves the same
 *    two states.
 */

const WORKER_ENTRYPOINT = fileURLToPath(new URL("./archive-bundle-worker.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const READY_SENTINEL = "@@CRASH_WORKER_READY@@";
const ERROR_SENTINEL = "@@CRASH_WORKER_ERROR@@";

/** Randomized crash points for the PostgreSQL-kill lane. 200 is the plan's number; the env
 *  override exists for a fast local loop, never for CI. */
const ARCHIVE_CRASH_POINTS = Number(process.env.UMBRADB_ARCHIVE_CRASH_POINTS ?? "200");

/** Deterministic PRNG so a failing run is reproducible from the seed printed in the message.
 *  `Math.random()` would make a rare partial state impossible to re-hit. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("Rule A: one block height, one transaction — the only observable states are none of H and all of H", () => {
  let container: StartedPostgreSqlContainer;
  let admin: UmbraDBSql;
  let writer: UmbraDBSql;
  const schema = "archive_rule_a_test";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    admin = createClient({ connectionString: container.getConnectionUri(), schema, maxConnections: 5 });
    await runMigrations(admin, { schema, migrations: chainArchiveMigrations });
    // A dedicated pool for the UNFAULTED writes (the per-point retries and the negative
    // controls). It is never the target of a kill, so it stays healthy for the whole run --
    // see `faultPool()` for why each killed write gets a pool of its own instead.
    writer = createClient({
      connectionString: container.getConnectionUri(), schema, maxConnections: 2, connectTimeout: 10,
    });
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled(faultPools.map((p) => p.end({ timeout: 2 })));
    await writer?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
    await container?.stop();
  });

  /** Pools that have had a backend killed under them, retired rather than reused. */
  const faultPools: UmbraDBSql[] = [];

  /**
   * A single-use pool for one killed write.
   *
   * A pool is NOT reusable across kills, and this is a real `postgres.js` behaviour rather than
   * caution: the driver keeps a SHARED `retries` counter that increments on every errored close
   * and drives an exponential reconnect backoff (`3^retries/100` seconds, capped at 20). It only
   * resets when a connection successfully reconnects -- which a pool with a spare connection
   * never needs to do. After a handful of kills the retired connection's backoff exceeds the
   * connect timeout and every later statement on that pool fails with CONNECT_TIMEOUT, poisoning
   * the rest of the run. Observed here at point 8 of 12 before this was split out.
   *
   * One pool per killed write sidesteps it entirely: the counter is per-`postgres()` instance, so
   * a fresh pool starts at zero and the poisoned one is simply retired.
   */
  const faultPool = (): UmbraDBSql => {
    const pool = createClient({
      connectionString: container.getConnectionUri(), schema, maxConnections: 1, connectTimeout: 10,
    });
    faultPools.push(pool);
    return pool;
  };

  it(
    `[[crash.archive-height.pg-kill-two-states]] ${ARCHIVE_CRASH_POINTS} randomized PostgreSQL kills inside the per-height transaction leave only {nothing of H, all of H incl. watermark}`,
    async () => {
      const net = "rule_a_pgkill";
      const watermarkKey = `${WATERMARK_KEY_PREFIX}${net}`;
      const rng = makeRng(0x5eed_1234);
      const seen: Record<RuleAState, number> = { "nothing-of-height": 0, "all-of-height": 0 };
      let parentHash = GENESIS_PARENT_HASH;

      for (let point = 0; point < ARCHIVE_CRASH_POINTS; point++) {
        const height = point;
        const spec = {
          net, height, parentHash,
          txCount: Math.floor(rng() * 4),
          observationCount: Math.floor(rng() * 2),
          withCheckpoint: rng() < 0.25,
        };
        const bundle = buildHeightBundle(spec);
        const expected = {
          height,
          transactionRows: spec.txCount,
          observationRows: spec.observationCount,
          checkpointRows: spec.withCheckpoint ? 1 : 0,
        };

        // Statement indices run from 1 to roughly 8 + 3*(txs + observations) + 3 + 2. Drawing
        // beyond that range on purpose: an index past the end means the transaction is never
        // interrupted, which must land the whole height -- a control point mixed in with the
        // faults rather than a separate, easily-skipped test.
        const maxStatement = 12 + 3 * (spec.txCount + spec.observationCount) + 5;
        const killAtStatement = 1 + Math.floor(rng() * maxStatement);

        const state: FaultState = {
          count: 0,
          killAtStatement,
          onReached: async (backendPid) => {
            // The writer's backend dies with the transaction open and every earlier statement
            // issued. PostgreSQL rolls the whole thing back; the next statement fails.
            //
            // `pgTerminateBackend` (the repo's own primitive) is used rather than a bare
            // `pg_terminate_backend(pid)` because the one-argument form returns as soon as the
            // SIGTERM is DELIVERED. The backend may then still execute several more statements
            // before it notices, which would make "kill before statement N" mean "kill somewhere
            // after N" -- and the crash point would no longer be the named program point the
            // crash-worker discipline requires. This form waits, and polls `pg_stat_activity`
            // until the backend is provably gone.
            await pgTerminateBackend(admin, backendPid);
          },
        };
        const pool = faultPool();
        const store = new PgChainArchiveStore(withStatementFault(pool, state), schema);
        let threw = false;
        try {
          await store.putBlockBundle(bundle);
        } catch {
          threw = true;
        }
        // Retire the killed pool immediately rather than at the end of the run, so a 200-point
        // run does not hold 200 idle pools open against the container.
        await pool.end({ timeout: 2 }).catch(() => {});

        const observation = await observeHeight(admin, schema, net, height, watermarkKey);
        let classified: RuleAState;
        try {
          classified = classifyRuleAState(observation, expected);
        } catch (err) {
          throw new Error(
            `point ${point} (height ${height}, kill before statement ${killAtStatement}, ` +
              `shape ${JSON.stringify(spec)}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        seen[classified]++;
        // A kill that landed inside the transaction must have surfaced as an error, and a run
        // that completed must not have. Without this, a fault that silently did nothing would
        // still "pass" by observing a complete height.
        if (classified === "nothing-of-height") expect(threw).toBe(true);

        if (classified === "nothing-of-height") {
          // Retry the SAME height, unfaulted: the recovery the rule promises ("continue from the
          // last committed height"), and simultaneously the per-point negative control -- the
          // identical bundle lands whole when nothing kills it.
          const retryStore = new PgChainArchiveStore(writer, schema);
          await retryStore.putBlockBundle(bundle);
          expect(
            classifyRuleAState(await observeHeight(admin, schema, net, height, watermarkKey), expected),
          ).toBe("all-of-height");
        }
        parentHash = bundle.block.blockHash;
      }

      // Non-vacuity: the run must actually have interrupted transactions, not just completed
      // every one of them. Both classes must be represented.
      expect(seen["nothing-of-height"]).toBeGreaterThan(0);
      expect(seen["all-of-height"]).toBeGreaterThan(0);
      expect(seen["nothing-of-height"] + seen["all-of-height"]).toBe(ARCHIVE_CRASH_POINTS);
    },
    900_000,
  );

  it(
    "[[crash.archive-height.sigkill-two-states]] SIGKILLing the writer PROCESS inside the per-height transaction, and immediately after its commit, leaves only {nothing of H, all of H incl. watermark}",
    async () => {
      const net = "rule_a_sigkill";
      const watermarkKey = `${WATERMARK_KEY_PREFIX}${net}`;
      const spec = { txCount: 2, observationCount: 1, withCheckpoint: true };
      // Named points spanning the transaction: the very first statement (the advisory lock), the
      // block insert, inside the transaction rows, the checkpoint/watermark tail, and finally the
      // instant after COMMIT returned -- the point that used to leave the watermark behind.
      const points: (number | "after-commit")[] = [1, 4, 8, 11, 17, 20, "after-commit"];

      let parentHash = GENESIS_PARENT_HASH;
      for (const [index, crashAt] of points.entries()) {
        const height = index;
        const bundle = buildHeightBundle({ net, height, parentHash, ...spec });
        const expected = {
          height,
          transactionRows: spec.txCount,
          observationRows: spec.observationCount,
          checkpointRows: spec.withCheckpoint ? 1 : 0,
        };

        const child = spawnWorker({
          connectionUri: container.getConnectionUri(), schema, net, height, parentHash,
          crashAt, ...spec,
        });
        try {
          const ready = await waitForReady(child, 60_000);
          expect(ready.height).toBe(height);
          child.kill("SIGKILL");
          const exit = await waitForExit(child);
          expect(exit.signal).toBe("SIGKILL");

          const observed = await observeHeight(admin, schema, net, height, watermarkKey);
          const classified = classifyRuleAState(observed, expected);
          // The two points are not interchangeable, and asserting only "one of the two states"
          // would let a regression that never commits anything pass the whole suite.
          expect(classified).toBe(crashAt === "after-commit" ? "all-of-height" : "nothing-of-height");

          if (classified === "nothing-of-height") {
            const retry = new PgChainArchiveStore(writer, schema);
            await retry.putBlockBundle(bundle);
            expect(
              classifyRuleAState(await observeHeight(admin, schema, net, height, watermarkKey), expected),
            ).toBe("all-of-height");
          }
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
        parentHash = bundle.block.blockHash;
      }
    },
    300_000,
  );

  it(
    "[[crash.archive-height.negative-control-unfolded-writes]] the pre-fold three-transaction shape DOES expose a partial height — so the two-state result above is caused by the fold, not by the assertions",
    async () => {
      const net = "rule_a_control";
      const watermarkKey = `${WATERMARK_KEY_PREFIX}${net}`;
      const height = 0;
      const bundle = buildHeightBundle({
        net, height, parentHash: GENESIS_PARENT_HASH,
        txCount: 2, observationCount: 1, withCheckpoint: true,
      });
      const store = new PgChainArchiveStore(writer, schema);

      // Exactly what `sync-service.ts` did before this change: the bundle in one transaction,
      // then the checkpoint in a second, then the watermark in a third. Crash after the first --
      // simulated here by simply not issuing the other two.
      await store.putBlockBundle({
        block: bundle.block,
        transactions: bundle.transactions,
        bridgeObservations: bundle.bridgeObservations,
      });

      const observed = await observeHeight(admin, schema, net, height, watermarkKey);
      // Neither of Rule A's two states: the block, its transactions and its observations are
      // durable while the checkpoint and the watermark are not.
      expect(() => classifyRuleAState(observed, {
        height, transactionRows: 2, observationRows: 1, checkpointRows: 1,
      })).toThrow(/Rule A violation/);
      expect(observed.blockRows).toBe(1);
      expect(observed.checkpointRows).toBe(0);
      expect(observed.watermarkHeight).toBeUndefined();
    },
    120_000,
  );

  it(
    "[[crash.archive-height.notify-only-on-commit]] the progress NOTIFY is delivered for a committed height and never for a rolled-back one",
    async () => {
      const net = "rule_a_notify";
      const listener = createClient({
        connectionString: container.getConnectionUri(), schema, maxConnections: 1,
      });
      const received: string[] = [];
      try {
        await listener.listen("chain_archive_progress", (payload) => { received.push(payload); });

        // (1) A height whose transaction is rolled back: nothing must arrive. The NOTIFY is
        // issued inside the transaction, so PostgreSQL queues it and discards it on rollback --
        // which is exactly why a listener can treat an arrival as "this height is readable".
        const rolledBack = buildHeightBundle({
          net, height: 0, parentHash: GENESIS_PARENT_HASH,
          txCount: 1, observationCount: 0, withCheckpoint: false,
        });
        const state: FaultState = {
          count: 0,
          killAtStatement: 8,
          onReached: async (backendPid) => { await pgTerminateBackend(admin, backendPid); },
        };
        const pool = faultPool();
        await expect(
          new PgChainArchiveStore(withStatementFault(pool, state), schema).putBlockBundle(rolledBack),
        ).rejects.toBeDefined();
        await pool.end({ timeout: 2 }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(received).toEqual([]);

        // (2) The same height, committed: the notification arrives with the height in it.
        await new PgChainArchiveStore(writer, schema).putBlockBundle(rolledBack);
        for (let i = 0; i < 40 && received.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(received).toEqual([`${net}:0`]);
      } finally {
        await listener.end({ timeout: 5 });
      }
    },
    120_000,
  );
});

interface SpawnWorkerOptions {
  connectionUri: string;
  schema: string;
  net: string;
  height: number;
  parentHash: string;
  txCount: number;
  observationCount: number;
  withCheckpoint: boolean;
  crashAt: number | "after-commit" | undefined;
}

function spawnWorker(opts: SpawnWorkerOptions): ChildProcess {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("UMBRADB_ARCHIVE_") || key.startsWith("UMBRADB_TEST_")) delete env[key];
  }
  env.UMBRADB_TEST_CONNECTION_URI = opts.connectionUri;
  env.UMBRADB_TEST_SCHEMA = opts.schema;
  env.UMBRADB_ARCHIVE_NET = opts.net;
  env.UMBRADB_ARCHIVE_HEIGHT = String(opts.height);
  env.UMBRADB_ARCHIVE_PARENT_HASH = opts.parentHash;
  env.UMBRADB_ARCHIVE_TX_COUNT = String(opts.txCount);
  env.UMBRADB_ARCHIVE_OBS_COUNT = String(opts.observationCount);
  env.UMBRADB_ARCHIVE_CHECKPOINT = opts.withCheckpoint ? "1" : "0";
  if (opts.crashAt !== undefined) env.UMBRADB_ARCHIVE_CRASH_AT = String(opts.crashAt);
  // `--import tsx` runs in-process, so `child.pid` IS the worker's node process and SIGKILL is a
  // literal cross-process kill of the writer mid-operation (same rationale as `spawnCrashWorker`).
  return spawn(process.execPath, ["--import", "tsx", WORKER_ENTRYPOINT], {
    cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForReady(child: ChildProcess, timeoutMs: number): Promise<{ height: number; [k: string]: unknown }> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("exit", onExit);
      fn();
    };
    const onOut = (chunk: Buffer): void => {
      out += chunk.toString();
      const line = out.split("\n").find((l) => l.includes(READY_SENTINEL));
      if (line !== undefined) {
        done(() => resolve(JSON.parse(line.slice(line.indexOf(READY_SENTINEL) + READY_SENTINEL.length))));
      }
    };
    const onErr = (chunk: Buffer): void => {
      err += chunk.toString();
      if (err.includes(ERROR_SENTINEL)) done(() => reject(new Error(`worker error: ${err}`)));
    };
    const onExit = (code: number | null, signal: string | null): void => {
      done(() => reject(new Error(`worker exited (${code}/${signal}) before readiness. stderr: ${err}`)));
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`worker readiness timed out. stdout: ${out} stderr: ${err}`))),
      timeoutMs,
    );
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
