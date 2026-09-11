import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgArchiveReadContract } from "../../../src/postgres/archive-read-contract.js";
import { PgChainArchiveStore } from "../../../src/postgres/chain-archive-store.js";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../../src/postgres/migrations/chain_archive/index.js";
import { bootstrapShieldedMonitorSchema } from "../../../shielded-monitor/bootstrap.js";
import { LEDGER_BUILD_ID, MATCHING_RULE_VERSION } from "../../../shielded-monitor/offers.js";
import { ShieldedMonitorScanner } from "../../../shielded-monitor/scanner.js";
import { PgShieldedMonitorStore } from "../../../shielded-monitor/store.js";
import { encodeViewingKey, parseViewingKey } from "../../../shielded-monitor/viewing-key.js";
import { buildCorpus, type BuiltCorpus } from "../../fixtures/shielded-monitor/build-corpus.js";
import { pgTerminateBackend } from "../../postgres/setup.js";
import { withStatementFault, type FaultState } from "./archive-fault-injection.js";
import {
  classifyRuleBState, CRASH_NET, crashHeightBundle, heightShape, observeMonitorHeight,
  type RuleBState,
} from "./monitor-batch-fixture.js";

/**
 * **Owner Rule B** (`spec/00009` User Story 5 scenario 2, FR-010): for one monitor, ALL the
 * associations of a block height and the coverage advance to that height commit in ONE
 * `BEGIN … COMMIT` in `shielded_monitor`. After a crash at ANY point, exactly two states are
 * observable: no association of that height with coverage below it, or all of them with
 * coverage AT it. There is no third state, and a redone batch produces the golden association
 * set exactly once.
 *
 * The suite is the Rule A suite's shape, deliberately — same instrumentation module, same two
 * lanes, same negative control — because the two rules are the same claim about two writers and
 * a reviewer should be able to read one after the other:
 *
 *  - **PostgreSQL kill, in-process, 200 randomized points.** A backend can be terminated
 *    hundreds of times in one process, so this lane carries the volume. Each point picks a
 *    height (whose shape — zero, one or two matches, sometimes a system transaction, sometimes
 *    no transactions at all — is fixed by `monitor-batch-fixture.ts`) and a random statement
 *    index inside the advance transaction, kills the writer's backend with the transaction
 *    open, and classifies what survived.
 *  - **Process SIGKILL, child process, named points.** A real separate OS process running the
 *    real scanner, killed with a real signal, before the commit and immediately after it.
 *
 * The zero-match heights are what make this more than a restatement of "one transaction is
 * atomic": for them "no associations of H" is true in BOTH states, so the classification turns
 * entirely on coverage — which is precisely the distinction FR-011 forbids collapsing.
 */

const WORKER_ENTRYPOINT = fileURLToPath(new URL("./monitor-batch-worker.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const READY_SENTINEL = "@@CRASH_WORKER_READY@@";

/** Randomized crash points for the PostgreSQL-kill lane. 200 is the plan's number; the env
 *  override exists for a fast local loop, never for CI. */
const MONITOR_CRASH_POINTS = Number(process.env.UMBRADB_MONITOR_CRASH_POINTS ?? "200");

/** Deterministic PRNG so a failing run is reproducible from the seed in the message. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("Rule B: one block height, one transaction — the only observable states are none of H and all of H", () => {
  let container: StartedPostgreSqlContainer;
  let admin: UmbraDBSql;
  /** Never the target of a kill: used for the archive reads, the unfaulted retries and the
   *  observations, so it stays healthy for the whole run. */
  let clean: UmbraDBSql;
  let corpus: BuiltCorpus;
  let archiveStore: PgChainArchiveStore;
  let archive: PgArchiveReadContract;
  let cleanStore: PgShieldedMonitorStore;
  let monitorId: string;
  const archiveSchema = "rule_b_archive";
  const monitorSchema = "rule_b_monitor";
  /** One more height than there are crash points, so the tip is never reached and `goLive`
   *  (another `begin`) never fires inside a faulted batch. */
  const HEIGHTS = MONITOR_CRASH_POINTS + 8;

  beforeAll(async () => {
    corpus = await buildCorpus();
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    admin = createClient({ connectionString: container.getConnectionUri(), schema: monitorSchema, maxConnections: 4 });
    await runMigrations(admin, { schema: archiveSchema, migrations: chainArchiveMigrations });
    await bootstrapShieldedMonitorSchema(admin, monitorSchema);

    clean = createClient({
      connectionString: container.getConnectionUri(), schema: monitorSchema,
      maxConnections: 4, connectTimeout: 10,
    });
    archiveStore = new PgChainArchiveStore(clean, archiveSchema);
    archive = new PgArchiveReadContract(clean, archiveSchema);
    cleanStore = new PgShieldedMonitorStore(clean, monitorSchema);
    await archiveStore.ensureArchiveInstanceId(CRASH_NET);

    const rawById = new Map(corpus.transactions.map((t) => [t.spec.id, t.rawBytes]));
    for (let height = 0; height < HEIGHTS; height++) {
      await archiveStore.putBlockBundle(crashHeightBundle(height, rawById, corpus.manifest.protocolVersion));
    }

    const serialized = corpus.keyBytes.get("K")!;
    const key = await parseViewingKey(encodeViewingKey(serialized, CRASH_NET), CRASH_NET);
    const monitor = await cleanStore.register({
      key, net: CRASH_NET, requestedStartHeight: 0n,
      matchingRuleVersion: MATCHING_RULE_VERSION, ledgerBuild: LEDGER_BUILD_ID, actor: "rule-b-crash",
    });
    monitorId = monitor.id;
    // Bind the archive identity up front, so the FIRST faulted batch's statement indices
    // describe the advance transaction and not a one-off binding transaction.
    const identity = (await archive.getArchiveIdentity(CRASH_NET))!;
    await cleanStore.bindArchiveSource(monitorId, monitor.epoch, {
      genesisHash: identity.genesisHash, instanceId: identity.archiveInstanceId,
    });
  }, 600_000);

  afterAll(async () => {
    await Promise.allSettled(faultPools.map((p) => p.end({ timeout: 2 })));
    await clean?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
    await container?.stop();
  });

  /** Pools that have had a backend killed under them, retired rather than reused.
   *
   *  A pool is NOT reusable across kills, and this is a measured `postgres.js` behaviour rather
   *  than caution (00009-01 found it and the master plan carries it as an integration note): the
   *  driver keeps a SHARED `retries` counter that increments on every errored close and drives a
   *  `3^retries/100`-second reconnect backoff, reset only by a successful reconnect. After a
   *  handful of kills every later statement on that pool fails CONNECT_TIMEOUT. One pool per
   *  killed write sidesteps it: the counter is per-`postgres()` instance. */
  const faultPools: UmbraDBSql[] = [];
  const faultPool = (): UmbraDBSql => {
    const pool = createClient({
      connectionString: container.getConnectionUri(), schema: monitorSchema,
      maxConnections: 1, connectTimeout: 10,
    });
    faultPools.push(pool);
    return pool;
  };

  it(
    `[[crash.shielded-monitor-batch.pg-kill-two-states]] ${MONITOR_CRASH_POINTS} randomized PostgreSQL kills inside the scanner's per-batch transaction leave only {no associations of H and coverage H-1, all of H and coverage H}`,
    async () => {
      const rng = makeRng(0xb00b_1e5);
      const seen: Record<RuleBState, number> = { "nothing-of-height": 0, "all-of-height": 0 };
      let totalBefore = 0;
      let killsWithMatches = 0;
      let killsWithoutMatches = 0;

      for (let height = 0; height < MONITOR_CRASH_POINTS; height++) {
        const shape = heightShape(height);
        const expectedRows = shape.matchPositions.length;
        // Statements inside the advance transaction: 1 (the fencing UPDATE) + one INSERT per
        // association. Drawing one index beyond that on purpose — an index past the end means
        // the transaction is never interrupted, which must land the whole batch: a control
        // point mixed in with the faults rather than a separate, skippable test.
        const killAtStatement = 1 + Math.floor(rng() * (expectedRows + 2));

        const state: FaultState = {
          count: 0,
          killAtStatement,
          onReached: async (backendPid) => { await pgTerminateBackend(admin, backendPid); },
        };
        const pool = faultPool();
        const store = new PgShieldedMonitorStore(withStatementFault(pool, state), monitorSchema);
        const scanner = new ShieldedMonitorScanner(archive, store, { net: CRASH_NET, batchBlocks: 1 });
        const loaded = await cleanStore.get(monitorId);
        expect(loaded.coverage.scannedThrough ?? -1n).toBe(BigInt(height) - 1n);

        let threw = false;
        try {
          const result = await scanner.scanBatch(loaded);
          if (result.kind !== "advanced") threw = true;
        } catch {
          threw = true;
        }
        await pool.end({ timeout: 2 }).catch(() => {});

        const observation = await observeMonitorHeight(clean, monitorSchema, monitorId, height);
        let classified: RuleBState;
        try {
          classified = classifyRuleBState(observation, { height, associationRows: expectedRows, totalBefore });
        } catch (err) {
          throw new Error(
            `point ${height} (kill before statement ${killAtStatement}, shape ` +
              `${JSON.stringify(shape)}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        seen[classified]++;
        if (classified === "nothing-of-height") {
          expect(threw, `a kill that rolled the batch back must have surfaced as a failure`).toBe(true);
          if (expectedRows > 0) killsWithMatches++; else killsWithoutMatches++;

          // Redo the SAME batch, unfaulted: the recovery the rule promises, and the per-point
          // negative control — the identical batch lands whole when nothing kills it.
          const retryScanner = new ShieldedMonitorScanner(archive, cleanStore, {
            net: CRASH_NET, batchBlocks: 1,
          });
          const retry = await retryScanner.scanBatch(await cleanStore.get(monitorId));
          expect(retry.kind).toBe("advanced");
          expect(
            classifyRuleBState(
              await observeMonitorHeight(clean, monitorSchema, monitorId, height),
              { height, associationRows: expectedRows, totalBefore },
            ),
          ).toBe("all-of-height");
        }
        totalBefore += expectedRows;
      }

      // Non-vacuity: the run must actually have interrupted transactions, and must have
      // interrupted both a height WITH associations (where the two states differ in row count)
      // and a height WITHOUT any (where they differ only in coverage — the case a naive
      // implementation gets wrong).
      expect(seen["nothing-of-height"]).toBeGreaterThan(0);
      expect(seen["all-of-height"]).toBeGreaterThan(0);
      expect(seen["nothing-of-height"] + seen["all-of-height"]).toBe(MONITOR_CRASH_POINTS);
      expect(killsWithMatches, "at least one interrupted height must have carried matches").toBeGreaterThan(0);
      expect(killsWithoutMatches, "at least one interrupted height must have carried NO matches").toBeGreaterThan(0);

      // And the golden set: every height's associations, exactly once, in order.
      const finalAssociations = await cleanStore.readAssociations(monitorId, 0n, 1000);
      expect(finalAssociations).toHaveLength(totalBefore);
      const keys = finalAssociations.map((a) => `${a.blockHeight}/${a.position}`);
      expect(new Set(keys).size, "no duplicate (height, position) after 200 crash-and-redo cycles").toBe(keys.length);
    },
    1_800_000,
  );

  it(
    "[[crash.shielded-monitor-batch.sigkill-two-states]] SIGKILLing the scanner PROCESS inside its per-batch transaction, and immediately after its commit, leaves only {no associations of H and coverage H-1, all of H and coverage H}",
    async () => {
      // Heights above the pg-kill lane's range, so the two lanes never contend for one height.
      const startHeight = Number((await cleanStore.get(monitorId)).coverage.scannedThrough ?? -1n) + 1;
      let totalBefore = (await cleanStore.readAssociations(monitorId, 0n, 1000)).length;

      // The crash point is chosen PER HEIGHT from that height's own statement count, because a
      // height with no matches issues exactly one statement (the fencing UPDATE) and asking to
      // pause before statement 2 there would not pause at all — the worker would commit and
      // exit, and the parent would "SIGKILL" an already-finished process and observe
      // `all-of-height` for a point it believed was mid-transaction. The `hook` assertion below
      // makes that failure mode impossible to reach silently even if this arithmetic drifts.
      const points: { height: number; crashAt: number | "after-commit" }[] = [];
      for (let offset = 0; points.length < 5; offset++) {
        const height = startHeight + offset;
        const rows = heightShape(height).matchPositions.length;
        // Statements in the advance transaction: 1 fencing UPDATE + one INSERT per association.
        const statements = 1 + rows;
        points.push({ height, crashAt: offset % 2 === 0 ? ((offset % statements) + 1) : "after-commit" });
      }

      for (const { height, crashAt } of points) {
        const expectedRows = heightShape(height).matchPositions.length;

        const child = spawnWorker({
          connectionUri: container.getConnectionUri(), archiveSchema, monitorSchema,
          monitorId, height, crashAt,
        });
        try {
          const ready = await waitForReady(child, 120_000);
          expect(ready.height).toBe(height);
          // The worker must have paused where we asked. Without this, a point that fell past
          // the end of the transaction would report the post-run sentinel (`hook: null`) and the
          // kill would land on a process that had already committed — a "crash point" that
          // never crashed anything.
          expect(
            ready.hook,
            `the worker was asked to pause at ${String(crashAt)} but signalled ${JSON.stringify(ready.hook)}`,
          ).toBe(crashAt === "after-commit" ? "after-commit" : `before-statement-${crashAt}`);
          child.kill("SIGKILL");
          const exit = await waitForExit(child);
          expect(exit.signal).toBe("SIGKILL");

          const observed = await observeMonitorHeight(clean, monitorSchema, monitorId, height);
          const classified = classifyRuleBState(observed, { height, associationRows: expectedRows, totalBefore });
          // The two points are NOT interchangeable, and asserting only "one of the two" would
          // let a regression that never commits anything pass the whole suite.
          expect(
            classified,
            `crashAt=${String(crashAt)} at height ${height} (expected ${expectedRows} associations)`,
          ).toBe(crashAt === "after-commit" ? "all-of-height" : "nothing-of-height");

          if (classified === "nothing-of-height") {
            const retryScanner = new ShieldedMonitorScanner(archive, cleanStore, {
              net: CRASH_NET, batchBlocks: 1,
            });
            expect((await retryScanner.scanBatch(await cleanStore.get(monitorId))).kind).toBe("advanced");
            expect(
              classifyRuleBState(
                await observeMonitorHeight(clean, monitorSchema, monitorId, height),
                { height, associationRows: expectedRows, totalBefore },
              ),
            ).toBe("all-of-height");
          }
          totalBefore += expectedRows;
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
      }
    },
    600_000,
  );

  it(
    "[[crash.shielded-monitor-batch.negative-control-unfolded-writes]] an UNFOLDED two-transaction shape (associations, then coverage) DOES expose a partial batch — so the two-state result above is caused by the fold, not by the assertions",
    async () => {
      // What a scanner that wrote the associations first and advanced coverage afterwards would
      // leave behind if it died between the two. Written directly, because the production path
      // cannot produce it — which is the point.
      const height = Number((await cleanStore.get(monitorId)).coverage.scannedThrough ?? -1n) + 1;
      const totalBefore = (await cleanStore.readAssociations(monitorId, 0n, 1000)).length;
      const [row] = await clean<{ last_assoc_seq: bigint }[]>`
        SELECT last_assoc_seq FROM ${clean(monitorSchema)}.monitors WHERE id = ${monitorId}
      `;
      const seq = row!.last_assoc_seq + 1n;
      await clean`
        INSERT INTO ${clean(monitorSchema)}.associations (
          monitor_id, seq, net, block_height, block_hash, position, tx_hash, protocol_version,
          matched_segments, applied_outcome, matching_rule_version, ledger_build
        ) VALUES (
          ${monitorId}, ${seq}, ${CRASH_NET}, ${height}, ${Buffer.alloc(32, 1)}, 0,
          ${Buffer.alloc(32, 2)}, ${1_000_000}, '{0}'::smallint[], 'unknown',
          ${MATCHING_RULE_VERSION}, ${LEDGER_BUILD_ID}
        )
      `;
      await clean`
        UPDATE ${clean(monitorSchema)}.monitors SET last_assoc_seq = ${seq} WHERE id = ${monitorId}
      `;

      const observed = await observeMonitorHeight(clean, monitorSchema, monitorId, height);
      expect(() => classifyRuleBState(observed, { height, associationRows: 1, totalBefore }))
        .toThrow(/Rule B violation/);
      expect(observed.associationRows).toBe(1);
      expect(observed.coverageThrough).toBe(height - 1);

      // Leave the monitor consistent for anything that runs after this case.
      await clean`
        DELETE FROM ${clean(monitorSchema)}.associations WHERE monitor_id = ${monitorId} AND seq = ${seq}
      `;
      await clean`
        UPDATE ${clean(monitorSchema)}.monitors SET last_assoc_seq = ${seq - 1n} WHERE id = ${monitorId}
      `;
    },
    300_000,
  );

  it(
    "[[crash.shielded-monitor-batch.write-set-is-shielded-monitor-only]] across the whole crash run, project B's statement log names only shielded_monitor tables as write targets — and a positive control shows an archive write WOULD be caught",
    async () => {
      // The audit instrument: every statement the scanner issues on its own handle, captured by
      // a proxy, filtered to the ones that WRITE. Reading a statement log is only worth anything
      // if the reader is shown to catch a violation, hence the control at the end.
      const statements: string[] = [];
      const logged = logStatements(clean, statements);
      const store = new PgShieldedMonitorStore(logged, monitorSchema);
      const scanner = new ShieldedMonitorScanner(
        new PgArchiveReadContract(logged, archiveSchema), store, { net: CRASH_NET, batchBlocks: 3 },
      );
      await scanner.scanBatch(await cleanStore.get(monitorId));

      // "A write" is the statement's LEADING verb, not the appearance of a keyword anywhere in
      // it. That distinction is not pedantry: the scanner's own `SELECT … FOR UPDATE` contains
      // the word UPDATE, and a substring detector classifies it as a write and then fails to
      // find a target — which is exactly what the first version of this audit did.
      const writes = statements.map(normalize).filter(isWriteStatement);
      expect(writes.length, "the batch must have written something, or this proves nothing").toBeGreaterThan(0);
      const targets = writes.map(writeTarget);
      for (const [index, target] of targets.entries()) {
        expect(target, `could not read a write target from: ${writes[index]}`).not.toBe("");
        expect(target.toLowerCase(), `a write named a table outside B's schema: ${writes[index]}`)
          .not.toContain(archiveSchema);
        expect(target.toLowerCase(), `a write named a table outside B's schema: ${writes[index]}`)
          .toContain(monitorSchema);
      }
      // The scan DID read the archive in the same run — through the contract — so "no archive
      // writes" is a statement about a run that genuinely touched the archive.
      expect(statements.some((s) => s.includes(archiveSchema))).toBe(true);

      // Two positive controls, because an audit nobody has seen catch anything is not evidence.
      // (1) an archive write IS classified as a write and IS flagged;
      const control = normalize(`INSERT INTO ${archiveSchema}.watermarks (kind, key, value) VALUES ('x','y','{}')`);
      expect(isWriteStatement(control)).toBe(true);
      expect(writeTarget(control)).toContain(archiveSchema);
      // (2) a `SELECT … FOR UPDATE` is NOT classified as a write, so the detector is precise
      //     rather than merely permissive.
      expect(isWriteStatement(normalize(`SELECT * FROM ${monitorSchema}.monitors WHERE id = 'x' FOR UPDATE`)))
        .toBe(false);
    },
    300_000,
  );
});

/** Collapses whitespace so a multi-line tagged template is one comparable line. */
function normalize(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

/** True when the statement's LEADING verb writes. */
function isWriteStatement(statement: string): boolean {
  return /^(insert\s+into|update|delete\s+from)\b/i.test(statement);
}

/** The identifier that leading verb writes to, or "" if it cannot be read. */
function writeTarget(statement: string): string {
  return /^(?:insert\s+into|update|delete\s+from)\s+("?[\w.]+"?)/i.exec(statement)?.[1] ?? "";
}

/** A pass-through `UmbraDBSql` that records the text of every tagged statement it issues,
 *  including the ones inside `begin` callbacks. Test-only instrumentation: no fault code in
 *  `src/` or `shielded-monitor/`. */
function logStatements(sql: UmbraDBSql, sink: string[]): UmbraDBSql {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const isTagged = (args: readonly unknown[]): boolean => {
    const first = args[0];
    return Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, "raw");
  };
  const record = (args: any[]): void => {
    const strings = args[0] as readonly string[];
    const values = args.slice(1);
    // Rendered with the SCHEMA/identifier fragments interpolated, since those are what a write
    // target actually is here — a `postgres.js` identifier helper, not a literal.
    sink.push(strings.map((part, i) => part + (i < values.length ? renderValue(values[i]) : "")).join(""));
  };
  const renderValue = (value: unknown): string => {
    // An identifier fragment (`sql(schema)`) carries the name; anything else is a parameter and
    // its VALUE is irrelevant to a write-target audit (and could be key material).
    const asAny = value as any;
    if (typeof asAny === "function" || (asAny !== null && typeof asAny === "object" && "value" in asAny)) {
      return String(asAny?.value ?? "?");
    }
    return "?";
  };
  const wrap = (target: any): any => {
    const wrapped = (...args: any[]): any => {
      if (isTagged(args)) record(args);
      return target(...args);
    };
    return new Proxy(wrapped, {
      get: (_t, property) => {
        if (property === "begin") {
          return (fn: any) => target.begin((tx: any) => fn(wrap(tx)));
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
      has: (_t, property) => property in target,
    });
  };
  return wrap(sql as any) as UmbraDBSql;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

interface SpawnWorkerOptions {
  connectionUri: string;
  archiveSchema: string;
  monitorSchema: string;
  monitorId: string;
  height: number;
  crashAt: number | "after-commit" | undefined;
}

function spawnWorker(opts: SpawnWorkerOptions): ChildProcess {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("UMBRADB_MONITOR_") || key.startsWith("UMBRADB_TEST_")) delete env[key];
  }
  env.UMBRADB_TEST_CONNECTION_URI = opts.connectionUri;
  env.UMBRADB_MONITOR_ARCHIVE_SCHEMA = opts.archiveSchema;
  env.UMBRADB_MONITOR_SCHEMA = opts.monitorSchema;
  env.UMBRADB_MONITOR_ID = opts.monitorId;
  env.UMBRADB_MONITOR_HEIGHT = String(opts.height);
  if (opts.crashAt !== undefined) env.UMBRADB_MONITOR_CRASH_AT = String(opts.crashAt);
  // `--import tsx` runs in-process, so `child.pid` IS the scanner's node process and SIGKILL is
  // a literal cross-process kill of the writer mid-operation.
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
    const onErr = (chunk: Buffer): void => { err += chunk.toString(); };
    const onExit = (code: number | null, signal: string | null): void => {
      done(() => reject(new Error(
        `monitor-batch-worker exited before signalling ready (code ${code}, signal ${signal}).\n` +
          `stdout: ${out}\nstderr: ${err}`,
      )));
    };
    const timer = setTimeout(() => {
      done(() => reject(new Error(`monitor-batch-worker did not signal ready within ${timeoutMs} ms.\nstdout: ${out}\nstderr: ${err}`)));
    }, timeoutMs);
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
    child.once("exit", (code, signal) => { resolve({ code, signal }); });
  });
}
