import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { keccak256 as ethersKeccak256 } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { evmRpcMigrations } from "../../src/postgres/migrations/evm_rpc/index.js";
import { PostgresEvmRpcReader } from "../db.js";
import type { IndexerBlock, IndexerTransaction } from "../indexer-gql.js";
import { getLogs } from "../logs/get-logs.js";
import { defaultAddressMapper, type LogRow, type MidnightIdentity } from "../logs/event-map.js";
import { writeLogs, type SqlPool } from "../logs/store.js";
import { logsBloom } from "../methods/bloom.js";
import { registerTransactionMethods, synthesizeReceipt } from "../methods/transactions.js";
import { MethodRegistry } from "../registry.js";
import { assertJsonSchema, context, fakeIndexer, fixture } from "./helpers.js";

const TRANSFER_TOPIC0 = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * An INDEPENDENT reading of go-ethereum's `bloomValues`: the three bits an item sets are taken from
 * byte pairs 0-1, 2-3 and 4-5 of its keccak digest, and the 256-byte array is indexed from the END.
 * Written against `ethers`' keccak (a different hash implementation from the one under test), so
 * this checks the part that is actually easy to get wrong — the byte order and the direction of the
 * index — rather than re-running the same code.
 */
function expectedBits(itemHex: string): { byteIndex: number; mask: number }[] {
  const digest = Buffer.from(ethersKeccak256(itemHex).slice(2), "hex");
  return [0, 2, 4].map((pair) => {
    const bit = digest.readUInt16BE(pair) & 0x7ff;
    return { byteIndex: 255 - Math.floor(bit / 8), mask: 1 << (bit % 8) };
  });
}

describe("receipt logs and logsBloom (plan 00006 K2)", () => {
  const ADDRESS = `0x${"1a".repeat(20)}`;
  const TOPIC1 = `0x${"00".repeat(12)}${"aa".repeat(20)}`;

  it("sets exactly the bits go-ethereum's rule names, for the address and every topic", () => {
    const bloom = Buffer.from(logsBloom([{ address: ADDRESS, topics: [`0x${TRANSFER_TOPIC0}`, TOPIC1] }]).slice(2), "hex");
    expect(bloom.length).toBe(256);

    const expected = new Uint8Array(256);
    for (const item of [ADDRESS, `0x${TRANSFER_TOPIC0}`, TOPIC1]) {
      for (const { byteIndex, mask } of expectedBits(item)) expected[byteIndex]! |= mask;
    }
    expect(bloom.toString("hex")).toBe(Buffer.from(expected).toString("hex"));
    // A filter that matched everything (or nothing) would pass a "non-zero" assertion just as
    // happily, so pin the population count too: 3 items × 3 bits, no collisions on these values.
    expect([...bloom].reduce((n, byte) => n + byte.toString(2).replace(/0/g, "").length, 0)).toBe(9);
  });

  it("is zero for a receipt with no logs and order-independent for one with several", () => {
    expect(logsBloom([])).toBe(`0x${"00".repeat(256)}`);
    const a = { address: ADDRESS, topics: [`0x${TRANSFER_TOPIC0}`] };
    const b = { address: `0x${"2b".repeat(20)}`, topics: [TOPIC1] };
    expect(logsBloom([a, b])).toBe(logsBloom([b, a]));
    expect(logsBloom([a, a])).toBe(logsBloom([a]));
  });

  it("synthesizeReceipt carries the logs it was given and a bloom that agrees with them", () => {
    const log = {
      address: ADDRESS, topics: [`0x${TRANSFER_TOPIC0}`], data: "0x0b", blockNumber: "0xbaa",
      blockHash: `0x${"cc".repeat(32)}`, transactionHash: `0x${"dd".repeat(32)}`,
      transactionIndex: "0x0", logIndex: "0x0", removed: false,
    };
    const receipt = synthesizeReceipt({
      hash: `0x${"dd".repeat(32)}`, blockHash: `0x${"cc".repeat(32)}`, blockNumber: "0xbaa",
      transactionIndex: "0x0", gasUsed: 0n, status: "0x1", logs: [log],
    });
    expect(receipt.logs).toEqual([log]);
    expect(receipt.logsBloom).toBe(logsBloom([log]));
    expect(receipt.logsBloom).not.toBe(`0x${"00".repeat(256)}`);
  });

  it("joins a transaction's stored logs into both by-hash receipt paths", async () => {
    const tx = await fixture<IndexerTransaction>("tx-success.json");
    const block = await fixture<IndexerBlock>("block-latest.json");
    const stored = [{
      address: ADDRESS, topics: [`0x${TRANSFER_TOPIC0}`], data: "0x0b", blockNumber: "0x2a",
      blockHash: `0x${"aa".repeat(32)}`, transactionHash: `0x${tx.hash}`,
      transactionIndex: "0x0", logIndex: "0x0", removed: false,
    }];
    const registry = new MethodRegistry();
    registerTransactionMethods(registry);
    const asked: string[] = [];
    const ctx = context({
      db: {
        async getNativeBalance() { return undefined; },
        async getTransactionCount() { return 0n; },
        async getAddressKind() { return undefined; },
        async getTransactionByHash() { return undefined; },
        async getLogsByTransactionHash(hash) { asked.push(hash.toString("hex")); return stored; },
      },
      indexer: fakeIndexer({
        async getTransactionByHash() { return { transaction: tx, matchCount: 1 }; },
        async getBlockByHeight() { return { ...block, transactions: [{ hash: tx.hash }] }; },
      }),
    });
    const receipt = await registry.getMethod("eth_getTransactionReceipt")!([`0x${tx.hash}`], ctx) as Record<string, unknown>;
    await assertJsonSchema("eth-receipt.schema.json", receipt);
    expect(receipt.logs).toEqual(stored);
    expect(receipt.logsBloom).toBe(logsBloom(stored));
    expect(asked).toEqual([tx.hash]);
  });

  it("joins a relayer row's logs by its MIDNIGHT hash, not by the eth hash it was queried with", async () => {
    const ethHash = "ee".repeat(32);
    const midnightHash = "cc".repeat(32); // block-latest.json's transaction 0
    const block = await fixture<IndexerBlock>("block-latest.json");
    const asked: string[] = [];
    const registry = new MethodRegistry();
    registerTransactionMethods(registry);
    const ctx = context({
      db: {
        async getNativeBalance() { return undefined; },
        async getTransactionCount() { return 0n; },
        async getAddressKind() { return undefined; },
        async getTransactionByHash() {
          return {
            hash: Buffer.from(ethHash, "hex"), blockHeight: 42n,
            blockHash: Buffer.from("aa".repeat(32), "hex"), status: "SUCCESS", fee: 0n,
            fromAddress: null, toAddress: null, nonce: 0n,
            rawRef: `relayer:midnight:${midnightHash}`, canonicalHash: Buffer.from(midnightHash, "hex"),
          };
        },
        async getLogsByTransactionHash(hash) { asked.push(hash.toString("hex")); return []; },
      },
      indexer: fakeIndexer({ async getBlockByHeight() { return block; } }),
    });
    await registry.getMethod("eth_getTransactionReceipt")!([`0x${ethHash}`], ctx);
    expect(asked).toEqual([midnightHash]);
  });

  describe("against real Postgres", () => {
    let container: StartedPostgreSqlContainer;
    let sql: UmbraDBSql;
    const schema = "evm_rpc"; // PostgresEvmRpcReader addresses this schema by name.
    const CONTRACT: MidnightIdentity = { kind: "contract", hex: "11".repeat(32) };
    const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

    beforeAll(async () => {
      container = await new PostgreSqlContainer("postgres:17-alpine").start();
      sql = createClient({ connectionString: container.getConnectionUri(), schema });
      await runMigrations(sql, { schema, migrations: evmRpcMigrations });
      const rows: LogRow[] = [0, 1].map((logIndex) => ({
        address: defaultAddressMapper(CONTRACT),
        blockNumber: 2986,
        blockHash: bytes("8a".repeat(32)),
        txHash: bytes("7a".repeat(32)),
        txIndex: 0,
        logIndex,
        topics: [bytes(TRANSFER_TOPIC0), bytes(`${"00".repeat(12)}${"aa".repeat(20)}`)],
        data: bytes("0b"),
        sourceEventId: 100 + logIndex,
        removed: false,
      }));
      // One log belonging to a DIFFERENT transaction, so a join that ignored tx_hash would show up.
      rows.push({ ...rows[0]!, txHash: bytes("7b".repeat(32)), logIndex: 0, sourceEventId: 200 });
      await writeLogs(sql as unknown as SqlPool, schema, rows, { contractIdentity: CONTRACT });
    }, 180_000);

    afterAll(async () => {
      await sql?.end({ timeout: 5 });
      await container?.stop();
    }, 60_000);

    it("returns exactly what eth_getLogs returns for the same transaction", async () => {
      const reader = new PostgresEvmRpcReader(sql as unknown as ConstructorParameters<typeof PostgresEvmRpcReader>[0]);
      const viaReceipt = await reader.getLogsByTransactionHash(Buffer.from("7a".repeat(32), "hex"));
      const viaGetLogs = (await getLogs({ sql, schema }, [{ blockHash: `0x${"8a".repeat(32)}` }]))
        .filter((log) => log.transactionHash === `0x${"7a".repeat(32)}`);

      // Byte-for-byte: a receipt and a log query must never describe the same row differently.
      expect(viaReceipt).toEqual(viaGetLogs);
      expect(viaReceipt).toHaveLength(2);
      expect(viaReceipt.map((log) => log.logIndex)).toEqual(["0x0", "0x1"]);
      expect(logsBloom(viaReceipt)).not.toBe(`0x${"00".repeat(256)}`);
      expect(await reader.getLogsByTransactionHash(Buffer.from("ff".repeat(32), "hex"))).toEqual([]);
    });
  });
});
