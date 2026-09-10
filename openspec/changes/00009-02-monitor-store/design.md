# Design — 00009-02: shielded monitor store, key intake and lifecycle

Every design decision below is stated against the repository's existing design documents. Where
this change touches a decision those documents already made, the section is cited; where it makes
a genuinely new decision, the new decision is stated as such and the reason it does not contradict
the cited section is given.

Cited throughout:

- `design/design.md` §0 (tier reconciliation), §5 (commit/transaction layer), §7 (driver choice).
- `design/design-interfaces.md` §1.1 (error idiom), §1.2 (async pattern), §1.3 (transaction
  participation), §1.4 (runtime validation), §1.5 (naming), §2 (`storage-errors.ts`).
- `Formal/STORAGE_ALGEBRA.md` §1 (CAS guard), §3 (watermarks are last-write-wins, monotonicity
  deliberately not a law), §4 (the control algebra, incl. the removal of fencing tokens from the
  lease layer), §5 (the fast-check testable-law deliverable).
- `design/full-chain-storage-design.md` §5 (how a second, independent migration lineage is run).

---

## 1. Tier placement: a third lineage, not a third home for wallet data

`design/design.md` §0 draws the line between Tier-1 (`tier1_wallet`: wallet/checkpoint
persistence) and the Tier-2 indexer schema, and `design/full-chain-storage-design.md` §5 added
Tier-1.5 (`chain_archive`) as a *separate schema with its own migration lineage*, explicitly
"not the Tier-2 indexer-schema fork either".

`shielded_monitor` follows Tier-1.5's precedent exactly, for the same reason and one stronger one.
The same reason: viewing-key monitors are not wallet-state envelopes or checkpoints, so
`tier1_wallet` is the wrong home (design.md §0). The stronger one: the organizer spec's **owner
Rule B** (spec US5) makes the separation a *correctness* requirement rather than a tidiness one —
project B must never write to an archive table, must commit its per-height work in its own
`BEGIN … COMMIT`, and must be restorable on its own so it can later run in a separate process or
TEE with no schema access to A at all (spec FR-025).

Mechanically this needs nothing new from the runner. `src/postgres/migrate.ts`'s
`RunMigrationsOptions.migrations` (added for Tier-1.5, `full-chain-storage-design.md` §5) already
selects a lineage, and `000_schema.ts` is already fully schema-parameterised, so
`shielded_monitor`'s lineage reuses it unchanged as its bootstrap step exactly as
`chainArchiveMigrations` does. `shielded-monitor/bootstrap.ts` mirrors
`chain-archive-sync/bootstrap.ts` one-for-one.

**Consequence made explicit:** no table is written by both A and B, because no table is *visible*
to both — they are different schemas, and B's code contains no `chain_archive` identifier at all.
`test/shielded-monitor/schema-isolation.integration.test.ts` proves the stronger runtime claim by
running the whole B flow as a PostgreSQL role that has been granted only `USAGE`/`SELECT` on
`chain_archive`: a write attempt would abort the flow, and a positive control asserts such a write
really is rejected for that role.

## 2. Where the module lives: outside `src/`, like `chain-archive-sync/`

`chain-archive-sync/` established that ingestion/consumer code lives outside `src/`, and
`test/postgres/no-chain-sync-import-guard.test.ts` enforces it with a whole-file source scan.
`shielded-monitor/` adopts the same discipline and this change adds the mirror guard,
`test/postgres/no-shielded-monitor-import-guard.test.ts`, built on the same scanner shape
(string-literal extraction that skips comments, so a doc comment naming the directory does not
false-positive).

The module name is hyphenated (`shielded-monitor/`) and the schema name is underscored
(`shielded_monitor`), matching `chain-archive-sync/` ↔ `chain_archive`. That is not cosmetic: the
guard keys on the literal text `shielded-monitor`, so the migration directory
`src/postgres/migrations/shielded_monitor/` — which legitimately lives under `src/` — cannot trip
it, exactly as `chain_archive`'s does not trip the existing guard.

## 3. Error idiom and validation

`design/design-interfaces.md` §1.1 fixes one idiom: thrown, `code`-discriminated errors extending
`StorageError` with a machine-readable `retryable`. §1.4 fixes Zod at the boundary. This change
follows both: `shielded-monitor/errors.ts` defines five subclasses
(`InvalidViewingKeyError`, `MonitorNotFoundError`, `MonitorRevokedError`, `MonitorFencedError`,
`IllegalLifecycleTransitionError`), and inputs are parsed with Zod schemas before any SQL runs.

Two deliberate departures, both narrow:

1. **These errors are not exported from `src/index.ts`.** The published barrel is frozen by
   `test/api-surface/error-catalog-drift.test.ts` and `docs/ERROR-CATALOG.md`, and B is not part
   of the published storage surface (the same position `chain-archive-sync`'s own six error
   classes hold — see `test/api-surface/excluded-not-exported.test.ts`). Nothing in the catalog
   drifts.
2. **`InvalidViewingKeyError` carries one fixed message.** Spec FR-001 requires that *any*
   key-intake failure yields one generic client error, so the message string is identical whether
   the Bech32m checksum failed, the HRP named another network, or the ledger refused the payload.
   The discriminating `reason` is kept on a separate, explicitly diagnostic-only field, never in
   the message, and the class holds no fragment of the input.

## 4. Key intake

### 4.1 Bech32m is implemented here, not imported

The reference indexer decodes a viewing key with the Rust `bech32` crate
(`indexer-api/src/infra/api/v4.rs:190-204`), then checks the HRP against the deployment network
(`v4.rs:149-158`), then hands the payload to `SecretKey::deserialize`
(`indexer-api/src/infra/api/v4/viewing_key.rs:39-48`). The ledger v9 source
(`resources/midnight-ledger-4823b53`) exposes no Bech32m helper, and neither does the vendored v8
WASM (`vendor/ledger-v8-syshash/midnight_ledger_wasm.d.ts`) — so HRP↔network binding is this
repository's responsibility either way.

`shielded-monitor/bech32m.ts` implements BIP-350 Bech32m (checksum constant `0x2bc830a3`) rather
than adding a dependency. This is a deliberate supply-chain choice consistent with
`design/design.md` §7's minimal-dependency posture: the algorithm is ~120 lines, fully specified,
and testable against BIP-350's own published vectors, which the test file uses — including the
*invalid* vector set, so the implementation is proven to reject as well as accept.

Two properties matter for safety and are asserted:

- **Bech32 (the original, checksum constant `1`) is rejected.** A string that is valid under the
  older constant must not decode here; spec FR-001 says Bech32m.
- **Mixed case is rejected** (BIP-173/350), and the HRP is compared case-sensitively after that
  check, so `MN_SHIELD-ESK_…` cannot slip past the network binding.

An overall length bound of 512 characters is applied before any work. BIP-173's 90-character limit
is deliberately *not* used as the bound: it is a property of the addresses BIP-173 defines, not of
this HRP family, and a 24-character HRP plus a 32-byte payload is 83 characters, so the real
inputs sit comfortably below either bound. The 512 bound exists only so a hostile megabyte string
is rejected before the polymod loop runs.

### 4.2 HRP rule

`hrpForNetwork(net)` = `mn_shield-esk` when `net` equals `mainnet` case-insensitively, else
`mn_shield-esk_<net>`. This reproduces `AddressType::hrp` (`v4.rs:149-158`) exactly, including its
`eq_ignore_ascii_case("mainnet")` comparison. The acceptance network is `undeployed` (owner Q7),
so the reference indexer's own committed test vector
(`indexer-api/src/infra/api/v4/viewing_key.rs:66-71`) is directly usable as a positive vector and
is used as one.

### 4.3 Validation is the ledger's, not ours

After the HRP check the payload goes to `EncryptionSecretKey.deserialize(bytes)` on the vendored
ledger v8 WASM (`midnight_ledger_wasm.d.ts:359`), and the resulting handle is `clear()`ed
immediately — the intake's only purpose is to prove the bytes are a real encryption secret key, so
holding the handle any longer would be secret material kept alive for no reason. The WASM is
loaded through `chain-archive-sync/tx-replay-decoder.ts`'s existing `loadLedgerV8()`, reused rather
than reimplemented; both modules live outside `src/`, so this import breaks no guard. Phase 1
(`00009-01`) owns `shielded-monitor/offers.ts`; this change deliberately does not create or touch
that file, to keep the two PRs conflict-free.

`clear()` versus `free()`: `clear()` is the ledger's own zeroising call and is what the intake
uses. `free()` is wasm-bindgen's deallocator; it is called afterwards inside a `try/finally` so the
handle cannot leak if `clear()` throws.

### 4.4 The key type redacts itself

`ShieldedViewingKey` holds the serialized bytes in a `#private` field and overrides `toString()`,
`toJSON()` and `Symbol.for("nodejs.util.inspect.custom")` to return `[ShieldedViewingKey redacted]`.
Reading the bytes requires the explicitly-named
`yesIKnowTheSecurityImplicationsOfThis_serialized()` accessor — the naming convention the ledger
WASM itself uses for exactly this hazard, adopted here so a reviewer sees the hazard at the call
site. `test/shielded-monitor/viewing-key.test.ts` asserts every implicit-stringification path
(template literal, `String()`, `console.log` via `util.inspect`, `JSON.stringify`, `%s`/`%o`
format) yields the redaction and never the payload, with a positive control proving the test would
notice a leak (spec FR-023, SC-004).

### 4.5 Fingerprint

`fingerprint(net, serialized)` = `SHA-256("umbradb/shielded-monitor/fp/v1" ‖ 0x00 ‖ utf8(net) ‖
0x00 ‖ serialized)`.

The organizer plan writes this as `SHA-256(domain ‖ net ‖ key)`. The two `0x00` separator bytes are
an unambiguous-encoding refinement of that formula, not a change of substance: without them,
`(net="a", key=X)` and `(net="aX₀", key=X₁…)` could in principle collide for variable-length key
encodings. `0x00` cannot occur in the UTF-8 encoding of a network id (the id is restricted to
`[A-Za-z0-9_-]` by the input schema), so the framing is injective.

Keyed fingerprints (HMAC under a server secret, which would stop an attacker with database access
from testing a guessed key) are deferred with US4 by owner decision; the restore document and
`SECURITY.md` say so. Fingerprints are never returned to callers (spec FR-003).

## 5. Lifecycle: a total, explicit transition table

`shielded-monitor/lifecycle.ts` is a pure module — no SQL, no I/O — exporting the states, the
events and a total transition function. Spec FR-015 requires
`backfilling → live`, `{backfilling, live} ↔ paused`, `any → revoked → deleted`, plus terminal
`failed` and `stale_source`, with every transition incrementing the epoch and appending a
lifecycle event.

| from \ event | `go_live` | `pause` | `resume` | `fail` | `mark_stale_source` | `revoke` | `delete` |
|---|---|---|---|---|---|---|---|
| `backfilling` | `live` | `paused` | — | `failed` | `stale_source` | `revoked` | via `revoked` |
| `live` | — (idempotent no-op) | `paused` | — | `failed` | `stale_source` | `revoked` | via `revoked` |
| `paused` | — | — (idempotent no-op) | `backfilling` | `failed` | `stale_source` | `revoked` | via `revoked` |
| `failed` | — | — | — | — (idempotent no-op) | — | `revoked` | via `revoked` |
| `stale_source` | — | — | — | — | — (idempotent no-op) | `revoked` | via `revoked` |
| `revoked` | — | — | — | — | — | — (idempotent no-op) | `deleted` |
| `deleted` | — | — | — | — | — | — (idempotent no-op) | — (idempotent no-op) |

Three decisions in that table are ours, not the spec's, and each is called out because a reviewer
would otherwise have to guess:

1. **`resume` goes to `backfilling`, never straight to `live`.** A monitor that was `live` when it
   was paused is, by the time it resumes, behind a tip that moved while it slept. Returning it to
   `backfilling` states that truthfully; the scanner promotes it to `live` on its own when coverage
   reaches the tip. The alternative (remembering the pre-pause state) would restore a `live` label
   that is not true at the moment it is restored, and spec FR-011/FR-020 are emphatic that
   unscanned history must never be presented as caught-up.
2. **`delete` from a non-revoked state performs revoke-then-delete**, as two transitions with two
   epoch bumps and two lifecycle events. Spec FR-015 spells the path as `any → revoked → deleted`;
   honouring it literally means the audit trail of a deleted monitor always shows the revoke, and
   the fence closes at the revoke rather than at the delete.
3. **Idempotent re-issues are no-ops, not errors** (spec FR-016 requires revoke and delete to be
   idempotent; the same treatment is given to `pause`/`resume`/`fail`/`mark_stale_source` for
   uniformity). A no-op does **not** bump the epoch and does **not** append a lifecycle event —
   otherwise a retrying client could fence a healthy worker off its own monitor indefinitely.

`revoked` and `deleted` are absorbing in the sense the spec needs: nothing leaves `deleted`, and
the only edge out of `revoked` is to `deleted`. Every accepted, state-changing transition
increments the epoch by exactly one, so epochs are strictly increasing per monitor.

## 6. The fence

`Formal/STORAGE_ALGEBRA.md` §4 removed fencing tokens from the *lease* layer, on the explicit
ground that guaranteeing mutual exclusion for arbitrary caller code would need "a monotonic fencing
token, a lease-loss `AbortSignal`, and every downstream write checking the fencing token, none of
which this project needs yet for a single-process, single-writer deployment", and said to revisit
"only if a real multi-process/crash-recovery requirement appears".

**That requirement has now appeared, and this change satisfies it in the narrow place it arose
rather than by reopening §4.** Spec FR-012 and US3 scenario 1 require that a scanner worker holding
a stale view of a monitor cannot commit after a pause, revoke or delete. So:

- The fencing token is `monitors.epoch`, monotone per monitor, bumped by every lifecycle
  transition.
- The "every downstream write checks the token" obligation is discharged structurally, not by
  convention: **there is exactly one downstream write path**, `advance()`, and it is the same
  statement as the check.
- No `AbortSignal` and no lease-loss callback is introduced; the worker learns it was fenced by its
  commit being rejected, which is all Rule B needs because the whole batch is one transaction.

This is deliberately *not* a general fencing mechanism for the lease layer, and §4's Law L1 is
untouched. It is a CAS guard of exactly the shape `Formal/STORAGE_ALGEBRA.md` §1's Law T2 already
uses for TemporalKV — an atomic `WHERE <version column> = <expected>` — applied to a different
column on a different table.

The statement:

```sql
UPDATE shielded_monitor.monitors
   SET scanned_from_height    = COALESCE(scanned_from_height, $from),
       scanned_through_height = $through,
       last_assoc_seq         = last_assoc_seq + $n,
       updated_at             = now()
 WHERE id = $id
   AND epoch = $epoch
   AND state IN ('backfilling', 'live')
   AND (scanned_through_height IS NULL OR scanned_through_height < $through)
RETURNING last_assoc_seq, net, matching_rule_version, ledger_build, scanned_from_height;
```

Zero rows aborts the transaction. Because "zero rows" has four possible causes and they are not
equally benign, `advance` then reads the row inside the same transaction to classify:

| cause | outcome |
|---|---|
| no such monitor | throw `MonitorNotFoundError` |
| `state` not in `{backfilling, live}` | throw `MonitorFencedError(reason: "state")` |
| `epoch` ≠ expected | throw `MonitorFencedError(reason: "epoch")` |
| coverage already ≥ `$through`, epoch and state fine | return `{ applied: false, reason: "already-advanced" }` |

The last row is the one that matters for crash safety and is the reason the classification exists
at all. Spec US5 scenario 2 and FR-010 require that a batch whose commit succeeded but whose ack
was lost is *redone* without duplicating: the redo re-runs `advance` with the same arguments, the
monotonic guard matches zero rows, and the caller is told "already applied" instead of being handed
a fencing error it would (wrongly) treat as a lifecycle event. Without the classification the
crash-retry path and the stale-epoch path would be indistinguishable.

### 6.1 Why the association sequence lives on the monitor row

Associations are keyed `PRIMARY KEY (monitor_id, seq)` with a **per-monitor** sequence (spec
FR-022: "associations are stored as plaintext columns with a per-monitor sequence for paging"). A
PostgreSQL `SEQUENCE` is global and non-transactional (gaps survive rollback), which would make the
cursor in Phase 4 gappy and make "the same cursor returns the same page" harder to hold. So the
counter is a plain `bigint` column on the monitor row, `last_assoc_seq`, advanced by `+n` inside
the very `UPDATE` that is already the fence. That yields three things for free: the allocation is
atomic with the coverage advance, it is fenced by the same predicate, and a rolled-back batch
consumes no sequence numbers, so `seq` is gapless per monitor.

## 7. What `advance` commits, and why coverage is in block heights

Spec FR-010/FR-011 and owner Rule B: one `BEGIN … COMMIT` per height (or per batch of *whole*
heights), coverage expressed in block heights, blocks with zero matches still advance coverage.
`advance(monitorId, epoch, throughHeight, associations)` is therefore:

```
BEGIN
  <the fenced UPDATE above>            -- coverage advance + seq allocation, or abort
  INSERT INTO associations …           -- 0..n rows, seq = base+1 … base+n
COMMIT
```

An empty `associations` array is a normal, expected call — it is what a run of empty blocks looks
like — and it still advances coverage. The `UNIQUE (monitor_id, block_height, block_hash, position)`
constraint is left strict (no `ON CONFLICT DO NOTHING`): the monotonic coverage guard already makes
a legitimate replay impossible to reach the `INSERT`, so a unique violation here means a caller bug
and should be loud.

`applied_outcome` carries a `CHECK (applied_outcome = 'unknown')`. Spec FR-009 and the assumptions
section are unambiguous that the alpha never claims funds were received; the check makes that
un-writeable rather than merely undocumented. `source_outcome` is the separate, nullable column for
the archive's own replay outcome, exactly as FR-009 separates them.

## 8. Delete semantics

Spec US3 scenario 4: after a delete, "the key and association rows are gone, and the API answers as
if the monitor never existed"; FR-016: delete removes the key and all derived rows and is
idempotent. FR-015 nonetheless names `deleted` as a *state*, which a fully removed row could not
carry.

Both are satisfiable together, and this change satisfies them as follows. Delete keeps a tombstone
`monitors` row in state `deleted` with `key_serialized` set to `NULL` **and `fingerprint` set to
`NULL`**, and deletes every association row for that monitor. Lifecycle and audit events survive,
because they are the record of what was done.

- "The key … gone": the only copy of the key was `key_serialized`; it is nulled in the same
  transaction as the deletion of the associations.
- "Association rows … gone": deleted, not soft-deleted.
- "As if the monitor never existed": `get()` refuses a `deleted` monitor with the same
  `MonitorNotFoundError` an unknown id gets, so a caller cannot distinguish them. (That is also
  why `getIncludingRevoked()` exists as a separate, internal-only reader for the harness, the
  lifecycle operations and the tests.)
- **Nulling the fingerprint is what makes re-registration behave "as if it never existed"**: the
  `UNIQUE (net, fingerprint)` index treats `NULL`s as distinct, so registering the same key again
  after a delete mints a *new* monitor id rather than colliding with the tombstone. It also removes
  the last derived value from which the key could be tested by guessing.

## 9. Registration idempotency, and the one case that is not idempotent

Spec FR-004: registration is idempotent per network/key. Looking up `(net, fingerprint)` gives that
directly. The interesting case the spec does not name is a *revoked* monitor: a re-registration of
a revoked key would otherwise silently resurrect it and defeat the revocation.

This change **refuses** registration when the `(net, fingerprint)` match is `revoked`, with
`MonitorRevokedError`; the operator deletes the monitor (which nulls the fingerprint) and may then
register the key afresh. `failed` and `stale_source` matches are returned as-is, since those are
recoverable operational states and the caller should see the existing monitor with its coverage and
`last_error`, not a duplicate. This decision is recorded as question `Q11` in the organizer
questions file with the alternatives, and applied as the default.

## 10. Restore, and why the revocation list lives outside the database

Spec FR-024 and the edge case "scanner and API run against a database restored to an older
snapshot": after a restore, revoked and deleted monitors must still be refused. A snapshot taken
before a revoke does not contain the revoke — that is what a snapshot *is* — so no amount of care
inside the database can recover it. The record has to be kept outside the snapshot's rollback
domain.

`shielded-monitor/revocation-list.ts` exports `exportRevocationList(store)` →
`{ monitorId, epoch, state, at }[]` (no key material, no fingerprint, no association data — the
list is safe to store next to the backups) and `applyRevocationList(store, list, actor)`, which for
each entry revokes any monitor that the restored database still shows as live. It is idempotent and
records `actor: "restore"` in the lifecycle event, so the audit trail shows why the transition
happened. `docs/shielded-monitor-restore.md` is the operator-facing procedure; the drill is
executed as a test with a real `pg_dump`/`psql` round trip inside the container, not described and
left unproven.

## 11. Testing strategy

Following `Formal/STORAGE_ALGEBRA.md` §5's shape (laws as `fc.property` over arbitrary event
sequences) and the repository's existing split (unit/property without Docker; integration on
Testcontainers):

| Law / requirement | Test |
|---|---|
| Lifecycle table is total; no illegal transition; epoch strictly increases; `revoked`/`deleted` absorbing | `lifecycle.property.test.ts` (fast-check, no Docker) |
| Bech32m accepts the BIP-350 valid vectors and rejects the invalid ones, incl. Bech32-not-m | `bech32m.test.ts` (no Docker) |
| Key intake: reference vector accepted on `undeployed`; wrong-net HRP, wrong checksum, garbage rejected with one generic error; a `ZswapSecretKeys.fromSeed` key round-trips | `viewing-key.test.ts` (no Docker, needs the vendored WASM) |
| The key type never stringifies its payload | `viewing-key.test.ts`, with a positive control |
| Fingerprint determinism, network separation, domain separation | `fingerprint.test.ts` (no Docker) |
| Registration idempotency; fencing rejects a stale epoch; crash-retry classified as `already-advanced`; `advance` is atomic | `store.integration.test.ts` + `store.property.test.ts` (Testcontainers) |
| B writes only `shielded_monitor.*` (owner Rule B, spec US5 scenario 4) | `schema-isolation.integration.test.ts` (Testcontainers, privilege-enforced, with positive control) |
| Restore drill: snapshot → revoke → restore → apply list → refused | `restore-drill.integration.test.ts` (Testcontainers, real `pg_dump`/`psql`) |
| Nothing under `src/` imports the module | `test/postgres/no-shielded-monitor-import-guard.test.ts` |

Three ids (fencing, restore, schema isolation) are added to
`test/integration/required-tests.manifest.json` so the conformance gate fails *by id* if any of
them is ever skipped, and `EXPECTED_REQUIRED_COUNT` is bumped from 25 to 28. No existing required
id, threshold or gate is removed or relaxed.

## 12. Deferred, and where the seams are

Deferred with US4 (owner, 2026-09-10): envelope encryption of `key_serialized`, KEK rotation and
fail-closed boot, keyed fingerprints, tenant scoping, least-privilege role script, and the
database-dump leakage gate. The seams left for them are deliberate and small:

- `key_serialized bytea` becomes an AEAD ciphertext column plus a nonce column; nothing else in the
  store reads it except `getKeyMaterial`, which is the single choke point where decryption would
  go.
- `fingerprint bytea` becomes an HMAC output; the function already takes the network and is already
  the sole determinant of registration identity, so only `fingerprint.ts` changes.
- `monitors` has no tenant column today. Adding one means a new nullable column plus widening the
  `(net, fingerprint)` unique key to `(tenant, net, fingerprint)`, both additive.
