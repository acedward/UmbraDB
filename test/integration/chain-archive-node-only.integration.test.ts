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

  it("ingests from genesis including system transactions, with no indexer request", async () => {
    // Node-only ingest now archives system transactions, so it can build a full archive from
    // block 0. It gets their authoritative hash from SystemTransaction.transactionHash(); that
    // export is absent from every published @midnight-ntwrk/ledger-v8, so this asserts the
    // REFUSAL instead when running against a stock package -- refusing is correct there, because
    // an archive written without them cannot be repaired in place (all inserts are
    // ON CONFLICT DO NOTHING).
    const schema = "node_only_gate";
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);

    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(typeof input === "string" ? input : input.toString());
      return realFetch(input, init);
    }) as typeof fetch;

    let ingested = 0;
    let refusedForMissingExport = false;
    try {
      const service = new ChainArchiveSyncService({
        sql, net: NET, schema, node: { url: NODE_URL, timeoutMs: 30_000 },
      });
      try {
        ingested = (await service.syncOnce({ maxBlocks: 40 })).ingestedBlocks;
      } catch (e) {
        if (!/exposes no SystemTransaction\.transactionHash/.test((e as Error).message)) throw e;
        refusedForMissingExport = true;
      }
    } finally {
      globalThis.fetch = realFetch;
    }

    // The no-indexer guarantee holds either way, verified by observing the requests made.
    const indexerCalls = requested.filter((u) => INDEXER_SHAPED.test(u));
    expect(indexerCalls, `unexpected indexer-shaped request(s): ${indexerCalls.join(", ")}`).toEqual([]);
    expect(requested.length).toBeGreaterThan(0);

    if (refusedForMissingExport) return; // stock ledger build: refusal is the correct outcome

    expect(ingested).toBeGreaterThan(0);
    const txs = await sql<{ h: string; position: number; kind: string; hash_len: number }[]>`
      SELECT block_height::text AS h, position, kind, octet_length(tx_hash) AS hash_len
      FROM ${sql(schema)}.transactions WHERE net = ${NET} ORDER BY block_height, position
    `;
    // Genesis carries system transactions on every Midnight chain; archiving them is the point.
    expect(txs.some((t) => t.kind === "system")).toBe(true);
    for (const t of txs) expect(t.hash_len).toBe(32);
    // Positions are contiguous from 0 across BOTH kinds -- the ordering the indexer uses.
    const byBlock = new Map<string, number[]>();
    for (const t of txs) byBlock.set(t.h, [...(byBlock.get(t.h) ?? []), t.position]);
    for (const [h, positions] of byBlock) {
      expect(positions, `positions in block ${h} must be contiguous from 0`).toEqual(
        positions.map((_, i) => i),
      );
    }
  }, 180_000);
});
