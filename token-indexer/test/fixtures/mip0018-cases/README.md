# MIP-0018 Stagenet case expectations (project 00026, sub-plan B3)

Expected consumer state per case contract, in the reference's `expected.json` shape (identities with their usable
common fields, `fields` and `counts` where given, symbol groups). Used by `token-indexer/test/mip0018-metadata.test.ts`.

## Verbatim reference files

Every `<case>/*.json` directly under a case folder is a byte-for-byte copy of
`midnight-experiments/mip-0018 @ daec1f19747b09f4e245885ab0dd9ecc789a82ce`, `deployments/stagenet/cases/<case>/<file>`
(copied with `git show daec1f1:<path>`; never edited). The test checks each copy's SHA-256 against the value the
recorded case index (`test/integration/fixtures/stagenet-archive/case-index.json`, `source.files`) holds for that
reference path.

Sub-plan D2 added three more verbatim copies from the same commit, used by `token-indexer/test/mip0018-cases.test.ts`
and checked the same way: `IDX/expected.json` (the matrix colors with each identity's metadata, C05 bronze not minted),
`IDX/index-summary.json` and `U1/index-summary.json` (the reference mint scanner's output over 714485–715183 and
715402–715433: colors with first/last mint, deploys, the `mip-0018:token-metadata[v1]` events with position, bytes and
classification, stats). C09 has no copy: its `expected.json` is byte-identical to C01's (same SHA-256 in the case
index), so the test compares C01's file.

## UmbraDB's own per-key expectations (`C06/umbradb-per-key/`)

The reference expectations of C06's steps after the tombstone (`expected-after-withdraw.json`,
`expected-after-withdraw-again.json`, `expected-after-revive.json`, and `expected.json` = after the revive) were
written for MIP `78ecbb4`, where a Null record withdrew the whole identity. UmbraDB implements MIP PR #340 head
`274a84f221bcfc17e4b73e2c8b32fd8c028ea092` — per-key tombstones (owner decisions Q16/Q17 of project 00026; the
reference repository is not changed). C06's `withdrawMetadata` event carries ONE record, a Null at `name`, so under the
per-key rule:

| Step (height) | Event | UmbraDB's expectation |
|---|---|---|
| withdraw (714813) | Null at `name` | kind 3 keeps `symbol` = ACMP, `decimals` = 6, `standards` = mip-0004; no `name` |
| withdraw-again (714827) | Null at `name` again (no value) | no effect: same as after the withdraw |
| revive (714835) | `name` = Acme Again, `symbol` = ACMA | name and symbol set; `decimals` and `standards` were never deleted and stay |

The files in `C06/umbradb-per-key/` state exactly that, in the same shape. Single-member groups are listed as the
reference lists them; comparisons ignore groups of one member (Q6).
