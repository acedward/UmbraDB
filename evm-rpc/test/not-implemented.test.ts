import { describe, expect, it } from "vitest";
import { registerAccountMethods } from "../methods/accounts.js";
import { registerBlockMethods } from "../methods/blocks.js";
import {
  NOT_IMPLEMENTED_DOC, NOT_IMPLEMENTED_METHODS, registerNotImplementedMethods,
} from "../methods/not-implemented.js";
import { registerStaticMethods } from "../methods/static.js";
import { registerTransactionMethods } from "../methods/transactions.js";
import { JSON_RPC_ERRORS, MethodRegistry } from "../registry.js";
import { dispatchPayload, dispatchRequest } from "../server.js";
import { context } from "./helpers.js";

/**
 * Every method the official Ethereum JSON-RPC spec defines at the reviewed pin —
 * `ethereum/execution-apis` @ `742d45db810b31265c8d3c075af324953330d1ed` (`src/eth/*.yaml`,
 * 46 `eth_*` + `net_version`). Inlined rather than parsed out of that checkout: it is a review
 * workspace resource outside this repo, and this suite must not depend on a path that only exists
 * on one machine. Re-pinning the spec is a new review pass (plan 00006 FR-001) and updates this
 * list in the same change.
 */
const OFFICIAL_METHODS = [
  // block.yaml
  "eth_getBlockByHash", "eth_getBlockByNumber", "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber", "eth_getBlockReceipts", "eth_getBlockAccessList",
  // client.yaml
  "eth_chainId", "eth_syncing", "eth_coinbase", "eth_accounts", "eth_blockNumber", "eth_config",
  "net_version",
  // capabilities.yaml
  "eth_capabilities",
  // execute.yaml
  "eth_call",
  "eth_estimateGas",
  "eth_simulateV1",
  "eth_createAccessList",
  // fee_market.yaml
  "eth_gasPrice", "eth_baseFee", "eth_blobBaseFee", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  // filter.yaml
  "eth_newFilter", "eth_newBlockFilter", "eth_newPendingTransactionFilter", "eth_uninstallFilter",
  "eth_getFilterChanges", "eth_getFilterLogs", "eth_getLogs",
  // fill.yaml / sign.yaml
  "eth_fillTransaction", "eth_sign", "eth_signTransaction",
  // transaction.yaml
  "eth_getTransactionByHash", "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionReceipt",
  // subscribe.yaml / submit.yaml
  "eth_subscribe", "eth_unsubscribe", "eth_sendTransaction", "eth_sendRawTransaction",
  // state.yaml
  "eth_getBalance", "eth_getStorageAt", "eth_getStorageValues", "eth_getTransactionCount",
  "eth_getCode", "eth_getProof",
] as const;

/** The full Part B surface plus the NYI stubs, wired exactly as `rpc-cli.ts` wires it. */
function fullRegistry(): MethodRegistry {
  const registry = new MethodRegistry();
  registerStaticMethods(registry);
  registerBlockMethods(registry);
  registerAccountMethods(registry);
  registerTransactionMethods(registry);
  registerNotImplementedMethods(registry);
  return registry;
}

describe("not-implemented (-32004) policy", () => {
  it("answers -32004 with a classification, a reason and a documentation pointer", async () => {
    const registry = fullRegistry();
    for (const entry of NOT_IMPLEMENTED_METHODS) {
      const response = await dispatchRequest({ jsonrpc: "2.0", id: 1, method: entry.method, params: [] }, registry, context());
      expect(response, entry.method).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: JSON_RPC_ERRORS.METHOD_NOT_SUPPORTED,
          message: "Method not supported",
          data: {
            method: entry.method,
            classification: entry.classification,
            reason: entry.reason,
            documentation: NOT_IMPLEMENTED_DOC,
          },
        },
      });
    }
    expect(JSON_RPC_ERRORS.METHOD_NOT_SUPPORTED).toBe(-32004);
  });

  it("keeps -32601 for genuinely unknown method names, so the two are distinguishable", async () => {
    const registry = fullRegistry();
    for (const unknown of ["eth_notARealMethod", "totally_garbage", "", "debug_traceTransaction", "eth_getproof"]) {
      await expect(dispatchRequest({ jsonrpc: "2.0", id: 1, method: unknown }, registry, context()), unknown)
        .resolves.toMatchObject({ error: { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND, message: "Method not found" } });
    }
    // ...and the -32004 list never leaks a -32601, which is what makes the distinction meaningful.
    await expect(dispatchRequest({ jsonrpc: "2.0", id: 1, method: "eth_getProof", params: [] }, registry, context()))
      .resolves.toMatchObject({ error: { code: JSON_RPC_ERRORS.METHOD_NOT_SUPPORTED } });
  });

  it("carries all three verdicts through one batch: -32004, -32601 and a real result, in order", async () => {
    const registry = fullRegistry();
    const responses = await dispatchPayload([
      { jsonrpc: "2.0", id: 1, method: "eth_newFilter", params: [{}] },
      { jsonrpc: "2.0", id: 2, method: "eth_thisDoesNotExist", params: [] },
      { jsonrpc: "2.0", id: 3, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 4, method: "eth_getStorageAt", params: [] },
    ], registry, context()) as unknown as Record<string, unknown>[];

    expect(responses).toHaveLength(4);
    expect(responses[0]).toMatchObject({ id: 1, error: { code: -32004, message: "Method not supported" } });
    expect(responses[1]).toMatchObject({ id: 2, error: { code: -32601, message: "Method not found" } });
    expect(responses[2]).toEqual({ jsonrpc: "2.0", id: 3, result: "0x960" });
    expect(responses[3]).toMatchObject({ id: 4, error: { code: -32004 } });
  });

  it("ignores params entirely — a -32004 method never reports a params problem instead", async () => {
    const registry = fullRegistry();
    for (const params of [undefined, [], [1, 2, 3], [{ fromBlock: "0x0" }]]) {
      await expect(dispatchRequest({ jsonrpc: "2.0", id: 1, method: "eth_getFilterChanges", params }, registry, context()))
        .resolves.toMatchObject({ error: { code: JSON_RPC_ERRORS.METHOD_NOT_SUPPORTED } });
    }
  });

  it("leaves no official spec method answering -32601 (SC-005), and stubs nothing unofficial", () => {
    const registry = fullRegistry();
    expect(OFFICIAL_METHODS).toHaveLength(47);

    // Registered elsewhere, deliberately absent from this Part B registry: `eth_getLogs`,
    // `eth_subscribe` and `eth_unsubscribe` come from Part C (`logs/`), and
    // `eth_sendRawTransaction` only exists when RELAY_URL is set (`serve-all.ts`).
    const registeredElsewhere = new Set([
      "eth_getLogs", "eth_subscribe", "eth_unsubscribe", "eth_sendRawTransaction",
    ]);
    const unanswered = OFFICIAL_METHODS
      .filter((method) => !registeredElsewhere.has(method) && registry.getMethod(method) === undefined);
    expect(unanswered).toEqual([]);

    // Every stub names a REAL spec method (no invented names), and no name is stubbed twice.
    const stubbed = NOT_IMPLEMENTED_METHODS.map(({ method }) => method);
    expect(new Set(stubbed).size).toBe(stubbed.length);
    for (const method of stubbed) expect(OFFICIAL_METHODS, method).toContain(method);

    // The five methods this phase implemented are answered for real, not stubbed.
    for (const method of [
      "eth_getBlockTransactionCountByHash", "eth_getBlockTransactionCountByNumber",
      "eth_getTransactionByBlockHashAndIndex", "eth_getTransactionByBlockNumberAndIndex",
      "eth_getBlockReceipts",
    ]) {
      expect(stubbed, method).not.toContain(method);
      expect(registry.getMethod(method), method).toBeDefined();
    }
  });
});
