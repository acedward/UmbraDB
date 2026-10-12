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
 * - `[[evm-rpc.method-info.param-specs]]` — each method (the Node-only ones too) has a one-line summary; each served
 *   one has the kinds of its positional parameters: names unique, optional ones only at the end; its example fits them
 *   (each value of its kind, every required one given); the method answers a result with its required parameters only,
 *   with all of them, and with each block tag Node accepts in a block parameter, and refuses one parameter more than
 *   the kinds list (`-32602`), so the list is exactly what the method takes.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { emptyEvmRpcReader } from "../db.js";
import { handleHttpRequest, textBody } from "../handler.js";
import { IndexerGqlClient } from "../indexer-gql.js";
import { registerGetLogs } from "../logs/get-logs.js";
import { METHOD_NOTES, NODE_ONLY_METHODS, type ParamKind } from "../method-info.js";
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

  /** Whether `v` is a value of `kind`, as the method takes it. */
  const fits = (kind: ParamKind, v: unknown): boolean => {
    const tags = ["latest", "earliest", "pending", "safe", "finalized"];
    switch (kind) {
      case "address":
        return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
      case "hash":
        return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
      case "quantity":
        return typeof v === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v);
      case "blockTag":
        return typeof v === "string" && (tags.includes(v) || /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v));
      case "blockRef":
        return typeof v === "string" && (tags.includes(v) || /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v) || /^0x[0-9a-fA-F]{64}$/.test(v));
      case "boolean":
        return typeof v === "boolean";
      case "data":
        return typeof v === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(v);
      case "percentiles":
        return Array.isArray(v) && v.every((x) => typeof x === "number" && x >= 0 && x <= 100);
      case "object":
        return typeof v === "object" && v !== null && !Array.isArray(v);
    }
  };

  it("[[evm-rpc.method-info.param-specs]] each served method has a summary and its parameters' kinds: the example fits them, the required ones alone, all of them and every block tag are answered, one more is refused", async () => {
    const answer = async (method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code: number } }> =>
      JSON.parse((await handleHttpRequest("POST", textBody(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })), registry, context())).body) as { result?: unknown; error?: { code: number } };
    for (const m of NODE_ONLY_METHODS) expect(m.summary.trim(), m.method).not.toBe("");
    for (const [method, note] of Object.entries(METHOD_NOTES)) {
      expect(note.summary.trim(), method).not.toBe("");
      expect(note.summary, method).not.toMatch(/\n/);
      const specs = note.paramSpecs;
      expect(new Set(specs.map((s) => s.name)).size, method).toBe(specs.length);
      const required = specs.findIndex((s) => s.optional === true);
      const requiredCount = required < 0 ? specs.length : required;
      expect(specs.slice(requiredCount).every((s) => s.optional === true), `${method}: optional parameters only at the end`).toBe(true);
      expect(note.params.length, method).toBeGreaterThanOrEqual(requiredCount);
      expect(note.params.length, method).toBeLessThanOrEqual(specs.length);
      note.params.forEach((v, i) => expect(fits(specs[i]!.kind, v), `${method} parameter ${i}`).toBe(true));
      // The required parameters alone.
      const minimal = note.params.slice(0, requiredCount);
      expect((await answer(method, minimal)).error, `${method} with its required parameters`).toBeUndefined();
      // Every block tag Node accepts, in each block parameter.
      for (const [i, s] of specs.entries()) {
        if (s.kind !== "blockTag" && s.kind !== "blockRef") continue;
        for (const tag of ["latest", "earliest", "pending", "safe", "finalized"]) {
          const params = [...note.params];
          while (params.length <= i) params.push(undefined);
          params[i] = tag;
          expect((await answer(method, params)).error, `${method} ${tag}`).toBeUndefined();
        }
      }
      // One parameter more than its kinds list.
      const full = [...note.params];
      while (full.length < specs.length) full.push(specs[full.length]!.kind === "percentiles" ? [] : "latest");
      expect((await answer(method, full)).error, `${method} with every parameter`).toBeUndefined();
      expect((await answer(method, [...full, "0x0"])).error?.code, `${method} with a parameter too many`).toBe(-32602);
    }
  });
});
