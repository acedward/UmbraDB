import type { DbTransaction } from "../db.js";
import type { IndexerBlock, IndexerTransaction, IndexerTransactionLookup } from "../indexer-gql.js";
import { MethodRegistry, type RpcContext } from "../registry.js";
import {
  ESTIMATE_GAS, GAS_PRICE, ZERO_ADDRESS, ZERO_BLOOM, ZERO_HASH, blockByTag, dataHex, decimalBigInt,
  evmAddressFromBytes, fixedDataHex, parseQuantity, positionalParams, quantity, sourceFixedDataHex,
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

/** The positioned inputs a receipt needs; everything else in the shape is constant or synthetic. */
export interface ReceiptShapeInput {
  readonly hash: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly transactionIndex: string;
  readonly from?: string;
  readonly to?: string;
  readonly gasUsed: bigint;
  /** `"0x1"` / `"0x0"` — already reduced by {@link receiptStatus}. */
  readonly status: string;
}

/**
 * The single receipt shape used by `eth_getTransactionReceipt` and `eth_getBlockReceipts`, so the
 * two can never drift. `logs` is `[]` with a zero bloom on every path: Part C serves logs from
 * `evm_rpc.logs` through `eth_getLogs`, which this read path does not join (documented deviation).
 */
export function synthesizeReceipt(input: ReceiptShapeInput): Record<string, unknown> {
  return {
    transactionHash: input.hash,
    transactionIndex: input.transactionIndex,
    blockHash: input.blockHash,
    blockNumber: input.blockNumber,
    from: input.from ?? ZERO_ADDRESS,
    to: input.to ?? ZERO_ADDRESS,
    cumulativeGasUsed: quantity(input.gasUsed),
    gasUsed: quantity(input.gasUsed),
    contractAddress: null,
    logs: [],
    logsBloom: ZERO_BLOOM,
    status: input.status,
    type: "0x0",
    effectiveGasPrice: GAS_PRICE,
  };
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

function rowGasUsed(row: DbTransaction): bigint {
  return row.fee !== null && row.fee >= 0n ? row.fee : 0n;
}

async function receiptFromDb(row: DbTransaction, ctx: RpcContext): Promise<Record<string, unknown>> {
  const hash = sourceFixedDataHex(row.hash.toString("hex"), 32, "transaction hash");
  const index = row.blockHeight === null ? await missingTransactionPosition() : await transactionIndex(ctx, row.blockHeight, hash);
  return synthesizeReceipt({
    hash,
    blockHash: row.blockHash === null ? ZERO_HASH : sourceFixedDataHex(row.blockHash.toString("hex"), 32, "block hash"),
    blockNumber: quantity(row.blockHeight ?? 0n),
    transactionIndex: index,
    from: evmAddressFromBytes(row.fromAddress),
    to: evmAddressFromBytes(row.toAddress),
    gasUsed: rowGasUsed(row),
    status: receiptStatus(row.status ?? "FAILURE", undefined),
  });
}

async function receiptFromIndexer(tx: IndexerTransaction, ctx: RpcContext): Promise<Record<string, unknown>> {
  const hash = sourceFixedDataHex(tx.hash, 32, "transaction hash");
  const result = tx.transactionResult;
  return synthesizeReceipt({
    hash,
    blockHash: sourceFixedDataHex(tx.block.hash, 32, "block hash"),
    blockNumber: quantity(tx.block.height),
    transactionIndex: await transactionIndex(ctx, tx.block.height, hash),
    gasUsed: decimalBigInt(tx.fee),
    status: receiptStatus(result?.status ?? "FAILURE", result?.segments),
  });
}

/**
 * Receipt for a transaction whose block position the caller ALREADY knows (`eth_getBlockReceipts`).
 *
 * Deliberately never calls {@link transactionIndex}: the position comes from the indexer block the
 * caller fetched, so this path cannot hit the tx_index/block-query hash mismatch that makes the
 * by-hash DB-first branch answer `-32603` (plan 00006 Q2). `tx_index` is still consulted — it is
 * the only source of mapped `from`/`to` — but purely as enrichment: a miss falls back to the
 * indexer transaction lookup rather than failing.
 */
export async function synthesizeBlockReceipt(
  input: Pick<TransactionShapeInput, "hash" | "blockHash" | "blockNumber" | "transactionIndex">,
  ctx: RpcContext,
): Promise<Record<string, unknown>> {
  const hash = sourceFixedDataHex(input.hash, 32, "transaction hash");
  const position = { hash, blockHash: input.blockHash, blockNumber: input.blockNumber, transactionIndex: input.transactionIndex };
  const row = await ctx.db.getTransactionByHash(Buffer.from(hash.slice(2), "hex"));
  if (row !== undefined) {
    return synthesizeReceipt({
      ...position,
      from: evmAddressFromBytes(row.fromAddress),
      to: evmAddressFromBytes(row.toAddress),
      gasUsed: rowGasUsed(row),
      status: receiptStatus(row.status ?? "FAILURE", undefined),
    });
  }
  // A hash the block query itself listed should always resolve here; if the indexer disagrees with
  // itself we still emit a shape-correct receipt (status 0x0) so the array stays index-aligned with
  // the block's transaction list rather than losing an entry.
  const { transaction } = await ctx.indexer.getTransactionByHash(hash.slice(2));
  const result = transaction?.transactionResult;
  return synthesizeReceipt({
    ...position,
    gasUsed: transaction === undefined ? 0n : decimalBigInt(transaction.fee),
    status: transaction === undefined ? "0x0" : receiptStatus(result?.status ?? "FAILURE", result?.segments),
  });
}

/**
 * `eth_getTransactionByBlockHashAndIndex` / `…ByBlockNumberAndIndex` body: an out-of-range index
 * (or an unknown block) is `null`, never an error, per the official `notFound` result union.
 */
async function blockTransactionAt(
  block: IndexerBlock | undefined,
  index: bigint,
  ctx: RpcContext,
): Promise<Record<string, unknown> | null> {
  if (block === undefined || index >= BigInt(block.transactions.length)) return null;
  const entry = block.transactions[Number(index)]!;
  return synthesizeBlockTransaction({
    hash: sourceFixedDataHex(entry.hash, 32, "transaction hash"),
    blockHash: sourceFixedDataHex(block.hash, 32, "block hash"),
    blockNumber: quantity(block.height),
    transactionIndex: quantity(index),
  }, ctx);
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

  registry.registerMethod("eth_getTransactionByBlockHashAndIndex", async (params, ctx) => {
    const [hashValue, indexValue] = positionalParams(params, 2);
    const hash = fixedDataHex(hashValue, 32, "block hash");
    const index = parseQuantity(indexValue, "transaction index");
    return blockTransactionAt(await ctx.indexer.getBlockByHash(hash.slice(2)), index, ctx);
  });

  registry.registerMethod("eth_getTransactionByBlockNumberAndIndex", async (params, ctx) => {
    const [tagValue, indexValue] = positionalParams(params, 2);
    const index = parseQuantity(indexValue, "transaction index");
    return blockTransactionAt(await blockByTag(ctx, tagValue), index, ctx);
  });
}
