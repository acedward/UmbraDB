# Re-audit brief — audit round 2 remediation

**Reviewed head:** `a1f521d` · **Base:** `origin/main` `3c0c68b` (unchanged since branching, so the
branch is a direct descendant — no rebase required, and `merge-base == main`) · **87 commits**

Round 2 returned three BLOCKs on head `2cfef2a`
([findings](https://github.com/acedward/UmbraDB/pull/1#issuecomment-5269573241)). All five blocker
groups are remediated. This maps each to its fix, its commit, and the test that proves it, so a
re-audit can go straight to the evidence.

**Standing rule this round was held to:** no blocker was closed without a test **verified to fail
against the pre-fix code**. Where that verification was done by reverting the fix and re-running,
it is stated below — treat it as a claim to check, not a courtesy.

---

## A1 — kind from the payload; event hashes never trusted

**Commit `1ade369`** · `chain-archive-sync/sync-service.ts`

Two ways the archive could record something its own bytes contradict:

1. Event-borne system transactions were keyed on the hash the event **claimed**, never checked
   against the payload stored beside it. A wrong or forged hash became the key everything joins on
   — permanently, since inserts are `ON CONFLICT DO NOTHING`. The `transactionHash()` export was
   vendored precisely so this is checkable; not checking it was the gap.
2. `kind` came from the dispatched **call** alone, so system-tagged bytes arriving via
   `send_mn_transaction` archived as `regular`, and consumers filtering on `kind` read it wrongly.

Now: the hash is recomputed from the bytes being archived and the block refuses if the event's two
halves disagree; call and payload must agree on kind or the block refuses. Ingest does not pick a
winner between the runtime's dispatch and the transaction's self-description.

**Tests** — `test/integration/chain-archive-event-guard.integration.test.ts`: a lying event hash;
an event carrying regular-transaction bytes; system bytes dispatched to the regular call.
**Verified**: all three fail against the pre-fix code, no other test moves.

## A2 — replay gates ingest

**Commit `a3b06f7`** · `chain-archive-sync/{sync-service,ledger-replay}.ts`,
`src/postgres/migrations/chain_archive/004_replay_checkpoints.ts`

The replay engine existed and nothing consulted it, so an archive could hold blocks the reference
would have aborted on. Replay now runs **before** `putBlockBundle`.

`004_replay_checkpoints` (owner-approved) keeps restart cost proportional to the checkpoint
interval rather than to chain length. Sparse by measurement: serialized `LedgerState` is 816 bytes
blank, ~37 KB after genesis's five system transactions, unbounded thereafter — per-block
checkpointing would dwarf the archive. `ledger_version` is stored **and checked**: serialized state
is a ledger-internal encoding, so resuming under a different build computes against state that
build may read differently, producing wrong outcomes rather than an error.

Off by default — strictly slower and requires an unbroken run from genesis.

**Tests** — `test/integration/chain-archive-replay-validation.integration.test.ts` (6): genesis
replays clean; a block replay rejects is refused with nothing written; checkpoint contents are real
and re-readable; a foreign `ledger_version` refuses; out-of-order replay refuses; with replay off
the same transaction **is** archived.

**Two bugs the tests caught, worth an auditor's attention:**
- The checkpoint write violated its own foreign key — gating necessarily precedes the block row, so
  checkpointing moved to *after* the write (also correct on its own terms: a checkpoint may only
  record state for a block that was archived).
- The first refusal test used undeserializable bytes, which **never reach replay** — the decode
  path rejects them first. The case only replay catches is a structurally **valid** transaction
  failing validation, so the test now uses the real genesis transaction with one byte flipped
  inside its proof.

## A3 — metadata resolution failure semantics

**Commit `9f74db5`** · `chain-archive-sync/runtime-metadata.ts`

The `runtimeVersionAt` catch swallowed **every** error, so a connection reset or timeout silently
degraded resolution to the coarse committed registry — and nothing in the archive records which
metadata decoded a block, so the degradation left no trace. Only a node that **answered** "state is
gone" now earns the fallback; everything else propagates. The predicate matches message text
deliberately and narrowly, because Substrate reports pruned state as an application-level JSON-RPC
error rather than a distinct type, and matching broadly would restore the bug.

A3's other half — persisting a capture before the triggering block is known archivable — is
**answered in code, not silently kept**: a capture is a fact about a *runtime*, not a block, so it
stays true whether or not the block later refuses, and keeping it makes a retry cheaper rather than
poisoned. The one visible consequence (`first_seen_height` can name a never-archived block) is
diagnostic, and "first observed" is the honest answer to that question.

**Test** — `chain-archive-metadata-availability.integration.test.ts`: a node healthy except on
`state_getRuntimeVersion`, failing the way a network does. **Verified** to fail against the
swallow-everything version. *(The test was wrong twice first — the initial fake failed at
`chain_getBlockHash` so it never reached the metadata path, and the second asserted inner error
text where the RPC client wraps failures with the method name. Both corrections are in the commit
message.)*

## A4 — restart and retry consistency

**Commit `c0b684e`** · `chain-archive-sync/sync-service.ts`

`ON CONFLICT DO NOTHING` is right for idempotent retries but was silent about a re-ingest producing
**different** rows at the same keys: discarded, success reported, archive keeping contents the code
that just produced them disagrees with.

This also closes A4's other half without new machinery. A range archived by the pre-metadata
implementation has no event-borne system transactions and numbers positions differently, so
re-ingesting it now yields genuinely different rows — which **is** "history written by an older
implementation." No version marker anyone has to trust; the rows are the evidence.

Comparison is by `(position, tx_hash, kind)`. Identical contents still pass silently.

**Test** — ingest a block without its event-borne system transaction (the old shape), then
re-ingest with the event present. **Verified** to fail with the check removed; the existing retry
suite stayed green, confirming idempotent re-ingest was not broken.

## A5 — release readiness

**Commits `3577b1f`, `26673ac`, `ca68f8e`, `a1f521d`**

- **Populated-database migration test** (`3577b1f`). Every prior migration test ran on empty
  tables, where dropping and rebuilding a primary key cannot fail; on populated tables it
  revalidates every row, and the runner is **forward-only with no `down()`**. Two blocks, four
  transactions written under the old key, bridge observations, then migrated: rows survive in
  order, the dual-source shape becomes storable, position clashes still reject, 003's widened role
  CHECK accepts `runtime_metadata`. **Verified non-vacuous by sabotage** — re-pointing 002's key
  back at `tx_hash` fails this test and the empty-table one.
- **Image pins** (`26673ac`). Every compose image digest-pinned, CI fails if any is not. The stack
  is the **oracle** for the parity gate, so a mutable tag means the comparison target can change
  with no commit. Verified: `docker compose config` resolves all five, the pinned node starts and
  answers, and the pin check was run both ways.
- **Corpus reconciliation** (`ca68f8e`). Three normative statements had become false and are
  corrected, each recording *why the earlier form was wrong*: `design.md`'s "current position"
  (said event-borne transactions were undecoded); the spec's classification requirement (said kind
  SHALL NOT come from the payload — the exact inversion A1 corrected); the spec's refusal and
  protocol-gating requirements (superseded by metadata decoding). Strict OpenSpec validation
  passes.
- **Graphify** (`a1f521d`). Regenerated at the reconciliation head, 2940 nodes, **zero** vendor
  pollution.
- **Scanning: declined, not silently dropped.** A first attempt shipped a step named "scan the
  pinned images" that actually ran `scan-type: config` against the compose *file* — green forever
  without looking at an image. Removed rather than left misleading. The decline reasoning is in the
  plan: pins protect the parity gate's integrity; CVEs in upstream release images this repo neither
  builds nor patches are actionable only by whoever bumps a pin.

---

## Things a re-audit should press on

Offered because they are the weakest points, not the strongest:

1. **Three migrations in a branch whose scope test was "no migrations."** `002`, `003`, `004`, each
   individually owner-approved. The original A/B boundary ("Part A stores no new data") **no longer
   holds**; what survives is that none stores new *business* data — only the archive's own
   machinery (key shape, decoder inputs, replay position). Recorded in the plan, not glossed.
2. **Replay's fullness deviation.** The reference normalizes accumulated block fullness against
   `parameters.limits.block_limits`; the WASM exposes no accessor, so `postBlockUpdate` receives
   zero fullness. Nil on near-empty blocks; divergent fee-market updates near capacity. A second
   candidate upstream export (plan §10.3).
3. **The parity gate's shelf life.** It requires the indexer, which is being decommissioned. Owner
   decision: keep it optional-at-runtime and required-for-parity, drop it later. So this round's
   parity evidence is a dated snapshot, and ledger replay is its intended successor.
4. **Mechanism-equivalence vs live parity.** §7 now labels every row by evidence type. Several
   populations no reachable chain emits (runtime-generated system transactions, signed calls) are
   proven against real captured bytes through fake nodes. The runtime-upgrade boundary **cannot**
   be demonstrated here at all.
5. **A2's `kind` mapping.** `replayBlockIfEnabled` maps `kind === "system" ? "system" : "regular"`.
   Post-A1 the two agree by construction, but the mapping is defensive rather than asserted.

## Validation on this head

Typecheck ✅ · build ✅ · **93 focused tests** across decoder, metadata, event-ingest, refusal,
replay, migration ✅ · strict OpenSpec ✅ · vendored-ledger integrity ✅ · graph fresh at HEAD ✅ ·
live parity (60 blocks, 38 transactions incl. 5 system, 1 D-parameter observation, identical
including `block_hash`) ✅ on a matched node/indexer pair.

Passing validation does not clear a semantic finding. It is listed so a re-audit knows what has
already been mechanically checked and can spend its attention elsewhere.
