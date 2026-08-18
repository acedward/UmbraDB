# UmbraDB EVM JSON-RPC methods

This module exposes an HTTP JSON-RPC 2.0 compatibility surface for browser wallets. The default
chain ID is 2400 (`0x960`). Hex-encoded Midnight values are unprefixed inside the indexer and gain
the `0x` prefix only at this boundary.

## Implemented

| Method | Behavior / source |
|---|---|
| `eth_chainId` | `CHAIN_ID`, default `0x960`. |
| `net_version` | Decimal `CHAIN_ID`, default `"2400"`. |
| `web3_clientVersion` | `umbradb-evm-rpc/<package version>`. |
| `net_listening` | `true`. |
| `eth_syncing` | `false` until a Part A watermark source is available. |
| `eth_accounts` | Empty array; account permission belongs to the wallet. |
| `eth_gasPrice` | Constant 1 gwei (`0x3b9aca00`). |
| `eth_estimateGas` | Constant 21,000 (`0x5208`). |
| `eth_blockNumber` | Latest indexer GraphQL block height. |
| `eth_getBlockByNumber` | Indexer GraphQL block synthesized into the documented EVM shape. `pending`, `safe`, and `finalized` map to `latest`; `earliest` maps to height 0. |
| `eth_getBlockByHash` | Indexer GraphQL block synthesized into the same shape. |
| `eth_getBalance` | Native-token `evm_rpc.balances.value` multiplied by 10^12 using `bigint`. Unknown addresses return `0x0`. |
| `eth_getTransactionCount` | Count of `evm_rpc.tx_index` rows whose `from_id` is the address. |
| `eth_getCode` | `0x60006000` for `address_map.kind = 'contract'`; otherwise `0x`. |
| `eth_getTransactionByHash` | `evm_rpc.tx_index` first, then indexer GraphQL. UTXO amounts are not attributable yet, so `value` is `0x0`. |
| `eth_getTransactionReceipt` | `evm_rpc.tx_index` first, then indexer GraphQL. Success requires `SUCCESS` and every segment successful. Logs are empty pending Part C. |
| `eth_getBlockTransactionCountByHash` | Length of the indexer GraphQL block's transaction list. Unknown block returns `null`. |
| `eth_getBlockTransactionCountByNumber` | Same, addressed by block tag — `pending`/`safe`/`finalized` map to `latest`, `earliest` to height 0, as `eth_getBlockByNumber`. |
| `eth_getTransactionByBlockHashAndIndex` | Transaction at that position of the indexer GraphQL block's transaction list, synthesized into the same shape as `eth_getTransactionByHash` and enriched from `evm_rpc.tx_index` when a row matches. Out-of-range index or unknown block returns `null`. |
| `eth_getTransactionByBlockNumberAndIndex` | Same, addressed by block tag. |
| `eth_getBlockReceipts` | One receipt per transaction of the indexer GraphQL block, in block order, using the same synthesis as `eth_getTransactionReceipt` (so `logs` is `[]` here too — logs are served by `eth_getLogs`). Accepts a block tag or a 32-byte block hash. Unknown block returns `null`. |
| `web3_sha3` | Dependency-free Ethereum Keccak-256. |

## Compatibility stubs

These methods are registered so wallet polling does not encounter `-32601` while later parts are
still absent.

| Method | Stub behavior |
|---|---|
| `eth_call` | **ERC20 views implemented** (`evm-rpc/methods/erc20-call.ts`, registered with `replace: true`): `balanceOf(address)`, `decimals()`, `symbol()`, `name()`, `totalSupply()` for any watched token, answered by folding Transfer logs — the same computation an EVM explorer performs. Any other target or selector still returns `0x`. There is no EVM execution: Midnight contract state is a ledger blob, not EVM storage. **`decimals()` is 0 by default** — the Compact contracts store `Uint<128>` whole units and emit them verbatim, so a `deployment.json` nominally declaring `decimals: 18` is ignored unless a watch entry sets `evmDecimals`. This is what lets MetaMask import a token and produce `transfer(address,uint256)` calldata, the only shape Part E's relayer accepts. |
| `eth_feeHistory` | Returns correctly-sized zero base-fee, gas-ratio, and reward arrays. Blocks deliberately omit `baseFeePerGas`, so transactions remain legacy type 0. |
| `eth_maxPriorityFeePerGas` | Returns `0x0` for the legacy-fee chain. |
| Receipt logs | `logs: []` and a zero 256-byte bloom; Part C replaces this through `registerMethod(..., { replace: true })`. |
| Contract code | Returns a non-empty marker rather than executable EVM bytecode. |

## Intentionally absent

- `eth_sendRawTransaction` is reserved for Part E.
- `eth_getLogs`, subscriptions, and the WebSocket listener (`EVM_RPC_WS_PORT`, default 8546) are
  reserved for Part C.
- Mining, uncle, filter, tracing, debug, personal, admin, and tx-pool namespaces are not part of
  the compatibility layer.

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

## Documented deviations

- Account methods serve latest state for every syntactically string-valued block tag because the
  Part A schema has no historical balance lineage.
- `eth_getTransactionCount` is a monotonic sent-transaction count, not an Ethereum state trie
  nonce. It is sufficient for MetaMask's nonce polling over the monitored transaction set.
- Part A's fixed DDL has no index beginning with `tx_index.from_id`, so transaction-count and
  synthesized-nonce reads can scan that table as it grows. The RPC bounds batch cardinality and
  concurrency, but production deployments should add an upstream `(from_id, block_height, hash)`
  index when the Part A schema contract permits migrations.
- Block author data is used as `miner` only when it is exactly 20 bytes; other Midnight author
  encodings become the zero address to preserve the EVM field shape.
- The live rc.4 indexer exposes pallet timestamps in milliseconds despite describing them as UNIX
  timestamps. Values at millisecond magnitude are divided by 1,000 before becoming EVM seconds;
  already-normalized second values remain unchanged.
- If a `tx_index` row is partially populated, missing block fields become zero-valued EVM fields.
  Missing transactions return `null` as required by Ethereum JSON-RPC.
- The GraphQL transaction lookup is list-valued. Element zero is used; when more than one row is
  returned, the synthesized transaction adds a non-standard `raw_ref` note recording the ambiguity.

## MetaMask compatibility session

Automated envelope and method-shape coverage was run on 2026-08-10. Live checks against the Part A
stack also passed: the indexer-backed height advanced from `0x1c` to `0x1e` over ten seconds, the
live block carried a 256-byte bloom and no `baseFeePerGas`, a monitored native balance matched the
database value after exact 10^12 scaling, and a live `tx_index` transaction/receipt returned mapped
from/to addresses with receipt status `0x1` and empty logs.

The five-minute MetaMask session itself remains blocked. The only connected browser is the Codex
in-app browser, which has no `window.ethereum`, and the dashboard reports this explicitly. In
addition, the current Part A dashboard proxy targets the future Part F service name
`http://umbradb:8545`, so its `/api/eth` probes cannot reach a host-run `npm run evm-rpc` process at
port 10020. Direct HTTP checks against port 10020 pass. Once a MetaMask-enabled browser is attached
and Part F routes the dashboard proxy to this service, run Add network → connect → idle for five
minutes and append the unhandled-method summary here.

## Environment

| Variable | Default |
|---|---|
| `EVM_RPC_PORT` | `8545` |
| `EVM_RPC_HOST` | `0.0.0.0` |
| `EVM_RPC_WS_PORT` | `8546` (reserved; not opened until Part C) |
| `INDEXER_URL` | `http://127.0.0.1:10001/api/v4/graphql` |
| `PG_URL` | unset; account reads return empty values when absent |
| `CHAIN_ID` | `2400` |

`npm run evm-rpc` is a source-checkout operational entrypoint, matching the existing
`npm run archive:sync` model. The published `umbradb` package remains the compiled storage library
under `dist/`; it intentionally does not ship either top-level operational TypeScript module or
promote the development runner `tsx` to a runtime dependency.

With the server running, `npm run evm-rpc:live-smoke` reproducibly checks the live height-growth and
block-shape claims. `EVM_RPC_TEST_ADDRESS` and `EVM_RPC_TEST_TX_HASH` add account and transaction
probes without embedding environment-specific fixture values.
