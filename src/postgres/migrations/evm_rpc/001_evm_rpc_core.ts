import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

export const name = "001_evm_rpc_core";

/** Additive storage contract consumed by the wallet monitor and EVM RPC modules. */
export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  await sql`
    CREATE TABLE ${sql(schema)}.address_map (
      id               bigserial PRIMARY KEY,
      evm_addr         bytea NOT NULL UNIQUE CHECK (octet_length(evm_addr) = 20),
      kind             text NOT NULL CHECK (kind IN ('midnight', 'ethereum', 'contract')),
      mn_address       text UNIQUE,
      meta             jsonb,
      first_seen_block bigint
    )
  `;
  await sql`
    CREATE TABLE ${sql(schema)}.balances (
      address_id   bigint NOT NULL REFERENCES ${sql(schema)}.address_map(id),
      token_type   bytea NOT NULL CHECK (octet_length(token_type) = 32),
      value        numeric(39,0) NOT NULL CHECK (value >= 0),
      updated_block bigint NOT NULL,
      PRIMARY KEY (address_id, token_type)
    )
  `;
  await sql`
    CREATE TABLE ${sql(schema)}.utxos (
      intent_hash bytea NOT NULL,
      output_index int NOT NULL CHECK (output_index >= 0),
      address_id bigint NOT NULL REFERENCES ${sql(schema)}.address_map(id),
      token_type bytea NOT NULL CHECK (octet_length(token_type) = 32),
      value numeric(39,0) NOT NULL CHECK (value >= 0),
      created_tx bigint NOT NULL,
      spent_tx bigint,
      PRIMARY KEY (intent_hash, output_index)
    )
  `;
  await sql`
    CREATE TABLE ${sql(schema)}.tx_index (
      hash bytea PRIMARY KEY,
      block_height bigint NOT NULL,
      block_hash bytea NOT NULL,
      status text NOT NULL,
      fee numeric(39,0),
      from_id bigint REFERENCES ${sql(schema)}.address_map(id),
      to_id bigint REFERENCES ${sql(schema)}.address_map(id),
      raw_ref text
    )
  `;

  // Local operational cursor. Data writes and this cursor advance share one postgres.js
  // transaction in wallet-monitor/store.ts, giving the same no-cursor-ahead guarantee as
  // UmbraDB's saveAndAdvance without coupling this lineage to Tier-1 checkpoint tables.
  await sql`
    CREATE TABLE ${sql(schema)}.watermarks (
      kind text NOT NULL,
      key text NOT NULL,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, key)
    ) WITH (fillfactor = 90)
  `;

  await sql`CREATE INDEX utxos_unspent_balance_idx ON ${sql(schema)}.utxos (address_id, token_type) WHERE spent_tx IS NULL`;
  await sql`CREATE INDEX tx_index_height_idx ON ${sql(schema)}.tx_index (block_height)`;
}
