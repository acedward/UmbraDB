# Tasks — 00009-04: the private shielded-monitor HTTP API and its reference consumer

Each task states its acceptance criteria as a concrete command or a named test that must pass.
`vitest run <file>` below always means `npx vitest run <file>`; the whole set must also pass under
`npm run typecheck` and `VITEST_MAX_WORKERS=2 npm run test:conformance`.

---

## 1. Cursor codec

`shielded-monitor/api/cursor.ts`: `encodeCursor(monitorId, seq)` → base64url of
`"<monitorId>:<seq>"`; `decodeCursor(text, expectedMonitorId)` → `bigint`, throwing
`CursorError` when the string is not base64url, not the expected shape, names a different monitor,
or carries a negative / non-integer sequence.

**Acceptance criteria**

- `vitest run test/shielded-monitor/api-cursor.test.ts` passes (no Docker): a fast-check round-trip
  property over random UUIDs and sequences up to 2^63−1 (`decode(encode(id, s), id) === s`); a
  cursor minted for monitor A rejected against monitor B; each malformed input class rejected with
  its own reason asserted, not merely "threw".
- The encoding contains no `+`, `/` or `=` for any input (query-string safety).

## 2. HTTP server

`shielded-monitor/api/server.ts`: `createShieldedMonitorApi(deps)` returning a `startServer`
handle over `node:http`; routes per `design.md`; zod boundary schemas; body cap enforced while
reading; per-request id; a structured logger that never sees a body.

**Acceptance criteria**

- `vitest run test/shielded-monitor/api.integration.test.ts` passes against a Testcontainers
  PostgreSQL 17, covering every route: `POST /v1/monitors` → 201 with a monitor view whose
  `coverage` carries all four fields and which contains **no** `viewingKey` and no `fingerprint`;
  `GET /v1/monitors/:id` → 200; unknown id → 404; revoked → 410; deleted → 404; `resume` on a
  non-paused monitor → 409; unknown route → 404; wrong method → 405; non-JSON content type → 415.
- Oversized body → 400 `BODY_TOO_LARGE`, asserted with a body one byte over `API_MAX_BODY_BYTES`.
- `limit=0`, `limit=-1`, `limit=<API_MAX_PAGE + 1>` and `limit=abc` each → 400.
- A malformed cursor and a cursor minted for another monitor each → 400.
- `vitest run test/shielded-monitor/api-config.test.ts` passes (no Docker): boot with
  `API_MAX_PAGE` above the store's `MAX_ASSOCIATION_PAGE`, with a default page above the cap, or
  with any non-decimal / out-of-range numeric variable, fails at configuration time and names the
  offending variable — not at request time.

## 3. Coverage in every response

Status and matches responses carry `{requestedStart, scannedFrom, scannedThrough, sourceTip}` as
decimal strings or `null`, from the store's `MonitorCoverage` plus the injectable
`SourceTipProvider`.

**Acceptance criteria**

- In `api.integration.test.ts`: a monitor with no advance yet reports
  `scannedFrom: null, scannedThrough: null` while `items` is `[]`, and the two are asserted to be
  distinguishable (the test fails if `scannedThrough` is rendered as `"0"`).
- After an advance over a range with no matches, `scannedThrough` moves and `items` stays `[]` —
  the FR-020 case, asserted as a state transition rather than a single snapshot.
- With a `SourceTipProvider` supplied, `sourceTip` is that value; with the default provider it is
  `null` and never `"0"`.

## 4. Cursor paging over associations

`GET /v1/monitors/:id/matches?cursor&limit` returns `{items, nextCursor, coverage}` in
`(blockHeight, position)` order.

**Acceptance criteria**

- In `api.integration.test.ts`, with N=37 associations seeded directly through
  `PgShieldedMonitorStore.advance` across several heights: paging with `limit=5` from an empty
  cursor visits **every** association exactly once, in `(blockHeight, position)` order, and the
  concatenation equals the seeded set — required id
  `shielded-monitor.api.cursor-pages-each-match-exactly-once`.
- Re-issuing the *same* cursor returns a byte-identical page.
- A page beyond current coverage is empty and returns the caller's own cursor unchanged, so a
  poller cannot lose its position at the end of the stream.

## 5. Key hygiene

**Acceptance criteria**

- Required id `shielded-monitor.api.key-never-logged` in `api.integration.test.ts`: after
  exercising every endpoint with one dedicated key, including four failing registrations (bad
  checksum, mixed-case Bech32m, the SAME key bytes encoded for the WRONG network, and a schema
  failure with the key present in the body), every captured log record and every captured
  response body is scanned for the Bech32m string, its data part, and the serialized bytes in
  hex, base64 and base64url — zero hits.
- A **positive control** in the same test feeds the capture a line containing the key and asserts
  the scanner finds it, so a scanner that cannot detect a leak fails the gate.
- Every intake failure class — malformed Bech32m, wrong-network HRP, junk payload, non-canonical
  payload — produces the byte-identical generic message (a separate table-driven case).
- The DEFAULT `stderrLogger` is exercised too, with the process's own stderr captured, so the
  clean result is not an artefact of the capturing logger the rest of the suite injects.
- The create route logs no error MESSAGE at all, while other routes do (asserted both ways).

## 6. Reference consumer CLI

`shielded-monitor/client/cli.ts`, bin `umbradb-shielded-monitor-client`: `register --key-file
--start`, `status`, `poll --cursor-file`, `pause`, `resume`, `revoke`, `delete`.

**Acceptance criteria**

- Required id `shielded-monitor.client.end-to-end-lifecycle` in
  `test/shielded-monitor/client-cli.integration.test.ts`: the client drives a **real** HTTP server
  over a real socket against a Testcontainers PostgreSQL through register → status → poll (empty)
  → advance-with-matches (seeded through the store, standing in for Phase 3's scanner) → poll →
  pause → resume → revoke → delete, asserting the state and coverage at each step.
- `poll` is idempotent on resume: running it twice with no new associations leaves the cursor file
  byte-identical and prints no duplicate transaction hash.
- The client's whole import closure is audited in the same test: only `node:` built-ins, no store,
  no `postgres`, no schema name.
- Client output never contains the viewing key (the same scan as task 5, over the client's stdout).

## 7. Bin entries, docs and README

Two `bin` entries; `tsconfig.cli.json` includes `shielded-monitor/**/*.ts`;
`docs/shielded-monitor-api.md`; a README section stating the deployment must restrict network
access.

**Acceptance criteria**

- `npm run build` succeeds and emits `dist-cli/shielded-monitor/api/server-cli.js` and
  `dist-cli/shielded-monitor/client/cli.js` — the exact paths the two `bin` entries name (asserted
  by `vitest run test/shielded-monitor/api-bin.test.ts`, which reads `package.json` and checks
  each `bin` target is produced by `tsconfig.cli.json`'s `include`).
- `npm run typecheck` clean.
- `docs/shielded-monitor-api.md` documents every endpoint, the coverage object, the cursor
  contract, every environment variable and the no-authentication posture.

## 8. Required-tests manifest

Three new required ids, count pin 28 → 31.

**Acceptance criteria**

- `vitest run test/integration/check-required-tests.test.ts` passes with the new count.
- `VITEST_MAX_WORKERS=2 npm run test:conformance` reports
  `all 31 required test(s) executed and passed`.

## 9. Close-out

**Acceptance criteria**

- `npm run typecheck` and `VITEST_MAX_WORKERS=2 npm run test:conformance` both green at the head
  commit, recorded with counts in the organizer sub-plan's evidence log.
- Draft PR opened against `feat/indexer-independent-ingest` stating the additive impact, the
  unauthenticated-by-design posture and the `EXPECTED_REQUIRED_COUNT` union rule.
- **Not performed here, and recorded rather than implied:** `graphify` is not installed in this
  environment (`which graphify` → not found), so `CLAUDE.md`'s "re-run `graphify update .` and
  commit `graphify-out/`" close-out step could not run; committing a stale or partially
  regenerated graph would be worse than leaving it. Called out in the PR description.
- **Deferred to Phase 5, not skipped:** the Compose end-to-end run with a real shielded transaction
  (SC-005/SC-008's live half) needs Phase 3's scanner, which is not on `origin` at the time of
  writing (`git fetch origin --prune` shows no `origin/feat/00009-03-relevance-scanner`; a local,
  still-advancing branch of that name exists in the shared clone, but merging an unpushed branch
  another runner is actively committing to would put their unreviewed work in this PR and collide
  on the `EXPECTED_REQUIRED_COUNT` pin both branches move).
- **Stated as unverified rather than as passing:** `gitleaks detect` — the binary is not installed
  in this environment (`which gitleaks` → not found). Every file this branch touches was scanned
  by hand for a Bech32m key, a credential literal, a private-key header and an API-key assignment,
  with a positive control proving the scan fires; nothing was found. The Compose-based
  `chain-archive-parity` and live-service jobs are owner-gated and unrelated to this surface.
