/**
 * The `mip0018` migration lineage (fresh schema, project 00026 Q7): two tables, exact bytes, lossless integers,
 * constraints that keep tombstones and earlier layouts out. One Postgres 17 container for the file.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { MIP0018_SCHEMA, mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";

const schema = MIP0018_SCHEMA;
const A = Buffer.alloc(32, 0xaa);
const D = Buffer.alloc(32, 0x11);
const key = (text: string): Buffer => Buffer.from(text, "utf8");

describe("mip0018 schema", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let sql: UmbraDBSql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: mip0018Migrations });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  const field = (k: Buffer, valType: number, value: Buffer, uint: string | null, usable: boolean | null) => ({
    network: "testnet-a",
    contract_address: A,
    domain_sep: D,
    kind: 3,
    key: k,
    val_type: valType,
    value,
    uint_value: uint,
    usable,
    updated_block: 1,
    updated_tx: 0,
    updated_event: 0,
    updated_record: 0,
  });

  it("[[mip0018.schema.fresh-lineage]] creates exactly the event log and the latest-value table, and re-running is a no-op", async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      "_migrations", "mip0018_activity", "mip0018_builtin_tokens", "mip0018_color_sightings", "mip0018_contract_actions",
      "mip0018_events", "mip0018_fields", "mip0018_mints", "mip0018_scan",
    ]); // 002_mip0018_scan (A3/B2) adds the scan tables; 003_mip0018_activity (C2) the activity rows
    await runMigrations(sql, { schema, migrations: mip0018Migrations });
    const applied = await sql<{ name: string }[]>`SELECT name FROM ${sql(schema)}._migrations ORDER BY name`;
    expect(applied.map((r) => r.name)).toEqual(["000_schema", "001_mip0018_core", "002_mip0018_scan", "003_mip0018_activity"]);
  });

  it("[[mip0018.schema.bytes]] keys and values are exact bytes and a 31-byte integer is lossless", async () => {
    const max = (1n << 248n) - 1n;
    const rows = [
      field(key("symbol"), 1, key("ACME"), null, true),
      field(Buffer.concat([key("symbol"), Buffer.from([0])]), 1, key("ACME"), null, null),
      field(Buffer.from("ff6b6579", "hex"), 0, Buffer.from([1, 0, 0]), null, null),
      field(key("decimals"), 2, Buffer.alloc(31, 0xff), max.toString(), true),
      field(Buffer.alloc(220, 0x6b), 0, Buffer.alloc(0), null, null),
    ];
    for (const r of rows) await sql`INSERT INTO ${sql(schema)}.mip0018_fields ${sql(r)}`;
    const got = await sql<{ key: Buffer; value: Buffer; uint_value: string | null }[]>`
      SELECT key, value, uint_value::text AS uint_value FROM ${sql(schema)}.mip0018_fields ORDER BY key`;
    expect(got).toHaveLength(5);
    const byHex = new Map(got.map((g) => [Buffer.from(g.key).toString("hex"), g]));
    expect(byHex.has("73796d626f6c")).toBe(true);
    expect(byHex.has("73796d626f6c00")).toBe(true);
    expect(Buffer.from(byHex.get("ff6b6579")!.value).toString("hex")).toBe("010000");
    expect(byHex.get("646563696d616c73")!.uint_value).toBe(max.toString());
    const grouped = await sql`
      SELECT 1 FROM ${sql(schema)}.mip0018_fields
      WHERE key = '\\x73796d626f6c'::bytea AND usable AND value = ${key("ACME")}`;
    expect(grouped).toHaveLength(1);
  });

  it("[[mip0018.schema.constraints]] rejects tombstones, other kinds, unsized integers and accepted events without a header", async () => {
    const bad = [
      field(key("name"), 5, Buffer.alloc(0), null, null), // a Null record deletes its row; it is never stored
      { ...field(key("name"), 1, key("x"), null, true), kind: 4 },
      field(key("decimals"), 2, Buffer.from([6]), null, true), // val_type 2 needs its integer
      field(Buffer.alloc(0), 1, key("x"), null, null), // empty key
    ];
    for (const r of bad) await expect(sql`INSERT INTO ${sql(schema)}.mip0018_fields ${sql(r)}`).rejects.toThrow();
    const event = {
      network: "testnet-a",
      block_height: 1,
      tx_index: 0,
      event_index: 0,
      contract_address: A,
      event_type: "Misc",
      name: Buffer.alloc(32),
      payload: Buffer.alloc(256),
      classification: "accept",
      reason: null,
      domain_sep: null,
      kind: null,
    };
    await expect(sql`INSERT INTO ${sql(schema)}.mip0018_events ${sql(event)}`).rejects.toThrow();
    await sql`INSERT INTO ${sql(schema)}.mip0018_events ${sql({ ...event, classification: "reject", reason: "no-records" })}`;
    await expect(
      sql`INSERT INTO ${sql(schema)}.mip0018_events ${sql({ ...event, event_index: 1, classification: "reject" })}`,
    ).rejects.toThrow();
    const count = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.mip0018_events`;
    expect(count[0]?.n).toBe(1);
  });
});
