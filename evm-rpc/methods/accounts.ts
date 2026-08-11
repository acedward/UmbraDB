import { MethodRegistry } from "../registry.js";
import { fixedDataHex, invalidParams, positionalParams, quantity } from "./common.js";

export const NIGHT_TO_WEI_SCALE = 1_000_000_000_000n;

function accountParams(params: unknown): { address: Buffer; tag: unknown } {
  const [addressValue, tag = "latest"] = positionalParams(params, 1, 2);
  const address = fixedDataHex(addressValue, 20, "address");
  if (typeof tag !== "string") {
    // Historical state is unavailable, but syntactically the second argument remains a block tag.
    invalidParams("block tag must be a string");
  }
  return { address: Buffer.from(address.slice(2), "hex"), tag };
}

export function scaleNightToWei(value: bigint): bigint {
  if (value < 0n) throw new Error("balance cannot be negative");
  return value * NIGHT_TO_WEI_SCALE;
}

export function registerAccountMethods(registry: MethodRegistry): void {
  registry.registerMethod("eth_getBalance", async (params, ctx) => {
    const { address } = accountParams(params);
    const balance = await ctx.db.getNativeBalance(address);
    return quantity(scaleNightToWei(balance ?? 0n));
  });

  registry.registerMethod("eth_getTransactionCount", async (params, ctx) => {
    const { address } = accountParams(params);
    return quantity(await ctx.db.getTransactionCount(address));
  });

  registry.registerMethod("eth_getCode", async (params, ctx) => {
    const { address } = accountParams(params);
    return (await ctx.db.getAddressKind(address)) === "contract" ? "0x60006000" : "0x";
  });
}
