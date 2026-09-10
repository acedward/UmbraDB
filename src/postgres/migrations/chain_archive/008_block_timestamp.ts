import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `blocks.timestamp_ms`: the block's own `Timestamp::set` value, in milliseconds.
 *
 * WHY (`spec/00009` FR-028, User Story 7). A consumer paging the archive needs to date each block
 * -- and today the only place that value exists is inside the block BODY, as the `Timestamp::set`
 * inherent. Recovering it means decoding the body against the runtime metadata of the block that
 * produced it, per block. Every reader would have to repeat that work, carry a metadata resolver,
 * and get the same answer; the archive already decodes it once during ingest
 * (`chain-archive-sync/runtime-metadata.ts`'s `decodeBlockTimestampMs`, called by replay), so it
 * stores it instead.
 *
 * WHY NULLABLE, unlike `replay_checkpoints.block_timestamp_ms` (migration 005, which made its
 * column `NOT NULL` and deleted the pre-existing rows). The two situations are not alike:
 *
 *  - a checkpoint without a timestamp is UNUSABLE -- resume cannot supply `lastBlockTime` -- and
 *    every pre-existing row was already unusable for an unrelated reason, so deleting them cost
 *    nothing;
 *  - a BLOCK without a timestamp is perfectly usable for everything the archive already does. The
 *    rows are the archive's actual content: deleting them to satisfy a new column would destroy
 *    real history, and inventing a value would be exactly the guess this column exists to avoid.
 *
 * So the column is nullable, existing rows keep `NULL`, and the backfill
 * (`chain-archive-sync/backfill-block-timestamps.ts`) fills them in by re-decoding the archived
 * body blobs. `NULL` therefore means "not decoded yet", never "the block has no time", and the
 * read contract surfaces it as `timestampMs: undefined` rather than as a zero.
 *
 * ADDITIVE. No existing column, constraint, index or trigger changes; no row is written or
 * deleted; every current reader and writer is unaffected. `ALTER TABLE ... ADD COLUMN` on a
 * `PARTITION BY RANGE` parent propagates to every existing partition and to partitions created
 * later, so `createHeightPartitions`' pre-created buckets and the `DEFAULT` catch-all all gain the
 * column without being named here.
 *
 * WHY A NEW MIGRATION rather than editing 001: the runner records applied migrations by NAME, so
 * an edit to an already-applied migration reaches new databases only. A migration applied anywhere
 * is immutable (see 005 and 007, which encode the same rule).
 */
export const name = "008_block_timestamp";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  // Same discovery-not-assumption preflight as 003-005: confirm the table this migration extends
  // is the one it was written against, rather than failing halfway through the ALTER.
  const [table] = await sql<{ n: string }[]>`
    SELECT c.relname AS n
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = ${schema} AND c.relname = 'blocks' AND c.relkind = 'p'
  `;
  if (table === undefined) {
    throw new Error(
      `${schema}.blocks does not exist as a partitioned table; refusing to continue, because this ` +
        "migration adds a column to the table 001 was supposed to have created.",
    );
  }

  // `IF NOT EXISTS` is deliberate belt-and-braces, not laziness: it makes a re-run against a
  // database that somehow already carries the column a no-op instead of an error, matching the
  // idempotent posture every other statement in this lineage takes.
  //
  // The CHECK admits NULL (an unbackfilled row) and any non-negative millisecond value. It does
  // NOT require > 0 the way 005's checkpoint column does: that column could exclude zero because
  // its rows were deleted and re-created, whereas here a hypothetical genuine zero would be a
  // decoded fact about a block, and a constraint is the wrong place to argue with the chain.
  await sql`
    ALTER TABLE ${sql(schema)}.blocks
      ADD COLUMN IF NOT EXISTS timestamp_ms bigint
      CONSTRAINT blocks_timestamp_ms_nonnegative CHECK (timestamp_ms IS NULL OR timestamp_ms >= 0)
  `;
}
