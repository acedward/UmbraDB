import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

export const name = "001_mip0018_core";

/**
 * MIP-0018 (PR #340 head `274a84f`) token metadata: the chain-event log and the latest value of every field.
 *
 * A fresh schema (project 00026, Q7): nothing here upgrades or reads an earlier token-indexer layout. Two tables only:
 *
 * - `mip0018_events` — one row per observed `Misc` event the indexer classified, at its chain position (Q15: the
 *   chain-event record — position, contract, classification, reason). The raw `name`/`payload` bytes are kept so the
 *   state can be recomputed after blocks above a height are removed (MIP "Applying records", vector S4); they are
 *   never served as metadata. `unresolved` (final-audit F1): a `log` op whose logged value the raw transaction does
 *   not show (event type `Unknown`, no bytes, a reason); never applied.
 * - `mip0018_fields` — one row per field `(network, contract_address, domain_sep, kind, key)` holding only its current
 *   value (Q5: no history table). A Null record deletes its row (Q16, per-key tombstones). A token identity exists
 *   only while it has at least one row here; with no rows it MUST NOT be referenced anywhere.
 *
 * Keys and values are `bytea` (Q10/FR-014: exact bytes, NUL and non-UTF-8 keys); unsigned integers (`val_type` 2,
 * 1–31 bytes little-endian) are also kept losslessly as `numeric` for queries.
 *
 * Text columns never hold chain bytes (sub-plan C4 H2): `network` is the operator's configuration, `phase` and
 * `classification` are fixed vocabularies, and `event_type` / `reason` are written by UmbraDB's code (the MIP-0002
 * type name; the vendored codec's reason vocabulary or a fixed decoder message with numbers) — their CHECKs hold them
 * to ASCII, so no chain-derived NUL or non-UTF-8 byte can reach a `text` column and stop the scan.
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
  // `/v1/status` counts the unresolved rows of a network (final-audit F1) without reading the other events.
  await sql`
    CREATE INDEX mip0018_events_unresolved_idx
      ON ${sql(schema)}.mip0018_events (network) WHERE classification = 'unresolved'
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
}
