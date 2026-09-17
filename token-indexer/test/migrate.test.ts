import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { BUILTIN_KEYS } from "../../src/postgres/migrations/token_index/index.js";
import { bootstrapTokenIndexSchema, rebuildTokenIndex } from "../bootstrap.js";
import { NIGHT_COLOR_HEX, pad32 } from "../color.js";

/**
 * Project 00020, sub-plan 01 Phase 1 — the `token_index` lineage and its two built-in rows
 * (spec §6.1, owner decision Q7). Real Postgres 17 through Testcontainers, matching every other
 * schema test in this repo; not a mock and not an assertion about SQL text.
 *
 * One container, one test per fact, all against the same migrated schema — the lineage is applied
 * once and written to over time, which is also how it will really be used.
 *
 * The DUST row's shape is question Q30's applied default: the ledger's DUST token type is a UNIT
 * variant carrying no bytes (`export type DustTokenType = { tag: 'dust' }`, and
 * `coin-structure/src/coin.rs:285-288`), so the spec's `feeToken().raw` does not exist and the row
 * carries `color = NULL`. The assertion below is deliberately written against the LEDGER, not
 * against the seed: the day ledger-v9 grows a DUST colour, this test fails and the seed is
 * revisited, instead of the seed silently drifting from the chain.
 */
describe("token_index migration lineage and built-in rows", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "token_index_migrate_test";
  const net = "stagenet";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("[[token-migrate-seeds]] applies the lineage, seeds NIGHT and DUST with the exact bytes the ledger defines, re-runs as a no-op, and rebuild empties everything but the seeds", async () => {
    // --- fresh apply ---------------------------------------------------------------------
    await bootstrapTokenIndexSchema(sql, { schema, net });
    const applied = await sql<{ name: string }[]>`
      SELECT name FROM ${sql(schema)}._migrations ORDER BY name
    `;
    expect(applied.map((r) => r.name)).toEqual(["000_schema", "001_token_index_core"]);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY table_name
    `;
    expect(tables.map((r) => r.table_name)).toEqual([
      "_migrations", "contracts", "cursors", "pending_event_lookups", "token_metadata_events",
      "token_metadata_kv", "token_mints", "tokens",
    ]);

    // --- the two built-in rows ------------------------------------------------------------
    const seeds = await sql<{
      address: Buffer; domain_sep: Buffer; kind: string; storage: string | null;
      color: Buffer | null; name: string; symbol: string; decimals: number; status: string;
      mint_count: string; total_minted: string;
    }[]>`
      SELECT address, domain_sep, kind, storage, color, name, symbol, decimals, status,
             mint_count, total_minted
      FROM ${sql(schema)}.tokens WHERE net = ${net} ORDER BY symbol
    `;
    expect(seeds).toHaveLength(2);
    const dust = seeds[0]!;
    const night = seeds[1]!;

    expect(night.symbol).toBe("NIGHT");
    expect(night.name).toBe("NIGHT");
    expect(night.decimals).toBe(6);
    expect(night.kind).toBe("unshielded");
    expect(night.storage).toBe("native");
    expect(night.status).toBe("builtin");
    expect(night.color?.toString("hex")).toBe(NIGHT_COLOR_HEX);
    expect(night.address.toString("hex")).toBe(BUILTIN_KEYS.night.address);
    expect(night.domain_sep.toString("hex")).toBe(BUILTIN_KEYS.night.domainSep);
    expect(Number(night.mint_count)).toBe(0);
    expect(night.total_minted).toBe("0");

    expect(dust.symbol).toBe("DUST");
    expect(dust.decimals).toBe(15);
    expect(dust.status).toBe("builtin");
    expect(dust.color).toBeNull(); // Q30 — DUST has no colour on this ledger
    expect(dust.domain_sep.toString("hex")).toBe(Buffer.from(pad32("dust")).toString("hex"));
    expect(dust.address.toString("hex")).toBe(BUILTIN_KEYS.dust.address);

    // --- the seeds against the LEDGER itself, not against themselves ----------------------
    const ledger = (await import("@midnightntwrk/ledger-v9")) as unknown as {
      nativeToken(): { tag: string; raw: string };
      feeToken(): { tag: string; raw?: string };
    };
    expect(ledger.nativeToken().raw).toBe(NIGHT_COLOR_HEX);
    expect(ledger.nativeToken().tag).toBe("unshielded");
    // The whole justification for `color IS NULL` on the DUST row: the fee token carries no bytes.
    expect(ledger.feeToken().tag).toBe("dust");
    expect(ledger.feeToken().raw).toBeUndefined();

    // --- idempotent re-run ----------------------------------------------------------------
    await bootstrapTokenIndexSchema(sql, { schema, net });
    const afterRerun = await sql<{ name: string }[]>`
      SELECT name FROM ${sql(schema)}._migrations ORDER BY name
    `;
    expect(afterRerun).toEqual(applied);
    const seedCount = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.tokens WHERE net = ${net}
    `;
    expect(seedCount[0]!.n).toBe("2");

    // --- rebuild: derived rows go, seeds come back, another net is untouched --------------
    const other = "someothernet";
    await bootstrapTokenIndexSchema(sql, { schema, net: other });
    await sql`
      INSERT INTO ${sql(schema)}.contracts (net, address, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 7)}, 1)
    `;
    await sql`
      INSERT INTO ${sql(schema)}.tokens
        (net, address, domain_sep, kind, storage, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 7)}, ${Buffer.alloc(32, 9)}, 'shielded', 'native',
              ${Buffer.alloc(32, 3)}, 'observed', 1)
    `;
    await sql`
      INSERT INTO ${sql(schema)}.cursors (net, kind, value)
      VALUES (${net}, 'decode', ${sql.json({ height: 5, position: 2 })})
    `;

    await rebuildTokenIndex(sql, { schema, net });

    const afterRebuild = await sql<{ symbol: string; status: string }[]>`
      SELECT symbol, status FROM ${sql(schema)}.tokens WHERE net = ${net} ORDER BY symbol
    `;
    expect(afterRebuild).toEqual([
      { symbol: "DUST", status: "builtin" },
      { symbol: "NIGHT", status: "builtin" },
    ]);
    const leftovers = await sql<{ contracts: string; cursors: string; others: string }[]>`
      SELECT
        (SELECT count(*)::text FROM ${sql(schema)}.contracts WHERE net = ${net}) AS contracts,
        (SELECT count(*)::text FROM ${sql(schema)}.cursors   WHERE net = ${net}) AS cursors,
        (SELECT count(*)::text FROM ${sql(schema)}.tokens    WHERE net = ${other}) AS others
    `;
    expect(leftovers[0]).toEqual({ contracts: "0", cursors: "0", others: "2" });
  }, 180_000);

  it("[[token-migrate-checks]] the schema rejects a wrong byte length, an unknown status and an unknown kind", async () => {
    const bad = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("expected the insert to be rejected");
    };

    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, address, domain_sep, kind, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(31)}, ${Buffer.alloc(32)}, 'shielded', 'observed', 1)
    `)).toMatch(/tokens_address_check|violates check constraint/i);

    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, address, domain_sep, kind, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 1)}, ${Buffer.alloc(32, 1)}, 'shielded', 'nonsense', 1)
    `)).toMatch(/tokens_status_check|violates check constraint/i);

    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, address, domain_sep, kind, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 2)}, ${Buffer.alloc(32, 2)}, 'dust', 'observed', 1)
    `)).toMatch(/tokens_kind_check|violates check constraint/i);

    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.token_metadata_events
        (net, event_id, address, tx_hash, block_height, payload, domain_sep, kind_byte, key, len, value, applied)
      VALUES (${net}, 1, ${Buffer.alloc(32)}, ${Buffer.alloc(32)}, 1, ${Buffer.alloc(255)},
              ${Buffer.alloc(32)}, 1, ${Buffer.alloc(32)}, 0, ${Buffer.alloc(0)}, true)
    `)).toMatch(/payload_check|violates check constraint/i);
  }, 60_000);
});
