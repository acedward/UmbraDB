# umbra-primitive-feed (implementation)

The UmbraDB-sourced feed that supplies effectstream's Midnight primitives with chain data in place
of the `midnight-indexer` GraphQL API, and the differential-parity harness that proves the feed
equivalent to the indexer while the indexer still exists to compare against.

Requirements below follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous
("The system SHALL..."), Event-driven ("WHEN \<trigger>, the system SHALL..."), Unwanted-behavior
("IF \<trigger>, THEN the system SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."),
or Optional-feature ("WHERE \<feature>, the system SHALL...") form — as in Sprint 2's, Sprint 4's,
Sprint 7's, and Sprint 8's spec files.

Scope is the harness plus exactly one primitive, `Midnight:UnshieldedCreate`. The other five
Midnight primitives are staged in `proposal.md` and are **not** covered by any requirement here.

## ADDED Requirements

### Requirement: decoded unshielded created outputs are persisted as a derived projection

The system SHALL persist every unshielded created output decoded from an archived transaction's
`tx_raw` bytes into a derived table in the `chain_archive` schema, carrying at minimum `net`,
`block_height`, `block_hash`, `tx_hash`, `intent_hash`, `output_index`, `owner`, `token_type`, and
`value`, with `value` stored in an exact decimal type that cannot lose u128 precision
(`design.md` §1.2).

#### Scenario: A decoded output round-trips through the projection without precision loss

- **WHEN** a transaction whose unshielded output carries a `value` exceeding
  `Number.MAX_SAFE_INTEGER` is decoded and projected
- **THEN** reading that row back SHALL yield the exact original integer value
- **AND** the value SHALL NOT have passed through any JavaScript `number` representation

#### Scenario: Identity survives a same-height fork

- **WHEN** two blocks at the same height on different forks each contain a transaction creating an
  unshielded output
- **THEN** both outputs SHALL persist as distinct rows, distinguished by `block_hash`
- **AND** neither SHALL overwrite the other

### Requirement: the projection cursor advances in the same transaction as the rows it describes

WHEN the projection writes decoded rows for a block and advances its progress cursor, the system
SHALL perform both writes inside a single Postgres transaction, so that the cursor can never commit
ahead of the rows it claims are present (`design.md` §4; same failure class as the checkpoint cursor
closed by `saveAndAdvance`).

#### Scenario: A crash between rows and cursor cannot leave the cursor ahead

- **WHEN** the projection process is killed at an arbitrary point during a block's projection
- **THEN** on restart the cursor SHALL NOT report a height whose rows are absent
- **AND** re-projecting from the reported cursor SHALL produce a complete result

### Requirement: the feed exposes a watermark bounding what is answerable

The system SHALL expose a feed watermark giving the highest block height for which decoding is
complete, and this watermark SHALL be part of the read contract rather than an internal detail
(`design.md` §2.2).

#### Scenario: An empty result below the watermark is authoritative

- **WHEN** a reader queries a height range wholly at or below the feed watermark and receives zero
  rows
- **THEN** that result SHALL mean the range genuinely created no unshielded outputs **from regular
  transactions**
- **AND** the contract SHALL NOT be worded so as to imply the range created no unshielded outputs at
  all, since system-transaction outputs are excluded by scope (`design.md` §6.2)

#### Scenario: A query above the watermark is refused, not answered emptily

- **IF** a reader queries a height range extending above the feed watermark
- **THEN** the system SHALL signal that the range is not yet answerable
- **AND** SHALL NOT return a zero-row result that is indistinguishable from a genuinely empty range

### Requirement: the read contract is a versioned view carrying no build-time coupling

The system SHALL expose the feed to readers as a version-named SQL view in the `chain_archive`
schema, consumable by a plain SQL client, requiring no npm dependency on UmbraDB and no running
UmbraDB service (`design.md` §2).

#### Scenario: A reader with only a Postgres connection can consume the feed

- **WHEN** a client holding nothing but a Postgres connection string queries the view
- **THEN** it SHALL obtain the projected rows
- **AND** SHALL NOT require any UmbraDB package to be installed or any HTTP endpoint to be running

#### Scenario: A breaking shape change is additive

- **WHEN** the feed's exposed shape must change incompatibly
- **THEN** a new version-named view SHALL be introduced alongside the existing one
- **AND** the existing view's shape SHALL NOT change in place

#### Scenario: The contract states its own incompleteness

- **WHEN** the read contract is documented
- **THEN** it SHALL state that the feed covers regular transactions only and is therefore not a
  complete UTXO view
- **AND** SHALL note that consumers computing balances will be short the system-transaction-created
  outputs (`design.md` §6.2)

### Requirement: the feed is read-only to consumers and preserves the single-writer model

The system SHALL grant feed consumers read-only access, so the archive retains exactly one writer
and `SECURITY.md`'s single-trusted-writer threat model is unchanged.

#### Scenario: A consumer cannot write through the feed

- **WHEN** a feed consumer attempts to insert, update, or delete through the read contract
- **THEN** the attempt SHALL be rejected

### Requirement: a new sync protocol type coexists with the indexer-backed one

The system SHALL add a Midnight sync protocol distinct from `MIDNIGHT_PARALLEL` that sources data
from the UmbraDB feed, and both SHALL be simultaneously configurable within one effectstream node
(`design.md` §3.1).

#### Scenario: Both protocols run in one node

- **WHEN** an effectstream node is configured with both an indexer-backed and an UmbraDB-backed
  Midnight sync protocol
- **THEN** both SHALL start and progress independently
- **AND** neither SHALL interfere with the other's cursor or state

#### Scenario: Only one dispatch site changes

- **WHEN** the new protocol is registered
- **THEN** the change to fetcher construction SHALL be confined to the single existing dispatch
  branch in `syncProtocolFactory.ts`

### Requirement: the UmbraDB-backed fetcher emits payloads indistinguishable from the indexer-backed one

WHEN the UmbraDB-backed fetcher produces a primitive entry for a created unshielded output, the
system SHALL emit `payloadType` `"midnight-unshielded-create"` and a payload carrying `owner`,
`intentHash`, `outputIndex`, `value`, `tokenType`, and `txHash` with the same types and encodings
the indexer-backed fetcher produces (`design.md` §3.2).

#### Scenario: The primitive cannot tell the two sources apart

- **WHEN** the same block is fed to `MidnightUnshieldedCreatePrimitive` from each source
- **THEN** the resulting state-machine payloads SHALL be equal field for field

### Requirement: no primitive class or grammar is modified

The system SHALL deliver this change without modifying any file under
`packages/node-sdk/sm/primitives/src/midnight-*/` (`design.md` §3.2).

#### Scenario: The primitives directory is untouched

- **WHEN** the change's full diff is examined
- **THEN** it SHALL contain no modification to any Midnight primitive class or grammar file

### Requirement: the two feeds are compared as an exact set difference

The system SHALL compare the indexer-sourced and UmbraDB-sourced streams over a pinned block range
by joining on `(net, block_height, tx_hash, intent_hash, output_index)`, comparing `owner`,
`intent_hash`, `output_index`, `value`, `token_type`, and `tx_hash` after case-folding hex, stripping
`0x` prefixes, and comparing `value` as an exact decimal integer; and the comparison SHALL pass only
when the symmetric difference is empty (`design.md` §5).

#### Scenario: Any discrepancy fails the comparison

- **WHEN** the two streams differ in any compared field for any joined row, or either side holds a
  row the other lacks
- **THEN** the comparison SHALL fail
- **AND** SHALL report the differing rows rather than a count or a rate

#### Scenario: Row ordering does not affect the verdict

- **WHEN** the two streams contain identical rows emitted in different orders
- **THEN** the comparison SHALL pass

### Requirement: a comparison range must be valid before its verdict counts

The system SHALL treat a comparison range as void, distinctly from failed, unless its upper bound is
at or below both the feed watermark and the indexer-backed protocol's own confirmed height
(`design.md` §5).

#### Scenario: An over-extended range is void rather than failed

- **IF** a comparison range extends above either bound
- **THEN** the harness SHALL report the range as void
- **AND** SHALL NOT report it as either a pass or a failure

### Requirement: system transactions are excluded from the feed and from both sides of the comparison

The system SHALL scope the feed to outputs created by regular transactions only, and SHALL apply the
same exclusion to the indexer-sourced side of every comparison, so the two sides are compared over
the same population (`design.md` §6, owner decision).

#### Scenario: The indexer side is filtered to match

- **WHEN** a comparison range contains a system transaction that created unshielded outputs
- **THEN** those outputs SHALL be excluded from the indexer-sourced side before comparison
- **AND** the comparison SHALL NOT fail on their absence from the UmbraDB side

### Requirement: the exclusion is byte-derived, so it behaves identically with and without the indexer

The system SHALL determine whether a transaction is regular or system from the transaction's own
payload self-tag, as already recorded in `chain_archive.transactions.kind`, and SHALL NOT derive it
from any indexer-supplied field (`design.md` §6.1).

#### Scenario: The filter survives indexer removal unchanged

- **WHEN** the same comparison range is filtered during the indexer-sourced run and the node-sourced
  run
- **THEN** the two runs SHALL classify every transaction identically
- **AND** the classification SHALL NOT depend on any indexer response

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
