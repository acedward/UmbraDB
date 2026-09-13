# Tasks — 00009-09: the merged monitor-node

Each task states its own acceptance. The organizer's ordered change list is
`plans/00009-09-merged-monitor-node.md` §8; this file is the repository-side view of it.

## 1. Migration and the store contract

`src/postgres/migrations/shielded_monitor/004_key_in_ram_and_gaps.ts`: relax
`monitors_deleted_is_shredded` to fingerprint-only and add `monitor_gaps(monitor_id FK ON DELETE
CASCADE, from_height, to_height CHECK (>= from_height), recorded_at, PK(monitor_id, from_height))`.
`shielded-monitor/store.ts`: `MonitorGap`, `MonitorRecord.gaps`, `RegisterMonitorInput.fingerprint`,
`AdvanceBatchItem/Result`, `FillGapInput/Result`, `listGaps`; remove `getKeyMaterial` and the three
lease methods.

**Acceptance**: `migrations.integration.test.ts` shows five lineage entries, six tables, the
inverted CHECK and the gap-range CHECK; `store.integration.test.ts` shows no row holding key
material.

## 2. The storage API

`advanceBatch` (one transaction, per-item fences reported not thrown), `fillGap` (shrink, split,
delete; coverage untouched), `listGaps`; registration by fingerprint; `key-material` and the three
lease routes → 410 `GONE`.

**Acceptance**: the required ids `shielded-monitor.store.advance-batch-reports-fenced-items-
without-failing-the-block`, `…fill-gap-shrinks-splits-and-deletes`,
`…register-upserts-by-fingerprint-and-returns-coverage-and-gaps` and
`storage-api.removed-routes-answer-410` pass, and the store parity property suite covers the three
new commands.

## 3. The monitor-node

`shielded-monitor/node/{key-store,block-scan,monitor-node,config}.ts` and
`shielded-monitor/node-cli.ts` (bin `umbradb-shielded-monitor-node`, image command `node`). Remove
`scanner-cli.ts`, `api/server-cli.ts`, `scanner-service.ts` and `scanner-config.ts` with their
bins and image commands.

**Acceptance**: `monitor-node.test.ts` passes, including the required ids for key zero-fill and
clear, the `HAS_SCANNED_ONCE` gap, and paused-keeps/revoked-clears; the bin gate pins eight bins
and asserts the two removals; the import guard still finds no path from `shielded-monitor/**` to
a driver.

## 4. The balancer

`shielded-monitor/balancer/routing.ts` (fingerprint without WASM, per-fingerprint mutex) and the
routing, hint table, `holder` route, `heldBy`/`keyNeeded` rewriting and `/internal/*` 404 in
`balancer.ts`.

**Acceptance**: the required ids `shielded-monitor.balancer.routing-decision-table` and
`…hint-invalidated-when-a-node-goes-away` pass, and the existing balancer distribution id still
passes unchanged.

## 5. Dashboard, compose overlay and demo

`key needed` and `held by` on every monitor row, a gaps column, the `syncing` badge; the overlay's
`shielded-monitor-node-1/-2`; `npm run demo:shielded-monitor -- --split`.

**Acceptance**: `api-ui.test.ts` passes (the dashboard's self-containment id included),
`docker compose … config` validates, and `docker build -f Dockerfile.shielded-monitor .` succeeds.

## 6. End to end

**Acceptance**: `test/storage-api/split-topology.integration.test.ts` passes with two real
monitor-nodes behind the balancer, including duplicate-registration-lands-on-the-holder,
restart → `key needed` → re-send → resume, `/internal/*` never forwarded, and the key-never-logged
id over both components; and the Rule B crash suite's
`crash.shielded-monitor-batch.advance-batch-is-all-or-nothing` passes.

## 7. Documentation and gates

`docs/shielded-monitor-node.md` (renamed from `-scanner.md`), `docs/shielded-monitor-deployment.md`
(topology, env matrix, scaling, the BREAKING migration), `docs/shielded-monitor-api.md`
(`heldBy`/`keyNeeded`/`gaps`), `docs/shielded-monitor-demo.md`, SECURITY.md's trust model, the
CHANGELOG entry with the breaking change, and `EXPECTED_REQUIRED_COUNT` 56 → 73 (→ 78 with §7a).

**Acceptance**: `npx vitest run test/integration/check-required-tests.test.ts` passes and
`VITEST_MAX_WORKERS=2 npm run test:conformance` is green.

## 7a. The two defects the live end-to-end run found (organizer questions Q31 and Q32)

Both were invisible to a suite that never paused a monitor and never re-read a range twice; both
were measured on the owner's live demo on 2026-09-13 and fixed here.

- **MN-037** — the balancer forwards `stateChanged` to the holder after every 2xx lifecycle write
  (`shielded-monitor/balancer/balancer.ts`), addressed by the monitor hints its `holds` fan-out
  already collects, fanned out when it has none, and unable to affect the client's response.
- **MN-018** — the node re-reads every paused key's record on each block it processes
  (`MonitorNode.#refreshPausedKeys`), which is the backstop for a forward that is lost. The same
  change narrows `refreshHeldMonitor` to `isScannable`, so a `failed` or `stale_source` monitor is
  no longer handed a `sync-key` the store is bound to fence.
- **MN-026** — `PgShieldedMonitorStore.fillGap` selects the observations it already holds for the
  range and drops them before the `last_assoc_seq` bump, so `seq` stays dense and `written` counts
  rows actually inserted.
- **MN-017** — `MonitorNode.#queueRecordedGaps` queues a back-sync for every gap still in the
  record when a key finishes syncing, which is the retry path a stuck gap had none of.

**Acceptance**: the required ids `shielded-monitor.balancer.lifecycle-writes-forward-state-changed`,
`shielded-monitor.node.resume-in-storage-is-noticed-on-the-next-block`,
`shielded-monitor.node.resume-through-the-balancer-needs-no-resend`,
`shielded-monitor.store.fill-gap-skips-rows-it-already-holds` and
`shielded-monitor.node.sync-key-queues-a-back-sync-for-a-recorded-gap` pass, and
`EXPECTED_REQUIRED_COUNT` is 78. **Not added**: a `fill-gap` overlap case in the Rule B crash
suite. That suite's subject is atomicity under a kill, and this fix changes no transaction
boundary — it adds one SELECT inside the existing one. The claim a crash case would make (a retry
after a lost response writes nothing twice) is made directly by the store id above, which runs the
identical fill twice and asserts `written: 0` and two rows.

## 8. Close-out

Re-run `graphify update .` and commit the refreshed `graphify-out/` with this change (CLAUDE.md's
standing sprint rule), and update `ROADMAP.md`. **Not done on this branch**: `graphify` is not
installed on the machine this change was built on, and the committed graph was already stale
before it — carried forward from 00009-08's task 9 rather than silently dropped.
