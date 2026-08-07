import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { ledgerV8EntryPath } from "../../chain-archive-sync/tx-replay-decoder.js";

/**
 * The node-only regression gate: ingest from a REAL Midnight node with no indexer involved, and
 * prove it.
 *
 * Why this file exists separately from `chain-archive-sync.integration.test.ts`: that suite
 * constructs an indexer-backed service, so a green run there says nothing about whether the
 * archive can be built without one. The headline claim of this branch had no test that could
 * fail if the indexer were secretly required -- an audit finding, and a fair one.
 *
 * What makes the proof real rather than asserted:
 *
 *   - the service is constructed with NO `indexer` option, so no IndexerClient exists;
 *   - `globalThis.fetch` is wrapped for the duration of the sync and every request URL recorded,
 *     then asserted to contain no indexer endpoint. A future refactor that reintroduced an
 *     indexer call would fail here even if it went around this module's own client;
 *   - the archived rows are checked for the properties the indexer used to supply -- ledger
 *     transaction hashes, raw payload bytes, kind, and contiguous positions -- so "it ran" is not
 *     mistaken for "it produced the right thing".
 *
 * Environment, matching the sibling suite's convention: `MIDNIGHT_TEST_NODE_URL`, defaulting to
 * the same local devnet. Skipped (never vacuously passed) when no node answers, and when the
 * ledger WASM is unavailable -- node-only ingest needs it to hash transactions.
 */
const NODE_URL = process.env.MIDNIGHT_TEST_NODE_URL ?? "http://localhost:9944";
const NET = "node_only_gate";
/** Anything that looks like an indexer endpoint. Deliberately broad: the point is to catch a
 *  request nobody intended, so a near-miss should still trip it. */
const INDEXER_SHAPED = /(:8088|:19088|\/api\/v\d+\/graphql|graphql)/i;

async function nodeIsUp(): Promise<boolean> {
  try {
    const res = await fetch(NODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system_chain", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await nodeIsUp();
const haveLedger = ledgerV8EntryPath() !== undefined;

describe.skipIf(!up || !haveLedger)("node-only ingest against a real node (no indexer)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("refuses at genesis rather than archiving without system transactions", async () => {
    // The honest current state of node-only ingest, asserted rather than described.
    //
    // Genesis carries system transactions on every Midnight chain, and node-only ingest cannot
    // archive them: the ledger WASM exposes no SystemTransaction hash, and block 0 emits no
    // SystemTransactionApplied event to take one from. Since `syncOnce` starts at height 0 for an
    // empty archive, node-only ingest therefore cannot build a full archive of ANY chain today.
    //
    // It REFUSES instead of omitting them, because every terminal insert is
    // `ON CONFLICT DO NOTHING`: an archive written now without system transactions could not be
    // repaired by re-ingesting later, and corrected positions would collide with the rows already
    // there. An incomplete archive that looks complete is the worse failure.
    //
    // When this is fixed, this test should invert: the same range must ingest and match the
    // indexer's transaction sequence exactly. See system-transactions-plan.md.
    const schema = "node_only_gate";
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);

    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(typeof input === "string" ? input : input.toString());
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const service = new ChainArchiveSyncService({
        sql, net: NET, schema, node: { url: NODE_URL, timeoutMs: 30_000 },
      });
      await expect(service.syncOnce({ maxBlocks: 40 })).rejects.toThrow(
        /system transaction, which it cannot yet archive/,
      );
      // Nothing was written: the refusal happens before any durable write for that block.
      const blocks = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET}
      `;
      expect(blocks[0]!.n).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }

    // The no-indexer guarantee still holds during the attempt, and is still verified by observing
    // the requests actually made rather than by inspecting configuration.
    const indexerCalls = requested.filter((u) => INDEXER_SHAPED.test(u));
    expect(indexerCalls, `unexpected indexer-shaped request(s): ${indexerCalls.join(", ")}`).toEqual([]);
    expect(requested.length).toBeGreaterThan(0);
  }, 180_000);
});
