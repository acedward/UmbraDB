import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `runtime_metadata`: each archive carries its own copy of every runtime's metadata.
 *
 * WHY. Since Stage 2, decoding a block requires the metadata of the runtime that produced it --
 * pallet indices, extension layouts and event shapes are all runtime configuration, not protocol
 * constants. That metadata is fetched from the node at the block's hash, and it is derived from
 * historical STATE: a pruned node cannot serve it. So ingest of an old range through a pruned node
 * refuses, and Stage 4 replay would re-read metadata for every historical runtime long after any
 * capture window closed.
 *
 * For a chain whose history is pruned everywhere, a prior capture is not one option among several
 * -- it is the ONLY possible source, because the bytes exist nowhere else. This table is where
 * this archive keeps its captures. Ingest persists a runtime's metadata the first time that
 * runtime is seen, so the archive becomes self-describing: re-syncs, re-decodes and replay read it
 * from here and never depend on the node's state retention again. First contact with a runtime
 * still needs a serving node -- unavoidable -- but exactly once per runtime version, not forever.
 *
 * This mirrors the reference indexer, which never fetches metadata at ingest at all: it captures
 * `metadata.scale` per node version offline (`get_node_metadata.sh`, `NODE_VERSIONS`,
 * `.node/<version>/`) and compiles its decoders from the captured artifacts.
 *
 * KEY. `(net, spec_name, spec_version)` -- the runtime's own identity, which is exactly what a
 * runtime upgrade bumps, and therefore exactly the granularity at which metadata changes. Scoped
 * by `net` because two chains can legitimately report the same spec name and version while having
 * different runtimes.
 *
 * Bytes go through the existing content-addressed `chain_blobs` under a new `runtime_metadata`
 * role, so the ~100 KB payload is stored once even if several nets share a runtime, and the
 * existing blob-role integrity triggers apply unchanged.
 *
 * Owner-approved as the second Part A schema change (sprint plan §13, using §1's reserved
 * scope-decision mechanism).
 */
export const name = "003_runtime_metadata";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  // Extend the blob-role vocabulary. The CHECK is re-created rather than altered because Postgres
  // has no "add a value to a CHECK" operation; the constraint name is discovered rather than
  // assumed, for the same reason as in 002 -- it was created inline and its name is generated.
  const [roleCheck] = await sql<{ conname: string }[]>`
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema} AND t.relname = 'chain_blob_roles' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%block_header%'
  `;
  if (roleCheck === undefined) {
    throw new Error(
      `${schema}.chain_blob_roles has no role CHECK constraint to extend; refusing to continue, ` +
        "because the table is not in the shape this migration was written against.",
    );
  }
  await sql`ALTER TABLE ${sql(schema)}.chain_blob_roles DROP CONSTRAINT ${sql(roleCheck.conname)}`;
  await sql`
    ALTER TABLE ${sql(schema)}.chain_blob_roles
      ADD CHECK (role IN ('block_header', 'block_body', 'tx_raw', 'proof', 'verifier_key',
                          'bridge_observation', 'runtime_metadata'))
  `;

  await sql`
    CREATE TABLE ${sql(schema)}.runtime_metadata (
      net                text        NOT NULL,
      spec_name          text        NOT NULL,
      spec_version       bigint      NOT NULL CHECK (spec_version >= 0),
      -- The height at which this runtime was first observed. Diagnostic rather than structural:
      -- it makes "which block introduced this runtime" answerable from the archive alone, which
      -- is the question asked when a decode goes wrong at an upgrade boundary.
      first_seen_height  bigint      NOT NULL CHECK (first_seen_height >= 0),
      metadata_blob_hash bytea       NOT NULL REFERENCES ${sql(schema)}.chain_blobs(hash),
      captured_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (net, spec_name, spec_version)
    )
  `;

  // Same blob-role integrity discipline every other blob-referencing table has: a row may not
  // point at bytes that were never classified as runtime metadata.
  await sql`
    CREATE FUNCTION ${sql(schema)}.runtime_metadata_check_blob_roles() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      PERFORM ${sql(schema)}.chain_archive_assert_blob_role(
        NEW.metadata_blob_hash, 'runtime_metadata', 'runtime_metadata', 'metadata_blob_hash');
      RETURN NEW;
    END;
    $fn$
  `;
  await sql`
    CREATE TRIGGER runtime_metadata_blob_roles_trigger
      BEFORE INSERT OR UPDATE OF metadata_blob_hash ON ${sql(schema)}.runtime_metadata
      FOR EACH ROW EXECUTE FUNCTION ${sql(schema)}.runtime_metadata_check_blob_roles()
  `;
}
