# Proposal — 00009-01: archive read contract, block timestamp, per-height atomic commit

## Why this change exists

A second process is about to read this archive. Project 00009 ("wallet data store availability")
adds a shielded-monitor service that registers a viewing key, scans archived finalized history for
relevant transactions, and stores associations in a schema of its own. That scanner needs three
things from the archive that PR #1 does not provide, and it needs them before any of it can be
written.

**1. There is no call that answers "everything after height H, in order."** PR #1 can return the
blocks at a height (`getBlocksAtHeight`), a canonical range of block HEADERS
(`getCanonicalChainRange`), and the transactions of one block by hash
(`getTransactionsForBlock`) — plus a `chain_blobs` fetch per transaction to get its bytes. A
scanner would have to stitch those together, invent its own paging, and re-derive the ordering
rules on every restart. Worse, it would be doing so against `ChainArchiveStore`, the WRITER's
interface, which also exposes `putBlockBundle`: a consumer that is supposed to be read-only would
be holding the write surface.

**2. The archive cannot say who it is.** Drop the archive, re-sync the same chain, and the new
database is indistinguishable from the old one — same network, same genesis, a lower tip. A
consumer with persisted coverage ("I have scanned through height 900") reads that lower tip as its
own archive having gone backwards, and carries on. Nothing anywhere says the history underneath it
was replaced.

**3. A block's time is not stored.** It lives in the block BODY, as the `Timestamp::set` inherent,
recoverable only by decoding the body against the runtime metadata of the block that produced it.
Every consumer would repeat that work, carry a metadata resolver, and — on a pruned node — fail.

Separately, and independently of the scanner, the owner set a rule for this project
(`spec/00009` User Story 5, Rule A):

> Everything the archive writes for a block height happens inside one `BEGIN … COMMIT`. A crash
> leaves either nothing of that height or all of it, and recovery is "continue from the last
> committed height."

PR #1 does not satisfy it. `putBlockBundle` commits the block, its transactions and its
observations atomically — but `chain-archive-sync/sync-service.ts` then writes the replay
checkpoint in a second transaction and the sync watermark in a third. Both intermediate states are
durably observable after a crash. Neither is unsafe (the retry is idempotent), but "safe" is not
the property the owner asked for: the rule is that there are exactly two states, so recovery needs
no reasoning at all.

## What this change delivers

1. **`ArchiveReadContract`** (`src/interfaces/archive-read-contract.ts`) — `readBlocksSince(net,
   afterHeight, maxBlocks)` returning whole blocks in height order with their transactions in
   position order and raw bytes hash-verified, plus `getArchiveIdentity(net)`. No SQL type, blob
   hash, canonical flag or driver type appears in it.
2. **`PgArchiveReadContract`** (`src/postgres/archive-read-contract.ts`) — the in-process
   PostgreSQL implementation: read-only, one `REPEATABLE READ` snapshot per page, three queries
   per page rather than N+1, fail-closed on a discontinuity in canonical history.
3. **Migration 008** — additive, nullable `blocks.timestamp_ms`, written by ingest where the
   runtime metadata is already resolved, and filled in for older rows by an offline backfill.
4. **Rule A fold** — `putBlockBundle` additionally commits the replay checkpoint (when due), the
   sync watermark (monotonic guard intact) and a transactional `NOTIFY`, all inside the one
   per-height transaction. The sync service's two extra transactions are gone.
5. **Archive identity** — `ensureArchiveInstanceId(net)` mints 128 random bits once per archive
   database per net, at bootstrap, first-writer-wins.
6. **Replay outcome persistence** — `transactions.result` is now written for regular transactions
   when replay validation is on. It was never written before, in either mode.
7. **`shielded-monitor/offers.ts`** — offer extraction and viewing-key deserialization over the
   vendored ledger v8 build, with a typed refusal for unsupported protocol versions. The one place
   project B touches the ledger.

## Non-goals

Explicitly NOT in this change:

- **No ledger v9 / Midnight 2.x support.** Owner decision (project 00009, Q1): this project uses
  the vendored ledger v8 build PR #1 already pins. No second ledger module, no adapter layer, no
  new dependency. A protocol version outside v8's ranges is refused, not decoded.
- **No monitor, association, coverage or lifecycle storage.** That is 00009-02's `shielded_monitor`
  schema. Nothing here knows what a viewing key is used for.
- **No scanner and no relevance predicate.** `offers.ts` hands back offers; deciding what is
  relevant, and recording it, is 00009-03.
- **No HTTP API, no authentication, no tenant concept.** That is 00009-04.
- **No change to WHAT is ingested.** No new data source, no new decoded category, no change to
  which blocks or transactions are archived. Every row this change writes was already being
  written, except `blocks.timestamp_ms` (new column) and `transactions.result` (existing column,
  never populated until now).
- **No reorg or non-finalized support.** The read contract returns canonical FINALIZED blocks
  only, as PR #1's writer produces them. Serving a not-yet-final tip would mean retractable pages.
- **No encryption at rest, redaction gate or tenant isolation.** Deferred with User Story 4 by the
  owner.
- **No RPC implementation of the read contract.** The interface is shaped so one can be added
  (that is the point of it being an interface), but this change ships only the in-process
  PostgreSQL implementation.
- **No PGlite / driver seam.** Owner decision (Q6).

## Breaking-change assessment: none

Every schema change is additive and every interface change is optional:

| Change | Shape | Effect on an existing deployment |
|---|---|---|
| `blocks.timestamp_ms` (migration 008) | new nullable column, non-negative CHECK | none; existing rows read `NULL` |
| `BlockBundle.replayCheckpoint` / `.watermark` / `.notifyChannel` | new OPTIONAL fields | omitting them reproduces the previous behaviour exactly |
| `BlockRecord.timestampMs` / `BlockMeta.timestampMs` | new optional field | `undefined` writes `NULL` |
| `ChainArchiveStore.ensureArchiveInstanceId` | new method | new row in the existing `watermarks` table under its own key |
| `transactions.result` now written for regular transactions under replay validation | existing nullable column | `NULL` remains legal and is still what indexer-sourced ingest without replay validation writes |
| `ArchiveReadContract` / `PgArchiveReadContract` | new files | nothing imports them yet outside tests |

No column is dropped, renamed, retyped or made NOT NULL; no constraint is tightened on existing
data; no row is deleted or rewritten by a migration. The 1.0.0 public barrel (`src/index.ts`) is
untouched — the chain-archive track is not part of the frozen surface.

## Prior art this builds on, and does not contradict

- `design/full-chain-storage-design.md` §4.1 (metadata/blob split), §4.2 (the block tree), §5
  (the archive's own watermark table) — the read contract re-packages these reads; it does not
  introduce a second model of the archive.
- `design/design-interfaces.md` — the interface/implementation split this repo already uses
  (`src/interfaces/*` declares, `src/postgres/*` implements, nothing in `src/` imports
  `chain-archive-sync/`). The new pair follows it exactly.
- `Formal/STORAGE_ALGEBRA.md` — the read contract's laws are stated in `design.md` in the same
  vocabulary (paging is a partition of a totally ordered sequence; identity is stable under
  re-read and distinct under re-bootstrap).
