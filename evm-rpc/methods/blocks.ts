import type { IndexerBlock } from "../indexer-gql.js";
import { MethodRegistry, type RpcContext } from "../registry.js";
import {
  EMPTY_UNCLES_HASH, ZERO_ADDRESS, ZERO_BLOOM, ZERO_HASH, dataHex, fixedDataHex,
  invalidParams, positionalParams, quantity, resolveBlockTag, sourceFixedDataHex,
} from "./common.js";
import { synthesizeBlockTransaction } from "./transactions.js";

export function evmTimestampSeconds(timestamp: number): number {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("indexer returned an invalid block timestamp");
  // Indexer v4 documents UNIX time but the live rc.4 endpoint exposes pallet Timestamp.set.now
  // milliseconds. Retain compatibility with a future seconds-normalized endpoint.
  return timestamp >= 1_000_000_000_000 ? Math.floor(timestamp / 1_000) : timestamp;
}

export async function synthesizeBlock(block: IndexerBlock, fullTransactions: boolean, ctx: RpcContext): Promise<unknown> {
  const blockHash = sourceFixedDataHex(block.hash, 32, "block hash");
  const transactions: unknown[] = [];
  if (fullTransactions) {
    // Keep one block request from fan-out flooding the small read-only Postgres pool.
    for (const [index, { hash }] of block.transactions.entries()) {
      transactions.push(await synthesizeBlockTransaction({
        hash: sourceFixedDataHex(hash, 32, "transaction hash"),
        blockHash,
        blockNumber: quantity(block.height),
        transactionIndex: quantity(index),
      }, ctx));
    }
  } else {
    transactions.push(...block.transactions.map(({ hash }) => sourceFixedDataHex(hash, 32, "transaction hash")));
  }

  const author = block.author === null ? ZERO_ADDRESS : dataHex(block.author);
  return {
    number: quantity(block.height),
    hash: blockHash,
    parentHash: block.height === 0 || block.parent === null ? ZERO_HASH : sourceFixedDataHex(block.parent.hash, 32, "parent hash"),
    nonce: "0x0000000000000000",
    sha3Uncles: EMPTY_UNCLES_HASH,
    logsBloom: ZERO_BLOOM,
    transactionsRoot: ZERO_HASH,
    stateRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    miner: /^0x[0-9a-f]{40}$/.test(author) ? author : ZERO_ADDRESS,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: quantity(evmTimestampSeconds(block.timestamp)),
    transactions,
    uncles: [],
    mixHash: ZERO_HASH,
  };
}

export function registerBlockMethods(registry: MethodRegistry): void {
  registry.registerMethod("eth_blockNumber", async (params, ctx) => {
    positionalParams(params, 0);
    const block = await ctx.indexer.getLatestBlock();
    return block === undefined ? "0x0" : quantity(block.height);
  });

  registry.registerMethod("eth_getBlockByNumber", async (params, ctx) => {
    const [tagValue, fullValue] = positionalParams(params, 2);
    const tag = resolveBlockTag(tagValue);
    if (typeof fullValue !== "boolean") invalidParams("full transactions must be boolean");
    const block = tag.kind === "latest"
      ? await ctx.indexer.getLatestBlock()
      : await ctx.indexer.getBlockByHeight(tag.height);
    return block === undefined ? null : synthesizeBlock(block, fullValue as boolean, ctx);
  });

  registry.registerMethod("eth_getBlockByHash", async (params, ctx) => {
    const [hashValue, fullValue] = positionalParams(params, 2);
    const hash = fixedDataHex(hashValue, 32, "block hash");
    if (typeof fullValue !== "boolean") invalidParams("full transactions must be boolean");
    const block = await ctx.indexer.getBlockByHash(hash.slice(2));
    return block === undefined ? null : synthesizeBlock(block, fullValue, ctx);
  });
}
