# `@midnight-ntwrk/ledger-v8` @ 8.1.0-syshash.2 — vendored build

This directory is a **built** `ledger-wasm` package, committed as binary. It is the ledger UmbraDB
loads at runtime, replacing the published `@midnight-ntwrk/ledger-v8@8.0.3`.

## Why it exists

The published package is missing three things a node-only consumer needs to reproduce a block.

**`SystemTransaction.transactionHash()`.** The method exists on the Rust ledger and the reference
indexer calls it directly to key the system transactions it archives, but the `wasm-bindgen`
wrapper never exported it — so JavaScript could read a system transaction's bytes yet not its
identity, and therefore could not store one under the key every other consumer uses. Node-only
ingest cannot archive system transactions without it.

**`SystemTransaction.cost()`.** The node's `apply_system_tx` folds `tx.cost(&params)` into the
running block fullness exactly as the regular path folds a transaction's cost, but only the
regular path was exported. Genesis is *nothing but* system transactions — five on a 1.0.0 devnet —
so without this a consumer could not account for any of genesis's cost and had to record its
fullness as zero. It is not zero: under the initial parameters those five normalize to an overall
fullness of **0.903322**. Unlike the regular sibling the Rust method takes no
`enforce_time_to_dismiss` flag and cannot fail, and the binding mirrors that rather than inventing
an argument or an error case.

> That 0.903322 is a property of these five transactions **under the initial parameters**, which is
> what the acceptance proof below exercises. It is *not* the fullness genesis actually closes at:
> two of the five are `OverwriteParameters`, and the block is closed against the limits the state
> ends with, so real replay closes genesis at **0.37696**. Both numbers are correct about different
> things; see `chain-archive-sync/ledger-replay.ts` for the fold that produces the latter.

**`LedgerParameters.clampAndNormalizeFullness()`** (with `blockLimits` alongside it). The existing
`normalizeFullness` throws when any dimension exceeds its limit, because `SyntheticCost::normalize`
returns `None` there. The node does not do that: `post_block_update` calls `clamp_and_normalize`,
which clamps each dimension to its limit and then normalizes, so an overfull block is reported as
exactly full rather than failing. A consumer using `normalizeFullness` would throw on a block the
chain accepted. `normalizeFullness` is left alone for callers who *want* over-limit input reported
as an error.

These are being upstreamed separately (see the sprint plan's §10); when they ship in a published
release, **this directory is deleted** and `package.json` points at the published version again.

## Source

| | |
|---|---|
| Repository | `git@github.com:acedward/midnight-ledger.git` |
| Branch | `feat/expose-system-transaction-hash` |
| Commit | `280905e` — `.wasm` built from `eb380b3` |
| Base | ledger 8.1.0 (`d89e0b6`, the reference `midnight-reference-mainnet/v1.0.0` checkout) |
| Built with | `wasm-pack 0.15.0`, `rustc 1.93.0 (254b59607 2026-01-19)`, `--target bundler` |
| Post-build | snippet-directory rewrite + `#self` Node import mapping (see the sprint plan's §8) |

The two commits are interchangeable as build inputs: `280905e` adds only
`ledger-wasm/verification/verify-system-tx-cost.mts`, which is not part of the crate's compiled
source. `eb380b3` is recorded because it is the tree the committed bytes were actually produced
from.

The only source differences from the 8.1.0 base are the added exports and their `.d.ts`
declarations.

## What guarantees this artifact is correct

**Not a byte comparison — that is impossible.** Rebuilding from the same commit with the same
`wasm-pack` and `rustc` on the same machine produces a **different** `.wasm` hash
(measured 2026-08-08: `46b80140…` then `9c7fc5f0…`). The build is not bit-reproducible, so no
rebuild can attest these exact bytes, and these exact bytes cannot be regenerated. That is
precisely why the artifact is committed rather than rebuilt on demand.

(The current bytes hash `7ac3fc7a…`. That differs from the 2026-08-08 pair because the source
differs — it is not a further reproducibility measurement.)

What *is* checked, and is the meaningful property, is **behavioural equivalence against an
independent implementation**: the five system transactions of a 1.0.0 devnet's genesis block, as
archived by `midnight-indexer 4.3.2`, have their hashes recomputed from the indexer's own recorded
bytes using this build. All five must match. This build passes 5/5, verified 2026-08-13.

That check also settles a version question: the indexer's ledger and this build differ in patch
version (8.0.3 vs 8.1.0), and matching hashes show the gap does not affect transaction hashing.

The cost and clamping exports have no equivalent external ground truth — the indexer records
hashes, not costs — so they are pinned against the *node's* definition instead. The companion
proof asserts that genesis's accumulated cost is non-zero, that `clampAndNormalizeFullness` agrees
with `normalizeFullness` dimension-for-dimension whenever the input is within limits, and that
over the limits the two diverge in exactly the way the node's `clamp_and_normalize` specifies.
Asserting the agreement matters as much as the divergence: it shows the clamping variant is the
same normalization, not a second one that happens to be close.

## Verifying this directory

Integrity of the committed files:

```bash
cd vendor/ledger-v8-syshash && sha256sum -c SHA256SUMS
```

Behaviour, against the indexer's ground truth (the gate that actually matters):

```bash
./node_modules/.bin/tsx /home/eddie/midnight-ledger-fork/ledger-wasm/verification/verify-system-tx-hash.mts "$PWD/vendor/ledger-v8-syshash/midnight_ledger_wasm_fs.js"
```

Behaviour of the cost and clamping exports, against the node's definition:

```bash
./node_modules/.bin/tsx /home/eddie/midnight-ledger-fork/ledger-wasm/verification/verify-system-tx-cost.mts "$PWD/vendor/ledger-v8-syshash/midnight_ledger_wasm_fs.js"
```

Both take an **absolute** path: the argument is passed to `import()`, which resolves a relative
specifier against the script's own location rather than the working directory.

Both run in CI. The ground-truth fixture and scripts live in the ledger fork alongside the source.

## Rebuilding from source

The sprint plan's §8 carries the exact recipe. Expect a different `.wasm` hash — verify with the
known-vector check above, not with `sha256sum` against this directory.

Bumping this directory **must** bump `LEDGER_STATE_VERSION` in `chain-archive-sync/sync-service.ts`.
Checkpoints store serialized ledger state, which is a ledger-internal encoding; resuming one under
a build that reads it differently produces wrong replay outcomes rather than an error. This build
is `ledger-v8@8.1.0-syshash.2`, which invalidates checkpoints written by `…syshash.1`.
