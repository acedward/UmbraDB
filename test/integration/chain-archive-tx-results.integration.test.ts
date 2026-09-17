import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema, chainArchiveMigrationsWithResults } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService, mapTransactionResult } from "../../chain-archive-sync/sync-service.js";
import { backfillTransactionResults, heightsMissingResults } from "../../chain-archive-sync/backfill-results.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import type { Hex32 } from "../../src/interfaces/chain-archive-store.js";

/**
 * Project 00020, spec FR-002 / owner decision Q8 — the archive learns each transaction's result
 * and, for a `PARTIAL_SUCCESS` transaction, its per-SEGMENT outcome.
 *
 * Why this matters: a mint in a call's FALLIBLE transcript applies only if that call's intent
 * segment succeeded. Without the segment detail the token scanner would either count a mint the
 * ledger rejected or refuse to count any fallible mint at all.
 *
 * The harness is the same controllable fake node/indexer pair as
 * `chain-archive-sync-start-concurrency.integration.test.ts`, in its own file so that suite is
 * untouched. Real Postgres 17 through Testcontainers; no live chain.
 */

const NET = "tx_results_test_net";

function hx(n: number, tag: number): Hex32 {
  return (tag.toString(16).padStart(2, "0") + n.toString(16)).padStart(64, "0");
}

interface FakeTx {
  hash: Hex32;
  raw: string;
  /** `undefined` models a SystemTransaction, which has no `transactionResult` in the v4 SDL. */
  result?: { status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE"; segments: { id: number; success: boolean }[] | null };
}

interface FakeBlock {
  height: number;
  hash: Hex32;
  parentHash: Hex32;
  txs: FakeTx[];
}

function chain(): FakeBlock[] {
  const mk = (height: number, txs: FakeTx[]): FakeBlock => ({
    height, hash: hx(height, 0xa), parentHash: height === 0 ? hx(0, 0) : hx(height - 1, 0xa), txs,
  });
  return [
    mk(0, [{ hash: hx(0, 0xd), raw: Buffer.from("tx-0").toString("hex"), result: { status: "SUCCESS", segments: null } }]),
    mk(1, [{
      hash: hx(1, 0xd), raw: Buffer.from("tx-1").toString("hex"),
      result: { status: "PARTIAL_SUCCESS", segments: [{ id: 1, success: true }, { id: 2, success: false }] },
    }]),
    mk(2, [{ hash: hx(2, 0xd), raw: Buffer.from("tx-2").toString("hex"), result: { status: "FAILURE", segments: null } }]),
    // A "system" transaction: the indexer serves it without a transactionResult at all. Its raw
    // bytes carry the system self-tag so the sync classifies it as `system` and skips the
    // node-body containment cross-check.
    mk(3, [{ hash: hx(3, 0xd), raw: Buffer.from("midnight:system-transaction[v6]:x").toString("hex") }]),
  ];
}

function nodeFetch(blocks: FakeBlock[], finalizedHeight: number): typeof fetch {
  return async (_url, init) => {
    const { id, method, params } = JSON.parse((init as RequestInit).body as string) as
      { id: number; method: string; params: unknown[] };
    const headerOf = (b: FakeBlock): unknown => ({
      parentHash: "0x" + b.parentHash, number: "0x" + b.height.toString(16),
      stateRoot: "0x" + hx(b.height, 0xb), extrinsicsRoot: "0x" + hx(b.height, 0xc), digest: { logs: [] },
    });
    let result: unknown;
    switch (method) {
      case "chain_getFinalizedHead": result = "0x" + blocks[finalizedHeight]!.hash; break;
      case "chain_getHeader": result = headerOf(blocks.find((b) => b.hash === (params[0] as string).replace(/^0x/, ""))!); break;
      case "chain_getBlockHash": result = "0x" + blocks[params[0] as number]!.hash; break;
      case "chain_getBlock": {
        const b = blocks.find((x) => x.hash === (params[0] as string).replace(/^0x/, ""))!;
        result = { block: { header: headerOf(b), extrinsics: b.txs.map((t) => "0x" + t.raw) }, justifications: null };
        break;
      }
      default: throw new Error(`unhandled ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
  };
}

/** `withResults: false` reproduces the OLD indexer query (no `transactionResult` selected) — what
 *  an archive synced before this change actually recorded, which is what `backfill-results` repairs. */
function indexerFetch(blocks: FakeBlock[], withResults = true): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as { variables?: { height?: number } };
    const height = body.variables?.height;
    if (typeof height === "number") {
      const b = blocks.find((x) => x.height === height);
      return new Response(JSON.stringify({
        data: {
          block: b === undefined ? null : {
            hash: "0x" + b.hash, height: b.height,
            transactions: b.txs.map((t) => ({
              hash: "0x" + t.hash, protocolVersion: 1, raw: t.raw,
              ...(withResults && t.result !== undefined ? { transactionResult: t.result } : {}),
            })),
            systemParameters: { dParameter: { numPermissionedCandidates: 1, numRegisteredCandidates: 2 } },
          },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { block: { height: Math.max(...blocks.map((b) => b.height)) } } }), { status: 200 });
  };
}

describe("chain_archive transaction results and segments (00020 FR-002)", () => {
  let container: StartedPostgreSqlContainer;
  const open: UmbraDBSql[] = [];
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterAll(async () => { await container?.stop(); }, 60_000);
  afterEach(async () => { while (open.length > 0) await open.pop()!.end({ timeout: 5 }); });

  async function newSchema(bootstrap = true): Promise<{ sql: UmbraDBSql; schema: string }> {
    const schema = `tx_results_${counter++}`;
    const client = createClient({ connectionString: container.getConnectionUri(), schema });
    open.push(client);
    if (bootstrap) await bootstrapChainArchiveSchema(client, schema);
    return { sql: client, schema };
  }

  it("[[archive-tx-results]] the sync stores result and per-segment outcomes for every regular transaction, and leaves a system transaction's result NULL", async () => {
    const blocks = chain();
    const { sql, schema } = await newSchema();
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 3) },
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks) },
    });
    await service.syncOnce({ maxBlocks: 10 });

    const rows = await sql<{ block_height: string; kind: string; result: string | null; segments: unknown }[]>`
      SELECT block_height, kind, result, segments FROM ${sql(schema)}.transactions
      WHERE net = ${NET} ORDER BY block_height
    `;
    expect(rows.map((r) => [Number(r.block_height), r.kind, r.result])).toEqual([
      [0, "regular", "success"],
      [1, "regular", "partial_success"],
      [2, "regular", "failure"],
      [3, "system", null],
    ]);
    // Only the PARTIAL_SUCCESS transaction carries segments, and it carries them verbatim.
    expect(rows[0]!.segments).toBeNull();
    expect(rows[1]!.segments).toEqual([{ id: 1, success: true }, { id: 2, success: false }]);
    expect(rows[2]!.segments).toBeNull();
    expect(rows[3]!.segments).toBeNull();

    // Re-ingesting the same blocks changes nothing (the store's own ON CONFLICT DO NOTHING plus
    // this update's IS DISTINCT FROM predicate).
    const service2 = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 3) },
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks) },
      startHeight: 0,
    });
    await service2.syncOnce({ maxBlocks: 10 });
    const again = await sql<{ block_height: string; result: string | null; segments: unknown }[]>`
      SELECT block_height, result, segments FROM ${sql(schema)}.transactions
      WHERE net = ${NET} ORDER BY block_height
    `;
    expect(again.map((r) => r.result)).toEqual(rows.map((r) => r.result));
    expect(again[1]!.segments).toEqual(rows[1]!.segments);
  }, 180_000);

  it("[[archive-tx-results-backfill]] backfill-results repairs an archive synced before this change, is idempotent, and is bounded", async () => {
    const blocks = chain();
    const { sql, schema } = await newSchema();
    // Sync with the OLD query shape: no transactionResult is ever selected, so every row lands NULL.
    const legacy = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 3) },
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks, false) },
    });
    await legacy.syncOnce({ maxBlocks: 10 });
    const before = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.transactions WHERE net = ${NET} AND result IS NOT NULL
    `;
    expect(before[0]!.n).toBe("0");

    // Only the three REGULAR transactions are candidates — the system one has no result to fetch.
    expect(await heightsMissingResults(sql, schema, NET, { limit: 100 })).toEqual([0, 1, 2]);

    // Bounded: one block at a time.
    const first = await backfillTransactionResults({
      sql, schema, net: NET, indexerUrl: "http://fake-indexer", maxBlocks: 1,
      client: { getBlockByHeight: async (h) => JSON.parse(await (await indexerFetch(blocks)("u", { body: JSON.stringify({ variables: { height: h } }) } as RequestInit)).text()).data.block ?? undefined },
    });
    expect(first).toMatchObject({ blocksExamined: 1, transactionsUpdated: 1, blocksUnavailable: 0, lastHeight: 0 });

    const rest = await backfillTransactionResults({
      sql, schema, net: NET, indexerUrl: "http://fake-indexer",
      client: { getBlockByHeight: async (h) => JSON.parse(await (await indexerFetch(blocks)("u", { body: JSON.stringify({ variables: { height: h } }) } as RequestInit)).text()).data.block ?? undefined },
    });
    expect(rest).toMatchObject({ blocksExamined: 2, transactionsUpdated: 2, blocksUnavailable: 0 });

    const rows = await sql<{ block_height: string; result: string | null; segments: unknown }[]>`
      SELECT block_height, result, segments FROM ${sql(schema)}.transactions WHERE net = ${NET} ORDER BY block_height
    `;
    expect(rows.map((r) => r.result)).toEqual(["success", "partial_success", "failure", null]);
    expect(rows[1]!.segments).toEqual([{ id: 1, success: true }, { id: 2, success: false }]);

    // Idempotent: nothing left to do, nothing updated.
    const third = await backfillTransactionResults({
      sql, schema, net: NET, indexerUrl: "http://fake-indexer",
      client: { getBlockByHeight: async () => { throw new Error("must not be queried"); } },
    });
    expect(third).toMatchObject({ blocksExamined: 0, transactionsUpdated: 0 });
  }, 180_000);

  it("[[archive-tx-results-migration]] the 002 migration is additive: an archive on the old lineage upgrades in place, keeps its rows, and rejects a non-array segments value", async () => {
    const { sql, schema } = await newSchema(false);
    // Bootstrap the OLD lineage only — exactly what an archive created before 00020 has.
    await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
    const oldNames = await sql<{ name: string }[]>`SELECT name FROM ${sql(schema)}._migrations ORDER BY name`;
    expect(oldNames.map((r) => r.name)).toEqual(["000_schema", "001_chain_archive_core"]);
    const hasSegments = async (): Promise<boolean> => {
      const r = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'transactions' AND column_name = 'segments'`;
      return r[0]!.n !== "0";
    };
    expect(await hasSegments()).toBe(false);

    // Write a row through the old shape, then upgrade.
    const blocks = chain();
    const legacy = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 1) },
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks, false) },
    });
    await legacy.syncOnce({ maxBlocks: 2 });
    const beforeCount = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.transactions WHERE net = ${NET}`;
    expect(beforeCount[0]!.n).toBe("2");

    await runMigrations(sql, { schema, migrations: chainArchiveMigrationsWithResults });
    const newNames = await sql<{ name: string }[]>`SELECT name FROM ${sql(schema)}._migrations ORDER BY name`;
    expect(newNames.map((r) => r.name)).toEqual(["000_schema", "001_chain_archive_core", "002_tx_result_segments"]);
    expect(await hasSegments()).toBe(true);
    const afterCount = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.transactions WHERE net = ${NET}`;
    expect(afterCount[0]!.n).toBe("2"); // rows survive; the ALTER is metadata-only

    // The CHECK pins the JSON type, not its contents.
    await expect(sql`
      UPDATE ${sql(schema)}.transactions SET segments = ${sql.json({ id: 1 })} WHERE net = ${NET}
    `).rejects.toThrow(/transactions_segments_is_array|check constraint/i);
    await sql`
      UPDATE ${sql(schema)}.transactions SET segments = ${sql.json([{ id: 4, success: true, future: "field" }])}
      WHERE net = ${NET} AND block_height = 0
    `;
  }, 180_000);

  it("[[archive-tx-results-mapping]] the status mapping is exact and an unknown status is a hard error, never a silent NULL", () => {
    expect(mapTransactionResult({ status: "SUCCESS" })).toBe("success");
    expect(mapTransactionResult({ status: "PARTIAL_SUCCESS" })).toBe("partial_success");
    expect(mapTransactionResult({ status: "FAILURE" })).toBe("failure");
    expect(mapTransactionResult(null)).toBeUndefined();
    expect(mapTransactionResult(undefined)).toBeUndefined();
    expect(() => mapTransactionResult({ status: "TIMED_OUT" })).toThrow(/unknown indexer TransactionResultStatus/);
  });
});
