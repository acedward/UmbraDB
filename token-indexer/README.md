# UmbraDB token indexer — MIP-0018 (final)

The token indexer reads finalized Midnight blocks from UmbraDB's chain archive, finds every token minted or seen in
public data, decodes MIP-0018 token-metadata events from the archived raw transactions, keeps each token's current
metadata in Postgres, and serves it as a read-only JSON API and an explorer page.

## What it implements

- **MIP-0018, final text only**: [`midnightntwrk/midnight-improvement-proposals` PR #340 @ `274a84f221bcfc17e4b73e2c8b32fd8c028ea092`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/274a84f221bcfc17e4b73e2c8b32fd8c028ea092/mips/mip-0018-on-chain-token-metadata.md)
  (SHA-256 `e64fe1429b9f7589077f1323572cf5c3ffa90c7c96690242a9e76d2658058d8b`): `Misc` events named exactly
  `mip-0018:token-metadata[v1]`, the payload checks, value types, latest value per key, **per-key tombstones** (a Null
  record deletes its field; an identity with no field left is not referenced anywhere), common fields, symbol groups,
  the color lookup (`rawTokenType(domainSep, contractAddress)`), zero extension of trimmed ledger data.
- **Not compatible with earlier drafts of MIP-0018.** Nothing of an earlier layout is decoded, stored or served; an
  event with any other name (other versions included) is ignored like any other `Misc` event.
- **Beyond the MIP** (owner decisions, project 00026 Q3): hard-coded NIGHT and DUST rows, "seen" tokens (any color in
  public data, also without a known mint), each token's activity (mints, UTXOs created/spent, contract in/out,
  shielded offer deltas, metadata transactions) with Bech32m wallet addresses, and a ✓/⚠ mark per token (✓ = usable
  `name`, `symbol`, `decimals`, no rejected MIP-0018 event and no unresolved log from its contract; ⚠ partial,
  incorrect or unresolved; no mark without MIP-0018 events). The mark says the metadata is correctly published — it is not an endorsement of the token.
- Network: **Stagenet** (Midnight node 2.x). Never fetches a URI. Block heights only (no wall-clock time).

Conformance: every MUST/SHOULD of the final text is mapped to a test in [CONFORMANCE.md](CONFORMANCE.md).

## Architecture

```
Stagenet node RPC + indexer GraphQL (finalized blocks)
   │  chain-archive-sync/sync-cli.ts  --from/--to, polite (4 in flight, ≥ 250 ms per endpoint, back-off)
   ▼
Postgres schema chain_archive      blocks, raw transactions, per-transaction result + per-segment outcomes,
   │                               one atomic checkpoint per block
   │  token-indexer/mip0018/scan.ts (scan-cli.ts, or the loop inside serve)
   │    applied-parts.ts  decode each raw transaction (ledger-v9); keep only applied parts (guaranteed part
   │                      unless FAILURE, each fallible segment only if it succeeded), in ledger order
   │                      read each logged value with the ledger's own decode_event rule; a log op whose
   │                      value the raw transaction does not show → unresolved (see "Known limitation")
   │    vendored codec    classify each Misc event: accept / reject (reason) / ignore
   │    state.ts          per-key rules (one pure module, also used by the vector adapters)
   ▼
Postgres schema mip0018            mints (color table), color sightings, contract actions, events (classification,
   │                               no values served), fields (latest value per key), activity, NIGHT/DUST, cursor —
   │                               one transaction per block
   │  read helpers: tokens.ts, metadata.ts, events.ts, activity.ts
   ▼
read-only JSON API (api.ts)  ──►  explorer page GET /ui (ui/)
```

Everything a block adds commits in one Postgres transaction with the scan cursor, so a kill at any point resumes
without a gap or a duplicate; `removeAbove(height)` deletes the rows above a height and recomputes the fields from
the stored events (the MIP's reorganization rule; the indexer itself follows finalized blocks only).

## How to run

The indexer needs only a Postgres 17 database (no secrets). Commands run from the repository root.

```sh
export PG_URL=postgres://user:pass@127.0.0.1:5432/umbradb

# 1. Archive a range of finalized Stagenet blocks (resumable; a second run continues at the cursor).
ARCHIVE_PG=$PG_URL NET=stagenet \
NODE_URL=https://rpc.stagenet.shielded.tools INDEXER_URL=https://indexer.stagenet.shielded.tools/api/v4/graphql \
  node --import tsx chain-archive-sync/sync-cli.ts --from 714485 --to 715183

# 2a. Scan the archived range into the mip0018 schema (exits at --to or at the archive's end; resumable).
node --import tsx token-indexer/mip0018/scan-cli.ts --network stagenet --from 714485 --to 715183

# 2b. Or serve: the API plus the scan loop following the archive (default 127.0.0.1:10026)
node --import tsx token-indexer/mip0018/serve-cli.ts --network stagenet
#     read-only replica: no scan, no migration
node --import tsx token-indexer/mip0018/serve-cli.ts --network stagenet --api-only
```

- `sync-cli.ts` flags and environment: see its header (`--from`, `--to`, `--concurrency`, `--max-blocks`,
  `--min-interval-ms`; `SYNC_BACKOFF_*`). Without `--to` it follows the finalized tip.
- **An archive synced before this PR cannot be scanned.** The base's `chain-archive-sync` never stored a
  transaction's result, and migration `chain_archive/002_transaction_segments` adds the per-segment outcomes as
  `NULL`, so such an archive has no result on any transaction: the MIP-0018 scan stops at its first regular
  transaction ("has no stored result"; it never guesses which parts applied, owner decision Q20) and `serve` reports
  `scanner: stalled`. The sync does not re-ingest below its cursor, so use a fresh deployment (owner decision Q7) or
  re-sync the range with this version into a fresh schema (`ARCHIVE_SCHEMA=chain_archive_v2 … sync-cli.ts --from …`,
  then `--archive-schema chain_archive_v2` for `scan-cli.ts` / `serve-cli.ts`).
- **A `mip0018` schema created by an earlier build of this PR must be dropped and recreated.** The `mip0018`
  migrations (`src/postgres/migrations/mip0018/`) were edited in place before the first release (the schema is new,
  owner decision Q7: fresh deployment), and the migration runner records applied migrations by name only, so it never
  re-runs an edited one: such a schema keeps the earlier tables, checks and indexes (for example the CHECK that refuses
  `unresolved` event rows, or a missing table), and the scan or the API fails on it. Drop it
  (`DROP SCHEMA mip0018 CASCADE`, or the schema given with `--schema`) and start `scan-cli.ts` / `serve-cli.ts` again:
  the schema is recreated and the scan rebuilds every row from the chain archive (nothing in it is primary data).
- `scan-cli.ts`: `--from`, `--to`, `--max-blocks`, `--schema` (default `mip0018`), `--archive-schema` (default
  `chain_archive`). The scan stops with an error at a transaction it cannot decode (never skips it). A `log` op
  whose logged value is not in the raw transaction does not stop it: it is stored as `unresolved` (see below).
- API: [API.md](API.md) (endpoints, JSON shapes, errors, pagination). Explorer page: `GET /ui`,
  [ui/README.md](mip0018/ui/README.md).

## Known limitation: events the raw transaction does not show

The ledger's `log` op logs whatever value is on top of the contract's VM stack; the ledger turns a well-formed
`[version, type, data]` triple into an event of that type and any other value into a `Misc` event (version 0) whose
data is the whole value (`midnight-ledger` v2.0.0-rc.4 `onchain-vm/src/vm.rs` `decode_event`). The indexer applies
exactly that rule — but it reads events from the raw transactions (owner decision Q4), and a raw transaction shows the
logged value only when the VM reaches the `log` op straight from a `push` op right before it. Every recorded Stagenet
event has that shape (Compact emits `push [version, type, data]; log`).

A `log` op whose operand comes from anything else (`dup`, `swap`, `idx`, …: the contract's state), or that runs on
some paths of the program only (a `branch` on a value of the contract's state), cannot be read without the contract's
state. The scan does not stop on it (anyone could halt the indexer with a hand-built circuit) and does not drop it: it
stores an event row classified `unresolved` with its reason (`log-operand-not-pushed`, `log-conditionally-executed`),
never applies it, serves it in `/v1/events` with its position, and counts such rows in `/v1/status`
(`unresolvedEvents`). While a contract has an unresolved log, its tokens' metadata in this indexer may differ from what
the ledger emitted (MIP "Applying records": state MUST equal every accepted event), so none of its tokens keeps a
clean ✓: each is marked ⚠ `unresolved` (reason `unresolved-log`, with the count and the first positions), or ⚠
`incorrect` when the contract also has a rejected event. A `log` op that no successful run
of the program reaches logs nothing, on the ledger and here. Decision and alternatives: project 00026 Q33, assumption
A23 (under review by the owner).

## Tests and fixtures

All tests run in the repository's required gate (`npm run test:conformance -- --maxWorkers=2`, Vitest +
Testcontainers Postgres 17; the page's browser tests need a Chromium — see the page README). No test touches the
network: Stagenet data comes from recorded fixtures.

| What | Where |
|---|---|
| MIP vectors through two adapters (pure state module; real Postgres path): 59 reference normative, 43 informative, 8 UmbraDB versions | `test/mip0018-vectors.test.ts`, `test/mip0018-vectors-pg.test.ts` |
| Decoder, scan, events, metadata state, activity, Bech32m, schema | `test/mip0018-{applied-parts,scan,events,metadata,activity,bech32m,schema,state}.test.ts` |
| The twelve Stagenet cases (C01–C10, IDX, U1) against the reference's expectations | `test/mip0018-metadata.test.ts`, `test/mip0018-cases.test.ts` (coverage table: project 00026 sub-plan D) |
| Recorded live range = replay | `test/mip0018-live-range.test.ts` |
| Conformance table and the no-network check | `test/mip0018-conformance.test.ts` |
| API and page | `test/mip0018-api.test.ts`, `test/mip0018-ui-*.test.ts` |

Fixtures:

- `../test/integration/fixtures/stagenet-archive/` — recorded Stagenet blocks 714485–715183 and 715402–715433
  (node + indexer answers, brotli tapes, 935 KB), the indexer's `contractEvents` for the cross-check, the case index;
  `manifest.json` holds the source endpoints, genesis hash and SHA-256 of every file. The fake chain server replays them
  over HTTP to the unchanged sync service.
- `test/fixtures/mip0018-cases/` — the reference's case expectations, copied verbatim (SHA-256 checked) plus
  UmbraDB's own per-key expectations for C06's steps after the tombstone (the reference files predate per-key
  tombstones).
- `test/fixtures/live-range/stagenet-714485-715183.json` — the recorded result of live syncs of 714485–715183: the
  current recording (one uninterrupted live run with the current schema, identical to the fixture replay; a killed-
  and-resumed live run on the final code gave the same digest — recorded in the project plan, not in the file) and the
  previous one (an
  uninterrupted run, a run killed with SIGKILL and resumed, archive and scan, and the replay, all identical; its
  archive tables equal the current run's, and only the two tables whose entry-point columns became `bytea` differ);
  CI checks a fresh replay against the current per-table digests.

Development check against live Stagenet (polite; not CI):

```sh
PG_URL=… node --import tsx token-indexer/dev/live-range-check.ts live --tag a --from 714485 --to 715183 --out /tmp/d3
PG_URL=… node --import tsx token-indexer/dev/live-range-check.ts replay --tag r --range idx --out /tmp/d3
PG_URL=… node --import tsx token-indexer/dev/live-range-check.ts compare --tags a,r --out /tmp/d3
```

## Vendored code and provenance

`vendor/mip0018/` holds, byte for byte, the reference implementation's codec (`packages/codec`), the language-neutral
vectors and the vector runner of [`midnight-experiments/mip-0018`](https://github.com/midnight-experiments/mip-0018)
@ `daec1f19747b09f4e245885ab0dd9ecc789a82ce` (Apache-2.0; `LICENSE`, `NOTICE`). `vendor/mip0018/SOURCE.md` lists every
file with its SHA-256; `[[mip0018.vendor.provenance]]` fails on any changed, missing or unlisted file. The vendored
files are never edited. The state rules are UmbraDB's own (`mip0018/state.ts`); the reference vectors were written
for an earlier pin of the MIP, so UmbraDB keeps its own `274a84f` versions of S1a, S3a–S3d, S4a/S4b and S9d in
`mip0018/vectors-umbradb/` (generator with `--check`, SHA256SUMS).

Other copies: the explorer's Outfit font and icon come from PR #19 (`NOTICE`, OFL 1.1).

## Owner decisions

The project's decisions (questions Q1–Q31 of project 00026) are summarized here; the executor's assumptions are
**under review by the owner** and listed in the PR description of acedward/UmbraDB#26.

| Topic | Decision |
|---|---|
| Authority | The final MIP text only; no compatibility with earlier drafts (spec; Q16/Q17: per-key tombstones). |
| Vendoring | Codec, vectors and runner vendored verbatim; the reference repository is never changed (Q2, Q17, Q18). |
| Events | Decoded from archived raw transactions, applied parts only, with the ledger's `decode_event` rule; the indexer's `contractEvents` is a test cross-check (Q4, Q9); logs the raw transaction does not show are stored as `unresolved`, never applied (final audit F1, Q33). |
| State | Latest value per key, no history; a tombstone deletes its key; an identity with no keys is not referenced; shared entries derived from the field rows (Q5, Q15, Q16, Q24). |
| Groups | As the MIP defines them, two or more members (Q6). |
| Scope extras | NIGHT/DUST rows, seen tokens, activity with Bech32m, ✓/⚠ marks with `standards` tags (Q3, Q14). |
| Schema | Fresh `mip0018` lineage, no migration from PR #19 (Q7, Q21). |
| Network and data | Stagenet only; CI on recorded fixtures, development on live `--from/--to` ranges (Q8, Q11). |
| Ledger | `@midnightntwrk/ledger-v9` 1.0.0-rc.3 decodes current Stagenet (Q13). |
