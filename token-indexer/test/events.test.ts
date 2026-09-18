import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import {
  IndexerEventSource,
  UnexpectedEventCountError,
  drainPendingLookups,
  lookupBackoffMs,
  lookupEventsFor,
  type EventSource,
  type IndexerContractEvent,
} from "../ingest/events.js";
import {
  TOKEN_METADATA_NAME_HEX, encodeInteger, isTokenMetadataName, parseTokenMetadata,
} from "../ingest/payload.js";
import { TokenScanner } from "../ingest/scan.js";
import { readDecodeCursor } from "../ingest/store.js";
import { seedSyntheticTransaction } from "./helpers/synthetic-archive.js";
import { fakeLedger, metadataPayloadHex } from "./helpers/fake-ledger.js";
import { startFakeEventIndexer, type FakeEventIndexer } from "./helpers/fake-event-indexer.js";

/**
 * Project 00020, sub-plan 01 Phase 5 — `[[token-event-lookup]]`.
 *
 * The event source under test is the REAL `IndexerEventSource` talking to a REAL HTTP server on an
 * ephemeral port; only the chain side is synthetic, and only because it has to be: no contract on
 * Stagenet emits a `TokenMetadata` event yet, and forging proven transaction bytes is impossible.
 * `scan.test.ts` covers the mint half on real recorded bytes.
 */

const NET = "stagenet";
const ADDRESS = "a1".repeat(32);
const TX = "b2".repeat(32);
const DOMAIN = Buffer.from(pad32("umbra:sstar")).toString("hex");
const KIND_SHIELDED_NATIVE = 1;

describe("token metadata event lookup", () => {
  let container: StartedPostgreSqlContainer;
  let indexer: FakeEventIndexer;
  const open: UmbraDBSql[] = [];
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    indexer = await startFakeEventIndexer();
  }, 180_000);

  afterAll(async () => {
    while (open.length > 0) await open.pop()!.end({ timeout: 5 });
    await indexer?.close();
    await container?.stop();
  }, 60_000);

  afterEach(() => {
    indexer.events.clear();
    indexer.requests.length = 0;
    indexer.failNext = 0;
  });

  async function freshDb(): Promise<{ sql: UmbraDBSql; schema: string; archiveSchema: string }> {
    const id = counter++;
    const schema = `token_events_${id}`;
    const archiveSchema = `arch_events_${id}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    open.push(sql);
    await bootstrapChainArchiveSchema(sql, archiveSchema);
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    return { sql, schema, archiveSchema };
  }

  function source(): EventSource {
    return new IndexerEventSource({ url: indexer.url, pageSize: 500 });
  }

  function metadataEvent(
    id: number, key: string, value: string | Uint8Array,
    opts: { valType?: number; valLen?: number; nameHex?: string } = {},
  ): {
    id: number; contractAddress: string; txHash: string; blockHeight: number; nameHex: string; payloadHex: string;
  } {
    return {
      id, contractAddress: ADDRESS, txHash: TX, blockHeight: 100,
      nameHex: opts.nameHex ?? TOKEN_METADATA_NAME_HEX,
      payloadHex: metadataPayloadHex({
        domainSep: DOMAIN, kindByte: KIND_SHIELDED_NATIVE, key, value,
        valType: opts.valType, valLen: opts.valLen,
      }),
    };
  }

  it("[[token-event-lookup]] a short answer queues the pair with backoff and lets the scan go on; the drain completes it; the end state equals a one-shot run", async () => {
    const complete = [
      metadataEvent(1, "name", "Shielded Star"),
      metadataEvent(2, "symbol", "SSTAR"),
      metadataEvent(3, "decimals", encodeInteger(6), { valType: 2 }),
    ];

    // --- the short-then-complete run --------------------------------------------------------
    const db = await freshDb();
    indexer.events.set(`${TX}:${ADDRESS}`, complete.slice(0, 1)); // only the first event exists yet
    await seedSyntheticTransaction(db.sql, db.archiveSchema, NET, { txHash: TX, blockHeight: 100 });
    const scanner = new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET,
      eventSource: source(),
      ledger: fakeLedger({ calls: [{ address: ADDRESS, entryPoint: "publishMetadata", guaranteed: { logOps: 3 } }] }),
    });

    const first = await scanner.scanOnce();
    expect(first.lookups).toBe(1);
    expect(first.lookupsShort).toBe(1);
    expect(first.eventsApplied).toBe(1);
    // The scan cursor MOVED ON even though the lookup was short — one slow transaction must never
    // stall the scanner.
    expect(await readDecodeCursor(db.sql, db.schema, NET)).toEqual({ height: 100, position: 0 });

    const pending = await db.sql<{ expected_events: number; got_events: number; attempts: number }[]>`
      SELECT expected_events, got_events, attempts FROM ${db.sql(db.schema)}.pending_event_lookups WHERE net = ${NET}`;
    expect(pending).toEqual([{ expected_events: 3, got_events: 1, attempts: 1 }]);

    // The row is not due yet, so a drain right now does nothing.
    expect(await drainPendingLookups(db.sql, db.schema, NET, source())).toMatchObject({ attempted: 0 });

    // The indexer catches up; make the row due and drain.
    indexer.events.set(`${TX}:${ADDRESS}`, complete);
    await db.sql`UPDATE ${db.sql(db.schema)}.pending_event_lookups SET next_attempt_at = now() - interval '1 second' WHERE net = ${NET}`;
    const drained = await drainPendingLookups(db.sql, db.schema, NET, source());
    expect(drained).toMatchObject({ attempted: 1, completed: 1, stillShort: 0, applied: 2 });
    expect(await db.sql`SELECT * FROM ${db.sql(db.schema)}.pending_event_lookups WHERE net = ${NET}`).toHaveLength(0);

    const retried = await tokenRow(db);
    expect(retried).toMatchObject({
      name: "Shielded Star", symbol: "SSTAR", decimals: 6, status: "declared",
      kind: 1, privacy: "shielded", storage: "native",
    });
    expect(retried.color).toBe(tokenColorHex(DOMAIN, ADDRESS));

    // --- the one-shot reference run ---------------------------------------------------------
    const ref = await freshDb();
    indexer.events.set(`${TX}:${ADDRESS}`, complete);
    await seedSyntheticTransaction(ref.sql, ref.archiveSchema, NET, { txHash: TX, blockHeight: 100 });
    const refScanner = new TokenScanner({
      sql: ref.sql, schema: ref.schema, archiveSchema: ref.archiveSchema, net: NET,
      eventSource: source(),
      ledger: fakeLedger({ calls: [{ address: ADDRESS, entryPoint: "publishMetadata", guaranteed: { logOps: 3 } }] }),
    });
    const oneShot = await refScanner.scanOnce();
    expect(oneShot).toMatchObject({ lookups: 1, lookupsShort: 0, eventsApplied: 3 });
    expect(await tokenRow(ref)).toEqual(retried);

    // --- a duplicated delivery changes nothing ----------------------------------------------
    indexer.events.set(`${TX}:${ADDRESS}`, [...complete]);
    const again = await lookupOnce(ref, source());
    expect(again).toMatchObject({ got: 3, short: false, applied: 0 }); // already stored, nothing re-applied
    expect(await tokenRow(ref)).toEqual(retried);
    const eventCount = await ref.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${ref.sql(ref.schema)}.token_metadata_events WHERE net = ${NET}`;
    expect(eventCount[0]!.n).toBe("3");
  }, 300_000);

  it("[[token-event-overcount]] MORE events than log ops is a hard error, and it aborts the whole scan batch", async () => {
    const db = await freshDb();
    indexer.events.set(`${TX}:${ADDRESS}`, [metadataEvent(10, "name", "A"), metadataEvent(11, "symbol", "B")]);
    await seedSyntheticTransaction(db.sql, db.archiveSchema, NET, { txHash: TX, blockHeight: 100 });
    const scanner = new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET,
      eventSource: source(),
      ledger: fakeLedger({ calls: [{ address: ADDRESS, guaranteed: { logOps: 1 } }] }), // only ONE log op
    });
    await expect(scanner.scanOnce()).rejects.toThrow(UnexpectedEventCountError);
    // Nothing was committed and the cursor did not move.
    const state = await db.sql<{ tokens: string; events: string; cursors: string }[]>`
      SELECT (SELECT count(*)::text FROM ${db.sql(db.schema)}.tokens WHERE net = ${NET} AND status <> 'builtin') AS tokens,
             (SELECT count(*)::text FROM ${db.sql(db.schema)}.token_metadata_events WHERE net = ${NET}) AS events,
             (SELECT count(*)::text FROM ${db.sql(db.schema)}.cursors WHERE net = ${NET}) AS cursors`;
    expect(state[0]).toEqual({ tokens: "0", events: "0", cursors: "0" });
  }, 180_000);

  it("[[token-event-retry-budget]] a transport failure during the drain keeps the pair queued with its error, and the queue gives up loudly rather than looping forever", async () => {
    const db = await freshDb();
    indexer.events.set(`${TX}:${ADDRESS}`, [metadataEvent(20, "name", "A")]);
    await seedSyntheticTransaction(db.sql, db.archiveSchema, NET, { txHash: TX, blockHeight: 100 });
    const scanner = new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET,
      eventSource: source(),
      ledger: fakeLedger({ calls: [{ address: ADDRESS, guaranteed: { logOps: 2 } }] }),
    });
    await scanner.scanOnce();

    indexer.failNext = 1;
    await db.sql`UPDATE ${db.sql(db.schema)}.pending_event_lookups SET next_attempt_at = now() - interval '1 second' WHERE net = ${NET}`;
    const drained = await drainPendingLookups(db.sql, db.schema, NET, source());
    expect(drained).toMatchObject({ attempted: 1, completed: 0, stillShort: 1 });
    const row = await db.sql<{ attempts: number; last_error: string | null }[]>`
      SELECT attempts, last_error FROM ${db.sql(db.schema)}.pending_event_lookups WHERE net = ${NET}`;
    expect(row[0]!.attempts).toBe(2);
    expect(row[0]!.last_error).toMatch(/contractEvents HTTP 503/);

    // Exhausted rows are left visible, not deleted and not retried.
    await db.sql`UPDATE ${db.sql(db.schema)}.pending_event_lookups SET attempts = 30, next_attempt_at = now() - interval '1 second' WHERE net = ${NET}`;
    expect(await drainPendingLookups(db.sql, db.schema, NET, source())).toMatchObject({ attempted: 0 });
    expect(await db.sql`SELECT 1 FROM ${db.sql(db.schema)}.pending_event_lookups WHERE net = ${NET}`).toHaveLength(1);

    // The backoff schedule is the documented one: 1 s doubling to a 60 s ceiling.
    expect([1, 2, 3, 4, 10, 20].map(lookupBackoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 60_000, 60_000]);
  }, 180_000);

  it("[[token-event-filtering]] events of other types and other names are counted but never stored, and paging fetches everything", async () => {
    const db = await freshDb();
    const many = [
      { ...metadataEvent(30, "name", "Paged"), typename: "MiscContractEvent" },
      { id: 31, typename: "ShieldedMintEvent", contractAddress: ADDRESS, txHash: TX, blockHeight: 100 },
      {
        id: 32, typename: "MiscContractEvent", contractAddress: ADDRESS, txHash: TX, blockHeight: 100,
        nameHex: Buffer.from(pad32("SomethingElse")).toString("hex"),
        payloadHex: metadataPayloadHex({ domainSep: DOMAIN, kindByte: 1, key: "name", value: "ignored" }),
      },
    ];
    indexer.events.set(`${TX}:${ADDRESS}`, many);
    await seedSyntheticTransaction(db.sql, db.archiveSchema, NET, { txHash: TX, blockHeight: 100 });

    // pageSize 2 forces a second request, proving the paging loop.
    const pagedSource = new IndexerEventSource({ url: indexer.url, pageSize: 2 });
    const scanner = new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET,
      eventSource: pagedSource,
      ledger: fakeLedger({ calls: [{ address: ADDRESS, guaranteed: { logOps: 3 } }] }),
    });
    const outcome = await scanner.scanOnce();
    expect(outcome).toMatchObject({ lookups: 1, lookupsShort: 0, eventsApplied: 1 });
    expect(indexer.requests.filter((r) => r.offset === 2)).toHaveLength(1);

    const stored = await db.sql<{ event_id: string }[]>`
      SELECT event_id::text FROM ${db.sql(db.schema)}.token_metadata_events WHERE net = ${NET}`;
    expect(stored.map((r) => r.event_id)).toEqual(["30"]);
    expect((await tokenRow(db)).name).toBe("Paged");
  }, 180_000);

  it("[[token-legacy-name-ignored]] an event under the pre-MIP name `TokenMetadata` is IGNORED — counted, never stored, never rejected (MIP §1)", async () => {
    const db = await freshDb();
    // The very same payload bytes under two names. Only the name differs, and only the name decides.
    const legacyNameHex = Buffer.from(pad32("TokenMetadata")).toString("hex");
    const legacy = metadataEvent(40, "name", "Old Name", { nameHex: legacyNameHex });
    const current = metadataEvent(41, "name", "New Name");
    indexer.events.set(`${TX}:${ADDRESS}`, [legacy, current]);
    await seedSyntheticTransaction(db.sql, db.archiveSchema, NET, { txHash: TX, blockHeight: 100 });

    const scanner = new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET,
      eventSource: source(),
      // TWO log ops: the transcript counts the legacy emission as well, because the VM ran it. The
      // count assertion is about `log` ops, not about names.
      ledger: fakeLedger({ calls: [{ address: ADDRESS, entryPoint: "publishMetadata", guaranteed: { logOps: 2 } }] }),
    });
    const outcome = await scanner.scanOnce();
    // Counted (so the lookup is COMPLETE, not short) and applied exactly once.
    expect(outcome).toMatchObject({ lookups: 1, lookupsShort: 0, eventsApplied: 1, eventsRejected: 0 });

    // Not stored: an ignored event is not evidence of anything, and in particular is NOT a rejection
    // — `/internal/status`'s rejected counter must stay at zero.
    const stored = await db.sql<{ event_id: string }[]>`
      SELECT event_id::text FROM ${db.sql(db.schema)}.token_metadata_events WHERE net = ${NET} ORDER BY event_id`;
    expect(stored.map((r) => r.event_id)).toEqual(["41"]);
    expect(await tokenRow(db)).toMatchObject({ name: "New Name", status: "declared" });

    // …and the bytes themselves were perfectly valid, which is what makes this a NAME decision:
    // the parser would have applied them had the event carried this MIP's name.
    const parsed = parseTokenMetadata(new Uint8Array(Buffer.from(legacy.payloadHex, "hex")));
    expect(parsed.applied).toBe(true);
    expect(parsed.valueText).toBe("Old Name");
    expect(isTokenMetadataName(legacyNameHex)).toBe(false);
    expect(isTokenMetadataName(TOKEN_METADATA_NAME_HEX)).toBe(true);
  }, 180_000);

  async function lookupOnce(
    db: { sql: UmbraDBSql; schema: string }, eventSource: EventSource,
  ): ReturnType<typeof lookupEventsFor> {
    return db.sql.begin(async (tx) =>
      lookupEventsFor(tx, db.schema, NET, eventSource, { txHash: TX, address: ADDRESS, blockHeight: 100, expected: 3 }));
  }

  async function tokenRow(db: { sql: UmbraDBSql; schema: string }): Promise<{
    name: string | null; symbol: string | null; decimals: number | null; status: string;
    privacy: string; storage: string; color: string | null; kind: number;
  }> {
    const rows = await db.sql<{
      name: string | null; symbol: string | null; decimals: number | null; status: string;
      privacy: string; storage: string; color: Buffer | null; kind: number;
    }[]>`
      SELECT name, symbol, decimals, status, privacy, storage, color, kind FROM ${db.sql(db.schema)}.tokens
      WHERE net = ${NET} AND status <> 'builtin'`;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    return { ...row, color: row.color === null ? null : row.color.toString("hex") };
  }
});

/** Silences the unused-import lint for a type only referenced in a generic position. */
export type _EventShape = IndexerContractEvent;
