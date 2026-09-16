# Changelog

All notable changes to UmbraDB are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/). The stability guarantees that govern the
entries below are stated in [`docs/STABILITY.md`](docs/STABILITY.md).

## [Unreleased]

### Added

- **The archive records the chain's DUST parameters, so the node never deserializes a ledger state
  (00016).** New migration `010_dust_parameters` and table `chain_archive.dust_parameters`: three
  numeric columns plus a `reason` (`genesis` | `change` | `resume`), written by the replay-on ingest
  and by `npm run dust:backfill` from the `LedgerState` they already hold — one row at genesis, one
  per parameter change, and one at a resume point on an archive that gained the table late. The
  shielded-monitor node reads that row to construct its DUST mirror and to answer
  `GET /v1/dust/tip`, and `/internal/status.dust` now reports `parametersSource`
  (`chain` | `unknown` | `changed-at-<height>`), `parametersHeight` and the three values.

  **This replaces a start-up check that could hang a node for minutes.** The previous
  implementation read the newest replay checkpoint and called `LedgerState.deserialize` on it; on a
  preprod-sized archive that blob is 31 MB, the call is minutes of one synchronous WebAssembly
  invocation, and for the whole of it the node answered no HTTP request at all — not `/v1/health`,
  not the monitor-store routes — so a load balancer marked it unhealthy with nothing in the log to
  explain it. **Operators: `dust_reader` now needs `GRANT SELECT` on
  `chain_archive.dust_parameters`, and must NOT be granted `replay_checkpoints` or `chain_blobs`**
  — the optional stanza offering those has been removed from
  `docs/shielded-monitor-deployment.md`. An archive that records no row still works: the mirror
  falls back to the ledger's initial DUST parameters and says `parametersSource: "unknown"` rather
  than passing a default off as the chain's. A mid-chain parameter change makes the mirror rebuild
  from zero, because a `DustLocalState`'s parameters are fixed at construction in the WASM
  bindings; that is documented in `docs/shielded-monitor-node.md`.

- **The DUST mirror skips a snapshot that would cost more than replaying (00016).** New
  `DUST_STATE_SNAPSHOT_MAX_BYTES` (default 2 MiB): above it the node leaves the snapshot file alone
  and folds from `dust_events` instead, logging `snapshot skipped (N bytes > max): replaying from
  zero`. Measured on a preprod archive at 146 253 retained leaves, restoring a 13.5 MB snapshot took
  **639 s** of one synchronous WebAssembly call with the node answering nothing, against **154 s**
  to fold the same state out of PostgreSQL while staying responsive — `DustLocalState.deserialize`
  of a retained state grows faster than the file does. Snapshots are still written and are still the
  fast path on devnet and small chains. `/internal/status.dust` gains `startPath`
  (`snapshot` | `replay`) and `startMs` so an operator can see which regime a restart took, and a
  snapshot whose recorded DUST parameters disagree with the archive's is now refused the same way a
  wrong-`net` or wrong-ledger-build one already was.

- **A wallet builds its DUST state from the node in seconds (00016, step 3 of 3).** New
  `dust-sync-client/` and `npm run dust:sync`: from a DUST secret key and a balancer URL it
  produces a spend-ready `DustLocalState` whose two Merkle roots equal the node's at one mirror
  tip, in a handful of round trips instead of the wallet SDK's ~123-minute replay of every DUST
  event on the chain. It follows its own spend chains (one request per *generation* of a chain,
  not per spend), applies the collapsed Merkle updates the node cuts, inserts its own leaves in the
  gaps, and **throws rather than returning a state it cannot prove** — a wrong root means wrong
  Merkle paths, and a wallet would only discover that after paying for a proof.
  - The **DUST secret key never leaves the process**: it reaches two ledger calls (`dustNullifier`,
    `successorUtxo`) and is never serialized, logged or returned. The CLI refuses a seed file that
    is not mode 600. What the node sees is the wallet's nullifiers — the leak the owner accepted
    for this project — and its DUST public key.
  - The client uses **only the standard published `@midnight-ntwrk/ledger-v8` 8.1.0 surface**, so a
    real wallet can run it against the package it already ships: the three fork exports this
    repository vendors are the NODE's, and a test checks every ledger member the client touches
    against the published declaration file (committed at
    `dust-sync-client/test/published-ledger-v8-8.1.0.d.ts`).
  - `--sdk-wrapper` emits the JSON `DustWallet.restore` consumes, so a state built in seconds can
    be handed to the SDK. Its `offset` is the INDEXER's event id and defaults to `0` (replay
    history) rather than to our own numbering — too high an offset makes the SDK skip events.
  - `dust-sync-client/devnet/` scripts the whole golden environment (compose devnet, replay-on
    ingest, `dust_reader` role, monitor-node, balancer) and compares the client's state with the
    SDK's own field by field.

- **The monitor-node mirrors the chain's DUST trees and serves them (00016, step 2 of 3).** With
  `DUST_DATABASE_URL` set, `umbradb-shielded-monitor-node` folds `chain_archive.dust_events` into
  one key-less `DustLocalState` and answers five new routes —
  `GET /v1/dust/{tip,initial-utxos,generation,segments}` and `POST /v1/dust/lookup` — which the
  balancer forwards to a uniformly random healthy node. A wallet applies the returned collapsed
  Merkle updates, inserts its own leaves in the gaps and compares roots; the DUST secret key never
  leaves it. Unset, the module is off and those routes answer `503 DUST_DISABLED`; nothing else
  about the node changes. The mirror snapshots to `DUST_STATE_SNAPSHOT_DIR` and refuses a snapshot
  from another net or ledger build. `/internal/status` gains a `dust` block. Contracts in
  `docs/shielded-monitor-api.md`, operation in `docs/shielded-monitor-node.md`, the role SQL in
  `docs/shielded-monitor-deployment.md`.
  - **A deliberate, waived exception to "project B has no database".** This is the one directory
    (`shielded-monitor/node/dust/`) that opens a PostgreSQL connection, by the owner's decision of
    2026-09-15 (`spec/00016-dust-wallet-sync.md` §1). It is **read-only** — the role may read
    `dust_events` and `blocks` and nothing else — and the accepted consequence is that the database
    can see which nullifiers a wallet asks about. The node itself never logs, persists or returns
    them. The import guard now allow-lists exactly that directory and asserts both the two modules
    it may reach and the three files that may import it; the schema-name literal scan, the
    `*_PG` boot refusal and the three guards under `test/postgres/` are unchanged.

- **The ingest keeps the DUST ledger events it already computes (00016, step 1 of 3).** With
  `REPLAY_VALIDATION=1`, every `dustInitialUtxo` / `dustGenerationDtimeUpdate` /
  `dustSpendProcessed` event a block produces is written to the new `chain_archive.dust_events`
  (migration `009_dust_events`) **inside that block's own transaction**, with a dense per-net id in
  ledger execution order and the raw `Event.serialize()` bytes. Nothing else changes: it is a new
  table plus its indexes, and an archive that never runs replay validation simply keeps it empty.
  Why it exists: replaying preprod's ~1.49 M DUST events is what costs a wallet roughly two hours
  of sync today, once per wallet — and the ingest was computing those events and throwing them
  away. Written down once, they let a consumer fold the two DUST Merkle trees once and serve every
  wallet from them (`spec/00016-dust-wallet-sync.md`).
  Three details worth knowing before relying on the table. **Genesis is included**: replay installs
  the node's ready-made genesis state rather than executing block 0, but genesis is where the
  chain's DUST trees get leaves 0..N, so the ingest harvests those events by applying the genesis
  body to a throwaway blank state — which is exactly what the reference indexer does. **Density is
  tracked by a watermark**, `dust_capture:<net>`, advanced in the same transaction even for the
  many blocks that produce no DUST event at all; a height whose rows would leave a hole commits
  WITHOUT them and the ingest's status line turns to `dust=gap`, because a partially filled table
  would make a consumer build trees that look fine and are wrong. **With replay off** the CLI says
  once at start that the events are not captured, and the table stays empty.
  New CLI `umbradb-dust-backfill` (`npm run dust:backfill`) fills the table for an archive ingested
  before this change: a replay over blocks the archive already holds, reading each block's body and
  `System::Events` back from a **local** archive node, resuming from the newest replay checkpoint
  at or below the covered height, stopping at the sync watermark, and sharing the ingest's
  watermark so the two hand over with no gap at the seam.

- **The merged monitor-node: viewing keys live only in RAM (00009-09).** A new process,
  `umbradb-shielded-monitor-node`, is project B: it serves the public API and the `/ui` dashboard,
  runs both scan queues, and is the **sole custodian of every viewing key it is sent**. A key is
  decoded, validated, fingerprinted and handed to the ledger, and its byte buffers are zero-filled
  the instant the handle exists; from then on the only representation is a WASM handle, cleared on
  revoke, delete, a fenced drop and SIGTERM. **The database holds no key material at all** —
  registration sends a 32-byte SHA-256 fingerprint, which was already the monitor's identity.
  Migration `004_key_in_ram_and_gaps` relaxes the `monitors` CHECK to fingerprint-only, adds
  `monitor_gaps`, and **drops `monitors.key_serialized` and the `monitor_leases` table** (open
  point OP-4, decided 2026-09-13). That last step is the lineage's one non-additive migration and
  is deliberate: a column that once held plaintext viewing keys should not survive on the strength
  of a promise that nothing writes to it, and there is no deployment of this service to stage a
  retirement for.
  Scanning inverted with it: a block is read once, each transaction is deserialized **once for all
  keys**, and the whole block commits as ONE `advance-batch` — every held monitor's associations,
  coverage advance and gap rows in one transaction, with a fenced monitor reported in the response
  rather than failing the block. Queue B catches a newly registered key up to the live watermark
  (`sync-key`) and re-reads ranges that were missed (`back-sync`, committing through the new
  `fill-gap`, which never moves coverage).
  Coverage learned to have holes: a key's first live pass compares its recorded `scannedThrough`
  with the height being scanned, and a shortfall becomes a `monitor_gaps` row written in the same
  transaction as the coverage move, plus a queued back-sync. A monitor is complete when
  `scannedThrough == sourceTip` **and** its `gaps` list is empty; both the API and the dashboard
  show the list.
  The balancer now routes registrations: it computes the key's fingerprint from a Bech32m decode
  and a SHA-256 (**no ledger WASM**), verifies its hint with `GET /internal/holds`, fans out to
  every healthy node on a miss, and places an unheld key on the node with the fewest keys (ties
  broken by the shortest Queue B). It fills `heldBy`/`keyNeeded` on the monitor read routes from a
  fan-out, serves `GET /v1/monitors/<id>/holder`, and answers **404 to any client request under
  `/internal/`** without forwarding it. The registration body is never logged, at either end.

- **Project B as a distinct deployable, with no database of its own (00009-08).** A new A-side
  process `umbradb-storage-api` owns the single main PostgreSQL and serves two route families on
  one port: the archive read contract (`/v1/archive/*`, mounted from the same router
  `umbradb-archive-read-api` uses) and a **command-shaped monitor store** (`/v1/monitor-store/*`)
  in which one call is one database transaction — `POST …/advance` carries a height's
  associations, its coverage advance and the scanner's lease renewal in one body and one
  `BEGIN … COMMIT`, fenced by the monitor's epoch (409 on a stale one).
  The scanner, the private API and its dashboard, the details backfill and the new balancer are
  pure HTTP clients of it: they take `STORAGE_URL` and nothing else, hold no connection string,
  no schema name and no driver, and **refuse to start if any `*_PG` variable is present in their
  environment**. A transitive import guard fails the build if any module under
  `shielded-monitor/**` can reach `postgres`, `src/postgres/**` or the storage API by any chain of
  imports, static or dynamic.
  Also new: `umbradb-shielded-monitor-balancer` (uniform random upstream per request, health
  exclusion and reinstatement, one retry for GET only, never for POST, `X-Upstream` on every
  response), one image with six commands (`Dockerfile.shielded-monitor`), a 2×2 Compose overlay
  (2 scanners + 2 APIs + balancer + storage API over one database), `npm run
  demo:shielded-monitor -- --split`, and `docs/shielded-monitor-deployment.md`.

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

- **A replay-on ingest resuming from a checkpoint now says so, with the blob size, before it goes
  quiet (00016).** `chain-archive-sync` logs `resuming ledger replay from checkpoint at height H:
  deserializing N bytes — on a large archive this takes many minutes` before the
  `LedgerState.deserialize` call that both the ingest's own resume and `npm run dust:backfill`'s
  resume make, and `checkpoint deserialized in T s` after it. Measured on a preprod archive at
  height 375 199, that call held one core at 100 % for **more than 73 minutes without finishing** on
  a 52 882 323 B checkpoint — no block committed, the database connection idle, and previously not
  one line of output to distinguish it from a hang. The log lines do not make it faster: the cost is
  in the ledger's WebAssembly deserializer and is tracked as issue `00019`. Cold starts, which
  deserialize the small genesis snapshot, are unaffected and unchanged.

- **The vendored ledger is now `@midnight-ntwrk/ledger-v8@8.1.0-syshash.6`** (was `…syshash.4`),
  built from `acedward/midnight-ledger` branch `feat/00016-dust-collapsed-updates` at
  `2b579359d79d59486d63440f9de39b6441aae493`. It adds four exports the node's DUST mirror needs:
  `DustLocalState.collapsedCommitmentUpdate` / `collapsedGenerationUpdate`, the
  `commitmentTreeFirstFree` / `generatingTreeFirstFree` getters, and
  `replayRawEventsRetainingAll`. The former out-of-tree `SOURCE-ledger-state-root.patch` is gone:
  it is committed in the fork.
  - **Compatibility warning.** `LEDGER_STATE_VERSION` moves with it, so replay checkpoints written
    under `…syshash.1` through `…syshash.5` are **refused** on resume rather than silently
    misread — serialized ledger state is a ledger-internal encoding. Re-ingest, or start a fresh
    archive, if you hold checkpoints from an earlier build.

- **BREAKING (00009-09): `umbradb-shielded-monitor` (the scanner) and
  `umbradb-shielded-monitor-api` are REPLACED by `umbradb-shielded-monitor-node`.** Both bins and
  both image commands (`scanner`, `api`) are gone; the image's commands are now `node`,
  `balancer`, `derive-key`, `storage`, `archive-sync` and `client`, and the Compose overlay runs
  `shielded-monitor-node-1` / `-2`. The scanner-only environment variables go with them:
  `SCAN_INSTANCE_ID`, `SCAN_LEASE_TTL_MS`, `SCAN_CONCURRENCY`, `MAX_MONITORS`, `SCAN_MAX_BATCHES`,
  `SCAN_ONCE` and `SCAN_BACKFILL_DETAILS` (a node scans one block at a time for every key at once,
  so there is nothing to parallelise across monitors and no claim to own; the details backfill now
  runs inside the node that holds the key, because re-deriving details needs one).
- **BREAKING (00009-09, owner decision Q33): `pause`, `resume` and `revoke` are REMOVED — a
  monitor is registered or it is deleted.** `POST /v1/monitors/:id/pause`, `…/resume` and
  `…/revoke` are gone from the private API (a client still calling one gets the `404` any unknown
  path gets), from the reference CLI, from the dashboard and from the storage API's transition
  command. The `paused` and `revoked` STATES are gone with them: a monitor is `backfilling`,
  `live`, `failed`, `stale_source` or `deleted`, and the middle two are reached only by the
  system's own fail-closed detection, never by a request. `DELETE /v1/monitors/:id` now destroys
  the registration identity, every association, every gap row and every scan fact in one
  transaction, and the key held for it is destroyed in its node's RAM — the balancer forwards the
  delete to the holder, and the holder's next block would fence it anyway. Giving the same key
  again mints a FRESH monitor. Migration 001's `state` CHECK still admits the two removed literals
  and is deliberately not rewritten; no code path can produce one.
  `MONITOR_REVOKED` (410) disappears from both error catalogues, and FR-024's restore mechanism
  becomes a **deletion list**: `export-deletions` / `apply-deletions` on the harness, file version
  2, re-applying a delete rather than a revoke (`docs/shielded-monitor-restore.md`).
- **BREAKING (00009-09, owner decision Q29): the 00009-07 details backfill is REMOVED.** Filling a
  match's `details` needs the viewing key, which since this phase exists only in a node's RAM;
  rather than carry a repair tool for a service nobody is running, the command, its store methods
  (`readAssociationsMissingDetails`, `updateAssociationDetails`), its storage-API routes and its
  suite are deleted. The `details` column and the live path that writes it are untouched; a match
  recorded by an older build keeps `details: null` forever.
- **BREAKING (00009-09): four storage-API routes answer `410 Gone`.**
  `GET /v1/monitor-store/monitors/<id>/key-material` (the database holds no key material),
  `GET …/lease`, `POST /v1/monitor-store/leases/claim` and `POST …/leases/release` (there are no
  leases). `POST /v1/monitor-store/monitors` takes `fingerprint` instead of `keySerialized` and
  refuses anything that is not 32 bytes.
- **BREAKING (00009-09), operationally: every viewing key must be re-sent after the upgrade.**
  The keys that were in `monitors.key_serialized` are not loaded from it, so every existing
  monitor reports `"keyNeeded": true` until its client registers the key again. The re-send is
  idempotent, reaches the same monitor (the fingerprint is unchanged), and resumes from the
  recorded coverage — it does not rescan history. Coverage, associations and lifecycle rows are
  untouched by the migration. Full steps in `docs/shielded-monitor-deployment.md`
  ("Migrating from the 00009-08 deployment").
- The monitor view gains `gaps`, `heldBy` and `keyNeeded`. `heldBy`/`keyNeeded` describe
  **custody**, which is a different fact from `state`: a monitor can be `live` and yet have nobody
  holding its key, which is exactly what a node restart leaves behind.

- **BREAKING (alpha deployment shape, 00009-08): `umbradb-shielded-monitor` and
  `umbradb-shielded-monitor-api` no longer take a database connection.** `MONITOR_PG`,
  `SHIELDED_MONITOR_PG`, `SHIELDED_MONITOR_SCHEMA`, `ARCHIVE_SCHEMA` and
  `SHIELDED_MONITOR_BOOTSTRAP` are gone from those two processes, which now require `STORAGE_URL`
  and refuse to start while any `*_PG` variable is set. Nothing in the database changes — same
  schema, same rows, same lineage; the migration is `docs/shielded-monitor-deployment.md`
  ("Migrating from the single-host deployment"), and it is three environment edits plus one new
  service. The in-process single-host mode this repository shipped before 00009-08 is removed
  deliberately (owner decision Q25): project B must have no database connection at all, so that
  the boundary it crosses is the one a TEE step can attest and encrypt.


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
- The runtime ledger is a checksummed vendored `8.1.0-syshash.6` build; its provenance and minimal
  source patches are committed under `vendor/ledger-v8-syshash/`.

### Fixed

- **A deleted monitor's key is destroyed on its holder immediately (00009-09).** The live run
  found that nothing in the deployment told a node about a lifecycle change: the node's
  `POST /internal/events` handler existed and had no caller. The balancer now posts a best-effort
  `{"type":"stateChanged","monitorId":…}` to the node it believes holds the monitor (or to every
  healthy node when it has no hint) after a 2xx `DELETE` — fire-and-forget, sent after the client's
  response, unable to change it — so the WASM handle is cleared in milliseconds rather than at the
  holder's next block. The `not-found` fence on that next block remains the backstop, and is what
  makes the guarantee independent of a best-effort message.
- **`fill-gap` is idempotent, and a stuck gap heals itself (00009-09).** A back-sync re-reads a
  range the coverage number already claims, which is the one write path with no `scanned_through <
  height` fence to protect it from a replay. When the range held a match that was already recorded
  — after a moment of double custody, or an operator's coverage repair — the fill died on
  `associations_observation_key`, the storage API answered 500, the job was dropped and the
  `monitor_gaps` row stayed forever with nothing scheduled to retry it. The insert is now
  `ON CONFLICT … DO NOTHING` and `written` counts the rows that really landed, and a node queues a
  back-sync for every gap still in a monitor's record whenever it finishes syncing that key. One
  consequence, documented in the cursor contract: association sequence numbers are **monotonic but
  no longer dense** — a skipped row's number is allocated and unused. `seq` is a cursor, not a
  count, and nothing derives a match total from it.

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
