# chain-archive-node-ingest (implementation)

The archive's ingest SOURCE: building `chain_archive` from a Midnight node's JSON-RPC alone,
in place of the `midnight-indexer` GraphQL API.

Deliberately narrow. This capability changes WHERE the archive's contents come from; it does not
change what the archive means, what is derived from it, or what any consumer reads. The
projection, the read views, the effectstream sync protocol and the differential-parity harness
build ON this and are specified separately -- they are not prerequisites for substituting the
source, and holding them together made a source substitution look like a feed rewrite.

Requirements below follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous
("The system SHALL..."), Event-driven ("WHEN \<trigger>, the system SHALL..."), Unwanted-behavior
("IF \<trigger>, THEN the system SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."),
or Optional-feature ("WHERE \<feature>, the system SHALL...") form.

## ADDED Requirements

### Requirement: an archived transaction is selected by its dispatched call, and typed by its payload

The system SHALL determine WHETHER an extrinsic carries a Midnight transaction from the
`(pallet, call)` it dispatches to, resolved from the runtime metadata of the block being decoded.
It SHALL determine WHICH KIND of transaction it is from the payload's own self-description, and
SHALL refuse the block when the two disagree.

*Revised 2026-08-11 (audit A1). The earlier form said kind SHALL NOT be determined from the
payload. That was wrong in a way tests did not catch: taking kind from the call alone means a
payload reaching the "wrong" call is archived under a kind its own bytes contradict, and every
consumer filtering on `kind` then reads it as something it is not. The reference derives type from
the payload it deserializes, so the two sources must agree — ingest does not get to pick a winner
between the runtime's dispatch and the transaction's self-description.*

#### Scenario: the dispatched call and the payload disagree about kind

- **WHEN** an extrinsic dispatches to the regular Midnight call but its payload decodes as a system
  transaction, or the reverse
- **THEN** the system SHALL refuse the block rather than archive a row whose recorded kind its own
  bytes contradict

#### Scenario: tagged bytes under a call that is not a Midnight call are ignored

- **WHEN** an extrinsic carries a payload bearing a Midnight self-tag but dispatches to a call that
  is not one of the Midnight transaction calls
- **THEN** the system SHALL ignore it, exactly as the reference does — it extracts only
  `send_mn_transaction` and `send_mn_system_transaction` from the decoded call, regardless of
  payload content

*Revised 2026-08-11 (Stage 2). The earlier form required REFUSING the block here. That refusal
existed only because classification keyed off a forgeable payload tag plus PINNED pallet indices,
which made a forgery indistinguishable from a runtime that had renumbered its pallets. Reading the
indices from the runtime's own metadata removes the ambiguity: renumbering is followed, and forged
tag bytes under some other pallet's call are simply not a Midnight call. Ignoring them is parity;
refusing would also have discarded any genuine transaction sharing that block.*

### Requirement: ingest halts on a runtime it cannot decode

The system SHALL accept only protocol versions whose ledger codec it implements, and SHALL resolve
call numbering from the metadata of the block being decoded rather than from assumed constants. It
SHALL halt, naming the offending version, when the ledger codec is unsupported, when that metadata
cannot be obtained from any source, or when metadata-derived numbering disagrees with a pinned
entry that exists for the same version.

*Revised 2026-08-11 (Stage 2). The earlier form required verified call numbering as a precondition,
which made an otherwise-decodable runtime unusable until someone observed and pinned its indices.
The runtime describes its own numbering, so that precondition is gone; the pinned table survives
only as a cross-check, and a disagreement between two independent sources still halts, because one
of them would make genuine transactions vanish.*

#### Scenario: a supported ledger version with unverified call numbering is still refused

- **WHEN** a block's protocol version has a supported ledger codec but no verified call-index
  mapping
- **THEN** the system SHALL halt with an error identifying what is missing

#### Scenario: the gate does not affect indexer-sourced ingest

- **WHILE** ingesting from an indexer
- **THEN** node-side classification SHALL NOT be required, so a runtime this build cannot classify
  does not break a path that does not depend on classification

### Requirement: the archive refuses to mix chains

The system SHALL verify that each ingested block's parent is the block already archived beneath
it, and that the node serves the same chain the archive already holds, before writing.

#### Scenario: a foreign parent is rejected

- **WHEN** a block's parent hash is not the archived block at the preceding height
- **THEN** the system SHALL refuse the block and SHALL NOT advance the cursor

#### Scenario: identity is anchored on the archive, not on a stored claim

- **WHEN** an archive already holds a genesis block and the configured node serves a different one
- **THEN** the system SHALL refuse to ingest
- **AND** an archive holding no blocks SHALL NOT be able to record an identity that later prevents
  ingesting the correct chain

### Requirement: replay uses the node's real parent timestamp

The system SHALL persist each replayed block's real `Timestamp::set` value and SHALL use that value
as the next block's `lastBlockTime`, matching the target node's ledger fold.

This is a deliberate authority exception to the pinned reference indexer. The indexer seeds parent
time with zero when its process starts (`chain-indexer/src/application.rs:150`), substitutes the
current block's timestamp for that sentinel (`:328`), and only then carries the observed timestamp
forward (`:386`). Its result therefore depends on whether a process restarted between two blocks,
which cannot be reproduced from an archive. The target node's fold
(`midnight-node/ledger/src/versions/common/api/ledger.rs:125-205`) has no such restart-dependent
sentinel, so node semantics are authoritative for replay parent time.

#### Scenario: parent time changes a dust-affecting fold

- **WHEN** a committed transaction fixture makes node parent-time semantics and the indexer's
  zero-sentinel semantics produce different dust-affecting ledger states
- **THEN** replay SHALL match the native node-semantics state
- **AND** SHALL differ from the committed indexer-sentinel counterweight

### Requirement: catch-up is finalized-only and refuses disconnected canonical rows

Replay/catch-up SHALL support the finalized-only writer used by node ingest. Arbitrary historical
canonical states produced by height-at-a-time `setCanonical` reorg flips are outside this read
contract; full ancestry-bound checkpoint selection is deferred under O2.

#### Scenario: individually canonical rows do not form one chain

- **WHEN** catch-up selects a canonical row whose parent hash differs from the block just replayed
- **THEN** it SHALL refuse rather than splice the two branches
- **AND** the refusal SHALL name both the stored parent hash and the just-replayed hash

### Requirement: node-only ingest is provably free of the indexer

The system SHALL support ingest with no indexer configured, and that mode SHALL issue no request
to any indexer endpoint.

#### Scenario: no indexer request is made

- **WHEN** a sync runs with no indexer configured
- **THEN** no request to an indexer endpoint SHALL be issued, demonstrated by observing the
  requests actually made rather than by inspecting configuration

#### Scenario: the test environment does not require an indexer

- **WHEN** the node-only gate runs
- **THEN** it SHALL be able to run in an environment where no indexer service exists at all

### Requirement: system transactions are archived, or ingest refuses

The system SHALL archive a block's system transactions under the ledger's own transaction hash, and
SHALL refuse to write a block whose system transactions it cannot so key, rather than writing that
block without them.

Refusal rather than omission is required because every terminal insert is `ON CONFLICT DO NOTHING`:
an archive written without them cannot be repaired by re-ingesting the range later, so a silent
omission is permanent.

#### Scenario: an extrinsic-borne system transaction is archived

- **WHEN** a block carries a system transaction as an extrinsic
- **THEN** it SHALL be archived with `kind = 'system'` and the ledger's transaction hash
- **AND** its `position` SHALL be assigned from the same counter as regular transactions, in
  extrinsic order, so both ingest sources agree on ordering

#### Scenario: an unhashable system transaction stops the block

- **WHEN** the loaded ledger build cannot produce a system transaction's hash
- **THEN** ingest SHALL refuse the block, naming the missing capability
- **AND** SHALL NOT write the block without it

### Requirement: only node-sourced ingest evidence gates cutover

The system SHALL run the comparison twice — once with the archive ingesting transaction bytes from
the indexer, once ingesting from node JSON-RPC alone — and SHALL treat only the node-sourced run as
evidence that the pipeline survives indexer shutdown (`design.md` §7).

#### Scenario: An indexer-sourced pass does not authorize cutover

- **WHEN** the comparison passes with the archive ingesting from the indexer
- **THEN** the result SHALL be recorded as validating decode and transport only
- **AND** SHALL NOT be presented as evidence of indexer independence

#### Scenario: Node-sourced ingest reproduces the archived bytes

- **WHEN** transaction bytes are ingested from node JSON-RPC with the outer SCALE envelope stripped
- **THEN** the resulting `tx_raw` SHALL equal the bytes the indexer-sourced path archived for the
  same transaction


### Requirement: indexer ground truth is captured for all six primitives while the indexer runs

The system SHALL capture and commit indexer-sourced ground-truth fixtures covering the source fields
of all six Midnight primitives over a pinned block range, not only the primitive being migrated,
because every such claim becomes unfalsifiable once the indexer is retired (`proposal.md`).

#### Scenario: Fixtures cover primitives not migrated in this sprint

- **WHEN** the captured fixture set is examined
- **THEN** it SHALL include the indexer fields backing all six primitives
- **AND** SHALL be committed to the repository rather than held only in a transient environment

#### Scenario: Capture records its provenance

- **WHEN** a fixture is captured
- **THEN** it SHALL record the indexer version, the network, and the block range it came from
