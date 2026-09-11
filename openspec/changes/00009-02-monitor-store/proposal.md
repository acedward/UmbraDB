# Proposal — 00009-02: shielded monitor store, key intake and lifecycle (project B core)

> Organizer spec: `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
> (approved 2026-09-10). Organizer sub-plan: `plans/00009-02-monitor-store.md`.
> This change implements **Phase 2 only**: the store. The scanner (Phase 3) and the private
> HTTP API (Phase 4) are separate changes and are explicitly out of scope here.

## Why this change exists

PR #1 (`feat/indexer-independent-ingest`) gave this repository project **A**: node-only
finalized ingestion into the position-keyed `chain_archive` schema, with raw ledger bytes per
transaction and atomic per-block commits. It has no viewing-key handling, no monitor table, no
association table and no notion of per-wallet scan coverage — so there is nothing a wallet can
register with and nothing that can remember how far a scan got.

Project **B** ("wallet data store availability", proposal step 2) needs a storage layer with
three properties before any scanning code can be written safely:

1. **A validated key intake.** A Midnight shielded viewing key arrives Bech32m-encoded with a
   network-bound HRP. Accepting one that is malformed, or that belongs to another network, would
   silently produce a monitor that can never match anything. The reference indexer validates by
   decoding the HRP and then deserializing the payload with the ledger
   (`indexer-api/src/infra/api/v4/viewing_key.rs:39-48`); we reproduce exactly that, against the
   ledger v8 WASM this repository already vendors.
2. **A fenced lifecycle.** Pause, resume, revoke and delete must be able to stop a scanner worker
   that is already mid-batch. Without a fence, a worker holding a stale view commits associations
   into a monitor its owner has just revoked. The fence is a monotone `epoch` on the monitor row,
   checked inside the same `UPDATE` that advances coverage.
3. **A schema of its own.** Owner Rule B: B never writes to an archive table, and everything B
   writes for one block height — the associations of that height and the coverage advance to it —
   commits in one `BEGIN … COMMIT`. That is what makes B restorable on its own and what keeps the
   later TEE split possible.

Delivering the store first, with a trusted harness instead of an API, means the fencing and
lifecycle semantics are testable and reviewable before a scanner or an HTTP surface exists to
confuse the review.

## What this change delivers

- A new PostgreSQL schema `shielded_monitor` with its own additive migration lineage
  (`src/postgres/migrations/shielded_monitor/`), independent of both `tier1_wallet` and
  `chain_archive`, applied through the existing `runMigrations` runner via a
  `bootstrapShieldedMonitorSchema()` entry point — the same shape `chain-archive-sync/bootstrap.ts`
  already uses for Tier-1.5.
- A new top-level module `shielded-monitor/` holding a Bech32m codec, key intake, the fingerprint
  function, the lifecycle state machine, the PostgreSQL store and a trusted operator harness. It
  observes the same discipline as `chain-archive-sync/`: nothing under `src/` imports it, enforced
  by a committed guard test.
- Plaintext key storage with a domain-separated SHA-256 fingerprint that makes registration
  idempotent per `(network, key)`.
- `advance(monitorId, epoch, throughHeight, associations)` — one transaction, epoch-fenced,
  covering the associations of the advanced heights and the coverage advance together.
- A documented backup/restore procedure with a revocation list kept outside the snapshot's
  rollback domain, plus the code that exports and re-applies it.

## What this change explicitly does NOT cover (non-goals)

- **No scanner.** Nothing in this change reads the archive, decodes a transaction, or evaluates
  `EncryptionSecretKey.test(offer)` against an archived offer. Relevance matching is Phase 3
  (`00009-03`). The store is exercised by a trusted harness that supplies associations directly.
- **No HTTP API and no authentication.** Phase 4 (`00009-04`). Nothing here binds a port.
- **No import of the Phase 1 archive read contract.** Archive identity is stored as two opaque
  caller-supplied strings (`source_genesis_hash`, `source_instance_id`); this module has no
  knowledge of how the archive computes them and no compile-time dependency on
  `00009-01`.
- **No encryption at rest, no key wrapping, no KEK rotation, no keyed fingerprints, no
  least-privilege role script, no tenant concept.** All deferred with User Story 4 by owner
  decision on 2026-09-10. The alpha is single-consumer and operator-trusted: anyone with database
  access can read a registered viewing key. This is stated in `SECURITY.md` and in the restore
  document, not left implicit.
- **No ledger v9 lane.** Owner decision Q1: this project is ledger v8 only, using the build PR #1
  already vendors (`vendor/ledger-v8-syshash`).
- **No PGlite.** Owner decision Q6: PostgreSQL 17 via Testcontainers/Compose is the only tier.
- **No change to any existing `chain_archive` or `tier1_wallet` table, migration or gate.** The
  migration lineage is new and additive; no existing lineage is edited.

## Impact

- Additive only. A deployment that never calls `bootstrapShieldedMonitorSchema()` is byte-for-byte
  unaffected: no existing migration, table, interface or exported symbol changes.
- `tsconfig.json`'s `include` gains `shielded-monitor/**/*.ts` so the new module is typechecked;
  `tsconfig.build.json` and `tsconfig.cli.json` are untouched, so the published package surface
  does not change.
- `test/integration/required-tests.manifest.json` gains three required ids (fencing, restore,
  schema isolation) and `EXPECTED_REQUIRED_COUNT` is bumped accordingly — the gate is
  strengthened, never relaxed.
