# Tasks — Sprint 9: Indexer Independence

This file is the sprint's only checkbox/status authority. Every phase closes only after its
specified persona review passes or all findings are fixed and re-reviewed (`AGENTS.md`).

**Scope boundary (owner, 2026-08-07):** Part A is ONLY reading from the node instead of the
indexer — it adds no migrations, columns or views. Everything that STORES new data is Part B, which
is primarily the contract ledger state. Two commits were moved from A to B to enforce this, which
also surfaced a duplicate-column collision between two parallel implementations; see
`scope-split.md` for the old-to-new commit mapping and the resolution.

**Status (2026-08-07):** Phases 6.1/6.2 and 6d are implemented and checked below; every other box
is genuinely unchecked. Two independent audits have returned BLOCK on the implementation branch,
and their findings are being worked through -- see `security-classification.md` for the
classification issue and its correction. Nothing here has been rubber-stamped; a checked box means
the acceptance criterion beneath it was met and the evidence recorded alongside it.

**Ordering note.** Phase 1 (ground-truth capture) comes before any build work, deliberately: it is
time-boxed by an external event we do not control, and every parity claim in this sprint depends on
an oracle that stops existing. Phase 2 is small and no longer gating — system transactions are
excluded by owner decision, so it is exclusion plumbing rather than an investigation that could
invalidate the choice of first primitive.

## 0. Specification freeze

- [ ] 0.1 Write proposal/design/tasks/spec for this change.
  - **Acceptance:** `test -f` succeeds for
    `openspec/changes/sprint-9-indexer-independence/{proposal.md,design.md,tasks.md,specs/umbra-primitive-feed/spec.md}`.
- [ ] 0.2 Validate this change and the full OpenSpec corpus with strict validation.
  - **Acceptance:** `openspec validate sprint-9-indexer-independence --strict` and
    `openspec validate --all --strict` both exit 0.
  - **Known blocker:** the `openspec` CLI is **not currently resolvable in this environment** —
    neither on `PATH` nor via `npx openspec` (`npm error could not determine executable to run`),
    despite Sprint 8's tasks recording successful `npx openspec validate` runs. These artifacts were
    authored directly against `openspec/config.yaml`'s schema and the layout used by Sprints 2–8.
    This box stays unchecked until the CLI is restored and actually run — do not check it on the
    grounds that the files "look right".
- [ ] 0.3 Run the three-persona design panel (`AGENTS.md`) on this planning tranche. Reviewers must
  specifically adjudicate: the §1.1 reversal of `full-chain-storage-design.md` §7's deferral; the
  §2 view-versus-library read contract; and whether §6's system-transaction exclusion is safe to
  carry forward to `UnshieldedSpend` (7 config sites, mainnet) or must be revisited there.
  - **Acceptance:** three independent reviews recorded, every finding either fixed or explicitly
    declined with a reason, and a re-review returning no new blocking findings.
- [ ] 0.4 Update `design/full-chain-storage-design.md` §7 so the corpus does not carry two
  contradictory classifications of unshielded created outputs (`design.md` §1.1).
  - **Acceptance:** §7's "Unshielded UTXO events" row distinguishes created (build now, this
    sprint) from spent (still deferred), and cites this change by name.

## 1. Ground-truth capture — TIME-CRITICAL, do first

The indexer is the only oracle for every parity claim in this sprint. Once it is retired, none of
these claims can be checked, only asserted.

- [ ] 1.1 Pin a block range on a named network that contains, at minimum: unshielded created
  outputs, at least one system transaction (to exercise the §6.1 exclusion filter, not to compare
  against), and at least one contract action.
  - **Acceptance:** the range, network, and indexer version are recorded in this file; a query
    against the live indexer confirms each of the three categories is non-empty in that range.
- [ ] 1.2 Capture indexer responses covering the source fields of **all six** primitives over that
  range — `contractActions`, `zswapLedgerEvents`, `unshieldedCreatedOutputs`,
  `unshieldedSpentOutputs`, `zswapMerkleTreeRoot`, and `raw` + `transactionResult`.
  - **Acceptance:** committed fixtures exist for all six field groups; each records indexer version,
    network, and block range; a checksum over the fixture set is recorded here.
- [ ] 1.3 Lift the environment gating on
  `test/integration/chain-archive-replay-decode.integration.test.ts` so it runs against the
  committed fixtures rather than requiring a sibling `midnight-wallet` checkout and a live capture.
  - **Acceptance:** the test executes (not skips) in an environment with no sibling checkout, and
    its skip condition no longer depends on `GROUND_TRUTH_AVAILABLE`. Confirm by running it and
    observing a pass, not a skip, in the CI-equivalent environment.

## 2. System-transaction exclusion (owner decision — no investigation needed)

System transactions are out of scope by owner decision. The work is making the exclusion symmetric
and declared, not closing the gap (`design.md` §6).

- [ ] 2.1 Filter the indexer-sourced side of the comparison to regular transactions only, using
  `chain_archive.transactions.kind` (self-tag-derived), never an indexer-supplied type field.
  - **Acceptance:** a range containing a system transaction that created unshielded outputs compares
    clean; a test confirms the classification is identical whether or not the indexer is reachable.
- [ ] 2.2 Document the incompleteness in the read contract and correct the watermark wording.
  - **Acceptance:** the view's contract states it covers regular transactions only and is not a
    complete UTXO view; no spec or doc text claims a below-watermark empty result means "no
    unshielded outputs" without the regular-transaction qualifier.

## 3. UmbraDB: projection, cursor, read contract

- [ ] 3.1 Add the `chain_archive` projection table for decoded unshielded created outputs, in its
  own migration in the existing `chain_archive` lineage.
  - **Acceptance:** a migration test applies the lineage fresh, re-runs it idempotently, and
    rejects a same-height fork collision — mirroring
    `test/postgres/chain-archive-migrate.test.ts`'s existing coverage shape.
- [ ] 3.2 Implement the projection writer: decode archived `tx_raw` and persist rows, advancing the
  projection cursor **in the same transaction**.
  - **Acceptance:** a test kills the writer mid-projection and confirms on restart that the cursor
    never reports a height whose rows are absent, and that re-projecting from the cursor yields a
    complete result.
- [ ] 3.3 Add the feed watermark and the versioned view `feed_unshielded_created_v1`.
  - **Acceptance:** a query at or below the watermark returning zero rows is authoritative; a query
    above it is refused rather than answered emptily. Both behaviours are covered by tests.
- [ ] 3.4 Confirm the read contract needs no UmbraDB package and no running service.
  - **Acceptance:** a test consuming the view through a bare `postgres.js` connection, with no
    UmbraDB import, returns the projected rows.
- [ ] 3.5 Confirm consumers cannot write through the contract.
  - **Acceptance:** insert, update, and delete attempts through the read path are all rejected.
- [ ] 3.6 Confirm `src/`'s dependency posture is intact.
  - **Acceptance:** `test/postgres/no-sdk-import-guard.test.ts` and
    `test/postgres/no-chain-sync-import-guard.test.ts` both still pass.

## 4. Effectstream: sync protocol and fetcher

Work in the effectstream repository, tracked here because it is this sprint's scope.

- [ ] 4.1 Add `ConfigSyncProtocolType.MIDNIGHT_UMBRA` and its config schema.
  - **Acceptance:** a node configured with both `MIDNIGHT_PARALLEL` and `MIDNIGHT_UMBRA` starts, and
    both protocols progress independently without sharing a cursor.
- [ ] 4.2 Implement the UmbraDB-backed fetcher reading `feed_unshielded_created_v1`, respecting the
  feed watermark as its progress bound.
  - **Acceptance:** the fetcher never emits for a height above the watermark; a test with a
    deliberately lagging watermark confirms it waits rather than emitting an empty block.
- [ ] 4.3 Register the fetcher at the single dispatch branch in `syncProtocolFactory.ts`.
  - **Acceptance:** the diff touches exactly one dispatch site; no other construction path changes.
- [ ] 4.4 Confirm no primitive class or grammar changed.
  - **Acceptance:** the change's full diff contains zero modifications under
    `packages/node-sdk/sm/primitives/src/midnight-*/`. Check mechanically, not by inspection.
- [ ] 4.5 Wire effectstream's feed connection to the shared Postgres with its own `search_path`,
  per the one-instance-separate-schemas shape (`design.md` §2.1, following `design/design.md` §0).
  - **Acceptance:** effectstream's node tables and `chain_archive` coexist in one instance with no
    name collision; the feed connection resolves the view without a merged schema and without
    relying on table-name distinctiveness.
- [ ] 4.6 Document the two deployment constraints the shared database imposes (`design.md` §2.1).
  - **Acceptance:** the deployment note states that no transaction pooler may sit in front of the
    shared instance (UmbraDB's durability probe raises `TransactionPoolerDetectedError` because a
    pooler breaks the session-scoped advisory locks the lease and migration lock depend on), and
    that a shared database means a shared trust domain with no at-rest encryption per
    `SECURITY.md`. Verify the pooler claim by actually putting PgBouncer in transaction mode in
    front of a test instance and observing the error, not by citing the probe's source.

## 5. The harness and Run A

- [ ] 5.1 Build the config clone: two `addPrimitive` entries of the same
  `PrimitiveTypeMidnightUnshieldedCreate`, different `name` and `stateMachinePrefix`, bound to the
  two sync protocols.
  - **Acceptance:** both prefixes receive state-machine inputs over the pinned range in one node
    run.
- [ ] 5.2 Implement the differ per `design.md` §5 — join key, compared fields, normalization, and
  empty-symmetric-difference pass criterion.
  - **Acceptance:** the differ reports differing rows rather than a count; a deliberately corrupted
    row on one side is detected; identical rows in different orders still pass.
- [ ] 5.3 Implement range-validity checking.
  - **Acceptance:** a range extending above either bound is reported void, distinctly from failed.
- [ ] 5.4 Execute Run A (archive ingesting from the indexer) over the pinned range.
  - **Acceptance:** empty symmetric difference, with the run's range, watermark, and row counts
    recorded here. Record explicitly that this validates decode and transport only.

## 6. Node-only ingest and Run B — the cutover gate

> **Note (2026-08-06): 6.1 and 6.2 were implemented and executed AHEAD of phases 3–5**, on the
> owner's directive to prioritize bypassing the indexer. The archive-level halves below are DONE;
> 6.3's *primitive-level* comparison still depends on phases 3–5 existing. Implementation:
> `chain-archive-sync/extrinsic-decoder.ts` (envelope strip + MNSV protocol-version digest decode,
> unit-tested against live-captured devnet bytes in
> `test/chain-archive-sync/extrinsic-decoder.test.ts`), `sync-service.ts` (indexer now OPTIONAL:
> node-only mode + an indexer-as-oracle cross-check mode), `sync-cli.ts` (`NODE_ONLY=1` /
> `INDEXER_URL=none`).

- [x] 6.1 Implement node-only `tx_raw` ingest: strip the outer SCALE envelope from
  `chain_getBlock` extrinsics and classify the inherents that never wrap a `pallet_midnight`
  payload.
  - **Acceptance:** for the pinned range, node-derived `tx_raw` equals the bytes the
    indexer-sourced path archived, transaction for transaction.
  - **DONE (2026-08-06), scope note:** node-only ingest covers REGULAR transactions only — the
    ledger WASM exposes no `SystemTransaction.hash()` accessor for the `tx_hash` PK, and
    runtime-generated system txs are not in `chain_getBlock.extrinsics` at all (they ARE
    node-recoverable via the `SystemTransactionApplied` event — see the design.md §6 correction —
    but event decode needs runtime metadata; deferred). Recorded result: heights 0–1216 on the
    compose devnet, 25/25 regular transactions with FULL field equality (tx_hash recomputed
    locally via WASM `transactionHash()`, block_height, block_hash, protocol_version from the
    MNSV digest, raw bytes) against the indexer-sourced schema; symmetric difference EMPTY.
    `position` is NOT compared across modes: in blocks that also carry system txs the two modes
    number positions differently — cross-mode joins use `tx_hash`.
- [x] 6.2 Re-run the archive ingest with the indexer disabled entirely.
  - **Acceptance:** the ingest completes over the pinned range with no network call to any indexer
    endpoint. Verify by blocking the endpoint, not by inspecting configuration.
  - **DONE (2026-08-06):** executed with the indexer CONTAINER STOPPED (`docker stop
    umbradb-test-indexer-1`), not merely unconfigured — heights 0→1225 ingested into a fresh
    `chain_archive_nodeonly` schema in ~10s, with the D-parameter sourced via
    `state_call(SystemParametersApi_get_d_parameter)` and verified byte-equal to the values the
    indexer had reported.
    Node-only mode passes NO indexer option, so the service never constructs an `IndexerClient` —
    independence holds by construction.
- [ ] 6.3 Execute Run B over the pinned range.
  - **Acceptance:** empty symmetric difference against the indexer-sourced primitive, with the
    indexer still available *only* as the comparison oracle and not as an ingest source. Record the
    range, watermark, and row counts here.
  - **Partial (2026-08-06):** the ARCHIVE-level Run B is done (6.1/6.2 above — empty symmetric
    difference at the `transactions`/`chain_blobs` layer). The PRIMITIVE-level comparison this
    task actually gates on still requires phases 3–5 (projection, feed protocol, clone primitive,
    differ). Additionally, the new oracle mode makes every indexer-configured sync a continuous
    Run-B-style check: `sync-service.ts` computes the node-derived view on every block and throws
    on any disagreement with the indexer before writing (verified live over blocks 1217–1241+).
- [ ] 6.4 Record the cutover recommendation.
  - **Acceptance:** an explicit written verdict for `Midnight:UnshieldedCreate` — cutover-ready, or
    blocked with the reason — stating alongside it that the feed is regular-transaction only, so
    "ready" is scoped to that boundary rather than to full parity with the indexer.

## 6d. Test stack (`test/compose/`)

The Midnight stack used to verify this work now lives at `test/compose/docker-compose.yml`,
not under this change's own directory -- an openspec change gets archived when its sprint
closes, and the repo's live-devnet integration suite depends on this stack, so it needs a
durable home.

It publishes NO host ports. Services are reachable only on the compose network under their
canonical ports (node 9944, indexer 8088, proof server 6300, postgres 5432), so several stacks
coexist on one machine under different project names without negotiating a port range. This
also fixes a real mis-binding: `test/integration/chain-archive-sync.integration.test.ts` probes
a node URL and runs against whatever answers, so on a shared machine it could silently test
against an unrelated devnet -- and did, failing on foreign data. Its endpoints are now
`MIDNIGHT_TEST_NODE_URL` / `MIDNIGHT_TEST_INDEXER_URL` (defaults unchanged), which the compose
`tests` service points at its own services.

    docker compose -f test/compose/docker-compose.yml up -d node indexer proof-server postgres
    docker compose -f test/compose/docker-compose.yml run --rm tests

Layer `docker-compose.hostports.yml` when host access is actually wanted.

## 7. Close-out

- [ ] 7.1 Run the post-implementation auditor passes per `CLAUDE.md`'s graph-scoped review policy,
  computing the PUSH-role manifest first (`scoped-review-manifest` skill).
  - **Acceptance:** manifest generated with a `built_at_commit` matching HEAD; spec-compliance,
    code-quality, and final differential-review passes all complete with findings fixed or
    explicitly declined.
- [ ] 7.2 Record this sprint's subagent token totals against the Sprint 4 baseline
  (~94.6k / ~108.7k / ~79.1k, ~282k total), normalized per changed line.
  - **Acceptance:** the three totals and the normalized comparison are recorded here, with the
    caveat that the diffs differ in size and shape stated alongside.
- [ ] 7.3 Re-run `graphify update .` against the repo root and commit the refreshed `graphify-out/`
  in the same commit as this sprint's close-out (`CLAUDE.md`).
  - **Acceptance:** `graphify update .` exits 0 and `graphify-out/graph.json`'s `built_at_commit`
    advances to current HEAD; only repository-owned graphify outputs appear in `git status --short`;
    `graphify-out/.graphify_python` and `.graphify_root` are not committed if they hold paths from
    another machine.
- [ ] 7.4 Update `ROADMAP.md` with this sprint's outcome.
  - **Acceptance:** the roadmap states which primitive was migrated, whether Run B passed, and what
    the remaining five require.

## 8. Staged execution (plan §11) — Part A

The plan's §11 supersedes any reading of §6/§7 as one monolithic gate. Each stage is mergeable on
its own. Ordered; close-out steps apply per stage.

- [x] **8.0 Stage 0 — Reproducible foundation.** *(completed 2026-08-08)*
  - **Acceptance:** a fresh clone runs every current suite with no manual build steps and no env
    vars. **Met and verified by clone-and-run**, not by inspection: `git clone` → `npm ci` →
    typecheck, build, 27 unit tests, 10 fake-service integration tests, and the real-node node-only
    ingest test all pass with `MIDNIGHT_LEDGER_WASM` explicitly unset.
  - The verified 8.1.0 ledger build is committed at `vendor/ledger-v8-syshash` with `PROVENANCE.md`
    and `SHA256SUMS`; `package.json` depends on it by path; `MIDNIGHT_LEDGER_WASM` is demoted to a
    test-only escape hatch.
  - The anticipated "CI rebuild-and-compare" gate proved impossible — the build is not
    bit-reproducible (plan §10.3). Replaced by checksum pinning plus a known-vector behavioural
    check against `midnight-indexer 4.3.2`'s recorded hashes, in
    `.github/workflows/vendored-ledger.yml` and `test/chain-archive-sync/vendored-ledger-vectors.test.ts`.
  - Refusal-path coverage, which vendoring silently removed, is restored by constructing the
    condition rather than waiting for it (`test/integration/chain-archive-ledger-refusal.integration.test.ts`).
- [x] **8.1 Stage 1 — Fail-closed on the current slice.** *(completed 2026-08-08)*
  - **Acceptance:** no known input reaches silent omission; every gap refuses loudly. Verified in a
    fresh clone with `MIDNIGHT_LEDGER_WASM` unset: 49 passed, 1 skipped, including the real-node
    node-only ingest test.
  - Signed/general **system** calls were classified `not_midnight` and dropped silently, because
    the guard searched for `midnight:transaction` alone and the two tags diverge at their tenth
    byte. Both tags are searched now (`extrinsic-decoder.ts`), with a regression test verified to
    fail against the old check and a companion test that near-misses must NOT trigger refusal.
  - The event guard's §5.1 false negative is closed. Counting compared `S+R > S+F`, detecting an
    omission only when `R > F`, so one failed direct call masked one runtime-generated event
    exactly. It now matches archived bytes against the events blob, which separates the two
    populations counting conflated — still with no runtime metadata. Its residual limits (assumes
    event bytes equal extrinsic bytes; cannot say WHAT an unmatched payload is) are stated in the
    code rather than implied.
  - Dual-source key collisions refuse rather than losing a row to `ON CONFLICT DO NOTHING`.
    Reachable today in **indexer-sourced** mode, not node-only: the indexer keeps both copies.
  - Node-only mode announces itself as experimental at every start, before connecting to Postgres.
  - **Not covered by this stage, and still a silent-omission path:** extending an archive written
    by an older incomplete implementation (§5.5). That belongs to §6.6 / Stage 3–4 work and is not
    claimed closed here.
- [x] **8.2 Stage 2 — Block-scoped metadata decoding.** *(completed 2026-08-10)*
  - **Acceptance:** the §5.1/§5.2 refusals convert to support; pinned `CALL_INDICES_BY_PROTOCOL`
    retired to a cross-check. **Met**: node-only ingest resolves the block's own runtime metadata
    (cached by `(specName, specVersion)`), archives signed/general framings, recovers
    runtime-generated system transactions from `SystemTransactionApplied` (event-first ordering per
    `v1_0_0.rs:160-163`), and follows a renumbered runtime instead of refusing it. The pinned table
    now only cross-checks and refuses on disagreement; 0.22.x ingests (its indices were also
    settled from the reference's captured metadata — plan B5).
  - Migration `002_transaction_position_key` landed (owner-approved); the dual-source case stores
    both rows and the collision guard now enforces position-uniqueness instead.
  - 71 tests green in the dev clone (unit + fake-node integration + migration suites), typecheck
    clean. Three suites whose premise was refusal were rewritten to assert the archiving behaviour
    that replaced it — documented in commit 2b2443e.
  - **Open, deliberately not absorbed by this close-out:** node-only ingest requires the node to
    serve historical metadata, so pruned nodes refuse for old ranges. The fix is planned as
    **Stage 2b** (plan §13) — the indexer-style captured-metadata registry plus a
    `runtime_metadata` table — and is not claimed done here.
- [x] **8.2b Stage 2b — Metadata availability (plan §13).** *(completed 2026-08-11)*
  - Migration `003_runtime_metadata` (+ `runtime_metadata` blob role) and
    `chain-archive-sync/metadata-captures/` (the reference's `.node/` ported: 1.0.0 and 0.22.0).
    Resolution order: archive capture → node (persisting) → committed registry → refuse naming all
    three. 75 tests green, typecheck clean.
  - **Scope corrected by implementing it** (plan §13.5): pruned-node *ingest* is NOT solvable —
    `System::Events` and the D-parameter are per-block state that no per-runtime capture replaces.
    What this buys is a self-describing archive: re-decode and Stage 4 replay need no node, and a
    runtime is fetched once per net ever. B7 is narrowed, not closed.
- [x] **8.3 Stage 3 — Parity gates required.** *(completed 2026-08-11)*
  - Parity gate now compares `block_hash` and the ordered `system_parameters_d` observations,
    closing revision 7's §5.6 finding. Run live against a matched node/indexer pair: 60 blocks,
    38 transactions (5 system), 1 D-parameter observation — identical from both sources. First
    evidence that Stage 2's behaviour changes did not break parity.
  - `REQUIRE_LIVE_SERVICES=1` turns service-absence skips into failures; verified in both
    directions. New workflow `.github/workflows/chain-archive-parity.yml` provisions the stack
    (with the hostports overlay, which is mandatory there) and waits for the indexer to reach
    height 10 so the comparison cannot be vacuous. Whole sequence simulated locally end-to-end.
  - Removed a test that could never run again (`skipIf(haveSystemHash)` in the node-only suite);
    its coverage lives in the refusal suite that actually executes. That suite now has no skips.
  - §7 gains an evidence-type column: live parity vs mechanism-equivalence vs not-demonstrated.
    Three rows remain open and are named with their blockers (U5, Stage 4, and the
    runtime-upgrade boundary, which **cannot** be demonstrated on any reachable chain).
  - **Owner action when this merges:** flip the new job to required in branch protection.
- [x] **8.4 Stage 4 — Apply-rule parity (replay).** *(completed 2026-08-11)*
  - **Acceptance ("the last two §7 refusal-parity rows close"): met by mechanism-equivalence.**
    `ledger-replay.ts` advances real ledger state through the reference's exact pipeline (same
    strictness, same BlockContext, same classification), verified against real bytes: genesis
    applies clean; garbage refuses at `deserialize`; a one-byte proof corruption refuses at
    `well_formed`; and — the finding at the centre — an apply-`Failure` is an **archived row**,
    not a refusal, exactly as the reference records it.
  - Documented deviation: block fullness is zeroed in `postBlockUpdate` because the WASM exposes
    no block-limits accessor (second missing export, plan §10.3). Nil on near-empty blocks.
  - **Deliberately out:** wiring replay into live ingest. It needs a restart/checkpoint story
    (`LedgerState.serialize()` exists for exactly this; a checkpoint table is a schema decision),
    so it is its own follow-up rather than a rider. U5 (does the indexer archive a `BadOrigin`
    rejection?) remains the one live-observation dependency in this area.
- [ ] **8.5 Stage 5 — Optional-source GA.** Blocked on one owner decision (plan §11.2).

Per-stage close-out, every stage: update this file, re-run `graphify update .` and commit
`graphify-out/`, and append any ledger findings to the plan's §10.3 log, dated.

> **Outstanding — the graph is stale and cannot be refreshed on this machine.**
> `graphify-out/graph.json`'s `built_at_commit` is `afe5c11`; Stage 0 advanced HEAD past it, so
> per CLAUDE.md's freshness gate any review manifest computed from it is **void** until refreshed.
> The pinned command `uvx --from graphifyy==0.9.24 graphify update .` cannot run here: `uv`,
> `uvx`, `pipx` and `pip3` are all absent, and `python3 -m venv` fails because `ensurepip` is not
> installed (`apt install python3.12-venv`, which needs sudo). Not worked around, because a
> different graphify version would produce outputs inconsistent with the pinned pipeline.
> **Needs one of:** installing `uv`, or `apt install python3.12-venv`, or running the refresh from
> a machine that already has the toolchain. Plan §11.1's prerequisite list omits this dependency
> and should gain it.

## 9. Audit round 2 remediation (plan §14) — gates PR #1

Three personas returned BLOCK on head `2cfef2a`
(<https://github.com/acedward/UmbraDB/pull/1#issuecomment-5269573241>). No box below closes
without a test that fails on the pre-fix behaviour; each fix gets a targeted re-audit, and merge
needs fresh PASS×3 on the final head rebased onto current `main`.

- [x] **9.1 (A1) Kind from the payload, hashes never trusted.** *(done 2026-08-11, `1ade369`)*
  Event hashes are recomputed from the bytes being archived and the block refuses if the event's
  two halves disagree; `kind` must agree between the dispatched call and the payload's self-tag.
  Three tests, each verified to fail on the pre-fix code with no other test moving.
  ~~Original:~~ Refuse when the dispatched call's
  type disagrees with the payload's self-tag; recompute every event-borne system-transaction hash
  via `SystemTransaction.transactionHash()` and refuse on mismatch with the event's claim.
- [x] **9.2 (A3) Metadata resolution failure semantics.** *(done 2026-08-11, `9f74db5`)*
  Only a node that answered "state is gone" falls back to the registry; transport failures
  propagate. Persistence-boundary question answered in code: a capture is a fact about a RUNTIME,
  not a block, so it may outlive a refused block — with the `first_seen_height` consequence stated.
  Test verified against the swallow-everything version.
  ~~Original:~~ The `runtimeVersionAt` catch must
  distinguish "historical state discarded" (fall through to the registry) from "request failed"
  (propagate); decide and document whether `runtime_metadata` persistence may survive a refused
  block, or move it inside the block's atomic boundary.
- [x] **9.3 (A5a) Populated-database migration test.** *(done 2026-08-11, `3577b1f`)*
  Two blocks, four transactions and bridge observations written under the OLD key, then migrated.
  Rows survive in order; the dual-source shape becomes storable on the populated table; a position
  clash is still rejected; 003's widened role CHECK accepts `runtime_metadata`. Non-vacuity proven
  by sabotage — re-pointing 002's key back at `tx_hash` fails this test and the empty-table one.
  ~~Original:~~ Apply 002+003 onto a database already
  holding blocks/transactions rows and prove the PK swap and role-CHECK extension preserve them.
- [x] **9.4 (A4) Restart and retry consistency.** *(done 2026-08-11, `c0b684e`)*
  A re-ingest producing different rows at the same keys now refuses instead of being silently
  discarded — which also *is* the older-implementation detector, since a pre-metadata range
  re-ingests to genuinely different rows. Identical contents still pass, so idempotent retries are
  unaffected (existing retry suite green). Verified to fail with the check removed.
  ~~Original:~~ Detect an archive written by an older
  implementation before extending it; a retry whose bytes CONFLICT with an existing row must
  refuse, not be `ON CONFLICT DO NOTHING`-skipped.
- [ ] **9.5 (A2) Wire replay into node-only ingest.** Blocked on the owner's checkpoint decision:
  a `replay_checkpoints` table (schema change) versus rebuild-from-archive on every restart.
- [ ] **9.6 (A5b) Release close-out.** Reconcile authoritative docs; pin compose images by digest
  and add scanning; regenerate graphify on the final head.
- [ ] **9.7 Re-audits.** Targeted re-audit per blocker, then fresh PASS/PASS/PASS on the final
  integrated head, recorded on PR #1.

## Deferred to a later change

Recorded here so they are not silently absorbed:

- The other five Midnight primitives (`proposal.md`, Staging).
- The actual cutover — switching any template config to the new protocol.
- Unshielded **spent** outputs, which need an intent `.inputs` decoder that does not exist.
- The `eventId` redefine-or-drop decision for `NullifierAndCommitment`.
- Any GraphQL shim for non-effectstream consumers (wallet, dapp-connector), which have the same
  shutdown exposure but are out of this sprint's scope.
