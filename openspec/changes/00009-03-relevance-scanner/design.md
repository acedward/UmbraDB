# Design — 00009-03: the shielded viewing-key relevance scanner

Every decision below is stated against the repository's existing design documents. Where this
change touches a decision those documents already made, the section is cited; where it makes a
genuinely new decision, it is stated as new and the reason it does not contradict the cited
section is given.

Cited throughout:

- `design/design.md` §0 (tier reconciliation), §5 (commit/transaction layer), §7 (driver choice).
- `design/design-interfaces.md` §1.1 (error idiom), §1.2 (async pattern), §1.3 (transaction
  participation), §1.4 (runtime validation at the boundary), §1.5 (naming), §2
  (`storage-errors.ts`).
- `Formal/STORAGE_ALGEBRA.md` §1 (the CAS guard), §3 (watermarks are last-write-wins and
  monotonicity is deliberately not a law there), §4 (the control algebra and the removal of
  fencing tokens from the lease layer), §5 (the fast-check testable-law deliverable).
- `design/full-chain-storage-design.md` §5 (how a second, independent migration lineage is run).
- Sibling changes: `openspec/changes/00009-01-archive-read-contract/design.md` (the read
  contract and Rule A), `openspec/changes/00009-02-monitor-store/design.md` (the store, the
  epoch fence and Rule B's storage half).

---

## 1. Where the scanner sits, and what it is allowed to touch

`design/design.md` §0 separates Tier-1 (`tier1_wallet`) from the Tier-2 indexer schema, and
`design/full-chain-storage-design.md` §5 added Tier-1.5 (`chain_archive`) as a separate schema
with its own lineage. `00009-02` added `shielded_monitor` as a third lineage on that precedent.

This change adds no schema and no lineage. It adds a WORKER, and the only design question it
raises is what that worker may reach:

| Dependency | Form | Why this form |
|---|---|---|
| The archive | `ArchiveReadContract` (interface, `src/interfaces/archive-read-contract.ts`) | Organizer FR-025: B's only access to A is read-only through the contract, so B can later run in another process or a TEE. The scanner holds no archive schema name and no archive SQL. |
| The monitor store | `ScannerStore` (a 7-method interface declared in `scanner.ts`, satisfied structurally by `PgShieldedMonitorStore`) | New decision. `design/design-interfaces.md` §1.5's naming discipline says a dependency should be named by what it does; here the narrow interface additionally makes "what can the scanner write" a seven-line answer a reviewer can check, and lets the control-flow suite drive the scanner with a double. |
| The ledger | `shielded-monitor/offers.ts` (from `00009-01`) | One place loads the WASM and gates the protocol version, so a wrong build has one audit point. |

Nothing else. In particular the scanner does not import `PgChainArchiveStore`, does not know the
archive's schema name, and cannot be handed one.

## 2. The batch, and why it is shaped exactly like the archive's height transaction

Owner Rule B (organizer spec US5) and FR-010: for one monitor, a block height's associations and
the coverage advance to that height commit together. `00009-02` made that a single store method
(`advance`); this change is the only caller of it, and the batch is therefore:

```text
  identity check ──► one page of WHOLE blocks ──► predicate over every regular transaction
                                              ──► ONE advance(monitorId, epoch, lastHeight, associations)
```

`SCAN_BATCH_BLOCKS` (default 1) counts BLOCKS because `readBlocksSince` never splits one
(`00009-01` design §2). That makes the scanner's commit unit and the archive's write unit the
same object — a block height — which is what makes recovery statable in one sentence for both
writers. A default of 1 is the smallest unit Rule B admits and the one that loses the least work
to a crash; larger values trade that for amortizing the per-batch archive read and identity read.

**Zero-match blocks still commit.** An empty association array is the normal shape for a run of
blocks with nothing in them, and skipping the commit would leave coverage behind reality —
collapsing FR-011's distinction between "scanned and empty" and "not scanned". The crash suite's
non-vacuity assertion deliberately requires an interrupted zero-match height, because that is the
case where the two observable states differ ONLY in coverage.

**Relation to `Formal/STORAGE_ALGEBRA.md` §3.** §3 records that watermarks are last-write-wins and
that monotonicity is deliberately NOT a law of the watermark layer. Coverage here is not a
watermark: it is a column on the monitor row, and its monotonic guard lives inside the same
`UPDATE` that advances it (`00009-02` design §6). This change does not reopen §3; it relies on a
different mechanism in a different layer, exactly as §3 anticipated a caller doing when it needs
monotonicity.

## 3. The fence, and every place a worker write can be refused

`Formal/STORAGE_ALGEBRA.md` §1's CAS guard is the shape: check and write are one statement.
`00009-02` applied it to `advance`. This change is the component that can actually be fenced, so
it must handle the fence at every write it makes, not just the obvious one:

| Write | Fenced on | What the scanner does when refused |
|---|---|---|
| `advance` | epoch + scannable state, inside the `UPDATE` | reports `{kind: "fenced"}`; nothing is retried blindly |
| `markFailed` | optional `expectedEpoch` (supplied) | reports `{kind: "fenced"}` — a monitor its consumer just took control of must not be stopped by a departing worker |
| `markStaleSource` | optional `expectedEpoch` (supplied) | same |
| `goLive` | `expectedEpoch` (supplied) | swallowed: a pause landing after a batch that already committed is not that batch's failure |
| `bindArchiveSource` | `expectedEpoch` + scannable state | reports `{kind: "fenced"}` |

`Formal/STORAGE_ALGEBRA.md` §4 removed fencing tokens from the lease layer deliberately. That
decision is untouched: this is not a lease, there is exactly one downstream write path, and the
token is checked by the write itself.

## 4. Archive identity: read every batch, bind first-write-wins

FR-013 requires a monitor to be bound to `(genesisHash, archiveInstanceId)` and to stop when it
changes. Two decisions, both new:

**4.1 The identity is read afresh every batch, not memoized.** A memo would let the scanner
commit a batch read from a REBUILT archive against the stale binding for as long as the memo
lived, which is precisely the history-mixing FR-013 exists to prevent. The cost is one small
read-only transaction per batch, and `SCAN_BATCH_BLOCKS` amortizes it. The check also happens
BEFORE the page is read, so a stale source is never scanned at all (asserted:
`archive.reads === 0` in the unit suite).

**4.2 `bindArchiveSource` is first-write-wins, never an overwrite.** Registration may leave the
binding NULL — `00009-02` deliberately gave the store no compile-time dependency on the read
contract, and the Phase-4 API that accepts a key has no archive handle. So the scanner binds on
first use. The `UPDATE`'s `WHERE` requires both columns to be NULL, so an already-bound monitor
can never be silently re-bound: a differing identity has to surface as `markStaleSource`. An
overwriting bind would have turned the FR-013 failure into a silent success.

This write is NOT inside the Rule B height transaction, and that is deliberate rather than an
oversight: Rule B constrains what must commit TOGETHER (a height's associations and its coverage
advance). An identity binding is not a height's data, and lifecycle events are already written
outside that transaction for the same reason.

## 5. The predicate: what is examined, and the false negatives we accept and name

FR-006, and reference parity with `indexer-common/src/domain/ledger/transaction.rs:250-304`:
relevance is trial decryption with the registered key over the guaranteed offer and every
fallible-segment offer. The ledger's `test(offer)` examines OUTPUTS and TRANSIENTS and never
inputs, so the predicate is strictly receive-side. Every offer is tested even after the first
hit, because FR-008 requires the association to name ALL matched segments.

**Segment numbering is the ledger's, not ours.** The guaranteed section is recorded as segment 0
because the ledger's own `SegmentSpecifier` treats `guaranteedOnly` and `specific(0)` as the same
branch (`ledger-wasm/src/tx.rs`'s `add_zswap_offer`), and a fallible offer therefore never
carries segment 0. That keeps `matched_segments` one flat list of ledger segment ids rather than a
list plus a boolean.

**Two skip classes are reported distinctly from "no match":**

- `system-transaction` — skipped on the archive's `kind`, WITHOUT deserializing. A system
  transaction's bytes are not a standard transaction payload; handing them to the standard codec
  would be a category error, and the test proves the scanner does not look by feeding it bytes
  that would throw if it did.
- `no-zswap-offers` — the transaction deserialized and holds no offer at all. A reward-claim
  transaction is the canonical case, and this is WHY a reward claim can never be relevant: there
  is nothing for any key to be tested against.

**The documented false-negative class (organizer spec's edge cases):** an output with no
ciphertext is invisible to the predicate. In practice that is the contract-owned output, whose
coin data goes to a contract rather than being encrypted to a user key. No viewing key can match
it — ours included — and the corpus contains one, asserted invisible to every key, so a future
ledger that made them visible would fail the suite rather than change coverage silently.

## 6. Fail-closed, and what `last_error` is allowed to contain

FR-007: an unsupported protocol version or undecodable bytes stop the monitor at that position.
The scanner wraps the failure in a `TransactionScanError` carrying `(height, position)`, writes
`last_error` with a typed code and a truncated message, and **does not advance coverage**. The
integration suite asserts the coverage stays below the failed height, because that is the whole
point: the difference between "no match" and "could not look" is invisible afterwards.

`last_error.message` is the LEDGER's message, which describes bytes. FR-023 forbids key material
in logs and error bodies; a ledger decode error cannot contain the key (the key is not an input
to `Transaction.deserialize`), and the assertion that the message carries no `mn_shield-esk`
prefix is in the suite as a standing check rather than an argument.

## 7. Scheduling: one ordered worker per monitor, NOTIFY plus polling

- **One ordered worker per monitor.** Two workers on one monitor would not corrupt anything — the
  fence and the monotonic guard see to that — but one would burn a whole batch and lose at the
  commit. The `inFlight` set is waste-avoidance, not safety, and it is held in this process
  because this process is the only scanner (organizer Q4).
- **`SCAN_CONCURRENCY` monitors in parallel.** Monitors are independent: different keys, rows and
  commits. The bound caps connections and WASM memory.
- **`LISTEN chain_archive_progress` for the tail, `SCAN_POLL_MS` as the fallback that makes it
  correct.** `00009-01` emits the NOTIFY INSIDE the height transaction, so an arrival means "this
  height is readable" and a rolled-back height delivers nothing. But `LISTEN` has no replay and
  the connection can drop, so the poll is not redundant: the notification makes the tail prompt,
  the poll makes it correct. A listener that cannot attach degrades to polling with a log line
  rather than refusing to start.

## 8. Key lifetime

The key is deserialized inside `scanBatch` and `clear()`ed in a `finally`, and the local copy of
the serialized bytes is zeroed. No handle is stored on the instance, so no handle can be shared
between monitors — including by a later refactor that adds caching without thinking about it.
The `deserializeKey` option is the seam a TEE-backed handle would replace; it is also the only
instrument that can observe the lifetime, and the unit suite asserts exactly one deserialization
and exactly one `clear()` per batch **including when the predicate throws**.

## 9. Metrics: a closed label type, not a redaction rule

FR-014 asks for throughput metrics without sensitive labels, and FR-023 forbids keys in metrics.
The sink's label type is `{ net: string }` — a closed interface, not a `Record<string, string>`.
A monitor id is not key material, but a metric series per monitor id leaks per-wallet association
counts and timing to anyone who can read the metrics endpoint, which is the anti-pattern the
audit named in the reference indexer. Making the label set a type means adding one is a
deliberate change a reviewer sees, rather than a string a caller invents. Lag is published as the
MAXIMUM across monitors, so the series says "the worst-served monitor is N blocks behind" without
naming it.

## 10. Error idiom

`design/design-interfaces.md` §1.1's idiom is thrown errors extending `StorageError` with a
stable `code` and a `retryable` classification. This change adds one error class,
`TransactionScanError`, and it deliberately extends plain `Error` rather than `StorageError`:
it is not a storage failure, it never crosses the published surface, and it exists to carry a
position from the predicate to the fail-closed handler inside one module. Every error that DOES
cross the store boundary is `00009-02`'s (`MonitorFencedError`, `MonitorNotFoundError`,
`MonitorRevokedError`), unchanged. Consistent with §2 and with `chain-archive-sync`'s own
position, nothing here is re-exported from `src/index.ts`.

## 11. Fixture fidelity: what the corpus proves, and what it does not

Measured against the vendored WASM, not assumed:

- `Transaction.fromParts(...)` serializes with the self-tag
  `midnight:transaction[v9](signature[v1],proof-preimage,embedded-fr[v1])`, which the ARCHIVED
  marker triple `("signature","proof","binding")` refuses.
- `.mockProve()` on the same transaction yields
  `midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1])` — the tag real archived
  bytes carry — and round-trips through the production deserialize call unchanged.

So the corpus is archived and read with **exactly the production codec**; the fixture-only marker
configuration flag the sub-plan allowed was not needed and was not added. A test asserts the
round-trip for every corpus transaction, so a fixture that drifted off the archived markers fails
rather than quietly exercising a different path.

What `mockProve()` costs, stated plainly: the zero-knowledge proofs are mock, so these
transactions would not verify on a chain. Nothing the predicate reads is a proof — it
trial-decrypts output ciphertexts — so the predicate's inputs are genuine. The end-to-end
fidelity gap (a real proven transfer from a wallet against a real node) is organizer SC-005 and
belongs to Phase 5.

**A real reward-claim could not be synthesized in archived form.**
`Transaction.fromRewards(...)` is already bound, so `mockProve()` refuses it ("cannot prove bound
transaction") and its bytes stay tagged `proof-preimage`. Rather than fake it, the case is
covered in two halves: the suite deserializes a REAL rewards transaction with the markers its own
bytes carry and asserts it holds no zswap offer at all (the fact the exclusion rests on), and the
corpus carries an archivable standard transaction with no offers, which is the shape the scanner
actually sees.

## 12. Throughput, honestly scoped

SC-006 asks for a first measurement at 1, 10 and 50 keys. `bench/shielded-monitor-scan.ts`
measures the whole production path against real PostgreSQL and real archived ledger bytes. Two
limits are stated in the harness itself rather than in a footnote: the corpus is synthesized, so
the offers are small and uniform and the figures are an upper bound for that shape; and each
row's work is capped (`BENCH_SCAN_MAX_EVALS`) by scanning a prefix, with the row reporting the
blocks and transactions it actually scanned. The reported quantity is a rate, and nothing is
extrapolated.

The dominant cost is structural and worth recording for whoever sets the threshold: a transaction
is re-deserialized once per monitor, so aggregate throughput is roughly flat in the number of
keys and per-key throughput falls roughly linearly. A future optimisation (deserialize once per
transaction, test every key against it) is a real change to the batch shape and is deliberately
out of scope here.
