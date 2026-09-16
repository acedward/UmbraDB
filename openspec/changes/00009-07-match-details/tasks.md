# Tasks — 00009-07: match details

Each task states the command that must succeed or the test that must pass
(openspec `config.yaml` rule: acceptance criteria are concrete, not descriptions of work).

## 1. `shielded-monitor/match-details.ts` — the extractor

From the offers already extracted for the predicate plus the set of matched segment ids, produce
`{ version, ledgerBuild, segments[], totals, truncated? }` with per-segment outputs, inputs,
transients, true `counts`, an optional `truncated` flag, and a three-valued `mine` derived by the
rule in `design.md` §2. Attempt exact isolation first; fall back to the deduction when the ledger
refuses. Lists capped at `MAX_DETAIL_ENTRIES = 256`.

**Acceptance**: `npx vitest run test/shielded-monitor/match-details.test.ts` passes, including
(a) for **every** corpus transaction and **every** corpus key, the recorded commitments,
nullifiers and transient pairs equal those read straight off the offer, and every `mine` value is
the one the rule entails; (b) non-vacuity assertions that a pinned `true`, an ambiguous `null`, an
unmatched-segment `false`, a contract-owned `false`, a real input and a real transient all actually
occurred in the run; (c) truncation caps the lists and preserves the true counts; (d) the required
id `shielded-monitor.match-details.per-output-isolation-is-refused-for-archived-bytes` — the ledger
refuses per-entry isolation on archived (proven) values — with a positive control showing the same
call IS exact for an unproven output.

## 2. Migration `shielded_monitor/002_association_details`

Additive and nullable: `associations.details jsonb`, `associations.block_timestamp_ms bigint` with
a non-negative CHECK, and the partial index `associations_details_missing` on `details IS NULL`.
Appended to `shieldedMonitorMigrations`, never inserted.

**Acceptance**: `npx vitest run test/shielded-monitor/migrations.integration.test.ts` passes with
new cases proving: a row written the pre-00009-07 way keeps `NULL` in both columns; a details
document and a block time round-trip unchanged; a negative block time violates a CHECK; the index
exists and is PARTIAL; re-running `up()` against the migrated schema changes nothing. The lineage
assertion reads `["000_schema", "001_core", "002_association_details"]`.

## 3. Store: write, read and the backfill's write path

`AssociationInput`/`AssociationRecord` gain optional `details`/`blockTimestampMs`; `advance`
writes them in the SAME `INSERT`, inside the SAME transaction, as every other association column;
`readAssociations` returns them; `readAssociationsMissingDetails(monitorId, afterSeq, limit)` is
the backfill's work list; `updateAssociationDetails(monitorId, expectedEpoch, updates)` fills rows
under `AND details IS NULL`, epoch-fenced, refusing revoked and deleted monitors.

**Acceptance**: `npx vitest run test/shielded-monitor/store.integration.test.ts` passes, including
the required id `shielded-monitor.backfill.fills-null-rows-once-and-is-idempotent` (a second run
applies 0 and overwrites nothing), a details document above `MAX_ASSOCIATION_DETAILS_BYTES`
refused as a `ValidationError` with **nothing** of the batch written, a stale epoch refused with
`MonitorFencedError` and nothing written, a paused monitor still fillable, and revoked/deleted
refused.

## 4. Scanner: details at match time, inside the height's transaction

`evaluateRelevance(tx, key, { details: true })` computes the details from the same extraction and
the same `test(offer)` results that decided the match; the scanner attaches them and the block's
`timestampMs` to the association it hands `advance`.

**Acceptance**: `npx vitest run test/shielded-monitor/scanner.integration.test.ts` passes with a
case asserting every match carries details whose matched segments equal the association's own and
whose block time equals the archive's value for that height.
`npx vitest run test/integration/crash/shielded-monitor-batch-atomicity.crash.test.ts` passes,
including the required id `crash.shielded-monitor-batch.details-commit-with-the-height` and the
200-kill case under the **strengthened** `classifyRuleBState`.

## 5. `--backfill-details`

`shielded-monitor/details-backfill.ts` plus the CLI flag and `SCAN_BACKFILL_DETAILS` /
`SCAN_BACKFILL_ROWS` config. Reads blocks only through `ArchiveReadContract`; writes only the two
new columns; skips and counts what it cannot tie to the recorded match; pages forward by `seq`.

**Acceptance**: `npx vitest run test/shielded-monitor/details-backfill.integration.test.ts`
passes, including the required id `shielded-monitor.backfill.fills-existing-matches-and-is-idempotent`,
a case proving a backfilled row is **identical** to one the scanner recorded live, a case proving a
row whose block hash no longer matches is skipped while the rest of the monitor is filled, a
revoked monitor passed over without abandoning the others, and a content hash of the archive's own
rows unchanged across the run.

## 6. API: `blockTimestampMs`, `details`, `?details=0`

**Acceptance**: `npx vitest run test/shielded-monitor/api.integration.test.ts` passes with cases
for: a match with neither recorded returning both keys with `null` values; a recorded details
object returned verbatim with the block time as a decimal string; `?details=0` omitting BOTH keys
and the remaining item being byte-identical to the default one minus those two fields; any other
value (including `1`, `true`, empty) including them. The pre-existing required id
`shielded-monitor.api.key-never-logged` stays green.

## 7. Dashboard: the expandable row

**Acceptance**: `npx vitest run test/shielded-monitor/api-ui.test.ts` passes, including the
pre-existing required id `shielded-monitor.ui.self-contained-no-external-resources`, and new cases
that EXECUTE the served page's own script in a `node:vm` sandbox and assert: the summary line for
a pinned, an ambiguous and a none-yours match; the backfill placeholder for a match with no
details; the expanded panel containing every commitment, every nullifier, the contract address, the
attribution and the legend; a segment with no entries saying so rather than rendering an empty
table; `fmtWhen`/`ago` never inventing a time. The page-size bound moves 600 → 700, argued in
`design.md` §7.

## 8. Docs, CHANGELOG and the required-test manifest

`docs/shielded-monitor-api.md` (the details object, the `mine` table, `?details=0`),
`docs/shielded-monitor-scanner.md` (the backfill section and the two new variables),
`docs/shielded-monitor-demo.md` (what the expanded row shows), `CHANGELOG.md`, and five new
required ids with `EXPECTED_REQUIRED_COUNT` **45 → 50**.

**Acceptance**: `npx vitest run test/integration/check-required-tests.test.ts` passes;
`npx tsc --noEmit`, `npx tsc -p tsconfig.cli.json --noEmit`, `npm run docs:storage:check` and
`npm run build` are clean; the full `VITEST_MAX_WORKERS=2 npm run test:conformance` is green with
all 50 required ids reconciled.

## 9. Close-out

Re-run `graphify --update` and commit `graphify-out/` (CLAUDE.md's standing rule) — **not done on
this host: `graphify` is not installed**, the same position PRs #11, #13 and #14 recorded.
