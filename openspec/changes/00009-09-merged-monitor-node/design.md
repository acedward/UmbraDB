# Design — 00009-09: the merged monitor-node

> Reference design (the organizer's, with the diagrams and the decision table):
> `/home/eddie/todo/Umbra/plans/00009-09-merged-monitor-node.md` §§1–7.
> This file records the decisions a reader of THIS repository needs, and the reasons they went the
> way they did.

## 1. Why one process rather than two that share a key

A viewing key that is never persisted can be held by exactly one process. The 00009-08 split —
a scanner that fetched the key per batch and an API that accepted it — only worked because the
database was the hand-off point. Remove the database from that path and there are two options:
pass keys between processes over a private channel, or merge the two processes.

Merging wins on every axis that matters here. A private key channel is a new attested surface for
the TEE step to protect, for no capability: the API and the scanner have no reason to be separate
units once they share state that only exists in memory. Merging also removes the lease, because
the question a lease answered — "which scanner may work on this monitor?" — has a better answer
once keys are in RAM: the node that HAS the key, and no table can know that.

The cost is that a node restart loses its keys. That is not hidden: the monitor reports
`keyNeeded`, the dashboard shows it, and the client's remedy is to re-send — which reaches the
same monitor, because the fingerprint is the identity, and resumes from the recorded coverage.

## 2. Why the scan loop inverted

Per-monitor scanning deserializes each transaction once per monitor. Deserialization is a WASM
call over the whole transaction and is the expensive part; the predicate is a trial decryption per
key per offer and is cheap by comparison. With keys in one process, the loop can invert: read the
block once, deserialize each transaction once, test every key.

That changes the natural commit unit from "this monitor's batch" to "this block, for everyone",
which **strengthens** owner Rule B rather than weakening it: a height is still exactly one
`BEGIN … COMMIT`, and now that commit also cannot leave two of a node's monitors disagreeing about
whether the height happened. `crash.shielded-monitor-batch.advance-batch-is-all-or-nothing` is the
assertion.

`evaluateExtractedOffers` is shared by both paths deliberately: the one-key sync path and the
many-key live path must not be able to disagree about what a match is.

## 3. Why fenced items are reported, not thrown (OP-2)

A block batch carries every monitor a node holds. If one paused monitor threw, the whole block
would fail for every other wallet — the node would stall on a lifecycle event that has nothing to
do with the rest. So each item is fenced independently and the failures come back in the response
with a reason the node can act on: `state`/`not-found` drop or re-read the key, `epoch` retries
next turn, `already-advanced` is the idempotent replay path.

## 4. Why gaps are rows

Coverage is one number, so it cannot say "I have scanned through 500, except 120–125". Without
somewhere to record the hole, the hand-off between Queue B and Queue A would have to be atomic —
which would mean locking the live scan while a key catches up, and stalling every other key.

Instead the node checks once per key (`HAS_SCANNED_ONCE`) whether it joined the live set behind
its own coverage, writes the shortfall as a row **in the same transaction as the coverage move**,
and queues a back-sync. The same-transaction part is the whole guarantee: a crash between the two
would leave coverage claiming a range no gap row admits was never scanned, and nothing would ever
revisit it.

Back-filled associations take the NEXT sequence numbers, above the live ones, even though their
heights are older. `seq` is the consumer's cursor, and a poller that has already paged past height
H must still be handed a match discovered later at H. The consequence — `seq` order is no longer
`(blockHeight, position)` order for a monitor that had a gap — is a deliberate trade, recorded
here and in `PgShieldedMonitorStore.fillGap`'s own doc.

## 5. Why the balancer routes, and why it may compute a fingerprint

Registration has to reach the node that already holds the key, or a second node takes custody and
two nodes scan one monitor. The balancer is the only component that can see all the nodes, so it
decides — by asking them, not by reading a table, because what a node holds in RAM is the truth.

To ask, it needs the fingerprint, which means decoding the submitted key. That is a real widening
of the trust boundary and is recorded as **OP-1**. It is bounded in three ways: the computation is
a Bech32m decode and a SHA-256 with **no ledger WASM** (so `routing.ts` imports nothing that could
reach one), the bytes are not retained, and the registration body is never logged. The TEE step
either moves the balancer into the enclave or takes a client-computed fingerprint header instead;
the routing already works from the fingerprint alone.

The hint table is a hint. It is never trusted without a `holds` check, because the node it names
may have restarted — and a restarted node holds nothing. That single verification is what makes a
stale hint self-correcting rather than a source of duplicate custody.

## 6. What was kept unused rather than removed (OP-4)

`monitors.key_serialized` and the `monitor_leases` table are left in place, always NULL and never
read. Dropping a column and a table is not an additive migration, and this lineage's rule is that
a migration never invalidates a reader that ran before it. A later cleanup migration removes both
once no deployed reader references them.
