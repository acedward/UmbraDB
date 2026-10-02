# Activity fixtures — project 00023

Seven real Stagenet transactions, fetched **by hash** from the public indexer
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

The first four are third parties' transactions, found in the archive. The three below are this
project's own, made on Stagenet on **2026-09-21** from the recorded test wallet (spec US6, owner
decision Q7, master-plan task C4) with a proof server started and stopped for the occasion. They
exist because the archive contained **no user-to-user transfer of a named token at all** — every
non-NIGHT spend in it is a deposit into somebody's contract — and no balanced shielded transfer
between users either.

| Label | Hash | Block | Raw bytes | Indexer `fee` (SPECK) | What it proves |
|---|---|---|---|---|---|
| `ucom-transfer` | `ad9da752a11321137f341273dcfbc90d2c6a804374ccfd3b33e16957b98b4f41` | 565 368 | 3 817 | 260 835 456 953 929 | **1.000000 UCOM** (colour `10dbdaf2…8269`, contract `de76f303…8acb`) from the wallet's index-0 address to its index-1 address, with 0.500000 returned as change. One spend and two outputs in the intent's **guaranteed** unshielded offer, no zswap offer and no contract call at all — the plain shape a token page must show, with a Bech32m owner on both sides. It is also the fixture that found the `intentHash` bug below. |
| `night-transfer` | `b6c1fb95f8495557b682bd3259ecebc9e5e99e4cd6aea50ba26adf5b1cca0120` | 565 372 | 3 822 | 547 711 320 914 278 | the same, for NIGHT: 1 NIGHT = 1 000 000 STAR to the index-1 address with change, carried this time in the **fallible** unshielded offer. NIGHT resolves to its built-in row rather than creating one. |
| `sstar-balanced-transfer` | `9b9254f4710e6a1893f30d3d396dd07336d190851961a526b106202d273eed75` | 565 376 | 18 527 | 308 389 257 142 858 | **1.000000 SSTAR** (colour `3248c456…5553`, kind 1) from the wallet's shielded address **to itself**: one input, two outputs, no transient, `deltas = []`, and — unlike `balanced-offer-contract` — **no contract address on any coin**. Inputs of SSTAR equal outputs of SSTAR, so the ledger publishes nothing about which colour moved. Zero activity rows, one undisclosed offer, and SSTAR's own colour appears nowhere in the decode. Spec SC-003 on a transfer between users. |

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

- The indexer's `fee` is **not** the sum of the transaction's DUST `vFee` spends. Measured on the
  first four: `vFee` exceeds it by 25–53 % (`deposit-toMap`: 248 379 650 240 359 vs
  162 873 142 857 143), which is what a wallet's fee margin looks like (`feesWithMargin` offers more
  than `fees` requires). Spec §4 asked for this to be verified; the answer is no. Question Q18.
  The three live transfers put a floor under how wide that gap can get, because this project chose
  their margin itself (`FEE_BLOCKS_MARGIN = 100`, the contracts repo's default): `ucom-transfer`
  offered **23 203 453 598 383 638** against an indexer `fee` of **260 835 456 953 929** — a factor
  of **89**. The inequality Q18 pins still holds on all seven, but the ratio is a property of the
  sending wallet's settings, not of the chain, which is one more reason not to call `feeSpeck` "the
  fee" on the page.
- **A created UTXO's intent hash depends on the section it sat in, not on the intent's segment key.**
  `Intent.intentHash(segment)` has one answer per segment, and an intent is evaluated in two: its
  guaranteed part in segment 0, its fallible part in its own. On `ucom-transfer` — a guaranteed
  unshielded offer inside intent segment 1 — the indexer files both created UTXOs under
  `d3fe93c467828b07c39046f71fb7348fc5406ff275056a6bbe1b0ac86b40f3d0`, which is `intentHash(0)`;
  `intentHash(1)` is `566e20535f68a9a13799a371748b019942e5447f4ba03318f990346a8e1999e0` and appears
  nowhere on chain for those UTXOs. On `night-transfer` (fallible, segment 1) and `night-passthrough`
  (fallible, segment 15 274) the indexer's value is `intentHash(<segment>)`. The decoder had always
  used the segment key, which was right for every fallible case and wrong for every guaranteed one —
  invisible until a fixture with a guaranteed created output existed, which is what `ucom-transfer`
  is. Fixed in `ingest/decode.ts` and pinned by `[[token-activity-decode-utxo]]` against the
  indexer's own `unshieldedCreatedOutputs[].intentHash`, which the fixtures record and the test never
  recomputes.
- `unshieldedCreatedOutputs[].owner` / `unshieldedSpentOutputs[].owner` are **Bech32m**
  (`mn_addr_stagenet1…`) and decode to exactly the 32 bytes the ledger reports as the `UtxoOutput`
  owner / `addressFromKey(spend.owner)` — no version byte, no prefix. That is the verification spec
  §0 and sub-plan task A4.3 asked for, done against the indexer's own strings.
- Every transaction's `transactionHash()` equals the hash the archive filed it under.

The builder is the throwaway `.local-00023/build-activity-fixtures.mts` (git-excluded).
