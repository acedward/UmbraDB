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
- Any other call taking a `Vec<u8>` — `System::remark` is the familiar example — does something
  else, or nothing at all. The Midnight pallet never sees those bytes. (Whether such a call can
  actually be submitted is the next section, and the answer on the 1.0 runtime is no.)

Both are "data the node accepted". Only one is a transaction.

The reference indexer draws exactly this line — it matches the call variants and discards the
rest (`chain-indexer/src/infra/subxt_node/runtimes/v1_0_0.rs`):

```rust
Call::Midnight(send_mn_transaction { midnight_tx })              => Some(Regular(..)),
Call::MidnightSystem(send_mn_system_transaction { midnight_system_tx }) => Some(System(..)),
_ => None,
```

The archive did not. It ignored which call carried the bytes and classified by the *payload's own*
`midnight:` self-tag — a string that lives inside the call's data rather than in the dispatch
information the node acted on.

## Who can actually produce such a call — and the correction

An earlier version of this document claimed an ordinary user could do this cheaply and
permissionlessly. **That was wrong, and an independent review was right to reject it.** On the 1.0
runtime both routes are closed:

- A **bare (unsigned)** foreign call is refused by the node. `pallet_midnight` holds the runtime's
  ONLY `ValidateUnsigned`, and its `pre_dispatch` admits only `send_mn_transaction`
  (`pallets/midnight/src/lib.rs`); every other call returns an error. Bare Midnight transactions
  work precisely *because* that validator exists, and nothing equivalent covers other pallets.
- An ordinary **signed** call is refused by this decoder before the pallet index is ever read —
  signed and "general" extrinsic types return early.

So the reachable cases are the trusted genesis chain-spec, which does construct a bare remark, and
future runtimes that add unsigned-validated calls taking a `Vec<u8>`. Neither is a live
permissionless exploit.

**This is therefore correctness hardening, not an exploit fix.** It is still worth doing: it makes
classification match the authoritative source instead of depending on a property of the runtime
that is true today, easy to lose, and nowhere stated as a guarantee this archive may rely on.

## What it actually costs

Two distinct failures came out of the same root cause.

### Case 1 — Forgery

Put a **genuine** transaction's bytes — copied from any block, or any chain on the same ledger
version — into a non-Midnight call. The archive records a transaction the ledger never applied,
with a valid hash, attributed to a block it never executed in. (Constructible only at the
trusted boundary on the 1.0 runtime; see above.)

This is undetectable from the payload, because the payload *is* a real transaction. Only the
carrying call tells them apart, and that was the information being thrown away.

Downstream, the archive exists to replace the indexer for effectstream primitives. A phantom
transaction means `TokenMint` reporting a mint that never happened, `NullifierAndCommitment`
reporting values never added to the ledger, and any balance derived from the feed being wrong. The
indexer would report none of it — so the archive would not be a faithful replacement, which is the
entire premise of this sprint.

### Case 2 — Ingest stall

Put **junk** under the same tag. The archive accepted it, the ledger refused to deserialize it,
and the error aborted the block; because the watermark only advances on success, ingest retried
that height indefinitely.

The same reachability limit applies — this was never user-triggerable on the 1.0 runtime. The
archive's response to it has since been reverted to failing loudly: bytes that reach the ledger
decoder have already passed `validate_unsigned`, which runs the ledger's own validation, so a
decode failure there is a real defect and silently skipping it would write a permanently
incomplete block while recording nothing.

## The fix

Classification now comes from the `(pallet, call)` pair, matched against indices pinned per
protocol-version range — the same thing the reference indexer does. The self-tag is demoted to a
corroborating check: a call and a payload that disagree are rejected rather than archived.

Pinning constants is sound here because ingest is already gated to known protocol versions, and
within a version the runtime's pallet numbering is fixed. It is **fail-closed**: if a runtime renumbers pallets inside a
supported range, genuine transactions stop being recognized rather than forged ones starting to be
accepted. That failure is not self-announcing, so it is counted — `SyncOnceResult.
midnightTaggedForeignCalls` rises when a payload claims to be a Midnight transaction while riding
another call, which is exactly the shape a renumbering produces. Resolving indices from runtime
metadata removes the pinning altogether and is the intended successor.

Node 0.22.x is deliberately absent from the index table. Its ledger codec is supported, but its
pallet indices have never been observed here, and guessing them would either drop real
transactions or archive forged ones. It fails with a message naming exactly what is missing.

Behind classification, a payload inside a *genuine* Midnight call that fails to deserialize now
**halts ingest** rather than being skipped. Those bytes have already passed the node's own ledger
validation, so a failure here is a real defect; completing the block without them would make the
archive permanently and silently incomplete.

## Verifying it yourself

Both cases are regression tests
(`test/chain-archive-sync/extrinsic-decoder.test.ts`, "classification is by call, not by payload
content"; `test/integration/chain-archive-sync-retry.integration.test.ts`, "audit F2"):

```bash
docker compose -f test/compose/docker-compose.yml run --rm tests \
  npx vitest run test/chain-archive-sync/extrinsic-decoder.test.ts
```

The forgery case is the one worth reading — it puts the **real** captured genesis transaction
into a non-Midnight call and asserts the decoder rejects it. The fixture constructs that extrinsic
directly rather than claiming to reproduce a submittable one, precisely because it is not
submittable on this runtime. To confirm the test is not vacuous, revert the classification to the
self-tag and watch it fail.

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
