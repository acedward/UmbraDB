# `@midnight-ntwrk/ledger-v8` @ 8.1.0-syshash.1 — vendored build

This directory is a **built** `ledger-wasm` package, committed as binary. It is the ledger UmbraDB
loads at runtime, replacing the published `@midnight-ntwrk/ledger-v8@8.0.3`.

## Why it exists

The published package exposes no `SystemTransaction.transactionHash()`. The method exists on the
Rust ledger and the reference indexer calls it directly to key the system transactions it archives,
but the `wasm-bindgen` wrapper never exported it — so JavaScript could read a system transaction's
bytes yet not its identity, and therefore could not store one under the key every other consumer
uses. Node-only ingest cannot archive system transactions without it.

A 16-line export closes that. It is being upstreamed separately (see the sprint plan's §10); when
it ships in a published release, **this directory is deleted** and `package.json` points at the
published version again.

## Source

| | |
|---|---|
| Repository | `git@github.com:acedward/midnight-ledger.git` |
| Branch | `feat/expose-system-transaction-hash` |
| Commit | `1a561ac57c60526254ff40151bf49453d6d2648b` |
| Base | ledger 8.1.0 (`d89e0b6`, the reference `midnight-reference-mainnet/v1.0.0` checkout) |
| Built with | `wasm-pack 0.15.0`, `rustc 1.93.0 (254b59607 2026-01-19)`, `--target bundler` |
| Post-build | snippet-directory rewrite + `#self` Node import mapping (see the sprint plan's §8) |

The only source difference from the 8.1.0 base is the added export and its `.d.ts` declaration.

## What guarantees this artifact is correct

**Not a byte comparison — that is impossible.** Rebuilding from the same commit with the same
`wasm-pack` and `rustc` on the same machine produces a **different** `.wasm` hash
(measured 2026-08-08: `46b80140…` then `9c7fc5f0…`). The build is not bit-reproducible, so no
rebuild can attest these exact bytes, and these exact bytes cannot be regenerated. That is
precisely why the artifact is committed rather than rebuilt on demand.

What *is* checked, and is the meaningful property, is **behavioural equivalence against an
independent implementation**: the five system transactions of a 1.0.0 devnet's genesis block, as
archived by `midnight-indexer 4.3.2`, have their hashes recomputed from the indexer's own recorded
bytes using this build. All five must match.

Both builds above pass 5/5. The vendored bytes are the second, verified on 2026-08-08.

That check also settles a version question: the indexer's ledger and this build differ in patch
version (8.0.3 vs 8.1.0), and matching hashes show the gap does not affect transaction hashing.

## Verifying this directory

Integrity of the committed files:

```bash
cd vendor/ledger-v8-syshash && sha256sum -c SHA256SUMS
```

Behaviour, against the indexer's ground truth (the gate that actually matters):

```bash
./node_modules/.bin/tsx \
  /home/eddie/midnight-ledger-fork/ledger-wasm/verification/verify-system-tx-hash.mts \
  vendor/ledger-v8-syshash/midnight_ledger_wasm_fs.js
```

Both run in CI. The ground-truth fixture and script live in the ledger fork alongside the source.

## Rebuilding from source

The sprint plan's §8 carries the exact recipe. Expect a different `.wasm` hash — verify with the
known-vector check above, not with `sha256sum` against this directory.
