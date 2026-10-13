# UmbraDB token indexer — MIP-0018

The token indexer reads finalized Midnight blocks from UmbraDB's chain archive, finds every token minted or seen in
public data, decodes MIP-0018 token-metadata events from the archived raw transactions, keeps each token's current
metadata in Postgres, and serves it as a read-only JSON API and an explorer page.

## What it implements

- **[MIP-0018](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/eb94bc182221cd937a84ed66a5f903b060f165ab/mips/mip-0018-on-chain-token-metadata.md) as merged from
  [PR #372](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/372)** (`midnightntwrk/midnight-improvement-proposals` `main` at
  `eb94bc182221cd937a84ed66a5f903b060f165ab`; file SHA-256 `8d4204e7aa24428faa44740ba99612f5556f628347c50e38903e4bea83f17245`):
  `Misc` events named exactly
  `mip-0018:token-metadata[v1]`, the payload checks, value types, keys that MUST be valid UTF-8 (an event with any
  other key is rejected whole; the vendored codec checks values only, UmbraDB's `mip0018/classify.ts` adds the key
  check), latest value per key, **per-key tombstones** (a Null record deletes its field), **defined keys only** (every
  key is stored, but only the common fields and keys of a standard the token declares are served, and only they make
  a token exist; an identity without one is not referenced anywhere), common fields incl. `image` / `image_sha256`
  (usable as a URI / exactly 32 bytes), `name` / `symbol` cut to their first 64 / 12 characters (grapheme clusters,
  Node's `Intl.Segmenter`) before they are stored — the stored, served and grouped value is the cut one — symbol groups,
  the color lookup (`rawTokenType(domainSep, contractAddress)`), zero extension of trimmed ledger data. An event with
  any other name (other versions of this one included) is ignored like any other `Misc` event.
- **Explorer page** (`mip0018/ui/`, at `/ui`): a token's image is shown on its view as checked — verified: the image;
  unverified: the image with a "not verified" warning; a hash mismatch or a file that is not a raster image: a warning,
  no image and no link; not reachable or not checked yet: a neutral note. The URL is always text, never a link, and
  the page loads images from the indexer's own origin only (CSP `img-src 'self'`).
- **Beyond the MIP**: hard-coded NIGHT and DUST rows, "seen" tokens (any color in public data, also without a known
  mint), each token's activity (mints, UTXOs created/spent, contract in/out, shielded offer deltas, metadata
  transactions) with Bech32m wallet addresses, and a ✓/⚠ mark per token (✓ = usable `name`, `symbol`, `decimals`, no
  rejected MIP-0018 event and no unresolved log from its contract; ⚠ partial, incorrect or unresolved; no mark without
  MIP-0018 events). The mark says the metadata is correctly published — it is not an endorsement of the token.
- Network: **Stagenet** (Midnight node 2.x). Block heights only (no wall-clock time). The scan and the API never fetch
  a URI; only `serve`'s background image fetcher fetches token images (`image`), under SSRF precautions, checks them
  against `image_sha256`, keeps raster images only and serves them from the indexer's own origin (API.md "Images").

Conformance: [CONFORMANCE.md](CONFORMANCE.md) maps the MIP's MUST/SHOULD requirements to tests.

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
   │    classify.ts       classify each Misc event (vendored codec + UTF-8 keys): accept / reject (reason) / ignore
   │    state.ts          per-key rules (one pure module, also used by the vector adapters)
   ▼
Postgres schema mip0018            mints (color table), color sightings, contract actions, events (classification,
   │                               no values served), fields (latest value per key), each identity's last
   │                               withdrawal and the events activity may list (its history from its last revival on),
   │                               activity, NIGHT/DUST, cursor — one transaction per block
   │  read helpers: tokens.ts, metadata.ts, events.ts, activity.ts
   ▼
read-only JSON API (api.ts)  ──►  explorer page GET /ui (ui/)
   ▲  token images: GET /v1/images/{id}, the `image` object
   │
mip0018_images  ◄──  image-fetcher.ts (in serve, beside the scan loop; the only network client): each identity's
                     `image` → checked address, size/time/rate caps → verified / unverified / mismatch / not-image /
                     unreachable (images.ts)
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

# 2b. Or serve: the API plus the scan loop following the archive and the image fetcher (default 127.0.0.1:10026;
#     --no-image-fetch: no outbound request at all)
node --import tsx token-indexer/mip0018/serve-cli.ts --network stagenet
#     read-only replica: no scan, no migration
node --import tsx token-indexer/mip0018/serve-cli.ts --network stagenet --api-only
```

- `sync-cli.ts` flags and environment: see its header (`--from`, `--to`, `--concurrency`, `--max-blocks`,
  `--min-interval-ms`; `SYNC_BACKOFF_*`). Without `--to` it follows the finalized tip.
- The scan needs each transaction's result and per-segment outcomes in the archive, which `sync-cli.ts` stores. At a
  regular transaction without a stored result it stops ("has no stored result"; it never guesses which parts
  applied), and `serve` reports `scanner: stalled`.
- Nothing in the `mip0018` schema is primary data: the scan builds every row from the chain archive.
- `scan-cli.ts`: `--from`, `--to`, `--max-blocks`, `--schema` (default `mip0018`), `--archive-schema` (default
  `chain_archive`). The scan stops with an error at a transaction it cannot decode (never skips it). A `log` op
  whose logged value is not in the raw transaction does not stop it: it is stored as `unresolved` (see below).
- API: [API.md](API.md) (endpoints, JSON shapes, errors, pagination). Explorer page: `GET /ui`,
  [ui/README.md](mip0018/ui/README.md).

## Known limitation: events the raw transaction does not show

The ledger's `log` op logs whatever value is on top of the contract's VM stack; the ledger turns a well-formed
`[version, type, data]` triple into an event of that type and any other value into a `Misc` event (version 0) whose
data is the whole value (`midnight-ledger` v2.0.0-rc.4 `onchain-vm/src/vm.rs` `decode_event`). The indexer applies
exactly that rule — but it reads events from the raw transactions, and a raw transaction shows the
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
`incorrect` when the contract also has a rejected event. A `log` op that no successful run of the program reaches
logs nothing, on the ledger and here.

## Tests and fixtures

All tests run in the repository's required gate (`npm run test:conformance -- --maxWorkers=2`, Vitest +
Testcontainers Postgres 17; the page's browser tests need a Chromium — see the page README). No test touches the
network: Stagenet data comes from recorded fixtures, and the image fetcher's tests use a local HTTP server on
127.0.0.1 with resolver and dialer seams.

| What | Where |
|---|---|
| MIP vectors through two adapters (pure state module; real Postgres path): 67 normative, 43 informative | `test/mip0018-vectors.test.ts`, `test/mip0018-vectors-pg.test.ts` |
| Decoder, scan, events, metadata state, activity, Bech32m, schema | `test/mip0018-{applied-parts,scan,events,metadata,activity,bech32m,schema,state}.test.ts` |
| The twelve Stagenet cases (C01–C10, IDX, U1) against the reference's expectations | `test/mip0018-metadata.test.ts`, `test/mip0018-cases.test.ts` |
| Recorded live range = replay | `test/mip0018-live-range.test.ts` |
| Conformance table, the no-network check (only the image fetcher may use the network) and the fetcher's isolation | `test/mip0018-conformance.test.ts` |
| Token images: address policy, statuses, SSRF refusals, caps, limits, resume, `/v1/images/{id}` | `test/mip0018-images.test.ts` |
| API (defined keys only, cut `name`/`symbol` in every answer, the `image` object) and page (routes, hostile text, every image status in a real browser) | `test/mip0018-api.test.ts`, `test/mip0018-ui-*.test.ts` |

Fixtures:

- `../test/integration/fixtures/stagenet-archive/` — recorded Stagenet blocks 714485–715183 and 715402–715433
  (node + indexer answers, brotli tapes, 935 KB), the indexer's `contractEvents` for the cross-check, the case index;
  `manifest.json` holds the source endpoints, genesis hash and SHA-256 of every file. The fake chain server replays them
  over HTTP to the unchanged sync service.
- `test/fixtures/mip0018-cases/` — the reference's case expectations, copied verbatim (`SOURCE.md`: SHA-256 of
  every copy, checked by the tests).
- `test/fixtures/live-range/stagenet-714485-715183.json` — the recorded result of a live sync and scan of
  714485–715183 (one uninterrupted run against live Stagenet; every table of both schemas identical to the fixture
  replay), with its per-table digests. CI checks a fresh replay against them.

Development check against live Stagenet (polite; not CI):

```sh
PG_URL=… node --import tsx token-indexer/dev/live-range-check.ts live --tag a --from 714485 --to 715183 --out /tmp/live-range
PG_URL=… node --import tsx token-indexer/dev/live-range-check.ts replay --tag r --range idx --out /tmp/live-range
PG_URL=… node --import tsx token-indexer/dev/live-range-check.ts compare --tags a,r --out /tmp/live-range
```

## Vendored code and provenance

`vendor/mip0018/` holds, byte for byte, the reference implementation's codec (`packages/codec`), the language-neutral
vectors and the vector runner of [`midnight-experiments/mip-0018`](https://github.com/midnight-experiments/mip-0018)
@ `e8295792d9363be37ff2f7f716c740fcdf3f195e` (Apache-2.0; `LICENSE`, `NOTICE`). `vendor/mip0018/SOURCE.md` lists every
file with its SHA-256; `[[mip0018.vendor.provenance]]` fails on any changed, missing or unlisted file. The vendored
files are never edited. The state rules are UmbraDB's own (`mip0018/state.ts`). Every vendored vector runs through
both adapters, except where MIP-0018 as merged from PR #372 changes its expectation: UmbraDB then runs its own version with
the same id (`mip0018/vectors-umbradb/`, see its README; today A3c, a non-UTF-8 key). Likewise for the Stagenet cases
(`test/fixtures/mip0018-cases-umbradb/`: C07's non-UTF-8-key event).

Other copies: the explorer's Outfit font and icon come from the explorer in acedward/UmbraDB PR #19 (`NOTICE`, OFL
1.1).

## Design decisions

| Topic | Decision |
|---|---|
| Authority | MIP-0018 as merged from PR #372 (`main` at `eb94bc1`) only, with per-key tombstones. |
| Vendoring | The reference codec, vectors and runner, verbatim (`vendor/mip0018/SOURCE.md`); the state rules are UmbraDB's own. |
| Events | Decoded from archived raw transactions, applied parts only, with the ledger's `decode_event` rule; the indexer's `contractEvents` is a test cross-check; logs the raw transaction does not show are stored as `unresolved`, never applied. |
| State | Latest value per key, no history; a tombstone deletes its key; every key stored with a `defined` flag, only defined keys served; an identity without a defined key is not referenced; shared entries derived from the defined field rows. |
| Groups | As the MIP defines them, two or more members. |
| Scope extras | NIGHT/DUST rows, seen tokens, activity with Bech32m, ✓/⚠ marks with `standards` tags. |
| Schema | Its own `mip0018` migration lineage (`src/postgres/migrations/mip0018/`). |
| Network and data | Stagenet only; CI on recorded fixtures, development on live `--from/--to` ranges. |
| Ledger | `@midnightntwrk/ledger-v9` 1.0.0-rc.3 decodes current Stagenet. |
