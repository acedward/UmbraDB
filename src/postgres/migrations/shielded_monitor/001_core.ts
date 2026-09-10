import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `monitors` / `associations` / `lifecycle_events` / `audit_events` DDL for the **project-B
 * shielded-monitor lineage** (organizer spec
 * `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`, FR-001..005,
 * FR-010..016, FR-022..026; design rationale in
 * `openspec/changes/00009-02-monitor-store/design.md`).
 *
 * Like the Tier-1.5 chain-archive lineage (`design/full-chain-storage-design.md` §5), this is an
 * INDEPENDENT lineage applied to its own schema (conventionally `shielded_monitor`) via
 * `shieldedMonitorMigrations` (`./index.ts`), never via `tier1WalletMigrations`. The separation is
 * not tidiness here: owner **Rule B** (spec US5) requires that project B never writes to an
 * archive table and that it stay restorable on its own so it can later run in a separate process
 * or TEE with no schema access to project A at all (FR-025). Two schemas with no shared table is
 * the mechanical form of that rule.
 *
 * Nothing in this file references `chain_archive` or `tier1_wallet`. Archive identity reaches this
 * schema only as two OPAQUE caller-supplied strings (`source_genesis_hash`, `source_instance_id`);
 * B never learns how the archive computes them, which is what keeps the Phase-1 read contract a
 * pure interface boundary rather than a schema dependency.
 *
 * ── What is deliberately NOT here (deferred with User Story 4, owner decision 2026-09-10) ──────
 * `key_serialized` holds the **plaintext** serialized encryption secret key. There is no envelope
 * encryption, no key-encryption key, no rotation column and no tenant column. Anyone with read
 * access to this schema can read every registered viewing key. That is a stated, accepted property
 * of the alpha (spec FR-002 and the "Assumptions" section), documented in `SECURITY.md` and
 * `docs/shielded-monitor-restore.md` — not an oversight. The seams for adding protection later are
 * described in the design doc §12 and are all additive.
 */
export const name = "001_core";

export async function up(sql: ISql, schema: string): Promise<void> {
  // Defense in depth, matching every other migration in this repo: `runMigrations` already
  // validated `opts.schema`, but a caller invoking `up()` directly bypasses that gate.
  assertValidSchemaName(schema);

  // -----------------------------------------------------------------------------------------
  // monitors — one registered viewing key for one network.
  //
  // `epoch` is the fence (spec FR-012). Every lifecycle transition bumps it by one; every
  // coverage advance is admitted only when the caller's epoch still equals the stored one, so a
  // worker holding a stale view cannot commit after a pause, revoke or delete. This is the same
  // CAS shape as `Formal/STORAGE_ALGEBRA.md` §1's Law T2 (`WHERE version = expected`), applied to
  // a different column; it deliberately does NOT reopen §4's decision to keep fencing tokens out
  // of the lease layer (design doc §6).
  //
  // `last_assoc_seq` is the per-monitor association counter. A PostgreSQL SEQUENCE would be
  // global and non-transactional (a rolled-back batch would burn numbers), which would make the
  // Phase-4 cursor gappy; a plain column advanced inside the fencing UPDATE is atomic with the
  // coverage advance, fenced by the same predicate, and gapless (design doc §6.1).
  //
  // `fingerprint` is NULLable ONLY so `delete` can null it: `UNIQUE (net, fingerprint)` treats
  // NULLs as distinct, so a deleted monitor's tombstone stops occupying its key's identity and
  // re-registering that key mints a fresh monitor -- which is what spec US3 scenario 4 ("as if
  // the monitor never existed") requires. A live monitor always has one (CHECK below).
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.monitors (
      id                     uuid        PRIMARY KEY,
      net                    text        NOT NULL CHECK (net ~ '^[A-Za-z0-9_-]{1,64}$'),
      fingerprint            bytea       CHECK (fingerprint IS NULL OR octet_length(fingerprint) = 32),
      key_serialized         bytea       CHECK (key_serialized IS NULL OR octet_length(key_serialized) BETWEEN 1 AND 4096),
      state                  text        NOT NULL CHECK (state IN (
                                           'backfilling', 'live', 'paused',
                                           'failed', 'stale_source', 'revoked', 'deleted')),
      epoch                  bigint      NOT NULL CHECK (epoch >= 0),
      last_assoc_seq         bigint      NOT NULL DEFAULT 0 CHECK (last_assoc_seq >= 0),
      requested_start_height bigint      NOT NULL CHECK (requested_start_height >= 0),
      scanned_from_height    bigint      CHECK (scanned_from_height IS NULL OR scanned_from_height >= 0),
      scanned_through_height bigint      CHECK (scanned_through_height IS NULL OR scanned_through_height >= 0),
      source_genesis_hash    text        CHECK (source_genesis_hash IS NULL OR octet_length(source_genesis_hash) BETWEEN 1 AND 256),
      source_instance_id     text        CHECK (source_instance_id IS NULL OR octet_length(source_instance_id) BETWEEN 1 AND 256),
      matching_rule_version  text        NOT NULL CHECK (octet_length(matching_rule_version) BETWEEN 1 AND 64),
      ledger_build           text        NOT NULL CHECK (octet_length(ledger_build) BETWEEN 1 AND 128),
      last_error             jsonb,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),

      -- Coverage is a pair of block heights, and a through-height without a from-height is not a
      -- coverage claim anyone can interpret (spec FR-011).
      CONSTRAINT monitors_coverage_shape CHECK (
        scanned_through_height IS NULL
        OR (scanned_from_height IS NOT NULL AND scanned_from_height <= scanned_through_height)
      ),
      -- A deleted monitor has shed BOTH its key and its fingerprint; every other monitor has
      -- BOTH. Written as a CASE rather than an equality between two booleans: the equality form
      -- accepts the half-shredded rows (key gone, fingerprint kept) that are exactly the bug
      -- worth catching — a monitor that silently stops matching while still occupying its key's
      -- registration identity.
      CONSTRAINT monitors_deleted_is_shredded CHECK (
        CASE WHEN state = 'deleted'
             THEN key_serialized IS NULL AND fingerprint IS NULL
             ELSE key_serialized IS NOT NULL AND fingerprint IS NOT NULL
        END
      )
    )
  `;

  // Registration identity (spec FR-003/FR-004). Partial on a non-null fingerprint so any number
  // of deleted tombstones can coexist; a UNIQUE index would already treat NULLs as distinct, but
  // the partial index also keeps the tombstones out of the index entirely.
  await sql`
    CREATE UNIQUE INDEX monitors_net_fingerprint_key
      ON ${sql(schema)}.monitors (net, fingerprint)
      WHERE fingerprint IS NOT NULL
  `;

  // The scanner's work list (spec FR-014's bounded per-monitor scheduling).
  await sql`
    CREATE INDEX monitors_scannable
      ON ${sql(schema)}.monitors (net, state)
      WHERE state IN ('backfilling', 'live')
  `;

  // -----------------------------------------------------------------------------------------
  // associations — one relevant transaction observation for one monitor (spec FR-008/FR-009).
  //
  // Plaintext columns with a per-monitor sequence: spec FR-022's encrypted-content requirement is
  // DEFERRED with User Story 4, and FR-022 as approved says exactly this shape.
  //
  // `applied_outcome` is CHECK-pinned to 'unknown'. The alpha computes no applied outcome and
  // must never look as though it did (spec FR-009, and the "nothing claims funds were received"
  // acceptance scenario); a CHECK makes that un-writeable instead of merely documented. The
  // archive's own replay verdict, when the caller has one, goes in the separate nullable
  // `source_outcome` column so the two can never be confused.
  //
  // `block_hash`/`tx_hash` are length-bounded rather than pinned to 32 bytes: they are opaque
  // identity supplied by project A through the read contract, and B is not the place to encode an
  // assumption about A's hash width.
  // -----------------------------------------------------------------------------------------
  // A CHECK constraint may not contain a subquery ("cannot use subquery in check constraint",
  // SQLSTATE 0A000 — confirmed empirically against PostgreSQL 17 while writing this migration),
  // and "every element of this array is non-negative" has no subquery-free spelling. An
  // IMMUTABLE SQL helper is the standard way out and matches this repository's existing practice
  // of putting constraint logic in a schema-local function (`chain_archive_assert_blob_role` in
  // the Tier-1.5 lineage). `pg_dump` emits functions before tables, so a dump/restore of this
  // schema reproduces the constraint — asserted, not assumed, by
  // `test/shielded-monitor/restore-drill.integration.test.ts`, which performs a real
  // `pg_dump`/`psql` round trip.
  await sql`
    CREATE FUNCTION ${sql(schema)}.shielded_monitor_valid_segments(segs smallint[])
    RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
      -- COALESCE matters: for an EMPTY array both array_ndims and array_length return NULL, so
      -- the bare comparisons would evaluate to NULL, and a CHECK passes on NULL. Confirmed
      -- empirically: without the COALESCE, '{}'::smallint[] was accepted.
      SELECT COALESCE(array_ndims(segs), 0) = 1
         AND COALESCE(array_length(segs, 1), 0) >= 1
         AND array_position(segs, NULL) IS NULL
         AND NOT EXISTS (SELECT 1 FROM unnest(segs) AS s(v) WHERE s.v < 0)
    $fn$
  `;

  await sql`
    CREATE TABLE ${sql(schema)}.associations (
      monitor_id            uuid        NOT NULL REFERENCES ${sql(schema)}.monitors (id) ON DELETE CASCADE,
      seq                   bigint      NOT NULL CHECK (seq > 0),
      net                   text        NOT NULL CHECK (net ~ '^[A-Za-z0-9_-]{1,64}$'),
      block_height          bigint      NOT NULL CHECK (block_height >= 0),
      block_hash            bytea       NOT NULL CHECK (octet_length(block_hash) BETWEEN 1 AND 64),
      position              integer     NOT NULL CHECK (position >= 0),
      tx_hash               bytea       NOT NULL CHECK (octet_length(tx_hash) BETWEEN 1 AND 64),
      protocol_version      bigint      NOT NULL CHECK (protocol_version >= 0),
      matched_segments      smallint[]  NOT NULL CHECK (
                                          ${sql(schema)}.shielded_monitor_valid_segments(matched_segments)
                                        ),
      applied_outcome       text        NOT NULL DEFAULT 'unknown' CHECK (applied_outcome = 'unknown'),
      source_outcome        text        CHECK (source_outcome IS NULL OR octet_length(source_outcome) BETWEEN 1 AND 64),
      matching_rule_version text        NOT NULL CHECK (octet_length(matching_rule_version) BETWEEN 1 AND 64),
      ledger_build          text        NOT NULL CHECK (octet_length(ledger_build) BETWEEN 1 AND 128),
      created_at            timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (monitor_id, seq),
      -- One association per monitor per transaction OBSERVATION. Position-keyed, not hash-keyed:
      -- the same transaction hash can legitimately appear at two positions (spec's edge cases),
      -- and those stay two distinct observations.
      CONSTRAINT associations_observation_key UNIQUE (monitor_id, block_height, block_hash, position)
    )
  `;

  // Coverage-ordered reads (spec FR-019's "(blockHeight, position) order"). The PK already serves
  // cursor paging by `seq`.
  await sql`
    CREATE INDEX associations_by_height
      ON ${sql(schema)}.associations (monitor_id, block_height, position)
  `;

  // -----------------------------------------------------------------------------------------
  // lifecycle_events — the ordered record of transitions (spec FR-015).
  //
  // No ON DELETE CASCADE from `monitors` is needed in practice, because `delete` keeps the
  // tombstone row; the cascade above exists for `associations` only. The lifecycle log therefore
  // survives a delete, which is the point: it is the record of WHAT WAS DONE, and a delete is one
  // of the things that was done.
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.lifecycle_events (
      monitor_id  uuid        NOT NULL REFERENCES ${sql(schema)}.monitors (id) ON DELETE CASCADE,
      seq         bigint      NOT NULL CHECK (seq > 0),
      event       text        NOT NULL CHECK (event IN (
                                'register', 'go_live', 'pause', 'resume',
                                'fail', 'mark_stale_source', 'revoke', 'delete')),
      state_before text       CHECK (state_before IS NULL OR state_before IN (
                                'backfilling', 'live', 'paused',
                                'failed', 'stale_source', 'revoked', 'deleted')),
      state_after text        NOT NULL CHECK (state_after IN (
                                'backfilling', 'live', 'paused',
                                'failed', 'stale_source', 'revoked', 'deleted')),
      epoch_after bigint      NOT NULL CHECK (epoch_after >= 0),
      actor       text        NOT NULL CHECK (octet_length(actor) BETWEEN 1 AND 128),
      at          timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (monitor_id, seq)
    )
  `;

  // -----------------------------------------------------------------------------------------
  // audit_events — a minimal operator-facing trail for acts that are not state transitions
  // (a registration attempt that was refused, a revocation list re-applied after a restore).
  //
  // `detail` is jsonb and MUST NOT be given key material: it is written by this module only, and
  // the one call site that could plausibly carry a key (a refused registration) records the
  // failure reason, never the input. There is no database-level way to enforce that, so it is
  // stated here and asserted by the key-not-logged test instead.
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.audit_events (
      id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at         timestamptz NOT NULL DEFAULT now(),
      actor      text        NOT NULL CHECK (octet_length(actor) BETWEEN 1 AND 128),
      action     text        NOT NULL CHECK (octet_length(action) BETWEEN 1 AND 64),
      monitor_id uuid,
      detail     jsonb
    )
  `;

  await sql`
    CREATE INDEX audit_events_by_monitor
      ON ${sql(schema)}.audit_events (monitor_id, at)
      WHERE monitor_id IS NOT NULL
  `;
}
