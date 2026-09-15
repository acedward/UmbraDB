import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `dust_events`: the DUST ledger events the ingest's replay already computes, kept instead of
 * discarded (`spec/00016-dust-wallet-sync.md` §5.3, FR-001).
 *
 * WHY. Replaying preprod's 1.49 M DUST ledger events is what costs a wallet its two hours today:
 * the SDK fetches them from the indexer and folds them one wallet at a time. The ingest already
 * produces exactly those events while applying each block (`TransactionResult.events` for regular
 * transactions, the second element of `applySystemTx` for system ones) and throws them away. This
 * table is that work, written down once, so the node can fold it once and every wallet reads trees
 * instead of re-folding history.
 *
 * WHY `raw` IS A PLAIN `bytea` AND NOT A `chain_blobs` ROLE. Every other raw payload in this schema
 * is content-addressed because it is large and repeats (a block body, a transaction). A serialized
 * `Event` is ~250-1300 B (measured: 253 B for a `dustInitialUtxo`, 139 B for a `dustSpendProcessed`,
 * 1290 B for a `dustGenerationDtimeUpdate` with its 32-entry path) and is unique by construction --
 * it carries its own transaction hash and tree position. Content-addressing it would add a blob
 * row, a role row and a trigger round-trip per event for no deduplication at all, and would drag
 * the blob-role removal guard's table enumeration (004) along with it.
 *
 * WHY `id` IS NOT AN IDENTITY COLUMN. The consumer contract is "dense per net, in ledger execution
 * order" (FR-001): the node pages the table with `WHERE id > $1 ORDER BY id`, and a gap would make
 * it either stall or silently skip events. An `IDENTITY`/sequence allocates on INSERT ATTEMPT, so
 * every rolled-back or conflicting block would burn ids and leave holes. The writer therefore
 * assigns `COALESCE(max(id), 0) + row_number()` inside the block's own transaction
 * (`src/postgres/chain-archive-store.ts`), which is safe because the archive has exactly one
 * writer per net and that writer holds this height's advisory lock.
 *
 * WHY NOT PARTITIONED, unlike `transactions`/`bridge_observations`. Those are keyed by
 * `(net, block_height, ...)` and partitioned on the height column. This table's primary key is
 * `(net, id)` -- a partitioned table requires every partition key column to be part of every
 * unique key, so partitioning by `block_height` would force `block_height` into the PK and break
 * the dense-id read path the node depends on. The volume does not need it: preprod's whole DUST
 * history is ~1.49 M rows (~1 GB with indexes), two orders of magnitude below `transactions`.
 *
 * THE FK targets the PARTITIONED PARENT `blocks (net, height, block_hash)`, exactly as
 * `004_replay_checkpoints` does -- an FK from an ordinary table to a range-partitioned one is
 * accepted by Postgres and is what makes "an event for a block this archive does not hold"
 * unstorable rather than merely unlikely.
 *
 * ADDITIVE. No existing table, column, constraint, trigger or function changes. An archive that
 * never runs replay simply keeps this table empty, and every pre-existing reader and writer is
 * unaffected.
 *
 * The read-only role the TEE-side node uses is NOT created here (a migration must not mint
 * credentials): `docs/shielded-monitor-deployment.md` and `docs/SCHEMA.md` carry the operator's
 * `CREATE ROLE dust_reader ... GRANT SELECT` recipe.
 */
export const name = "009_dust_events";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  // Same discovery-not-assumption preflight as 003-005 and 008: confirm the table this migration
  // attaches its foreign key to is the one it was written against, rather than failing halfway
  // through the CREATE.
  const [table] = await sql<{ n: string }[]>`
    SELECT c.relname AS n
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = ${schema} AND c.relname = 'blocks' AND c.relkind = 'p'
  `;
  if (table === undefined) {
    throw new Error(
      `${schema}.blocks does not exist as a partitioned table; refusing to continue, because this ` +
        "migration adds a foreign key to the table 001 was supposed to have created.",
    );
  }

  await sql`
    CREATE TABLE ${sql(schema)}.dust_events (
      net              text     NOT NULL,
      -- Dense per net, in ledger EXECUTION order, which is NOT the archive's row order: the
      -- reference indexer lists a block's system transactions first, while the ledger executes
      -- them in Substrate phase order.
      id               bigint   NOT NULL CHECK (id > 0),
      block_height     bigint   NOT NULL CHECK (block_height >= 0),
      block_hash       bytea    NOT NULL CHECK (octet_length(block_hash) = 32),
      -- Position in ReplayBlockInput.transactions, i.e. the ledger's execution order.
      tx_position      integer  NOT NULL CHECK (tx_position >= 0),
      -- Index within that transaction's own event list.
      event_index      integer  NOT NULL CHECK (event_index >= 0),
      -- The event's own EventSource.transaction_hash: the same value chain_archive.transactions
      -- is keyed by, so the two join.
      tx_hash          bytea    NOT NULL CHECK (octet_length(tx_hash) = 32),
      -- 1 = dustInitialUtxo, 2 = dustGenerationDtimeUpdate, 3 = dustSpendProcessed.
      kind             smallint NOT NULL CHECK (kind IN (1,2,3)),
      -- Field elements are numeric(78): a BN254 scalar is below 2^254, which is 77 decimal
      -- digits. They are decimal strings at the API boundary (spec §4) because the WASM
      -- bindings hand them over as BigInt.
      owner            numeric(78),
      commitment       numeric(78),
      commitment_index bigint   CHECK (commitment_index IS NULL OR commitment_index >= 0),
      generation_index bigint   CHECK (generation_index IS NULL OR generation_index >= 0),
      nullifier        numeric(78),
      -- u128, i.e. at most 39 decimal digits.
      v_fee            numeric(39),
      declared_time    bigint,
      block_time       bigint   NOT NULL,
      -- kind 2: the generation's new end time; kind 1: its initial one, which is usually absent.
      -- NULL means "this generation has no end time", never "not decoded yet".
      dtime            bigint,
      payload          jsonb    NOT NULL,
      -- Event.serialize() -- tagged_serialize, so a concatenation of these is exactly what
      -- DustLocalState.replayRawEvents consumes (FR-002, verified on real events).
      raw              bytea    NOT NULL CHECK (octet_length(raw) > 0),
      PRIMARY KEY (net, id),
      -- What makes re-ingesting a block a silent no-op rather than a duplicate: the identity of
      -- an event is where it happened, not the id the writer assigned it.
      UNIQUE (net, block_height, block_hash, tx_position, event_index),
      FOREIGN KEY (net, block_height, block_hash)
        REFERENCES ${sql(schema)}.blocks (net, height, block_hash),
      -- Per-kind column presence. Without this a mis-mapped event is a row full of NULLs that
      -- every later query silently skips; the node's routes read these columns directly.
      CONSTRAINT dust_events_kind_columns CHECK (
        CASE kind
          WHEN 1 THEN owner IS NOT NULL AND commitment IS NOT NULL
                  AND commitment_index IS NOT NULL AND generation_index IS NOT NULL
                  AND nullifier IS NULL AND v_fee IS NULL AND declared_time IS NULL
          -- kind 2 deliberately carries NO owner: spec section 5.2 resolves a dtime update to
          -- its generation entry by index, and the owner is the kind-1 row's (section 5.7's
          -- selectGenerationByOwner joins the two). Storing it twice would create a second
          -- place for the same fact to be wrong.
          WHEN 2 THEN generation_index IS NOT NULL
                  AND owner IS NULL
                  AND commitment IS NULL AND commitment_index IS NULL
                  AND nullifier IS NULL AND v_fee IS NULL AND declared_time IS NULL
          WHEN 3 THEN commitment IS NOT NULL AND commitment_index IS NOT NULL
                  AND nullifier IS NOT NULL AND v_fee IS NOT NULL
                  AND declared_time IS NOT NULL
                  AND owner IS NULL AND generation_index IS NULL AND dtime IS NULL
        END
      )
    )
  `;

  // "Every initial UTxO of this owner, in order" -- the wallet's first question (FR-016).
  await sql`
    CREATE INDEX dust_events_owner_idx
      ON ${sql(schema)}.dust_events (net, owner, id) WHERE kind = 1
  `;
  // "Was this nullifier spent?" -- the one query POST /v1/dust/lookup runs, once per wallet round
  // (FR-015). It must be a single indexed probe over up to 1 000 nullifiers.
  await sql`
    CREATE INDEX dust_events_nullifier_idx
      ON ${sql(schema)}.dust_events (net, nullifier) WHERE kind = 3
  `;
  // "The latest dtime for this generation entry" -- kind-1 and kind-2 rows merged by index.
  await sql`
    CREATE INDEX dust_events_gen_idx
      ON ${sql(schema)}.dust_events (net, generation_index, id) WHERE kind IN (1,2)
  `;
  // Height lookups: the mirror reports its applied tip as a height, and the backfill works in
  // height order.
  await sql`
    CREATE INDEX dust_events_height_idx
      ON ${sql(schema)}.dust_events (net, block_height)
  `;
}
