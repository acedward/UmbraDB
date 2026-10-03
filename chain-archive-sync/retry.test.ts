import { describe, expect, it } from "vitest";
import { IndexerClientError, IndexerClientParseError } from "./indexer-client.js";
import { NodeRpcError, NodeRpcParseError } from "./node-rpc-client.js";
import { defaultMinIntervalMs, isPublicEndpoint, parseRetryAfterMs, RequestPacer } from "./polite-http.js";
import { classifyEndpointError, withRetry } from "./retry.js";
import { parseArchiveSyncArgs } from "./sync-cli.js";

/** Polite public-endpoint access: unit level, no network, no Postgres. */
describe("polite public-endpoint access", () => {
  it("classifies only throttling, outages, transport failures and non-JSON bodies as retryable", () => {
    const cases: [unknown, boolean, number | undefined][] = [
      [new NodeRpcError("x", undefined, 429, 2_000), true, 429],
      [new IndexerClientError("x", undefined, 403), true, 403],
      [new NodeRpcError("x", undefined, 502), true, 502],
      [new IndexerClientError("x", undefined, 404), false, 404],
      [new NodeRpcError("x", new Error("ECONNRESET")), true, undefined],
      [new NodeRpcError("chain_getBlock: RPC error -32000: bad"), false, undefined],
      [new IndexerClientError("GraphQL error: bad query"), false, undefined],
      [new NodeRpcParseError("x", "u", "m"), true, undefined],
      [new IndexerClientParseError("x", "u"), true, undefined],
      [new Error("indexer has not yet synced height 5 (node has); retry later"), false, undefined],
    ];
    for (const [error, retryable, httpStatus] of cases) {
      expect(classifyEndpointError(error)).toMatchObject({ retryable, httpStatus });
    }
    expect(classifyEndpointError(new NodeRpcError("x", undefined, 429, 2_000)).retryAfterMs).toBe(2_000);
  });

  it("retries with exponential back-off, honours Retry-After up to the ceiling, counts throttling, and rethrows after maxAttempts", async () => {
    const waits: number[] = [];
    const counters = { retries: 0, throttled: 0 };
    let calls = 0;
    const result = await withRetry("op", async () => {
      calls++;
      if (calls === 1) throw new NodeRpcError("x", undefined, 429, 30_000);
      if (calls === 2) throw new IndexerClientError("x", undefined, 503);
      if (calls === 3) throw new NodeRpcError("x", new Error("timeout"));
      return "ok";
    }, { jitter: false, baseDelayMs: 100, maxDelayMs: 10_000, sleep: async (ms) => { waits.push(ms); } }, counters);
    expect(result).toBe("ok");
    expect(waits).toEqual([10_000, 200, 400]); // Retry-After 30 s capped at maxDelayMs; then 2^n
    expect(counters).toEqual({ retries: 3, throttled: 1 });

    let attempts = 0;
    await expect(withRetry("op", async () => { attempts++; throw new IndexerClientError("x", undefined, 429); },
      { maxAttempts: 3, jitter: false, baseDelayMs: 1, sleep: async () => {} })).rejects.toBeInstanceOf(IndexerClientError);
    expect(attempts).toBe(3);

    let protocolAttempts = 0;
    await expect(withRetry("op", async () => { protocolAttempts++; throw new IndexerClientError("GraphQL error"); },
      { sleep: async () => {} })).rejects.toThrow("GraphQL error");
    expect(protocolAttempts).toBe(1);
  });

  it("parses Retry-After (delta seconds only) and paces request starts per endpoint", async () => {
    expect(parseRetryAfterMs("3")).toBe(3_000);
    expect(parseRetryAfterMs(" 0.5 ")).toBe(500);
    expect(parseRetryAfterMs("99999")).toBe(600_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined();
    expect(parseRetryAfterMs("-1")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();

    expect(isPublicEndpoint("https://rpc.stagenet.shielded.tools")).toBe(true);
    expect(isPublicEndpoint("https://indexer.preprod.midnight.network/api/v4/graphql")).toBe(true);
    expect(isPublicEndpoint("http://127.0.0.1:12345/rpc")).toBe(false);
    expect(isPublicEndpoint("https://shielded.tools.evil.example")).toBe(false);
    expect(defaultMinIntervalMs("https://rpc.stagenet.shielded.tools")).toBe(250);
    expect(defaultMinIntervalMs("http://localhost:9944")).toBe(0);

    let now = 1_000;
    const slept: number[] = [];
    const pacer = new RequestPacer(250, () => now, async (ms) => { slept.push(ms); });
    await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]); // three concurrent callers
    expect(slept).toEqual([250, 500]);
    now = 5_000; // long after the reserved slots: no wait
    await pacer.wait();
    expect(slept).toEqual([250, 500]);
    expect(() => new RequestPacer(-1)).toThrow(RangeError);
  });

  it("parses the CLI's --from/--to flags strictly", () => {
    expect(parseArchiveSyncArgs(["--from", "714485", "--to", "715183", "--concurrency", "4"]))
      .toEqual({ from: 714485, to: 715183, concurrency: 4 });
    expect(parseArchiveSyncArgs(["--max-blocks", "50", "--min-interval-ms", "0"])).toEqual({ maxBlocks: 50, minIntervalMs: 0 });
    expect(() => parseArchiveSyncArgs(["--from", "10", "--to", "9"])).toThrow(/below/);
    expect(() => parseArchiveSyncArgs(["--from=-1"])).toThrow(/non-negative/);
    expect(() => parseArchiveSyncArgs(["--from", "1e3"])).toThrow(/non-negative/);
    expect(() => parseArchiveSyncArgs(["--concurrency", "0"])).toThrow(/positive/);
    expect(() => parseArchiveSyncArgs(["--unknown"])).toThrow();
    expect(() => parseArchiveSyncArgs(["714485"])).toThrow();
  });
});
