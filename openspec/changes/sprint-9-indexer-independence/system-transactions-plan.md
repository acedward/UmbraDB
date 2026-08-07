# Plan: completing node-side decoding for exact indexer parity

**Revision 2.** Revision 1 was reviewed and blocked. Three of its findings were verified as correct
and are incorporated; separately, revision 1 overstated both of its blockers, and the corrections
make the work smaller and entirely ours to schedule. Changes from revision 1 are listed in §9.

**Written for an independent reviewer with no prior context.**

---

## 1. Background

**UmbraDB** is a TypeScript library over PostgreSQL. Its `chain-archive-sync/` component ingests the
Midnight blockchain into a `chain_archive` schema: blocks, transactions (raw bytes,
content-addressed), and lean metadata. It is an archive, not a state store.

Ingest used to **require the Midnight indexer** (`midnight-indexer`, a service that replays the
ledger and serves GraphQL). UmbraDB stored what the indexer handed it: per transaction, a hash, a
protocol version and raw payload bytes.

**The indexer is being decommissioned.** This branch replaces it with direct reads from a Midnight
node's JSON-RPC. The goal is deliberately narrow:

> Change **where the archive's bytes come from**. Do not change what the archive contains, what it
> means, or what anything downstream reads.

**Repository:** `/home/eddie/umbradb-fork`. **Branch:** `feat/indexer-independent-ingest`.
**Reference sources** (read-only): `/home/eddie/midnight-reference-mainnet/v1.0.0/`, containing
`midnight-node`, `midnight-indexer` and `midnight-ledger`.

## 2. Current state

Regular, *unsigned* transactions ingest correctly from the node. Bytes come from decoding the
extrinsic envelope; the transaction hash is recomputed locally via the ledger WASM (the same ledger
function the indexer calls, so the values agree by construction); the protocol version comes from
the header's `MNSV` digest; the D-parameter from a runtime `state_call`. Measured on one chain over
one range, both ways: 21 regular transactions, byte-identical, empty symmetric difference.

**Node-only ingest currently refuses to run** on any range containing a system transaction, rather
than silently omitting it. Since genesis carries system transactions on every Midnight chain, and
ingest starts at height 0 for an empty archive, **node-only ingest cannot presently build a full
archive of any chain.** That is deliberate — see §4.

## 3. The gap

Indexer-sourced vs node-only ingest of the **same chain and range**:

| | regular | system |
|---|---|---|
| indexer-sourced | 21 | **5** |
| node-only | 21 | **0** |

Three distinct defects produce it. Revision 1 described only the first, and described it wrongly.

### 3.1 System transactions are not archived at all

They are runtime-level transactions — block rewards, treasury payouts, governance parameter
changes. They reach the node two ways, and **both occur at any height**:

- as **extrinsics**, via `pallet_midnight_system::send_mn_system_transaction`, which is a
  root-dispatched call (`ensure_root(origin)`) — not a genesis-only construct;
- as **events**, `SystemTransactionApplied`, emitted after successful application.

The reference indexer reads both and prepends the event-derived ones
(`midnight-indexer/chain-indexer/src/infra/subxt_node/runtimes/v1_0_0.rs`). This branch reads only
extrinsics, and discards system-kind ones.

Because a successful root-dispatched system transaction appears in **both** sources, combination
rules are required, not optional — see §6.3.

### 3.2 Signed and "general" extrinsics are rejected before their call is read

`decodeMidnightExtrinsic` returns `null` for any extrinsic whose version byte carries the signed or
general bits, before the pallet index is examined. But
`send_mn_transaction(_origin: OriginFor<T>, …)` **ignores its origin**
(`midnight-node/pallets/midnight/src/lib.rs`), so a signed Midnight transaction is valid and
executes — and the reference indexer decodes call data for *every* extrinsic regardless of framing.

**This affects regular transactions, not only system ones.** Revision 1's claim that "one gap
remains" was wrong.

### 3.3 Positions do not match indexer semantics

Node-only numbers regular transactions `0..n-1`. Indexer-sourced uses the indexer's own ordering,
which includes system transactions. Even once §3.1 and §3.2 are fixed, cross-mode comparison stays
impossible until ordering matches.

*(Out of scope, stated to prevent confusion: `transactions.result` is unpopulated, but it has been
NULL in indexer mode too since before this branch — the GraphQL query never requested it. Filling
it is a new feature, not a parity repair.)*

## 4. Why ingest refuses instead of omitting

The archive's inserts are all `ON CONFLICT DO NOTHING`. An archive written today without system
transactions therefore **cannot be repaired by re-ingesting the range later**: existing rows would
be skipped, and corrected positions (§3.3) would collide with what is already stored. The
incompleteness would be permanent and invisible.

Refusing is the only safe behaviour until parity exists. Marking blocks was considered and rejected:
it would add stored data, which this branch's scope forbids, and a log-only marker does not protect
a downstream reader.

## 5. The two "blockers", corrected

Revision 1 presented both as external dependencies. Both are smaller, and neither is blocked on
another team.

### 5.1 The system-transaction hash: a five-line binding gap

The hash exists in the Rust ledger:

```
midnight-ledger/ledger/src/structure.rs:2202
    impl SystemTransaction {
        pub fn transaction_hash(&self) -> TransactionHash   // line 2203
```

The npm package `@midnight-ntwrk/ledger-v8` is a `wasm-bindgen` wrapper over **that same crate**,
and its binding is in-tree:

```
midnight-ledger/ledger-wasm/src/tx.rs:1696
    #[wasm_bindgen]
    impl SystemTransaction {
        new / serialize / deserialize / to_string        // transaction_hash is simply not wrapped
    }
```

So this is a **missing export, not a missing capability**, and the fix mirrors three methods
already present. Two routes, neither requiring anyone else's schedule:

- request the export upstream and pin the resulting version; or
- build `ledger-wasm` locally with the export and pin that artifact.

Reimplementing the hash in TypeScript remains rejected: it is a primary key other consumers join
on, and a local implementation that disagreed on one input would produce rows that silently fail to
join.

### 5.2 Metadata: build-time artifacts, not runtime resolution

Revision 1 said this needed runtime metadata resolution, "realistically `@polkadot/api`". **The
indexer does not do that.** It captures metadata offline, per node version:

- `get_node_metadata.sh <version>` runs the node in Docker and dumps metadata via the `subxt` CLI
  to `.node/<version>/metadata.scale`;
- `NODE_VERSIONS` pins exactly two: `0.22.0`, `1.0.0-rc.3`;
- `build.rs` generates typed decoders from those files at build time;
- at runtime it dispatches on the protocol version from the block header.

That pattern transfers directly, and shrinks the dependency: we need something that can decode SCALE
against a **metadata blob**, which `@polkadot/types` does — not the provider/RPC layer of
`@polkadot/api`. The capture mechanism already exists and is reusable.

It also matches the security posture already in place: ingest is gated to known protocol versions,
so decoding against metadata captured for exactly those versions is consistent with it. This
branch's hand-rolled `CALL_INDICES_BY_PROTOCOL` is a miniature of the same idea and would be
replaced by it.

## 6. Proposed work

### 6.1 Complete the extrinsic decoder

Decode call data for **every** extrinsic framing — bare, signed and general — rather than rejecting
signed ones before reading the call (§3.2). Classification must stay driven by the dispatched
`(pallet, call)`, never by payload content.

### 6.2 Decode events

Resolve `SystemTransactionApplied` from block events, taking both the authoritative hash and the
serialized transaction from the event. Metadata must be resolved for **the block being ingested**,
never the chain tip, or a historical block spanning a runtime upgrade is decoded with the wrong
layout.

### 6.3 Define combination, deduplication and ordering

Required cases, each needing an explicit rule and a test:

| Case | Sources | Rule |
|---|---|---|
| Runtime-generated system transaction | event only | archive from event |
| Root-dispatched call that **failed** | extrinsic only (no event) | ? — must be decided; the indexer's own behaviour is the reference |
| Root-dispatched call that **succeeded** | extrinsic **and** event | archive once; define which supplies bytes and position |
| Same hash, different raw bytes | both | must fail loudly — it means one source is misread |
| Genesis | extrinsic only (no events at block 0) | needs §5.1 for the hash |

Ordering must reproduce indexer semantics — event-derived system transactions prepended before
extrinsic-derived transactions — so that `position` matches across modes (§3.3).

### 6.4 Source the hash

Per §5.1. Where both a computed hash and an event hash are available, they must be compared and
disagreement must fail.

## 7. Acceptance criteria

**One criterion decides this: ingesting a range both ways on one chain must produce identical
persisted transaction sequences** — an exact ordered per-block comparison of every persisted field:

```
block_height, block_hash, position, tx_hash, kind, protocol_version, raw bytes
```

Set equality is insufficient; ordering is part of the contract (§3.3). Today this fails 26 vs 21.

The comparison range must contain, and each must be asserted:

- genesis system transactions;
- non-genesis, event-generated system transactions;
- system and regular transactions mixed in one block;
- signed or general regular calls;
- a failed root-dispatched system call;
- a runtime-upgrade boundary, if the pinned chain has one.

Further requirements:

- **the gate must not self-skip.** The existing node-only test skips when its prerequisites are
  absent, which is honest for a developer machine but unacceptable for a required gate. It must run
  against a pinned chain that actually produces system transactions — the current devnet does not
  (its only ones are at genesis), so preprod or a reward-producing devnet is required.
- restart, and indexer↔node source switching, must be exercised.
- an archive partially written by the current regular-only implementation must be detected rather
  than silently extended (§4).

## 8. Sequencing

1. Capture immutable indexer ground truth **now**, while the indexer still exists: network, genesis
   hash, exact range, indexer version, queries, and checksums of the result. Every parity claim
   afterwards depends on an oracle that is being switched off.
2. Raise the upstream WASM export request (§5.1) — it costs nothing to start and may take longest.
3. Capture pinned metadata per supported node version, following the indexer's mechanism (§5.2).
4. Complete the extrinsic decoder (§6.1).
5. Decode events (§6.2).
6. Define and implement combination/ordering (§6.3), from observed indexer behaviour rather than
   inference.
7. Build the non-skipping parity gate (§7) on a chain that produces system transactions.
8. Reconcile the normative corpus: the spec, design, tasks and store interface still declare system
   transactions excluded.

## 9. What changed from revision 1

| Revision 1 | Revision 2 |
|---|---|
| "One gap remains: system transactions" | Three gaps: system transactions, signed/general extrinsics, positions |
| System transactions are genesis-extrinsic or event-only | They arrive as extrinsics **at any height** (root-dispatched) and as events; both sources can carry the same one |
| No combination or dedup rules | §6.3 enumerates the cases and requires explicit rules |
| Hash blocked upstream, timeline not ours | A five-line export on an in-tree binding; local build is a viable fallback |
| Metadata needs runtime resolution, `@polkadot/api` | Build-time pinned artifacts, as the indexer does; `@polkadot/types`-scale |
| "Neither should block merging" | Withdrawn. Incomplete archives are unrepairable in place, so ingest now refuses |
| Acceptance: "same transaction set" | Exact **ordered** per-block comparison of every persisted field, on a chain that actually produces system transactions, with a non-skipping gate |

One factual correction also carried from the review: the reference indexer's genesis pallet-storage
workaround is for **cNight registrations**, not for genesis system transactions. Revision 1 implied
otherwise.

## 10. Question for the reviewer

With both blockers reduced to in-house work, is the §8 sequencing right — specifically, is
capturing indexer ground truth first (step 1) urgent enough to precede all implementation, given
the oracle disappears when the indexer is switched off?
