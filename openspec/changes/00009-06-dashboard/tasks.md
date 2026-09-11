# Tasks — 00009-06: dashboard, list endpoint, key derivation, demo runbook

Each task states the command that must succeed or the test that must pass
(openspec `config.yaml` rule: acceptance criteria are concrete, not descriptions of work).

## 1. `PgShieldedMonitorStore.listAll(limit)`

Add a read beside `listAll`'s sibling `listActive`: every monitor whose state is not `deleted`,
ordered `created_at, id`, bounded by the same `z.number().int().positive().max(10_000)` guard.

**Acceptance**: `npx vitest run test/shielded-monitor/store.integration.test.ts` passes, including
new cases proving (a) revoked monitors are returned and deleted monitors are not, (b) the order is
`created_at, id` for monitors registered out of order, (c) `limit` bounds the result and a
non-positive or oversized limit is a `ValidationError`.

## 2. `GET /v1/monitors`

Add the route to the collection path in `shielded-monitor/api/server.ts`; items are built with the
existing `monitorView`; the page cap is the existing `API_MAX_PAGE`, the default the existing
`API_DEFAULT_PAGE`; `?limit=` is parsed by the existing `parseLimit`.

**Acceptance**: `npx vitest run test/shielded-monitor/api.integration.test.ts` passes with new
cases for: empty list; several monitors in several states in `createdAt` order; a revoked monitor
present with `state: "revoked"` while `GET /v1/monitors/:id` for the same id answers `410`; a
deleted monitor absent; `?limit=0` and `?limit=<above cap>` both `400`; the response carrying no
`fingerprint` and no `viewingKey` key anywhere in its JSON.

## 3. `GET /ui`, `GET /ui/`, `GET /` → 302

Serve the embedded page with `content-type: text/html; charset=utf-8`, the CSP header from
design §3, `x-content-type-options: nosniff` and `referrer-policy: no-referrer`.

**Acceptance**: `npx vitest run test/shielded-monitor/api-ui.test.ts` passes: `/ui` and `/ui/`
return `200` with the CSP header; `/` returns `302` with `location: /ui`; `POST /ui` returns
`405`; the served HTML contains **no** `src=`/`href=`/`url(` referencing an absolute `http://` or
`https://` URL; every `/v1/...` path literal appearing in the page resolves against the server's
own route table; the page's tags balance.

## 4. Key hygiene on the dashboard's path

Extend the required test `shielded-monitor.api.key-never-logged` so the corpus it scans includes a
registration issued the way the page issues it (same headers, same body shape), and add the served
HTML to the scanned haystack.

**Acceptance**: `npx vitest run test/shielded-monitor/api.integration.test.ts -t "key-never-logged"`
passes, its positive control still fires, and `npm run test:conformance` reconciles the id as
executed-and-passed.

## 5. `shielded-monitor/hd.ts` — BIP32 `m/44'/2400'/account'/role/index`

Node built-ins only: `createHmac("sha512")`, `createECDH("secp256k1")`, `BigInt`.

**Acceptance**: `npx vitest run test/shielded-monitor/hd.test.ts` passes, covering (a) all six
nodes of BIP-0032 official test vector 1 compared as serialized `xprv` strings, (b) the three
`@midnightntwrk/wallet-sdk-hd@3.0.3` vectors reproduced exactly (role seed, coin public key,
encryption public key), (c) a rejected seed length and a rejected out-of-range child index.

## 6. `umbradb-shielded-monitor-derive-key`

`shielded-monitor/derive-key-cli.ts`, shebang, added to `package.json` `bin`.

**Acceptance**: `npx vitest run test/shielded-monitor/derive-key.test.ts` passes, covering: the
raw-seed output equals `fixtureViewingKeyEncoded(n)` for the same fixture seed; `--hd` reproduces
the SDK vector's keys; the seed never appears in stdout or stderr; `--seed <hex>` on argv is a
usage error (exit 2) naming `--seed-file`; a short/long/non-hex seed file is a usage error;
`--net preview` changes the HRP. `npx vitest run test/shielded-monitor/api-bin.test.ts` passes
with the non-vacuity pin at six bins, and `npm run build` emits `dist-cli/shielded-monitor/derive-key-cli.js`.

## 7. `docs/shielded-monitor-demo.md` and `npm run demo:shielded-monitor`

The runbook carries the exact commands from the `00009-05` acceptance run with the project name
and ports parameterised; the script automates only the wallet-free part.

**Acceptance**: `node --check scripts/demo-shielded-monitor.mjs` exits 0; the runbook's wallet-free
half is executed once on this host and its curl outputs are recorded in the sub-plan's evidence
log; `npm run demo:shielded-monitor -- --help` prints usage and exits 0 without touching Docker.

## 8. Docs and change records

`docs/shielded-monitor-api.md` gains `GET /v1/monitors`, `GET /ui` and the revoked-list asymmetry;
`README.md` points at the dashboard and the runbook; `CHANGELOG.md` gets an Unreleased entry;
`SECURITY.md` gains the dashboard's one sentence (it is the same unauthenticated surface).

**Acceptance**: `npm run docs:storage:check` (typedoc, warnings-as-errors) exits 0;
`npx tsc --noEmit` and `npx tsc -p tsconfig.cli.json --noEmit` exit 0.

## 9. Gates

**Acceptance**: `npx tsc --noEmit` exit 0; `npm run build` exit 0 with all six bins resolving to
emitted files; `VITEST_MAX_WORKERS=2 npm run test:conformance` exit 0 with every required id
reconciled as executed-and-passed and zero coverage-threshold errors.
