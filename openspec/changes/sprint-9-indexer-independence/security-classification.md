# Why "the node accepted it" is not the same as "it is a transaction"

The natural objection to this whole class of bug is: *the archive only reads data the Midnight
node already accepted into a finalized block — how can that be unsafe?*

The answer is that the node accepted an **extrinsic**. It never asserted that the extrinsic was a
Midnight **transaction**. Those are different claims, and the archive was conflating them.

## The mechanism

A Substrate block is a list of extrinsics. Each names the `(pallet, call)` it dispatches to. The
node validates and executes each one according to *that call's* rules:

- `pallet_midnight::send_mn_transaction(midnight_tx: Vec<u8>)` — call index 0 — is the **only**
  path that reaches `LedgerApi::apply_transaction`
  (`midnight-node/pallets/midnight/src/lib.rs`). Bytes arriving here become ledger state.
- `System::remark(Vec<u8>)` is a real, fee-paying call that does **nothing**. Its entire purpose
  is to put arbitrary bytes on chain. The Midnight pallet never sees them.

Both are "data the node accepted". Only one is a transaction.

The reference indexer draws exactly this line — it matches the call variants and discards the
rest (`chain-indexer/src/infra/subxt_node/runtimes/v1_0_0.rs`):

```rust
Call::Midnight(send_mn_transaction { midnight_tx })              => Some(Regular(..)),
Call::MidnightSystem(send_mn_system_transaction { midnight_system_tx }) => Some(System(..)),
_ => None,
```

The archive did not. It ignored which call carried the bytes and classified by the *payload's own*
`midnight:` self-tag — a string inside data that any user can write. That is classifying by
attacker-controlled content.

## Why the fee doesn't save you

Submitting a remark costs a fee, so the attack isn't free. It is, however, *cheap and
permissionless* — no privileged access, no compromised node, no consensus attack. An ordinary
user with an ordinary account can do it, repeatedly, and the fee is the same one they'd pay to
store any data on chain.

## What it actually costs

Two distinct failures came out of the same root cause.

### Case 1 — Forgery (the severe one)

Wrap a **genuine** transaction's bytes — copy them from any block, or any chain running the same
ledger version — in a `System::remark`. The archive records a transaction that the ledger never
applied, with a valid hash, attributed to a block it never executed in.

This is undetectable from the payload, because the payload *is* a real transaction. Only the
carrying call tells them apart, and that was the information being thrown away.

Downstream, the archive exists to replace the indexer for effectstream primitives. A phantom
transaction means `TokenMint` reporting a mint that never happened, `NullifierAndCommitment`
reporting values never added to the ledger, and any balance derived from the feed being wrong. The
indexer would report none of it — so the archive would not be a faithful replacement, which is the
entire premise of this sprint.

### Case 2 — Denial of service

Put **junk** under the same forged tag. The archive accepted it, the ledger refused to
deserialize it, and the resulting error aborted the block. Because the sync watermark only
advances on success, ingest retried that height forever.

One remark, and a node-only archive stalls permanently at a height of the attacker's choosing.

## The fix

Classification now comes from the `(pallet, call)` pair, matched against indices pinned per
protocol-version range — the same thing the reference indexer does. The self-tag is demoted to a
corroborating check: a call and a payload that disagree are rejected rather than archived.

Pinning constants is sound here because ingest is already gated to known protocol versions, and
within a version the runtime's pallet numbering is fixed. It is deliberately **fail-closed**: if a
runtime renumbers pallets inside a supported range, genuine transactions stop being recognized —
visible and fixable — rather than forged ones starting to be accepted, which would be silent and
permanent.

Node 0.22.x is deliberately absent from the index table. Its ledger codec is supported, but its
pallet indices have never been observed here, and guessing them would either drop real
transactions or archive forged ones. It fails with a message naming exactly what is missing.

A second layer remains behind classification: a payload inside a *genuine* Midnight call that
fails to deserialize is skipped and counted on `SyncOnceResult`, not thrown. Nothing an attacker
can put on chain should be able to halt ingest.

## Verifying it yourself

Both cases are regression tests
(`test/chain-archive-sync/extrinsic-decoder.test.ts`, "classification is by call, not by payload
content"; `test/integration/chain-archive-sync-retry.integration.test.ts`, "audit F2"):

```bash
docker compose -f test/compose/docker-compose.yml run --rm tests \
  npx vitest run test/chain-archive-sync/extrinsic-decoder.test.ts
```

The forgery case is the one worth reading — it smuggles the **real** captured genesis transaction
through a remark and asserts the decoder returns `null`. To confirm the test is not vacuous,
revert the classification to the self-tag and watch it fail.

To confirm the check does not reject genuine traffic, run both ingest modes against one chain and
compare. Measured on a live 1.0.0 devnet: node-only and indexer-sourced both archive **21 regular
transactions** over heights 0–1599, and oracle mode ran **2000 blocks** with no cross-check
failure.

```bash
docker compose -f test/compose/docker-compose.yml up -d node indexer proof-server postgres
# node-only (no indexer) and indexer-sourced (oracle cross-check on every block)
NODE_ONLY=1 npm run archive:sync     # into one database
npm run archive:sync                 # into another, same chain
```

## What this does not fix

Classification answers *"is this a Midnight transaction?"*. It does not answer *"did it
execute?"* — the archive still records submissions, and a transaction that reverted or partially
applied is archived indistinguishably from one that succeeded. Closing that requires decoding the
runtime's own outcome events (`TxApplied` / `TxPartialSuccess`, and `UnshieldedTokens` for created
outputs), which is the audit's finding F1 and needs a runtime-metadata dependency.

Until then the archive is trustworthy about **what was submitted**, not about **what happened**,
and should not be cut over from the indexer on the strength of this fix alone.
