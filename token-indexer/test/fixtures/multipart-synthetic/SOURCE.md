# Synthetic MIP-0018 multi-part corpus — interim, until the 01-A5 corpus (project 00024-01)

**Not contract output.** These three JSON files are written by `generate.ts` next to them, with this
repository's own UC-1 encoder (`encodeTokenMetadataUc1`, `token-indexer/ingest/payload.ts`), from
a literal declaration table; the expected rows are a second, hand-written literal table in the same
file. They exist so `[[multipart-0018-golden]]` (`token-indexer/test/multipart-golden.test.ts`) can
run before the contracts repository exports its regenerated simulator corpus (plan
`plans/00024-01-mip-0018.md`, task 01-A5: "events grouped as packages (`segment`, `parts`, part
order), `expected-tokens.json` with the long values").

| Field | Value |
|---|---|
| Produced by | `npx tsx token-indexer/test/fixtures/multipart-synthetic/generate.ts --write` (task B5, 2026-09-25) |
| Layout | MIP-0018 amended in place by UC-1: 2-byte little-endian `val-len` at 66, value from 68, one declaration per package |
| Contents | 16 declarations = 16 packages, 22 parts, 3 contracts (`sha256("umbra:00024:<row>")`), 1 mint; 3 expected token rows |
| Long values | SNEB18 `metadata` 697 B (3 parts); LMOON18 `description` 26 B → Null → 400 B (2 parts); CNST18 `lore` 300 B (2 parts), `name` 202 B (2 parts), `tokenUri` 259 B (2 parts) — the last two are projected (no 189-byte ceiling, spec FR-009) |
| Determinism | the golden test regenerates the corpus in memory and requires the committed files to be byte-identical |

**Replace** with the real corpus when 01-A5 lands: copy `fixtures/simulator/` of
`acedward/mip-0018-midnight-contracts` into `../contracts/` (with its own `SOURCE.md` re-pin),
point `multipart-golden.test.ts` at it, and delete this directory.
