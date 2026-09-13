import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * **The viewing key leaves the database, and coverage learns to have holes**
 * (organizer sub-plan 00009-09; owner decision Q28; open points OP-3 and OP-4).
 *
 * WHY. Until now `monitors.key_serialized` held the plaintext serialized encryption secret key,
 * and a scanner fetched it once per batch. The owner's 00009-09 decision removes that entirely: a
 * viewing key is held in the RAM of exactly one monitor-node and is never written anywhere. What
 * the database keeps is the key's HASH — `fingerprint`, which was already the registration
 * identity — so a monitor is still identified by its key without the database ever holding one.
 *
 * That makes two changes here, and only two:
 *
 * 1. **The CHECK becomes fingerprint-only.** `monitors_deleted_is_shredded` required
 *    `key_serialized IS NOT NULL` for every non-deleted monitor, which from now on is exactly
 *    backwards: every non-deleted monitor has a fingerprint and NO key. The replacement keeps the
 *    half it still means — a deleted monitor sheds its identity, a live one has one — and says
 *    nothing at all about `key_serialized`.
 *
 * 2. **`monitor_gaps`.** Block-centric scanning (one pass over each new block testing every held
 *    key) means a key can join the live set at height H while its own coverage still stands at
 *    some H' < H − 1. The range in between was never scanned for that key, and
 *    `scanned_through_height` alone cannot say so: it is a single number, and moving it to H would
 *    claim the hole as covered. So the hole becomes a ROW, the monitor-node queues a `back-sync`
 *    for it, and `fill-gap` shrinks or deletes the row as the range is actually read. "Complete"
 *    is `scanned_through_height = tip AND no gap rows`.
 *
 * ── What is deliberately NOT done ───────────────────────────────────────────────────────────
 * `key_serialized` is **kept as a column** and `monitor_leases` is **kept as a table**, both
 * unused from now on (OP-4). Dropping a column and a table is not an additive migration, and this
 * lineage's rule is that a migration never invalidates a reader that ran before it. A later
 * cleanup migration drops both once no deployed reader references them. Until then the column is
 * always NULL — nothing writes it, and `register` no longer has anything to write — and the table
 * is never read or written.
 *
 * Existing rows need no data migration: a monitor whose key used to be in the database simply has
 * nobody holding it in RAM, which is exactly the `key needed` state the dashboard shows until the
 * client re-sends the key. Its coverage, its associations and its lifecycle log are untouched.
 *
 * ADDITIVE. One CHECK replaced by a weaker one (every row that satisfied the old one satisfies the
 * new one, except the ones the old one forbade and the new topology requires), one new table, one
 * new index. No column is dropped, no row is rewritten.
 */
export const name = "004_key_in_ram_and_gaps";

export async function up(sql: ISql, schema: string): Promise<void> {
  // Defense in depth, matching every other migration in this repo: `runMigrations` already
  // validated `opts.schema`, but a caller invoking `up()` directly bypasses that gate.
  assertValidSchemaName(schema);

  // Discovery, not assumption — the preflight every additive migration in this lineage runs.
  const [table] = await sql<{ n: string }[]>`
    SELECT c.relname AS n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = ${schema} AND c.relname = 'monitors' AND c.relkind = 'r'
  `;
  if (table === undefined) {
    throw new Error(
      `${schema}.monitors does not exist as an ordinary table; refusing to continue, because ` +
        "this migration relaxes a constraint on it and adds a table whose every row references it.",
    );
  }

  // ── 1. The key is no longer required to be present ────────────────────────────────────────
  //
  // `DROP CONSTRAINT IF EXISTS` then `ADD`: idempotent, and it does not care whether the old
  // constraint was ever created under this exact name (a database restored from a dump names it
  // the same way, because 001 named it explicitly).
  await sql`
    ALTER TABLE ${sql(schema)}.monitors
      DROP CONSTRAINT IF EXISTS monitors_deleted_is_shredded
  `;
  await sql`
    ALTER TABLE ${sql(schema)}.monitors
      ADD CONSTRAINT monitors_deleted_is_shredded CHECK (
        CASE WHEN state = 'deleted'
             THEN fingerprint IS NULL
             ELSE fingerprint IS NOT NULL
        END
      )
  `;

  // ── 2. monitor_gaps ───────────────────────────────────────────────────────────────────────
  //
  // One row per contiguous unscanned range BELOW a monitor's `scanned_through_height`.
  //
  // `PRIMARY KEY (monitor_id, from_height)` rather than a surrogate id: a gap is identified by
  // where it starts, and two rows starting at the same height for the same monitor would be two
  // descriptions of one hole. It also makes the fill path's `DELETE … WHERE from_height = …` a
  // primary-key lookup.
  //
  // `ON DELETE CASCADE` for the same reason `monitor_leases` has it: `delete` leaves a tombstone
  // row in `monitors`, and a gap outliving its monitor would be a row nothing could clean up. Note
  // that the cascade therefore never fires for a delete — the monitor row survives — so the
  // store's own delete path shreds these rows explicitly, alongside the associations.
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(schema)}.monitor_gaps (
      monitor_id  uuid        NOT NULL REFERENCES ${sql(schema)}.monitors (id) ON DELETE CASCADE,
      from_height bigint      NOT NULL CHECK (from_height >= 0),
      to_height   bigint      NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (monitor_id, from_height),
      -- An inverted range is not a smaller hole, it is a nonsense one; a single-height gap is
      -- from = to, which is the common case after a one-block desync.
      CONSTRAINT monitor_gaps_range CHECK (to_height >= from_height)
    )
  `;

  // No second index. Every read of this table is "this monitor's gaps, lowest first", which the
  // primary key `(monitor_id, from_height)` already serves as an index scan; a separate index on
  // the same two columns in the same order would be a duplicate that only costs write time.
}
