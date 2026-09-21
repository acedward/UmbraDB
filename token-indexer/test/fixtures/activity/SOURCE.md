# Activity fixtures — project 00023

Four real Stagenet transactions, fetched **by hash** from the public indexer
`https://indexer.stagenet.shielded.tools/api/v4/graphql` on **2026-09-21**, in the same
`ScanFixture` shape the 00020 scan fixtures use (`token-indexer/test/helpers/archive-fixture.ts`).
The block around each one is synthesised when a test seeds an archive — the transaction bytes, the
only thing under test, are the chain's own.

They live here rather than in `fixtures/scan/` because `[[token-scan-mints]]` pins that directory's
contents at exactly the twelve 00020 mint fixtures.

| Label | Hash | Block | Raw bytes | Indexer `fee` (SPECK) | What it proves |
|---|---|---|---|---|---|
| `deposit-toMap` | `f5033d4f20e8419921f4633eee0e021017ab5b6bb07f9efb2ecad91959a40396` | 500 750 | 10 434 | 162 873 142 857 143 | An unshielded token deposited into a contract: one **fallible** UTXO spend of 200 000 units of colour `254fc193…bc47` by `db563c77…585f` (spending `61cfd2c6…/0`), and the `toMap` call on `bc4fa552…094b` declaring `unshieldedInputs` for the same colour and amount. Two activity rows and nothing else (spec US1 scenario 1). Also carries a DUST fee spend, which is never tracked (Q13). |
| `night-passthrough` | `69ea91eb4bf6346c1dcc0dab326740baa876664b20140c09a5df4af3f68385ca` | 500 257 | 9 632 | 398 392 602 471 429 | 10 STAR of NIGHT spent and re-created for the same owner `578d3097…968e` around a `register_domain_for` call on `29be1e64…f116`, whose effects declare `unshieldedInputs` **and** `unshieldedOutputs` of NIGHT. All four unshielded roles in one transaction (US1 scenario 2). |
| `shielded-mint-delta` | `bd0360d461843d2c337b04b9353c8b95833dc1d60780e28a62530a53abe024f9` | 497 182 | 13 819 | 264 747 657 142 858 | `mint_shielded` on `4fc92e15…e92f`: the guaranteed zswap offer carries `deltas {d086a9e2…2cea: −1}` — the mint made public — plus one user output commitment `a94f9761…`. The `shielded_delta` row and the `mint` row agree about the colour independently (US1 scenario 3). |
| `balanced-offer-contract` | `c235e6b20f5c66771719ec5235d109ea664eb6dd576fe6396ccbfaed80fa6036` | 497 189 | 34 092 | 507 246 490 812 504 | `deposit_shielded` on `ef8b7033…7c8d`: a **balanced** guaranteed zswap offer (`deltas = []`) with two inputs, one output and one transient, most of them contract-owned. **Zero** activity rows: nothing about which colour moved is public. The negative case the disclosure panel rests on (US1 scenario 4, US4). |

## Goldens

`<label>.rows.json` is the activity rows `decodeTokenFlows` produces (amounts as decimal strings);
`<label>.view.json` is the spec §4 public transaction view, minus the fields that come from the
archive rather than from the bytes. Both are asserted equal on every run by
`token-indexer/test/activity-decode.test.ts` and rewritten by

```
UPDATE_ACTIVITY_GOLDENS=1 npx vitest run token-indexer/test/activity-decode.test.ts
```

Review the diff before committing: a golden that changed silently is a decoder that changed
silently.

## Recorded observations

- The indexer's `fee` is **not** the sum of the transaction's DUST `vFee` spends. Measured on all
  four: `vFee` exceeds it by 25–53 % (`deposit-toMap`: 248 379 650 240 359 vs 162 873 142 857 143),
  which is what a wallet's fee margin looks like (`feesWithMargin` offers more than `fees` requires).
  Spec §4 asked for this to be verified; the answer is no. Question Q18.
- `unshieldedCreatedOutputs[].owner` / `unshieldedSpentOutputs[].owner` are **Bech32m**
  (`mn_addr_stagenet1…`) and decode to exactly the 32 bytes the ledger reports as the `UtxoOutput`
  owner / `addressFromKey(spend.owner)` — no version byte, no prefix. That is the verification spec
  §0 and sub-plan task A4.3 asked for, done against the indexer's own strings.
- Every transaction's `transactionHash()` equals the hash the archive filed it under.

The builder is the throwaway `.local-00023/build-activity-fixtures.mts` (git-excluded).
