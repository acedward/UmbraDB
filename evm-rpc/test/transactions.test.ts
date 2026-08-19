import { describe, expect, it, vi } from "vitest";
import { canonicalHashFromRawRef, type DbTransaction, type EvmRpcReader } from "../db.js";
import type { IndexerBlock, IndexerTransaction } from "../indexer-gql.js";
import { registerTransactionMethods } from "../methods/transactions.js";
import { MethodRegistry } from "../registry.js";
import { assertJsonSchema, context, fakeIndexer, fixture } from "./helpers.js";

function noDb(overrides: Partial<EvmRpcReader> = {}): EvmRpcReader {
  return {
    async getNativeBalance() { return undefined; },
    async getTransactionCount() { return 0n; },
    async getAddressKind() { return undefined; },
    async getTransactionByHash() { return undefined; },
    ...overrides,
  };
}

describe("transaction methods", () => {
  it.each([
    ["tx-success.json", "0x1"],
    ["tx-failure.json", "0x0"],
    ["tx-partial-success.json", "0x0"],
  ])("applies the receipt policy to %s", async (fixtureName, expectedStatus) => {
    const tx = await fixture<IndexerTransaction>(fixtureName);
    const block = await fixture<IndexerBlock>("block-latest.json");
    const registry = new MethodRegistry();
    registerTransactionMethods(registry);
    const ctx = context({ indexer: fakeIndexer({
      async getTransactionByHash() { return { transaction: tx, matchCount: 1 }; },
      async getBlockByHeight() { return { ...block, transactions: [{ hash: tx.hash }] }; },
    }) });
    const receipt = await registry.getMethod("eth_getTransactionReceipt")!([`0x${tx.hash}`], ctx);
    await assertJsonSchema("eth-receipt.schema.json", receipt);
    expect(receipt).toMatchObject({
      status: expectedStatus,
      gasUsed: `0x${BigInt(tx.fee ?? "0").toString(16)}`,
      contractAddress: null,
      logs: [],
    });
  });

  it("tries tx_index first and synthesizes mapped addresses and nonce", async () => {
    const row: DbTransaction = {
      hash: Buffer.from("cc".repeat(32), "hex"),
      blockHeight: 42n,
      blockHash: Buffer.from("aa".repeat(32), "hex"),
      status: "SUCCESS",
      fee: 21_000n,
      fromAddress: Buffer.from("12".repeat(20), "hex"),
      toAddress: Buffer.from("34".repeat(20), "hex"),
      nonce: 7n,
      rawRef: "wallet-monitor:7",
    canonicalHash: null,
    };
    const fallback = vi.fn(async () => { throw new Error("fallback must not run"); });
    const block = await fixture<IndexerBlock>("block-latest.json");
    const registry = new MethodRegistry();
    registerTransactionMethods(registry);
    const ctx = context({
      db: noDb({ async getTransactionByHash() { return row; } }),
      indexer: fakeIndexer({ getTransactionByHash: fallback, async getBlockByHeight() { return block; } }),
    });
    await expect(registry.getMethod("eth_getTransactionByHash")!([`0x${"cc".repeat(32)}`], ctx)).resolves.toMatchObject({
      from: `0x${"12".repeat(20)}`,
      to: `0x${"34".repeat(20)}`,
      nonce: "0x7",
    });
    const transaction = await registry.getMethod("eth_getTransactionByHash")!([`0x${"cc".repeat(32)}`], ctx) as Record<string, unknown>;
    expect(transaction).not.toHaveProperty("raw_ref");
    const receipt = await registry.getMethod("eth_getTransactionReceipt")!([`0x${"cc".repeat(32)}`], ctx);
    await assertJsonSchema("eth-receipt.schema.json", receipt);
    expect(receipt).toMatchObject({ status: "0x1", transactionIndex: "0x0" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to GraphQL, records duplicate lookup ambiguity, and returns null when absent", async () => {
    const tx = await fixture<IndexerTransaction>("tx-success.json");
    const block = await fixture<IndexerBlock>("block-latest.json");
    const registry = new MethodRegistry();
    registerTransactionMethods(registry);
    const duplicateCtx = context({ indexer: fakeIndexer({
      async getTransactionByHash() { return { transaction: tx, matchCount: 2 }; },
      async getBlockByHeight() { return block; },
    }) });
    await expect(registry.getMethod("eth_getTransactionByHash")!([`0x${tx.hash}`], duplicateCtx)).resolves.toMatchObject({
      raw_ref: expect.stringContaining("2 transactions"),
    });
    const missingCtx = context();
    await expect(registry.getMethod("eth_getTransactionByHash")!([`0x${"ff".repeat(32)}`], missingCtx)).resolves.toBeNull();
    await expect(registry.getMethod("eth_getTransactionReceipt")!([`0x${"ff".repeat(32)}`], missingCtx)).resolves.toBeNull();
  });

  it("answers null instead of fabricating transaction index zero when block membership is unavailable", async () => {
    const tx = await fixture<IndexerTransaction>("tx-success.json");
    const registry = new MethodRegistry();
    registerTransactionMethods(registry);
    const ctx = context({ indexer: fakeIndexer({
      async getTransactionByHash() { return { transaction: tx, matchCount: 1 }; },
      async getBlockByHeight() { return undefined; },
    }) });
    // A transaction whose block cannot be read is UNKNOWN, not an internal fault — and above all
    // it is never answered with a made-up `transactionIndex: "0x0"`.
    await expect(registry.getMethod("eth_getTransactionReceipt")!([`0x${tx.hash}`], ctx)).resolves.toBeNull();
    await expect(registry.getMethod("eth_getTransactionByHash")!([`0x${tx.hash}`], ctx)).resolves.toBeNull();
  });

  describe("canonical hash resolution (plan 00006 Q2 / F8)", () => {
    const ETH_HASH = "ee".repeat(32);
    const MIDNIGHT_HASH = "cc".repeat(32);

    /** A relayer-written row: keyed on the ETH-side hash, mapping to a Midnight hash in raw_ref. */
    function relayerRow(): DbTransaction {
      return {
        hash: Buffer.from(ETH_HASH, "hex"),
        blockHeight: 42n,
        blockHash: Buffer.from("aa".repeat(32), "hex"),
        status: "SUCCESS",
        fee: 0n,
        fromAddress: null,
        toAddress: null,
        nonce: 0n,
        rawRef: `relayer:midnight:${MIDNIGHT_HASH}`,
        canonicalHash: Buffer.from(MIDNIGHT_HASH, "hex"),
      };
    }

    it("derives the Midnight hash from a relayer raw_ref and leaves every other provenance alone", () => {
      expect(canonicalHashFromRawRef(`relayer:midnight:${MIDNIGHT_HASH}`)?.toString("hex")).toBe(MIDNIGHT_HASH);
      expect(canonicalHashFromRawRef(`relayer:midnight:${MIDNIGHT_HASH.toUpperCase()}`)?.toString("hex")).toBe(MIDNIGHT_HASH);
      expect(canonicalHashFromRawRef("indexer:transaction:90")).toBeNull();
      expect(canonicalHashFromRawRef("relayer:midnight:short")).toBeNull();
      expect(canonicalHashFromRawRef(null)).toBeNull();
    });

    it("positions a relayer row by its Midnight hash while echoing the eth hash it was asked about", async () => {
      const block = await fixture<IndexerBlock>("block-latest.json"); // transactions: cc…, dd…
      const registry = new MethodRegistry();
      registerTransactionMethods(registry);
      const fallback = vi.fn(async () => { throw new Error("fallback must not run"); });
      const ctx = context({
        db: noDb({ async getTransactionByHash() { return relayerRow(); } }),
        indexer: fakeIndexer({ getTransactionByHash: fallback, async getBlockByHeight() { return block; } }),
      });
      const transaction = await registry.getMethod("eth_getTransactionByHash")!([`0x${ETH_HASH}`], ctx);
      expect(transaction).toMatchObject({ hash: `0x${ETH_HASH}`, transactionIndex: "0x0", blockNumber: "0x2a" });
      const receipt = await registry.getMethod("eth_getTransactionReceipt")!([`0x${ETH_HASH}`], ctx);
      await assertJsonSchema("eth-receipt.schema.json", receipt);
      expect(receipt).toMatchObject({ transactionHash: `0x${ETH_HASH}`, transactionIndex: "0x0", status: "0x1" });
      expect(fallback).not.toHaveBeenCalled();
    });

    it("falls through to the indexer when a stored row's block no longer lists it", async () => {
      const block = await fixture<IndexerBlock>("block-latest.json");
      const registry = new MethodRegistry();
      registerTransactionMethods(registry);
      // A row from a previous chain incarnation: the height still exists, the transaction does not.
      const stale: DbTransaction = { ...relayerRow(), canonicalHash: null, hash: Buffer.from("ab".repeat(32), "hex") };
      const ctx = context({
        db: noDb({ async getTransactionByHash() { return stale; } }),
        indexer: fakeIndexer({ async getBlockByHeight() { return { ...block, transactions: [] }; } }),
      });
      await expect(registry.getMethod("eth_getTransactionByHash")!([`0x${"ab".repeat(32)}`], ctx)).resolves.toBeNull();
      await expect(registry.getMethod("eth_getTransactionReceipt")!([`0x${"ab".repeat(32)}`], ctx)).resolves.toBeNull();
    });

    it("still refuses a block height the indexer's Int range cannot express", async () => {
      const registry = new MethodRegistry();
      registerTransactionMethods(registry);
      const corrupt: DbTransaction = { ...relayerRow(), blockHeight: 4_000_000_000n };
      const ctx = context({ db: noDb({ async getTransactionByHash() { return corrupt; } }) });
      await expect(registry.getMethod("eth_getTransactionByHash")!([`0x${ETH_HASH}`], ctx))
        .rejects.toThrow("outside the indexer's supported range");
    });
  });
});
