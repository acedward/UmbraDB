import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketProvider, id as ethersId } from "ethers";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { evmRpcMigrations } from "../../../src/postgres/migrations/evm_rpc/index.js";
import { createSubscribeServer, rowToRpcLog, type SubscribeServer } from "../subscribe.js";
import { startIngest, type IngestHandle } from "../ingest.js";
import { getLogs } from "../get-logs.js";
import { matchesFilter, parseSubscriptionFilter } from "../log-filter.js";
import { clearRegistry, registerMethod } from "../../registry-shim.js";
import { writeLogs, type SqlPool } from "../store.js";
import { defaultAddressMapper, toHex, type LogRow, type MidnightEvent } from "../event-map.js";
import { startFakeIndexer, type FakeIndexer } from "./fake-indexer.js";

/**
 * C-G4 verified with `ethers.WebSocketProvider` — a third-party client driving the hand-rolled
 * RFC 6455 server in `../ws.ts`. That interop is the point: a WS implementation that only its own
 * tests can talk to has proven nothing.
 *
 * The live `logs` tail is fed by the real ingester (fake indexer upstream, real Postgres
 * downstream), so this exercises the whole C-G2 -> C-G4 path rather than a hand-published row.
 */
describe("eth_subscribe (C-G4)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "evm_rpc";
  const CONTRACT = "11".repeat(32);
  const ALICE = "a1".repeat(32);
  const BOB = "b0".repeat(32);
  const TRANSFER_TOPIC = ethersId("Transfer(address,address,uint256)");

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: evmRpcMigrations });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  const open: Array<{
    server?: SubscribeServer;
    provider?: WebSocketProvider;
    ingest?: IngestHandle;
    indexer?: FakeIndexer;
  }> = [];

  afterEach(async () => {
    for (const item of open.splice(0)) {
      item.ingest?.stop();
      await item.ingest?.done.catch(() => {});
      // Tear the provider down in this exact order, then WAIT. `removeAllListeners()` only *starts*
      // an eth_unsubscribe per subscriber; `destroy()` cancels anything still in flight as a
      // rejected promise nobody awaits, which vitest (correctly) reports as an unhandled rejection
      // for the whole file. Letting the round-trips land first leaves nothing to cancel.
      if (item.provider !== undefined) {
        await item.provider.removeAllListeners();
        await new Promise((resolve) => setTimeout(resolve, 150));
        item.provider.destroy();
      }
      await item.indexer?.close();
      await item.server?.close();
    }
    clearRegistry();
    await sql`TRUNCATE ${sql(schema)}.logs, ${sql(schema)}.log_cursors`;
    await sql`TRUNCATE ${sql(schema)}.address_map CASCADE`;
  });

  let nextId = 1;
  const transferPair = (txId: number, height: number, amount: string): [MidnightEvent, MidnightEvent] => {
    const txHash = txId.toString(16).padStart(2, "0").repeat(32);
    const transaction = {
      hash: txHash,
      block: { height, hash: "bb".repeat(32), transactions: [{ hash: txHash }] },
    };
    const common = {
      contractAddress: CONTRACT,
      transactionId: txId,
      transaction,
      domainSep: "d5".repeat(32),
      tokenType: "77".repeat(32),
      amount,
    };
    return [
      { __typename: "UnshieldedSpendEvent", id: nextId++, ...common, sender: { kind: "USER", userAddress: ALICE, contractAddress: null } },
      { __typename: "UnshieldedReceiveEvent", id: nextId++, ...common, recipient: { kind: "USER", userAddress: BOB, contractAddress: null } },
    ];
  };

  /**
   * Starts the WS server plus the ingester feeding it, and an `ethers.WebSocketProvider` pointed at
   * it. `eth_chainId` is registered on the registry as a STUB: it is Part B's method, and ethers
   * calls it during network detection.
   */
  async function harness(): Promise<{
    indexer: FakeIndexer;
    provider: WebSocketProvider;
    server: SubscribeServer;
    wsUrl: string;
  }> {
    registerMethod("eth_chainId", () => "0x539"); // 1337
    const server = createSubscribeServer({ port: 0, sql, schema, blockPollMs: 100 });
    const port = await server.listen();
    const indexer = await startFakeIndexer();
    const ingest = startIngest({
      sql: sql as unknown as SqlPool,
      schema,
      indexerWs: indexer.url,
      contracts: [{ address: CONTRACT, profile: "erc20" }],
      idleFlushMs: 100,
      onCommitted: (rows) => server.publishLogs(rows),
      onError: () => {},
    });
    const provider = new WebSocketProvider(`ws://127.0.0.1:${port}`, undefined, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    open.push({ server, provider, ingest, indexer });
    return { indexer, provider, server, wsUrl: `ws://127.0.0.1:${port}` };
  }

  // --- interop --------------------------------------------------------------------------------

  it("ethers.WebSocketProvider completes a JSON-RPC call over the hand-rolled WS server", async () => {
    const { provider } = await harness();
    // Proves the RFC 6455 handshake, framing and masking all work against a real client.
    expect(await provider.send("eth_chainId", [])).toBe("0x539");
  }, 60_000);

  it("delivers a live Transfer log to an ethers subscriber, then stops after unsubscribe", async () => {
    const { indexer, provider } = await harness();

    const received: unknown[] = [];
    const filter = { topics: [TRANSFER_TOPIC] };
    const listener = (log: unknown): void => {
      received.push(log);
    };
    await provider.on(filter, listener);

    indexer.emit(...transferPair(1, 100, "1000"));
    const deadline = Date.now() + 30_000;
    while (received.length === 0) {
      if (Date.now() > deadline) throw new Error("no log delivered to the ethers subscriber");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const log = received[0] as { topics: string[]; data: string; address: string };
    expect(log.topics[0]).toBe(TRANSFER_TOPIC);
    expect(BigInt(log.data)).toBe(1000n);
    expect(log.address.toLowerCase()).toBe(
      `0x${toHex(defaultAddressMapper({ kind: "contract", hex: CONTRACT }))}`,
    );

    // --- unsubscribe: no further logs arrive ---
    await provider.off(filter, listener);
    const countAtUnsubscribe = received.length;
    indexer.emit(...transferPair(2, 101, "2000"));
    // Wait long enough that a still-live subscription would certainly have delivered.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(received.length).toBe(countAtUnsubscribe);
  }, 90_000);

  it("delivers newHeads to an ethers subscriber", async () => {
    const { indexer, provider } = await harness();
    const heads: unknown[] = [];
    const listener = (blockNumber: number): void => {
      heads.push(blockNumber);
    };
    await provider.on("block", listener);

    indexer.emit(...transferPair(3, 250, "5"));
    const deadline = Date.now() + 30_000;
    while (heads.length === 0) {
      if (Date.now() > deadline) throw new Error("no newHeads delivered");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(heads[0]).toBe(250);
    await provider.off("block", listener);
  }, 90_000);

  // --- filter semantics ------------------------------------------------------------------------

  it("honours the address and topic filter on a live subscription", async () => {
    const { indexer, provider } = await harness();
    const matching: unknown[] = [];
    const nonMatching: unknown[] = [];
    // An address that never emits: must receive nothing.
    await provider.on({ address: `0x${"99".repeat(20)}` }, (log: unknown) => nonMatching.push(log));
    await provider.on({ topics: [TRANSFER_TOPIC] }, (log: unknown) => matching.push(log));

    indexer.emit(...transferPair(4, 300, "42"));
    const deadline = Date.now() + 30_000;
    while (matching.length === 0) {
      if (Date.now() > deadline) throw new Error("no matching log delivered");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(nonMatching).toHaveLength(0);
  }, 90_000);

  it("rejects an unsupported subscription type and reports false for an unknown unsubscribe id", async () => {
    const { provider } = await harness();
    await expect(provider.send("eth_subscribe", ["syncing"])).rejects.toThrow();
    expect(await provider.send("eth_unsubscribe", ["0xdead"])).toBe(false);
  }, 60_000);

  it("drops a socket's subscriptions when it closes", async () => {
    // A RAW client rather than ethers here: `provider.destroy()` cancels its own in-flight
    // eth_unsubscribe as an unhandled rejection, which would be test noise obscuring the thing
    // under test — that the SERVER cleans up when a socket dies without unsubscribing first.
    const { server, wsUrl } = await harness();
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("raw socket failed to open")));
    });
    const subscribed = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String((event as MessageEvent).data)) as { id?: number; result?: unknown };
        if (message.id === 1 && typeof message.result === "string") resolve();
      });
    });
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", {}] }),
    );
    await subscribed;
    expect(server.subscriptionCount).toBe(1);

    socket.close();
    const deadline = Date.now() + 15_000;
    while (server.subscriptionCount > 0) {
      if (Date.now() > deadline) throw new Error("subscriptions were not dropped on socket close");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 60_000);

  // --- anti-divergence: the JS matcher vs the SQL path -----------------------------------------

  it("matches identically to eth_getLogs' SQL predicate over the same rows and filters", async () => {
    // The whole reason `log-filter.ts` exists: if these two disagree, `eth_getLogs` and
    // `eth_subscribe("logs")` mean different things by the same filter.
    const TOKEN = { kind: "contract" as const, hex: CONTRACT };
    const other = { kind: "contract" as const, hex: "22".repeat(32) };
    const b = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
    const A32 = `${"00".repeat(12)}${"a1".repeat(20)}`;
    const B32 = `${"00".repeat(12)}${"b0".repeat(20)}`;
    const T0 = TRANSFER_TOPIC.slice(2);
    const T0B = "ee".repeat(32);

    const rows: LogRow[] = [
      { address: defaultAddressMapper(TOKEN), blockNumber: 1, blockHash: b("bb".repeat(32)), txHash: b("01".repeat(32)), txIndex: 0, logIndex: 0, topics: [b(T0), b(A32), b(B32)], data: new Uint8Array(0), sourceEventId: 1, removed: false },
      { address: defaultAddressMapper(TOKEN), blockNumber: 1, blockHash: b("bb".repeat(32)), txHash: b("01".repeat(32)), txIndex: 0, logIndex: 1, topics: [b(T0B), b(A32)], data: new Uint8Array(0), sourceEventId: 2, removed: false },
      { address: defaultAddressMapper(TOKEN), blockNumber: 2, blockHash: b("bc".repeat(32)), txHash: b("02".repeat(32)), txIndex: 0, logIndex: 0, topics: [b(T0)], data: new Uint8Array(0), sourceEventId: 3, removed: false },
    ];
    await writeLogs(sql as unknown as SqlPool, schema, rows, { contractIdentity: TOKEN });
    await writeLogs(
      sql as unknown as SqlPool,
      schema,
      [{ ...rows[0]!, address: defaultAddressMapper(other), sourceEventId: 4, txHash: b("03".repeat(32)) }],
      { contractIdentity: other },
    );

    const addrToken = `0x${toHex(defaultAddressMapper(TOKEN))}`;
    const filters: unknown[] = [
      {},
      { address: addrToken },
      { address: [addrToken, `0x${toHex(defaultAddressMapper(other))}`] },
      { address: `0x${"99".repeat(20)}` },
      { topics: [TRANSFER_TOPIC] },
      { topics: [`0x${T0B}`] },
      { topics: [[TRANSFER_TOPIC, `0x${T0B}`]] },
      { topics: [null, `0x${A32}`] },
      { topics: [TRANSFER_TOPIC, null] },
      { topics: [TRANSFER_TOPIC, `0x${A32}`, `0x${B32}`] },
      { address: addrToken, topics: [TRANSFER_TOPIC, null] },
    ];

    for (const filter of filters) {
      const viaSql = await getLogs({ sql, schema }, [{ ...(filter as object), fromBlock: "earliest" }]);
      const parsed = parseSubscriptionFilter(filter);
      const viaMatcher = rows
        .concat([{ ...rows[0]!, address: defaultAddressMapper(other), sourceEventId: 4, txHash: b("03".repeat(32)) }])
        .map(rowToRpcLog)
        .filter((log) => matchesFilter(log, parsed));

      const key = (l: { address: string; logIndex: string; blockNumber: string; transactionHash: string }) =>
        `${l.address}|${l.blockNumber}|${l.transactionHash}|${l.logIndex}`;
      expect(
        viaMatcher.map(key).sort(),
        `filter ${JSON.stringify(filter)} disagreed between SQL and the in-memory matcher`,
      ).toEqual(viaSql.map(key).sort());
    }
  }, 120_000);
});
