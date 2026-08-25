import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { evmRpcMigrations } from "../../../src/postgres/migrations/evm_rpc/index.js";
import { AddressIdCache, resolveAddressId } from "../address-map.js";
import { readCursor, writeLogs, type SqlPool } from "../store.js";
import { defaultAddressMapper, toHex, type LogRow, type MidnightIdentity } from "../event-map.js";

/**
 * Real Postgres 17 via Testcontainers, matching every other database test in this repo — the
 * migration's DDL is asserted by APPLYING it and then trying to violate each constraint, never by
 * string-matching the SQL. Also covers `store.ts`'s atomicity and dedup contract, which is the part
 * a crash would otherwise expose in production rather than here.
 */
describe("evm_rpc logs migration + store (C-G1)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "evm_rpc";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: evmRpcMigrations });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  const CONTRACT: MidnightIdentity = { kind: "contract", hex: "11".repeat(32) };
  const b = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

  function row(overrides: Partial<LogRow> = {}): LogRow {
    return {
      address: defaultAddressMapper(CONTRACT),
      blockNumber: 12,
      blockHash: b("bb".repeat(32)),
      txHash: b("e1".repeat(32)),
      txIndex: 0,
      logIndex: 0,
      topics: [b("dd".repeat(32))],
      data: new Uint8Array(0),
      sourceEventId: 1,
      removed: false,
      ...overrides,
    };
  }

  const pool = (): SqlPool => sql as unknown as SqlPool;

  it("applies cleanly and is idempotent on a re-run", async () => {
    const applied = await sql<{ name: string }[]>`
      SELECT name FROM ${sql(schema)}._migrations ORDER BY name
    `;
    // Post-merge lineage: A1/A2's 001_evm_rpc_core sorts between the schema bootstrap and C's logs.
    expect(applied.map((r) => r.name)).toEqual(["000_schema", "001_evm_rpc_core", "010_logs"]);

    await runMigrations(sql, { schema, migrations: evmRpcMigrations });
    const again = await sql<{ name: string }[]>`
      SELECT name FROM ${sql(schema)}._migrations ORDER BY name
    `;
    expect(again).toEqual(applied);
  });

  it("created every table and index the interface contract promises", async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    expect(tables.map((t) => t.table_name)).toEqual([
      // Post-merge union: A1/A2's core tables (balances, tx_index, utxos, watermarks if present)
      // plus C's logs tables. Keep sorted.
      "_migrations", "address_map", "balances", "log_cursors", "logs", "tx_index", "utxos", "watermarks",
    ]);

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = ${schema} AND tablename = 'logs'
      ORDER BY indexname
    `;
    // The two the plan names, plus the tx_hash path Part B's receipts read and the blockHash form.
    expect(indexes.map((i) => i.indexname)).toContain("logs_address_block_idx");
    expect(indexes.map((i) => i.indexname)).toContain("logs_topic0_block_idx");
    expect(indexes.map((i) => i.indexname)).toContain("logs_tx_hash_idx");
    expect(indexes.map((i) => i.indexname)).toContain("logs_block_hash_idx");
  });

  it("registers an address once and returns a stable id (upsert, not duplicate)", async () => {
    const cache = new AddressIdCache();
    const first = await resolveAddressId(sql, schema, CONTRACT, { firstSeenBlock: 12, cache });
    const second = await resolveAddressId(sql, schema, CONTRACT, { firstSeenBlock: 99 });
    expect(second).toBe(first);

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.address_map
      WHERE kind = 'contract' AND mn_address = ${"11".repeat(32)}
    `;
    expect(rows[0]!.n).toBe(1);
    // first_seen_block is preserved by the no-op update, not overwritten by the later sighting.
    const seen = await sql<{ first_seen_block: bigint | null }[]>`
      SELECT first_seen_block FROM ${sql(schema)}.address_map WHERE id = ${first}
    `;
    expect(Number(seen[0]!.first_seen_block)).toBe(12);
  });

  it("derives the stored evm_addr as keccak256(identity)[12:32]", async () => {
    const id = await resolveAddressId(sql, schema, CONTRACT);
    const rows = await sql<{ evm_addr: Buffer }[]>`
      SELECT evm_addr FROM ${sql(schema)}.address_map WHERE id = ${id}
    `;
    expect(toHex(rows[0]!.evm_addr)).toBe(toHex(defaultAddressMapper(CONTRACT)));
    expect(rows[0]!.evm_addr.length).toBe(20);
  });

  it("rejects two identities colliding onto one evm_addr instead of merging balances", async () => {
    // Fire the unique index directly: a second row claiming an already-taken evm_addr must be a
    // hard error, because silently merging would pool two accounts' balances.
    const taken = await sql<{ evm_addr: Buffer }[]>`
      SELECT evm_addr FROM ${sql(schema)}.address_map LIMIT 1
    `;
    await expect(
      sql`INSERT INTO ${sql(schema)}.address_map (evm_addr, kind, mn_address)
          VALUES (${taken[0]!.evm_addr}, 'midnight', ${"fe".repeat(32)})`,
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("matches Part A1/A2's committed address_map shape, so the merge is a no-op", async () => {
    // Guards the reason `010_logs.ts` creates this table with IF NOT EXISTS: the columns must be
    // A1/A2's (umbradb-sync/.../001_evm_rpc_core.ts), verified against the live Part A stack.
    const columns = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'address_map'
      ORDER BY ordinal_position
    `;
    expect(columns.map((c) => c.column_name)).toEqual([
      "id", "evm_addr", "kind", "mn_address", "meta", "first_seen_block",
    ]);
    expect(columns.find((c) => c.column_name === "mn_address")?.data_type).toBe("text");
    expect(columns.find((c) => c.column_name === "meta")?.data_type).toBe("jsonb");
  });

  it("writes rows and the cursor in one transaction", async () => {
    const written = await writeLogs(pool(), schema, [row({ sourceEventId: 10, logIndex: 0 })], {
      contractIdentity: CONTRACT,
      cursor: { contractAddress: b("11".repeat(32)), lastEventId: 10 },
    });
    expect(written).toEqual({ inserted: 1, skipped: 0 });
    expect(await readCursor(sql, schema, b("11".repeat(32)))).toBe(10);
  });

  it("skips a replayed source_event_id rather than duplicating it (at-least-once delivery)", async () => {
    const replay = await writeLogs(pool(), schema, [row({ sourceEventId: 10, logIndex: 0 })], {
      contractIdentity: CONTRACT,
      cursor: { contractAddress: b("11".repeat(32)), lastEventId: 10 },
    });
    expect(replay).toEqual({ inserted: 0, skipped: 1 });
    const count = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.logs WHERE source_event_id = 10
    `;
    expect(count[0]!.n).toBe(1);
  });

  it("never moves the cursor backwards", async () => {
    await writeLogs(pool(), schema, [], {
      contractIdentity: CONTRACT,
      cursor: { contractAddress: b("11".repeat(32)), lastEventId: 3 },
    });
    expect(await readCursor(sql, schema, b("11".repeat(32)))).toBe(10);
  });

  it("rolls back the whole batch — cursor included — when any row violates a constraint", async () => {
    const before = await readCursor(sql, schema, b("11".repeat(32)));
    await expect(
      writeLogs(
        pool(),
        schema,
        [
          row({ sourceEventId: 20, logIndex: 0, txHash: b("aa".repeat(32)) }),
          // 31-byte topic0: violates the octet_length check, so the batch must not land AT ALL.
          row({ sourceEventId: 21, logIndex: 1, txHash: b("aa".repeat(32)), topics: [b("cc".repeat(31))] }),
        ],
        { contractIdentity: CONTRACT, cursor: { contractAddress: b("11".repeat(32)), lastEventId: 21 } },
      ),
    ).rejects.toThrow();

    const landed = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.logs WHERE source_event_id IN (20, 21)
    `;
    expect(landed[0]!.n).toBe(0);
    expect(await readCursor(sql, schema, b("11".repeat(32)))).toBe(before);
  });

  it("enforces the DDL constraints the plan's bytea(32) intent stands for", async () => {
    const addressId = await resolveAddressId(sql, schema, CONTRACT);
    interface Candidate {
      addressId: bigint;
      blockHash: Buffer;
      txHash: Buffer;
      txIndex: number;
      topic0: Buffer;
      topic1: Buffer | null;
      topic2: Buffer | null;
      sourceEventId: bigint;
    }
    const insert = (overrides: Partial<Candidate>) => {
      const c: Candidate = {
        addressId,
        blockHash: Buffer.from("bb".repeat(32), "hex"),
        txHash: Buffer.from("cd".repeat(32), "hex"),
        txIndex: 0,
        topic0: Buffer.from("dd".repeat(32), "hex"),
        topic1: null,
        topic2: null,
        sourceEventId: 900n,
        ...overrides,
      };
      return sql`
        INSERT INTO ${sql(schema)}.logs
          (address_id, block_number, block_hash, tx_hash, tx_index, log_index,
           topic0, topic1, topic2, data, source_event_id)
        VALUES (${c.addressId}, 1, ${c.blockHash}, ${c.txHash}, ${c.txIndex}, 0,
                ${c.topic0}, ${c.topic1}, ${c.topic2}, ${Buffer.alloc(0)}, ${c.sourceEventId})
      `;
    };

    // A short block_hash / tx_hash / topic is rejected, not silently stored.
    await expect(insert({ blockHash: Buffer.alloc(31), sourceEventId: 901n })).rejects.toThrow();
    await expect(insert({ txHash: Buffer.alloc(20), sourceEventId: 902n })).rejects.toThrow();
    await expect(insert({ topic1: Buffer.alloc(31), sourceEventId: 903n })).rejects.toThrow();
    // A topic gap (topic2 set, topic1 NULL) breaks positional matching, so it is rejected.
    await expect(
      insert({ topic2: Buffer.alloc(32), sourceEventId: 904n }),
    ).rejects.toThrow(/logs_topics_contiguous/);
    // A negative index is rejected.
    await expect(insert({ txIndex: -1, sourceEventId: 905n })).rejects.toThrow();
    // An address_id with no address_map row is rejected (FK).
    await expect(insert({ addressId: 999_999n, sourceEventId: 906n })).rejects.toThrow();
  });

  it("accepts the negative source_event_id range C-G5's synthetic genesis rows use", async () => {
    const written = await writeLogs(pool(), schema, [row({ sourceEventId: -1, txHash: b("77".repeat(32)) })], {
      contractIdentity: CONTRACT,
    });
    expect(written.inserted).toBe(1);
  });
});
