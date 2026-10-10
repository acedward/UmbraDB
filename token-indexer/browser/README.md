# The token indexer in the browser

The engine (`../engine/engine.ts`: the chain-archive sync, the MIP-0018 scan and the API) runs in Chrome in a dedicated
module worker, on PGlite stored in the Origin Private File System. The page talks to it with messages; nothing but
static files is served.

```sh
npm run build:browser   # the static site in dist-browser/ (engine.html + assets/)
npm run dev:browser     # the same configuration served by Vite on 127.0.0.1
```

## Modules

| Module | Role |
|---|---|
| `worker.ts` | The worker's entry: the host below on `opfs-ahp://umbradb-stagenet`, bound to the worker's messages |
| `host.ts` | Boot, request dispatch and the engine's lifecycle, from injected dependencies (tests run it in Node on `memory://`) |
| `protocol.ts` | The message protocol: versions, requests, results, errors and notices, each with a zod schema |
| `client.ts` | The page's side: `startEngineWorker()` and `createEngineClient(endpoint)` (requests as promises of validated results) |
| `capabilities.ts` | The Chrome-only capability check run before anything else |
| `store.ts` | Opens PGlite and its two clients (`chain_archive`, `mip0018`); non-durable, results and errors as on PostgreSQL |
| `scheduler.ts` | Yields to the worker's event loop before each sync batch and scan step, so messages are served while it runs |
| `tapes.ts`, `tapes/` | The recorded Stagenet ranges (gzip) the worker can replay with no network, SHA-256 checked |
| `config.ts` | The network, its default endpoints, the store's location and the build's settings |
| `settings.ts` | The engine's saved configuration, a file beside the store |
| `quota.ts` | The storage guard: pauses the sync before the quota |
| `engine.html`, `engine-page.ts` | A page that starts the worker and shows its status; `window.umbradbEngine` holds the client |
| `vite.config.ts`, `build-guard.ts` | The build (Node tooling): ES module worker, `esnext`, class names kept, `vite-plugin-wasm` for ledger-v9's WASM module, assets as files, and a plugin that fails the build if postgres.js or a Node built-in would be bundled |

## Boot

The worker boots as soon as it loads, in phases posted as `boot` notices and reported by `status`:
`capabilities` → `store` → `ledger` → `migrate` → `ready`.

- **capabilities**: Chrome (a Chromium browser), OPFS with sync access handles (a probe file is opened), Web Locks,
  BroadcastChannel and persistent storage. If any is missing the boot ends `unsupported` with a "Chrome only" message
  and nothing is opened or started. (`navigator.storage.persist()` exists only in a window; the worker checks
  `persisted()`.)
- **store**: PGlite opens the store; the first open creates the database (about a second, with a second PGlite heap
  while it runs).
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
| `export`, `import` | as in `protocol.ts` | error `not-implemented` |

Error codes: `bad-request`, `unsupported-version`, `unknown-type`, `not-implemented`, `unsupported-browser`,
`boot-failed`, `already-running`, `start-failed`, `internal`; the client adds `bad-response`, `worker-error` and
`closed`. Notices: `boot` (each phase) and `engine` (`running`, `stopped`, `failed`).

While no engine runs, `api` answers from the same store with no loops (`/v1/status` reports `scanner: "off"`). Defaults
in the browser: 20 heights per sync batch and 10 blocks per scan step, so a stop and API requests wait for little.

## Sync

- **Start at the tip.** A new archive starts at `startHeight`, by default the finalized tip both sources serve when the
  sync begins, `min(node finalized height, indexer tip)`, read with the same clients and retries as every batch. While
  the endpoints fail the engine waits (each attempt's calls retried, then a wait doubling from 1 s to 60 s, with
  jitter) and asks again; it never starts at genesis by default. `/v1/status` `startHeight` is the first indexed
  height: history before it is not indexed. Requests to the Stagenet endpoints are spaced 250 ms apart per endpoint and
  a throttling answer is retried after its `Retry-After`, as in the Node commands.
- **Automatic start and resume.** The configuration of the last `start` or `range` is saved beside the store
  (`settings.ts`: `umbradb-stagenet.engine.json` in the OPFS root), with whether the engine starts by itself. When the
  worker boots it starts that configuration (the build's default for a new store: the tip, following it), unless a
  `stop` request turned that off. A reopened store continues at its cursor and fetches every height since, so a closed
  or frozen tab leaves no hole; a chosen range keeps its end.
- **Ranges.** One archive has no gaps and no backfill, so `range` (a new start or end) and `reset` drop the store's data
  (both schemas, in one transaction) and migrate again before starting. The page offers an export first; the host takes
  a `beforeWipe` hook for that.
- **Persistent storage.** `navigator.storage.persist()` exists only in a window: `startEngineWorker()` asks for it when
  the page starts the worker (`persistence` holds the answer), and the worker's `storage.persisted` reports the outcome.
  A refusal changes nothing else.
- **Storage quota** (`quota.ts`). Before a sync batch (reading again when the last reading is 10 s old) the worker
  compares `navigator.storage.estimate()`'s usage with its quota. While the store is open that usage includes the space
  Chrome reserves for the store's open files (about 1 GB in the session that creates the store, for about 42 MB of
  files; reopening the page releases it), and Chrome refuses a write once usage, reservations included, would pass the
  quota, so the reported usage is what decides. The sync pauses once usage ≥ quota − max(256 MiB, 10 % of the quota)
  and resumes once usage is 32 MiB under that, read every 30 s while paused; the scan and the API keep running. The
  reading (usage, quota, the threshold, the size of the store's files from an OPFS walk, `persisted`, the pause and its
  reason) is `status`'s `storage`, and the system snapshot's storage provider.

## Build settings

`config.ts` holds the network, its endpoints and the store's location. A build can set `__UMBRADB_BROWSER_CONFIG__`
through Vite's `define` (JSON): `autoStart` (default true), `start` (the configuration a new store starts with, default
`{}`) and `quota` (the storage guard's `checkEveryMs`, `recheckMs`, `storeEveryMs`). The browser tests use it to turn
the automatic start off, or to point it at a local chain.
