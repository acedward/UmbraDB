# Recorded contract fixtures — provenance (MIP-0018, the standard)

These five files were produced by the reference contracts of `acedward/mip-erc7496-midnight-contracts`,
not written by hand. They are the **MIP-0018** corpus; the superseded `mip-xxxx` draft corpus lives
in `../contracts-legacy/` and has its own `SOURCE.md`.

| Field | Value |
|---|---|
| Repository | `git@github.com:acedward/mip-erc7496-midnight-contracts.git` (private) |
| Branch | `main` |
| Commit | **`7d9f6596d66e3953eb6b14ce152f09169de61eda`** (`7d9f659`, 2026-09-22 03:33 UTC, "F2: the on-chain recorder on the final name, and a little-endian decimals"; CI green on `main`) |
| Path in that repo | `fixtures/simulator/` |
| Producer | `scripts/export-simulator-fixtures.ts` |
| Toolchain | compactc 0.34.0, `@midnight-ntwrk/compact-runtime` 0.19.0 |
| Standard | **MIP-0018**, `mips/mip-0018-on-chain-token-metadata.md` @ `37a3471` ([PR #325](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/325)) |
| Event name | `mip-0018:token-metadata[v1]` — every one of the 66 events |
| Copied on | 2026-09-22 (project 00023, Phase F task F1.5), byte-identical to `fixtures/simulator/` at that commit |

They are the output of the real compiled Compact templates executed in the Compact simulator, in
process: **66** `mip-0018:token-metadata[v1]` events, **16** mints, **15** colour vectors,
**17** expected token rows over 17 identities and 15 `(address, domainSep)` pairs across 11
contracts (4 `declared` + 11 `described` + 2 `observed`), and **32** deliberately awkward payloads
(2 ignored, 14 rejected, 16 applied — six of them applied with a failing projection).

Because the simulator has no chain, the contract addresses are `sha256("umbra:00020:<row id>")`,
there are no block heights or transaction hashes, and `eventId` is the emission order across the
whole corpus. The BYTES — payloads, domain separators, colours, amounts — are the compiled
contracts' own.

## What changed against the draft corpus in `../contracts-legacy/`

Every one of the final text's transport changes is visible in these files, which is why both corpora
are kept: the pair is the regression test for "two names, two validators".

| | this corpus (`mip-0018`) | `../contracts-legacy/` (`mip-xxxx`) |
|---|---|---|
| events | **66** | 69 |
| `decimals` | `Uint<128>`, `val-len` **16**, little-endian (`0x06` + 15 NUL for 6) | one big-endian byte, `val-len` 1 |
| SNEB's `metadata` | ONE complete JSON value, `val-len` 141, plus a `/metadata/description` RFC 6901 pointer key | a six-part `metadata/0 … metadata/5` document of JSON fragments |
| `val-type` 5 | present: LMOON **clears** `description` with a Null | absent (5 was reserved) |
| negatives | **32**, `ignored` **2**, and a `key_pointer_invalid` reason | 22, `ignored` 1, no pointer rule |
| first reserved `val-type` | **6** | 5 |
| a 17-byte integer | applied | rejected (`val_type_rule`) |
| token rows / identities / pairs | 17 / 17 / 15 — **unchanged** | 17 / 17 / 15 |

Two details of this corpus that this indexer's fold must match exactly, and does:

* **LMOON's Null is a tombstone, not a deletion.** `expected-tokens.json` lists LMOON's
  `description` in `traits` as `{ valType: 5, valLen: 0, valueHex: "" }` and omits the value it used
  to carry, so "cleared on chain" stays distinguishable from "never said". The corpus's own note
  allows a consumer to delete the row instead; this one keeps it, and
  `[[token-0018-null-clears]]` in `../../status-rules.test.ts` says why (the last-write-wins
  comparison needs something to compare a late-arriving older event against).
* **One of the two `ignored` negatives is a real `mip-xxxx`-named event.** For a conforming
  MIP-0018 consumer that is correct — MIP §1 says a v1 consumer ignores every other name. **This
  consumer deliberately does not ignore it** (owner decision Q27: the Stagenet reference set is
  deployed under that name and is not being redeployed), so `contract-fixtures.test.ts` asserts the
  divergence explicitly rather than letting the corpus's verdict quietly fail.

## Re-pin

```
for f in events mints color-vectors expected-tokens negative-payloads; do
  gh api "repos/acedward/mip-erc7496-midnight-contracts/contents/fixtures/simulator/$f.json?ref=main" \
    -H "Accept: application/vnd.github.raw" \
    | diff - token-indexer/test/fixtures/contracts/$f.json && echo "$f identical"
done
```

Consumed by `token-indexer/test/contract-fixtures.test.ts`, which reads the rules to apply out of
**each payload's own recorded `eventName`** — so a corpus regenerated under a third name throws
rather than being validated under the wrong rules. The hand-built payloads in
`token-indexer/test/payload-0018.test.ts` (the standard), `token-indexer/test/payload.test.ts` (the
draft) and `token-indexer/test/status-rules.test.ts` are kept alongside these, not replaced by them.

## Project 00024-01 — read on UC-1 through an interim view (2026-09-25)

UC-1 (`spec/00024-upstream-spec-changes.md` in the organizer) amends `mip-0018:token-metadata[v1]`
**in place**: `val-len` is two bytes little-endian at offset 66 and the value starts at 68, so one
field may be any length within a [Y] multi-part package. These files were recorded at `7d9f659` in
the one-event layout (one-byte `val-len` at 66, value from 67) and are **not modified**. Until the
contracts repository's regenerated corpus (plan `00024-01` task 01-A5) is re-pinned here,
`contract-fixtures.test.ts` reads every payload recorded under the standard's name through
`uc1ViewOfRecordedPayload`: bytes 0–65 as recorded, `val-len` widened to two bytes, the value
shifted one byte right, the recorded payload's last byte (value padding for every declaration)
dropped. The one negative whose reason depends on the layout (`val-len` 200) is expected as
`val_len_beyond_package` instead of `val_len_too_long`. The draft corpus in `../contracts-legacy/`
is read as recorded.
