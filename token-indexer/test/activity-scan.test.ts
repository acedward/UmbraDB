import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { loadLedgerV9 } from "../../chain-archive-sync/tx-replay-decoder.js";
import { bootstrapTokenIndexSchema, rebuildTokenIndex } from "../bootstrap.js";
import { NIGHT_COLOR_HEX, pad32, tokenColorHex } from "../color.js";
import type { ObservedMint } from "../ingest/decode.js";
import type { EventSource, IndexerContractEvent } from "../ingest/events.js";
import { applyMint, ensureSeenToken } from "../ingest/fold.js";
import { TokenScanner } from "../ingest/scan.js";
import { loadActivityFixtures, seedArchive, type ScanFixture } from "./helpers/archive-fixture.js";

/**
 * Project 00023, sub-plan 01 — the scanner's side of the activity index, on a real Postgres 17
 * through Testcontainers exactly as `scan.test.ts` does, over the four recorded Stagenet
 * transactions of `fixtures/activity/` and the real ledger-v9 WASM.
 *
 * This file owns the `seen` row (A1.4) and the scanner's rows, counters, idempotence and `rebuild`
 * equality (A3.2). Everything here runs against the real schema and the real fold — nothing about
 * the identity change or the activity rows is asserted against SQL text.
 */

const NET = "stagenet";

/** These contracts emit nothing the lookup can fetch; the source is asked (one of the fixtures has
 *  a `log` op) and answers honestly with nothing, which parks a `pending_event_lookups` row. */
class EmptyEventSource implements EventSource {
  calls = 0;
  async eventsFor(): Promise<IndexerContractEvent[]> {
    this.calls++;
    return [];
  }
}

interface GoldenRow {
  segment: number; section: string; role: string; itemIndex: number;
  color: string; kind: number; amount: string; direction: string;
  owner?: string; ownerKey?: string; intentHash?: string; outputNo?: number;
  address?: string; entryPoint?: string; callIndex?: number; domainSep?: string;
}

function goldenRows(label: string): GoldenRow[] {
  const file = new URL(`./fixtures/activity/${label}.rows.json`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as GoldenRow[];
}

const sortKey = (r: { segment: number; section: string; role: string; itemIndex: number }): string =>
  `${String(r.segment).padStart(6, "0")}|${r.section}|${r.role}|${String(r.itemIndex).padStart(4, "0")}`;

describe("activity rows, counters and seen tokens", () => {
  let container: StartedPostgreSqlContainer;
  let ledger: unknown;
  const open: UmbraDBSql[] = [];
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    ledger = await loadLedgerV9();
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

  function scanner(
    db: { sql: UmbraDBSql; schema: string; archiveSchema: string },
    eventSource: EventSource,
  ): TokenScanner {
    return new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET,
      eventSource, ledger, batchSize: 500,
    });
  }

  /** Every `token_activity` row of one transaction, in the goldens' own shape. */
  async function rowsOfTx(
    db: { sql: UmbraDBSql; schema: string }, txHash: string,
  ): Promise<GoldenRow[]> {
    const rows = await db.sql<{
      segment: number; section: string; role: string; item_index: number; color: Buffer;
      kind: number; amount: string; direction: string; owner: Buffer | null; owner_key: string | null;
      intent_hash: Buffer | null; output_no: number | null; address: Buffer | null;
      entry_point: string | null; call_index: number | null; domain_sep: Buffer | null;
    }[]>`
      SELECT segment, section, role, item_index, color, kind, amount::text, direction, owner,
             owner_key, intent_hash, output_no, address, entry_point, call_index, domain_sep
      FROM ${db.sql(db.schema)}.token_activity
      WHERE net = ${NET} AND tx_hash = ${Buffer.from(txHash, "hex")}
    `;
    return rows.map((r) => {
      const out: GoldenRow = {
        segment: r.segment, section: r.section, role: r.role, itemIndex: r.item_index,
        color: r.color.toString("hex"), kind: r.kind, amount: r.amount, direction: r.direction,
      };
      // The goldens omit a field that is absent rather than carrying an explicit null, because
      // `JSON.stringify` drops `undefined` — so the DB shape is folded the same way.
      if (r.owner !== null) out.owner = r.owner.toString("hex");
      if (r.owner_key !== null) out.ownerKey = r.owner_key;
      if (r.intent_hash !== null) out.intentHash = r.intent_hash.toString("hex");
      if (r.output_no !== null) out.outputNo = r.output_no;
      if (r.address !== null) out.address = r.address.toString("hex");
      if (r.entry_point !== null) out.entryPoint = r.entry_point;
      if (r.call_index !== null) out.callIndex = r.call_index;
      if (r.domain_sep !== null) out.domainSep = r.domain_sep.toString("hex");
      return out;
    }).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  }

  /** Everything `rebuild` must reproduce, as one comparable document (FR-005). */
  async function dump(db: { sql: UmbraDBSql; schema: string }): Promise<string> {
    const s = db.sql;
    const parts: unknown[] = [];
    parts.push(await s`
      SELECT encode(token_key,'hex') AS token_key, kind, encode(address,'hex') AS address,
             encode(domain_sep,'hex') AS domain_sep, encode(color,'hex') AS color, name, symbol,
             decimals, token_uri, metadata, status, mint_count::text, total_minted::text,
             first_mint_height::text, last_mint_height::text, first_seen_height::text
      FROM ${s(db.schema)}.tokens WHERE net = ${NET} ORDER BY token_key, kind`);
    parts.push(await s`
      SELECT encode(tx_hash,'hex') AS tx_hash, block_height::text, tx_position, segment, section,
             role, item_index, encode(color,'hex') AS color, kind, amount::text, direction,
             encode(owner,'hex') AS owner, owner_key, encode(intent_hash,'hex') AS intent_hash,
             output_no, encode(address,'hex') AS address, entry_point, call_index,
             encode(domain_sep,'hex') AS domain_sep
      FROM ${s(db.schema)}.token_activity WHERE net = ${NET}
      ORDER BY block_height, tx_hash, segment, section, role, item_index`);
    parts.push(await s`
      SELECT encode(tx_hash,'hex') AS tx_hash, section, segment, block_height::text, tx_position,
             inputs, outputs, transients, deltas, undisclosed, counted
      FROM ${s(db.schema)}.shielded_offers WHERE net = ${NET}
      ORDER BY block_height, tx_hash, section, segment`);
    parts.push(await s`
      SELECT encode(tx_hash,'hex') AS tx_hash, segment, call_index, encode(address,'hex') AS address,
             entry_point, block_height::text, tx_position, guaranteed, fallible
      FROM ${s(db.schema)}.contract_calls WHERE net = ${NET}
      ORDER BY block_height, tx_hash, segment, call_index`);
    return JSON.stringify(parts, null, 1);
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

  it("[[token-activity-scan-rows]] the four recorded transactions produce exactly the golden rows, offers, calls and seen tokens", async () => {
    const db = await freshDb();
    const fixtures = loadActivityFixtures();
    expect(fixtures.map((f) => f.label)).toEqual([
      "shielded-mint-delta", "balanced-offer-contract", "night-passthrough", "deposit-toMap",
    ]);
    await seedArchive(db.sql, db.archiveSchema, NET, fixtures);

    const events = new EmptyEventSource();
    const outcome = await scanner(db, events).scanOnce();

    expect(outcome.transactionsScanned).toBe(4);
    // deposit-toMap 2 + night-passthrough 4 + shielded-mint-delta 2 + balanced-offer-contract 0.
    expect(outcome.activityRows).toBe(8);
    // One zswap offer in the mint, one in the balanced deposit; the balanced one is undisclosed.
    expect(outcome.shieldedOffers).toBe(2);
    expect(outcome.undisclosedShieldedOffers).toBe(1);
    expect(outcome.contractCalls).toBe(4);
    expect(outcome.mints).toBe(1);
    // Exactly ONE colour in this set has no row of its own: `254fc193…`, whose mint predates the
    // archive. NIGHT already has its built-in row, and the shielded mint creates its own.
    expect(outcome.seenTokens).toBe(1);
    // The one call with a `log` op really did make the scanner ask the indexer (deposit-toMap).
    expect(events.calls).toBe(1);

    // --- rows, per transaction, against the goldens the decoder test pinned -------------------
    for (const fixture of fixtures) {
      const expected = goldenRows(fixture.label).slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      expect(await rowsOfTx(db, fixture.transaction.hash), fixture.label).toEqual(expected);
    }

    // --- the seen row, and the rows that resolve through it ----------------------------------
    const DEPOSIT_COLOR = "254fc19366d929e7a5813f04a89fbc68195046f5261428e721e5d16daca8bc47";
    const seen = await db.sql<{ token_key: Buffer; status: string; address: Buffer | null; first_seen_height: string }[]>`
      SELECT token_key, status, address, first_seen_height::text FROM ${db.sql(db.schema)}.tokens
      WHERE net = ${NET} AND status = 'seen'`;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.token_key.toString("hex")).toBe(DEPOSIT_COLOR);
    expect(seen[0]!.address).toBeNull();
    expect(seen[0]!.first_seen_height).toBe("500750");

    // NIGHT's four rows resolve to the BUILT-IN row, not to a new `seen` one.
    const night = await db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${db.sql(db.schema)}.token_activity
      WHERE net = ${NET} AND color = ${Buffer.from(NIGHT_COLOR_HEX, "hex")}`;
    expect(night[0]!.n).toBe("4");
    // …and the shielded mint's colour became an `observed` row through the mint itself.
    const minted = await db.sql<{ status: string; address: Buffer }[]>`
      SELECT status, address FROM ${db.sql(db.schema)}.tokens
      WHERE net = ${NET} AND token_key = ${Buffer.from("d086a9e29154d03f507a589c89ea61a453f444c2881b8d0d88192f2965fa2cea", "hex")}`;
    expect(minted).toHaveLength(1);
    expect(minted[0]!.status).toBe("observed");
    expect(minted[0]!.address.toString("hex")).toBe("4fc92e152e8d854ef9337275504244e18bd6e3d7d41fd81ed2dabf62be78e92f");

    // --- every activity row resolves to a token row: SC-009, on this fixture set -------------
    const unresolved = await db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${db.sql(db.schema)}.token_activity a
      LEFT JOIN ${db.sql(db.schema)}.tokens t
        ON t.net = a.net AND t.token_key = a.color AND t.kind = a.kind
      WHERE a.net = ${NET} AND t.token_key IS NULL`;
    expect(unresolved[0]!.n).toBe("0");

    // --- offers and calls --------------------------------------------------------------------
    const offers = await db.sql<{
      tx_hash: Buffer; inputs: number; outputs: number; transients: number; deltas: number;
      undisclosed: boolean; counted: boolean;
    }[]>`
      SELECT tx_hash, inputs, outputs, transients, deltas, undisclosed, counted
      FROM ${db.sql(db.schema)}.shielded_offers WHERE net = ${NET} ORDER BY block_height`;
    expect(offers.map((o) => [o.inputs, o.outputs, o.transients, o.deltas, o.undisclosed, o.counted])).toEqual([
      [0, 1, 0, 1, false, true],  // the mint: one delta, so the colour IS public
      [2, 1, 1, 0, true, true],   // the balanced deposit: no delta at all, so it is not
    ]);
    const calls = await db.sql<{ entry_point: string; guaranteed: unknown; fallible: unknown }[]>`
      SELECT entry_point, guaranteed, fallible FROM ${db.sql(db.schema)}.contract_calls
      WHERE net = ${NET} ORDER BY block_height`;
    expect(calls.map((c) => c.entry_point)).toEqual([
      "mint_shielded", "deposit_shielded", "register_domain_for", "toMap",
    ]);
    expect(calls[3]!.guaranteed).toBeNull();
    expect(calls[3]!.fallible).toMatchObject({ ops: 62, logOps: 1, counted: true });
  }, 300_000);

  it("[[token-activity-counting]] a failed transaction produces no activity row, a failed fallible segment drops only its own rows, and the offer and the call are still recorded and marked uncounted", async () => {
    const db = await freshDb();
    const fixtures = loadActivityFixtures();
    // `deposit-toMap` carries its rows in a FALLIBLE section (segment 63196); `shielded-mint-delta`
    // carries both of its rows in GUARANTEED ones. Failing every fixture's own segment therefore
    // separates the two rules in one batch.
    const failedSegment = (f: ScanFixture): { id: number; success: boolean }[] =>
      f.label === "deposit-toMap" ? [{ id: 63196, success: false }, { id: 1, success: true }]
        : f.label === "night-passthrough" ? [{ id: 15274, success: false }, { id: 1, success: true }]
          : [{ id: 40256, success: false }, { id: 25074, success: false }, { id: 1, success: true }];
    await seedArchive(db.sql, db.archiveSchema, NET, fixtures, {
      resultOverride: (f) => f.label === "balanced-offer-contract"
        // The whole transaction failed: not even its guaranteed section counts.
        ? { result: "failure", segments: null }
        : { result: "partial_success", segments: failedSegment(f) },
    });

    const outcome = await scanner(db, new EmptyEventSource()).scanOnce();
    expect(outcome.transactionsScanned).toBe(4);

    // The two fallible-carried transactions lost every row; the guaranteed-carried one kept both.
    expect(await rowsOfTx(db, loadActivityFixtures().find((f) => f.label === "deposit-toMap")!.transaction.hash))
      .toEqual([]);
    expect(await rowsOfTx(db, loadActivityFixtures().find((f) => f.label === "night-passthrough")!.transaction.hash))
      .toEqual([]);
    const mintRows = await rowsOfTx(db, loadActivityFixtures().find((f) => f.label === "shielded-mint-delta")!.transaction.hash);
    // The transaction-level guaranteed offer sits at segment 0; the mint is in intent 40256.
    expect(mintRows.map((r) => [r.role, r.section, r.amount, r.segment])).toEqual([
      ["shielded_delta", "guaranteed", "1", 0],
      ["mint", "guaranteed", "1", 40256],
    ]);
    expect(outcome.activityRows).toBe(2);
    // A guaranteed mint in a partially failed transaction still counts (FR-002), so `token_mints`
    // keeps it too — the two lists agree.
    expect(outcome.mints).toBe(1);

    // The offer of the FAILED transaction is still recorded — the privacy figure is about what the
    // chain carries — and it is marked uncounted.
    const offers = await db.sql<{ counted: boolean; undisclosed: boolean; deltas: number }[]>`
      SELECT counted, undisclosed, deltas FROM ${db.sql(db.schema)}.shielded_offers
      WHERE net = ${NET} ORDER BY block_height`;
    expect(offers).toHaveLength(2);
    expect(offers.map((o) => [o.counted, o.undisclosed])).toEqual([[true, false], [false, true]]);
    expect(outcome.shieldedOffers).toBe(2);

    // Every call is recorded, each transcript carrying whether its own section counted (US7's rule:
    // this table is introspection, not attribution).
    const calls = await db.sql<{ entry_point: string; guaranteed: { counted: boolean } | null; fallible: { counted: boolean } | null }[]>`
      SELECT entry_point, guaranteed, fallible FROM ${db.sql(db.schema)}.contract_calls
      WHERE net = ${NET} ORDER BY block_height`;
    expect(calls.map((c) => [c.entry_point, c.guaranteed?.counted ?? null, c.fallible?.counted ?? null])).toEqual([
      ["mint_shielded", true, null],        // partial_success: the guaranteed section counts
      ["deposit_shielded", false, null],    // whole transaction failed
      ["register_domain_for", null, false], // its segment failed
      ["toMap", null, false],
    ]);
    expect(outcome.contractCalls).toBe(4);

    // No row was written for a colour nobody counted: the only `seen` token is the one the surviving
    // guaranteed rows needed — and that one is `observed`, because its mint counted.
    const statuses = await db.sql<{ status: string; n: string }[]>`
      SELECT status, count(*)::text AS n FROM ${db.sql(db.schema)}.tokens
      WHERE net = ${NET} GROUP BY status ORDER BY status`;
    expect(statuses.map((s) => [s.status, s.n])).toEqual([["builtin", "2"], ["observed", "1"]]);
    expect(outcome.seenTokens).toBe(0);
  }, 300_000);

  it("[[token-activity-idempotent]] a second scan of the same archive changes no row and reports no new one", async () => {
    const db = await freshDb();
    await seedArchive(db.sql, db.archiveSchema, NET, loadActivityFixtures());

    const scan = scanner(db, new EmptyEventSource());
    const first = await scan.scanOnce();
    expect(first.activityRows).toBe(8);
    const before = await dump(db);

    // Rewind the cursor so the very same transactions are decoded and written again — which is
    // exactly what a crash mid-batch, or a restart, makes the scanner do (FR-004).
    await db.sql`DELETE FROM ${db.sql(db.schema)}.cursors WHERE net = ${NET}`;
    const second = await scanner(db, new EmptyEventSource()).scanOnce();
    expect(second.transactionsScanned).toBe(4);
    expect({
      activityRows: second.activityRows, shieldedOffers: second.shieldedOffers,
      undisclosedShieldedOffers: second.undisclosedShieldedOffers,
      contractCalls: second.contractCalls, seenTokens: second.seenTokens, mints: second.mints,
    }).toEqual({
      activityRows: 0, shieldedOffers: 0, undisclosedShieldedOffers: 0,
      contractCalls: 0, seenTokens: 0, mints: 0,
    });
    expect(await dump(db)).toBe(before);

    // …and a third scan from the tip is a no-op that does not even read a transaction.
    const third = await scanner(db, new EmptyEventSource()).scanOnce();
    expect(third.transactionsScanned).toBe(0);
    expect(await dump(db)).toBe(before);
  }, 300_000);

  it("[[token-activity-rebuild-equal]] rebuild plus a re-scan reproduces the tokens, the activity rows, the offers and the calls exactly", async () => {
    const db = await freshDb();
    await seedArchive(db.sql, db.archiveSchema, NET, loadActivityFixtures());

    await scanner(db, new EmptyEventSource()).scanOnce();
    const live = await dump(db);
    expect(live).toContain("token_key");

    // `rebuild` empties every derived row of this net — the three new tables included — and
    // re-seeds the built-ins; the scanner then refills from block zero of the archive.
    await rebuildTokenIndex(db.sql, { schema: db.schema, net: NET });
    const emptied = await db.sql<{ activity: string; offers: string; calls: string; tokens: string }[]>`
      SELECT (SELECT count(*)::text FROM ${db.sql(db.schema)}.token_activity  WHERE net = ${NET}) AS activity,
             (SELECT count(*)::text FROM ${db.sql(db.schema)}.shielded_offers WHERE net = ${NET}) AS offers,
             (SELECT count(*)::text FROM ${db.sql(db.schema)}.contract_calls  WHERE net = ${NET}) AS calls,
             (SELECT count(*)::text FROM ${db.sql(db.schema)}.tokens          WHERE net = ${NET}) AS tokens`;
    expect(emptied[0]).toEqual({ activity: "0", offers: "0", calls: "0", tokens: "2" });

    const rebuilt = await scanner(db, new EmptyEventSource()).scanOnce();
    expect(rebuilt.transactionsScanned).toBe(4);
    expect(rebuilt.activityRows).toBe(8);
    expect(rebuilt.seenTokens).toBe(1);
    // FR-005: byte-equal, not merely equivalent.
    expect(await dump(db)).toBe(live);
  }, 300_000);
});

