import type { DbTransaction } from "../db.js";
import type { IndexerTransaction, IndexerTransactionLookup } from "../indexer-gql.js";
import { MethodRegistry, type RpcContext } from "../registry.js";
import {
  ESTIMATE_GAS, GAS_PRICE, ZERO_ADDRESS, ZERO_BLOOM, ZERO_HASH, dataHex, decimalBigInt,
  evmAddressFromBytes, fixedDataHex, positionalParams, quantity, sourceFixedDataHex,
} from "./common.js";

export interface TransactionShapeInput {
  readonly hash: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly transactionIndex: string;
  readonly from?: string;
  readonly to?: string;
  readonly nonce?: string;
  readonly rawRef?: string | null;
}

export function synthesizeTransaction(input: TransactionShapeInput): Record<string, unknown> {
  const transaction: Record<string, unknown> = {
    blockHash: input.blockHash,
    blockNumber: input.blockNumber,
    from: input.from ?? ZERO_ADDRESS,
    gas: ESTIMATE_GAS,
    gasPrice: GAS_PRICE,
    hash: input.hash,
    input: "0x",
    nonce: input.nonce ?? "0x0",
    to: input.to ?? ZERO_ADDRESS,
    transactionIndex: input.transactionIndex,
    value: "0x0",
    type: "0x0",
    v: "0x0",
    r: ZERO_HASH,
    s: ZERO_HASH,
  };
  if (input.rawRef !== null && input.rawRef !== undefined) transaction.raw_ref = input.rawRef;
  return transaction;
}

async function transactionFromDb(
  row: DbTransaction,
  ctx: RpcContext,
  blockProjection?: Pick<TransactionShapeInput, "blockHash" | "blockNumber" | "transactionIndex">,
): Promise<Record<string, unknown>> {
  const hash = sourceFixedDataHex(row.hash.toString("hex"), 32, "transaction hash");
  return synthesizeTransaction({
    hash,
    blockHash: blockProjection?.blockHash ?? (row.blockHash === null ? ZERO_HASH : sourceFixedDataHex(row.blockHash.toString("hex"), 32, "block hash")),
    blockNumber: blockProjection?.blockNumber ?? quantity(row.blockHeight ?? 0n),
    transactionIndex: blockProjection?.transactionIndex ?? (
      row.blockHeight === null ? await missingTransactionPosition() : await transactionIndex(ctx, row.blockHeight, hash)
    ),
    from: evmAddressFromBytes(row.fromAddress),
    to: evmAddressFromBytes(row.toAddress),
    nonce: quantity(row.nonce),
  });
}

async function missingTransactionPosition(): Promise<never> {
  throw new Error("transaction row has no block height; position is unavailable");
}

/** Enriches an already-positioned block transaction from tx_index when available. */
export async function synthesizeBlockTransaction(input: TransactionShapeInput, ctx: RpcContext): Promise<Record<string, unknown>> {
  const hash = sourceFixedDataHex(input.hash, 32, "transaction hash");
  const row = await ctx.db.getTransactionByHash(Buffer.from(hash.slice(2), "hex"));
  return row === undefined ? synthesizeTransaction(input) : transactionFromDb(row, ctx, input);
}

async function transactionFromIndexer(lookup: IndexerTransactionLookup, ctx: RpcContext): Promise<Record<string, unknown> | null> {
  const tx = lookup.transaction;
  if (tx === undefined) return null;
  const duplicateNote = lookup.matchCount > 1
    ? `indexer returned ${lookup.matchCount} transactions for this hash; using element 0`
    : null;
  return synthesizeTransaction({
    hash: sourceFixedDataHex(tx.hash, 32, "transaction hash"),
    blockHash: sourceFixedDataHex(tx.block.hash, 32, "block hash"),
    blockNumber: quantity(tx.block.height),
    transactionIndex: await transactionIndex(ctx, tx.block.height, sourceFixedDataHex(tx.hash, 32, "transaction hash")),
    rawRef: duplicateNote,
  });
}

function receiptStatus(status: string, segments: readonly { readonly success: boolean }[] | null | undefined): string {
  return status === "SUCCESS" && (segments ?? []).every(({ success }) => success) ? "0x1" : "0x0";
}

async function transactionIndex(ctx: RpcContext, height: bigint | number, hash: string): Promise<string> {
  const numericHeight = typeof height === "bigint" ? Number(height) : height;
  if (!Number.isSafeInteger(numericHeight) || numericHeight < 0 || numericHeight > 2_147_483_647) {
    throw new Error("transaction block height is outside the indexer's supported range");
  }
  const block = await ctx.indexer.getBlockByHeight(numericHeight);
  if (block === undefined) throw new Error("transaction block is unavailable from the indexer");
  const index = block.transactions.findIndex((candidate) => sourceFixedDataHex(candidate.hash, 32, "transaction hash") === hash);
  if (index < 0) throw new Error("transaction is absent from its reported block");
  return quantity(index);
}

async function receiptFromDb(row: DbTransaction, ctx: RpcContext): Promise<Record<string, unknown>> {
  const hash = sourceFixedDataHex(row.hash.toString("hex"), 32, "transaction hash");
  const index = row.blockHeight === null ? await missingTransactionPosition() : await transactionIndex(ctx, row.blockHeight, hash);
  return {
    transactionHash: hash,
    transactionIndex: index,
    blockHash: row.blockHash === null ? ZERO_HASH : sourceFixedDataHex(row.blockHash.toString("hex"), 32, "block hash"),
    blockNumber: quantity(row.blockHeight ?? 0n),
    from: evmAddressFromBytes(row.fromAddress),
    to: evmAddressFromBytes(row.toAddress),
    cumulativeGasUsed: quantity(row.fee !== null && row.fee >= 0n ? row.fee : 0n),
    gasUsed: quantity(row.fee !== null && row.fee >= 0n ? row.fee : 0n),
    contractAddress: null,
    logs: [],
    logsBloom: ZERO_BLOOM,
    status: receiptStatus(row.status ?? "FAILURE", undefined),
    type: "0x0",
    effectiveGasPrice: GAS_PRICE,
  };
}

async function receiptFromIndexer(tx: IndexerTransaction, ctx: RpcContext): Promise<Record<string, unknown>> {
  const hash = sourceFixedDataHex(tx.hash, 32, "transaction hash");
  const gasUsed = quantity(decimalBigInt(tx.fee));
  const result = tx.transactionResult;
  return {
    transactionHash: hash,
    transactionIndex: await transactionIndex(ctx, tx.block.height, hash),
    blockHash: sourceFixedDataHex(tx.block.hash, 32, "block hash"),
    blockNumber: quantity(tx.block.height),
    from: ZERO_ADDRESS,
    to: ZERO_ADDRESS,
    cumulativeGasUsed: gasUsed,
    gasUsed,
    contractAddress: null,
    logs: [],
    logsBloom: ZERO_BLOOM,
    status: receiptStatus(result?.status ?? "FAILURE", result?.segments),
    type: "0x0",
    effectiveGasPrice: GAS_PRICE,
  };
}

export function registerTransactionMethods(registry: MethodRegistry): void {
  registry.registerMethod("eth_getTransactionByHash", async (params, ctx) => {
    const [hashValue] = positionalParams(params, 1);
    const hash = fixedDataHex(hashValue, 32, "transaction hash");
    const row = await ctx.db.getTransactionByHash(Buffer.from(hash.slice(2), "hex"));
    if (row !== undefined) return transactionFromDb(row, ctx);
    return transactionFromIndexer(await ctx.indexer.getTransactionByHash(hash.slice(2)), ctx);
  });

  registry.registerMethod("eth_getTransactionReceipt", async (params, ctx) => {
    const [hashValue] = positionalParams(params, 1);
    const hash = fixedDataHex(hashValue, 32, "transaction hash");
    const row = await ctx.db.getTransactionByHash(Buffer.from(hash.slice(2), "hex"));
    if (row !== undefined) return receiptFromDb(row, ctx);
    const lookup = await ctx.indexer.getTransactionByHash(hash.slice(2));
    return lookup.transaction === undefined ? null : receiptFromIndexer(lookup.transaction, ctx);
  });
}
