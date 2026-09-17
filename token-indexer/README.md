# token-indexer — every Midnight token, its colour and its on-chain metadata

Project 00020. Spec: `spec/00020-token-indexer.md` in the planning workspace (§4 is the on-chain
standard, §5 the API, §6 the internals). This directory is the whole deliverable; `src/` is
untouched apart from two additive migration files (`src/postgres/migrations/token_index/` and
`src/postgres/migrations/chain_archive/002_tx_result_segments.ts`).

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
emitted `TokenMetadata` event in the documented format — plus the two built-in rows below.

## Row sources (normative, spec §3 / FR-017)

- **Minting is always native.** A mint effect exists only for UTxO tokens, so an observed mint sets
  `storage = native` unconditionally and `kind` from the map it came from. No event can change
  either afterwards; a contradicting event marks the row `inconsistent` and is kept as evidence.
- **Only emitted metadata can describe a ledger token**, and emitted metadata may also describe a
  native one.
- Nothing declared ever overwrites something observed.

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
