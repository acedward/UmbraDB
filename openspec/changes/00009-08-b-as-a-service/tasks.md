# Tasks — 00009-08: project B as a distinct deployable

Each task states the command that must succeed or the test that must pass
(openspec `config.yaml` rule: acceptance criteria are concrete, not descriptions of work).

## 1. Split the monitor store into a contract and an implementation

`shielded-monitor/store.ts` keeps the record types and gains `ShieldedMonitorStore`; the
PostgreSQL implementation moves to `storage-api/monitor-store-pg.ts`, the migration bootstrap to
`storage-api/bootstrap.ts`, the operator harness to `storage-api/harness-cli.ts` and the
`LISTEN`-based wake source to `storage-api/pg-wake.ts`.

**Acceptance**: `npx tsc --noEmit` is clean and `npx vitest run test/shielded-monitor/` passes with
no behavioural change to the store.

## 2. `umbradb-storage-api`

`storage-api/{config,server,server-cli}.ts`: `/v1/health`, the mounted archive routes, and the
monitor-store commands, one transaction per call, 409 on a stale epoch.

**Acceptance**: `npx vitest run test/storage-api/storage-api.test.ts` passes, including the
required id `storage-api.fencing.stale-epoch-is-409-and-rethrown`, the error-status mapping for
every typed store error, 405/404/413, and a bigint above 2^53 surviving the round trip.

## 3. `HttpMonitorStore`

`shielded-monitor/storage-http-client.ts`, implementing `ShieldedMonitorStore` over one base URL,
reconstructing the typed errors, and resolving a lost `advance` response by re-reading.

**Acceptance**: `npx vitest run test/storage-api/monitor-store-parity.property.test.ts` passes,
including the required id `storage-api.parity.http-store-matches-pg-store` — eight
`fast-check`-sampled command sequences produce identical transcripts and identical final state
against a direct PostgreSQL store and against a real HTTP server over the same database.

## 4. No database in project B

`shielded-monitor/no-database.ts` refuses any `*_PG` (and the three schema variables) at boot;
`scanner-cli` and `api/server-cli` require `STORAGE_URL`; the import guard bans `postgres`,
`src/postgres/**` and `storage-api/**` transitively.

**Acceptance**: `npx vitest run test/shielded-monitor/import-boundary.test.ts
test/shielded-monitor/archive-source.test.ts` passes, including the required id
`shielded-monitor.import-boundary.no-database-in-project-b` and its four positive controls, and
the assertion that no dynamic import into project A remains.

## 5. `umbradb-shielded-monitor-balancer`

Uniform random selection, health exclusion and reinstatement, GET-only retry, `X-Upstream`.

**Acceptance**: `npx vitest run test/shielded-monitor/balancer.test.ts` passes, including the
required id `shielded-monitor.balancer.random-selection-over-two-upstreams` (200 requests, both
upstreams, a real band around 50%) and the case proving a POST is never replayed.

## 6. Rule B across the boundary

Extend — never weaken — the Rule B crash argument with an HTTP-level suite that uses the SAME
`classifyRuleBState` the writer suite uses.

**Acceptance**: `npx vitest run test/integration/crash/shielded-monitor-http-atomicity.crash.test.ts`
passes, including the required id `crash.shielded-monitor-http.lost-response-never-duplicates`.
The existing `shielded-monitor-batch-atomicity.crash.test.ts` is unchanged and still passes.

## 7. The 2×2 deployment

`Dockerfile.shielded-monitor` (six commands),
`test/compose/docker-compose.shielded-monitor.yml` (2 scanners + 2 APIs + balancer + storage API),
`npm run demo:shielded-monitor -- --split`.

**Acceptance**: `docker build -f Dockerfile.shielded-monitor .` succeeds;
`npx vitest run test/storage-api/split-topology.integration.test.ts` passes, including the required
id `storage-api.split-topology.two-scanners-two-apis-one-balancer`; and a manual
`npm run demo:shielded-monitor -- --split` on a real devnet reaches `scannedThrough == sourceTip`
with the dashboard served through the balancer.

## 8. Documentation and gates

`docs/shielded-monitor-deployment.md` (topology, env matrix, scaling, migration, what the TEE step
adds), SECURITY.md's storage-boundary section, the CHANGELOG entry including the breaking change,
and `EXPECTED_REQUIRED_COUNT` 50 → 56 with the six new ids bound to their files.

**Acceptance**: `npx vitest run test/integration/check-required-tests.test.ts` passes and
`VITEST_MAX_WORKERS=2 npm run test:conformance` is green.

## 9. Close-out

Re-run `graphify update .` and commit the refreshed `graphify-out/` with this change (CLAUDE.md's
standing sprint rule), and update `ROADMAP.md`.
