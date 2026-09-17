# Recorded contract fixtures — provenance

These five files were produced by the reference contracts of `acedward/mip-erc7496-midnight-contracts`,
not written by hand.

| Field | Value |
|---|---|
| Repository | `git@github.com:acedward/mip-erc7496-midnight-contracts.git` (private) |
| Branch | `feat/00021-mip-315-alignment` |
| Commit | `5cf46f4` — the pushed head of that branch (PR #2). The five files are byte-identical to `ed5f03445e5ed699f0509a344cbb40f17bae6df3` ("feat: the simulator corpus on the MIP's identity and three states"), which produced them; `5cf46f4` only changed documentation. Verified by `diff` against `git show origin/feat/00021-mip-315-alignment:fixtures/simulator/*` on 2026-09-17. |
| Path in that repo | `fixtures/simulator/` |
| Producer | `scripts/export-simulator-fixtures.ts` |
| Toolchain | compactc 0.34.0, `@midnight-ntwrk/compact-runtime` 0.19.0 |
| Standard | MIP PR #315, `mips/mip-xxxx-on-chain-token-metadata.md` @ `f433056` |
| Copied on | 2026-09-17 (project 00021, Phase A task A5) |

**Re-pin if runner H regenerates the corpus.** Phase D's check is a diff of these five files against
`fixtures/simulator/` at whatever head the contracts PR settles on:

```
for f in events mints color-vectors expected-tokens negative-payloads; do
  git -C <contracts clone> show origin/feat/00021-mip-315-alignment:fixtures/simulator/$f.json \
    | diff - token-indexer/test/fixtures/contracts/$f.json && echo "$f identical"
done
```

They are the output of the real compiled Compact templates executed in the Compact simulator, in
process: 69 `mip-xxxx:token-metadata[v1]` events, 16 mints, 15 colour vectors, **17 expected token
rows over 17 identities `(address, domainSep, kind)`** across 11 contracts and 15
`(address, domainSep)` pairs, covering MIP §7.2's three states plus 22 deliberately awkward
payloads (1 ignored, 11 rejected, 10 applied — six of which are applied with a failing Appendix A
projection).

Because the simulator has no chain, the contract addresses are `sha256("umbra:00020:<row id>")`,
there are no block heights or transaction hashes, and `eventId` is the emission order across the
whole corpus. The BYTES — payloads, domain separators, colours, amounts — are the compiled
contracts' own.

Consumed by `token-indexer/test/contract-fixtures.test.ts`. The hand-built payloads in
`token-indexer/test/payload.test.ts` and `token-indexer/test/status-rules.test.ts` are kept
alongside these, not replaced by them.
