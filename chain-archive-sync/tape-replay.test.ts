import { describe, expect, it } from "vitest";
import type { ArchiveTape, TapeBlock } from "./archive-tape.js";
import { IndexerClient } from "./indexer-client.js";
import { NodeRpcClient, NodeRpcError } from "./node-rpc-client.js";
import { createTapeFetch, createTapeReplay, DEFAULT_TAPE_ORIGIN } from "./tape-replay.js";

/**
 * The tape replay's answering core and its `fetch`-shaped function, on a small synthetic tape (heights 100–109) and
 * through the real node and indexer clients. No network, no database.
 */

const hashOf = (h: number): string => `0x${h.toString(16).padStart(64, "0")}`;

function block(height: number): TapeBlock {
  return {
    height,
    blockHash: hashOf(height),
    nodeBlock: {
      block: {
        header: { parentHash: hashOf(height - 1), number: `0x${height.toString(16)}`, stateRoot: hashOf(1), extrinsicsRoot: hashOf(2), digest: { logs: [] } },
        extrinsics: [`0x0400${height.toString(16)}`],
      },
      justifications: null,
    },
    indexerBlock: {
      hash: hashOf(height).slice(2), height, transactions: [],
      systemParameters: { dParameter: { numPermissionedCandidates: 1, numRegisteredCandidates: 0 } },
    },
  };
}

const HEIGHTS = Array.from({ length: 10 }, (_, i) => 100 + i);
const TAPE: ArchiveTape = { network: "test", genesisHash: hashOf(0xabc), heights: HEIGHTS, blocks: HEIGHTS.map(block) };

const rpcBody = (method: string, params: unknown[] = []): string => JSON.stringify({ jsonrpc: "2.0", id: 7, method, params });
const graphqlBody = (query: string, variables?: Record<string, unknown>): string => JSON.stringify({ query, variables });

function clients(t: ReturnType<typeof createTapeFetch>): { node: NodeRpcClient; indexer: IndexerClient } {
  return {
    node: new NodeRpcClient({ url: t.nodeUrl, fetchImpl: t.fetchImpl }),
    indexer: new IndexerClient({ url: t.indexerUrl, fetchImpl: t.fetchImpl }),
  };
}

describe("tape replay", () => {
  it("[[archive.tape-replay.advancing-tip]] the reported finalized height rises with the injected clock (by blocks every everyMs, up to until), moves by hand, and node and indexer report the same height", async () => {
    let clock = 0;
    const t = createTapeFetch(TAPE, { finalizedHeight: 102, advance: { everyMs: 1000, by: 2, until: 107 }, now: () => clock });
    const { node, indexer } = clients(t);
    const reported = async (): Promise<[number, number]> => [await node.getHeightOf(await node.getFinalizedHead()), await indexer.getTipHeight()];

    expect(await reported()).toEqual([102, 102]);
    clock = 999;
    expect(await reported()).toEqual([102, 102]);
    clock = 1000;
    expect(await reported()).toEqual([104, 104]);
    clock = 2500;
    expect(await reported()).toEqual([106, 106]);
    clock = 3000;
    expect(await reported()).toEqual([107, 107]); // capped at until
    clock = 60_000;
    expect(t.finalizedHeight()).toBe(107);

    // By hand: set restarts the clock; a step raises by n, never past until.
    t.setFinalizedHeight(103);
    expect(t.finalizedHeight()).toBe(103);
    clock = 61_000;
    expect(await reported()).toEqual([105, 105]);
    expect(t.advanceFinalizedHeight()).toBe(106);
    expect(t.advanceFinalizedHeight(5)).toBe(107);
    expect(t.advanceFinalizedHeight()).toBe(107);
    expect(t.advanceFinalizedHeight(0)).toBe(107);

    // Without an advance the height stays put; a step stops at the tape's highest height; a height set by hand
    // outside the tape is reported as set, and the node then answers 500.
    const fixed = createTapeReplay(TAPE, { now: () => clock });
    expect(fixed.finalizedHeight()).toBe(109);
    clock += 1_000_000;
    expect(fixed.finalizedHeight()).toBe(109);
    fixed.setFinalizedHeight(100);
    expect(fixed.advanceFinalizedHeight(3)).toBe(103);
    expect(fixed.advanceFinalizedHeight(50)).toBe(109);
    const beyond = createTapeFetch(TAPE);
    beyond.setFinalizedHeight(120);
    expect(beyond.advanceFinalizedHeight()).toBe(120);
    const err = await clients(beyond).node.getFinalizedHead().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRpcError);
    expect((err as NodeRpcError).httpStatus).toBe(500);
    expect(await clients(beyond).indexer.getTipHeight()).toBe(120);

    // The default clock is Date.now.
    const wall = createTapeReplay(TAPE, { finalizedHeight: 100, advance: { everyMs: 20 } });
    await new Promise((r) => setTimeout(r, 70));
    expect(wall.finalizedHeight()).toBeGreaterThanOrEqual(102);

    for (const advance of [{ everyMs: 0 }, { everyMs: Number.NaN }, { everyMs: 10, by: 0 }, { everyMs: 10, by: 1.5 }, { everyMs: 10, until: 1.5 }]) {
      expect(() => createTapeReplay(TAPE, { advance }), JSON.stringify(advance)).toThrow(RangeError);
    }
    expect(() => fixed.advanceFinalizedHeight(-1)).toThrow(RangeError);
    expect(() => fixed.advanceFinalizedHeight(0.5)).toThrow(RangeError);
  });

  it("answers the archive sync's JSON-RPC and GraphQL calls from the tape, counts every request, and serves throttles, overrides and recorded contractEvents in order", async () => {
    const override = { ...block(105).indexerBlock, transactions: [{ __typename: "RegularTransaction", hash: "aa", protocolVersion: 1, raw: "bb" }] };
    const r = createTapeReplay(TAPE, {
      indexerOverrides: new Map([[105, override]]),
      throttles: [
        { operation: "chain_getBlock", times: 2, status: 429, retryAfter: "3" },
        { operation: "indexer.tip", times: 1, status: 200, htmlBody: true },
        { operation: "indexer.block", times: 1, status: 503 },
      ],
      contractEvents: [{ contractAddress: "c0ffee", txHash: "beef", events: [1, 2, 3, 4, 5] }],
    });
    const json = async (target: string, body: string): Promise<[number, unknown, Record<string, string>]> => {
      const a = await r.answer(target, body);
      return [a.status, a.headers["content-type"] === "application/json" ? JSON.parse(a.body) : a.body, a.headers];
    };

    expect(await json("/rpc", rpcBody("chain_getBlockHash", [104]))).toEqual([200, { jsonrpc: "2.0", id: 7, result: hashOf(104) }, { "content-type": "application/json" }]);
    expect((await json("/rpc", rpcBody("chain_getBlockHash", [0])))[1]).toMatchObject({ result: hashOf(0xabc) });
    expect((await json("/rpc", rpcBody("chain_getBlockHash", [99])))[1]).toMatchObject({ result: null });
    expect((await json("/rpc", rpcBody("chain_getHeader", [hashOf(103).toUpperCase().replace("0X", "")])))[1])
      .toMatchObject({ result: TAPE.blocks[3]!.nodeBlock.block.header });
    expect(await json("/rpc", rpcBody("chain_getBlock", [hashOf(103)]))).toEqual([429, { error: "throttled" }, { "content-type": "application/json", "retry-after": "3" }]);
    expect((await json("/rpc", rpcBody("chain_getBlock", [hashOf(103)])))[0]).toBe(429);
    expect((await json("/rpc", rpcBody("chain_getBlock", [hashOf(103)])))[1]).toMatchObject({ result: TAPE.blocks[3]!.nodeBlock });
    expect((await json("/rpc", rpcBody("chain_getBlock", [hashOf(1)])))[1]).toMatchObject({ result: null });
    expect(await json("/rpc", rpcBody("state_getStorage"))).toEqual([500, { error: "tape replay: unsupported JSON-RPC method state_getStorage" }, { "content-type": "application/json" }]);

    expect(await json("/graphql", graphqlBody("{ block { height } }"))).toEqual([200, "<html><body>502 Bad Gateway</body></html>", { "content-type": "text/html" }]);
    expect((await json("/graphql", graphqlBody("{ block { height } }")))[1]).toEqual({ data: { block: { height: 109 } } });
    expect((await json("/graphql", graphqlBody("q", { height: 104 })))[0]).toBe(503);
    expect((await json("/graphql", graphqlBody("q", { height: 104 })))[1]).toEqual({ data: { block: TAPE.blocks[4]!.indexerBlock } });
    expect((await json("/graphql", graphqlBody("q", { height: 105 })))[1]).toEqual({ data: { block: override } });
    expect((await json("/graphql", graphqlBody("q", { height: 200 })))[1]).toEqual({ data: { block: null } });
    const events = async (variables: Record<string, unknown>): Promise<unknown> =>
      (await json("/graphql", graphqlBody("query { contractEvents(...) }", variables)))[1];
    expect(await events({ filter: { contractAddress: "0xC0FFEE", transactionHash: "BEEF" }, limit: 2, offset: 1 })).toEqual({ data: { contractEvents: [2, 3] } });
    expect(await events({ filter: { contractAddress: "c0ffee", transactionHash: "beef" } })).toEqual({ data: { contractEvents: [1, 2, 3, 4, 5] } });
    expect(await events({ filter: { contractAddress: "c0ffee", transactionHash: "dead" } })).toEqual({ data: { contractEvents: [] } });

    expect(await json("/other", rpcBody("chain_getBlockHash", [104]))).toEqual([404, { error: "not found" }, { "content-type": "application/json" }]);
    expect((await json("/rpc", "not json"))[0]).toBe(500);
    expect((await json("/rpc", "null"))[0]).toBe(500);

    expect(Object.fromEntries(r.counts)).toEqual({
      chain_getBlockHash: 3, chain_getHeader: 1, chain_getBlock: 4, state_getStorage: 1,
      "indexer.tip": 2, "indexer.block": 4, "indexer.contractEvents": 3,
    });
  });

  it("the fetch-shaped function answers its origin only, accepts a URL, a Request or a string, gives HEAD no body, and honours the request's signal (also during the response delay)", async () => {
    const t = createTapeFetch(TAPE, { delayMs: 200 });
    expect(t.nodeUrl).toBe(`${DEFAULT_TAPE_ORIGIN}/rpc`);
    expect(t.indexerUrl).toBe(`${DEFAULT_TAPE_ORIGIN}/graphql`);
    const post = (body: string, signal?: AbortSignal): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body, ...(signal === undefined ? {} : { signal }) });

    const viaString = await t.fetchImpl(t.nodeUrl, post(rpcBody("chain_getBlockHash", [101])));
    expect(viaString.status).toBe(200);
    expect(viaString.headers.get("content-type")).toBe("application/json");
    expect(await viaString.json()).toEqual({ jsonrpc: "2.0", id: 7, result: hashOf(101) });
    const viaUrl = await t.fetchImpl(new URL(t.indexerUrl), post(graphqlBody("{ block { height } }")));
    expect(await viaUrl.json()).toEqual({ data: { block: { height: 109 } } });
    const viaRequest = await t.fetchImpl(new Request(t.indexerUrl, post(graphqlBody("q", { height: 100 }))));
    expect(await viaRequest.json()).toEqual({ data: { block: TAPE.blocks[0]!.indexerBlock } });
    const head = await t.fetchImpl(`${DEFAULT_TAPE_ORIGIN}/elsewhere`, { method: "HEAD" });
    expect(head.status).toBe(500); // the empty body is not JSON
    expect(await head.text()).toBe("");
    const missing = await t.fetchImpl(`${DEFAULT_TAPE_ORIGIN}/elsewhere`, post("{}"));
    expect(missing.status).toBe(404);

    await expect(t.fetchImpl("http://127.0.0.1:9/rpc", post(rpcBody("chain_getBlockHash", [101])))).rejects.toBeInstanceOf(TypeError);
    const custom = createTapeFetch(TAPE, { origin: "https://replay.invalid:8443/ignored/path" });
    expect(custom.nodeUrl).toBe("https://replay.invalid:8443/rpc");
    await expect(custom.fetchImpl(`${DEFAULT_TAPE_ORIGIN}/rpc`, post(rpcBody("chain_getBlockHash", [101])))).rejects.toThrow(/answers https:\/\/replay\.invalid:8443 only/);

    // An abort during the delay rejects with the signal's reason; an already aborted request is not answered or counted.
    const before = t.counts.get("chain_getBlockHash");
    const controller = new AbortController();
    const pending = t.fetchImpl(t.nodeUrl, post(rpcBody("chain_getBlockHash", [101]), controller.signal));
    setTimeout(() => controller.abort(new Error("stop")), 20);
    await expect(pending).rejects.toThrow("stop");
    await expect(t.fetchImpl(t.nodeUrl, post(rpcBody("chain_getBlockHash", [101]), AbortSignal.timeout(10)))).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(t.fetchImpl(t.nodeUrl, post(rpcBody("chain_getBlockHash", [101]), AbortSignal.abort(new Error("gone"))))).rejects.toThrow("gone");
    expect(t.counts.get("chain_getBlockHash")).toBe(before);

    // The clients' own timeout reaches the delay too.
    const slow = createTapeFetch(TAPE, { delayMs: 5_000 });
    const started = Date.now();
    const timedOut = await new NodeRpcClient({ url: slow.nodeUrl, fetchImpl: slow.fetchImpl, timeoutMs: 50 }).getFinalizedHead().catch((e: unknown) => e);
    expect(timedOut).toBeInstanceOf(NodeRpcError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
