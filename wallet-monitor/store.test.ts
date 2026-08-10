import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../src/postgres/client.js";
import { bootstrapEvmRpcSchema } from "./bootstrap.js";
import type { SubscriptionUtxo, UnshieldedSubscriptionEvent } from "./subscription.js";
import { WalletMonitorStore } from "./store.js";

const ALICE = "mn_addr_undeployed1h3ssm5ru2t6eqy4g3she78zlxn96e36ms6pq996aduvmateh9p9sk96u7s";
const BOB = "mn_addr_undeployed1gkasr3z3vwyscy2jpp53nzr37v7n4r3lsfgj6v5g584dakjzt0xqun4d4r";
const TOKEN = "00".repeat(32);

function utxo(owner: string, tag: number, outputIndex: number): SubscriptionUtxo {
  return {
    owner,
    tokenType: TOKEN,
    value: "1000000",
    intentHash: tag.toString(16).padStart(64, "0"),
    outputIndex,
    ctime: null,
    initialNonce: "0",
    registeredForDustGeneration: true,
    createdAtTransaction: { id: tag },
    spentAtTransaction: null,
  };
}

function deliveries(id: number): { sender: UnshieldedSubscriptionEvent; receiver: UnshieldedSubscriptionEvent } {
  const transaction = {
    __typename: "RegularTransaction",
    id,
    hash: id.toString(16).padStart(64, "0"),
    block: { height: id, hash: (id + 1000).toString(16).padStart(64, "0") },
    transactionResult: { status: "SUCCESS" },
    fee: "123",
  };
  return {
    sender: {
      __typename: "UnshieldedTransaction",
      transaction,
      createdUtxos: [utxo(ALICE, id * 10 + 1, 0)],
      spentUtxos: [utxo(ALICE, id * 10 + 2, 0)],
    },
    receiver: {
      __typename: "UnshieldedTransaction",
      transaction,
      createdUtxos: [utxo(BOB, id * 10 + 3, 0)],
      spentUtxos: [],
    },
  };
}

describe("WalletMonitorStore", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: WalletMonitorStore;
  const schema = "evm_rpc_store_test";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapEvmRpcSchema(sql, schema);
    store = new WalletMonitorStore(sql, schema);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  it("does not persist an announced progress high-water mark before its transactions", async () => {
    await store.processEvent(ALICE, {
      __typename: "UnshieldedTransactionsProgress",
      highestTransactionId: 999,
    });
    expect(await store.getCursor(ALICE)).toBeUndefined();
  });

  it("merges sender-change and recipient deliveries deterministically in either order", async () => {
    const receiverFirst = deliveries(20);
    await store.processEvent(BOB, receiverFirst.receiver);
    await store.processEvent(ALICE, receiverFirst.sender);

    const senderFirst = deliveries(21);
    await store.processEvent(ALICE, senderFirst.sender);
    await store.processEvent(BOB, senderFirst.receiver);

    const rows = await sql<{ hash: Buffer; from_address: string; to_address: string }[]>`
      SELECT t.hash, sender.mn_address AS from_address, receiver.mn_address AS to_address
      FROM ${sql(schema)}.tx_index t
      JOIN ${sql(schema)}.address_map sender ON sender.id = t.from_id
      JOIN ${sql(schema)}.address_map receiver ON receiver.id = t.to_id
      ORDER BY t.block_height
    `;
    expect(rows.map((row) => ({
      hash: row.hash.toString("hex"),
      from: row.from_address,
      to: row.to_address,
    }))).toEqual([
      { hash: "14".padStart(64, "0"), from: ALICE, to: BOB },
      { hash: "15".padStart(64, "0"), from: ALICE, to: BOB },
    ]);

    // At-least-once replay changes neither identities nor balances.
    await store.processEvent(ALICE, senderFirst.sender);
    await store.processEvent(BOB, senderFirst.receiver);
    const counts = await sql<{ rows: bigint; identities: bigint }[]>`
      SELECT count(*)::bigint AS rows,
             count(DISTINCT (intent_hash, output_index))::bigint AS identities
      FROM ${sql(schema)}.utxos
    `;
    expect(counts[0]!.rows).toBe(counts[0]!.identities);
    expect(await store.getCursor(ALICE)).toBe(21);
    expect(await store.getCursor(BOB)).toBe(21);
  });
});
