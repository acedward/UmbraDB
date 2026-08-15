# Proposal — Sprint 9: Indexer Independence (differential-parity harness + first migrated primitive)

> **Status update (2026-08-15): IMPLEMENTED, pending final independent PASS×3.** This is the
> original scoping proposal. Owner decisions and audit remediation expanded Part A to include
> system transactions, replay/checkpoints and the minimal safety migrations needed by the source
> substitution. Do not interpret the historical non-goals below as current limitations; the
> authoritative current registers are `tasks.md` §§13–18 and `system-transactions-plan.md` §§15–19.

## Why this sprint exists

Effectstream's Midnight support has exactly one data source. Every one of its six Midnight
primitives is typed to `ConfigSyncProtocolType.MIDNIGHT_PARALLEL`, and that protocol's fetcher
(`packages/node-sdk/sync/src/sync-protocols/midnight/fetcher.ts`) talks to one thing: the
`midnight-indexer` GraphQL API. The sync-protocol config schema says so in as many words —
`packages/effectstream-sdk/config/src/schema/sync-protocols/midnight/graphql.ts:30`, *"node URL and
proof server are not needed for read-only use"*. There is no fallback path to fall back to.

The indexer is scheduled for shutdown. When it goes, effectstream's Midnight support goes to zero —
not degraded, zero — including two live mainnet template configs
(`templates/night-bitcoin-v2/packages/node/config.mainnet.ts`,
`templates/evm-midnight-v2/packages/node/config.mainnet.ts`).

UmbraDB is already most of the way to being the replacement source. `chain-archive-sync/`
(Tier-1.5, `design/full-chain-storage-design.md`) archives blocks and raw transaction bytes, and
`chain-archive-sync/tx-replay-decoder.ts` already reconstructs unshielded outputs, zswap
inputs/outputs, and dust actions from those archived bytes — with
`test/integration/chain-archive-replay-decode.integration.test.ts` matching them field-for-field
against real indexer ground truth. What does not exist yet is (a) persistence of those decoded
values, (b) a read contract effectstream can consume, and (c) any evidence that an
UmbraDB-sourced feed produces *the same* state-machine inputs as the indexer-sourced one.

(c) is the part that expires. Every parity claim about a decoded field becomes unfalsifiable the
moment the indexer is switched off, because the oracle is the indexer. **The window to prove this
is open now and closes on a date we do not control.** That is the forcing function for this
sprint's timing, and it is why the sprint's first deliverable is a comparison harness rather than a
migration.

## What this sprint delivers

Two things, in this order:

1. **A differential-parity harness.** The same primitive class, instantiated twice from config —
   once against the existing indexer-backed sync protocol, once against a new UmbraDB-backed one —
   writing to two different state-machine prefixes, with a differ that asserts the two streams are
   1:1 over a pinned block range. The "clone" the owner asked for is a **config clone, not a code
   clone**: no primitive class and no grammar is duplicated or modified.

2. **One migrated primitive: `Midnight:UnshieldedCreate`.** Chosen because it is the cheapest
   possible first proof — the decode is already written and already validated against indexer
   ground truth, so this sprint's new work is confined to persistence, the read contract, and the
   harness itself, rather than to chain semantics.

The strategic value is the harness. The primitive is the thing that proves the harness works.

## The circularity threat, stated up front

`chain-archive-sync/sync-service.ts` currently sources transaction bytes from the **indexer's**
`Transaction.raw`. If UmbraDB ingests from the indexer, and effectstream then reads from UmbraDB, a
green parity run proves the decode and the transport — and proves *nothing whatsoever* about
surviving the indexer's shutdown. It would be a pipeline that still needs the thing being
switched off.

The sprint therefore specifies **two** parity runs, and only the second one gates anything:

| Run | UmbraDB ingest source | What a green result actually proves |
|---|---|---|
| **A** | Indexer `Transaction.raw` | The decode, the projection, and the read contract are correct |
| **B** | Node JSON-RPC only | The pipeline survives indexer shutdown |

Run B is the cutover gate. Run A is a debugging convenience that isolates decode bugs from ingest
bugs — valuable, but it must never be reported as the migration's evidence.

Node-only ingest is bounded work, not open-ended: `sync-service.ts` has already established
empirically that the indexer's `raw` is an **exact suffix** of the corresponding node extrinsic's
bytes, and that the count gap (28 node extrinsics vs 26 indexer transactions on the sampled block)
is Substrate framework inherents that never wrap a `pallet_midnight` payload. The remaining work is
stripping the outer SCALE envelope and classifying inherents — not reverse-engineering a format.

## Non-goals

Stated explicitly, per this project's proposal convention:

- **Not migrating the other five primitives.** `Generic`, `UnshieldedSpend`, `NullifierAndCommitment`,
  `ZswapRoot`, and `TokenMint` are staged below but are not specified here and no requirement in
  this change covers them.
- **Not building a ledger replay engine.** No `LedgerState` is maintained, no transaction is
  applied, no Merkle DAG arena is held. Research this sprint confirmed no primitive requires one
  (see Staging, below).
- **Not building a GraphQL shim.** UmbraDB does not grow an API mimicking the indexer's schema.
  Should a shim later be wanted for *non-effectstream* consumers (wallet, dapp-connector), that is
  a separate change with a separate justification.
- **Not making UmbraDB multi-tenant or a hosted service.** `SECURITY.md`'s single-trusted-writer
  threat model is unchanged. Effectstream is a **reader**; the archive keeps exactly one writer.
- **Not publishing UmbraDB to npm.** The read contract is deliberately designed so effectstream
  needs no build-time dependency on UmbraDB (see `design.md` §2).
- **Not changing any effectstream primitive class or grammar.** If this sprint finds itself editing
  `packages/node-sdk/sm/primitives/src/midnight-*/`, the design is wrong.
- **Not covering system transactions.** Owner decision: the feed is regular-transaction only. The
  indexer reports unshielded outputs from system transactions and this feed will not, so the
  comparison excludes them from both sides and the feed is documented as an incomplete UTXO view
  (`design.md` §6). Midnight distributes NIGHT through system transactions, so any consumer
  computing balances from this feed will be short those outputs — a declared boundary rather than a
  silent omission.
- **Not cutting over.** This sprint ends with evidence, not with a template switched to the new
  protocol. Cutover is its own change, gated on Run B.
- **Not touching `src/`'s dependency posture.** `test/postgres/no-sdk-import-guard.test.ts` keeps
  holding: nothing under `src/` imports `@midnight-ntwrk/*`, and all decode work stays outside it.

## Staging for the remaining five (context only — not specified here)

Research during this sprint's scoping corrected an earlier assumption that most primitives would
require replaying the ledger. They do not. The node's own `MidnightRuntimeApi` (api_version 5,
`midnight-node/pallets/midnight/src/runtime_api.rs:20`) exposes `get_contract_state`,
`get_zswap_state_root`, `get_zswap_chain_state`, and `get_decoded_transaction` — and the indexer
itself obtains contract state that way, not by replay
(`midnight-indexer/chain-indexer/src/infra/subxt_node.rs:679` resolves `contract_actions` via
`runtimes::get_contract_state(address, node_version, block)`).

| Primitive | Config sites (templates + e2e) | Non-indexer source | Notable open item |
|---|---|---|---|
| `Generic` | **17**, incl. 2 mainnet | Node runtime API `get_contract_state` at block | Highest usage; cheapest source. Likely the second migration, not the last |
| `UnshieldedSpend` | **7**, incl. mainnet | Decode intent `.inputs` + archive join on `(intentHash, outputIndex)` | The decoder has no unshielded-input path today; the join is a natural fit for an archive |
| `UnshieldedCreate` | 2 | **This sprint** | — |
| `NullifierAndCommitment` | 2 | Decode proven; `mtIndex` needs a running `zswap_first_free` counter | `eventId` is an indexer artifact with no on-chain meaning — needs an explicit redefine-or-drop decision |
| `ZswapRoot` | 2 | Node runtime API `get_zswap_state_root` | Node API is per-block; the indexer reports per-transaction. Granularity must be reconciled |
| `TokenMint` | 2 | effectstream's existing decoder + per-segment results from pallet events `TxApplied` / `TxPartialSuccess` | — |

Usage is inverted from difficulty: the two primitives carrying real production weight (`Generic`,
`UnshieldedSpend`) are not the two this sprint migrates. That is deliberate — the first increment
buys the harness, and the harness is what makes the next two safe to do quickly.

**Ground-truth capture is scoped to all six anyway** (`tasks.md` §1). Capturing responses for
primitives we are not migrating costs one extra query per block range now, and is impossible later.

## Relationship to existing work

- Builds directly on `design/full-chain-storage-design.md` (Tier-1.5 `chain_archive` schema) and
  the `chain-archive-sync/` service, neither of which is currently wired into any executing path.
  This sprint is the first consumer that gives them a reason to run.
- Reuses the co-transactional cursor property proved for checkpoints
  (`saveAndAdvance`, `v1.0.0-durable-checkpoint-cursor`) for the decode projection's own cursor —
  see `design.md` §4. The failure mode is identical, so the remedy should be too.
- Does not touch the frozen 1.0.0 Lean cut-line `{T3, T5, W1, C1}`; W1 is *relied upon*, not
  modified.
