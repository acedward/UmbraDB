# Tasks — 00009-03: the shielded viewing-key relevance scanner

Each task states its acceptance criteria as a concrete command or a named test that must pass.
`vitest run <file>` below always means `npx vitest run <file>`; the whole set must also pass under
`npm run typecheck` and `npm run test:conformance`.

---

## 1. The relevance predicate

`shielded-monitor/relevance.ts`: `evaluateRelevance(tx, key)` returning `match` (with every
matched segment id, ascending), `no-match`, or `skipped` with a reason
(`system-transaction` / `no-zswap-offers`). `GUARANTEED_SEGMENT_ID = 0`, justified from the
ledger's own `SegmentSpecifier`.

**Acceptance criteria**

- `vitest run test/shielded-monitor/relevance.test.ts` passes (10 cases), including: every
  corpus transaction matches exactly the keys and segments
  `test/fixtures/shielded-monitor/corpus.manifest.json` declares; a system transaction is
  skipped without being deserialized (proven with bytes that would throw if it were); a
  transaction with no offers is `skipped`, not `no-match`; a contract-owned output is invisible
  to every key; an unsupported protocol version throws `UnsupportedProtocolVersionError` while
  the SAME bytes match at a supported version; undecodable bytes throw rather than reporting a
  no-match.
- The same file asserts the manifest is NON-VACUOUS: it declares at least four positives for K,
  at least one negative, at least one positive whose only match is in a fallible segment, and at
  least one transaction with two matching outputs.

## 2. The batch: one page of whole blocks, one commit

`shielded-monitor/scanner.ts`: `ShieldedMonitorScanner.scanBatch(monitor)` and
`scanToTip(monitorId, {maxBatches})`. Archive access only through `ArchiveReadContract`; store
access only through the narrow `ScannerStore` interface.

**Acceptance criteria**

- `vitest run test/shielded-monitor/scanner.test.ts` passes (16 cases) and asserts, with
  in-memory doubles, that a batch spanning three blocks makes exactly ONE `advance` call at the
  page's LAST height, that a page of system transactions still advances, and that a
  non-positive `batchBlocks` is refused at construction.
- `vitest run test/shielded-monitor/scanner.integration.test.ts` passes (15 cases) against a
  real archive written by `putBlockBundle` and read back through the contract.
- **SC-001**: the integration suite's `[[shielded-monitor.relevance.matches-equal-the-fixture-manifest]]`
  case asserts, for all three corpus keys, that the stored associations equal the manifest
  exactly — every positive once, zero negatives, correct `matchedSegments`,
  `appliedOutcome = "unknown"`, FR-009 provenance, and a gapless `seq` in `(blockHeight,
  position)` order.
- A zero-match block and an empty block still advance coverage (asserted in the same suite).

## 3. Archive identity binding and the stale-source stop

`PgShieldedMonitorStore.bindArchiveSource(id, expectedEpoch, {genesisHash, instanceId})` —
epoch-fenced, scannable-states only, first-write-wins — plus the scanner's per-batch comparison.

**Acceptance criteria**

- `[[shielded-monitor.scanner.stale-source-stops-the-monitor]]` in
  `scanner.integration.test.ts`: after one clean batch, rewriting the archive's instance id (what
  a drop-and-re-sync produces) moves the monitor to `stale_source` with
  `lastError.code = "ARCHIVE_IDENTITY_CHANGED"` and its coverage FROZEN where it was — neither
  advanced nor rolled back.
- `scanner.test.ts` asserts the stale source is detected BEFORE the page is read
  (`archive.reads === 0`), that an unbound monitor is bound exactly once and not re-bound on the
  next batch, and that an archive which cannot yet answer its identity is "nothing to scan"
  rather than a mismatch.

## 4. Fail-closed on an unreadable transaction

**Acceptance criteria**

- `[[shielded-monitor.scanner.fail-closed-on-undecodable-bytes]]` in
  `scanner.integration.test.ts`: a `regular` transaction at a supported protocol version whose
  bytes the ledger cannot read moves the monitor to `failed` with `atHeight`/`atPosition`
  recorded, and **coverage stays below that height**.
- `scanner.test.ts` asserts the same for an unsupported protocol version
  (`code = "UNSUPPORTED_PROTOCOL_VERSION"`), and that `advance` was never called in either case.
- The failure message carries no `mn_shield-esk` fragment (asserted).

## 5. Owner Rule B: crash safety and the write-set audit

`test/integration/crash/{monitor-batch-fixture.ts, monitor-batch-worker.ts,
shielded-monitor-batch-atomicity.crash.test.ts}`, reusing the Rule A suite's shared
instrumentation (`archive-fault-injection.ts`) so a statement index means the same thing in both.

**Acceptance criteria**

- `vitest run test/integration/crash/shielded-monitor-batch-atomicity.crash.test.ts` passes
  (4 cases):
  - `[[crash.shielded-monitor-batch.pg-kill-two-states]]` — 200 randomized PostgreSQL kills
    inside the advance transaction leave exactly `{no association of H and coverage below H, all
    of H and coverage H}`; both classes occur; an interrupted height WITH matches and one
    WITHOUT both occur; every interrupted batch redoes whole with no duplicate
    `(height, position)`.
  - `[[crash.shielded-monitor-batch.sigkill-two-states]]` — a real child process running the
    real scanner, SIGKILLed inside the transaction and immediately after the commit, yields the
    two states respectively; the worker's own pause signal is asserted against the point asked
    for, so a point past the end of the transaction cannot masquerade as a crash point.
  - `[[crash.shielded-monitor-batch.negative-control-unfolded-writes]]` — the UNFOLDED shape
    DOES expose a partial batch, so the two-state result is attributable to the fold.
  - `[[crash.shielded-monitor-batch.write-set-is-shielded-monitor-only]]` — every write
    statement the scanner issues names a `shielded_monitor` table, in a run that also read the
    archive, with two positive controls (an archive write IS flagged; a `SELECT … FOR UPDATE` is
    NOT classified as a write).
- The four ids plus the three scanner ids are in `test/integration/required-tests.manifest.json`
  and `EXPECTED_REQUIRED_COUNT` is 39; `vitest run test/integration/check-required-tests.test.ts`
  passes.

## 6. Fencing and lifecycle interaction

**Acceptance criteria**

- `scanner.integration.test.ts`: a pause landing between the worker's load and its commit fences
  the batch with NOTHING written and coverage unset; `resume` then produces the manifest's
  association set exactly, with no duplicate and no gap. A revoke stops the ordered worker
  before it runs a batch at all.
- `scanner.test.ts`: a fence thrown by `advance` and a fence thrown by `markFailed` are each
  reported as `{kind: "fenced"}` rather than swallowed or re-raised.

## 7. Laws over interleaved growth and scanning

**Acceptance criteria**

- `vitest run test/shielded-monitor/scanner.property.test.ts` passes: over random interleavings
  of "append 1–3 blocks" and "scan a batch of 1–4 blocks", after EVERY operation coverage is
  monotonic and never above the tip (L1) and the association set equals the manifest oracle
  restricted to covered heights (L2).
- The property asserts its own non-vacuity: at least one run scanned a height carrying a match
  AND at least one run scanned a height with none.

## 8. Scheduling and the live tail

**Acceptance criteria**

- `scanner.integration.test.ts`: one `runCycle()` drives every active monitor to `live`.
- With `pollMs` set to 600 000 (far beyond the test), a newly archived block still produces the
  new match — so the wake-up came from `LISTEN chain_archive_progress`, not the timer. This case
  is deliberately NOT in the required-tests manifest: it is the one assertion whose outcome
  depends on wall-clock progress under host load, and a load-sensitive entry makes a fail-closed
  gate less trustworthy.

## 9. The process, its configuration and its metrics

`shielded-monitor/{scanner-config.ts, scanner-metrics.ts, scanner-cli.ts}`; bin
`umbradb-shielded-monitor`; `tsconfig.cli.json` includes `shielded-monitor/**/*.ts`.

**Acceptance criteria**

- `vitest run test/shielded-monitor/scanner-config.test.ts` passes: every default is what the
  documentation says, and a zero, negative, fractional or non-numeric bound is REFUSED with the
  variable named rather than silently replaced by the default.
- `npx tsc -p tsconfig.cli.json --noEmit` is clean, so the binary the `bin` entry points at is
  actually built.
- `vitest run test/api-surface/package-json-strict.test.ts` still passes with the new `bin`
  entry.
- Metrics carry no monitor id: the label type admits only `net`, and the integration suite
  additionally asserts no monitor id appears in a serialized snapshot.

## 10. SC-006 first measurement

`bench/shielded-monitor-scan.ts`.

**Acceptance criteria**

- `npx tsx bench/shielded-monitor-scan.ts` runs to completion against a Testcontainers
  PostgreSQL and prints a table with tx/s per key and RSS at 1, 10 and 50 keys.
- The numbers, and the limits on what they mean, are recorded in the organizer sub-plan
  (`plans/00009-03-relevance-scanner.md`). The acceptance THRESHOLD is explicitly not set here —
  SC-006 says the plan sets it once a first measurement exists.

## 11. Close-out

- `npx tsc --noEmit` clean; `npm run test:conformance` exit 0 with the required-test
  reconciliation reporting all 39 ids executed-and-passed.
- **`graphify update .` — NOT DONE.** `graphify` is not installed on this host (`which graphify`
  → not found), so `CLAUDE.md`'s per-sprint graph refresh could not be performed. Committing a
  stale or partially regenerated graph would be worse than leaving it; recorded here and in the
  PR description as an open item for the reviewer rather than silently skipped. Same position as
  `00009-01` and `00009-02` took.
- **`gitleaks` — NOT RUN** (not installed here). The one class of risk this change adds is
  fixture seeds; they are integers in a JSON manifest, marked as test-only in three places
  (`corpus.manifest.json`'s `$seeds-are-test-only`, the builder's header, `helpers.ts`'s
  `fixtureSeed`), and no serialized key or Bech32m string is committed anywhere in this change.
