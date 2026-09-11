# shielded-monitor-scanner Specification (delta — change `00009-03-relevance-scanner`)

## Purpose

Defines the contract for **project B's relevance scanner**: how an archived transaction is
judged relevant to a registered viewing key, how a batch of whole block heights is committed,
how the scanner is bounded and scheduled, and how it stops rather than guessing. The monitor
store and lifecycle (`00009-02`) and the archive read contract (`00009-01`) are governed by their
own changes; the private HTTP API and the reference consumer (`00009-04`) are out of scope.

Traceability: organizer spec `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
User Stories 1, 2, 5 and 7; requirements FR-006..FR-014 and FR-026; success criteria SC-001,
SC-002, SC-006. User Story 4 (tenant isolation and confidentiality) is DEFERRED by owner decision
of 2026-09-10, so the scanner reads plaintext key material from B's schema; the requirement below
that would otherwise cover it says so explicitly.

## Requirements

### Requirement: Relevance is the ledger's own trial decryption over the guaranteed offer and every fallible segment

The scanner SHALL compute relevance by deserializing a regular transaction with the vendored
ledger v8 build and evaluating `EncryptionSecretKey.test(offer)` against the transaction's
guaranteed zswap offer and against the offer of EVERY fallible segment, SHALL record every
segment that matched, and SHALL NOT stop at the first match. System transactions SHALL be
skipped on the archive's `kind` without being deserialized. A transaction carrying no zswap
offer SHALL be reported as skipped rather than as an evaluated non-match.

#### Scenario: Every corpus transaction matches exactly what the manifest declares
- **WHEN** the fixture corpus is evaluated against each of its keys
- **THEN** the matched segment list for every (key, transaction) pair SHALL equal the list
  `test/fixtures/shielded-monitor/corpus.manifest.json` declares for it

#### Scenario: A positive whose only matching output is in a fallible segment names that segment
- **WHEN** a transaction whose only output encrypted to key K sits in fallible segment 2 is
  evaluated with K
- **THEN** the result SHALL be a match naming segment 2 and no other

#### Scenario: A transaction with two matching outputs is one match, not two
- **WHEN** a transaction carrying two outputs encrypted to key K in its guaranteed offer is
  evaluated with K
- **THEN** the result SHALL be a single match naming segment 0 once

#### Scenario: A system transaction is never deserialized
- **WHEN** a transaction whose archived `kind` is `system` is evaluated, and its bytes are not a
  decodable transaction payload
- **THEN** the result SHALL be `skipped` with reason `system-transaction`
- **AND** no ledger deserialization SHALL be attempted

#### Scenario: A reward-claim transaction carries no offer and is therefore never relevant
- **WHEN** a transaction produced by `Transaction.fromRewards` is inspected
- **THEN** it SHALL carry neither a guaranteed offer nor any fallible offer
- **AND** a transaction with no offers SHALL be reported as `skipped` with reason
  `no-zswap-offers`

#### Scenario: An output with no ciphertext is invisible to every key
- **WHEN** a transaction whose only output is contract-owned is evaluated with any registered key
- **THEN** the result SHALL be a non-match for every key
- **AND** this false-negative class SHALL be documented in the module that implements the
  predicate

### Requirement: A batch is whole block heights, committed with its coverage advance in one transaction

For one monitor, the scanner SHALL read `SCAN_BATCH_BLOCKS` WHOLE canonical finalized blocks
through the archive read contract, SHALL evaluate every regular transaction of those blocks, and
SHALL commit that batch's associations together with the coverage advance to the batch's LAST
block height in ONE database transaction in the `shielded_monitor` schema. A batch containing no
matches SHALL still commit its coverage advance. The scanner SHALL NOT issue SQL against any
archive table.

#### Scenario: Three blocks are one commit at the last height
- **WHEN** a batch of three whole blocks is scanned
- **THEN** exactly one coverage advance SHALL be issued, naming the third block's height

#### Scenario: A block with no matches still advances coverage
- **WHEN** a block containing only transactions relevant to other keys is scanned
- **THEN** no association SHALL be written and the monitor's `scannedThrough` SHALL advance to
  that block's height

#### Scenario: Only the monitor schema is written
- **WHEN** every statement the scanner issues during a batch is captured
- **THEN** every statement whose leading verb writes SHALL name a table in the `shielded_monitor`
  schema
- **AND** the same run SHALL have read the archive schema, so the audit covers a run that
  genuinely touched both

### Requirement: A crash during a batch leaves either none of a height or all of it

WHEN the scanner process or the database backend dies at any point during a batch, THEN after
restart the monitor SHALL show either no association of that height with coverage below it, or
every association of that height with coverage at it. No third state SHALL be observable, and a
redone batch SHALL produce the golden association set exactly once.

#### Scenario: Randomized database kills inside the batch transaction
- **WHEN** the writer's backend is terminated at a randomly chosen statement inside the batch
  transaction, over at least 200 points spanning heights with zero, one and two matches
- **THEN** every observation SHALL classify as exactly one of the two permitted states
- **AND** both states SHALL occur, including at least one interrupted height with matches and
  at least one with none
- **AND** the final association set SHALL contain no duplicate `(height, position)`

#### Scenario: The scanner process is SIGKILLed inside the transaction and after the commit
- **WHEN** a real child scanner process is SIGKILLed while paused inside the batch transaction
- **THEN** no association of that height SHALL exist and coverage SHALL be below it
- **WHEN** the same process is SIGKILLed immediately after the transaction committed
- **THEN** every association of that height SHALL exist and coverage SHALL be at it

#### Scenario: The unfolded shape is shown to be detectable
- **WHEN** associations are written and the coverage advance is applied as a SEPARATE statement,
  and the state between them is observed
- **THEN** the classification SHALL reject it as a Rule B violation

### Requirement: Every association carries provenance and an unknown applied outcome

Each association SHALL record network, block height, block hash, position, transaction hash,
protocol version, every matched segment id, the matching-rule version and the ledger build
identifier, and SHALL set `appliedOutcome` to `unknown`. WHERE the archive recorded a replay
outcome for that transaction, the scanner SHALL record it as `sourceOutcome`; it SHALL NOT be
promoted to `appliedOutcome`, and its absence SHALL NOT be rendered as a failure.

#### Scenario: An archive that recorded no outcome produces no sourceOutcome
- **WHEN** transactions archived by node-only ingest (which records no replay outcome) are
  matched
- **THEN** every resulting association SHALL have `appliedOutcome = "unknown"` and no
  `sourceOutcome`

### Requirement: Every worker write is fenced by the monitor's lifecycle epoch

The scanner SHALL pass the epoch it loaded to every write it makes — the coverage advance, the
failure stop, the stale-source stop, the live promotion and the archive-identity binding — and
SHALL treat a refusal as a refusal rather than retrying blindly.

#### Scenario: A pause between the load and the commit rejects the batch
- **WHEN** a monitor is paused after a worker has loaded it and before the worker commits
- **THEN** the commit SHALL be refused, no association SHALL be written, and coverage SHALL be
  unchanged

#### Scenario: Resuming continues with no duplicate and no gap
- **WHEN** the monitor is resumed and scanned to the tip
- **THEN** the association set SHALL equal the fixture manifest exactly, with no duplicate
  `(height, position)`

### Requirement: The scanner binds each monitor to the archive's identity and stops when it changes

The scanner SHALL read the archive's identity before each batch. WHERE a monitor carries no
binding, the scanner SHALL bind it first-write-wins and SHALL NOT overwrite an existing binding.
IF the archive's identity differs from the monitor's binding, THEN the scanner SHALL move the
monitor to `stale_source` and SHALL NOT read or commit that batch.

#### Scenario: A re-synced archive stops the monitor with its coverage intact
- **WHEN** the archive's instance id changes while the chain's genesis hash does not
- **THEN** the monitor SHALL enter `stale_source` with a typed `ARCHIVE_IDENTITY_CHANGED` reason
- **AND** its coverage SHALL be neither advanced nor rolled back

#### Scenario: An archive that cannot yet answer is not a mismatch
- **WHEN** the archive has no identity to report (not bootstrapped, or no genesis block archived)
- **THEN** the scanner SHALL treat the batch as "nothing to scan" and SHALL NOT mark anything
  stale

### Requirement: An unreadable transaction stops the monitor at its position and claims no coverage

IF a transaction's protocol version is outside the vendored ledger build's supported set, or its
bytes cannot be deserialized, THEN the scanner SHALL stop the monitor with a typed failure naming
the block height and position, and SHALL NOT advance coverage to or past that height.

#### Scenario: Undecodable bytes at height H leave coverage at H-1
- **WHEN** height H carries a `regular` transaction at a supported protocol version whose bytes
  the ledger cannot read
- **THEN** the monitor SHALL be `failed` with `atHeight = H` and `atPosition` recorded
- **AND** `scannedThrough` SHALL remain below H

#### Scenario: The failure reason carries no key material
- **WHEN** the recorded failure reason is inspected
- **THEN** it SHALL contain no viewing key and no Bech32m key prefix

### Requirement: Key material lives for exactly one batch

The scanner SHALL deserialize the monitor's viewing key at the start of a batch, SHALL clear the
resulting handle before the batch returns including when the batch throws, and SHALL NOT retain
or share a key handle between monitors or between batches. At-rest protection of the stored key
is DEFERRED with organizer User Story 4.

#### Scenario: The handle is cleared even when the predicate throws
- **WHEN** a batch fails part-way through because a transaction cannot be decoded
- **THEN** exactly one key deserialization and exactly one clear SHALL have occurred

#### Scenario: Two monitors never share a handle
- **WHEN** two monitors are scanned in succession
- **THEN** each batch SHALL have obtained its own handle

### Requirement: Scan work is bounded and reported without sensitive labels

The scanner SHALL bound its work by configuration — whole blocks per batch, monitors scanned in
parallel, monitors picked up per cycle, batches per monitor per cycle, and an optional per-monitor
transactions-per-second ceiling — SHALL refuse a malformed bound rather than substituting a
default, and SHALL report transactions scanned, matches, blocks scanned and lag WITHOUT any label
identifying a monitor.

#### Scenario: A malformed bound is refused by name
- **WHEN** a numeric setting is zero, negative, fractional or non-numeric
- **THEN** startup SHALL fail with a message naming that variable

#### Scenario: Metrics cannot carry a monitor id
- **WHEN** the metrics sink is inspected
- **THEN** its label type SHALL admit only the network
- **AND** a serialized snapshot SHALL contain no monitor id

### Requirement: The scanner follows the archive tip promptly and correctly

The scanner SHALL run at most one ordered worker per monitor, SHALL scan at most
`SCAN_CONCURRENCY` monitors concurrently, SHALL subscribe to the archive's transactional progress
notification for prompt wake-up, and SHALL ALSO poll on `SCAN_POLL_MS` so that a missed or
undeliverable notification cannot stall the tail. WHERE the subscription cannot be established,
the scanner SHALL continue on the polling fallback rather than refusing to start.

#### Scenario: A newly archived block is picked up without waiting for the poll timer
- **WHEN** the polling interval is set far beyond the observation window and a new block carrying
  a match is archived
- **THEN** the new association SHALL appear

#### Scenario: A monitor that has reached the tip is promoted to live
- **WHEN** coverage reaches the tip reported in the same page read
- **THEN** the monitor SHALL transition from `backfilling` to `live`

### Requirement: The scanner ships as its own process

The scanner SHALL be runnable as a CLI entry point of the same package, separate from the archive
ingester, configured entirely from the environment, and SHALL bootstrap only its own schema.

#### Scenario: The binary is built and pointed at a real entry point
- **WHEN** the package's CLI build runs
- **THEN** the `umbradb-shielded-monitor` bin entry SHALL resolve to a compiled file
