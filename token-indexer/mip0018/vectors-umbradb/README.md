# UmbraDB's own MIP-0018 vector versions

The vendored vectors (`token-indexer/vendor/mip0018/vectors/`) are written against MIP-0018 at `274a84f`. UmbraDB
implements [MIP-0018](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/eb94bc182221cd937a84ed66a5f903b060f165ab/mips/mip-0018-on-chain-token-metadata.md) as merged from [PR #372](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/372), which
adds "Keys MUST be valid UTF-8" (Testing R5: invalid UTF-8 in a key rejects the event). This folder holds UmbraDB's own
version of each vendored vector whose expected result that rule changes; `token-indexer/mip0018/run-vectors.ts` runs
it instead of the vendored file with the same id, so every id runs exactly once.

| Id | Event | Vendored expectation | UmbraDB's expectation |
|---|---|---|---|
| `A3c` | one record, key `ff 6b 65 79` (not UTF-8), value `"ok"` | `accept` | `reject`, reason `invalid-utf8`, offset 33 (the record) |

The event bytes (`event`, `payload/A3c.bin`) are the vendored vector's, byte for byte; only `mip`, `description`,
`basis` and `expect` differ — `[[mip0018.vectors.own-integrity]]` checks that, and `SHA256SUMS` covers every file
(the vendored runner verifies it before a run).
