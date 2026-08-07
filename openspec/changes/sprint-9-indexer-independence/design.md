# Design — Sprint 9: Indexer Independence

Companion to `proposal.md`. This document decides *how* an UmbraDB-sourced primitive feed is
built, how it is proved equivalent to the indexer-sourced one, and what is deliberately left open.

---

## 0. Reconciliation with the existing Tier-1 / Tier-2 split

`design/design.md` §0 records the 2026-07-17 storage-architecture reconciliation: Tier 1 is client
wallet/checkpoint persistence (`tier1_wallet` schema), Tier 2 is the chain mirror, planned as **a
fork of the official indexer's own Postgres schema**. `design/full-chain-storage-design.md` §1 then
introduced Tier-1.5 (`chain_archive`) as explicitly neither — chain-scoped, but not the indexer
fork.

This sprint builds on **Tier-1.5, not Tier-2**, and that is a deliberate choice against the earlier
plan rather than an oversight of it:

- Forking the indexer's schema (Tier-2) inherits a schema whose upstream is being retired. The fork
  would have no upstream to track and no migration path to follow.
- Tier-1.5 already exists, already content-addresses raw bytes, and already has a decoder written
  against those bytes.
- The Tier-2 fork was justified by *analytics* workloads. Serving a primitive feed is not an
  analytics workload; it is a narrow, range-scanned, append-only read.

Tier-2 is not cancelled by this change. If it is later built, it becomes a second consumer of the
same archive, not a replacement for this feed. `design/design.md` §0's hard requirement — Tier-1
tables must never be added to a forked indexer schema — is untouched: everything this sprint adds
lives in `chain_archive`.

---

## 1. Where decoded values live: a persisted projection

**Decision: persist decoded unshielded created outputs into a derived table in `chain_archive`,
rather than decoding on read.**

Rejected alternative — decode on read: every reader would need the `@midnight-ntwrk/ledger-v8` WASM
bindings loaded and a full transaction deserialize per query. That pushes the exact dependency
effectstream is trying to shed onto every consumer, and turns a range scan into N WASM calls.

### 1.1 This reverses a deliberate deferral, and the reversal is principled

`design/full-chain-storage-design.md` §7 classifies **Unshielded UTXO events** as *"Defer —
UNVERIFIED"*, on the stated reasoning that *"indexer's `unshielded_utxos` covers full create→spend
lifecycle … and is plausibly replay-recoverable"*. Both halves of that justification are now
different facts:

- The "indexer already covers it" half **expires with the indexer**. A deferral justified by a
  dependency cannot outlive the dependency.
- The "UNVERIFIED / plausibly replay-recoverable" half is **no longer unverified for the create
  side**. `test/integration/chain-archive-replay-decode.integration.test.ts` matched reconstructed
  outputs against real indexer `unshielded_utxos` rows on `(owner, tokenType, value, intentHash,
  outputIndex)`. §7's own wording made the deferral conditional on exactly this test existing.

This change therefore reverses §7 for **created** outputs only. Spent outputs stay deferred (they
need an inputs decoder that does not exist yet — `proposal.md`, Staging). `design/full-chain-storage-design.md`
§7's table must be updated in the same commit that lands this, so the design corpus does not carry
two contradictory classifications.

### 1.2 Shape

A table keyed to survive forks and reorgs the same way `transactions` does
(`design/full-chain-storage-design.md` §4.3 — PK `(net, block_height, block_hash, tx_hash)`, chosen
after a fork-breaking PK bug was caught in review). The projection inherits that discipline:
identity includes `net` and `block_hash`, never height alone.

Non-negotiable columns: `net`, `block_height`, `block_hash`, `tx_hash`, `intent_hash`,
`output_index`, `owner`, `token_type`, `value`. `value` is `NUMERIC`, never a JS-number-backed type —
u128 values exceed `MAX_SAFE_INTEGER` and the existing grammar already carries them as decimal
strings.

---

## 2. The read path: share the database

**Decision: effectstream and UmbraDB share one Postgres. Effectstream reads
`chain_archive.feed_unshielded_created_v1` — a versioned view — with its own `pg` client.**

Say the obvious part plainly, because an earlier draft of this section obscured it behind the words
"exposes" and "read contract": **there is nothing to expose data *through*.** UmbraDB is a library
over Postgres — `README.md`: *"You supply the database; UmbraDB owns a schema inside it."* The
database **is** the interface. No server is built, no endpoint is stood up, no protocol is defined.

The view is not an API layer. It is a stable column shape inside a schema the reader is already
connected to, so effectstream selects from a named contract rather than from table internals. That
is a thin naming convention, and it should not be described as anything grander.

**What does need to run is the writer.** `chain-archive-sync/sync-cli.ts` is already that ops entry
point — a resumable loop advancing a persisted watermark
(`ARCHIVE_PG=… npx tsx chain-archive-sync/sync-cli.ts`), with `bootstrapChainArchiveSchema`
applying the `chain_archive` lineage on startup, matching this codebase's established "the consuming
module bootstraps its own schema" pattern rather than a separate migration binary. The asymmetry is
the whole point: **collection is a daemon, exposure is a `SELECT`.**

Three properties this buys, each of which was a requirement:

| Property | Why it matters |
|---|---|
| **No build-time coupling** | UmbraDB is not published to npm (`README.md`). A library import would force effectstream to install from git and match Node/ESM constraints against a Bun toolchain. A view needs none of that. |
| **No new service** | `README.md` states UmbraDB is *"not a distributed database or a service you run for other tenants"*, and `SECURITY.md`'s threat model assumes a single trusted writer. A read-only view keeps that intact: effectstream is a reader, the archive keeps exactly one writer. |
| **Refactorable interior** | The underlying table can change shape; the view is the compatibility surface. A breaking change becomes `_v2` alongside `_v1`, never a silent reshape. |

Effectstream already depends on `pg` in four `node-sdk` packages, so this adds no dependency class.

### 2.1 Deployment shape: one instance, separate schemas

Sharing the database follows a shape this project already committed to. `design/design.md` §0:
*"Both tiers end up on one Postgres instance, two schemas … not a merged schema."* That decision was
forced by a real, confirmed name collision against the upstream indexer schema, which creates a
table literally named `wallets` in `public`. Effectstream's own node tables are a third occupant of
the same instance and inherit the same rule: **separate schema, never a merged one**, and every
connection sets its own `search_path` rather than relying on table-name distinctiveness.

Two deployment constraints follow, and both are load-bearing enough to state here rather than
discover in production:

- **No transaction pooler in front of the shared instance.** UmbraDB's startup durability probe
  actively detects one and raises `TransactionPoolerDetectedError`, because a transaction pooler
  breaks the session-scoped advisory locks the lease and the migration lock depend on
  (`src/postgres/durability-probe.ts`). Adding effectstream as a second client of the same Postgres
  raises the odds someone puts PgBouncer in transaction mode in front of it. If that happens the
  archive stops being able to migrate — loudly, at startup, which is the good failure, but it is a
  constraint on the deployment topology and not a detail.
- **Shared database means shared trust domain.** `SECURITY.md` is explicit that *"`schema` is
  namespacing, not a tenant boundary"* and that there is no at-rest encryption. Effectstream and the
  archive must therefore be operated by the same party. This design does not weaken that model —
  effectstream is read-only — but it does extend the "encrypt the substrate" precondition to cover
  chain data, not just wallet data.

### 2.2 The feed watermark is part of the contract, not an implementation detail

This is the single most important correctness element of the read path.

A reader querying a height range gets rows back. **Zero rows is ambiguous**: it means either "this
block genuinely created no unshielded outputs" or "this block has not been decoded yet." Those are
not the same, and confusing them produces exactly the silent gap that
`v1.0.0-durable-checkpoint-cursor` was created to eliminate on the checkpoint side.

The contract therefore exposes a **feed watermark** — the highest block height for which decoding is
complete — and a reader MUST NOT treat any height above it as answered. The view is not readable
without it; they are one contract.

---

## 3. The effectstream seam

### 3.1 A new sync protocol, not a modified one

Add `ConfigSyncProtocolType.MIDNIGHT_UMBRA` (`"midnight-umbra-parallel"`) alongside the existing
`MIDNIGHT_PARALLEL`. Both must be simultaneously configurable in one node — that is what makes the
parity harness possible at all.

Dispatch today is `syncProtocolFactory.ts:106`, branching on
`entry.networkType === ConfigNetworkType.MIDNIGHT` and unconditionally constructing
`new MidnightFetcher(entry)`. That branch gains a sub-discriminator on `entry.syncProtocol.type`.
It is the **only** dispatch site that changes.

### 3.2 The primitives do not change

`MidnightUnshieldedCreatePrimitive.getPayload` consumes
`primitiveTransactionData.output.payload` and never learns where it came from. The new fetcher's
sole obligation is to emit `PrimitiveType[]` entries whose `output.payloadType` is
`"midnight-unshielded-create"` and whose `output.payload` carries the same six fields the existing
`MidnightFetcher.fetchUnshieldedCreates` produces (`fetcher.ts:280`).

**If this sprint edits anything under `packages/node-sdk/sm/primitives/src/midnight-*/`, the design
is wrong.** That constraint is testable and is specified as such.

### 3.3 The "clone" is a config clone

The owner's requirement — run the indexer version and the UmbraDB version side by side and compare
1:1 — is satisfied without duplicating a single line of primitive code. Two `addPrimitive` entries,
same `type: PrimitiveTypeMidnightUnshieldedCreate`, different `name` and `stateMachinePrefix`, bound
to the two different sync protocols. The template configs already demonstrate multiple `addParallel`
sync protocols coexisting in one node (`e2e/midnight/config.ts`, `templates/*/config.mainnet.ts`).

This matters beyond tidiness: a code clone would let the two paths drift, and a parity harness whose
two sides can drift independently proves nothing about the path being migrated.

---

## 4. The projection cursor advances co-transactionally

The decoder walks archived transactions and writes projected rows. Its progress cursor **MUST**
advance in the same Postgres transaction as the rows it describes.

This is not a new insight; it is the same failure this project already found and fixed once. From
`README.md`: *"a cursor can commit ahead of the checkpoint it points at, and a crash leaves you
resuming from a position whose data was never durable, a silent gap. This was the single
correctness blocker of the 1.0 program."* The remedy there was `saveAndAdvance`
(`v1.0.0-durable-checkpoint-cursor`).

The projection cursor has the identical shape and therefore takes the identical remedy. Reusing
`Watermarks` for the cursor also inherits W1 (last-write-wins), mechanized in Lean and part of the
frozen 1.0.0 cut-line (`Formal/STORAGE_ALGEBRA.md` §3; `Formal/Lean/UmbraDBFormal/Watermarks/Laws.lean`).
Nothing about W1 changes — it is relied on, not extended.

A cursor ahead of its rows would surface in the harness as a spurious mismatch, which is the *good*
outcome. The bad outcome is a reader treating an undecoded range as empty and the harness scoring
it as agreement on both sides. §2.2's watermark and this section's atomicity are the two halves of
preventing that.

---

## 5. What "1:1" means, precisely

Vague parity is unfalsifiable parity. The comparison is specified exactly:

- **Join key:** `(net, block_height, tx_hash, intent_hash, output_index)`.
- **Compared fields:** `owner`, `intent_hash`, `output_index`, `value`, `token_type`, `tx_hash`.
- **Normalization before comparison:** hex case-folded to lower; `0x` prefixes stripped on both
  sides; `value` compared as an exact decimal integer, never as a float; row ordering ignored (set
  comparison, not sequence comparison).
- **Pass criterion:** the symmetric difference of the two row sets over the pinned height range is
  **empty**. Not "small", not "explained" — empty.
- **Range validity:** the range's upper bound must be at or below both the feed watermark (§2.2)
  and the indexer-backed protocol's own confirmed height. A range extending past either is void,
  not failed.

A mismatch is a finding to be explained and fixed, never a threshold to be tuned.

---

## 6. System transactions: excluded by decision

**Owner decision (binding): system transactions are out of scope. The feed is regular-transaction
only.**

The underlying asymmetry is real and was found during scoping. Effectstream's existing
indexer-backed fetcher iterates `unshieldedCreatedOutputs` for **every** transaction in a block, and
its own comment is explicit that this covers *"regular AND system transactions"* (`fetcher.ts:277`).
UmbraDB's decoder does not: `decodeArchivedTransaction` branches on the payload's self-tag and, for a
system transaction, returns immediately with `unshieldedOutputs: []`
(`chain-archive-sync/tx-replay-decoder.ts`). The module's own note records why — *"the ledger WASM
API exposes no hash accessor on `SystemTransaction`."*

Rather than close that gap, this sprint **excludes system transactions from both sides**. That turns
an invisible omission into a declared boundary, which is the safe form of the same limitation.

**Correction (2026-08-06, from reading the v1.0.0 reference implementation):** an earlier version
of this analysis claimed runtime-generated system-transaction bytes were "indexer-only,
structurally." That is wrong. The indexer's own node adapter
(`midnight-indexer/chain-indexer/src/infra/subxt_node/runtimes/v1_0_0.rs:113`) obtains them from
the node's **`SystemTransactionApplied` event** (`Event::MidnightSystem`, field
`serialized_system_transaction`) — on-chain events storage, available to any node client. They are
absent from `chain_getBlock.extrinsics`, which is what the earlier claim conflated with absence
from the node altogether. The exclusion therefore rests on two real but narrower facts: (a)
decoding the events vector requires runtime metadata (a heterogeneous SCALE enum is not skippable
without it — a dependency decision deferred, e.g. `@polkadot/types`), and (b) the ledger WASM
exposes no `SystemTransaction.hash()` accessor to compute the archive's `tx_hash` PK. Both are
closable engineering gaps, not structural impossibilities — which strengthens, not weakens, the
case that the exclusion is a *decision*.

### 6.1 The exclusion must be symmetric, and byte-derived

Excluding on the UmbraDB side happens for free — the decoder already emits nothing. The indexer side
must be filtered explicitly, or every comparison fails on rows UmbraDB was never going to produce.

The filter is `chain_archive.transactions.kind` (`TransactionKind = "regular" | "system"`,
`src/interfaces/chain-archive-store.ts`), which `sync-service.ts` populates by classifying the
payload's **self-tag** — `isSystemTransaction` / `isStandardTransaction`. That classification is
derived from the transaction bytes, not from any indexer field, so it behaves identically in Run A
and Run B. An indexer-side filter (e.g. GraphQL `__typename`) would not: it would vanish with the
indexer and silently change the comparison's meaning between the two runs.

### 6.2 Consequence the feed contract must carry

Midnight distributes NIGHT through system transactions, so a regular-transaction-only feed is **not
a complete UTXO view**. Any consumer computing balances or reconstructing a UTXO set from this feed
will be short exactly the system-transaction-created outputs.

That is acceptable for this sprint's primitive and its two non-mainnet config sites, but it is a
property of the feed, not of the test. Two places must say so rather than implying completeness:

1. §2.2's watermark semantics. "Zero rows below the watermark means the range created no unshielded
   outputs" is **false** under this decision and is corrected in the spec to "…created no unshielded
   outputs **from regular transactions**." A watermark that implies completeness it does not have is
   the same silent-gap failure §2.2 exists to prevent.
2. The view's own documented contract.

The exclusion carries forward to later primitives, and it matters more there: `UnshieldedSpend` has
7 config sites including mainnet. Whether the same boundary is acceptable for a spend feed is a
question for that change, not a decision inherited silently from this one.

---

## 7. Run A / Run B

Per `proposal.md`, two runs with different ingest sources. Concretely:

| | Run A | Run B |
|---|---|---|
| `sync-service.ts` sources `tx_raw` from | Indexer `Transaction.raw` | Node `chain_getBlock` extrinsics, envelope stripped |
| Isolates | Decode, projection, view, fetcher, harness | Ingest |
| Gates cutover | **No** | **Yes** |

Run B's ingest work is bounded by two facts `sync-service.ts` already established empirically: the
indexer's `raw` is an **exact suffix** of the node extrinsic's bytes, and the extrinsic-count gap is
Substrate inherents that never wrap a `pallet_midnight` payload. So the work is envelope-stripping
plus inherent classification.

**Status (2026-08-06): the ingest half of Run B is implemented and executed** — see `tasks.md`
§6.1/§6.2 for the recorded evidence (indexer container stopped; 0→1225 ingested node-only; 25/25
regular transactions byte-identical to the indexer-sourced archive; empty symmetric difference).
Two implementation facts worth carrying forward:

- The envelope decode does **not** hardcode pallet indices (5/6 on this devnet runtime): the
  authoritative filter is the payload's own `midnight:` self-tag plus the structural requirement
  that the single trailing `Vec<u8>` argument spans exactly to the extrinsic's end
  (`extrinsic-decoder.ts`). Bare v4 (wallet-submitted) and v5 (node-authored) envelopes both occur
  live and are both handled.
- `tx_hash` is recomputed locally — WASM `Transaction.transactionHash()` is the same ledger method
  the indexer's `hash` field comes from (`subxt_node.rs:675`), so hashes are identical by
  construction, and byte-equality of `raw` subsumes hash equality in the oracle cross-check.

Additionally, the transition period now has a stronger shape than a one-shot Run B: with the
indexer configured, `sync-service.ts` computes the node-derived view of every block anyway and
**throws on any disagreement before writing** (indexer-as-oracle mode). Cutover is: stop passing
the indexer option.

Run A must never be reported as the migration's evidence. A green Run A with no Run B is a pipeline
that still depends on the thing being switched off.

---

## 8. Open questions

Carried deliberately rather than guessed:

1. ~~**System-transaction outputs.**~~ **Closed by owner decision** — excluded from both sides, see
   §6. What remains is not a question but an obligation: the exclusion must be symmetric and
   byte-derived (§6.1), and the feed contract must not imply completeness it lacks (§6.2).
2. **Reorg semantics for the projection.** `chain_archive.blocks` models the full block tree with
   `is_canonical` / `finalized` (`design/full-chain-storage-design.md` §4.2). The feed view must
   decide whether it serves canonical-only or all-seen rows. Canonical-only is the presumptive
   answer since effectstream consumes confirmed data, but the indexer-backed protocol's
   `confirmationDepth` / `delayMs` handling must be compared against it rather than assumed
   equivalent.
3. **Where the harness runs.** Both prefixes write to effectstream's own accounting tables, which
   makes a SQL diff natural; but that couples the harness to effectstream's schema. An alternative
   is exporting both streams and diffing outside either system. Resolve during implementation, with
   a bias toward whichever is easier to run repeatedly.
4. **Whether `net` and effectstream's `caip2` / `networkId` agree.** The archive keys on `net`;
   effectstream's Midnight config carries `networkId` and validates it against the primitive
   (`fetcher.ts:47`). These must be reconciled or the join key is wrong across networks.
