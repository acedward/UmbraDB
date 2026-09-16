import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `replay_checkpoints.block_timestamp_ms`: the checkpointed block's own `Timestamp::set` value.
 *
 * WHY (audit finding T1). Ledger replay is time-dependent: the reference passes the PREVIOUS
 * block's timestamp as `last_block_time` when applying the next one, and it feeds the ledger's own
 * validity rules. A checkpoint stored the ledger state but not that timestamp, so a resumed run
 * had nothing to supply for its first block and used zero -- folding it against a parent dated
 * 1970. Nothing detects this: the state is still structurally valid, the run still succeeds, and
 * the divergence only exists ACROSS a restart, which no single-run test exercises.
 *
 * Storing the checkpointed block's own time is sufficient, because the block that resumes from a
 * checkpoint at height H is H+1, whose parent is H.
 *
 * WHY A NEW MIGRATION rather than editing 004. Two reasons, and the second is the general rule.
 *
 * 1. The runner records applied migrations by NAME. A database that already recorded
 *    `004_replay_checkpoints` skips it forever, so an edit to 004's body reaches new databases
 *    only -- exactly the split-brain the T8 finding names. A new file is applied everywhere.
 * 2. Migrations that have been applied anywhere are immutable on principle. Editing one makes the
 *    recorded name stop describing what actually ran.
 *
 * WHY THE COLUMN IS `NOT NULL` AND EXISTING ROWS ARE DELETED. The timestamp cannot be
 * reconstructed from anything in the archive -- the block's time lives in its extrinsics, which
 * the archive does not decode at rest -- so back-filling would mean inventing values, which is the
 * defect this migration exists to remove. A nullable column would push the same guess into the
 * resume path.
 *
 * Deleting is safe and is not data loss: `replay_checkpoints` is a derived cache, rebuildable by
 * replaying from genesis, and every pre-existing row is ALREADY unusable. Each carries a
 * `ledger_version` of `ledger-v8@8.1.0-syshash.1` or earlier, and the vendored ledger has since
 * moved to `…syshash.2`, so resume refuses all of them regardless. This migration removes rows
 * that could not have been used anyway.
 *
 * The `ledger_state` role rows in `chain_blob_roles` are deliberately left alone. Blobs are
 * content-addressed and may be shared; an unreferenced role row is inert, and the removal guard
 * only forbids dropping a role that IS still referenced.
 */
export const name = "005_replay_checkpoint_block_time";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  // Same discovery-not-assumption approach as 003 and 004: verify the table is in the shape this
  // migration was written against before touching it, rather than failing halfway through.
  const [table] = await sql<{ n: string }[]>`
    SELECT c.relname AS n
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = ${schema} AND c.relname = 'replay_checkpoints' AND c.relkind = 'r'
  `;
  if (table === undefined) {
    throw new Error(
      `${schema}.replay_checkpoints does not exist; refusing to continue, because this migration ` +
        "adds a column to a table 004 was supposed to have created.",
    );
  }

  // Unusable by construction (see the header): every existing row predates the current ledger
  // build and would be refused on resume. Removing them is what lets the new column be NOT NULL
  // without inventing a timestamp for any of them.
  await sql`DELETE FROM ${sql(schema)}.replay_checkpoints`;

  await sql`
    ALTER TABLE ${sql(schema)}.replay_checkpoints
      ADD COLUMN block_timestamp_ms bigint NOT NULL CHECK (block_timestamp_ms > 0)
  `;
}
