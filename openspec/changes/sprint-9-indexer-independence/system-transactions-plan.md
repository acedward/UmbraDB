# Plan: finish replacing the indexer with the node as the archive ingest source

**Revision 7 (2026-08-08).** Revision 6 correctly retracted the claim that node-only ingest has no
silent gaps. This follow-up incorporates its independent domain, adversarial, and release audit:
it adds the missing D-parameter invariant, qualifies the current parity test, separates
dispatch-failed calls from ledger-invalid payloads, targets an actually event-bearing oracle
range, and corrects the ledger-override and generated-artifact status. The current branch proves
only a narrow devnet slice; it is not yet a safe general replacement for the indexer.

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
| Is test-chain parity sufficient? | **No.** It proves only part of the genesis/bare-extrinsic slice: the committed comparison omits `block_hash` and all D-parameter observations. An event-bearing oracle range and required non-skipping gates are still needed. |
| May this PR add new archive data? | **No.** It substitutes the ingest source. It does not add stored business data, projections, feeds, or contract state. |
| May an archive start at an arbitrary height? *(owner, 2026-08-08)* | **No — genesis-start only.** Not because mid-start needs the indexer (it does not; it needs an un-pruned archive node — a freshly started indexer is equally blind to pruned history). Genesis-start is chosen because it keeps completeness self-evident under `ON CONFLICT DO NOTHING` (§5.5), it matches the existing identity anchor (the archived genesis block, `sync-service.ts`), and apply-rule parity requires ledger state that can only be built from genesis. Backfilling old history via the existing indexer-sourced mode and then switching sources remains the supported path for history the node no longer serves. |
| Is byte-parity with the indexer negotiable? *(owner, 2026-08-08)* | **No — reaffirmed.** Every dapp consumes the indexer today; a "correct per the node, with documented deviations" relaxation would make the swap permanently hard. Consequence: the indexer's *apply*-validity rule is in scope eventually, which means umbra maintaining ledger state via the WASM's `LedgerState.apply` — a replay engine. That is a real, deliberate cost accepted by this decision, not an accident of the acceptance matrix (see §8a.1, now a sequencing question only). |
| What is the final shape of the work? *(owner, 2026-08-08)* | **Node as an *optional* source, transparent in its results** — not a forced cutover. Both sources stay first-class while the indexer exists. Executed in the stages of §11. |
| When is "unsupported + refuse" an acceptable terminal status? *(owner, 2026-08-08)* | **Only where the indexer itself would fail.** The indexer's mechanism is uniform metadata-driven decoding with no special cases, so almost nothing qualifies. For populations with no producible live fixture, the fallback is **mechanism-equivalence**: implement the indexer's mechanism and prove it with synthesized unit fixtures — the missing specimen changes the evidence type, not the support status (resolves §8a.2). |
| Which ledger artifact ships? *(owner, 2026-08-08)* | **Our own verified 8.1.0 build, vendored** with provenance: ledger commit `1a561ac`, the §8 recipe, SHA-256 checksums, and a CI rebuild-and-compare job. `MIDNIGHT_LEDGER_WASM` demotes to a test-only escape hatch. Swapped for the upstream package when §10 completes. Resolves §5.4's distribution objection. |
| How is a dual-source system transaction archived? *(owner, 2026-08-08)* | **Option (a) of §3(c): match the indexer — archive both rows.** The PK-widening migration (add `position` to `chain_archive.transactions`' key) is hereby **approved** as §1's reserved safety migration; it lands at Stage 2 the earliest, bundled with the metadata-decoding work that first makes dual-source blocks archivable. Refuse-on-collision remains the Stage 1 interim. |

The remaining owner coordination choices are narrower still, now that the ledger fork has a
publication destination (`git@github.com:acedward/midnight-ledger.git`, both branches pushed —
§5.7a). What is left: **which oracle ranges to capture before their indexers disappear, including
an observed non-genesis runtime-generated `SystemTransactionApplied` transaction and a real
D-parameter change** — the time-sensitive choice — and whether the upstream PR targets
`midnightntwrk/midnight-ledger` directly, which is an owner action, not one to take unprompted.

## 1. Goal and scope

UmbraDB's `chain-archive-sync/` component stores finalized Midnight blocks and their ordered ledger
transactions in PostgreSQL. The old path obtains transaction rows and D-parameter values from the
Midnight indexer's GraphQL API. Part A replaces that source with the Midnight node.

> **Transaction acceptance invariant:** for the same finalized range, indexer-sourced and
> node-sourced ingest produce identical persisted transaction rows, in the same order, for
> `block_height, block_hash, position, tx_hash, kind, protocol_version, raw bytes`.

> **D-parameter acceptance invariant:** the same two runs produce identical ordered
> `system_parameters_d` bridge observations for `block_height, block_hash, observation_index,
> kind, raw bytes`, including the exact heights at which values change.

The reference adapter extracts recognized calls without consulting Substrate dispatch outcome,
but that does **not** mean every failed call becomes an indexer row. The indexer subsequently
deserializes and applies each payload to its ledger state. A valid payload rejected before ledger
execution (for example, a root-origin failure) may still be archived; a malformed payload or one
rejected by ledger replay can instead prevent the reference block from indexing. Part A must match
that row-versus-refusal outcome and, on refusal, make no durable write or watermark advance.

### In scope — the minimum source substitution

- block, header, extrinsic, historical storage/event, and runtime-metadata reads from the node;
- decoding every extrinsic framing the reference indexer decodes;
- regular and system transactions from every source the indexer uses;
- the authoritative ledger transaction hashes and exact persisted ordering;
- D-parameter retrieval through the node runtime API, with exact persisted change-boundary parity;
- continuity, identity, runtime-version, retry, restart, and source-switch safety;
- a reproducible ledger dependency and exact differential test gates.

### Out of scope

- `transactions.result` changes (it was already `NULL` in indexer mode);
- projections, UTXO feeds, Effectstream integration, contract state, and new stored categories;
- Part B (`feat/contract-ledger-state`) and unrelated concurrent branches.

The migration diff is expected to remain empty:

```bash
git diff --name-only origin/main...HEAD -- src/postgres/migrations/
```

If completeness/source-version detection cannot be implemented using the existing archive and
watermark facilities, any proposed migration requires a separate scope decision before it enters
Part A.

## 2. Repositories and reviewed baseline

Status recorded for the baseline on which this revision was written; use `git rev-parse HEAD` for
the eventual review commit rather than treating these hashes as permanent documentation.

| Path | Baseline | Role |
|---|---|---|
| `/home/eddie/umbradb-fork` | `afe5c11`, `feat/indexer-independent-ingest`; 35 commits and 27 changed files over current remote `main` `3c0c68b`; zero migrations | Part A implementation and this plan |
| `/home/eddie/midnight-ledger-fork` | `1a561ac`, `feat/expose-system-transaction-hash`; four local commits after ledger 8.1.0. **Publication destination now configured and pushed:** `git@github.com:acedward/midnight-ledger.git` (remote `fork`) | Required upstream WASM binding and its verification fixture, exactly as verified |
| `/home/eddie/midnight-ledger-fork-x` | `97a6c9dd`, `feat/expose-system-transaction-hash-ledger8` off `ledger-8` (`272c25fc`), same fork remote | The **PR-able** re-application of that binding onto upstream's live branch, which is 305 commits ahead of the verified base — see §5.7a |
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
| Direct regular calls | Extract `send_mn_transaction` from decoded call data without consulting dispatch outcome. |
| Direct system calls | Extract `send_mn_system_transaction` from decoded call data without consulting dispatch outcome. |
| Event system transactions | Decode every `SystemTransactionApplied` event: `runtimes/v1_0_0.rs:90-117`. |
| Ordering | Prepend event-borne system transactions before the extrinsic-derived list: `runtimes/v1_0_0.rs:160-163`. |
| Runtime schema | Use version-specific generated metadata; the node toolkit likewise decodes with metadata selected for the block being read (`midnight-node/util/toolkit/src/fetcher/compute_task.rs:184-230`). |
| Hashes | Use ledger `Transaction::transaction_hash()` and `SystemTransaction::transaction_hash()` as authoritative identities. |
| Downstream validity | Deserialize extracted regular/system bytes (`subxt_node.rs:665-715`) and replay them against indexer ledger state (`ledger_state.rs:67-96, 192-212`); a decode or apply error aborts the reference block rather than producing a row. |

The reference establishes event-first ordering and that direct calls enter the candidate population
before dispatch outcome is considered. It does not establish that malformed or ledger-invalid
payloads persist. Ground-truth capture is still needed for (a) a valid direct call rejected before
ledger execution, (b) deserialization and ledger-apply failures, and (c) how the database/GraphQL
surface exposes a successful direct system transaction that is also present as an event, including
any hash-based deduplication and resulting position.

**(c) is now resolved by code reading (2026-08-08): the indexer does not deduplicate.**
`v1_0_0.rs:160-163` prepends event-borne system transactions and plain-`extend`s the extrinsic
list — no hash comparison anywhere on the path — and the indexer's own `transactions` table
(`indexer-common/migrations/postgres/001_initial.sql`) has **no unique constraint on `hash`**
(`id BIGSERIAL` primary key, plain index on `hash`). A successful direct system call therefore
persists as **two rows**, the event-borne copy first. Byte-parity means umbra must do the same —
and currently cannot: `chain_archive.transactions`' primary key is
`(net, block_height, block_hash, tx_hash)`
(`src/postgres/migrations/chain_archive/001_chain_archive_core.ts:392`), so the second copy
collides and `ON CONFLICT DO NOTHING` silently drops it. This is the one place a safety migration
(§1's reserved scope decision) is affirmatively justified: widen the PK to include `position`.
Until that lands, the correct interim is to **refuse** any block containing the collision
(Stage 1, §11). Live observation of the case remains worthwhile as end-to-end confirmation, but
the combination rule itself no longer waits on it.

## 4. What is genuinely demonstrated

### 4.1 Extrinsic-borne genesis transactions

With the patched ledger binding, node ingest archives the devnet's five genesis system
transactions and regular transactions under their authoritative hashes, with one position counter
across both kinds in extrinsic order.

A manual comparison over heights 0–1599 reported 26 indexer rows and 26 node rows with identical
persisted transaction fields. The committed parity test defaults to 60 blocks and compares
`block_height, position, tx_hash, kind, protocol_version, raw bytes`; despite its stronger comment,
its `Row`/SQL currently omit `block_hash`, and it never queries `bridge_observations`. Both results
concern a devnet whose observed system transactions are the five extrinsic-borne genesis
transactions; they do not exercise event-generated systems, signed/general framing, a runtime
upgrade, or D-parameter change parity.

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
- an explicitly configured but nonexistent `MIDNIGHT_LEDGER_WASM` path fails immediately rather
  than falling back to the behaviorally different stock package;
- indexer mode does not require node call-index classification unless the oracle cross-check is
  explicitly enabled;
- Part A adds no migrations or stored category.

### 4.4 D-parameter decoding

The node path SCALE-decodes two little-endian `u16` values from
`SystemParametersApi_get_d_parameter` at the exact block hash. One live devnet sample,
`0x0a000000`, matched the indexer's `{numPermissionedCandidates: 10,
numRegisteredCandidates: 0}`. A deterministic fake-chain test proves that a changed value is
recorded at the expected height and survives a failed-write retry. Neither is a differential,
persisted indexer↔node gate over a real change boundary, so the D-parameter acceptance invariant
remains open.

## 5. Blocking correctness gaps

### 5.1 Raw event-tag counting has a false-negative combination

The current guard reads raw `System::Events`, counts occurrences of the system-transaction tag,
and refuses only when:

```text
tagged event payload count > archived extrinsic-system count
```

That comparison is not a completeness proof. Let:

- `S` = successful direct system extrinsics, each also represented by an event;
- `F` = valid direct system calls rejected before ledger execution (for example, `BadOrigin`),
  archived by the indexer but producing no event;
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
direct system call can therefore be classified as non-Midnight and omitted. If a valid payload
fails the root-origin check, no event compensates for or detects it, while the indexer can still
deserialize, replay, and archive the extracted direct call.

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
- checks that an explicit path exists and already fails closed if it does not, but does not bind the
  selected bytes to a commit, checksum, package version, or known-vector startup check;
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
- the parity query omits transaction `block_hash`, despite the acceptance invariant;
- parity covers only transactions: it does not compare D-parameter-derived
  `system_parameters_d` observations or a real change boundary;
- the available devnet has no event-generated system transactions or signed/general Midnight
  calls;
- restart, both source-switch directions, runtime-boundary decoding, row-versus-refusal failure
  cases, mixed blocks, and legacy-partial-archive detection are not covered by the parity gate.

A visible skip is better than a vacuous pass, but it is not acceptance evidence for a required
cutover gate.

### 5.7 Specifications and release records are not yet closed out

`system-transactions-plan.md` is explanatory, not the only normative artifact. Before merge,
`design.md`, `proposal.md`, `tasks.md`, the node-ingest delta, public source comments, feature docs,
supply-chain inventory, and versions lock must all state the same behavior and status. In
particular, `tasks.md` still contains the superseded regular-only exclusion plan and old completion
claims.

Graphify has been regenerated for revision 7 with `graphifyy==0.9.24`; the exact freshness and
diagnostic checks are recorded in §8. It must be regenerated again after any later normative or
implementation change. Required persona evidence is not yet recorded on a PR because no UmbraDB
PR exists. The ledger patch has a publication location (§5.7a) but still no upstream PR and no
published artifact, so the release-dependency objection in §0 stands unchanged.

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
happens the merge candidate is **unverified against ground truth**. Current local evidence must
explicitly set `MIDNIGHT_LEDGER_WASM` to the verified 8.1.0 loader; no tracked configuration or
current shell environment sets that override automatically.

Note the toolchain requirement, since it is not pinned in the repo: `ledger-8`'s dependency tree
needs **rustc ≥ 1.95** (`sysinfo@0.39.1`); the machine default of 1.93.0 fails to resolve before
compiling anything.

## 6. Required work, in order

All items below are Part A prerequisites unless explicitly described as release coordination.

1. **Prevent the incomplete path from being mistaken for supported cutover.** Until items 2–7
   land, node-only mode must remain explicitly experimental or be disabled outright. Documentation
   and CLI output must not call it a general indexer replacement.
2. **Implement block-scoped metadata decoding.** Decode every extrinsic framing and
   `SystemTransactionApplied` event using the runtime schema for the exact block. Do not use tag
   substrings or aggregate counts as completeness proofs.
3. **Reproduce transaction combination, validity, and ordering exactly.** Cover runtime-generated
   events, valid calls rejected before ledger execution, malformed payloads, ledger-apply failures,
   successful direct calls represented in both sources, conflicting bytes for one hash, and the
   indexer's event-first ordering/deduplication behavior. Match either the persisted row or the
   reference block refusal; never convert an invalid reference payload into an archive row.
4. **Close D-parameter parity.** Compare the indexer and historical node runtime-API value at every
   height in an oracle range containing a real change, then compare the exact ordered persisted
   `system_parameters_d` observations and change heights. Include restart and both source-switch
   directions across a change boundary.
5. **Make the ledger capability reproducible.** Upstream and publish the binding, or vendor/pin a
   reviewed artifact with exact provenance and CI reconstruction. Qualify the selected ledger
   build across every protocol range Part A claims to support, preserve the existing bad-path
   fail-closed behavior, and preflight required capabilities before the first archive write.
6. **Define archive compatibility and source-switch behavior.** Detect histories written by an
   older incomplete implementation; exercise restart and both source-switch directions; provide a
   documented recovery path instead of relying on conflict-ignored replay.
7. **Capture and commit event-bearing ground truth while the indexer exists.** The reviewed v1.0.0
   runtime's block reward is zero and its reward pallet is disabled; CNight observation is a
   concrete runtime source of `SystemTransactionApplied`. Capture a range with an actually observed
   non-genesis event transaction, plus separate fixtures as needed for every remaining §7 case.
   Record network, genesis hash, range, indexer/node/runtime versions, queries, exact ordered rows,
   and fixture checksums.
8. **Make the gates required.** CI must separately require stock-capability refusal, successful
   node-only ingest with the release artifact, exact transaction parity, and exact D-parameter
   observation parity. Required jobs must fail rather than skip when a fixture/service/artifact is
   missing.
9. **Reconcile and close out the corpus.** Update all normative/status/supply-chain documents,
   regenerate Graphify after final changes, run the three independent persona audits on current
   `main`, fix every blocking finding, and record verdicts plus validation evidence on the PR.

## 7. Merge acceptance matrix

The required parity range must contain and assert every row for:

**Evidence types.** *Live parity* = compared against the indexer on a running chain, the strongest
form. *Mechanism-equivalence* = the reference's mechanism implemented and exercised against real
captured bytes through a fake node, used where **no reachable chain emits the population** (§0's
fallback rule). A row's evidence type is part of its status, not a footnote — reading
"demonstrated" without it would overstate several of these.

| Population | Current evidence | Merge requirement |
|---|---|---|
| Genesis extrinsic-borne system transactions | ✅ **Live parity** (60 blocks, 5 system tx, identical) | Required exact parity gate |
| Bare regular transactions | ✅ **Live parity** (38 transactions, identical incl. `block_hash`) | Required exact parity gate |
| D-parameter observations and change heights | ✅ **Live parity** (added 2026-08-11; the two modes read different sources, so this was previously unchecked) | Required exact observation parity |
| Non-genesis runtime-generated system transactions | ✅ **Mechanism-equivalence** — archived under the runtime's own hash, event-first. No reachable chain emits these (v1.0.0 rewards are zero, reward pallet disabled) | Required |
| Regular and system transactions mixed in one block | ✅ **Mechanism-equivalence** — one position sequence across both kinds | Required |
| Successful direct system call also represented by an event | ✅ **Mechanism-equivalence** — both copies stored, event-borne first, per the reference's non-deduplication | Required |
| Signed and general regular calls | ✅ **Mechanism-equivalence** — decoded via metadata, payload byte-exact | Required |
| Signed/general direct system call with a governance-allowed, ledger-valid payload | ⚠️ **Partial** — the decode path is covered by the same metadata mechanism; end-to-end ingest of one is not | Required |
| Valid regular/system call rejected before ledger execution (including bad origin) | ❌ Not demonstrated — depends on **U5**, which needs live observation | Required exact row parity |
| Malformed regular/system payload rejected during indexer deserialization | ✅ **Mechanism-equivalence** (Stage 4): same ledger, garbage bytes refuse at `deserialize` exactly as the reference aborts | Required exact refusal parity; no write |
| Deserializable regular/system payload rejected by indexer ledger replay | ✅ **Mechanism-equivalence** (Stage 4): a one-byte proof corruption deserializes and refuses at `well_formed`; and the load-bearing counterpart is pinned — an apply-`Failure` is an **archived row**, not a refusal, read from the reference source | Required exact refusal parity; no write |
| Runtime-upgrade boundary | ❌ Not demonstrated — **cannot be**: the only reachable chains never upgraded, so their metadata is byte-identical at genesis and tip (§12.3). Needs a second runtime from any source | Required when the supported range contains one |

For every case, compare the exact ordered persisted sequence of `block_height, block_hash,
position, tx_hash, kind, protocol_version, raw bytes`—not set equality and not counts.

The D-parameter gate must separately compare exact ordered `system_parameters_d` observations for
`block_height, block_hash, observation_index, kind, raw bytes`. Its range must include at least one
real D-parameter change and assert both the unchanged spans and the exact change height. The same
result is required across restart and both source-switch directions.

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
git merge-base --is-ancestor origin/main HEAD
git diff --check origin/main...HEAD
git diff --check
git diff --name-only origin/main...HEAD -- src/postgres/migrations/
npm run typecheck
npm run build
npx vitest run test/chain-archive-sync/extrinsic-decoder.test.ts --maxWorkers=1
docker compose -f test/compose/docker-compose.yml run --rm tests \
  npx vitest run test/integration/chain-archive-sync-retry.integration.test.ts --maxWorkers=1
```

The recorded 8.1.0 known-vector run used ledger commit `1a561ac`, `wasm-pack 0.15.0`, and
`rustc 1.93.0`. `wasm-pack --target bundler` does not create the Node filesystem loader or the
`#self` Node import mapping used by its snippets. The repository's publication build generates both
in `bagel.nix:76-147`; for this local proof, the pinned 8.0.3 loader is only a template. Its
snippet-directory token must be rewritten to the unique directory emitted by the 8.1.0 build, and
the generated package manifest must map `#self` to that loader. A verbatim loader copy is invalid.
This is reproducible local evidence, not a release-distribution mechanism:

```bash
set -euo pipefail
cd /home/eddie/midnight-ledger-fork/ledger-wasm
test "$(git rev-parse HEAD)" = "1a561ac57c60526254ff40151bf49453d6d2648b"
test "$(wasm-pack --version)" = "wasm-pack 0.15.0"
test "$(rustc --version)" = "rustc 1.93.0 (254b59607 2026-01-19)"
wasm-pack build --target bundler
ledger_snippet_dir="$(
  find pkg/snippets -mindepth 1 -maxdepth 1 -type d \
    -name 'midnight-ledger-wasm-*' -printf '%f\n'
)"
test -n "$ledger_snippet_dir"
test "$(printf '%s\n' "$ledger_snippet_dir" | wc -l)" -eq 1
sed -E "s/midnight-ledger-wasm-[0-9a-f]+/$ledger_snippet_dir/g" \
  /home/eddie/umbradb-fork/node_modules/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_fs.js \
  > pkg/midnight_ledger_wasm_fs.js
grep -q "snippets/$ledger_snippet_dir/inline0.js" pkg/midnight_ledger_wasm_fs.js
jq '
  .name = "@midnight-ntwrk/ledger-v8"
  | .files = ((.files + ["midnight_ledger_wasm_fs.js", "snippets"]) | unique)
  | .sideEffects = ((.sideEffects + ["./midnight_ledger_wasm_fs.js"]) | unique)
  | .imports = {"#self": {
      "browser": "./midnight_ledger_wasm.js",
      "node": "./midnight_ledger_wasm_fs.js"
    }}
  | .types = "./midnight_ledger_wasm.d.ts"
  | .exports = {
      "types": "./midnight_ledger_wasm.d.ts",
      "browser": "./midnight_ledger_wasm.js",
      "node": "./midnight_ledger_wasm_fs.js"
    }
' pkg/package.json > pkg/package.json.local
mv pkg/package.json.local pkg/package.json

cd /home/eddie/umbradb-fork
./node_modules/.bin/tsx \
  /home/eddie/midnight-ledger-fork/ledger-wasm/verification/verify-system-tx-hash.mts \
  /home/eddie/midnight-ledger-fork/ledger-wasm/pkg/midnight_ledger_wasm_fs.js
```

The live parity commands must be wired into a required workflow using the final release artifact;
running the current self-skipping files manually is useful evidence but does not close §7.

Use pinned validation tools:

```bash
npx --yes --package @fission-ai/openspec@1.6.0 openspec \
  validate sprint-9-indexer-independence --strict
npx --yes --package @fission-ai/openspec@1.6.0 openspec validate --all --strict
uvx --from graphifyy==0.9.24 graphify update .
uvx --from graphifyy==0.9.24 graphify check-update .
uvx --from graphifyy==0.9.24 graphify \
  diagnose multigraph --graph graphify-out/graph.json --json
```

Graphify's `built_at_commit` identifies the **input HEAD at generation time**. Before committing
the generated outputs, the following working-tree audit check must pass:

```bash
test "$(git rev-parse HEAD)" = "$(jq -r .built_at_commit graphify-out/graph.json)"
```

It is not a final artifact-commit equality gate: committing files that contain the input hash
necessarily creates a different commit hash. After generated outputs are committed, use the pinned
`check-update`, diagnostics, manifest/diff inspection, and recorded input-parent relationship to
establish content freshness.

Recorded plan-tranche validation on 2026-08-08:

| Check | Result |
|---|---|
| Strict `sprint-9-indexer-independence` validation | **PASS** with OpenSpec 1.6.0 |
| Full strict OpenSpec corpus | **14 PASS / 2 FAIL**; the two failures are the pre-existing no-delta changes `v1.1.0-formal-completion` and `v1.1.0-quint-model-checking` |
| Typecheck and build | **PASS** |
| Focused extrinsic-decoder suite | **24/24 PASS** |
| Ledger 8.1.0 indexer-ground-truth vectors | **5/5 PASS**, including a clean commit-`1a561ac` archive build using the documented loader/manifest adaptation |
| Graphify update, content check, freshness check, and multigraph diagnostics | **PASS** with `graphifyy==0.9.24`; `built_at_commit` is `afe5c11`, matching the reviewed working tree's input HEAD |
| Part A migration diff and `git diff --check` | **PASS**; no migration file |

These checks validate the plan tranche and its currently implemented narrow slice. They do not
override the Part A merge `BLOCK` or substitute for the missing required live gates in §7.

## 8a. Dissent: concerns with revision 7, from the implementing author

Recorded because revisions 6 and 7 were written by independent review passes and this plan is
going to a reviewer as a single document. Agreement and disagreement should both be visible.

**Where revision 7 is right, and I was wrong.** §5.1's counting argument holds: the guard compares
`S + R > S + F` and so detects an omission only when `R > F`, which one failed direct system
extrinsic plus one runtime-generated event defeats exactly. Revision 5's "no silent gaps" claim was
mine and it was wrong. §5.2 is also confirmed against the code — `extrinsic-decoder.ts:264` tests
only `STANDARD_TX_TAG_PREFIX`, so a signed or general direct *system* call returns `not_midnight`
and is silently omitted rather than refused. The BLOCK verdict follows from those two facts and I
agree with it.

The concerns below are about scope and satisfiability, not about those findings.

### 8a.1 One §7 row silently requires a ledger replay engine

The matrix requires, for "deserializable payload rejected by indexer ledger replay", *exact refusal
parity, no write*. Deciding that a payload **would be** rejected by ledger replay requires
maintaining and advancing ledger state — which is what the indexer does and what UmbraDB does not.
`tx-replay-decoder.ts` calls `Transaction.deserialize` / `SystemTransaction.deserialize` and
nothing else: there is no `LedgerState`, no apply, no state to advance.

So that row is not a test to write. It is "Part A grows a replay engine," which contradicts §1's
own framing of UmbraDB as an archive rather than a state store, and is a far larger change than the
source substitution this PR describes.

The two failure modes in that part of the matrix are very different in cost and should not share a
row:

| Reference failure | Detectable without ledger state? | Cost to reach parity |
|---|---|---|
| Malformed payload, rejected at deserialization | **Yes** — WASM deserialize already runs and already throws | Small; arguably already met |
| Deserializable payload rejected by ledger *apply* | **No** — needs ledger state advanced across the range | A replay engine |

**Recommendation:** split the row. Keep deserialization-failure parity as a merge gate. Move
apply-failure parity out of Part A, or make it an explicit, separately-approved decision to build
replay — not a line item a reader would price as one more test.

**Partially overruled by the owner (2026-08-08, §0):** byte-parity is reaffirmed as
non-negotiable, so apply-rule parity — and therefore replay — is a matter of *when*, not
*whether*. The WASM ledger exposes `LedgerState.apply`, so it is implementable without leaving
JS. What survives of this concern is sequencing only: the rows should still be split by cost
(deserialize-failure parity is nearly free and can gate the merge; apply parity is its own
milestone, after block-scoped metadata decoding), and the replay engine should be planned as the
deliberate, sized piece of work it is. Note it also hard-couples to genesis-start (§0): ledger
state can only be built by replaying from block 0.

### 8a.2 Several merge-blocking rows have no stated fallback if the population cannot be found

"Signed and general regular calls", "signed/general direct system call", and a "real D-parameter
change" all require a chain that actually exhibits them. A signed Midnight call is *possible*
(the pallet ignores its origin) but needs someone to have submitted one; a D-parameter change is a
governance event. §6.7 says "separate fixtures as needed" without saying what happens when no
reachable chain has ever produced the population.

As written, those rows are unfalsifiable: they can neither be satisfied nor ruled out, and a gate
that can only ever stay red is not a gate. **Recommendation:** for each, state the fallback
explicitly — a synthesized fixture against a local chain, or a documented "unsupported and refused
fail-closed" status with the refusal tested. Either is defensible; silence is not.

### 8a.3 There is no position on the indexer disappearing first

This is the concern I would raise loudest. The BLOCK is correct on the merits, but the schedule is
not ours: the indexer is being decommissioned, and §6.7 depends on capturing ground truth *from a
live indexer*. If it is switched off before those captures exist, Part A becomes permanently
unmergeable **by its own criteria**, and there is simultaneously no working ingest path. The plan
treats the oracle as time-sensitive but does not say what UmbraDB does if the deadline is missed.

**Recommendation:** add an explicit contingency. Either (a) a reduced-support cutover — node-only
ingest ships supporting exactly the populations that are proven, refusing loudly on the rest, which
is close to today's behaviour once §5.1/§5.2 are fixed; or (b) an owner commitment to keep one
indexer instance alive for parity capture past the decommission date. Both are decisions someone
has to make; neither is made here.

**Correction (owner question, 2026-08-08), which softens this concern.** "The oracle disappears
with the hosted indexer" overstates the loss. The indexer derives everything from the node — that
is Part A's own premise — so the oracle's *inputs* never disappear while an archive node retains
full history, and the oracle itself is deterministic software this project already has
(`/home/eddie/midnight-reference-mainnet/v1.0.0/midnight-indexer`, plus the published
`indexer-standalone` images). Reference answers for any range can therefore be **regenerated at
will** by pointing a self-hosted indexer at an archive node. What is genuinely at risk is only:

- an **archive node with un-pruned history** for the chain of interest — if every node prunes,
  the inputs really are gone, and *that* is the irreversible loss;
- a **runnable, protocol-compatible indexer build** — software rot, slow but real, mitigated by
  pinning the image/sources now.

So contingency (b) above becomes much cheaper than "keep the hosted indexer alive": ensure one
archive node exists and pin the indexer image. §6.7's capture-before-the-deadline framing should
be read with this correction; capturing early is still prudent (it is cheap now and archival
guarantees are someone else's promise), but it is not the cliff-edge revisions 6–7 describe.

### 8a.4 The plan should separate "safe to merge" from "safe to cut over"

Revisions 6 and 7 grew this from a lean source substitution into a nine-item program: block-scoped
metadata, replay-outcome parity, D-parameter change-boundary parity, CI provisioning, corpus
reconciliation. Each item is individually justified. But the stated goal has been, consistently,
*replace the indexer with the node and produce the same archive* — and a program that cannot land
until every population on a live oracle has been observed may not land at all.

**Recommendation:** tier the matrix. A **merge** tier — the branch is correct, fail-closed, and
strictly better than what exists — versus a **cutover** tier, where node-only becomes the supported
default. Most of §7 is plainly cutover criteria. Merging behind an experimental flag (§6.1 already
requires the flag) does not require them, and keeping the two tiers fused gives up the ability to
land safe work incrementally while the deadline runs.

### 8a.5 One fix is available now and is being deferred

§5.2 correctly notes that searching both tags is still a substring heuristic rather than the
reference behaviour. True — but the gap it closes is between *silently omitting* a signed system
call and *loudly refusing* it, and fail-closed-over-silent-omission is the property this plan
treats as load-bearing everywhere else. It is a one-line change at `extrinsic-decoder.ts:264`.

**Recommendation:** make it now rather than folding it into block-scoped metadata decoding.
It reduces silent data loss today, it is independently testable, and it does not pre-empt the
real fix. Not done in this document's commit only because the plan file is under concurrent
edit; it needs an owner's go-ahead to touch the decoder.

## 9. Changes from revision 6

| Revision 6 | Revision 7 |
|---|---|
| Transaction-only acceptance invariant | Adds exact D-parameter/`system_parameters_d` parity, including change boundaries and switching |
| Called the automated comparison the same as the manual persisted-field check | Records that it omits transaction `block_hash` and all bridge observations |
| Treated all dispatch-failed direct calls as archived rows | Separates valid pre-ledger dispatch rejection from deserialize/apply failures and requires row-versus-refusal parity |
| Required a reward-bearing oracle range | Targets an observed non-genesis event-bearing range; v1.0.0 rewards are disabled and CNight is the concrete runtime source |
| Listed nonexistent-path fallback as open | Records the existing fail-closed override behavior while retaining provenance and distribution blockers |
| Used unpinned validation commands and stale Graphify status | Pins OpenSpec/Graphify versions, records actual corpus results, and refreshes Graphify |
| Gave a verbatim stock-loader copy as a reproduction recipe | Records the deterministic snippet-directory rewrite and required `#self` Node import mapping; the clean recipe reproduces 5/5 |

## 10. Parallel track — upstream the ledger WASM export (not a goal of this plan)

**This section is a tracking log, not a Part A requirement.** Owner decision (2026-08-08): the
binding **will** be committed upstream, but only after this working version has proven itself —
so that when the upstream PR opens, we know with certainty the 16-line export is the only change
needed, and can say so with evidence. Recorded here so it is not forgotten, and so findings from
the parallel work accumulate in one place instead of in chat history.

Part A's merge does **not** wait on this section. Part A consumes the verified 8.1.0 build via
`MIDNIGHT_LEDGER_WASM` (§5.4 governs what *is* release-blocking about that). Conversely, this
section does not wait on Part A's merge — it can proceed any time.

### 10.1 State

| | |
|---|---|
| The change | `SystemTransaction::transactionHash` on the WASM binding + the template `.d.ts` declaration. 25 lines total, no behaviour change to anything existing |
| Verified branch | `feat/expose-system-transaction-hash` @ `1a561ac` (base 8.1.0) on `git@github.com:acedward/midnight-ledger.git` — 5/5 ground-truth hash match, proof committed in `ledger-wasm/verification/` |
| Merge candidate | `feat/expose-system-transaction-hash-ledger8` @ `97a6c9dd` (base `ledger-8` = 8.2.0-rc.1) on the same fork — compile-checked only |
| Upstream target | `midnightntwrk/midnight-ledger`, branch `ledger-8`. Gap confirmed still open there at `272c25fc` |

### 10.2 Remaining steps, in order

1. **Let Part A exercise the 8.1.0 build in anger** — parity gate, node-only gate, and (when
   captured) the event-bearing fixtures. Every archive row keyed by the export is further evidence
   the export is complete and sufficient. Record anything that forces a second ledger change here;
   the goal of this soak is precisely to discover whether the export is the *only* change.
2. **Recompute the five ground-truth hashes from an 8.2.0-rc.1 build** of the merge-candidate
   branch (`wasm-pack build --target bundler` + the §8 loader adaptation). This is the missing
   verification on the candidate; until it passes, only the 8.1.0 branch is evidence-backed.
3. **Open the upstream PR** from the merge-candidate branch against `midnightntwrk/midnight-ledger`
   `ledger-8` — an owner action. The PR body should carry: the indexer-parity motivation (JS can
   read a system transaction's bytes but not its identity, while the indexer keys on exactly this
   hash), the 5/5 verification result and how to rerun it, and the note that the binding mirrors
   the sibling `Transaction::transactionHash` convention.
4. **When upstream publishes**, repoint UmbraDB's `package.json` at the published version, delete
   the `MIDNIGHT_LEDGER_WASM` interim (or demote it to a test-only escape hatch), and close §5.4.

### 10.3 Findings log

- 2026-08-08 — Gap confirmed open at `ledger-8` `272c25fc`: `impl SystemTransaction` still exposes
  only `new`/`serialize`/`deserialize`/`toString`.
- 2026-08-08 — Building `ledger-8` requires **rustc ≥ 1.95** (`sysinfo@0.39.1`); no toolchain file
  is pinned in the repo, so a 1.93 default fails during dependency resolution.
- 2026-08-08 — Upstream's template typings now use `TransactionHash` (a `string` alias) rather than
  bare `string`; the merge candidate follows that convention.
- 2026-08-08 — 8.0.3 → 8.1.0 does not affect transaction hashing (proven by the 5/5 match against
  indexer 4.3.2's recorded hashes). No equivalent statement exists yet for 8.2.0-rc.1 (step 2).
- 2026-08-08 — **The ledger WASM build is NOT bit-reproducible.** Rebuilding commit `1a561ac` with
  the same `wasm-pack 0.15.0` and `rustc 1.93.0` on the same machine produced a different `.wasm`
  (`46b80140…` then `9c7fc5f0…`); both pass the 5/5 known vectors. The snippet directory name
  *is* stable. Three consequences, all acted on in Stage 0:
  (a) §0's "CI rebuild-and-compare" gate is **impossible as specified** — a byte comparison against
  a rebuild would fail every run while saying nothing about correctness. It is replaced by
  checksum-pinning the committed bytes plus the known-vector behavioural check, which is the
  stronger gate anyway since it compares against an independent implementation.
  (b) It *strengthens* the vendoring decision rather than weakening it: the exact verified bytes
  cannot be regenerated, so committing them is the only way to preserve what was actually verified.
  (c) The §8 recipe reproduces **behaviour, not bytes** — worth stating wherever it is cited as a
  reproduction, and now stated in `vendor/ledger-v8-syshash/PROVENANCE.md`.
- 2026-08-08 — Vendoring silently removed coverage of the refusal path, because it was reached by
  the capability being *absent* (`it.skipIf(haveSystemHash)`) and the vendored build makes it
  always present. No test turned red. Fixed by constructing the condition instead of waiting for
  it: `ledger-v8-stock` (published 8.0.3, pinned exactly) plus `MIDNIGHT_LEDGER_WASM`, in
  `test/integration/chain-archive-ledger-refusal.integration.test.ts`. A general lesson for the
  remaining stages: **a capability gate that becomes permanently true is a silent coverage loss.**
- 2026-08-11 — **Second missing WASM export found: `LedgerParameters` exposes no block limits.**
  The reference normalizes accumulated block fullness against `parameters.limits.block_limits`;
  the WASM has no accessor, so replay's `postBlockUpdate` receives zero fullness. Nil difference on
  near-empty blocks; divergent fee-market parameter updates on blocks approaching capacity. A
  candidate second upstream export, same shape as the `transactionHash` gap.
- *(append future findings here, dated)*

## 11. Staged execution plan (owner, 2026-08-08)

**Final goal, restated by the owner:** umbra can use the node, **optionally**, instead of the
indexer — and is **transparent in its results** about what each mode covers. Not a forced cutover;
both sources remain first-class while the indexer exists. This supersedes any reading of §6/§7 as
a single monolithic gate and resolves §8a.4 (merge/cutover tiering): each stage below has its own
done-condition, and earlier stages are mergeable without later ones.

> **TARGETED RE-AUDIT (2026-08-13): BLOCK×3 at head `5b6a0b6`** — the round-3 fixes themselves
> failed re-audit; §16 is the current register. The banner below is the round-3 verdict it
> attempted to remediate.
>
> **AUDIT ROUND 3 (2026-08-13): three personas, three BLOCKs — PR #1 must not merge.** Findings:
> <https://github.com/acedward/UmbraDB/pull/1#issuecomment-5273905932>. Current brief:
> `audit-round-3-remediation-brief.md`. **A1 from round 2 held under all three reviews; A2, A3 and
> A5 did not.** Eight findings fixed in `1d4bb36`; five open (§15).
>
> **The PR is mechanically MERGEABLE** — every required check is green, nothing enforces this
> verdict. "Blocked" here is process discipline, not a lock. That distinction matters because every
> round-3 finding was invisible to the green suite: replay defaulted off so CI never ran it, the
> timestamp bug hid behind genesis being genuinely time 0, and a swallowed error had no test at all.
>
> **Round 2's register (§14) is history**, not current state.

> **AUDIT ROUND 2 (2026-08-11): three personas, three BLOCKs.** Findings and evidence:
> <https://github.com/acedward/UmbraDB/pull/1#issuecomment-5269573241>. §14 is that round's
> remediation register. Superseded by round 3 above.

**Execution status (2026-08-11): Stages 0–4 are ALL COMPLETE** — each closed out in `tasks.md` §8
with its evidence and commits. PR #1 is open with `parity` and `integrity` green and **required on
`main`**. Only Stage 5 remains, waiting on its one owner decision. Stage 2b (§13) was inserted
after this table was written and sits between 2 and 3. Stage 4's ingest wiring (replay during live
sync) is a named follow-up, not part of the stage's done-condition: it needs a checkpoint/restart
design, which is a schema decision.

| Stage | Contents | Done when | Decisions needed |
|---|---|---|---|
| **0 — Reproducible foundation** | Vendor the verified 8.1.0 ledger build with provenance (commit `1a561ac`, §8 recipe, SHA-256 sums, CI rebuild-and-compare); demote `MIDNIGHT_LEDGER_WASM` to test-only; pin toolchains; compose stack is the canonical environment | A fresh clone runs every current suite with no manual build steps and no env vars | None — decided in §0 |
| **1 — Fail-closed on the current slice** | The one-line signed-system-tag fix (§8a.5); harden the §5.1 event guard's stated scope; refuse dual-source-collision blocks (§3(c)); label node-only experimental in docs and CLI (§6.1) | No known input reaches silent omission; every gap refuses loudly; **mergeable** as strictly-better | None |
| **2 — Block-scoped metadata decoding** | §6.2 in full: every extrinsic framing and `SystemTransactionApplied` decode via the runtime schema for the exact block, per-node-version capture like the reference | The §5.1/§5.2 refusals convert to support; pinned `CALL_INDICES_BY_PROTOCOL` retired to a cross-check | None — §0 settles the capture approach |
| **3 — Parity gates required** | Synthesize devnet fixtures where producible (signed call, direct system call via root, mixed block); mechanism-equivalence unit fixtures where not (§0 fallback rule); ordered-comparison gates including `block_hash` and D-parameter observations; CI jobs that fail rather than skip | The §7 matrix rows are green, red-with-fallback-evidence, or refused-matching-the-indexer — none silently skipped | None |
| **4 — Apply-rule parity (replay)** | Ledger state advanced from genesis via WASM `LedgerState.apply`; row-versus-refusal parity for deserialize- and apply-failures | The last two §7 refusal-parity rows close | None — decided in §0 (parity ⇒ replay ⇒ genesis-start) |
| **5 — Optional-source GA** | Node mode leaves experimental; mode + coverage visibly reported in results; the source/version transparency record (may use §1's reserved safety-migration slot, alongside the §3(c) PK widening) | An operator can choose either source and see exactly what their archive covers | One: the shape of the transparency record, when reached |

**The PK-widening migration** (§3(c)) is the single currently-known schema change, and is now
**approved by the owner** (§0) as §1's reserved safety migration. It belongs to whichever stage
first needs to *archive* (not merely refuse) a dual-source block — Stage 2 at the earliest.

### 11.1 Execution prerequisites (what an agent needs; nothing else)

- **Services:** `test/compose/docker-compose.yml` (node 1.0.0, indexer-standalone 4.3.2, proof
  server, postgres); Docker + testcontainers for the integration suites.
- **Ledger build (until Stage 0 lands):** the §8 recipe verbatim — ledger `1a561ac`,
  `wasm-pack 0.15.0`, **rustc 1.93.0 exactly**, then the loader/`#self` adaptation. After Stage 0:
  nothing.
- **Toolchains:** rustc 1.93.0; rustc ≥ 1.95 only for `ledger-8` work (§10); Node 20+, `tsx`, `jq`.
- **`uv`/`uvx`**, for the pinned `graphify` and OpenSpec close-out commands in §8. Added
  2026-08-08 after Stage 0 hit its absence: this machine has no `uv`, `uvx`, `pipx` or `pip3`, and
  `python3 -m venv` fails without `ensurepip` (`apt install python3.12-venv`, needs sudo). The
  close-out graph refresh cannot run without one of these, and substituting an unpinned graphify
  would produce outputs inconsistent with the rest of the pipeline.
- **Access:** push to `acedward/UmbraDB` and `acedward/midnight-ledger`; pull for midnight images.
- **Open decisions: none for Stages 0–4.** Stage 5: one, deferrable until reached.

### 11.2 The owner's complete action list

Everything the owner personally must do, in one place. **Right now: nothing.** Every decision is
made; Stages 0–4 run without owner input. The three future actions, each with its trigger:

| When | Action | Effort |
|---|---|---|
| ~~Stage 3 lands~~ | ~~Flip `parity` and `integrity` to required~~ **DONE (owner, 2026-08-11):** PR #1 opened, both jobs ran green on it (`parity` 2m36s on a fresh runner, `integrity` 21s), and the `main` ruleset now targets the default branch requiring both. `main` cannot advance without the parity gates | — |
| §10 step 2 passes (hashes recomputed on an 8.2.0-rc.1 build) | Open — or say the word and the PR text is drafted from §10.2.3 — the upstream PR from `acedward/midnight-ledger` `feat/expose-system-transaction-hash-ledger8` against `midnightntwrk/midnight-ledger` `ledger-8`. Kept as an owner action because it is outward-facing on the upstream org | ~10 minutes with the drafted text |
| Stage 5 is reached | Approve the proposed shape of the source/coverage transparency record (a concrete proposal will be presented then; no thinking required before that) | One yes/no |

Nothing else. Reviews of stage deliverables are welcome but are not gates the plan waits on —
each stage's done-condition is checked by its own required tests.

## 12. Blockers and unknowns

Live register. **Blockers** stop specific work; **unknowns** are unverified assumptions that could
invalidate work already done. Both are updated as stages proceed.

### 12.1 Blockers

| # | Blocker | Blocks | Status |
|---|---|---|---|
| **B1** | **No reachable chain emits runtime-generated system transactions.** The reviewed v1.0.0 runtime's block reward is zero and its reward pallet is disabled. | Live validation of the event guard; the §7 rows for event-borne systems, mixed blocks, and dual-source transactions | Open. §0's mechanism-equivalence fallback applies: implement the reference mechanism, prove with synthesized fixtures. CNight observation is the one identified real source |
| **B2** | ~~Block-scoped metadata decoding.~~ **Closed** (commit `2b2443e`): node-only ingest classifies via the block's own metadata, archives every framing, recovers event-borne system transactions event-first, and follows renumbered runtimes. The pinned table is a cross-check only. 71 tests green. | — | **Successor blocker: B7** — the metadata itself must be obtainable for pruned ranges (§13) |
| **B7** | ~~Historical metadata depends on an un-pruned node.~~ **Narrowed, not closed** (commit `7f4d2a3`, §13.5). Metadata availability is solved: the archive keeps its own captures, a runtime is fetched once per net ever, and re-decode/replay need no node. **Ingesting pruned history remains impossible** — `System::Events` and the D-parameter are per-block state that no per-runtime capture can substitute for. | Stage 4 replay: **unblocked**. Fresh ingest of pruned ranges: still requires an archive node, which is a property of the chain rather than of this archive | Residual is inherent, not a defect. Archive-node requirement applies to *first* ingest of a range |
| **B3** | ~~The `transactions` primary key cannot hold two rows sharing a hash.~~ **Resolved:** migration `002_transaction_position_key` re-keys on `position` (already unique per block, so the rule was merely re-labelled). Verified fresh **and** incremental onto an existing 000/001 archive. | — | **Landed.** Follow-through pending: `assertNoDuplicateTransactionKeys` still refuses the now-legal dual-source rows and must be re-scoped to position-uniqueness when the wiring lands (§12.4) |
| **B4** | **The ledger export is neither upstreamed nor published.** | Closing §5.4's release-artifact objection | Vendored interim in place (`vendor/ledger-v8-syshash`) and no longer blocking day-to-day work. §10 tracks it |
| **B5** | ~~Node 0.22.x has no verified call indices.~~ **Settled** by resolving the reference's own captured 0.22.0 metadata (`midnight-indexer/.node/0.22.0/metadata.scale`) with the new resolver: **identical to 1.0.x** — Midnight=5, MidnightSystem=6, both calls 0, `SystemTransactionApplied` at (6,0). Notable: that metadata is **V16** (1.0.0's is V14) and `@polkadot/types` handles both, so metadata-version drift across node versions is covered. | — | Evidence is derived-from-captured-metadata, not live-chain observation; sufficient to add the 0.22 entry fail-open, and moot once metadata decoding replaces the pinned table entirely |
| **B6** | ~~No decision on how to decode SCALE metadata.~~ **Decided (owner, 2026-08-10): `@polkadot/types`**, at its measured cost (19 scoped packages / 46 MB). In `package.json` + lockfile. Local caveat: the main repo's root-owned `node_modules` cannot be relinked without sudo, so local runs use a dev clone; fresh clones and CI are unaffected | — | **Closed** |

### 12.2 Unknowns

| # | Unknown | Why it matters | How it gets settled |
|---|---|---|---|
| **U1** | ~~Are the event's bytes identical to the extrinsic's?~~ **Downgraded to non-blocking** (Stage 2 wiring): each dual-source copy is archived under its OWN bytes — event payload for the event-borne row, extrinsic payload for the extrinsic row — exactly as the indexer stores them. If the two streams ever differ, we mirror the reference either way. The byte-match guard this governed was replaced by real event decoding | Curiosity, not risk. Settles itself the first time B1's population is observed live |
| **U2** | **The ledger WASM build is not bit-reproducible.** Same commit, `wasm-pack` and `rustc` produce different `.wasm` bytes | The vendored artifact can never be re-attested by rebuilding it; provenance rests entirely on behavioural vectors | Settled as far as it can be: accepted, with the known-vector gate as the substitute attestation. Do not add a byte-comparison CI gate — it cannot pass |
| **U3** | **Does an 8.2.0-rc.1 build reproduce the five genesis hashes?** | The upstream merge candidate is compile-checked only; it is *unverified against ground truth* while the 8.1.0 tree is what Part A consumes | Build the candidate and run the vectors (§10.2 step 2) |
| **U4** | **Can a signed Midnight call be produced at all?** `send_mn_transaction` ignores its origin, so one is valid — but nobody may ever have submitted one | §7 requires the row. If unproducible, that gate can only ever stay red | Attempt submission on the devnet; failing that, mechanism-equivalence per §0 |
| **U5** | **Does the indexer archive a valid call rejected *before* ledger execution (`BadOrigin`)?** | Decides row-versus-refusal parity for the whole §7 failure family, and therefore how much of Stage 4 is real | Observation on an oracle range. Not derivable from the adapter source, which stops before dispatch outcome |
| **U6** | **Is the reference's event-first ordering stable across runtimes?** Read from `runtimes/v1_0_0.rs:160-163`, which is version-specific by construction | Position is part of the archive's contract; a different order in another runtime silently breaks parity | Re-read the adapter for each supported runtime as B2 lands |

**Settled by code reading, previously listed as needing observation:** whether the indexer
deduplicates a system transaction present in both sources. It does not — no hash comparison on the
path, and no unique constraint on `hash` in its schema, so it stores two rows (§3(c)). This is what
produced B3.

### 12.3 Stage 2 reconnaissance — measured, not yet implemented

Findings from probing the live devnet node and the reference's captured metadata. They narrow
Stage 2 considerably and are recorded because several *retire* risks the plan currently carries.

| Finding | Consequence |
|---|---|
| **`state_getMetadata` accepts a historical block hash** and returns metadata **V14**, 102,234 bytes (devnet `undeployed1`). | §5.3's "must prove the metadata belongs to the block being decoded" is mechanically satisfiable **without** a build-time capture step. Fetch-at-ingest, cached by runtime identity, is viable |
| **Metadata is byte-identical at genesis and at the finalized tip** on this devnet. | No runtime upgrade to exercise. **U6 and the §7 runtime-boundary row cannot be tested here** — this chain cannot produce the case, same shape of problem as B1 |
| **Metadata-derived indices exactly match the pinned constants**: `System=0`, `Timestamp=1`/`set=0`, `Midnight=5`/`send_mn_transaction=0`, `MidnightSystem=6`/`send_mn_system_transaction=0`. | Independent confirmation that `CALL_INDICES_BY_PROTOCOL` is correct for 1.0.x, and that metadata can replace it rather than merely cross-check it |
| **`SystemTransactionApplied(hash_: [u8;32], serializedSystemTransaction: Bytes)`** — the event carries the authoritative hash **and** the payload. | Event-borne system transactions need **no ledger hashing at all**: the hash is in the event. This shrinks the §5.1 fix and makes it independent of the vendored ledger export |
| **The chain advertises extrinsic version `4` only** (`versions: 0x04`). | The decoder currently accepts format versions 4 and 5; 5 is unreachable on this runtime |
| **Midnight defines three custom transaction extensions** — `AuthorizeCall`, `CheckCallFilter`, `CheckThrottle` — which `@polkadot/types` does not recognise and warns it is "treating as no-effect". | Sounds alarming, and is **benign for decoding**: all three have `payload=Null`, so they contribute zero bytes to the extrinsic body. Only `CheckMortality` (`Era`) and `CheckNonce` (`Compact<u32>`) carry payload bytes. The unknown-extension warning must **not** be taken as a reason to distrust signed-framing decode — but it must be re-checked per runtime, since a future version could give them a payload |

**Recommendation for B6:** adopt `@polkadot/types`. It decodes this exact metadata correctly today
(all of the above was produced with it), the custom-extension warning is benign per the row above,
and the alternative is hand-writing a V14 type registry in the single most decode-critical path in
the system — where a subtle bug produces a wrong archive rather than a crash. The cost is real and
should be taken with open eyes: 19 scoped packages and 46 MB against a 17-dependency repo.
*(Adopted by the owner 2026-08-10 — see B6.)*

### 12.5 Status snapshot after Stage 3 (2026-08-11) — answered, and still open

**Answered since the register was created** (each recorded in place; collected here so the current
state is readable in one pass):

| Question | Answer |
|---|---|
| How to decode SCALE metadata in TS? (B6) | `@polkadot/types`, owner-approved, in `package.json` |
| Can the PK hold dual-source rows? (B3) | Yes — re-keyed on `position` (migration 002), both copies stored |
| 0.22.x call indices? (B5) | Identical to 1.0.x, derived from the reference's own captured metadata (V16) |
| Can ingest read signed framings / events / renumbered runtimes? (B2) | Yes — wired, three refusals became archiving |
| Does parity survive all of Stage 2's changes? | **Yes — live-verified**: 60 blocks, 38 tx (5 system), 1 D-param observation, identical incl. `block_hash` |
| Do event bytes equal extrinsic bytes? (U1) | Moot for parity — each copy archived under its own bytes, as the reference does |
| Can pruned nodes ingest history? (B7/§13) | **No, inherently** — per-block state (`System::Events`, D-param) has no capture substitute. The archive is self-describing for re-decode/replay instead |
| Metadata across node versions? | V14 (1.0.0) and V16 (0.22.0) both decode; version drift is handled |

**Open, with owners:**

| Item | Waiting on |
|---|---|
| B1 — no reachable chain emits runtime-generated system transactions | The root blocker for every "live" upgrade of a mechanism-equivalence row. CNight observation is the identified real source |
| U5 — does the indexer archive a `BadOrigin`-rejected call? | Live observation on an oracle range; sizes Stage 4's row-vs-refusal work |
| U6 / runtime-upgrade boundary | **Impossible on reachable chains** (no upgrade ever happened); needs a second runtime from any source |
| ~~§7: ledger-replay refusal parity~~ | **Done (Stage 4)** — mechanism-equivalence; apply-`Failure` confirmed to be a ROW, not a refusal |
| Replay wired into live ingest | A checkpoint/restart design (schema decision — `LedgerState.serialize()` exists for it) |
| Second upstream WASM export: block limits on `LedgerParameters` | §10 track, alongside the `transactionHash` export |
| ~~Branch protection~~ | **Done 2026-08-11** — PR #1 open, both gates green on it, ruleset active on `main` |
| B4 / §10 — ledger export upstream PR | §10.2 step 2 (recompute hashes on 8.2.0-rc.1), then owner opens the PR |
| Stage 5's transparency-record shape | Deferred until Stage 5 |

Local-only, not plan-level: the main repo's `node_modules` has 3,135 root-owned entries, so local
installs silently no-op; development runs in a scratch clone. Fresh clones and CI are unaffected.

### 12.4 Stage 2 mid-stage review (2026-08-10) — built, missing, and two library hazards

**Built and verified** (commits `3147cde`, `814a326`, `6133a5f`, `f05d0a4`): metadata resolution
at the block's hash cached by `(specName, specVersion)`; event-borne system-transaction decode
recovering the runtime's own hash and bare payload; call decode for every framing including
signed (verified against the same real genesis bytes as the hand-rolled decoder, plus a signed
extrinsic built from the layout metadata itself describes); and the `position` re-key migration,
fresh and incremental. 14 metadata tests + 6 migration tests green; fixtures are committed
real-node captures, so none of it needs a running chain.

**Two `@polkadot/types` hazards, recorded because both produce a wrong archive rather than a
crash, and both were caught only by known-answer tests:**

1. `event.index` is a codec, not an array — positional indexing yields `undefined`, so a naive
   pallet/variant match silently matches *nothing* and every event-borne system transaction reads
   as absent. Read via `toU8a()`.
2. **`codec.hash` is a built-in on every codec** (blake2 of the encoded value). Reading the
   event's `hash_` field as `.hash` returns a plausible 32-byte hex that is *not* the field —
   every event-borne system transaction would have been archived under a fabricated key,
   permanently, under `ON CONFLICT DO NOTHING`. Named fields are read only through the Struct
   accessor, and the test compares against a known hash because nothing else catches this class.

**Missing — what closes Stage 2 (all in `sync-service.ts` unless noted):**

1. **Wire the decoders into node-only ingest.** Metadata-derived indices classify (pinned table
   demoted to a cross-check that logs/aborts on disagreement); event-borne system transactions
   become archived rows rather than a refusal.
2. **Event-first ordering.** The reference prepends event-borne transactions, so every position in
   a block that carries one shifts by the prepended count. This is the behaviour-changing step:
   archives of such blocks differ from what the pre-wiring code would have written (it refused
   them, so no existing archive changes retroactively — but the ordering rule must match
   `v1_0_0.rs:160-163` exactly).
3. **Store each copy's own bytes** for a dual-source transaction — event payload for the
   event-borne row, extrinsic payload for the extrinsic row, exactly as the indexer does. Note
   this makes **U1 non-blocking for parity**: if the two byte-streams ever differ we mirror the
   reference either way; U1 only governs the Stage-1 byte-match guard, which the wiring replaces.
4. **Re-scope the Stage-1 interim guards.** `assertNoDuplicateTransactionKeys` currently refuses
   the dual-source rows that are now legal — it must check position-uniqueness instead. The
   byte-match event guard is superseded by actual decode and becomes a cross-check or is removed.
5. **Operational consequence to document:** node-only ingest now calls `state_getMetadata` at
   historical hashes, so pruned nodes fail for old ranges — an archive-node requirement, already
   thrown as a clear error by `BlockScopedMetadata.forBlock`.
6. **End-to-end tests:** fake-node ingest of a block whose events carry a system transaction
   (archived, event-first positions); dual-source block stores two rows; indexer-mode unchanged.
7. Stage close-out: `tasks.md` 8.2, graphify, §10.3 findings.

**Known-open items that Stage 2 does NOT close** (Stage 3, restated so the close-out cannot absorb
them): the parity gate still omits `block_hash` and all D-parameter observations from its
comparison (revision 7's §5.6 finding — confirmed still true today), required-not-skipping CI, and
every §7 population that needs fixtures.

## 13. Stage 2b — metadata availability (owner-approved, 2026-08-10)

**The problem (B7).** Stage 2 made ingest depend on the block's runtime metadata, fetched from the
node at the block's hash. That is correct and fine-grained, but historical metadata is derived from
historical *state*: a pruned node cannot serve it, so node-only ingest of old ranges refuses. The
refusal is clear and safe — and still a refusal. Stage 4 replay makes this worse: it will re-read
metadata for every historical runtime long after any capture window has closed.

**The owner's direction: follow the indexer, and add the table.** The indexer never has this
problem because it never fetches at ingest — it captures `metadata.scale` per node version offline
(`get_node_metadata.sh`, `NODE_VERSIONS`, `.node/<version>/`) and compiles decoders from the
captured artifacts. For a chain whose history is pruned everywhere, a prior capture **is the only
possible source** — the bytes no longer exist anywhere else — so this is not one option among
several; it is the fallback every path bottoms out in.

Umbra's equivalent has two halves, because umbra is a library archiving arbitrary nets rather than
a binary shipped per chain:

### 13.1 The `runtime_metadata` table — each archive carries its own captures

New migration `003_runtime_metadata` (the second approved schema change, using §1's reserved
scope-decision mechanism as the owner has now exercised it):

```
runtime_metadata (
  net                text   NOT NULL,
  spec_name          text   NOT NULL,
  spec_version       bigint NOT NULL,
  first_seen_height  bigint NOT NULL,
  metadata_blob_hash bytea  NOT NULL REFERENCES chain_blobs (hash),
  PRIMARY KEY (net, spec_name, spec_version)
)
```

The bytes go through the existing content-addressed `chain_blobs` under a new
`runtime_metadata` role (the role CHECK and blob-role triggers extend accordingly). Ingest
persists metadata **the first time each runtime identity is seen** — one ~100 KB row per runtime
version per net, ever. From then on the archive is *self-describing*: re-syncs, re-decodes, and
Stage 4 replay read metadata from the archive itself and never depend on the node's state
retention again. First contact with a runtime still needs a serving node — that is unavoidable —
but it needs it exactly once per runtime version rather than forever.

### 13.2 The committed capture registry — the indexer's `.node/` directory, ported

`chain-archive-sync/metadata/` gains the known captures as committed artifacts with a manifest —
exactly the shape of the indexer's `NODE_VERSIONS` + `.node/<version>/metadata.scale`:

| Capture | Source | Status |
|---|---|---|
| `midnight-node-1.0.0` (V14, 102,234 bytes) | our own live capture, already committed as a test fixture | promote to the registry |
| `midnight-node-0.22.0` (V16) | the reference's `.node/0.22.0/metadata.scale`, already proven to resolve with our resolver (B5) | copy in, with provenance |

The manifest maps an **MNSV protocol-version range** to a capture — the same coarse key the
indexer dispatches on. Coarseness is deliberate here and only here: this registry is the
bootstrap for blocks where even `state_getRuntimeVersion` is unanswerable (pruned state), and the
MNSV digest lives in the block *header*, which is always available. Where the fine-grained path
works, it wins (below); where it cannot, matching the reference's own granularity **is** parity.

### 13.3 Resolution order in `BlockScopedMetadata`

1. **The archive's own `runtime_metadata` table** — self-contained, exact.
2. **The node**, at the block's hash, keyed by `(specName, specVersion)` — and persist the result
   into the table, so this path retires itself per runtime.
3. **The committed registry**, keyed by the header's MNSV version — the pruned-node bootstrap,
   with the provenance of the capture recorded in what it decodes.
4. **Refuse**, naming which of the three sources were tried. Never guess a layout.

A cross-check mirrors the pinned-indices rule: when both a table/registry capture and a live node
answer exist, they must agree byte-for-byte or ingest refuses — two sources disagreeing about the
runtime's own description means one of them decodes the block wrongly.

### 13.5 Correction after implementing (2026-08-11): pruned-node INGEST is not solvable

This section, as written above, implied that captured metadata would let a pruned node ingest
history. **It does not, and cannot** — established by building it and running it, not by review.

Metadata is a *per-runtime* fact, so a capture substitutes for it perfectly. But node-only ingest
also reads two *per-block* facts that are equally historical state:

- **`System::Events`** (`state_getStorageAt`) — where runtime-generated system transactions live;
- **the D-parameter** (`state_call`) — the bridge observations.

No per-runtime capture can stand in for per-block facts. A pruned node therefore still cannot
serve a complete archive of history it has pruned, from any source, and ingest correctly fails on
the state that is genuinely gone rather than on metadata.

**What Stage 2b actually buys, stated accurately:**

1. **The archive is self-describing.** Re-decoding bytes it already holds needs no node at all.
   This is the property **Stage 4 replay** depends on, since replay re-reads metadata for every
   historical runtime long after any capture window has closed. Pinned by the
   "decodes from the stored capture with the node's metadata gone" test.
2. **A runtime is fetched once per net, ever** — not once per re-sync.
3. **Metadata stops being the first thing that fails** on a degraded node, so failures name the
   state that is actually missing.

B7 is therefore **narrowed, not closed**: metadata availability is solved; ingesting pruned
history remains impossible and is a property of the chain, not of this archive. The archive-node
requirement stands for *first* ingest of a range — which is where it always belonged.

### 13.4 Sequencing and what it does NOT change

Stage 2b sits before Stage 3 (whose parity gates should exercise the table path), sized at one
migration + registry module + resolution-order change + tests. It does not alter what Stage 2
decodes or in what order — only where the metadata bytes come from. The §7 acceptance matrix is
untouched; the archive-node requirement recorded in §12.4 item 5 is superseded by this section
once landed (it then applies only to first contact with a runtime version).


## 14. Audit round 2 — remediation register (owner-reported, 2026-08-11)

Reviewed head `2cfef2a`. Each blocker gets a targeted re-audit after its fix; merge needs fresh
PASS/PASS/PASS on the final head rebased onto current `main` (`3c0c68b` at audit time).

| # | Blocker | First assessment (to verify, not trust) |
|---|---|---|
| **A1** | Transaction `kind` comes from the dispatched CALL and can disagree with the payload's own type; event-borne system-tx hashes are trusted from the event, never recomputed | Both halves look genuine. A `send_mn_transaction` carrying a system-tagged payload would archive as `regular`; the reference derives type from the payload it deserializes. And the `transactionHash` export exists precisely so the event's claimed hash can be **cross-checked** — trusting it was lazier than the tools we built. Fix: assert call-type ≡ payload-tag (refuse on disagreement), and recompute event hashes via the ledger, refusing on mismatch |
| **A2** | Live replay does not yet gate ingest — acceptance/refusal behaviour is engine-only | True and was a *named* follow-up, but the auditors are right that parity is not delivered until wired. Needs the checkpoint/restart design (schema decision) + wiring |
| **A3** | `runtime_metadata` persists outside the block's atomic refusal boundary; resolution has an unsafe fallback | Both real. `putRuntimeMetadata` commits before the block can still refuse (capture survives a refused block — defensible for a runtime-level fact, but must be argued or moved, not implicit). Worse: `forBlock` swallows **every** `runtimeVersionAt` error, so a transient network blip silently falls through to the coarse registry instead of failing the fetch path — that catch must distinguish "state discarded" from "request failed" |
| **A4** | Restart continuity / conflicting-retry handling can silently produce inconsistent archives | §5.5, which Stage 1's close-out explicitly declined to claim. Now due: detect a history written by an older implementation; make conflicting-bytes retries refuse rather than `DO NOTHING`-skip |
**Migration-number ownership (owner, 2026-08-11).** Part A now owns `002`–`004` in the
`chain_archive` lineage, which collides by number with Part B's parked `002_zswap_root` /
`003_contract_state`. Not resolved by renumbering: **Part B will be redesigned and reimplemented**,
so its current migrations are disposable and the collision has no cost to pay. Recorded so a later
reader does not mistake the overlap for an unnoticed conflict.

Also worth stating once, since the A/B boundary was originally "Part A stores no new data": that
test no longer holds — three migrations landed, each individually approved. What survives is the
narrower and still-true version: none of them stores new **business** data (no contract state, no
projections, no feeds). They store the archive's own machinery — its key shape, its decoder inputs,
its replay position. The upgrade risk that usually motivates a no-migrations rule is nil here (no
UmbraDB is deployed anywhere), and the runner is forward-only with no `down()`, which is why
`002`/`003` were proven against a populated database rather than empty tables (§9.3).

**The indexer's role, settled (owner, 2026-08-11).** For this PR the indexer stays **optional at
runtime and required for the parity gate**. UmbraDB itself depends on no oracle — node-only mode
constructs no `IndexerClient`, and the node-only suite wraps `globalThis.fetch` to assert *zero*
indexer-shaped requests, so the guarantee is enforced rather than asserted. The compose stack is
test infrastructure (`test/compose/`, shipped in nothing), and the indexer appears in it for one
reason: proving "produces the same archive as X" requires running X.

That gate therefore has a **shelf life**. When the indexer is decommissioned the parity comparison
becomes unrunnable, and this sprint's parity evidence becomes a dated snapshot rather than a
standing check. That is accepted: the indexer's code remains available, so the stack can be kept
running as long as it is useful and dropped later. What replaces it is already being built — ledger
replay (§Stage 4) validates against the *ledger's own rules* rather than another implementation's
output, which is the only class of correctness check that survives the oracle's removal. The
mechanism-equivalence fixtures and the captured ground truth serve the same purpose: converting a
decaying external oracle into permanent internal evidence.

**A5's scanning half is declined**, with the reason recorded rather than left as an unticked box.
The pins are in and CI enforces them, which is the part that protects the parity gate's integrity —
a mutable tag means the comparison target can change with no commit. Scanning would report CVEs in
upstream Midnight *release images* this repo neither builds nor patches; the finding would be
actionable only by whoever bumps a pin, and a non-blocking job nobody owns is noise that trains
people to ignore the workflow. (A first attempt at this shipped a step named "scan the pinned
images" that actually ran `scan-type: config` against the compose *file* — it would have gone green
while never looking at an image, which is precisely the kind of check this audit round exists to
eliminate. Removed rather than left misleading.)

| **A5** | Release items: authoritative-doc reconciliation; immutable image pins (compose uses mutable tags) + scanning; an incremental migration test against a **populated** database (ours ran on empty tables); regenerate graphify | All mechanical and legitimate. The populated-migration gap is the sharpest: 002's PK swap was never proven against rows that exist |

**Remediation order:** A1 and A3's fallback fix first (small, semantic, test-backed); A5's
populated-migration test next (cheap, de-risks the schema changes); A4; then A2, which is the
largest and depends on the checkpoint schema decision. A5's doc/pin/graphify items ride the final
close-out. Each fix cites its finding; no finding closes without a test that fails on the old
behaviour.


## 15. Audit round 3 — register (2026-08-13)

Reviewed head `c7493c9`. Full detail in `audit-round-3-remediation-brief.md`; this is the register
the plan carries.

**Why round 2's remediation failed**, since it shapes what to distrust: every round-2 blocker was
closed with a test verified to fail when the fix was reverted. That proves a test is *connected* to
a change, not that the change is right or complete. Replay's timestamp field was declared, read and
never assigned — invisible because genesis genuinely is time 0 and genesis was the only block
tested. A3's fix corrected one `.catch(() => undefined)` and left its twin twelve lines away —
invisible because the test exercised only the first site. **A test whose fixture cannot express the
failure proves nothing about it.**

### Fixed in `1d4bb36`

| # | Finding |
|---|---|
| R1 | Replay ran every block at timestamp 0 (field declared, read, never assigned) — now decoded from `Timestamp::set` |
| R2 | Ledger state initialised with the archive's `net` label instead of the ledger's network id — now required config, validated in service and CLI |
| R3 | Replay not failure-atomic — a refusing block left earlier transactions applied, and retries re-folded them |
| R4 | Cost/fees not computed as the reference does |
| R5 | `metadataAt` still swallowed transport failures — the twin of the catch round 2 fixed |
| R6 | Sparse-checkpoint restart unusable above interval 1 — replay now catches up over archived blocks |
| R7 | Migrations 003/004 invisible to 001's blob-role deletion guard |
| R8 | Replay unreachable from the CLI, so the deployable path was never replay-gated |

### Open

| # | Finding |
|---|---|
| O1 | D-parameter continuity breaks across restarts |
| O2 | Historical conflict detection incomplete and racy — no locking, so two ingesters racing one height both pass |
| O3 | No state-root checks in replay |
| O4 | Image-pin CI check bypassable (matches quoted `image:` lines only) |
| O5 | Status docs, dependency inventory and Graphify stale |

**Exit:** targeted re-audit of R1–R8 (requested now), then O1–O5, then fresh PASS/PASS/PASS on the
final head. Merge is gated by that verdict alone — not by any mechanism.


## 16. Targeted re-audit of the round-3 fixes — register (2026-08-13)

Audited head `5b6a0b6` (implementation `1d4bb36`). Verdict BLOCK×3. The five declared-open items
(§15 O1–O5) were correctly excluded and remain open. Verified findings, each checked against the
code before being recorded:

| # | Severity | Finding |
|---|---|---|
| T1 | HIGH | **The genesis timestamp exemption is wrong for the target node.** 1.0 always adds `Timestamp::set` to genesis; the committed devnet genesis decodes to `1754395200000` ms, not 0. Also: checkpoints store no parent timestamp, so the first resumed block gets `lastBlockTime=0`; and catch-up substitutes 0 for missing non-genesis timestamps — the exact "guessing zero" the R1 fix claimed to refuse |
| T2 | HIGH | **Resume never compares the checkpoint's embedded network with `ledgerNetworkId`** — pre-fix wrong-network/zero-time checkpoints carry the same `ledger_version` marker and are accepted |
| T3 | HIGH | **Replay atomic within the engine, not across the ingest block**: replay advances before bundle/checkpoint/watermark persistence, so a one-shot durable-write failure leaves replay ahead and the CLI then refuses that height forever. Reproduced by the auditor with an injected first-write failure |
| T4 | HIGH | **Zero fullness was avoidable all along**: `LedgerParameters.normalizeFullness(fullness)` exists in the vendored build (`midnight_ledger_wasm.d.ts:435`). My recorded claim that normalization was impossible (§10.3 finding, module doc) is **wrong** — verified 2026-08-13. `cost()`/`fees()` returns are discarded; a ten-cost probe produced overall fullness 0.10272 and a *different serialized state* than zero-fullness |
| T5 | HIGH | **Checkpoint selection ignores fork ancestry** — filters `(net, height)` only, though 004 permits fork-distinct checkpoints; an orphan checkpoint can be combined with canonical successors. Partial catch-up failures also poison the in-memory retry state |
| T6 | HIGH | **R8 is absent from the release artifact**: `package.json` advertises `archive:sync` but `npm pack` ships only `dist` + docs — no CLI, and `tsx`/ledger are devDependencies. Checkpoint interval `0`/`NaN` silently disables checkpointing |
| T7 | MED | **R5 untested and partly fail-open**: the transport test faults `runtimeVersionAt` only (restoring the missed catch still passes), and `/unknown block/i` classifies an unknown hash as pruning — silently selecting the committed capture |
| T8 | MED | **R7 lacks regressions** (removing both new guard branches stays green — deletion coverage only exercises `tx_raw`) and databases that recorded the old 003/004 names skip the edited bodies — a forward migration is needed if those draft schemas are supported |

**Corrections to this plan's own record, forced by T1 and T4:** the §10.3 claim that block-limits
normalization is unavailable in the WASM is withdrawn; and every statement that "genesis has no
timestamp" is wrong for the target node — the *synthetic test fixtures* omit `Timestamp::set`,
which is precisely why the suite could not see T1.

**Exit unchanged:** fix T1–T8, then O1–O5, then fresh PASS×3. Acceptance per finding now requires
the §10 strengthened rule AND exercising the actual production path (packed artifact, real fork,
injected write failure), since T3/T6 were found exactly there.
