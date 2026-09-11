# Proposal — 00009-06: a dashboard for the shielded monitor, a list endpoint, and a key-derivation command

> Organizer spec: `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
> (approved 2026-09-10). Organizer sub-plan: `plans/00009-06-dashboard.md`.
> This change stacks on `00009-05-acceptance` (PR #13), which carries the fully merged alpha:
> the archive read contract, the monitor store, the relevance scanner, the private API and the
> reference consumer. It adds **no** new capability to any of them.

## Why this change exists

The alpha works and is proven to work — 42 required test ids, a real shielded transfer matched on
the Compose devnet, 400 randomized crash points. None of that is *visible*. To see the system do
anything today you must: hold a Bech32m viewing key you produced somewhere else, know the monitor
id you were handed once on stdout, and run `curl` or the reference CLI against an endpoint that
can only be asked about **one monitor at a time**, whose id you must already have.

Three concrete holes follow from that, and this change closes exactly those three:

1. **There is no way to ask "what monitors exist?"** `GET /v1/monitors/:id` needs an id.
   `PgShieldedMonitorStore.listActive` exists but is bounded to the two *scannable* states and is
   not reachable over HTTP. An operator who lost a monitor id has no recovery path short of
   opening `psql`, which is precisely the database access the private API exists to avoid needing.
2. **There is no way to *watch* coverage advance.** The one thing the spec's FR-011/FR-020
   distinction is about — unscanned history is not empty history — is a four-number relationship
   that changes every few seconds. Reading it by re-running a CLI is how you fail to notice that
   `scannedThrough` stopped moving.
3. **There is no way to produce a viewing key.** Every key in this repository so far came from a
   test helper or, for the acceptance run, from a one-off container holding the Midnight wallet
   SDK. The operator-facing path — "here is a seed, give me the string the register form wants,
   and tell me which address to fund" — does not exist as a command.

## What this change delivers

- **`GET /v1/monitors`** — the list route, one item per monitor in the same `MonitorView` shape
  `GET /v1/monitors/:id` returns, ordered by `createdAt`, page-capped by the existing
  `API_MAX_PAGE`. Backed by a new `PgShieldedMonitorStore.listAll(limit)` beside `listActive`.
- **`GET /ui`** — a single self-contained HTML page served by the API process itself: health and
  archive tip, a monitor table with state badges and a coverage bar, a register form, a matches
  panel with cursor paging, and a 3-second auto-refresh with a pause toggle. No build step, no
  framework, no external resource, `Content-Security-Policy: default-src 'self'`.
  `GET /ui/` serves the same page; `GET /` redirects to it.
- **`umbradb-shielded-monitor-derive-key`** — a CLI that reads a 32-byte hex seed from a **file**
  and prints the Bech32m `mn_shield-esk_<net>` viewing key plus the shielded coin public key and
  encryption public key (the address half, safe to publish, which is what you fund). Optional
  `--hd` applies the BIP32 derivation path `m/44'/2400'/0'/3/0` first.
- **`docs/shielded-monitor-demo.md`** — the runbook: the exact Compose, archive-sync, scanner and
  API commands from the Phase 5 acceptance run, with the ports randomized and the project name
  unique, ending with a match on the page.
- **`npm run demo:shielded-monitor`** — the wallet-free part of that runbook as one script.

## What this change explicitly does NOT cover

*(openspec `config.yaml` rule: every proposal states its non-goals.)*

- **No authentication, still.** Owner decision Q3 stands and this change does not soften it: the
  dashboard is served by the same unauthenticated process, on the same loopback bind, and grants a
  browser exactly what `curl` already had. A reader who takes "it has a UI now" to mean "it has a
  login" would be wrong, so the page itself says so, in the page, above the fold.
- **No multi-user anything.** No sessions, no cookies, no per-user views, no CSRF token — there is
  no user. US4 remains deferred.
- **No new runtime dependency.** No front-end framework, no bundler, no CSS library, no charting
  library, no icon font, no web font. `package.json`'s `dependencies` is byte-identical after this
  change. The page is one HTML string in one TypeScript module.
- **No remote resources at runtime.** The page loads nothing over the network except this API's own
  JSON. That is enforced by a CSP header *and* by a test that greps the served HTML.
- **No write operations the API did not already have.** The dashboard's buttons call the existing
  pause/resume/revoke/delete routes. The one new route that reads is the list; there is no new
  route that writes.
- **No key material in a URL, a log line, or the page's own storage.** The viewing key is typed
  into one field, sent once in a `POST` body, and never written to `localStorage`, never put in a
  query string, never echoed into the DOM.
- **No wallet, and no wallet SDK dependency.** The runbook's shielded-transfer step is described
  exactly as Phase 5 performed it — out of tree, in a one-off container — and stays out of tree.
- **No change to the matching rules, the scanner, the store's write path, the crash guarantees or
  the cursor contract.** Nothing in this change can alter what counts as a match.
- **No BIP39 wordlist and no mnemonic validation.** `--hd` takes a seed, not a mnemonic; see
  `design.md` §4 for why, and question Q20/Q21 in the organizer's questions file.

## Impact

- New files: `shielded-monitor/api/ui/page.ts` (the HTML), `shielded-monitor/derive-key-cli.ts`,
  `shielded-monitor/hd.ts`, `docs/shielded-monitor-demo.md`, `scripts/demo-shielded-monitor.mjs`.
- Changed: `shielded-monitor/store.ts` (+`listAll`), `shielded-monitor/api/server.ts` (+3 routes),
  `package.json` (+1 bin, +1 script), `docs/shielded-monitor-api.md`, `README.md`, `CHANGELOG.md`,
  `test/shielded-monitor/api-bin.test.ts` (bin non-vacuity pin 5 → 6).
- Additive for every existing consumer: no existing route, response field, error code, exit code,
  environment variable default or database object changes.
