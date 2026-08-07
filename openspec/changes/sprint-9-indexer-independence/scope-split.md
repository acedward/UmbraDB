# Scope split: Part A / Part B — plan update and commit changes

**For the reviewer.** History on both branches was rewritten on 2026-08-07 to enforce a scope
boundary the owner set. Commit SHAs quoted in earlier reviews no longer resolve. This document
maps old to new, states what moved and why, and records what each branch now contains.

## The boundary

| | Definition |
|---|---|
| **Part A** — `feat/indexer-independent-ingest` | **Only** reading from the node instead of the indexer. No new schema, no new stored data. |
| **Part B** — `feat/contract-ledger-state` | Extending the archive. Primarily storing the contract ledger state; also the block-level readings that are stored rather than merely read. |

The test for A is now mechanical and worth re-checking on any future commit:

```bash
git diff --name-only <base>..feat/indexer-independent-ingest -- src/postgres/migrations/
```

**must be empty.** A adds no migrations, no columns, no views.

## What moved, and why

Two commits sat on A that stored new data, which is B's job by the definition above. They were not
authored as part of A's line of work; they arrived on the branch while other work was in flight.

| Commit | Adds | Was | Now |
|---|---|---|---|
| `capture the zswap state root and block timestamp` | `blocks.zswap_state_root`, `blocks.timestamp_ms`, `feed_blocks_v1`, `feed_zswap_roots_v1`, migration `002_zswap_root` | A | **B** (`279196e`) |
| `persist the protocol version on blocks` | `blocks.protocol_version` | A | **B** (`ba24fc9`) |

Moving them surfaced a conflict that was already latent and would have blocked B's merge:

**Both `002_zswap_root` and B's `002_contract_state` ran `ALTER TABLE blocks ADD COLUMN
zswap_state_root`, and both were numbered `002`.** Applying the lineage would have failed with a
duplicate-column error. Two independent implementations of the same capture had been written in
parallel; the collision was invisible while they lived on separate branches.

Resolved by ownership rather than by picking a winner:

- `002_zswap_root` owns the block-level node readings: zswap root, timestamp, protocol version,
  and the two block feed views.
- `002_contract_state` was renumbered **`003_contract_state`** and no longer adds
  `blocks.zswap_state_root`. It owns contract state only: the `contract_states` table, its
  partitions, blob-role integrity, and `feed_contract_states_v1`.
- The ingest side matched the schema side: `captureContractState` no longer fetches the zswap
  root. `captureZswapRoot` owns that one RPC. Previously both fetched it — two round trips per
  block for one column.
- Where the two implementations overlapped in `BlockRecord` and the store, the `002_zswap_root`
  version was kept: it is a strict superset (root + timestamp + protocol version, against root
  alone).

## Branch contents after the split

**Part A — 16 commits.** Extrinsic-envelope decoding, `state_call`, the indexer-optional switch,
and the correctness work on that path: call-based classification, the protocol-version gate,
parent continuity, chain identity, the packaged ledger dependency, and the in-compose test stack.
Adds no migrations.

**Part B — 6 commits on top of A.** In dependency order: `002_zswap_root` (block-level readings)
→ protocol-version column → contract-action decoding → `003_contract_state` → contract-state
capture at ingest → spec deltas.

## Verification after the rewrite

| | Part A | Part B |
|---|---|---|
| Typecheck | clean | clean |
| Migration + decoder + retry suites | 35 passed | 43 passed |
| Migration lineage | `000, 001` | `000, 001, 002_zswap_root, 003_contract_state` — applies clean, including incrementally onto a database already carrying the earlier lineage |

Backup refs `backup/pre-scope-split-A` and `backup/pre-scope-split-B` hold the pre-rewrite state,
so nothing is lost and the rewrite is auditable.

## One commit message was corrected, not just moved

`capture contract state and zswap root at ingest` became **`capture contract state at ingest`**,
because after the split it no longer captures the root. The body states that explicitly rather
than leaving a reader to notice the subject no longer matches the diff.

## Unchanged by this split

The standing blocker is untouched: the archive establishes **what was submitted**, not **what
executed**. Deriving applied outputs needs the runtime's outcome events, which needs a
runtime-metadata dependency that has not been decided. Neither branch should cut over from the
indexer on the strength of what is here.
