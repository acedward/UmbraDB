import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { BUILTIN_KEYS } from "../../src/postgres/migrations/token_index/index.js";
import { bootstrapTokenIndexSchema, rebuildTokenIndex } from "../bootstrap.js";
import { NIGHT_COLOR_HEX, pad32 } from "../color.js";

/**
 * Project 00021, Phase A task A2 — the `token_index` lineage through migration `002_mip_xxxx_layout`
 * and its two built-in rows (spec 00021 FR-103/FR-104/FR-107, MIP §3/§4/§5.1/§7.2; 00020 owner
 * decision Q7 for the seeds). Real Postgres 17 through Testcontainers, matching every other schema
 * test in this repo; not a mock and not an assertion about SQL text.
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

  it("[[token-migrate-seeds]] applies the lineage through 003, seeds NIGHT and DUST with the exact bytes the ledger defines, re-runs as a no-op, and rebuild empties everything but the seeds", async () => {
    // --- fresh apply ---------------------------------------------------------------------
    await bootstrapTokenIndexSchema(sql, { schema, net });
    const applied = await sql<{ name: string }[]>`
      SELECT name FROM ${sql(schema)}._migrations ORDER BY name
    `;
    expect(applied.map((r) => r.name)).toEqual([
      "000_schema", "001_token_index_core", "002_mip_xxxx_layout", "003_token_activity",
    ]);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY table_name
    `;
    expect(tables.map((r) => r.table_name)).toEqual([
      "_migrations", "contract_calls", "contracts", "cursors", "pending_event_lookups",
      "shielded_offers", "token_activity", "token_metadata_events", "token_metadata_kv",
      "token_mints", "tokens",
    ]);

    // --- the identity, as the schema states it (00021 FR-103, 00023 FR-019) ----------------
    // `kind` is the byte, it is in the primary key, and `privacy`/`storage` are DERIVED from it —
    // so no row can ever carry a privacy or a storage that disagrees with its own identity.
    // Since 00023 the OTHER half of the key is `token_key` — the colour for a native kind — and
    // the MIP's `(address, domain_sep, kind)` lives on as a partial UNIQUE index, because a `seen`
    // row (a colour whose issuer is not knowable) has no contract to be keyed by.
    const pk = await sql<{ column_name: string }[]>`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${`${schema}.tokens`}::regclass AND i.indisprimary
      ORDER BY a.attname
    `;
    expect(pk.map((r) => r.column_name)).toEqual(["kind", "net", "token_key"]);
    const identity = await sql<{ column_name: string }[]>`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${`${schema}.tokens`}::regclass AND i.indisunique AND NOT i.indisprimary
      ORDER BY a.attname
    `;
    expect(identity.map((r) => r.column_name)).toEqual(["address", "domain_sep", "kind", "net"]);
    const columns = await sql<{ column_name: string; data_type: string; is_generated: string }[]>`
      SELECT column_name, data_type, is_generated FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'tokens'
        AND column_name IN ('kind', 'privacy', 'storage')
      ORDER BY column_name
    `;
    expect(columns).toEqual([
      { column_name: "kind", data_type: "smallint", is_generated: "NEVER" },
      { column_name: "privacy", data_type: "text", is_generated: "ALWAYS" },
      { column_name: "storage", data_type: "text", is_generated: "ALWAYS" },
    ]);

    // --- the two built-in rows ------------------------------------------------------------
    const seeds = await sql<{
      token_key: Buffer; address: Buffer; domain_sep: Buffer; kind: number; privacy: string;
      storage: string; color: Buffer | null; name: string; symbol: string; decimals: number;
      status: string; mint_count: string; total_minted: string;
    }[]>`
      SELECT token_key, address, domain_sep, kind, privacy, storage, color, name, symbol, decimals,
             status, mint_count, total_minted
      FROM ${sql(schema)}.tokens WHERE net = ${net} ORDER BY symbol
    `;
    expect(seeds).toHaveLength(2);
    const dust = seeds[0]!;
    const night = seeds[1]!;

    expect(night.symbol).toBe("NIGHT");
    expect(night.name).toBe("NIGHT");
    expect(night.decimals).toBe(6);
    expect(night.kind).toBe(0);
    expect(night.privacy).toBe("unshielded");
    expect(night.storage).toBe("native");
    expect(night.status).toBe("builtin");
    expect(night.color?.toString("hex")).toBe(NIGHT_COLOR_HEX);
    expect(night.address.toString("hex")).toBe(BUILTIN_KEYS.night.address);
    expect(night.domain_sep.toString("hex")).toBe(BUILTIN_KEYS.night.domainSep);
    // 00023: the physical key of a native row IS its colour, so NIGHT's key is the zero colour.
    expect(night.token_key.toString("hex")).toBe(BUILTIN_KEYS.night.tokenKey);
    expect(night.token_key.toString("hex")).toBe(NIGHT_COLOR_HEX);
    expect(Number(night.mint_count)).toBe(0);
    expect(night.total_minted).toBe("0");

    expect(dust.symbol).toBe("DUST");
    expect(dust.decimals).toBe(15);
    expect(dust.status).toBe("builtin");
    expect(dust.kind).toBe(0);
    expect(dust.color).toBeNull(); // Q30 — DUST has no colour on this ledger
    expect(dust.domain_sep.toString("hex")).toBe(Buffer.from(pad32("dust")).toString("hex"));
    expect(dust.address.toString("hex")).toBe(BUILTIN_KEYS.dust.address);
    // DUST has no colour to be keyed by, so its key is the documented sentinel separator — the
    // built-ins are exactly why `tokens_native_has_color` exempts `status = 'builtin'`.
    expect(dust.token_key.toString("hex")).toBe(BUILTIN_KEYS.dust.tokenKey);
    expect(dust.token_key.toString("hex")).toBe(Buffer.from(pad32("dust")).toString("hex"));

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
        (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 3)}, 1, ${Buffer.alloc(32, 7)}, ${Buffer.alloc(32, 9)},
              ${Buffer.alloc(32, 3)}, 'observed', 1)
    `;
    // 00023's three tables are derived rows too, and `rebuild` must take them with it (FR-005).
    await sql`
      INSERT INTO ${sql(schema)}.token_activity
        (net, tx_hash, block_height, tx_position, segment, section, role, item_index,
         color, kind, amount, direction)
      VALUES (${net}, ${Buffer.alloc(32, 4)}, 1, 0, 0, 'guaranteed', 'utxo_out', 0,
              ${Buffer.alloc(32, 3)}, 1, 7, 'in')
    `;
    await sql`
      INSERT INTO ${sql(schema)}.shielded_offers
        (net, tx_hash, section, segment, block_height, tx_position, inputs, outputs, transients, deltas, counted)
      VALUES (${net}, ${Buffer.alloc(32, 4)}, 'guaranteed', 0, 1, 0, 1, 1, 0, 0, true)
    `;
    await sql`
      INSERT INTO ${sql(schema)}.contract_calls
        (net, tx_hash, segment, call_index, address, entry_point, block_height, tx_position)
      VALUES (${net}, ${Buffer.alloc(32, 4)}, 0, 0, ${Buffer.alloc(32, 7)}, 'mint', 1, 0)
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
    const leftovers = await sql<{
      contracts: string; cursors: string; others: string;
      activity: string; offers: string; calls: string;
    }[]>`
      SELECT
        (SELECT count(*)::text FROM ${sql(schema)}.contracts WHERE net = ${net}) AS contracts,
        (SELECT count(*)::text FROM ${sql(schema)}.cursors   WHERE net = ${net}) AS cursors,
        (SELECT count(*)::text FROM ${sql(schema)}.tokens    WHERE net = ${other}) AS others,
        (SELECT count(*)::text FROM ${sql(schema)}.token_activity  WHERE net = ${net}) AS activity,
        (SELECT count(*)::text FROM ${sql(schema)}.shielded_offers WHERE net = ${net}) AS offers,
        (SELECT count(*)::text FROM ${sql(schema)}.contract_calls  WHERE net = ${net}) AS calls
    `;
    expect(leftovers[0]).toEqual({
      contracts: "0", cursors: "0", others: "2", activity: "0", offers: "0", calls: "0",
    });
  }, 180_000);

  it("[[token-migrate-checks]] the schema rejects a wrong byte length, an unknown status, a kind outside the MIP's four, a colour on a ledger kind, a write to a derived column, and 00023's colour-identity and activity rules", async () => {
    const bad = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("expected the insert to be rejected");
    };

    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 1)}, 1, ${Buffer.alloc(31)}, ${Buffer.alloc(32)}, ${Buffer.alloc(32, 1)}, 'observed', 1)
    `)).toMatch(/tokens_address_check|violates check constraint/i);

    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 1)}, 1, ${Buffer.alloc(32, 1)}, ${Buffer.alloc(32, 1)}, ${Buffer.alloc(32, 1)}, 'nonsense', 1)
    `)).toMatch(/tokens_status_check|violates check constraint/i);

    // `inconsistent` was a status of the 00020 schema and is gone (MIP §7.2, spec D4): the CHECK
    // is what makes its removal a fact rather than a convention nobody enforces.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 1)}, 1, ${Buffer.alloc(32, 1)}, ${Buffer.alloc(32, 2)}, ${Buffer.alloc(32, 1)}, 'inconsistent', 1)
    `)).toMatch(/tokens_status_check|violates check constraint/i);

    // MIP §3: the kind byte takes exactly four values.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 2)}, 4, ${Buffer.alloc(32, 2)}, ${Buffer.alloc(32, 2)}, 'observed', 1)
    `)).toMatch(/tokens_kind_check|violates check constraint/i);

    // MIP §3: "A consumer MUST NOT derive or display a colour for a ledger kind."
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 4)}, 2, ${Buffer.alloc(32, 3)}, ${Buffer.alloc(32, 3)}, ${Buffer.alloc(32, 4)}, 'declared', 1)
    `)).toMatch(/tokens_ledger_has_no_color|violates check constraint/i);

    // `privacy` and `storage` are GENERATED: not even a deliberate write can make them disagree
    // with the kind byte.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, privacy, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 5)}, 0, ${Buffer.alloc(32, 5)}, ${Buffer.alloc(32, 5)}, 'shielded', 'observed', 1)
    `)).toMatch(/generated column|cannot insert/i);

    // ---- 00023: the colour identity, stated as constraints (FR-019, US5) --------------------
    // A contract and a domain separator are one fact: neither is knowable without the other.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 6)}, 0, ${Buffer.alloc(32, 6)}, NULL, ${Buffer.alloc(32, 6)}, 'observed', 1)
    `)).toMatch(/tokens_contract_pair|violates check constraint/i);

    // `seen` is the ONLY status that may have no contract behind it — and it must have none.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 7)}, 0, ${Buffer.alloc(32, 7)}, ${Buffer.alloc(32, 7)}, ${Buffer.alloc(32, 7)}, 'seen', 1)
    `)).toMatch(/tokens_seen_has_no_contract|violates check constraint/i);

    // A native row that came from the chain always has a colour (only the built-ins are exempt).
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 8)}, 0, ${Buffer.alloc(32, 8)}, ${Buffer.alloc(32, 8)}, 'observed', 1)
    `)).toMatch(/tokens_native_has_color|violates check constraint/i);

    // …and where a colour exists, it IS the physical key. Nothing may key a colour by anything else.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 9)}, 0, ${Buffer.alloc(32, 9)}, ${Buffer.alloc(32, 9)}, ${Buffer.alloc(32, 10)}, 'observed', 1)
    `)).toMatch(/tokens_color_is_key|violates check constraint/i);

    // The MIP identity stays UNIQUE even though it is no longer the primary key: two `token_key`s
    // can never claim one `(address, domain_sep, kind)`.
    await sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 11)}, 0, ${Buffer.alloc(32, 12)}, ${Buffer.alloc(32, 12)}, ${Buffer.alloc(32, 11)}, 'observed', 1)
    `;
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.tokens (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
      VALUES (${net}, ${Buffer.alloc(32, 13)}, 0, ${Buffer.alloc(32, 12)}, ${Buffer.alloc(32, 12)}, ${Buffer.alloc(32, 13)}, 'observed', 1)
    `)).toMatch(/tokens_by_identity|duplicate key/i);

    // ---- 00023: the activity tables ---------------------------------------------------------
    // DUST is not tracked (owner decision Q13): every activity row has a colour, and DUST has none.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.token_activity
        (net, tx_hash, block_height, tx_position, segment, section, role, item_index, color, kind, amount, direction)
      VALUES (${net}, ${Buffer.alloc(32)}, 1, 0, 0, 'guaranteed', 'utxo_out', 0, NULL, 0, 1, 'in')
    `)).toMatch(/null value in column "color"|not-null/i);

    // A ledger kind has no colour, so it can never be the subject of an activity row.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.token_activity
        (net, tx_hash, block_height, tx_position, segment, section, role, item_index, color, kind, amount, direction)
      VALUES (${net}, ${Buffer.alloc(32)}, 1, 0, 0, 'guaranteed', 'utxo_out', 0, ${Buffer.alloc(32, 1)}, 2, 1, 'in')
    `)).toMatch(/token_activity_kind_check|violates check constraint/i);

    // The seven roles and the five directions are closed sets: a typo is an error, not a new role.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.token_activity
        (net, tx_hash, block_height, tx_position, segment, section, role, item_index, color, kind, amount, direction)
      VALUES (${net}, ${Buffer.alloc(32)}, 1, 0, 0, 'guaranteed', 'dust_fee', 0, ${Buffer.alloc(32, 1)}, 0, 1, 'in')
    `)).toMatch(/token_activity_role_check|violates check constraint/i);
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.token_activity
        (net, tx_hash, block_height, tx_position, segment, section, role, item_index, color, kind, amount, direction)
      VALUES (${net}, ${Buffer.alloc(32)}, 1, 0, 0, 'guaranteed', 'utxo_out', 0, ${Buffer.alloc(32, 1)}, 0, 1, 'sideways')
    `)).toMatch(/token_activity_direction_check|violates check constraint/i);

    // `amount` is UNSIGNED — the sign lives in `direction`, so a negative delta is a bug here.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.token_activity
        (net, tx_hash, block_height, tx_position, segment, section, role, item_index, color, kind, amount, direction)
      VALUES (${net}, ${Buffer.alloc(32)}, 1, 0, 0, 'guaranteed', 'shielded_delta', 0, ${Buffer.alloc(32, 1)}, 1, -1, 'pool_in')
    `)).toMatch(/token_activity_amount_check|violates check constraint/i);

    // `shielded_offers.undisclosed` is GENERATED from the delta count: no code path can assert a
    // privacy claim the numbers do not support (FR-018).
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.shielded_offers
        (net, tx_hash, section, segment, block_height, tx_position, inputs, outputs, transients, deltas, undisclosed, counted)
      VALUES (${net}, ${Buffer.alloc(32)}, 'guaranteed', 0, 1, 0, 1, 1, 0, 3, true, true)
    `)).toMatch(/generated column|cannot insert/i);
    await sql`
      INSERT INTO ${sql(schema)}.shielded_offers
        (net, tx_hash, section, segment, block_height, tx_position, inputs, outputs, transients, deltas, counted)
      VALUES (${net}, ${Buffer.alloc(32, 14)}, 'guaranteed', 0, 1, 0, 2, 2, 0, 0, true)
    `;
    const balanced = await sql<{ undisclosed: boolean }[]>`
      SELECT undisclosed FROM ${sql(schema)}.shielded_offers
      WHERE net = ${net} AND tx_hash = ${Buffer.alloc(32, 14)}
    `;
    expect(balanced[0]!.undisclosed).toBe(true);

    // A mint effect is always native (MIP §6.3), so `token_mints.kind` is 0 or 1 and nothing else.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.token_mints
        (net, tx_hash, block_height, tx_position, segment, call_index, address, domain_sep, kind, amount)
      VALUES (${net}, ${Buffer.alloc(32)}, 1, 0, 0, 0, ${Buffer.alloc(32)}, ${Buffer.alloc(32)}, 2, 1)
    `)).toMatch(/token_mints_kind_check|violates check constraint/i);

    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.token_metadata_events
        (net, event_id, address, tx_hash, block_height, payload, domain_sep, kind_byte, key, key_hex,
         val_type, val_len, value, applied)
      VALUES (${net}, 1, ${Buffer.alloc(32)}, ${Buffer.alloc(32)}, 1, ${Buffer.alloc(255)},
              ${Buffer.alloc(32)}, 1, ${Buffer.alloc(32)}, '6e616d65', 1, 0, ${Buffer.alloc(0)}, true)
    `)).toMatch(/payload_check|violates check constraint/i);

    // The kv row's identity is the key's BYTES (MIP §5.1): `key_hex` is lowercase hex and never
    // empty — an all-NUL key is rejected by the parser long before it could reach a kv row.
    expect(await bad(() => sql`
      INSERT INTO ${sql(schema)}.token_metadata_kv
        (net, address, domain_sep, kind, key_hex, val_type, val_len, value, updated_event_id, updated_height)
      VALUES (${net}, ${Buffer.alloc(32)}, ${Buffer.alloc(32)}, 1, 'NOTHEX', 1, 0, ${Buffer.alloc(0)}, 1, 1)
    `)).toMatch(/key_hex_check|violates check constraint/i);
  }, 60_000);
});
