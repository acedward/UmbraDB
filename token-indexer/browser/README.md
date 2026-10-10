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
| `client.ts` | The page's side: `startEngineWorker()` (the worker under the page's watchdog) and `createEngineClient(endpoint)` (requests as promises of validated results) |
| `supervisor.ts` | The page's watchdog: heartbeats, terminate and restart of a worker that stopped answering, what the page set up restored on the new worker |
| `host-system.ts` | The worker's telemetry, `system` snapshot collector and viewers, and the watchdog's heartbeat |
| `system-view.ts` | The page's side of the `system` snapshot: follow it while the page is visible, refresh it, "Download diagnostics" |
| `session.ts` | The worker's view of its PGlite session: turns for the event loop between statements, failed statements counted |
| `capabilities.ts` | The Chrome-only capability check run before anything else |
| `store.ts` | Opens PGlite and its two clients (`chain_archive`, `mip0018`); non-durable, results and errors as on PostgreSQL |
| `scheduler.ts` | Yields to the worker's event loop before each sync batch and scan step, so messages are served while it runs |
| `tapes.ts`, `tapes/` | The recorded Stagenet ranges (gzip) the worker can replay with no network, SHA-256 checked |
| `config.ts` | The network, its default endpoints and the store's location |
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
| `status` | — | boot state, store facts (data directory, created, PostgreSQL version, `fsync`, durability, applied migrations), the last engine's configuration and loop status, the stored cursors |
| `api` | `method`, `target` | the API's answer `{ status, headers, body }` (`../API.md`) |
| `start` | `config`: `source` (`{ kind: "network", nodeUrl?, indexerUrl? }` or `{ kind: "tape", range: "idx" \| "u1", finalizedHeight?, advance? }`), `startHeight?`, `endHeight?`, `sync?`, `scan?` | status |
| `stop` | — | status |
| `system` | `watch` (with `viewer?`) or `refresh: { database?, exactCounts? }` | `{ watching, viewers, snapshot }`: the snapshot of a refresh (`null` for a watch) |
| `watchdog` | `limitMs`, `heartbeatMs?`, `carried?` | `{ limitMs, heartbeatMs }` |
| `range`, `reset`, `export`, `import` | as in `protocol.ts` | error `not-implemented` |

Error codes: `bad-request`, `unsupported-version`, `unknown-type`, `not-implemented`, `unsupported-browser`,
`boot-failed`, `already-running`, `start-failed`, `internal`; the client adds `bad-response`, `worker-error`,
`restarted` and `closed`. Notices: `boot` (each phase), `engine` (`running`, `stopped`, `failed`), `system` (one
snapshot per collection while watched) and `heartbeat` (after a `watchdog` request).

A first `start` on an empty archive needs `startHeight`; a store whose archive has a cursor continues from it. While no
engine runs, `api` answers from the same store with no loops (`/v1/status` reports `scanner: "off"`). Defaults in the
browser: 20 heights per sync batch and 10 blocks per scan step, so a stop and API requests wait for little.

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
PGlite and ledger versions; `vite.config.ts`). Some values have placeholder providers until the parts that own them
exist (`host-system.ts`): storage reads `navigator.storage.estimate()` and `persisted()` with no quota pause, no
snapshot export or import is recorded, the role is `leader` with the connected tabs unknown, and the start mode is
`range` without auto-start.

