# shielded-monitor-match-details Specification (delta — change `00009-07-match-details`)

## Purpose

Defines what the service records, stores and shows about the **contents** of a matched transaction:
the public zswap data the scanner already holds when it decides relevance, the time of the block the
transaction sat in, and the three-valued attribution of each output and transient to the monitor's
key.

Relevance itself is governed by `00009-03-relevance-scanner`, storage and lifecycle by
`00009-02-monitor-store`, the consumer wire contract by `00009-04-private-api-cli`, and the operator
surface by `00009-06-dashboard`. This delta adds to those contracts and changes none of them.

Traceability: organizer spec `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
User Stories 1, 2 and 5; requirements FR-006, FR-008, FR-009, FR-010, FR-011, FR-012, FR-017,
FR-019, FR-020, FR-025, FR-027, FR-028. User Story 4 is DEFERRED by owner decision of 2026-09-10.
The three-valued attribution is organizer question **Q22 `[07]`**, DEFAULT-APPLIED.

## Requirements

### Requirement: A match records the transaction's public zswap data

For every association it writes, the scanner SHALL record the public zswap data of that
transaction, per segment: for every output its index and coin commitment and, when present, the
contract address it is delivered to; for every input its index and nullifier; for every transient
its index, commitment and nullifier. The recorded data SHALL be derived from the SAME extracted
offers and the SAME per-segment relevance results that produced the association's matched-segment
list. The record SHALL name the ledger build and the rule version that produced it.

#### Scenario: Every commitment and nullifier of the offer is recorded
- **GIVEN** a matched transaction whose offer holds outputs, inputs and transients
- **WHEN** the association is written
- **THEN** the recorded output commitments SHALL equal the offer's own, in the offer's order
- **AND** the recorded input nullifiers and transient commitment/nullifier pairs SHALL likewise
  equal the offer's own

#### Scenario: The recorded segments cannot disagree with the match
- **WHEN** a match's details are read back
- **THEN** the segments they report as matched SHALL equal the association's `matchedSegments`

#### Scenario: A transaction that does not match records nothing
- **WHEN** a transaction is evaluated and no segment matches
- **THEN** no association and therefore no details SHALL be written
- **AND** no additional trial decryption SHALL have been performed for it

#### Scenario: Lists are capped and truncation is visible
- **GIVEN** a segment holding more entries than the per-list cap
- **WHEN** its details are recorded
- **THEN** the stored list SHALL hold at most the cap
- **AND** the record SHALL carry a truncation flag and the TRUE count of every list, so a truncated
  list can never read as a short one

### Requirement: Attribution states only what the ledger entails

Each output and transient SHALL carry an attribution with exactly three values — yours, not yours,
and not attributable. The service SHALL NOT report an entry as the monitor's own unless the ledger's
own relevance semantics entail it, and SHALL NOT report an entry as not the monitor's own unless
they entail that.

#### Scenario: Nothing in an unmatched segment is yours
- **GIVEN** a segment whose relevance test returned false
- **THEN** every output and transient of that segment SHALL be attributed "not yours"

#### Scenario: A contract-owned entry is nobody's
- **GIVEN** an entry that names a contract address
- **THEN** it SHALL be attributed "not yours", in a matched segment as well as an unmatched one

#### Scenario: A single candidate in a matched segment is yours
- **GIVEN** a matched segment in which exactly one entry could carry a user ciphertext
- **THEN** that entry SHALL be attributed "yours"

#### Scenario: Two or more candidates are reported as unknown, with their number
- **GIVEN** a matched segment in which two or more entries could carry a user ciphertext
- **THEN** each of them SHALL be attributed "not attributable"
- **AND** the segment SHALL report how many candidates it holds, so "at least one of these n is
  yours" is expressible

#### Scenario: Nothing claims an amount or a spend
- **WHEN** any details record is read
- **THEN** it SHALL carry no coin value, no balance and no claim that the monitor spent anything
- **AND** the association's applied outcome SHALL remain "unknown"

### Requirement: A match records the time of its block

For every association it writes, the scanner SHALL record the block timestamp the archive published
for that height through the read contract. When the archive has no timestamp for that height, the
association SHALL record none rather than a substituted value.

#### Scenario: The recorded time is the archive's
- **WHEN** a match's block time is read back
- **THEN** it SHALL equal the timestamp the read contract reported for that block

#### Scenario: An unknown time is absent, never zero
- **GIVEN** a block the archive holds no timestamp for
- **THEN** the association SHALL record no block time, and no reader SHALL present one

### Requirement: Details and coverage commit together

A block height's associations, their details, their block times and the monitor's coverage advance
to that height SHALL commit in ONE database transaction in the monitor's own schema. No state SHALL
be durably observable in which a height's associations exist without their details.

#### Scenario: A crash leaves none of a height or all of it
- **GIVEN** the scanner is committing a height that carries matches
- **WHEN** the process or the database dies at any statement of that transaction
- **THEN** after restart either no association of that height exists and coverage is below it, or
  every association of that height exists WITH its details and its block time and coverage is at it

#### Scenario: A detail-less height is refused as partial
- **GIVEN** an observation in which a height's associations exist but one carries no details
- **WHEN** it is classified
- **THEN** it SHALL be reported as a partial batch, not as a complete one

### Requirement: Existing matches can be filled in without re-scanning

The service SHALL provide a command that records details for associations written before this data
existed. It SHALL read blocks only through the archive read contract, SHALL write only the details
and block-time columns, and SHALL NOT move coverage or alter any other column of any association.

#### Scenario: The backfill fills each row exactly once
- **GIVEN** associations with no details recorded
- **WHEN** the backfill runs
- **THEN** each SHALL be filled once
- **AND** a second run SHALL fill nothing and report zero

#### Scenario: A filled row is indistinguishable from one recorded live
- **WHEN** a backfilled association is compared with the same association recorded at match time
- **THEN** their details and block times SHALL be equal

#### Scenario: A row that cannot be tied to its block is skipped, not guessed
- **GIVEN** an association whose height the archive no longer holds, or whose block hash,
  transaction position or transaction hash no longer agree with the archive, or whose
  re-evaluation no longer reproduces its matched segments
- **WHEN** the backfill visits it
- **THEN** it SHALL leave the row unrecorded and count the reason
- **AND** it SHALL continue with the monitor's remaining associations

#### Scenario: A lifecycle transition fences the backfill
- **GIVEN** a backfill in progress for a monitor
- **WHEN** a lifecycle transition changes the monitor's epoch before the commit
- **THEN** the commit SHALL be refused and nothing SHALL be written
- **AND** a later run SHALL continue from the rows still unrecorded

#### Scenario: Closed monitors are refused
- **WHEN** the backfill reaches a revoked monitor
- **THEN** it SHALL refuse that monitor and continue with the others
- **AND** a deleted monitor SHALL be indistinguishable from one that never existed

### Requirement: The API exposes the details and the block time

The matches endpoint SHALL carry each item's block time and details. An unrecorded value SHALL be
present as an explicit null rather than an omitted field. A caller SHALL be able to request the
pre-existing item shape, in which both fields are absent entirely.

#### Scenario: A match with nothing recorded reports null, not an omitted field
- **WHEN** a match written before this change is returned
- **THEN** both fields SHALL be present with null values

#### Scenario: Heights and times are strings
- **WHEN** a block time is returned
- **THEN** it SHALL be a decimal string, never a JSON number

#### Scenario: The opt-out returns the previous shape exactly
- **WHEN** the caller asks for the matches page without details
- **THEN** neither the block time nor the details field SHALL be present
- **AND** every other field SHALL be identical to the default response's

#### Scenario: An unrecognised opt-out value includes the data
- **WHEN** the caller supplies any value other than the documented opt-out
- **THEN** the fields SHALL be included

### Requirement: The dashboard shows a match's contents on demand

The dashboard SHALL let an operator expand any match to see its block time, its per-segment
outputs, inputs and transients with copyable hashes, the attribution of each entry, and a legend
explaining the terms. A match with nothing recorded SHALL say so and name the backfill.

#### Scenario: The collapsed row summarises what is inside
- **WHEN** a match with details is listed
- **THEN** its row SHALL show the block time and a summary naming how many entries are the
  monitor's own and how many commitments, nullifiers and transients the transaction holds

#### Scenario: The expanded row shows the public data per segment
- **WHEN** a match is expanded
- **THEN** the panel SHALL show the block time in UTC with a relative age, and for each segment
  whether it matched and its outputs, inputs and transients with their commitments, nullifiers and
  contract addresses
- **AND** each hash SHALL be copyable

#### Scenario: The three attribution values are visually distinct
- **WHEN** an entry is not attributable
- **THEN** the page SHALL render it distinctly from "not yours", and the legend SHALL explain the
  difference

#### Scenario: A match with no details points at the backfill
- **WHEN** a match with nothing recorded is expanded
- **THEN** the panel SHALL say the details are not recorded yet and name the backfill command
- **AND** it SHALL NOT present the match as a transaction with no outputs

#### Scenario: The page stays self-contained
- **WHEN** the page is served
- **THEN** it SHALL reference no external origin and SHALL remain under the Content Security Policy
  already in force, with the hashes recomputed from the served bytes
