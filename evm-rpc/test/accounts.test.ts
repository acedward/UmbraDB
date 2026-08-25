import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EvmRpcReader } from "../db.js";
import { NIGHT_TO_WEI_SCALE, registerAccountMethods, scaleNightToWei } from "../methods/accounts.js";
import { MethodRegistry } from "../registry.js";
import { context, fakeIndexer } from "./helpers.js";

function db(overrides: Partial<EvmRpcReader> = {}): EvmRpcReader {
  return {
    async getNativeBalance() { return undefined; },
    async getTransactionCount() { return 0n; },
    async getAddressKind() { return undefined; },
    async getTransactionByHash() { return undefined; },
    async getLogsByTransactionHash() { return []; },
    ...overrides,
  };
}

const address = `0x${"12".repeat(20)}`;

describe("account methods", () => {
  it("returns zero for unknown and zero-balance addresses", async () => {
    const registry = new MethodRegistry();
    registerAccountMethods(registry);
    await expect(registry.getMethod("eth_getBalance")!([address, "latest"], context({ db: db() }))).resolves.toBe("0x0");
    await expect(registry.getMethod("eth_getBalance")!([address, "0x1"], context({ db: db({ async getNativeBalance() { return 0n; } }) }))).resolves.toBe("0x0");
  });

  it("scales max-u128 exactly and returns nonce/code projections", async () => {
    const max = (1n << 128n) - 1n;
    const registry = new MethodRegistry();
    registerAccountMethods(registry);
    const ctx = context({ indexer: fakeIndexer(), db: db({
      async getNativeBalance() { return max; },
      async getTransactionCount() { return 17n; },
      async getAddressKind() { return "contract"; },
    }) });
    await expect(registry.getMethod("eth_getBalance")!([address, "latest"], ctx)).resolves.toBe(`0x${(max * NIGHT_TO_WEI_SCALE).toString(16)}`);
    await expect(registry.getMethod("eth_getTransactionCount")!([address, "latest"], ctx)).resolves.toBe("0x11");
    await expect(registry.getMethod("eth_getCode")!([address, "latest"], ctx)).resolves.toBe("0x60006000");
  });

  it("scaling round-trips for every generated u128", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), (value) => {
      expect(scaleNightToWei(value) / NIGHT_TO_WEI_SCALE).toBe(value);
      expect(scaleNightToWei(value) % NIGHT_TO_WEI_SCALE).toBe(0n);
    }));
  });
});

