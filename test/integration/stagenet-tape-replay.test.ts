import { afterAll, describe, expect, it } from "vitest";
import { createTapeFetch, type TapeReplayOptions } from "../../chain-archive-sync/tape-replay.js";
import { type FakeChain, fakeChainFetch, startFakeChain } from "./fixtures/stagenet-archive/fake-chain-server.js";
import { loadContractEvents, loadRangeTape } from "./fixtures/stagenet-archive/stagenet-fixtures.js";

/**
 * The `node:http` fake chain is a thin carrier of the runtime-neutral tape replay: for the same tape and options, every
 * request answered over real HTTP, through the `fetch`-shaped replay and through the fake chain's own `fetch` transport
 * gets the same status, the same `content-type` and `retry-after` headers and the same body text, including throttled,
 * failed and unknown requests and a finalized height moved by hand. No database.
 */

const noPrefix = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);

describe("tape replay over HTTP and through fetchImpl", () => {
  const servers: FakeChain[] = [];
  afterAll(async () => {
    for (const s of servers) await s.close();
  });

  it("[[archive.tape-replay.same-answers-as-http]] the node:http fake chain and the fetch-shaped replay (and the fake chain's fetch transport) give identical answers (status, content-type, retry-after, body) to every request of the archive sync, the throttles and the error cases", async () => {
    const tape = loadRangeTape("u1");
    const pairs = loadContractEvents().pairs;
    const options = (): TapeReplayOptions => ({
      throttles: [
        { operation: "chain_getBlock", times: 2, status: 429, retryAfter: "2" },
        { operation: "chain_getFinalizedHead", times: 1, status: 503 },
        { operation: "indexer.block", times: 1, status: 403 },
        { operation: "indexer.tip", times: 1, status: 200, htmlBody: true },
        { operation: "indexer.contractEvents", times: 1, status: 502, retryAfter: "1" },
      ],
      contractEvents: pairs,
      indexerOverrides: new Map([[715410, { ...tape.blocks[8]!.indexerBlock, transactions: [] }]]),
    });
    const http = await startFakeChain(tape, options());
    servers.push(http);
    const direct = createTapeFetch(tape, options());
    const transport = fakeChainFetch(tape, options());

    const rpc = (method: string, params: unknown[] = []): [string, string] => ["/rpc", JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })];
    const gql = (query: string, variables?: Record<string, unknown>): [string, string] => ["/graphql", JSON.stringify({ query, variables })];
    const requests: [string, string][] = [
      rpc("chain_getFinalizedHead"), rpc("chain_getFinalizedHead"), rpc("chain_getBlockHash", [0]), rpc("chain_getBlockHash", [1]),
      gql("{ block { height } }"), gql("{ block { height } }"),
    ];
    for (const b of tape.blocks) {
      requests.push(rpc("chain_getBlockHash", [b.height]), rpc("chain_getHeader", [b.blockHash]), rpc("chain_getBlock", [b.blockHash]),
        rpc("chain_getBlock", [noPrefix(b.blockHash).toUpperCase()]), gql("query($height: Int!) { block(offset: { height: $height }) { hash } }", { height: b.height }));
    }
    for (const p of pairs) {
      const filter = { contractAddress: p.contractAddress, transactionHash: `0x${p.txHash}` };
      requests.push(gql("query { contractEvents }", { filter }), gql("query { contractEvents }", { filter, limit: 1, offset: 1 }));
    }
    requests.push(
      rpc("chain_getBlock", ["0xdead"]), rpc("chain_getBlockHash", [714000]), rpc("state_getMetadata"),
      gql("query { contractEvents }", { filter: { contractAddress: "00", transactionHash: "00" } }), gql("q", { height: 1 }),
      ["/rpc", "not json"], ["/graphql", "null"], ["/rpc", "{}"], ["/other", "{}"], ["/rpc?x=1", rpc("chain_getBlockHash", [715402])[1]],
    );

    let compared = 0;
    const compare = async ([target, body]: [string, string]): Promise<void> => {
      const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body };
      const viaHttp = await fetch(`${new URL(http.nodeUrl).origin}${target}`, init);
      const viaFetch = await direct.fetchImpl(`${new URL(direct.nodeUrl).origin}${target}`, init);
      const viaTransport = await transport.fetch(`${new URL(transport.nodeUrl).origin}${target}`, init);
      const shape = async (r: Response) => ({
        status: r.status, type: r.headers.get("content-type"), retryAfter: r.headers.get("retry-after"), body: await r.text(),
      });
      const expected = await shape(viaHttp);
      expect(await shape(viaFetch), `${target} ${body}`).toEqual(expected);
      expect(await shape(viaTransport), `${target} ${body}`).toEqual(expected);
      compared++;
    };
    for (const r of requests) await compare(r);

    // A height moved by hand on both sides.
    for (const side of [http, direct, transport]) side.setFinalizedHeight(715410);
    for (const r of [rpc("chain_getFinalizedHead"), gql("{ block { height } }")]) await compare(r);
    for (const side of [http, direct, transport]) expect(side.advanceFinalizedHeight(30)).toBe(715433);
    for (const r of [rpc("chain_getFinalizedHead"), gql("{ block { height } }")]) await compare(r);
    for (const side of [http, direct, transport]) side.setFinalizedHeight(1);
    await compare(rpc("chain_getFinalizedHead"));

    expect(compared).toBe(requests.length + 5);
    expect(Object.fromEntries(direct.counts)).toEqual(Object.fromEntries(http.counts));
    expect(Object.fromEntries(transport.counts)).toEqual(Object.fromEntries(http.counts));
    expect(transport.nodeUrl).toBe("http://fake-chain.invalid/rpc");
    expect(direct.counts.get("chain_getBlock")).toBe(2 * tape.blocks.length + 1);
  }, 60_000);
});
