# Proposal — 00009-04: the private shielded-monitor HTTP API and its reference consumer

> Organizer spec: `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
> (approved 2026-09-10). Organizer sub-plan: `plans/00009-04-private-api-cli.md`.
> This change implements **Phase 4 only**: the HTTP/JSON surface over the Phase 2 store, plus a
> reference consumer CLI. The relevance scanner (Phase 3, `00009-03`) is a separate change and is
> explicitly out of scope here.

## Why this change exists

Phase 2 (`00009-02`, PR #10) delivered project **B**'s storage core: a `shielded_monitor` schema,
validated viewing-key intake, a fenced lifecycle, and `PgShieldedMonitorStore`. It is driven today
only by a **trusted, in-process harness** (`storage-api/harness-cli.ts`) that speaks directly
to PostgreSQL with operator credentials.

That is not a consumer surface. The proposal's step 2 acceptance is that **one application
completes the whole flow — register, discover history, follow live, pause, resume, revoke,
delete — by cursor polling over a network protocol**, holding no database credentials and no
schema knowledge. Nothing in the repository does that yet: there is no HTTP server anywhere in
this stack, no cursor encoding, and no consumer client.

Three properties make this worth its own change rather than a corner of the scanner's:

1. **The consumer contract is a different audience from the scanner's.** What a wallet application
   sees — status, coverage, a page of matches, a cursor it can persist across restarts — is
   reviewable on its own, against organizer spec FR-017..021, without any opinion about how
   relevance is computed.
2. **Coverage must be legible over the wire.** Organizer spec FR-020 forbids presenting an
   unscanned range as an empty result. That is a property of the *response shape*, not of the
   store: every status and matches response carries `requestedStart`, `scannedFrom`,
   `scannedThrough` and `sourceTip` so a consumer can always distinguish "nothing matched" from
   "not looked yet".
3. **The key must not escape.** FR-023/SC-004 require that no viewing key appears in a log line or
   an error body. An HTTP layer is where that is easiest to get wrong (request logging, validation
   errors echoing the offending field, unhandled-rejection dumps), so the hygiene rules and their
   test belong with the server.

## What this change delivers

- `shielded-monitor/api/` — a JSON HTTP server on Node's built-in `http`, with:
  - `POST /v1/monitors`, `GET /v1/monitors/:id`, `GET /v1/monitors/:id/matches`,
    `POST /v1/monitors/:id/{pause,resume,revoke}`, `DELETE /v1/monitors/:id`;
  - zod boundary schemas, a body-size cap, a page-size cap, per-request ids;
  - an opaque base64url cursor bound to its monitor;
  - a typed error mapper over the Phase 2 store's error classes (404 unknown, 410 revoked,
    409 illegal transition, 400 validation).
- `shielded-monitor/client/cli.ts` — the reference consumer: `register`, `status`, `poll`
  (idempotent cursor-file resume), `pause`, `resume`, `revoke`, `delete`. It speaks only HTTP; it
  imports no store, no driver and no schema name.
- Two `package.json` bin entries — `umbradb-shielded-monitor-api` and
  `umbradb-shielded-monitor-client` — so both are shippable CLI entry points of the same package
  (organizer spec FR-026).
- `docs/shielded-monitor-api.md`: the endpoint reference, the coverage contract, the cursor
  contract, and the deployment restriction the missing authentication makes mandatory.

## What this change explicitly does NOT cover (non-goals)

- **No authentication, no authorization, no tenant scoping, no rate limiting, no quotas.** Owner
  decision Q3 (2026-09-10): the alpha private API has *no security*. The server binds `127.0.0.1`
  by default and the deployment is required to restrict network access. The only admission
  controls are a request-body size cap and a page-size cap. Anyone who can reach the port can
  register, read and delete any monitor. This is stated in `README.md`, `SECURITY.md` and
  `docs/shielded-monitor-api.md`, not left implicit.
- **No cursor signing or encryption.** The cursor is opaque (base64url) but unauthenticated: a
  caller can forge one. It is bound to its monitor id, so a forged cursor can only move a caller
  within a monitor it can already read in full. Signing is deferred with User Story 4.
- **No TLS.** Terminating TLS is the deployment's job; the server speaks plain HTTP on loopback.
- **No scanner.** Nothing in this change reads the archive, decodes a transaction or evaluates
  `EncryptionSecretKey.test(offer)`. Coverage advances only when something else calls
  `store.advance` — the Phase 2 harness today, the Phase 3 scanner later. The API is therefore
  correct but *idle* on a stack without a scanner, and its tests seed associations through the
  store exactly as the harness does.
- **No `sourceTip` source.** `sourceTip` is served through an injectable
  `SourceTipProvider` seam. This change ships only the "unknown" provider, which reports
  `sourceTip: null`; Phase 3 wires the archive read contract into it. The field is nullable *in the
  wire contract* precisely so it cannot silently become a false zero (see `design.md` §5 and
  organizer question Q14).
- **No encryption at rest and no key wrapping.** Deferred with User Story 4, as in `00009-02`.
- **No change to any existing table, migration, interface, exported symbol or gate.** This change
  adds no migration and touches nothing under `src/`.
- **No live Compose end-to-end run with real shielded transactions.** That needs Phase 3's
  scanner, which does not exist on any branch at the time of writing; it is recorded as deferred to
  Phase 5 in the organizer sub-plan. The end-to-end evidence this change *does* provide is the
  reference client driving the real HTTP server against a real PostgreSQL, with matches seeded
  through the store.

## Impact

- Additive only. No existing file under `src/` changes; no migration is added; a deployment that
  never starts the API is byte-for-byte unaffected.
- `package.json` gains two `bin` entries and `tsconfig.cli.json`'s `include` gains
  `shielded-monitor/**/*.ts` so those entry points are actually emitted into `dist-cli`. The
  published *library* surface (`dist/index.js`, its `exports` map and the frozen barrel) does not
  change.
- `test/integration/required-tests.manifest.json` gains three required ids (cursor exactly-once,
  key-never-logged, client end-to-end) and `EXPECTED_REQUIRED_COUNT` moves 28 → 31 — the gate is
  strengthened, never relaxed. **Merge note:** PR #9 (`00009-01`) moves the same pin 25 → 29 and
  PR #10 (`00009-02`) moves it 25 → 28; a branch carrying all three must take the **union** of the
  id lists and set the count to their total (32 + 3 = 35), never one side's number.
