# The token indexer in the browser

The engine (`../engine/engine.ts`: the chain-archive sync, the MIP-0018 scan and the API) runs in Chrome in a dedicated
module worker, on PGlite stored in the Origin Private File System. The page talks to it with messages; nothing but
static files is served.

```sh
npm run build:browser   # the static site in dist-browser/ (index.html, system.html, engine.html, assets/, _headers and the published snapshot in snapshots/)
npm run dev:browser     # the same configuration served by Vite on 127.0.0.1 (no security headers)
```

The build indexes Stagenet unless `UMBRADB_BROWSER_NETWORK`, `UMBRADB_BROWSER_NODE_URL` and
`UMBRADB_BROWSER_INDEXER_URL` say otherwise when it runs (see [Security headers](#security-headers)).

[MEASUREMENTS.md](MEASUREMENTS.md) records what the build costs and how fast it runs (cold start, sizes, live and replay
blocks per second, storage per block, memory, a hidden tab, the status page's cost), next to the Node build on
PostgreSQL.

## Modules

| Module | Role |
|---|---|
| `worker.ts` | The worker's entry: the host below on `opfs-ahp://umbradb-stagenet`, bound to the worker's messages |
| `host.ts` | Boot, request dispatch and the engine's lifecycle, from injected dependencies (tests run it in Node on `memory://`) |
| `protocol.ts` | The message protocol: versions, requests, results, errors and notices, each with a zod schema |
| `client.ts` | The page's side: `startEngineWorker()` (the worker under the page's watchdog, created through the Trusted Types policy below) and `createEngineClient(endpoint)` (requests as promises of validated results) |
| `supervisor.ts` | The page's watchdog: heartbeats, terminate and restart of a worker that stopped answering, what the page set up restored on the new worker |
| `tabs.ts` | One engine across tabs: `connectEngineTabs()` elects the leader tab, which alone runs the worker; the other tabs proxy their requests to it and take over when it closes |
| `tab-locks.ts` | The Web Locks behind that (leader, tab presence, store) and the connected-tab count |
| `host-system.ts` | The worker's telemetry, `system` snapshot collector and viewers, and the watchdog's heartbeat |
| `system-view.ts` | The page's side of the `system` snapshot: follow it while the page is visible, refresh it, "Download diagnostics" |
| `system.html`, `system-page.ts`, `system-model.ts`, `system.css` | The system status page (see [System status page](#system-status-page)): the page, its drawing, its pure view of a snapshot, its style beside the explorer's `ui/page.css` |
| `visible-text.ts` | The explorer's hidden-character rules for text a page draws from data: `⟨U+XXXX⟩` marks, bidi islands, text nodes only |
| `session.ts` | The worker's view of its PGlite session: turns for the event loop between statements, failed statements counted, a close that waits for the statements in flight |
| `capabilities.ts` | The Chrome-only capability check run before anything else |
| `store.ts` | Opens PGlite and its two clients (`chain_archive`, `mip0018`); non-durable, results and errors as on PostgreSQL |
| `scheduler.ts` | Yields to the worker's event loop before each sync batch and scan step, so messages are served while it runs |
| `tapes.ts`, `tapes/` | The recorded Stagenet ranges (gzip) the worker can replay with no network, SHA-256 checked |
| `config.ts` | The network, its default endpoints (fixed when the site is built), the store's location and the build's settings |
| `settings.ts` | The engine's saved configuration, a file beside the store |
| `store-identity.ts` | Which PGlite wrote the store, a file beside it: a store of another PGlite version is refused before it is opened |
| `quota.ts` | The storage guard: pauses the sync before the quota, and after a write the browser refused |
| `snapshot.ts` | The snapshot file: its manifest, its format (a tar of `manifest.json` and `data.tar.gz`) and every check an import makes |
| `snapshot-store.ts` | Export (a consistent read while the engine runs), import (checks, a trial load, then a journaled swap under the store's lock) and finishing an interrupted import when the store opens |
| `snapshot-page.ts` | The page's side: saving an exported file as a download, fetching a snapshot the build publishes |
| `trusted-worker.ts` | The pages' one Trusted Types policy, `umbradb-engine-worker`, which makes the engine worker's script URL |
| `zod-jitless.ts` | Turns zod's JIT (`new Function`) off before any schema exists; the first module of the worker and of every page |
| `index.html`, `explorer-page.ts`, `explorer-host.ts`, `explorer-transport.ts`, `explorer.css` | The token explorer (see [Explorer](#explorer)): the page `GET /ui` serves, reading the API through the engine, with the engine panel |
| `engine-panel.ts`, `panel-model.ts` | The explorer's engine panel: what the engine indexes and how it is doing, and its controls |
| `engine.html`, `engine-page.ts` | A page that joins the tabs, asks for persistent storage, shows its role and the engine's status; `window.umbradbEngine` holds the client, the tabs and the snapshot helpers |
| `vite.config.ts`, `build-guard.ts`, `build-csp.ts`, `build-explorer.ts` | The build (Node tooling): every `*.html` here is a page, ES module worker, `esnext`, class names kept, `vite-plugin-wasm` for ledger-v9's WASM module, assets as files, a plugin that fails the build if postgres.js or a Node built-in would be bundled, a plugin that writes the pages' security headers, and one that makes the explorer page from `GET /ui`'s markup |

## Explorer

`index.html` is the MIP-0018 token explorer of `GET /ui` (`../mip0018/ui/`), the same script and style, with the API
answered by the engine instead of a server:

- **Transport.** The explorer script (`../mip0018/ui/page.js`) reads the API through one function, `api(path)`. On
  `GET /ui` it is a same-origin `fetch`. Here `explorer-host.ts` runs first and installs `window.umbradbExplorerHost`,
  whose `api(path)` sends `api` (`GET`, the path) to the engine and answers with a fetch `Response` of the handler's
  status, headers and body (`explorer-transport.ts`); the script reads it exactly as a fetched one: the 8 MiB cap (the
  announced `content-length`, then the bytes read), the JSON, and the error rendering (`… answered 503 BUSY`; a failed
  engine request is `… answered nothing UNREACHABLE`). The host object is the switch: only this build installs it, so
  `GET /ui` is unchanged.
- **Start height.** This build's index may start mid-chain (at the tip by default), so next to every list (the token
  list, a contract's token identities, a color's tokens, an identity's current fields and MIP-0018 mark, every
  activity and events section) the explorer states "indexed from block H · history before block H is not indexed"
  (`/v1/status` `startHeight`; "nothing indexed yet" before the first block): a token minted earlier shows only as
  seen, and its metadata only holds what was written from H on.
- **Page.** The build writes `GET /ui`'s markup (`UI_BODY` of `ui/page.ts`) into `index.html` and links `ui/page.css`,
  whose font reference becomes the font file (`build-explorer.ts`). The page joins the tabs like the engine page
  (`window.umbradbEngine`, persistent storage asked at load) and gets the build's policy like every page.
- **Engine panel** (`engine-panel.ts`, between the header and the view): this tab's role (leader, or follower with the
  engine in another tab) and the open tabs; the network; the engine's state (`not started`, `running`, `stopped`,
  `waiting (network)`, `stalled (scan)`, `paused (storage)`, `failed`, …) with its detail; the saved configuration
  (`settings`); "indexed from block H · history before block H is not indexed"; the synced (archive) and scanned
  heights; durability; storage (`status`'s `storage` reading: usage, quota, where the sync pauses, the store's files,
  persistence; the page's own `navigator.storage` figures until there is one). Controls, each one request (from a
  follower the leader performs it): **start** (the saved configuration), **stop**, **change range** (a start, `tip` or
  a height, and an optional end, checked before it is sent), **reset**, **export snapshot**, **import snapshot** (a
  file). A range change, a reset or an import on a store that holds blocks first says which blocks will be dropped
  and offers to export a snapshot before going on (or cancel, which sends nothing). The answer or the error is shown
  under the controls. A link leads to the system status page (`system.html`). The panel refreshes every 2 s while the
  page is visible, after each request and on the engine's notices; all text is set as text.

## Boot

The worker boots as soon as it loads, in phases posted as `boot` notices and reported by `status`:
`capabilities` → `store` → `ledger` → `migrate` → `ready`.

- **capabilities**: Chrome (a Chromium browser), OPFS with sync access handles (a probe file is opened), Web Locks,
  BroadcastChannel and persistent storage. If any is missing the boot ends `unsupported` with a "Chrome only" message
  and nothing is opened or started. (`navigator.storage.persist()` exists only in a window; the worker checks
  `persisted()`.)
- **store**: PGlite opens the store; the first open creates the database (about a second, with a second PGlite heap
  while it runs). Before it, the store's identity (`<store directory>.store.json` beside the store, written once a boot
  has migrated the store and after an import: the PGlite and PostgreSQL versions it was opened with) is read:
  - a store another PGlite version wrote is **refused unopened**: the boot ends `failed` with `storeProblem: "version"`
    and "reset it (its data is dropped and synced again) or load a snapshot made by this build";
  - a store with no identity that does not open is one whose **creation was interrupted** (a worker that ends while
    PGlite creates a store leaves files PGlite cannot open again: it then needs more pool files than a reopened store
    gets): its files are removed and the store is created again, with a warning (nothing was stored yet);
  - a store with an identity that does not open ends the boot `failed` with `storeProblem: "unopenable"`, the error
    and the same two choices.

  With `storeProblem` set, `reset` and `range` remove the store's files (under the store's lock) and `import` loads a
  snapshot in their place (journaled, as any import); then the rest of the boot runs. Nothing is read from such a
  store, and the engine panel keeps those three controls enabled. A store another worker holds is never removed.
- **ledger**: ledger-v9 loads and its classes must keep their names (the scan stores them); a renamed class fails the
  boot.
- **migrate**: the chain archive's and MIP-0018's migrations, as the Node commands run them.

A failure in the last three ends the boot `failed`, with the error, and closes the store.

## Protocol

Every message carries `v` (version 1). Requests are `{ v, id, type, …parameters }`; each gets one response
`{ v, type: "response", id, request, ok, result | error: { code, message } }`.

| Request | Parameters | Result |
|---|---|---|
| `status` | — | boot state, store facts (data directory, created, PostgreSQL version, `fsync`, durability, applied migrations), the last engine's configuration and loop status, the stored cursors, the saved configuration (`settings`) and the storage reading (`storage`) |
| `api` | `method`, `target` | the API's answer `{ status, headers, body }` (`../API.md`) |
| `start` | `config?`: `source` (`{ kind: "network", nodeUrl?, indexerUrl? }` or `{ kind: "tape", range: "idx" \| "u1", finalizedHeight?, advance? }`), `startHeight?` (a height or `"tip"`, the default), `endHeight?`, `sync?` (`maxBlocks`, `concurrency`, `minIntervalMs`, `idleMs`, `backoff`), `scan?`; omitted: the saved configuration | status |
| `stop` | — | status; the engine no longer starts by itself until the next `start` |
| `range` | `startHeight` (a height or `"tip"`), `endHeight?` | status: the store's data is dropped and the new range starts (source and tuning from the saved configuration) |
| `reset` | — | status: the store's data is dropped and the saved configuration starts again |
| `digest` | — | the store's archive digest (the 7 `chain_archive` tables, `chain-archive-sync/archive-digest.ts`) and the digest of every table of both schemas (`../engine/range-tables.ts`), read in one read-only transaction |
| `system` | `watch` (with `viewer?`) or `refresh: { database?, exactCounts? }` | `{ watching, viewers, snapshot }`: the snapshot of a refresh (`null` for a watch) |
| `watchdog` | `limitMs`, `heartbeatMs?`, `carried?` | `{ limitMs, heartbeatMs }` |
| `export` | — | a snapshot file of the store (`Blob`), its suggested name, its manifest, its size and timings (see Snapshots) |
| `import` | `snapshot`: a snapshot file (`Blob`, a picked `File`) | the imported manifest, timings and status: the store is the snapshot's, the engine is stopped (see Snapshots) |

Error codes: `bad-request`, `unsupported-version`, `unknown-type`, `not-implemented`, `unsupported-browser`,
`boot-failed`, `already-running`, `start-failed`, `internal`, `snapshot-refused` (the message starts with the reason;
nothing changed) and `snapshot-failed` (a checked snapshot could not be loaded; the store was opened empty); the client
adds `bad-response`, `worker-error`, `restarted` and `closed`, and a page sharing the engine with other tabs also
`leader-changed` and `leader-unavailable` (see Tabs). Notices: `boot` (each phase), `engine` (`running`, `stopped`,
`failed`), `system` (one snapshot per collection while watched) and `heartbeat` (after a `watchdog` request).

While no engine runs, `api` answers from the same store with no loops (`/v1/status` reports `scanner: "off"`). Defaults
in the browser: 20 heights per sync batch and 10 blocks per scan step, so a stop and API requests wait for little.

## Tabs

A browser profile runs one engine per store, however many tabs are open. A page connects with `connectEngineTabs()`
(`tabs.ts`) and uses its `client` exactly like `startEngineWorker()`'s.

- **Leader.** Every tab holds a presence lock (`umbradb-engine-tab:<store>:<tab>`). The tab that gets the leader lock
  (`umbradb-engine-leader:<store>`) starts the engine worker and keeps the lock until it closes; it answers its own
  page and the other tabs through the same engine client and relays the worker's notices to them.
- **Followers.** The other tabs start no worker (so they never open the store) and queue for the leader lock. They send
  each request (`type`, `params`) to the leader over BroadcastChannel (`umbradb-engine:<store>`) and get its answer on
  their own channel (`umbradb-engine:<store>:tab:<tab>`), validated again; every request type works from any tab. A
  system snapshot a follower receives is marked as relayed.
- **Handover.** When the leader closes, the oldest follower gets the lock, starts its worker on the same store and
  resumes what the previous leader last reported running (the same `start` configuration, which continues at the stored
  cursors); the first leader of a store starts its saved configuration instead (see Sync). Requests in flight to the closed leader: `status`, `api`, `export`, `digest` and `system` are sent again to the next leader;
  any other request fails with `leader-changed` (it may or may not have been applied); a request made while no leader
  is known waits up to 10 s, then fails with `leader-unavailable`.
- **Store lock.** The worker opens the store only under `umbradb-store:<store>`, held until it closes the store or ends,
  and waits until no other context still holds the store's files, so a closed tab's worker that is still shutting down
  and its successor never have the store open together.
- Leadership belongs to the tab: replacing the leader tab's worker does not move it. `connectedTabs()` counts the
  presence locks; `connectedTabsCounter()` (`tab-locks.ts`) gives the same count synchronously, e.g. inside the worker.

## Sync

- **Start at the tip.** A new archive starts at `startHeight`, by default the finalized tip both sources serve when the
  sync begins, `min(node finalized height, indexer tip)`, read with the same clients and retries as every batch. While
  the endpoints fail the engine waits (each attempt's calls retried, then a wait doubling from 1 s to 60 s, with
  jitter) and asks again; it never starts at genesis by default. `/v1/status` `startHeight` is the first indexed
  height: history before it is not indexed. Requests to the Stagenet endpoints are spaced 250 ms apart per endpoint and
  a throttling answer is retried after its `Retry-After`, as in the Node commands.
- **Automatic start and resume.** The configuration of the last `start` or `range` is saved beside the store
  (`settings.ts`: `umbradb-stagenet.engine.json` in the OPFS root), with whether the engine starts by itself (`stop`
  turns that off, the next `start` on). The leader tab starts it (`tabs.ts` `resumeOrAutoStart`, the default `resume`):
  after its worker has booted it resumes what a previous leader was running, or else, when the saved configuration
  says so, sends `start` with no configuration, which runs the saved one (for a new store, the build's default: the
  tip, following it). Followers never start anything. A reopened store continues at its cursor and fetches every
  height since, so a closed or frozen tab leaves no hole; a chosen range keeps its end.
- **Ranges.** One archive has no gaps and no backfill, so `range` (a new start or end) and `reset` drop the store's data
  (both schemas, in one transaction, in the leader's worker, which holds the store's lock) and migrate again before
  starting. The page offers an export first; the host takes a `beforeWipe` hook for that. Neither is sent again after
  a handover (`leader-changed`); `digest`, which only reads, is.
- **Persistent storage.** `navigator.storage.persist()` exists only in a window: every page asks for it when it loads
  (`requestPersistentStorage()` in `client.ts`; the grant is per site, so any tab's request counts; the engine page keeps
  the answer in `window.umbradbEngine.persistence`), and the worker's `storage.persisted` reports the outcome. A
  refusal changes nothing else: the engine runs, and the explorer's engine panel says the browser refused to keep the
  site's storage (or that asking failed), so the store may be cleared when space runs low.
- **Storage quota** (`quota.ts`). Before a sync batch (reading again when the last reading is 10 s old) the worker
  compares `navigator.storage.estimate()`'s usage with its quota. While the store is open that usage includes the space
  Chrome reserves for the store's open files (about 1 GB in the session that creates the store, for about 42 MB of
  files; reopening the page releases it), and Chrome refuses a write once usage, reservations included, would pass the
  quota, so the reported usage is what decides. The sync pauses once usage ≥ quota − max(256 MiB, 10 % of the quota)
  and resumes once usage is 32 MiB under that, read every 30 s while paused; the scan and the API keep running. The
  reading (usage, quota, the threshold, the size of the store's files from an OPFS walk, `persisted`, the pause and its
  reason) is `status`'s `storage`, and the system snapshot's storage provider. A write Chrome refuses anyway (the
  figures did not show it coming; the database reports "could not extend file …: File too large") fails its statement,
  so its block's transaction is rolled back and the store stays at its last full block; the sync's or scan's error is
  recognized as such and the sync pauses the same way, with "the browser refused to write to the store for lack of
  space (…)" as the reason, until its next batch (at least 30 s later, and after the sync's own back-off) tries again.

## Snapshots

A snapshot is the whole store (both schemas, as PGlite's data directory) in one file,
`umbradb-<network>-<first height>-<height>.snapshot.tar`, a plain tar of two entries (`tar -tf` lists them):

| Entry | Content |
|---|---|
| `manifest.json` | `format`, `version`, `createdAt`; `network` and `genesisHash`; `archive`: the first height, and the height and hash of the last fully committed block; `scan`: the scan cursor at the same instant (it may be behind the archive; the scan catches up); `schemaVersions`: the applied migrations of `chain_archive` and `mip0018`; `pglite`: the PGlite and PostgreSQL versions; `build.appCommit`; `data`: the size, uncompressed size and SHA-256 of `data.tar.gz` |
| `data.tar.gz` | PGlite's `dumpDataDir()`: a tar of the data directory, gzip |

**Export** does not stop the engine. It takes the store's one PGlite session between two transactions (so each block
is in the snapshot whole or not at all, and both cursors are at a full block), reads what the manifest records, runs
`CHECKPOINT` and writes the data directory as a tar; the sync, the scan and API requests wait only for that read (tens of
milliseconds for the recorded ranges), and the compression runs after it. It changes nothing, so a tab that asked for it
can ask the next leader again.

**Import** first checks the file without touching anything (a running engine keeps running), and refuses it with a
reason: `format` (not a snapshot file of this version), `truncated`, `network` (another network or genesis block),
`schema` (other migrations than this build's), `pglite` (another PGlite or PostgreSQL version), `hash` (the data's size
or SHA-256 is not the manifest's), `corrupt` (the data does not unpack into a data directory, or holds another state
than its manifest says: it is loaded into a trial in-memory PGlite and its cursors, block hash and migrations compared).
Then it stops the engine, waits for the API requests in flight, saves the file beside the store as a journal
(`<store>.import.snapshot.tar` in the Origin Private File System), closes PGlite while keeping the store's lock, removes
the store's files, opens the store again from the snapshot's data directory and checks it against the manifest once
more, and removes the journal. A worker that ends anywhere in that swap leaves the journal, and the next open finishes
the import before PGlite opens the store, so a half-written store is never opened; a journal that cannot be read back
whole means the swap never began, and is dropped. `status` and `api` wait during the swap.

After an import the engine is stopped and the saved configuration continues the imported archive: its first height as
the start, no end height, and no automatic start (as after `stop`). A `start` then continues at the height after the
snapshot's (and the scan from its cursor).

A snapshot is trusted data: its SHA-256 detects damage, not who made it, and the explorer shows what it holds. Import
snapshots you exported or the build published.

**Published snapshot.** `npm run build:browser` writes `snapshots/umbradb-stagenet-714485-715183.snapshot.tar` and
`snapshots/index.json` (each file's size, SHA-256, manifest and digests) after Vite (`../dev/browser-snapshot.ts`): the
worker host runs in Node on an in-memory PGlite (the browser's PGlite build), replays the recorded IDX range's tape and
exports; the build then loads the file back and fails unless its store's archive digest and range-tables digest equal
the recorded live sync of that range. The file's bytes differ from build to build (times, and the database identifier
PGlite's `initdb` makes); what it holds does not. A page loads it with
`window.umbradbEngine.snapshots.published("idx")` (checked against the index) and imports it; with it the explorer
answers for 714485–715183 with no network. `npm run dev:browser` publishes none.

## Build settings

`config.ts` holds the network, its endpoints (see Security headers) and the store's location. A build can also set
`__UMBRADB_BROWSER_CONFIG__` through Vite's `define` (JSON): `autoStart` (default true: the leader tab starts the saved
configuration), `start` (the configuration a new store starts with, default `{}`) and `quota` (the storage guard's
`checkEveryMs`, `recheckMs`, `storeEveryMs`). The browser tests use it to turn the automatic start off, or to point it at
a local chain on the site's own origin (`'self'` in `connect-src`); under the policy, a `start` source can reach only
the site's origin and the build's two chain endpoints.

## Security headers

Every page of the static build runs under a strict Content-Security-Policy, made by the build (`build-csp.ts`):

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'none'` | nothing loads unless a directive below names it |
| `script-src` | `'self' 'wasm-unsafe-eval'` + the SHA-256 of each inline `<script>` | the site's own modules; WebAssembly may compile (PGlite, ledger-v9); no `'unsafe-eval'`, no `'unsafe-inline'` |
| `style-src` | `'self'` + the SHA-256 of each inline `<style>` | |
| `img-src`, `font-src` | `'self'` | |
| `connect-src` | `'self'` + the origins of the build's node and indexer URLs | assets and tapes; the two chain endpoints (Stagenet: `https://rpc.stagenet.shielded.tools`, `https://indexer.stagenet.shielded.tools`) |
| `worker-src` | `'self'` | the engine worker |
| `object-src`, `base-uri`, `form-action` | `'none'` | |
| `frame-ancestors` | `'none'` | header only (a `<meta>` cannot carry it) |
| `require-trusted-types-for` | `'script'` | a string can reach no script sink: `eval`, `new Function`, `innerHTML`, `new Worker(string)`, … all throw |
| `trusted-types` | `umbradb-engine-worker` | the one policy: it turns the engine worker's URL into a `TrustedScriptURL`, and accepts only a script of the page's origin inside the build's `assets/` |

The build writes the policy twice:

- **In each page**, as `<meta http-equiv="Content-Security-Policy">` (with that page's own hashes) followed by
  `<meta name="referrer" content="no-referrer">`, right after `<meta charset>`. The hashes are of the bytes the build
  writes, so an inline block the build did not write cannot run. This form protects the page even on a host that sends
  no headers, but it does not reach the worker: Chrome takes a worker's policy from its script's response.
- **In `dist-browser/_headers`**, for every path (Netlify and Cloudflare Pages read this file). A host that does not read
  it must send these headers with every file of the build — the pages, the worker's script and the other assets (the
  policy's exact text, with the current hashes, is in `_headers`; it changes when an inline block changes):

  | Header | Value |
  |---|---|
  | `Content-Security-Policy` | the policy above (the union of the pages' hashes, with `frame-ancestors 'none'`) |
  | `Cross-Origin-Opener-Policy` | `same-origin` |
  | `Cross-Origin-Embedder-Policy` | `require-corp` |
  | `Cross-Origin-Resource-Policy` | `same-origin` |
  | `Referrer-Policy` | `no-referrer` |
  | `X-Content-Type-Options` | `nosniff` |
  | `X-Frame-Options` | `DENY` |

  The host must also serve `.wasm` as `application/wasm`. Only with these headers is the engine worker confined: its
  requests limited to the site and the two chain endpoints, `eval` refused in it. COOP and COEP make the page and the
  worker cross-origin isolated (`crossOriginIsolated`, needed by `performance.measureUserAgentSpecificMemory()`); the
  chain endpoints answer CORS, so the worker's requests to them work under COEP.

The chain is fixed at build time: `UMBRADB_BROWSER_NETWORK` (a network id), `UMBRADB_BROWSER_NODE_URL` and
`UMBRADB_BROWSER_INDEXER_URL` (`https:`, or `http:` on a loopback host; no credentials) set the worker's defaults
(`config.ts`) and `connect-src` together, e.g.
`UMBRADB_BROWSER_NETWORK=preprod UMBRADB_BROWSER_NODE_URL=https://… UMBRADB_BROWSER_INDEXER_URL=https://… npm run build:browser`.
Under the header policy, a `start` that names other endpoints cannot reach them: the policy refuses the requests.

A page needs nothing to be covered: any `*.html` in this directory is built, given the meta policy, hashed into
`_headers`, and has `zod-jitless.ts` as its first module. The build fails if a page holds an inline event handler
(`onclick=…`), a `style` attribute or a `javascript:` URL, which the policy would silently block. Script code must not
compile strings (`eval`, `new Function`, string timers); the bundled dependencies never do in this build: zod's JIT is
off, and PGlite's two `eval` calls are in its loader for dynamically linked modules that carry inline JavaScript
(`EM_ASM`/`EM_JS`), which none of the modules PGlite ships (`plpgsql` and the encoding converters) does; the store loads
no extension.

Tabs of one store talk over BroadcastChannel and share Web Locks; both are same-origin and need no directive (a
follower tab runs under the same policy and starts no worker).

The dev server (`npm run dev:browser`) sends no policy.

## Scheduling, watchdog and reopen

PGlite runs every statement synchronously on the worker's thread, so the worker shares its time explicitly:

- **Turns.** The engine's scheduler yields one task before each sync batch and scan step (`scheduler.ts`), and the
  session monitor (`session.ts`) gives the event loop a turn before a statement once 10 ms have passed since the last
  one. Requests that arrived meanwhile enter the clients' session lock in arrival order, between whole transactions:
  an API read waits for at most the block transaction holding the session. Measured in Chrome on OPFS while the IDX
  range replays in the worker: page round trips p95 10 ms (`/v1/status`), 16 ms (`/v1/tokens`), 20 ms (an activity
  page), and the 1 s heartbeat never late by more than a few milliseconds.
- **Watchdog** (`supervisor.ts`, in the page). `statement_timeout` has no effect in PGlite and a statement that does not
  return holds the worker's thread, so only the page can end it. The worker posts a heartbeat every second after the
  page's `watchdog` request. When nothing has come for the limit (30 s; `?watchdogLimitMs=` on the engine page) and
  nothing during a grace of two heartbeats either, the page terminates the worker and starts a new one: the API request
  in flight gets the API's 503 `UNAVAILABLE` answer, other requests in flight `restarted`; the new worker carries the
  restart count and reason and the PGlite reopen count, boots on the same store and gets back the system snapshot's
  viewers and the engine of the last `start` (it continues at the stored cursors; an engine the page stopped stays
  stopped). While `range`, `reset`, `export` or `import` runs the limit is 10 min. More than 3 restarts within 10 min
  close the client with `worker-error`.
- **Reopen.** PGlite 0.5.8 fails every statement with "stack depth limit exceeded" once a database has failed about
  1,700 statements, until it is reopened. The host counts the statements the database fails and reopens the store at
  1,000 since it was opened, or at once on the first "stack depth limit exceeded": it holds new requests, stops the
  engine at a full block, lets the requests reading the store end, closes PGlite, opens it again and runs the same
  engine configuration (it continues at the cursors). Closing PGlite waits for the statements in flight: a statement
  queued inside PGlite 0.5.8 when it closes never returns.

## System snapshot

The worker keeps the engine's telemetry (`../engine/telemetry.ts`: per-endpoint requests, blocks per second, API
latency, the last 200 log lines, watchdog restarts, PGlite reopens, failed statements) and answers `system`:

- `watch: true` / `watch: false` (per `viewer`, default `page`): while at least one viewer watches, the worker reads the
  counters and `/v1/status` every 2 s and the catalog statistics every 30 s, and posts each snapshot as a `system`
  notice. With no viewer it collects nothing. A status page uses `followSystem(client, { onSnapshot })`
  (`system-view.ts`), which watches while the page is visible and stops when it is hidden or goes away.
- `refresh: { database?, exactCounts? }`: one snapshot now; exact row counts only when asked.
- "Download diagnostics": `diagnosticsFile(snapshot)` (the snapshot as JSON, redacted and validated).

The snapshot's schema is `../engine/system-snapshot.ts` (versioned, strict). The build defines its facts (app commit,
PGlite and ledger versions; `vite.config.ts`). The storage section is the storage guard's reading (`quota.ts`), the
start mode and the automatic start come from the saved configuration, the connected tabs from the tab locks; the
role is `leader` in the worker (a follower tab marks what it relays). The snapshots section is the worker's last
snapshot export and import (see Snapshots).

## System status page

`system.html` shows the whole system on one read-only page, from the `system` snapshot: **Overview** (the health line —
running, following, catching up, waiting (network), stalled (scan), paused (quota), stopped or error — with its
reason, this tab's role, the first indexed height, the archive and scan heights, the finalized tip and the lag in
blocks and time), **Configuration** (network, genesis, endpoints, pacing, batches, retry, start mode and range,
automatic start, durability, watchdog limit, API queue cap, build), **Sync** (heights, rates, requests per endpoint by
answer, last success, next attempt, last error), **Scan**, **Databases** (data directory, server version, `fsync`,
durability, size; per schema the applied migrations and per table the estimated rows and size, exact counts on
demand), **Storage**, **API**, **Engine** (role, connected tabs, uptime, watchdog restarts, reopens, failed
statements), **Browser**, **Snapshots** and **Logs** (the last 200 lines, newest first).

- The page joins the tabs like every page of the build: opened alone it leads (it runs the engine worker under the
  watchdog; `?watchdogLimitMs=` as on `engine.html`); beside a leader it is a follower and shows the leader's
  snapshots, marked "follower". The controls stay in the explorer's engine panel (`index.html`), which links here;
  this page links back.
- It follows the snapshots while it is visible (about every 2 s, the catalog about every 30 s) and reads nothing while
  it is hidden. "count rows exactly" reads `count(*)` of every table once.
- "Download diagnostics" saves the snapshot shown as JSON (`umbradb-diagnostics-<time>.json`, its log lines
  included): a download through a `blob:` URL and `<a download>`, which the policy allows. URLs lose their
  credentials, query and fragment, and secret-looking values (tokens, passwords, keys, `Authorization` and `Cookie`
  headers, Bearer and Basic credentials, JWTs, viewing keys) are replaced, in every string of the snapshot; a log line
  is redacted as it is written, before an event's fields become JSON.
- Text from the engine (error messages, log lines, URLs) is drawn as text nodes with the explorer's hidden-character
  rules (`visible-text.ts`, the rule of `../mip0018/ui/page.js`): every control, format, private-use, unassigned or
  surrogate code point, line or paragraph separator and default-ignorable character is drawn as a visible mark
  `⟨U+XXXX⟩`, each value in its own bidirectional island.
- For scripted use, `window.umbradbEngine` holds the client and the tabs, and `window.umbradbSystem.latest()` the
  snapshot drawn last.
