/**
 * The notes beside the module's method names (`../method-info.ts`) describe the registry, not a list of their own, and
 * every example parameter list is one the method accepts.
 *
 * - `[[evm-rpc.method-info.registry]]` — `METHOD_NOTES` names exactly the read-only registry's methods that are not
 *   `-32004` stubs; `NODE_ONLY_METHODS` are not registered by the read-only entry point and are what `npm run
 *   evm-rpc:all`'s modules add: `registerGetLogs` registers `eth_getLogs`, `registerErc20Call` replaces `eth_call`,
 *   `serve-all.ts` registers `eth_sendRawTransaction`, and the WebSocket server (`logs/subscribe.ts`) answers
 *   `eth_subscribe` and `eth_unsubscribe`.
 * - `[[evm-rpc.method-info.examples]]` — each served method called with its example over the recorded indexer answers
 *   a result, never an error, through the handler and identically through Node's HTTP server.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { emptyEvmRpcReader } from "../db.js";
import { handleHttpRequest, textBody } from "../handler.js";
import { IndexerGqlClient } from "../indexer-gql.js";
import { registerGetLogs } from "../logs/get-logs.js";
import { METHOD_NOTES, NODE_ONLY_METHODS } from "../method-info.js";
import { registerErc20Call } from "../methods/erc20-call.js";
import { NOT_IMPLEMENTED_METHODS } from "../methods/not-implemented.js";
import { registerReadOnlyMethods } from "../read-only.js";
import { registeredMethods } from "../registry-shim.js";
import { MethodRegistry, type RpcContext } from "../registry.js";
import { createRpcServer } from "../server.js";
import { recordedIndexerFetch } from "./recorded-indexer.js";

const source = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function context(): RpcContext {
  return {
    chainId: 2400n,
    clientVersion: "umbradb-evm-rpc/0.9.5",
    indexer: new IndexerGqlClient({ url: "http://indexer.test/graphql", fetchImpl: recordedIndexerFetch().fetch }),
    db: emptyEvmRpcReader,
  };
}

describe("the method notes", () => {
  const registry = new MethodRegistry();
  registerReadOnlyMethods(registry);
  const stubs = new Set(NOT_IMPLEMENTED_METHODS.map((m) => m.method));

  it("[[evm-rpc.method-info.registry]] the notes name exactly the registry's served methods; the Node-only methods are what evm-rpc:all adds", () => {
    const served = registry.listMethods().filter((m) => !stubs.has(m));
    expect(Object.keys(METHOD_NOTES).sort()).toEqual([...served].sort());
    for (const note of Object.values(METHOD_NOTES)) expect(note.source.length).toBeGreaterThan(0);

    const nodeOnly = NODE_ONLY_METHODS.map((m) => m.method);
    expect(new Set(nodeOnly).size).toBe(nodeOnly.length);
    for (const m of nodeOnly) {
      expect(registry.getMethod(m), m).toBeUndefined();
      expect(stubs.has(m), m).toBe(false);
    }
    const dummySql = (() => { throw new Error("not called"); }) as never;
    registerGetLogs({ sql: dummySql, schema: "evm_rpc" });
    expect(registeredMethods()).toContain("eth_getLogs");
    const full = new MethodRegistry();
    registerReadOnlyMethods(full);
    const readOnlyCall = full.getMethod("eth_call");
    registerErc20Call({ registry: full, sql: dummySql, schema: "evm_rpc", tokens: [] });
    expect(full.getMethod("eth_call")).not.toBe(readOnlyCall);
    expect(source("serve-all.ts")).toContain('defaultRegistry.registerMethod("eth_sendRawTransaction"');
    const ws = source("logs/subscribe.ts");
    expect(ws).toContain('request.method === "eth_subscribe"');
    expect(ws).toContain('request.method === "eth_unsubscribe"');
    expect(new Set(nodeOnly)).toEqual(new Set(["eth_getLogs", "eth_sendRawTransaction", "eth_subscribe", "eth_unsubscribe"]));
  });

  it("[[evm-rpc.method-info.examples]] every example is accepted, through the handler and identically through Node's server", async () => {
    const server = createRpcServer({ registry, ctx: context() });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      let id = 1;
      for (const [method, note] of Object.entries(METHOD_NOTES)) {
        const body = JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: note.params });
        const answer = await handleHttpRequest("POST", textBody(body), registry, context());
        expect(answer.status, method).toBe(200);
        const parsed = JSON.parse(answer.body) as { result?: unknown; error?: unknown };
        expect(parsed.error, method).toBeUndefined();
        expect(Object.hasOwn(parsed, "result"), method).toBe(true);
        const http = await fetch(url, { method: "POST", body });
        expect(await http.text(), method).toBe(answer.body);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
