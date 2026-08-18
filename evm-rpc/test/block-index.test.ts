import { describe, expect, it, vi } from "vitest";
import type { DbTransaction, EvmRpcReader } from "../db.js";
import type { IndexerBlock, IndexerTransaction } from "../indexer-gql.js";
import { registerBlockMethods } from "../methods/blocks.js";
import { registerTransactionMethods } from "../methods/transactions.js";
import { MethodRegistry, RpcError } from "../registry.js";
import { assertJsonSchema, context, fakeIndexer, fixture } from "./helpers.js";

const BLOCK_HASH = `0x${"aa".repeat(32)}`;
const TX0_HASH = `0x${"cc".repeat(32)}`;
const TX1_HASH = `0x${"dd".repeat(32)}`;

function registry(): MethodRegistry {
  const created = new MethodRegistry();
  registerBlockMethods(created);
  registerTransactionMethods(created);
  return created;
}

function noDb(overrides: Partial<EvmRpcReader> = {}): EvmRpcReader {
  return {
    async getNativeBalance() { return undefined; },
    async getTransactionCount() { return 0n; },
    async getAddressKind() { return undefined; },
    async getTransactionByHash() { return undefined; },
    ...overrides,
  };
}

/** A tx_index row for block-latest.json's first transaction, carrying mapped from/to and a fee. */
const TX0_ROW: DbTransaction = {
  hash: Buffer.from("cc".repeat(32), "hex"),
  blockHeight: 42n,
  blockHash: Buffer.from("aa".repeat(32), "hex"),
  status: "SUCCESS",
  fee: 21_000n,
  fromAddress: Buffer.from("12".repeat(20), "hex"),
  toAddress: Buffer.from("34".repeat(20), "hex"),
  nonce: 7n,
  rawRef: "wallet-monitor:7",
};

describe("by-index block and transaction reads", () => {
  describe("eth_getBlockTransactionCountByHash / ByNumber", () => {
    it("counts the indexer block's transaction list for a hash, a height and every latest-family tag", async () => {
      const block = await fixture<IndexerBlock>("block-latest.json");
      const heights: number[] = [];
      const methods = registry();
      const ctx = context({ indexer: fakeIndexer({
        async getLatestBlock() { return block; },
        async getBlockByHeight(height) { heights.push(height); return height === 42 ? block : { ...block, height, transactions: [] }; },
        async getBlockByHash(hash) { return hash === "aa".repeat(32) ? block : undefined; },
      }) });

      await expect(methods.getMethod("eth_getBlockTransactionCountByHash")!([BLOCK_HASH], ctx)).resolves.toBe("0x2");
      for (const tag of ["latest", "pending", "safe", "finalized"]) {
        await expect(methods.getMethod("eth_getBlockTransactionCountByNumber")!([tag], ctx)).resolves.toBe("0x2");
      }
      await expect(methods.getMethod("eth_getBlockTransactionCountByNumber")!(["0x2a"], ctx)).resolves.toBe("0x2");
      await expect(methods.getMethod("eth_getBlockTransactionCountByNumber")!(["earliest"], ctx)).resolves.toBe("0x0");
      expect(heights).toEqual([42, 0]);
    });

    it("returns null for an unknown block and -32602 for a malformed hash, tag or arity", async () => {
      const methods = registry();
      const ctx = context();
      await expect(methods.getMethod("eth_getBlockTransactionCountByHash")!([`0x${"ee".repeat(32)}`], ctx)).resolves.toBeNull();
      await expect(methods.getMethod("eth_getBlockTransactionCountByNumber")!(["0x1"], ctx)).resolves.toBeNull();
      await expect(methods.getMethod("eth_getBlockTransactionCountByHash")!(["0xdead"], ctx)).rejects.toBeInstanceOf(RpcError);
      await expect(methods.getMethod("eth_getBlockTransactionCountByHash")!([], ctx)).rejects.toBeInstanceOf(RpcError);
      await expect(methods.getMethod("eth_getBlockTransactionCountByNumber")!(["yesterday"], ctx)).rejects.toBeInstanceOf(RpcError);
      await expect(methods.getMethod("eth_getBlockTransactionCountByNumber")!([BLOCK_HASH, 0], ctx)).rejects.toBeInstanceOf(RpcError);
    });
  });

  describe("eth_getTransactionByBlockHashAndIndex / ByBlockNumberAndIndex", () => {
    it("positions the transaction from the block list and passes the transaction shape guard", async () => {
      const block = await fixture<IndexerBlock>("block-latest.json");
      const methods = registry();
      const ctx = context({ indexer: fakeIndexer({
        async getLatestBlock() { return block; },
        async getBlockByHash(hash) { return hash === "aa".repeat(32) ? block : undefined; },
      }) });

      const first = await methods.getMethod("eth_getTransactionByBlockHashAndIndex")!([BLOCK_HASH, "0x0"], ctx);
      await assertJsonSchema("eth-transaction.schema.json", first);
      expect(first).toMatchObject({ hash: TX0_HASH, blockHash: BLOCK_HASH, blockNumber: "0x2a", transactionIndex: "0x0" });

      const second = await methods.getMethod("eth_getTransactionByBlockNumberAndIndex")!(["latest", "0x1"], ctx);
      await assertJsonSchema("eth-transaction.schema.json", second);
      expect(second).toMatchObject({ hash: TX1_HASH, transactionIndex: "0x1" });
    });

    it("enriches from tx_index without re-deriving the position, so the Q2 hash mismatch cannot bite", async () => {
      const block = await fixture<IndexerBlock>("block-latest.json");
      // A tx_index row exists for the block's first transaction. The by-hash path would call
      // getBlockByHeight again to re-derive the index (and throw when the hashes disagree); this
      // path must not, because the block already told it the position.
      const byHeight = vi.fn(async () => block);
      const methods = registry();
      const ctx = context({
        db: noDb({ async getTransactionByHash() { return TX0_ROW; } }),
        indexer: fakeIndexer({ getBlockByHeight: byHeight, async getLatestBlock() { return block; } }),
      });

      const tx = await methods.getMethod("eth_getTransactionByBlockNumberAndIndex")!(["latest", "0x0"], ctx);
      expect(tx).toMatchObject({
        from: `0x${"12".repeat(20)}`,
        to: `0x${"34".repeat(20)}`,
        nonce: "0x7",
        transactionIndex: "0x0",
        blockNumber: "0x2a",
      });
      expect(byHeight).not.toHaveBeenCalled();
    });

    it("returns null past the end of the block or for an unknown block, and -32602 for a bad index", async () => {
      const block = await fixture<IndexerBlock>("block-latest.json");
      const methods = registry();
      const ctx = context({ indexer: fakeIndexer({
        async getLatestBlock() { return block; },
        async getBlockByHash(hash) { return hash === "aa".repeat(32) ? block : undefined; },
      }) });

      await expect(methods.getMethod("eth_getTransactionByBlockHashAndIndex")!([BLOCK_HASH, "0x2"], ctx)).resolves.toBeNull();
      await expect(methods.getMethod("eth_getTransactionByBlockNumberAndIndex")!(["latest", "0xffffffffffffffffff"], ctx)).resolves.toBeNull();
      await expect(methods.getMethod("eth_getTransactionByBlockHashAndIndex")!([`0x${"ee".repeat(32)}`, "0x0"], ctx)).resolves.toBeNull();
      await expect(methods.getMethod("eth_getTransactionByBlockNumberAndIndex")!(["0x1", "0x0"], ctx)).resolves.toBeNull();
      await expect(methods.getMethod("eth_getTransactionByBlockHashAndIndex")!([BLOCK_HASH, "0x00"], ctx)).rejects.toBeInstanceOf(RpcError);
      await expect(methods.getMethod("eth_getTransactionByBlockHashAndIndex")!([BLOCK_HASH, 0], ctx)).rejects.toBeInstanceOf(RpcError);
      await expect(methods.getMethod("eth_getTransactionByBlockHashAndIndex")!([BLOCK_HASH], ctx)).rejects.toBeInstanceOf(RpcError);
    });
  });

  describe("eth_getBlockReceipts", () => {
    it("returns one schema-valid receipt per block transaction, index-aligned, for a tag and a hash", async () => {
      const block = await fixture<IndexerBlock>("block-latest.json");
      const tx = await fixture<IndexerTransaction>("tx-success.json");
      const methods = registry();
      const ctx = context({ indexer: fakeIndexer({
        async getLatestBlock() { return block; },
        async getBlockByHash(hash) { return hash === "aa".repeat(32) ? block : undefined; },
        async getTransactionByHash(hash) {
          return hash === tx.hash ? { transaction: tx, matchCount: 1 } : { transaction: undefined, matchCount: 0 };
        },
      }) });

      for (const ref of ["latest", BLOCK_HASH]) {
        const receipts = await methods.getMethod("eth_getBlockReceipts")!([ref], ctx) as Record<string, unknown>[];
        expect(receipts).toHaveLength(2);
        for (const receipt of receipts) await assertJsonSchema("eth-receipt.schema.json", receipt);
        expect(receipts[0]).toMatchObject({
          transactionHash: TX0_HASH, transactionIndex: "0x0", blockHash: BLOCK_HASH, blockNumber: "0x2a",
          status: "0x1", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", logs: [], type: "0x0",
        });
        // The indexer does not know the second hash: the entry is still emitted so the array stays
        // aligned with the block's transaction list, with the failure-side status policy.
        expect(receipts[1]).toMatchObject({ transactionHash: TX1_HASH, transactionIndex: "0x1", status: "0x0", gasUsed: "0x0" });
      }
    });

    it("prefers tx_index for mapped addresses and never re-derives a position from a hash", async () => {
      const block = await fixture<IndexerBlock>("block-latest.json");
      const byHeight = vi.fn(async () => block);
      const byHash = vi.fn(async () => ({ transaction: undefined, matchCount: 0 }));
      const methods = registry();
      const ctx = context({
        db: noDb({ async getTransactionByHash(hash) { return hash.toString("hex") === "cc".repeat(32) ? TX0_ROW : undefined; } }),
        indexer: fakeIndexer({ getBlockByHeight: byHeight, getTransactionByHash: byHash, async getLatestBlock() { return block; } }),
      });

      const receipts = await methods.getMethod("eth_getBlockReceipts")!(["latest"], ctx) as Record<string, unknown>[];
      expect(receipts[0]).toMatchObject({
        from: `0x${"12".repeat(20)}`, to: `0x${"34".repeat(20)}`, status: "0x1", gasUsed: "0x5208", transactionIndex: "0x0",
      });
      expect(byHeight).not.toHaveBeenCalled();
      // Only the tx_index MISS falls through to the indexer transaction lookup.
      expect(byHash).toHaveBeenCalledTimes(1);
    });

    it("returns null for an unknown block, an empty array for an empty one, and -32602 for a bad reference", async () => {
      const block = await fixture<IndexerBlock>("block-latest.json");
      const methods = registry();
      const ctx = context({ indexer: fakeIndexer({
        async getLatestBlock() { return { ...block, transactions: [] }; },
        async getBlockByHeight() { return undefined; },
        async getBlockByHash() { return undefined; },
      }) });

      await expect(methods.getMethod("eth_getBlockReceipts")!(["latest"], ctx)).resolves.toEqual([]);
      await expect(methods.getMethod("eth_getBlockReceipts")!(["0x1"], ctx)).resolves.toBeNull();
      await expect(methods.getMethod("eth_getBlockReceipts")!([BLOCK_HASH], ctx)).resolves.toBeNull();
      await expect(methods.getMethod("eth_getBlockReceipts")!(["yesterday"], ctx)).rejects.toBeInstanceOf(RpcError);
      await expect(methods.getMethod("eth_getBlockReceipts")!([], ctx)).rejects.toBeInstanceOf(RpcError);
    });
  });
});
