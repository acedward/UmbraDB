import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../schema-name.js";

export const name = "003_mip0018_activity";

/**
 * Token activity: one row per PUBLIC token flow of an applied part of a transaction, written by the MIP-0018 scan in
 * the same block transaction as its mints, events and cursor (`token-indexer/mip0018/activity.ts`), and removed with
 * them above a height. Heights and positions only — no wall-clock time.
 *
 * Roles (`direction` is relative to the role's subject; amounts are unsigned):
 * - `mint` — a `shieldedMints` (kind 1) / `unshieldedMints` (kind 2) effect: contract, domainSep, kind, amount, the
 *   computed color; for kind 2 also the recipient when the transcript's claimed unshielded spends name exactly one
 *   for that color and amount (`wallet_address` for a user, `recipient_contract` for a contract). `in`.
 * - `utxo-created` / `utxo-spent` — an unshielded offer output / input: the wallet (`UserAddress`; for a spend, the
 *   address of the signing key), the amount, and the UTXO's identity (`intent_hash`, `output_index`; for a spend,
 *   the spent UTXO's). `in` / `out`.
 * - `contract-in` / `contract-out` — a contract's `unshieldedInputs` / `unshieldedOutputs` effect (with the recipient
 *   attached as for mints). `in` / `out`.
 * - `shielded-offer` — a Zswap offer delta (the public net imbalance of a color in an offer; balanced shielded
 *   transfers publish none): `in` = into the shielded pool (negative delta), `out` = out of it.
 * - `metadata-event` — one row per (transaction, contract) whose applied parts carry accepted or rejected MIP-0018
 *   events (never `ignore`): counts and the first event's index in `mip0018_events` (a reference to the event log, no
 *   decoded values). No color: a color's activity includes the metadata rows of its minting contract.
 *
 * NIGHT (color 32 zero bytes) is recorded like any color; DUST has no color and no row; nothing comes from a failed
 * segment or a FAILURE transaction. Wallet addresses are stored as their 32 raw bytes and served as Bech32m. A
 * contract's `entry_point` is its exact bytes (`bytea`: entry points are arbitrary bytes on the ledger, NUL and
 * non-UTF-8 included), served as hex plus a text form only when printable.
 */
export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);
  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_activity (
      network            text          NOT NULL CHECK (length(network) > 0),
      block_height       bigint        NOT NULL CHECK (block_height >= 0),
      tx_index           integer       NOT NULL CHECK (tx_index >= 0),
      item_index         integer       NOT NULL CHECK (item_index >= 0),
      tx_hash            bytea         NOT NULL CHECK (octet_length(tx_hash) = 32),
      role               text          NOT NULL CHECK (role IN ('mint', 'utxo-created', 'utxo-spent', 'contract-in',
                                         'contract-out', 'shielded-offer', 'metadata-event')),
      phase              text          CHECK (phase IN ('guaranteed', 'fallible')),
      segment_id         integer       CHECK (segment_id >= 0),
      color              bytea         CHECK (octet_length(color) = 32),
      amount             numeric(39,0) CHECK (amount >= 0),
      direction          text          CHECK (direction IN ('in', 'out')),
      contract_address   bytea         CHECK (octet_length(contract_address) = 32),
      action_index       integer       CHECK (action_index >= 0),
      entry_point        bytea,
      domain_sep         bytea         CHECK (octet_length(domain_sep) = 32),
      kind               smallint      CHECK (kind IN (1, 2)),
      wallet_address     bytea         CHECK (octet_length(wallet_address) = 32),
      recipient_contract bytea         CHECK (octet_length(recipient_contract) = 32),
      intent_hash        bytea         CHECK (octet_length(intent_hash) = 32),
      output_index       integer       CHECK (output_index >= 0),
      events_accepted    integer       CHECK (events_accepted >= 0),
      events_rejected    integer       CHECK (events_rejected >= 0),
      first_event_index  integer       CHECK (first_event_index >= 0),
      PRIMARY KEY (network, block_height, tx_index, item_index),
      -- a flow has a part, a color, an amount and a direction; a metadata row has none of them
      CHECK (role = 'metadata-event' OR (phase IS NOT NULL AND segment_id IS NOT NULL AND color IS NOT NULL
                                         AND amount IS NOT NULL AND direction IS NOT NULL)),
      CHECK (role <> 'metadata-event' OR (phase IS NULL AND segment_id IS NULL AND color IS NULL AND amount IS NULL
                                          AND direction IS NULL)),
      CHECK ((role = 'metadata-event') = (events_accepted IS NOT NULL AND events_rejected IS NOT NULL
                                          AND first_event_index IS NOT NULL)),
      CHECK (role <> 'metadata-event' OR (contract_address IS NOT NULL AND events_accepted + events_rejected >= 1)),
      CHECK ((role = 'mint') = (domain_sep IS NOT NULL AND kind IS NOT NULL)),
      CHECK (role NOT IN ('mint', 'contract-in', 'contract-out')
             OR (contract_address IS NOT NULL AND action_index IS NOT NULL AND entry_point IS NOT NULL)),
      CHECK ((role IN ('utxo-created', 'utxo-spent')) = (intent_hash IS NOT NULL AND output_index IS NOT NULL)),
      CHECK (role NOT IN ('utxo-created', 'utxo-spent') OR (wallet_address IS NOT NULL AND contract_address IS NULL)),
      CHECK (role IN ('utxo-created', 'utxo-spent', 'mint', 'contract-out') OR (wallet_address IS NULL AND recipient_contract IS NULL)),
      CHECK (wallet_address IS NULL OR recipient_contract IS NULL),
      CHECK (role <> 'mint' OR kind = 2 OR (wallet_address IS NULL AND recipient_contract IS NULL)),
      CHECK (direction IS NULL OR direction = CASE role WHEN 'mint' THEN 'in' WHEN 'utxo-created' THEN 'in'
             WHEN 'utxo-spent' THEN 'out' WHEN 'contract-in' THEN 'in' WHEN 'contract-out' THEN 'out' ELSE direction END)
    )
  `;
  // A color's activity in chain order (keyset pagination), and a contract's metadata transactions.
  await sql`
    CREATE INDEX mip0018_activity_color_idx ON ${sql(schema)}.mip0018_activity (network, color, block_height, tx_index, item_index)
    WHERE color IS NOT NULL`;
  await sql`
    CREATE INDEX mip0018_activity_metadata_idx ON ${sql(schema)}.mip0018_activity (network, contract_address, block_height, tx_index, item_index)
    WHERE role = 'metadata-event'`;
}
