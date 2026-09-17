# Recorded contract fixtures — provenance

These five files were produced by the reference contracts of project 00020-02, not written by hand.

| Field | Value |
|---|---|
| Repository | `git@github.com:acedward/mip-erc7496-midnight-contracts.git` (private) |
| Branch | `feat/00020-02-initial` |
| Commit | `576853ca8ab93b6c7eb748f4524aafc122c0c866` |
| Path in that repo | `fixtures/simulator/` |
| Producer | `scripts/export-simulator-fixtures.ts` |
| Toolchain | compactc 0.34.0, `@midnight-ntwrk/compact-runtime` 0.19.0 |
| Copied on | 2026-09-17 |

They are the output of the real compiled Compact templates executed in the Compact simulator, in
process: 69 `TokenMetadata` events, 16 mints, 15 colour vectors, 16 expected token rows covering all
four `status` values of spec §6.2, and 7 deliberately malformed payloads.

Because the simulator has no chain, the contract addresses are `sha256("umbra:00020:<row id>")`,
there are no block heights or transaction hashes, and `eventId` is the emission order across the
whole corpus. The BYTES — payloads, domain separators, colours, amounts — are the compiled
contracts' own.

Consumed by `token-indexer/test/contract-fixtures.test.ts`. The hand-built negatives in
`token-indexer/test/payload.test.ts` are kept alongside these, not replaced by them.
