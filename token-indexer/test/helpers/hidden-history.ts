/**
 * Many metadata transactions of one identity, seeded fast. The real apply path (`writeEvents`) and activity writer
 * (`transactionActivity` + `writeActivity`) write ONE publish transaction of the identity (a single `name` record); its
 * rows in every table keyed by chain position (`mip0018_events`, `mip0018_activity` and, where the schema has it,
 * `mip0018_listed_events`) are then cloned at the following heights — what the same path writes for each further
 * publish of the same value, where only the height and the transaction hash differ — and the field row moves to the
 * last height. `[[mip0018.activity.bounded-cost]]` checks the clone against the real path on a small count.
 */
import { createHash } from "node:crypto";
import { type ActivityTransactionLike, transactionActivity, writeActivity } from "../../mip0018/activity.ts";
import { type EventRow, observedEventRow, type Queryable, writeEvents } from "../../mip0018/fields.ts";
import type { UmbraDBSql } from "../../../src/postgres/client.js";
import { EVENT_NAME, encodePayload, type MetadataRecord, record } from "../../vendor/mip0018/codec/src/index.ts";

/** The synthetic transaction hash of the (only) transaction at a height: SHA-256 of the height as 8 bytes big-endian. */
export function txHashAt(height: number): string {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(height));
  return createHash("sha256").update(b).digest("hex");
}

export interface SeedIdentity {
  network: string;
  /** hex */
  contract: string;
  /** hex */
  domainSep: string;
  kind: 1 | 2 | 3;
}

/** One event of `id` at `height` (transaction 0, event 0) carrying `records`, as the scan would store it. */
export function eventAt(id: SeedIdentity, height: number, records: MetadataRecord[] | "reject"): EventRow {
  const payload = records === "reject" ? new Uint8Array(256) : encodePayload({ domainSep: Buffer.from(id.domainSep, "hex"), kind: id.kind }, records);
  return observedEventRow({
    network: id.network, position: { block: height, tx: 0, event: 0 }, contractAddress: id.contract, type: "Misc",
    name: EVENT_NAME, payload, txHash: txHashAt(height), segment: 1, phase: "guaranteed",
  });
}

/** Writes one metadata transaction (its events through the real apply path, its activity rows through the real writer). */
export async function writeMetadataTx(tx: Queryable, schema: string, events: EventRow[]): Promise<void> {
  const first = events[0]!;
  await writeEvents(tx, schema, events);
  const none: ActivityTransactionLike = {};
  await writeActivity(tx, schema, transactionActivity({
    network: first.network, height: first.block_height, txIndex: first.tx_index, txHash: first.tx_hash!.toString("hex"), tx: none,
    outcome: { result: "success", segments: null }, events,
  }));
}

/**
 * `count` publish transactions of `id` at heights `from` … `from + count − 1`, each setting `name` to the same value:
 * the first through the real paths, the rest cloned (see the file header).
 */
export async function seedPublishes(sql: UmbraDBSql, schema: string, id: SeedIdentity, from: number, count: number, name = "Spam"): Promise<void> {
  await sql.begin((tx) => writeMetadataTx(tx as unknown as Queryable, schema, [eventAt(id, from, [record.utf8("name", name)])]));
  if (count <= 1) return;
  const last = from + count - 1;
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_name IN ('mip0018_events', 'mip0018_activity', 'mip0018_listed_events')
    ORDER BY CASE table_name WHEN 'mip0018_events' THEN 0 WHEN 'mip0018_activity' THEN 1 ELSE 2 END`;
  for (const { table_name: table } of tables) {
    const cols = (await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table} ORDER BY ordinal_position`)
      .map((c) => c.column_name);
    const q = (c: string): string => `"${c.replace(/"/g, '""')}"`;
    const select = cols.map((c) => (c === "block_height" ? "g::bigint" : c === "tx_hash" ? "sha256(int8send(g::bigint))" : `t.${q(c)}`));
    await sql.unsafe(
      `INSERT INTO ${q(schema)}.${q(table)} (${cols.map(q).join(", ")})
       SELECT ${select.join(", ")} FROM ${q(schema)}.${q(table)} t CROSS JOIN generate_series($2::bigint, $3::bigint) g
       WHERE t.network = $1 AND t.block_height = $4 AND t.contract_address = decode($5, 'hex')`,
      [id.network, from + 1, last, from, id.contract],
    );
  }
  await sql`
    UPDATE ${sql(schema)}.mip0018_fields SET updated_block = ${last}
    WHERE network = ${id.network} AND contract_address = ${Buffer.from(id.contract, "hex")} AND domain_sep = ${Buffer.from(id.domainSep, "hex")} AND kind = ${id.kind}`;
}
