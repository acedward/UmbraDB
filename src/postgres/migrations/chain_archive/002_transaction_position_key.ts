import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * Re-key `transactions` on `position` instead of `tx_hash`, so one block can hold two rows with
 * the same transaction hash.
 *
 * WHY THIS IS NECESSARY, not a preference. The reference indexer does **not** deduplicate a system
 * transaction that reaches the node twice. `midnight-indexer/chain-indexer/src/infra/subxt_node/
 * runtimes/v1_0_0.rs:160-163` prepends the event-borne system transactions and plain-`extend`s the
 * extrinsic-derived list, with no hash comparison anywhere on the path, and its own `transactions`
 * table (`indexer-common/migrations/postgres/001_initial.sql`) has `id BIGSERIAL` as its primary
 * key with only a plain index on `hash`. So a successful direct system call -- which is present
 * BOTH as an extrinsic and as a `SystemTransactionApplied` event -- legitimately persists there as
 * two rows.
 *
 * This archive is defined by byte-parity with that output, so it must be able to hold two rows
 * too. Under the old key `(net, block_height, block_hash, tx_hash)` it could not: the second copy
 * collided, and since every terminal insert is `ON CONFLICT DO NOTHING`, it was dropped in silence
 * rather than raising. Ingest currently REFUSES such blocks (`assertNoDuplicateTransactionKeys`)
 * precisely because storing one of two copies would look complete while disagreeing with the
 * source.
 *
 * `position` is the right key because it is already the archive's notion of transaction identity
 * within a block -- ordered, contiguous from zero across both kinds, and already carrying its own
 * `UNIQUE (net, block_height, block_hash, position)`. Promoting that existing constraint to the
 * primary key is therefore a re-labelling of a uniqueness rule the table already enforced, not a
 * new one; no row that was legal before becomes illegal.
 *
 * `tx_hash` remains indexed (`transactions_by_hash`, created in `001`), so "find this transaction
 * across all blocks and forks" is unaffected -- that index was never the PK's left prefix anyway.
 *
 * Owner-approved as the single schema change Part A may make (sprint plan §0 and §3(c)).
 */
export const name = "002_transaction_position_key";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  // Discover the constraint names rather than assuming Postgres's defaults. They were created
  // inline in `CREATE TABLE`, so their names are generated, and a hardcoded guess that misses
  // would leave the old key in place while this migration reports success -- the failure mode
  // being that duplicate-hash rows keep getting dropped silently, which is the whole bug.
  const [pk] = await sql<{ conname: string }[]>`
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema} AND t.relname = 'transactions' AND c.contype = 'p'
  `;
  if (pk === undefined) {
    throw new Error(
      `${schema}.transactions has no primary key to replace; refusing to continue, because the ` +
        "table is not in the shape this migration was written against.",
    );
  }

  // The unique constraint on position, which is about to become the primary key. Identified by its
  // column set rather than its name, for the same reason.
  const [positionUnique] = await sql<{ conname: string }[]>`
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema} AND t.relname = 'transactions' AND c.contype = 'u'
      AND (
        -- attname is of type name, not text; without the casts this comparison is
        -- name[] = text[], for which Postgres has no operator. (No backticks in here:
        -- this is inside a JS template literal, and one would end the string.)
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM unnest(c.conkey) k
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
      ) = ARRAY['block_hash', 'block_height', 'net', 'position']::text[]
  `;

  // Order matters: the new primary key duplicates the old unique constraint's columns, so that
  // constraint is dropped first. Postgres would otherwise keep both, leaving a redundant index to
  // maintain on every write.
  if (positionUnique !== undefined) {
    await sql`ALTER TABLE ${sql(schema)}.transactions DROP CONSTRAINT ${sql(positionUnique.conname)}`;
  }
  await sql`ALTER TABLE ${sql(schema)}.transactions DROP CONSTRAINT ${sql(pk.conname)}`;
  await sql`
    ALTER TABLE ${sql(schema)}.transactions
      ADD PRIMARY KEY (net, block_height, block_hash, position)
  `;
}
