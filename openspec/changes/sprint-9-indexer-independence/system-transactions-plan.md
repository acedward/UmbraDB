# Plan: replacing the indexer with the node as the archive's ingest source

**Revision 3.** Revision 1 was blocked; revision 2 rewrote it against that review; this revision
records that **exact parity has been achieved on the test chain**, documents the second repository
the work now spans, and narrows what remains. §10 lists changes from revision 2.

**Written for an independent reviewer with no prior context.**

---

## 1. The goal, and its boundary

**UmbraDB** is a TypeScript library over PostgreSQL. Its `chain-archive-sync/` component ingests
the Midnight blockchain into a `chain_archive` schema: blocks, transactions (raw bytes,
content-addressed), lean metadata. It is an archive, not a state store.

Ingest used to **require the Midnight indexer** (`midnight-indexer`, a service that replays the
ledger and serves GraphQL). UmbraDB stored what it was handed.

**The indexer is being decommissioned.** The goal is exactly one thing:

> Replace the indexer with the node as the source of the archive's bytes. Produce the **same
> archive**. Change nothing about what it contains, what it means, or what reads it.

Anything that adds stored data, derives new values, or builds a feed is **out of scope** and lives
on a separate branch. The measure of success is therefore not a feature list — it is that ingesting
a range both ways yields identical rows.

## 2. Repositories

| Path | What it is | State |
|---|---|---|
| `/home/eddie/umbradb-fork` | The UmbraDB fork carrying this work. Branch `feat/indexer-independent-ingest` (26 commits); `feat/contract-ledger-state` stacks 6 more, and is **out of scope here** | clean |
| `/home/eddie/midnight-ledger-fork` | Clone of `midnightntwrk/midnight-ledger`, branch `feat/expose-system-transaction-hash`, commit `de62430`. A 16-line addition exposing `SystemTransaction::transactionHash` to WASM — **needs upstreaming** | clean; built artifact in `ledger-wasm/pkg` (19 MB, gitignored) |
| `/home/eddie/midnight-reference-mainnet/v1.0.0` | Read-only reference: `midnight-node`, `midnight-indexer`, `midnight-ledger` sources | reference only |

The second repository exists because one method the indexer relies on was never exposed to
JavaScript. See §5.

## 3. The indexer's code path — what we are reproducing

Every mechanism below is what `midnight-indexer` does against the same node. This is the
specification; anything we do differently is a deviation to justify, not a design choice.

All paths relative to `/home/eddie/midnight-reference-mainnet/v1.0.0/`.

| Concern | Indexer implementation | Our equivalent |
|---|---|---|
| Block traversal, parent continuity | `midnight-indexer/chain-indexer/src/infra/subxt_node.rs:353` (`ParentHashMismatch`) | implemented |
| Extrinsic → call decoding | `.../runtimes/v1_0_0.rs:30` `make_block_details`, decoding **every** extrinsic via `decode_call_data_as::<Call>()` | **partial** — signed/general framings rejected (§4.2) |
| Regular transactions | `.../runtimes/v1_0_0.rs:78` matches `Call::Midnight(send_mn_transaction)` | implemented |
| System transactions, extrinsic-borne | `.../runtimes/v1_0_0.rs:82` matches `Call::MidnightSystem(send_mn_system_transaction)` | implemented (§5) |
| System transactions, event-borne | `.../runtimes/v1_0_0.rs:113` reads `Event::MidnightSystem(SystemTransactionApplied)`, prepending them before extrinsic-derived ones | **not implemented** (§4.1) |
| Transaction hash | `midnight-indexer/indexer-common/src/domain/ledger/transaction.rs:58` (regular), `:213` (system) — both call the ledger's `transaction_hash()` | implemented, via the WASM export in §5 |
| Protocol version | header `MNSV` consensus digest, `chain-indexer/src/infra/subxt_node/header.rs` | implemented |
| Supported version ranges | `indexer-common/src/domain/protocol_version.rs:55` rejects unknown ranges | implemented |
| D-parameter | `runtimes.rs` `get_d_parameter` runtime API | implemented via `state_call` |
| Runtime metadata | captured OFFLINE per node version: `midnight-indexer/get_node_metadata.sh`, `NODE_VERSIONS`, `chain-indexer/build.rs` generating decoders; dispatched at runtime on the header's protocol version | **pinned constants instead** (§4.3) |
| Contract state | `subxt_node.rs:681` runtime API per contract action | out of scope (Part B) |

The metadata row is the important one: **the indexer does not resolve metadata at runtime.** It
captures it per node version offline and compiles decoders. That pattern is directly available to
us and is what §4.3 proposes.

## 4. Current state

**Exact parity is achieved on the test chain.** Ingesting heights 0–1599 both ways, then comparing
every persisted field in order (`block_height, position, tx_hash, kind, protocol_version`, raw
bytes):

```
indexer-sourced: 26 rows
node-only:       26 rows
IDENTICAL — every field, in order
```

Previously 26 vs 21. Also verified: node-only ingest issues no indexer request, demonstrated by
recording every outgoing HTTP request during a real-node sync rather than by inspecting
configuration.

**This does not mean parity is proven in general.** Three gaps remain, and the test chain exercises
none of them.

### 4.1 Event-borne system transactions — not implemented

System transactions reach the node two ways, both at any height: as extrinsics
(`send_mn_system_transaction`, root-dispatched) and as `SystemTransactionApplied` events emitted
after successful application. We read only extrinsics.

The test chain's only system transactions are the five at genesis, all extrinsic-borne, so it
cannot exercise this. A reward-bearing chain (preprod) can.

Because a successful root-dispatched call appears in **both** sources, combination rules are
required, not optional:

| Case | Sources | Rule |
|---|---|---|
| Runtime-generated | event only | archive from event |
| Root-dispatched, failed | extrinsic only (no event) | to be decided from the indexer's behaviour |
| Root-dispatched, succeeded | extrinsic **and** event | archive once; define which supplies bytes and position |
| Same hash, differing bytes | both | must fail loudly — one source is being misread |

### 4.2 Signed and general extrinsics — rejected before their call is read

`decodeMidnightExtrinsic` returns `null` for any extrinsic carrying the signed or general framing
bits, before the pallet index is examined. But `send_mn_transaction(_origin: OriginFor<T>, …)`
**ignores its origin** (`midnight-node/pallets/midnight/src/lib.rs:365`), so a signed Midnight
transaction is valid and executes — and the indexer decodes call data for every extrinsic
regardless of framing.

This affects **regular** transactions. The test chain's wallet submits bare extrinsics only, so
parity there is not evidence of parity in general.

### 4.3 Call indices are pinned constants, not metadata-derived

`CALL_INDICES_BY_PROTOCOL` hardcodes `(pallet, call)` per protocol-version range, verified only
against node 1.0.x. It is fail-closed — a renumbered runtime stops recognising genuine
transactions, and that case now aborts the block rather than being counted past — but it is a
hand-rolled miniature of what the indexer generates from captured metadata.

Node 0.22.x is deliberately absent: its ledger codec is supported but its indices were never
observed, and guessing would either drop real transactions or archive forged ones.

## 5. The second repository, and why it exists

`SystemTransaction::transaction_hash()` has always existed on the Rust ledger
(`midnight-ledger/ledger/src/structure.rs:2203`), and the indexer calls it directly to key the
system transactions it archives. The `wasm-bindgen` wrapper over that same type
(`midnight-ledger/ledger-wasm/src/tx.rs`) exposed only `new / serialize / deserialize / toString`.

So a JavaScript consumer could deserialize a system transaction and read its bytes but not obtain
its identity — and therefore could not store one under the key every other consumer uses. That
asymmetry, not any protocol limitation, is why system transactions were unarchivable.

**The fix** is 16 lines mirroring the `Transaction::transactionHash` binding beside it, on branch
`feat/expose-system-transaction-hash` in `/home/eddie/midnight-ledger-fork`.

**Verified against ground truth**, not inspection: the five system transactions of the test chain's
genesis were archived by `midnight-indexer 4.3.2`; the rebuilt binding recomputes all five hashes
from the same archived bytes, matching exactly. That also settled a version question — the clone
builds 8.1.0 while UmbraDB pins 8.0.3, and the hashes are identical across that gap.

**How UmbraDB consumes it:** via the `MIDNIGHT_LEDGER_WASM` environment override, not a `file:`
dependency, so `package.json` stays portable. The hash is **feature-detected** — against a stock
published ledger the method is absent, and ingest then **refuses** rather than omitting system
transactions, because all inserts are `ON CONFLICT DO NOTHING` and an archive written without them
cannot be repaired by re-ingesting. Both paths are covered by the real-node gate.

**Packaging note:** the published package is ESM with an `imports["#self"]` map and a hand-rolled
`midnight_ledger_wasm_fs.js` Node loader. A `--target nodejs` build is *not* drop-in — it produces
CJS that breaks under vitest with an ESM cycle. The build must use `--target bundler` plus that
loader.

## 6. Required actions

Ordered. Items 1–2 are prerequisites for proving anything about 3–5.

1. **Upstream the WASM export.** `/home/eddie/midnight-ledger-fork`, branch
   `feat/expose-system-transaction-hash`. Until it ships, node-only ingest of any chain with system
   transactions requires the local build. *Owner action.*
2. **Capture indexer ground truth for a reward-bearing chain, now**, while the indexer still runs:
   network, genesis hash, range, indexer version, queries, checksums. Every remaining parity claim
   depends on an oracle that is being switched off, and the test chain cannot exercise §4.1 or
   §4.2.
3. **Decode all extrinsic framings** (§4.2), so signed Midnight calls are archived. Classification
   must stay driven by the dispatched `(pallet, call)`, never payload content.
4. **Decode events** for `SystemTransactionApplied` (§4.1), with metadata resolved for the block
   being ingested — never the chain tip, or a block spanning a runtime upgrade decodes against the
   wrong layout. Implement the §4.1 combination table.
5. **Replace pinned indices with captured metadata** (§4.3), following the indexer's own mechanism.
   This subsumes item 3's decoding needs and removes the 0.22 exclusion.
6. **Re-prove parity on a chain exercising all of it**, per §7.

Deliberately NOT on this list: `transactions.result`, projections, feeds, contract state. None is a
regression from the source substitution — `transactions.result` has been NULL in indexer mode too
since before this work — and adding them is not replacing the indexer.

## 7. Acceptance

One criterion: **ingesting a range both ways on one chain must produce identical persisted
transaction sequences** — an exact ordered per-block comparison of `block_height, block_hash,
position, tx_hash, kind, protocol_version, raw bytes`. Set equality is insufficient; ordering is
part of the contract.

Currently met on the test chain. To be meaningful in general the range must contain, and each be
asserted:

- genesis system transactions ✅ *(covered today)*
- non-genesis, event-generated system transactions ❌
- system and regular transactions mixed in one block ❌
- signed or general regular calls ❌
- a failed root-dispatched system call ❌
- a runtime-upgrade boundary, if the pinned chain has one ❌

Plus: the gate must not self-skip; restart and indexer↔node source switching must be exercised; and
an archive partially written by an earlier, less complete implementation must be detected rather
than silently extended.

## 8. Testing, at minimum

The suites must stay green throughout. Today: 31 focused tests plus the real-node gate, which runs
against a live node with **no indexer service present** and asserts both the full-ingest path (with
the WASM export) and the refusal path (without it).

The one addition needed for the remaining work is a parity gate that runs the §7 comparison
automatically against a pinned reward-bearing chain, rather than the manual comparison used to
establish today's result.

## 9. Open questions

1. **Is `MIDNIGHT_LEDGER_WASM` acceptable as an interim**, or should the patched build be vendored
   or published under a scoped name until upstream ships? The override keeps `package.json`
   portable but means the capability depends on operator configuration.
2. **Which chain becomes the parity oracle** for §4.1/§4.2? The devnet cannot exercise them, and
   the window to capture ground truth closes when the indexer is retired.
3. **For a root-dispatched system transaction appearing in both sources** — which supplies the
   archived bytes and position? Reproducing the indexer's answer requires observing it, not
   reasoning about it.
4. **Is metadata capture (§4.3 / item 5) in scope for this substitution**, or acceptable as
   follow-up given the pinned indices are fail-closed and gated to verified versions?

## 10. Changes from revision 2

| Revision 2 | Revision 3 |
|---|---|
| Parity failing 26 vs 21 | **Exact parity on the test chain**: 26 vs 26, identical every field in order |
| System-tx hash blocked on a missing export | Export written, built and verified (5/5 against indexer ground truth); second repo documented in §2/§5 |
| Single repository | Two: the UmbraDB fork and the ledger fork, with paths and branches |
| Indexer mechanisms described in prose | §3 maps each concern to its indexer file:line and our status |
| "Three gaps" | Same three, now with the test chain's inability to exercise two of them stated explicitly |
