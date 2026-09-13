# Running the shielded-monitor node

The monitor-node is project **B**, in one process (00009-09). It serves the public API and the
dashboard, reads the archive's canonical finalized history through the archive read contract,
decides which transactions are relevant to each viewing key **it holds in RAM**, and records those
decisions with per-monitor coverage.

It replaces the two processes 00009-08 shipped — `umbradb-shielded-monitor` (the scanner) and
`umbradb-shielded-monitor-api` — which shared a viewing key through a database column. The key is
now never written anywhere.

```
umbradb-shielded-monitor-node     # installed binary
npm run shielded-monitor:node     # from a checkout
npx tsx shielded-monitor/node-cli.ts --help
```

## What it needs

- A reachable `umbradb-storage-api` (`STORAGE_URL`). The node has **no database connection**: no
  driver, no connection string, no schema name, and a boot refusal if a `*_PG` variable is in its
  environment.
- The vendored ledger v8 WASM (shipped with the package).
- At least one registered viewing key. With none, the node is healthy and idle — and it will stay
  that way, because keys arrive only by being sent to it.

## The two queues

```text
  Queue A (always running)            Queue B (always running, FIFO)
  ─────────────────────────           ──────────────────────────────
  get-tip every SCAN_POLL_MS          sync-key(fp)  catch ONE new key up to the live watermark
    │     or on an SSE height           │           page by page, one `advance` per block
    ▼                                   ▼
  scan-phase, per block:              back-sync(fp, from, to)
    deserialize each tx ONCE            re-read a range the key missed, one `fill-gap` per block
    test EVERY live key
    ONE advance-batch for the block
    liveWatermark = that height
```

A key is in one queue or the other, never both — which is what the key's **phase** records:

| phase | meaning |
|---|---|
| `syncing` | Queue B is catching it up; Queue A skips it, so its coverage cannot move past a range it never read |
| `live` | in the block-centric pass; every new block is committed for it |
| `paused` | its monitor is paused. The key **stays in RAM** and is skipped, so a resume needs no re-send |

**At boot the live watermark is the archive tip, not zero.** A node holds no keys at boot, so
there is nothing to scan history for; starting at zero would walk the whole chain testing an empty
key set and delay every key registered afterwards. History is Queue B's job, per key, from that
key's own coverage.

## Configuration

See [`shielded-monitor-deployment.md`](shielded-monitor-deployment.md) for the whole topology
and the migration from the pre-00009-08 single-host mode.

| Variable | Default | Meaning |
|---|---|---|
| `STORAGE_URL` | — (**required**) | Base URL of the `umbradb-storage-api`. **This process has no database connection** (00009-08 v2, owner Q25): it reads the archive and persists every monitor record through this one URL, and refuses to start if any `*_PG` variable is in its environment. |
| `ARCHIVE_URL` | `STORAGE_URL` | Where `/v1/archive/*` is served, if not by the storage API. |
| `NET` / `SHIELDED_MONITOR_NET` | `undeployed` | Network id / row scope. One network per deployment. |
| `MONITOR_NODE_ID` | a random UUID | This node's name, shown to a client as `heldBy`. |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `8787` | Where the public API, `/ui` and `/internal/*` are served. |
| `SCAN_BATCH_BLOCKS` | `8` | Whole blocks per Queue B page. Queue A is always ONE block per commit. |
| `SCAN_BLOCKS_PER_TURN` | `64` | Blocks Queue A commits before yielding, so a node far behind still answers requests. |
| `SCAN_POLL_MS` | `2000` | Fallback wake-up interval when no SSE height arrives. |
| `NODE_STATUS_LOG_SECONDS` | `60` | Seconds between the status log line; `0` disables it. |

The scanner-only variables of 00009-08 are **gone**: `SCAN_INSTANCE_ID` and `SCAN_LEASE_TTL_MS`
(there are no leases), `SCAN_CONCURRENCY`, `MAX_MONITORS` and `SCAN_MAX_BATCHES` (a node scans one
block at a time for every key at once, so there is nothing to parallelise across monitors),
`SCAN_ONCE` and `SCAN_BACKFILL_DETAILS`.

**Every numeric setting fails closed.** A zero, negative, fractional or non-numeric value stops
the process with the variable named. It is never silently replaced by the default — a bound that
quietly becomes something else is worse than no bound.

## How one block behaves (the live pass)

1. read the block through the archive read contract — never SQL against the archive;
2. for each regular transaction, **deserialize it ONCE** and test every live key against the
   guaranteed offer and each fallible-segment offer (the inversion 00009-09 introduced: before, a
   transaction was deserialized once per monitor, which is the expensive part of scanning);
3. for each match, record the transaction's **public zswap data** from the offers already in
   hand — output commitments, spent nullifiers, transients, contract addresses and a three-valued
   "is this one yours" — plus the block's timestamp;
4. for a key on its FIRST live pass, compare its stored coverage with `H − 1`; if it is lower,
   the range between was never read for that key, so record it as a **gap** and queue a
   `back-sync`;
5. commit **one `advance-batch`**: every held monitor's associations, every one's coverage advance
   to this height, and any gap rows — all in ONE transaction.

A crash at any point therefore leaves either none of a height or all of it, **for every monitor in
the block together**. Blocks with no matches still advance coverage, so "scanned and empty" is
always distinguishable from "not scanned".

A monitor whose epoch moved (a pause, a revoke) is reported back as fenced and **does not fail the
block for the others** (open point OP-2).

## Gaps, and what clears them

`scanned_through_height` is a single number and cannot describe a hole. So a range that was never
read for a monitor becomes a row in `shielded_monitor.monitor_gaps`, written in the same
transaction as the coverage move that would otherwise have hidden it, and a `back-sync` job reads
that range and clears the row with `fill-gap` — which writes the matches and shrinks, splits or
deletes the gap **without moving coverage**, because coverage is already above it.

A monitor is **complete** when `scannedThrough === sourceTip` AND its `gaps` list is empty. The
API and the dashboard both show the list.

## Backfilling match details for older matches

Matches recorded before this service stored per-transaction zswap data have `details = NULL`; the
API returns `null` and the dashboard says "details not recorded yet". One command fills them:

Since 00009-09 the backfill runs **inside a node, for the keys that node holds**: re-deriving a
match's details needs the viewing key, and there is nowhere else to get one. A monitor whose key
nobody holds is skipped and counted as `key-not-held`, and the fill happens when the client
re-sends the key.

It reads each match's block back **through the archive read contract** (never SQL against the
archive), recomputes the details with that monitor's key, and writes them. What it is careful
about:

- **Idempotent.** Every write carries `AND details IS NULL`, so a second run fills nothing and can
  never overwrite a recorded detail. Re-deriving details under a future
  `MATCH_DETAILS_VERSION` is therefore *not* something a re-run does; it would need its own
  deliberate step.
- **It cannot rewrite a match.** The only columns it may set are `details` and
  `block_timestamp_ms`. Height, position, transaction hash, matched segments, outcomes and
  coverage are not in its `SET` list.
- **It refuses what it cannot tie to the recorded match.** If the archive no longer holds that
  height, or the block there carries a different hash (a re-synced archive), or no transaction
  sits at the recorded position with the recorded hash, or re-evaluating it no longer reproduces
  the same matched segments, the row is **skipped and counted** — never filled with a guess. The
  summary line reports the counts by reason.
- **Fenced like every other write.** A pause, resume, revoke or delete landing under a run refuses
  the commit; a later run continues from the rows still `NULL`. Revoked and deleted monitors are
  refused outright. Paused, failed and `stale_source` monitors ARE filled: their matches stay
  readable, so leaving them detail-less would be a worse answer than filling them.
- It prints counts only — never a monitor id, for the same reason the scanner's own log lines do
  not.

## Tuning

- The live pass commits **one block at a time**, which is the smallest unit Rule B admits and the
  one that loses the least on a crash. `SCAN_BATCH_BLOCKS` tunes only Queue B's catch-up pages.
- Throughput is dominated by ledger deserialization, which since 00009-09 happens **once per
  transaction for all keys** rather than once per monitor per transaction. The 00009-05 figures
  (~95 tx/s at one key, ~117 aggregate at ten, ~110 at fifty on a synthesized 2 000-transaction
  corpus) were measured under the OLD shape and are not comparable; `bench/shielded-monitor-scan.ts`
  now measures the block-centric path and says so in its own header.

## What it logs

One status line per `NODE_STATUS_LOG_SECONDS`, carrying this node's id, how many keys it holds and
in which phases, the Queue B depth, the live watermark and the lag in blocks. **No monitor id, no
fingerprint and no viewing key appear in any log line** — not in the node's, and not in the
balancer's, which reads a registration body in order to route it. A required test captures both
and searches them, with a positive control.

## Monitor states you may see

| State | Meaning | What to do |
|---|---|---|
| `backfilling` | converging from the requested start towards the tip | nothing |
| `live` | coverage has reached the archive tip and is following it | nothing |
| `paused` | a consumer paused it; coverage frozen, matches still readable | resume when ready |
| `failed` | fail-closed: a transaction could not be read at a named height and position | investigate the bytes; the range was NOT recorded as scanned |
| `stale_source` | the archive was rebuilt (its instance id changed) under this monitor | decide whether to delete and re-register against the new archive |
| `revoked` / `deleted` | lifecycle terminal states | nothing; the node clears the key and forgets it |

Alongside the state, a monitor carries **custody**: `heldBy` (the node holding its key, or `null`)
and `keyNeeded` (`true` when nobody holds it and the state says it should be scanning). A monitor
reading `live` + `keyNeeded: true` is what a node restart leaves behind — the history is intact
and nothing is scanning until the client re-sends the key.

`failed` and `stale_source` are deliberate stops, not crashes. In both cases the monitor's
coverage is exactly where it was, so nothing has been silently skipped.
