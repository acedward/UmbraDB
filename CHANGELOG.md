# Changelog

All notable changes to UmbraDB are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/). The stability guarantees that govern the
entries below are stated in [`docs/STABILITY.md`](docs/STABILITY.md).

## [Unreleased]

### Added

- Indexer-independent finalized chain-archive ingest from a historical Midnight 1.x node, including
  block-scoped metadata/event decoding, runtime-generated system transactions, durable D-parameter
  continuity, sparse ledger replay checkpoints, and per-block comparison with the chain-committed
  `midnight_ledgerStateRoot`.
- Packaged `umbradb-archive-sync` CLI and digest-pinned Docker parity/live-service gates.
- **Shielded monitor store (`shielded_monitor` schema, project B core).** A new, **additive**
  migration lineage — `src/postgres/migrations/shielded_monitor/{000_schema,001_core}` applied
  through `bootstrapShieldedMonitorSchema()` — creating `monitors`, `associations`,
  `lifecycle_events` and `audit_events` in a schema of its own. Nothing existing changes: no
  current migration, table, interface or exported symbol is touched, and a deployment that never
  calls the bootstrap is unaffected.
  Alongside it, a new top-level `shielded-monitor/` module (outside `src/`, like
  `chain-archive-sync/`, with a committed guard test enforcing that nothing under `src/` imports
  it): BIP-350 Bech32m intake for Midnight shielded viewing keys with the network-bound HRP rule
  and ledger-v8 validation, a domain-separated SHA-256 registration fingerprint, a total lifecycle
  state machine with a monotone epoch, an epoch-fenced `advance()` that commits a block range's
  associations and its coverage advance in one transaction, a revocation-list export/apply pair
  for restores, and a trusted operator harness (`npm run shielded-monitor:harness`).
  Documented in `docs/shielded-monitor-restore.md` and `SECURITY.md`; specified in
  `openspec/changes/00009-02-monitor-store/`.
  **Alpha trust model:** viewing keys and wallet↔transaction associations are stored in
  **plaintext** in this schema — at-rest encryption, key rotation, keyed fingerprints and tenant
  isolation are deferred. See `SECURITY.md` before deploying it.

### Changed

- **Breaking (`chain_archive` preview):** migration 002 re-keys `transactions` from
  `(net, block_height, block_hash, tx_hash)` to `(net, block_height, block_hash, position)` so
  duplicate-hash reference rows can coexist. Migrations 003–007 add runtime metadata, replay
  checkpoint identity, and forward blob-role protection. This is forward-only; back up before
  upgrade and coordinate readers that assumed the old key.
- The finalized bundle writer now serializes competing `(net,height)` writes with a Postgres
  advisory lock and refuses incompatible stored history rather than permitting interleaving.
- The runtime ledger is a checksummed vendored `8.1.0-syshash.4` build; its provenance and minimal
  source patches are committed under `vendor/ledger-v8-syshash/`.

## [1.0.0] - unreleased — "Totality"

**Blocked.** The 1.0.0 tag additionally requires a **full local sync of UmbraDB against Midnight**
(archive node → local indexer → UmbraDB), which is not yet complete. Until it is, the release below
ships as `0.9.5`: the same code, without the SemVer freeze commitment that 1.0.0 makes. See
`ROADMAP.md` § "What blocks 1.0.0".

## [0.9.5] - 2026-07-25 — "Penumbra"

The first importable, published public surface. Everything below is imported from the package root
(`import { ... } from "umbradb"`); there is no supported deep import of an internal module (the
`package.json` `exports` map exposes only `"."`).

**SemVer status — read this before depending on it.** This is a `0.y.z` release, so under SemVer the
surface carries **no compatibility guarantee yet**. The surface *is* frozen in the engineering sense —
it is enumerated, drift-tested against the exported classes, and documented in
[`docs/STABILITY.md`](docs/STABILITY.md) — but the *promise* not to break it in a minor or patch
release is a commitment that takes effect **at 1.0.0**, not here. Treat 0.9.5 as the release
candidate for that promise: depend on it, report what breaks, and expect the surface to be identical
at 1.0.0 unless something found in the interim justifies changing it.

### Added

Initial public API surface — the five storage primitives plus the wallet-state-envelope capability:

- **`PgTemporalKV`** (`TemporalKV`) — a versioned key-value store with point-in-time reads
  (`put`/`get`/`getAt`/`listKeys`) over a `kv_current`/`kv_history` schema.
- **`PgTransactionLeaseLayer`** (`TransactionLeaseLayer`) — real Postgres transactions and
  connection-pinned advisory locks; the `withTransaction` and `withLease` combinators are `async`
  **methods** of this class (there are no standalone `withTransaction`/`withLease` exports).
- **`PgCheckpointStore`** (`CheckpointStore`) — content-addressed, deduplicated, chunked storage
  for large periodic snapshots, with integrity verification and reachability-based garbage
  collection (`save`/`load`/`history`/`prune`).
- **`PgWatermarks`** (`Watermarks`) — simple, unversioned sync-progress cursors with transactional
  composition (`set`/`get`).
- **`PgTransactionHistoryStorage`** (`TransactionHistoryStorage`) — per-wallet transaction history
  with lifecycle-aware upsert/merge and identifier-subset pending-clear.
- **`PgWalletStateEnvelopeStore`** — persists shielded/unshielded/dust wallet-sync snapshots as a
  single `CheckpointStore.save()` call per `(walletId, networkId)`. A capability on top of the five
  primitives, not a sixth primitive (it adds no table or migration of its own).

Also part of the frozen surface:

- **`createClient`** / **`UmbraDBConnectionOptions`** / **`UmbraDBSql`** / **`DEFAULT_SCHEMA`** — the
  connection factory and its types.
- **`runMigrations`** / **`Migration`** / **`RunMigrationsOptions`** — the forward-only migration
  runner (which also runs the startup durability probe).
- **`saveAndAdvance`** (with `SaveAndAdvanceDeps` / `SaveAndAdvanceCursor`) — the G5 co-transactional
  composition primitive that persists a checkpoint and advances its sync cursor in one transaction.
- **`Rollback`** — the control primitive a caller throws inside a `withTransaction` callback to
  request a deliberate rollback (an `Error` subclass with **no** catalog `code`).
- Every `interfaces/` contract and value type (`TransactionHandle`, versioned-entry types,
  wallet-envelope types, etc.).
- The full **`StorageError`** hierarchy (base + every concrete subclass **except** the six
  deferred chain-archive classes), each carrying a machine-readable `retryable: Retryability`
  field. The frozen `{code → meaning → retryable}` catalog (24 codes) is
  [`docs/ERROR-CATALOG.md`](docs/ERROR-CATALOG.md).

### Contract documents

- SemVer stability policy: [`docs/STABILITY.md`](docs/STABILITY.md).
- The eight release contracts (durability, forward-only migration, cancellation, save-retry caveat,
  lease limitation, backup/restore, threat-model pointer, format headroom):
  [`docs/CONTRACT.md`](docs/CONTRACT.md).
- Frozen error-code catalog: [`docs/ERROR-CATALOG.md`](docs/ERROR-CATALOG.md).

### Deferred to a 1.1 fast-follow (explicitly outside the frozen 1.0 surface)

- Full-chain archival storage (the `chain_archive` schema and its error classes) — a 1.1 preview.
- Automatic save idempotency (the `idempotency_key` UNIQUE migration).
- Keyed/per-consumer chunk addressing and at-rest encryption.
- A public observability/tracing seam.

[Unreleased]: https://github.com/charleshoskinson/UmbraDB/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/charleshoskinson/UmbraDB/releases/tag/v1.0.0
