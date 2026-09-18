# token-indexer — every Midnight token, its colour and its on-chain metadata

Projects 00020 and 00021. Specs: `spec/00020-token-indexer.md` (§5 the API, §6 the internals) and
`spec/00021-mip-315-alignment.md` (the delta that put this on the MIP draft) in the planning
workspace. This directory is the whole deliverable; `src/` is untouched apart from three additive
migration files (`src/postgres/migrations/token_index/` and
`src/postgres/migrations/chain_archive/002_tx_result_segments.ts`).

## The standard this reads (normative)

**MIP PR #315, `mips/mip-xxxx-on-chain-token-metadata.md`** in
`midnightntwrk/midnight-improvement-proposals` (head `f433056`, branch
`mip-on-chain-token-metadata`) — "On-Chain Token Metadata Emission". Normative there are the event
envelope [1], the payload layout [2], the `kind` byte [3], token identity [4], key/value handling
[5], emission rules [6], consumer rules [7] and versioning [8]; Appendix A's well-known keys are
informative but SHOULD-level for interoperability, and this indexer follows them.

The MIP is the text; `acedward/mip-erc7496-midnight-contracts` is the reference implementation whose
compiled contracts produce the golden corpus below. This consumer implements the MIP directly and
deliberately shares no code with the contracts.

**Two consequences worth stating out loud.**

* The event name is `pad(32, "mip-xxxx:token-metadata[v1]")`, and `xxxx` is a placeholder until the
  MIP is assigned its number. The name is spelled once, in
  `ingest/payload.ts`'s `TOKEN_METADATA_EVENT_NAME`; when the number is assigned that line changes
  and every emitting contract has to be redeployed, because on their side the name is a circuit
  literal.
* The pre-MIP name `TokenMetadata` that project 00020 shipped is **ignored** — not stored, not
  rejected, not evidence of anything (MIP §1: "Any other event MUST be ignored"). Contracts deployed
  under the old name keep whatever rows their mints created, as `observed`.

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
- An Appendix A key whose value breaks Appendix A's rule (wrong `val-type`, a `decimals` above 36, a
  `tokenUri` that is not an absolute http(s) URL) does **not** reject the event: the trait is stored
  with a `projection_error` and the column it would have filled is not written.

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
```

## Recorded fixtures

`test/fixtures/scan/` holds twelve REAL Stagenet transactions (the six `effectstream/mint-test-tokens`
issuers' deploys at heights 360 721–360 737 and their mint calls at 364 875–364 934), fetched by hash
from the public indexer with their `raw` bytes, `transactionResult` and created outputs. The scanner
runs against those bytes through the real store and the real ledger-v9 decoder.

`test/fixtures/contracts/` holds the golden corpus emitted by the **reference contracts** of
`acedward/mip-erc7496-midnight-contracts`, produced by the real compiled Compact templates in the
Compact simulator; `test/fixtures/contracts/SOURCE.md` pins the exact repository, branch and commit.
The corpus is currently the **pre-MIP (00020) one**, so `test/contract-fixtures.test.ts` is skipped
until the regenerated corpus lands — see the skip reason in that file. The hand-built payloads in
`test/payload.test.ts` and `test/status-rules.test.ts` are kept alongside it, not replaced by it.

## The payload

```
 offset  size  field
      0    32  domainSep
     32     1  kind        0 unshielded native, 1 shielded native, 2 unshielded ledger, 3 shielded ledger
     33    32  key         UTF-8, NUL-padded; compared after trimming TRAILING NULs, and a key that is
                           not valid UTF-8 is kept as bytes rather than rejected (MIP §5.1)
     65     1  val-type    0 opaque, 1 UTF-8 string, 2 unsigned big-endian integer, 3 UTF-8 JSON,
                           4 UTF-8 URI, 5..255 reserved → reject
     66     1  val-len     meaningful bytes of `value`, 0..189; 0 means "present, empty"
     67   189  value
```

One stable reject reason per transport rule: `kind_unknown`, `key_empty`, `val_type_reserved`,
`val_len_too_long`, `val_type_rule`, `payload_size`. Rejected events are stored with their reason —
a contract's malformed claim is evidence about that contract.

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
