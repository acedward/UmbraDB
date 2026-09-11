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
- **Shielded viewing-key relevance scanner (project B's worker).** A new process,
  `umbradb-shielded-monitor`, that reads the archive's canonical finalized history **only**
  through the `ArchiveReadContract` interface, evaluates the ledger's own
  `EncryptionSecretKey.test(offer)` over each regular transaction's guaranteed offer and every
  fallible-segment offer, and commits each batch of whole block heights — that batch's
  associations **and** the coverage advance — in ONE transaction in `shielded_monitor`. Blocks
  with no matches still advance coverage, so "scanned and empty" stays distinguishable from
  "not scanned". An unsupported protocol version or an undecodable transaction stops the monitor
  at that height and position **without** claiming coverage over it; an archive rebuilt under a
  monitor moves it to `stale_source` rather than mixing histories. The tail follows
  `LISTEN chain_archive_progress` with polling as the fallback. Every association carries
  `appliedOutcome = "unknown"`; the archive's replay outcome, where it recorded one, is exposed
  separately as `sourceOutcome` and is never promoted. Additive: no existing migration, table,
  interface or exported symbol changes, and a deployment that never runs the binary is
  unaffected. Documented in `docs/shielded-monitor-scanner.md`; specified in
  `openspec/changes/00009-03-relevance-scanner/`.
- **Shielded monitor private API and reference consumer (project C, private half).** Two new
  packaged CLI entry points, `umbradb-shielded-monitor-api` and
  `umbradb-shielded-monitor-client`, over the `shielded_monitor` schema above. The service is
  built on Node's own `http` plus the `zod` this package already depends on — **no new runtime
  dependency** — and serves `POST /v1/monitors`, `GET /v1/monitors/:id`,
  `GET /v1/monitors/:id/matches`, `POST /v1/monitors/:id/{pause,resume,revoke}`,
  `DELETE /v1/monitors/:id` and `GET /v1/health`. Matches page by an opaque base64url cursor
  bound to its monitor; every status and matches response carries the coverage object
  (`requestedStart`, `scannedFrom`, `scannedThrough`, `sourceTip`) as decimal strings, so an
  unscanned range is never presented as an empty result. The reference client registers a key
  read from a file, polls with a cursor persisted atomically to a file, and drives the whole
  lifecycle over HTTP alone — it imports nothing but Node built-ins. Documented in
  `docs/shielded-monitor-api.md`; specified in `openspec/changes/00009-04-private-api-cli/`.
  Additive: no migration, no change under `src/`, and the published library surface is unchanged.
  **Unauthenticated by design:** this alpha has no authentication, authorization, tenant scoping,
  rate limiting or quotas (only a body-size and a page-size cap). It binds `127.0.0.1` by default
  and **the deployment must restrict network access** — anyone who can reach the port can
  register, read and delete any monitor. See `README.md` and `SECURITY.md` before exposing it.

- **A way to watch the shielded monitor work.** Three additive pieces, no new runtime dependency:
  - `GET /v1/monitors` — the list route. Every monitor except deleted ones, in creation order, each
    item in the same shape `GET /v1/monitors/:id` returns, page-capped by the existing
    `API_MAX_PAGE`, with the deployment's `sourceTip` and `net` at the top level. A **revoked**
    monitor is listed (with `state: "revoked"`) although its own reads still answer `410`; a
    **deleted** monitor never is. Backed by a new `PgShieldedMonitorStore.listAll(limit)`.
  - `GET /ui` — a dashboard served by the API process itself (`GET /ui/` the same, `GET /` a `302`).
    One self-contained HTML page: no framework, no bundler, no CDN, no font, no external resource
    of any kind, under `Content-Security-Policy: default-src 'self'` with SHA-256 hashes of its own
    inline script and style, `form-action 'none'` and `frame-ancestors 'none'`. It shows health and
    the archive tip, the monitor table with state badges and a coverage bar, a registration form,
    and the selected monitor's matches with cursor paging, refreshing every 3 s. A key typed into
    the form travels only in the `POST /v1/monitors` body — never a URL, never browser storage,
    never a log line. **It adds no authentication**: it is the same unauthenticated surface, and it
    says so above the fold.
  - `umbradb-shielded-monitor-derive-key` — derives the Bech32m viewing key and the shielded
    address's two public halves from a 32-byte seed **read from a file, never from `argv`**.
    `--hd` applies the wallet's own derivation, BIP-0032 `m/44'/2400'/<account>'/3/<index>` over
    secp256k1 (`shielded-monitor/hd.ts`, Node built-ins only), verified against BIP-0032's official
    test vector 1 and against three key vectors captured from `@midnightntwrk/wallet-sdk-hd@3.0.3`.
  Plus `docs/shielded-monitor-demo.md` (a full runbook on this repository's own Compose devnet) and
  `npm run demo:shielded-monitor` for its wallet-free half. Specified in
  `openspec/changes/00009-06-dashboard/`.

- **Match details: what was actually in the transaction.** A match used to be a height, a position
  and a hash. It now also carries the transaction's **public zswap data**, recorded by the scanner
  from the offers it already had in hand when it decided relevance — output commitments, spent
  nullifiers, transients, contract addresses on contract-owned entries — plus the block's
  timestamp, and a three-valued `mine` per output/transient. **Additive throughout:**
  - one migration, `src/postgres/migrations/shielded_monitor/002_association_details`, adding the
    **nullable** `associations.details jsonb` and `associations.block_timestamp_ms bigint` plus a
    partial index on the rows still missing details. Existing rows keep `NULL`, every pre-existing
    writer and reader is unaffected, and `NULL` means *not recorded yet*, never "no outputs".
  - the scanner writes them in the **same** `BEGIN…COMMIT` as the height's associations and its
    coverage advance (owner Rule B); the Rule B crash gate is strengthened to require it.
  - `GET /v1/monitors/:id/matches` items gain `blockTimestampMs` (decimal string or `null`) and
    `details` (object or `null`); `?details=0` omits both and reproduces the previous item exactly.
  - the dashboard's match rows expand into per-segment output / input / transient tables with
    click-to-copy hashes and a legend, and show a "run the backfill" placeholder for older matches.
  - `umbradb-shielded-monitor --backfill-details` (or `SCAN_BACKFILL_DETAILS=1`) fills older
    matches, reading blocks only through the archive read contract and writing only the two new
    columns. Idempotent by predicate (`AND details IS NULL`), epoch-fenced, and it skips rather
    than guesses when a row cannot be tied to the block it names.

  `mine` is `true | false | null` because the ledger permits nothing stronger:
  `EncryptionSecretKey.test(offer)` is an `any()` over all of an offer's ciphertexts, and
  isolating one proven output into its own offer is refused by the vendored ledger v8 build. Every
  value the service reports is entailed — `false` for every entry of an unmatched segment and for
  contract-owned entries, `true` when a matched segment has exactly one candidate left, `null`
  otherwise with `mineAmong` saying how many. Amounts, balances and spend detection remain out of
  scope, and `appliedOutcome` is still always `"unknown"`. Specified in
  `openspec/changes/00009-07-match-details/`.

### Changed

- `umbradb-shielded-monitor-api` now reports the archive's **real** `sourceTip` when the archive
  is reachable from its database connection, instead of always `null`. The 00009-04 branch
  shipped the `SourceTipProvider` seam with the "reports nothing" implementation because the
  archive read contract lived on another branch; with the branches merged, leaving it unwired
  would have left every deployment unable to answer "am I caught up?" — the one question the
  coverage object exists for. The tip is read through the `ArchiveReadContract` interface only
  (two `SELECT`s, no schema knowledge, no write method in reach), so owner Rule B is unchanged;
  the wire shape is unchanged (the field was already always present and nullable). Set
  `SOURCE_TIP=off` for an API deployed with no archive access. The API's database role now needs
  `USAGE`/`SELECT` on the archive schema unless that switch is used.
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
