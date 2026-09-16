# Full-chain storage

**Status (2026-08-15):** implemented on `feat/indexer-independent-ingest`, the branch behind
UmbraDB PR #1. The authoritative delivery and evidence registers are
`openspec/changes/sprint-9-indexer-independence/tasks.md` §§15–18 and
`openspec/changes/sprint-9-indexer-independence/system-transactions-plan.md` §§15–19. Historical
branch names, commits and limitations in the design's revision log describe the state at those
revisions; they are not the current implementation contract.

## Purpose and boundary

UmbraDB's `tier1_wallet` schema is wallet-scoped. Full-chain storage adds the independent,
chain-scoped `chain_archive` schema: block records and raw bodies, ordered Midnight transactions,
D-parameter change observations, runtime metadata, and replay checkpoints. It is Tier 1.5 rather
than a copy of the indexer's relational schema.

The dependency direction remains strict:

- `chain-archive-sync/` owns node RPC, optional indexer GraphQL, runtime-metadata decoding,
  transaction decoding, replay and the CLI.
- `src/interfaces/chain-archive-store.ts` is the storage contract.
- `src/postgres/chain-archive-store.ts` and `src/postgres/migrations/chain_archive/` own SQL.
- `src/*` never imports `chain-archive-sync/*` or the node/indexer clients. The source guard in
  `test/postgres/no-chain-sync-import-guard.test.ts` enforces that direction.

The sync service directly constructs `PgChainArchiveStore`; the interface is a type boundary, not
runtime dependency injection.

## Schema and write contract

The independent migration lineage currently contains 001–007:

- 001 creates content-addressed `chain_blobs`, role classifications, the partitioned block,
  transaction and observation tables, verifier-key observations, and watermarks.
- 002 changes the transaction primary key to
  `(net, block_height, block_hash, position)`. `tx_hash` remains indexed and is not unique because
  the reference indexer can legitimately represent one system transaction twice at different
  positions.
- 003 persists block-scoped runtime metadata.
- 004–006 add replay checkpoints and bind them to block time and the ledger network.
- 007 forward-fixes blob-role removal guards on already-upgraded databases.

`putBlockBundle` is the atomic writer for a height. Its contract is intentionally narrow:

1. The sync service writes only the finalized canonical chain. It does not race the best-chain
   tail or attempt to archive competing unfinalized forks.
2. The store takes a transaction-scoped Postgres advisory lock derived from `(net, height)` before
   it evaluates or writes that height. The lock works across processes and database sessions.
3. Under the lock it refuses a different already-finalized canonical block at the same height and
   rechecks existing transaction identity triples `(position, tx_hash, kind)`.
4. An identical retry is idempotent; incompatible history is refused. Two writers can therefore
   never both pass a stale preflight check and interleave a block bundle.

The store still models a block tree and exposes `setCanonical` for other callers, but the sync
service's finalized-only writer contract is the safety boundary for this ingest path.

Blob reads recompute SHA-256 and refuse missing or corrupt content. Role triggers protect both
directions of each blob reference. Partition rollover remains implemented for the single-bucket
case; a multi-bucket overflow is refused for an operator-led split.

## Indexer-independent ingest

`ChainArchiveSyncService` has two source modes:

- With no `indexer` option, node-only ingest derives transaction rows from the historical node.
  Runtime metadata at each block decodes signed/general extrinsic framing, pallet/call-index
  changes, and `SystemTransactionApplied` events. The vendored ledger hashes both regular and
  system transactions. The header MNSV digest supplies the protocol version.
- With an `indexer` option, the historical indexer-sourced write path remains available.
  `oracleCrossCheck: true` additionally compares its regular-transaction view with the
  node-derived view before writing.

Node-only ingest needs an archive node for the range being captured: `System::Events`, runtime
state and the D-parameter are historical per-block values. Runtime metadata is captured once per
runtime and then available locally for later re-decode/replay, but it cannot reconstruct state
that was never ingested.

The persisted D-parameter stream is restart-stable. Before processing the first post-watermark
block, a new service instance hydrates its last-seen value from the newest finalized/canonical
`system_parameters_d` observation at or below the watermark. Restarting directly across a change
boundary therefore produces the same ordered identities and raw bytes as an uninterrupted run.

Header and body blobs are stable canonical JSON encodings of the authoritative JSON-RPC response;
Substrate RPC does not expose a raw SCALE header method. Transaction `tx_raw` blobs are the inner
opaque `send_mn_transaction` payloads and are real wire bytes.

## Replay validation and committed roots

`replayValidation: true` applies each block through the real ledger before the archive write. It
requires `ledgerNetworkId` and uses the chain specification's serialized `genesis_state`; the node
constructs block 0 without executing its embedded genesis extrinsics, so starting blank and
applying them would be a different transition.

For each block, replay reconstructs execution order from event phases and block-body order, applies
transactions with the block timestamp, closes the block, and compares the replayed ledger arena key
with the chain-committed root exposed by the historical runtime API
`midnight_ledgerStateRoot(at)`. A missing or mismatching root refuses before `putBlockBundle`, and
the speculative in-memory replay state is discarded so the same service instance can retry.
Checkpoint catch-up performs the same per-block comparison.

The related historical runtime methods used here are:

- `midnight_ledgerStateRoot(at)` — the variable-length serialized typed ledger arena key committed by
  `LedgerApi::post_block_update`.
- `MidnightRuntimeApi_get_network_id` via `state_call` — the runtime's SCALE string network id.
- `system_properties.genesis_state` — the authoritative serialized genesis ledger state.

The vendored runtime dependency `@midnight-ntwrk/ledger-v8@8.1.0-syshash.4` adds the minimal
`LedgerState.ledgerStateRoot()` export needed for an exact comparison. Its source commit, patches,
artifact hashes and structural/native oracle evidence are recorded in
`vendor/ledger-v8-syshash/PROVENANCE.md` and `SHA256SUMS`. `MIDNIGHT_LEDGER_WASM` is a deliberate
test/candidate override; sibling-wallet discovery is only a legacy compatibility fallback.

## Running the service

The production entry point is installed as `umbradb-archive-sync` and is available in-repo as:

```sh
ARCHIVE_PG=postgres://user:pass@host:5432/db \
NODE_ONLY=1 \
NODE_URL=http://archive-node:9944 \
npm run archive:sync
```

Important settings are `NET`, `ARCHIVE_SCHEMA`, `NODE_URL`, optional `INDEXER_URL`, `NODE_ONLY`,
`ORACLE_CROSS_CHECK`, `MAX_BLOCKS`, `REPLAY_VALIDATION`, `LEDGER_NETWORK_ID`, and
`REPLAY_CHECKPOINT_INTERVAL`. Replay interval values must be positive whole numbers. The CLI logs
node-only mode before connecting and states its archive-node requirement.

`syncOnce` stops at the finalized head and advances a persisted watermark only after the block
bundle and any due checkpoint are durable.

## Evidence and remaining scope

The committed suite includes unit, synthetic integration, real Postgres concurrency, digest-pinned
compose, captured-vector, native Rust oracle, and live archive-node cases. Each O1–O4 regression was
also run against its pre-fix mutation; the exact counterfactual and blind-spot answer are recorded
in the Sprint 9 registers. Current release-gate results belong in those registers rather than a
copied test count here, so this page cannot silently go stale again.

Known scope boundaries:

- The sync service deliberately ingests only finalized canonical blocks. Non-finalized-tail reorg
  following is not part of this writer.
- `INGESTS_VERIFIER_KEYS` remains false: the storage surface exists, but no available fixture has a
  deployed contract from which to implement and prove sync-side verifier-key observation ingest.
- Observation kinds other than `system_parameters_d` are not yet populated by this service.
- Replay validation is opt-in because it executes the ledger and performs historical RPC reads for
  every block.

See `design/full-chain-storage-design.md` for the original schema rationale and revision history;
use the Sprint 9 registers named at the top of this page for current implementation status.
