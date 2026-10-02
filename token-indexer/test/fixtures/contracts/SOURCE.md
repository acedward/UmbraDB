# Recorded contract fixtures — provenance (MIP-0018 on UC-1, the MIP-18 set)

These five JSON files were produced by the generated **MIP-18** contracts (`LSUN18` … `LLIAR18`) of
`acedward/mip-0018-midnight-contracts`, executed in the Compact simulator — contract output, not
written by hand. They are the **MIP-0018** corpus on the **UC-1 layout** (project 00024-01: an
amendment in development of `mip-0018:token-metadata[v1]` — 2-byte little-endian `val-len` at
offset 66, value from offset 68, one declaration per [Y] multi-part package of `256·k` bytes). The
superseded `mip-xxxx` draft corpus lives in `../contracts-legacy/` and has its own `SOURCE.md`.

| Field | Value |
|---|---|
| Repository | `git@github.com:acedward/mip-0018-midnight-contracts.git` (formerly `mip-erc7496-midnight-contracts`) |
| Branch | `feat/00024-01-mip-0018` (project 00024-01; PR to `main` opened in 01-D) |
| Commit | **`cb6c675ddbbb4a82d0bcaf87ad863c934becce31`** (`cb6c675`, 2026-09-26, "00024-01-A6b: CNST18 deployed in stages — one circuit per declaration again, maintenance key inserts (owner Q20 (a))") |
| Path in that repo | `fixtures/simulator/` |
| Producer | `scripts/export-simulator-fixtures.ts` (its own provenance: `PRODUCER-SOURCE.md` here, byte-identical to `fixtures/simulator/SOURCE.md` at that commit) |
| Toolchain | compactc 0.34.0, `@midnight-ntwrk/compact-runtime` 0.19.0 |
| Event name | `mip-0018:token-metadata[v1]` — every one of the 86 events |
| Copied on | 2026-09-26 (project 00024-01, phase 01-C step 1) with `git show cb6c675:fixtures/simulator/<file>`, byte-identical to the commit |

| File | SHA-256 (equal to `PRODUCER-SOURCE.md`'s "Outputs" table) |
|---|---|
| `events.json` | `adb602dfbb4af99564b845e843de2862fc4a0c0ab2b8cfd11d4e5cfee97c3d16` |
| `expected-tokens.json` | `668ee3301f09cf12556c0af2b47e10ebe92c46541837e118f63227c2b7434f89` |
| `mints.json` | `6a0ebbaa47f9fa48fe552533b6a5f1acbae111d5d4f007711858e23cf263edb2` |
| `color-vectors.json` | `9d5af0eed68dacb333d6c6e03aa316ac37eef5fa7ee5f88dc4445398b9293216` |
| `negative-payloads.json` | `8b896e73a409bf1a790b4d54e4f9109620551dc8f11d3c2c16596171773e7751` |
| `PRODUCER-SOURCE.md` | `47859af6928d677b253082c406acd58f6334fd675d478e7ec1176602c0678bca` |

`multipart-golden.test.ts` (`[[multipart-0018-golden]]`) checks these six SHA-256s before it reads
anything, so an edited file fails the golden test rather than changing what it proves.

## Contents

* `events.json` — `events`: **86** `mip-0018:token-metadata[v1]` Misc events as a chain delivers them
  (256 bytes each; `eventId` = emission order, `packageId`, `part` 1..k); `packages`: the **82**
  packages they form (79 × 1 part, 2 × 2, 1 × 3), each ONE declaration with its event ids in order,
  the merged `256·k`-byte `payloadHex`, `payloadSha256` and the decoded fields. Long values: SNEB18
  `metadata` 677 B (3 parts), LMOON18 `description` 377 B (2 parts, after a 52-byte value and a Null),
  CNST18 Orion `metadata` 279 B (2 parts).
* `expected-tokens.json` — **17** rows over 17 identities and 15 `(address, domainSep)` pairs across
  11 contracts: 4 `declared`, 11 `described`, 2 `observed` (SGHOST18, minted and never described —
  owner Q19 (b); LLIAR18's kind-0 mint). Every described or declared row carries a `repository`
  trait (val-type 4). Traits carry `parts`; a JSON-object `metadata` is also projected (SNEB18, CNST18
  Orion).
* `mints.json` — 16 mints; `color-vectors.json` — 15 `(domainSep, address) → colour` vectors, each
  checked by the producer against the contract's own `tokenColor()`.
* `negative-payloads.json` — **40** packages that are not simply applied (2 ignored, 17 rejected, 21
  applied — six with a failing Appendix A projection), each with `parts` and `partPayloadsHex`,
  including the UC-1 cases: a declared length beyond the package in 1, 2 and 3 parts, a package filled
  exactly, a UTF-8 character across a part boundary, a JSON value cut by `val-len`, non-zero bytes after
  the value in 1 and 2 parts, and two declarations merged by one intent (spec 00024 Q11).

The simulator has no chain: contract addresses are `sha256("umbra:00024:<row id>")`, `txStandIn`
is `sha256("umbra:00024:sim:<row>:<step>")` (one transaction per circuit call) and `segmentStandIn`
is 1; there are no block heights or indexer event ids. The BYTES — payloads, domain separators,
colours, amounts — are the compiled contracts' own.

## What changed against the draft corpus in `../contracts-legacy/`

| | this corpus (`mip-0018`, UC-1, MIP-18 set) | `../contracts-legacy/` (`mip-xxxx`) |
|---|---|---|
| contracts | the `…18` variant: ids/symbols `LSUN18` …, names `"… · MIP-18"`, domains `umbra:lsun18` …, `cnst18:<piece>`, addresses `sha256("umbra:00024:<ID>")` | `LSUN` …, `umbra:lsun` …, addresses `sha256("umbra:00020:<row>")` |
| transport | [Y] packages: 86 events → **82** declarations (one per circuit call) | **69** events, one declaration each |
| `val-len` | 2 bytes little-endian at 66, value from 68, any length | 1 byte at 66, value from 67, ≤ 189 |
| `decimals` | `Uint<128>`, `val-len` **16**, little-endian | one big-endian byte, `val-len` 1 |
| SNEB's `metadata` | ONE complete JSON value of 677 bytes in 3 parts, plus a `/metadata/description` pointer key | a six-part `metadata/0 … metadata/5` document of JSON fragments |
| `val-type` 5 | present: LMOON18 declares `description`, clears it with a Null, then declares a 377-byte one | absent (5 was reserved) |
| `repository` | a val-type-4 trait on every row that declares anything | absent |
| negatives | **40**, 2 ignored, 17 rejected (`val_len_beyond_package`, `key_pointer_invalid` among the reasons) | 22, 1 ignored, no pointer rule |
| token rows / identities / pairs / states | 17 / 17 / 15 / 4 declared, 11 described, 2 observed — **unchanged** | 17 / 17 / 15 / same |
| colours | different bytes (the address and the domain separator changed), same 15 vectors per row | — |

* **LMOON18's Null is history, not the current value**: the fold keeps all three declarations in
  `token_metadata_events` (52-byte text → Null → 377-byte text, the last in two parts) and the current
  `description` is the long value. The Null-as-tombstone rule itself is `[[token-0018-null-clears]]`
  in `../../status-rules.test.ts`.
* **One of the two `ignored` negatives is a real `mip-xxxx`-named event.** For a conforming MIP-0018
  consumer that is correct — MIP §1 says a v1 consumer ignores every other name. **This consumer
  deliberately does not ignore it** (owner decision Q27: the Stagenet reference set is deployed under
  that name and is not being redeployed), so `contract-fixtures.test.ts` asserts the divergence
  explicitly rather than letting the corpus's verdict quietly fail.

## History

* 2026-09-22 (project 00023, F1.5) — first pinned from `acedward/mip-erc7496-midnight-contracts`
  `main` @ `7d9f659` (66 events in the one-event layout).
* 2026-09-25 (project 00024-01, B4) — read on UC-1 through an interim view in
  `contract-fixtures.test.ts` (`uc1ViewOfRecordedPayload`) until the regenerated corpus existed.
* 2026-09-26 (project 00024-01, 01-C) — re-pinned from `feat/00024-01-mip-0018` @ `cb6c675` (this
  file); the interim view is gone, and `[[multipart-0018-golden]]` reads this corpus instead of the
  synthetic one it used during 01-B.

## Re-pin

```
C=<clone of acedward/mip-0018-midnight-contracts>
for f in events mints color-vectors expected-tokens negative-payloads; do
  git -C "$C" show <commit>:fixtures/simulator/$f.json > token-indexer/test/fixtures/contracts/$f.json
done
git -C "$C" show <commit>:fixtures/simulator/SOURCE.md > token-indexer/test/fixtures/contracts/PRODUCER-SOURCE.md
sha256sum token-indexer/test/fixtures/contracts/*.json token-indexer/test/fixtures/contracts/PRODUCER-SOURCE.md
```

then update the commit and the SHA-256 table above (and the pinned hashes in
`multipart-golden.test.ts`).

Consumed by `token-indexer/test/contract-fixtures.test.ts` (four governed ids, over both corpora;
the rules to apply are read out of **each payload's own recorded `eventName`**, so a corpus
regenerated under a third name throws rather than being validated under the wrong rules) and by
`token-indexer/test/multipart-golden.test.ts` (`[[multipart-0018-golden]]`: the [Y] reader rebuilds
every package from its recorded parts, the UC-1 decoder reads it, the fold produces the expected
rows). The hand-built payloads in `token-indexer/test/payload-0018.test.ts` (the standard),
`token-indexer/test/payload.test.ts` (the draft) and `token-indexer/test/status-rules.test.ts` are
kept alongside these, not replaced by them.
