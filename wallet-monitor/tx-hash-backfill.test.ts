import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../src/postgres/client.js";
import type { IndexerBlock } from "../evm-rpc/indexer-gql.js";
import { bootstrapEvmRpcSchema } from "./bootstrap.js";
import { backfillCanonicalTxHashes, TX_HASH_BACKFILL_VERSION } from "./tx-hash-backfill.js";

const SCHEMA = "evm_rpc_backfill_test";

function block(height: number, transactions: { id: number; hash: string }[], hash = `${height}`.padStart(64, "b")): IndexerBlock {
  return { hash, height, timestamp: 0, author: null, parent: null, transactions };
}

/** Only `getBlockByHeight` is consumed; the counter proves the pass queries each height ONCE. */
function fakeIndexer(blocks: Map<number, IndexerBlock>): { getBlockByHeight(h: number): Promise<IndexerBlock | undefined>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async getBlockByHeight(height: number) { calls.push(height); return blocks.get(height); },
  };
}

describe("tx_index canonical-hash repair pass", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema: SCHEMA });
    await bootstrapEvmRpcSchema(sql, SCHEMA);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  async function reset(rows: { hash: string; height: number; blockHash: string; rawRef: string }[]): Promise<void> {
    await sql`DELETE FROM ${sql(SCHEMA)}.tx_index`;
    await sql`DELETE FROM ${sql(SCHEMA)}.watermarks WHERE kind = 'tx_index_canonical_hash_backfill'`;
    for (const row of rows) {
      await sql`
        INSERT INTO ${sql(SCHEMA)}.tx_index (hash, block_height, block_hash, status, raw_ref)
        VALUES (${Buffer.from(row.hash, "hex")}, ${row.height}, ${Buffer.from(row.blockHash, "hex")},
                'SUCCESS', ${row.rawRef})
      `;
    }
  }

  async function hashes(): Promise<string[]> {
    const rows = await sql<{ hash: Buffer }[]>`SELECT hash FROM ${sql(SCHEMA)}.tx_index ORDER BY hash`;
    return rows.map((row) => row.hash.toString("hex"));
  }

  const CANONICAL = "aa".repeat(32);
  const STALE = "11".repeat(32);
  const BLOCK_HASH = "cc".repeat(32);
  const RELAYER_KEY = "ee".repeat(32);

  it("rewrites a monitor row whose stored hash disagrees with the block query, matching on the indexer id", async () => {
    await reset([{ hash: STALE, height: 7, blockHash: BLOCK_HASH, rawRef: "indexer:transaction:90" }]);
    const indexer = fakeIndexer(new Map([[7, block(7, [{ id: 89, hash: "22".repeat(32) }, { id: 90, hash: CANONICAL }], BLOCK_HASH)]]));

    const result = await backfillCanonicalTxHashes({ sql, schema: SCHEMA, indexer, log: () => {} });

    expect(result).toMatchObject({ scanned: 1, rewritten: 1, unresolvable: 0, skipped: 0, alreadyComplete: false });
    expect(await hashes()).toEqual([CANONICAL]);
  });

  it("is idempotent and latches on a clean run", async () => {
    const indexer = fakeIndexer(new Map([[7, block(7, [{ id: 90, hash: CANONICAL }], BLOCK_HASH)]]));
    const second = await backfillCanonicalTxHashes({ sql, schema: SCHEMA, indexer, log: () => {} });
    // The first `it` left a recorded clean completion, so the whole scan is skipped.
    expect(second).toMatchObject({ alreadyComplete: true, rewritten: 0 });
    expect(indexer.calls).toEqual([]);
    expect(await hashes()).toEqual([CANONICAL]);

    // …and re-running the scan itself (watermark cleared) still changes nothing.
    await sql`DELETE FROM ${sql(SCHEMA)}.watermarks WHERE kind = 'tx_index_canonical_hash_backfill'`;
    const third = await backfillCanonicalTxHashes({ sql, schema: SCHEMA, indexer, log: () => {} });
    expect(third).toMatchObject({ scanned: 1, rewritten: 0, unresolvable: 0 });
    expect(await hashes()).toEqual([CANONICAL]);
  });

  it("merges rather than collides when the canonical key is already present", async () => {
    await reset([
      { hash: STALE, height: 7, blockHash: BLOCK_HASH, rawRef: "indexer:transaction:90" },
      { hash: CANONICAL, height: 7, blockHash: BLOCK_HASH, rawRef: "indexer:transaction:90" },
    ]);
    const indexer = fakeIndexer(new Map([[7, block(7, [{ id: 90, hash: CANONICAL }], BLOCK_HASH)]]));

    const result = await backfillCanonicalTxHashes({ sql, schema: SCHEMA, indexer, log: () => {} });

    expect(result).toMatchObject({ scanned: 2, rewritten: 1 });
    expect(await hashes()).toEqual([CANONICAL]);
  });

  it("never touches relayer rows or unknown provenance, and refreshes a stale block hash", async () => {
    await reset([
      { hash: RELAYER_KEY, height: 7, blockHash: "00".repeat(32), rawRef: `relayer:midnight:${CANONICAL}` },
      { hash: CANONICAL, height: 7, blockHash: "00".repeat(32), rawRef: "indexer:transaction:90" },
      { hash: "33".repeat(32), height: 7, blockHash: "00".repeat(32), rawRef: null as unknown as string },
    ]);
    const indexer = fakeIndexer(new Map([[7, block(7, [{ id: 90, hash: CANONICAL }], BLOCK_HASH)]]));

    const result = await backfillCanonicalTxHashes({ sql, schema: SCHEMA, indexer, log: () => {} });

    expect(result).toMatchObject({ scanned: 1, rewritten: 0, blockHashRefreshed: 1, skipped: 2 });
    expect(await hashes()).toEqual([CANONICAL, "33".repeat(32), RELAYER_KEY].sort());
    const relayer = await sql<{ block_hash: Buffer }[]>`
      SELECT block_hash FROM ${sql(SCHEMA)}.tx_index WHERE hash = ${Buffer.from(RELAYER_KEY, "hex")}
    `;
    expect(relayer[0]!.block_hash.toString("hex")).toBe("00".repeat(32));
  });

  it("leaves an unplaceable row alone and refuses to latch, so a lagging indexer is retried", async () => {
    await reset([{ hash: STALE, height: 17, blockHash: BLOCK_HASH, rawRef: "indexer:transaction:26" }]);
    const indexer = fakeIndexer(new Map([[17, block(17, [])]]));

    const result = await backfillCanonicalTxHashes({ sql, schema: SCHEMA, indexer, log: () => {} });

    expect(result).toMatchObject({ scanned: 1, rewritten: 0, unresolvable: 1 });
    expect(await hashes()).toEqual([STALE]);

    const watermark = await sql<{ value: { version: number; unresolvable: number } }[]>`
      SELECT value FROM ${sql(SCHEMA)}.watermarks WHERE kind = 'tx_index_canonical_hash_backfill'
    `;
    expect(watermark[0]!.value).toMatchObject({ version: TX_HASH_BACKFILL_VERSION, unresolvable: 1 });
    const again = await backfillCanonicalTxHashes({ sql, schema: SCHEMA, indexer, log: () => {} });
    expect(again.alreadyComplete).toBe(false);
  });
});
