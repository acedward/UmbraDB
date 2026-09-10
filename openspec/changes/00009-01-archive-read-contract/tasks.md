# Tasks — 00009-01: archive read contract, block timestamp, per-height atomic commit

Every task states what must PASS, not just what must be written. A task is done when the named
command succeeds against a real PostgreSQL 17 (Testcontainers), not when the code exists.

## 1. `ArchiveReadContract` (the interface)

**Do**: declare `src/interfaces/archive-read-contract.ts` — `readBlocksSince(net, afterHeight,
maxBlocks)`, `getArchiveIdentity(net)`, the plain-data record types, and
`ArchiveDiscontinuityError` extending `StorageError`.

**Acceptance**:
- `npm run typecheck` passes.
- The file imports nothing from `postgres`, nothing from `src/postgres/*`, and nothing from
  `chain-archive-sync/*`; no blob hash, canonical flag or row type appears in any exported type.
  Enforced by the existing `test/postgres/no-chain-sync-import-guard.test.ts` (it scans every file
  under `src/`) plus review of the type surface.
- `test/api-surface/excluded-not-exported.test.ts` still passes: nothing new is exported from the
  frozen 1.0.0 barrel.

## 2. `PgArchiveReadContract` (the PostgreSQL implementation)

**Do**: `src/postgres/archive-read-contract.ts` — one `REPEATABLE READ, READ ONLY` transaction per
call; three queries per page (blocks, their transactions, their blobs); rehash every payload;
refuse a discontinuity; validate paging arguments.

**Acceptance** — `npx vitest run test/postgres/archive-read-contract.property.test.ts` passes,
covering:
- **P-ARC-1** (property, fast-check): for random archive shapes — empty blocks, multi-transaction
  blocks, duplicate transaction hashes at different positions — and any `maxBlocks`, the
  concatenation of pages equals `getCanonicalChainRange` + `getTransactionsForBlock` +
  `getBlob` exactly, block for block and byte for byte; every block carries its FULL transaction
  set; only the last page may be short.
- **P-ARC-2**: paging resumed from a remembered height on a NEW client equals the uninterrupted
  paging of the same archive — no gap, no repeat.
- **P-ARC-3**: `sourceTip` names the archive's tip; a reader at the tip gets an empty page WITH the
  tip still reported; a start height above the tip is not an error.
- **P-ARC-4**: an unknown net yields `{blocks: [], sourceTip: undefined}`, not an error.
- **P-ARC-5**: non-finalized and orphaned rows never appear.
- **P-ARC-6 / P-ARC-6b**: a hole in canonical history, and a broken parent link at consecutive
  heights, both throw `ArchiveDiscontinuityError`.
- **P-ARC-7**: `maxBlocks < 1`, `afterHeight < -1` and non-integers throw `ValidationError`.
- **P-ARC-9**: a payload corrupted out of band is refused on read.

## 3. Migration 008 — `blocks.timestamp_ms`

**Do**: `src/postgres/migrations/chain_archive/008_block_timestamp.ts`, additive and nullable, with
a non-negative CHECK; register it in the lineage index.

**Acceptance** — `npx vitest run test/postgres/chain-archive-migrate.test.ts` passes with:
- the applied-migration list ending `…, "007_blob_role_guard_forward_fix", "008_block_timestamp"`;
- `information_schema.columns` reporting `timestamp_ms` as `bigint`, `is_nullable = YES`;
- EVERY partition of the range-partitioned `blocks` parent carrying the column (a column added to
  the parent only would leave ingest writing into partitions that lack it);
- the existing idempotent-re-run assertion unchanged (a second `runMigrations` applies nothing).

## 4. Rule A fold — one height, one transaction

**Do**: extend `BlockBundle` with optional `replayCheckpoint`, `watermark` and `notifyChannel`;
write them inside `putBlockBundle`'s existing transaction after the block row; share the watermark
statement with `setWatermark`; refuse a checkpoint that names another block; replace the sync
service's two post-bundle transactions with bundle arguments.

**Acceptance** — `npx vitest run test/integration/crash/archive-height-atomicity.crash.test.ts`
passes, covering:
- **`crash.archive-height.pg-kill-two-states`**: 200 randomized points (random height shape,
  random statement index inside the bundle transaction) with the writer's backend provably
  terminated mid-transaction; every observation classifies as exactly "nothing of H" or "all of H
  including the watermark"; both classes occur (non-vacuity); a killed attempt threw; the same
  bundle retried unfaulted lands whole.
- **`crash.archive-height.sigkill-two-states`**: a REAL child process SIGKILLed at named statement
  indices leaves "nothing of H", and SIGKILLed immediately after the commit returned leaves "all of
  H including the watermark".
- **`crash.archive-height.negative-control-unfolded-writes`**: the PRE-FOLD three-transaction shape
  DOES produce a partial height — so the two-state result is caused by the fold, not by
  unfalsifiable assertions.
- **`crash.archive-height.notify-only-on-commit`**: a listener receives `"<net>:<height>"` for a
  committed height and nothing at all for a rolled-back one.

## 5. Archive identity

**Do**: `ensureArchiveInstanceId(net)` on the store (128 random bits, `ON CONFLICT DO NOTHING` +
read-back, malformed row refused); `getArchiveIdentity(net)` on the read contract, `undefined`
until both halves exist; mint it in `bootstrapChainArchiveSchema` and from `syncOnce`.

**Acceptance** — P-ARC-8 in the read-contract suite: `undefined` before bootstrap and before
genesis; a 32-hex-char id after minting; the same id on every later call; a re-bootstrapped
archive (fresh schema, same net) yields a DIFFERENT id.

## 6. Replay outcome → `transactions.result`

**Do**: keep `applyBlock`'s outcomes for regular transactions; map them onto the archive's regular
rows positionally; byte-verify each pair; leave the whole block NULL on any mismatch; write only
under the existing `replayValidation` flag.

**Acceptance** — `npx vitest run test/chain-archive-sync/replay-outcome-mapping.test.ts` passes:
outcomes land on the right rows in a block that mixes event-borne system transactions with regular
ones; a count mismatch and a byte mismatch each leave every `result` NULL and record the reason;
system rows are never given a `result`. Plus `npm run typecheck`.

## 7. Backfill for pre-008 rows

**Do**: `chain-archive-sync/backfill-block-timestamps.ts` + `backfill-timestamps-cli.ts`, offline,
`AND timestamp_ms IS NULL` on every write, undecodable blocks reported and the CLI exiting 2.

**Acceptance** — `npx vitest run test/chain-archive-sync/backfill-block-timestamps.test.ts` passes:
a block archived with `NULL` is filled from its archived body blob and the archive's own runtime
metadata; a re-run is a no-op; a block whose body cannot be decoded is reported unresolved and left
`NULL`; an already-populated row is never overwritten.

## 8. `shielded-monitor/offers.ts`

**Do**: `extractOffers(rawBytes, protocolVersion)`, `deserializeEncryptionSecretKey(bytes)`,
`UnsupportedProtocolVersionError`, `LEDGER_BUILD_ID`, sharing ingest's protocol-version gate.

**Acceptance** — `npx vitest run test/shielded-monitor/offers.test.ts` passes: an unsupported
protocol version throws the typed error BEFORE the ledger is loaded; a non-standard payload throws
`NotAStandardTransactionError`; `LEDGER_BUILD_ID` equals the sync service's `LEDGER_STATE_VERSION`
(a drift between them would make association provenance lie).

## 9. Close-out

- `npm run typecheck` clean.
- `npm run test:conformance` green, with the required-tests manifest reconciling every required id
  (the count pin updated deliberately if a required id was added).
- Re-run `graphify update .` and commit the refreshed `graphify-out/` (CLAUDE.md's sprint rule) —
  or record in the PR why it could not run in this environment.
- `ROADMAP.md` / `CHANGELOG.md` note if the owner wants the entry in this PR.
