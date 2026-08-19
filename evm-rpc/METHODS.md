# UmbraDB EVM JSON-RPC — per-endpoint reference

This module exposes a **JSON-RPC 2.0 wallet-compatibility surface over Midnight**. It is not an
Ethereum node: there is no EVM execution engine, no storage trie and no mempool. Every answer is
either read from the Midnight indexer, read from the `evm_rpc` Postgres schema this repo maintains,
computed from those two, a compiled-in constant, or forwarded to the relayer.

Default chain ID is **2400** (`0x960`). Midnight hex values are unprefixed inside the indexer and
the database and gain their `0x` prefix only at this boundary.

Two surfaces:

| Surface | Default port | Entrypoint | Serves |
|---|---|---|---|
| HTTP JSON-RPC | `EVM_RPC_PORT`, 8545 | `npm run evm-rpc:all` (`serve-all.ts`) | all 27 HTTP methods below |
| HTTP JSON-RPC, read-only subset | `EVM_RPC_PORT`, 8545 | `npm run evm-rpc` (`rpc-cli.ts`) | the same minus `eth_call`'s ERC20 views, `eth_getLogs` and `eth_sendRawTransaction` (it registers only `static`/`blocks`/`accounts`/`transactions` + the `-32004` stubs) |
| WebSocket | `EVM_RPC_WS_PORT`, 10021 | `serve-all.ts` (`logs/subscribe.ts`) | `eth_subscribe`, `eth_unsubscribe`, `eth_getLogs` — **and nothing else** (see [Known issues](#known-issues)) |

**Data-source tags** used throughout:

| Tag | Meaning |
|---|---|
| `indexer` | Midnight indexer GraphQL v4 (`INDEXER_URL`) via `evm-rpc/indexer-gql.ts` — `block(offset:{height\|hash})`, `block`, `transactions(offset:{hash})` |
| `pg:<table>` | the `evm_rpc` Postgres schema (`PG_URL`) — `tx_index`, `balances`, `address_map`, `logs` |
| `const` | compiled-in constant; nothing is measured |
| `config` | process configuration (`CHAIN_ID`, `package.json` version, the watch file) |
| `relay` | forwarded to the relayer process (`RELAY_URL`) |

---

## Method index

29 methods are served: **27 on HTTP** plus **2 WebSocket-only**. A further 21 spec-defined methods
answer `-32004` — see [Not implemented (-32004)](#not-implemented--32004). Genuinely unknown names
answer `-32601`.

| # | Method | Surface | Source | Summary |
|---|---|---|---|---|
| 1 | [`eth_chainId`](#eth_chainid) | HTTP | `config` | `0x960` |
| 2 | [`net_version`](#net_version) | HTTP | `config` | `"2400"` |
| 3 | [`web3_clientVersion`](#web3_clientversion) | HTTP | `config` | `umbradb-evm-rpc/<pkg version>` |
| 4 | [`net_listening`](#net_listening) | HTTP | `const` | `true` |
| 5 | [`eth_syncing`](#eth_syncing) | HTTP | `const` | always `false` |
| 6 | [`eth_accounts`](#eth_accounts) | HTTP | `const` | `[]` — keys live in the wallet |
| 7 | [`eth_gasPrice`](#eth_gasprice) | HTTP | `const` | 1 gwei, presentation only |
| 8 | [`eth_estimateGas`](#eth_estimategas) | HTTP | `const` | always `0x5208` |
| 9 | [`eth_feeHistory`](#eth_feehistory) | HTTP | `const` | correctly-sized zero arrays |
| 10 | [`eth_maxPriorityFeePerGas`](#eth_maxpriorityfeepergas) | HTTP | `const` | `0x0` |
| 11 | [`web3_sha3`](#web3_sha3) | HTTP | `const` | real Keccak-256 |
| 12 | [`eth_blockNumber`](#eth_blocknumber) | HTTP | `indexer` | indexer head height |
| 13 | [`eth_getBlockByNumber`](#eth_getblockbynumber) | HTTP | `indexer` | synthesized legacy header |
| 14 | [`eth_getBlockByHash`](#eth_getblockbyhash) | HTTP | `indexer` | same synthesis, by hash |
| 15 | [`eth_getBlockTransactionCountByHash`](#eth_getblocktransactioncountbyhash) | HTTP | `indexer` | length of the block's tx list |
| 16 | [`eth_getBlockTransactionCountByNumber`](#eth_getblocktransactioncountbynumber) | HTTP | `indexer` | same, by tag/height |
| 17 | [`eth_getBalance`](#eth_getbalance) | HTTP | `pg:balances`, `pg:address_map` | native balance ×10¹² |
| 18 | [`eth_getTransactionCount`](#eth_gettransactioncount) | HTTP | `pg:tx_index` | sent-transaction count |
| 19 | [`eth_getCode`](#eth_getcode) | HTTP | `pg:address_map` | `0x60006000` marker for contracts |
| 20 | [`eth_call`](#eth_call) | HTTP | `pg:logs`, `config` | ERC20 views folded from Transfer logs |
| 21 | [`eth_getTransactionByHash`](#eth_gettransactionbyhash) | HTTP | `pg:tx_index` → `indexer` | synthesized transaction |
| 22 | [`eth_getTransactionReceipt`](#eth_gettransactionreceipt) | HTTP | `pg:tx_index` → `indexer` | synthesized receipt |
| 23 | [`eth_getTransactionByBlockHashAndIndex`](#eth_gettransactionbyblockhashandindex) | HTTP | `indexer` + `pg:tx_index` | tx at a block position |
| 24 | [`eth_getTransactionByBlockNumberAndIndex`](#eth_gettransactionbyblocknumberandindex) | HTTP | `indexer` + `pg:tx_index` | same, by tag/height |
| 25 | [`eth_getBlockReceipts`](#eth_getblockreceipts) | HTTP | `indexer` + `pg:tx_index` | all receipts of one block |
| 26 | [`eth_getLogs`](#eth_getlogs) | HTTP + WS | `pg:logs`, `pg:address_map` | geth filter semantics |
| 27 | [`eth_sendRawTransaction`](#eth_sendrawtransaction) | HTTP (conditional) | `relay` | forwards the raw tx to the relayer |
| 28 | [`eth_subscribe`](#eth_subscribe) | **WS only** | `pg:logs` | `logs` + `newHeads` |
| 29 | [`eth_unsubscribe`](#eth_unsubscribe) | **WS only** | — | cancels a subscription |

Method 27 is registered **only when `RELAY_URL` is set**; with no relayer configured the name is
absent from the registry and answers `-32601` (see [Known issues](#known-issues), K8).

---

## Chain and node identity

### `eth_chainId`

- **Params** none. **Result** quantity.
- **Source** `config` — the `CHAIN_ID` environment variable (default 2400) rendered as a hex
  quantity, `0x960`.
- **Errors** any parameter → `-32602 expected 0 positional parameter(s)`.

### `net_version`

- **Params** none. **Result** the chain ID as a **decimal string**, `"2400"` (legacy `net_*`
  convention — not a hex quantity).
- **Source** `config`, the same `CHAIN_ID`.
- **Errors** any parameter → `-32602`.

### `web3_clientVersion`

- **Params** none. **Result** `"umbradb-evm-rpc/<version from package.json>"`.
- **Source** `config`.
- **Errors** any parameter → `-32602`.

### `net_listening`

- **Params** none. **Result** `true`, unconditionally — the process is answering, which is the only
  thing it can honestly assert. There is no devp2p peer set behind this surface.
- **Source** `const`. **Errors** any parameter → `-32602`.

### `eth_syncing`

- **Params** none. **Result** `false`, unconditionally.
- **Source** `const`.
- **Deviation** it never reports the real lag between the indexer head, the ingester's
  `log_cursors` watermark and the archive sync. A client polling `eth_syncing` will be told the
  node is caught up even while the ingester is minutes behind.
- **Errors** any parameter → `-32602`.

### `eth_accounts`

- **Params** none. **Result** `[]`.
- **Source** `const`. This service holds no keys by design; accounts live in the wallet. It is also
  why the signing methods are absent rather than stubbed — a wallet that sees `[]` never calls them.
- **Errors** any parameter → `-32602`.

---

## Fees and gas

Midnight fees are paid in DUST and are not an EVM gas market. Everything in this section is
presentation for wallets that refuse to build a transaction without fee data.

### `eth_gasPrice`

- **Params** none. **Result** `0x3b9aca00` (1 gwei), constant.
- **Source** `const`. **Errors** any parameter → `-32602`.

### `eth_estimateGas`

- **Params** 1–2 positional (`transaction`, optional block tag). **Result** `0x5208` (21 000),
  constant.
- **Source** `const`.
- **Deviation** the transaction object is **never inspected or validated** — a bare string is
  accepted and answered with `0x5208`. Only the parameter *count* is checked.
- **Errors** 0 or >2 parameters → `-32602 expected 1-2 positional parameter(s)`.

### `eth_feeHistory`

- **Params** 2–3 positional: `blockCount` (hex quantity), `newestBlock` (string), optional
  `rewardPercentiles`.
- **Result** `{ oldestBlock, baseFeePerGas: [0x0 × count+1], gasUsedRatio: [0 × count],
  reward: [[0x0 × percentiles] × count] }` — shape-correct, all zero.
- **Source** `const`.
- **Deviation** `oldestBlock` echoes `newestBlock` when it was given as a hex quantity, and is
  `0x0` when it was given as a tag. The spec wants the **lowest** block of the returned range in
  both cases. A client computing a range from `oldestBlock` will therefore get the wrong window
  (harmless here only because every value in it is zero).
- **Errors** `-32602` for: wrong arity, non-canonical `blockCount`, `blockCount > 1024`,
  non-string `newestBlock`, a percentile outside 0–100 or not a number, more than 100 percentiles,
  and `blockCount × percentiles > 4096`.

### `eth_maxPriorityFeePerGas`

- **Params** none. **Result** `0x0` — this is a legacy-fee chain.
- **Source** `const`. **Errors** any parameter → `-32602`.

---

## Utility

### `web3_sha3`

- **Params** 1 positional: `0x`-prefixed byte data of even length.
- **Result** Ethereum **Keccak-256** (legacy `0x01` padding domain, not FIPS SHA3-256) of those
  bytes — a dependency-free implementation in `methods/static.ts`.
- **Source** `const` (pure computation). `"0x"` hashes the empty input, which is correct.
- **Errors** non-string, missing `0x`, odd length or non-hex characters →
  `-32602 input must be 0x-prefixed byte data`; wrong arity → `-32602`.

---

## Blocks

Blocks are **synthesized** from the indexer's block query into the Ethereum header shape. Fields
Midnight has no analogue for are filled with fixed values rather than omitted, so wallet decoders
never see a missing key: `nonce 0x0000000000000000`, `sha3Uncles` = the empty-uncles hash,
`logsBloom` = 256 zero bytes, `transactionsRoot`/`stateRoot`/`receiptsRoot`/`mixHash` = zero hash,
`difficulty`/`totalDifficulty`/`gasUsed`/`size` = `0x0`, `extraData 0x`, `gasLimit 0x1c9c380`,
`uncles []`. `miner` is the block author when it is exactly 20 bytes, otherwise the zero address.

**There is deliberately no `baseFeePerGas`.** A pre-London header is what keeps wallets emitting
legacy type-0 transactions, which is the only form the relayer can decode.

`timestamp` is normalized to EVM seconds: the live rc.4 indexer reports pallet timestamps in
milliseconds despite documenting UNIX seconds, so values at millisecond magnitude
(`>= 1_000_000_000_000`) are divided by 1000; already-normalized values pass through.

**Block tags** (one rule for every block-scoped method, `methods/common.ts::resolveBlockTag`):
`latest`, `pending`, `safe` and `finalized` all resolve to the indexer head — Midnight has no fork
choice that would distinguish them — and `earliest` is height 0. Anything else must be a canonical
hex quantity (no leading zeros); heights above 2 147 483 647 are rejected because the indexer's
GraphQL `Int` cannot carry them.

### `eth_blockNumber`

- **Params** none. **Result** the indexer head height as a quantity; `0x0` if the indexer reports
  no block at all.
- **Source** `indexer` (`block { height }`). **Errors** any parameter → `-32602`.

### `eth_getBlockByNumber`

- **Params** 2 positional: `BlockNumberOrTag`, `fullTransactions` (boolean, **required**).
- **Result** the synthesized header, or `null` for a height that is not on chain. With
  `fullTransactions: false` the `transactions` array holds hashes; with `true` it holds transaction
  objects built by the same synthesis as [`eth_getTransactionByHash`](#eth_gettransactionbyhash),
  hydrated **serially** so one block request cannot fan out across the small read-only Postgres pool.
- **Source** `indexer`; hydrated transactions additionally read `pg:tx_index`.
- **Deviation** tags collapse as described above; the header is synthetic (zero roots and bloom).
  `parentHash` is the zero hash at height 0.
- **Errors** wrong arity, non-boolean flag, garbage tag, non-canonical quantity (`0x0baa`),
  negative or out-of-`Int` height → `-32602`.

### `eth_getBlockByHash`

- **Params** 2 positional: 32-byte block hash, `fullTransactions` (boolean).
- **Result** as above; unknown hash → `null`.
- **Source** `indexer` (`block(offset:{hash})`).
- **Errors** hash not exactly 32 bytes or not a string → `-32602 block hash must contain exactly 32
  bytes`; non-boolean flag or wrong arity → `-32602`.

### `eth_getBlockTransactionCountByHash`

- **Params** 1 positional: 32-byte block hash. **Result** quantity, or `null` for an unknown block.
- **Source** `indexer` — the length of the block query's `transactions` list.
- **Errors** malformed hash / wrong arity → `-32602`.

### `eth_getBlockTransactionCountByNumber`

- **Params** 1 positional: `BlockNumberOrTag`. **Result** quantity, or `null` for a height that is
  not on chain.
- **Source** `indexer`. Tag rules as above.
- **Errors** garbage tag / non-canonical quantity / wrong arity → `-32602`.

---

## Accounts and contract state

### `eth_getBalance`

- **Params** 1–2 positional: 20-byte address, optional block tag (defaults to `latest`).
- **Result** the address's **native** balance, scaled ×10¹² into wei-like units; `0x0` for an
  address with no row.
- **Source** `pg:address_map` joined to `pg:balances` on the native token type (32 zero bytes).
- **Deviations** (a) the block tag is syntactically validated and then **ignored** — the Part A
  schema stores current balances only, so every tag returns latest state; (b) the ×10¹² scale is a
  lossless presentation choice (NIGHT has 6 decimals on Midnight; ×10¹² lands it on the 18-decimal
  scale wallets assume).
- **Errors** address not exactly 20 bytes → `-32602 address must contain exactly 20 bytes`;
  non-string tag → `-32602 block tag must be a string`; wrong arity → `-32602`.
- **Demo variant** with `DEMO_TOKEN_AS_NIGHT=1` (`serve-all.ts`) this method is re-registered with
  `replace: true` to **add** the address's Transfer-log-folded token balance ×10¹⁸ on top of the
  native value, so a MetaMask account number is non-zero on a stack where the relayer pays all
  fees. It deliberately conflates native and token value and self-transfers net to zero. Never
  enable it outside a demo stack.

### `eth_getTransactionCount`

- **Params** 1–2 positional: address, optional tag. **Result** quantity.
- **Source** `pg:tx_index` — `count(*)` of rows whose `from_id` maps to the address; unknown
  address → `0x0`.
- **Deviation** this is a **monotonic sent-transaction count over the indexed set**, not an
  Ethereum state-trie nonce. It is sufficient for MetaMask's nonce polling; it is not an authority
  on replay protection (the relayer decodes a raw tx's nonce but never enforces it).
- **Operational note** the fixed Part A DDL has no index beginning with `tx_index.from_id`, so this
  read can scan that table as it grows. A deployment that may migrate the schema should add
  `(from_id, block_height, hash)`.
- **Errors** as `eth_getBalance`.

### `eth_getCode`

- **Params** 1–2 positional: address, optional tag. **Result** `0x60006000` when
  `address_map.kind = 'contract'`, otherwise `0x`.
- **Source** `pg:address_map`.
- **Deviation** `0x60006000` is a **non-executable marker**, not the contract's code — Midnight
  contract state is a ledger blob and there is no EVM bytecode to return. It exists because wallets
  and libraries treat empty code as "this is an EOA" and refuse token flows.
- **Errors** as `eth_getBalance`.

### `eth_call`

- **Params** 1–2 positional: a call object (`{to, data, …}`), optional block tag.
- **Result** ABI-encoded return data for the five ERC20 **view** selectors against a watched token,
  otherwise `0x`.
- **Source** `pg:logs` + `pg:address_map` for the folds, `config` (the watch file, optionally its
  `deploymentFile`) for the metadata:

  | Selector | Function | Answered from |
  |---|---|---|
  | `0x70a08231` | `balanceOf(address)` | sum of Transfer log amounts received − sent by that address for the token |
  | `0x18160ddd` | `totalSupply()` | sum of mints (`topic1 = 0x0…0`) − burns (`topic2 = 0x0…0`) |
  | `0x313ce567` | `decimals()` | the watch entry's `evmDecimals`, **default 0** |
  | `0x95d89b41` | `symbol()` | watch entry / `deployment.json`, default `UMBRA` |
  | `0x06fdde03` | `name()` | watch entry / `deployment.json`, default `Umbra Token <prefix>` |

  This is what lets a browser wallet import a watched token: MetaMask's import flow calls
  `symbol()`, `decimals()` and `balanceOf(you)`, and its Send flow then produces
  `transfer(address,uint256)` calldata — the only shape the relayer accepts.
- **Deviations** (a) **there is no contract execution**: any other target address, any other
  selector, calldata shorter than 4 bytes, or a `balanceOf` argument that is not 32 bytes returns
  `0x`. The log fold is the honest analogue of an EVM state read, and it is the same computation an
  explorer performs. (b) `decimals()` is **0 unless a watch entry sets `evmDecimals`**: the Compact
  contracts store `Uint<128>` whole units and emit them verbatim, so a `deployment.json` that
  nominally declares `decimals: 18` is ignored on purpose — honouring it would divide every
  displayed balance by 10¹⁸. (c) the arity guard is gone — see [Known issues](#known-issues), K3.
- **Errors** none of its own; a malformed call currently yields `0x`, not `-32602`.

---

## Transactions and receipts

Transactions are synthesized into the Ethereum shape from what Midnight actually records. The
constant fields are: `gas 0x5208`, `gasPrice 0x3b9aca00`, `input 0x`, `value 0x0`, `type 0x0`,
`v 0x0`, `r`/`s` = zero hash. `value` is `0x0` because Midnight's UTXO amounts are not attributable
to a single (from, to) pair at this layer — the transferred amount is visible in the Transfer log,
not in the transaction. `from`/`to` are the mapped 20-byte addresses when a `tx_index` row supplies
them and the zero address otherwise.

Receipts share **one shape function** (`synthesizeReceipt`), used by both
[`eth_getTransactionReceipt`](#eth_gettransactionreceipt) and
[`eth_getBlockReceipts`](#eth_getblockreceipts), so the two surfaces cannot drift:
`cumulativeGasUsed` = `gasUsed` = the recorded fee, `contractAddress null`, `type 0x0`,
`effectiveGasPrice 0x3b9aca00`. `logs` is the transaction's `evm_rpc.logs` rows in
`(txIndex, logIndex)` order — the same objects `eth_getLogs` returns — and `logsBloom` is computed
from that array in the same call, so the filter can never disagree with the logs beside it.
`status` is `0x1` only when the transaction result is `SUCCESS` **and** every segment succeeded;
anything else is `0x0`.

### `eth_getTransactionByHash`

- **Params** 1 positional: 32-byte transaction hash. **Result** the synthesized transaction, or
  `null` when neither source knows the hash.
- **Source** `pg:tx_index` **first**, falling back to `indexer` (`transactions(offset:{hash})`).
  The DB path supplies mapped `from`/`to` and a synthesized `nonce` (the count of the sender's
  earlier `tx_index` rows). Both paths position the transaction by re-fetching its block; the DB
  path positions by the **Midnight** hash the row denotes (its own key, or the
  `relayer:midnight:<hash>` mapping when the row is keyed on an eth-side hash) while still echoing
  the queried hash back — see [Known issues](#known-issues), K1.
- **Deviations** `value` is always `0x0` (above); when the indexer returns more than one
  transaction for a hash, element 0 is used and a **non-standard `raw_ref`** field records the
  ambiguity. A stored row the block query cannot place (e.g. left over from a previous chain
  incarnation) is answered `null`, not an error.
- **Errors** hash not exactly 32 bytes → `-32602`; wrong arity → `-32602`.

### `eth_getTransactionReceipt`

- **Params** 1 positional: 32-byte transaction hash. **Result** the synthesized receipt, or `null`.
- **Source** `pg:tx_index` first, then `indexer`. `gasUsed` is the recorded Midnight fee (0 from the
  relayer path, which hardcodes it). Positioned exactly like `eth_getTransactionByHash` (K1).
- **Logs** the transaction's `pg:logs` rows, byte-identical to what `eth_getLogs` serves, with a
  `logsBloom` computed from them (Bloom-9, `methods/bloom.ts`). The join key is the **Midnight**
  hash, not necessarily the queried one — see [Known issues](#known-issues), K2.
- **Deviations** the all-segments-or-`0x0` status policy is stricter than Ethereum's binary status:
  a `PARTIAL_SUCCESS` Midnight transaction reports `0x0`. A transaction whose contract is not in
  the watch list has no rows in `evm_rpc.logs`, so its receipt reports `logs: []` — accurately for
  this surface, but not what an Ethereum node would say.
- **Errors** as `eth_getTransactionByHash`.

### `eth_getTransactionByBlockHashAndIndex`

- **Params** 2 positional: 32-byte block hash, index (canonical hex quantity).
- **Result** the transaction at that position, or `null` when the block is unknown **or** the index
  is out of range (`null`, never an error — the official `notFound` union).
- **Source** `indexer` block query for the position, `pg:tx_index` purely as **enrichment** for
  `from`/`to`/`nonce`; a miss degrades to the constant fields instead of failing. This path never
  re-derives a position, so it was never affected by K1.
- **Errors** malformed hash, non-canonical index (`0x01`, decimal, negative) or wrong arity →
  `-32602`.

### `eth_getTransactionByBlockNumberAndIndex`

- Identical to the above, addressed by `BlockNumberOrTag` instead of a hash; same tag rules, same
  `null` policy, same enrichment.

### `eth_getBlockReceipts`

- **Params** 1 positional: `BlockNumberOrTagOrHash`. A 32-byte hex string is read as a block hash
  (geth's disambiguation — unambiguous because a 32-byte value is never a canonical quantity);
  anything else is a tag or height.
- **Result** an array of receipts, one per transaction the block query lists, in block order.
  Unknown block → `null`; empty block → `[]`.
- **Source** `indexer` for the transaction list and positions, `pg:tx_index` as enrichment with an
  `indexer` transaction lookup as fallback. Like the by-index methods, it never re-derives a
  position and was therefore never affected by K1.
- **Deviations** (a) only the **string** forms of `BlockNumberOrTagOrHash` are accepted — the object
  forms `{blockHash, requireCanonical}` and `{blockNumber}` are not; (b) logs are joined per
  transaction, so a block of *n* transactions costs *n* log queries (K2); (c) if the block query
  lists a transaction hash that the transaction lookup then cannot
  resolve, a shape-correct placeholder receipt is emitted (`status 0x0`, `gasUsed 0x0`) so the array
  stays index-aligned with the block's transaction list rather than silently losing an entry. This
  is defensive; it has not been observed.
- **Errors** garbage tag / non-canonical quantity / wrong arity → `-32602`.

---

## Logs and subscriptions

`eth_getLogs` is served **entirely from `evm_rpc.logs`** — no indexer call is on this path, so a
log query does not fail when the ingester's upstream is unreachable. How events get into that table
(Compact `emit` → indexer `contractEvents` → mapping → rows) is documented in
[`logs/LOGMAP.md`](logs/LOGMAP.md) and, end to end with worked examples, in the review report
`Umbra/reports/00006-events-pipeline.md` in the organizer workspace (not part of this repo). This
section documents only the RPC contract.

### `eth_getLogs`

- **Params** 1 positional: a filter object.

  | Field | Accepted | Meaning |
  |---|---|---|
  | `address` | absent, one address, or an array | OR over addresses; an **empty array** and an address nothing ever emitted from both return `[]`, not an error |
  | `topics` | positional array, entries `null`, a topic, or a nested array | `null` is a wildcard **over the value**; a nested array is OR at that position; a filter of length L additionally requires the log to *have* at least L topics (go-ethereum's length rule) |
  | `fromBlock` / `toBlock` | hex quantity or `latest`/`earliest`/`pending`/`safe`/`finalized` | both **default to `latest`**, so a bare `{}` returns only logs in the head block; `pending`/`safe`/`finalized` collapse to `latest` |
  | `blockHash` | 32 bytes | mutually exclusive with `fromBlock`/`toBlock` |

- **Result** an array of geth-shaped log objects (`address`, `topics`, `data`, `blockNumber`,
  `blockHash`, `transactionHash`, `transactionIndex`, `logIndex`, `removed`), ordered by
  `(block_number, tx_index, log_index)`.
- **Source** `pg:logs` joined to `pg:address_map`; `latest` resolves through the **indexer head**
  in `serve-all.ts` (not the logs table's max block).
- **Deviations** (a) an inverted range (`from > to`) returns `[]`, matching geth, not an error;
  (b) JSON **numbers** are accepted for `fromBlock`/`toBlock` where geth requires quantity strings.
- **Errors** `-32602` for: missing/non-object filter, a filter array, `blockHash` combined with a
  range, a short `blockHash` or topic, a decimal `fromBlock`, more than 4 topic positions, a
  malformed address. More than 10 000 matching rows → **`-32005 query returned more than 10000
  results`** (the limit is enforced with `LIMIT 10001`, so it costs one extra row, not a count).

### `eth_subscribe`

**WebSocket only** (`EVM_RPC_WS_PORT`, default 10021). Not available over HTTP.

- **Params** 1–2 positional: the subscription kind, plus a filter object for `logs`.
- **Result** a subscription id (`0x1`, `0x2`, …). Ids come from a **process-wide** monotonic
  counter, not a per-connection one, so ids are unique across sockets.
- **Kinds**

  | Kind | Source | Payload |
  |---|---|---|
  | `logs` | the ingester's **post-commit** tail (`onCommitted`), filtered in memory by the same primitives `eth_getLogs` parses with | one log object per notification, byte-identical in shape to an `eth_getLogs` entry, so a client can use one decoder for both |
  | `newHeads` | polled distinct `(block_number, block_hash)` pairs from `pg:logs`, every 1000 ms | `{number, hash, parentHash, timestamp}` |

  Feeding `logs` from after the commit (rather than from the mapper) means a subscriber is never
  told about a log that a rolled-back transaction then erased.
- **Notifications** are `{"jsonrpc":"2.0","method":"eth_subscription","params":{subscription,result}}`.
- **Deviations** only `logs` and `newHeads` exist; `newPendingTransactions` and `syncing` answer
  `-32602 unsupported subscription type`. `newHeads` is derived from the **logs table**, so it
  announces only blocks that carried a watched log and its `parentHash` is always the zero hash and
  its `timestamp` always `0x0` — see [Known issues](#known-issues), K7.
- **Errors** unsupported kind, non-object `logs` filter, malformed address/topic in the filter →
  `-32602`. Subscriptions belonging to a socket are dropped when it closes.

### `eth_unsubscribe`

- **Params** 1 positional: a subscription id. **Result** `true` when a subscription was removed,
  `false` otherwise — including for a garbage or non-string id. This is geth's behaviour
  (an unknown id is not an error).
- **Surface** WebSocket only.

---

## Write path

### `eth_sendRawTransaction`

- **Registered only when `RELAY_URL` is set.** With no relayer configured the method name is not in
  the registry at all and the server answers `-32601 Method not found` (K8).
- **Params** 1 positional: the raw, signed transaction hex. Additional parameters are ignored.
- **Result** whatever the relayer returns as `result` — an eth-shaped 32-byte hash.
- **Source** `relay`. The forward is literally
  `POST <RELAY_URL>/eth_sendRawTransaction {"rawTx": params[0]}` and nothing else; this service does
  not decode, validate or hex-check the payload. The relayer's `code`/`message` are propagated
  verbatim (e.g. `-32602 malformed RLP … BUFFER_OVERRUN`, `-32000 only legacy (type-0) transactions
  are supported`); an HTTP failure without a body error becomes `-32000 relayer HTTP <status>`.
- **Deviations** (a) legacy **type-0 transactions only** — this is why blocks carry no
  `baseFeePerGas`; (b) a `200 OK` means "the relayer accepted the job", **not** "the transaction is
  on chain": proving takes ~25–40 s afterwards and a failure at that point has no channel back to
  the JSON-RPC caller; (c) local parameter validation surfaces as `-32603` (K5).
- **Related** what the relayer receives, derives and verifies — including the trust model of this
  path and the questions a future relay specification must settle — is documented in the review
  report `Umbra/reports/00006-relay-interface.md` in the organizer workspace (not part of this repo).

---

## Not implemented (-32004)

Methods the official Ethereum JSON-RPC spec defines but this surface deliberately does not serve
answer **`-32004 "Method not supported"`** (EIP-1474), not `-32601` — a client can therefore tell
"this endpoint knows the method and declines to serve it" from "this endpoint has never heard of
that name" and fall back accordingly. **Genuinely unknown method names still answer `-32601`.**
Each error carries `data: { method, classification, reason, documentation }` — the per-method
reason is in the code. The table below mirrors `evm-rpc/methods/not-implemented.ts`, which is the
single source of truth; `evm-rpc/test/not-implemented.test.ts` asserts that no method of the
official spec inventory is left answering `-32601`.

| Classification | Meaning | Methods |
|---|---|---|
| `n/a-by-design` | Structurally impossible on Midnight: contract state is a ledger blob, and there is no EVM execution engine, storage trie or state proof. No future version can answer these. | `eth_getStorageAt`, `eth_getStorageValues`, `eth_getProof`, `eth_createAccessList`, `eth_getBlockAccessList`, `eth_simulateV1`, `eth_fillTransaction`, `eth_baseFee`, `eth_blobBaseFee` |
| `intentionally-absent` | The capability lives elsewhere by design — signing is the wallet's (`eth_accounts` is `[]`, so wallets never call these), and there is no mining identity. | `eth_sendTransaction`, `eth_sign`, `eth_signTransaction`, `eth_coinbase` |
| `backlog` | Implementable, deferred until a real consumer needs it. The polling-filter family is stateful; ethers v6 polls `eth_getLogs` instead, and `eth_subscribe` covers live tails. | `eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`, `eth_getFilterChanges`, `eth_getFilterLogs`, `eth_uninstallFilter`, `eth_capabilities`, `eth_config` |

Mining, uncle, tracing, `debug_*`, `personal_*`, `admin_*` and `txpool_*` namespaces are outside
the wallet-compatibility surface entirely and answer `-32601`.

---

## Deviations from Ethereum semantics

One table for the whole surface. "By design" = a deliberate consequence of Midnight not being an
EVM chain. "Known issue" = a defect or rough edge, detailed in the next section.

| # | Method(s) | Deviation | Status |
|---|---|---|---|
| D1 | `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_call` | the block-tag argument is syntactically validated and then ignored; every tag serves latest state | by design — no historical state lineage |
| D2 | `eth_getBalance` | native balance is scaled ×10¹² into wei-like units | by design (lossless presentation) |
| D3 | `eth_getTransactionCount` | a monotonic sent-transaction count over the indexed set, not a state-trie nonce | by design |
| D4 | `eth_getCode` | `0x60006000` marker for known contracts, not executable bytecode | by design |
| D5 | `eth_call` | ERC20 views only, folded from Transfer logs; every other target/selector returns `0x` | by design — no EVM execution |
| D6 | `eth_call` | `decimals()` is 0 unless a watch entry sets `evmDecimals` | by design (Compact stores whole units) |
| D7 | block methods | `latest`/`pending`/`safe`/`finalized` all resolve to the indexer head | by design — no fork choice |
| D8 | block methods | synthetic legacy header: zero roots and bloom, fixed gas limit, **no `baseFeePerGas`** | by design — keeps wallets on type-0 txs |
| D9 | block methods | millisecond indexer timestamps normalized to EVM seconds | by design (upstream quirk) |
| D10 | transaction methods | `value` is always `0x0` (UTXO amounts are not attributable at this layer) | by design |
| D11 | `eth_getTransactionByHash` | a duplicate indexer match adds a non-standard `raw_ref` note; element 0 is used | by design |
| D12 | receipts | `status 0x1` requires `SUCCESS` **and** every segment successful — a `PARTIAL_SUCCESS` reports `0x0` | by design |
| D13 | `eth_syncing` | constant `false`; the real ingester/archive lag is never reported | by design, low value — could be wired to the watermark |
| D14 | `eth_gasPrice`, `eth_estimateGas`, `eth_maxPriorityFeePerGas`, `eth_feeHistory` | constants; fees are DUST and there is no gas market | by design |
| D15 | `eth_getLogs` | inverted range returns `[]` (geth behaviour); JSON numbers accepted for `fromBlock`/`toBlock` | benign |
| D16 | `eth_getLogs` | >10 000 results → `-32005` | by design (provider practice) |
| D17 | `eth_subscribe` | only `logs` and `newHeads`; ids are process-wide, not per-connection | by design |
| D18 | `eth_sendRawTransaction` | legacy type-0 only; `200 OK` means "accepted for relaying", not "mined" | by design |
| D19 | `eth_getBlockReceipts` | only the **string** forms of `BlockNumberOrTagOrHash`; object forms rejected | **known issue** K6 |
| D20 | `eth_getTransactionByHash`, `eth_getTransactionReceipt` | a stored row the block query cannot place answers `null` (not an error); a relayer row echoes the eth-side hash it was queried by while being positioned by its Midnight hash | by design — K1 (fixed) |
| D21 | `eth_getTransactionReceipt`, `eth_getBlockReceipts` | `logs` covers only WATCHED contracts (what `evm_rpc.logs` holds); an unwatched contract's transaction reports `logs: []` | by design — K2 (fixed) |
| D22 | `eth_call` | no arity guard: `params: []` answers `0x` instead of `-32602` | **known issue** K3 |
| D23 | `eth_estimateGas` | the transaction object is never validated; a bare string is accepted | **known issue** K4 |
| D24 | `eth_feeHistory` | `oldestBlock` is the newest block (hex form) or `0x0` (tag form), never the range's lowest | **known issue** K4 |
| D25 | `eth_sendRawTransaction` | local parameter errors surface as `-32603`, not `-32602` | **known issue** K5 |
| D26 | WebSocket surface | no envelope validation; notifications answered; Part B methods absent | **known issue** K7 |
| D27 | `eth_sendRawTransaction` | `-32601` when `RELAY_URL` is unset (conditional registration) | **known issue** K8 |
| D28 | transport | additive operational limits: 100-entry batch cap, 1 MiB request/response caps, HTTP 413/405 | benign — see [Transport](#transport-and-envelope) |

---

## Known issues

Behaviour recorded here is **current and verified**, not aspirational. Each entry says what happens
today, why, and whether a fix is scheduled.

### K1 — `-32603` for `tx_index`-stored hashes — **FIXED**

**Was:** both by-hash methods answered **`-32603 Internal error`** for a transaction hash stored in
`evm_rpc.tx_index`. The DB-first branch positioned the row with `transactionIndex()`, which
re-fetched the block from the indexer and threw `"transaction is absent from its reported block"`
whenever the stored hash was not in `block.transactions[]`.

**Why it happened** — the earlier diagnosis blamed the wallet monitor and was wrong; re-measured
against the live indexer before the fix, the monitor's subscription hash equals the block query's
hash for the same transaction (7 of 7 rows). `evm_rpc.tx_index.hash` is simply **not one
namespace**:

| Writer | `hash` is | `raw_ref` |
|---|---|---|
| wallet monitor | the Midnight transaction hash — identical to the block query's | `indexer:transaction:<id>` |
| relayer | the **eth-side** transaction hash, deliberately: it is the identifier MetaMask computed and polls with | `relayer:midnight:<midnight hash>` |

Searching a Midnight block for an eth-side hash can only ever fail. A second, unrelated source of
the same symptom: a row naming a block from a **previous chain incarnation** (a local stack reset
while its `evm_rpc` data survived), whose transaction no longer exists at that height.

**Fix (both by-hash methods):**

1. the row is positioned by the hash the indexer knows it by — `relayer:midnight:<hash>` when the
   row carries one, otherwise its own key (`db.ts::canonicalHashFromRawRef`). The `hash` /
   `transactionHash` fields still echo the identifier the caller asked about, so a wallet polling
   with its own eth-side hash gets a real, positioned receipt;
2. a row the block query cannot place is no longer an error. The read falls through to the indexer
   lookup, and an unknown transaction answers **`null`** — the official `notFound` result — instead
   of `-32603`. No `transactionIndex` is ever fabricated.

A `tx_index` row whose stored hash genuinely disagrees with the block query is repaired at wallet-
monitor startup by `wallet-monitor/tx-hash-backfill.ts`, which matches rows to block transactions by
**indexer transaction id** (never by hash — that could only confirm the value under suspicion),
rewrites the primary key on divergence, refreshes a stale `block_hash`, and leaves relayer rows and
unknown provenance untouched. It is idempotent and re-runs until it has a clean pass.

Never affected: `eth_getBlockReceipts` and the two by-index methods, which start from the block
query and never re-derive a position.

### K2 — receipts never carried logs — **FIXED**

**Was:** both receipt methods returned `logs: []` with a zero `logsBloom`, even for a transaction
whose Transfer log `eth_getLogs` served (reproduced on `0x7a8c0ba2…` at block `0xbaa`). The cause
was structural: receipts are synthesized on the Part B read path, which had an `EvmRpcReader` but no
way to reach `evm_rpc.logs`, and fixing one of the two receipt surfaces alone would have made them
disagree.

**Fix:** `EvmRpcReader` gained `getLogsByTransactionHash()`, reading the same columns
`eth_getLogs` reads (`logs_tx_hash_idx` already existed for exactly this access path) and returning
the identical objects — a receipt and a log query can no longer describe the same row differently.
The shared `synthesizeReceipt()` carries them, so `eth_getTransactionReceipt` and
`eth_getBlockReceipts` are fixed together and cannot drift.

`logsBloom` is computed from that array in the same call (`methods/bloom.ts`, go-ethereum's Bloom-9:
three 11-bit positions per address/topic from `keccak256`, indexed from the end of the 256-byte
array). A receipt that carried logs but a zero bloom would be worse than one carrying neither — it
asserts, with the filter's full authority, that nothing matches.

**The join key is the Midnight transaction hash**, which is why this became possible only with K1:
`evm_rpc.logs.tx_hash` is written by the ingester from the indexer's transaction identity, so a
relayer row keyed on an eth-side hash finds its logs through `canonicalHash`, not through the key it
was queried by.

**Remaining limit (by design, D21):** `evm_rpc.logs` only holds events from **watched** contracts,
so a transaction touching an unwatched contract still reports `logs: []`. That is accurate for this
surface — it is the whole log set this service knows — but it is not what an Ethereum node would
say. Per-transaction joining also means `eth_getBlockReceipts` issues one log query per transaction
in the block.

### K3 — `eth_call` lost its arity guard at the Part F merge

`methods/static.ts` registered `eth_call` with `positionalParams(params, 1, 2)`. The ERC20-view
handler re-registers it with `{ replace: true }` and performs no arity check, so a malformed
`eth_call` with `params: []` answers **`0x` instead of `-32602`**. Every well-formed call is
unaffected. Restoring the guard is a two-line change in `methods/erc20-call.ts`; it is recorded
rather than fixed because this review is documentation-only.

### K4 — two constant-answer methods are laxer than the spec

- **`eth_estimateGas`** validates only the parameter *count*: `["not-a-tx"]` is accepted and
  answered `0x5208`. A client sending a malformed transaction object gets no signal.
- **`eth_feeHistory`** returns `oldestBlock` = the `newestBlock` argument when it was hex, and `0x0`
  when it was a tag. The spec defines it as the **lowest** block of the returned range. Since every
  returned value is zero this misleads only a client that computes block numbers from the response.

### K5 — `eth_sendRawTransaction` reports local parameter errors as `-32603`

The forwarding handler throws a plain `Error("expected [rawTxHex]")` for a missing or non-string
parameter, which the server sanitizes into `-32603 Internal error`. `params: []` and `[42]` both
produce it, where `-32602` is correct. Errors coming *from the relayer* are propagated with their
own codes and are unaffected. There is also no client-side hex validation: a non-hex string is
forwarded to the relayer, which rejects it.

### K6 — `eth_getBlockReceipts` accepts only string block references

`BlockNumberOrTagOrHash`'s object forms (`{blockHash, requireCanonical}`, `{blockNumber}`) are
rejected; a tag, a hex height or a 32-byte hash string all work. Additionally, a transaction hash
the block query lists but the transaction lookup cannot resolve produces a **placeholder receipt**
(`status 0x0`, `gasUsed 0x0`) rather than an omission, so the returned array stays index-aligned
with the block's transaction list. That path is defensive and has not been observed on a live stack.

### K7 — the WebSocket endpoint is not a full JSON-RPC endpoint

`EVM_RPC_WS_PORT` (10021) is a subscription endpoint that happens to speak JSON-RPC, and it differs
from the HTTP surface in four verified ways:

1. **No envelope validation.** A request without a `jsonrpc` member is served normally; the HTTP
   path answers `-32600`.
2. **Notifications are answered.** A request without an `id` receives a response with `id: null`
   instead of no response at all.
3. **Part B methods are absent.** Only `eth_subscribe`, `eth_unsubscribe` and the Part C
   registrations (`eth_getLogs`) are dispatchable; `eth_chainId`, `eth_blockNumber` and every other
   HTTP method answer `-32601`. Because ethers' `WebSocketProvider` opens a connection with
   `eth_chainId`, **it cannot be used against this port** — use the HTTP endpoint, or `eth_subscribe`
   over a raw socket.
4. **`newHeads` is derived from `evm_rpc.logs`**, not from the chain head. It announces only blocks
   that carried a watched log, so it stays silent while the chain advances without one (verified:
   no notification in a 12 s window while blocks were being produced), and its `parentHash` and
   `timestamp` are placeholders.

### K8 — `eth_sendRawTransaction` is conditionally registered

Without `RELAY_URL` the method is not registered and answers **`-32601`**, which is the one place
where a spec-defined method escapes the `-32004` policy. This is deliberate for now: the choice
between leaving it and registering an `else` branch that answers `-32004` ("write path requires
RELAY_URL") is parked until the relay interface is specified — see the review report
`Umbra/reports/00006-relay-interface.md` in the organizer workspace.

---

## Transport and envelope

`server.ts` is JSON-RPC 2.0 compliant on the HTTP surface; every rule below was verified on the
wire, not only by reading the code.

| Aspect | Behaviour |
|---|---|
| Envelope | `jsonrpc: "2.0"` and a string `method` are required → `-32600` otherwise; unknown members ignored |
| `id` | echoed verbatim for string/number/null; boolean/object/array ids → `-32600` with `id: null`; fractional ids are accepted |
| Notifications | a request without `id` gets no response; a payload that is entirely notifications answers **HTTP 204** with an empty body |
| Params | must be an array or an object if present; a string/number/`null` `params` → `-32602`. **By-name (object) params are not supported** by Part B methods, which are positional; Part C methods wrap an object as `[obj]` |
| Batches | arrays are dispatched in order with bounded concurrency (8) and the response order always matches the request order; one failing entry never kills the batch; empty `[]` → a single `-32600` |
| Batch caps | more than 100 entries → `-32600 Batch exceeds 100 entries`; responses exceeding 1 MiB → the remaining entries answer `-32005 Batch response limit exceeded` |
| Request cap | body over 1 MiB → **HTTP 413** with `-32600 Request body too large` |
| Errors | `-32700` parse · `-32600` invalid request · `-32601` unknown method · `-32602` invalid params · `-32603` internal · `-32004` method not supported (EIP-1474) · `-32005` limit exceeded. Handler exceptions that are not `RpcError` are sanitized to `-32603`; an `RpcError`'s `data` is carried through |
| Results | canonicalized through `JSON.stringify`/`parse` at the per-entry boundary, so BigInt, cycles and `toJSON` side effects cannot reach the HTTP serializer |
| HTTP verbs | non-`POST` → **405** with `Allow: POST, OPTIONS`; `OPTIONS` → **204** with CORS headers |
| CORS | allow-all (`Access-Control-Allow-Origin: *`). Required for browser wallets, fine for a local demo — **review before any public deployment** |
| Content type | never inspected; a body is decoded lossily as UTF-8 (invalid bytes become U+FFFD) rather than rejected |

The WebSocket surface does **not** share these guarantees — see K7.

---

## Environment

| Variable | Default | Used by | Notes |
|---|---|---|---|
| `EVM_RPC_PORT` | `8545` | both entrypoints | HTTP listener |
| `EVM_RPC_HOST` | `0.0.0.0` | both | |
| `CHAIN_ID` | `2400` | both | drives `eth_chainId` and `net_version` |
| `INDEXER_URL` | `http://127.0.0.1:10001/api/v4/graphql` | both | block and transaction queries |
| `PG_URL` | — | `evm-rpc:all` **requires** it; `evm-rpc` treats it as optional | without it, `rpc-cli.ts` uses an empty reader and account/transaction reads return empty values |
| `INDEXER_WS` | — | `evm-rpc:all` (required) | ingester subscription |
| `WATCH_CONTRACTS_FILE` | — (required); `./watch.json` for the ERC20-view metadata | `evm-rpc:all` | contracts to ingest and expose |
| `EVM_RPC_WS_PORT` | `10021` | `evm-rpc:all` | subscription listener |
| `EVM_RPC_SCHEMA` | `evm_rpc` | `evm-rpc:all` | Postgres schema |
| `RELAY_URL` | unset | `evm-rpc:all` | when set, registers `eth_sendRawTransaction` and forwards to it |
| `DEMO_TOKEN_AS_NIGHT` | unset | `evm-rpc:all` | `=1` makes `eth_getBalance` add folded token balance ×10¹⁸ — demo only |

`npm run evm-rpc` and `npm run evm-rpc:all` are source-checkout operational entrypoints, matching
the existing `npm run archive:sync` model. The published `umbradb` package remains the compiled
storage library under `dist/`; it intentionally ships neither the operational TypeScript modules nor
`tsx` as a runtime dependency.

With a server running, `npm run evm-rpc:live-smoke` reproducibly checks the live height-growth and
block-shape claims; `EVM_RPC_TEST_ADDRESS` and `EVM_RPC_TEST_TX_HASH` add account and transaction
probes without embedding environment-specific fixtures.

---

## Related documents and provenance

| Topic | Where |
|---|---|
| Event → log mapping rules, `evm_rpc.logs` DDL, `source_event_id`, genesis backfill | [`logs/LOGMAP.md`](logs/LOGMAP.md) |
| Running the ingester and the log stack | [`logs/RUNBOOK.md`](logs/RUNBOOK.md) |
| The events pipeline end to end (Compact `emit` → indexer → ingest → `eth_getLogs` → token state), with live-validated worked examples and full filter semantics | review report `Umbra/reports/00006-events-pipeline.md` (organizer workspace, outside this repo) |
| What the relayer receives and derives on both ingress paths, and the open questions a relay specification must settle | review report `Umbra/reports/00006-relay-interface.md` (organizer workspace, outside this repo) |
| Per-method live verification evidence (request/response per method, envelope border cases) | review plan 00006 findings F4–F6 (organizer workspace) |

**Provenance of this document.** Every statement above is either read from the code in this
directory or taken from the live verification matrix of review 00006, which exercised all
registered methods against the running stack (indexer, proof server, Postgres, host-run RPC
service) with recorded requests and responses, plus a border-case suite for the JSON-RPC 2.0
envelope. The MetaMask compatibility session referenced by earlier revisions of this file **was
completed** (plan 00005, B-G5/F-G4): a live browser session connected, imported a watched token and
idled with **zero unhandled methods**. Cases that cannot be produced on a demo stack — the >10 000
result cap and live `eth_subscribe("logs")` delivery — are covered by
`evm-rpc/logs/test/get-logs.test.ts` and `evm-rpc/logs/test/subscribe.test.ts` instead.
