import type { IndexerBlock } from "../indexer-gql.js";
import { JSON_RPC_ERRORS, RpcError, type RpcContext } from "../registry.js";

export const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
export const ZERO_HASH = `0x${"00".repeat(32)}`;
export const ZERO_BLOOM = `0x${"00".repeat(256)}`;
export const EMPTY_UNCLES_HASH = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";
export const GAS_PRICE = "0x3b9aca00";
export const ESTIMATE_GAS = "0x5208";

export function invalidParams(message: string): never {
  throw new RpcError(JSON_RPC_ERRORS.INVALID_PARAMS, message);
}

export function positionalParams(params: unknown, min: number, max = min): unknown[] {
  const actual = params === undefined ? [] : params;
  if (!Array.isArray(actual) || actual.length < min || actual.length > max) {
    invalidParams(`expected ${min === max ? min : `${min}-${max}`} positional parameter(s)`);
  }
  return actual;
}

export function quantity(value: bigint | number): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) throw new Error("JSON-RPC quantities cannot be negative");
  return `0x${n.toString(16)}`;
}

export function parseQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    invalidParams(`${label} must be a canonical hex quantity`);
  }
  return BigInt(value);
}

export function dataHex(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return "0x";
  const raw = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(raw) || raw.length % 2 !== 0) {
    throw new Error("indexer or database returned malformed hex data");
  }
  return `0x${raw.toLowerCase()}`;
}

export function sourceFixedDataHex(value: string | null | undefined, bytes: number, label: string): string {
  const normalized = dataHex(value);
  if (normalized.length !== 2 + bytes * 2) throw new Error(`data source returned malformed ${label}`);
  return normalized;
}

export function fixedDataHex(value: unknown, bytes: number, label: string): string {
  if (typeof value !== "string") invalidParams(`${label} must be a 0x-prefixed hex string`);
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  if (!pattern.test(value)) invalidParams(`${label} must contain exactly ${bytes} bytes`);
  return value.toLowerCase();
}

export function evmAddressFromBytes(value: Buffer | null | undefined): string {
  if (value === null || value === undefined || value.length !== 20) return ZERO_ADDRESS;
  return `0x${value.toString("hex")}`;
}

export type ResolvedBlockTag = { readonly kind: "latest" } | { readonly kind: "height"; readonly height: number };

export function resolveBlockTag(value: unknown): ResolvedBlockTag {
  if (value === "latest" || value === "pending" || value === "safe" || value === "finalized") {
    return { kind: "latest" };
  }
  if (value === "earliest") return { kind: "height", height: 0 };
  const parsed = parseQuantity(value, "block tag");
  if (parsed > 2_147_483_647n) invalidParams("block height exceeds the indexer's GraphQL Int range");
  return { kind: "height", height: Number(parsed) };
}

/**
 * Fetches the block a `BlockNumberOrTag` parameter names, `undefined` when it is not (yet) on
 * chain. One definition of the tag rules for every block-scoped method: `latest`/`pending`/`safe`/
 * `finalized` are the indexer head (Midnight has no fork choice to distinguish them), `earliest`
 * is height 0, anything else must be a canonical hex height.
 */
export async function blockByTag(ctx: RpcContext, value: unknown): Promise<IndexerBlock | undefined> {
  const tag = resolveBlockTag(value);
  return tag.kind === "latest" ? ctx.indexer.getLatestBlock() : ctx.indexer.getBlockByHeight(tag.height);
}

/**
 * Fetches the block a `BlockNumberOrTagOrHash` parameter names (`eth_getBlockReceipts`). A
 * 32-byte hex string is read as a block hash — the same disambiguation geth applies, and
 * unambiguous here because a 32-byte value can never be a canonical hex quantity (it is either
 * zero-padded or longer than any height this chain reaches).
 */
export async function blockByRef(ctx: RpcContext, value: unknown): Promise<IndexerBlock | undefined> {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
    return ctx.indexer.getBlockByHash(value.slice(2).toLowerCase());
  }
  return blockByTag(ctx, value);
}

export function decimalBigInt(value: string | bigint | null | undefined, fallback = 0n): bigint {
  if (value === null || value === undefined) return fallback;
  const text = value.toString();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error("data source returned a non-integer amount");
  return BigInt(text);
}
