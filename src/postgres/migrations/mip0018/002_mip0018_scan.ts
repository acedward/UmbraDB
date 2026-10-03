import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

export const name = "002_mip0018_scan";

/**
 * The MIP-0018 scan over the chain archive (project 00026, sub-plans A3/B2): what one pass over the archived raw
 * transactions records next to the event log of `001_mip0018_core`, in the same `mip0018` lineage (fresh schema,
 * Q7) so that a block's mints, colors, actions, events and the scan cursor commit in ONE transaction.
 *
 * - `mip0018_scan` — the scan cursor per network: the first scanned height, the next height to scan and the hash of
 *   the last scanned block (its parent check). Independent of the archive's own sync cursor.
 * - `mip0018_mints` — every `shieldedMints` (kind 1) / `unshieldedMints` (kind 2) effect of an APPLIED part of a
 *   contract call (MIP "Lookup"), with its color `tokenType(domainSep, contractAddress)` computed by the scanner,
 *   never read from a value. The MIP's table `color → (contractAddress, domainSep)` is a query over these rows; one
 *   color has exactly one (contract, domainSep) — kinds 1 and 2 share it.
 * - `mip0018_color_sightings` — the FIRST place each token color appears in public data per kind of evidence
 *   (unshielded UTXO, Zswap offer delta, a contract's unshielded effect) — the seen tokens of owner decision Q3, with
 *   or without a known mint (a mint found later completes the same color in place). NIGHT's zero color is a built-in
 *   row, never a sighting.
 * - `mip0018_contract_actions` — contract calls, deploys and maintenance updates (e.g. `VerifierKeyInsert` /
 *   `VerifierKeyRemove`) that took effect, so the scanner recognises every action and moves past it.
 * - `mip0018_builtin_tokens` — NIGHT and DUST (owner decision Q3, outside MIP-0018: the protocol fixes their
 *   properties); seeded per network by the scanner.
 *
 * Every row carries its chain position; removing everything above a height (and resetting the cursor) restores the
 * state of a scan that stopped there — first-sighting rows included, since a first sighting above the height had no
 * earlier one.
 */
export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_scan (
      network         text   PRIMARY KEY CHECK (length(network) > 0),
      from_height     bigint NOT NULL CHECK (from_height >= 0),
      next_height     bigint NOT NULL,
      last_block_hash bytea  CHECK (last_block_hash IS NULL OR octet_length(last_block_hash) = 32),
      CHECK (next_height >= from_height),
      CHECK ((next_height = from_height) = (last_block_hash IS NULL))
    )
  `;

  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_mints (
      network          text          NOT NULL CHECK (length(network) > 0),
      block_height     bigint        NOT NULL CHECK (block_height >= 0),
      tx_index         integer       NOT NULL CHECK (tx_index >= 0),
      mint_index       integer       NOT NULL CHECK (mint_index >= 0),
      tx_hash          bytea         NOT NULL CHECK (octet_length(tx_hash) = 32),
      phase            text          NOT NULL CHECK (phase IN ('guaranteed', 'fallible')),
      segment_id       integer       NOT NULL CHECK (segment_id >= 0),
      action_index     integer       NOT NULL CHECK (action_index >= 0),
      contract_address bytea         NOT NULL CHECK (octet_length(contract_address) = 32),
      domain_sep       bytea         NOT NULL CHECK (octet_length(domain_sep) = 32),
      kind             smallint      NOT NULL CHECK (kind IN (1, 2)),
      amount           numeric(39,0) NOT NULL CHECK (amount >= 0),
      color            bytea         NOT NULL CHECK (octet_length(color) = 32),
      PRIMARY KEY (network, block_height, tx_index, mint_index)
    )
  `;
  await sql`CREATE INDEX mip0018_mints_color_idx ON ${sql(schema)}.mip0018_mints (network, color, block_height, tx_index, mint_index)`;
  await sql`CREATE INDEX mip0018_mints_contract_idx ON ${sql(schema)}.mip0018_mints (network, contract_address, domain_sep)`;

  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_color_sightings (
      network      text    NOT NULL CHECK (length(network) > 0),
      color        bytea   NOT NULL CHECK (octet_length(color) = 32 AND color <> '\\x0000000000000000000000000000000000000000000000000000000000000000'::bytea),
      evidence     text    NOT NULL CHECK (evidence IN ('unshielded-utxo', 'shielded-offer', 'contract-unshielded')),
      block_height bigint  NOT NULL CHECK (block_height >= 0),
      tx_index     integer NOT NULL CHECK (tx_index >= 0),
      tx_hash      bytea   NOT NULL CHECK (octet_length(tx_hash) = 32),
      PRIMARY KEY (network, color, evidence)
    )
  `;
  await sql`CREATE INDEX mip0018_color_sightings_height_idx ON ${sql(schema)}.mip0018_color_sightings (network, block_height)`;

  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_contract_actions (
      network          text     NOT NULL CHECK (length(network) > 0),
      block_height     bigint   NOT NULL CHECK (block_height >= 0),
      tx_index         integer  NOT NULL CHECK (tx_index >= 0),
      segment_id       integer  NOT NULL CHECK (segment_id >= 0),
      action_index     integer  NOT NULL CHECK (action_index >= 0),
      tx_hash          bytea    NOT NULL CHECK (octet_length(tx_hash) = 32),
      action           text     NOT NULL CHECK (action IN ('call', 'deploy', 'maintenance')),
      contract_address bytea    NOT NULL CHECK (octet_length(contract_address) = 32),
      entry_point      text,
      applied_phases   text[],
      maintenance_counter numeric(20,0) CHECK (maintenance_counter IS NULL OR maintenance_counter >= 0),
      maintenance_updates text[],
      CHECK ((action = 'call') = (entry_point IS NOT NULL AND applied_phases IS NOT NULL)),
      CHECK ((action = 'maintenance') = (maintenance_counter IS NOT NULL AND maintenance_updates IS NOT NULL)),
      CHECK (applied_phases IS NULL OR (cardinality(applied_phases) BETWEEN 1 AND 2
             AND applied_phases <@ ARRAY['guaranteed', 'fallible']::text[])),
      PRIMARY KEY (network, block_height, tx_index, segment_id, action_index)
    )
  `;
  await sql`CREATE INDEX mip0018_contract_actions_contract_idx ON ${sql(schema)}.mip0018_contract_actions (network, contract_address, block_height)`;

  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_builtin_tokens (
      network  text     NOT NULL CHECK (length(network) > 0),
      symbol   text     NOT NULL CHECK (symbol IN ('NIGHT', 'DUST')),
      name     text     NOT NULL,
      decimals smallint NOT NULL CHECK (decimals >= 0),
      color    bytea    CHECK (color IS NULL OR octet_length(color) = 32),
      note     text     NOT NULL,
      PRIMARY KEY (network, symbol)
    )
  `;
}
