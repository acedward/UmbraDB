# The token indexer in the browser

The engine (`../engine/engine.ts`: the chain-archive sync, the MIP-0018 scan and the API) runs in Chrome in a dedicated
module worker, on PGlite stored in the Origin Private File System. The page talks to it with messages; nothing but
static files is served.

```sh
npm run build:browser   # the static site in dist-browser/ (engine.html, assets/ and _headers)
npm run dev:browser     # the same configuration served by Vite on 127.0.0.1 (no security headers)
```

The build indexes Stagenet unless `UMBRADB_BROWSER_NETWORK`, `UMBRADB_BROWSER_NODE_URL` and
`UMBRADB_BROWSER_INDEXER_URL` say otherwise when it runs (see [Security headers](#security-headers)).

## Modules

| Module | Role |
|---|---|
| `worker.ts` | The worker's entry: the host below on `opfs-ahp://umbradb-stagenet`, bound to the worker's messages |
| `host.ts` | Boot, request dispatch and the engine's lifecycle, from injected dependencies (tests run it in Node on `memory://`) |
| `protocol.ts` | The message protocol: versions, requests, results, errors and notices, each with a zod schema |
| `client.ts` | The page's side: `startEngineWorker()` (through the Trusted Types policy below) and `createEngineClient(endpoint)` (requests as promises of validated results) |
| `capabilities.ts` | The Chrome-only capability check run before anything else |
| `store.ts` | Opens PGlite and its two clients (`chain_archive`, `mip0018`); non-durable, results and errors as on PostgreSQL |
| `scheduler.ts` | Yields to the worker's event loop before each sync batch and scan step, so messages are served while it runs |
| `tapes.ts`, `tapes/` | The recorded Stagenet ranges (gzip) the worker can replay with no network, SHA-256 checked |
| `config.ts` | The network, its default endpoints (fixed when the site is built) and the store's location |
| `trusted-worker.ts` | The pages' one Trusted Types policy, `umbradb-engine-worker`, which makes the engine worker's script URL |
| `zod-jitless.ts` | Turns zod's JIT (`new Function`) off before any schema exists; the first module of the worker and of every page |
| `engine.html`, `engine-page.ts` | A page that starts the worker and shows its status; `window.umbradbEngine` holds the client |
| `vite.config.ts`, `build-guard.ts`, `build-csp.ts` | The build (Node tooling): every `*.html` here is a page, ES module worker, `esnext`, class names kept, `vite-plugin-wasm` for ledger-v9's WASM module, assets as files, a plugin that fails the build if postgres.js or a Node built-in would be bundled, and a plugin that writes the pages' security headers |

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
`closed`. Notices: `boot` (each phase) and `engine` (`running`, `stopped`, `failed`).

A first `start` on an empty archive needs `startHeight`; a store whose archive has a cursor continues from it. While no
engine runs, `api` answers from the same store with no loops (`/v1/status` reports `scanner: "off"`). Defaults in the
browser: 20 heights per sync batch and 10 blocks per scan step, so a stop and API requests wait for little.

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

The dev server (`npm run dev:browser`) sends no policy.
