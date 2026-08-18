import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * Re-install `chain_archive_assert_role_removable` with the COMPLETE table enumeration.
 *
 * WHY (audit finding T8). 001 created a removal guard that enumerates the tables referencing
 * `chain_blobs` BY NAME, so tables added later are invisible to it and their blobs' role rows can
 * be deleted -- orphaning a live reference and defeating the insert-side integrity trigger. Round 3
 * fixed that by extending the function from inside 003 and 004.
 *
 * The problem is HOW it was fixed: by editing the bodies of migrations that had already been
 * applied. The runner records applied migrations by NAME, so any database that had already
 * recorded `003_runtime_metadata` and `004_replay_checkpoints` skips them forever and never sees
 * the extension. Such a database has the new TABLES but the OLD guard -- the exact split-brain the
 * edit was meant to remove, now invisible because the migration ledger says both ran.
 *
 * IS SUCH A DATABASE SUPPORTED? This migration deliberately does not depend on the answer. No
 * UmbraDB deployment exists today, so most likely none is out there -- but "most likely none" is
 * not a property worth betting a silent integrity hole on, and the cost of being wrong is
 * asymmetric: a corrected function costs one idempotent statement, while a missed one leaves a
 * guard that looks present and is not. `CREATE OR REPLACE` on a database that already has the
 * correct definition installs the identical body, so a fresh lineage is unaffected.
 *
 * The general rule this encodes, and the reason it is a new file rather than another edit:
 * **a migration that has been applied anywhere is immutable.** Fixing one means adding another.
 *
 * Kept in sync with 004's copy by construction -- both must list every blob-referencing table. A
 * future migration adding such a table must extend this function again, in ITS OWN file.
 */
export const name = "007_blob_role_guard_forward_fix";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  await sql`
    CREATE OR REPLACE FUNCTION ${sql(schema)}.chain_archive_assert_role_removable(
      p_blob_hash bytea, p_role text
    ) RETURNS void LANGUAGE plpgsql AS $fn$
    DECLARE
      v_in_use boolean;
    BEGIN
      PERFORM 1 FROM ${sql(schema)}.chain_blob_roles
        WHERE blob_hash = p_blob_hash AND role = p_role FOR UPDATE;

      v_in_use := CASE p_role
        WHEN 'block_header' THEN
          EXISTS (SELECT 1 FROM ${sql(schema)}.blocks WHERE header_blob_hash = p_blob_hash)
        WHEN 'block_body' THEN
          EXISTS (SELECT 1 FROM ${sql(schema)}.blocks WHERE body_blob_hash = p_blob_hash)
        WHEN 'tx_raw' THEN
          EXISTS (SELECT 1 FROM ${sql(schema)}.transactions WHERE raw_blob_hash = p_blob_hash)
        WHEN 'bridge_observation' THEN
          EXISTS (SELECT 1 FROM ${sql(schema)}.bridge_observations WHERE raw_blob_hash = p_blob_hash)
        WHEN 'verifier_key' THEN
          EXISTS (SELECT 1 FROM ${sql(schema)}.verifier_key_observations WHERE vk_hash = p_blob_hash)
        WHEN 'runtime_metadata' THEN
          EXISTS (SELECT 1 FROM ${sql(schema)}.runtime_metadata WHERE metadata_blob_hash = p_blob_hash)
        WHEN 'ledger_state' THEN
          EXISTS (SELECT 1 FROM ${sql(schema)}.replay_checkpoints WHERE state_blob_hash = p_blob_hash)
        ELSE false
      END;

      IF v_in_use THEN
        RAISE EXCEPTION
          'cannot remove/change chain_blob_roles row (blob %, role %): still referenced by a live row'
          , encode(p_blob_hash, 'hex'), p_role
          USING ERRCODE = '23514', CONSTRAINT = 'chain_blob_roles_removal_guard';
      END IF;
    END;
    $fn$
  `;
}
