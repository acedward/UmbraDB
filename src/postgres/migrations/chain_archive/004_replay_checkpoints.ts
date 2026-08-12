import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `replay_checkpoints`: serialized ledger state at chosen heights, so replay can resume without
 * re-applying the whole chain.
 *
 * WHY. Audit A2 requires ledger replay to GATE ingest -- the reference's accept/refuse behaviour
 * is part of what byte-parity means, and it is only real if it runs in the sync loop. That makes
 * restart cost load-bearing: without checkpoints, every process start replays from genesis over
 * the entire archive before it can ingest one new block, which is superlinear in chain length and
 * unusable on a real chain.
 *
 * SPARSE BY DESIGN, and the numbers are why. A serialized `LedgerState` is 816 bytes blank and
 * ~37 KB after the five genesis system transactions alone, growing with UTXOs and contract state
 * -- unbounded, in other words. Checkpointing every block would dwarf the archive it belongs to.
 * Instead a checkpoint is written every N blocks and restart loads the nearest one at or below the
 * watermark, replaying forward only from there.
 *
 * Bytes go through the existing content-addressed `chain_blobs` under a new `ledger_state` role,
 * so a state that happens to be unchanged across two checkpoints stores once, and the existing
 * blob-role integrity triggers apply unchanged.
 *
 * `ledger_version` is not decoration. Serialized state is a LEDGER-INTERNAL encoding: resuming a
 * checkpoint written by one ledger build under a different build is exactly the class of silent
 * corruption this sprint keeps finding, so the resuming code must compare and refuse rather than
 * discover the problem later as wrong replay outcomes.
 *
 * Owner-approved (Option A, 2026-08-11) as the third Part A schema change.
 */
export const name = "004_replay_checkpoints";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  // Same discovery-not-assumption approach as 003: the role CHECK was created inline, so its name
  // is generated, and a hardcoded guess that missed would leave the old vocabulary in place while
  // this migration reported success.
  const [roleCheck] = await sql<{ conname: string }[]>`
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema} AND t.relname = 'chain_blob_roles' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%runtime_metadata%'
  `;
  if (roleCheck === undefined) {
    throw new Error(
      `${schema}.chain_blob_roles has no role CHECK carrying the 003 vocabulary; refusing to ` +
        "continue, because the table is not in the shape this migration was written against.",
    );
  }
  await sql`ALTER TABLE ${sql(schema)}.chain_blob_roles DROP CONSTRAINT ${sql(roleCheck.conname)}`;
  await sql`
    ALTER TABLE ${sql(schema)}.chain_blob_roles
      ADD CHECK (role IN ('block_header', 'block_body', 'tx_raw', 'proof', 'verifier_key',
                          'bridge_observation', 'runtime_metadata', 'ledger_state'))
  `;

  await sql`
    CREATE TABLE ${sql(schema)}.replay_checkpoints (
      net             text        NOT NULL,
      block_height    bigint      NOT NULL CHECK (block_height >= 0),
      block_hash      bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
      -- Serialized LedgerState as of AFTER this block's post-block update, i.e. the state a
      -- replay resuming at block_height + 1 must start from.
      state_blob_hash bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      -- The ledger build that produced these bytes. Resuming under a different build is refused.
      ledger_version  text        NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (net, block_height, block_hash),
      -- A checkpoint describes a block, so it cannot outlive one. Also means a fork's checkpoints
      -- are distinguishable: same height, different block_hash.
      FOREIGN KEY (net, block_height, block_hash)
        REFERENCES ${sql(schema)}.blocks (net, height, block_hash)
    )
  `;

  // "The newest checkpoint at or below height H for this net" is the only read path that matters,
  // and it runs once per process start.
  await sql`
    CREATE INDEX replay_checkpoints_resume
      ON ${sql(schema)}.replay_checkpoints (net, block_height DESC)
  `;

  await sql`
    CREATE FUNCTION ${sql(schema)}.replay_checkpoints_check_blob_roles() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      PERFORM ${sql(schema)}.chain_archive_assert_blob_role(
        NEW.state_blob_hash, 'ledger_state', 'replay_checkpoints', 'state_blob_hash');
      RETURN NEW;
    END;
    $fn$
  `;
  await sql`
    CREATE TRIGGER replay_checkpoints_blob_roles_trigger
      BEFORE INSERT OR UPDATE OF state_blob_hash ON ${sql(schema)}.replay_checkpoints
      FOR EACH ROW EXECUTE FUNCTION ${sql(schema)}.replay_checkpoints_check_blob_roles()
  `;
}
