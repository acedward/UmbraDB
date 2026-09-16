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
| `failed` | its monitor STOPPED — an undecodable transaction, an unsupported protocol version, or an archive rebuilt underneath it. The key **stays in RAM** and is skipped: the monitor's matches are still readable, and a stopped scan is not a reason to destroy a key its owner has not asked to delete. A DELETED monitor's key is cleared instead, at once (the balancer forwards the delete to the holder) or by the next block at the latest (the `not-found` fence) |

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

**The lifecycle is give or delete** (owner decision Q33). A viewing key is GIVEN with
`POST /v1/monitors` and DELETED with `DELETE /v1/monitors/<id>`; there is no pause, no resume and
no revoke. The states a monitor can occupy are the ones the SYSTEM reaches on its own —
`backfilling`, `live`, `failed`, `stale_source` — plus `deleted`. Migration 001's `state` CHECK
still admits the two removed literals and is deliberately not rewritten (it belongs to an
already-open change, and this lineage does not edit a shipped migration); no code path can produce
one, because no transition yields it.

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

A monitor whose epoch moved, or which stopped or was deleted underneath the batch, is reported
back as fenced and **does not fail the block for the others** (open point OP-2).

## Gaps, and what clears them

`scanned_through_height` is a single number and cannot describe a hole. So a range that was never
read for a monitor becomes a row in `shielded_monitor.monitor_gaps`, written in the same
transaction as the coverage move that would otherwise have hidden it, and a `back-sync` job reads
that range and clears the row with `fill-gap` — which writes the matches and shrinks, splits or
deletes the gap **without moving coverage**, because coverage is already above it.

A monitor is **complete** when `scannedThrough === sourceTip` AND its `gaps` list is empty. The
API and the dashboard both show the list.

**A back-sync expects rows it already has.** Its whole purpose is to go back over ground the
coverage number already claims, so `fill-gap` is idempotent: rows already present under `(monitor,
height, block hash, position)` are skipped, `written` counts only what was really inserted, and the
gap shrinks either way. Two ordinary situations produce the overlap — a moment of double custody
(the balancer's `holds` probe times out, the client re-sends the key, and the old holder writes the
same height before it notices) and an operator repairing coverage by hand.

**A gap is retried at the next hold.** A gap is discovered once, by the check above, and the job
that fills it lives in the RAM of the node that found it. So whenever a node finishes syncing a
key, it also queues a back-sync for every gap the record still carries — which is how a hole left
behind by a node that died, or by a back-sync whose transport failed, gets cleared instead of
sitting in `monitor_gaps` forever.

## Match details

Every match this node records carries the transaction's public zswap data (00009-07) written in
the same transaction as the coverage advance. Matches recorded by an older build have
`details: null`, and there is **no backfill command** to fill them in: re-deriving a match's
details needs the viewing key, which since 00009-09 exists only in a node's RAM, and the owner's
decision (Q29) was to ship forward rather than carry a repair tool for an unreleased service.

## Monitor states you may see

| State | Meaning | What to do |
|---|---|---|
| `backfilling` | converging from the requested start towards the tip | nothing |
| `live` | coverage has reached the archive tip and is following it | nothing |

| `failed` | fail-closed: a transaction could not be read at a named height and position | investigate the bytes; the range was NOT recorded as scanned |
| `stale_source` | the archive was rebuilt (its instance id changed) under this monitor | decide whether to delete and re-register against the new archive |
| `deleted` | the consumer deleted it: its matches, its gaps and its registration identity are gone, and the node clears the key | nothing; giving the same key again starts a FRESH monitor |

Alongside the state, a monitor carries **custody**: `heldBy` (the node holding its key, or `null`),
`heldPhase` (that key's phase inside the node — `syncing`, `live` or `failed`), and `keyNeeded`
(`true` when nobody holds it and the state says it should be scanning). A monitor
reading `live` + `keyNeeded: true` is what a node restart leaves behind — the history is intact
and nothing is scanning until the client re-sends the key.

`failed` and `stale_source` are deliberate stops, not crashes. In both cases the monitor's
coverage is exactly where it was, so nothing has been silently skipped.

## The DUST tree mirror (optional; project 00016)

Set `DUST_DATABASE_URL` and the node gains a sixth job: it folds the chain's DUST ledger events —
the ones `chain-archive-sync` captures into `chain_archive.dust_events` — into one key-less
`DustLocalState`, and serves the two Merkle trees to wallets through `/v1/dust/*`
(`docs/shielded-monitor-api.md`). Leave it unset and nothing changes; those routes answer
`503 DUST_DISABLED`.

**Why it is here and not somewhere else.** A wallet that syncs its DUST from the indexer replays
every DUST event the chain ever produced — 1.49 M of them on preprod, measured at about two hours.
Every wallet repeats the same fold over the same public data. The node does it once, and hands each
wallet only the parts of the trees it does not own, as collapsed Merkle updates it applies in
seconds. The wallet still computes its own nullifiers and successors, with a key this process never
sees.

**This is the one place project B touches a database, and it is waived, read-only and confined.**
`shielded-monitor/node/dust/` is the only directory that may import a driver
(`spec/00016-dust-wallet-sync.md` §1, owner decision 2026-09-15). The role it connects as can read
`dust_events`, `dust_parameters` and `blocks` and nothing else — `docs/shielded-monitor-deployment.md` has the SQL,
and `test/shielded-monitor/dust-reader-role.integration.test.ts` proves every other read and every
write is refused. The accepted cost is that the database sees which nullifiers a wallet asks about;
a later project replaces the query with an enclave-side copy.

### What it does on start

1. Reads the newest `dust_parameters` row for its net — the chain's three DUST parameters, written
   by the ingest (migration 010). They are what the mirror's `DustLocalState` is CONSTRUCTED with
   and what `GET /v1/dust/tip` serves. No row means `parametersSource: "unknown"` and the ledger's
   initial parameters; see **DUST parameters** below.
2. Loads `DUST_STATE_SNAPSHOT_DIR/<net>.dust-state` if one is there **and it is at most
   `DUST_STATE_SNAPSHOT_MAX_BYTES`**. A snapshot from another `net`, another ledger build, or one
   built with different DUST parameters is refused — serialized ledger state is a ledger-internal
   encoding and its parameters cannot be changed on load — and the mirror replays from zero, saying
   so in its log. A snapshot over the size limit is also skipped; see **Why a big snapshot is
   skipped** in the deployment doc, and `startPath` below.
3. Reads `dust_events` in batches of `DUST_REPLAY_BATCH`, folding each batch into the trees, until
   it reaches the table's tip. Until then the DUST routes answer `503 DUST_NOT_READY`, and every
   monitor-store route works exactly as before — the fold yields between batches, deliberately, so
   the rest of the node keeps answering throughout.
4. Keeps following the table every `DUST_STATE_POLL_MS`, snapshotting every
   `DUST_STATE_SNAPSHOT_EVERY` events and on a clean shutdown.

### DUST parameters

A `DustLocalState` takes its parameters from its constructor and ignores parameter events
entirely, so the mirror has to be **told** which ones the chain uses. It is told by
`chain_archive.dust_parameters`: one row at genesis, one per change, and one at a resume point on
an archive that gained the table late. The ingest writes them from the ledger state it is already
holding.

The node **never deserializes a ledger state** to find this out. It used to — reading the newest
replay checkpoint and calling `LedgerState.deserialize` on a 31 MB blob, which is minutes of one
synchronous WebAssembly call during which the node answers nothing (project 00016, question Q-22).
That is why the reader role is not granted `replay_checkpoints` or `chain_blobs`.

**A mid-chain parameter change costs a full re-fold.** `DustLocalState.params` is read-only in the
WASM bindings and the constructor is the only way parameters enter a state, so they cannot be
swapped in place — and the snapshot on disk holds a state built with the old ones. When a row
appears above the one the mirror's state was built from, the mirror logs it, reports
`parametersSource: "changed-at-<height>"`, and rebuilds from zero. The DUST routes answer
`503 DUST_NOT_READY` until it catches up; everything else keeps working. The resulting trees are
identical either way — parameters do not touch them — so what the re-fold buys is that the `params`
a wallet is handed match the state it is served segments from. A DUST parameter change is a
governance action and has not happened on any Midnight network to date.

### Reading `/internal/status`

```json
"dust": { "enabled": true, "producer": "ingest", "ready": true,
          "applied": { "eventId": "1490233", "height": "853596" },
          "snapshotEventId": "1480000", "rss": 2411724800, "externalBytes": 1984000000,
          "parametersSource": "chain", "parametersHeight": "0",
          "parameters": { "nightDustRatio": "5000000000", "generationDecayRate": "8267",
                          "dustGracePeriodSeconds": "10800" },
          "startPath": "replay", "startMs": 154300, "lastError": null }
```

| field | what it tells you |
|---|---|
| `producer: "none"` | the archive holds no DUST events for this net at all — its ingest ran with `REPLAY_VALIDATION=0`. A deployment mistake, not a transient state, and the routes say `503 DUST_NO_PRODUCER` rather than pretending to be an empty chain |
| `ready: false` | still folding; `applied.eventId` is how far |
| `applied` | the trees' tip. Always behind or equal to the table's — every DUST response reports this number, not the table's, so a client can tell |
| `rss` / `externalBytes` | process memory, and Node's `external`, which is where the trees actually live. ≈ 2 KB per leaf; watch it before enabling the module on two nodes |
| `parametersSource` | `chain` — read from a `dust_parameters` row; `unknown` — the archive records none, so the ledger's initial parameters are in use (right on every Midnight network so far, but a guess must not read like a fact); `changed-at-<height>` — a row appeared above the one the state was built from and the mirror rebuilt for it |
| `parametersHeight` / `parameters` | the row's height, and the three values this node serves on `GET /v1/dust/tip`. `null` height under `unknown` |
| `startPath` | `snapshot` if the snapshot was small enough to restore, `replay` if there was none or it was over `DUST_STATE_SNAPSHOT_MAX_BYTES`. On a large chain `replay` is the faster **and** the responsive path — see the deployment doc |
| `startMs` | how long this mirror took to catch up, or `null` while it still has not |
| `lastError` | the last fold or query failure, this module's own message |

### If the mirror stops advancing

`lastError` names it. Two shapes are worth knowing:

- **a database fault** — `applied` stops, the already-folded trees keep serving `tip` and
  `segments`, and the three table-backed routes answer `503 DUST_DB_UNAVAILABLE`. Nothing is lost;
  the next poll resumes.
- **a replay refusal** (`NonLinearInsertion` and friends) — the table has a hole. The ingest
  refuses to write a discontinuous capture for exactly this reason, so a hole means the table was
  filled some other way. `npm run dust:backfill` rebuilds it; the mirror will not advance past the
  hole and deliberately does not skip it, because a tree missing leaves is a tree every wallet
  would then fail to verify against.
