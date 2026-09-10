# Design — 00009-04: the private shielded-monitor HTTP API and its reference consumer

Every decision below is stated against the repository's existing design documents. Where this
change touches a decision those documents already made, the section is cited; where it makes a
genuinely new decision, the new decision is stated as such together with the reason it does not
contradict the cited section.

Cited throughout:

- `design/design.md` §5 (commit/transaction layer — what a caller may and may not assume about
  transaction boundaries), §7 (driver/toolkit choice — the dependency-minimalism rule this change
  inherits), §0 (tier reconciliation — why the API is not a Tier-2 indexer surface).
- `design/design-interfaces.md` §1.1 (one error idiom: thrown, `code`-discriminated typed errors),
  §1.2 (async pattern), §1.4 (runtime validation with Zod *at the boundary*), §1.5 (naming),
  §2 (`storage-errors.ts` as the shared base).
- `Formal/STORAGE_ALGEBRA.md` §1 (the CAS guard and its gapless-version law — the shape the cursor
  reuses on the read side), §3 (watermarks are last-write-wins and monotonicity is deliberately
  *not* a law there — the contrast that makes coverage's monotonicity worth stating here), §5 (the
  fast-check testable-law deliverable, the shape the cursor round-trip property follows).
- `openspec/changes/00009-02-monitor-store/design.md` §§1–2 (the schema's tier placement and the
  outside-`src/` module discipline this change extends), §6 (the fenced `advance`).

---

## 1. No HTTP framework: Node's built-in `http`, and why that is not asceticism

`design/design.md` §7 chose `postgres.js` over an ORM on an explicit dependency-minimalism
argument: every runtime dependency is code this project must audit, pin and keep supply-chain
evidence for. `docs/supply-chain/` carries that evidence per dependency, and the organizer
sub-plan restates the rule ("no new HTTP framework unless the owner allows one; supply-chain gate
applies").

This surface does not earn an exception. It is six routes over two path shapes, JSON in and JSON
out, with no middleware stack, no content negotiation, no templating, no static files, no cookies
and no sessions. What a framework would actually contribute here is a router (≈ 30 lines of
`URL.pathname` matching), body accumulation with a cap (≈ 25 lines, and the cap is the part we
must own anyway) and an error-to-status mapper (which must be written against *this* project's
error classes whatever the framework). The remaining surface — Express's `req.body` parsers,
Fastify's schema compiler — is either unused or duplicates the zod validation
`design/design-interfaces.md` §1.4 already mandates at the boundary.

So: `node:http`, and `zod`, which is already a runtime dependency of this package. **No new
runtime dependency is added by this change.**

The one thing a framework would genuinely have given us — a battle-tested body reader — is where
the risk actually is, so it is written deliberately rather than casually (§4).

## 2. Where the code lives, and what it may import

`00009-02`'s design §2 put project B outside `src/` in `shielded-monitor/`, mirroring
`chain-archive-sync/`, and added `test/postgres/no-shielded-monitor-import-guard.test.ts` to
enforce that nothing under `src/` imports it. This change adds two subdirectories under that same
roof and inherits the guard unchanged:

- `shielded-monitor/api/` — the server. May import `shielded-monitor/*` (the store, the lifecycle
  table, the error classes, key intake) and `src/postgres/client.ts` for its own connection.
- `shielded-monitor/client/` — the reference consumer. **May import nothing but Node built-ins.**

That second rule is the interesting one, and it is enforced by a test rather than a comment
(`test/shielded-monitor/client-cli.integration.test.ts`'s import audit). A reference consumer that
reached into `PgShieldedMonitorStore` would prove nothing: the point of the exercise (organizer
spec US1–US3, SC-008) is that an application with no database credentials, no driver and no schema
knowledge can complete the whole flow. If the client can import the store, a later refactor can
quietly make the "end-to-end" test a function call, and the acceptance evidence evaporates without
a failing assertion. The client therefore speaks `fetch` and nothing else.

## 3. The cursor: an opaque encoding of `(monitorId, seq)`

`Formal/STORAGE_ALGEBRA.md` §1's Law T1 gives TemporalKV a *gapless* server-assigned version, and
the CAS guard is what makes a caller's `expectedVersion` meaningful. The association table's
per-monitor `seq` is the same construction on a different table:
`00009-02`'s `advance` allocates `seq` inside the fenced `UPDATE` that advances coverage, after
sorting the batch by `(blockHeight, position)`, so `seq` order **is** `(blockHeight, position)`
order structurally rather than by convention.

The cursor is therefore just `seq`, wrapped:

    cursor = base64url( "<monitorId>:<seq>" )

**Why the monitor id is inside the cursor even though the path already carries it.** Organizer
spec FR-019 requires a cursor to be bound to its monitor. Without the binding, a consumer that
juggles two monitors and crosses its cursor files silently reads monitor A's page positions
against monitor B — and because both cursors are just small integers, the mistake produces
*plausible* results (a valid page, from the wrong offset) rather than an error. With the binding,
the mismatch is a 400 at the first request. The check is `cursor.monitorId === path id`, and the
test that matters is the negative one.

**Why not signed.** Signing is deferred with User Story 4 (owner, 2026-09-10). The residual risk
is bounded and worth stating plainly: an unauthenticated cursor can be forged, but a forged cursor
can only reposition a caller *within a monitor it can already read in full* — and in an alpha with
no authentication at all, the caller could read that monitor from `seq = 0` anyway. Signing buys
nothing until there is something to authenticate against.

**Why base64url of a string, not a number.** Two reasons, both about what a consumer is tempted to
do. A bare integer invites arithmetic (`cursor + 1`), which would break the moment `seq` allocation
changes; the encoding makes the value visibly not-a-number. And base64url specifically — not
base64 — because the cursor travels in a query string, where `+` and `/` need escaping and one
consumer in ten will forget.

**Stability.** The same cursor with the same `limit` returns the same page, because associations
are append-only under a monotone `seq` and coverage only moves forward: no row can ever appear
*below* a `seq` a caller has already seen. This is the read-side counterpart of §1's gapless law
and is asserted directly (`api.integration.test.ts`).

## 4. Admission control: exactly two caps, and both fail with 400

Owner decision Q3 defers authentication, rate limiting and quotas. What remains is what organizer
spec FR-021 requires unconditionally:

| Cap | Env var | Default | Violation |
|---|---|---|---|
| Request body bytes | `API_MAX_BODY_BYTES` | 65536 (64 KiB) | `400 BODY_TOO_LARGE` |
| Matches page size | `API_MAX_PAGE` | 200 | `400 VALIDATION_FAILED` |

`400` rather than `413`/`429` for the body cap is the organizer sub-plan's explicit instruction
("only body-size and page-size caps (400 on violation)"), and it is defensible on its own terms:
with no authentication and no quotas there is no rate-limit story for a `413` to be part of, and
one client-error class for "your request was not acceptable" is simpler for the single reference
consumer to handle than two.

The body reader enforces the cap **while reading**, not after: it counts bytes as chunks arrive
and destroys the socket the moment the running total exceeds the limit. Buffering first and
checking after would make the cap a formality — the memory is already spent by the time the check
runs. The page cap is additionally floored by the store's own `MAX_ASSOCIATION_PAGE` (1000), which
`00009-02` deliberately placed at the store so no in-process caller can ask for an unbounded page
either; `API_MAX_PAGE` is validated to be ≤ that, so a misconfiguration is a boot failure rather
than a runtime surprise.

## 5. Coverage on the wire, and the `sourceTip` seam

Organizer spec FR-011 defines coverage as four block heights and FR-020 forbids presenting an
unscanned range as an empty result. The wire object is therefore:

```json
{ "requestedStart": "0", "scannedFrom": null, "scannedThrough": null, "sourceTip": null }
```

Heights are **decimal strings**, not JSON numbers. Block heights are `bigint` throughout this
repository (`src/postgres/client.ts` configures `types.bigint`), and JSON numbers are IEEE-754
doubles: a height above 2^53 would round silently. A string cannot round.

`null` for `scannedFrom`/`scannedThrough` means *not scanned yet* and is the whole point of
FR-020 — it is structurally different from an empty `items` array, and the reference client prints
it as `not scanned` rather than as a zero.

`sourceTip` is the one field this change cannot compute. It is the archive's current tip, which
lives behind Phase 1's `ArchiveReadContract` — a branch this one is not stacked on, and a module
`00009-02`'s design §1 forbids B from reaching into directly. Three options were considered and
the decision is recorded as organizer question **Q14**:

- **omit the field** — a consumer cannot tell "this deployment does not report a tip" from "the
  field was dropped by a proxy", and the shape changes when Phase 3 lands, which is a breaking
  change to a contract we would rather freeze now;
- **report `0`** — actively false, and false in the most dangerous direction: `scannedThrough >=
  sourceTip` reads as *caught up*;
- **report `null` through an injectable `SourceTipProvider`** (chosen). The field always exists;
  `null` means "not observed by this deployment"; Phase 3 supplies a provider backed by
  `getArchiveIdentity`/`readBlocksSince` and the shape does not change.

The seam is one method — `sourceTip(net): Promise<bigint | undefined>` — deliberately narrower
than the archive contract itself, so wiring it in Phase 3 cannot drag `chain_archive` knowledge
into the API module.

## 6. Error mapping: one idiom in, HTTP statuses out

`design/design-interfaces.md` §1.1 fixed one error idiom for this repository — thrown errors
extending `StorageError` with a stable `code` discriminant — and `00009-02` gave project B its own
classes on that base. The API's mapper is a total function over those classes:

| Thrown | Status | Wire `code` |
|---|---|---|
| `MonitorNotFoundError` (also: deleted) | 404 | `MONITOR_NOT_FOUND` |
| `MonitorRevokedError` | 410 | `MONITOR_REVOKED` |
| `IllegalLifecycleTransitionError` | 409 | `ILLEGAL_TRANSITION` |
| `InvalidViewingKeyError` | 400 | `INVALID_VIEWING_KEY` |
| `ValidationError` | 400 | `VALIDATION_FAILED` |
| `MonitorFencedError` | 409 | `MONITOR_FENCED` |
| anything else | 500 | `INTERNAL_ERROR` (message replaced) |

Two properties of this table are load-bearing rather than incidental.

**410, not 404, for revoked — and 404, not 410, for deleted.** The organizer spec is explicit in
both directions: US3 scenario 3 requires a revoked monitor's reads to be *refused* (the consumer
must be able to tell that its monitor was stopped, otherwise it retries forever against a 404 it
reads as a transient routing error), and US3 scenario 4 requires a deleted monitor to answer *as
if it never existed*. `00009-02`'s store already draws exactly this line (`get` throws
`MonitorNotFoundError` for `deleted` and `MonitorRevokedError` for `revoked`), so the mapper
inherits it rather than re-deciding it.

**The 500 branch replaces the message.** An unexpected error's message is the one string in this
system that no one has reviewed for what it might contain — a driver error can quote a parameter,
and a parameter on the create path is a viewing key. The mapper therefore never forwards an
unmapped message to the wire; it logs the error server-side (where §7's redaction applies) and
returns a fixed string plus the request id.

## 7. Key hygiene: the key exists in exactly one function

Organizer spec FR-023 and SC-004 require that no viewing key appears in a log line, a metric or an
error body. The design achieves that structurally rather than by filtering:

1. **The key is accepted only in the `POST /v1/monitors` body** (FR-017). No other endpoint takes
   one, no endpoint takes one in a query string or a header, and no endpoint returns one.
2. **Request logging never touches bodies.** The logger is handed a fixed record — request id,
   method, matched *route pattern* (`POST /v1/monitors`, not the raw URL), status, duration,
   request bytes — and the body is not in scope at the call site. Logging the route pattern rather
   than the URL also means a future path parameter cannot become a log field by accident.
3. **The key never reaches a Zod issue.** Zod's own messages do not echo values, but "does not
   today" is not a property. The create schema types `viewingKey` as a bounded string and the
   handler scrubs any issue whose path is `viewingKey` before the error is rendered, so even a Zod
   version that started echoing would leak nothing.
4. **Intake failures are one generic error.** `parseViewingKey` (00009-02) already throws a single
   `InvalidViewingKeyError` with one fixed message for every failure class, carrying no fragment
   of the input and deliberately no `cause`.
5. **The parsed key is a `ShieldedViewingKey`**, which redacts itself under `toString`, `toJSON`
   and `util.inspect` (00009-02). Even an accidental `console.log(key)` prints the placeholder.

The test is a scan with a **positive control**: the same capture harness is fed a line that
deliberately contains the key, and the scan must find it. A leak-scanner that cannot detect a leak
it was handed is the failure mode this control exists to catch, and SC-004 names it explicitly.

## 8. Idempotent registration over HTTP: 201 versus 200

Organizer spec US1 scenario 5 requires the second registration of the same key to return the
existing monitor. The sub-plan's endpoint table says `POST /v1/monitors → 201 monitor view`.
Those are compatible if — and only if — the status distinguishes the two cases, which is what this
change does: **201 when a monitor was created, 200 when an existing one was returned.**

The alternative (always 201) would make the API claim to have created a resource it did not
create, which is the one thing 201 asserts. The lookup is `store.getByFingerprint` before
`store.register`; a concurrent double-create can still race to two 201s, which is harmless because
`register` itself is idempotent at the database level (`ON CONFLICT … DO NOTHING`, 00009-02) — the
two responses name the same monitor.

A registration whose key matches a **revoked** monitor answers `410`, following organizer question
Q11's applied default (a revoked key cannot be re-registered without an explicit delete).

## 9. Lifecycle endpoints and the pre-check

`pause`, `resume` and `revoke` map onto `store.pause/resume/revoke`, which are fenced and
idempotent (00009-02 §6). One wrinkle needs a decision: `store.pause` on a *revoked* monitor
raises `IllegalLifecycleTransitionError` (the transition table does not admit it), which would map
to 409 — but the endpoint contract says a revoked monitor answers 410 everywhere.

The handler therefore loads the monitor's administrative view first
(`store.getIncludingRevoked`) and applies the contract before the transition: missing or `deleted`
→ 404; `revoked` → 410 for every verb except `revoke` itself, which stays idempotent and answers
200. The pre-check is a read, so it cannot make the subsequent write unsafe: the write is still
fenced by the store, and a lifecycle change landing between the two produces the store's own typed
error rather than a wrong answer.

`DELETE` answers `204` when it deleted something and `404` when the id names nothing — including
an id that was *already* deleted, because US3 scenario 4 requires a deleted monitor to be
indistinguishable from one that never existed. After a successful delete, every endpoint for that
id answers 404, which is the only self-consistent reading.

## 10. What the API does *not* do to the database

`design/design.md` §5 fixes what a caller may assume about transaction boundaries. The API assumes
nothing new: every handler is a single store call (or a read followed by a store call), and the
API opens no transaction of its own. It has no write path that is not one of `00009-02`'s, and it
adds no SQL — the string `chain_archive` and the string `shielded_monitor` both appear in this
change only in documentation and in the server's configuration default for the schema name.

Consequently owner Rule B is preserved without a new argument: the API's write set is exactly the
store's write set, which `test/shielded-monitor/schema-isolation.integration.test.ts` (00009-02)
already pins under a least-privilege role.

## 11. Bin entries and the published surface

Organizer spec FR-026 requires the API and the scanner to be shippable CLI entry points of the
same package. This change adds two:

- `umbradb-shielded-monitor-api` → `dist-cli/shielded-monitor/api/server-cli.js`
- `umbradb-shielded-monitor-client` → `dist-cli/shielded-monitor/client/cli.js`

`umbradb-shielded-monitor` (the scanner) is **not** added: there is no scanner module on this
branch, and a `bin` entry pointing at a file `tsc` will not emit is a broken published package,
not a placeholder. Phase 3 adds it with the code it names.

For those two entries to exist in `dist-cli`, `tsconfig.cli.json`'s `include` gains
`shielded-monitor/**/*.ts`. `tsconfig.build.json` — which produces the *library* `dist/` and the
frozen barrel that `test/api-surface/*` pins — is untouched, so the published library surface does
not change. The trusted harness stays a `npm run` script rather than a bin, exactly as
`00009-02`'s harness doc comment says it should.
