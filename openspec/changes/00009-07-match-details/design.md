# Design — 00009-07: match details

> Cites `design/design.md` §0 (scope and module boundaries) and §7 (dependency minimalism);
> `design/design-interfaces.md` §1.4 (boundary validation with Zod) and §2 (storage interfaces);
> `Formal/STORAGE_ALGEBRA.md` §1 (Law T2, the compare-and-set write) and §3 (ordering);
> `design/full-chain-storage-design.md` §5 (independent migration lineages); and the sibling
> changes `openspec/changes/00009-01-archive-read-contract/design.md` (the read contract and the
> block timestamp), `00009-02-monitor-store/design.md` §§1–2, §6 and §6.1 (the association row, the
> fenced advance and the per-monitor sequence), `00009-03-relevance-scanner/design.md` (the batch
> shape and the key lifetime), `00009-04-private-api-cli/design.md` §4 (redaction) and
> `00009-06-dashboard/design.md` §1 and §3 (the one-file page and its CSP).
>
> Nothing here contradicts those sections. Where this change adds to one, the section is named and
> the addition is argued.

## 1. Why the details are produced by the scanner, in the same pass, and not by a second reader

The obvious alternative is a separate process — or an API handler — that re-reads a matched
transaction's bytes and decodes them on demand. It is rejected for three reasons, in increasing
order of importance:

1. **Cost.** The 00009-03 benchmark measured that the ledger deserialize dominates the per-match
   cost. Decoding again per read multiplies it by the number of times anyone looks at a match.
2. **Rule B.** An API handler that decoded a transaction would need the raw bytes, which means a
   read contract handle in the API process for a purpose that is not coverage. The details are a
   property of a match, and matches live in B's schema; keeping the decode where the decode already
   happens keeps B's dependency on A exactly one interface, used by exactly one process.
3. **Agreement.** The decisive one. `details.segments[].matched` and the association's
   `matched_segments` must describe the same evaluation. If they are produced by two passes, two
   ledger loads, or two key deserializations, there is a way for them to differ — and a detail
   record that describes a different evaluation than the association it hangs off is worse than no
   detail record. `evaluateRelevance(tx, key, { details: true })` therefore computes both from one
   extraction and one set of `test(offer)` results.

The cost of collecting details for a non-matching transaction is **zero**: the option is consulted
only after the segment set is known to be non-empty, so the overwhelming majority of transactions a
scan evaluates pay nothing.

## 2. `mine` is three-valued because the ledger permits nothing stronger

The organizer sub-plan specified `mine` per output as `esk.test(ZswapOffer.fromOutput(output))`.
That call is real and exact — **for an unproven output**. It was measured against the vendored
`vendor/ledger-v8-syshash` build and confirmed in the pinned ledger source:

- `ZswapOffer.fromOutput` matches `ZswapOutputTypes::UnprovenOutput` only
  (`ledger-wasm/src/zswap_wasm.rs:592-608`); a proven output is refused with *"ZswapOffer cannot be
  constructed from a proven or proof-erased output."* `fromInput` (`:576-590`), `fromTransient`
  (`:611-627`) and `Transaction.addCalls` (`ledger-wasm/src/tx.rs:1028-1036`) refuse proven values
  identically.
- Every archived transaction is proven — that is the `("signature","proof","binding")` marker triple
  the archive's own codec uses — so the prescribed mechanism never fires in production.
- `EncryptionSecretKey.test(offer)` (`ledger-wasm/src/zswap_keys.rs:289-320`) is an `any()` over the
  ciphertexts of **all** outputs and transients of an offer. The WASM exposes no per-entry variant
  and no ciphertext accessor. The one per-coin API, `ZswapLocalState.applyWithChanges`, needs the
  full `ZswapSecretKeys`, which a viewing-key monitor does not hold and cannot derive.

The reference Midnight indexer sits on the same boundary: it uses `test(offer)` for relevance and
leaves per-coin attribution to the wallet, which has the full keys.

So `mine` reports only what the ledger entails:

| value | rule | why it is sound |
|---|---|---|
| `false` | every entry of a segment whose `test(offer)` was `false`; and any entry naming a contract address | `test` is an `any()` over every ciphertext in the offer, so a `false` there is a `false` for each of them. A contract-owned entry carries no user ciphertext at all — the spec's own documented false-negative class, asserted in `relevance.test.ts` |
| `true` | a matched segment's single remaining candidate | something in the segment decrypted, and after removing the contract-owned entries there is nothing else it could have been |
| `null` | every candidate of a matched segment with two or more of them | not attributable with a viewing key alone; the segment carries `mineAmong: n`, so *"one of these n is yours"* is still sayable — and it is the honest sentence |

**Rejected alternatives**, recorded because each is the shape someone will propose:

- *Splice a single-output offer's bytes and `ZswapOffer.deserialize("proof", …)` it.* A serialized
  `ZswapOffer` is a storage-`Array` tagged serialization whose trailer changes with arity (measured:
  `…0410080104100c080c1400` for one output, `…0420080104101c181c2400` for two). Hand-building one is
  a guess about a versioned binary format, and its failure mode is a **wrong** badge — strictly
  worse than no badge.
- *Register the seed or the full `ZswapSecretKeys` instead of the viewing key.* Reverses the
  project's privacy posture. FR-001/FR-002 accept a *viewing* key precisely so the service cannot
  spend, and US4 is deferred, so those keys sit in plaintext. Handing the alpha spend authority over
  every registered wallet is not a dashboard-polish decision.
- *Drop `mine` and show only public data.* Throws away the sound part for free: a `false` for every
  entry of an unmatched segment, and a `true` for a single-candidate match, cost nothing.

The exact isolation is still **attempted** — once per matched segment the deduction cannot settle —
so this module upgrades itself if a future ledger relaxes the constraint, and
`match-details.test.ts` pins the measured refusal with a positive control so the finding cannot rot
into folklore. Recorded as organizer question **Q22 `[07]`**, DEFAULT-APPLIED.

## 3. Why `jsonb`, why nullable, and why a second bound at the store

`details` is a per-transaction tree — segments, each with three lists — read whole, written once,
never queried by an inner field. Three normalized tables would add their own fencing for a shape
nothing joins against; `jsonb` matches what this lineage already does for `monitors.last_error`
(`00009-02/design.md` §2).

**Nullable**, because every pre-existing association is a real match with real provenance: deleting
those rows to satisfy a new column would destroy history, and synthesising a value would be a guess
presented as a decode. `NULL` therefore means exactly *not recorded yet* — the API returns `null`,
the page says so in those words and names the backfill, and no reader may read it as "this
transaction had no outputs". This is the same argument migration `chain_archive/008_block_timestamp`
made for `blocks.timestamp_ms`, and the two nulls mean the same kind of thing.

The size bound exists **twice on purpose**: `match-details.ts` caps each list at
`MAX_DETAIL_ENTRIES = 256` and records the true count, and the store independently refuses a
document over `MAX_ASSOCIATION_DETAILS_BYTES`. A producer's cap is a promise; a store that accepts a
caller's object should not rely on a promise made in another module (`design-interfaces.md` §1.4).
Over the bound the store raises `ValidationError` and the **whole batch** is refused before anything
is written — a bad detail must not be able to commit half a height.

## 4. Rule B: the details are part of the height, so they commit with it

Owner Rule B says a monitor's associations for a block height and its coverage advance commit in one
`BEGIN…COMMIT` in B's schema. A match's details are that match's data, so they are written by the
same `INSERT`, inside the same transaction — not by a follow-up `UPDATE`, however quick.

That is not left to inspection. `test/integration/crash/monitor-batch-fixture.ts`'s
`classifyRuleBState` — the Rule B oracle — now **requires** that in the `all-of-height` state every
association of that height carries both a details document and a block time. A run in which the
matches survived a crash but their details did not satisfies the previous three conditions and is
now refused as a partial batch. The gate is strengthened, never relaxed, and the strengthening has
its own case with a positive control (`crash.shielded-monitor-batch.details-commit-with-the-height`)
showing the classifier really does refuse a detail-less height.

`block_timestamp_ms` is a **copy** of a value A published through the read contract, not a join and
not a second source of truth. It is absent when the archive itself has no timestamp for that height
(migration 008's unbackfilled rows) — never a guessed value, and never `0`.

## 5. The backfill: fill-only, fenced, and unable to lie

Coverage only moves forward, so a match already recorded cannot be revisited by scanning. The
backfill walks the existing rows instead, and every one of its properties is a property of a
predicate rather than of the caller's bookkeeping:

- **Idempotent**: every write carries `AND details IS NULL`. A second run fills nothing and can
  never overwrite a recorded detail.
- **Cannot rewrite a match**: the `SET` list is the two columns this change added. Height, position,
  transaction hash, matched segments, outcomes and coverage are not in it.
- **Refuses what it cannot tie to the recorded match**: the block at that height must still carry
  the recorded block hash (a rebuilt archive is a different history — the case FR-013's
  `stale_source` exists for), a transaction must sit at the recorded position with the recorded
  hash, and re-evaluating it must reproduce the same matched segments. Otherwise the row is
  **skipped and counted**, by reason.
- **Walks forward by `seq`**: an unfillable row is passed, not re-read. Without that, one bad row
  would stall a monitor forever on the same head page.
- **Fenced**: the monitor row is locked `FOR UPDATE` and its epoch compared in the same transaction.
  Revoked and deleted monitors are refused; `paused`, `failed` and `stale_source` monitors are
  deliberately **fillable**, because their matches stay readable through the API, and leaving them
  detail-less would make the page's "run the backfill" placeholder a lie.
- **Reads A only through the contract**: `readBlocksSince(height - 1, 1)` is the contract's own way
  to ask for one height, so no new read method was needed and B still holds no archive schema
  knowledge.

It is a one-shot command (`--backfill-details` / `SCAN_BACKFILL_DETAILS=1`) that runs to completion
and exits, rather than a mode the tailing worker also performs: the worker already records details
for every new match, so the only thing the backfill adds is finishing work — and an operator wants
to see that finish.

## 6. `?details=0` is an opt-OUT, and it removes both fields

The dashboard and every human reader want this data; the consumer with a reason to decline is the
one paging a long history. So the default includes it, and `?details=0` returns the pre-00009-07
item **exactly** — both `blockTimestampMs` and `details` absent, not just the large one. "Give me
the old shape" is one clean semantic; "give me the timestamp but not the details" is a third shape
nobody asked for.

Any other value, including an absent parameter, includes them. A typo therefore fails towards MORE
data rather than towards a silently smaller page.

When the fields ARE included, an unrecorded value is `null`, never an omitted key: a consumer must
be able to tell *"this deployment does not send details"* from *"this match has none recorded
yet"*, and an absent key cannot express the second.

## 7. The page: an expandable row, and a bound that moved deliberately

`00009-06/design.md` §1 committed the dashboard to one file with no build step and stated a size
discipline of ~600 lines, with the rule that growing past what one file can carry is the moment to
propose a build step *as a change*.

This change spends 165 of those lines — the caret column, the per-segment tables, the time
formatters and the legend — taking the served document from 479 to 644 lines, and raises the test's
bound from 600 to 700. That is recorded here rather than nudged in the test, and it does not reopen
§1's decision: the page is still one file, one language, no framework, no bundler, no external
resource, and the CSP still names the SHA-256 hashes of its own two inline blocks, recomputed from
the very constants the page is built from. The next change that wants more room owes the same
paragraph — or the build step.

Two page-level decisions worth naming:

- **Expansion state is keyed by the match's own cursor**, which is stable across the 3-second poll,
  so a refresh cannot collapse a row the operator opened.
- **`mine` is rendered three ways** — a green "yours", a neutral dash, and a `?` — with the legend
  explaining the third. Rendering `null` as a blank would quietly turn "we cannot tell" into "not
  yours", which is the one mistake this whole design exists to avoid.

The renderer is not asserted by string-matching the template: `api-ui.test.ts` evaluates the served
page's own script in a `node:vm` sandbox against a small DOM stub and reads the rendered text back.
A template match would pass for a page whose summary line reads `undefined output yours`.
