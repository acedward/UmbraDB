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

  it("ingests real blocks, issues no indexer request, and produces well-formed rows", async () => {
    const schema = "node_only_gate";
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);

    // The recorder is installed BEFORE the service is constructed, deliberately: both RPC clients
    // capture `fetch` at construction (`opts.fetchImpl ?? fetch`), so wrapping the global
    // afterwards records nothing. The first version of this test did exactly that, and the
    // "recorder actually ran" assertion below is what caught it -- without that guard the test
    // would have reported a clean no-indexer result while watching nothing at all.
    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(typeof input === "string" ? input : input.toString());
      return realFetch(input, init);
    }) as typeof fetch;

    let result;
    try {
      // No `indexer` option at all -- the service cannot construct a client it was never given.
      const service = new ChainArchiveSyncService({
        sql,
        net: NET,
        schema,
        node: { url: NODE_URL, timeoutMs: 30_000 },
      });
      result = await service.syncOnce({ maxBlocks: 40 });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(result.ingestedBlocks).toBeGreaterThan(0);

    // THE assertion this file exists for.
    const indexerCalls = requested.filter((u) => INDEXER_SHAPED.test(u));
    expect(indexerCalls, `unexpected indexer-shaped request(s): ${indexerCalls.join(", ")}`).toEqual([]);
    // Sanity: the recorder was actually wired, so an empty list means "none", not "not watching".
    expect(requested.length).toBeGreaterThan(0);

    // Blocks are contiguous from genesis, which is what the continuity check should guarantee.
    // `AS h`, not a bare `height::text`: an unqualified ORDER BY resolves to the OUTPUT column,
    // so selecting `height::text` under its own name sorts lexicographically (0,1,10,11,...,2)
    // and a contiguity assertion becomes meaningless. Aliasing keeps ORDER BY on the bigint.
    const blocks = await sql<{ h: string }[]>`
      SELECT height::text AS h FROM ${sql(schema)}.blocks WHERE net = ${NET} ORDER BY height
    `;
    expect(blocks.length).toBe(result.ingestedBlocks);
    const heights = blocks.map((b) => Number(b.h));
    expect(heights, `archived heights: ${JSON.stringify(heights.slice(0, 45))}`).toEqual(
      heights.map((_, i) => i),
    );

    // Every archived transaction carries the properties the indexer used to supply: a 32-byte
    // ledger hash, non-empty raw bytes, and a known kind. Positions are contiguous per block.
    const txs = await sql<{ block_height: string; position: number; kind: string; hash_len: number; raw_len: number }[]>`
      SELECT t.block_height::text, t.position, t.kind,
             octet_length(t.tx_hash) AS hash_len, octet_length(b.data) AS raw_len
      FROM ${sql(schema)}.transactions t
      JOIN ${sql(schema)}.chain_blobs b ON b.hash = t.raw_blob_hash
      WHERE t.net = ${NET}
      ORDER BY t.block_height, t.position
    `;
    for (const t of txs) {
      expect(t.hash_len).toBe(32);
      expect(t.raw_len).toBeGreaterThan(0);
      expect(["regular", "system"]).toContain(t.kind);
    }
    const byBlock = new Map<string, number[]>();
    for (const t of txs) byBlock.set(t.block_height, [...(byBlock.get(t.block_height) ?? []), t.position]);
    for (const [height, positions] of byBlock) {
      expect(positions, `positions in block ${height} must be contiguous from 0`).toEqual(
        positions.map((_, i) => i),
      );
    }
  }, 180_000);

  it("resumes across a restart without re-ingesting or breaking continuity", async () => {
    // A fresh service instance against the same archive: the in-memory continuity anchor is gone,
    // so this exercises the store-backed path a real deployment takes on every start.
    const schema = "node_only_gate";
    const resumed = new ChainArchiveSyncService({
      sql, net: NET, schema, node: { url: NODE_URL, timeoutMs: 30_000 },
    });
    const before = await resumed.getSyncedHeight();
    expect(before).toBeGreaterThan(0);

    const result = await resumed.syncOnce({ maxBlocks: 5 });
    const after = await resumed.getSyncedHeight();
    expect(after).toBeGreaterThanOrEqual(before!);
    // Whatever it ingested, it did not duplicate: one row per (net, height).
    const dupes = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT height FROM ${sql(schema)}.blocks WHERE net = ${NET}
        GROUP BY height HAVING count(*) > 1
      ) d
    `;
    expect(dupes[0]!.n).toBe(0);
    expect(result.midnightTaggedForeignCalls).toBe(0);
  }, 180_000);
});
