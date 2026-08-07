# Plan: replacing the indexer with the node as the archive's ingest source

**Revision 4.** Revisions 1–3 were each reviewed and blocked; every finding is now either fixed or
carried explicitly below. This revision records that **node-only ingest has no silent gaps left**,
and reduces what remains to one engineering task and four decisions.

**Written for an independent reviewer with no prior context.** All paths are absolute.

---

## 1. The goal, and its boundary

**UmbraDB** is a TypeScript library over PostgreSQL. Its `chain-archive-sync/` component ingests
the Midnight blockchain into a `chain_archive` schema: blocks, transactions (raw bytes,
content-addressed), lean metadata. It is an archive, not a state store.

Ingest used to **require the Midnight indexer** (a service that replays the ledger and serves
GraphQL). UmbraDB stored what it was handed. **The indexer is being decommissioned.**

> **The goal:** replace the indexer with the node as the source of the archive's bytes. Produce the
> **same archive**. Change nothing about what it contains, what it means, or what reads it.

Success is therefore not a feature list. It is that ingesting a range both ways yields **identical
rows**. Anything that adds stored data, derives new values, or builds a feed is out of scope.

## 2. Repositories and key files (absolute paths)

| Path | Role |
|---|---|
| `/home/eddie/umbradb-fork` | UmbraDB fork. Branch `feat/indexer-independent-ingest`, **31 commits**, tree clean. Branch `feat/contract-ledger-state` stacks 6 more and is **out of scope here** |
| `/home/eddie/midnight-ledger-fork` | Clone of `midnightntwrk/midnight-ledger`. Branch `feat/expose-system-transaction-hash`, **2 commits, UNPUSHED** |
| `/home/eddie/midnight-reference-mainnet/v1.0.0` | Read-only reference: `midnight-node`, `midnight-indexer`, `midnight-ledger` |

**Implementation:**
- `/home/eddie/umbradb-fork/chain-archive-sync/extrinsic-decoder.ts` — envelope decode, call-index classification, protocol-version gate
- `/home/eddie/umbradb-fork/chain-archive-sync/sync-service.ts` — ingest, mode split, continuity, identity, all refusal conditions
- `/home/eddie/umbradb-fork/chain-archive-sync/tx-replay-decoder.ts` — ledger loading, transaction/system-transaction decode, capability probe
- `/home/eddie/umbradb-fork/chain-archive-sync/node-rpc-client.ts` — JSON-RPC surface

**Tests:**
- `/home/eddie/umbradb-fork/test/chain-archive-sync/extrinsic-decoder.test.ts` — 24 unit tests
- `/home/eddie/umbradb-fork/test/integration/chain-archive-sync-retry.integration.test.ts` — 10 tests, fake node/indexer
- `/home/eddie/umbradb-fork/test/integration/chain-archive-node-only.integration.test.ts` — real node, **no indexer service**
- `/home/eddie/umbradb-fork/test/integration/chain-archive-source-parity.integration.test.ts` — **the acceptance gate**
- `/home/eddie/umbradb-fork/test/compose/docker-compose.yml` — node/indexer/proof/postgres, no host ports

**Ledger fix:** `/home/eddie/midnight-ledger-fork/ledger-wasm/src/tx.rs` (the export),
`/home/eddie/midnight-ledger-fork/ledger-wasm/ledger-v8.template.d.ts` (authored typings),
`/home/eddie/midnight-ledger-fork/ledger-wasm/pkg/` (local build, gitignored, 19 MB).

## 3. The indexer's code path — what we are reproducing

The indexer reads the same node. Its implementation is the specification; anything we do
differently is a deviation to justify. Paths under `/home/eddie/midnight-reference-mainnet/v1.0.0/`.

| Concern | Indexer | Status |
|---|---|---|
| Parent continuity | `midnight-indexer/chain-indexer/src/infra/subxt_node.rs:353` | ✅ |
| Extrinsic → call decode (**every** framing) | `.../runtimes/v1_0_0.rs:30`, `decode_call_data_as::<Call>()` | ⚠️ bare only; signed/general **refused** (§5.2) |
| Regular transactions | `.../runtimes/v1_0_0.rs:78` | ✅ |
| System transactions, extrinsic-borne | `.../runtimes/v1_0_0.rs:82` | ✅ |
| System transactions, event-borne | `.../runtimes/v1_0_0.rs:113` | ⚠️ not decoded; **refused** (§5.1) |
| Transaction hash | `midnight-indexer/indexer-common/src/domain/ledger/transaction.rs:58` and `:213` | ✅ via §4 |
| Protocol version | `.../subxt_node/header.rs` (`MNSV` digest) | ✅ |
| Supported version ranges | `midnight-indexer/indexer-common/src/domain/protocol_version.rs:55` | ✅ |
| D-parameter | `runtimes.rs` `get_d_parameter` | ✅ via `state_call` |
| Runtime metadata | captured OFFLINE per node version: `midnight-indexer/get_node_metadata.sh`, `NODE_VERSIONS`, `chain-indexer/build.rs` | ❌ pinned constants (§5.3) |

**The metadata row is the remaining work.** Note the indexer does *not* resolve metadata at
runtime — it captures it per node version offline and compiles decoders. That pattern transfers.

## 4. What is done

**Exact parity on the test chain.** Ingesting heights 0–1599 both ways and comparing every
persisted field in order (`block_height, position, tx_hash, kind, protocol_version`, raw bytes):

```
indexer-sourced: 26 rows
node-only:       26 rows
IDENTICAL — every field, in order
```

Now enforced automatically by `chain-archive-source-parity.integration.test.ts`, which ingests both
ways into two schemas and compares. Verified to fail when node-only is sabotaged to drop system
transactions (21 vs 26).

**System transactions are archived**, keyed by the ledger's own hash. This required a 16-line
`wasm-bindgen` export: `SystemTransaction::transaction_hash()` exists on the Rust ledger
(`/home/eddie/midnight-reference-mainnet/v1.0.0/midnight-ledger/ledger/src/structure.rs:2203`) and
the indexer calls it directly, but the WASM wrapper never exposed it — so JavaScript could read a
system transaction's bytes yet not its identity. Verified by recomputing the five hashes
`midnight-indexer 4.3.2` recorded for the devnet's genesis: **5/5 match**, which also proved the
8.0.3 → 8.1.0 version gap irrelevant for hashing.

**Also done:** call-based classification (never payload content); protocol-version gating; parent
continuity; chain identity anchored on the archived genesis block; positions numbered across both
transaction kinds in extrinsic order; a real-node gate proving no indexer request is issued by
recording every outgoing request.

## 5. What remains — and why nothing is silent

All three gaps are the same underlying task: **block-scoped runtime-metadata decoding**. Until it
lands, each is **detected and refused** rather than silently omitted. That distinction is
load-bearing: every terminal insert is `ON CONFLICT DO NOTHING`, so an archive written incomplete
**cannot be repaired by re-ingesting later**.

### 5.1 Event-borne system transactions — refused

Runtime-generated system transactions exist only in the `SystemTransactionApplied` event, which
this build does not decode. Ingest reads `System::Events`, counts occurrences of the
system-transaction self-tag, and refuses if there are more than it archived from extrinsics.

Counting, not decoding — delimiting an event payload needs metadata. The tag is a **detection**
signal only; it never decides what anything is. Directional: fewer than archived is expected (a
*failed* root-dispatched call emits no event). Genesis emits no events, so the working path is
unaffected.

### 5.2 Signed and general extrinsic framings — refused

`send_mn_transaction` ignores its origin, so a **signed** Midnight transaction is valid and the
indexer archives it. Reading the call out of a signed framing needs metadata (address, signature
and signed-extension layouts are chain config). Such an extrinsic carrying a Midnight self-tag is
now reported and refused. A signed extrinsic *without* the tag cannot be a Midnight transaction —
the payload is always self-tagged — so ordinary chain traffic does not trip this.

**This affects regular transactions, not only system ones.**

### 5.3 Call indices are pinned constants

`CALL_INDICES_BY_PROTOCOL` hardcodes `(pallet, call)` per protocol-version range, verified only
against node 1.0.x. Fail-closed: a renumbered runtime aborts the block rather than misclassifying.
Node 0.22.x is deliberately absent — its ledger codec is supported but its indices were never
observed, and guessing would either drop real transactions or archive forged ones.

### 5.4 The consequence, stated plainly

Node-only ingest is **correct where it completes, and refuses where it cannot**. On a chain whose
system transactions are all extrinsic-borne (a fresh devnet) it produces an archive identical to
the indexer's. On a reward-minting chain it will refuse at the first runtime-generated system
transaction. It is not yet a general replacement.

## 6. Required actions

1. **Block-scoped metadata decoding** — the single remaining engineering task. Resolves §5.1, §5.2
   and §5.3 together. Metadata must be resolved for the block being ingested, never the chain tip,
   or a block spanning a runtime upgrade decodes against the wrong layout. Follow the indexer's
   own mechanism: capture per node version offline, dispatch on the header's protocol version.
2. **Capture indexer ground truth for a reward-bearing chain — time-critical.** Network, genesis
   hash, range, indexer version, queries, checksums. The test chain cannot exercise §5.1 or §5.2,
   and this oracle **disappears when the indexer is retired**. Every other item here is
   recoverable; this one is not.
3. **Upstream the ledger export.** `/home/eddie/midnight-ledger-fork`, 2 commits, unpushed. Until
   it ships, archiving system transactions requires the local build via `MIDNIGHT_LEDGER_WASM`.
4. **Open the PR**, which unblocks the three mandatory Codex persona audits (`AGENTS.md` requires
   them recorded on a PR after integration with main) and `graphify --update`, currently stale.
5. **Define combination rules** for a system transaction appearing in *both* sources (successful
   root-dispatched calls do). Reproducing the indexer's answer requires observing it, not
   reasoning about it — so this depends on item 2.

**Deliberately not on this list:** `transactions.result` (NULL in indexer mode too, since before
this work — not a regression), projections, feeds, contract state.

## 7. Acceptance

**One criterion: ingesting a range both ways on one chain must produce identical persisted
transaction sequences** — an exact ordered per-block comparison of `block_height, block_hash,
position, tx_hash, kind, protocol_version, raw bytes`. Set equality is insufficient; ordering is
part of the contract.

| Population | Covered |
|---|---|
| genesis system transactions | ✅ |
| regular transactions, bare framing | ✅ |
| non-genesis, event-generated system transactions | ❌ needs §6.2 |
| system and regular mixed in one block | ❌ |
| signed or general regular calls | ❌ |
| a failed root-dispatched system call | ❌ |
| a runtime-upgrade boundary | ❌ |

Plus: gates must not self-skip (each ingest path is a separately required test, gated on the ledger
capability, so an absent export produces a visible SKIP rather than a substituted pass); restart and
source-switching exercised; an archive partially written by an earlier implementation detected
rather than silently extended.

## 8. Questions for the reviewer

1. **Is the refuse-rather-than-omit posture the right interim**, or should node-only mode be
   disabled outright until §6.1 lands? It currently produces a correct archive on simple chains and
   stops cleanly elsewhere — usable, but not a general replacement.
2. **Which chain becomes the parity oracle**, and how soon can ground truth be captured? This is
   the only irreversible item; the window closes when the indexer is switched off.
3. **Is `MIDNIGHT_LEDGER_WASM` acceptable as an interim**, or should the patched build be vendored
   or published under a scoped name? It keeps `package.json` portable but makes the capability
   depend on operator configuration, and it replaces the whole ledger rather than one method.
4. **Should metadata be captured per node version at build time** (the indexer's approach, pinned
   artifacts) **or fetched from the node at ingest and cached per runtime version?** The former
   matches the reference and is reproducible; the latter needs no capture step but makes ingest
   depend on `state_getMetadata` availability for historical blocks.
5. **For a system transaction appearing in both sources** — which supplies the archived bytes and
   position? Needed for §6.5 and unanswerable without item 2.

## 9. Changes from revision 3

| Revision 3 | Revision 4 |
|---|---|
| Event-borne system transactions silently omitted | **Detected and refused** (§5.1) |
| Signed/general framings silently dropped | **Detected and refused** (§5.2) |
| Parity established by a manual one-off diff | **Automated acceptance gate**, verified to fail on sabotage |
| Real-node gate could pass without testing ingest | Each path a **separately required** test, gated on capability |
| `MIDNIGHT_LEDGER_WASM` fell back silently when missing | **Fails** — the two builds differ in behaviour |
| Spec/design/store interface still declared system transactions excluded | **Reconciled** with what the code does |
| Authored ledger `.d.ts` template lacked the method | Added |
