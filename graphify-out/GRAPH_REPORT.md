# Graph Report - 00016-dust-wallet-sync  (2026-09-15)

## Corpus Check
- 562 files · ~994,883 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 5739 nodes · 10611 edges · 413 communities (272 shown, 141 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 116 edges (avg confidence: 0.72)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `464fd391`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ADDED Requirements
- StorageError
- published-ledger-v8-8.1.0.d.ts
- ADDED Requirements
- scoped-review-manifest
- Storage Algebra Lean Formalization — Approved Design and Status
- devDependencies
- postgres.js driver choice
- openspec-explore/SKILL.md
- Tier 1 / Tier 2 Postgres schema split
- include
- kv_current/kv_history temporal-table design
- Throw-typed-error idiom unification across modules
- Transaction/Lease layer interface (STALE, superseded)
- Fixed-size chunk splitting requirement
- Testcontainers vs pg-mem test-infrastructure decision
- TypeDoc documentation tooling decision
- Transactions commit or roll back atomically
- midnight-pg-store new package
- Abstract-Model-First Scope Decision
- Requirements
- Nested withTransaction unsupported (disclosed limitation)
- Refuted Research Claims (GIN quote, Git grace period, correlated subquery)
- diagnostics_channel/tracingChannel Instrumentation Design
- Hand-rolled migration runner decision (no ORM)
- OpenSpec Store
- Postgres errors surface as StorageError hierarchy requirement
- Storage Algebra Lean M2 Retention Sprint
- Law T1: gapless monotonic versions requirement
- Keep-Knowledge-Graph-Current Policy
- Law T3: temporal-projection equivalence (getAt)
- Law T4: dual addressing agreement
- Law T5: history intervals never overlap
- TemporalKV Algebra
- listKeys streaming/order requirement
- Global Constraints
- Migrations idempotent and ordered requirement
- Schema isolation default requirement
- Lease timeout distinct for acquireLease vs tryAcquireLease
- Transaction timeout surfaces as TransactionFaultError
- withLease always releases its lease, even when fn throws
- history pagination query
- load full chunk-integrity + manifest verification
- manifest_hash tamper-detection verification
- prune two-step manifest-then-chunk GC pass
- Content-addressed global chunk dedup requirement
- history cursor paging no-gap/no-duplicate requirement
- load always fully verifies chunk integrity
- ManifestCorruptError position-gap requirement
- manifestHash computed once at write time
- ManifestCorruptError chunk-hash-sequence tamper requirement
- CheckpointNotFoundError vs empty-history distinction
- prune retains exactly N newest manifests requirement
- save ValidationError before any work requirement
- CheckpointSummary metadata/label round-trip requirement
- PgWatermarks.get implementation
- Tasks — Sprint 7: Transaction History Storage
- Watermarks Postgres errors surface as StorageError requirement
- get never throws for an unset cursor requirement
- get returns last value scoped per (kind,key) requirement
- private_state_salts table / per-scope salt derivation
- set ValidationError before statement requirement
- Sprint 5 Recommendation — Wallet Integration Surface (TransactionHistoryStorage + Live-Sync Conformance)
- Watermarks AbortSignal pre-check-only requirement
- Design — Sprint 7: Transaction History Storage
- Top-level null value application-level guard
- Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface)
- complete flag explicit-write requirement
- postgres/transaction-history-storage.ts
- CheckpointStore cancellation scope decision (pre-check only)
- setup.ts
- ADDED Requirements
- pull_request_template.md
- AGENTS.md
- ledger-replay.test.ts
- ADDED Requirements
- ADDED Requirements
- runtime-metadata.ts
- transaction-history-storage.property.test.ts
- Change: `v1.0.0-recovery-testing` — G9/G10/G11 crash-injection + soak + differential (2026-07-24)
- Design — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery
- compilerOptions
- ADDED Requirements
- interfaces/temporal-kv.ts
- shielded-monitor/helpers.ts
- ADDED Requirements
- ADDED Requirements
- Storage Algebra Lean M3a Watermarks Sprint
- UmbraDB dev environment — master runbook
- Sprint 7 — Midnight preprod toolchain inventory & build checklist
- Design — Sprint 5: Lean M3a Watermarks W1
- Tasks — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery
- Midnight infra verification checklist
- Proposal — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery
- Preprod connection — endpoints, wallet, faucet
- Environment changelog
- storage-http-client.ts
- UmbraDB third-party component inventory (SBOM)
- Proposal — Sprint 5: Lean M3a Watermarks W1
- Tasks — Sprint 5: Lean M3a Watermarks W1
- cursor-durability.crash.test.ts
- ADDED Requirements
- Full-Chain Storage — Design
- postgres/transaction-lease.ts
- Design — v1.0.0-durable-checkpoint-cursor
- src/index.ts
- Plan: finish replacing the indexer with the node as the archive ingest source
- chain_archive lineage
- ADDED Requirements
- Design — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- chain-archive-rollover.ts
- UmbraDBSql
- Design — v1.0.0 API Surface & Release Contract
- NodeRpcClient
- ChainArchiveStore
- storage-wire.ts
- tx-replay-decoder.ts
- monitor-node.ts
- chain-archive-preprod-cloud-crossval.integration.test.ts
- UmbraDB v1.0.0 — Resume-From-Home Checkpoint (2026-07-23)
- Tasks — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- UmbraDB
- Full-chain storage
- Storage Algebra Lean M3b CheckpointStore C1 Sprint
- Design — Sprint 6: Lean M3b CheckpointStore C1
- Proposal — Sprint 6: Lean M3b CheckpointStore C1
- Tasks — Sprint 6: Lean M3b CheckpointStore C1
- Scalability ceilings (v1.0.0)
- UmbraDB Durability Contract
- midnight-env — reproducible PREPROD dev environment
- Tasks — v1.0.0 API Surface & Release Contract
- Design — v1.0.0-perf-baseline
- Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- extrinsic-decoder.ts
- UmbraDB 1.0.0 Release Contracts
- sync-service.ts
- Design — v1.0.0-infosec-signoff
- Roadmap
- Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)
- MAX_ENTRY_CONTENT_DEPTH
- full-sync-soak.integration.test.ts
- Acceptance — v1.0.0 API Surface & Release Contract
- differential-equivalence.test.ts
- UmbraDB v0.9.5 "Penumbra" — Release Record
- check-required-tests.ts
- stryker.conf.json
- chain-archive-sync-retry.integration.test.ts
- Acceptance criteria — v1.0.0-infosec-signoff
- Tasks — v1.0.0-infosec-signoff
- cold-boot-recovery.integration.test.ts
- UmbraDB V1.0.0 Implementation Guideline — the release constitution
- Acceptance — v1.0.0-durable-checkpoint-cursor
- Tasks — v1.0.0-durable-checkpoint-cursor
- Proposal — v1.0.0-perf-baseline
- pg-tx-history-adapter.ts
- pg-kill-save.crash.test.ts
- postgres/checkpoint-store.ts
- UmbraDB 0.9.5 "Penumbra"
- crash-worker.ts
- mutation-per-adapter.mjs
- monitor-store-pg.ts
- Proposal — v1.0.0 API Surface & Release Contract
- Proposal — v1.0.0-durable-checkpoint-cursor
- Proposal — v1.0.0-infosec-signoff
- Tasks — v1.0.0-perf-baseline
- Proposal — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)
- UmbraDB V1.0.0 — Lessons-Learned Living Log
- no-chain-sync-import-guard.test.ts
- lease-nonwedge.crash.test.ts
- scripts
- pack-install.mjs
- Acceptance criteria — v1.0.0-perf-baseline
- Tasks — v1.0.0: Formal completion (`formal-completion`)
- MonitorRecord
- README.md
- midnight-wallet-sdk-loader.ts
- start-stack.sh
- client.ts
- conformance-gate.mjs
- withSuiteWatchdog
- compilerOptions
- UmbraDB Frozen Error-Code Catalog
- ASSESSMENT — `midnight-node-archive` Peer Flapping (Midnight Preprod, WSL2 Docker Host)
- package.json
- mutation-evidence.d.mts
- Research Assessment: Single-Statement Unbounded `bytea` Inserts via postgres.js
- [0.9.5] - 2026-07-25 — "Penumbra"
- backup-state.sh
- enable-db-sync-tls.sh
- restore-state.sh
- stop-stack.sh
- ADDED Requirements
- dependencies
- storage-errors.ts
- Gate notes — Task 6: differential state-equivalence gate (G11)
- Tasks — Sprint 9: Indexer Independence
- migrate.ts
- Checkpoint-store composition contract — cursor ordering and replay
- Design — v1.1.0: Quint model checking
- Roadmap — `v1.1.0-formal-completion`: storage-algebra Lean mechanization vs 1.0.0 (v2, audit-reframed)
- Why "the node accepted it" is not the same as "it is a transaction"
- Spec — `model-checking` capability
- harness.ts
- Tasks — v1.1.0: Quint model checking
- files
- Security policy & threat model
- checkpoint-store-contract-doc.test.ts
- vitest.config.ts
- Design — Sprint 9: Indexer Independence
- Scope split: Part A / Part B — plan update and commit changes
- Proposal — v1.1.0: Quint model checking (`quint-model-checking`)
- Roadmap for the missing formalization
- Proposal — Sprint 9: Indexer Independence (differential-parity harness + first migrated primitive)
- ROADMAP.md
- Acceptance — v1.0.0: Formal completion (`formal-completion`)
- Design — v1.0.0: Formal completion (`formal-completion`)
- Proposal — v1.0.0: Formal completion (`formal-completion`)
- Acceptance — v1.1.0: Quint model checking
- Audit record — `v1.1.0-formal-completion` roadmap (v1 → v2)
- Spec — capability `formal-completion`
- Captured runtime metadata
- Requirements
- generate-test-wallet.sh
- chain-archive-replay-validation.integration.test.ts
- 5. Blocking correctness gaps
- shielded-monitor-batch-atomicity.crash.test.ts
- sync.ts
- Re-audit brief — audit round 2 remediation
- 13. Stage 2b — metadata availability (owner-approved, 2026-08-10)
- 8a. Dissent: concerns with revision 7, from the implementing author
- api/server.ts
- 12. Blockers and unknowns
- 4. What is genuinely demonstrated
- 10. Parallel track — upstream the ledger WASM export (not a goal of this plan)
- 11. Staged execution plan (owner, 2026-08-08)
- 1. Goal and scope
- Re-audit brief — audit round 3
- Requirements
- CrashWorkerHandle
- Requirements
- Requirements
- liveServicesRequired
- derive-key-cli.ts
- ledger-replay.ts
- ShieldedMonitorStore
- copy-cli-assets.mjs
- shielded-monitor/errors.ts
- 15. Audit round 3 — register (2026-08-13)
- golden.mjs
- verify-compose-image-pins.sh
- compose-image-pins.sh
- scanner.test.ts
- ArchiveReadContract
- archive-height-atomicity.crash.test.ts
- Requirement: The service lists every monitor it holds
- fake-node.ts
- DustLocalState
- api/config.ts
- MonitorNode
- archive-read-wire.ts
- dust/index.ts
- ledger.ts
- Transaction
- Design — 00009-02: shielded monitor store, key intake and lifecycle
- dust-routes.test.ts
- The shielded-monitor private API
- split-topology.integration.test.ts
- archive-read-api.integration.test.ts
- FakeStore
- routes.ts
- devnet.mjs
- client/cli.ts
- dust-sync-client/cli.ts
- ZswapLocalState
- handoff-ids.mjs
- bech32m.ts
- StateValue
- wake.ts
- InMemoryScannerMetrics
- import-boundary.test.ts
- balancer-routing.test.ts
- Demo runbook — watch the shielded monitor work
- LedgerState
- demo-shielded-monitor.mjs
- createShieldedMonitorApi
- DustStateMirror
- archive-read-api/server.ts
- dust-events.test.ts
- src/errors.ts
- Intent
- Design — 00009-01: archive read contract, block timestamp, per-height atomic commit
- Design — 00009-03: the shielded viewing-key relevance scanner
- server.test.ts
- Tasks — 00009-02: shielded monitor store, key intake and lifecycle
- Tasks — 00009-03: the shielded viewing-key relevance scanner
- Design — 00009-04: the private shielded-monitor HTTP API and its reference consumer
- api-ui.test.ts
- MonitorKeyStore
- backfill-block-timestamps.ts
- dust-events.ts
- dust-capture-overhead.ts
- Running the shielded-monitor node
- self-transfers.ts
- FakeDustNode
- archive-http-client.ts
- routing.ts
- Deploying the shielded monitor: one database, one storage process, N monitor-nodes
- compare.mjs
- Tasks — 00009-01: archive read contract, block timestamp, per-height atomic commit
- Tasks — 00009-04: the private shielded-monitor HTTP API and its reference consumer
- Tasks — 00009-06: dashboard, list endpoint, key derivation, demo runbook
- Tasks — 00009-07: match details
- Tasks — 00009-08: project B as a distinct deployable
- Tasks — 00009-09: the merged monitor-node
- runtime-metadata.test.ts
- Backup and restore — `shielded_monitor` (project B)
- bin
- dust-harness.ts
- node-rpc-client.ts
- sdk-dust-state.ts
- ContractState
- StateBoundedMerkleTree
- ZswapChainState
- ZswapOffer
- Design — 00009-07: match details
- DustDb
- DustModule
- ShieldedViewingKey
- pg-tx-history-adapter.test.ts
- dust-backfill-cli.ts
- `dust-sync-client` — a wallet builds its DUST state in seconds
- ClaimRewardsTransaction
- EncryptionSecretKey
- LedgerParameters
- QueryContext
- VmStack
- Design — 00009-06: dashboard, list endpoint, key derivation
- Design — 00009-08: the storage boundary
- Design — 00009-09: the merged monitor-node
- DustStateMerkleTreeCollapsedUpdate
- StateMap
- ZswapOutput
- Proposal — 00009-01: archive read contract, block timestamp, per-height atomic commit
- Proposal — 00009-09: the merged monitor-node, with viewing keys only in RAM
- Spec — the merged monitor-node (EARS)
- TransactionCostModel
- UnshieldedOffer
- ZswapInput
- ZswapTransient
- Proposal — 00009-02: shielded monitor store, key intake and lifecycle (project B core)
- Proposal — 00009-04: the private shielded-monitor HTTP API and its reference consumer
- Proposal — 00009-06: a dashboard for the shielded monitor, a list endpoint, and a key-derivation command
- Proposal — 00009-07: record and show each match's public zswap data
- Proposal — 00009-08: project B as a distinct deployable, with no database of its own
- Spec — the shielded-monitor storage boundary (EARS)
- mutate
- viewing-key.test.ts
- Binding
- CoinSecretKey
- ContractMaintenanceAuthority
- ContractOperation
- DustActions
- DustGenerationState
- DustParameters
- DustRegistration
- DustSecretKey
- DustSpend
- DustState
- DustUtxoState
- Event
- MerkleTreeCollapsedUpdate
- NoBinding
- PreBinding
- PreProof
- Proof
- SignatureEnabled
- SystemTransaction
- UtxoState
- ZswapSecretKeys
- Proposal — 00009-03: the shielded viewing-key relevance scanner (project B's worker)
- dust-public-key.ts
- indexer-event-ids.ts
- ContractCallPrototype
- CostModel
- MaintenanceUpdate
- restore-smoke.ts
- sdk-run.sh
- ChargedState
- ContractCall
- ContractDeploy
- ContractOperationVersion
- ContractOperationVersionedVerifierKey
- NoProof
- PrePartitionContractCall
- PreTranscript
- QueryResults
- ReplaceAuthority
- SignatureErased
- TransactionContext
- TransactionResult
- VerifierKeyInsert
- VerifierKeyRemove
- VmResults
- shielded-monitor-entrypoint.sh
- CHAIN_ARCHIVE_PROGRESS_CHANNEL

## God Nodes (most connected - your core abstractions)
1. `UmbraDBSql` - 137 edges
2. `createClient()` - 98 edges
3. `translatePostgresError()` - 78 edges
4. `MonitorRecord` - 71 edges
5. `PgChainArchiveStore` - 56 edges
6. `ChainArchiveSyncService` - 55 edges
7. `withSuiteWatchdog()` - 55 edges
8. `PgShieldedMonitorStore` - 50 edges
9. `PgTransactionLeaseLayer` - 45 edges
10. `StorageError` - 44 edges

## Surprising Connections (you probably didn't know these)
- `readBody()` --indirect_call--> `chunk()`  [INFERRED]
  storage-api/server.ts → dust-sync-client/src/encode.ts
- `startUpstream()` --indirect_call--> `chunk()`  [INFERRED]
  test/shielded-monitor/balancer.test.ts → dust-sync-client/src/encode.ts
- `BenchEnv` --references--> `UmbraDBSql`  [EXTRACTED]
  bench/environment.ts → src/postgres/client.ts
- `tinybenchSamples()` --references--> `bench`  [EXTRACTED]
  bench/stats.ts → package.json
- `syncDust()` --indirect_call--> `index()`  [INFERRED]
  dust-sync-client/src/sync.ts → chain-archive-sync/dust-events.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **The Nine Laws Forming UmbraDB's Storage Algebra** — formal_storage_algebra_law_t1, formal_storage_algebra_law_t2, formal_storage_algebra_law_t3, formal_storage_algebra_law_t4, formal_storage_algebra_law_t5, formal_storage_algebra_law_c1, formal_storage_algebra_law_c2, formal_storage_algebra_law_w1, formal_storage_algebra_law_l1 [EXTRACTED 1.00]
- **Four storage modules unified under StorageError hierarchy** — design_design_interfaces_storageerror, design_design_interfaces_temporalkv, design_design_interfaces_checkpointstore, design_design_interfaces_watermarks, design_design_interfaces_transactionleaselayer_stale [EXTRACTED 1.00]
- **Modules composing the Sprint 2 transaction-handle registry** — sprint2_design_transaction_handle_registry, sprint1_design_pgtemporalkv_put, sprint3_design_torn_read_fix, sprint4_design_composing_txlease [EXTRACTED 1.00]
- **Pre-check-only withAbort cancellation pattern across sprints** — sprint1_design_listkeys_cursor, sprint2_design_withtransaction, sprint3_design_cancellation_scope_decision, sprint4_design_cancellation [INFERRED 0.85]

## Communities (413 total, 141 thin omitted)

### Community 0 - "ADDED Requirements"
Cohesion: 0.04
Nodes (45): ADDED Requirements, release-contract, Requirement: A cancellation contract states the abort guarantee as public behavior, Requirement: A CHANGELOG records the 1.0.0 surface, Requirement: A durability contract states the ordering guarantee and its binding precondition, Requirement: A format-headroom note reserves keyed/encrypted chunk modes for 1.1, Requirement: A forward-only migration contract states there is no supported downgrade, Requirement: A lease-limitation contract states the single-process boundary (+37 more)

### Community 1 - "StorageError"
Cohesion: 0.06
Nodes (41): CheckpointNotFoundError, CheckpointStoreError, ChunkIntegrityError, ChunkMissingError, ManifestCorruptError, ConnectionError, Retryability, SerializationFailedError (+33 more)

### Community 2 - "published-ledger-v8-8.1.0.d.ts"
Cohesion: 0.02
Nodes (86): AlignedValue, Alignment, AlignmentAtom, AlignmentSegment, Bindingish, BlockContext, CallContext, ClaimKind (+78 more)

### Community 3 - "ADDED Requirements"
Cohesion: 0.08
Nodes (25): ADDED Requirements, Requirement: concurrent writers merging the same tx hash never lose a section, Requirement: driver-level failures surface as the shared StorageError hierarchy, Requirement: getAll returns live bigint/Date-typed values, not JSON-stringified primitives, Requirement: identifier-subset pending-clear rule survives repeated merges, Requirement: merge semantics are equivalent to mergeWalletEntries, not last-write-wins, Requirement: one storage instance is bound to exactly one wallet at construction, Requirement: serialize() is a full synchronous-equivalent dump matching the fixed interface contract (+17 more)

### Community 4 - "scoped-review-manifest"
Cohesion: 0.22
Nodes (8): Cleanup, scoped-review-manifest, Step 0 — Skip check, Step 1 — Freshness gate, Step 2 — Changed-file seed set, Step 3 — Blast-radius computation, Step 4 — Write the manifest, Step 5 — Hand off

### Community 5 - "Storage Algebra Lean Formalization — Approved Design and Status"
Cohesion: 0.04
Nodes (44): 10. Sprint 2 transaction/lease proposal, 11.1 Repository evidence, 11.2 External primary sources, 11. Evidence matrix, 12. Milestone status, 13. Approved implementation decisions, 1. Executive conclusion, 2.1 Historical implementation baseline (+36 more)

### Community 6 - "devDependencies"
Cohesion: 0.07
Nodes (29): effect, fast-check, ledger-v8-stock, @midnightntwrk/wallet-sdk-abstractions, devDependencies, effect, fast-check, ledger-v8-stock (+21 more)

### Community 8 - "openspec-explore/SKILL.md"
Cohesion: 0.12
Nodes (16): Check for context, Ending Discovery, Guardrails, Handling Different Entry Points, OpenSpec Awareness, The Stance, What You Don't Have To Do, What You Might Do (+8 more)

### Community 10 - "include"
Cohesion: 0.09
Nodes (21): bench/**/*.ts, dust-sync-client/cli.ts, dust-sync-client/src/**/*.ts, dust-sync-client/test/**/*.ts, compilerOptions, declaration, esModuleInterop, module (+13 more)

### Community 11 - "kv_current/kv_history temporal-table design"
Cohesion: 0.05
Nodes (43): Content-addressed checkpoint chunker, ckpt_manifest_chunks junction table (original, later corrected), FerretDB Mongo-compatibility shim evaluated and rejected, kv_history retention policy (pg_cron), State-equivalence merge-blocker gate, kv_current/kv_history temporal-table design, TransactionKeyReuseError / txid_current() fix, watermarks table schema sketch (+35 more)

### Community 20 - "Requirements"
Cohesion: 0.06
Nodes (34): Purpose, Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored, Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed, Requirement: Dual addressing agrees at recorded write timestamps (Law T4), Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window, Requirement: History intervals never overlap for a single key (Law T5), Requirement: listKeys streams without materializing the full result set first, and orders results correctly, Requirement: Migrations are idempotent and ordered (+26 more)

### Community 27 - "Storage Algebra Lean M2 Retention Sprint"
Cohesion: 0.15
Nodes (12): Adversarial test matrix, Approved semantic decisions, Completed baseline, Executable pruning, Explicit non-goals, Extensional T5, Implemented source layout, Lookup classification (+4 more)

### Community 33 - "TemporalKV Algebra"
Cohesion: 0.10
Nodes (23): Superseded — see `Formal/STORAGE_ALGEBRA.md`, crdt-lean Dependency Refutation, CheckpointStore Algebra, ckpt_manifest_chunks Junction Table, Law C1 — Join-Semilattice Chunk Writes, Law C2 — GC Reachability Closure, Law L1 — Lease Mutual Exclusion, Law T1 — Gapless Monotonicity (+15 more)

### Community 35 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Plan Self-Review, Storage Algebra Lean M1 Implementation Plan, Task 1: Pin the project and prove the imported API smoke slice, Task 2: Implement the executable TemporalKV history kernel, Task 3: Prove the M1 TemporalKV theorem slice, Task 4: Add reproducible trust gates and close the M1 documentation loop

### Community 57 - "Tasks — Sprint 7: Transaction History Storage"
Cohesion: 0.20
Nodes (9): 0. Specification freeze, 1. Vendor/pin manifest, 2. Schema + interface, 3. PgTransactionHistoryStorage implementation, 4. WalletState envelope, 5. Storage-swappable conformance harness (Pg-only tier — required merge gate), 6. Live-sync tier (nightly/labeled — blocked on design.md §7's open question), 7. Close-out (+1 more)

### Community 63 - "Sprint 5 Recommendation — Wallet Integration Surface (TransactionHistoryStorage + Live-Sync Conformance)"
Cohesion: 0.22
Nodes (8): 1. Decisive scope, 2. Live-sync conformance test plan, 3. Open questions for the design-drafting stage, 4. Prioritized artifacts (dependency order), Architectural boundary (explicit owner directive, confirmed post-consolidation), Build (one product module + one thin envelope — corrected from the original "exactly two things, zero new code" framing; see finding below), Do not build (obsoleted — confirmed against real source), Sprint 5 Recommendation — Wallet Integration Surface (TransactionHistoryStorage + Live-Sync Conformance)

### Community 65 - "Design — Sprint 7: Transaction History Storage"
Cohesion: 0.22
Nodes (8): 1. Schema, 2. Dependency direction: structural mirror, not a runtime import, 3. Atomic merge under concurrent writers, 4. Multi-wallet identity, 5. WalletState envelope, 6. Open questions carried into this sprint (unresolved, tracked here rather than silently defaulted), 7. What "live-sync" means for this sprint's non-required test tier, Design — Sprint 7: Transaction History Storage

### Community 66 - "Top-level null value application-level guard"
Cohesion: 0.67
Nodes (3): prune retainCount validation requirement, Top-level null value application-level guard, set rejects top-level null requirement

### Community 67 - "Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface)"
Cohesion: 0.29
Nodes (6): Impact, Non-goals, Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface), What changes, Why, Why this sprint is numbered 7, not 5

### Community 69 - "postgres/transaction-history-storage.ts"
Cohesion: 0.06
Nodes (31): TemporalKV, MergeEntriesFn, TransactionHistoryEntry, TransactionHistoryEntrySchema, TransactionHistoryWriter, TransactionHandle, assertStoredEntryShape(), capitalize() (+23 more)

### Community 70 - "CheckpointStore cancellation scope decision (pre-check only)"
Cohesion: 0.06
Nodes (32): Advisory-lock class registry (classes 1/2/3), Module → Postgres module mapping table, Postgres advisory-lock writer lease (corrected design), CheckpointNotFoundError, CheckpointStore interface, CheckpointWalletStateStore (production adapter), Global cross-wallet chunk GC reclamation fix, WalletStateStore (project abstraction) (+24 more)

### Community 71 - "setup.ts"
Cohesion: 0.10
Nodes (20): class2AdvisoryLockCountForHash(), liveWorkers, manifestCount(), openPools, pool(), { sql: getSql, connectionUri }, watermarkCount(), Cancellable (+12 more)

### Community 72 - "ADDED Requirements"
Cohesion: 0.11
Nodes (18): ADDED Requirements, formal-watermarks, Requirement: Command traces compose in list order, Requirement: Lookup after a trace returns the last matching value, Requirement: Set is an unconditional overwrite at the exact address, Requirement: Set preserves distinct addresses, Requirement: The abstract Watermarks store has one absence representation, Requirement: The W1 proof claim remains abstract (+10 more)

### Community 73 - "pull_request_template.md"
Cohesion: 0.50
Nodes (3): Change summary, Mandatory Codex audit, Validation

### Community 75 - "ledger-replay.test.ts"
Cohesion: 0.14
Nodes (12): ReplayRefusalError, CLOSE_ORACLE_ROWS, CLOSE_ORACLES, CORRUPTED_REGULAR_HEX, Cost, Dimension, FIXTURE, GENESIS_PARENT (+4 more)

### Community 76 - "ADDED Requirements"
Cohesion: 0.05
Nodes (36): ADDED Requirements, Requirement: a cold boot resumes without a full resync and preserves tx-history continuity, Requirement: a corrupt or non-JSON envelope payload is rejected with a typed error, Requirement: a live-synced transaction materializes as a Postgres row observable via getAll, Requirement: a sub-wallet absent from the envelope is skipped on restore, Requirement: an unrecognized envelopeVersion is rejected, never best-effort restored, Requirement: each sub-wallet resumes from its own last-known point; the envelope bundles for atomicity only, Requirement: encode and decode are lossless inverses (+28 more)

### Community 77 - "ADDED Requirements"
Cohesion: 0.04
Nodes (45): ADDED Requirements, durable-composition (implementation), Requirement: a conforming composition keeps the durable cursor from ever being ahead of durable checkpoint data, Requirement: a durability probe asserts the server's crash-safety settings at client bootstrap, Requirement: a transaction-pooling proxy is detected and refused, Requirement: JsonValueSchema rejects values exceeding the maximum nesting depth, Requirement: migration advisory-lock acquisition is bounded and fails fast, Requirement: PgCheckpointStore validates walletId and networkId at every entry point (+37 more)

### Community 78 - "runtime-metadata.ts"
Cohesion: 0.14
Nodes (13): RuntimeCallIndices, BlockScopedMetadata, callIndex(), eventsTypeId(), EventSystemTransaction, findPallet(), hexToBytes(), isHistoricalStateUnavailable() (+5 more)

### Community 79 - "transaction-history-storage.property.test.ts"
Cohesion: 0.12
Nodes (16): EntryContent, applyCommand(), arbitraryCommand, badKeyValue, Command, GOOD_LEAF_KEYS, goodLeaf, goodNestedObject (+8 more)

### Community 80 - "Change: `v1.0.0-recovery-testing` — G9/G10/G11 crash-injection + soak + differential (2026-07-24)"
Cohesion: 0.10
Nodes (20): Audit (round 1) — the confirmation-bias control paid off, Boundary held, Change: `v1.0.0-api-surface` — G1/G2/G3/G4/G20 the public-surface freeze (2026-07-24), Change: `v1.0.0-durable-checkpoint-cursor` — G6 / G7 / G8 (2026-07-24), Change: `v1.0.0-perf-baseline` — G13 / G14 (2026-07-24), Change: `v1.0.0-recovery-testing` — G9/G10/G11 crash-injection + soak + differential (2026-07-24), Reconciliations recorded as consolidating-lead decisions (spec written pre-G6/G7), Rework (class 1 — infra) (+12 more)

### Community 81 - "Design — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery"
Cohesion: 0.11
Nodes (17): 1.1 Envelope shape, 1. Envelope decision: (a) one versioned envelope — DECIDED, 2. Module layout and dependency direction, 3.1 Field mapping (write path), 3.2 Lifecycle-detail fidelity — the correctness-gate open question, 3.3 No runtime SDK import in core, 3.4 serialize() is a diagnostic dump, not a migration path (F10), 3. The adapter (the seam) (+9 more)

### Community 82 - "compilerOptions"
Cohesion: 0.11
Nodes (18): chain-archive-sync, src/**/*.test.ts, compilerOptions, declaration, declarationMap, noEmit, outDir, rootDir (+10 more)

### Community 83 - "ADDED Requirements"
Cohesion: 0.05
Nodes (43): ADDED Requirements, Requirement: A real VerifyFull/--ca path is provided, replacing the stub (G17), Requirement: A shipped threat-model document states the single-trusted-writer trust model (G15), Requirement: CI gates any change to flake.lock behind explicit review (G18), Requirement: CI installs dependencies with npm ci (G18), Requirement: CI runs a blocking npm audit on runtime dependencies (G18), Requirement: CI runs full-history gitleaks secret scanning with the wallet history and template allowlisted (G18), Requirement: CI scans both pinned Docker image digests for CVEs (G18) (+35 more)

### Community 84 - "interfaces/temporal-kv.ts"
Cohesion: 0.16
Nodes (21): AsOf, AssertExact, exceedsMaxDepth(), ExpectedVersionSchema, JsonValueInnerSchema, JsonValueSchema, Key, KeySchema (+13 more)

### Community 85 - "shielded-monitor/helpers.ts"
Cohesion: 0.06
Nodes (50): benchHash(), benchSeed(), envInt(), KeyResult, main(), serializeKeyFromSeed(), deserialize(), disposeQuietly() (+42 more)

### Community 86 - "ADDED Requirements"
Cohesion: 0.05
Nodes (37): ADDED Requirements, chain-archive-node-ingest (implementation), Requirement: an archived transaction is selected by its dispatched call, and typed by its payload, Requirement: catch-up is finalized-only and refuses disconnected canonical rows, Requirement: Compose image pin enforcement examines the resolved model, Requirement: D-parameter change observations are restart-stable, Requirement: finalized block bundles are serialized across writers, Requirement: indexer ground truth is captured for all six primitives while the indexer runs (+29 more)

### Community 87 - "ADDED Requirements"
Cohesion: 0.05
Nodes (40): ADDED Requirements, recovery-testing (crash-injection, soak, differential & live-evidence gate), Requirement: G10 — a full-sync soak runs at a declared envelope with GC passes and holds every invariant, Requirement: G10 — load during a concurrent prune never corrupts a live checkpoint's retrieval, Requirement: G11/T11 — a fault-schedule run is state-equivalent to a fault-free reference, Requirement: G11 — the differential gate is anchored on the P3 replay-equivalence property, Requirement: G12 — a manual pre-tag Preprod round-trip is run against the RC with recorded evidence, Requirement: G9 — a skip-enforcement check proves every required crash test executed, none silently skipped (+32 more)

### Community 88 - "Storage Algebra Lean M3a Watermarks Sprint"
Cohesion: 0.25
Nodes (7): Adversarial examples, Audited semantic decisions, Explicit non-goals, Source layout, Storage Algebra Lean M3a Watermarks Sprint, Theorem gate, Verification matrix

### Community 89 - "UmbraDB dev environment — master runbook"
Cohesion: 0.22
Nodes (8): Build / run (from source — all public, no ghcr auth), Credentials, Host, Midnight repos (cloned under ~/repos), Shell / PATH persistence, Tooling (all rootless / user-space), UmbraDB dev environment — master runbook, Wallet SDK install (public-npm workaround — IMPORTANT)

### Community 90 - "Sprint 7 — Midnight preprod toolchain inventory & build checklist"
Cohesion: 0.22
Nodes (8): A. System / host toolchain (shared), B. midnight-node (from source → preprod), C. midnight-indexer (GraphQL WS the wallet syncs against), Credentials summary, D. proof-server (from source — corrects earlier "ghcr-only" finding), E. midnight-wallet SDK, Key version decision (resolved), Sprint 7 — Midnight preprod toolchain inventory & build checklist

### Community 91 - "Design — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.29
Nodes (6): 1. Executable carrier, 2. Commands and interpretation, 3. Laws, 4. Trust and reachability, 5. Refinement boundary, Design — Sprint 5: Lean M3a Watermarks W1

### Community 92 - "Tasks — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery"
Cohesion: 0.20
Nodes (9): 0. Specification freeze, 1. Vendor/pin manifest (for the nightly live tier), 2. Envelope module (Pg-only — required gate), 3. Adapter seam (Pg-only for its own tier — required gate), 4. Pg-only conformance suite (required merge gate) — `test:conformance`, 5. Live preprod DB-sync + cold-boot tiers (nightly/labeled — NOT a required gate), 6. Close-out, Deferred to Sprint 9 (Batch 3 — recorded as honest deferrals, NOT implemented here) (+1 more)

### Community 93 - "Midnight infra verification checklist"
Cohesion: 0.29
Nodes (6): A. Toolchain & binaries (all self-serve from public source), B. Preprod connectivity (public endpoints, verified live), C. Our wallet, D. Operations to verify (the requested end-to-end), E. Our from-source node (prove the build works as a real node), Midnight infra verification checklist

### Community 94 - "Proposal — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery"
Cohesion: 0.29
Nodes (6): Impact, Non-goals (explicitly out of scope), Proposal — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery, Scope of Sprint 8 (functional DB-backed persistence + recovery), What changes, Why this sprint exists, and why it unblocks Sprint 7

### Community 95 - "Preprod connection — endpoints, wallet, faucet"
Cohesion: 0.33
Nodes (5): Faucet (get tNIGHT), Our preprod wallet, Preprod connection — endpoints, wallet, faucet, Public preprod endpoints (all verified live), Sync cost (CORRECTED — no block-height "birthday" for the unshielded wallet)

### Community 98 - "storage-http-client.ts"
Cohesion: 0.08
Nodes (33): bytesToBase64Url(), HttpMonitorStore, safeJson(), StorageHttpError, StorageUnreachableError, toStoreError(), unwrapMonitor(), bytesToBase64() (+25 more)

### Community 99 - "UmbraDB third-party component inventory (SBOM)"
Cohesion: 0.06
Nodes (28): 1. npm — runtime dependencies, 2. npm — direct dev dependencies, 3. Nix — flake inputs (git-pinned), 4. Nix — pinned release binaries (`fetchurl` + sha256), 5. Docker images (digest-pinned), 6. Nix — nixpkgs packages (from the locked nixpkgs), 7. Lean / mathlib toolchain, 8. Host / toolchain dependencies (+20 more)

### Community 100 - "Proposal — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): Impact, Non-goals, Proposal — Sprint 5: Lean M3a Watermarks W1, What changes, Why

### Community 101 - "Tasks — Sprint 5: Lean M3a Watermarks W1"
Cohesion: 0.33
Nodes (5): 0. Specification freeze, 1. Executable Watermarks model, 2. W1 theorem tranche, 3. Close-out, Tasks — Sprint 5: Lean M3a Watermarks W1

### Community 102 - "cursor-durability.crash.test.ts"
Cohesion: 0.09
Nodes (27): adaptersFor(), adaptersOf(), ALL_BATCH_SPECS, ALL_BATCHES, completeManifestCount(), driveFullBatch(), durableCompleteSeqs(), durableKvValues() (+19 more)

### Community 103 - "ADDED Requirements"
Cohesion: 0.06
Nodes (33): ADDED Requirements, performance-baseline (implementation), Requirement: a benchmark baseline is recorded as a committed artifact (the G14 gate), Requirement: a coarse smoke guard is wired now; the CV-aware regression gate is deferred, Requirement: an in-repo benchmark harness drives the real adapters against a pinned Postgres, Requirement: ckpt_chunks carries a stored size_bytes column computed without detoasting (IS-2), Requirement: history() computes per-manifest aggregates in a single grouped query (HP-2), Requirement: kv_current is fillfactor-tuned to preserve HOT-update eligibility (IS-1) (+25 more)

### Community 104 - "Full-Chain Storage — Design"
Cohesion: 0.06
Nodes (31): 10. Residual limitations and open questions for the design council, 11. Phasing table, 1. Problem and core principle, 2. Source grounding, 3.1 Block header, 3.2 Raw transaction blob (opaque SCALE-wrapped ledger tx), 3.3 Transactions / regular_transactions (queryable metadata split), 3.4 Unshielded UTXOs (+23 more)

### Community 105 - "postgres/transaction-lease.ts"
Cohesion: 0.09
Nodes (22): Lease, LeaseAcquireOptions, LeaseAcquireOptionsSchema, TransactionOptionsSchema, abortError(), activeTransactions, HeldLease, PgTransactionLeaseLayer (+14 more)

### Community 106 - "Design — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.07
Nodes (26): 0. Package layout, 1.1 The gap, confirmed in source, 1.2 Change `save` to accept a caller transaction, 1.3 The `saveAndAdvance` combinator, 1.4 The ordering contract (for callers composing manually), 1. G5 — Co-transactional watermark + checkpoint data, 2.1 Where the probe runs (the one real design decision), 2.2 The three durability settings (+18 more)

### Community 107 - "src/index.ts"
Cohesion: 0.06
Nodes (59): CheckpointRecord, CheckpointSequence, CheckpointStore, CheckpointStoreErrorCode, CheckpointSummary, ContentHash, HistoryOptions, PruneResult (+51 more)

### Community 108 - "Plan: finish replacing the indexer with the node as the archive ingest source"
Cohesion: 0.13
Nodes (14): 0. Decisions made by revision 7 (historical; later registers supersede status), 14. Audit round 2 — remediation register (owner-reported, 2026-08-11), 16. Targeted re-audit of the round-3 fixes — register (2026-08-13), 17. Formal T1–T8 remediation audit — register (2026-08-13, head `1c46ba2`), 18. Round-5 re-audit — register (2026-08-14, head `a6e8772`), 19. O1–O5 implementation register (2026-08-15), 2. Repositories and reviewed baseline, 3. Reference behavior to reproduce (+6 more)

### Community 109 - "chain_archive lineage"
Cohesion: 0.10
Nodes (21): `blocks`, Boundary enforcement, `bridge_observations`, chain_archive lineage, `chain_archive.watermarks`, `chain_blobs` / `chain_blob_roles`, CheckpointStore tables, `dust_events` (+13 more)

### Community 110 - "ADDED Requirements"
Cohesion: 0.12
Nodes (16): ADDED Requirements, formal-checkpoint-c1, Requirement: C1 remains a save-only abstract projection, Requirement: Chunk identities form an unconditional finite join projection, Requirement: Chunk-map merge preserves existing bytes, Requirement: Collision freedom is an explicit local theorem premise, Requirement: Compatible chunk maps satisfy conditional C1 commutation, Requirement: Saving identity inputs is extensive, repeat-idempotent, and order-independent (+8 more)

### Community 111 - "Design — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.11
Nodes (18): 0. Test-infrastructure layout, 1.1 Skip-enforcement mechanism — the anti-self-skip guarantee, made a named check, 1. Crash harness — deterministic faults, not timing races (`council/B` §3 tooling ruling), 2.1 Process-kill mid-save (T1) — `02` §"Fault-injection test plan" T1; `council/B` §3 item 1, 2.2 Postgres-kill mid-save + retry-duplication contract (T2) — `02`-T2; `council/B` §3 item 2, 2.3 Crash between data and cursor — the keystone (T5) — `02`-T5; `council/B` §3 item 3; §5 item 1, 2.4 Lease non-wedge cold start (T3) — `02`-T3; `council/B` §3 item 4, 2. G9 — the four crash tests (+10 more)

### Community 112 - "chain-archive-rollover.ts"
Cohesion: 0.24
Nodes (12): AnySql, assertDefaultSpanFitsOneBucket(), assertValidBucketBounds(), assertValidPartitionSuffix(), attachedPartitionBound(), getFkConstraintName(), quoteIdent(), ROLLOVER_TABLES (+4 more)

### Community 113 - "UmbraDBSql"
Cohesion: 0.07
Nodes (41): BlobIntegrityError, BlobMissingError, BlobRole, BlockBundle, BlockMeta, BlockNotFoundError, BlockRecord, BlockStatus (+33 more)

### Community 114 - "Design — v1.0.0 API Surface & Release Contract"
Cohesion: 0.12
Nodes (15): 0. Ordering constraint (why this change is Phase 2, not Phase 1), 1.1 The barrel: `src/index.ts`, 1.2 `package.json` — make it publishable with a strict `exports`, 1.3 Packed-tarball install smoke test, 1. G1 — Public API surface, 2. G2 — SemVer stability policy + CHANGELOG, 3.1 The frozen catalog (the machine-facing API), 3.2 Promote retryability to a machine-readable field (+7 more)

### Community 117 - "storage-wire.ts"
Cohesion: 0.05
Nodes (50): associationFromWire(), Base64Schema, base64ToBuffer(), base64ToBytes(), BigintStringSchema, decodeAdvanceBatchItem(), decodeAssociationInput(), DetailsSchema (+42 more)

### Community 118 - "tx-replay-decoder.ts"
Cohesion: 0.09
Nodes (26): decodeArchivedTransaction(), DecodedArchivedTransaction, DecodedDustRegistration, DecodedDustSpend, DecodedUnshieldedOutput, DecodedZswapInput, DecodedZswapOutput, hexNoPrefixLower() (+18 more)

### Community 119 - "monitor-node.ts"
Cohesion: 0.05
Nodes (60): buildMatchDetails(), isolateAndTest(), MatchInputDetail, MatchOutputDetail, MatchSegmentDetail, MatchTransientDetail, MineAttribution, optionalString() (+52 more)

### Community 120 - "chain-archive-preprod-cloud-crossval.integration.test.ts"
Cohesion: 0.15
Nodes (5): IndexerClient, IndexerClientError, IndexerClientParseError, IndexerTransaction, MAX

### Community 121 - "UmbraDB v1.0.0 — Resume-From-Home Checkpoint (2026-07-23)"
Cohesion: 0.20
Nodes (9): 1. Current `main` state, 2. Preprod sync — PAUSED (safely), no progress lost, 2a. Resume on THIS machine, 2b. Resume on a FRESH machine, 3. Reproducible environment, 4. Roadmap status — G5 done, 19 to go, 5. Established implementation workflow (follow it for G6–G8), 6. Worktree cleanup (+1 more)

### Community 122 - "Tasks — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.17
Nodes (11): 0. Crash harness (foundation), 1. Process-kill mid-save (G9 / 02-T1), 2. Postgres-kill mid-save + retry-duplication contract (G9 / 02-T2), 3. Crash between data and cursor — the keystone (G9 / 02-T5)  ⟵ depends on G5, 4. Lease non-wedge cold start (G9 / 02-T3), 5. Full-sync soak + load-under-concurrent-prune (G10), 6. Differential state-equivalence gate, rescoped in-repo (G11)  ⟵ fault-schedule half depends on G5, 7. CI gate wiring (+3 more)

### Community 123 - "UmbraDB"
Cohesion: 0.10
Nodes (20): CheckpointStore: content-addressed snapshots, Contents, Durability and crash semantics, Errors and retryability, License, Performance and ceilings, Schema and migrations, Security (+12 more)

### Community 124 - "Full-chain storage"
Cohesion: 0.22
Nodes (8): DUST ledger events (`chain_archive.dust_events`), Evidence and remaining scope, Full-chain storage, Indexer-independent ingest, Purpose and boundary, Replay validation and committed roots, Running the service, Schema and write contract

### Community 125 - "Storage Algebra Lean M3b CheckpointStore C1 Sprint"
Cohesion: 0.22
Nodes (8): Adversarial examples, Audited semantic decisions, Compatible-map theorem gate, Explicit non-goals, Identity-projection theorem gate, Source layout, Storage Algebra Lean M3b CheckpointStore C1 Sprint, Verification matrix

### Community 126 - "Design — Sprint 6: Lean M3b CheckpointStore C1"
Cohesion: 0.29
Nodes (6): 1. Finite identity projection, 2. Finite byte-bearing maps, 3. Collision premise bridge, 4. Laws and trust boundary, 5. Refinement boundary, Design — Sprint 6: Lean M3b CheckpointStore C1

### Community 127 - "Proposal — Sprint 6: Lean M3b CheckpointStore C1"
Cohesion: 0.33
Nodes (5): Impact, Non-goals, Proposal — Sprint 6: Lean M3b CheckpointStore C1, What changes, Why

### Community 128 - "Tasks — Sprint 6: Lean M3b CheckpointStore C1"
Cohesion: 0.33
Nodes (5): 0. Specification freeze, 1. Chunk-identity projection, 2. Compatible chunk maps, 3. Close-out, Tasks — Sprint 6: Lean M3b CheckpointStore C1

### Community 129 - "Scalability ceilings (v1.0.0)"
Cohesion: 0.20
Nodes (9): Environment pinning (for reproduction), Regression gating posture, SC-1 — `kv_history` unbounded growth, SC-2 — `ckpt_chunks` GC cost is O(live chunks), full anti-join per pass, SC-3 — `load()` single-buffer materialization, SC-4 — single global writer lease serializes writers, SC-5 — TransactionHistory GIN `fastupdate` p99 spikes, SC-6 — TOAST storage mode on `ckpt_chunks.data` (+1 more)

### Community 130 - "UmbraDB Durability Contract"
Cohesion: 0.25
Nodes (7): 1. `fsync = on` — probe-enforced, 2. `full_page_writes = on` — probe-enforced (overridable), 3. `synchronous_commit` — probe-warned, never refused, 4. Session-mode connection pooling only — probe-enforced (best-effort), 5. Server-side timeouts — applied by `createClient` (documented), Summary, UmbraDB Durability Contract

### Community 131 - "midnight-env — reproducible PREPROD dev environment"
Cohesion: 0.22
Nodes (8): 1. Reproducibility contract — what is pinned, and how, 2. Host-state assumptions the flake does NOT capture (the real impurities), 3. How to reproduce (exact steps), 4. Validation performed, 5. Impurity reduction vs. documented-as-known, midnight-env — reproducible PREPROD dev environment, Security — db-sync TLS posture (READ BEFORE ENABLING TLS), Why `nix develop -c bash scripts/start-stack.sh` and not `nix run .#start-stack`

### Community 132 - "Tasks — v1.0.0 API Surface & Release Contract"
Cohesion: 0.18
Nodes (10): 0. Preconditions (blocking gate — verify before any freeze work), 1. Pre-freeze: retryability field (G3), 2. Pre-freeze: strip / mark-experimental the chain-archive error classes (G3), 3. The freeze: build + package.json (G1), 4. The freeze: the public barrel (G1), 5. Release contract docs (G2, G4), 6. Freeze the Lean cut-line (G20), 7. Packed-tarball install smoke test (G1) (+2 more)

### Community 133 - "Design — v1.0.0-perf-baseline"
Cohesion: 0.18
Nodes (10): 0. Package layout, 1. HP-1 — `save()` `UNNEST` batching (G13), 2. HP-2 + IS-2 — `history()` single `GROUP BY` over a stored `size_bytes` (G13), 3. IS-1 — `kv_current fillfactor=90` (G13), 4. G14 — benchmark harness, 5. G14 — the GC anti-join measurement + recorded baseline, 6. G14 — documented scalability ceilings (SC-1..SC-6), 7. Boundaries and non-goals respected (+2 more)

### Community 134 - "Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.18
Nodes (10): Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`), Boundary / scope guardrails (council rulings honored), Crash between data and cursor — keystone (G9 / T5, depends on G5), Differential state-equivalence, in-repo (G11, fault-schedule half depends on G5), Full-sync soak + load-under-prune (G10), Lease non-wedge cold start (G9 / T3), Manual pre-tag Preprod evidence run (G12, release step 7, against the RC), Postgres-kill mid-save + retry contract (G9 / T2) (+2 more)

### Community 135 - "extrinsic-decoder.ts"
Cohesion: 0.25
Nodes (14): assertSupportedProtocolVersion(), CALL_INDICES_BY_PROTOCOL, callIndicesForProtocolVersion(), classifyExtrinsic(), decodeCompactU32(), DecodedMidnightExtrinsic, decodeMidnightExtrinsic(), decodeProtocolVersionFromDigest() (+6 more)

### Community 136 - "UmbraDB 1.0.0 Release Contracts"
Cohesion: 0.22
Nodes (9): 1. Durability contract, 2. Forward-only / no-downgrade migration contract, 3. Cancellation semantics, 4. Save-retry caveat, 5. Lease limitation, 6. Backup/restore guidance, 7. Threat-model pointer, 8. Format headroom (reserved for 1.1) (+1 more)

### Community 137 - "sync-service.ts"
Cohesion: 0.08
Nodes (26): IndexerBlock, IndexerClientOptions, ReplayOutcome, NodeRpcClientOptions, SubstrateHeader, mapReplayOutcomes(), RegularReplayOutcome, ReplayOutcomeMapping (+18 more)

### Community 138 - "Design — v1.0.0-infosec-signoff"
Cohesion: 0.20
Nodes (9): 0. Scope boundary and what this change does NOT touch, 1. G15 — `SECURITY.md` / threat-model document, 2. G16 — CheckpointStore cross-wallet dedup interface-doc rewrite, 3. G17 — TLS caveat surfaced + VerifyFull/`--ca` de-stubbed, 4. G18 — Supply-chain CI gate, 5. G19 — Replace the committed Preview wallet secret, 6. Non-goals & boundaries respected (summary), Audit resolution (+1 more)

### Community 139 - "Roadmap"
Cohesion: 0.12
Nodes (16): 1.0.0 acceptance checklist, Beyond 1.0.0 — additional tracks in progress, Frozen 1.0.0 API surface, SemVer policy, error catalog & contracts (G1-G4 -- `openspec/changes/v1.0.0-api-surface`), Frozen 1.0.0 Lean cut-line (G20 — `openspec/changes/v1.0.0-api-surface`), Milestone 0 — Design (completed baseline), Milestone 1 — Formal (`Formal/`, in progress), Milestone 2 — Core implementation (module implementations complete), Milestone 3 — Testing (complete for 1.0.0) (+8 more)

### Community 140 - "Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)"
Cohesion: 0.22
Nodes (8): 1. Driver — why this is now mandatory, 2. What the Cardano side does (and does not) provide, 3. Feasibility — demonstrated, 4. Security postures, 5. Folding into `nix/midnight-env`, 6. Risks / open items, 7. Verdict, Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)

### Community 142 - "full-sync-soak.integration.test.ts"
Cohesion: 0.07
Nodes (17): JsonValue, KvRow, BatchSpec, CurrentState, { connectionUri }, CurrentState, DECLARED_ENVELOPE, GcPass (+9 more)

### Community 143 - "Acceptance — v1.0.0 API Surface & Release Contract"
Cohesion: 0.22
Nodes (8): Acceptance — v1.0.0 API Surface & Release Contract, G1 — Public API surface, G20 — Lean cut-line, G2 — SemVer stability policy + CHANGELOG, G3 — Frozen, cleaned error catalog, G4 — Contract doc set (all true), Negative / boundary criteria (nothing out-of-scope leaked in), Precondition (blocks the whole change)

### Community 145 - "differential-equivalence.test.ts"
Cohesion: 0.13
Nodes (25): adaptersFor(), adaptersOf(), applyBatchUnderFault(), buildSchedule(), completeManifestCount(), driveFullBatch(), Fault, injectT1() (+17 more)

### Community 146 - "UmbraDB v0.9.5 "Penumbra" — Release Record"
Cohesion: 0.11
Nodes (16): 1. The twenty gate items, 2. Tag preconditions R1–R12, 3. Rulings recorded for this release, 4. Deferred to 1.1 / post-1.0.0, 5. R5 — live Preprod evidence against the RC, 6. R6 — independent cold release audit, 7. R9 — Go / No-Go, Track A — Release contract (`openspec/changes/v1.0.0-api-surface`, merged `726f567`) (+8 more)

### Community 147 - "check-required-tests.ts"
Cohesion: 0.14
Nodes (20): cli(), DEFAULT_MANIFEST, extractIds(), fileMatches(), filesFromReport(), JsonReport, JsonReportAssertion, JsonReportFile (+12 more)

### Community 148 - "stryker.conf.json"
Cohesion: 0.11
Nodes (18): clear-text, html, json, cleanTempDir, _comment, concurrency, coverageAnalysis, reporters (+10 more)

### Community 149 - "chain-archive-sync-retry.integration.test.ts"
Cohesion: 0.08
Nodes (32): bootstrapChainArchiveSchema(), MAX_BLOCKS, REPLAY_CHECKPOINT_INTERVAL, service, sql, bareSystemExtrinsicHex(), compactU32Hex(), EVENT_TX_HASH (+24 more)

### Community 150 - "Acceptance criteria — v1.0.0-infosec-signoff"
Cohesion: 0.25
Nodes (7): Acceptance criteria — v1.0.0-infosec-signoff, Cross-cutting council-ruling gates (close-out — Task 5.1), G15 — Threat-model / `SECURITY.md`, G16 — CheckpointStore dedup interface-doc caveat, G17 — TLS caveat surfaced + VerifyFull de-stubbed, localhost default kept, G18 — Supply-chain CI gate, G19 — Committed-secret remediation

### Community 151 - "Tasks — v1.0.0-infosec-signoff"
Cohesion: 0.22
Nodes (8): 0. Threat-model documentation hub (G15), 1. CheckpointStore interface-doc rewrite (G16) — depends on 0.3, 2. TLS caveat + VerifyFull de-stub (G17) — independent, 3. Supply-chain CI gate (G18) — 3.5 depends on 4.1, 4. Committed-secret remediation (G19) — mutually dependent with 3.5, 4b. Release-publication artifact (R7) — found missing during the release run, 5. Change close-out, Tasks — v1.0.0-infosec-signoff

### Community 152 - "cold-boot-recovery.integration.test.ts"
Cohesion: 0.34
Nodes (10): phaseA_syncAndPersistEnvelope(), phaseB_freshProcessRestoreAndVerify(), deriveUnshieldedSeed(), buildUnshieldedConfig(), firstStateWhere(), isPlainObject(), mergeSections(), referenceMergeEntries() (+2 more)

### Community 153 - "UmbraDB V1.0.0 Implementation Guideline — the release constitution"
Cohesion: 0.12
Nodes (16): §0 — Purpose & authority, §1 — The high-assurance spec→code workflow, §2.0 — Orchestrator (the role that can break independence by mistake), §2.1 — Implementation agent, §2.2 — Audit agent(s), §2.3 — QA agent, §2.4 — Usability / DX agent, §2.5 — Security agent (+8 more)

### Community 154 - "Acceptance — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.29
Nodes (6): Acceptance — v1.0.0-durable-checkpoint-cursor, G5 — Co-transactional watermark + checkpoint data, G6 — Durability startup probe + binding contract, G7 — Server-side timeouts, G8 — Contract-integrity fixes, Whole-change gates (non-goal compliance + sequencing)

### Community 155 - "Tasks — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.29
Nodes (6): 0. G5 — Co-transactional watermark + checkpoint data (do first; pre-freeze, signature-changing), 1. G6 — Durability startup probe + binding contract, 2. G7 — Server-side timeouts, 3. G8 — Contract-integrity fixes, 4. Change close-out, Tasks — v1.0.0-durable-checkpoint-cursor

### Community 156 - "Proposal — v1.0.0-perf-baseline"
Cohesion: 0.29
Nodes (6): 1.0.0 gate items addressed, Impact, Non-goals (explicitly out of scope for this change), Proposal — v1.0.0-perf-baseline, What changes, Why

### Community 157 - "pg-tx-history-adapter.ts"
Cohesion: 0.16
Nodes (16): assertNoReservedAdapterKeys(), COMMON_FIELD_NAMES, DANGEROUS_EXTENSION_KEYS, describeStatusValue(), LifecycleDetailStore, LifecycleDetailStoreSchema, mapSdkStatusToUmbra(), mapUmbraStatusToSdk() (+8 more)

### Community 158 - "pg-kill-save.crash.test.ts"
Cohesion: 0.11
Nodes (18): assertSaveNotAutoRetriedUnderRetriableFault(), assertSaveNotInAnyAutoRetryAllowlist(), C5AnyFn, completeManifestCount(), completeManifestCountAtSeq(), danglingChunkCount(), IDEMPOTENCY_KEY_FEATURE, listSrcTsFiles() (+10 more)

### Community 159 - "postgres/checkpoint-store.ts"
Cohesion: 0.07
Nodes (31): assertValidCheckpointIds(), CheckpointIdSchema, HistoryOptionsSchema, SaveCheckpointOptionsSchema, TransactionLeaseLayer, withAbort(), AggregateRow, ChunkJoinRow (+23 more)

### Community 160 - "UmbraDB 0.9.5 "Penumbra""
Cohesion: 0.15
Nodes (12): Benchmarks, Compatibility, and what 1.0.0 needs, Durability, Errors, If you build from source, Installing, Security, The fix this release exists for (+4 more)

### Community 161 - "crash-worker.ts"
Cohesion: 0.10
Nodes (24): RFC-8259, WatermarkKey, WatermarkKind, saveAndAdvance(), resolveTransaction(), PgWatermarks, ALL_HOOKS, CoTxCallable (+16 more)

### Community 162 - "mutation-per-adapter.mjs"
Cohesion: 0.17
Nodes (11): gateAdapters(), tallyMutants(), adapters, conf, gate, JSON_REPORT, PER_ADAPTER_CONF, results (+3 more)

### Community 163 - "monitor-store-pg.ts"
Cohesion: 0.07
Nodes (46): IllegalLifecycleTransitionError, isScannable(), LIFECYCLE_EVENTS, LifecycleEvent, MONITOR_STATES, MonitorState, SCANNABLE_STATES, TABLE (+38 more)

### Community 164 - "Proposal — v1.0.0 API Surface & Release Contract"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope — honoring the council rulings verbatim), Proposal — v1.0.0 API Surface & Release Contract, What changes — the 1.0.0 gate items this change addresses, Why

### Community 165 - "Proposal — v1.0.0-durable-checkpoint-cursor"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this change), Proposal — v1.0.0-durable-checkpoint-cursor, What changes, Why

### Community 166 - "Proposal — v1.0.0-infosec-signoff"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope — per the council rulings), Proposal — v1.0.0-infosec-signoff, What changes (the 1.0.0 gate items addressed), Why

### Community 167 - "Tasks — v1.0.0-perf-baseline"
Cohesion: 0.29
Nodes (6): 1. G13 — perf-correctness fixes (LAND FIRST), 2. G14 — benchmark harness (may start in parallel; baseline recorded only after §1), 3. G14 — record the baseline + document ceilings, 4. Close-out, G14 build close-out (2026-07-23), Tasks — v1.0.0-perf-baseline

### Community 168 - "Proposal — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)"
Cohesion: 0.33
Nodes (5): Impact, Non-goals (explicitly out of scope for this change), Proposal — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`), What changes (the 1.0.0 gate items this change addresses), Why

### Community 169 - "UmbraDB V1.0.0 — Lessons-Learned Living Log"
Cohesion: 0.12
Nodes (16): A. Preventative actions to land or re-defer before iteration 2 begins, B. Named consumption targets (guideline §5.5) — record the actual edit made, C. Trend analysis (across events, not per-incident), Capture rules, D. Retro review sign-off, Entry template (copy per event), Event log (append-only; newest at bottom), Iteration-2 intake (+8 more)

### Community 170 - "no-chain-sync-import-guard.test.ts"
Cohesion: 0.31
Nodes (9): extractStringLiterals(), findChainSyncViolations(), GuardViolation, scanDirectory(), walkTsFiles(), findShieldedMonitorViolations(), GuardViolation, scanDirectory() (+1 more)

### Community 171 - "lease-nonwedge.crash.test.ts"
Cohesion: 0.18
Nodes (13): worker(), class2AdvisoryLockCountForHash(), liveWorkers, openPools, pollForLockGone(), pool(), sleep(), { sql: getSql, connectionUri } (+5 more)

### Community 172 - "scripts"
Cohesion: 0.08
Nodes (25): scripts, archive:read-api, archive:sync, bench, bench:smoke, build, build:cli, demo:shielded-monitor (+17 more)

### Community 173 - "pack-install.mjs"
Cohesion: 0.42
Nodes (8): dockerIndependentOracles(), fail(), main(), repoRoot, roundTripOracle(), run(), scratch, tscBin

### Community 174 - "Acceptance criteria — v1.0.0-perf-baseline"
Cohesion: 0.40
Nodes (4): Acceptance criteria — v1.0.0-perf-baseline, Boundary / non-goal assertions (must remain true), G13 — perf-correctness fixes (land first), G14 — benchmark harness + recorded baseline

### Community 175 - "Tasks — v1.0.0: Formal completion (`formal-completion`)"
Cohesion: 0.15
Nodes (12): 0. Scaffolding + Trust reach, 1. C2a — GC-safety (release-blocking; start now), 2. C2b — eventual collection (DEFERRED), 3. L1 — lease mutual exclusion (release-blocking; start now), 4. Multi-key TemporalKV lift — FRAMING ONLY (DEFERRED), 5. Ordered chunk reconstruction (DEFERRED), 6. C1 collision hygiene (release-blocking rider), 7. Transaction-envelope composition (DEFERRED) (+4 more)

### Community 176 - "MonitorRecord"
Cohesion: 0.12
Nodes (14): MonitorGap, MonitorLastError, MonitorRecord, runHarness(), MonitorRow, MonitorTx, parse(), PgShieldedMonitorStore (+6 more)

### Community 177 - "README.md"
Cohesion: 0.19
Nodes (7): Scope and pre-1.0 note, The three commitments, UmbraDB Stability Policy (SemVer), Generate your local wallet, Test wallets, Why this is not just a committed key anymore, OpenSpec Change

### Community 178 - "midnight-wallet-sdk-loader.ts"
Cohesion: 0.36
Nodes (8): facadeDistIndexPath(), facadeMergeAvailable(), loadFacadeMerge(), unshieldedWalletDistIndexPath(), ledgerV8NodeEntry(), loadMidnightWalletSdk(), midnightWalletRepoRoot(), packageDistFile()

### Community 180 - "client.ts"
Cohesion: 0.07
Nodes (30): assertNoConflictingSearchPath(), assertValidSchemaName(), createClient(), createHeightPartitions(), up(), up(), up(), up() (+22 more)

### Community 181 - "conformance-gate.mjs"
Cohesion: 0.22
Nodes (8): check, checker, env, forwarded, maxWorkers, repoRoot, reportPath, vitest

### Community 182 - "withSuiteWatchdog"
Cohesion: 0.13
Nodes (19): completeManifestCount(), completeManifestCountAtSeq(), danglingChunkCount(), junctionRowCount(), liveWorkers, manifestRowCountAtSeq(), openPools, orphanJunctionCount() (+11 more)

### Community 183 - "compilerOptions"
Cohesion: 0.09
Nodes (22): compilerOptions, declaration, declarationMap, noEmit, outDir, rootDir, sourceMap, exclude (+14 more)

### Community 184 - "UmbraDB Frozen Error-Code Catalog"
Cohesion: 0.29
Nodes (7): `CLOCK_REGRESSION` is conditional, not uniformly non-retryable, Excluded: the deferred chain-archive codes, Reconciliation rationale (why 24, not the design's earlier 21), The catalog, The count is enforced, not asserted, The retryable set, UmbraDB Frozen Error-Code Catalog

### Community 185 - "ASSESSMENT — `midnight-node-archive` Peer Flapping (Midnight Preprod, WSL2 Docker Host)"
Cohesion: 0.29
Nodes (6): 1. Executive verdict, 2. Ranked root causes, evidence, and council challenges resolved, 3. THE recommended action, 4. Decisive validation experiment, 5. Residual risk and confidence, ASSESSMENT — `midnight-node-archive` Peer Flapping (Midnight Preprod, WSL2 Docker Host)

### Community 186 - "package.json"
Cohesion: 0.12
Nodes (16): bugs, url, description, engines, node, exports, homepage, license (+8 more)

### Community 187 - "mutation-evidence.d.mts"
Cohesion: 0.29
Nodes (6): AdapterResult, GateResult, MutantTally, StrykerFile, StrykerMutant, StrykerReport

### Community 188 - "Research Assessment: Single-Statement Unbounded `bytea` Inserts via postgres.js"
Cohesion: 0.33
Nodes (5): 1. Is there a known resolution — bounded-constant statement count, unbounded rows, no bind-param cap, no V8 string limit?, 2. Best candidate — COPY-BINARY into temp + INSERT-SELECT-ON-CONFLICT, 3. Recommendation for UmbraDB, 4. Migration/rollout note (if/when adopted), Research Assessment: Single-Statement Unbounded `bytea` Inserts via postgres.js

### Community 189 - "[0.9.5] - 2026-07-25 — "Penumbra""
Cohesion: 0.20
Nodes (10): [0.9.5] - 2026-07-25 — "Penumbra", [1.0.0] - unreleased — "Totality", Added, Added, Changed, Changelog, Contract documents, Deferred to a 1.1 fast-follow (explicitly outside the frozen 1.0 surface) (+2 more)

### Community 194 - "ADDED Requirements"
Cohesion: 0.04
Nodes (47): ADDED Requirements, chain-archive-read-contract (implementation), Requirement: a block carries its own timestamp, Requirement: a discontinuity in canonical history is refused, never smoothed over, Requirement: a page and the tip it is compared against are one observation, Requirement: everything the archive writes for one block height commits together, Requirement: history is paged as whole blocks, in commit order, from a remembered height, Requirement: offers are extracted only under a ledger build that can read them (+39 more)

### Community 195 - "dependencies"
Cohesion: 0.22
Nodes (9): @midnight-ntwrk/ledger-v8, dependencies, @midnight-ntwrk/ledger-v8, @polkadot/types, postgres, zod, @polkadot/types, postgres (+1 more)

### Community 196 - "storage-errors.ts"
Cohesion: 0.06
Nodes (17): ValidationError, WatermarkValueSchema, WatermarkRow, Method, METHODS, OVERLONG_ID, { sql: getSql }, { sql: getSql, connectionUri } (+9 more)

### Community 197 - "Gate notes — Task 6: differential state-equivalence gate (G11)"
Cohesion: 0.50
Nodes (3): 6.1 — P3 is the differential gate's replay-equivalence / fold anchor (documentation, no new test code), 6.2 — fault-schedule differential (`test/postgres/differential-equivalence.test.ts`), Gate notes — Task 6: differential state-equivalence gate (G11)

### Community 198 - "Tasks — Sprint 9: Indexer Independence"
Cohesion: 0.11
Nodes (18): 0. Specification freeze, 10.13 Targeted re-audit findings T1–T8 (plan §16) — the open merge-gating work, 10. Audit round 3 remediation (plan §15) — gates PR #1, 11. Formal T1–T8 audit outcome (plan §17) — gates PR #1, 12. Round-5 re-audit outcome (plan §18), 13. O1–O5 — the last merge gate before final PASS×3, 1. Ground-truth capture — TIME-CRITICAL, do first, 2. System-transaction exclusion (owner decision — no investigation needed) (+10 more)

### Community 199 - "migrate.ts"
Cohesion: 0.06
Nodes (30): assertNoTransactionPooler(), classifyFsync(), classifyFullPageWrites(), classifySynchronousCommit(), DurabilityProbeOptions, DurabilityViolation, DurabilityWarning, probeAdvisoryLockVisibility() (+22 more)

### Community 200 - "Checkpoint-store composition contract — cursor ordering and replay"
Cohesion: 0.25
Nodes (7): 1. The invariant: the cursor is never ahead of its data, 2.1 Atomic co-commit (preferred): `saveAndAdvance` or one shared `tx`, 2.2 Manual composition: advance the cursor **strictly after** the data commits, 2. The two conforming compositions, 3. Replay convergence is judged on CURRENT state, 4. Cross-reference, Checkpoint-store composition contract — cursor ordering and replay

### Community 201 - "Design — v1.1.0: Quint model checking"
Cohesion: 0.17
Nodes (11): 1. Module layout, 2. Backend routing (the one non-obvious constraint), 3. C2a model sketch, 4. C2b model sketch, 5. L1 model sketch, 6. Falsifiability controls, 6b. Witnesses — proving the interesting state is reachable, 7. Bounds (+3 more)

### Community 202 - "Roadmap — `v1.1.0-formal-completion`: storage-algebra Lean mechanization vs 1.0.0 (v2, audit-reframed)"
Cohesion: 0.18
Nodes (10): 0. What v1 got wrong (audit corrections folded in), 1. Decision the user/council must make (forced, per audit), 2. Normative release-law manifest (single source of truth), 3. Corrected Lean gates (the ones that change), 4. Anti-vacuity acceptance criteria (corrected — was the hole), 5. Refinement strategy — three honest statuses (was overstated), 6. CI / faithfulness enforcement (corrected — Trust ≠ law-presence), 7. Effort & sequencing (consistent DAG) (+2 more)

### Community 203 - "Why "the node accepted it" is not the same as "it is a transaction""
Cohesion: 0.20
Nodes (9): Case 1 — Forgery, Case 2 — Ingest stall, The fix, The mechanism, Verifying it yourself, What it actually costs, What this does not fix, Who can actually produce such a call — and the correction (+1 more)

### Community 204 - "Spec — `model-checking` capability"
Cohesion: 0.20
Nodes (9): 1. Scope and honesty, 2. Faithfulness to the algebra, 3. C2a — GC reachability safety, 4. C2b — eventual collection (liveness), 5. L1 — lease mutual exclusion, 6. T1 cross-writer, 7. CI integration, 8. Documentation (+1 more)

### Community 205 - "harness.ts"
Cohesion: 0.10
Nodes (43): BenchEnv, PG_SETTINGS, startBenchEnv(), fmtRatio(), main(), parseNums(), printSummary(), BaselineLoad (+35 more)

### Community 206 - "Tasks — v1.1.0: Quint model checking"
Cohesion: 0.20
Nodes (9): 0. Toolchain and scaffolding, 1. C2a — GC reachability safety, 2. C2b — eventual collection, 3. L1 — lease mutual exclusion, 4. T1 — cross-writer, 5. CI, 6. Documentation and close-out, 7. Model-based conformance (the refinement bridge) (+1 more)

### Community 207 - "files"
Cohesion: 0.25
Nodes (8): files, dist, dist-cli, CHANGELOG.md, LICENSE, NOTICE, README.md, vendor

### Community 208 - "Security policy & threat model"
Cohesion: 0.18
Nodes (11): Commit policy — what may and may not go into git, Data at rest — NO encryption is provided (a binding deployer precondition), Reporting a vulnerability, `schema` is namespacing, NOT a security or tenant boundary, Scope — documented preconditions vs. implemented controls (1.0.0), Security policy & threat model, Shielded monitors (`shielded_monitor` schema) — alpha trust model, T-A1 — Single trusted writer, one trust domain (+3 more)

### Community 215 - "Design — Sprint 9: Indexer Independence"
Cohesion: 0.22
Nodes (8): 0. Reconciliation with the existing Tier-1 / Tier-2 split, 6.1 The exclusion must be symmetric, and byte-derived, 6.2 Consequence the feed contract must carry, 6. System transactions: SUPERSEDED — they are archived, 6a. System transactions: what is actually recoverable, measured, 7. Run A / Run B, 8. Open questions, Design — Sprint 9: Indexer Independence

### Community 216 - "Scope split: Part A / Part B — plan update and commit changes"
Cohesion: 0.22
Nodes (8): Branch contents after the split, Corrected: "submitted versus executed" is not a Part A blocker, One commit message was corrected, not just moved, Scope split: Part A / Part B — plan update and commit changes, Since resolved: system transactions are in scope and archived, The boundary, Verification after the rewrite, What moved, and why

### Community 217 - "Proposal — v1.1.0: Quint model checking (`quint-model-checking`)"
Cohesion: 0.22
Nodes (8): Binding constraints, Dependencies, Proposal — v1.1.0: Quint model checking (`quint-model-checking`), Tooling, What changes, What this does NOT claim, Why Quint specifically, Why: three laws are unproved, and it is not a coincidence which three

### Community 218 - "Roadmap for the missing formalization"
Cohesion: 0.25
Nodes (7): Phase F1 — Close the absent *abstract* laws (tractable now; highest value), Phase F2 — Cross-module composition laws, Phase F3 — The refinement gap (strategic; the big decision), Priority call, Roadmap for the missing formalization, UmbraDB storage-algebra — formalization gap map & roadmap, What we have vs. the spec

### Community 219 - "Proposal — Sprint 9: Indexer Independence (differential-parity harness + first migrated primitive)"
Cohesion: 0.25
Nodes (7): Non-goals, Proposal — Sprint 9: Indexer Independence (differential-parity harness + first migrated primitive), Relationship to existing work, Staging for the remaining five (context only — not specified here), The circularity threat, stated up front, What this sprint delivers, Why this sprint exists

### Community 220 - "ROADMAP.md"
Cohesion: 0.15
Nodes (9): Captured transcript, Chain / wallet state at run time, Cold-boot round-trip, G12 / R5 — manual pre-tag Preprod round-trip evidence, Pass/fail per M5 sub-criterion, Run identity, Verdict, Custom Node/TypeScript Benchmark Harness (+1 more)

### Community 221 - "Acceptance — v1.0.0: Formal completion (`formal-completion`)"
Cohesion: 0.29
Nodes (6): Acceptance — v1.0.0: Formal completion (`formal-completion`), Change-level exit (Option B) / checklist-close (Option A), Definition-of-done for a gate to CLOSE, Non-goals, Normative release-law manifest (single source of truth), The forced decision (must be recorded before this change closes)

### Community 222 - "Design — v1.0.0: Formal completion (`formal-completion`)"
Cohesion: 0.29
Nodes (6): §1 C2a — GC reachability-safety (`Checkpoint/GC.lean`), §2 L1 — lease mutual exclusion (`Transaction/Lease.lean`), §3 Supporting gates, §4 Refinement register & three statuses, §5 CI faithfulness manifest, Design — v1.0.0: Formal completion (`formal-completion`)

### Community 223 - "Proposal — v1.0.0: Formal completion (`formal-completion`)"
Cohesion: 0.29
Nodes (6): Binding constraints, Dependencies & critical path, Governance framing (read first), Proposal — v1.0.0: Formal completion (`formal-completion`), What changes, Why

### Community 224 - "Acceptance — v1.1.0: Quint model checking"
Cohesion: 0.33
Nodes (5): Acceptance — v1.1.0: Quint model checking, Definition of done, Explicit non-goals, Status manifest — what this change may and may not claim, The honesty bar

### Community 225 - "Audit record — `v1.1.0-formal-completion` roadmap (v1 → v2)"
Cohesion: 0.40
Nodes (4): Affirmed (audit found sound), Audit record — `v1.1.0-formal-completion` roadmap (v1 → v2), Convergent findings (≥2 lanes) and v2 resolution, Verdicts

### Community 226 - "Spec — capability `formal-completion`"
Cohesion: 0.50
Nodes (3): Governed by, Requirements (EARS), Spec — capability `formal-completion`

### Community 227 - "Captured runtime metadata"
Cohesion: 0.50
Nodes (3): Captured runtime metadata, How it was captured, What this fixture does and does not cover

### Community 228 - "Requirements"
Cohesion: 0.04
Nodes (45): Purpose, Requirement: A block height's associations and its coverage advance commit together, fenced by the epoch, Requirement: A restore keeps revoked monitors refused, Requirement: Associations carry full provenance and never assert an applied outcome, Requirement: At-rest protection of key material is deferred, Requirement: Coverage is expressed in block heights and never presents unscanned history as empty, Requirement: Key material redacts itself and is never logged, Requirement: Monitor state follows an explicit, total transition table with a monotone epoch (+37 more)

### Community 230 - "chain-archive-replay-validation.integration.test.ts"
Cohesion: 0.13
Nodes (18): bareRegularExtrinsicHex(), bareSystemExtrinsicHex(), chainNodeFetch(), compactU32Hex(), fakeNodeFetch(), FIXTURE, GENESIS_SYSTEM_EXTRINSICS, LedgerRoots (+10 more)

### Community 231 - "5. Blocking correctness gaps"
Cohesion: 0.22
Nodes (9): 5.1 Raw event-tag counting has a false-negative combination, 5.2 Signed/general detection is incomplete and heuristic, 5.3 Runtime metadata and supported versions, 5.4 The successful ledger dependency is not deliverable yet, 5.5 Existing incomplete archives and source switching, 5.6 The current tests are evidence, not release gates, 5.7 Specifications and release records are not yet closed out, 5.7a Ledger patch: published to a fork, not yet upstream (+1 more)

### Community 232 - "shielded-monitor-batch-atomicity.crash.test.ts"
Cohesion: 0.06
Nodes (26): ArchiveDiscontinuityError, ArchiveTip, assertPagingArguments(), bufToHex(), PageBlockRow, PageTxRow, PgArchiveReadContract, sha256Hex() (+18 more)

### Community 233 - "sync.ts"
Cohesion: 0.12
Nodes (38): bytesFromHex(), chunk(), dateFromSeconds(), gapRanges(), generationFromWire(), qdoFromWire(), Range, rangesParam() (+30 more)

### Community 234 - "Re-audit brief — audit round 2 remediation"
Cohesion: 0.22
Nodes (8): A1 — kind from the payload; event hashes never trusted, A2 — replay gates ingest, A3 — metadata resolution failure semantics, A4 — restart and retry consistency, A5 — release readiness, Re-audit brief — audit round 2 remediation, Things a re-audit should press on, Validation on this head

### Community 235 - "13. Stage 2b — metadata availability (owner-approved, 2026-08-10)"
Cohesion: 0.33
Nodes (6): 13.1 The `runtime_metadata` table — each archive carries its own captures, 13.2 The committed capture registry — the indexer's `.node/` directory, ported, 13.3 Resolution order in `BlockScopedMetadata`, 13.4 Sequencing and what it does NOT change, 13.5 Correction after implementing (2026-08-11): pruned-node INGEST is not solvable, 13. Stage 2b — metadata availability (owner-approved, 2026-08-10)

### Community 236 - "8a. Dissent: concerns with revision 7, from the implementing author"
Cohesion: 0.33
Nodes (6): 8a.1 One §7 row silently requires a ledger replay engine, 8a.2 Several merge-blocking rows have no stated fallback if the population cannot be found, 8a.3 There is no position on the indexer disappearing first, 8a.4 The plan should separate "safe to merge" from "safe to cut over", 8a.5 One fix is available now and is being deferred, 8a. Dissent: concerns with revision 7, from the implementing author

### Community 237 - "api/server.ts"
Cohesion: 0.07
Nodes (31): CursorError, CursorRejection, decodeCursor(), encodeCursor(), ApiErrorCode, bigintSafe(), CreateMonitorBodySchema, HttpError (+23 more)

### Community 238 - "12. Blockers and unknowns"
Cohesion: 0.33
Nodes (6): 12.1 Blockers, 12.2 Unknowns, 12.3 Stage 2 reconnaissance — measured, not yet implemented, 12.4 Stage 2 mid-stage review (2026-08-10) — built, missing, and two library hazards, 12.5 Status snapshot after Stage 3 (2026-08-11) — answered, and still open, 12. Blockers and unknowns

### Community 239 - "4. What is genuinely demonstrated"
Cohesion: 0.40
Nodes (5): 4.1 Extrinsic-borne genesis transactions, 4.2 System transaction hash export, 4.3 Other resolved implementation findings, 4.4 D-parameter decoding, 4. What is genuinely demonstrated

### Community 240 - "10. Parallel track — upstream the ledger WASM export (not a goal of this plan)"
Cohesion: 0.50
Nodes (4): 10.1 State, 10.2 Remaining steps, in order, 10.3 Findings log, 10. Parallel track — upstream the ledger WASM export (not a goal of this plan)

### Community 241 - "11. Staged execution plan (owner, 2026-08-08)"
Cohesion: 0.67
Nodes (3): 11.1 Execution prerequisites (what an agent needs; nothing else), 11.2 The owner's complete action list, 11. Staged execution plan (owner, 2026-08-08)

### Community 242 - "1. Goal and scope"
Cohesion: 0.67
Nodes (3): 1. Goal and scope, In scope — the minimum source substitution, Out of scope

### Community 243 - "Re-audit brief — audit round 3"
Cohesion: 0.22
Nodes (8): Fixed in `1d4bb36`, Other fixed findings, Re-audit brief — audit round 3, Replay was not reference-equivalent, Still open at the round-3 head — historical, not current status, Validation on this head, What this re-audit is asked to check, Why round 2's remediation failed, in one paragraph

### Community 244 - "Requirements"
Cohesion: 0.05
Nodes (40): Purpose, Requirement: A batch is whole block heights, committed with its coverage advance in one transaction, Requirement: A crash during a batch leaves either none of a height or all of it, Requirement: An unreadable transaction stops the monitor at its position and claims no coverage, Requirement: Every association carries provenance and an unknown applied outcome, Requirement: Every worker write is fenced by the monitor's lifecycle epoch, Requirement: Key material lives for exactly one batch, Requirement: Relevance is the ledger's own trial decryption over the guaranteed offer and every fallible segment (+32 more)

### Community 246 - "Requirements"
Cohesion: 0.05
Nodes (38): Purpose, Requirement: A reference consumer completes the whole flow over HTTP alone, Requirement: Every status and matches response carries coverage as block heights, Requirement: Matches are paged by an opaque cursor bound to its monitor, Requirement: No viewing key appears in a log record or an error body, Requirement: The alpha API has no authentication and binds to loopback, Requirement: The API and the client are entry points of the same package, Requirement: The API caps request body size and page size (+30 more)

### Community 247 - "Requirements"
Cohesion: 0.05
Nodes (37): Purpose, Requirement: A match records the time of its block, Requirement: A match records the transaction's public zswap data, Requirement: Attribution states only what the ledger entails, Requirement: Details and coverage commit together, Requirement: Existing matches can be filled in without re-scanning, Requirement: The API exposes the details and the block time, Requirement: The dashboard shows a match's contents on demand (+29 more)

### Community 249 - "derive-key-cli.ts"
Cohesion: 0.11
Nodes (28): DerivedKey, deriveViewingKey(), fromSeed(), LedgerKeysApi, parseArgs(), Parsed, readIndex(), readSeed() (+20 more)

### Community 250 - "ledger-replay.ts"
Cohesion: 0.15
Nodes (9): AccumulatedCost, addCost(), BlockFullness, COST_DIMENSIONS, CostDimension, LedgerReplay, LedgerReplayOptions, ReplayBlockInput (+1 more)

### Community 251 - "ShieldedMonitorStore"
Cohesion: 0.07
Nodes (13): applyDeletionList(), DeletionApplyReport, DeletionListFile, exportDeletionList(), DeletionRecord, ShieldedMonitorStore, AssociationFileEntry, jsonSafe() (+5 more)

### Community 252 - "copy-cli-assets.mjs"
Cohesion: 0.50
Nodes (3): from, repoRoot, to

### Community 253 - "shielded-monitor/errors.ts"
Cohesion: 0.09
Nodes (23): ArchiveReadApiLogger, ArchiveRouterOptions, FenceRejection, MonitorFencedError, MonitorNotFoundError, ShieldedMonitorErrorCode, ViewingKeyRejection, StorageApiConfig (+15 more)

### Community 254 - "15. Audit round 3 — register (2026-08-13)"
Cohesion: 0.67
Nodes (3): 15. Audit round 3 — register (2026-08-13), Fixed in `1d4bb36`, Open

### Community 255 - "golden.mjs"
Cohesion: 0.07
Nodes (28): atEvent, balanceAt, clientOut, clientReport, log(), name, out, repeat (+20 more)

### Community 258 - "scanner.test.ts"
Cohesion: 0.11
Nodes (11): ScannerStore, ShieldedMonitorScanner, AdvanceResult, AssociationInput, ArchivedBlock, drain(), Advance, block() (+3 more)

### Community 259 - "ArchiveReadContract"
Cohesion: 0.10
Nodes (14): FetchLike, ArchiveSource, OpenArchiveSourceOptions, HttpMonitorStoreOptions, ArchiveWakeSource, SseWakeOptions, ArchiveBlockPage, ArchiveIdentity (+6 more)

### Community 260 - "archive-height-atomicity.crash.test.ts"
Cohesion: 0.12
Nodes (22): blockHashFor(), buildHeightBundle(), GENESIS_PARENT_HASH, HeightBundleSpec, hex32(), main(), pauseUntilKilled(), requireEnv() (+14 more)

### Community 261 - "Requirement: The service lists every monitor it holds"
Cohesion: 0.07
Nodes (26): Purpose, Requirement: A viewing key can be derived from a seed by a shipped command, Requirement: The dashboard handles the viewing key exactly as the API does, Requirement: The demonstration is runnable from a document, Requirement: The service lists every monitor it holds, Requirement: The service serves a self-contained dashboard, Requirements, Scenario: A deleted monitor is not listed (+18 more)

### Community 262 - "fake-node.ts"
Cohesion: 0.14
Nodes (12): FakeChain, FakeNodeCalls, FakeNodeOptions, FakeQdo, FakeWallet, InitialRow, loadLedger(), makeWallet() (+4 more)

### Community 264 - "api/config.ts"
Cohesion: 0.15
Nodes (17): ApiConfig, ApiConfigError, loadApiConfig(), normalize(), readInt(), readStorageAccess(), assertNoDatabaseEnvironment(), DatabaseEnvironmentError (+9 more)

### Community 266 - "archive-read-wire.ts"
Cohesion: 0.12
Nodes (23): ArchiveReadApiError, ArchiveWireError, Base64Schema, base64ToBytes(), bytesToBase64(), decode(), decodeBlockPage(), decodeIdentity() (+15 more)

### Community 267 - "dust/index.ts"
Cohesion: 0.12
Nodes (18): DustConfig, DustConfigError, loadDustConfig(), readInt(), openDustDb(), createDustModule(), CreateDustModuleOptions, DustMirrorApplied (+10 more)

### Community 268 - "ledger.ts"
Cohesion: 0.09
Nodes (7): CollapsedUpdateLike, DustLocalStateLike, LEDGER_SURFACE, WASM_BINDGEN_UNIVERSALS, DustSdkWrapper, DustSdkWrapperOptions, published

### Community 270 - "Design — 00009-02: shielded monitor store, key intake and lifecycle"
Cohesion: 0.08
Nodes (23): 10. Restore, and why the revocation list lives outside the database, 11. Testing strategy, 12. Deferred, and where the seams are, 1. Tier placement: a third lineage, not a third home for wallet data, 2. Where the module lives: outside `src/`, like `chain-archive-sync/`, 3. Error idiom and validation, 4.1 Bech32m is implemented here, not imported, 4.2 HRP rule (+15 more)

### Community 271 - "dust-routes.test.ts"
Cohesion: 0.12
Nodes (16): ApiLogRecord, DustNodeFixtureMeta, FIXTURE_URL, META_URL, readDustNodeFixtureBlob(), readDustNodeFixtureEvents(), readDustNodeFixtureMeta(), meta (+8 more)

### Community 272 - "The shielded-monitor private API"
Cohesion: 0.09
Nodes (23): `DELETE /v1/monitors/:id`, Deriving a key to register, `?details=0`, DUST error codes, DUST wallet sync — `/v1/dust/*` (project 00016, optional), Endpoints, Error bodies, `GET /ui` — the dashboard (+15 more)

### Community 273 - "split-topology.integration.test.ts"
Cohesion: 0.13
Nodes (10): Balancer, BALANCER_ENV_DOC, loadBalancerConfig(), readInt(), runBalancer(), createBalancer(), FakeUpstream, startUpstream() (+2 more)

### Community 274 - "archive-read-api.integration.test.ts"
Cohesion: 0.14
Nodes (11): ARCHIVE_READ_ENV_DOC, ArchiveReadApiConfigError, loadArchiveReadApiConfig(), readInt(), ArchiveProgressEvent, ArchiveProgressSubscription, parseProgressPayload(), pgArchiveProgressEvents() (+3 more)

### Community 276 - "routes.ts"
Cohesion: 0.20
Nodes (15): assertRangesWithin(), decimalOf(), dustErrorBody(), DustErrorCode, DustHttpError, DustLookupRequest, DustRange, hexOf() (+7 more)

### Community 277 - "devnet.mjs"
Cohesion: 0.22
Nodes (19): alive(), argv, availableMb(), compose(), COMPOSE_FILES, down(), freePort(), json() (+11 more)

### Community 278 - "client/cli.ts"
Cohesion: 0.14
Nodes (17): ApiRefusal, Args, Coverage, MatchItem, MatchPage, MonitorView, parseArgs(), readCursorFile() (+9 more)

### Community 279 - "dust-sync-client/cli.ts"
Cohesion: 0.19
Nodes (15): Args, main(), parseArgs(), report(), utxoView(), DustSecretKeyFactory, dustSecretKeyFromSeed(), fromSeed() (+7 more)

### Community 281 - "handoff-ids.mjs"
Cohesion: 0.11
Nodes (15): atBlockEnds, extra, heights, indexer, indexerByHash, offsets, ourHashes, ours (+7 more)

### Community 282 - "bech32m.ts"
Cohesion: 0.19
Nodes (14): Bech32mDecoded, Bech32mDecodeFailure, Bech32mError, Bech32mWords, CHARSET_REV, convertBits(), decodeBech32m(), decodeBech32mWords() (+6 more)

### Community 284 - "wake.ts"
Cohesion: 0.18
Nodes (9): normalizeArchiveBaseUrl(), ArchiveWakeSubscription, handleFrame(), NO_WAKE, readEventStream(), sseWake(), decodeProgressEvent(), ListenCapable (+1 more)

### Community 285 - "InMemoryScannerMetrics"
Cohesion: 0.17
Nodes (6): InMemoryScannerMetrics, ZERO_BATCHES(), corpusKeyHandle(), corpusKeyHandles(), destroyWorld(), scannerFor()

### Community 286 - "import-boundary.test.ts"
Cohesion: 0.16
Nodes (13): BANNED_FILES, BANNED_PACKAGES, BANNED_PREFIXES, bannedReason(), isWaived(), PERMITTED_DUST_IMPORTERS, productionFiles, ReachResult (+5 more)

### Community 287 - "balancer-routing.test.ts"
Cohesion: 0.15
Nodes (8): BalancerOptions, NodeAnswer, Upstream, fingerprintHexToBase64Url(), FingerprintLocks, FakeNode, monitorIdFor(), startFakeNode()

### Community 288 - "Demo runbook — watch the shielded monitor work"
Cohesion: 0.13
Nodes (15): 0. Pick a project name and a port block, 1. Bring the devnet up, 2. Ingest, node-only, 3. Derive a viewing key, 4. Start the storage API, then the monitor-node, 5. Open the dashboard, 6. Drive the lifecycle, 7. Optional: a real shielded transaction (needs a wallet, out of tree) (+7 more)

### Community 290 - "demo-shielded-monitor.mjs"
Cohesion: 0.27
Nodes (14): compose(), COMPOSE_FILES, composeEnv(), down(), json(), log(), main(), randomPort() (+6 more)

### Community 291 - "createShieldedMonitorApi"
Cohesion: 0.27
Nodes (10): ApiLogger, createShieldedMonitorApi(), stderrLogger(), archiveSourceTip(), staticSourceTip(), unknownSourceTip(), openArchiveSource(), runMonitorNode() (+2 more)

### Community 293 - "archive-read-api/server.ts"
Cohesion: 0.18
Nodes (7): ArchiveReadApiConfig, ArchiveProgressEvents, ArchiveReadApiLogRecord, ArchiveReadApiOptions, ArchiveRouter, HttpError, ArchiveReadApiErrorCode

### Community 294 - "dust-events.test.ts"
Cohesion: 0.22
Nodes (12): DUST_EVENT_KIND_BY_TAG, LedgerEventRef, BLOCK, GENESIS_SYSTEM_TXS, GENESIS_TX_HASHES, DustFixtureMeta, FIXTURE_URL, META_URL (+4 more)

### Community 295 - "src/errors.ts"
Cohesion: 0.22
Nodes (6): asNonLinear(), DustSyncError, DustSyncErrorCode, delay(), DustHttpClient, DustHttpOptions

### Community 297 - "Design — 00009-01: archive read contract, block timestamp, per-height atomic commit"
Cohesion: 0.14
Nodes (13): Decision 10 — `NOTIFY` is an optimisation with no contract, Decision 1 — a separate read interface, not more methods on `ChainArchiveStore`, Decision 2 — the page unit is a whole block height, and only ever that, Decision 3 — one snapshot per page, and it includes `sourceTip`, Decision 4 — a discontinuity is refused, not returned, Decision 5 — the identity is "all of it or none of it", Decision 6 — the Rule A fold, and why the FK no longer forces a second transaction, Decision 7 — `blocks.timestamp_ms` is nullable, and `NULL` means "not decoded" (+5 more)

### Community 298 - "Design — 00009-03: the shielded viewing-key relevance scanner"
Cohesion: 0.14
Nodes (13): 10. Error idiom, 11. Fixture fidelity: what the corpus proves, and what it does not, 12. Throughput, honestly scoped, 1. Where the scanner sits, and what it is allowed to touch, 2. The batch, and why it is shaped exactly like the archive's height transaction, 3. The fence, and every place a worker write can be refused, 4. Archive identity: read every batch, bind first-write-wins, 5. The predicate: what is examined, and the false negatives we accept and name (+5 more)

### Community 299 - "server.test.ts"
Cohesion: 0.23
Nodes (8): createArchiveReadApi(), createArchiveRouter(), silentLogger(), ArchiveHttpError, ArchiveUnreachableError, createStorageApi(), serve(), started

### Community 300 - "Tasks — 00009-02: shielded monitor store, key intake and lifecycle"
Cohesion: 0.15
Nodes (12): 10. Guards, typechecking and the gate, 11. Close-out, 1. Migration lineage `shielded_monitor`, 2. Bech32m codec, 3. Fingerprint, 4. Key intake, 5. Lifecycle state machine, 6. Store (+4 more)

### Community 301 - "Tasks — 00009-03: the shielded viewing-key relevance scanner"
Cohesion: 0.15
Nodes (12): 10. SC-006 first measurement, 11. Close-out, 1. The relevance predicate, 2. The batch: one page of whole blocks, one commit, 3. Archive identity binding and the stale-source stop, 4. Fail-closed on an unreadable transaction, 5. Owner Rule B: crash safety and the write-set audit, 6. Fencing and lifecycle interaction (+4 more)

### Community 302 - "Design — 00009-04: the private shielded-monitor HTTP API and its reference consumer"
Cohesion: 0.15
Nodes (12): 10. What the API does *not* do to the database, 11. Bin entries and the published surface, 1. No HTTP framework: Node's built-in `http`, and why that is not asceticism, 2. Where the code lives, and what it may import, 3. The cursor: an opaque encoding of `(monitorId, seq)`, 4. Admission control: exactly two caps, and both fail with 400, 5. Coverage on the wire, and the `sourceTip` seam, 6. Error mapping: one idiom in, HTTP statuses out (+4 more)

### Community 303 - "api-ui.test.ts"
Cohesion: 0.18
Nodes (7): ShieldedMonitorApi, silentLogger(), DASHBOARD_CSP, loadScript(), makeNode(), StubNode, RunningNode

### Community 305 - "backfill-block-timestamps.ts"
Cohesion: 0.21
Nodes (9): ArchivedCaptureRow, backfillBlockTimestamps(), BackfillBlockTimestampsOptions, BackfillBlockTimestampsResult, decodeArchivedExtrinsics(), decodeArchivedHeaderDigestLogs(), PendingBlockRow, MAX_BLOCKS (+1 more)

### Community 306 - "dust-events.ts"
Cohesion: 0.39
Nodes (11): decimal(), DustEventBlockContext, generationIndexFromInsertionPath(), generationPayload(), hex(), index(), mapDustEvents(), optionalUnixSeconds() (+3 more)

### Community 307 - "dust-capture-overhead.ts"
Cohesion: 0.18
Nodes (10): DUST_EVENT_TAGS, BLOCK, FIXTURE, ITERATIONS, main(), stats(), SYSTEM_TXS, genesisCapture() (+2 more)

### Community 308 - "Running the shielded-monitor node"
Cohesion: 0.17
Nodes (12): Configuration, Gaps, and what clears them, How one block behaves (the live pass), If the mirror stops advancing, Match details, Monitor states you may see, Reading `/internal/status`, Running the shielded-monitor node (+4 more)

### Community 309 - "self-transfers.ts"
Cohesion: 0.24
Nodes (10): AMOUNT, availableNonces(), COUNT, DUST_WAIT_TIMEOUT_MS, dustNow(), log(), main(), SEED (+2 more)

### Community 311 - "archive-http-client.ts"
Cohesion: 0.26
Nodes (6): HttpArchiveReadContract, HttpArchiveReadContractOptions, safeJson(), StorageClients, ARCHIVE_READ_ROUTES, ArchiveReadApiErrorSchema

### Community 312 - "routing.ts"
Cohesion: 0.30
Nodes (8): RoutingKey, routingKeyFor(), RoutingKeyRejection, assertNetworkId(), hrpForNetwork(), monitorFingerprint(), fingerprintHexOf(), REFERENCE_KEY_BYTES

### Community 313 - "Deploying the shielded monitor: one database, one storage process, N monitor-nodes"
Cohesion: 0.18
Nodes (11): Deploying the shielded monitor: one database, one storage process, N monitor-nodes, DUST wallet sync (optional; project 00016), Environment matrix, Migrating from the 00009-08 deployment (BREAKING), Running it, Scaling, The shape, `umbradb-shielded-monitor-balancer` (+3 more)

### Community 314 - "compare.mjs"
Cohesion: 0.18
Nodes (7): client, clientUtxos, FIELDS, golden, goldenUtxos, rows, widths

### Community 315 - "Tasks — 00009-01: archive read contract, block timestamp, per-height atomic commit"
Cohesion: 0.18
Nodes (10): 1. `ArchiveReadContract` (the interface), 2. `PgArchiveReadContract` (the PostgreSQL implementation), 3. Migration 008 — `blocks.timestamp_ms`, 4. Rule A fold — one height, one transaction, 5. Archive identity, 6. Replay outcome → `transactions.result`, 7. Backfill for pre-008 rows, 8. `shielded-monitor/offers.ts` (+2 more)

### Community 316 - "Tasks — 00009-04: the private shielded-monitor HTTP API and its reference consumer"
Cohesion: 0.18
Nodes (10): 1. Cursor codec, 2. HTTP server, 3. Coverage in every response, 4. Cursor paging over associations, 5. Key hygiene, 6. Reference consumer CLI, 7. Bin entries, docs and README, 8. Required-tests manifest (+2 more)

### Community 317 - "Tasks — 00009-06: dashboard, list endpoint, key derivation, demo runbook"
Cohesion: 0.18
Nodes (10): 1. `PgShieldedMonitorStore.listAll(limit)`, 2. `GET /v1/monitors`, 3. `GET /ui`, `GET /ui/`, `GET /` → 302, 4. Key hygiene on the dashboard's path, 5. `shielded-monitor/hd.ts` — BIP32 `m/44'/2400'/account'/role/index`, 6. `umbradb-shielded-monitor-derive-key`, 7. `docs/shielded-monitor-demo.md` and `npm run demo:shielded-monitor`, 8. Docs and change records (+2 more)

### Community 318 - "Tasks — 00009-07: match details"
Cohesion: 0.18
Nodes (10): 1. `shielded-monitor/match-details.ts` — the extractor, 2. Migration `shielded_monitor/002_association_details`, 3. Store: write, read and the backfill's write path, 4. Scanner: details at match time, inside the height's transaction, 5. `--backfill-details`, 6. API: `blockTimestampMs`, `details`, `?details=0`, 7. Dashboard: the expandable row, 8. Docs, CHANGELOG and the required-test manifest (+2 more)

### Community 319 - "Tasks — 00009-08: project B as a distinct deployable"
Cohesion: 0.18
Nodes (10): 1. Split the monitor store into a contract and an implementation, 2. `umbradb-storage-api`, 3. `HttpMonitorStore`, 4. No database in project B, 5. `umbradb-shielded-monitor-balancer`, 6. Rule B across the boundary, 7. The 2×2 deployment, 8. Documentation and gates (+2 more)

### Community 320 - "Tasks — 00009-09: the merged monitor-node"
Cohesion: 0.18
Nodes (10): 1. Migration and the store contract, 2. The storage API, 3. The monitor-node, 4. The balancer, 5. Dashboard, compose overlay and demo, 6. End to end, 7. Documentation and gates, 7a. The two defects the live end-to-end run found (organizer questions Q31 and Q32) (+2 more)

### Community 321 - "runtime-metadata.test.ts"
Cohesion: 0.27
Nodes (8): captureForProtocolVersion(), METADATA_CAPTURES, MetadataCapture, compact(), eventsBlobWithSystemTransaction(), IDENTITY, METADATA, REAL_EVENTS

### Community 322 - "Backup and restore — `shielded_monitor` (project B)"
Cohesion: 0.20
Nodes (10): 1. Read this first: what a restore cannot recover on its own, 2. What is in the schema, 3. Taking a backup, 4.1 Restore the schema, 4.2 Re-apply the deletion list — before anything else connects, 4.3 Restart the nodes, 4. Restoring, 5. Verifying a restore (+2 more)

### Community 323 - "bin"
Cohesion: 0.20
Nodes (10): bin, umbradb-archive-backfill-timestamps, umbradb-archive-read-api, umbradb-archive-sync, umbradb-dust-backfill, umbradb-shielded-monitor-balancer, umbradb-shielded-monitor-client, umbradb-shielded-monitor-derive-key (+2 more)

### Community 324 - "dust-harness.ts"
Cohesion: 0.40
Nodes (8): DustCheckpointProbe, DustGenerationRow, DustInitialUtxoRow, DustRawEvent, DustSpendRow, DustTableTip, PayloadShape, FakeDustDbOptions

### Community 325 - "node-rpc-client.ts"
Cohesion: 0.28
Nodes (4): NodeRpcError, NodeRpcInvalidHeightError, NodeRpcParseError, SubstrateBlock

### Community 326 - "sdk-dust-state.ts"
Cohesion: 0.31
Nodes (7): BALANCE_AT, json(), log(), main(), SEED, SYNC_TIMEOUT_MS, utxosOrTree()

### Community 331 - "Design — 00009-07: match details"
Cohesion: 0.22
Nodes (8): 1. Why the details are produced by the scanner, in the same pass, and not by a second reader, 2. `mine` is three-valued because the ledger permits nothing stronger, 3. Why `jsonb`, why nullable, and why a second bound at the store, 4. Rule B: the details are part of the height, so they commit with it, 5. The backfill: fill-only, fenced, and unable to lie, 6. `?details=0` is an opt-OUT, and it removes both fields, 7. The page: an expandable row, and a bound that moved deliberately, Design — 00009-07: match details

### Community 333 - "DustModule"
Cohesion: 0.22
Nodes (4): DustModule, DustReply, DustRouteName, dustStatusBlock

### Community 335 - "pg-tx-history-adapter.test.ts"
Cohesion: 0.22
Nodes (6): $schema, assertSchemaValidSdkEntry(), makeAdapter(), { sql: getSql }, TestEntry, TestSection

### Community 336 - "dust-backfill-cli.ts"
Cohesion: 0.25
Nodes (5): conn, ledgerNetworkId, nodeUrl, service, sql

### Community 337 - "`dust-sync-client` — a wallet builds its DUST state in seconds"
Cohesion: 0.25
Nodes (7): `dust-sync-client` — a wallet builds its DUST state in seconds, Hand-off to the SDK (§5.6), The CLI, The devnet golden run, The ledger, and why it is a parameter, Use it, What it does, in order (spec §5.5)

### Community 343 - "Design — 00009-06: dashboard, list endpoint, key derivation"
Cohesion: 0.25
Nodes (7): 1. Why the dashboard is served by the API process, and why it is one file, 2. `GET /v1/monitors`: what the list shows, and the one asymmetry it creates, 3. The viewing key on the dashboard's path, 4. `derive-viewing-key`: what it computes, and what proves it, 5. Auto-refresh, and why the page must never present a gap as emptiness, 6. What this change does not touch, Design — 00009-06: dashboard, list endpoint, key derivation

### Community 344 - "Design — 00009-08: the storage boundary"
Cohesion: 0.25
Nodes (7): 1. Why a command-shaped API rather than a row-shaped one, 2. The error round trip, 3. The lost response, 4. Why the balancer is allowed to be random, 5. What the import guard proves, and what it does not, 6. Deviations from the sub-plan, recorded, Design — 00009-08: the storage boundary

### Community 345 - "Design — 00009-09: the merged monitor-node"
Cohesion: 0.25
Nodes (7): 1. Why one process rather than two that share a key, 2. Why the scan loop inverted, 3. Why fenced items are reported, not thrown (OP-2), 4. Why gaps are rows, 5. Why the balancer routes, and why it may compute a fingerprint, 6. What was removed outright (OP-4, decided 2026-09-13), Design — 00009-09: the merged monitor-node

### Community 349 - "Proposal — 00009-01: archive read contract, block timestamp, per-height atomic commit"
Cohesion: 0.29
Nodes (6): Breaking-change assessment: none, Non-goals, Prior art this builds on, and does not contradict, Proposal — 00009-01: archive read contract, block timestamp, per-height atomic commit, What this change delivers, Why this change exists

### Community 350 - "Proposal — 00009-09: the merged monitor-node, with viewing keys only in RAM"
Cohesion: 0.29
Nodes (6): Amendment — owner decisions Q33, Q29 and Q32 (2026-09-13), Breaking changes, Non-goals, Proposal — 00009-09: the merged monitor-node, with viewing keys only in RAM, What this change delivers, Why this change exists

### Community 351 - "Spec — the merged monitor-node (EARS)"
Cohesion: 0.29
Nodes (6): Key custody, Routing, Scanning, Spec — the merged monitor-node (EARS), The lifecycle (owner decision Q33), The storage API

### Community 356 - "Proposal — 00009-02: shielded monitor store, key intake and lifecycle (project B core)"
Cohesion: 0.33
Nodes (5): Impact, Proposal — 00009-02: shielded monitor store, key intake and lifecycle (project B core), What this change delivers, What this change explicitly does NOT cover (non-goals), Why this change exists

### Community 357 - "Proposal — 00009-04: the private shielded-monitor HTTP API and its reference consumer"
Cohesion: 0.33
Nodes (5): Impact, Proposal — 00009-04: the private shielded-monitor HTTP API and its reference consumer, What this change delivers, What this change explicitly does NOT cover (non-goals), Why this change exists

### Community 358 - "Proposal — 00009-06: a dashboard for the shielded monitor, a list endpoint, and a key-derivation command"
Cohesion: 0.33
Nodes (5): Impact, Proposal — 00009-06: a dashboard for the shielded monitor, a list endpoint, and a key-derivation command, What this change delivers, What this change explicitly does NOT cover, Why this change exists

### Community 359 - "Proposal — 00009-07: record and show each match's public zswap data"
Cohesion: 0.33
Nodes (5): Impact, Proposal — 00009-07: record and show each match's public zswap data, What this change delivers, What this change explicitly does NOT cover, Why this change exists

### Community 360 - "Proposal — 00009-08: project B as a distinct deployable, with no database of its own"
Cohesion: 0.33
Nodes (5): Breaking change, Proposal — 00009-08: project B as a distinct deployable, with no database of its own, What it deliberately does not deliver, What this change delivers, Why this change exists

### Community 361 - "Spec — the shielded-monitor storage boundary (EARS)"
Cohesion: 0.33
Nodes (5): Project-B processes, Spec — the shielded-monitor storage boundary (EARS), The balancer, The client, The storage API

### Community 362 - "mutate"
Cohesion: 0.33
Nodes (6): src/postgres/checkpoint-store.ts, src/postgres/save-and-advance.ts, src/postgres/temporal-kv.ts, src/postgres/transaction-lease.ts, src/postgres/watermarks.ts, mutate

### Community 363 - "viewing-key.test.ts"
Cohesion: 0.47
Nodes (3): InvalidViewingKeyError, expectRejected(), rejectionOf()

### Community 386 - "Proposal — 00009-03: the shielded viewing-key relevance scanner (project B's worker)"
Cohesion: 0.40
Nodes (4): Proposal — 00009-03: the shielded viewing-key relevance scanner (project B's worker), What this change delivers, What this change explicitly does NOT cover (non-goals), Why this change exists

### Community 388 - "indexer-event-ids.ts"
Cohesion: 0.67
Nodes (3): log(), main(), STREAM_TIMEOUT_MS

## Knowledge Gaps
- **2268 isolated node(s):** `ArchiveProgressEvent`, `ArchiveReadApiLogRecord`, `KeyResult`, `BaselineLoad`, `TinybenchOpts` (+2263 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **141 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `StateMap` connect `StateMap` to `published-ledger-v8-8.1.0.d.ts`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Why does `main()` connect `shielded-monitor/helpers.ts` to `migrate.ts`, `shielded-monitor-batch-atomicity.crash.test.ts`, `MonitorRecord`, `UmbraDBSql`, `client.ts`, `monitor-node.ts`, `StateMap`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Why does `UmbraDBSql` connect `UmbraDBSql` to `StorageError`, `archive-height-atomicity.crash.test.ts`, `sync-service.ts`, `full-sync-soak.integration.test.ts`, `differential-equivalence.test.ts`, `archive-read-api.integration.test.ts`, `chain-archive-sync-retry.integration.test.ts`, `cold-boot-recovery.integration.test.ts`, `pg-tx-history-adapter.ts`, `pg-kill-save.crash.test.ts`, `postgres/checkpoint-store.ts`, `crash-worker.ts`, `monitor-store-pg.ts`, `lease-nonwedge.crash.test.ts`, `MonitorRecord`, `backfill-block-timestamps.ts`, `client.ts`, `withSuiteWatchdog`, `storage-errors.ts`, `postgres/transaction-history-storage.ts`, `migrate.ts`, `setup.ts`, `harness.ts`, `interfaces/temporal-kv.ts`, `shielded-monitor/helpers.ts`, `chain-archive-replay-validation.integration.test.ts`, `cursor-durability.crash.test.ts`, `shielded-monitor-batch-atomicity.crash.test.ts`, `postgres/transaction-lease.ts`, `src/index.ts`, `chain-archive-rollover.ts`, `tx-replay-decoder.ts`, `chain-archive-preprod-cloud-crossval.integration.test.ts`, `shielded-monitor/errors.ts`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **What connects `ArchiveProgressEvent`, `ArchiveReadApiLogRecord`, `KeyResult` to the rest of the system?**
  _2268 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ADDED Requirements` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._
- **Should `StorageError` be split into smaller, more focused modules?**
  _Cohesion score 0.05693693693693694 - nodes in this community are weakly interconnected._
- **Should `published-ledger-v8-8.1.0.d.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.02127659574468085 - nodes in this community are weakly interconnected._