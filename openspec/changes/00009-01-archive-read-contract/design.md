# Design — 00009-01: archive read contract, block timestamp, per-height atomic commit

Read `proposal.md` first: it says why this exists and what it deliberately does not do. This
document records the decisions and the reasoning that is not obvious from the code, and cites the
prior art it has to stay consistent with.

## Prior art this is bound by

- **`design/design.md` §5 (Commit/transaction layer)** — this repo's rule that a caller-visible
  operation's atomicity is a property of ONE database transaction, not of a retry protocol layered
  above it. The Rule A fold below is that rule applied to the archive's per-height write; the
  previous three-transaction shape satisfied §5 for each of its three parts and for none of the
  whole.
- **`design/design.md` §4 (Watermarks)** — a watermark is a last-write-wins cursor with no history.
  The fold does not change that; it changes WHEN the cursor is written (inside the height's own
  transaction) and nothing about what it means.
- **`design/design-interfaces.md` §1 (Shared Conventions)** and **§3 (Module Interfaces)** — the
  interface/implementation split: `src/interfaces/*` declares a contract with no driver import and
  no SQL; `src/postgres/*` implements exactly one; nothing under `src/` imports
  `chain-archive-sync/`. `ArchiveReadContract` + `PgArchiveReadContract` follow it exactly, and the
  existing guard test (`test/postgres/no-chain-sync-import-guard.test.ts`) covers them for free
  because it scans all of `src/`.
- **`design/design-interfaces.md` §2 (`storage-errors.ts`)** — every typed error extends
  `StorageError` with a stable `code` and a `Retryability`. `ArchiveDiscontinuityError` does, and
  is deliberately NOT added to the frozen 1.0.0 catalog (the chain-archive track is excluded from
  the public barrel; `test/api-surface/excluded-not-exported.test.ts` pins that).
- **`design/full-chain-storage-design.md` §4.1 / §4.2 / §5** — the metadata/blob split, the block
  TREE (not just the canonical chain), and the archive's own watermark table. The read contract
  projects the canonical finalized path out of that tree; it does not introduce a second model.
- **`Formal/STORAGE_ALGEBRA.md` §3 (Watermarks — trivial last-write-wins)** — the monotonic guard
  the folded watermark write keeps. §5 (testable-law deliverable) is the shape the property test
  follows: laws stated over random inputs, checked with fast-check.
- **`Formal/STORAGE_ALGEBRA.md` §6 (On not adding a Merkle/authenticated data structure)** — why
  `readBlocksSince` verifies content addresses (a rehash of what it returns) but does NOT attempt
  to prove the archive's history is authentic. Integrity here means "these bytes are the bytes
  this archive stored", not "this archive holds the real chain"; the second claim needs the
  authenticated structure §6 argues against for now.

## Decision 1 — a separate read interface, not more methods on `ChainArchiveStore`

`ChainArchiveStore` is the writer's contract. Adding `readBlocksSince` to it would mean handing a
scanner an object that also has `putBlockBundle` and `setCanonical` on it.

The spec makes B's read-only access to A a REQUIREMENT (FR-025), and a requirement that is only a
convention is one that gets violated during a debugging session. A separate interface makes it
structural: a consumer typed against `ArchiveReadContract` cannot write, and the write-set audit
US5 scenario 4 asks for has one object to point at.

The second reason is the TEE path (US7). Because B depends only on this interface, an RPC
implementation can serve it to a B running in another process without giving B schema access. Every
type in the file is therefore plain data — no handles, no lazily-loaded fields, no cursor that is
secretly a database object. `rawBytes` being materialised eagerly (rather than a `getBytes()`
callback) is part of that: a callback could not cross a process boundary.

## Decision 2 — the page unit is a whole block height, and only ever that

`maxBlocks` counts blocks. A block with several hundred transactions is a one-block page.

The reason is not ergonomics. Rule A makes a block height the archive's write unit; Rule B makes a
block height the scanner's commit unit. If a page could split a block, the scanner would have to
invent a sub-block commit unit, and a crash inside one would leave a height half-scanned with no
way to record that fact — the exact class of partial state both rules exist to remove.

`afterHeight` is EXCLUSIVE and `-1` means "from genesis", so the resume argument is always "the
last height I actually saw" and never needs an off-by-one adjustment at the call site. Consumers
must resume from the last RETURNED height rather than `afterHeight + blocks.length`, because the
first block of a page need not be `afterHeight + 1` (an archive whose earliest retained height is
above the reader's start is legitimate and visible — `spec/00009`'s "start height below retained
history" edge case).

## Decision 3 — one snapshot per page, and it includes `sourceTip`

The page and the tip are read inside one `REPEATABLE READ, READ ONLY` transaction.

Without it, a height committed between the two reads makes `sourceTip` lower than a block already
returned, and a consumer comparing its coverage against the tip concludes it is ahead of the
archive. FR-011 and FR-020 require "unscanned" and "scanned, empty" to stay distinguishable, and
they are only distinguishable if the tip is a fact about the same snapshot as the blocks.

`READ ONLY` on the transaction is belt-and-braces for Decision 1: the class cannot write, and now
the database will not let it.

Rule A is what makes the snapshot sufficient. A snapshot cannot straddle a partially written
height, because there is no such thing.

## Decision 4 — a discontinuity is refused, not returned

Consecutive blocks within a page must be parent-linked; if they are not, `readBlocksSince` throws
`ArchiveDiscontinuityError`.

The alternative — return the rows as found — produces a sequence that LOOKS contiguous (heights
ascend, every block is whole) while silently omitting history. A scanner would then record coverage
over a range it never saw, and nothing downstream could detect it. The archive's own writer cannot
produce this state (it ingests `watermark + 1` under a parent-continuity check), so the state means
the archive was assembled or damaged by something else, and refusing is the only honest answer.

Only WITHIN a page: the first block of a page is not compared with the page before it, because a
reader legitimately starts below the archive's earliest retained height, and inventing a failure
there would break retention rather than detect corruption.

## Decision 5 — the identity is "all of it or none of it"

`getArchiveIdentity` returns `undefined` until BOTH the instance id has been minted AND block 0 is
archived. There is no partially-known identity.

A consumer binds to the identity once and compares it forever after (FR-013). If it could bind to
`{net, archiveInstanceId}` with the genesis hash still unknown, the later arrival of the genesis
hash would look identical to the archive having changed. Returning `undefined` for "not ready" costs
the consumer one poll and removes that state entirely.

The instance id is minted with `INSERT ... ON CONFLICT DO NOTHING` followed by a read-back, so the
FIRST writer wins and every later caller — including a concurrent bootstrap in another process —
observes that same value. It deliberately does not go through `setWatermark`, whose last-write-wins
behaviour for non-`{height}` values would let a second bootstrap silently replace an identity that
consumers have already bound to. A malformed identity row is refused rather than overwritten, for
the same reason.

## Decision 6 — the Rule A fold, and why the FK no longer forces a second transaction

`putBlockBundle` now also writes, inside its one transaction: the replay checkpoint when due, the
sync watermark, and a transactional `NOTIFY`.

The previous split was not arbitrary. `replay_checkpoints` has a real foreign key to `blocks` — a
checkpoint describes a block, so it must not outlive one — and the old code's checkpoint write ran
at replay-gating time, BEFORE the block row existed. Writing it there violated the FK, which is
what the original implementation discovered. Inside one transaction the block row is inserted
first and is visible to the checkpoint insert's own FK check (ordinary same-transaction MVCC
visibility, the same mechanism the transactions/observations inserts already relied on), so the
constraint that forced the split no longer does.

Three properties are preserved deliberately:

- **The monotonic watermark guard.** It lives in the statement, not the method, so the standalone
  `setWatermark` and the folded write share one helper and cannot drift apart.
- **Idempotent retry.** Every insert keeps its `ON CONFLICT DO NOTHING`. Re-ingesting a
  byte-identical height is still a silent no-op.
- **`ON CONFLICT DO NOTHING` on `blocks`, unchanged.** A re-ingest therefore does NOT retro-fill a
  `NULL` timestamp on an already-archived row. Filling those in is the backfill's job, explicitly,
  rather than a side effect of a retry.

A bundled checkpoint that names a different block is refused before anything is written. Inside one
transaction there is no later step at which the mismatch could still be caught, and a checkpoint
resumed against the wrong block produces silent, permanent divergence rather than an error.

## Decision 7 — `blocks.timestamp_ms` is nullable, and `NULL` means "not decoded"

Migration 005 made `replay_checkpoints.block_timestamp_ms` NOT NULL and deleted the existing rows.
This migration does the opposite, and the difference is not inconsistency:

- a checkpoint without a timestamp is unusable, and every pre-existing row was already unusable for
  an unrelated reason, so deleting them cost nothing;
- a BLOCK without a timestamp is perfectly usable for everything the archive already does. Deleting
  such rows to satisfy a new column would destroy real history, and inventing a value would be the
  guess the column exists to avoid.

Ingest fills the column where the runtime metadata is ALREADY resolved — node-only mode and
replay-validation mode. Indexer-sourced ingest without replay validation deliberately resolves no
metadata at all (that is what lets it work against a pruned node), so fetching metadata just to
fill one column would silently change that mode's node requirements. It writes `NULL`, and the
offline backfill fills those rows in later.

## Decision 8 — the backfill is offline, and never guesses

`chain-archive-sync/backfill-block-timestamps.ts` reads only the archive: the body blob (the JSON
extrinsic list the sync writer stored), the header blob (for the MNSV protocol version), and either
the archive's own `runtime_metadata` capture for the runtime in force at that height or this repo's
committed capture registry.

Offline is a requirement, not a convenience: runtime metadata derives from historical state, so a
node that has pruned that state cannot re-serve it — and those are exactly the archives most likely
to hold pre-008 rows.

A block whose timestamp cannot be decoded is reported, not filled with a substitute and not
silently skipped, and the CLI exits non-zero when any remain. Every write carries
`AND timestamp_ms IS NULL`, so the backfill can run concurrently with ingest and can be re-run
freely.

## Decision 9 — `transactions.result` for regular transactions only

The verdict `LedgerReplay.applyBlock` already computes was being discarded. Persisting it needs a
mapping, because the archive's ROW order is reference-compatible (event-borne system transactions
first) while replay applies transactions in Substrate execution order, and a direct system
extrinsic yields two archive rows against one execution entry.

The two orders agree exactly on one subsequence: the REGULAR transactions, which in both cases are
"this block's Midnight regular calls, in body order". So the correspondence is taken there,
positionally, and then verified byte-for-byte; any disagreement leaves the entire block's `result`
NULL. A system transaction's outcome (`system_applied`) is not one of the three values the column's
CHECK admits anyway, so nothing is lost by excluding it that could have been stored.

Recorded as question Q12 in the project's questions file, with the alternatives, because the choice
is visible in the data and an owner may want the wider version later (which would need a migration
widening the CHECK — not an additive change).

## Decision 10 — `NOTIFY` is an optimisation with no contract

`pg_notify` is issued inside the height's transaction, so it is delivered if and only if the height
commits. Nothing in this repo depends on receiving it: notifications are not queued for a listener
that is not connected, so a consumer that misses one finds the height on its next poll. Polling
remains the contract, and the wake-up hook only removes latency.

## Testing strategy, and why the crash test is shaped the way it is

`test/integration/crash/archive-height-atomicity.crash.test.ts` proves Rule A. It follows the
repo's crash discipline (`test/integration/crash/crash-worker.ts`): the fault is a pause at a NAMED
PROGRAM POINT between real operations, never a timer, and no fault code lives in `src/`. For a call
that issues ~10-30 statements inside one transaction, the named program points ARE its statements,
so the instrumentation is a proxy around the driver handle that counts them
(`archive-fault-injection.ts`) — the store is unchanged and unaware.

Two lanes, sharing that instrumentation so a statement index means the same thing in both:

- a PostgreSQL-kill lane (in-process, hundreds of randomized points) — a backend can be terminated
  many times in one process, so this lane carries the volume;
- a process-SIGKILL lane (a real child process, real signal, named points) — including the point
  immediately AFTER the commit returned, which is what proves the other half of the rule: what
  survives is the whole height, watermark included.

The kill uses the repo's own `pgTerminateBackend`, which waits for the backend to actually die
rather than merely delivering the signal. Without that wait, "kill before statement N" degrades to
"kill somewhere after N" and the crash point stops being a named program point.

The suite also carries a negative control that reconstructs the PRE-FOLD three-transaction shape and
asserts a partial height IS observable in it. Without that control, the two-state result would be
consistent with assertions that cannot fail.
