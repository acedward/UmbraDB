/**
 * The read-only methods over a real `evm_rpc` database (PostgreSQL 17, or PGlite with `UMBRADB_BACKEND=pglite`),
 * created by the module's migrations.
 *
 * - `[[evm-rpc.handler.empty-database]]` — Node's server reading an empty database (`npm run evm-rpc` with `PG_URL`)
 *   answers every differential case byte for byte as the server with no database (`npm run evm-rpc` without
 *   `PG_URL`), so an empty database (the browser's) answers as both.
 * - `[[evm-rpc.reader.rows]]` — with an account, its native balance, a contract and a transaction in the database,
 *   the reader, given byte values as `Uint8Array`, answers the account and transaction methods from those rows: the
 *   balance ×10¹², the sent-transaction count, the contract marker, the transaction's mapped `from`/`to` positioned
 *   by the indexer, and its receipt with the stored status and fee.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, type TestDatabase } from "../../test/helpers/test-database.ts";
import { runMigrations } from "../../src/postgres/migrate.js";
import { evmRpcMigrations } from "../../src/postgres/migrations/evm_rpc/index.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { emptyEvmRpcReader, type EvmRpcReader, PostgresEvmRpcReader } from "../db.js";
import { handleHttpRequest, textBody } from "../handler.js";
import { IndexerGqlClient } from "../indexer-gql.js";
import { registerReadOnlyMethods } from "../read-only.js";
import { MethodRegistry, type RpcContext } from "../registry.js";
import { differentialCases } from "./differential-cases.js";
import { BLOCK_HASH, HEIGHT, recordedIndexerFetch, TX_HASH } from "./recorded-indexer.js";

const SCHEMA = "evm_rpc";

function context(db: EvmRpcReader): RpcContext {
  return {
    chainId: 2400n,
    clientVersion: "umbradb-evm-rpc/0.9.5",
    indexer: new IndexerGqlClient({ url: "http://indexer.test/graphql", fetchImpl: recordedIndexerFetch().fetch }),
    db,
  };
}

describe("the read-only methods over an evm_rpc database", () => {
  let database: TestDatabase;
  let sql: UmbraDBSql;
  let reader: PostgresEvmRpcReader;
  const registry = new MethodRegistry();
  registerReadOnlyMethods(registry);

  beforeAll(async () => {
    database = await openTestDatabase();
    sql = database.client(SCHEMA);
    await runMigrations(sql, { schema: SCHEMA, migrations: evmRpcMigrations });
    reader = new PostgresEvmRpcReader(sql as unknown as ConstructorParameters<typeof PostgresEvmRpcReader>[0]);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  const call = async (db: EvmRpcReader, method: string, params: unknown[]): Promise<unknown> => {
    const answer = await handleHttpRequest("POST", textBody(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })), registry, context(db));
    return (JSON.parse(answer.body) as { result?: unknown; error?: unknown }).result;
  };

  it("[[evm-rpc.handler.empty-database]] an empty database answers every case as no database", async () => {
    for (const c of differentialCases()) {
      const withDatabase = await handleHttpRequest(c.method, textBody(c.body), registry, context(reader));
      const without = await handleHttpRequest(c.method, textBody(c.body), registry, context(emptyEvmRpcReader));
      expect(withDatabase, c.name).toEqual(without);
    }
  }, 120_000);

  it("[[evm-rpc.reader.rows]] the account and transaction methods answer from the rows", async () => {
    const account = `0x${"12".repeat(20)}`;
    const recipient = `0x${"34".repeat(20)}`;
    const contract = `0x${"56".repeat(20)}`;
    const bytes = (h: string): Uint8Array => Uint8Array.from(h.slice(2).match(/../g)!.map((b) => parseInt(b, 16)));
    const from = (await sql<{ id: bigint }[]>`INSERT INTO evm_rpc.address_map (evm_addr, kind) VALUES (${bytes(account)}, 'midnight') RETURNING id`)[0]!.id;
    const to = (await sql<{ id: bigint }[]>`INSERT INTO evm_rpc.address_map (evm_addr, kind) VALUES (${bytes(recipient)}, 'midnight') RETURNING id`)[0]!.id;
    await sql`INSERT INTO evm_rpc.address_map (evm_addr, kind) VALUES (${bytes(contract)}, 'contract')`;
    await sql`INSERT INTO evm_rpc.balances (address_id, token_type, value, updated_block) VALUES (${from}, ${new Uint8Array(32)}, 5, 42)`;
    await sql`INSERT INTO evm_rpc.tx_index (hash, block_height, block_hash, status, fee, from_id, to_id, raw_ref)
      VALUES (${bytes(`0x${TX_HASH.success}`)}, ${HEIGHT.head}, ${bytes(`0x${BLOCK_HASH.head}`)}, 'SUCCESS', 7, ${from}, ${to}, 'indexer:transaction:103')`;
    try {
      expect(await call(reader, "eth_getBalance", [account, "latest"])).toBe(`0x${(5n * 10n ** 12n).toString(16)}`);
      expect(await call(reader, "eth_getTransactionCount", [account])).toBe("0x1");
      expect(await call(reader, "eth_getCode", [contract, "latest"])).toBe("0x60006000");
      expect(await call(reader, "eth_getCode", [account, "latest"])).toBe("0x");
      expect(await call(reader, "eth_getTransactionByHash", [`0x${TX_HASH.success}`])).toMatchObject({
        hash: `0x${TX_HASH.success}`, from: account, to: recipient, nonce: "0x0", blockNumber: "0x2a", transactionIndex: "0x0",
      });
      expect(await call(reader, "eth_getTransactionReceipt", [`0x${TX_HASH.success}`])).toMatchObject({
        transactionHash: `0x${TX_HASH.success}`, from: account, to: recipient, gasUsed: "0x7", status: "0x1", logs: [],
      });
    } finally {
      await sql`TRUNCATE evm_rpc.tx_index, evm_rpc.balances, evm_rpc.address_map CASCADE`;
    }
  });
});
