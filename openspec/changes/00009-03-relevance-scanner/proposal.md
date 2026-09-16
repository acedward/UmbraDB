# Proposal — 00009-03: the shielded viewing-key relevance scanner (project B's worker)

> Organizer spec: `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
> (approved 2026-09-10). Organizer sub-plan: `plans/00009-03-relevance-scanner.md`.
> This change implements **Phase 3 only**: the scanner. It stacks on `00009-01` (the archive read
> contract) and `00009-02` (the monitor store); the private HTTP API and the reference consumer
> are `00009-04` and are explicitly out of scope here.

## Why this change exists

After `00009-01` and `00009-02` the repository can archive finalized history and page it as whole
blocks, and it can register a viewing key, remember how far that key has been scanned, and fence
a worker that is holding a stale view of the monitor. What it cannot do is the one thing the
feature is for: **decide which archived transactions are relevant to a registered key, and record
that decision durably.**

Nothing in the repository evaluates `EncryptionSecretKey.test(offer)` against an archived offer.
A monitor registered today stays in `backfilling` forever with `scannedThrough` absent, because no
process advances it. That is the gap this change closes.

Three properties make this more than "a loop that reads blocks and writes rows":

1. **Rule B is a correctness requirement, not a style.** Everything the scanner commits for a
   block height — that height's associations AND the coverage advance to it — must land in one
   `BEGIN … COMMIT` in `shielded_monitor`, so a crash leaves either none of a height or all of
   it. Without that, recovery has no rule: a coverage advance that outran its associations loses
   matches silently and forever, because the range will never be revisited.
2. **The predicate must fail closed.** A transaction the ledger cannot read is not an irrelevant
   transaction, and after the fact the two are indistinguishable. A scanner that recorded an
   unreadable range as "scanned, no matches" would produce a wallet that is quietly missing money
   it was sent.
3. **B must still not touch A.** The scanner is where the temptation to "just query
   `chain_archive`" is strongest — it needs blocks, transactions and raw bytes. It reaches all of
   them through the `ArchiveReadContract` interface and nothing else, which is what keeps the
   later TEE split (organizer FR-025) possible.

## What this change delivers

- **`shielded-monitor/relevance.ts`** — the predicate over one archived transaction: skip system
  transactions without deserializing, extract the guaranteed offer and every fallible-segment
  offer, test each, and return every matched segment id. Nothing else; no database, no lifecycle.
- **`shielded-monitor/scanner.ts`** — `ShieldedMonitorScanner.scanBatch`: archive-identity check,
  one page of whole blocks through the contract, the key deserialized for exactly that batch and
  `clear()`ed in a `finally`, and ONE `store.advance` carrying the batch's associations and its
  coverage advance together. Plus `scanToTip`, the single ordered worker for one monitor.
- **`shielded-monitor/scanner-service.ts`** — the scheduler: one in-flight worker per monitor,
  `SCAN_CONCURRENCY` monitors in parallel, a live tail driven by `LISTEN chain_archive_progress`
  with `SCAN_POLL_MS` polling as the fallback that makes it correct rather than merely prompt.
- **`shielded-monitor/scanner-metrics.ts`** — counters, throughput and lag behind a closed label
  type whose only dimension is the network, so a monitor id cannot be passed as a label.
- **`shielded-monitor/scanner-config.ts` and `scanner-cli.ts`** — the `umbradb-shielded-monitor`
  binary and its environment, every numeric bound failing closed on a bad value.
- **`PgShieldedMonitorStore.bindArchiveSource`** — a small, epoch-fenced, first-write-wins
  addition to `00009-02`'s store, because a monitor registered through an API that holds no
  archive handle arrives with its archive identity unset and the scanner is what binds it.
- **`test/fixtures/shielded-monitor/`** — a manifest that DECLARES the corpus and a builder that
  synthesizes it with the vendored ledger WASM, plus the suites that compare the scanner's output
  against the manifest, prove Rule B across 200 crash points and a real process SIGKILL, and
  audit the write set.
- **`bench/shielded-monitor-scan.ts`** — SC-006's first throughput measurement at 1, 10 and 50
  keys.

## What this change explicitly does NOT cover (non-goals)

- **No HTTP surface, no consumer.** Registration, status, cursor paging, pause/resume/revoke over
  an API, and the reference CLI consumer are `00009-04`. This change is driven by a test harness
  and by its own binary.
- **No at-rest encryption, no tenant isolation, no keyed fingerprints.** Deferred with organizer
  User Story 4 (owner decision, 2026-09-10). Keys remain plaintext in B's schema and the scanner
  reads them in the clear; the `deserializeKey` seam is where a TEE-backed handle would replace
  that, and nothing else would change.
- **No ledger v9.** Ledger v8 only (owner decision Q1). A protocol version outside the vendored
  build's supported set stops the monitor rather than being decoded by the wrong codec.
- **No applied outcomes.** Every association carries `appliedOutcome = "unknown"`. The archive's
  own replay outcome is surfaced as `sourceOutcome` when it recorded one, and never promoted.
  Balances, spend detection, Merkle tree state and DUST remain out of scope (organizer Q2).
- **No back-pressure beyond a per-monitor rate ceiling.** `SCAN_BUDGET_TX_PER_S` exists and is off
  by default; there is no global scheduler fairness model, no priority, and no work stealing.
- **No retention or pruning of associations.** Simplest retention (owner Q9): rows accumulate.
- **No live devnet acceptance.** A real shielded transfer produced by a wallet against the Compose
  devnet is organizer SC-005 and belongs to Phase 5; this change states exactly what it did and
  did not prove about fixture fidelity instead of implying the gap is closed.
