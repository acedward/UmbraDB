# Running the shielded-monitor relevance scanner

The scanner is project **B**'s worker: it reads the archive's canonical finalized history through
the archive read contract, decides which transactions are relevant to each registered viewing
key, and records those decisions with per-monitor coverage.

It is a **separate process** from the archive ingester (`umbradb-archive-sync`) and from the
private API, and it writes to the `shielded_monitor` schema and nothing else.

```
umbradb-shielded-monitor          # installed binary
npm run shielded-monitor:scan     # from a checkout
npx tsx shielded-monitor/scanner-cli.ts --help
```

## What it needs

- A PostgreSQL database carrying the `chain_archive` schema (populated by `umbradb-archive-sync`)
  and the `shielded_monitor` schema. The scanner bootstraps **only its own** schema; it never
  runs the archive's migrations.
- The vendored ledger v8 WASM (shipped with the package).
- At least one registered monitor. With none, the scanner is healthy and idle.

Least privilege is supported and tested: the scanner's database role needs `USAGE` + `SELECT` on
`chain_archive` and full rights on `shielded_monitor`. Nothing it does requires more
(`test/shielded-monitor/schema-isolation.integration.test.ts` runs the whole flow under exactly
that role, and the crash suite's write-set audit checks the statements themselves).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MONITOR_PG` | — (**required**) | PostgreSQL connection string. |
| `NET` | `undeployed` | Network id / row scope. One network per deployment. |
| `ARCHIVE_SCHEMA` | `chain_archive` | The archive's schema. **Read only.** |
| `MONITOR_SCHEMA` | `shielded_monitor` | The schema this process owns and writes. |
| `SCAN_BATCH_BLOCKS` | `1` | Whole blocks per batch, and therefore per commit. |
| `SCAN_CONCURRENCY` | `4` | Monitors scanned in parallel. |
| `SCAN_POLL_MS` | `2000` | Fallback wake-up interval when no notification arrives. |
| `MAX_MONITORS` | `100` | Monitors picked up per cycle. |
| `SCAN_MAX_BATCHES` | `64` | Batches one monitor may run before others get a turn. |
| `SCAN_BUDGET_TX_PER_S` | unset | Optional per-monitor throughput ceiling. |
| `SCAN_METRICS_LOG_S` | `30` | Seconds between the metrics log line; `0` disables it. |
| `SCAN_ONCE` | unset | `1` runs a single cycle and exits (scripted backfills). |

**Every numeric setting fails closed.** A zero, negative, fractional or non-numeric value stops
the process with the variable named. It is never silently replaced by the default — a bound that
quietly becomes something else is worse than no bound.

## How a batch behaves

One batch, for one monitor, is:

1. read the archive's identity and compare it with the monitor's binding (bind it on first use);
2. read `SCAN_BATCH_BLOCKS` **whole** blocks after the monitor's coverage;
3. deserialize the viewing key, test the guaranteed offer and every fallible-segment offer of
   every regular transaction, clear the key;
4. commit that batch's associations **and** the coverage advance in **one** transaction.

A crash at any point therefore leaves either none of a height or all of it. Blocks with no
matches still advance coverage, so "scanned and empty" is always distinguishable from
"not scanned".

## Tuning

- `SCAN_BATCH_BLOCKS` is the crash-loss unit. `1` loses at most one block's work; a larger value
  amortizes the per-batch archive read and identity read across more blocks.
- Throughput is dominated by ledger deserialization, which happens **once per monitor per
  transaction**. Aggregate throughput is therefore roughly flat in the number of registered keys
  and per-key throughput falls roughly linearly. Measured on a synthesized 2 000-transaction
  corpus (`bench/shielded-monitor-scan.ts`): ~95 tx/s at one key, ~117 aggregate at ten,
  ~110 aggregate at fifty; RSS stayed between 226 and 260 MB across all three.

## What it logs

One line per `SCAN_METRICS_LOG_S`, carrying transactions scanned, matches, blocks scanned,
throughput and the maximum lag in blocks. **No monitor id and no viewing key appear in any log
line** — errors are rendered through a helper that redacts monitor ids while keeping the failure
class and the diagnosis.

## Monitor states you may see

| State | Meaning | What to do |
|---|---|---|
| `backfilling` | converging from the requested start towards the tip | nothing |
| `live` | coverage has reached the archive tip and is following it | nothing |
| `paused` | a consumer paused it; coverage frozen, matches still readable | resume when ready |
| `failed` | fail-closed: a transaction could not be read at a named height and position | investigate the bytes; the range was NOT recorded as scanned |
| `stale_source` | the archive was rebuilt (its instance id changed) under this monitor | decide whether to delete and re-register against the new archive |
| `revoked` / `deleted` | lifecycle terminal states | nothing; the scanner will not touch them |

`failed` and `stale_source` are deliberate stops, not crashes. In both cases the monitor's
coverage is exactly where it was, so nothing has been silently skipped.
