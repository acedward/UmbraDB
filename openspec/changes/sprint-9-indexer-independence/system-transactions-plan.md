# Plan: replacing the indexer with the node as the archive's ingest source

**Revision 5.** Revisions 1–3 were each reviewed and blocked; every finding is now either fixed or
carried explicitly below. Revision 4 recorded that node-only ingest has no silent gaps left.
**This revision states the review scope, records where the code now lives, and reduces what remains
to one engineering task and five decisions.**

**Written for an independent reviewer with no prior context. All paths are absolute.**

---

## 0. What is under review — read this first

Two branches exist. **Only one is being reviewed and executed now.**

| | Branch | Status for this review |
|---|---|---|
| **Part A** | `feat/indexer-independent-ingest` | **THE REVIEW SUBJECT.** Read this, execute this. |
| **Part B** | `feat/contract-ledger-state` | **Future work. Not under review. Do not read it for this round.** |

Part A is *only* substituting the ingest source: read from the node instead of the indexer, produce
the same archive. It adds **no migrations, no columns, no views, no stored fields** — verifiable
mechanically, and this must stay empty:

```bash
cd /home/eddie/umbradb-fork && git diff --name-only main...feat/indexer-independent-ingest -- src/postgres/migrations/
```

Part B stores new data (contract ledger state, block-level readings). It is a *different* change
with different acceptance criteria, it is stacked on A only to avoid rewriting it later, and
reviewing it now would confuse the question A has to answer. It gets its own review when its turn
comes. **Everything below §1 concerns Part A unless a heading says otherwise.**

## 1. The goal, and its boundary

**UmbraDB** is a TypeScript library over PostgreSQL. Its `chain-archive-sync/` component ingests
the Midnight blockchain into a `chain_archive` schema: blocks, transactions (raw bytes,
content-addressed), lean metadata. It is an archive, not a state store.

Ingest used to **require the Midnight indexer** (a service that replays the ledger and serves
GraphQL). UmbraDB stored what it was handed. **The indexer is being decommissioned.**

> **The goal:** replace the indexer with the node as the source of the archive's bytes. Produce the
> **same archive**. Change nothing about what it contains, what it means, or what reads it.

Success is therefore not a feature list. It is that ingesting a range both ways yields **identical
rows**. Anything that adds stored data, derives new values, or builds a feed is out of scope — that
is the same boundary §0 draws between A and B, stated as an acceptance criterion.

## 2. Repositories, branches, and key files (absolute paths)

### 2.1 Repositories

| Absolute path | Remote | Role |
|---|---|---|
| `/home/eddie/umbradb-fork` | `git@github.com:acedward/UmbraDB.git` | UmbraDB fork. **The review subject lives here.** Tree clean |
| `/home/eddie/midnight-ledger-fork` | *(none — local clone of `midnightntwrk/midnight-ledger`)* | The one upstream fix A depends on. **3 commits, UNPUSHED — no destination fork exists yet** (§6.3) |
| `/home/eddie/midnight-reference-mainnet/v1.0.0` | *(read-only reference)* | `midnight-node`, `midnight-indexer`, `midnight-ledger` sources — the implementation being reproduced |

### 2.2 Branches on `git@github.com:acedward/UmbraDB.git`

All four are pushed; local and remote agree.

| Branch | Head | Contents |
|---|---|---|
| `main` | `3c0c68b` | Merge base for A |
| **`feat/indexer-independent-ingest`** | **`1678214`** + this revision | **Part A — 32 commits, 23 files, +3385/−85, zero migrations, plus the commit carrying this document. THE REVIEW SUBJECT** |
| `feat/contract-ledger-state` | `9beeb58` | Part B — 6 commits stacked on A. **Not under review** (§0) |
| `feat/zswap-root-feed` | `56c698b` | Pre-existing branch from concurrent work. **Not under review**, but it collides with B — see §6.6 |

### 2.3 Implementation (Part A)

- `/home/eddie/umbradb-fork/chain-archive-sync/extrinsic-decoder.ts` — envelope decode, call-index classification, protocol-version gate (new, 395 lines)
- `/home/eddie/umbradb-fork/chain-archive-sync/sync-service.ts` — ingest, mode split, continuity, identity, all refusal conditions
- `/home/eddie/umbradb-fork/chain-archive-sync/tx-replay-decoder.ts` — ledger loading, transaction/system-transaction decode, capability probe
- `/home/eddie/umbradb-fork/chain-archive-sync/node-rpc-client.ts` — JSON-RPC surface
- `/home/eddie/umbradb-fork/chain-archive-sync/sync-cli.ts` — `INDEXER_URL` now optional
- `/home/eddie/umbradb-fork/src/interfaces/chain-archive-store.ts` — interface docs reconciled with behaviour (no schema change)

### 2.4 Tests (Part A)

- `/home/eddie/umbradb-fork/test/chain-archive-sync/extrinsic-decoder.test.ts` — 24 unit tests, real captured devnet fixtures
- `/home/eddie/umbradb-fork/test/integration/chain-archive-sync-retry.integration.test.ts` — 10 tests, fake node/indexer
- `/home/eddie/umbradb-fork/test/integration/chain-archive-node-only.integration.test.ts` — real node, **no indexer service**
- `/home/eddie/umbradb-fork/test/integration/chain-archive-source-parity.integration.test.ts` — **the acceptance gate**
- `/home/eddie/umbradb-fork/test/compose/docker-compose.yml` — node/indexer/proof/postgres, no host ports
- `/home/eddie/umbradb-fork/test/compose/docker-compose.hostports.yml` — overlay exposing 19944/19088/16300/15432 for manual runs

### 2.5 The ledger fix (separate repository)

- `/home/eddie/midnight-ledger-fork/ledger-wasm/src/tx.rs` — the 16-line `wasm-bindgen` export
- `/home/eddie/midnight-ledger-fork/ledger-wasm/ledger-v8.template.d.ts` — authored typings
- `/home/eddie/midnight-ledger-fork/ledger-wasm/verification/verify-system-tx-hash.mts` — the acceptance proof (§4)
- `/home/eddie/midnight-ledger-fork/ledger-wasm/verification/indexer-ground-truth.txt` — the five hashes `midnight-indexer 4.3.2` recorded, with the bytes they came from
- `/home/eddie/midnight-ledger-fork/ledger-wasm/pkg/` — local build, gitignored, 19 MB

Reproduce the proof (needs a `wasm-pack build --target bundler` output in `pkg/`):

```bash
cd /home/eddie/umbradb-fork && ./node_modules/.bin/tsx /home/eddie/midnight-ledger-fork/ledger-wasm/verification/verify-system-tx-hash.mts /home/eddie/midnight-ledger-fork/ledger-wasm/pkg/midnight_ledger_wasm_fs.js
```

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
8.0.3 → 8.1.0 version gap irrelevant for hashing. That check is a committed, rerunnable script
(§2.5) rather than a one-off — and it compares against an *independent* implementation, which is
what makes it evidence rather than a tautology.

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

Items 1–5 belong to Part A. Item 6 is coordination that Part A does not depend on.

1. **Block-scoped metadata decoding** — the single remaining engineering task. Resolves §5.1, §5.2
   and §5.3 together. Metadata must be resolved for the block being ingested, never the chain tip,
   or a block spanning a runtime upgrade decodes against the wrong layout. Follow the indexer's
   own mechanism: capture per node version offline, dispatch on the header's protocol version.
   Gated on decision §8.4.
2. **Capture indexer ground truth for a reward-bearing chain — time-critical.** Network, genesis
   hash, range, indexer version, queries, checksums. The test chain cannot exercise §5.1 or §5.2,
   and this oracle **disappears when the indexer is retired**. Every other item here is
   recoverable; this one is not. Gated on decision §8.2.
3. **Upstream the ledger export.** `/home/eddie/midnight-ledger-fork`, 3 commits, unpushed —
   `git@github.com:acedward/midnight-ledger.git` does not exist, so **the branch has nowhere to go
   until a fork is created**. Until it ships, archiving system transactions requires the local
   build via `MIDNIGHT_LEDGER_WASM`. Gated on decision §8.3.
4. **Open the PR** for `feat/indexer-independent-ingest`, which unblocks the three mandatory Codex
   persona audits (`/home/eddie/umbradb-fork/AGENTS.md` requires them recorded on a PR after
   integration with main) and `graphify --update`, currently stale.
5. **Define combination rules** for a system transaction appearing in *both* sources (successful
   root-dispatched calls do). Reproducing the indexer's answer requires observing it, not
   reasoning about it — so this depends on item 2. Gated on decision §8.5.
6. **Resolve `feat/zswap-root-feed` against Part B — Part A is unaffected.** That branch holds a
   `002_zswap_root.ts` byte-identical to Part B's copy but with different commit SHAs
   (cherry-picked), so merging both would duplicate the migration. It also branches from an older
   Part A and is missing 10 commits, including the refuse-rather-than-omit work, the ledger-hash
   parity, and the test gates. Flagged rather than modified — it is someone else's branch. Since
   only A is under review now, this blocks nothing today, but it will block B.

**Deliberately not on this list:** `transactions.result` (NULL in indexer mode too, since before
this work — not a regression), projections, feeds, contract state (all Part B or later).

## 7. Acceptance (Part A)

**One criterion: ingesting a range both ways on one chain must produce identical persisted
transaction sequences** — an exact ordered per-block comparison of `block_height, block_hash,
position, tx_hash, kind, protocol_version, raw bytes`. Set equality is insufficient; ordering is
part of the contract.

| Population | Covered |
|---|---|
| genesis system transactions | ✅ |
| regular transactions, bare framing | ✅ |
| non-genesis, event-generated system transactions | ❌ needs §6.1 |
| system and regular mixed in one block | ❌ |
| signed or general regular calls | ❌ |
| a failed root-dispatched system call | ❌ |
| a runtime-upgrade boundary | ❌ |

Plus: gates must not self-skip (each ingest path is a separately required test, gated on the ledger
capability, so an absent export produces a visible SKIP rather than a substituted pass); restart and
source-switching exercised; an archive partially written by an earlier implementation detected
rather than silently extended.

**And, as the boundary in §0:** the migrations diff stays empty. A change to Part A that adds
stored data has left Part A.

## 8. Questions for the reviewer

1. **Is the refuse-rather-than-omit posture the right interim**, or should node-only mode be
   disabled outright until §6.1 lands? It currently produces a correct archive on simple chains and
   stops cleanly elsewhere — usable, but not a general replacement.
2. **Which chain becomes the parity oracle**, and how soon can ground truth be captured? This is
   the only irreversible item; the window closes when the indexer is switched off.
3. **Is `MIDNIGHT_LEDGER_WASM` acceptable as an interim**, or should the patched build be vendored
   or published under a scoped name? It keeps `package.json` portable but makes the capability
   depend on operator configuration, and it replaces the whole ledger rather than one method.
   **Related and blocking §6.3: where should the ledger branch be pushed?** No fork exists under
   `acedward`, and pushing to the upstream org unprompted is not something I will do.
4. **Should metadata be captured per node version at build time** (the indexer's approach, pinned
   artifacts) **or fetched from the node at ingest and cached per runtime version?** The former
   matches the reference and is reproducible; the latter needs no capture step but makes ingest
   depend on `state_getMetadata` availability for historical blocks.
5. **For a system transaction appearing in both sources** — which supplies the archived bytes and
   position? Needed for §6.5 and unanswerable without item 2.

## 9. Changes from revision 4

| Revision 4 | Revision 5 |
|---|---|
| A and B both described; scope left to the reader | **§0 states the review scope: A only. B is future work and explicitly out of this round** |
| Branch state local-only | **All four branches pushed to `git@github.com:acedward/UmbraDB.git`, heads recorded (§2.2)** |
| Ledger proof was a one-off run, script in `/tmp` | **Committed and rerunnable, with the indexer ground truth alongside it (§2.5)** |
| Ledger fork "2 commits, unpushed" | **3 commits — and the reason it is unpushed is now stated: no destination fork exists (§6.3, §8.3)** |
| `feat/zswap-root-feed` not mentioned | **Recorded as a Part B collision, explicitly not a Part A blocker (§6.6)** |
| Compose overlay, CLI and store-interface files unlisted | Listed with absolute paths (§2.3, §2.4) |
| Required actions unlinked to the open decisions | Each gated item names the decision it waits on (§6) |
