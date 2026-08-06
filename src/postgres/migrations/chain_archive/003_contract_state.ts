import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";
import {
  CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE,
  CHAIN_ARCHIVE_PRECREATED_PARTITIONS,
} from "./partition-config.js";

/**
 * Sprint 9 (indexer independence) -- contract ledger state capture + per-block zswap state root
 * (`openspec/changes/sprint-9-indexer-independence/`, design.md Part 2).
 *
 * WHAT this adds and WHY it is a distinct migration rather than a 001 revision: 001 archives
 * blocks/transactions as raw published bytes -- values that exist inside the transaction
 * payloads themselves. Contract STATE is categorically different (the sprint's own analysis):
 * it is the *result* of applying the state transition, present in no transaction in any form,
 * and the reference indexer obtains it per touched contract via a node runtime API at that
 * block (`midnight-indexer/chain-indexer/src/infra/subxt_node.rs:679`), not via replay. This
 * migration gives that same capture a home:
 *
 *   - `contract_states`: one row per (net, block, contract address) whose state was captured at
 *     that block, state bytes content-addressed into `chain_blobs` under a new
 *     `'contract_state'` role -- an unchanged state re-captured across many blocks dedupes to a
 *     single blob, only the per-block metadata row repeats. Same
 *     "queryable metadata + blob reference" pattern as `transactions`/`bridge_observations`.
 *   - `feed_contract_states_v1`: the versioned hex-rendering READ VIEW (the database is the
 *     interface -- design.md §2); consumers query the view, never the tables, so the underlying
 *     layout can evolve behind a stable contract.
 *
 * Blob-role integrity follows 001's established v3/v4 pattern exactly: the role CHECK is
 * widened, an insert-side trigger asserts the `'contract_state'` role row exists for every
 * referenced blob, and `chain_archive_assert_role_removable` is REPLACED with a version whose
 * CASE carries a `'contract_state'` branch -- without that branch the v4 removal guard would
 * silently allow deleting a role row still referenced by `contract_states` (the function's own
 * `ELSE false` comment in 001 documents that a new consuming table "would need its own branch
 * added here, the same way each existing consumer does" -- this is that addition).
 */
export const name = "003_contract_state";

export async function up(sql: ISql, schema: string): Promise<void> {
  // Same defense-in-depth re-check as 001 (partition DDL below goes through sql.unsafe()).
  assertValidSchemaName(schema);

  // ---------------------------------------------------------------------------------------
  // Widen the role vocabulary. The inline column CHECK from 001 carries Postgres's
  // auto-generated name (<table>_<column>_check); re-added as an explicitly named constraint so
  // the next widening can target it by name instead of relying on the auto-naming rule.
  // ---------------------------------------------------------------------------------------
  await sql`
    ALTER TABLE ${sql(schema)}.chain_blob_roles
      DROP CONSTRAINT chain_blob_roles_role_check
  `;
  await sql`
    ALTER TABLE ${sql(schema)}.chain_blob_roles
      ADD CONSTRAINT chain_blob_roles_role_check CHECK (role IN
        ('block_header', 'block_body', 'tx_raw', 'proof', 'verifier_key', 'bridge_observation',
         'contract_state'))
  `;

  // NOTE: `blocks.zswap_state_root` is NOT added here. It is created by `002_zswap_root`, which
  // owns the per-block root capture; this migration owns contract state only. An earlier revision
  // of this file added the column too, which made the two migrations un-composable -- running
  // both raised a duplicate-column error. Scope split: 002 = block-level node readings,
  // 003 = contract state.

  // ---------------------------------------------------------------------------------------
  // contract_states -- (net, block, contract) -> state blob. PK includes block_hash for the
  // same fork-safety reason as `transactions` (001's "fork-breaking PK bug fix": competing
  // blocks at one height must each carry their own capture). FK to `blocks` makes a state row
  // for a nonexistent/mismatched block impossible; the ingest writes both in one transaction
  // (`putBlockBundle`), so ordinary same-transaction MVCC visibility satisfies the FK.
  // `contract_address` is the ledger-serialized address (32 bytes, confirmed live against the
  // deployed sprint-9 counter contract).
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.contract_states (
      net              text        NOT NULL,
      block_height     bigint      NOT NULL CHECK (block_height >= 0),
      block_hash       bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
      contract_address bytea       NOT NULL CHECK (octet_length(contract_address) = 32),
      state_blob_hash  bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      synced_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (net, block_height, block_hash, contract_address),
      FOREIGN KEY (net, block_height, block_hash) REFERENCES ${sql(schema)}.blocks (net, height, block_hash)
    ) PARTITION BY RANGE (block_height)
  `;

  await createHeightPartitions(sql, schema, "contract_states");

  // The genuinely distinct access pattern: "this contract's state history across blocks"
  // (net, contract_address, block_height) is not a left-prefix of the PK.
  await sql`
    CREATE INDEX contract_states_by_address
      ON ${sql(schema)}.contract_states (net, contract_address, block_height)
  `;

  // Insert-side blob-role integrity, exactly per 001's per-consumer-table pattern.
  await sql`
    CREATE FUNCTION ${sql(schema)}.contract_states_check_blob_roles() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      PERFORM ${sql(schema)}.chain_archive_assert_blob_role(
        NEW.state_blob_hash, 'contract_state', 'contract_states', 'state_blob_hash');
      RETURN NEW;
    END;
    $fn$
  `;
  await sql`
    CREATE TRIGGER contract_states_blob_roles_trigger
      BEFORE INSERT OR UPDATE OF state_blob_hash ON ${sql(schema)}.contract_states
      FOR EACH ROW EXECUTE FUNCTION ${sql(schema)}.contract_states_check_blob_roles()
  `;

  // ---------------------------------------------------------------------------------------
  // Removal-guard branch for the new consumer (001's v4 guard, extended). CREATE OR REPLACE
  // keeps the same signature, so the existing `chain_blob_roles_guard_removal_trigger` keeps
  // calling through unchanged. The full CASE is restated (plpgsql functions are replaced whole,
  // not patched) -- every pre-existing branch is byte-identical to 001's.
  // ---------------------------------------------------------------------------------------
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
        WHEN 'contract_state' THEN
          EXISTS (SELECT 1 FROM ${sql(schema)}.contract_states WHERE state_blob_hash = p_blob_hash)
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

  // ---------------------------------------------------------------------------------------
  // The versioned read contract (design.md §2: consumers read the database directly; views are
  // the stable surface, tables are internals). Hex-rendering, blob-joined -- one SELECT gives a
  // contract's full serialized state at a block with no bytea client-rendering pitfalls.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE VIEW ${sql(schema)}.feed_contract_states_v1 AS
      SELECT cs.net,
             cs.block_height,
             encode(cs.block_hash, 'hex')       AS block_hash,
             encode(cs.contract_address, 'hex') AS contract_address,
             encode(b.data, 'hex')              AS state,
             octet_length(b.data)               AS state_size_bytes,
             cs.synced_at
      FROM ${sql(schema)}.contract_states cs
      JOIN ${sql(schema)}.chain_blobs b ON b.hash = cs.state_blob_hash
  `;
}

/** Identical mechanism (and identical sql.unsafe() rationale) to 001's own
 *  `createHeightPartitions` -- that helper is module-private there by design, and this
 *  migration needs the same bucketing for `contract_states` (partition column
 *  `block_height`). */
async function createHeightPartitions(sql: ISql, schema: string, tableBaseName: string): Promise<void> {
  for (let i = 0; i < CHAIN_ARCHIVE_PRECREATED_PARTITIONS; i++) {
    const lo = i * CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE;
    const hi = (i + 1) * CHAIN_ARCHIVE_HEIGHT_PARTITION_SIZE;
    await sql.unsafe(
      `CREATE TABLE "${schema}".${tableBaseName}_p${i} ` +
      `PARTITION OF "${schema}".${tableBaseName} FOR VALUES FROM (${lo}) TO (${hi})`,
    );
  }
  await sql.unsafe(
    `CREATE TABLE "${schema}".${tableBaseName}_default ` +
    `PARTITION OF "${schema}".${tableBaseName} DEFAULT`,
  );
}
