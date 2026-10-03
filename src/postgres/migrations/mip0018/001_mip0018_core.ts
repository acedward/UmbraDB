import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

export const name = "001_mip0018_core";

/**
 * MIP-0018 (PR #340 head `274a84f`) token metadata: the chain-event log and the latest value of every field.
 *
 * The tables:
 *
 * - `mip0018_events` — one row per observed `Misc` event the indexer classified, at its chain position (the chain-event
 *   record: position, contract, classification, reason). The raw `name`/`payload` bytes are kept so the state can be
 *   recomputed after blocks above a height are removed (MIP "Applying records", vector S4); they are never served as
 *   metadata. `unresolved`: a `log` op whose logged value the raw transaction does not show (event type `Unknown`, no
 *   bytes, a reason); never applied.
 * - `mip0018_fields` — one row per field `(network, contract_address, domain_sep, kind, key)` holding only its current
 *   value (no history table). A Null record deletes its row (per-key tombstones). A token identity exists only while it
 *   has at least one row here; with no rows it MUST NOT be referenced anywhere.
 * - `mip0018_withdrawals` and `mip0018_listed_events` — each identity's last withdrawal, and the events activity may
 *   list as metadata history (rejected events; accepted events of an identity's current description, i.e. from its last
 *   revival on; one row per listed event of `mip0018_events`, same position). Derived state like the fields: written
 *   with them by the apply path, deleted with their events and rebuilt by the recompute. A withdrawal deletes rows
 *   here; their dead index entries are reclaimed by (auto)vacuum, until which an index scan that starts before them
 *   steps over them (about one index page per hundred).
 *
 * Keys and values are `bytea` (exact bytes, NUL and non-UTF-8 keys included); unsigned integers (`val_type` 2,
 * 1–31 bytes little-endian) are also kept losslessly as `numeric` for queries.
 *
 * Text columns never hold chain bytes: `network` is the operator's configuration, `phase` and `classification` are
 * fixed vocabularies, and `event_type` / `reason` are written by UmbraDB's code (the MIP-0002 type name; the vendored
 * codec's reason vocabulary or a fixed decoder message with numbers) — their CHECKs hold them to ASCII, so no
 * chain-derived NUL or non-UTF-8 byte can reach a `text` column and stop the scan.
 */
export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_events (
      network          text     NOT NULL CHECK (length(network) > 0),
      block_height     bigint   NOT NULL CHECK (block_height >= 0),
      tx_index         integer  NOT NULL CHECK (tx_index >= 0),
      event_index      integer  NOT NULL CHECK (event_index >= 0),
      tx_hash          bytea    CHECK (tx_hash IS NULL OR octet_length(tx_hash) = 32),
      segment_id       integer  CHECK (segment_id IS NULL OR segment_id >= 0),
      phase            text     CHECK (phase IS NULL OR phase IN ('guaranteed', 'fallible')),
      contract_address bytea    NOT NULL CHECK (octet_length(contract_address) = 32),
      event_type       text     NOT NULL CHECK (event_type ~ '^[A-Za-z]{1,32}$'),
      name             bytea    NOT NULL CHECK (octet_length(name) <= 32),
      payload          bytea    NOT NULL CHECK (octet_length(payload) <= 256),
      classification   text     NOT NULL CHECK (classification IN ('accept', 'reject', 'ignore', 'unresolved')),
      reason           text     CHECK (reason IS NULL OR reason ~ '^[\\x20-\\x7e]+$'),
      domain_sep       bytea    CHECK (domain_sep IS NULL OR octet_length(domain_sep) = 32),
      kind             smallint CHECK (kind IS NULL OR kind IN (1, 2, 3)),
      CHECK ((classification = 'accept') = (reason IS NULL)),
      CHECK (classification <> 'accept' OR (domain_sep IS NOT NULL AND kind IS NOT NULL)),
      CHECK (classification <> 'unresolved'
             OR (octet_length(name) = 0 AND octet_length(payload) = 0 AND domain_sep IS NULL AND kind IS NULL)),
      PRIMARY KEY (network, block_height, tx_index, event_index)
    )
  `;
  await sql`
    CREATE INDEX mip0018_events_contract_idx
      ON ${sql(schema)}.mip0018_events (network, contract_address, block_height, tx_index, event_index)
  `;
  await sql`CREATE INDEX mip0018_events_tx_hash_idx ON ${sql(schema)}.mip0018_events (tx_hash) WHERE tx_hash IS NOT NULL`;
  // `/v1/status` counts the unresolved rows of a network, and a mark counts a contract's unresolved rows and lists the
  // first positions, without reading the other events.
  await sql`
    CREATE INDEX mip0018_events_unresolved_idx
      ON ${sql(schema)}.mip0018_events (network, contract_address, block_height, tx_index, event_index)
      WHERE classification = 'unresolved'
  `;
  // Bounded API reads (the number of a contract's events is chosen by its callers): a mark counts the contract's
  // rejected events and lists the first reasons from this index alone; `/v1/events?contract=` pages through the served
  // classifications without stepping over `ignore` rows.
  await sql`
    CREATE INDEX mip0018_events_reject_idx
      ON ${sql(schema)}.mip0018_events (network, contract_address, block_height, tx_index, event_index) INCLUDE (reason)
      WHERE classification = 'reject'
  `;
  await sql`
    CREATE INDEX mip0018_events_served_idx
      ON ${sql(schema)}.mip0018_events (network, contract_address, block_height, tx_index, event_index)
      WHERE classification IN ('accept', 'reject', 'unresolved')
  `;

  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_fields (
      network          text     NOT NULL CHECK (length(network) > 0),
      contract_address bytea    NOT NULL CHECK (octet_length(contract_address) = 32),
      domain_sep       bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind             smallint NOT NULL CHECK (kind IN (1, 2, 3)),
      key              bytea    NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 220),
      val_type         smallint NOT NULL CHECK (val_type BETWEEN 0 AND 4),
      value            bytea    NOT NULL CHECK (octet_length(value) <= 219),
      uint_value       numeric(75, 0) CHECK (uint_value IS NULL OR uint_value >= 0),
      usable           boolean,
      updated_block    bigint   NOT NULL CHECK (updated_block >= 0),
      updated_tx       integer  NOT NULL CHECK (updated_tx >= 0),
      updated_event    integer  NOT NULL CHECK (updated_event >= 0),
      updated_record   integer  NOT NULL CHECK (updated_record >= 0),
      CHECK ((val_type = 2) = (uint_value IS NOT NULL)),
      PRIMARY KEY (network, contract_address, domain_sep, kind, key)
    )
  `;
  // Symbol grouping (MIP "Symbol grouping"): identities of one (network, contract) with the same usable `symbol`.
  await sql`
    CREATE INDEX mip0018_fields_symbol_idx
      ON ${sql(schema)}.mip0018_fields (network, contract_address, value)
      WHERE key = '\\x73796d626f6c'::bytea AND usable
  `;

  // Per identity, its LAST withdrawal — the position of the record that deleted its last field row. Written by the
  // apply path in the scan's block transaction; rebuilt with the identity's fields when `removeAbove` recomputes it.
  // One row per identity that was ever withdrawn.
  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_withdrawals (
      network          text     NOT NULL CHECK (length(network) > 0),
      contract_address bytea    NOT NULL CHECK (octet_length(contract_address) = 32),
      domain_sep       bytea    NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind             smallint NOT NULL CHECK (kind IN (1, 2, 3)),
      block_height     bigint   NOT NULL CHECK (block_height >= 0),
      tx_index         integer  NOT NULL CHECK (tx_index >= 0),
      event_index      integer  NOT NULL CHECK (event_index >= 0),
      record_index     integer  NOT NULL CHECK (record_index >= 0),
      PRIMARY KEY (network, contract_address, domain_sep, kind)
    )
  `;
  // The events activity may reference — the identities' metadata history (MIP "Applying records": a withdrawn identity
  // MUST NOT be referenced in metadata history; "a later non-Null record describes it again"). Every rejected event (it
  // describes no identity), and each accepted event after which its identity has a field, until that identity is
  // withdrawn again: a withdrawal deletes the identity's accepted rows here, so an identity's history starts at its
  // last revival. Activity listings read only these rows (bounded by what they serve, never by hidden rows); the event
  // log itself is unchanged.
  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_listed_events (
      network          text     NOT NULL CHECK (length(network) > 0),
      block_height     bigint   NOT NULL,
      tx_index         integer  NOT NULL,
      event_index      integer  NOT NULL,
      contract_address bytea    NOT NULL CHECK (octet_length(contract_address) = 32),
      classification   text     NOT NULL CHECK (classification IN ('accept', 'reject')),
      domain_sep       bytea    CHECK (domain_sep IS NULL OR octet_length(domain_sep) = 32),
      kind             smallint CHECK (kind IS NULL OR kind IN (1, 2, 3)),
      CHECK ((classification = 'accept') = (domain_sep IS NOT NULL AND kind IS NOT NULL)),
      -- A contract's listed events in chain order: the activity listings' index skip scan by (block, tx). The only
      -- index ordered by position, so no plan can walk other contracts' rows instead.
      PRIMARY KEY (network, contract_address, block_height, tx_index, event_index) INCLUDE (classification)
    )
  `;
  // A withdrawal deletes exactly the identity's listed accepted rows.
  await sql`
    CREATE INDEX mip0018_listed_events_identity_idx
      ON ${sql(schema)}.mip0018_listed_events (network, contract_address, domain_sep, kind) WHERE classification = 'accept'
  `;
}
