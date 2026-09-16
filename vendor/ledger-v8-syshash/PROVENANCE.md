# `@midnight-ntwrk/ledger-v8` @ 8.1.0-syshash.6 — vendored build

This directory is a **built** `ledger-wasm` package, committed as binary. It is the ledger UmbraDB
loads at runtime, replacing the published `@midnight-ntwrk/ledger-v8@8.0.3`.

## Why it exists

The published package is missing five things a node-only consumer needs to reproduce a block, and
— since `syshash.6` — four more that a node-side **DUST tree mirror** needs to serve wallets
(project 00016; see "What `.6` adds" below).

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

**`LedgerState.closeBlock(tblock, accumulatedCost)`.** Q64 `FixedPoint` values are serialized to
JavaScript as `f64`. Splitting the node's block-close fold across the WASM boundary therefore
rounds the normalized cost before it is passed back to `postBlockUpdate`, changing serialized
ledger state by as much as 318 raw Q64 units in the audited vector. This atomic export performs
clamp, normalization, max-of-five-dimensions, and `post_block_update` entirely in Rust. Only the
raw integer `SyntheticCost` enters from JavaScript; no `FixedPoint` value leaves Rust.

**`LedgerState.ledgerStateRoot()`.** Applying transactions without comparing the resulting state
only proves that the ledger accepted the bytes; it does not prove replay reached the state the
chain committed. Node 1.0 stores the untagged serialized typed arena key returned after
`post_block_update` and exposes it historically through `midnight_ledgerStateRoot(at)`. This
binding serializes the identical `Sp<LedgerState>::as_typed_key()` representation so ingest can
refuse a mismatched block before writing it.

## What `.6` adds over `.4` (project 00016 — DUST wallet sync)

A wallet that wants a spend-ready `DustLocalState` in seconds needs the shared part of the two DUST
Merkle trees from somewhere that already replayed them. The node can hold a key-less
`DustLocalState` mirror, but 8.1.0 gives JavaScript no way to *cut* a collapsed update out of one:
`MerkleTreeCollapsedUpdate::new` is only reachable through the **chain-side** `DustUtxoState`.

**`DustLocalState.collapsedCommitmentUpdate(start, end)`** and
**`DustLocalState.collapsedGenerationUpdate(start, end)`** expose exactly that constructor over a
local state's own two trees. Both validate `start ≤ end` **and** `end < first_free` in Rust and
return an error rather than panicking, so the range a caller may ask for is exactly `[0, firstFree−1]`.

**`DustLocalState.commitmentTreeFirstFree`** and **`DustLocalState.generatingTreeFirstFree`**
(read-only getters). The Rust fields are private and had no accessor, so without them JavaScript
cannot form a valid range at all, and a mirror cannot report the trees' bounds from the trees
themselves rather than from a second data source.

**`DustLocalState.replayRawEventsRetainingAll(sk, raw)`** — the same replay as `replayRawEvents`
with a core `retain_all` flag that skips every `collapse` call. This is the one a **mirror** must
use and a **wallet** must not. The stock replay collapses each foreign leaf, and
`MerkleTreeNode::collapse` merges collapsed siblings upward, so a key-less mirror's trees keep only
large aligned collapsed subtrees and `MerkleTreeCollapsedUpdate::new` cannot descend into one.
Measured on the first 5 000 preprod DUST events (3 989 commitment leaves): a stock mirror can serve
the segments around a uniformly random wallet leaf in **0 of 200** draws, a retained mirror in
**200 of 200**, and both reach identical roots — so the wrong choice here fails only when a wallet
asks for a segment. The price is memory: ≈ 2 032 B of WebAssembly heap per leaf for a retained
tree against ≈ 855 B for a collapsed one (both measured as peak `external` delta over the same
5 370 leaves).

These are being upstreamed separately (see the sprint plan's §10 and, for the four DUST exports,
`ledger-wasm/UPSTREAM-PR-00016.md` on the fork branch below); when they ship in a published
release, **this directory is deleted** and `package.json` points at the published version again.

## Source

| | |
|---|---|
| Repository | `git@github.com:acedward/midnight-ledger.git` |
| Branch | `feat/00016-dust-collapsed-updates` (a fast-forward of the owner's `feat/expose-system-transaction-hash`, which is untouched at `ebe6aa53271c7465a67bae0150f7ac4d85200de9`) |
| Source commit | `2b579359d79d59486d63440f9de39b6441aae493` (branch head) |
| Bytes built from | `6f4acdb9` — the commits between it and the head touch only `ledger-wasm/verification/verify-dust-collapsed-update.mts` and `UPSTREAM-PR-00016.md`, no Rust and no Cargo manifest, so the head builds the same artifact |
| Applied source patch | **none** — the former `SOURCE-ledger-state-root.patch` is now in the fork tree, hand-merged and committed as `9d76f2ef` |
| Base | ledger 8.1.0 (`d89e0b6`, the reference `midnight-reference-mainnet/v1.0.0` checkout) |
| Built with | `wasm-pack 0.15.0`, `rustc 1.93.0 (254b59607 2026-01-19)`, `cargo 1.93.0`, `--target bundler` (7 m 01 s) |
| Post-build | snippet-directory rewrite + `#self` Node import mapping (see the sprint plan's §8) |
| `midnight_ledger_wasm_bg.wasm` | `c07cff68561dd51748ffd07c91f5e64236f45c9e7f542c2cf93e8a66d4918552` |

The source tree was checked out at the exact source commit above and built with no out-of-tree
patch. The only source differences from the 8.1.0 base are the nine added exports, their generated
declarations, and native-oracle verification fixtures.

## What guarantees this artifact is correct

**Not a byte comparison — that is impossible.** Rebuilding from the same commit with the same
`wasm-pack` and `rustc` on the same machine produces a **different** `.wasm` hash
(measured 2026-08-08: `46b80140…` then `9c7fc5f0…`). The build is not bit-reproducible, so no
rebuild can attest these exact bytes, and these exact bytes cannot be regenerated. That is
precisely why the artifact is committed rather than rebuilt on demand.

(The current bytes hash `c07cff68561dd51748ffd07c91f5e64236f45c9e7f542c2cf93e8a66d4918552`.
That differs from the 2026-08-08 pair, and from `.4`'s `2c3cec6c…` and `.5`'s `54edd6d4…`, because
the source differs — it is not a further reproducibility measurement.)

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

The atomic close export is checked against SHA-256 state hashes precomputed by native Rust, not by
the WASM code under test. All seven committed vectors also pin the old rounded-f64 result as a
counterweight and require it to differ: genesis closes to `412811927ead…` natively but
`c41b7298b8b6…` through the lossy path, while five synthetic additions each make one cost
dimension uniquely dominant and solely over-limit. This directly closes both the committed-oracle
trap in which actual and expected state shared the rounded binding and the per-dimension clamp/max
coverage gap. The five test-only additions were assembled at ledger-fork
`ebe6aa53271c7465a67bae0150f7ac4d85200de9`; they do not alter the artifact source commit or bytes.

The four DUST exports are checked by a fourth script against **real preprod data** rather than a
synthetic tree: 5 000 DUST ledger events fetched once from the public indexer are replayed into a
retained mirror; both roots must equal the stock replay's; segments cut around three real own
leaves must apply to a blank `DustLocalState` and, after the own leaves are inserted, reproduce the
mirror's roots; the generating tree rebuilt independently from the *parsed* initial-UTxO entries
and their latest dtime annotations must reach the same root the ledger's own replay does; every
out-of-range cut must throw; and the 200 random-wallet draws above must be 200/200 on the retained
mirror and pinned at 0/200 on the stock one. 26/26 checks pass on these exact bytes (2026-09-15).

The ledger-root export has a structural native-Rust oracle in the fork tree (commit `9d76f2ef`,
formerly the vendored patch): for an actual
`LedgerState<InMemoryDB>`, it independently constructs `Sp::new(state.clone()).as_typed_key()`,
serializes that key, and requires the helper to return byte-identical output. This rejects tagged
state serialization, full-state bytes, and the unrelated Substrate header root. UmbraDB then
checks the built WASM against a digest-pinned node 1.0.0: the node's historical custom roots agree
for a 40-block live replay, while a synthetic non-checkpoint mismatch is refused before writes.

## Verifying this directory

Integrity of the committed files:

```bash
cd vendor/ledger-v8-syshash && sha256sum -c SHA256SUMS
```

The four behaviour checks below run **from the repo root**. They live in the ledger fork, which is a
separate checkout and not part of this repo — point `LEDGER_FORK` at wherever you cloned it (see
"Rebuilding from source" below for what that fork is):

```bash
LEDGER_FORK=/path/to/midnight-ledger-fork
```

Behaviour, against the indexer's ground truth (the gate that actually matters):

```bash
./node_modules/.bin/tsx "$LEDGER_FORK/ledger-wasm/verification/verify-system-tx-hash.mts" "$PWD/vendor/ledger-v8-syshash/midnight_ledger_wasm_fs.js"
```

Behaviour of the cost and clamping exports, against the node's definition:

```bash
./node_modules/.bin/tsx "$LEDGER_FORK/ledger-wasm/verification/verify-system-tx-cost.mts" "$PWD/vendor/ledger-v8-syshash/midnight_ledger_wasm_fs.js"
```

Atomic close behaviour, against committed native-Rust state hashes:

```bash
./node_modules/.bin/tsx "$LEDGER_FORK/ledger-wasm/verification/verify-close-block.mts" "$PWD/vendor/ledger-v8-syshash/midnight_ledger_wasm_fs.js"
```

The DUST collapsed-update exports, against real preprod events (this one caches its indexer fetch
under `/media/eddie/mn-nvme/00016/samples/`; it re-fetches only if the cache is gone):

```bash
./node_modules/.bin/tsx "$LEDGER_FORK/ledger-wasm/verification/verify-dust-collapsed-update.mts" "$PWD/vendor/ledger-v8-syshash/midnight_ledger_wasm_fs.js"
```

All four scripts take an **absolute** path for the artifact: the argument is passed to `import()`,
which resolves a relative specifier against the script's own location rather than the working
directory. `$PWD` supplies that absolute path when you run from the repo root, which is why these
are written that way rather than as a bare `vendor/...` path.

Equivalent assertions for the hash, cost, close and root behaviour groups run in CI against the
installed vendored package; the DUST group is covered in CI by the node-side mirror and segment
tests (`test/shielded-monitor/dust-*.test.ts`), which cut and re-apply segments over a committed
preprod event fixture. The standalone ground-truth scripts live in the ledger fork alongside the
source; the independent close hashes are also copied into UmbraDB's test fixtures.

## Rebuilding from source

The sprint plan's §8 carries the exact recipe. Expect a different `.wasm` hash — verify with the
known-vector check above, not with `sha256sum` against this directory.

Bumping this directory **must** bump `LEDGER_STATE_VERSION` in `chain-archive-sync/sync-service.ts`.
Checkpoints store serialized ledger state, which is a ledger-internal encoding; resuming one under
a build that reads it differently produces wrong replay outcomes rather than an error. This build
is `ledger-v8@8.1.0-syshash.6`, which invalidates checkpoints written by `…syshash.1` through
`…syshash.5`. (`.5` was staged on 2026-09-15 with the collapsed-update pair and the two getters but
never vendored: without `replayRawEventsRetainingAll` the node's mirror cannot serve segments.)
