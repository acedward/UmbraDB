# UmbraDB's own Stagenet case expectations

The reference case files in `../mip0018-cases/` (verbatim, SHA-256 checked) are written against MIP-0018 at `274a84f`.
UmbraDB implements MIP-0018 as in [PR #372](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/372),
whose rule "Keys MUST be valid UTF-8" (Testing R5) changes one recorded event: case C07's step A3c (height 714956,
contract `23aa27cb…`), an event whose only record has the non-UTF-8 key `ff 6b 65 79`. The reference accepts it;
UmbraDB rejects it whole (reason `invalid-utf8`).

| File | Replaces | What differs from the reference file |
|---|---|---|
| `C07/expected.json` | `../mip0018-cases/C07/expected.json` | no field `ff6b6579`; `counts` 8 accepted, 10 rejected (the reference: 9 and 9) |
| `IDX/index-summary-differences.json` | the 714956 entry of `../mip0018-cases/IDX/index-summary.json` `events` | `result` `reject`, `reason` `invalid-utf8`, no `domainSep`/`kind` |

The tests read an expectation from here when this folder has it, else the reference copy, and
`[[mip0018.metadata.recorded-cases]]` checks that each file here differs from the reference file in exactly the points
above.
