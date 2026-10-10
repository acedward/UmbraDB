# UmbraDB token indexer — MIP-0018

The token indexer reads finalized Midnight blocks from UmbraDB's chain archive, finds every token minted or seen in
public data, decodes MIP-0018 token-metadata events from the archived raw transactions, keeps each token's current
metadata in Postgres, and serves it as a read-only JSON API and an explorer page.

## What it implements

- **MIP-0018 at `274a84f` only**: [`midnightntwrk/midnight-improvement-proposals` PR #340 @ `274a84f221bcfc17e4b73e2c8b32fd8c028ea092`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/274a84f221bcfc17e4b73e2c8b32fd8c028ea092/mips/mip-0018-on-chain-token-metadata.md)
  (SHA-256 `e64fe1429b9f7589077f1323572cf5c3ffa90c7c96690242a9e76d2658058d8b`): `Misc` events named exactly
  `mip-0018:token-metadata[v1]`, the payload checks, value types, latest value per key, **per-key tombstones** (a Null
  record deletes its field; an identity with no field left is not referenced anywhere), common fields, symbol groups,
  the color lookup (`rawTokenType(domainSep, contractAddress)`), zero extension of trimmed ledger data. An event with
  any other name (other versions of this one included) is ignored like any other `Misc` event.
- **Beyond the MIP**: hard-coded NIGHT and DUST rows, "seen" tokens (any color in public data, also without a known
  mint), each token's activity (mints, UTXOs created/spent, contract in/out, shielded offer deltas, metadata
  transactions) with Bech32m wallet addresses, and a ✓/⚠ mark per token (✓ = usable `name`, `symbol`, `decimals`, no
  rejected MIP-0018 event and no unresolved log from its contract; ⚠ partial, incorrect or unresolved; no mark without
  MIP-0018 events). The mark says the metadata is correctly published — it is not an endorsement of the token.
- Network: **Stagenet** (Midnight node 2.x). Never fetches a URI. Block heights only (no wall-clock time).

Conformance: every MUST/SHOULD of MIP-0018 at `274a84f` is mapped to a test in [CONFORMANCE.md](CONFORMANCE.md).

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
   │                               no values served), fields (latest value per key), each identity's last
   │                               withdrawal and the events activity may list (its history from its last revival on),
   │                               activity, NIGHT/DUST, cursor — one transaction per block
   │  read helpers: tokens.ts, metadata.ts, events.ts, activity.ts
   ▼
read-only JSON API (api.ts)  ──►  explorer page GET /ui (ui/)
```

The sync loop, the scan loop and the API run in one engine (`engine/engine.ts`) built only from injected parts: the
database client, `fetch`, a clock, a scheduler for the loops' steps and an event listener that receives every log line.
`sync-cli.ts`, `scan-cli.ts` and `serve-cli.ts` are Node wrappers over it (arguments, signals, the Postgres client,
`node:http`, their own log formats); the engine itself uses no Node API, so a browser worker can host it too.

The engine's `system` snapshot describes the whole system for a status page and a diagnostics file: configuration,
health, sync, scan, databases, storage, API, engine, browser, snapshots and the latest log lines. Its parts:

- `engine/telemetry.ts` counts from the engine's events and an instrumented `fetch`: per-endpoint requests, answers by
  status and retries, blocks per second over the last minute, API answers, `BUSY` refusals and p50/p95 latency, and
  the hooks a host calls (watchdog restarts, PGlite reopens, failed statements). It keeps the latest 200 log lines and
  derives the health line (`deriveHealth`).
- `engine/database-stats.ts` reads catalog estimates (`pg_class.reltuples`, `pg_total_relation_size`,
  `pg_database_size`, `_migrations`), one autocommit statement at a time; exact counts are read only on demand.
- `engine/system-collector.ts` reads counters and `/v1/status` every 2 s and catalog statistics every 30 s, only while
  a viewer watches.
- `engine/system-snapshot.ts` holds the versioned zod schema. Every snapshot is redacted (no URL credentials, query
  secrets or key-like path segments, no keys, tokens, passwords or seed phrases) and validated before it leaves. Log text stays text; a page renders it as text
  nodes.

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
- The scan needs each transaction's result and per-segment outcomes in the archive, which `sync-cli.ts` stores. At a
  regular transaction without a stored result it stops ("has no stored result"; it never guesses which parts
  applied), and `serve` reports `scanner: stalled`.
- Nothing in the `mip0018` schema is primary data: the scan builds every row from the chain archive.
- `scan-cli.ts`: `--from`, `--to`, `--max-blocks`, `--schema` (default `mip0018`), `--archive-schema` (default
  `chain_archive`). The scan stops with an error at a transaction it cannot decode (never skips it). A `log` op
  whose logged value is not in the raw transaction does not stop it: it is stored as `unresolved` (see below).
- API: [API.md](API.md) (endpoints, JSON shapes, errors, pagination). Explorer page: `GET /ui`,
  [ui/README.md](mip0018/ui/README.md).

## Run in the browser

The whole indexer — the chain-archive sync, the MIP-0018 scan, the API and the explorer — also runs in one Chrome tab,
with no server: the engine runs in a dedicated worker on PGlite (PostgreSQL compiled to WebAssembly) stored in the
browser's Origin Private File System, reads the Stagenet node and indexer directly, and the explorer page reads the API
from it. Only static files are served. Details: [browser/README.md](browser/README.md); figures (bundle size, start
time, blocks per second, bytes per block, memory): [browser/MEASUREMENTS.md](browser/MEASUREMENTS.md).

```sh
npm run build:browser    # the static site in dist-browser/: pages, assets, _headers, the published snapshot
npm run serve:browser    # serves it at http://127.0.0.1:10100/ with the headers of its _headers file
npm run dev:browser      # or, for development: the same pages from the sources, served by Vite (no security headers)
```

Then open `http://127.0.0.1:10100/` (with `dev:browser`, the address Vite prints) in Chrome. The page opens on the
indexer's **Overview** (its health, heights, the finalized tip and the lag, blocks per second, uptime, a one-line
storage figure and its controls, and the **Modules** section: Token Indexer MIP-0018, which can be switched off and on,
and the planned modules); the **Token Indexer** tab holds the explorer, and the **Database** tab shows the store's
tables and a page of rows of any of them.

- **Chrome on the desktop only.** The engine checks for OPFS sync access handles, Web Locks, BroadcastChannel and
  persistent storage before anything else; without them it shows "Chrome only" and creates nothing. The page must come
  from a secure context: `https:`, or a loopback host such as `127.0.0.1`.
- **From the finalized tip, then following.** On a first visit the engine starts by itself at the finalized tip both
  endpoints serve, `min(node finalized height, indexer tip)`, and follows new finalized blocks. History before that
  start height H is not indexed, and the explorer says so next to every list ("indexed from block H · history before
  block H is not indexed"): a token minted earlier shows only as seen, and its metadata holds only what was written
  from H on. While the endpoints are unreachable the engine waits with back-off; it never starts at genesis. A
  reopened page continues at the stored cursor and fetches every block since, leaving no gap.
- **Ranges and reset.** The overview starts and stops the engine, changes the range (a start height or `tip`, and an
  optional end) and resets the store. One archive has no gaps, so a range change or a reset replaces the store with a
  new one (its files removed, the database created again); the overview offers to export a snapshot first.
- **Token Indexer off.** Unchecked in the Modules section, the MIP-0018 scan stops at a block boundary while the chain
  archive keeps syncing, and the Token Indexer tab is hidden; the API still answers from the stored data. Checked
  again, the scan continues from its cursor and catches up. The choice is saved with the store's settings and kept
  when the store is replaced (a range, a reset, an import).
- **Snapshots.** The overview exports the rows of every table of the store as one file (a manifest and the rows) and
  imports one into a new store made by this build's migrations (a file carries rows only, never code); an import is
  refused, with its reason, for another network, other migrations, another PGlite version, rows that are not this
  build's tables or do not load, or a damaged file. After an import the engine is stopped; its next start continues at the snapshot's height + 1. The
  build publishes the recorded range 714485–715183 as `snapshots/umbradb-stagenet-714485-715183.snapshot.tar`, checked
  against the recorded digests when it is built: save it from the site and pick it under "import snapshot" (or, from
  the console, `umbradbEngine.snapshots.published("idx").then((f) => umbradbEngine.client.import(f))`), and the
  explorer answers for that range with no network. A snapshot's rows are trusted as they are: its SHA-256 detects
  damage, not who made it.
- **Several tabs.** One engine per store, however many tabs: the first tab leads and runs the worker, the others run
  none and send their requests to it, and the oldest takes over from the stored cursors when the leader closes. The
  overview marks each tab leader or follower.
- **System status page.** `system.html`, linked from the main page's header, shows the whole system read-only: a health line
  (running, following, catching up, waiting (network), stalled (scan), paused (quota), stopped or error), the
  configuration, sync, scan, the databases (migrations, estimated rows and size per table, exact counts on demand),
  storage, API, engine, browser capabilities, snapshots and the last 200 log lines. It reads only while it is visible.
  "Download diagnostics" saves it all as JSON, with URL credentials and secret-looking values removed.
- **Durability.** PGlite runs with `fsync` off (`/v1/status` reports `durability: "non-durable"`; PostgreSQL still
  refuses that mode). Every block still commits in one transaction with its cursor, so a worker or tab killed at any
  point reopens at its last full block. The store holds only public chain data: a sync or a snapshot rebuilds it.
- **Storage.** Every page asks the browser to keep the site's storage (`navigator.storage.persist()`); a refusal is
  shown by the overview and changes nothing else. Before each sync batch the engine compares the browser's usage with its
  quota and pauses the sync at quota − max(256 MiB, 10 % of the quota), while the scan and the API keep running; it
  resumes once space is freed. A write the browser refuses anyway pauses it the same way, with the store at its last
  full block. The overview's storage line is one short line — the store's own size, the quota, where the sync pauses,
  and whether the storage is persistent ("42.3 MB · quota 11.8 GB · pauses at 10.6 GB · not persistent") — with the
  browser's own figures in its tooltip: while the store is open they also count the space Chrome reserves for its
  files.
- **Security headers.** The build writes a strict Content-Security-Policy (with a Trusted Types policy for the worker)
  into every page, and the same policy with cross-origin isolation into `dist-browser/_headers`, which Netlify and
  Cloudflare Pages read. A host must send those headers with every file, over `https:`, serve `.wasm` as
  `application/wasm` and the `.gz` tapes without a `Content-Encoding`: the worker gets its policy only from its
  script's response, so a host that cannot set headers leaves the engine unconfined. The headers, their reasons and
  every host requirement: [browser/README.md](browser/README.md), "Security headers" and "Static hosting".
- **Another network.** The chain is fixed at build time:
  `UMBRADB_BROWSER_NETWORK=<id> UMBRADB_BROWSER_NODE_URL=https://… UMBRADB_BROWSER_INDEXER_URL=https://… npm run build:browser`
  sets the worker's endpoints and the policy's `connect-src` together (`https:`, or `http:` on a loopback host; both
  endpoints must answer CORS). The published snapshot stays Stagenet's, which such a build refuses to import.
- **Limits.** Chrome on the desktop only. Ranges, not full history: the sync is paced like the Node commands (250 ms
  between requests to each endpoint), so it covers a few thousand blocks an hour; a snapshot is the way to start from a
  known range. Without a server, the status page and its diagnostics file are the only view of the engine.

Tests: `npm run test:browser` runs every browser-engine test (the worker host in Node; the static build in Chromium on
OPFS, the static deploy as `serve:browser` serves it, the explorer's Chromium tests), `npm run test:pglite` the whole
suite on PGlite in Node, and `npm run test:crash` kills the worker and the tab's renderer 100 times during a replay
(about 6 minutes; the required gate runs 10). The Chromium tests find the browser through `MIP0018_UI_BROWSER` /
`CHROME_BIN`, the Playwright image's Chromium or Chrome on `PATH` (see [ui/README.md](mip0018/ui/README.md)).

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
network: Stagenet data comes from recorded fixtures.

The same suite runs on PGlite in Node, with no database server: `npm run test:pglite -- --maxWorkers=2`. Each test file
opens its database through `test/helpers/test-database.ts`, which `UMBRADB_BACKEND` (`postgres`, the default, or
`pglite`) points at one Postgres 17 container or one in-memory PGlite database per file. What needs a PostgreSQL server
(a CLI child process connecting by URL, a killed server or backend, the planner's buffer counts, several sessions, the
wallet-storage library) is listed with its reason in `test/helpers/postgresql-only.ts`; on PGlite those files are not
run and those tests are skipped, and `check-required-tests.ts --postgresql-only` requires every other required test to
pass.

The browser suite, `npm run test:browser`, is every test of the browser engine (`test/browser-*.test.ts`: the worker
host in Node, and the static build in Chromium on OPFS) plus the explorer page's Chromium tests, on either backend. CI
runs it in the Playwright image on PGlite, beside `npm run test:pglite` (`.github/workflows/browser.yml`); the
required gate runs it too, on PostgreSQL with the runner's Chrome.

| What | Where |
|---|---|
| MIP vectors through two adapters (pure state module; real Postgres path): 59 reference normative, 43 informative, 8 UmbraDB versions | `test/mip0018-vectors.test.ts`, `test/mip0018-vectors-pg.test.ts` |
| Decoder, scan, events, metadata state, activity, Bech32m, schema | `test/mip0018-{applied-parts,scan,events,metadata,activity,bech32m,schema,state}.test.ts` |
| The runtime-neutral byte helpers against `Buffer` as the oracle: hex, base64url, UTF-8 and Latin-1 text, entry points, API cursors | `test/mip0018-bytes.test.ts` |
| The twelve Stagenet cases (C01–C10, IDX, U1) against the reference's expectations | `test/mip0018-metadata.test.ts`, `test/mip0018-cases.test.ts` |
| Recorded live range = replay | `test/mip0018-live-range.test.ts` |
| Conformance table and the no-network check | `test/mip0018-conformance.test.ts` |
| No Node API in the runtime: the import walk from the runtime's entry modules, no Node module or Node-only global (an allow-list whose unneeded entries fail), the browser build never loading the PostgreSQL client, the Node tooling outside it, and a negative control | `test/runtime-node-free.test.ts` |
| API and page | `test/mip0018-api.test.ts`, `test/mip0018-ui-*.test.ts` |
| The API on PGlite against PostgreSQL: every route and error envelope identical, a database that cannot be read answering 503 on both, the failures only PGlite has, `/v1/status`'s durability mode | `test/mip0018-api-errors-pglite.test.ts` |
| The engine: sync, scan and API from injected parts (a `fetch` over the recorded tapes, a manual clock) | `test/engine.test.ts` |
| The engine's start at the finalized tip: back-off while the endpoints fail (never genesis), following the tip, resuming through the gap | `test/engine-start-tip.test.ts` |
| The engine's telemetry, health rule, `system` snapshot schema and redaction | `test/engine-telemetry.test.ts` |
| The `system` snapshot of a running engine against its sources (SQL catalog, `/v1/status`), its cost and cadence | `test/engine-system-snapshot.test.ts` |
| The browser engine: the worker host and its protocol on an in-memory PGlite; the built worker in Chromium on OPFS, across reloads (see `browser/README.md`) | `test/browser-host.test.ts`, `test/browser-worker.test.ts` |
| One engine across tabs: the leader election, the proxy and the handover rule with in-memory locks and channels; two and three tabs in Chromium on one profile, with the leader closed during a sync | `test/browser-tabs.test.ts`, `test/browser-tabs-chrome.test.ts` |
| The browser engine's sync: digests, the start at the tip, the automatic start, `range` and `reset`, the storage guard and the pacing in the host; the recorded ranges' digests in Chromium on OPFS, and the automatic start against an advancing local chain | `test/browser-sync-host.test.ts`, `test/browser-sync.test.ts` |
| The browser engine killed (the worker terminated, the tab's renderer crashed) at exact points of the first boot, of sync and scan block transactions and their commits, between transactions, at file writes, at random times and during a snapshot import, each point actually reached (a point not reached is tried again on a fresh range, then the campaign fails; the seed is printed first to repeat it): every reopened store holds exactly its cursors' blocks in all 37 tables, and finished ranges have the recorded digests (`npm run test:crash`: 100 kills) | `test/browser-crash-chrome.test.ts` |
| The browser engine at its limits: the pause before the quota and after a refused write (the store at a full block), a refused `persist()`, an unsupported browser (nothing created), a store of another PGlite version in the overview, a hidden tab's replay; in Node, the refused-write pause, a store of an older build migrated at boot, a token minted before the start height | `test/browser-limits.test.ts`, `test/browser-limits-chrome.test.ts` |
| A store the browser engine cannot use: another PGlite version's store refused unopened, an interrupted creation created again, a store that does not open reported; `reset`, `range` and a snapshot import replace it | `test/browser-store-recovery.test.ts` |
| Replacing the browser store: a failure at each step of an import, and a worker ending at each boundary of one (the store as it was, or the snapshot's with its configuration saved); a boot that fails after the store opened; the store identity's states; `range` saving the new range before it replaces the store | `test/browser-store-replace.test.ts` |
| Snapshots of the browser store: the file and every refusal reason, a round trip that continues at the snapshot's height + 1, exports while the engine writes, the import journal, and the published snapshot in Node; in Chromium on OPFS, the round trip between profiles with equal digests, the refusals, the published snapshot with no network, and an import finished at the next boot | `test/browser-snapshot.test.ts`, `test/browser-snapshot-chrome.test.ts` |
| Snapshots that carry more than rows: a store holding code exports only its rows and an import's store is made by this build's migrations (a table the build lacks refused); `reset` and `range` remove every file of a store holding code; a small file whose rows declare a huge size refused quickly with little memory | `test/browser-snapshot-attacks.test.ts` |
| The static build's explorer: its transport through the engine, the overview's view and the built page; in Chromium, `GET /ui`'s recorded-range checks in the Token Indexer tab with the IDX tape replayed in the worker, the transport's cap and error rendering, and the overview's controls, start height and leader/follower marks | `test/browser-explorer.test.ts`, `test/browser-explorer-chrome.test.ts` |
| The main page: the overview's view of the `system` snapshot, the modules, the tabs' URL rule and the Database tab's view; in Chromium on the static build with its headers, the overview's figures against their sources, the storage line, the tabs in the URL, the Token Indexer switch (the scan stopped at a block boundary while the archive advances, kept through a leader change and a reload, the finished digests equal), the Database tab against the store read with SQL and a forged table refused, and hostile engine and file text drawn as text | `test/browser-overview.test.ts`, `test/browser-shell-chrome.test.ts` |
| The engine's scan switch and the worker host's `module`, `tables` and `rows`: the scan off while the archive advances and on again to the recorded digests, the choice saved, every table listed and every first page equal to SQL, forged names and values that cannot be read refused; the switch kept, and the tables read, across a store replaced by `range`, `reset` or `import` | `test/browser-modules.test.ts` |
| The static build's security headers: the policy and `_headers` the build writes for every page, the build-time chain, the worker's Trusted Types policy; in Chromium, the engine under the header and the meta policy with no violation and only allowed origins, and each refusal enforced (see `browser/README.md`) | `test/browser-csp-build.test.ts`, `test/browser-csp.test.ts` |
| The browser engine's `system` snapshot and watchdog heartbeat in the worker host; in Chromium on OPFS, the snapshot against the store read by another page, a follower tab's snapshots, the watchdog's restart of a blocked worker with the recorded digests after it, and the API's round trips during a replay | `test/browser-system.test.ts`, `test/browser-engine-chrome.test.ts` |
| The browser worker's session (time slices, failed statements, close), API requests between block transactions, the reopen before PGlite's failed-statement defect; the page's watchdog with a real slow statement on a worker thread and its rules, and what a restart starts (the engine last reported running: after a start with no configuration, a range, an import, nothing after an import the restart interrupted; the token indexer switched off stays off) | `test/browser-session.test.ts`, `test/browser-watchdog.test.ts`, `test/browser-watchdog-restore.test.ts` |
| The browser build computes what the Node build computes, in Chromium: the 110 MIP vectors through the PGlite store in a worker on OPFS; the recorded cases through the engine worker's API (each case at its own last block, the reference index, marks, activity); a crawl of the whole API equal to the Node handler's over the same range | `test/browser-parity.test.ts` |
| The system status page: its view of a snapshot and the explorer's hidden-character rules; in Chromium on the static build with its headers, every section against its sources, each driven state, a follower tab, nothing read while hidden, hostile text, and the diagnostics file's schema and redaction (see `browser/README.md`) | `test/browser-system-page.test.ts`, `test/browser-system-page-chrome.test.ts` |
| The dev server (`npm run dev:browser`): every stylesheet, icon and font the main page and the status page link served as what it is, never as a page; in Chromium, the dev main page styled (its font, the logo's size, the overview's grid) | `test/browser-dev-chrome.test.ts` |
| The static deploy: `npm run serve:browser`'s server (every file kind's content type, no `Content-Encoding`, every `_headers` header, nothing outside the folder, a folder without `_headers` refused) and its command; in Chromium, the site `npm run build:browser` writes served by it: the main page starts the engine by itself, the status page follows it, the published snapshot imports with the recorded digests, only the site and the build's chain are requested, no CSP violation | `test/browser-deploy.test.ts`, `test/browser-deploy-chrome.test.ts` |
| Pages inside a frame (a host without the headers): each, the main page on every tab, shows a notice and starts no engine | `test/browser-frame-chrome.test.ts` |
| The build's licence notices: `THIRD-PARTY-NOTICES.txt` lists every bundled package with its licence text, PostgreSQL's, the font's and UmbraDB's; an unknown package without a licence text fails the build | `test/browser-notices.test.ts` |

Fixtures:

- `../test/integration/fixtures/stagenet-archive/` — recorded Stagenet blocks 714485–715183 and 715402–715433
  (node + indexer answers, brotli tapes, 935 KB), the indexer's `contractEvents` for the cross-check, the case index;
  `manifest.json` holds the source endpoints, genesis hash and SHA-256 of every file. The tape replay
  (`../chain-archive-sync/tape-replay.ts`, no Node API) answers the unchanged sync service's node and indexer calls from
  them: as a `fetch`-shaped function handed to the clients (no server; any runtime), or through the fake chain server
  over HTTP. Its reported finalized height can rise with a clock, for a sync that follows the tip.
- `browser/tapes/` — gzip copies of the two range tapes for browsers (Chrome's `DecompressionStream` reads gzip, not
  brotli), each decoding to exactly the JSON text of its brotli source; `manifest.json` records their sizes and SHA-256
  and their sources' SHA-256 (written by `dev/browser-tapes.ts`).
- `test/fixtures/mip0018-cases/` — the reference's case expectations, copied verbatim (SHA-256 checked) plus
  UmbraDB's own per-key expectations for C06's steps after the tombstone (the reference files are written for MIP
  `78ecbb4`, where a Null record withdraws the whole identity).
- `test/fixtures/live-range/stagenet-714485-715183.json` — the recorded result of a live sync and scan of
  714485–715183 (one uninterrupted run against live Stagenet; every table of both schemas identical to the fixture
  replay), with its per-table digests. CI checks a fresh replay against them.

Development check against live Stagenet (polite; not CI):

```sh
PG_URL=… node --import tsx token-indexer/dev/live-range-check.ts live --tag a --from 714485 --to 715183 --out /tmp/live-range
PG_URL=… node --import tsx token-indexer/dev/live-range-check.ts replay --tag r --range idx --out /tmp/live-range
PG_URL=… node --import tsx token-indexer/dev/live-range-check.ts compare --tags a,r --out /tmp/live-range
```

Measurements of the browser build next to the Node build (`browser/MEASUREMENTS.md`; not CI): `dev/measure-browser.ts`
(sizes, cold start, replay, memory, a hidden tab, the status page's cost, in headless Chromium) and `dev/measure-node.ts`
(the same replay on PostgreSQL and on PGlite in Node; the activity listings' page cost on a large store).

## Vendored code and provenance

`vendor/mip0018/` holds, byte for byte, the reference implementation's codec (`packages/codec`), the language-neutral
vectors and the vector runner of [`midnight-experiments/mip-0018`](https://github.com/midnight-experiments/mip-0018)
@ `daec1f19747b09f4e245885ab0dd9ecc789a82ce` (Apache-2.0; `LICENSE`, `NOTICE`). `vendor/mip0018/SOURCE.md` lists every
file with its SHA-256; `[[mip0018.vendor.provenance]]` fails on any changed, missing or unlisted file. The vendored
files are never edited. The state rules are UmbraDB's own (`mip0018/state.ts`); the reference vectors are written
for MIP `78ecbb4`, where a Null record withdraws the whole identity, so UmbraDB runs its own `274a84f` versions of
S1a, S3a–S3d, S4a/S4b and S9d from `mip0018/vectors-umbradb/` (generator with `--check`, SHA256SUMS) instead of the
vendored files with those ids.

Other copies: the explorer's Outfit font and icon come from the explorer in acedward/UmbraDB PR #19 (`NOTICE`, OFL
1.1).

## Design decisions

| Topic | Decision |
|---|---|
| Authority | MIP-0018 at `274a84f` only, with per-key tombstones. |
| Vendoring | The reference codec, vectors and runner, verbatim (`vendor/mip0018/SOURCE.md`); the state rules are UmbraDB's own. |
| Events | Decoded from archived raw transactions, applied parts only, with the ledger's `decode_event` rule; the indexer's `contractEvents` is a test cross-check; logs the raw transaction does not show are stored as `unresolved`, never applied. |
| State | Latest value per key, no history; a tombstone deletes its key; an identity with no keys is not referenced; shared entries derived from the field rows. |
| Groups | As the MIP defines them, two or more members. |
| Scope extras | NIGHT/DUST rows, seen tokens, activity with Bech32m, ✓/⚠ marks with `standards` tags. |
| Schema | Its own `mip0018` migration lineage (`src/postgres/migrations/mip0018/`). |
| Network and data | Stagenet only; CI on recorded fixtures, development on live `--from/--to` ranges. |
| Ledger | `@midnightntwrk/ledger-v9` 1.0.0-rc.3 decodes current Stagenet. |
