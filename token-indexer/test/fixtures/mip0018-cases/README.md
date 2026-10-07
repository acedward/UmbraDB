# MIP-0018 Stagenet case expectations

Expected consumer state per case contract, in the reference's `expected.json` shape (identities with their usable
common fields, `fields` and `counts` where given, symbol groups). Used by `token-indexer/test/mip0018-metadata.test.ts`
and `token-indexer/test/mip0018-cases.test.ts`.

## Verbatim reference files

Every `<case>/*.json` directly under a case folder is a byte-for-byte copy of
`midnight-experiments/mip-0018 @ e8295792d9363be37ff2f7f716c740fcdf3f195e`, `deployments/stagenet/cases/<case>/<file>`
(copied with `git show e829579:<path>`; never edited). `SOURCE.md` lists every copy with its SHA-256; the tests
recompute each hash. C06's files describe each step of its lifecycle under per-key tombstones: the withdraw (one Null
record at `name`) keeps `symbol`, `decimals` and `standards`; the revive sets `name` and `symbol` next to them.

Three more verbatim copies from the same commit are used by `token-indexer/test/mip0018-cases.test.ts`:
`IDX/expected.json` (the matrix colors with each identity's metadata, C05 bronze not minted), `IDX/index-summary.json`
and `U1/index-summary.json` (the reference mint scanner's output over 714485–715183 and 715402–715433: colors with
first/last mint, deploys, the `mip-0018:token-metadata[v1]` events with position, bytes and classification, stats).
C09 has no copy: its `expected.json` is byte-identical to C01's (`SOURCE.md` lists both hashes), so the test compares
C01's file.

Which transactions belong to which case step, and at which heights, comes from the recorded case index
(`test/integration/fixtures/stagenet-archive/case-index.json`), built from the reference's `record.json` files; those
files are byte-identical at the commit pinned here. The reference's case C11 (blocks 724875–724957) is outside the
recorded Stagenet ranges and is not replayed.

Single-member groups are listed as the reference lists them; comparisons ignore groups of one member (a symbol group
has two or more members).
