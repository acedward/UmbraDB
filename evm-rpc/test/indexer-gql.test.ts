import { describe, expect, it, vi } from "vitest";
import type { IndexerBlock, IndexerTransaction } from "../indexer-gql.js";
import { IndexerGqlClient, IndexerGqlError } from "../indexer-gql.js";
import { fixture } from "./helpers.js";

describe("IndexerGqlClient", () => {
  it("posts flat block queries and passes unprefixed offsets", async () => {
    const block = await fixture<IndexerBlock>("block-latest.json");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string) as { query: string; variables: Record<string, unknown> };
      // `id` is selected alongside the hash: it is the only identifier that survives a hash
      // disagreement between two indexer surfaces (see wallet-monitor/tx-hash-backfill.ts).
      expect(request.query).toContain("transactions { id hash }");
      expect(request.query).not.toContain("transactions { id hash block");
      expect(request.variables).toEqual({ hash: "aa".repeat(32) });
      return new Response(JSON.stringify({ data: { block } }), { status: 200 });
    });
    const client = new IndexerGqlClient({ url: "http://indexer/graphql", fetchImpl: fetchImpl as typeof fetch });
    await expect(client.getBlockByHash("aa".repeat(32))).resolves.toEqual(block);
  });

  it("uses element zero from transaction-list responses and reports the match count", async () => {
    const tx = await fixture<IndexerTransaction>("tx-success.json");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { transactions: [tx, tx] } })));
    const client = new IndexerGqlClient({ url: "http://indexer/graphql", fetchImpl: fetchImpl as typeof fetch });
    await expect(client.getTransactionByHash("cc".repeat(32))).resolves.toEqual({ transaction: tx, matchCount: 2 });
  });

  it("wraps GraphQL and non-JSON failures", async () => {
    const graphqlClient = new IndexerGqlClient({
      url: "http://indexer/graphql",
      fetchImpl: (async () => new Response(JSON.stringify({ errors: [{ message: "too complex" }] }))) as typeof fetch,
    });
    await expect(graphqlClient.getLatestBlock()).rejects.toThrow("too complex");

    const parseClient = new IndexerGqlClient({
      url: "http://indexer/graphql",
      fetchImpl: (async () => new Response("not-json")) as typeof fetch,
    });
    await expect(parseClient.getLatestBlock()).rejects.toBeInstanceOf(IndexerGqlError);
  });

  it("[[evm-rpc.indexer-gql.before-request]] a request waits for beforeRequest and its timeout starts once admitted; a refused admission fetches nothing", async () => {
    const events: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      events.push(`fetch, signal ${init?.signal?.aborted === true ? "aborted" : "live"}`);
      return new Response(JSON.stringify({ data: { block: null } }));
    }) as typeof fetch;
    const client = new IndexerGqlClient({
      url: "http://indexer/graphql",
      fetchImpl,
      timeoutMs: 50,
      beforeRequest: async () => {
        events.push("waiting");
        await new Promise((resolve) => setTimeout(resolve, 150));
        events.push("admitted");
      },
    });
    await expect(client.getLatestBlock()).resolves.toBeUndefined();
    expect(events).toEqual(["waiting", "admitted", "fetch, signal live"]);

    events.length = 0;
    const refusing = new IndexerGqlClient({ url: "http://indexer/graphql", fetchImpl, beforeRequest: async () => { throw new Error("no room"); } });
    await expect(refusing.getLatestBlock()).rejects.toThrow(IndexerGqlError);
    expect(events).toEqual([]);
  });
});
