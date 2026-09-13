# shielded-monitor Specification (delta — change `00009-02-monitor-store`)

## Purpose

Defines the storage, key intake and lifecycle contract for **project B**: shielded viewing-key
monitors, their per-monitor scan coverage, and the associations a relevance scanner will later
record against them. Scanning itself (`00009-03`) and the private API (`00009-04`) are governed by
their own changes and are out of scope here.

Traceability: organizer spec `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
User Stories 1, 3, 5 and 6; requirements FR-001..005, FR-010..016 and FR-022..026. User Story 4
(tenant isolation and confidentiality) is DEFERRED by owner decision of 2026-09-10; the
requirements below that would otherwise cover it say so explicitly.

## Requirements

### Requirement: Viewing keys are accepted only as network-bound Bech32m and validated by the ledger

The service SHALL decode a submitted viewing key as Bech32m (BIP-350), SHALL require the
human-readable part to be `mn_shield-esk` when the deployment network is `mainnet`
(case-insensitive) and `mn_shield-esk_<network>` otherwise, and SHALL validate the decoded payload
by deserializing it with the vendored ledger v8 `EncryptionSecretKey.deserialize`. Every failure
SHALL surface as one generic, identically-worded client error that contains no fragment of the
submitted input.

#### Scenario: The reference network vector is accepted
- **WHEN** the reference indexer's own committed vector
  `mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h` is
  submitted with deployment network `undeployed`
- **THEN** intake SHALL succeed
- **AND** the ledger handle used for validation SHALL be cleared before intake returns

#### Scenario: A key whose HRP names another network is refused
- **WHEN** a key encoded for `undeployed` is submitted to a deployment whose network is `preview`
- **THEN** intake SHALL fail with the generic key error
- **AND** the error message SHALL be byte-identical to the message produced by a malformed key

#### Scenario: A Bech32 (non-Bech32m) string is refused
- **WHEN** a string carrying the original Bech32 checksum constant is submitted
- **THEN** intake SHALL fail with the generic key error

#### Scenario: A well-formed envelope with an invalid payload is refused
- **WHEN** the HRP and Bech32m checksum are correct but the payload is not a valid encryption
  secret key
- **THEN** the ledger deserialization SHALL fail and intake SHALL fail with the generic key error

### Requirement: Key material redacts itself and is never logged

The in-memory key type SHALL render as a fixed redaction placeholder under every implicit
stringification path — `toString`, template interpolation, `JSON.stringify`, and Node's
`util.inspect` custom hook — and SHALL expose its bytes only through one explicitly-named
accessor. Logs, metrics and error bodies produced by this module SHALL NOT contain a viewing key.

#### Scenario: Implicit stringification cannot leak the payload
- **WHEN** the key object is interpolated into a template literal, passed to `String()`,
  serialized with `JSON.stringify`, or formatted by `util.inspect`
- **THEN** every result SHALL be the redaction placeholder
- **AND** none SHALL contain any substring of the serialized key or its Bech32m encoding

### Requirement: Registration is idempotent per network and key

Monitor identity for idempotency SHALL be a domain-separated SHA-256 fingerprint over a fixed
domain string, the network id and the serialized key, unique per network. Registering the same key
for the same network twice SHALL return the existing monitor rather than creating a second one.
Fingerprints SHALL NOT be returned to callers. Keyed (HMAC) fingerprints are DEFERRED with User
Story 4.

#### Scenario: The second registration returns the first monitor
- **WHEN** the same viewing key and network are registered twice
- **THEN** the second call SHALL return the monitor id created by the first
- **AND** exactly one `monitors` row SHALL exist for that `(network, fingerprint)`

#### Scenario: The same key on two networks is two monitors
- **WHEN** the same serialized key is registered under two different network ids
- **THEN** two distinct monitors SHALL exist, with different fingerprints

#### Scenario: Re-registering a revoked key is refused
- **WHEN** a key whose monitor is in state `revoked` is registered again
- **THEN** the call SHALL fail with the revoked error rather than resurrecting the monitor

### Requirement: Monitor state follows an explicit, total transition table with a monotone epoch

Monitors SHALL occupy exactly one of `backfilling`, `live`, `paused`, `failed`, `stale_source`,
`revoked`, `deleted`. Transitions SHALL be limited to `backfilling → live`,
`{backfilling, live} → paused`, `paused → backfilling`, `{backfilling, live, paused} → failed`,
`{backfilling, live, paused} → stale_source`, `any → revoked`, and `revoked → deleted`. Every
accepted state-changing transition SHALL increment the monitor's epoch by exactly one and SHALL
append a lifecycle event. A re-issued transition that would not change the state SHALL be a no-op
that neither increments the epoch nor appends an event.

#### Scenario: Resuming a paused monitor returns it to backfilling
- **WHEN** a paused monitor is resumed
- **THEN** its state SHALL be `backfilling`, not `live`
- **AND** scanning SHALL continue from the persisted `scannedThrough` with no gap and no repeat

#### Scenario: Deleted is absorbing
- **WHEN** any lifecycle event is issued against a monitor in state `deleted`
- **THEN** the state SHALL remain `deleted` and the epoch SHALL be unchanged

#### Scenario: Delete travels through revoked
- **WHEN** a monitor in state `live` is deleted
- **THEN** two transitions SHALL be recorded, `live → revoked` then `revoked → deleted`, with two
  epoch increments and two lifecycle events

### Requirement: A block height's associations and its coverage advance commit together, fenced by the epoch

For each monitor, all associations of the advanced block heights and the coverage advance to the
last of those heights SHALL be written in one database transaction inside the monitor's own
schema. The transaction SHALL be admitted only when the caller's epoch equals the stored epoch and
the monitor is in a scannable state; otherwise zero rows SHALL be updated and the transaction SHALL
abort with nothing written. A batch SHALL cover only whole block heights. Blocks with no matches
SHALL still advance coverage.

#### Scenario: A stale epoch commits nothing
- **WHEN** a worker calls advance with an epoch older than the stored one
- **THEN** the call SHALL fail with the fenced error
- **AND** no association row and no coverage column SHALL have changed

#### Scenario: A pause mid-batch fences the in-flight commit
- **WHEN** a monitor is paused after a worker loaded its epoch but before the worker commits
- **THEN** the worker's commit SHALL be rejected
- **AND** the monitor's coverage SHALL be exactly what it was before the batch

#### Scenario: An empty block range still advances coverage
- **WHEN** advance is called with an empty association list and a higher through-height
- **THEN** coverage SHALL advance to that height and no association row SHALL be created

#### Scenario: A replayed batch is reported as already applied, not as a fencing failure
- **WHEN** a batch that already committed is retried with the same arguments and a current epoch
- **THEN** the call SHALL report that the advance was already applied
- **AND** SHALL NOT create a duplicate association and SHALL NOT raise a fencing error

### Requirement: Coverage is expressed in block heights and never presents unscanned history as empty

A monitor SHALL persist `requestedStart`, `scannedFrom` and `scannedThrough` as block heights, with
`scannedFrom` and `scannedThrough` absent until the first advance. Coverage SHALL be monotone
non-decreasing for the life of a monitor.

#### Scenario: A fresh monitor reports no coverage
- **WHEN** a monitor has just been registered
- **THEN** `scannedFrom` and `scannedThrough` SHALL both be absent, distinguishable from a scanned
  range that happened to contain no matches

#### Scenario: Coverage never moves backwards
- **WHEN** advance is called with a through-height at or below the stored `scannedThrough`
- **THEN** the stored coverage SHALL be unchanged

### Requirement: Associations carry full provenance and never assert an applied outcome

Each association SHALL record network, block height, block hash, position, transaction hash,
protocol version, the matched segment ids, the matching-rule version and the ledger build
identifier, SHALL set `appliedOutcome` to `unknown`, and MAY carry the archive's own replay result
separately as `sourceOutcome`. One monitor SHALL have at most one association per transaction
observation. Associations SHALL be paged by a gapless per-monitor sequence.

#### Scenario: A transaction matching in several segments yields one association
- **WHEN** an observation matches in more than one segment
- **THEN** exactly one association row SHALL exist for it, naming every matched segment

#### Scenario: The applied outcome cannot be set to anything else
- **WHEN** a write attempts to store an applied outcome other than `unknown`
- **THEN** the database SHALL reject it

#### Scenario: Sequences are gapless per monitor
- **WHEN** several advances commit and one aborts
- **THEN** the surviving associations' sequence numbers SHALL be `1..n` with no gap

### Requirement: Revoke stops processing and refuses access; delete destroys key and derived rows

Revoke SHALL stop processing and SHALL refuse subsequent status and association reads. Delete SHALL
remove the stored key and every association row and SHALL make the monitor indistinguishable from
one that never existed. Both SHALL be idempotent.

#### Scenario: A revoked monitor refuses reads
- **WHEN** status or associations are read for a revoked monitor
- **THEN** the read SHALL fail with the revoked error

#### Scenario: A deleted monitor leaves no key and no associations
- **WHEN** the database is inspected after a delete
- **THEN** the monitor's stored key SHALL be absent, its fingerprint SHALL be absent, and it SHALL
  own zero association rows
- **AND** a read by its id SHALL be indistinguishable from a read of an unknown id

#### Scenario: The lifecycle record survives a delete
- **WHEN** the lifecycle events of a deleted monitor are listed
- **THEN** the register, revoke and delete events SHALL still be present with their epochs

### Requirement: Project B writes only its own schema

Project B SHALL own a dedicated PostgreSQL schema, SHALL NOT write to any archive table, and SHALL
obtain archive identity only as opaque values supplied by its caller. No table SHALL be written by
both the archive and project B.

#### Scenario: The full lifecycle runs with read-only archive privileges
- **WHEN** register, advance, pause, resume, revoke and delete run under a database role that has
  only `USAGE` and `SELECT` on the archive schema
- **THEN** every operation SHALL succeed
- **AND** every archive table's contents SHALL be unchanged

#### Scenario: The privilege control is not vacuous
- **WHEN** that same role attempts a direct write to an archive table
- **THEN** the database SHALL reject it

### Requirement: A restore keeps revoked monitors refused

A backup and restore procedure SHALL be documented, and the revocation record SHALL be kept outside
the database snapshot's rollback domain so it can be re-applied after a restore. After a restore to
a snapshot older than a revocation, re-applying the revocation list SHALL leave the affected
monitors refused, and scanning SHALL resume from the restored coverage without duplicates.

#### Scenario: A revoke that post-dates the snapshot is re-applied on boot
- **WHEN** a database is restored to a snapshot taken before a monitor was revoked, and the
  exported revocation list is re-applied
- **THEN** that monitor SHALL be refused again
- **AND** an advance against it SHALL be fenced

#### Scenario: Re-applying the list twice changes nothing
- **WHEN** the revocation list is applied a second time
- **THEN** no epoch SHALL change and no lifecycle event SHALL be appended

### Requirement: The archive is unaffected by project B

Installing project B's schema SHALL NOT change any existing migration, table or gate, and the
archive SHALL run with zero monitors and with project B's processes stopped.

#### Scenario: Existing gates pass with the B schema installed
- **WHEN** the repository's conformance gate runs with the `shielded_monitor` lineage present
- **THEN** it SHALL pass unchanged

#### Scenario: An empty monitor table is a healthy idle state
- **WHEN** the store is opened against a freshly bootstrapped, empty schema
- **THEN** listing active monitors SHALL return an empty list without error

### Requirement: At-rest protection of key material is deferred

At-rest encryption of the stored key, key-encryption-key rotation, fail-closed boot on missing key
material, keyed fingerprints, tenant isolation and the least-privilege role script are DEFERRED
with User Story 4. The alpha SHALL document that anyone with database access can read a registered
viewing key.

#### Scenario: The trust model is documented, not implied
- **WHEN** the security documentation and the restore procedure are read
- **THEN** both SHALL state that keys and associations are stored in plaintext in project B's
  schema and that the operator is trusted
