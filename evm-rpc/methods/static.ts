import { MethodRegistry } from "../registry.js";
import { ESTIMATE_GAS, GAS_PRICE, invalidParams, parseQuantity, positionalParams, quantity } from "./common.js";

type KeccakLane = bigint;
const MASK_64 = (1n << 64n) - 1n;
const ROTATION = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
] as const;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
] as const;

function rotateLeft64(value: bigint, amount: number): bigint {
  if (amount === 0) return value & MASK_64;
  const shift = BigInt(amount);
  return ((value << shift) | (value >> (64n - shift))) & MASK_64;
}

function keccakF(state: KeccakLane[]): void {
  for (const roundConstant of ROUND_CONSTANTS) {
    const c = new Array<bigint>(5);
    const d = new Array<bigint>(5);
    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x += 1) d[x] = c[(x + 4) % 5]! ^ rotateLeft64(c[(x + 1) % 5]!, 1);
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) state[x + 5 * y] = state[x + 5 * y]! ^ d[x]!;
    }

    const b = new Array<bigint>(25).fill(0n);
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLeft64(state[x + 5 * y]!, ROTATION[x + 5 * y]!);
      }
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        state[x + 5 * y] = b[x + 5 * y]! ^ ((~b[((x + 1) % 5) + 5 * y]!) & b[((x + 2) % 5) + 5 * y]!);
      }
    }
    state[0] = state[0]! ^ roundConstant;
  }
}

/** Ethereum Keccak-256 (legacy 0x01 domain, not FIPS SHA3-256). */
export function keccak256(input: Uint8Array): Buffer {
  const rate = 136;
  const paddedLength = Math.ceil((input.length + 1) / rate) * rate;
  const padded = Buffer.alloc(paddedLength);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      state[lane] = state[lane]! ^ padded.readBigUInt64LE(offset + lane * 8);
    }
    keccakF(state);
  }
  const output = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane += 1) output.writeBigUInt64LE(state[lane]!, lane * 8);
  return output;
}

function noParams(params: unknown): void {
  positionalParams(params, 0);
}

async function feeHistory(params: unknown): Promise<unknown> {
  const values = positionalParams(params, 2, 3);
  const count = parseQuantity(values[0], "block count");
  if (count > 1_024n) invalidParams("block count must not exceed 1024");
  const newest = values[1];
  if (typeof newest !== "string") invalidParams("newest block must be a block tag");
  const percentiles = values[2] ?? [];
  if (!Array.isArray(percentiles) || percentiles.some((p) => typeof p !== "number" || p < 0 || p > 100)) {
    invalidParams("reward percentiles must be numbers between 0 and 100");
  }
  if (percentiles.length > 100) invalidParams("reward percentiles must not contain more than 100 entries");
  if (count * BigInt(percentiles.length) > 4_096n) {
    invalidParams("block count and reward percentiles must not exceed 4096 reward entries");
  }
  const length = Number(count);
  const rewards = Array.from({ length }, () => percentiles.map(() => "0x0"));
  return {
    oldestBlock: newest.startsWith("0x") ? newest : "0x0",
    baseFeePerGas: Array.from({ length: length + 1 }, () => "0x0"),
    gasUsedRatio: Array.from({ length }, () => 0),
    reward: rewards,
  };
}

export function registerStaticMethods(registry: MethodRegistry): void {
  registry.registerMethod("eth_chainId", async (params, ctx) => { noParams(params); return quantity(ctx.chainId); });
  registry.registerMethod("net_version", async (params, ctx) => { noParams(params); return ctx.chainId.toString(10); });
  registry.registerMethod("web3_clientVersion", async (params, ctx) => { noParams(params); return ctx.clientVersion; });
  registry.registerMethod("net_listening", async (params) => { noParams(params); return true; });
  registry.registerMethod("eth_syncing", async (params) => { noParams(params); return false; });
  registry.registerMethod("eth_accounts", async (params) => { noParams(params); return []; });
  registry.registerMethod("eth_gasPrice", async (params) => { noParams(params); return GAS_PRICE; });
  registry.registerMethod("eth_estimateGas", async (params) => { positionalParams(params, 1, 2); return ESTIMATE_GAS; });
  registry.registerMethod("eth_call", async (params) => { positionalParams(params, 1, 2); return "0x"; });
  registry.registerMethod("eth_feeHistory", feeHistory);
  registry.registerMethod("eth_maxPriorityFeePerGas", async (params) => { noParams(params); return "0x0"; });
  registry.registerMethod("web3_sha3", async (params) => {
    const [value] = positionalParams(params, 1);
    if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
      invalidParams("input must be 0x-prefixed byte data");
    }
    return `0x${keccak256(Buffer.from(value.slice(2), "hex")).toString("hex")}`;
  });
}
