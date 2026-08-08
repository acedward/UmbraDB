# Plan: finish replacing the indexer with the node as the archive ingest source

**Revision 6 (2026-08-08).** This revision incorporates the domain, adversarial, and release
review of revisions 1–5. It deliberately retracts the revision-5 claim that node-only ingest has
no silent gaps. The current branch proves source parity on one simple devnet range, but it is not
yet a safe general replacement for the indexer.

> **Current merge verdict: BLOCK.** Part A becomes mergeable only when the node-derived path
> produces the same persisted archive as the indexer for every supported transaction source and
> framing, or refuses *before any write* whenever that equivalence cannot be established.

This document concerns only Part A, `feat/indexer-independent-ingest`. Contract ledger state,
projections, feeds, Effectstream changes, and every other new stored category are separate work and
must not enter this PR.

---

## 0. Decisions made by this revision

| Question from revision 5 | Decision |
|---|---|
| Can the current refuse-rather-than-omit heuristics support cutover? | **No.** They have false-negative cases (§5.1–§5.2). Node-only remains experimental and cutover-blocked until exact metadata decoding lands. |
| Is block-scoped metadata in scope? | **Yes.** It is a prerequisite for source equivalence, not follow-up work. |
| Is `MIDNIGHT_LEDGER_WASM` a release dependency? | **No.** It is acceptable only for local verification. The release path must use an upstreamed, published, vendored, or otherwise exact and reproducible artifact. |
| Is test-chain parity sufficient? | **No.** It proves the genesis/bare-extrinsic slice only. A reward-bearing oracle range and required non-skipping gates are still needed. |
| May this PR add new archive data? | **No.** It substitutes the ingest source. It does not add stored business data, projections, feeds, or contract state. |

The remaining owner coordination choices are narrower still, now that the ledger fork has a
publication destination (`git@github.com:acedward/midnight-ledger.git`, both branches pushed —
§5.7a). What is left: **which reward-bearing chain/range to capture before its indexer
disappears** — the only irreversible item — and whether the upstream PR targets
`midnightntwrk/midnight-ledger` directly, which is an owner action, not one to take unprompted.

## 1. Goal and scope

UmbraDB's `chain-archive-sync/` component stores finalized Midnight blocks and their ordered ledger
transactions in PostgreSQL. The old path obtains transaction rows and D-parameter values from the
Midnight indexer's GraphQL API. Part A replaces that source with the Midnight node.

> **Acceptance invariant:** for the same finalized range, indexer-sourced and node-sourced ingest
> produce identical persisted rows, in the same order, for
> `block_height, block_hash, position, tx_hash, kind, protocol_version, raw bytes`.

The invariant includes submitted calls even when dispatch fails because the reference indexer
decodes calls from block extrinsics; it is not an execution-success filter.

### In scope — the minimum source substitution

- block, header, extrinsic, historical storage/event, and runtime-metadata reads from the node;
- decoding every extrinsic framing the reference indexer decodes;
- regular and system transactions from every source the indexer uses;
- the authoritative ledger transaction hashes and exact persisted ordering;
- D-parameter retrieval through the node runtime API;
- continuity, identity, runtime-version, retry, restart, and source-switch safety;
- a reproducible ledger dependency and exact differential test gates.

### Out of scope

- `transactions.result` changes (it was already `NULL` in indexer mode);
- projections, UTXO feeds, Effectstream integration, contract state, and new stored categories;
- Part B (`feat/contract-ledger-state`) and unrelated concurrent branches.

The migration diff is expected to remain empty:

```bash
git diff --name-only main...HEAD -- src/postgres/migrations/
```

If completeness/source-version detection cannot be implemented using the existing archive and
watermark facilities, any proposed migration requires a separate scope decision before it enters
Part A.

## 2. Repositories and reviewed baseline

Status recorded for the baseline on which this revision was written; use `git rev-parse HEAD` for
the eventual review commit rather than treating these hashes as permanent documentation.

| Path | Baseline | Role |
|---|---|---|
| `/home/eddie/umbradb-fork` | `c7d34c1`, `feat/indexer-independent-ingest`; 33 commits and 23 changed files over current remote `main` `3c0c68b`; zero migrations | Part A implementation and this plan |
| `/home/eddie/midnight-ledger-fork` | `1a561ac`, `feat/expose-system-transaction-hash`; four local commits after ledger 8.1.0. **Publication destination now configured and pushed:** `git@github.com:acedward/midnight-ledger.git` (remote `fork`) | Required upstream WASM binding and its verification fixture, exactly as verified |
| `/home/eddie/midnight-ledger-fork-x` | `feat/expose-system-transaction-hash` off `ledger-8` (`272c25fc`), same fork remote | The **PR-able** re-application of that binding onto upstream's live branch, which is 305 commits ahead of the verified base — see §5.7a |
| `/home/eddie/midnight-reference-mainnet/v1.0.0` | read-only reference | Node, indexer, ledger, and toolkit behavior being reproduced |

Key Part A files:

- `/home/eddie/umbradb-fork/chain-archive-sync/extrinsic-decoder.ts`
- `/home/eddie/umbradb-fork/chain-archive-sync/sync-service.ts`
- `/home/eddie/umbradb-fork/chain-archive-sync/tx-replay-decoder.ts`
- `/home/eddie/umbradb-fork/chain-archive-sync/node-rpc-client.ts`
- `/home/eddie/umbradb-fork/test/integration/chain-archive-source-parity.integration.test.ts`
- `/home/eddie/umbradb-fork/test/integration/chain-archive-node-only.integration.test.ts`

Ledger evidence:

- `/home/eddie/midnight-ledger-fork/ledger-wasm/src/tx.rs`
- `/home/eddie/midnight-ledger-fork/ledger-wasm/ledger-v8.template.d.ts`
- `/home/eddie/midnight-ledger-fork/ledger-wasm/verification/verify-system-tx-hash.mts`
- `/home/eddie/midnight-ledger-fork/ledger-wasm/verification/indexer-ground-truth.txt`

## 3. Reference behavior to reproduce

The indexer is not merely a transport. Its node adapter defines which bytes become archive
transactions and their ordering.

| Concern | Reference behavior |
|---|---|
| Extrinsics | Fetch every extrinsic and decode its call with the runtime metadata: `midnight-indexer/chain-indexer/src/infra/subxt_node/runtimes/v1_0_0.rs:47-88`. |
| Direct regular calls | Archive `send_mn_transaction` from decoded call data, independent of dispatch outcome. |
| Direct system calls | Archive `send_mn_system_transaction` from decoded call data, independent of dispatch outcome. |
| Event system transactions | Decode every `SystemTransactionApplied` event: `runtimes/v1_0_0.rs:90-117`. |
| Ordering | Prepend event-borne system transactions before the extrinsic-derived list: `runtimes/v1_0_0.rs:160-163`. |
| Runtime schema | Use version-specific generated metadata; the node toolkit likewise decodes with metadata selected for the block being read (`midnight-node/util/toolkit/src/fetcher/compute_task.rs:184-230`). |
| Hashes | Use ledger `Transaction::transaction_hash()` and `SystemTransaction::transaction_hash()` as authoritative identities. |

The reference establishes event-first ordering and that failed direct calls remain in the submitted
extrinsic population. Ground-truth capture is still needed to establish how the indexer's database
and GraphQL surface expose a successful direct system transaction that is also present as an event,
including any hash-based deduplication and resulting position.

## 4. What is genuinely demonstrated

### 4.1 Extrinsic-borne genesis transactions

With the patched ledger binding, node ingest archives the devnet's five genesis system
transactions and regular transactions under their authoritative hashes, with one position counter
across both kinds in extrinsic order.

A manual comparison over heights 0–1599 reported 26 indexer rows and 26 node rows with identical
persisted fields. The committed parity test performs the same field-by-field comparison but
defaults to 60 blocks. Both results concern a devnet whose observed system transactions are the
five extrinsic-borne genesis transactions; they do not exercise event-generated systems,
signed/general framing, or a runtime upgrade.

### 4.2 System transaction hash export

The ledger fork's `SystemTransaction.transactionHash()` binding delegates directly to the Rust
ledger method used by the indexer. The committed verification script recomputes the five captured
genesis hashes from their indexer-recorded raw bytes and matches 5/5.

This validates those known vectors. It does **not** qualify replacing UmbraDB's entire published
8.0.3 ledger module with an arbitrary 8.1.0 build for every transaction and supported protocol
range; dependency provenance and compatibility remain §5.4 work.

### 4.3 Other resolved implementation findings

- classification of bare extrinsics is driven by `(pallet, call)`, not payload content;
- malformed envelopes and recognized-but-unmapped bare calls fail before the block write;
- protocol-version, parent-continuity, and genesis-identity checks are present;
- a detected unhashable extrinsic-borne system transaction fails before `putBlockBundle`;
- indexer mode does not require node call-index classification unless the oracle cross-check is
  explicitly enabled;
- Part A adds no migrations or stored category.

## 5. Blocking correctness gaps

### 5.1 Raw event-tag counting has a false-negative combination

The current guard reads raw `System::Events`, counts occurrences of the system-transaction tag,
and refuses only when:

```text
tagged event payload count > archived extrinsic-system count
```

That comparison is not a completeness proof. Let:

- `S` = successful direct system extrinsics, each also represented by an event;
- `F` = failed direct system extrinsics, archived from calls but producing no event;
- `R` = runtime-generated event-only system transactions.

Then the guard compares `S + R > S + F`, which detects an omission only when `R > F`.
One failed direct system extrinsic plus one runtime-generated event yields equal counts: the guard
passes, the runtime transaction is omitted, and the watermark advances. Raw substring counting
also cannot establish event identity, phase, bytes, ordering, or duplication semantics.

Therefore revision 5's statements that event omissions are always detected, node ingest is
"correct where it completes," and no silent gaps remain are retracted.

### 5.2 Signed/general detection is incomplete and heuristic

The current undecodable-framing guard searches the raw extrinsic body only for
`midnight:transaction`. It does not search for `midnight:system-transaction`. A signed/general
direct system call can therefore be classified as non-Midnight and omitted. If it fails the
root-origin check, no event compensates for or detects it, while the indexer still archives the
submitted direct call.

Searching both tags would improve fail-closed coverage but would remain a substring heuristic, not
the reference behavior. Correct support requires decoding the actual dispatched call using the
metadata for that block.

### 5.3 Runtime metadata and supported versions

`CALL_INDICES_BY_PROTOCOL` contains pinned indices only for node 1.0.x. Node 0.22.x is supported by
the selected ledger codec but deliberately has no call mapping. A runtime layout change inside a
broad protocol range also cannot be decoded reliably from constants.

Block-scoped metadata is therefore part of this PR's source-substitution scope. The implementation
may follow the indexer's reproducible build-time capture per node version, or fetch historical
metadata from the node and cache it by runtime identity, but it must prove that the metadata belongs
to the block being decoded and cover runtime-upgrade boundaries.

### 5.4 The successful ledger dependency is not deliverable yet

UmbraDB pins published `@midnight-ntwrk/ledger-v8@8.0.3`, which lacks the system hash export.
Successful genesis ingest currently relies on `MIDNIGHT_LEDGER_WASM` pointing at a local,
gitignored 8.1.0 build. The override:

- replaces the entire decoder/hashing module rather than adding one method;
- is selected by path existence, without a commit, checksum, version, or known-vector startup
  check;
- silently falls back when an explicitly configured path does not exist;
- is not rebuilt or exercised as a required fresh-clone CI dependency.

The local override remains useful verification plumbing, not the release mechanism.

### 5.5 Existing incomplete archives and source switching

Sync resumes at watermark + 1 and does not establish that earlier transaction sequences were
written by a complete implementation. `ON CONFLICT DO NOTHING` means replay cannot reliably repair
missing rows or shifted positions. The final implementation must detect an older incomplete
node-only history before extending it, and must exercise indexer→node and node→indexer switching.

At minimum, switching to node mode must preflight every required decoder/hash capability rather
than waiting to encounter a particular system extrinsic. A non-empty archive whose completeness
cannot be established must be refused with an actionable recovery path.

### 5.6 The current tests are evidence, not release gates

Separating stock-ledger refusal and patched-ledger success into different tests fixes the earlier
"either outcome passes" defect. However:

- the real-node and parity suites still self-skip when the node, indexer, or patched capability is
  absent;
- required CI does not yet provision and require both successful ingest and refusal modes;
- the parity test defaults to 60 blocks, not the manually reported 0–1599 range;
- the available devnet has no event-generated system transactions or signed/general Midnight
  calls;
- restart, both source-switch directions, runtime-boundary decoding, failed direct system calls,
  mixed blocks, and legacy-partial-archive detection are not covered by the parity gate.

A visible skip is better than a vacuous pass, but it is not acceptance evidence for a required
cutover gate.

### 5.7 Specifications and release records are not yet closed out

`system-transactions-plan.md` is explanatory, not the only normative artifact. Before merge,
`design.md`, `proposal.md`, `tasks.md`, the node-ingest delta, public source comments, feature docs,
supply-chain inventory, and versions lock must all state the same behavior and status. In
particular, `tasks.md` still contains the superseded regular-only exclusion plan and old completion
claims.

Graphify is stale and the required persona evidence is not recorded on a PR. The ledger patch now
has a publication location (§5.7a) but still no upstream PR, and no published artifact — so the
release-dependency objection in §0 stands unchanged.

### 5.7a Ledger patch: published to a fork, not yet upstream

The binding now has somewhere to live. Two branches exist on
`git@github.com:acedward/midnight-ledger.git`, and they are **not interchangeable**:

| Branch | Head | Base | Purpose |
|---|---|---|---|
| `feat/expose-system-transaction-hash` | `1a561ac` | `d89e0b6`, the reference **8.1.0** checkout | **The artifact actually verified.** The 5/5 genesis-hash match was produced by a `wasm-pack` build of *this* tree. It reproduces the evidence; it is not a merge candidate |
| `feat/expose-system-transaction-hash-ledger8` | `97a6c9dd` | `ledger-8` @ `272c25fc` (**8.2.0-rc.1**, 305 commits ahead) | **The merge candidate.** The same binding re-applied to upstream's live branch |

Two branches rather than a rebase because all three files the patch touches changed upstream in
those 305 commits; re-applying cleanly is more auditable than resolving a three-way conflict, and
it keeps the verified tree byte-identical to what produced the evidence.

Confirmed against `ledger-8` @ `272c25fc` before re-applying: `impl SystemTransaction`
(`ledger-wasm/src/tx.rs`) still exposes only `new`/`serialize`/`deserialize`/`toString`, so the gap
is still open upstream and the patch is still needed. The re-application follows upstream's current
conventions rather than the original: `Result<String, JsError>` via `to_hex_ser`
(`ledger-wasm/src/conversions.rs:140`), and `transactionHash(): TransactionHash` in the template
typings, matching the sibling `Transaction` declaration instead of the original's bare `string`.

**Verification status differs between the two, and this is the load-bearing caveat.** The merge
candidate's check was:

```bash
cd /home/eddie/midnight-ledger-fork-x && cargo +1.95 check -p midnight-ledger-wasm --target wasm32-unknown-unknown
```

which finished clean in 3m36s. That is a **compile check only**. The 5/5 hash evidence belongs to
the 8.1.0 branch; nothing has recomputed the genesis hashes from an 8.2.0-rc.1 build. Until that
happens the merge candidate is **unverified against ground truth**, and Part A must keep consuming
the verified 8.1.0 tree — which is what `MIDNIGHT_LEDGER_WASM` currently points at.

Note the toolchain requirement, since it is not pinned in the repo: `ledger-8`'s dependency tree
needs **rustc ≥ 1.95** (`sysinfo@0.39.1`); the machine default of 1.93.0 fails to resolve before
compiling anything.

## 6. Required work, in order

All items below are Part A prerequisites unless explicitly described as release coordination.

1. **Prevent the incomplete path from being mistaken for supported cutover.** Until items 2–6
   land, node-only mode must remain explicitly experimental or be disabled outright. Documentation
   and CLI output must not call it a general indexer replacement.
2. **Implement block-scoped metadata decoding.** Decode every extrinsic framing and
   `SystemTransactionApplied` event using the runtime schema for the exact block. Do not use tag
   substrings or aggregate counts as completeness proofs.
3. **Reproduce transaction combination and ordering exactly.** Cover runtime-generated events,
   failed direct system calls, successful direct calls represented in both sources, conflicting
   bytes for one hash, and the indexer's event-first ordering/deduplication behavior.
4. **Make the ledger capability reproducible.** Upstream and publish the binding, or vendor/pin a
   reviewed artifact with exact provenance and CI reconstruction. Qualify the selected ledger
   build across every protocol range Part A claims to support. A bad explicit override must fail
   immediately rather than fall back.
5. **Define archive compatibility and source-switch behavior.** Detect histories written by an
   older incomplete implementation; exercise restart and both source-switch directions; provide a
   documented recovery path instead of relying on conflict-ignored replay.
6. **Capture and commit reward-bearing ground truth while the indexer exists.** Record network,
   genesis hash, block range, indexer/node/runtime versions, queries, exact ordered rows, fixture
   checksums, and cases covering the §7 matrix.
7. **Make the gates required.** CI must separately require stock-capability refusal, successful
   node-only ingest with the release artifact, and exact indexer↔node parity. Required jobs must
   fail rather than skip when their fixture/service/artifact is missing.
8. **Reconcile and close out the corpus.** Update all normative/status/supply-chain documents,
   regenerate Graphify after final changes, run the three independent persona audits on current
   `main`, fix every blocking finding, and record verdicts plus validation evidence on the PR.

## 7. Merge acceptance matrix

The required parity range must contain and assert every row for:

| Population | Current evidence | Merge requirement |
|---|---|---|
| Genesis extrinsic-borne system transactions | Demonstrated on devnet | Required exact parity gate |
| Bare regular transactions | Demonstrated on devnet | Required exact parity gate |
| Non-genesis runtime-generated system transactions | Not demonstrated | Required |
| Regular and system transactions mixed in one block | Not demonstrated | Required |
| Signed and general regular calls | Not demonstrated | Required |
| Signed/general direct system call, including failed origin | Not demonstrated | Required |
| Failed bare root-dispatched system call | Not demonstrated | Required |
| Successful direct system call also represented by an event | Not demonstrated | Required |
| Runtime-upgrade boundary | Not demonstrated | Required when the supported range contains one |

For every case, compare the exact ordered persisted sequence of `block_height, block_hash,
position, tx_hash, kind, protocol_version, raw bytes`—not set equality and not counts.

Additional gates:

- no indexer request in node-only mode, verified by observation;
- no durable block, transaction, or watermark advancement on any refusal;
- restart and both source-switch directions preserve the same sequence;
- an older incomplete archive is detected rather than silently extended;
- required suites do not self-skip;
- typecheck, build, focused/full tests, strict OpenSpec validation, dependency provenance checks,
  Graphify freshness/diagnostics, and the three persona audits pass;
- the Part A migration diff remains empty unless a separately approved safety migration is proven
  necessary.

## 8. Validation commands

Run from `/home/eddie/umbradb-fork` unless noted:

```bash
git diff --check main...HEAD
git diff --name-only main...HEAD -- src/postgres/migrations/
npm run typecheck
npm run build
npx vitest run test/chain-archive-sync/extrinsic-decoder.test.ts --maxWorkers=1
docker compose -f test/compose/docker-compose.yml run --rm tests \
  npx vitest run test/integration/chain-archive-sync-retry.integration.test.ts --maxWorkers=1
```

Ledger known-vector verification, after building `ledger-wasm/pkg`:

```bash
./node_modules/.bin/tsx \
  /home/eddie/midnight-ledger-fork/ledger-wasm/verification/verify-system-tx-hash.mts \
  /home/eddie/midnight-ledger-fork/ledger-wasm/pkg/midnight_ledger_wasm_fs.js
```

The live parity commands must be wired into a required workflow using the final release artifact;
running the current self-skipping files manually is useful evidence but does not close §7.

After the normative delta is reconciled and the OpenSpec CLI is available:

```bash
openspec validate sprint-9-indexer-independence --strict
openspec validate --all --strict
graphify update .
graphify check-update .
graphify diagnose multigraph --graph graphify-out/graph.json --json
```

## 9. Changes from revision 5

| Revision 5 | Revision 6 |
|---|---|
| Claimed revision 4 left no silent gaps | Retracts the claim and gives the event-count masking counterexample (§5.1) |
| Described event-tag counting as a sufficient refusal guard | Classifies it as a heuristic that cannot prove identity, association, or completeness |
| Said signed/general refusal covered Midnight calls | Records that the implementation scans only the regular tag and misses signed/general system calls (§5.2) |
| Left metadata scope as a reviewer question | Resolves it as a Part A merge prerequisite (§0, §5.3) |
| Treated the local WASM override as an interim deployment choice | Restricts it to local verification and requires reproducible distribution (§5.4) |
| Called test-chain parity "exact parity" without a general qualifier | Limits the claim to the observed devnet population and distinguishes the 60-block automated gate from the 0–1599 manual run (§4.1) |
| Said only one engineering task remained | Lists the complete minimal correctness, compatibility, dependency, evidence, and release work (§6) |
| Included coordination for unrelated Part B/concurrent branches | Removes it from this plan so Part A remains only the ingest-source substitution |
