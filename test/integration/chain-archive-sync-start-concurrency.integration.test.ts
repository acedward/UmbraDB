import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService, isRetryableEndpointError } from "../../chain-archive-sync/sync-service.js";
import { IndexerClientError } from "../../chain-archive-sync/indexer-client.js";
import { NodeRpcError } from "../../chain-archive-sync/node-rpc-client.js";
import type { Hex32 } from "../../src/interfaces/chain-archive-store.js";

/**
 * Project 00020, spec FR-015 (`START_HEIGHT`) and FR-016 (`SYNC_CONCURRENCY` + endpoint back-off),
 * implemented as sub-plan `00020-01` tasks 2.4-2.6 and pulled forward into master Phase 0.2.
 *
 * Real Postgres (testcontainers) plus a fully-controllable fake node RPC / indexer GraphQL -- the
 * same harness shape as `chain-archive-sync-retry.integration.test.ts`, kept in its own file so
 * that suite's own scenarios stay untouched. Nothing here needs a live chain.
 *
 * What each group proves:
 * - **START_HEIGHT**: a first run starts where it is told (a height, or the finalized head), and a
 *   configured value is IGNORED once a watermark exists -- the property FR-015 rests on, because a
 *   stale value in a service manager's environment must never rewind or fork a running archive.
 * - **SYNC_CONCURRENCY**: concurrency 8 archives byte-identical rows and the same watermark as
 *   concurrency 1, and a failure inside a window still commits everything below it in height order.
 * - **Back-off**: a 429 burst is absorbed without operator action and counted; a GraphQL protocol
 *   error is NOT retried.
 */

const NET = "start_concurrency_test_net";

function hx(n: number, tag: number): Hex32 {
  return (tag.toString(16).padStart(2, "0") + n.toString(16)).padStart(64, "0");
}

interface FakeChainBlock {
  height: number;
  hash: Hex32;
  parentHash: Hex32;
  stateRoot: Hex32;
  extrinsicsRoot: Hex32;
  extrinsics: string[];
  txHashes: Hex32[];
  txRawHex: string[];
  dParameter: { numPermissionedCandidates: number; numRegisteredCandidates: number };
}

/** Heights 0..count-1, one transaction each; the node extrinsic CONTAINS the indexer's reported
 *  raw bytes, matching the real node/indexer byte relationship the sync cross-checks. */
function fakeChain(count: number): FakeChainBlock[] {
  return Array.from({ length: count }, (_unused, height) => {
    const txRaw = Buffer.from(`tx-raw-${height}`, "utf8").toString("hex");
    return {
      height,
      hash: hx(height, 0xa),
      parentHash: height === 0 ? hx(0, 0x00) : hx(height - 1, 0xa),
      stateRoot: hx(height, 0xb),
      extrinsicsRoot: hx(height, 0xc),
      extrinsics: [txRaw],
      txHashes: [hx(height, 0xd)],
      txRawHex: [txRaw],
      dParameter: { numPermissionedCandidates: 1, numRegisteredCandidates: 2 },
    };
  });
}

function nodeFetch(blocks: FakeChainBlock[], finalizedHeight: number): typeof fetch {
  return async (_url, init) => {
    const { id, method, params } = JSON.parse((init as RequestInit).body as string) as
      { id: number; method: string; params: unknown[] };
    const headerOf = (blk: FakeChainBlock): unknown => ({
      parentHash: "0x" + blk.parentHash, number: "0x" + blk.height.toString(16),
      stateRoot: "0x" + blk.stateRoot, extrinsicsRoot: "0x" + blk.extrinsicsRoot, digest: { logs: [] },
    });
    let result: unknown;
    switch (method) {
      case "chain_getFinalizedHead":
        result = "0x" + blocks[finalizedHeight]!.hash;
        break;
      case "chain_getHeader":
        result = headerOf(blocks.find((b) => b.hash === (params[0] as string).replace(/^0x/, ""))!);
        break;
      case "chain_getBlockHash":
        result = "0x" + blocks[params[0] as number]!.hash;
        break;
      case "chain_getBlock": {
        const blk = blocks.find((b) => b.hash === (params[0] as string).replace(/^0x/, ""))!;
        result = { block: { header: headerOf(blk), extrinsics: blk.extrinsics.map((e) => "0x" + e) }, justifications: null };
        break;
      }
      default:
        throw new Error(`nodeFetch: unhandled method ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
  };
}

function indexerFetch(blocks: FakeChainBlock[], tipHeight?: number): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as { variables?: { height?: number } };
    const height = body.variables?.height;
    if (typeof height === "number") {
      const blk = blocks.find((b) => b.height === height);
      const data = {
        block: blk === undefined ? null : {
          hash: "0x" + blk.hash, height: blk.height,
          transactions: blk.txHashes.map((hash, i) => ({ hash: "0x" + hash, protocolVersion: 1, raw: blk.txRawHex[i] })),
          systemParameters: { dParameter: blk.dParameter },
        },
      };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: { block: { height: tipHeight ?? Math.max(...blocks.map((b) => b.height)) } },
    }), { status: 200 });
  };
}

/** Wraps a fake fetch so its first `count` calls answer with `status` (429 by default) -- the
 *  public endpoints' throttling shape, including a `Retry-After` header when asked for one. */
function throttleFirst(inner: typeof fetch, count: number, status = 429, retryAfterSeconds?: number): typeof fetch {
  let remaining = count;
  return async (url, init) => {
    if (remaining > 0) {
      remaining--;
      return new Response("rate limited", {
        status,
        headers: retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) },
      });
    }
    return inner(url, init);
  };
}

describe("chain-archive-sync START_HEIGHT / SYNC_CONCURRENCY / back-off (00020 FR-015, FR-016)", () => {
  let container: StartedPostgreSqlContainer;
  const openClients: UmbraDBSql[] = [];
  let schemaCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  }, 60_000);

  afterEach(async () => {
    while (openClients.length > 0) await openClients.pop()!.end({ timeout: 5 });
  });

  /** A fresh schema per service so one test's watermark never leaks into another's first run --
   *  which is the whole subject of the START_HEIGHT group. */
  async function newSchema(): Promise<{ sql: UmbraDBSql; schema: string }> {
    const schema = `start_conc_${schemaCounter++}`;
    const client = createClient({ connectionString: container.getConnectionUri(), schema });
    openClients.push(client);
    await bootstrapChainArchiveSchema(client, schema);
    return { sql: client, schema };
  }

  it("START_HEIGHT=<height> on an EMPTY archive archives that height first and never fetches anything below it (FR-015)", async () => {
    const blocks = fakeChain(6);
    const { sql: client, schema } = await newSchema();
    const service = new ChainArchiveSyncService({
      sql: client, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 5) },
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks) },
      startHeight: 3,
    });

    const result = await service.syncOnce({ maxBlocks: 10 });
    expect(result).toMatchObject({ ingestedBlocks: 3, fromHeight: 3, toHeight: 5, startHeightSource: "configured" });
    expect(await service.getSyncedHeight()).toBe(5);

    const heights = await client<{ height: string }[]>`
      SELECT height FROM ${client(schema)}.blocks WHERE net = ${NET} ORDER BY height`;
    expect(heights.map((r) => Number(r.height))).toEqual([3, 4, 5]);
    // FR-015 explicitly allows this: the first archived block's parent is NOT in the archive.
    const first = await service.store.getCanonicalBlockAtHeight(NET, 3);
    expect(first).toBeDefined();
    expect(await service.store.getCanonicalBlockAtHeight(NET, 2)).toBeUndefined();
  }, 120_000);

  it("START_HEIGHT=head on an EMPTY archive starts at the finalized head both sources can serve, not at genesis (FR-015)", async () => {
    const blocks = fakeChain(6);
    const { sql: client, schema } = await newSchema();
    const service = new ChainArchiveSyncService({
      sql: client, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 5) },
      // The node is finalized at 5 but the indexer has only reached 4: `head` must resolve to the
      // LOWER of the two, so the first archived block is one the indexer can serve transactions for.
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks, 4) },
      startHeight: "head",
    });

    const result = await service.syncOnce({ maxBlocks: 10 });
    expect(result).toMatchObject({ ingestedBlocks: 1, fromHeight: 4, toHeight: 4, targetTipHeight: 4, startHeightSource: "head" });
    expect(await service.getSyncedHeight()).toBe(4);
    const rows = await client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${client(schema)}.blocks WHERE net = ${NET}`;
    expect(rows[0]!.n).toBe(1);
  }, 120_000);

  it("START_HEIGHT is IGNORED once a watermark exists -- a stale value cannot rewind a running archive (FR-015)", async () => {
    const blocks = fakeChain(6);
    const { sql: client, schema } = await newSchema();
    const common = {
      sql: client, net: NET, schema,
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks) },
    };

    // First run: starts at 3 (empty archive), reaches 3 only.
    const first = new ChainArchiveSyncService({
      ...common, node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 3) }, startHeight: 3,
    });
    await first.syncOnce({ maxBlocks: 1 });
    expect(await first.getSyncedHeight()).toBe(3);

    // Second run, deliberately configured with a DIFFERENT (stale) start: the watermark wins.
    const second = new ChainArchiveSyncService({
      ...common, node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 5) }, startHeight: 0,
    });
    const result = await second.syncOnce({ maxBlocks: 10 });
    expect(result).toMatchObject({ ingestedBlocks: 2, fromHeight: 4, toHeight: 5, startHeightSource: "watermark" });

    const heights = await client<{ height: string }[]>`
      SELECT height FROM ${client(schema)}.blocks WHERE net = ${NET} ORDER BY height`;
    expect(heights.map((r) => Number(r.height))).toEqual([3, 4, 5]); // nothing below the original start
  }, 120_000);

  it("a service with no startHeight still starts at genesis (unchanged default)", async () => {
    const blocks = fakeChain(3);
    const { sql: client, schema } = await newSchema();
    const service = new ChainArchiveSyncService({
      sql: client, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 2) },
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks) },
    });
    const result = await service.syncOnce({ maxBlocks: 10 });
    expect(result).toMatchObject({ ingestedBlocks: 3, fromHeight: 0, startHeightSource: "genesis" });
  }, 120_000);

  it("a non-integer or negative startHeight is rejected at construction, not at the first batch", async () => {
    const { sql: client, schema } = await newSchema();
    const build = (startHeight: number): ChainArchiveSyncService => new ChainArchiveSyncService({
      sql: client, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(fakeChain(1), 0) },
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(fakeChain(1)) },
      startHeight,
    });
    expect(() => build(-1)).toThrow(RangeError);
    expect(() => build(1.5)).toThrow(RangeError);
  }, 120_000);

  it("SYNC_CONCURRENCY=8 archives exactly the same blocks, transactions and watermark as concurrency 1 (FR-016)", async () => {
    const blocks = fakeChain(20);
    const runWith = async (concurrency: number): Promise<{ rows: unknown[]; watermark: number | undefined; ingested: number; bridgeRows: number }> => {
      const { sql: client, schema } = await newSchema();
      const service = new ChainArchiveSyncService({
        sql: client, net: NET, schema,
        node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 19) },
        indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks) },
        concurrency,
      });
      const result = await service.syncOnce({ maxBlocks: 100 });
      const rows = await client<{ height: string; block_hash: Buffer; tx_hash: Buffer }[]>`
        SELECT b.height, b.block_hash, t.tx_hash
        FROM ${client(schema)}.blocks b JOIN ${client(schema)}.transactions t
          ON t.net = b.net AND t.block_height = b.height
        WHERE b.net = ${NET} ORDER BY b.height, t.position`;
      const bridge = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${client(schema)}.bridge_observations WHERE net = ${NET}`;
      return {
        rows: rows.map((r) => ({ height: Number(r.height), block: r.block_hash.toString("hex"), tx: r.tx_hash.toString("hex") })),
        watermark: await service.getSyncedHeight(),
        ingested: result.ingestedBlocks,
        bridgeRows: bridge[0]!.n,
      };
    };

    const sequential = await runWith(1);
    const concurrent = await runWith(8);
    expect(concurrent.ingested).toBe(20);
    expect(concurrent.watermark).toBe(sequential.watermark);
    expect(concurrent.rows).toEqual(sequential.rows);
    // Bridge observations are the order-sensitive part (the D-parameter dedup cursor compares
    // against the PREVIOUS height), so the concurrent run must produce the same single row.
    expect(concurrent.bridgeRows).toBe(sequential.bridgeRows);
    expect(concurrent.bridgeRows).toBe(1);
  }, 180_000);

  it("a fetch failure inside a concurrent window still commits every block below it, in height order, and names the committed range", async () => {
    const blocks = fakeChain(8);
    const { sql: client, schema } = await newSchema();
    // The indexer has not reached height 2 yet: heights 0 and 1 of the same window must still land.
    const service = new ChainArchiveSyncService({
      sql: client, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 7) },
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks.filter((b) => b.height < 2), 7) },
      concurrency: 4,
    });

    const error = await service.syncOnce({ maxBlocks: 8 }).catch((caught: unknown) => caught) as Error & {
      partialSync?: { ingestedBlocks: number; fromHeight: number; toHeight: number };
    };
    expect(error.message).toContain("indexer has not yet synced height 2");
    expect(error.partialSync).toEqual({ ingestedBlocks: 2, fromHeight: 0, toHeight: 1 });
    expect(await service.getSyncedHeight()).toBe(1);
    const heights = await client<{ height: string }[]>`
      SELECT height FROM ${client(schema)}.blocks WHERE net = ${NET} ORDER BY height`;
    expect(heights.map((r) => Number(r.height))).toEqual([0, 1]);
  }, 120_000);

  it("a 429 burst from both endpoints is absorbed by the back-off and the batch completes, with the waits counted and reported (FR-016)", async () => {
    const blocks = fakeChain(4);
    const { sql: client, schema } = await newSchema();
    const slept: number[] = [];
    const retried: { operation: string; httpStatus: number | undefined; throttled: boolean }[] = [];
    const service = new ChainArchiveSyncService({
      sql: client, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: throttleFirst(nodeFetch(blocks, 3), 2) },
      indexer: { url: "http://fake-indexer", fetchImpl: throttleFirst(indexerFetch(blocks), 1) },
      backoff: {
        baseDelayMs: 10, maxDelayMs: 40, maxAttempts: 5, jitter: false,
        sleep: async (ms) => { slept.push(ms); },
        onRetry: (info) => retried.push({ operation: info.operation, httpStatus: info.httpStatus, throttled: info.throttled }),
      },
    });

    const result = await service.syncOnce({ maxBlocks: 10 });
    expect(result.ingestedBlocks).toBe(4);
    expect(result.retries).toBe(3);   // 2 node calls + 1 indexer call were thrown back
    expect(result.throttled).toBe(3); // all three were 429s
    expect(retried.every((r) => r.httpStatus === 429 && r.throttled)).toBe(true);
    // `chain_getFinalizedHead` is thrown back twice in a row, so its own schedule doubles
    // (10 ms then 20 ms); the indexer's tip query is thrown back once (10 ms). No jitter here.
    expect(slept).toEqual([10, 20, 10]);
    expect(await service.getSyncedHeight()).toBe(3);
  }, 120_000);

  it("honours a Retry-After header when it asks for longer than the exponential schedule", async () => {
    const blocks = fakeChain(2);
    const { sql: client, schema } = await newSchema();
    const slept: number[] = [];
    const service = new ChainArchiveSyncService({
      sql: client, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: throttleFirst(nodeFetch(blocks, 1), 1, 429, 2) },
      indexer: { url: "http://fake-indexer", fetchImpl: indexerFetch(blocks) },
      backoff: { baseDelayMs: 10, maxDelayMs: 60_000, maxAttempts: 3, jitter: false, sleep: async (ms) => { slept.push(ms); } },
    });
    await service.syncOnce({ maxBlocks: 10 });
    expect(slept).toEqual([2000]); // the header's 2 s, not the schedule's 10 ms
  }, 120_000);

  it("a GraphQL protocol error is NOT retried -- it surfaces immediately for the caller's loop", async () => {
    const blocks = fakeChain(2);
    const { sql: client, schema } = await newSchema();
    const slept: number[] = [];
    const service = new ChainArchiveSyncService({
      sql: client, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: nodeFetch(blocks, 1) },
      indexer: {
        url: "http://fake-indexer",
        fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: "unknown field" }] }), { status: 200 }),
      },
      backoff: { baseDelayMs: 10, maxAttempts: 5, jitter: false, sleep: async (ms) => { slept.push(ms); } },
    });

    await expect(service.syncOnce({ maxBlocks: 1 })).rejects.toThrow("GraphQL error: unknown field");
    expect(slept).toEqual([]);
  }, 120_000);

  it("classifies endpoint errors the way FR-016 requires (429/403/5xx and transports retryable, protocol errors not)", () => {
    expect(isRetryableEndpointError(new IndexerClientError("throttled", undefined, 429)).retryable).toBe(true);
    expect(isRetryableEndpointError(new IndexerClientError("forbidden", undefined, 403)).retryable).toBe(true);
    expect(isRetryableEndpointError(new NodeRpcError("bad gateway", undefined, 502)).retryable).toBe(true);
    expect(isRetryableEndpointError(new NodeRpcError("transport", new Error("ECONNRESET"))).retryable).toBe(true);
    expect(isRetryableEndpointError(new NodeRpcError("RPC error -32000")).retryable).toBe(false);
    expect(isRetryableEndpointError(new IndexerClientError("GraphQL error: nope")).retryable).toBe(false);
    expect(isRetryableEndpointError(new NodeRpcError("not found", undefined, 404)).retryable).toBe(false);
    expect(isRetryableEndpointError(new Error("boom")).retryable).toBe(false);
  });
});
