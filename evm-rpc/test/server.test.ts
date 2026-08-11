import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { emptyEvmRpcReader } from "../db.js";
import { registerStaticMethods } from "../methods/static.js";
import { JSON_RPC_ERRORS, MethodRegistry, RpcError } from "../registry.js";
import { createRpcServer, dispatchPayload, dispatchRequest } from "../server.js";
import { context } from "./helpers.js";

describe("JSON-RPC envelope", () => {
  it("echoes string and null ids", async () => {
    const registry = new MethodRegistry();
    registry.registerMethod("echo", async (params) => params);
    await expect(dispatchRequest({ jsonrpc: "2.0", id: "wallet", method: "echo", params: [1] }, registry, context()))
      .resolves.toEqual({ jsonrpc: "2.0", id: "wallet", result: [1] });
    await expect(dispatchRequest({ jsonrpc: "2.0", id: null, method: "echo", params: [] }, registry, context()))
      .resolves.toEqual({ jsonrpc: "2.0", id: null, result: [] });
  });

  it("preserves batch order and isolates a failed entry", async () => {
    const registry = new MethodRegistry();
    registry.registerMethod("ok", async (params) => (params as unknown[])[0]);
    registry.registerMethod("bad", async () => { throw new RpcError(-32602, "bad input"); });
    const result = await dispatchPayload([
      { jsonrpc: "2.0", id: 1, method: "ok", params: ["first"] },
      { jsonrpc: "2.0", id: 2, method: "bad", params: [] },
      { jsonrpc: "2.0", id: 3, method: "ok", params: ["last"] },
    ], registry, context());
    expect(result).toEqual([
      { jsonrpc: "2.0", id: 1, result: "first" },
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad input" } },
      { jsonrpc: "2.0", id: 3, result: "last" },
    ]);
  });

  it("reports unknown methods, malformed params, invalid requests, and empty batches", async () => {
    const registry = new MethodRegistry();
    registry.registerMethod("ok", async () => true);
    await expect(dispatchRequest({ jsonrpc: "2.0", id: 1, method: "missing" }, registry, context()))
      .resolves.toMatchObject({ error: { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND } });
    await expect(dispatchRequest({ jsonrpc: "2.0", id: 1, method: "ok", params: 1 }, registry, context()))
      .resolves.toMatchObject({ error: { code: JSON_RPC_ERRORS.INVALID_PARAMS } });
    await expect(dispatchRequest({ jsonrpc: "1.0", id: 1, method: "ok" }, registry, context()))
      .resolves.toMatchObject({ error: { code: JSON_RPC_ERRORS.INVALID_REQUEST } });
    await expect(dispatchPayload([], registry, context()))
      .resolves.toMatchObject({ error: { code: JSON_RPC_ERRORS.INVALID_REQUEST } });
  });

  it("does not emit responses for notifications", async () => {
    const registry = new MethodRegistry();
    registry.registerMethod("ok", async () => true);
    await expect(dispatchRequest({ jsonrpc: "2.0", method: "ok" }, registry, context())).resolves.toBeUndefined();
  });

  it("bounds batch cardinality and isolates unserializable plugin values", async () => {
    const registry = new MethodRegistry();
    registry.registerMethod("ok", async () => true);
    registry.registerMethod("bigint", async () => 1n);
    registry.registerMethod("undefined", async () => undefined);
    registry.registerMethod("bad-data", async () => { throw new RpcError(-32000, "bad", 1n); });
    const oversized = Array.from({ length: 101 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ok" }));
    await expect(dispatchPayload(oversized, registry, context()))
      .resolves.toMatchObject({ error: { code: JSON_RPC_ERRORS.INVALID_REQUEST } });
    await expect(dispatchRequest({ jsonrpc: "2.0", id: "plugin", method: "bigint" }, registry, context()))
      .resolves.toEqual({ jsonrpc: "2.0", id: "plugin", error: { code: JSON_RPC_ERRORS.INTERNAL_ERROR, message: "Internal error" } });
    await expect(dispatchRequest({ jsonrpc: "2.0", id: "plugin", method: "undefined" }, registry, context()))
      .resolves.toEqual({ jsonrpc: "2.0", id: "plugin", error: { code: JSON_RPC_ERRORS.INTERNAL_ERROR, message: "Internal error" } });
    await expect(dispatchPayload([
      { jsonrpc: "2.0", id: 1, method: "ok" },
      { jsonrpc: "2.0", id: 2, method: "bad-data" },
    ], registry, context())).resolves.toEqual([
      { jsonrpc: "2.0", id: 1, result: true },
      { jsonrpc: "2.0", id: 2, error: { code: JSON_RPC_ERRORS.INTERNAL_ERROR, message: "Internal error" } },
    ]);
  });

  it("invokes a plugin toJSON only once", async () => {
    const registry = new MethodRegistry();
    let calls = 0;
    registry.registerMethod("custom-json", async () => ({
      toJSON() {
        calls += 1;
        if (calls > 1) throw new Error("serialized twice");
        return { ok: true };
      },
    }));
    const response = await dispatchRequest({ jsonrpc: "2.0", id: 1, method: "custom-json" }, registry, context());
    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(JSON.stringify(response)).toContain('"ok":true');
    expect(calls).toBe(1);
  });

  it("caps aggregate batch response amplification without losing small entries", async () => {
    const registry = new MethodRegistry();
    registry.registerMethod("large", async () => "x".repeat(600_000));
    registry.registerMethod("small", async () => true);
    const response = await dispatchPayload([
      { jsonrpc: "2.0", id: 1, method: "large" },
      { jsonrpc: "2.0", id: 2, method: "large" },
      { jsonrpc: "2.0", id: 3, method: "small" },
    ], registry, context());
    expect(response).toEqual([
      { jsonrpc: "2.0", id: 1, result: "x".repeat(600_000) },
      { jsonrpc: "2.0", id: 2, error: { code: -32005, message: "Batch response limit exceeded" } },
      { jsonrpc: "2.0", id: 3, result: true },
    ]);
  });
});

describe("HTTP transport", () => {
  const servers: ReturnType<typeof createRpcServer>[] = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

  async function start(): Promise<string> {
    const registry = new MethodRegistry();
    registry.registerMethod("ok", async () => true);
    const server = createRpcServer({ registry, ctx: context({ db: emptyEvmRpcReader }) });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("returns parse errors and allow-all CORS", async () => {
    const response = await fetch(await start(), { method: "POST", body: "{" });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({ error: { code: JSON_RPC_ERRORS.PARSE_ERROR } });
  });

  it("answers CORS preflight", async () => {
    const response = await fetch(await start(), { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("static methods", () => {
  const registry = new MethodRegistry();
  registerStaticMethods(registry);
  const cases: readonly [string, unknown[], unknown][] = [
    ["eth_chainId", [], "0x960"],
    ["net_version", [], "2400"],
    ["web3_clientVersion", [], "umbradb-evm-rpc/0.9.5"],
    ["net_listening", [], true],
    ["eth_syncing", [], false],
    ["eth_accounts", [], []],
    ["eth_gasPrice", [], "0x3b9aca00"],
    ["eth_estimateGas", [{}], "0x5208"],
    ["eth_call", [{}], "0x"],
    ["eth_maxPriorityFeePerGas", [], "0x0"],
    ["web3_sha3", ["0x"], "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ];
  for (const [method, params, expected] of cases) {
    it(method, async () => {
      await expect(registry.getMethod(method)!(params, context())).resolves.toEqual(expected);
    });
  }

  it("eth_feeHistory returns a MetaMask-compatible zero shape", async () => {
    await expect(registry.getMethod("eth_feeHistory")!(["0x2", "latest", [10, 50]], context())).resolves.toEqual({
      oldestBlock: "0x0",
      baseFeePerGas: ["0x0", "0x0", "0x0"],
      gasUsedRatio: [0, 0],
      reward: [["0x0", "0x0"], ["0x0", "0x0"]],
    });
  });

  it("eth_feeHistory rejects response-amplifying percentile lists", async () => {
    await expect(registry.getMethod("eth_feeHistory")!(["0x400", "latest", Array(101).fill(0)], context()))
      .rejects.toMatchObject({ code: JSON_RPC_ERRORS.INVALID_PARAMS });
    await expect(registry.getMethod("eth_feeHistory")!(["0x400", "latest", Array(100).fill(0)], context()))
      .rejects.toMatchObject({ code: JSON_RPC_ERRORS.INVALID_PARAMS });
  });
});
