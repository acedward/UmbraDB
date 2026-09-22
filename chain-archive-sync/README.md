# `chain-archive-sync`

Fills the `chain_archive` schema from a live Midnight node (Substrate JSON-RPC, raw block bytes)
and indexer (GraphQL, per-transaction metadata and `raw` payloads). Finalized blocks only; every
archived block is `is_canonical = true, finalized = true` (no fork following).

Run it with `npm run archive:sync` (`tsx chain-archive-sync/sync-cli.ts`). It bootstraps its own
schema on startup and loops until `SIGINT`/`SIGTERM`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `ARCHIVE_PG` | *(required)* | Postgres connection string for the archive database |
| `NET` | `preprod` | free-form network id written into `chain_archive.*.net`. Not an enum and not validated — it only has to be stable for a given chain. Values in use: `preprod`, `undeployed1` (local devnet), **`stagenet`** (project 00020) |
| `ARCHIVE_SCHEMA` | `chain_archive` | schema the migration lineage is applied to |
| `NODE_URL` | `https://rpc.preprod.midnight.network` | Substrate JSON-RPC endpoint (`chain_getFinalizedHead`, `chain_getBlockHash`, `chain_getHeader`, `chain_getBlock`) |
| `INDEXER_URL` | `https://indexer.preprod.midnight.network/api/v4/graphql` | indexer GraphQL endpoint |
| `MAX_BLOCKS` | `200` | heights per `syncOnce` batch |
| `START_HEIGHT` | *(unset → genesis)* | `head`, or a height. Where a **first** run starts — see below |
| `SYNC_CONCURRENCY` | `8` | how many heights are fetched at once |
| `SYNC_BACKOFF_BASE_MS` | `1000` | first back-off delay after a retryable endpoint failure |
| `SYNC_BACKOFF_MAX_MS` | `60000` | back-off ceiling (per network call and between batches) |
| `SYNC_BACKOFF_MAX_ATTEMPTS` | `8` | attempts per network call before the batch fails and the loop retries |

Example (project 00020, Midnight Stagenet, archive from the current finalized head):

```sh
ARCHIVE_PG='postgres://umbra:umbra@127.0.0.1:10021/umbra' \
NET=stagenet \
NODE_URL='https://rpc.stagenet.shielded.tools' \
INDEXER_URL='https://indexer.stagenet.shielded.tools/api/v4/graphql' \
START_HEIGHT=head MAX_BLOCKS=200 SYNC_CONCURRENCY=8 \
npm run archive:sync
```

## `START_HEIGHT` (spec 00020 FR-015)

* `START_HEIGHT` is honoured **only while the archive has no watermark for this `NET`**. Once a
  watermark exists it is the sole authority, so a stale value left in a service manager's
  environment can never rewind or fork a running archive.
* `head` means the finalized head *at the moment of the first batch* — precisely
  `min(node finalized head, indexer tip)`, so the first archived block is one the indexer can
  already serve transactions for.
* **Consequence for every downstream reader**: the first archived block may have no archived
  parent. Nothing (archive queries, the token-indexer scanner, `rebuild`) may assume the archive
  begins at genesis or that `parent_hash` resolves to an archived row.

## Concurrency and back-off (spec 00020 FR-016)

* `SYNC_CONCURRENCY` bounds how many heights are **fetched** in parallel. Blocks are still
  **written** strictly in ascending height order, one watermark advance per block, so the
  watermark semantics and the crash-safety properties are unchanged. Against the public endpoints
  each block costs three latency-bound round trips (2 node RPC + 1 GraphQL), so this is the
  difference between ~1.3 blocks/s and roughly an order of magnitude more.
* Memory is bounded by the window (`SYNC_CONCURRENCY` blocks), not by `MAX_BLOCKS`.
* Retryable endpoint failures — HTTP **429**, **403** (what a WAF in front of a public endpoint
  answers when it decides a client is abusive), **5xx**, a failed transport, and a `200` whose body
  is not JSON (a proxy error page) — are retried per call on an exponential schedule with jitter,
  honouring `Retry-After` when present. A GraphQL/JSON-RPC protocol error, a malformed block
  number, and every database error are **not** retried; they surface immediately.
* If a window fails after some of its blocks were already written, those blocks and their
  watermark stand; the error carries a `partialSync` field naming the committed range.
* `syncOnce` returns `elapsedMs`, `blocksPerSecond`, `retries` and `throttled` per batch; the CLI
  logs them on every `batch` line and logs one `backoff` line per wait.
