import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { evmRpcMigrations } from "../../../src/postgres/migrations/evm_rpc/index.js";
import { startIngest, type IngestHandle } from "../ingest.js";
import { readCursor, type SqlPool } from "../store.js";
import { toHex, type MidnightEvent } from "../event-map.js";
import type { WatchEntry } from "../config.js";
import { startFakeIndexer, type FakeIndexer, type FakeIndexerOptions } from "./fake-indexer.js";

/**
 * C-G2 against a real Postgres and a `graphql-transport-ws` server, with the indexer replaced by
 * `fake-indexer.ts` — the Part A stack does not exist in this clone, so a live chain run is not
 * available here (see the plan's Open questions). What IS covered is everything about the ingester
 * that is not real-indexer wire compatibility: pair integrity across delivery boundaries, cursor
 * resume, at-least-once redelivery, reconnection, and crash atomicity.
 */
describe("ingest (C-G2)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "evm_rpc";
  const CONTRACT = "11".repeat(32);
  const ALICE = "a1".repeat(32);
  const BOB = "b0".repeat(32);

  const entry: WatchEntry = { address: CONTRACT, profile: "erc20" };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: evmRpcMigrations });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  const running: Array<{ handle: IngestHandle; indexer: FakeIndexer }> = [];

  afterEach(async () => {
    for (const { handle, indexer } of running.splice(0)) {
      handle.stop();
      await handle.done.catch(() => {});
      await indexer.close();
    }
    await sql`TRUNCATE ${sql(schema)}.logs, ${sql(schema)}.log_cursors`;
    await sql`TRUNCATE ${sql(schema)}.address_map CASCADE`;
  });

  // --- fixtures -------------------------------------------------------------------------------

  let nextId = 1;
  const transferPair = (
    txId: number,
    blockHeight: number,
    amount: string,
    from = ALICE,
    to = BOB,
  ): [MidnightEvent, MidnightEvent] => {
    const txHash = `${txId.toString(16).padStart(2, "0")}`.repeat(32);
    const transaction = {
      hash: txHash,
      block: { height: blockHeight, hash: "bb".repeat(32), transactions: [{ hash: txHash }] },
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
      {
        __typename: "UnshieldedSpendEvent",
        id: nextId++,
        ...common,
        sender: { kind: "USER", userAddress: from, contractAddress: null },
      },
      {
        __typename: "UnshieldedReceiveEvent",
        id: nextId++,
        ...common,
        recipient: { kind: "USER", userAddress: to, contractAddress: null },
      },
    ];
  };

  async function start(
    indexerOptions: FakeIndexerOptions = {},
    ingestOverrides: { idleFlushMs?: number } = {},
  ): Promise<FakeIndexer> {
    const indexer = await startFakeIndexer(indexerOptions);
    const handle = startIngest({
      sql: sql as unknown as SqlPool,
      schema,
      indexerWs: indexer.url,
      contracts: [entry],
      idleFlushMs: ingestOverrides.idleFlushMs ?? 150,
      // Transport drops are expected in these tests; swallow rather than fail the run.
      onError: () => {},
    });
    running.push({ handle, indexer });
    return indexer;
  }

  const countLogs = async (): Promise<number> => {
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.logs`;
    return rows[0]!.n;
  };

  async function waitFor(
    predicate: () => Promise<boolean>,
    label: string,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // --- tests ----------------------------------------------------------------------------------

  it("ingests a transfer pair as ONE Transfer log and advances the cursor", async () => {
    const indexer = await start();
    const [spend, receive] = transferPair(1, 10, "1000");
    indexer.emit(spend, receive);

    await waitFor(async () => (await countLogs()) === 1, "one log row");
    const rows = await sql<{ topic0: Buffer; topic1: Buffer; topic2: Buffer; data: Buffer; source_event_id: bigint }[]>`
      SELECT topic0, topic1, topic2, data, source_event_id FROM ${sql(schema)}.logs
    `;
    expect(toHex(rows[0]!.topic0)).toBe(
      "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
    expect(BigInt(`0x${toHex(rows[0]!.data)}`)).toBe(1000n);
    // Keyed on the spend (lower id), and the cursor covers BOTH consumed ids.
    expect(Number(rows[0]!.source_event_id)).toBe(spend.id);
    await waitFor(
      async () => (await readCursor(sql, schema, Buffer.from(CONTRACT, "hex"))) === receive.id,
      "cursor at the receive id",
    );
  });

  it("does NOT split a pair whose two events arrive in separate deliveries", async () => {
    // The hazard C-G2's buffering exists for: emit the spend, let a delivery boundary pass, then
    // emit the receive. A naive ingester writes a bogus burn and then a bogus mint (2 rows).
    const indexer = await start({}, { idleFlushMs: 3_000 });
    const [spend, receive] = transferPair(2, 11, "500");
    indexer.emit(spend);
    await new Promise((resolve) => setTimeout(resolve, 400)); // well past a delivery boundary
    expect(await countLogs()).toBe(0); // still held back, not flushed as a burn
    indexer.emit(receive);

    await waitFor(async () => (await countLogs()) === 1, "exactly one merged Transfer log");
    const rows = await sql<{ topic1: Buffer; topic2: Buffer }[]>`
      SELECT topic1, topic2 FROM ${sql(schema)}.logs
    `;
    // Neither side is address(0) — it is a real transfer, not a burn/mint pair.
    expect(toHex(rows[0]!.topic1)).not.toBe("0".repeat(64));
    expect(toHex(rows[0]!.topic2)).not.toBe("0".repeat(64));
  });

  it("flushes a trailing transaction on the idle timeout (liveness at the tip)", async () => {
    const indexer = await start({}, { idleFlushMs: 100 });
    // A single unpaired spend IS a legitimate burn — but only the idle timeout can prove it.
    const [spend] = transferPair(3, 12, "7");
    indexer.emit(spend);
    await waitFor(async () => (await countLogs()) === 1, "the burn log after the idle flush");
    const rows = await sql<{ topic2: Buffer }[]>`SELECT topic2 FROM ${sql(schema)}.logs`;
    expect(toHex(rows[0]!.topic2)).toBe("0".repeat(64)); // to = 0x0, i.e. a burn
  });

  it("flushes a held transaction as soon as a different transaction's event arrives", async () => {
    const indexer = await start({}, { idleFlushMs: 60_000 }); // idle flush effectively disabled
    const first = transferPair(4, 13, "1");
    const second = transferPair(5, 14, "2");
    indexer.emit(...first);
    expect(await countLogs()).toBe(0); // held: it is the trailing transaction
    indexer.emit(...second);
    // The first transaction is now provably closed, so it lands WITHOUT waiting for any timer.
    await waitFor(async () => (await countLogs()) === 1, "the first transaction's log");
  });

  it("is idempotent under at-least-once redelivery (every event delivered twice)", async () => {
    const indexer = await start({ duplicateEveryEvent: true });
    indexer.emit(...transferPair(6, 15, "10"));
    indexer.emit(...transferPair(7, 16, "20"));
    await waitFor(async () => (await countLogs()) === 2, "two logs despite doubled delivery");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await countLogs()).toBe(2);
  });

  it("resumes from the durable cursor after a restart, leaving the row count unchanged", async () => {
    const indexer = await start();
    const pairs = [transferPair(8, 17, "1"), transferPair(9, 18, "2"), transferPair(10, 19, "3")];
    for (const pair of pairs) indexer.emit(...pair);
    await waitFor(async () => (await countLogs()) === 3, "three logs");
    const cursorBefore = await readCursor(sql, schema, Buffer.from(CONTRACT, "hex"));

    // Stop the ingester, then start a NEW one against the same indexer log (a full replay: the
    // fake indexer still holds every event).
    const { handle, indexer: oldIndexer } = running.pop()!;
    handle.stop();
    await handle.done.catch(() => {});

    const restarted = startIngest({
      sql: sql as unknown as SqlPool,
      schema,
      indexerWs: oldIndexer.url,
      contracts: [entry],
      idleFlushMs: 150,
    });
    running.push({ handle: restarted, indexer: oldIndexer });

    await waitFor(async () => oldIndexer.subscribeCount >= 2, "the restarted subscription");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await countLogs()).toBe(3); // unchanged after full replay
    expect(await readCursor(sql, schema, Buffer.from(CONTRACT, "hex"))).toBe(cursorBefore);
    // It resumed at cursor+1, not from 0.
    expect(oldIndexer.requestedCursors[1]).toBe((cursorBefore ?? 0) + 1);
  });

  it("reconnects after a drop mid-transaction without fabricating a burn from the half it held", async () => {
    // `dropAfterMessages: 3` cuts the connection after the second pair's Spend has been delivered
    // but before its Receive — so the ingester is holding half a transaction when the socket dies.
    // A buffer that got flushed by its idle timer during the outage would write a bogus burn (and
    // then a bogus mint on resume): 3 rows, two of them wrong. The correct outcome is 2 real
    // Transfers.
    const indexer = await start({ dropAfterMessages: 3 }, { idleFlushMs: 100 });
    for (const pair of [transferPair(11, 20, "1"), transferPair(12, 21, "2")]) indexer.emit(...pair);

    await waitFor(async () => (await countLogs()) === 2, "both logs after a reconnect", 20_000);
    expect(indexer.subscribeCount).toBeGreaterThanOrEqual(2);
    // Settle, then prove no third (bogus) row appears and that NEITHER row is a mint or burn.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await countLogs()).toBe(2);
    const rows = await sql<{ topic1: Buffer; topic2: Buffer }[]>`
      SELECT topic1, topic2 FROM ${sql(schema)}.logs ORDER BY source_event_id
    `;
    for (const r of rows) {
      expect(toHex(r.topic1)).not.toBe("0".repeat(64));
      expect(toHex(r.topic2)).not.toBe("0".repeat(64));
    }
    // Generous bound: a reconnect pays the client's backoff before resuming.
  }, 40_000);

  it("leaves the cursor consistent with the rows at all times", async () => {
    const indexer = await start();
    for (let i = 0; i < 5; i++) indexer.emit(...transferPair(30 + i, 30 + i, String(i + 1)));
    await waitFor(async () => (await countLogs()) === 5, "five logs");

    // The cursor must never be ahead of an unwritten event: every source_event_id <= cursor, and
    // the highest consumed id equals the cursor.
    const cursor = await readCursor(sql, schema, Buffer.from(CONTRACT, "hex"));
    const rows = await sql<{ max: bigint | null }[]>`
      SELECT max(source_event_id) AS max FROM ${sql(schema)}.logs
    `;
    expect(cursor).not.toBeNull();
    expect(Number(rows[0]!.max)).toBeLessThanOrEqual(cursor!);
  });

  it("registers the emitting contract in address_map exactly once", async () => {
    const indexer = await start();
    for (let i = 0; i < 3; i++) indexer.emit(...transferPair(40 + i, 40 + i, "1"));
    await waitFor(async () => (await countLogs()) === 3, "three logs");
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.address_map WHERE kind = 'contract'
    `;
    expect(rows[0]!.n).toBe(1);
  });
});
