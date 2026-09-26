import type { ISql } from "postgres";

/**
 * Project 00024-01 — the `token_index` schema for **MIP-0018 values of any length, carried as
 * multi-part packages**.
 *
 * Spec: `/home/eddie/todo/Umbra/spec/00024-indexer-public-interface-multipart.md` (US2, US3,
 * FR-001–FR-009, FR-014), plan `plans/00024-01-mip-0018.md` task B1. Two changes in the standards
 * drive it, both recorded in `spec/00024-upstream-spec-changes.md`:
 *
 *  - **UC-1**: `mip-0018:token-metadata[v1]` is amended in place — `val-len` is 2 bytes
 *    (little-endian, offset 66), the value starts at 68 and may be any length `0..65535` within the
 *    package. One package carries one declaration.
 *  - **[Y] Multi-Part Event** (adopted unchanged, `compact-multi-part-event` PR #1 §4): events of an
 *    opted-in name from one contract, one transaction and one physical intent form ONE package, the
 *    concatenation of their 256-byte payloads in ledger emission order.
 *
 * ── What changes ───────────────────────────────────────────────────────────────────────────────
 *  1. **`token_metadata_events` holds one row per PACKAGE**, not per event: `payload` is the merged
 *     payload (`256 · parts` bytes), `part_event_ids` the indexer event ids of its parts in ledger
 *     emission order, and `event_id` — still the primary key — is the FIRST part's id (a package is
 *     positioned by its first part, derivation P1). `segment` is the physical intent every part came
 *     from (`EventSource.physicalSegment`) and `phase` is `guaranteed | fallible | mixed`, from the
 *     archived transcripts of the APPLIED parts ([Y] §5; a `mixed` package is a publisher error that
 *     is recorded, never dropped — FR-002). A draft-name (`legacy-mip-xxxx`) row is still exactly one
 *     event: that path is not opted into [Y] and keeps its behaviour (FR-006).
 *  2. **`val_len` up to 65 535** on both metadata tables (was `smallint`, `0..255` on the events
 *     table and `0..189` on the kv table). A REJECTED declaration keeps the length it DECLARED, even
 *     when that length runs past the package — that number is what its `reject_reason` is about.
 *  3. **`tx_position`** on the events and `updated_tx_position` on the kv table: MIP-0018 §6.2 orders
 *     declarations by block, then transaction position, then ledger execution order — "an indexer's
 *     monotonic event ID … does not define the normative order". The event id orders parts INSIDE a
 *     transaction only.
 *  4. **`pending_event_lookups` carries what a retry needs to rebuild the lookup exactly**: the
 *     transaction's position (for 3) and `emission`, the counted `log` ops of the contract's calls per
 *     intent and phase, from which every part's phase is derived (see `token-indexer/ingest/events.ts`).
 *  5. **`tokens_by_name` indexes a 256-character prefix** of the name (01-D audit F1): a name may now
 *     be longer than a B-tree entry can hold, and a refused index entry would stall the scanner.
 *
 * ── Why this drops and recreates (spec Q3, FR-014) ─────────────────────────────────────────────
 * Everything is in development: every local run starts from an empty chain and an empty database,
 * and no migration, backfill or rebuild procedure is written for existing rows. The three tables
 * are recreated empty and every row derived from them goes with them, for every net, exactly as
 * 004 did — the scanner re-reads the archive from the cursor this migration deletes.
 *
 * ── Deliberately NOT `bytea(32)` ───────────────────────────────────────────────────────────────
 * Postgres has no length-parameterised `bytea`; byte lengths are `CHECK (octet_length(...) = n)`,
 * following 001–004.
 */
export const name = "005_multipart_packages";

/** [Y]'s publisher ceiling, used by this reader as a SAFETY ceiling only (spec FR-004): no block
 *  can hold a package this large, so a response beyond it is an indexer error for that lookup,
 *  never a truncation. Spelled here and in `token-indexer/ingest/packages.ts`. */
export const MAX_PACKAGE_PARTS = 1024;

/** `val-len` is an unsigned 16-bit integer under UC-1. */
export const MAX_VAL_LEN_UC1 = 65_535;

export async function up(sql: ISql, schema: string): Promise<void> {
  // ---- out with the 004 shapes ---------------------------------------------------------------
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_metadata_kv`;
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.token_metadata_events`;
  await sql`DROP TABLE IF EXISTS ${sql(schema)}.pending_event_lookups`;

  // Every row derived from what those tables held — the same set 004 deletes, for the same reason.
  await sql`DELETE FROM ${sql(schema)}.token_activity`;
  await sql`DELETE FROM ${sql(schema)}.shielded_offers`;
  await sql`DELETE FROM ${sql(schema)}.contract_calls`;
  await sql`DELETE FROM ${sql(schema)}.token_mints`;
  await sql`DELETE FROM ${sql(schema)}.tokens`;
  await sql`DELETE FROM ${sql(schema)}.contracts`;
  await sql`DELETE FROM ${sql(schema)}.cursors`;

  // ---- pending_event_lookups (001's shape plus what a retry needs) ---------------------------
  await sql`
    CREATE TABLE ${sql(schema)}.pending_event_lookups (
      net             text        NOT NULL,
      tx_hash         bytea       NOT NULL CHECK (octet_length(tx_hash) = 32),
      address         bytea       NOT NULL CHECK (octet_length(address) = 32),
      block_height    bigint      NOT NULL CHECK (block_height >= 0),
      -- The transaction's index in its block: MIP-0018 §6.2's second ordering key.
      tx_position     int         NOT NULL CHECK (tx_position >= 0),
      expected_events int         NOT NULL CHECK (expected_events >= 0),
      -- The counted log ops of this contract's calls, per physical intent and phase:
      -- [{"segment": 7, "guaranteed": 2, "fallible": 1}, ...]. Their sum is expected_events.
      emission        jsonb       NOT NULL CHECK (jsonb_typeof(emission) = 'array'),
      got_events      int         NOT NULL DEFAULT 0 CHECK (got_events >= 0),
      attempts        int         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error      text,
      PRIMARY KEY (net, tx_hash, address)
    )
  `;
  await sql`
    CREATE INDEX pending_event_lookups_due
      ON ${sql(schema)}.pending_event_lookups (net, next_attempt_at)
  `;

  // ---- token_metadata_events: one row per PACKAGE (a draft-name row is one event) -------------
  await sql`
    CREATE TABLE ${sql(schema)}.token_metadata_events (
      net            text     NOT NULL,
      -- The FIRST part's indexer event id: the package's identity and, inside its transaction,
      -- its position (derivation P1). For a draft-name row, the event's own id.
      event_id       bigint   NOT NULL,
      -- Every part's indexer event id, in ledger emission order; part_event_ids[1] = event_id.
      part_event_ids bigint[] NOT NULL,
      parts          smallint NOT NULL CHECK (parts >= 1 AND parts <= 1024),
      -- EventSource.physicalSegment of every part (they are equal by construction, [Y] §4).
      segment        int      CHECK (segment IS NULL OR (segment >= 1 AND segment <= 65535)),
      -- From the archived transcripts of the APPLIED parts ([Y] §5, spec FR-002).
      phase          text     CHECK (phase IS NULL OR phase IN ('guaranteed','fallible','mixed')),
      address        bytea    NOT NULL CHECK (octet_length(address) = 32),
      tx_hash        bytea    NOT NULL CHECK (octet_length(tx_hash) = 32),
      block_height   bigint   NOT NULL CHECK (block_height >= 0),
      tx_position    int      NOT NULL CHECK (tx_position >= 0),
      name_variant   text     NOT NULL CHECK (name_variant IN ('mip-0018','legacy-mip-xxxx')),
      -- The merged payload: 256 bytes per part, every byte kept, trailing zeros included ([Y] §4).
      payload        bytea    NOT NULL,
      domain_sep     bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind_byte      smallint NOT NULL CHECK (kind_byte >= 0 AND kind_byte <= 255),
      key            bytea    NOT NULL CHECK (octet_length(key) = 32),
      key_hex        text     NOT NULL CHECK (key_hex ~ '^([0-9a-f][0-9a-f])*$'),
      key_text       text,
      val_type       smallint NOT NULL CHECK (val_type >= 0 AND val_type <= 255),
      -- The DECLARED length, 0..65535 under UC-1 (0..255 as one byte under the draft), recorded
      -- even when it runs past the package: that is what val_len_beyond_package is about.
      val_len        int      NOT NULL CHECK (val_len >= 0 AND val_len <= 65535),
      -- The payload's whole value field (from the value offset to the end), padding included.
      value          bytea    NOT NULL,
      applied        boolean  NOT NULL,
      reject_reason  text,
      PRIMARY KEY (net, event_id),
      CONSTRAINT events_payload_is_parts CHECK (octet_length(payload) = 256 * parts),
      CONSTRAINT events_part_ids_match CHECK (
        cardinality(part_event_ids) = parts AND part_event_ids[1] = event_id
      ),
      -- A MIP-0018 row is a [Y] package, so its evidence is always there (FR-003, FR-016b).
      CONSTRAINT events_package_evidence CHECK (
        name_variant <> 'mip-0018' OR (segment IS NOT NULL AND phase IS NOT NULL)
      ),
      -- The draft name is not opted into [Y]: its rows are single events (FR-006).
      CONSTRAINT events_legacy_single_event CHECK (name_variant <> 'legacy-mip-xxxx' OR parts = 1)
    )
  `;
  await sql`
    CREATE INDEX token_metadata_events_by_token
      ON ${sql(schema)}.token_metadata_events
         (net, address, domain_sep, kind_byte, block_height, tx_position, event_id)
  `;
  await sql`
    CREATE INDEX token_metadata_events_by_contract
      ON ${sql(schema)}.token_metadata_events (net, address, event_id)
  `;
  await sql`
    CREATE INDEX token_metadata_events_by_tx
      ON ${sql(schema)}.token_metadata_events (net, tx_hash, segment)
  `;

  // ---- token_metadata_kv (004's shape, lengths to 65535, ordered by §6.2's three keys) --------
  await sql`
    CREATE TABLE ${sql(schema)}.token_metadata_kv (
      net                 text     NOT NULL,
      address             bytea    NOT NULL CHECK (octet_length(address) = 32),
      domain_sep          bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind                smallint NOT NULL CHECK (kind >= 0 AND kind <= 3),
      key_hex             text     NOT NULL CHECK (key_hex ~ '^([0-9a-f][0-9a-f])+$'),
      key_text            text,
      name_variant        text     NOT NULL CHECK (name_variant IN ('mip-0018','legacy-mip-xxxx')),
      val_type            smallint NOT NULL CHECK (val_type >= 0 AND val_type <= 5),
      val_len             int      NOT NULL CHECK (val_len >= 0 AND val_len <= 65535),
      -- Exactly the val_len meaningful bytes: only APPLIED values reach this table, and an applied
      -- value always lies inside its package.
      value               bytea    NOT NULL,
      CONSTRAINT kv_value_is_val_len CHECK (octet_length(value) = val_len),
      CONSTRAINT kv_null_is_empty CHECK (val_type <> 5 OR (val_len = 0 AND octet_length(value) = 0)),
      CONSTRAINT kv_null_is_mip_0018 CHECK (val_type <> 5 OR name_variant = 'mip-0018'),
      projection_error    text,
      -- The package (its first part) that set the current value, and where it sits in §6.2's order.
      updated_event_id    bigint   NOT NULL,
      updated_height      bigint   NOT NULL CHECK (updated_height >= 0),
      updated_tx_position int      NOT NULL CHECK (updated_tx_position >= 0),
      PRIMARY KEY (net, address, domain_sep, kind, key_hex)
    )
  `;
  await sql`
    CREATE INDEX token_metadata_kv_by_key_text
      ON ${sql(schema)}.token_metadata_kv (net, key_text)
  `;

  // ---- tokens: the name index covers a bounded prefix (01-D audit F1) -----------------------
  // Under UC-1 a MIP-0018 `name` may be any length (up to 65 535 bytes). A B-tree entry holds at
  // most ~2.7 KB, so 003's `tokens_by_name (net, lower(name))` refused a long incompressible name:
  // the token update failed and rolled back the whole scan batch, on every retry — the scanner
  // stalled. The index now keeps the first 256 characters (at most 1 KiB of UTF-8); the `name`
  // column itself stays unbounded, and the name search reads the column, not the index key.
  await sql`DROP INDEX IF EXISTS ${sql(schema)}.tokens_by_name`;
  await sql`CREATE INDEX tokens_by_name ON ${sql(schema)}.tokens (net, lower(left(name, 256)))`;
}
