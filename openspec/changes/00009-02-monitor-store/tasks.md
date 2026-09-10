# Tasks — 00009-02: shielded monitor store, key intake and lifecycle

Each task states its acceptance criteria as a concrete command or a named test that must pass.
`vitest run <file>` below always means the repository's own `npx vitest run <file>`; the whole set
must also pass under `npm run typecheck` and `npm run test:conformance`.

---

## 1. Migration lineage `shielded_monitor`

Create `src/postgres/migrations/shielded_monitor/001_core.ts` and `index.ts`
(`shieldedMonitorMigrations = [migration000, core]`), plus
`shielded-monitor/bootstrap.ts` exporting `bootstrapShieldedMonitorSchema(sql, schema)`.

Tables: `monitors`, `associations`, `lifecycle_events`, `audit_events` as specified in
`design.md` §§6–8.

**Acceptance criteria**

- `vitest run test/shielded-monitor/migrations.integration.test.ts` passes: a fresh apply records
  exactly `["000_schema", "001_shielded_monitor_core"]` in `<schema>._migrations`; a second
  `bootstrapShieldedMonitorSchema` call applies zero further migrations; the four tables exist in
  the target schema and in no other.
- The same test asserts every CHECK constraint fires: a bad `state`, a negative height, a
  `scanned_through_height` below `scanned_from_height`, an `applied_outcome` other than
  `'unknown'`, an empty `matched_segments`, and a duplicate
  `(monitor_id, block_height, block_hash, position)` are each rejected.
- Applying the lineage into a database that already carries `chainArchiveMigrations` changes no
  `chain_archive` object (asserted by comparing the `information_schema.tables` snapshot before
  and after).

## 2. Bech32m codec

`shielded-monitor/bech32m.ts`: `encodeBech32m(hrp, bytes)`, `decodeBech32m(s)`, BIP-350 checksum
constant, mixed-case rejection, 512-character bound.

**Acceptance criteria**

- `vitest run test/shielded-monitor/bech32m.test.ts` passes with BIP-350's published **valid**
  Bech32m vectors accepted and its published **invalid** vectors rejected, each with the specific
  failure reason asserted (not merely "threw").
- A string valid under the original Bech32 checksum constant (`1`) is rejected.
- `encodeBech32m(hrp, decodeBech32m(s).data)` round-trips every valid vector back to `s`.

## 3. Fingerprint

`shielded-monitor/fingerprint.ts`: `monitorFingerprint(net, serialized)` per `design.md` §4.5.

**Acceptance criteria**

- `vitest run test/shielded-monitor/fingerprint.test.ts` passes: deterministic for equal inputs;
  different for the same key on two networks; different for two keys on one network; equals a
  committed 32-byte expected value for a fixed `(net, key)` pair, so a silent change of the domain
  string or the framing fails the test.

## 4. Key intake

`shielded-monitor/viewing-key.ts`: `hrpForNetwork`, `parseViewingKey(encoded, net)` →
`ShieldedViewingKey`, ledger validation through `loadLedgerV8()` with `clear()` + `free()` in a
`finally`, redacting `toString`/`toJSON`/inspect.

**Acceptance criteria**

- `vitest run test/shielded-monitor/viewing-key.test.ts` passes, including:
  - the reference indexer vector
    `mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h`
    (`indexer-api/src/infra/api/v4/viewing_key.rs:66-71`) is accepted on network `undeployed`;
  - the same string is rejected on network `preview` and on `mainnet`;
  - a key built from `ZswapSecretKeys.fromSeed(seed).encryptionSecretKey
    .yesIKnowTheSecurityImplicationsOfThis_serialize()` re-encoded as Bech32m is accepted, and its
    round-tripped bytes are byte-identical;
  - a well-formed Bech32m string whose payload is not a valid encryption secret key is rejected;
  - every rejection carries the identical generic message;
  - no stringification path reveals the payload, proven with a positive control.

## 5. Lifecycle state machine

`shielded-monitor/lifecycle.ts`: states, events, the total transition function of `design.md` §5.

**Acceptance criteria**

- `vitest run test/shielded-monitor/lifecycle.property.test.ts` passes with fast-check over random
  event sequences: the reached state is always legal; every accepted state-changing transition
  bumps the epoch by exactly 1 and every rejected or no-op one bumps it by 0; from `deleted` no
  event changes the state; from `revoked` only `delete` does; the transition table is total (every
  `(state, event)` pair has a defined outcome).

## 6. Store

`shielded-monitor/store.ts`: `register`, `get`, `getIncludingRevoked`, `getByFingerprint`,
`listActive`, `advance`, `pause`, `resume`, `goLive`, `revoke`, `delete`, `markFailed`,
`markStaleSource`, `readAssociations`, `listLifecycleEvents`, `getKeyMaterial`.

**Acceptance criteria**

- `vitest run test/shielded-monitor/store.integration.test.ts` passes against Testcontainers
  PostgreSQL 17, covering: idempotent registration; coverage advance with and without
  associations; `readAssociations` paging in `(blockHeight, position)` order; `revoke` refusing
  reads; `delete` removing key and associations while keeping lifecycle history; `markFailed`
  storing a `lastError` that contains no key material.
- `vitest run test/shielded-monitor/store.property.test.ts` passes: for random interleavings of
  lifecycle events and `advance` calls, a call whose epoch is stale never changes any row
  (asserted by comparing a full table snapshot before and after), coverage is monotone, and the
  association `seq` sequence is gapless and strictly increasing per monitor.
- The fencing test carries the required id
  `[[shielded-monitor.fencing.stale-epoch-never-commits]]`.

## 7. Owner Rule B evidence

`test/shielded-monitor/schema-isolation.integration.test.ts`.

**Acceptance criteria**

- Both lineages are installed in one database; the full B flow (register → advance → pause →
  resume → revoke → delete) runs as a role holding only `USAGE`/`SELECT` on `chain_archive` and
  full rights on `shielded_monitor`, and completes.
- Positive control: the same role's direct `INSERT` into a `chain_archive` table is rejected, so
  the test is not vacuous.
- Every `chain_archive` table's row count and the schema's `information_schema` snapshot are
  unchanged across the flow.
- Carries the required id `[[shielded-monitor.isolation.b-writes-only-its-own-schema]]`.

## 8. Restore procedure and drill

`shielded-monitor/revocation-list.ts`, `docs/shielded-monitor-restore.md`,
`test/shielded-monitor/restore-drill.integration.test.ts`.

**Acceptance criteria**

- The drill performs a real `pg_dump` of the schema inside the container, revokes a monitor,
  exports the revocation list, drops and restores the schema from the dump (which does **not**
  contain the revoke), re-applies the list, and then asserts `get()` refuses the monitor and
  `advance()` is fenced.
- Re-applying the same list twice changes nothing (idempotent).
- Carries the required id `[[shielded-monitor.restore.revocation-survives-snapshot-restore]]`.

## 9. Trusted harness

`shielded-monitor/harness-cli.ts` plus the `shielded-monitor:harness` npm script.

**Acceptance criteria**

- `vitest run test/shielded-monitor/harness.integration.test.ts` drives the harness end to end
  against Testcontainers — `bootstrap`, `register`, `status`, `advance`, `associations`, `pause`,
  `resume`, `revoke`, `delete`, `export-revocations`, `apply-revocations` — with **no scanner and
  no HTTP API in the process**, which is this phase's exit criterion.
- The harness reads the viewing key only from a file (never `argv`), and the test asserts the key
  never appears in the harness's stdout or stderr.

## 10. Guards, typechecking and the gate

**Acceptance criteria**

- `vitest run test/postgres/no-shielded-monitor-import-guard.test.ts` passes, with fixture files
  proving the scanner is non-vacuous.
- `tsconfig.json` includes `shielded-monitor/**/*.ts`; `npm run typecheck` exits 0.
- `test/integration/required-tests.manifest.json` carries the three new ids bound to their files,
  `EXPECTED_REQUIRED_COUNT` is 28, and `npm run test:conformance` exits 0 with all 28 required ids
  reconciled as executed-and-passed.

## 11. Close-out

- `CHANGELOG.md` gains an Unreleased entry naming the new schema and stating it is additive.
- `SECURITY.md` gains the alpha trust-model paragraph (plaintext keys and associations in the B
  schema, operator trusted, deferred hardening list).
- Re-run `graphify update .` and commit the refreshed `graphify-out/` (project `CLAUDE.md`
  close-out rule) — **if and only if** the `graphify` CLI is available in the execution
  environment; if it is not, record that in the PR description rather than committing a stale or
  partially-regenerated graph.
