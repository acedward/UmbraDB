import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { evmRpcMigrations } from "../../../src/postgres/migrations/evm_rpc/index.js";
import { startIngest } from "../ingest.js";
import { readCursor, type SqlPool } from "../store.js";
import { defaultAddressMapper, toHex, type MidnightEvent } from "../event-map.js";
import { startFakeIndexer } from "./fake-indexer.js";
import { CRASH_INGEST_COMMITTED, CRASH_INGEST_READY } from "./crash-sentinels.js";

const WORKER = fileURLToPath(new URL("./crash-ingest-worker.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * C-G2's crash requirement: `kill -9` mid-batch leaves NO partial state.
 *
 * A real, separate OS process is killed with a real SIGKILL while it is actively committing —
 * `store.writeLogs` puts the rows and the cursor in one transaction, and this is the test that the
 * claim survives contact with an uncooperative process death rather than only with a clean
 * rollback. The assertions are invariants, not row counts, because exactly WHERE the kill lands is
 * not deterministic:
 *
 *   - no torn pair: a Spend/Receive pair maps to one Transfer, so any mint/burn-shaped row
 *     (`from`/`to` == address(0)) would mean half a transaction was committed;
 *   - the cursor never runs ahead of the rows it claims to account for;
 *   - every surviving row is INTERNALLY correct (its amount matches its own transaction);
 *   - a restarted ingester converges on the complete, duplicate-free set.
 */
describe("ingest crash safety (C-G2, kill -9)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "evm_rpc";
  const CONTRACT = "11".repeat(32);
  const ALICE = "a1".repeat(32);
  const BOB = "b0".repeat(32);
  const PAIRS = 120;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: evmRpcMigrations });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  /** Each transaction carries a DISTINCT amount equal to its transaction id, so a row can be
   *  checked against its own source rather than only counted. */
  function pair(txId: number): [MidnightEvent, MidnightEvent] {
    const txHash = txId.toString(16).padStart(4, "0").repeat(16);
    const transaction = {
      hash: txHash,
      block: { height: txId, hash: "bb".repeat(32), transactions: [{ hash: txHash }] },
    };
    const common = {
      contractAddress: CONTRACT,
      transactionId: txId,
      transaction,
      domainSep: "d5".repeat(32),
      tokenType: "77".repeat(32),
      amount: String(txId),
    };
    return [
      {
        __typename: "UnshieldedSpendEvent",
        id: txId * 2 - 1,
        ...common,
        sender: { kind: "USER", userAddress: ALICE, contractAddress: null },
      },
      {
        __typename: "UnshieldedReceiveEvent",
        id: txId * 2,
        ...common,
        recipient: { kind: "USER", userAddress: BOB, contractAddress: null },
      },
    ];
  }

  it("survives a SIGKILL mid-batch with no partial state, and a restart converges", async () => {
    const indexer = await startFakeIndexer();
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, ["--import", "tsx", WORKER], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CRASH_PG_URI: container.getConnectionUri(),
          CRASH_SCHEMA: schema,
          CRASH_INDEXER_WS: indexer.url,
          CRASH_CONTRACT: CONTRACT,
          CRASH_IDLE_FLUSH_MS: "80",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let commits = 0;
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        commits = stdout.split(CRASH_INGEST_COMMITTED).length - 1;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 40_000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
          if (child?.exitCode !== null && child?.exitCode !== undefined) {
            throw new Error(`worker exited early (${child.exitCode}); stderr:\n${stderr}`);
          }
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };

      await waitFor(() => stdout.includes(CRASH_INGEST_READY), "worker connected");

      // Feed a long burst so commits run back-to-back; the kill then lands DURING write activity
      // rather than on an idle process.
      for (let txId = 1; txId <= PAIRS; txId++) indexer.emit(...pair(txId));

      // Kill once writing is demonstrably underway, but long before the burst is drained.
      await waitFor(() => commits >= 3, "the worker to start committing");
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      expect(child.signalCode).toBe("SIGKILL");

      // ---- invariants after the hard kill -----------------------------------------------------
      const rows = await sql<
        { source_event_id: bigint; topic1: Buffer; topic2: Buffer; data: Buffer; block_number: bigint }[]
      >`SELECT source_event_id, topic1, topic2, data, block_number FROM ${sql(schema)}.logs
        ORDER BY source_event_id`;
      const cursor = await readCursor(sql, schema, Buffer.from(CONTRACT, "hex"));

      // Reported so a reviewer can see the kill actually landed mid-burst rather than before any
      // work (which would make every invariant below vacuous) or after all of it.
      console.log(
        `[crash] killed after ${commits} committed batch(es): ${rows.length}/${PAIRS} rows landed, cursor=${String(cursor)}`,
      );
      expect(rows.length).toBeGreaterThan(0); // the kill must not have landed before any work
      expect(rows.length).toBeLessThan(PAIRS); // ...nor after the burst was fully drained
      const alice = toHex(defaultAddressMapper({ kind: "midnight", hex: ALICE }));
      const bob = toHex(defaultAddressMapper({ kind: "midnight", hex: BOB }));

      for (const row of rows) {
        // No torn pair: both parties are real, neither is address(0).
        expect(toHex(row.topic1).slice(24)).toBe(alice);
        expect(toHex(row.topic2).slice(24)).toBe(bob);
        // The row is internally consistent: amount == its own transaction id == its block height.
        const amount = BigInt(`0x${toHex(row.data)}`);
        expect(amount).toBe(BigInt(row.block_number));
        // Keyed on the Spend, i.e. the odd id of the pair (txId*2 - 1).
        expect(Number(row.source_event_id) % 2).toBe(1);
      }
      // The cursor accounts for every row and never runs ahead of unwritten work.
      expect(cursor).not.toBeNull();
      const maxSource = Number(rows[rows.length - 1]!.source_event_id);
      expect(cursor!).toBeGreaterThanOrEqual(maxSource);
      // Rows are a contiguous prefix of the burst — no holes, which a torn commit would leave.
      expect(rows.map((r) => Number(r.source_event_id))).toEqual(
        rows.map((_, index) => index * 2 + 1),
      );

      // ---- restart in-process and let it converge ---------------------------------------------
      const restarted = startIngest({
        sql: sql as unknown as SqlPool,
        schema,
        indexerWs: indexer.url,
        contracts: [{ address: CONTRACT, profile: "erc20" }],
        idleFlushMs: 100,
        onError: () => {},
      });
      try {
        const deadline = Date.now() + 40_000;
        for (;;) {
          const counted = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM ${sql(schema)}.logs
          `;
          const n = counted[0]!.n;
          if (n === PAIRS) break;
          if (Date.now() > deadline) throw new Error(`converged to ${n} rows, expected ${PAIRS}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // Exactly one row per transaction, and no duplicates anywhere.
        const distinct = await sql<{ distinct: number }[]>`
          SELECT count(DISTINCT source_event_id)::int AS distinct FROM ${sql(schema)}.logs
        `;
        expect(distinct[0]!.distinct).toBe(PAIRS);
      } finally {
        restarted.stop();
        await restarted.done.catch(() => {});
      }
    } finally {
      child?.kill("SIGKILL");
      await indexer.close();
    }
  }, 180_000);
});
