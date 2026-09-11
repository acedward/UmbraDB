# Proposal — 00009-07: record and show each match's public zswap data

> Organizer spec: `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
> (approved 2026-09-10). Organizer sub-plan: `plans/00009-07-match-details.md`.
> This change stacks on `00009-06-dashboard` (PR #14), which carries the merged alpha plus the
> operator surface: the archive read contract, the monitor store, the relevance scanner, the
> private API, the reference consumer, the list route and the dashboard.

## Why this change exists

A match, as the alpha records it, is a block height, a position, a transaction hash and a list of
matched segment ids. Every one of those is true and checkable, and together they say almost
nothing about what happened. An operator looking at the dashboard sees a row of hex and has no way
to answer the first question anyone asks: *what was actually in that transaction, and which part of
it was mine?*

The data to answer it is already in the process. The scanner deserializes the transaction and holds
its zswap offers at the exact moment it decides relevance; the offers carry the commitment of every
output, the nullifier of every input, the commitment/nullifier pair of every transient and the
contract address of anything delivered to a contract. All of it is **public on chain**. Today it is
read, used for one boolean, and thrown away.

Three holes follow, and this change closes exactly those three:

1. **A match cannot be inspected.** Nothing in the store, the API or the page says what coins the
   transaction created or spent.
2. **A match cannot be dated.** The archive has recorded `blocks.timestamp_ms` since 00009-01, and
   the read contract publishes it, but an association never kept it — so "when did this arrive?"
   requires a second query against a schema project B is not supposed to read.
3. **Matches already recorded cannot gain either.** Coverage only moves forward, so there is no
   supported way to revisit a height once it is scanned.

## What this change delivers

- **`shielded-monitor/match-details.ts`** — given the offers already extracted for the predicate,
  the per-segment public zswap data of a matched transaction: outputs (index, commitment, optional
  contract address), inputs (index, nullifier), transients (index, commitment, nullifier), the true
  list sizes, a truncation flag, and a **three-valued `mine`** per output and transient.
- **Migration `shielded_monitor/002_association_details`** — additive and nullable:
  `associations.details jsonb`, `associations.block_timestamp_ms bigint`, and a partial index on
  the rows still missing details. Existing rows keep `NULL`.
- **The scanner records them at match time**, inside the same `BEGIN…COMMIT` as the height's
  associations and its coverage advance (owner Rule B). The Rule B crash gate is **strengthened**
  to require exactly that.
- **`umbradb-shielded-monitor --backfill-details`** (or `SCAN_BACKFILL_DETAILS=1`) — fills older
  matches, reading blocks only through the `ArchiveReadContract` and writing only the two new
  columns; idempotent by predicate, epoch-fenced, and it skips rather than guesses.
- **API** — `GET /v1/monitors/:id/matches` items gain `blockTimestampMs` (decimal string or `null`)
  and `details` (object or `null`); `?details=0` omits both and reproduces the previous item byte
  for byte.
- **Dashboard** — each match row expands into per-segment output / input / transient tables with
  click-to-copy hashes, a summary line, a legend, and a "run the backfill" placeholder for a match
  with no details yet.

## What this change explicitly does NOT cover

*(openspec `config.yaml` rule: every proposal states its non-goals.)*

- **No balances and no amounts.** A coin's value lives in the ciphertext; reading it needs the
  decryption a viewing key cannot perform per entry, and the spec's own assumptions put balances
  out of scope (organizer question Q2). Nothing in `details` is a number of tokens.
- **No spend detection.** `inputs[].nullifier` is public data about what the *transaction* spent.
  It is not a claim that the monitor's wallet spent anything: the relevance predicate is
  receive-side only and never examines inputs.
- **No applied outcome.** `appliedOutcome` stays `"unknown"` regardless of what `details` shows. A
  commitment in a fallible segment is still a commitment in a segment that may have failed.
- **No change to what counts as a match.** The matched-segment set, the cursor contract, the
  ordering, the coverage semantics and the crash guarantees are untouched. `details` is computed
  from the SAME offers and the SAME per-segment `test` results that decided the match, so the two
  cannot disagree.
- **No per-output certainty the ledger does not give.** `mine` is `true | false | null`, and the
  `null` is load-bearing — see `design.md` §2 and organizer question Q22. This change does not
  reverse-engineer a serialization format to manufacture a stronger answer.
- **No key material anywhere new.** `details` is derived from public offer fields; the key is used
  only for the same `test(offer)` calls the predicate already makes, plus an isolation attempt that
  the archived shape refuses. Nothing key-derived reaches the store, the wire or the page.
- **No authentication, still.** Owner decision Q3 stands; US4 stays deferred.
- **No new runtime dependency.** `package.json`'s `dependencies` is byte-identical.
- **No coverage rewind and no re-scan.** The backfill walks existing rows; it never moves coverage,
  never re-derives a match, and cannot write any column other than the two this change adds.
- **No re-derivation on a version bump.** The backfill is fill-only. Re-deriving details under a
  future `MATCH_DETAILS_VERSION` would need its own deliberate step, which this change does not
  ship.

## Impact

- New files: `shielded-monitor/match-details.ts`, `shielded-monitor/details-backfill.ts`,
  `src/postgres/migrations/shielded_monitor/002_association_details.ts`,
  `test/shielded-monitor/match-details.test.ts`,
  `test/shielded-monitor/details-backfill.integration.test.ts`.
- Changed: `shielded-monitor/{offers,relevance,scanner,scanner-cli,scanner-config,store}.ts`,
  `shielded-monitor/api/{server,views}.ts`, `shielded-monitor/api/ui/page.ts`,
  `src/postgres/migrations/shielded_monitor/index.ts`, the fixture corpus (one new transaction
  carrying a real input and a real transient), `docs/shielded-monitor-{api,scanner,demo}.md`,
  `CHANGELOG.md`, and the required-tests manifest (**45 → 50**, union rule unchanged).
- Additive for every existing consumer: no existing route, response field, error code, exit code,
  environment-variable default or database object changes. One nullable-column migration.
