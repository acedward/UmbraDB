# Re-audit brief — audit round 3

> **RE-AUDITED (2026-08-13): BLOCK/BLOCK/BLOCK at head `5b6a0b6`.** The targeted re-audit found
> every fix below except R7's fresh-schema half **incomplete or wrong in production paths** — see
> the sprint plan §16 for the verified findings register. The "Fixed in `1d4bb36`" table is a
> statement of what was attempted, not of current state.

**Current document for the round-3 attempt; §16 of the sprint plan is the current register.** Supersedes `audit-round-2-remediation-brief.md`, which is retained as history
and marked accordingly.

**Head:** `1d4bb36` · **Base:** `origin/main` `3c0c68b` (still a direct ancestor — no rebase needed)

Round 3 reviewed head `c7493c9` and returned **BLOCK/BLOCK/BLOCK**
([findings](https://github.com/acedward/UmbraDB/pull/1#issuecomment-5273905932)). **A1 passed all
three reviews**; everything else did not.

**This is a partial remediation, requested as a targeted re-audit — not a bid for PASS.** Eight
findings are fixed in `1d4bb36`; five are open and listed below with the same specificity as the
fixed ones. A full PASS attempt now would return BLOCK on items already known and named here.

---

## Why round 2's remediation failed, in one paragraph

Worth stating because it shapes what this re-audit should distrust. Round 2 closed every blocker
with a test **verified to fail when the fix was reverted**. That check is weaker than it looks: it
proves a test is *connected* to a change, not that the change is right or complete. Two findings
survived it. Replay's timestamp field was declared, read, and never assigned — invisible because
genesis genuinely is time 0 and genesis was the only block the replay tests exercised. A3's fix
corrected one `.catch(() => undefined)` and left its twin twelve lines away — invisible because the
test exercised only the first call site. **A test whose fixture cannot express the failure proves
nothing about it.** A1 is the one blocker that held, and it is also the one where the failure modes
were reasoned about rather than only reverted.

---

## Fixed in `1d4bb36`

### Replay was not reference-equivalent

| # | Finding | Fix |
|---|---|---|
| R1 | **Zero timestamps.** `blockTimestampMs` declared, read, never assigned — every block replayed at time 0, and replay is time-dependent at three points (`wellFormed`, `apply`, `postBlockUpdate`) | Decoded from each block's own `Timestamp::set` inherent via metadata (`decodeBlockTimestampMs`). A non-genesis block without one now refuses rather than substituting zero |
| R2 | **Wrong network initialization.** `fromGenesis` was passed `this.net` — the archive's row-scope label ("preprod") — where the ledger wants its network id; `fromSerialized` passed the literal `"unused"` | `ledgerNetworkId` is now required config when replay is on, validated at construction *and* in the CLI. `fromSerialized` no longer builds a throwaway blank state |
| R3 | **Not failure-atomic.** `applyBlock` assigned `this.state` per transaction, so a block refusing at transaction 3 left two applied — and refusals are retried, so the next attempt folded them on top of themselves. Silent divergence in a fold | All work on a local; `this.state` replaced only after the whole block succeeds |
| R4 | **Missing cost/fees** | Computed as the reference does, before apply; a cost that cannot be modelled now refuses (`stage: "cost"`) |

### Other fixed findings

| # | Finding | Fix |
|---|---|---|
| R5 | **Metadata still silently fell back** after `state_getMetadata` transport failures — round 2 fixed `runtimeVersionAt` and missed the identical catch on `metadataAt` | Both distinguish "node answered, state is gone" from any other failure. The remaining catches in the directory were swept and each judged: a capability probe, a module-resolution chain, a documented absent-pallet case — none silently changes what is archived |
| R6 | **Sparse-checkpoint restart failed** unless the watermark itself was checkpointed. Crash at 1500 with a 1000-block interval leaves replay at 1000 and ingest at 1501 — the gap check correctly refuses, making replay unusable at any interval above 1 and defeating sparse checkpointing entirely | Replay **catches up** over the already-archived blocks in the hole, reading their transactions back from the archive in position order and re-decoding their timestamps |
| R7 | **Migrations 003/004 omitted blob-role deletion protections.** 001's guard enumerates referencing tables by name, so tables added later are invisible to it and their blobs' role rows could be deleted, orphaning the references | Both migrations extend `chain_archive_assert_role_removable`. Noted in-file that every future blob-referencing table must do the same |
| R8 | **Replay unavailable through the production CLI**, so deployable node-direct ingest was not replay-gated — the guarantee held exactly where it was already being asserted | `REPLAY_VALIDATION` + `LEDGER_NETWORK_ID` + `REPLAY_CHECKPOINT_INTERVAL` in `sync-cli.ts`, with the network id checked before the banner prints |

**Tests.** 96 focused tests green; typecheck clean. New timestamp tests assert **order of
magnitude**, not presence — a seconds/milliseconds confusion shifts every replayed block by 54
years and otherwise looks correct.

---

## Still open — please treat as known, not as findings to re-report

Listed so this re-audit spends its attention on whether R1–R8 are *actually* fixed, rather than
rediscovering these.

| # | Open finding | Status |
|---|---|---|
| O1 | **D-parameter continuity breaks across restarts** | Not started |
| O2 | **Historical conflict detection incomplete and racy** | Not started. The current check compares `(position, tx_hash, kind)` against stored rows with no locking, so two ingesters racing one height can both pass it |
| O3 | **No state-root checks** in replay — replayed state is never compared against the block header's root | Not started |
| O4 | **Image-pin enforcement bypassable** — the CI grep matches quoted `image:` lines only | Not started |
| O5 | **Status docs, dependency inventory and Graphify stale** | Partially: this brief and the round-2 brief's superseded marker are current as of `1d4bb36`; the sprint plan's §12 register, the dependency inventory and Graphify are not |

---

## What this re-audit is asked to check

1. **Are R1–R8 actually fixed**, not merely tested? Round 2's failure mode was fixes that passed
   their own tests. For each, the useful question is *what wrong implementation would still pass
   the test that now exists*.
2. **R1 specifically** — timestamps now flow from `Timestamp::set` through
   `replayBlockIfEnabled`. Genesis (no inherent) is permitted at height 0 only. Is that the right
   boundary, and is the ms/seconds conversion right at every hop?
3. **R6 specifically** — catch-up re-applies archived blocks read back from the store. Is
   re-reading stored bytes (rather than re-deriving from the node) the correct fold input, and does
   the catch-up path handle a fork correctly?
4. **R3** — is the atomicity boundary genuinely at the block, given `postBlockUpdate` also mutates?
5. Anything **new** introduced by these eight fixes. Round 3 exists because round 2's fixes
   introduced bugs of their own.

## Validation on this head

Typecheck ✅ · 96 focused tests ✅ · migrations (fresh + incremental + populated) ✅ ·
vendored-ledger known vectors ✅. CI on the PR is green including the two required checks
(`parity`, `integrity`).

**Green CI is not evidence against a finding.** Round 3's auditors reproduced failures outside the
existing tests, which is the correct method — every finding above was invisible to a green suite.
