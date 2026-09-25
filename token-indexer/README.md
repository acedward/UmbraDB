# token-indexer — every Midnight token, its colour, its on-chain metadata and its life on chain

Projects 00020, 00021 and 00023. Specs: `spec/00020-token-indexer.md` (§5 the API, §6 the
internals), `spec/00021-mip-315-alignment.md` (the delta that put this on the MIP draft, since
superseded by the final text — see below) and
`spec/00023-token-transactions.md` (every on-chain transaction that touched a token) in the
planning workspace. This directory is the whole deliverable; `src/` is untouched apart from four
additive migration files (`src/postgres/migrations/token_index/` and
`src/postgres/migrations/chain_archive/002_tx_result_segments.ts`).

> ## ⚠ Breaking changes in migrations `003_token_activity` and `004_mip_0018` (project 00023)
>
> **`004_mip_0018`** puts this index on the FINAL MIP-0018 text: it adds `name_variant` to
> `token_metadata_events` and `token_metadata_kv`, lets the kv table hold the new Null type, and
> states the two Null rules as CHECKs. It recreates those two tables and deletes every row derived
> from them, because `name_variant` cannot be derived from a stored payload — the events table keeps
> the payload, not the event's name — so backfilling it would be a guess that happens to be right
> for one database and is silently wrong for any other. Same two commands as below.
>
> **The index must be reindexed from scratch.** Migration `003` drops and recreates `tokens` with a
> new identity and adds three tables, so a database built by 00020/00021 cannot be carried forward —
> and does not need to be: everything in this schema is a derivation of `chain_archive`.
>
> ```
> npm run token-indexer -- migrate     # applies 003 and 004; the index is now EMPTY
> npm run token-indexer -- rebuild     # re-seeds NIGHT/DUST and re-scans from block zero
> ```
>
> What changed: `tokens` is keyed by `(net, token_key, kind)` where `token_key` **is the colour**
> for the two native kinds; `address`/`domain_sep` are nullable (NULL only on the new `seen`
> status); `Token.address`/`domainSep` may be `null` in JSON; the `/v1/tokens` cursor format
> changed; three new tables (`token_activity`, `shielded_offers`, `contract_calls`) appear. The MIP
> identity `(address, domainSep, kind)` survives as a UNIQUE index and every route that used it
> still works. The owner authorised this explicitly (question Q3).

## The standard this reads (normative)

**[MIP-0018, On-Chain Token Metadata Emission](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0018-on-chain-token-metadata.md)**
— `mips/mip-0018-on-chain-token-metadata.md` on `main` of
`midnightntwrk/midnight-improvement-proposals` (merged from PR #325; this implementation was
written against `37a3471`). Normative there are the event envelope [1],
the payload layout [2], the `kind` byte [3], token identity [4], key/value handling [5], emission
rules [6], consumer acceptance and input handling [7.1, 7.3–7.4] and versioning [8].

**Appendix A is informative**, and the final text says so in as many words: its examples
"demonstrate transport encodings only… They do not define required fields, key meanings, schema
types, validation beyond [2] and [5.1], projections or display behavior", while §5.2 adds that "A
transport-valid declaration is accepted even if its key is unknown". So the five keys this indexer
projects into columns of its own — `name`, `symbol`, `decimals`, `tokenUri`, `metadata` — are **this
consumer's convention**, not a MIP requirement, and a projection that fails is never a verdict about
the emitting contract. It is also never a rejection: see `projection_error` below.

The MIP is the text; `acedward/mip-erc7496-midnight-contracts` is the reference implementation whose
compiled contracts produce the golden corpus below. This consumer implements the MIP directly and
deliberately shares no code with the contracts.

### Two event names, two validators (owner decision Q27)

The event name **is** the layout version (MIP §8), and the number changed on the way to the final
text. This indexer therefore recognises two names and judges each under its own rules:

| rule | `mip-0018:token-metadata[v1]` (the standard) | `mip-xxxx:token-metadata[v1]` (superseded draft) |
|---|---|---|
| `val-type` 2 | Compact `Uint<8·N>`, `1 ≤ val-len ≤ 31`, **little-endian** | unsigned **big-endian**, `1 ≤ val-len ≤ 16` |
| `val-type` 3 | ONE complete valid JSON value (RFC 8259; scalars and arrays allowed) | valid UTF-8, nothing more |
| `val-type` 5 | **Null** — `val-len` MUST be 0, every value byte ignored; CLEARS the key | reserved → rejects |
| reserved | 6–255 | 5–255 |
| `/metadata/…` keys | MUST be valid RFC 6901 JSON Pointers (only `~0`/`~1`) or the event REJECTS | no rule; plain bytes |
| layout (UC-1, project 00024-01) | a [Y] package of `256·k` bytes: 2-byte little-endian `val-len` at 66, value from 68, any length | one 256-byte event: 1-byte `val-len`, ≤ 189 |
| long values | a [Y] multi-part package; `metadata` is ONE complete JSON value of any length | `metadata/<n>`, parts `0..15`, assembled |

Each name is spelled once, in `ingest/payload.ts` (`MIP_0018_EVENT_NAME`, `LEGACY_EVENT_NAME`), and
every stored row carries its `name_variant` (`mip-0018` or `legacy-mip-xxxx`): on
`token_metadata_events`, on `token_metadata_kv`, in the API's `nameVariant` on every trait and every
event, and as the page's "pre-MIP name" badge.

> **The draft path exists for demonstrative purposes only.** The reference contracts on Stagenet
> were compiled with the draft name as a circuit literal and are **not** being redeployed (owner
> decision Q28), so dropping the draft's rules would empty this explorer's token table. Keeping an
> already-deployed demonstration readable is the only reason that code path exists: it is not a
> compatibility guarantee, not a migration path, and not a pattern to copy. A real MIP-0018 consumer
> implements the left-hand column and nothing else, and MIP §1's "Events of another type or name …
> MUST be ignored by a v1 consumer" is what the draft name deserves once the contracts move. The
> whole path can be deleted in one commit the day they do.

The pre-MIP name `TokenMetadata` that project 00020 shipped is recognised by **neither** validator:
it is **ignored** — not stored, not rejected, not evidence of anything (MIP §1). Contracts deployed
under that name keep whatever rows their mints created, as `observed`.

### Project 00024-01: MIP-0018 values of any length, as multi-part packages

MIP-0018 is amended in place (UC-1 of the organizer's `spec/00024-upstream-spec-changes.md`) and
`mip-0018:token-metadata[v1]` follows the Multi-Part Event rule ([Y], `acedward/compact-multi-part-event`
PR #1, adopted unchanged): the events of that name one contract emits from one intent of one
transaction are ONE package, their 256-byte payloads concatenated in ledger emission order, and one
package is one declaration. The draft name is not opted in and keeps its single-event path.

* **Acquisition** (`ingest/events.ts`, `ingest/raw-event.ts`): the `contractEvents` query requests
  each event's `raw`; its `EventSource.physicalSegment` is the event's intent, its indexer id its
  position, and its phase comes from the archived transcripts (the ledger applies every intent's
  guaranteed part before any fallible segment). Nothing of an opted-in name is grouped, stored or
  folded until the whole `(transaction, contract)` answer is complete and every `raw` decodes — a
  short or undecodable answer stays in `pending_event_lookups` with its reason and stores nothing.
* **Reader** (`ingest/packages.ts`, ported from [Y]'s reference with `ingest/SOURCE.md`): groups by
  (network, contract, name, transaction, segment) on every contract, restores every part to 256
  bytes, keeps trailing zeros, records `guaranteed | fallible | mixed`; a 1 024-part safety ceiling.
* **Decoder** (`ingest/payload.ts`): the UC-1 layout; `val_len_beyond_package` when `68 + val-len`
  runs past the package. **Fold** (`ingest/fold.ts`): last write wins in MIP-0018 §6.2's order
  (block, transaction position, execution order), a package positioned by its first part (P1);
  projections have no 189-byte ceiling under the standard's name.
* **API** (additive): every token carries `origins` for `name`, `symbol`, `decimals`, `tokenUri`,
  `metadata`, `color`, `status` and `mints` — `mip-0018` (with the package: event ids, transaction,
  block, position, segment, parts, phase), `chain`, `derived` (with the rule) or `none` (with the
  reason); traits and metadata events gain `segment`, `parts`, `partEventIds`, `phase`, `txPosition`
  and an `origin` (events also `payloadLength` and `payloadSha256` of the merged package); mints and
  activity rows carry a `chain` origin; `/internal/status` counts `packages`, `multipartPackages` and
  `mixedPackages`. The page is unchanged in this project.
* **Schema** (`005_multipart_packages`): one `token_metadata_events` row per package; `val_len` up
  to 65 535; a fresh database per run (no migration of existing rows).

### Null clears a key, and its row stays

A `val-type` 5 event sets the current value of the exact key to Null (MIP §2.1, §6.2) "without
erasing history". In this index it lands as an ordinary last-write-wins upsert carrying `val_type
5`, `val_len 0` and no value bytes, and **that row is the cleared state**: the projection skips it,
so the column it fed goes empty, while the key keeps its place with the event that cleared it beside
it. Deleting the row would be wrong — it is the only thing the last-write-wins comparison can hold a
late-arriving *older* event against (a retried short lookup, a redelivery, a rebuild mid-flight),
and that event would then resurrect the value the Null retired. Every event, Null included, stays in
`token_metadata_events`.

## What it does

Two sources, nothing else:

1. **The archive** this repo already fills (`chain_archive.transactions` + `chain_blobs`, written by
   `chain-archive-sync/`). Every archived transaction is decoded with `@midnightntwrk/ledger-v9`;
   each `ContractDeploy` becomes a contract row, and every `ContractCall`'s transcript
   `effects.shieldedMints` / `effects.unshieldedMints` becomes a **mint** — a fact, publicly
   declared in the transaction and checked by the ledger before it was applied.
2. **The indexer's `contractEvents` query**, asked only for the `(contract, transaction)` pairs
   whose transcripts contain `log` ops — because a contract event's *contents* are not in the
   transaction bytes (the `log` opcode takes its data from the VM stack), while the *presence and
   count* of those ops is. There is no watch list and no per-contract subscription: the addresses
   come from the transactions themselves.

A token row is created or changed by exactly those two kinds of evidence — an observed mint, or an
applied metadata event — plus the two built-in rows below.

## Token identity and row sources (MIP §3, §4, §6.3, §7.2)

A token is **`(contract address, domainSep, kind)`** with the WHOLE kind byte:

| `kind` | privacy | storage | has a colour? |
|---|---|---|---|
| 0 | unshielded | native | yes |
| 1 | shielded | native | yes |
| 2 | unshielded | ledger | no |
| 3 | shielded | ledger | no (purely informative label) |

`privacy` and `storage` are generated columns of that byte, so they can never disagree with it.

- **A mint is always native**, so it lands on kind 0 or kind 1 by the effect map it came from, and
  on no other row.
- **A declaration populates exactly its own kind's row.** Declaring kind 2 says nothing about kind 0.
  A contract that describes its balance book and mints UTXOs therefore produces two rows — an
  `observed` kind-0 row without a name and a `declared` kind-2 row with one. That is the accurate
  picture, not an error, and the MIP chose it explicitly over flagging a contradiction.
- Rows sharing `(address, domainSep)` may be linked as one asset's several representations:
  `GET /v1/contracts/:address/tokens/:domainSep` returns exactly that set.
- The states are `observed`, `declared`, `described` (MIP §7.2) plus `builtin` for the two seeds.
- A projected key whose value this consumer's column cannot hold (wrong `val-type`, a `decimals`
  above 36, a `tokenUri` that is not an absolute http(s) URL, a `metadata` that is a transport-valid
  JSON scalar rather than an object) does **not** reject the event: the trait is stored with a
  `projection_error` and the column it would have filled is not written. The projections are ours,
  not the MIP's — see "The standard this reads" above.

## Built-in rows (owner decision Q7)

`NIGHT` (unshielded native, colour = 32 zero bytes, 6 decimals) and `DUST` (fee token, 15 decimals)
are seeded by `migrate` and marked `status = 'builtin'` — no contract ever mints them, so the
scanner can never see them.

`DUST` carries `color = NULL`: the ledger types DUST as a **unit** variant with no bytes
(`DustTokenType = { tag: 'dust' }`; `coin-structure/src/coin.rs:285-288`), so there is no 32-byte
colour to store and the spec's `feeToken().raw` does not exist. Its `domain_sep` is the sentinel
`pad(32, "dust")` purely so the primary key can tell it apart from NIGHT's all-zero key. Recorded as
question Q30 of the project.

## Configuration

See `config.ts` for the authoritative table. `PG_URL` is required; `INDEXER_HTTP` is required for
anything that reads events; `NET` defaults to `stagenet`; `TOKEN_API_PORT` defaults to **10020**
(the port baked into the reference contracts' `tokenUri` values).

The archive half of the pipeline is configured separately — see `chain-archive-sync/README.md`
(`ARCHIVE_PG`, `NET`, `NODE_URL`, `INDEXER_URL`, `START_HEIGHT`, `SYNC_CONCURRENCY`,
`SYNC_BACKOFF_*`).

## CLI

```
npm run token-indexer -- migrate                              apply the lineage and seed NIGHT/DUST
npm run token-indexer -- status                               cursors, counters, archive tip
npm run token-indexer -- rebuild                              drop this net's derived rows, re-seed
npm run token-indexer -- derive-color <addressHex> <domainSepHex>
npm run token-indexer -- serve [--api-only|--ingest-only]     scanner + drains + the API and page
```

`status` prints the whole status document, which since 00023 carries five more counters beside the
00020 ones: `activityRows`, `seenTokens`, `shieldedOffers`, `undisclosedShieldedOffers` and
`contractCalls`. Every one is a `COUNT` over stored rows rather than an in-memory tally, so a
restart does not reset them and a `rebuild` makes them agree with a live run by construction.

## Recorded fixtures

`test/fixtures/scan/` holds twelve REAL Stagenet transactions (the six `effectstream/mint-test-tokens`
issuers' deploys at heights 360 721–360 737 and their mint calls at 364 875–364 934), fetched by hash
from the public indexer with their `raw` bytes, `transactionResult` and created outputs. The scanner
runs against those bytes through the real store and the real ledger-v9 decoder.

**Two** golden corpora emitted by the **reference contracts** of
`acedward/mip-erc7496-midnight-contracts`, produced by the real compiled Compact templates in the
Compact simulator — because there are two event names and two validators:

* `test/fixtures/contracts/` — **MIP-0018**: 66 `mip-0018:token-metadata[v1]` events, 16 mints, 15
  colour vectors, 17 expected rows, 32 awkward payloads. Pinned on that repository's `main` @
  `7d9f659`.
* `test/fixtures/contracts-legacy/` — the frozen **PR #315 draft**: 69
  `mip-xxxx:token-metadata[v1]` events and the rest of that set. This is what the Stagenet reference
  set actually emits, and it is not being redeployed.

Each directory's `SOURCE.md` pins its repository, branch and commit and tabulates the differences.
`contract-fixtures.test.ts` runs **every one of its four governed ids over both**, and reads the
rules to apply out of each payload's own recorded `eventName` — so a corpus regenerated under a
third name throws rather than being silently validated under the wrong rules. The pair is the
regression test for "two names, two validators": the same eleven contracts, the same 17 rows, two
transports. It replays both into one Postgres container under two schemas, so the gate's container
count does not change.

The hand-built payloads are kept alongside it, not replaced by it, and there are two sets:
`test/payload.test.ts` is the **draft** validator's suite (every assertion project 00021 wrote,
unchanged) and `test/payload-0018.test.ts` is the **standard's** — seven governed ids, one per rule
the final text moved, ending with `[[token-0018-legacy-pair]]`, which puts single byte strings
through both validators at once. `test/status-rules.test.ts` carries the three fold-level ids
(`[[token-0018-null-clears]]`, `[[token-0018-no-multipart]]`, `[[token-0018-decimals-width]]`).

`test/fixtures/activity/` holds project 00023's four recorded Stagenet transactions — an unshielded
deposit into a contract, a NIGHT pass-through, a shielded mint whose offer delta publishes its
colour, and a **balanced** shielded offer that publishes none — with a golden row set and a golden
transaction view for each. `test/fixtures/activity/SOURCE.md` names them with their hashes, heights
and what each one proves.

## The payload

The 256-byte layout is the one thing the two event names share, so the structural decode never
depends on which name an event carried.

```
 offset  size  field
      0    32  domainSep
     32     1  kind        0 unshielded native, 1 shielded native, 2 unshielded ledger, 3 shielded ledger
     33    32  key         key identifier bytes, NUL-padded; compared after trimming TRAILING NULs, and
                           a key that is not valid UTF-8 is kept as bytes rather than rejected — except
                           a key beginning `/metadata/`, which MUST be a valid RFC 6901 JSON Pointer
                           (MIP §5.1)
     65     1  val-type    0 opaque, 1 UTF-8 string, 2 unsigned integer (Compact `Uint<8·N>`,
                           little-endian, 1..31 bytes), 3 UTF-8 JSON (ONE complete RFC 8259 value),
                           4 UTF-8 URI, 5 Null (`val-len` MUST be 0, the 189 bytes ignored, the key
                           cleared), 6..255 reserved → reject
     66     1  val-len     meaningful bytes of `value`, 0..189; 0 means "present, empty" — which is
                           NOT the same as Null (MIP §6.2)
     67   189  value
```

`serialize<Uint<128>, 16>(6)` is `0x06000000000000000000000000000000` (MIP Appendix A): the least
significant byte comes first. That is not taken on trust from the MIP's prose — the governed test
`[[token-0018-integer-endianness]]` derives those bytes from `@midnight-ntwrk/compact-runtime`
0.19.0, the runtime the MIP names as normative for v1, and asserts this module's encoder and decoder
agree with `toBinaryRepr` and `CompactTypeUnsignedInteger.fromValue` at widths 1, 2, 3, 16 and 31.

One stable reject reason per transport rule: `kind_unknown`, `key_empty`, `key_pointer_invalid`,
`val_type_reserved`, `val_len_too_long`, `val_type_rule`, `payload_size` — the same strings the
reference contracts' negative corpus records, so a diagnostic means one thing in both. Rejected
events are stored with their reason — a contract's malformed claim is evidence about that contract,
and MIP §7.1 asks a consumer to keep rejection reasons available for diagnostics.

## A note on payload width

The on-chain VM hands a `Log` event's bytes out with **trailing NULs trimmed**, while the event
declares its full serialized length. The indexer's GraphQL `payload` field re-pads to exactly 256
bytes, so this does not show through that source — but the node-direct event source the owner plans
next sees the untrimmed form. The parser therefore **zero-extends** a short payload to 256 and
records how short it arrived; only a payload longer than 256 is an error. The bytes stored in
`token_metadata_events.payload` are always the padded 256.

## Colour derivation

`color = persistentCommit(Vector<2, Bytes<32>>([domainSep, address]), pad(32, "midnight:derive_token"))`,
implemented with `@midnight-ntwrk/compact-runtime@0.19.0` — the runtime paired with compactc 0.34.0
and ledger-v9, i.e. the pin the tokens already on Stagenet were built with.

Verified against the live chain: Stagenet transaction
`9cb9a8d1b660dc7df2c0d4fd572d71a7b3cdef86450fe164a3b2d0545bae20bc` (height 364 934) is a `mint`
call on `2e962ef4…b59e` declaring `unshieldedMints = { "mint-test-tokens:utwBTC"·pad32 : 100000000 }`,
and the UTXO it created carries token type
`84392e97f3eb35ba7e41a575b6b77bb33e9025b39eee7bf9bc78fd17d059e575` — exactly what `tokenColor()`
in `color.ts` computes from the domain separator and the address alone.

---

# Project 00023 — a token's life on chain

Spec: `spec/00023-token-transactions.md`. The question it answers is the owner's: *"I click on a
token; I can see the transactions list that has happened on-chain and all the fields we can get
from the public data that the node exposes."*

Nothing new is fetched. Every row below is derived from the raw transaction bytes the archive
already stores, plus the archived `result`/`segments` — the archive stays the only source of facts.

## What becomes a row

One `token_activity` row per **public occurrence** of a colour in one archived transaction:

| `role` | where it comes from | `direction` |
|---|---|---|
| `utxo_out` | an intent's unshielded offer **output** — value, colour, owner, and the UTXO's own identity (`intentHash` + `outputNo`, see below) | `in` |
| `utxo_in` | an unshielded offer **input** — value, colour, the spender's address (`addressFromKey`), and the identity of the UTXO being spent (`intentHash` + `outputNo`) | `out` |
| `contract_in` | a transcript's `effects.unshieldedInputs` — what the contract received, per colour | `in` |
| `contract_out` | `effects.unshieldedOutputs` — what it paid out | `out` |
| `mint` | the transcript mint maps (the same fact `token_mints` stores, repeated here so **one** list carries everything) | `in` |
| `shielded_delta` | a zswap offer's `deltas` entry — the offer's **net imbalance** in that colour | `pool_in` (delta < 0) / `pool_out` (delta > 0) |
| `reward` | a `ClaimRewards` transaction — NIGHT | `in` |

`amount` is **unsigned**; `direction` carries the sign. Amounts are `numeric(39,0)` in the database
and decimal **strings** on the wire, so nothing is ever a lossy JSON number.

**A created UTXO's `intentHash` depends on the section, not on the intent's segment key.** An intent
is evaluated in two segments — its guaranteed part in segment 0, its fallible part in its own — so
`Intent.intentHash(segment)` has two answers and only one of them identifies the UTXO. A `utxo_out`
row therefore carries `intentHash(0)` when the output sat in the **guaranteed** unshielded offer and
`intentHash(<segment>)` when it sat in the **fallible** one. This is measured, not assumed: on the
`ucom-transfer` fixture (a guaranteed offer in intent segment 1) the indexer files both created
UTXOs under `d3fe93c4…`, which is `intentHash(0)`, while `intentHash(1)` is `566e2053…`; on
`night-transfer` and `night-passthrough` (fallible offers) the indexer's value is
`intentHash(<segment>)`. Getting this wrong is invisible until a later transaction spends the UTXO
and its `utxo_in.intentHash` matches nothing. The §4 transaction view keeps each intent's own
`intentHash(segment)` beside it — that is the intent's identity in the segment it is keyed by, a
different fact from the UTXO's.

**Only counted rows are stored** (owner decision Q10). A guaranteed section counts unless the whole
transaction failed; a fallible section counts only if its intent segment succeeded. A movement that
did not happen never appears in a token's list — while `GET /v1/transactions/:hash` still decodes
the whole transaction and marks the uncounted sections.

**DUST is never tracked** (owner decision Q13). 681 of the archive's 683 transactions pay a DUST
fee, so a DUST activity list would be a list of the whole chain. `token_activity.color` is
`NOT NULL` and DUST is the one token type on this ledger with no colour at all, so no code path can
write a DUST row even by accident. A transaction's DUST spends and registrations stay fully visible
inside that transaction's own view, and the DUST token answers `shieldedVisibility: "not-tracked"`.

**No wall-clock time anywhere** (owner decision Q1, FR-012). Not one column and not one JSON field
carries a timestamp: a row is located by `blockHeight` and `txPosition`. The two times that *are*
shown — an intent's `ttl` and a DUST action's `ctime` — are values the **wallet** put inside the
transaction, are labelled as such in the transaction view, and are never the block's time (this
lineage's archive has none).

## What the ledger publishes about a shielded token, and what it does not

This is the point of the feature, so it is stated plainly.

**Public** — and this indexer shows all of it:

* the colour of every unshielded UTXO, input and output, with its exact value and its owner;
* the colour and exact amount of every contract `unshieldedInputs` / `unshieldedOutputs` entry;
* every mint, with its domain separator and amount;
* **every zswap offer's net imbalance per colour** — which is what lets a counterparty, a contract
  mint or a fee balance the offer. An unbalanced offer therefore publishes the colour *and* the
  exact amount;
* every commitment, nullifier and transient, and the contract addresses attached to them;
* the DUST offered for each transaction's fee.

**Private** — and no amount of indexing changes that:

* who received a shielded coin, and who holds how much;
* **a transfer between two users**: the ledger sums each colour's inputs minus outputs and keeps
  only the non-zero results (`zswap/src/structure.rs:551-561`), and the verifier rejects an offer
  that stores a zero (`zswap/src/verify.rs:323-326`). A plain shielded transfer of token X has
  inputs of X equal to outputs of X, so it has **no delta entry for X at all** — only commitments
  and nullifiers. Nobody without the viewing key can say X moved;
* which commitment carries which colour, and the value of any single coin.

So a shielded token's list is complete for mints, burns and contract flows, and **silent** for
user-to-user transfers — and the API says so with a number rather than a slogan:
`GET /v1/shielded-offers?undisclosed=true` lists every offer on the chain whose colour is not
public, and `/internal/status`'s `undisclosedShieldedOffers` counts them. Any of them may be this
token; the ledger does not say.

Attribution of balanced transfers needs a viewing key and is deliberately **out of scope** here —
the token indexer handles no secrets. The 00009 monitor lineage is where that belongs.

## A colour with no contract: the `seen` status

A colour is a commitment over `(domainSep, contractAddress)`, so the pair behind it cannot be
recovered from it. A colour whose mint predates the archive's first block therefore appears in
public data with nothing to name it — 18 UTXO outputs and 3 offer deltas in today's Stagenet
archive are like that.

Such a colour gets a `tokens` row with status **`seen`**: `address` and `domainSep` are `null`, the
colour is the whole identity, and it has a page and a transactions list like any other token. When
a later mint or metadata event reveals `(address, domainSep)` for that colour and kind, **the same
row is completed in place** — never duplicated, because the colour, and therefore the key, did not
change.

That is why `tokens` is keyed by `token_key`:

* kinds 0 and 1 (native): `token_key` **is** the colour;
* kinds 2 and 3 (ledger): no colour exists (MIP §3), so `token_key` is
  `sha256('umbra:ledger' || address || domain_sep || kind)` — a private stand-in that never leaves
  this schema. Every route still addresses those rows by `(address, domainSep, kind)`, which the
  partial unique index `tokens_by_identity` keeps unique.

## Ledger tokens (kinds 2 and 3): introspection under a note

A ledger token has no colour and no UTXOs; its balances live in its contract's state, and reading
them needs that contract's own layout. Its page therefore lists **the contract's calls** —
transaction, block, segment, entry point, transcript op and `log` counts, gas, every effect map,
and whether the section counted — under the owner's note (question Q4):

> **only public data is listed — we do not have access to the code this executes**; what a call
> means for this token's balances is defined by the contract and is not readable here.

`shieldedVisibility` says which of the four a token is: `full` (kind 0), `disclosed-imbalances`
(kind 1), `calls-only` (kinds 2–3) or `not-tracked` (the built-in DUST row).

## Wallet addresses are Bech32m (owner decision Q9)

Bech32m **replaces** the hex wherever Bech32m is the standard display — unshielded owner addresses,
shielded addresses, DUST addresses. It is **never** used for contract addresses, colours,
transaction hashes, commitments, nullifiers or keys, which stay hex.

`api/bech32m.ts` is a dependency-free BIP-350 implementation (Bech32m only; a string valid under the
older Bech32 constant is rejected). The HRP is `mn` + `_addr` + `_<network>` unless mainnet, so
`mn_addr_stagenet1…` here and `mn_addr1…` on mainnet.

**Verified against the chain** (2026-09-21): the payload is the raw 32-byte `UserAddress` with **no
version byte**. The public indexer serves `deposit-toMap`'s spender as
`mn_addr_stagenet1mdtrcaank64kw…` and the ledger reports the same UTXO's owner as
`db563c77…585f`; the two decode to each other exactly, and so does `night-passthrough`'s
`mn_addr_stagenet127xnp9uuxwhh7…` ↔ `578d3097…968e`. `[[token-activity-bech32m]]` pins it.

Every activity row carries `owner` (Bech32m) **and** `ownerHex` — the second is for machine
consumers that join by address, and the page never shows it.

## Routes added

| Route | Returns |
|---|---|
| `GET /v1/contracts/:address/tokens/:domainSep/:kind/transactions?role=&limit&cursor` | `{ items: Activity[], nextCursor }`, newest first. A kind-2/3 token answers an empty page (use `/calls`). |
| `GET /v1/colors/:color/transactions?kind=&role=&limit&cursor` | the same shape, by colour — how a `seen` row's page gets its data |
| `GET /v1/transactions/:hash` | the full public decode of the transaction, computed from the archived bytes **on request**, plus the archive's block facts and this transaction's activity rows. `404 TOKEN_NOT_FOUND` if not archived. |
| `GET /v1/shielded-offers?undisclosed=true\|false&limit&cursor` | every zswap offer on the chain; `undisclosed=true` is the list behind the disclosure panel's figure |
| `GET /v1/contracts/:address/calls?limit&cursor` | every call of the contract with every public field of each transcript |
| `GET /v1/contracts/:address/tokens/:domainSep/:kind` (exists) | `Token` gains `shieldedVisibility`, `activityCount`, `lastActivityHeight` and, for kind 1, `disclosedTransactions` and `undisclosedShieldedOffers` |
| `GET /v1/tokens?status=seen` (exists) | the colours public data proves exist that nothing has named |
| `GET /internal/status` (exists) | `counters` gains `activityRows`, `seenTokens`, `shieldedOffers`, `undisclosedShieldedOffers`, `contractCalls` |

Every list is newest first and keyset-paged on `(block_height DESC, tx_hash, segment, section, role,
item_index)`, so a row the live scanner inserts between two pages cannot make a reader skip or
repeat one. `limit` is ≤ 500, the cursor is opaque, hex is lowercase and unprefixed, and the error
envelope is 00020's.

## Two measured facts worth knowing

* **`feeSpeck` is not the indexer's `fee`.** The transaction view's `feeSpeck` is the sum of the
  DUST spends' `vFee` — what the transaction *offered* — which is the only fee derivable from the
  archived bytes. Measured on all four recorded fixtures, it exceeds the public indexer's `fee` by
  25–53 % (`deposit-toMap`: 248 379 650 240 359 vs 162 873 142 857 143). That is what a wallet's fee
  margin looks like: `Transaction.feesWithMargin` offers more than `Transaction.fees` requires. Do
  not label it "the fee charged". Recorded as question Q18 of the project.
* **The ledger's effect collections are not deterministically ordered.** `Effects`' mint maps, flow
  maps and claimed-commitment lists are Rust sets and maps, and the WASM returns their contents in
  an order that varies between two decodes of the same bytes — the typings say `Nullifier[]`, which
  hides it. `decode.ts` sorts every one of them by its own content, because `token_activity`'s
  `item_index` is a positional counter and an unsorted map would give the same row a different
  primary key on a re-scan. Lists that are genuinely ordered on chain (an offer's
  inputs/outputs/transients, an intent's actions and unshielded outputs) are never reordered.
