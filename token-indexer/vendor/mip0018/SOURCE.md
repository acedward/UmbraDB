# Vendored MIP-0018 reference parts — provenance

Every file in this directory (except this `SOURCE.md`) is a **verbatim** copy of a file of the MIP-0018 reference
implementation at the pinned commit below. None of them is edited; a change upstream is re-vendored deliberately
(copy the files again, update this table). `token-indexer/test/mip0018-provenance.test.ts` recomputes every SHA-256
below in CI and fails on any modified, missing or unlisted file.

| Field | Value |
|---|---|
| Upstream | `https://github.com/midnight-experiments/mip-0018.git`, branch `main` |
| Pinned at | **`daec1f19747b09f4e245885ab0dd9ecc789a82ce`** ("toolchain.json: Prettier formatting", 2026-10-02) |
| License | Apache-2.0 (upstream `LICENSE` and `NOTICE` vendored next to this file; UmbraDB is Apache-2.0 too) |
| MIP text the upstream files were written against | MIP-0018 PR #340 @ `78ecbb4b1ba57371e84fe45f705991ab7b996a61` |
| MIP text UmbraDB implements | MIP-0018 PR #340 head **`274a84f221bcfc17e4b73e2c8b32fd8c028ea092`** (per-key tombstones) — the diff `78ecbb4 → 274a84f` changes only the tombstone rule, the S1/S3/S4/S9 tests and the grouping wording; the payload format, the three checks, the value types and the event name are unchanged, so the codec's classification is the final MIP's |
| Vendored on | 2026-10-02, UmbraDB project 00026 (sub-plan B, task B1; decision Q18 in the project's questions file) |

What is **not** vendored, on purpose (owner decision Q17): the reference consumer (`packages/consumer`, whole-identity
tombstones of `78ecbb4`), the codec's own unit tests (they import `@mip0018/vectors` by package name, which this
path-import layout does not resolve; the codec is exercised here through every payload vector instead), the vector
generator and validator. UmbraDB's state rules (per-key tombstones, Q16) are its own code in
`token-indexer/mip0018/state.ts`; UmbraDB's own versions of the eight state vectors that `274a84f` changed live in
`token-indexer/mip0018/vectors-umbradb/` with their own provenance.

How UmbraDB uses the files: plain path imports (`token-indexer/vendor/mip0018/codec/src/index.ts`), no npm `file:`
dependency; the root `tsconfig.json` sets `allowImportingTsExtensions` (it is `noEmit`) so `tsc` accepts the `.ts`
specifiers the upstream sources use.

## Files

| This directory | Upstream path at the pin | SHA-256 |
|---|---|---|
| `codec/package.json` | `packages/codec/package.json` | `f5d7eb61889c7c8a330065c2196c7cb65072433258c342bba0412975f675bac5` |
| `codec/README.md` | `packages/codec/README.md` | `9dab8be79c93ef5cfbb557fae7bbaf18225d1c69950ac1fb19d062b452547954` |
| `codec/src/classify.ts` | `packages/codec/src/classify.ts` | `57821aadf0af8772909408c601107f142ea5a7d19f3b2988fd23393b29049cf6` |
| `codec/src/constants.ts` | `packages/codec/src/constants.ts` | `7520efd857a6035752e9e8139fdbef11fc1ade984c820b9f240549ed60dc7274` |
| `codec/src/decode.ts` | `packages/codec/src/decode.ts` | `d9cee4a9b551448e3ffb90adedf8869e0749cf4b4350e97093b3d615363ffc41` |
| `codec/src/encode.ts` | `packages/codec/src/encode.ts` | `1ba99d64ba25b1b3b6473e29c15ed71e2307524f1fd6c75979c79b8caeb88b86` |
| `codec/src/hex.ts` | `packages/codec/src/hex.ts` | `7ad2914d8bb983dde3ccc00edb05955afa948f9108894b57ae586686d4ab2e01` |
| `codec/src/index.ts` | `packages/codec/src/index.ts` | `e2487ca5a1dd4983df9e372fbcdb4f34e983e709380abdcd11481ba9c016bf17` |
| `codec/src/internal.ts` | `packages/codec/src/internal.ts` | `8d8631bf553b7d5f65c768b5fe33d0083cd559b0db7e3cf111ee77b983125272` |
| `codec/src/rules.ts` | `packages/codec/src/rules.ts` | `a3e92a68d5e859ca38016e7091e2e244607f0268c3c39674d4de4946dcab595a` |
| `codec/src/uri.ts` | `packages/codec/src/uri.ts` | `612e56954c17995e4ca98e865e4865d9bbfdbd6c5a9de11fc2a168d055174829` |
| `codec/src/values.ts` | `packages/codec/src/values.ts` | `5e20c4e166e1960c929a290bdf812971fe478201649fbcb5d8a1fa8610299e79` |
| `codec/tsconfig.json` | `packages/codec/tsconfig.json` | `1443a43102572e64d3bc659d5f5984a4fce3b087bdfac72a8d6bb4b55b3139ec` |
| `LICENSE` | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `NOTICE` | `NOTICE` | `7dfa652b7aee31524aa22622276d56cc5f96faf191ee353c5510aafd8af6e0f7` |

## Re-check

```sh
git -C <clone of midnight-experiments/mip-0018> rev-parse HEAD     # daec1f19747b09f4e245885ab0dd9ecc789a82ce
git -C <clone> show daec1f19747b09f4e245885ab0dd9ecc789a82ce:<upstream path> | sha256sum   # equals the table
npx vitest run token-indexer/test/mip0018-provenance.test.ts        # recomputes every hash in this table
```
