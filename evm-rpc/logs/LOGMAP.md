# LOGMAP — Midnight contract events → EVM logs

**This document is a contract, not a description.** Three parts depend on it being exact:

| Part | Depends on |
|---|---|
| **C** (this repo) | `event-map.ts` implements it; `test/golden/*.golden.json` pins it byte-exactly |
| **D** (token dapp) | its `EVENTS.md` **must stay identical to this file**; its circuits must emit what this expects |
| **B** (`eth_*` RPC) | `eth_getTransactionReceipt` returns the `logs` rows this produces |

Source of truth for the input side: the indexer v4 SDL, snapshotted next to this file as
[`schema-v4.snapshot.graphql`](./schema-v4.snapshot.graphql) (from `midnight-indexer` at
`v2.0.0-rc.4`). All indexer hex is **unprefixed**; all EVM-facing hex in this document is
`0x`-prefixed.

---

## 1. Reading events

Read events **only** through the top-level `contractEvents` query/subscription:

```graphql
contractEvents(filter: ContractEventFilter!, limit: Int, offset: Int): [ContractEvent!]!   # query
contractEvents(filter: ContractEventFilter!, id: Int): ContractEvent!                      # subscription
```

- `ContractEventFilter.contractAddress` is **mandatory and single** → one subscription per watched
  contract.
- The subscription's `id` is an **inclusive** resume cursor and delivery is **at-least-once**:
  dedup by event `id`. This is what `logs.source_event_id UNIQUE` enforces in the database.
- Query paging is `limit`/`offset` (default 100, hard cap 500); pin `toBlock` across pages or rows
  shift under you.

> **Never** read events via the nested `ContractCall.contractEvents` field. The SDL itself documents
> that events are attributed to a call by matching contract address *and* entry point, and that
> when two calls in one transaction share both, **their events are not attributed there at all**.
> That field silently drops events; the top-level one does not.

## 2. Identity → EVM address

Midnight identities are 32 bytes; EVM addresses are 20.

```
evm_addr = keccak256(identity_bytes)[12:32]
```

An identity that is **already 20 bytes passes through unchanged** — that is how Part E's
Ethereum-native identities use the same mapper. Every mapping is registered in
`evm_rpc.address_map` at first sighting with `kind` ∈ `midnight` (a user accountId) /
`contract` (a Midnight contract address) / `ethereum` (Part E, pre-sized), and the source identity
in `mn_address` as unprefixed hex text.

> `address_map` is **owned by Part A1/A2** (`umbradb-sync/.../001_evm_rpc_core.ts`). Part C mirrors
> that definition in its own migration with `CREATE TABLE IF NOT EXISTS` so it can also run
> standalone, and confines every read and write to `evm-rpc/logs/address-map.ts`. Its columns are
> `evm_addr` / `kind` / `mn_address` / `meta` / `first_seen_block`.

`address_map` has `UNIQUE (evm_addr)`. Two identities colliding onto one address is a **hard
error**, never a silent merge — merging would silently pool two accounts' balances. `mn_address` is
also UNIQUE, which is the upsert's conflict target.

> For Part D's contract the `AddressOrContract` **USER** branch carries the OZ witness accountId
> (`persistentHash(sk)`) — an identity, **not** a spendable key.

## 3. topic0 constants

| Signature | topic0 |
|---|---|
| `Transfer(address,address,uint256)` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| `MidnightShieldedSpendEvent()` | `0x684848ddbac844dd2ced94df27a576ca0c74f8be0bdf4af5af2b76b8d9a8eace` |
| `MidnightShieldedReceiveEvent()` | `0xc64c2433fd557db61b3f11bb6d3ecefe1bd86311a78a16f36b2bc7bd81a9f384` |
| `MidnightShieldedMintEvent()` | `0x913e549f23a3945de721e1843738988e119be54d9a8dec1e4d387b2a932b8a9f` |
| `MidnightShieldedBurnEvent()` | `0xcc18eaf7bebda9f406ba45eba6ac29b0814ec5cf0156874b0d83c6d30d6ff211` |
| `MidnightUnshieldedSpendEvent()` | `0x5df4e139fc482778665f85ddc3b78d5679ff7dc4cf215c76fa81eb3f4156cc92` |
| `MidnightUnshieldedReceiveEvent()` | `0xc6c43d7b382360f22df7fe53eaa719fde83a15b3f17f6e71debf9fe70abfa169` |
| `MidnightUnshieldedMintEvent()` | `0xd48f98f43f12b9212cc91f34a11cb2c4b3b07a7adad71c2b115d7ee4b8554c62` |
| `MidnightUnshieldedBurnEvent()` | `0xa5b628edb85a977c53ca0a21506994fcc8107cf0a3d229895aecf4dd10741d54` |
| `MidnightPausedEvent()` | `0x44aed5108617013c06369ede48dfc3d3178d49e017e5a40d8ebfeaffa33885ce` |
| `MidnightUnpausedEvent()` | `0xe3efa616838a58a9120c6c950e7364e4eb1577bce7cb02b7eaaf407818ce0248` |

The `Midnight…()` signature string is the GraphQL `__typename` **verbatim**, so each constant is
derivable mechanically from the SDL rather than from a naming convention someone has to remember.
`MiscContractEvent` is the one exception: its topic0 is the hash of the event **name bytes** (§5).

Note that `keccak256` here is **Ethereum's Keccak, not FIPS-202 SHA3** — the two differ only in a
one-byte domain suffix (`0x01` vs `0x06`) and produce entirely different digests. Node's
`crypto.createHash("sha3-256")` is the wrong function; `keccak256.ts` implements the right one.

## 4. ERC20 / ERC721 `Transfer`

Applies when the contract's watch-config profile is `erc20` or `erc721`.

### 4.1 The pair rule

A `UnshieldedSpendEvent` **+** `UnshieldedReceiveEvent` **pair** within the **same transaction**
carrying the same `domainSep` **+** `tokenType` **+** `amount` maps to **ONE** log:

| Field | Value |
|---|---|
| `topic0` | `Transfer(address,address,uint256)` (§3) |
| `topic1` | `from` — the **spend**'s `sender`, mapped per §2, left-padded to 32 bytes |
| `topic2` | `to` — the **receive**'s `recipient`, mapped per §2, left-padded to 32 bytes |
| `topic3` | **erc721 only**: `tokenType`, i.e. the tokenId (raw 32 bytes) |
| `data` | **erc20**: `amount` as a big-endian `uint256` word. **erc721**: empty |

ERC721's `Transfer` shares ERC20's signature hash — the profile changes the **encoding**, not
topic0.

### 4.2 Mint and burn

| Source | Log |
|---|---|
| **Unpaired** `UnshieldedSpendEvent` | burn — `Transfer(from = sender, to = 0x0)` |
| **Unpaired** `UnshieldedReceiveEvent` | mint — `Transfer(from = 0x0, to = recipient)` |

These are distinct from the `UnshieldedMintEvent` / `UnshieldedBurnEvent` **types**, which are
separate events with their own topic0 (§5).

### 4.3 Pairing algorithm

Scope is one transaction. Match key is `(domainSep, tokenType, amount)`.

1. Walk spends in ascending event `id`.
2. For each, take the **first unclaimed** receive with an equal key (**FIFO**).
3. If **two or more** candidates match equally → still pair FIFO (deterministic, never a coin
   flip) and raise a `pair-ambiguous` warning naming every id involved.
4. Leftover spends → burn; leftover receives → mint.

### 4.4 `misc` profile

Under `misc` nothing is paired: the contract makes no ERC20/721 claim, so its Spend/Receive events
keep the lossless `Midnight…()` form of §5. Two events in, two logs out.

## 5. Everything else

`MiscContractEvent` — the contract-defined case:

| Field | Value |
|---|---|
| `topic0` | `keccak256(name)` where `name` is the event's **32 name bytes** (not a signature string) |
| `topic1..3` | absent |
| `data` | `payload` verbatim (≤ 256 bytes) |

The remaining standard types exist so that nothing is silently dropped; **ERC20/721 tooling only
needs `Transfer`**. Each takes its §3 topic0, then:

| Type | topic1 | topic2 | data (32-byte words, in order, then any raw tail) |
|---|---|---|---|
| `ShieldedSpendEvent` | `nullifier` | — | *(empty)* |
| `ShieldedReceiveEvent` | `commitment` | — | `receivingContractAddress` (zero word if null), then `ciphertext` **raw tail** |
| `ShieldedMintEvent` | `commitment` | `domainSep` | `amount` (0 if null) |
| `ShieldedBurnEvent` | `nullifier` | — | `amount` (0 if null) |
| `UnshieldedMintEvent` | `tokenType` | `domainSep` | `amount` |
| `UnshieldedBurnEvent` | `tokenType` | `sender` bytes | `kind` word, `amount` |
| `UnshieldedSpendEvent` *(misc profile)* | `tokenType` | `sender` bytes | `kind` word, `amount`, `domainSep` |
| `UnshieldedReceiveEvent` *(misc profile)* | `tokenType` | `recipient` bytes | `kind` word, `amount`, `domainSep` |
| `PausedEvent` | — | — | *(empty)* |
| `UnpausedEvent` | — | — | *(empty)* |

- Address-typed fields here keep their **raw Midnight bytes32** rather than being squeezed to 20
  bytes. Nothing decodes these with an ERC ABI, and the §2 truncation would discard 12 bytes for no
  benefit.
- `kind` word = `0` for the `USER` branch, `1` for `CONTRACT`.
- An **unknown** `__typename` (a newer indexer adding a type) is **skipped with a warning**, not an
  error — a schema addition must not wedge ingestion. A **known** type missing a field the SDL
  declares non-null **throws**: that means this contract has broken, and emitting a wrong log would
  corrupt logs-derived balances.

## 6. Row-level rules

### `log_index`

0-based position **within the transaction**, ordered by the source event `id` the log is keyed on.
A pair is keyed on the **lower** of its two ids. So a transaction emitting events
`700,701` (a pair), `702` (Misc), `703,704` (a pair) yields `log_index` `0,1,2` keyed on
`700,702,703`.

### `tx_index`

The SDL gives an event **no** transaction-index-within-block field. It is recovered by locating
`transaction.hash` in `transaction.block.transactions`, which the ingester therefore selects. When
that selection is absent or the hash is not found, `tx_index` is `0` **and a
`tx-index-unavailable` warning is raised** — never a silently invented index. (Plan Open question
Q2.)

### `source_event_id` and idempotency

`UNIQUE NOT NULL`. For a pair it is the **lower** of the two ids; the partner id is deliberately
not recorded. That is sufficient because the cursor only ever advances to a **transaction
boundary** (below), so a replay always re-delivers a pair in full and conflicts on the one id.

Genesis-backfill rows (C-G5) use a **negative** sequence — constructor-minted supply has no source
event, because Compact forbids `emit` in constructors. The indexer only issues positive ids, so the
ranges cannot collide, and re-running the backfill is a no-op.

### Batch boundaries (why a pair can never be split)

Pairing is scoped to a transaction, so a pair split across two delivery batches would map to a
bogus burn **plus** a bogus mint. Events arrive in monotonic `id` order and a transaction's events
are contiguous in that order, so:

- every transaction **except the last one seen** in a batch is complete and is mapped;
- the **trailing** transaction is held back, and the cursor is not advanced past it.

Holding back alone would stall at the tip (a contract whose only activity is one transfer has one
transaction, so nothing would ever flush). The ingester therefore also flushes the held tail after a
bounded **idle interval** (default 1500ms, comfortably under one block): a block's events are
indexed together, so an idle gap that long proves the transaction closed.

`id == maxId` is **deliberately not** a flush trigger. It looks like a cheaper tip signal, but it is
unsafe for precisely the case the buffer exists to protect: while a transfer's Spend is the newest
indexed event, `id == maxId` holds, so flushing there emits a bogus burn — and then a bogus mint when
the Receive lands. `maxId` can only ever mean "nothing newer *yet*", never "this transaction is
closed".

### Reorgs

`removed` is always `false` in Part C. Nothing here rewinds logs on a reorg; the column exists so
the row shape is `eth_getLogs`-complete and so a later part can implement rewind without a
migration.

## 7. Balance invariant

Folding every `Transfer` log from block 0 (`+value` to `to`, `-value` from `from`, `0x0` being the
mint/burn sink) must reproduce on-chain balances exactly. This holds **only if every balance-writing
circuit emits**. That invariant is owned by Part D's review checklist; C's parity script
(`test/verify-parity.ts`) is the regression net, not the guarantee.

## 8. Watch configuration

`WATCH_CONTRACTS_FILE` points at JSON:

```json
[{ "address": "<unprefixed hex, the Midnight contract address>", "profile": "erc20", "fromBlock": 0 }]
```

`profile` ∈ `erc20` | `erc721` | `misc`. `fromBlock` is optional. Part D ships a script that
converts its `out/deployment.json` into this shape.
