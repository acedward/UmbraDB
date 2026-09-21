import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMint, ensureSeenToken } from "../ingest/fold.js";

/**
 * Project 00023, sub-plan 01 — the scanner's side of the activity index, on a real Postgres 17
 * through Testcontainers exactly as `scan.test.ts` does.
 *
 * This file owns the `seen` row (A1.4) and, from A3 on, the scanner's rows, counters, idempotence
 * and `rebuild` equality. Everything here runs against the real schema and the real fold — nothing
 * about the identity change is asserted against SQL text.
 */

const NET = "stagenet";

describe("activity rows, counters and seen tokens", () => {
  let container: StartedPostgreSqlContainer;
  const open: UmbraDBSql[] = [];
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterAll(async () => {
    while (open.length > 0) await open.pop()!.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function freshDb(): Promise<{ sql: UmbraDBSql; schema: string; archiveSchema: string }> {
    const id = counter++;
    const schema = `token_activity_${id}`;
    const archiveSchema = `arch_activity_${id}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    open.push(sql);
    await bootstrapChainArchiveSchema(sql, archiveSchema);
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    return { sql, schema, archiveSchema };
  }

  it("[[token-activity-seen-row]] a colour with no row becomes a `seen` token, and the mint that reveals its contract completes THAT row in place", async () => {
    const db = await freshDb();
    const { sql, schema } = db;

    // A colour nobody has a row for. It is a real derivation — the contract and the separator
    // exist, they are simply not in the archive yet (18 such outputs and 3 such deltas are in the
    // Stagenet archive today, minted before its first block).
    const address = "a7".repeat(32);
    const domainSep = Buffer.from(pad32("umbra:preexisting")).toString("hex");
    const color = tokenColorHex(domainSep, address);

    const rowsOfColor = async (): Promise<{
      token_key: string; kind: number; status: string; address: string | null; domain_sep: string | null;
      color: string | null; first_seen_height: string; mint_count: string; total_minted: string;
      name: string | null;
    }[]> => {
      const rows = await sql<{
        token_key: Buffer; kind: number; status: string; address: Buffer | null;
        domain_sep: Buffer | null; color: Buffer | null; first_seen_height: string;
        mint_count: string; total_minted: string; name: string | null;
      }[]>`
        SELECT token_key, kind, status, address, domain_sep, color, first_seen_height::text,
               mint_count::text, total_minted::text, name
        FROM ${sql(schema)}.tokens
        WHERE net = ${NET} AND token_key = ${Buffer.from(color, "hex")}
        ORDER BY kind
      `;
      return rows.map((r) => ({
        token_key: r.token_key.toString("hex"),
        kind: r.kind,
        status: r.status,
        address: r.address === null ? null : r.address.toString("hex"),
        domain_sep: r.domain_sep === null ? null : r.domain_sep.toString("hex"),
        color: r.color === null ? null : r.color.toString("hex"),
        first_seen_height: r.first_seen_height,
        mint_count: r.mint_count,
        total_minted: r.total_minted,
        name: r.name,
      }));
    };
    const totalRows = async (): Promise<number> => {
      const n = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM ${sql(schema)}.tokens WHERE net = ${NET}`;
      return Number(n[0]!.n);
    };

    expect(await rowsOfColor()).toEqual([]);
    const before = await totalRows();
    expect(before).toBe(2); // the two built-in seeds and nothing else

    // --- the colour is seen in public data ---------------------------------------------------
    const created = await sql.begin(async (tx) => ensureSeenToken(tx, schema, NET, color, 0, 500_123));
    expect(created).toBe(true);
    expect(await rowsOfColor()).toEqual([{
      token_key: color, kind: 0, status: "seen",
      address: null, domain_sep: null, color,
      first_seen_height: "500123", mint_count: "0", total_minted: "0", name: null,
    }]);
    expect(await totalRows()).toBe(before + 1);

    // Seeing it again says nothing new: no second row, and the first sighting's height stands.
    const again = await sql.begin(async (tx) => ensureSeenToken(tx, schema, NET, color, 0, 500_999));
    expect(again).toBe(false);
    expect((await rowsOfColor())[0]!.first_seen_height).toBe("500123");
    expect(await totalRows()).toBe(before + 1);

    // The SAME colour under the other native kind is a different token — the ledger tells the two
    // apart by TAG, not by value — so it is a second row, not a contradiction.
    expect(await sql.begin(async (tx) => ensureSeenToken(tx, schema, NET, color, 1, 500_200))).toBe(true);
    expect((await rowsOfColor()).map((r) => [r.kind, r.status])).toEqual([[0, "seen"], [1, "seen"]]);
    expect(await totalRows()).toBe(before + 2);

    // --- the mint that reveals who issued it -------------------------------------------------
    const mint: ObservedMint = {
      segment: 0, callIndex: 0, address, domainSep, kind: 0, amount: 1_000_000n,
      entryPoint: "mint", section: "guaranteed",
    };
    const isNew = await sql.begin(async (tx) => applyMint(tx, schema, NET, mint, {
      txHash: "5e".repeat(32), blockHeight: 500_500, txPosition: 0,
    }));
    expect(isNew).toBe(true);

    const completed = await rowsOfColor();
    // Still TWO rows for this colour — the kind-0 one was completed IN PLACE, not duplicated, and
    // the kind-1 one knows nothing about a kind-0 mint (MIP §6.3).
    expect(completed).toHaveLength(2);
    expect(await totalRows()).toBe(before + 2);
    expect(completed[0]).toEqual({
      token_key: color, kind: 0, status: "observed",
      address, domain_sep: domainSep, color,
      // The height it was first SEEN stands: the colour existed before the mint reached the archive.
      first_seen_height: "500123",
      mint_count: "1", total_minted: "1000000", name: null,
    });
    expect(completed[1]).toMatchObject({ kind: 1, status: "seen", address: null, domain_sep: null });

    // The mint row itself is keyed by the contract, as it always was.
    const mints = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.token_mints
      WHERE net = ${NET} AND address = ${Buffer.from(address, "hex")}`;
    expect(mints[0]!.n).toBe("1");

    // A row that has a contract can never be `seen` again: the schema itself refuses it.
    await expect(sql`
      UPDATE ${sql(schema)}.tokens SET status = 'seen'
      WHERE net = ${NET} AND token_key = ${Buffer.from(color, "hex")} AND kind = 0
    `).rejects.toThrow(/tokens_seen_has_no_contract|violates check constraint/i);
  }, 180_000);
});
