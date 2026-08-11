import { describe, expect, it } from "vitest";
import type { IndexerBlock } from "../indexer-gql.js";
import { evmTimestampSeconds, registerBlockMethods, synthesizeBlock } from "../methods/blocks.js";
import { MethodRegistry, RpcError } from "../registry.js";
import { assertJsonSchema, context, fakeIndexer, fixture } from "./helpers.js";

describe("chain-view methods", () => {
  it("synthesizes hash-only and full-transaction blocks that pass the shape guard", async () => {
    const block = await fixture<IndexerBlock>("block-latest.json");
    const ctx = context({ indexer: fakeIndexer({ async getLatestBlock() { return block; } }) });
    const compact = await synthesizeBlock(block, false, ctx);
    const full = await synthesizeBlock(block, true, ctx);
    await assertJsonSchema("eth-block.schema.json", compact);
    await assertJsonSchema("eth-block.schema.json", full);
    expect(compact).not.toHaveProperty("baseFeePerGas");
    expect(compact).toMatchObject({
      number: "0x2a",
      hash: `0x${"aa".repeat(32)}`,
      parentHash: `0x${"bb".repeat(32)}`,
      miner: `0x${"11".repeat(20)}`,
      timestamp: `0x${(1_786_400_000).toString(16)}`,
    });
    expect((full as { transactions: unknown[] }).transactions[1]).toMatchObject({ transactionIndex: "0x1" });
  });

  it("normalizes live millisecond timestamps while retaining seconds compatibility", () => {
    expect(evmTimestampSeconds(1_786_400_000_123)).toBe(1_786_400_000);
    expect(evmTimestampSeconds(1_786_400_000)).toBe(1_786_400_000);
  });

  it("enriches full block transactions from tx_index without changing their block position", async () => {
    const block = await fixture<IndexerBlock>("block-latest.json");
    const ctx = context({
      indexer: fakeIndexer(),
      db: {
        async getNativeBalance() { return undefined; },
        async getTransactionCount() { return 0n; },
        async getAddressKind() { return undefined; },
        async getTransactionByHash(hash) {
          if (hash.toString("hex") !== "cc".repeat(32)) return undefined;
          return {
            hash,
            blockHeight: 42n,
            blockHash: Buffer.from("aa".repeat(32), "hex"),
            status: "SUCCESS",
            fee: 1n,
            fromAddress: Buffer.from("12".repeat(20), "hex"),
            toAddress: Buffer.from("34".repeat(20), "hex"),
            nonce: 9n,
            rawRef: "internal-only",
          };
        },
      },
    });
    const full = await synthesizeBlock(block, true, ctx) as { transactions: Record<string, unknown>[] };
    expect(full.transactions[0]).toMatchObject({
      from: `0x${"12".repeat(20)}`,
      to: `0x${"34".repeat(20)}`,
      nonce: "0x9",
      transactionIndex: "0x0",
    });
    expect(full.transactions[0]).not.toHaveProperty("raw_ref");
    expect(full.transactions[1]).toMatchObject({ from: `0x${"00".repeat(20)}`, transactionIndex: "0x1" });
  });

  it("maps latest-family tags to the tip and earliest to height zero", async () => {
    const block = await fixture<IndexerBlock>("block-latest.json");
    const seen: number[] = [];
    const registry = new MethodRegistry();
    registerBlockMethods(registry);
    const ctx = context({ indexer: fakeIndexer({
      async getLatestBlock() { return block; },
      async getBlockByHeight(height) { seen.push(height); return { ...block, height }; },
    }) });
    await expect(registry.getMethod("eth_blockNumber")!([], ctx)).resolves.toBe("0x2a");
    await expect(registry.getMethod("eth_getBlockByNumber")!(["pending", false], ctx)).resolves.toMatchObject({ number: "0x2a" });
    await expect(registry.getMethod("eth_getBlockByNumber")!(["earliest", false], ctx)).resolves.toMatchObject({ number: "0x0" });
    expect(seen).toEqual([0]);
  });

  it("strips the hash prefix for GraphQL and rejects a non-boolean fullTx flag", async () => {
    const block = await fixture<IndexerBlock>("block-latest.json");
    let received = "";
    const registry = new MethodRegistry();
    registerBlockMethods(registry);
    const ctx = context({ indexer: fakeIndexer({ async getBlockByHash(hash) { received = hash; return block; } }) });
    await registry.getMethod("eth_getBlockByHash")!([`0x${"aa".repeat(32)}`, false], ctx);
    expect(received).toBe("aa".repeat(32));
    await expect(registry.getMethod("eth_getBlockByHash")!([`0x${"aa".repeat(32)}`, "false"], ctx)).rejects.toBeInstanceOf(RpcError);
  });
});
