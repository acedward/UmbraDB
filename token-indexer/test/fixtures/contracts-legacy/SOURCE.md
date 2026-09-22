# Recorded contract fixtures — provenance (the SUPERSEDED `mip-xxxx` draft)

These five files were produced by the reference contracts of `acedward/mip-erc7496-midnight-contracts`
against the **PR #315 draft** of the MIP, before a number was assigned. They are frozen: they are
not regenerated, and they are **not** what a conforming MIP-0018 consumer accepts. The standard's
corpus is `../contracts/`, which has its own `SOURCE.md`.

| Field | Value |
|---|---|
| Repository | `git@github.com:acedward/mip-erc7496-midnight-contracts.git` (private) |
| Branch | `main` |
| Commit | **`7d9f6596d66e3953eb6b14ce152f09169de61eda`** (`7d9f659`, 2026-09-22) — where that repository froze this corpus |
| Path in that repo | `fixtures/legacy-mip-xxxx/` |
| Frozen upstream from | `fixtures/simulator/` at commit `fbc04e4`, byte-identical since `ed5f034`, which produced them |
| Producer at the time | `scripts/export-simulator-fixtures.ts` |
| Toolchain | compactc 0.34.0, `@midnight-ntwrk/compact-runtime` 0.19.0 |
| Standard | MIP PR #315, `mips/mip-xxxx-on-chain-token-metadata.md` @ `f433056` |
| Event name | `mip-xxxx:token-metadata[v1]` — the draft's placeholder; every one of the 69 events |
| History in this repository | copied on 2026-09-17 (project 00021 task A5) from `feat/00021-mip-315-alignment` @ `5cf46f4`, re-pin-checked 2026-09-18 at `1721636` (identical), **moved here** from `../contracts/` on 2026-09-22 (project 00023 task F1.5) and verified byte-identical to `fixtures/legacy-mip-xxxx/` at `7d9f659` — the files have not changed once since `ed5f034` produced them |

**69** `mip-xxxx:token-metadata[v1]` events, **16** mints, **15** colour vectors, **17** expected
token rows over 17 identities and 15 `(address, domainSep)` pairs across 11 contracts, and **22**
deliberately awkward payloads (1 ignored, 11 rejected, 10 applied — six of them applied with a
failing projection).

## Why they are still here (owner decision Q27)

**The Stagenet reference set on chain emits this name.** It was deployed while the MIP's number was
still unassigned and was **not** redeployed when MIP-0018 landed (owner decision Q28), so those
events are a different transport — which a conforming v1 consumer ignores (MIP-0018 §1, §8). This
indexer deliberately keeps reading them, under the draft's own rules, **for demonstrative purposes
only**, so that the already-deployed demonstration keeps displaying correctly. This corpus is what
pins that path.

Regenerating it is not possible: the draft's rules are gone from the contracts' generator and from
`token-indexer/ingest/payload.ts`'s standard path. It is frozen by construction.

The differences it exercises are tabulated in `../contracts/SOURCE.md`. In short: `decimals` is one
big-endian byte rather than a little-endian `Uint<128>`; SNEB's `metadata` is a six-part
`metadata/0 … metadata/5` document of JSON fragments rather than one complete value; `val-type` 5 is
reserved rather than Null; there is no `/metadata/` pointer rule; and a 17-byte integer rejects.
**The 17 token rows, 17 identities and 15 pairs are the same in both corpora** — which is the point:
the deployed set must keep folding to the same table.

## Re-pin

```
for f in events mints color-vectors expected-tokens negative-payloads; do
  gh api "repos/acedward/mip-erc7496-midnight-contracts/contents/fixtures/legacy-mip-xxxx/$f.json?ref=main" \
    -H "Accept: application/vnd.github.raw" \
    | diff - token-indexer/test/fixtures/contracts-legacy/$f.json && echo "$f identical"
done
```

Consumed by `token-indexer/test/contract-fixtures.test.ts`, which runs every one of its four
governed ids over BOTH corpora and reads the rules to apply out of each payload's own recorded
`eventName`. The hand-built draft payloads live in `token-indexer/test/payload.test.ts`.
