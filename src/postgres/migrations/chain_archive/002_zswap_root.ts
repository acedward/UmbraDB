import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * Sprint 9 / effectstream migration Phase 1 -- per-block zswap state root and block timestamp,
 * plus the first two versioned READ VIEWS of the primitive feed.
 *
 * WHY these two columns and not more: this migration exists to make ONE effectstream primitive
 * (`Midnight:ZswapRoot`) readable straight out of UmbraDB, with no ledger replay. That primitive
 * needs exactly a root per block and a transaction hash to attribute it to; the sync engine
 * additionally needs a block timestamp to place the block on the root chain's clock
 * (`MidnightSyncState.toRootPage`). Everything else the primitive migration will eventually need
 * -- applied ledger events, per-segment success, unshielded UTXO deltas -- is an output of
 * stateful replay and gets its own migration when that engine lands. Keeping this one narrow is
 * what lets the whole read path be proven end to end before that much larger commitment.
 *
 *   - `blocks.zswap_state_root`: nullable bytea -- the node's `midnight_zswapStateRoot` at this
 *     block (33 bytes observed live: 1-byte version tag + 32-byte digest; the CHECK allows 32..64
 *     rather than pinning a tagged length as if it were guaranteed). Nullable because rows
 *     ingested before this migration, or by an ingest configured without root capture, have no
 *     value -- absence is honest, not zero.
 *   - `blocks.timestamp_ms`: nullable bigint -- milliseconds since the Unix epoch, decoded from
 *     the block's own `Timestamp::set` inherent. Nullable for the same reason.
 *
 * **Equivalence to the indexer's value is measured, not assumed.** The indexer reports a
 * `zswapMerkleTreeRoot` per REGULAR TRANSACTION, recomputed after applying each one
 * (`midnight-indexer/chain-indexer/src/domain/ledger_state.rs:139`), and effectstream's fetcher
 * consumes the LAST such transaction in a block (`sync-protocols/midnight/fetcher.ts:324`) --
 * which is the post-block state, exactly what the node's runtime API returns at that block hash.
 * Probed live against a 1.0.0 devnet over the full chain: 17/17 rooted blocks matched
 * byte-for-byte, and a block with no rooted transaction returned the previous rooted block's root
 * (the tree did not advance). Caveat recorded honestly: that corpus contained no block with two
 * regular transactions producing DIFFERENT roots, so the "last transaction wins" reading is
 * strongly supported but not yet discriminated -- `feed_zswap_roots_v1` therefore derives its
 * `tx_hash` from the archive's own transaction ordering rather than trusting a single-tx
 * coincidence, and the integration test constructs the two-in-one-block case.
 */

export const name = "002_zswap_root";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  // ---------------------------------------------------------------------------------------
  // blocks.zswap_state_root / blocks.timestamp_ms -- one runtime-API call and one inherent
  // decode per block at ingest time. Both nullable: see the header on why absence is modelled
  // rather than defaulted.
  // ---------------------------------------------------------------------------------------
  await sql`
    ALTER TABLE ${sql(schema)}.blocks
      ADD COLUMN zswap_state_root bytea
        CHECK (zswap_state_root IS NULL OR octet_length(zswap_state_root) BETWEEN 32 AND 64)
  `;

  // Milliseconds, not seconds: `pallet_timestamp::set` carries a `Compact<u64>` moment in ms
  // (verified against a live block-45 inherent, `0x280501000be07b93d89f01` -> 1786044972000).
  // A bigint is required -- ms since epoch exceeds int4 by three orders of magnitude.
  await sql`
    ALTER TABLE ${sql(schema)}.blocks
      ADD COLUMN timestamp_ms bigint
        CHECK (timestamp_ms IS NULL OR timestamp_ms >= 0)
  `;

  // The protocol version is a property of the BLOCK -- it comes from the header's
  // `Consensus("MNSV", u32)` digest item -- but 001 only persisted it per transaction, so a block
  // with no transactions carried it nowhere. Storing it here is not new information (ingest
  // already decodes it for every block, to gate the ledger codec) and it means a block feed can
  // report the version without inventing one for empty blocks.
  await sql`
    ALTER TABLE ${sql(schema)}.blocks
      ADD COLUMN protocol_version integer
        CHECK (protocol_version IS NULL OR protocol_version >= 0)
  `;

  // ---------------------------------------------------------------------------------------
  // feed_blocks_v1 -- the versioned block feed. The database is the interface: consumers query
  // views, never tables, so the layout underneath can evolve behind a stable contract.
  //
  // Canonical rows only. A consumer driving a state machine must never observe a block that
  // later turns out to be off-chain, and `blocks` deliberately models the whole block tree
  // (competing blocks at one height), so filtering here is what makes the feed safe to read
  // without every consumer re-implementing fork awareness.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE VIEW ${sql(schema)}.feed_blocks_v1 AS
      SELECT
        b.net,
        b.height,
        encode(b.block_hash, 'hex')       AS block_hash,
        encode(b.parent_hash, 'hex')      AS parent_hash,
        b.timestamp_ms,
        b.protocol_version,
        encode(b.zswap_state_root, 'hex') AS zswap_state_root,
        b.finalized
      FROM ${sql(schema)}.blocks b
      WHERE b.is_canonical
  `;

  // ---------------------------------------------------------------------------------------
  // feed_zswap_roots_v1 -- one row per canonical block that BOTH carries a captured root AND
  // contains at least one regular transaction.
  //
  // The trigger condition is deliberately a faithful copy of the consumer's existing one, not an
  // improvement on it: effectstream emits a ZswapRoot input when the block contains a regular
  // transaction carrying a root, attributed to the LAST such transaction, REGARDLESS of whether
  // the root actually changed from the previous block (`fetcher.ts:316-346`). Emitting only on
  // change would be a smaller feed and a silently different trigger -- and this migration's whole
  // purpose is to preserve when the state machine fires.
  //
  // `tx_hash` is resolved from the archive's own ordering (`transactions.position`, the column
  // 001 already keeps unique per block) rather than from anything the root capture knows, so a
  // block with several regular transactions attributes the post-block root to the last one --
  // which is precisely what the indexer-backed path does.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE VIEW ${sql(schema)}.feed_zswap_roots_v1 AS
      SELECT
        b.net,
        b.height                          AS block_height,
        encode(b.block_hash, 'hex')       AS block_hash,
        encode(b.zswap_state_root, 'hex') AS root,
        last_tx.tx_hash,
        last_tx.position                  AS tx_position
      FROM ${sql(schema)}.blocks b
      JOIN LATERAL (
        SELECT encode(t.tx_hash, 'hex') AS tx_hash, t.position
        FROM ${sql(schema)}.transactions t
        WHERE t.net = b.net
          AND t.block_height = b.height
          AND t.block_hash = b.block_hash
          AND t.kind = 'regular'
        ORDER BY t.position DESC
        LIMIT 1
      ) AS last_tx ON true
      WHERE b.is_canonical
        AND b.zswap_state_root IS NOT NULL
  `;
}
