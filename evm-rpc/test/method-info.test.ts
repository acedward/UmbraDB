/**
 * The notes beside the module's method names (`../method-info.ts`) describe the registry, not a list of their own, and
 * every example parameter list is one the method accepts.
 *
 * - `[[evm-rpc.method-info.registry]]` — `METHOD_NOTES` names exactly the read-only registry's methods that are not
 *   `-32004` stubs; `NODE_ONLY_METHODS` are not registered by the read-only entry point, and are exactly what
 *   `npm run evm-rpc:all` registers beyond it (derived from `serve-all.ts`: each registration function it calls, run on
 *   a registry of its own, and each method it registers by name; a registration this test does not know fails it) plus
 *   what the WebSocket server (`logs/subscribe.ts`) answers by name.
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
import { registerAccountMethods } from "../methods/accounts.js";
import { registerBlockMethods } from "../methods/blocks.js";
import { registerErc20Call } from "../methods/erc20-call.js";
import { NOT_IMPLEMENTED_METHODS, registerNotImplementedMethods } from "../methods/not-implemented.js";
import { registerStaticMethods } from "../methods/static.js";
import { registerTransactionMethods } from "../methods/transactions.js";
import { registerReadOnlyMethods } from "../read-only.js";
import { registeredMethods } from "../registry-shim.js";
import { MethodRegistry, type RpcContext } from "../registry.js";
import { createRpcServer } from "../server.js";
import { sendToServer } from "./node-answers.js";
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

  it("[[evm-rpc.method-info.registry]] the notes name exactly the registry's served methods; the Node-only methods are exactly what evm-rpc:all registers beyond the read-only set, and what its WebSocket server answers by name", () => {
    const served = registry.listMethods().filter((m) => !stubs.has(m));
    expect(Object.keys(METHOD_NOTES).sort()).toEqual([...served].sort());
    for (const note of Object.values(METHOD_NOTES)) expect(note.source.length).toBeGreaterThan(0);

    const nodeOnly = NODE_ONLY_METHODS.map((m) => m.method);
    expect(new Set(nodeOnly).size).toBe(nodeOnly.length);
    for (const m of nodeOnly) {
      expect(registry.getMethod(m), m).toBeUndefined();
      expect(stubs.has(m), m).toBe(false);
    }

    // What `npm run evm-rpc:all` registers, derived from serve-all.ts: each registration function it calls, run on a
    // registry of its own, and each method it registers by name. A registration this test does not know fails it.
    const dummySql = (() => { throw new Error("not called"); }) as never;
    const namesOf = (register: (r: MethodRegistry) => void): string[] => {
      const r = new MethodRegistry();
      register(r);
      return [...r.listMethods()];
    };
    const registrations: Record<string, () => string[]> = {
      registerStaticMethods: () => namesOf(registerStaticMethods),
      registerBlockMethods: () => namesOf(registerBlockMethods),
      registerAccountMethods: () => namesOf(registerAccountMethods),
      registerTransactionMethods: () => namesOf(registerTransactionMethods),
      registerNotImplementedMethods: () => namesOf(registerNotImplementedMethods),
      registerErc20Call: () => namesOf((r) => registerErc20Call({ registry: r, sql: dummySql, schema: "evm_rpc", tokens: [] })),
      registerGetLogs: () => {
        const before = new Set(registeredMethods());
        registerGetLogs({ sql: dummySql, schema: "evm_rpc" });
        return registeredMethods().filter((m) => !before.has(m));
      },
    };
    const serveAll = source("serve-all.ts");
    const called = [...new Set([...serveAll.matchAll(/\b(register\w+)\(/g)].map((m) => m[1]!).filter((n) => n !== "registerMethod"))];
    expect(called.filter((n) => !(n in registrations)), "a registration of serve-all.ts this test does not know").toEqual([]);
    const byName = [...serveAll.matchAll(/registerMethod\(\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(byName.length).toBeGreaterThan(0);
    const full = new Set([...called.flatMap((n) => registrations[n]!()), ...byName]);
    const readOnly = new Set(registry.listMethods());
    const httpNodeOnly = NODE_ONLY_METHODS.filter((m) => m.surface !== "WebSocket").map((m) => m.method);
    expect([...full].filter((m) => !readOnly.has(m)).sort()).toEqual([...httpNodeOnly].sort());
    // eth_call is one of the read-only set that evm-rpc:all serves differently (the ERC20 views): its note says so.
    expect(full.has("eth_call")).toBe(true);
    expect(METHOD_NOTES.eth_call!.note).toContain("Node only");

    // The WebSocket server's own methods: those subscribe.ts answers by name.
    const ws = [...source("logs/subscribe.ts").matchAll(/request\.method === "([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ws)).toEqual(new Set(NODE_ONLY_METHODS.filter((m) => m.surface === "WebSocket").map((m) => m.method)));
  });

  it("[[evm-rpc.method-info.examples]] every example is accepted, through the handler and identically through Node's server", async () => {
    const server = createRpcServer({ registry, ctx: context() });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      let id = 1;
      for (const [method, note] of Object.entries(METHOD_NOTES)) {
        const body = JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: note.params });
        const answer = await handleHttpRequest("POST", textBody(body), registry, context());
        expect(answer.status, method).toBe(200);
        const parsed = JSON.parse(answer.body) as { result?: unknown; error?: unknown };
        expect(parsed.error, method).toBeUndefined();
        expect(Object.hasOwn(parsed, "result"), method).toBe(true);
        expect((await sendToServer(port, "POST", body)).body.toString("utf8"), method).toBe(answer.body);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
