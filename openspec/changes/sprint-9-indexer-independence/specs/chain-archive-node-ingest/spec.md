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

### Requirement: an archived transaction is classified by the call that dispatched it

The system SHALL determine whether an extrinsic carries a Midnight transaction from the
`(pallet, call)` it dispatches to, resolved for the block's protocol version, and SHALL NOT
determine it from the payload's contents.

#### Scenario: bytes shaped like a transaction under another call are refused

- **WHEN** an extrinsic carries a payload bearing a Midnight self-tag, but dispatches to a call
  that is not the Midnight transaction call
- **THEN** the system SHALL NOT archive it as a transaction
- **AND** SHALL refuse the block rather than complete it, because the same signal is produced by a
  runtime that renumbered its pallets, in which case the unrecognized payloads are genuine
  transactions that would otherwise be dropped silently

#### Scenario: the self-tag corroborates but does not decide

- **WHEN** the dispatched call and the payload's self-tag disagree about the transaction kind
- **THEN** the system SHALL refuse the extrinsic

### Requirement: ingest halts on a protocol version it cannot decode

The system SHALL accept only protocol versions whose ledger codec it implements AND whose runtime
call numbering it has verified, and SHALL halt naming the offending version rather than decode an
unknown runtime with assumed constants.

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

### Requirement: system transactions are excluded from the feed and from both sides of the comparison

The system SHALL scope the feed to outputs created by regular transactions only, and SHALL apply the
same exclusion to the indexer-sourced side of every comparison, so the two sides are compared over
the same population (`design.md` §6, owner decision).

#### Scenario: The indexer side is filtered to match

- **WHEN** a comparison range contains a system transaction that created unshielded outputs
- **THEN** those outputs SHALL be excluded from the indexer-sourced side before comparison
- **AND** the comparison SHALL NOT fail on their absence from the UmbraDB side


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
