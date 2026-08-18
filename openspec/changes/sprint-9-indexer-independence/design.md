# Design — Sprint 9: Indexer Independence

> **Current-status note (2026-08-15):** this design records the source-substitution decisions and
> their evolution. Audit-driven safety machinery now includes migrations 002–007, finalized-only
> serialized writes, replay checkpoints and per-block committed ledger-root checks. Use the
> task/plan §§15–19 registers for implementation disposition; historical intermediate refusals
> below are not current capability limits.

Companion to `proposal.md`. This document decides *how* an UmbraDB-sourced primitive feed is
built, how it is proved equivalent to the indexer-sourced one, and what is deliberately left open.

---

> **Scope (2026-08-07).** This document now covers the archive's INGEST SOURCE only. The
> projection, the read views, the effectstream seam and the feed-parity harness moved to the
> contract-ledger-state change: they build on the archive rather than being prerequisites for
> changing where it comes from, and keeping them here made a source substitution read as a
> feed rewrite. Sections are left at their original numbers so earlier review references
> still resolve.

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

## 6. System transactions: SUPERSEDED — they are archived

**This section's original decision no longer holds, and is kept for the reasoning trail rather
than as guidance.** It read: "Owner decision (binding): system transactions are out of scope."

That decision was taken on a premise that turned out to be false. It rested partly on the claim
that the ledger WASM exposed no `SystemTransaction` hash, so the `tx_hash` primary key could not be
computed — true of the binding, but the hash exists on the Rust ledger and the node also hands it
over directly in the `SystemTransactionApplied` event. Nothing needed computing.

**Current position (2026-08-11):** ALL system transactions are archived. Extrinsic-borne ones are
keyed by the ledger's own hash (§6a). Event-borne ones — the runtime-generated kind, which exist
only in the `SystemTransactionApplied` event — are decoded from the block's own runtime metadata
and archived too, **prepended** before the extrinsic-derived list exactly as the reference orders
them (`runtimes/v1_0_0.rs:160-163`). Their hash is recomputed from the archived bytes rather than
taken from the event's claim, so the key is derived from what is stored.

The paragraph this replaces said event-borne transactions were "not yet decoded" and that "ingest
does not yet detect it" — true when written, false since the Stage 2 metadata work. It is corrected
here rather than annotated, because a reader checking whether this archive is complete needs the
answer, not its history.

The exclusion below therefore describes history. Where it says the feed is regular-transaction
only, read `system-transactions-plan.md` instead.

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

## 6a. System transactions: what is actually recoverable, measured

The exclusion in §6 was justified partly on a claim that turned out to be wrong, and partly on one
that survives. Measured against a live 1.0.0 devnet on 2026-08-07, indexer-sourced vs node-only
ingest of the SAME chain:

| | regular | system |
|---|---|---|
| indexer-sourced | 21 | **5** |
| node-only | 21 | **0** |

So the parity gap is real and it is exactly the system transactions. Locating them changes what
the fix is:

**All five are at height 0**, and genesis system transactions are carried IN
`chain_getBlock.extrinsics` (this decoder's own fixtures: genesis extrinsic 0 is pallet 6 / call 0
with a 41-byte `midnight:system-transaction[v6]` payload -- matching the 41-byte archived row
exactly). The bytes are already in hand: `classifyExtrinsic` already returns them with
`kind: "system"`, and `buildNodeOnlyTransactionRecords` simply skips them.

**The blocker is the `tx_hash` primary key, and it is narrower than "needs runtime metadata".**

- The claim that `SystemTransactionApplied` makes this a non-issue is right for MOST blocks: the
  event carries the authoritative hash AND the serialized transaction
  (`pallets/midnight-system/src/lib.rs`). Runtime-generated system transactions are recoverable
  that way, and that path does need event decoding.
- It does NOT help at genesis. Substrate emits no events for block 0 (Parity PR #5463 -- the
  reference indexer has the same problem and works around it by reading pallet storage directly
  for its genesis cNight registrations). Probing `System::Events` at height 0 on the devnet
  returns nothing at all, confirming it.
- And the ledger WASM exposes no hash for a system transaction. Verified twice, against the
  typings and against the compiled bindings, which export only
  `deserialize / free / new / serialize / toString`. The RUST ledger DOES have
  `SystemTransaction::transaction_hash()` (which is how the reference indexer hashes them), so
  this is a **missing WASM export, not a protocol limitation**.

Consequences for scope:

1. Non-genesis system transactions are recoverable from events, at the cost of metadata-driven
   event decoding. On a chain that mints block rewards this is the bulk of them.
2. Genesis system transactions are recoverable in BYTES today but not in HASH, and no amount of
   work in this repo changes that -- it needs `transaction_hash` exported on `SystemTransaction`
   in `@midnight-ntwrk/ledger-v8`, or an authoritative statement of the algorithm. Inventing a
   hash here would produce a primary key that disagrees with every other consumer.
3. This devnet produced NO system transactions outside genesis (its event blobs at heights 50 and
   200 are 49 bytes and contain none), so the event path cannot be exercised against it. Testing
   that path needs preprod or a reward-producing chain.

The honest statement of the remaining gap is therefore: **five genesis rows, blocked upstream on a
WASM export** -- not "system transactions are unsupported".

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
