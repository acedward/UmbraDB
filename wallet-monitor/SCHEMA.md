# `evm_rpc` schema contract

Contract version: **1.0.0** (2026-08-10).

The additive migration lineage lives at `src/postgres/migrations/evm_rpc/` and owns the
`evm_rpc` schema independently of UmbraDB's Tier-1 and `chain_archive` lineages.

| Table | Contract |
| --- | --- |
| `address_map` | `id bigserial PK`, unique 20-byte `evm_addr`, `kind` in `midnight/ethereum/contract`, unique nullable `mn_address`, `meta`, `first_seen_block` |
| `balances` | One `numeric(39,0)` balance per `(address_id, 32-byte token_type)`, with `updated_block` |
| `utxos` | One row per `(intent_hash, output_index)`, owner/token/value, creating transaction id, nullable spending transaction id |
| `tx_index` | Transaction hash, block identity, ledger status/fee, optional first sender/receiver mappings, and an opaque `raw_ref` |
| `watermarks` | Operational subscription cursor keyed by watched Midnight address |

`watermarks` is the only operational extension to the four externally-consumed tables. The wallet
monitor writes a transaction's UTXO rows, recomputed balances, `tx_index` row, and subscription
cursor in one PostgreSQL transaction. Therefore the cursor cannot commit ahead of the state it
describes. Replayed events are idempotent on UTXO identity (`intent_hash`, `output_index`).

The invariant is:

```sql
balances.value = sum(utxos.value) where utxos.spent_tx is null
```

for every `(address_id, token_type)`. The native NIGHT token type is 32 zero bytes.

Midnight-to-EVM mapping is fixed as:

```text
evm_addr = keccak256(raw_bech32m_decoded_address_bytes)[12:32]
```

Any incompatible DDL or mapping change requires a new version note here before Parts B/C/F may
consume it.
