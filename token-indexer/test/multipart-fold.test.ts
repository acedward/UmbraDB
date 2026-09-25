import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32 } from "../color.js";
import { IndexerEventSource } from "../ingest/events.js";
import { applyMetadataEvent, type PackagePhase, type RawContractEvent } from "../ingest/fold.js";
import { MIP_0018_NAME_HEX, encodeTokenMetadataUc1, splitIntoParts } from "../ingest/payload.js";
import { TokenScanner } from "../ingest/scan.js";
import { startFakeEventIndexer, type FakeEventIndexer } from "./helpers/fake-event-indexer.js";
import { fakeLedgerPerTransaction, fakeRawEvent } from "./helpers/fake-ledger.js";
import { seedSyntheticTransaction } from "./helpers/synthetic-archive.js";

/**
 * Project 00024-01 task B5 — the fold on packages: last write wins per `(contract, domainSep, kind,
 * key)` in MIP-0018 §6.2's canonical order — block, transaction position, ledger execution order —
 * with a [Y] package positioned by its FIRST part (derivation P1, `spec/00024-upstream-spec-changes.md`).
 *
 * Each case is built so the rule under test gives a DIFFERENT answer from the tempting wrong one
 * (the last part, the arrival order, the raw event id), and each is replayed in more than one
 * arrival order, because a pending lookup drained later is how a real indexer meets the fold.
 */

const NET = "undeployed";
const CONTRACT = "d1".repeat(32);
const DOMAIN = Buffer.from(pad32("umbra:lmoon18"));
const KIND_LEDGER = 2;

/** A MIP-0018 declaration of `description`, as its merged package payload. */
const declaration = (value: string | Uint8Array, valType = 1): Buffer =>
  Buffer.from(encodeTokenMetadataUc1({ domainSep: new Uint8Array(DOMAIN), kindByte: KIND_LEDGER, key: "description", valType, value }));

describe("the fold on [Y] packages — MIP-0018 §6.2 order, P1", () => {
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

  afterEach(() => { indexer.events.clear(); indexer.requests.length = 0; });

  async function freshDb(): Promise<{ sql: UmbraDBSql; schema: string; archiveSchema: string }> {
    const id = counter++;
    const schema = `token_mpf_${id}`;
    const archiveSchema = `arch_mpf_${id}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    open.push(sql);
    await bootstrapChainArchiveSchema(sql, archiveSchema);
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    return { sql, schema, archiveSchema };
  }

  /** One package folded directly, as the lookup would fold it. */
  async function fold(
    db: { sql: UmbraDBSql; schema: string },
    pkg: { ids: number[]; payload: Buffer; height: number; position: number; tx: string; segment: number; phase: PackagePhase },
  ): Promise<void> {
    const event: RawContractEvent = {
      eventId: pkg.ids[0]!, partEventIds: pkg.ids, contractAddress: CONTRACT, txHash: pkg.tx,
      blockHeight: pkg.height, txPosition: pkg.position, nameHex: MIP_0018_NAME_HEX,
      payloadHex: pkg.payload.toString("hex"), segment: pkg.segment, phase: pkg.phase,
    };
    const outcome = await db.sql.begin(async (tx) => applyMetadataEvent(tx, db.schema, NET, event));
    expect(outcome.applied, `package ${pkg.ids.join(",")}`).toBe(true);
  }

  async function current(db: { sql: UmbraDBSql; schema: string }) {
    const rows = await db.sql<{ value: Buffer; val_type: number; updated_event_id: string; updated_height: string; updated_tx_position: number }[]>`
      SELECT value, val_type, updated_event_id::text, updated_height::text, updated_tx_position
      FROM ${db.sql(db.schema)}.token_metadata_kv WHERE net = ${NET} AND key_text = 'description'`;
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    return {
      text: r.value.toString("utf8"), valType: r.val_type, eventId: Number(r.updated_event_id),
      height: Number(r.updated_height), position: r.updated_tx_position,
    };
  }

  async function history(db: { sql: UmbraDBSql; schema: string }) {
    return (await db.sql<{ part_event_ids: string[]; phase: string }[]>`
      SELECT part_event_ids::text[] AS part_event_ids, phase FROM ${db.sql(db.schema)}.token_metadata_events
      WHERE net = ${NET} ORDER BY block_height, tx_position, event_id`)
      .map((r) => ({ ids: r.part_event_ids.map(Number), phase: r.phase }));
  }

  it("[[multipart-p1-first-part]] packages are positioned by their FIRST part in block, transaction-position, execution order: interleaved packages in one transaction, two transactions of one block, and every arrival order give the same winner", async () => {
    const P = "P".repeat(300); // 2 parts
    const Q = "Q".repeat(300); // 2 parts
    const pPayload = declaration(P);
    const qPayload = declaration(Q);
    const [p1, p2] = splitIntoParts(pPayload).map((b) => Buffer.from(b));
    const [q1, q2] = splitIntoParts(qPayload).map((b) => Buffer.from(b));
    const TX = "e1".repeat(32);

    // ── (a) interleaved in ONE transaction, through the scanner ─────────────────────────────
    // P is mixed-phase in intent 7 (a guaranteed part, then a fallible one — the only way two
    // packages' parts can interleave, since the ledger runs every intent's guaranteed part first);
    // Q is guaranteed in intent 8. Ledger emission order: P1 (10), Q1 (11), Q2 (12), P2 (13).
    //   first part:  P @10 < Q @11  → Q is the later declaration → Q wins   (P1)
    //   last part:   P @13 > Q @12  → P would win                           (wrong)
    const scanned = await freshDb();
    await seedSyntheticTransaction(scanned.sql, scanned.archiveSchema, NET, { txHash: TX, blockHeight: 500, marker: TX });
    const raw = (id: number, segment: number, payload: Buffer) => ({
      id, contractAddress: CONTRACT, txHash: TX, blockHeight: 500, nameHex: MIP_0018_NAME_HEX,
      payloadHex: payload.toString("hex"),
      rawHex: fakeRawEvent({ txHash: TX, segment, address: CONTRACT, nameHex: MIP_0018_NAME_HEX, payloadHex: payload.toString("hex") }),
    });
    // Delivered in a scrambled order: the reader orders by event id, never by delivery.
    indexer.events.set(`${TX}:${CONTRACT}`, [raw(13, 7, p2!), raw(11, 8, q1!), raw(10, 7, p1!), raw(12, 8, q2!)]);
    const scanner = new TokenScanner({
      sql: scanned.sql, schema: scanned.schema, archiveSchema: scanned.archiveSchema, net: NET,
      eventSource: new IndexerEventSource({ url: indexer.url }),
      ledger: fakeLedgerPerTransaction({
        [TX]: {
          calls: [
            { address: CONTRACT, entryPoint: "publishDescription", segment: 7, guaranteed: { logOps: 1 }, fallible: { logOps: 1 } },
            { address: CONTRACT, entryPoint: "publishDescription", segment: 8, guaranteed: { logOps: 2 } },
          ],
        },
      }),
    });
    expect(await scanner.scanOnce()).toMatchObject({ lookups: 1, lookupsShort: 0, eventsApplied: 2 });
    expect(await history(scanned)).toEqual([
      { ids: [10, 13], phase: "mixed" }, // P: recorded, applied, flagged — and superseded
      { ids: [11, 12], phase: "guaranteed" },
    ]);
    expect(await current(scanned)).toMatchObject({ text: Q, eventId: 11, height: 500, position: 0 });

    // …and in the OTHER arrival order (Q folded before P, as a drained retry would) the answer is
    // the same: P's position (500, 0, 10) is earlier than Q's (500, 0, 11), so it never overwrites.
    const reversed = await freshDb();
    await fold(reversed, { ids: [11, 12], payload: qPayload, height: 500, position: 0, tx: TX, segment: 8, phase: "guaranteed" });
    await fold(reversed, { ids: [10, 13], payload: pPayload, height: 500, position: 0, tx: TX, segment: 7, phase: "mixed" });
    expect(await current(reversed)).toMatchObject({ text: Q, eventId: 11 });

    // ── (b) two transactions of ONE block: transaction position decides, not the event id ────
    // MIP-0018 §6.2: "An indexer's monotonic event ID … does not define the normative order."
    // The transaction at position 1 carries LOWER ids here, and still comes later.
    const early = { ids: [60, 61], payload: pPayload, height: 700, position: 0, tx: "e2".repeat(32), segment: 3, phase: "guaranteed" as const };
    const late = { ids: [40, 41], payload: qPayload, height: 700, position: 1, tx: "e3".repeat(32), segment: 3, phase: "guaranteed" as const };
    for (const order of [[early, late], [late, early]]) {
      const db = await freshDb();
      for (const pkg of order) await fold(db, pkg);
      expect(await current(db), `arrival ${order.map((p) => p.position).join(",")}`)
        .toMatchObject({ text: Q, eventId: 40, height: 700, position: 1 });
    }

    // ── (c) blocks come first, whatever the position or the id ──────────────────────────────
    const older = { ids: [900], payload: declaration("old"), height: 800, position: 5, tx: "e4".repeat(32), segment: 1, phase: "guaranteed" as const };
    const newer = { ids: [100], payload: declaration("new"), height: 801, position: 0, tx: "e5".repeat(32), segment: 1, phase: "guaranteed" as const };
    for (const order of [[older, newer], [newer, older]]) {
      const db = await freshDb();
      for (const pkg of order) await fold(db, pkg);
      expect(await current(db)).toMatchObject({ text: "new", eventId: 100, height: 801 });
    }

    // ── (d) the LMOON shape: a Null, then a long value in a later transaction of the block ───
    // The Null is a write like any other (MIP §6.2); the 400-byte description that follows it is
    // the current value, whole, and the Null stays in the history.
    const nulled = { ids: [70], payload: declaration(new Uint8Array(0), 5), height: 900, position: 0, tx: "e6".repeat(32), segment: 2, phase: "guaranteed" as const };
    const long = { ids: [71, 72], payload: declaration("L".repeat(400)), height: 900, position: 1, tx: "e7".repeat(32), segment: 2, phase: "guaranteed" as const };
    for (const order of [[nulled, long], [long, nulled]]) {
      const db = await freshDb();
      for (const pkg of order) await fold(db, pkg);
      expect(await current(db)).toMatchObject({ text: "L".repeat(400), valType: 1, eventId: 71 });
      expect(await history(db)).toEqual([{ ids: [70], phase: "guaranteed" }, { ids: [71, 72], phase: "guaranteed" }]);
    }
  }, 240_000);
});
