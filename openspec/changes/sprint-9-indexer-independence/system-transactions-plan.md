# Plan: recovering system transactions in node-only archive ingest

**Written for an independent reviewer with no prior context.** Everything needed to judge this is
below, including how each claim was verified and which earlier claims turned out to be wrong.

---

## 1. Background

**UmbraDB** is a TypeScript library over PostgreSQL. One of its components, `chain-archive-sync/`,
ingests the Midnight blockchain into a `chain_archive` schema: blocks, transactions (raw bytes,
content-addressed), and a little metadata. It is an archive, not a state store — it records what
was on chain, and other things derive meaning from it later.

Until this work, ingest **required the Midnight indexer** (`midnight-indexer`, a separate service
that replays the ledger and serves GraphQL). For each block, UmbraDB fetched the indexer's view and
stored what it was handed: each transaction's hash, protocol version and raw payload bytes.

**The indexer is being decommissioned.** The branch under review replaces it with direct reads from
a Midnight node's JSON-RPC. The goal is narrow and worth stating plainly:

> Change **where the archive's bytes come from**. Do not change what the archive contains, what it
> means, or what anything downstream reads.

Anything that adds new stored data is explicitly a different piece of work on a separate branch.

**Repository:** `/home/eddie/umbradb-fork` (a fork; upstream is `CharlesHoskinson/UmbraDB`).
**Branch:** `feat/indexer-independent-ingest`.
**Reference implementation** (read-only, for grounding claims):
`/home/eddie/midnight-reference-mainnet/v1.0.0/` — contains both `midnight-node` and
`midnight-indexer` sources.

## 2. Status: what already works

Node-only ingest is implemented and verified against a live 1.0.0 devnet. Transaction bytes come
from decoding the Substrate extrinsic envelope; the ledger transaction hash is recomputed locally
via the ledger WASM (the same value the indexer served, since it is the same ledger function); the
protocol version comes from the block header's `MNSV` consensus digest; the D-parameter comes from
a runtime `state_call`.

Measured on one chain, ingesting the same range both ways: **21 regular transactions each,
byte-identical, empty symmetric difference.** A separate test ingests from a real node with no
indexer service running and asserts, by recording every outgoing HTTP request, that no
indexer-shaped request occurs.

**One gap remains, and it is the subject of this plan.**

## 3. The gap, measured

Indexer-sourced and node-only ingest of the **same chain and range**:

| | regular transactions | system transactions |
|---|---|---|
| indexer-sourced | 21 | **5** |
| node-only | 21 | **0** |

System transactions are runtime-level transactions (block rewards, treasury payouts, parameter
updates) rather than user submissions. Node-only ingest currently drops all of them, so the archive
it produces is **not** a faithful replacement for the indexer-sourced one. That is a regression
introduced by the source substitution, and closing it is in scope by the definition in §1.

*(Note for completeness: `transactions.result` is also unpopulated, but that is NOT a regression —
it has been NULL in indexer mode too since long before this branch, because the GraphQL query never
requested it. Populating it would be a new feature and is out of scope here.)*

## 4. Why they are missing, precisely

The reasoning below matters because an earlier version of it was wrong, and the wrong version is
what justified excluding system transactions in the first place.

### 4.1 Where system transactions live

Two different places, and this is the crux:

- **Genesis (block 0):** carried inside `chain_getBlock.extrinsics`, as ordinary extrinsics
  dispatching to `pallet_midnight_system::send_mn_system_transaction`.
- **Every other block:** produced *during block execution*. They are **not** extrinsics at all.
  They surface only as the `SystemTransactionApplied` event.

The reference indexer reads **both** — extrinsics *and* events — and prepends the event-derived
system transactions before the extrinsic-derived ones
(`midnight-indexer/chain-indexer/src/infra/subxt_node/runtimes/v1_0_0.rs`, `make_block_details`).

This branch reads only extrinsics. That is the root cause.

### 4.2 What was verified, and how

| Claim | Status | How verified |
|---|---|---|
| All 5 missing rows are at height 0 | **Verified** | Queried the indexer-sourced archive: all five have `block_height = 0` |
| Genesis system transactions are in the extrinsics | **Verified** | This repo's own decoder fixtures: genesis extrinsic 0 is pallet 6 / call 0 with a 41-byte `midnight:system-transaction[v6]` payload — matching the 41-byte archived row exactly |
| The decoder already recognises them | **Verified** | `classifyExtrinsic` returns them with `kind: "system"`; `buildNodeOnlyTransactionRecords` explicitly skips them |
| `SystemTransactionApplied` carries the hash AND the bytes | **Verified** | `midnight-node/pallets/midnight-system/src/lib.rs` — `struct SystemTransactionApplied { hash: Hash, serialized_system_transaction: Vec<u8> }` |
| Substrate emits no events at block 0 | **Verified** | Probed `System::Events` storage at height 0 on the devnet: returns nothing. The reference indexer documents the same limitation (Parity PR #5463) and works around it by reading pallet storage directly |
| The ledger WASM cannot hash a system transaction | **Verified twice** | `@midnight-ntwrk/ledger-v8` typings expose only `deserialize/serialize/toString`; the compiled bindings export only `systemtransaction_{deserialize,free,new,serialize,toString}` |
| Rust's ledger *can* hash one | **Verified** | `midnight-indexer/indexer-common/src/domain/ledger/transaction.rs` calls `transaction.transaction_hash()` on a `SystemTransaction`. This is how the indexer produced the five hashes above |
| This devnet has no non-genesis system transactions | **Verified** | Event blobs at heights 50 and 200 are 49 bytes and contain no system-transaction payload |

### 4.3 The resulting three-way split

**The bytes are not the problem.** For genesis they are already decoded and discarded; for other
blocks they are in the event.

**The `tx_hash` primary key is the problem**, and it splits:

1. **Non-genesis system transactions** — hash available from the event. Needs event decoding.
2. **Genesis system transactions** — bytes available today, hash available from *neither* route:
   no events exist at block 0, and the WASM exposes no hash function.
3. Therefore genesis is **blocked upstream**, on a binding that exists in Rust but is not exported
   to JS. It is a missing WASM export, **not** a protocol limitation.

**A correction the reviewer should weigh when judging this analysis:** the exclusion of system
transactions was originally justified to the owner on the grounds that "the ledger WASM exposes no
`SystemTransaction` hash accessor, so the primary key cannot be computed." That is true but was
presented as the whole story; it ignored that the node hands the hash over directly for every
non-genesis block. The scope decision was made on incomplete information.

## 5. Options

### Option A — Event decoding for non-genesis, genesis declared out of scope

Decode block events, extract `SystemTransactionApplied`, archive those transactions with the
event's hash and bytes. Genesis system transactions remain unarchived, with §4.3 as the recorded
reason.

- Closes the gap on any chain that mints rewards — in practice almost all system transactions.
- Does **not** close it on this devnet, whose only system transactions are at genesis.
- Requires decoding a heterogeneous SCALE event enum, which needs runtime metadata. Realistically
  a dependency such as `@polkadot/api`, in a directory that currently uses plain `fetch` and no
  SDK. That dependency would also unlock `transactions.result` and per-segment outcomes later.

### Option B — Request the upstream WASM export, then close the gap completely

Ask for `transaction_hash()` to be exported on `SystemTransaction` in `@midnight-ntwrk/ledger-v8`
(it already exists in the Rust ledger). Genesis system transactions then archive from bytes already
in hand, with no metadata dependency at all. Combined with Option A, parity is total.

- Only route that closes the genesis case.
- Blocked on an external team; timeline not ours.
- On its own it fixes only genesis, i.e. exactly this devnet, and leaves reward-bearing chains
  needing Option A anyway.

### Option C — Reimplement the hash in TypeScript

Rejected, and recorded so a reviewer need not re-derive it: the hash is a primary key that other
consumers rely on. A locally-invented implementation that disagreed even for one input would
produce rows that silently fail to join with anything else. This should not be done without an
authoritative specification of the algorithm, and even then it is duplicated trust for no gain.

### Recommendation

**A + B, in that order, and neither blocks merging what exists.**

Option A is the substantive fix and is bounded by the dependency decision, which is the owner's.
Option B is a request that costs nothing to raise now and may take a while to land.

Until either lands, node-only ingest should **refuse to run on a chain whose archive would be
incomplete**, rather than silently producing a smaller archive — see the acceptance criteria.

## 6. Proposed work

1. **Make the incompleteness impossible to miss.** Node-only ingest currently drops system
   transactions silently. It should either refuse, or record per block that system transactions
   were not archived, so no operator can mistake a node-only archive for a complete one. *This part
   needs no dependency decision and should be done regardless of which option is chosen.*
2. **Decide the dependency** (owner). Metadata-driven event decoding, or not.
3. **If yes:** decode block events, match `SystemTransactionApplied`, archive with the event's hash
   and bytes, and place them in the block's transaction ordering the way the reference indexer does
   — prepended before extrinsic-derived transactions.
4. **Raise the upstream request** for `transaction_hash` on `SystemTransaction`.
5. **Reconcile positions.** Node-only currently numbers regular transactions 0..n-1; indexer mode
   uses the indexer's own positions, which include system transactions. Once system transactions
   are archived, positions must match indexer semantics or cross-mode comparison stays impossible.

## 7. Acceptance criteria

- Ingesting a range **both ways on one chain** yields the same transaction set: same count, same
  `tx_hash` values, same `kind`, same raw bytes, same ordering. This is the single criterion that
  matters; today it fails 26 vs 21.
- A chain containing non-genesis system transactions must be used. This devnet is insufficient
  (§4.2) — preprod, or a devnet configured to mint rewards.
- If any category remains unarchivable, ingest must fail or mark the block, never silently omit.
- The existing node-only regression gate must still pass: no indexer request issued, verified by
  observing requests rather than inspecting configuration.

## 8. Explicitly out of scope

- `transactions.result` and per-segment outcomes — never populated in indexer mode either, so not a
  regression (§3).
- Any projection, view, feed or effectstream protocol built on top of the archive.
- Anything that adds stored data beyond restoring indexer parity.

## 9. Question for the reviewer

Is **Option A + B** the right call, and is criterion §7's "same transaction set both ways on one
chain" the correct definition of done for a source substitution — or is there a parity dimension
this plan has missed?
