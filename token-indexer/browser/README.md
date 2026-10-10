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
| `tabs.ts` | One engine across tabs: `connectEngineTabs()` elects the leader tab, which alone runs the worker; the other tabs proxy their requests to it and take over when it closes |
| `tab-locks.ts` | The Web Locks behind that (leader, tab presence, store) and the connected-tab count |
| `capabilities.ts` | The Chrome-only capability check run before anything else |
| `store.ts` | Opens PGlite and its two clients (`chain_archive`, `mip0018`); non-durable, results and errors as on PostgreSQL |
| `scheduler.ts` | Yields to the worker's event loop before each sync batch and scan step, so messages are served while it runs |
| `tapes.ts`, `tapes/` | The recorded Stagenet ranges (gzip) the worker can replay with no network, SHA-256 checked |
| `config.ts` | The network, its default endpoints and the store's location |
| `engine.html`, `engine-page.ts` | A page that joins the tabs, shows its role and the engine's status; `window.umbradbEngine` holds the client and the tabs |
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
| `range`, `reset`, `export`, `import` | as in `protocol.ts` | error `not-implemented` |

Error codes: `bad-request`, `unsupported-version`, `unknown-type`, `not-implemented`, `unsupported-browser`,
`boot-failed`, `already-running`, `start-failed`, `internal`; the client adds `bad-response`, `worker-error` and
`closed`, and a page sharing the engine with other tabs also `leader-changed` and `leader-unavailable` (see Tabs). Notices: `boot` (each phase) and `engine` (`running`, `stopped`, `failed`).

A first `start` on an empty archive needs `startHeight`; a store whose archive has a cursor continues from it. While no
engine runs, `api` answers from the same store with no loops (`/v1/status` reports `scanner: "off"`). Defaults in the
browser: 20 heights per sync batch and 10 blocks per scan step, so a stop and API requests wait for little.

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
  cursors). Requests in flight to the closed leader: `status`, `api` and `export` are sent again to the next leader;
  any other request fails with `leader-changed` (it may or may not have been applied); a request made while no leader
  is known waits up to 10 s, then fails with `leader-unavailable`.
- **Store lock.** The worker opens the store only under `umbradb-store:<store>`, held until it closes the store or ends,
  and waits until no other context still holds the store's files, so a closed tab's worker that is still shutting down
  and its successor never have the store open together.
- Leadership belongs to the tab: replacing the leader tab's worker does not move it. `connectedTabs()` counts the
  presence locks; `connectedTabsCounter()` (`tab-locks.ts`) gives the same count synchronously, e.g. inside the worker.

