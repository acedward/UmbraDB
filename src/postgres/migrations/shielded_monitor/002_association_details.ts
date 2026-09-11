import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `associations.details` and `associations.block_timestamp_ms`: the PUBLIC zswap data of a
 * matched transaction, and the time of the block it sat in (organizer sub-plan 00009-07).
 *
 * WHY. An association today names a block height, a position, a transaction hash and the matched
 * segments — all true, all checkable, and all opaque. The scanner already holds the decoded offers
 * at the moment it decides relevance, so recording what those offers contain costs one pass over
 * data already in memory: the commitment of every output (a new shielded coin), the nullifier of
 * every input (a spent one), the commitment/nullifier pair of every transient, the contract
 * address of any entry delivered to a contract, and a three-valued "is this one yours" whose every
 * value is entailed by the ledger (`shielded-monitor/match-details.ts`, organizer question Q22).
 *
 * WHY `jsonb` AND NOT A TABLE. The content is a per-transaction tree (segments, each with three
 * lists) that is read whole, written once, and never queried by its inner fields; the alternative
 * is three more tables plus their fencing, for a shape nothing joins against. The row is bounded
 * by `MAX_DETAIL_ENTRIES` before it is written, so "jsonb" is not an invitation to unbounded
 * growth. `jsonb` also matches what this lineage already does for `monitors.last_error`.
 *
 * WHY NULLABLE. Every association written before this migration is a real match with real
 * provenance; deleting those rows to satisfy a new column would destroy history, and synthesising
 * a value would be a guess presented as a decode. So `NULL` means exactly "not recorded yet" —
 * the API returns `null`, the dashboard says so in those words and points at the backfill
 * (`umbradb-shielded-monitor --backfill-details`), and no reader may treat it as "this
 * transaction had no outputs".
 *
 * OWNER RULE B IS UNTOUCHED. Both columns live in project B's own schema, are written by B's own
 * fenced write paths, and are computed from bytes B received through the read contract. Nothing
 * here references an archive table, and `block_timestamp_ms` is a COPY of a value the archive
 * published through `ArchiveReadContract` — not a join, not a foreign key, and not a second source
 * of truth for the archive's own column.
 *
 * ADDITIVE. No existing column, constraint or index changes; no row is written or deleted; every
 * pre-00009-07 reader and writer keeps working against a database that has run this migration, and
 * every pre-00009-07 row keeps `NULL` in both columns until a backfill visits it.
 *
 * WHY A NEW MIGRATION rather than editing `001_core`: the runner records applied migrations by
 * NAME, so an edit to an already-applied migration reaches new databases only. A migration applied
 * anywhere is immutable — the same rule the chain-archive lineage's 005/007/008 encode.
 */
export const name = "002_association_details";

export async function up(sql: ISql, schema: string): Promise<void> {
  // Defense in depth, matching every other migration in this repo: `runMigrations` already
  // validated `opts.schema`, but a caller invoking `up()` directly bypasses that gate.
  assertValidSchemaName(schema);

  // Discovery, not assumption (the preflight every additive migration in this repository runs):
  // confirm the table this migration extends is the one 001 was supposed to have created, rather
  // than failing halfway through the ALTER with a message about a column.
  const [table] = await sql<{ n: string }[]>`
    SELECT c.relname AS n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = ${schema} AND c.relname = 'associations' AND c.relkind = 'r'
  `;
  if (table === undefined) {
    throw new Error(
      `${schema}.associations does not exist as an ordinary table; refusing to continue, because ` +
        "this migration adds columns to the table 001_core was supposed to have created.",
    );
  }

  // `IF NOT EXISTS` is deliberate belt-and-braces: a re-run against a database that somehow
  // already carries the column is a no-op rather than an error, which is the idempotent posture
  // every other statement in this lineage takes.
  await sql`
    ALTER TABLE ${sql(schema)}.associations
      ADD COLUMN IF NOT EXISTS details jsonb
  `;

  // The CHECK admits NULL (never recorded, or recorded before the archive carried block times) and
  // any non-negative millisecond value. It does not argue with the chain about whether a genuine
  // zero is possible; it only refuses a negative, which cannot be a time.
  await sql`
    ALTER TABLE ${sql(schema)}.associations
      ADD COLUMN IF NOT EXISTS block_timestamp_ms bigint
      CONSTRAINT associations_block_timestamp_ms_nonnegative
        CHECK (block_timestamp_ms IS NULL OR block_timestamp_ms >= 0)
  `;

  // The backfill's work list: "which of this monitor's associations still have no details?".
  // PARTIAL, so it holds only the rows that still need visiting and shrinks to nothing as the
  // backfill completes — a full index on `(monitor_id, seq)` would duplicate the primary key for
  // every finished row forever.
  await sql`
    CREATE INDEX IF NOT EXISTS associations_details_missing
      ON ${sql(schema)}.associations (monitor_id, seq)
      WHERE details IS NULL
  `;
}
