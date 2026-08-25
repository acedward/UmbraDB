import type { DbTransaction } from "../db.js";
import type { IndexerBlock, IndexerTransaction, IndexerTransactionLookup } from "../indexer-gql.js";
import type { RpcLog } from "../logs/get-logs.js";
import { MethodRegistry, type RpcContext } from "../registry.js";
import { logsBloom } from "./bloom.js";
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

type BlockProjection = Pick<TransactionShapeInput, "blockHash" | "blockNumber" | "transactionIndex">;

/**
 * The hash the INDEXER knows this row by — `canonicalHash` when the row is keyed on something
 * else (a relayer row's eth-side hash), otherwise the row's own key. Every block-position and
 * log lookup goes through here; every value echoed back to the caller does not.
 */
export function positionHashOf(row: DbTransaction): string {
  const source = row.canonicalHash ?? row.hash;
  return sourceFixedDataHex(source.toString("hex"), 32, "transaction hash");
}

/**
 * Places a `tx_index` row inside the block it names, or `null` when the indexer's block query
 * cannot place it. `null` is a real, expected answer rather than a fault:
 *   - the row may name a block from a PREVIOUS chain incarnation (a local stack that was reset
 *     while its `evm_rpc` data survived), so the height exists but that transaction does not;
 *   - the row may have no height at all.
 * Both used to raise `-32603` (plan 00006 Q2 / METHODS.md K1). The caller now falls through to
 * the indexer lookup, which answers `null` — "this chain does not know that transaction", which
 * is what the official `notFound` result union asks for.
 */
async function rowPosition(row: DbTransaction, ctx: RpcContext): Promise<BlockProjection | null> {
  if (row.blockHeight === null) return null;
  const index = await transactionIndexOf(ctx, row.blockHeight, positionHashOf(row));
  if (index === undefined) return null;
  return {
    blockHash: row.blockHash === null ? ZERO_HASH : sourceFixedDataHex(row.blockHash.toString("hex"), 32, "block hash"),
    blockNumber: quantity(row.blockHeight),
    transactionIndex: index,
  };
}

function transactionShapeFromRow(row: DbTransaction, position: BlockProjection): Record<string, unknown> {
  return synthesizeTransaction({
    // The KEY the caller asked about, never `canonicalHash`: a JSON-RPC result must echo the
    // identifier it was queried by, and for a relayer row that is the eth-side hash MetaMask
    // is polling with.
    hash: sourceFixedDataHex(row.hash.toString("hex"), 32, "transaction hash"),
    ...position,
    from: evmAddressFromBytes(row.fromAddress),
    to: evmAddressFromBytes(row.toAddress),
    nonce: quantity(row.nonce),
  });
}

async function transactionFromDb(row: DbTransaction, ctx: RpcContext): Promise<Record<string, unknown> | null> {
  const position = await rowPosition(row, ctx);
  return position === null ? null : transactionShapeFromRow(row, position);
}

/** Enriches an already-positioned block transaction from tx_index when available. */
export async function synthesizeBlockTransaction(input: TransactionShapeInput, ctx: RpcContext): Promise<Record<string, unknown>> {
  const hash = sourceFixedDataHex(input.hash, 32, "transaction hash");
  const row = await ctx.db.getTransactionByHash(Buffer.from(hash.slice(2), "hex"));
  return row === undefined ? synthesizeTransaction(input) : transactionShapeFromRow(row, input);
}

async function transactionFromIndexer(lookup: IndexerTransactionLookup, ctx: RpcContext): Promise<Record<string, unknown> | null> {
  const tx = lookup.transaction;
  if (tx === undefined) return null;
  const duplicateNote = lookup.matchCount > 1
    ? `indexer returned ${lookup.matchCount} transactions for this hash; using element 0`
    : null;
  const hash = sourceFixedDataHex(tx.hash, 32, "transaction hash");
  // The indexer disagreeing with itself (a transaction whose own block does not list it) is
  // answered as "unknown" rather than as an internal error — see rowPosition().
  const index = await transactionIndexOf(ctx, tx.block.height, hash);
  if (index === undefined) return null;
  return synthesizeTransaction({
    hash,
    blockHash: sourceFixedDataHex(tx.block.hash, 32, "block hash"),
    blockNumber: quantity(tx.block.height),
    transactionIndex: index,
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
  /** The transaction's `evm_rpc.logs` rows, exactly as `eth_getLogs` serves them. */
  readonly logs?: readonly RpcLog[];
}

/**
 * The single receipt shape used by `eth_getTransactionReceipt` and `eth_getBlockReceipts`, so the
 * two can never drift. `logs` comes from `evm_rpc.logs` — the same rows, from the same columns,
 * that `eth_getLogs` serves — and `logsBloom` is computed from that array in this one place, so a
 * receipt can never advertise a filter that disagrees with the logs beside it.
 */
export function synthesizeReceipt(input: ReceiptShapeInput): Record<string, unknown> {
  const logs = input.logs ?? [];
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
    logs,
    logsBloom: logs.length === 0 ? ZERO_BLOOM : logsBloom(logs),
    status: input.status,
    type: "0x0",
    effectiveGasPrice: GAS_PRICE,
  };
}

/**
 * The transaction's stored logs, joined on the **Midnight** hash: `evm_rpc.logs.tx_hash` is written
 * by the ingester from the indexer's transaction identity, so a relayer row keyed on an eth-side
 * hash would find nothing under its own key (plan 00006 K1/K2 — this is why the logs join only
 * became possible once the canonical hash was resolvable).
 */
async function logsFor(ctx: RpcContext, midnightHash: string): Promise<RpcLog[]> {
  return ctx.db.getLogsByTransactionHash(Buffer.from(midnightHash.slice(2), "hex"));
}

/**
 * The transaction's index inside the block at `height`, or `undefined` when the indexer's block
 * query does not place it there (unknown block, or a hash the block does not list). A height the
 * indexer's `Int` range cannot express is a corrupt row, not a miss, and still throws.
 */
async function transactionIndexOf(ctx: RpcContext, height: bigint | number, hash: string): Promise<string | undefined> {
  const numericHeight = typeof height === "bigint" ? Number(height) : height;
  if (!Number.isSafeInteger(numericHeight) || numericHeight < 0 || numericHeight > 2_147_483_647) {
    throw new Error("transaction block height is outside the indexer's supported range");
  }
  const block = await ctx.indexer.getBlockByHeight(numericHeight);
  if (block === undefined) return undefined;
  const index = block.transactions.findIndex((candidate) => sourceFixedDataHex(candidate.hash, 32, "transaction hash") === hash);
  return index < 0 ? undefined : quantity(index);
}

function rowGasUsed(row: DbTransaction): bigint {
  return row.fee !== null && row.fee >= 0n ? row.fee : 0n;
}

async function receiptFromDb(row: DbTransaction, ctx: RpcContext): Promise<Record<string, unknown> | null> {
  const position = await rowPosition(row, ctx);
  if (position === null) return null;
  return synthesizeReceipt({
    hash: sourceFixedDataHex(row.hash.toString("hex"), 32, "transaction hash"),
    ...position,
    from: evmAddressFromBytes(row.fromAddress),
    to: evmAddressFromBytes(row.toAddress),
    gasUsed: rowGasUsed(row),
    status: receiptStatus(row.status ?? "FAILURE", undefined),
    logs: await logsFor(ctx, positionHashOf(row)),
  });
}

async function receiptFromIndexer(tx: IndexerTransaction, ctx: RpcContext): Promise<Record<string, unknown> | null> {
  const hash = sourceFixedDataHex(tx.hash, 32, "transaction hash");
  const result = tx.transactionResult;
  const index = await transactionIndexOf(ctx, tx.block.height, hash);
  if (index === undefined) return null;
  return synthesizeReceipt({
    hash,
    blockHash: sourceFixedDataHex(tx.block.hash, 32, "block hash"),
    blockNumber: quantity(tx.block.height),
    transactionIndex: index,
    gasUsed: decimalBigInt(tx.fee),
    status: receiptStatus(result?.status ?? "FAILURE", result?.segments),
    logs: await logsFor(ctx, hash),
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
  // The hash came from the block query, so it IS the Midnight hash the logs are keyed on.
  const logs = await logsFor(ctx, hash);
  const row = await ctx.db.getTransactionByHash(Buffer.from(hash.slice(2), "hex"));
  if (row !== undefined) {
    return synthesizeReceipt({
      ...position,
      from: evmAddressFromBytes(row.fromAddress),
      to: evmAddressFromBytes(row.toAddress),
      gasUsed: rowGasUsed(row),
      status: receiptStatus(row.status ?? "FAILURE", undefined),
      logs,
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
    logs,
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
    // A row the block query cannot place falls THROUGH to the indexer rather than failing, so a
    // stale `tx_index` row answers `null` instead of `-32603` (plan 00006 F8.2 / K1).
    if (row !== undefined) {
      const fromRow = await transactionFromDb(row, ctx);
      if (fromRow !== null) return fromRow;
    }
    return transactionFromIndexer(await ctx.indexer.getTransactionByHash(hash.slice(2)), ctx);
  });

  registry.registerMethod("eth_getTransactionReceipt", async (params, ctx) => {
    const [hashValue] = positionalParams(params, 1);
    const hash = fixedDataHex(hashValue, 32, "transaction hash");
    const row = await ctx.db.getTransactionByHash(Buffer.from(hash.slice(2), "hex"));
    if (row !== undefined) {
      const fromRow = await receiptFromDb(row, ctx);
      if (fromRow !== null) return fromRow;
    }
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
