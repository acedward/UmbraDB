import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { evmRpcMigrations } from "../../../src/postgres/migrations/evm_rpc/index.js";
import { MAX_RESULTS, getLogs, registerGetLogs, type RpcLog } from "../get-logs.js";
import { clearRegistry, getMethod, JsonRpcError, registeredMethods } from "../../registry-shim.js";
import { writeLogs, type SqlPool } from "../store.js";
import { defaultAddressMapper, toHex, type LogRow } from "../event-map.js";

/**
 * C-G3 over seeded rows in real Postgres. Every filter axis, the combinations, the empty result
 * (which must be `[]` and never an error), the 10 000-row cap, and the blockHash-vs-range
 * validation.
 */
describe("eth_getLogs (C-G3)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "evm_rpc";

  const TOKEN_A = { kind: "contract" as const, hex: "11".repeat(32) };
  const TOKEN_B = { kind: "contract" as const, hex: "22".repeat(32) };
  const addrA = () => toHex(defaultAddressMapper(TOKEN_A));
  const addrB = () => toHex(defaultAddressMapper(TOKEN_B));

  const T_TRANSFER = "dd".repeat(32);
  const T_APPROVAL = "ee".repeat(32);
  const ALICE = `${"00".repeat(12)}${"a1".repeat(20)}`;
  const BOB = `${"00".repeat(12)}${"b0".repeat(20)}`;

  const b = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

  function row(overrides: Partial<LogRow> & { sourceEventId: number }): LogRow {
    return {
      address: defaultAddressMapper(TOKEN_A),
      blockNumber: 1,
      blockHash: b("bb".repeat(32)),
      txHash: b("e1".repeat(32)),
      txIndex: 0,
      logIndex: 0,
      topics: [b(T_TRANSFER)],
      data: new Uint8Array(0),
      removed: false,
      ...overrides,
    };
  }

  const call = (filter: unknown): Promise<RpcLog[]> => getLogs({ sql, schema }, [filter]);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: evmRpcMigrations });
    const pool = sql as unknown as SqlPool;

    // --- token A: blocks 10, 11, 12 ---
    await writeLogs(
      pool,
      schema,
      [
        // block 10: two logs in one tx (log_index 0, 1)
        row({ sourceEventId: 1, blockNumber: 10, blockHash: b("aa".repeat(32)), txHash: b("11".repeat(32)), txIndex: 0, logIndex: 0, topics: [b(T_TRANSFER), b(ALICE), b(BOB)], data: b(`${"00".repeat(31)}64`) }),
        row({ sourceEventId: 2, blockNumber: 10, blockHash: b("aa".repeat(32)), txHash: b("11".repeat(32)), txIndex: 0, logIndex: 1, topics: [b(T_APPROVAL), b(ALICE)] }),
        // block 11: a second tx, tx_index 1
        row({ sourceEventId: 3, blockNumber: 11, blockHash: b("ab".repeat(32)), txHash: b("12".repeat(32)), txIndex: 1, logIndex: 0, topics: [b(T_TRANSFER), b(BOB), b(ALICE)] }),
        // block 12: a single-topic log — exercises the geth "filter longer than log" length rule
        row({ sourceEventId: 4, blockNumber: 12, blockHash: b("ac".repeat(32)), txHash: b("13".repeat(32)), txIndex: 0, logIndex: 0, topics: [b(T_TRANSFER)] }),
      ],
      { contractIdentity: TOKEN_A },
    );

    // --- token B: block 11 ---
    await writeLogs(
      pool,
      schema,
      [
        row({
          sourceEventId: 5, blockNumber: 11, blockHash: b("ab".repeat(32)),
          txHash: b("14".repeat(32)), txIndex: 2, logIndex: 0,
          address: defaultAddressMapper(TOKEN_B), topics: [b(T_TRANSFER), b(ALICE), b(BOB)],
        }),
      ],
      { contractIdentity: TOKEN_B },
    );
  }, 180_000);

  afterAll(async () => {
    clearRegistry();
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  // --- shape ---------------------------------------------------------------------------------

  it("returns geth's log shape with minimal-form hex quantities", async () => {
    const logs = await call({ blockHash: `0x${"aa".repeat(32)}` });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toEqual({
      address: `0x${addrA()}`,
      topics: [`0x${T_TRANSFER}`, `0x${ALICE}`, `0x${BOB}`],
      data: `0x${"00".repeat(31)}64`,
      blockNumber: "0xa",
      blockHash: `0x${"aa".repeat(32)}`,
      transactionHash: `0x${"11".repeat(32)}`,
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    });
  });

  it("orders by (block, tx_index, log_index)", async () => {
    const logs = await call({ fromBlock: "earliest", toBlock: "latest" });
    expect(logs.map((l) => [l.blockNumber, l.transactionIndex, l.logIndex])).toEqual([
      ["0xa", "0x0", "0x0"],
      ["0xa", "0x0", "0x1"],
      ["0xb", "0x1", "0x0"],
      ["0xb", "0x2", "0x0"],
      ["0xc", "0x0", "0x0"],
    ]);
  });

  // --- address axis --------------------------------------------------------------------------

  it("filters by a single address, and by an array of addresses", async () => {
    const onlyA = await call({ address: `0x${addrA()}`, fromBlock: "earliest" });
    expect(onlyA).toHaveLength(4);
    expect(new Set(onlyA.map((l) => l.address))).toEqual(new Set([`0x${addrA()}`]));

    const both = await call({ address: [`0x${addrA()}`, `0x${addrB()}`], fromBlock: "earliest" });
    expect(both).toHaveLength(5);
  });

  it("treats an absent address as every watched contract", async () => {
    expect(await call({ fromBlock: "earliest" })).toHaveLength(5);
  });

  it("returns [] — not an error — for an address that never emitted, or an empty address array", async () => {
    expect(await call({ address: `0x${"99".repeat(20)}`, fromBlock: "earliest" })).toEqual([]);
    expect(await call({ address: [], fromBlock: "earliest" })).toEqual([]);
  });

  // --- topics axis ---------------------------------------------------------------------------

  it("filters by topic0", async () => {
    expect(await call({ topics: [`0x${T_APPROVAL}`], fromBlock: "earliest" })).toHaveLength(1);
    expect(await call({ topics: [`0x${T_TRANSFER}`], fromBlock: "earliest" })).toHaveLength(4);
  });

  it("treats a nested array as OR at that position", async () => {
    const logs = await call({ topics: [[`0x${T_TRANSFER}`, `0x${T_APPROVAL}`]], fromBlock: "earliest" });
    expect(logs).toHaveLength(5);
  });

  it("treats null as a wildcard over the VALUE at that position", async () => {
    // [null, ALICE] => any topic0, topic1 == ALICE. Matches block 10's Transfer and Approval.
    const logs = await call({ topics: [null, `0x${ALICE}`], fromBlock: "earliest" });
    expect(logs.map((l) => l.blockNumber)).toEqual(["0xa", "0xa", "0xb"]);
  });

  it("requires the log to HAVE as many topics as the filter (geth length rule)", async () => {
    // Block 12's log has ONLY topic0. A 2-position filter must exclude it even though position 1
    // is a null wildcard.
    const oneTopic = await call({ topics: [`0x${T_TRANSFER}`], fromBlock: "earliest" });
    expect(oneTopic.map((l) => l.blockNumber)).toContain("0xc");
    const twoTopics = await call({ topics: [`0x${T_TRANSFER}`, null], fromBlock: "earliest" });
    expect(twoTopics.map((l) => l.blockNumber)).not.toContain("0xc");
    expect(twoTopics).toHaveLength(3);
  });

  it("combines positions with AND", async () => {
    const logs = await call({
      topics: [`0x${T_TRANSFER}`, `0x${BOB}`, `0x${ALICE}`],
      fromBlock: "earliest",
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.blockNumber).toBe("0xb");
  });

  // --- block range axis ----------------------------------------------------------------------

  it("filters by a hex fromBlock/toBlock range", async () => {
    expect(await call({ fromBlock: "0xa", toBlock: "0xa" })).toHaveLength(2);
    expect(await call({ fromBlock: "0xb", toBlock: "0xc" })).toHaveLength(3);
  });

  it("resolves earliest and latest", async () => {
    expect(await call({ fromBlock: "earliest", toBlock: "earliest" })).toEqual([]);
    // `latest` with no explicit fromBlock defaults fromBlock to latest too — the tip block only.
    const latest = await call({});
    expect(latest.map((l) => l.blockNumber)).toEqual(["0xc"]);
  });

  it("accepts pending/safe/finalized as aliases of latest", async () => {
    for (const tag of ["pending", "safe", "finalized"]) {
      expect(await call({ fromBlock: "earliest", toBlock: tag })).toHaveLength(5);
    }
  });

  it("returns [] for an inverted range", async () => {
    expect(await call({ fromBlock: "0xc", toBlock: "0xa" })).toEqual([]);
  });

  it("uses an injectable latest-block resolver (Part B owns the real head)", async () => {
    const logs = await getLogs(
      { sql, schema, resolveLatestBlock: async () => 10 },
      [{ fromBlock: "earliest", toBlock: "latest" }],
    );
    expect(logs).toHaveLength(2); // only block 10
  });

  // --- blockHash axis ------------------------------------------------------------------------

  it("filters by blockHash", async () => {
    const logs = await call({ blockHash: `0x${"ab".repeat(32)}` });
    expect(logs).toHaveLength(2); // token A tx_index 1 and token B tx_index 2, both in block 11
    expect(new Set(logs.map((l) => l.blockNumber))).toEqual(new Set(["0xb"]));
  });

  it("rejects blockHash combined with a range as -32602", async () => {
    for (const extra of [{ fromBlock: "0x1" }, { toBlock: "0x1" }]) {
      const error = await call({ blockHash: `0x${"ab".repeat(32)}`, ...extra }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JsonRpcError);
      expect((error as JsonRpcError).code).toBe(-32602);
      expect((error as JsonRpcError).message).toMatch(/mutually exclusive/);
    }
  });

  it("returns [] for an unknown blockHash", async () => {
    expect(await call({ blockHash: `0x${"fe".repeat(32)}` })).toEqual([]);
  });

  // --- validation ----------------------------------------------------------------------------

  it("rejects malformed parameters as -32602", async () => {
    const cases: unknown[] = [
      undefined,
      "not-an-object",
      { address: "0xnothex" },
      { address: `0x${"11".repeat(19)}` }, // 19 bytes
      { topics: "not-an-array" },
      { topics: [`0x${"dd".repeat(31)}`] }, // 31-byte topic
      { topics: [null, null, null, null, null] }, // 5 positions
      { fromBlock: "12" }, // decimal, not a hex quantity
      { fromBlock: "0xzz" },
    ];
    for (const filter of cases) {
      const error = await call(filter).catch((e: unknown) => e);
      expect(error, `filter ${JSON.stringify(filter)}`).toBeInstanceOf(JsonRpcError);
      expect((error as JsonRpcError).code).toBe(-32602);
    }
  });

  // --- registration --------------------------------------------------------------------------

  it("registers itself as eth_getLogs on the registry", async () => {
    clearRegistry();
    registerGetLogs({ sql, schema });
    expect(registeredMethods()).toEqual(["eth_getLogs"]);
    const handler = getMethod("eth_getLogs")!;
    const logs = (await handler([{ fromBlock: "earliest" }])) as RpcLog[];
    expect(logs).toHaveLength(5);
    // A duplicate registration is an error, not a silent overwrite.
    expect(() => registerGetLogs({ sql, schema })).toThrow(/already registered/);
  });

  // --- cap -----------------------------------------------------------------------------------

  it(`errors -32005 above ${MAX_RESULTS} results, and serves exactly ${MAX_RESULTS}`, async () => {
    // A dedicated schema so the seeded rows above stay untouched.
    const capSchema = "evm_rpc_cap";
    const capSql = createClient({ connectionString: container.getConnectionUri(), schema: capSchema });
    try {
      await runMigrations(capSql, { schema: capSchema, migrations: evmRpcMigrations });
      const bulk: LogRow[] = [];
      for (let i = 0; i < MAX_RESULTS; i++) {
        bulk.push(
          row({
            sourceEventId: i + 1,
            blockNumber: 1 + Math.floor(i / 100),
            txHash: b(i.toString(16).padStart(8, "0").repeat(8)),
            logIndex: i % 100,
          }),
        );
      }
      await writeLogs(capSql as unknown as SqlPool, capSchema, bulk, { contractIdentity: TOKEN_A });

      // Exactly at the cap: served, not an error.
      const atCap = await getLogs({ sql: capSql, schema: capSchema }, [{ fromBlock: "earliest" }]);
      expect(atCap).toHaveLength(MAX_RESULTS);

      // One more row pushes it over.
      await writeLogs(
        capSql as unknown as SqlPool,
        capSchema,
        [row({ sourceEventId: MAX_RESULTS + 1, blockNumber: 999, txHash: b("ff".repeat(32)) })],
        { contractIdentity: TOKEN_A },
      );
      const error = await getLogs({ sql: capSql, schema: capSchema }, [{ fromBlock: "earliest" }]).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(JsonRpcError);
      expect((error as JsonRpcError).code).toBe(-32005);
      expect((error as JsonRpcError).message).toBe(
        `query returned more than ${MAX_RESULTS} results`,
      );
    } finally {
      await capSql.end({ timeout: 5 });
    }
  }, 180_000);
});
