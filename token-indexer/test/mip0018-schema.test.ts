/**
 * The `mip0018` migration lineage: its tables, exact bytes, lossless integers, constraints that keep tombstones and
 * other layouts out. One database for the file (`test/helpers/test-database.ts`: Postgres 17 or PGlite).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { MIP0018_SCHEMA, mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";
import { openTestDatabase, type TestDatabase } from "../../test/helpers/test-database.ts";

const schema = MIP0018_SCHEMA;
const A = Buffer.alloc(32, 0xaa);
const D = Buffer.alloc(32, 0x11);
const key = (text: string): Buffer => Buffer.from(text, "utf8");

describe("mip0018 schema", () => {
  let db: TestDatabase | undefined;
  let sql: UmbraDBSql;

  beforeAll(async () => {
    db = await openTestDatabase();
    sql = db.client(schema);
    await runMigrations(sql, { schema, migrations: mip0018Migrations });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await db?.stop();
  }, 60_000);

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

  it("[[mip0018.schema.fresh-lineage]] creates exactly the lineage's tables (event log, latest-value fields, withdrawals, listed events, scan cursor, mints, color sightings, contract actions, built-in tokens, activity; no history table), and re-running is a no-op", async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      "_migrations", "mip0018_activity", "mip0018_builtin_tokens", "mip0018_color_sightings", "mip0018_contract_actions",
      "mip0018_events", "mip0018_fields", "mip0018_listed_events", "mip0018_mints", "mip0018_scan", "mip0018_withdrawals",
    ]); // 001_mip0018_core: events, fields, withdrawals, listed events; 002_mip0018_scan: the scan tables;
    // 003_mip0018_activity: the activity rows
    await runMigrations(sql, { schema, migrations: mip0018Migrations });
    const applied = await sql<{ name: string }[]>`SELECT name FROM ${sql(schema)}._migrations ORDER BY name`;
    expect(applied.map((r) => r.name)).toEqual(["000_schema", "001_mip0018_core", "002_mip0018_scan", "003_mip0018_activity"]);
  }, 120_000);

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
  }, 120_000);

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
  }, 120_000);

  /**
   * Every text-typed column of the lineage and why chain bytes cannot reach it. A new text column
   * fails this test until it is classified here; chain-derived bytes go to `bytea`.
   */
  const TEXT_COLUMNS: Record<string, "config" | "vocabulary" | "code-ascii" | "code-constant"> = {
    "mip0018_activity.direction": "vocabulary", // CHECK in ('in', 'out')
    "mip0018_activity.network": "config", // the operator's --network / NET
    "mip0018_activity.phase": "vocabulary",
    "mip0018_activity.role": "vocabulary",
    "mip0018_builtin_tokens.name": "code-constant", // NIGHT / DUST, seeded by the scanner
    "mip0018_builtin_tokens.network": "config",
    "mip0018_builtin_tokens.note": "code-constant",
    "mip0018_builtin_tokens.symbol": "vocabulary",
    "mip0018_color_sightings.evidence": "vocabulary",
    "mip0018_color_sightings.network": "config",
    "mip0018_contract_actions.action": "vocabulary",
    "mip0018_contract_actions.applied_phases": "vocabulary", // text[] <@ {guaranteed, fallible}
    "mip0018_contract_actions.maintenance_updates": "code-ascii", // text[]: ledger class name, `<bytes HEX>` or a printable entry point, v3/v4
    "mip0018_contract_actions.network": "config",
    "mip0018_events.classification": "vocabulary",
    "mip0018_events.event_type": "code-ascii", // the MIP-0002 type name
    "mip0018_events.network": "config",
    "mip0018_events.phase": "vocabulary",
    "mip0018_events.reason": "code-ascii", // the codec's reason vocabulary or a fixed decoder message with numbers
    "mip0018_fields.network": "config",
    "mip0018_listed_events.classification": "vocabulary", // CHECK in ('accept', 'reject')
    "mip0018_listed_events.network": "config",
    "mip0018_mints.network": "config",
    "mip0018_mints.phase": "vocabulary",
    "mip0018_scan.network": "config",
    "mip0018_withdrawals.network": "config",
  };

  it("[[mip0018.schema.text-columns]] every text column of the lineage is classified (operator configuration, fixed vocabulary, code-generated ASCII, code constant); entry points and every other chain byte string are bytea; the code-generated free-text columns refuse anything but printable ASCII and a NUL never reaches a text column", async () => {
    const cols = await sql<{ t: string; c: string; udt: string }[]>`
      SELECT table_name AS t, column_name AS c, udt_name AS udt FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name LIKE 'mip0018%'
        AND udt_name IN ('text', '_text', 'varchar', '_varchar', 'bpchar', '_bpchar', 'name', 'json', '_json', 'jsonb', '_jsonb')
      ORDER BY 1, 2`;
    expect(cols.map((r) => `${r.t}.${r.c}`)).toEqual(Object.keys(TEXT_COLUMNS).sort());
    const bytea = await sql<{ t: string; c: string; udt: string }[]>`
      SELECT table_name AS t, column_name AS c, udt_name AS udt FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name LIKE 'mip0018%'
        AND column_name IN ('entry_point', 'maintenance_operations', 'name', 'payload', 'key', 'value', 'reason') ORDER BY 1, 2`;
    expect(bytea.map((r) => `${r.t}.${r.c}:${r.udt}`)).toEqual([
      "mip0018_activity.entry_point:bytea", "mip0018_builtin_tokens.name:text", "mip0018_contract_actions.entry_point:bytea",
      "mip0018_contract_actions.maintenance_operations:_bytea", "mip0018_events.name:bytea", "mip0018_events.payload:bytea",
      "mip0018_events.reason:text", "mip0018_fields.key:bytea", "mip0018_fields.value:bytea",
    ]);
    // The code-generated free-text columns hold printable ASCII only.
    const event = {
      network: "testnet-a", block_height: 9, tx_index: 0, event_index: 0, contract_address: A, event_type: "Misc",
      name: Buffer.alloc(32), payload: Buffer.alloc(256), classification: "reject", reason: "no-records", domain_sep: null, kind: null,
    };
    for (const bad of [{ reason: "no-records\u00e9" }, { reason: "a\u202Eb" }, { reason: "" }, { event_type: "Mi sc" }, { event_type: "Misc\u00e9" }])
      await expect(sql`INSERT INTO ${sql(schema)}.mip0018_events ${sql({ ...event, ...bad })}`, JSON.stringify(bad)).rejects.toMatchObject({ code: "23514" });
    await sql`INSERT INTO ${sql(schema)}.mip0018_events ${sql({ ...event, reason: "undecodable-data: Misc data is 289 bytes (> 288)" })}`;
    const action = (updates: string[]) => sql`
      INSERT INTO ${sql(schema)}.mip0018_contract_actions
        (network, block_height, tx_index, segment_id, action_index, tx_hash, action, contract_address, maintenance_counter,
         maintenance_updates, maintenance_operations)
      VALUES ('testnet-a', 9, 0, 1, ${updates.length}, ${Buffer.alloc(32, 1)}, 'maintenance', ${A}, 1,
              ${sql.array(updates)}, ${sql.array(updates.map(() => Buffer.from("op")), 17)})`;
    for (const bad of [["VerifierKeyRemove(caf\u00e9, v3)"], ["ok", "X(\u202Eevil, v3)"]])
      await expect(action(bad), bad.join()).rejects.toMatchObject({ code: "23514" });
    await action(["VerifierKeyRemove(<bytes 6d696e7400>, v3)"]);
    // And a NUL cannot be sent to a text column at all (why entry points are bytea): 22021 / 22P05.
    const nul = await sql`SELECT ${"a\u0000b"}::text AS t`.then(() => null, (e: { code?: string }) => e.code);
    expect(["22021", "22P05"]).toContain(nul);
  }, 60_000);
});
