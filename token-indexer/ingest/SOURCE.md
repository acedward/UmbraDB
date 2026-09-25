# Ported code in `token-indexer/ingest/` — provenance

Only the files listed here contain code ported from another repository. Everything else in this
directory is this repository's own.

| Field | Value |
|---|---|
| Upstream | `https://github.com/acedward/compact-multi-part-event.git` — the Multi-Part Event proposal ([Y], `mip-xxxx:multi-part[v1]`) and its reference reader |
| Pinned at | PR #1, commit **`f2425f2722615c167b7b94814d6f3f282375479e`** ("Complete and clarify multipart event proposal draft") |
| License | Apache-2.0 (upstream and this repository) |
| Normative text | `MIP-SPEC-DRAFT.md` §3–§5 and its Testing vectors, adopted UNCHANGED (spec 00024 §0); the reference code is implementation evidence, not the definition |
| Ported on | 2026-09-25, project 00024-01 (plan `plans/00024-01-mip-0018.md`, task B3) |

## Files

| This repository | Upstream file (SHA-256 at the pin) | What was ported |
|---|---|---|
| `packages.ts` — `readPackages`, `restorePart` | `src/reader/packages.ts` (`75b90193ec093663bb0025c092b7050935e207c57304f77e57fd7ff06eb35d92`), `src/reader/event.ts` (`844d882fb02c19c20eea087631d9127c30e35e077b6d634b4e02903d95c26049`) | the grouping key (network, contract, name, transaction, physical segment), ordering by position, identical-redelivery tolerance, width restoration, concatenation, output order |

The differences from the reference are listed, with their reasons, in the header comment of
`packages.ts` (names opted in rather than `(contract, name)` pairs; no input bounds but the 1 024-part
safety ceiling; a conflicting delivery is a lookup error; each part carries its phase).

## Re-check

```
git -C <clone of compact-multi-part-event> rev-parse HEAD        # f2425f2722615c167b7b94814d6f3f282375479e
sha256sum src/reader/packages.ts src/reader/event.ts              # the two hashes above
```

A change upstream is re-ported deliberately, with this table updated; the [Y] normative vectors in
`token-indexer/test/packages.test.ts` (reader level) and `token-indexer/test/multipart-vectors.test.ts`
(through the scanner) are the regression tests.
