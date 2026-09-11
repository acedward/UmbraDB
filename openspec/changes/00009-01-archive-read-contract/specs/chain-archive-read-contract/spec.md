# chain-archive-read-contract (implementation)

How a SECOND process reads this archive, and what the archive guarantees about the state it
leaves behind after a crash.

Deliberately narrow. This capability changes nothing about what is ingested, from where, or how it
is decoded. It adds one read surface, one identity, one column, and one atomicity guarantee over
writes that were already happening.

Requirements below follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous
("The system SHALL..."), Event-driven ("WHEN \<trigger>, the system SHALL..."), Unwanted-behavior
("IF \<trigger>, THEN the system SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."),
or Optional-feature ("WHERE \<feature>, the system SHALL..." ) form.

## ADDED Requirements

### Requirement: the archive's read surface for a second process carries no storage types

The system SHALL expose reading the archive through an interface that declares no SQL, no driver
type, no content-address, no partition, no canonical/finalized flag and no watermark row — only
plain data: numbers, strings and byte arrays.

*A consumer typed against this interface cannot reach the archive's tables, which is what makes
"B's only access to A is read-only" (`spec/00009` FR-025) a structural fact rather than a
convention. It is also what allows the same interface to be served across a process boundary
later, to a consumer running separately or inside a TEE, without giving it schema access.*

#### Scenario: the read surface and the write surface are different objects

- **WHEN** a consumer is given the archive's read contract
- **THEN** the object it holds SHALL NOT expose any write operation of the archive store

#### Scenario: a payload's identity does not leak into the contract

- **WHEN** a consumer receives a transaction from the read contract
- **THEN** it SHALL receive the raw bytes themselves, and SHALL NOT receive the content address,
  blob role, or any other locator by which the archive stores them

---

### Requirement: history is paged as whole blocks, in commit order, from a remembered height

The system SHALL return, for a network and an exclusive `afterHeight`, the next canonical
finalized blocks in ascending height order, each with its identity, its parent, its timestamp when
known, and every transaction it holds in ascending position order, bounded by a caller-supplied
maximum number of BLOCKS.

*The page unit is a whole block height because that is the archive's own write unit and the
scanner's own commit unit. A page that could split a block would force a consumer to invent a
sub-block commit unit, and a crash inside one would leave a height half-processed with nothing
able to record that.*

#### Scenario: a page never contains part of a block

- **WHEN** a reader pages an archive with any maximum page size
- **THEN** every returned block SHALL carry its complete transaction set, and no block SHALL
  appear in two pages

#### Scenario: a block with hundreds of transactions

- **WHEN** a block holds far more transactions than a page would normally carry
- **THEN** the system SHALL return that block whole, as a page of one block, rather than splitting
  it or refusing it

#### Scenario: concatenating pages reproduces the canonical sequence exactly

- **WHEN** a reader concatenates every page it receives, for any page size
- **THEN** the result SHALL equal the archive's canonical finalized sequence exactly — same
  blocks, same order, same transactions per block, same bytes

#### Scenario: resuming after a restart

- **GIVEN** a reader recorded the height of the last block it received and then restarted
- **WHEN** it resumes paging from that height
- **THEN** the results SHALL continue with no gap and no repeat

#### Scenario: a reader at the tip

- **WHEN** a reader pages from the archive's current tip
- **THEN** the system SHALL return an empty page AND still report the tip, so that "nothing new"
  remains distinguishable from "nothing at all"

#### Scenario: a start height above the tip

- **WHEN** a reader pages from a height above everything the archive holds
- **THEN** the system SHALL return an empty page with the current tip, and SHALL NOT treat the
  request as an error

---

### Requirement: a page and the tip it is compared against are one observation

The system SHALL read the blocks of a page and the archive's current tip within a single database
snapshot.

*A consumer distinguishes "scanned, nothing matched" from "not scanned yet" by comparing its
coverage against the tip (`spec/00009` FR-011, FR-020). If the tip could be read from a different
moment than the blocks, a consumer could observe itself ahead of the archive, and that distinction
would collapse.*

#### Scenario: the archive advances during a read

- **WHEN** a block is committed between the two reads a page would otherwise perform
- **THEN** the returned tip SHALL NOT be lower than the highest block in the same page

---

### Requirement: returned bytes are verified against their content address

The system SHALL recompute the content address of every raw payload it returns and SHALL refuse
the read if the recomputation disagrees.

*Reading a page in bulk must not be a way to receive bytes that a single-blob read would have
refused.*

#### Scenario: a payload corrupted in storage

- **WHEN** a stored payload's bytes no longer hash to the address they are stored under
- **THEN** the system SHALL raise a typed integrity error and SHALL NOT return the bytes

---

### Requirement: a discontinuity in canonical history is refused, never smoothed over

IF the canonical finalized rows a page spans are not parent-linked — a missing height, or a block
whose parent is not the block below it — THEN the system SHALL raise a typed discontinuity error
naming the height and both hashes, and SHALL NOT return the page.

*Returning the rows as found would produce a sequence that reads as contiguous history — heights
ascend, every block is whole — while silently omitting part of it, and a consumer would then record
coverage over a range it never saw. The archive's own writer cannot produce this state, so it means
the archive was assembled or damaged by something else.*

#### Scenario: a hole between two canonical blocks

- **WHEN** a page spans heights H and H+2 with H+1 absent
- **THEN** the system SHALL raise the discontinuity error rather than return two blocks

#### Scenario: a page beginning above the archive's earliest retained height

- **WHEN** a reader starts below the earliest height the archive still retains
- **THEN** the system SHALL return the blocks it has, beginning at that earliest height, and SHALL
  NOT treat the reader's lower start as a discontinuity

---

### Requirement: the archive can state who it is, wholly or not at all

The system SHALL expose an identity for a network consisting of the network, the archived genesis
block's hash and an archive instance identifier, and SHALL report that identity as unavailable
until every part of it is known.

The instance identifier SHALL be 128 bits of cryptographically random data, minted once for a
network in a given archive database, unchanged by any later call, and SHALL be different in an
archive database that was rebuilt.

*A consumer's persisted coverage is a claim about a specific archive's history. Without an instance
identifier, a rebuilt archive that has only reached a lower height is indistinguishable from the
original archive going backwards. A partially-known identity is withheld rather than reported,
because binding to half of one and seeing the other half arrive later is indistinguishable from
the archive having changed.*

#### Scenario: an archive that has not ingested genesis yet

- **WHEN** the identity is read from an archive whose block 0 is not archived
- **THEN** the system SHALL report the identity as unavailable rather than reporting a partial one

#### Scenario: the identity is stable

- **WHEN** the identity is read repeatedly, and after a restart
- **THEN** every read SHALL return the same instance identifier

#### Scenario: the archive is rebuilt

- **WHEN** the archive is dropped and the same chain is synced into a new archive database
- **THEN** the network and genesis hash SHALL be unchanged and the instance identifier SHALL differ

#### Scenario: two bootstraps race

- **WHEN** two processes bootstrap the same archive concurrently
- **THEN** exactly one identifier SHALL be stored and both processes SHALL observe that same one

#### Scenario: a malformed identity is present

- IF the identity record exists but is not a well-formed identifier
- **THEN** the system SHALL refuse rather than mint a second identity over it

---

### Requirement: a block carries its own timestamp

The system SHALL record a block's own `Timestamp::set` value on the block, and SHALL distinguish
"not decoded" from any decoded value.

WHERE the ingest mode has already resolved the block's runtime metadata, the system SHALL record
the timestamp as the block is archived. WHERE it has not, the system SHALL record no timestamp
rather than acquiring metadata it would not otherwise need.

*The value lives in the block body and recovering it requires the runtime metadata of the block
that produced it. Storing it once removes that work — and that dependency — from every consumer.
Indexer-sourced ingest deliberately resolves no metadata, which is what lets it run against a
pruned node; fetching some just to fill a column would silently change what that mode requires.*

#### Scenario: a block archived before the column existed

- **WHEN** such a block is read
- **THEN** its timestamp SHALL be reported as unknown, and SHALL NOT be reported as zero or as any
  substituted value

#### Scenario: filling in older blocks

- **WHEN** the backfill runs against an archive holding blocks with no recorded timestamp
- **THEN** it SHALL decode each one from the archive's OWN stored body and metadata, without
  contacting a node or an indexer, and SHALL only write where no timestamp is recorded

#### Scenario: a block the backfill cannot decode

- **WHEN** a block's timestamp cannot be decoded from what the archive holds
- **THEN** the backfill SHALL report that block and leave its timestamp unrecorded, and SHALL NOT
  substitute a value; the run SHALL report a non-zero outcome

---

### Requirement: everything the archive writes for one block height commits together

The system SHALL write the block row, its transactions, its bridge observations, its block
timestamp, its replay checkpoint when one is due, and the sync watermark for that height inside ONE
database transaction.

IF the writing process or the database fails at any point, THEN after recovery exactly two states
SHALL be observable for that height: none of it, with the watermark below it; or all of it,
including the watermark.

*This is the owner's Rule A (`spec/00009` User Story 5, FR-029). Recovery then needs no reasoning
at all: continue from the last committed height. The previous shape committed the bundle, then the
checkpoint, then the watermark, in three transactions — each intermediate state durable and
observable.*

#### Scenario: the writer process is killed mid-transaction

- **WHEN** the process is killed at any statement of the height's transaction
- **THEN** no row of that height SHALL be observable and the watermark SHALL be below it

#### Scenario: the database kills the writer's connection mid-transaction

- **WHEN** the connection running the height's transaction is terminated at any statement
- **THEN** the observable state SHALL again be none of the height, with the watermark below it

#### Scenario: the writer is killed immediately after the commit returns

- **WHEN** the process dies after the transaction committed but before it does anything else
- **THEN** every row of that height SHALL be observable AND the watermark SHALL name that height

#### Scenario: retrying a height after a crash

- **WHEN** the same height is written again after an interrupted attempt
- **THEN** it SHALL commit whole, and re-writing an already-committed height SHALL remain a silent
  no-op

#### Scenario: the watermark cannot regress

- **WHEN** a height's transaction would write a watermark lower than the one already stored
- **THEN** the stored watermark SHALL be left unchanged

#### Scenario: a checkpoint that describes another block

- IF a height's transaction is given a replay checkpoint naming a different network, height or
  block hash
- **THEN** the system SHALL refuse before writing anything, rather than commit a checkpoint that
  would be resumed against a state that is not its own

---

### Requirement: progress notification is bound to the commit and promises nothing

WHERE a wake-up channel is configured, the system SHALL emit a progress notification carrying the
network and height inside the height's own transaction, so it is delivered if and only if that
height committed.

The system SHALL NOT depend on any consumer receiving it: polling remains the means by which a
consumer discovers new history.

#### Scenario: a height that rolls back

- **WHEN** a height's transaction is interrupted and rolled back
- **THEN** no notification for that height SHALL be delivered

#### Scenario: a listener that was not connected

- **WHEN** a consumer connects after a height committed
- **THEN** it SHALL still discover that height by reading, without the notification

---

### Requirement: the archive's own replay verdict is persisted only where it can be attributed exactly

WHERE replay validation is enabled, the system SHALL record the replay outcome of each REGULAR
transaction on that transaction's archived row.

IF the archive's row order and the ledger's execution order cannot be matched exactly for a block
— by count, or byte-for-byte per pair — THEN the system SHALL record no outcome for any
transaction of that block.

*The archive lists event-borne system transactions first, in reference-compatible order; the ledger
applies transactions in execution order. The two agree exactly on the regular subsequence and
nowhere else, and an outcome attributed to the wrong transaction is worse than an absent one
because nothing downstream can tell it is wrong. A system transaction's outcome is not one of the
values the column admits.*

#### Scenario: a block mixing system and regular transactions

- **WHEN** such a block is archived with replay validation enabled
- **THEN** each regular transaction SHALL carry its own replay outcome and each system transaction
  SHALL carry none

#### Scenario: the two orderings disagree

- **WHEN** the regular transactions of the archive's rows and of the execution order differ in
  count or in bytes
- **THEN** every transaction of that block SHALL be archived with no outcome, and the disagreement
  SHALL be recorded for diagnosis

#### Scenario: replay validation is off

- **WHEN** a block is archived without replay validation
- **THEN** no outcome SHALL be recorded, exactly as before

---

### Requirement: offers are extracted only under a ledger build that can read them

The system SHALL refuse, with a typed error naming the version, to deserialize a transaction whose
protocol version is outside the set the pinned ledger build decodes, and SHALL use the same
supported-version definition as ingest.

*A later ledger's bytes read with an earlier codec produce a wrong answer rather than an error, and
a consumer that treated such a range as scanned-with-no-matches would never revisit it
(`spec/00009` FR-007).*

#### Scenario: a transaction from an unsupported protocol version

- **WHEN** offer extraction is asked for such a transaction
- **THEN** it SHALL raise the typed unsupported-version error before loading or invoking the ledger

#### Scenario: a system or reward-claim payload

- **WHEN** offer extraction is asked for bytes that are not a standard transaction
- **THEN** it SHALL raise a typed error rather than return an empty offer set that would read as
  "examined, nothing found"

#### Scenario: the recorded ledger build identifies the ledger actually used

- **WHEN** an association records the ledger build that produced it
- **THEN** that identifier SHALL name the same build the archive's own replay records
