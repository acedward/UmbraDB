import type { ISql } from "postgres";

/**
 * Part C — the `evm_rpc` schema's EVM log store: `logs`, `log_cursors`, and (conditionally)
 * `address_map`.
 *
 * ── Why `010` and not `001` ────────────────────────────────────────────────────────────────────
 * The `evm_rpc` lineage is OWNED by Part A1/A2 (sync + wallet-monitor), which contributes the
 * schema's earlier migrations. That work has not landed in this clone, so this file is numbered to
 * sort AFTER a plausible `001`..`009` from A1/A2 rather than colliding with it. At the Part F merge
 * the two lineages concatenate in name order and this migration stays last — no renumbering, no
 * rewritten history.
 *
 * ── Why `address_map` is created `IF NOT EXISTS` ───────────────────────────────────────────────
 * `logs.address_id` references `address_map`, which **A1/A2 owns**. Two requirements collide: this
 * migration must be applicable STANDALONE in this clone (so C's tests exercise real DDL), and it
 * must not fight A1/A2's own definition after the merge. `CREATE TABLE IF NOT EXISTS` satisfies
 * both — standalone it provides the table, merged it is a no-op because A1/A2's earlier-numbered
 * `001_evm_rpc_core` already created it.
 *
 * The definition below is a BYTE-FOR-BYTE MIRROR of that migration's `address_map`, verified
 * against the running Part A stack's live schema (`postgres://…:10010/umbradb`), not guessed: same
 * `evm_addr` / `kind` / `mn_address` / `meta` / `first_seen_block` columns, same checks, same unique
 * keys. Mirroring rather than inventing a narrower shape is what makes Part C's queries work
 * unchanged against the merged schema. If A1/A2 revise it, the single place Part C has to follow is
 * `evm-rpc/logs/address-map.ts`, which owns every read and write of this table.
 *
 * `mn_address` is TEXT (unprefixed hex), not bytea, and is UNIQUE GLOBALLY rather than per-`kind` —
 * both are A1/A2's choices, and Part C's upsert conflict target follows from them.
 *
 * ── Deliberately NOT `bytea(32)` ───────────────────────────────────────────────────────────────
 * Postgres has no length-parameterised `bytea`; `bytea(32)` is a syntax error, not a 32-byte
 * constraint. The plan's `bytea(32)` intent is expressed as `CHECK (octet_length(...) = 32)`, which
 * is what actually rejects a short topic at insert time instead of silently storing it.
 */
export const name = "010_logs";

export async function up(sql: ISql, schema: string): Promise<void> {
  // ---- address_map (A1/A2-owned; see the header note) ----------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(schema)}.address_map (
      id               bigserial PRIMARY KEY,
      -- keccak256(identity)[12:32], or the identity itself when it is already 20 bytes. UNIQUE
      -- because two identities claiming one EVM address would silently pool two accounts'
      -- balances: it must be a hard error, not a merge.
      evm_addr         bytea NOT NULL UNIQUE CHECK (octet_length(evm_addr) = 20),
      -- 'midnight' = a user accountId (persistentHash(sk)); 'contract' = a Midnight contract
      -- address; 'ethereum' = a Part E native identity that arrives already 20 bytes.
      kind             text NOT NULL CHECK (kind IN ('midnight', 'ethereum', 'contract')),
      -- The source identity as unprefixed hex TEXT. NULL for an 'ethereum' identity, which has no
      -- Midnight-side preimage.
      mn_address       text UNIQUE,
      meta             jsonb,
      first_seen_block bigint
    )
  `;

  // ---- logs ----------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.logs (
      id              bigserial PRIMARY KEY,
      address_id      bigint  NOT NULL REFERENCES ${sql(schema)}.address_map (id),
      block_number    bigint  NOT NULL,
      block_hash      bytea   NOT NULL CHECK (octet_length(block_hash) = 32),
      tx_hash         bytea   NOT NULL CHECK (octet_length(tx_hash) = 32),
      tx_index        int     NOT NULL CHECK (tx_index >= 0),
      log_index       int     NOT NULL CHECK (log_index >= 0),
      topic0          bytea   NOT NULL CHECK (octet_length(topic0) = 32),
      topic1          bytea            CHECK (topic1 IS NULL OR octet_length(topic1) = 32),
      topic2          bytea            CHECK (topic2 IS NULL OR octet_length(topic2) = 32),
      topic3          bytea            CHECK (topic3 IS NULL OR octet_length(topic3) = 32),
      data            bytea   NOT NULL,
      removed         boolean NOT NULL DEFAULT false,
      -- The source contract-event id this row is keyed on (for a Spend/Receive pair, the LOWER of
      -- the two). UNIQUE is what makes the at-least-once contractEvents subscription safely
      -- replayable: a redelivered event's INSERT conflicts and is skipped.
      --
      -- Genesis-backfill rows (C-G5) use a NEGATIVE sequence, since constructor-minted supply has
      -- no source event at all (Compact forbids emit in constructors). Negative ids therefore
      -- cannot collide with real event ids, which the indexer only ever issues as positive.
      source_event_id bigint  NOT NULL UNIQUE,
      -- Topics are positional: a gap (topic2 set while topic1 is NULL) would make eth_getLogs
      -- position matching meaningless, so it is rejected rather than tolerated.
      CONSTRAINT logs_topics_contiguous CHECK (
        (topic1 IS NOT NULL OR (topic2 IS NULL AND topic3 IS NULL))
        AND (topic2 IS NOT NULL OR topic3 IS NULL)
      ),
      -- One log per (transaction, position); catches a mapping bug that reused a log_index.
      CONSTRAINT logs_tx_position_unique UNIQUE (tx_hash, log_index)
    )
  `;

  // The two access paths `eth_getLogs` actually takes: filter by address over a block range, and
  // filter by topic0 over a block range (the shape every ERC20 `Transfer` scan uses).
  await sql`CREATE INDEX logs_address_block_idx ON ${sql(schema)}.logs (address_id, block_number)`;
  await sql`CREATE INDEX logs_topic0_block_idx  ON ${sql(schema)}.logs (topic0, block_number)`;
  // Part B's receipts read every log of one transaction, in position order.
  await sql`CREATE INDEX logs_tx_hash_idx       ON ${sql(schema)}.logs (tx_hash, log_index)`;
  // `blockHash`-form filters (the `eth_getLogs` variant that is mutually exclusive with a range).
  await sql`CREATE INDEX logs_block_hash_idx    ON ${sql(schema)}.logs (block_hash)`;

  // ---- log_cursors ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.log_cursors (
      -- The watched MIDNIGHT contract address bytes (not the derived EVM address): this is the
      -- key the contractEvents subscription is opened with, so the cursor is stored under the
      -- same identifier the subscription filter uses.
      contract_address bytea  PRIMARY KEY,
      -- Highest source event id whose logs are durably committed. The subscription resumes at
      -- last_event_id + 1. Advanced in the SAME transaction as the rows it accounts for, and
      -- only ever to a TRANSACTION boundary (see evm-rpc/logs/ingest.ts), so a crash can never
      -- leave the cursor past a half-written transaction's logs.
      last_event_id    bigint NOT NULL,
      updated_at       timestamptz NOT NULL DEFAULT now()
    )
  `;
}
