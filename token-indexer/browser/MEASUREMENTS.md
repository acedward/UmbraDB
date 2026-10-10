# Measurements

What the browser build of the token indexer costs and how fast it runs, next to the Node build on PostgreSQL over the
same recorded Stagenet range. Every figure says how it was measured; `../dev/measure-browser.ts` and
`../dev/measure-node.ts` reproduce them (see [Reproduce](#reproduce)).

## Setup

| Item | Value |
|---|---|
| Date | 2026-10-10 (except the live sync, see [Live sync](#live-sync-paced)) |
| Code | commit `b753c70`; the browser build is `vite.config.ts` with the automatic start off (`__UMBRADB_BROWSER_CONFIG__`) |
| Host | Apple-silicon Mac, Docker Desktop 29.7.2: a Linux arm64 VM with 12 CPUs and 31 GiB, shared with other work. Each figure gives the VM's 1-minute load average while it was taken |
| Image | `mcr.microsoft.com/playwright:v1.63.0-noble`: Node 24.20.0 and Chromium 153.0.8010.12 (Chrome for Testing), run `--headless=new`, a new profile per run |
| Packages | `@electric-sql/pglite` 0.5.8 (PostgreSQL 18.3), `@midnightntwrk/ledger-v9` 1.0.0-rc.3, Vite 8.3.4 |
| PostgreSQL | 17.11 (`postgres:17-alpine`, default settings) in its own container on a private Docker network |
| Serving | the built site from 127.0.0.1 with its `_headers` rules (the policy, COOP/COEP: the pages and the worker are cross-origin isolated), `cache-control: no-store`. Nothing is downloaded over a network: the browser figures exclude download time |
| CPU limits | none, except the status-page runs marked "2 CPUs" |
| Range | Stagenet 714485–715183 (699 blocks, 69 transactions), replayed from its recorded tape (`tapes/stagenet-714485-715183.tape.json.gz`); every replay's archive digest (`cb0d5e21…b119`) and 37-table digest (`af6583d0…c832c`) checked equal to the recorded live sync's |
| Statistics | median, with the range (lowest–highest) of n runs |

## Summary

| Measure | Browser: the Chrome worker, PGlite on OPFS | Node |
|---|---|---|
| Page open → engine ready ([Cold start](#cold-start)) | first open **1,267 ms**, reopen **385 ms**, browser restart 367 ms (download excluded) | — |
| Download ([Bundle sizes](#bundle-sizes)) | **8.3 MB** brotli, 10.8 MB gzip, 28.6 MB raw; tapes +1.1 MB, published snapshot +10.4 MB, fetched only when used | — |
| Live sync, paced, 714485–715183 ([Live sync](#live-sync-paced)) | **1.37 blocks/s** (510.6 s, sync and scan) | **1.47 blocks/s** (474.4 s, sync then scan), PostgreSQL 17 |
| Replay, unpaced, the same range ([Replay](#replay-unpaced)) | **267 blocks/s** | PostgreSQL 17 **506 blocks/s**; the same worker host on PGlite 270–276; the Node commands 250 |
| Storage per block ([Storage](#storage-per-block)) | **7,491 B** (OPFS files), 7,489 B (`pg_database_size`); empty store 42.3 MB | PostgreSQL 17: 7,536 B (relations) |
| Memory ([Memory](#memory)) | WebAssembly **208 MB** after the replay, **467 MB** peak while a store is created; worker 235 MB (`measureUserAgentSpecificMemory`); renderer process ≤ 1.12 GB resident | Node process with PostgreSQL ≤ 257 MB resident (server not counted) |
| Hidden tab ([Hidden tab](#hidden-tab)) | paced: as fast as visible (1.905 blocks/s); unpaced: 7–10 % slower | — |
| Status page open, budget < 5 % ([Status page](#the-status-pages-cost)) | **−1.4 %** (95 %: −4.8 to +2.2 %); with 2 CPUs −0.1 % (−2.9 to +2.7 %): **within budget** | — |
| Activity listings, 100,000 hidden + 100,000 visible rows ([Planner](#activity-listings-on-pglites-planner-and-planner-statistics)) | PostgreSQL 17's plans and buffers; bounded once vacuumed, whatever the statistics; never vacuumed (PGlite's lasting state) about 1,160 extra buffers per page for 100,000 withdrawn rows; `ANALYZE` changes nothing; API 0.5–4.7 ms | the same plans and buffers |

## Cold start

The explorer (`index.html`, the site's entry page) opened in a new tab of its own window; the engine worker boots on
`opfs-ahp://umbradb-stagenet`. **First open**: a new profile, so the boot creates the database. **Reopen**: the same tab
reloaded. **Restart**: the browser closed and started again on the same profile, the page opened in a new tab. Times
are on the page's clock, from the start of the navigation; the boot phases are the worker's own timings (`status` →
`boot.timings`). 7 runs of each (load 3.4–3.7). Download time is not included (see [Bundle sizes](#bundle-sizes)).

| Phase (median, ms) | First open | Reopen | Restart |
|---|---|---|---|
| HTML received | 2 | 2 | 2 |
| Page script ran (leader election starts) | 35 | 18 | 33 |
| Engine worker created | 53 | 58 | 47 |
| Worker scripts loaded, boot starts | 75 | 103 | 70 |
| `capabilities` (Chrome-only checks, an OPFS probe) | 8 | 3 | 3 |
| `store` (PGlite opens the store; a first open creates the database) | 952 | 227 | 231 |
| `ledger` (ledger-v9 loads; its WebAssembly compiles lazily, at the first decodes) | 22 | 21 | 22 |
| `migrate` (both schemas' migrations; already applied on a reopen) | 195 | 25 | 30 |
| **Page open → engine ready** | **1,267** (1,240–1,346) | **385** (351–430) | **367** (357–376) |

Inside the worker (its own clock, from its creation), the first open fetches PGlite's JavaScript (500 KB) by 34 ms,
`pglite.data` (6.3 MB) by 47 ms, `initdb.wasm` by 47 ms and `pglite.wasm` (10.1 MB, compiled while it streams) by about
123 ms; the ledger's `.wasm` (10.3 MB) is fetched in the `ledger` phase. The page and the worker are cross-origin
isolated in every run. No run had a policy violation or a page exception.

After a killed worker (the crash tests, `npm run test:crash`, `browser-crash-chrome.test.ts`: 100 kills at exact points,
the same host and image), the next boot on the store took median 2,386 ms (439–4,158, n 56) after `Worker.terminate()`
and 417 ms (378–687, n 44) after a renderer crash: after `terminate()` the new worker waits until the old one's OPFS
files and store lock are released; a crashed renderer releases them with its process. Both replay the write-ahead log
and come back at the last full block.

## Bundle sizes

`npm run build:browser` (`dist-browser/`, 47 files), each file compressed here with gzip level 9 and brotli quality 11
(what a host sends depends on its own compression).

| Files | Raw | gzip | brotli |
|---|---|---|---|
| ledger-v9 `.wasm` | 10,322,794 | 4,693,417 | 4,155,586 |
| `pglite.wasm` | 10,088,161 | 3,439,803 | 2,649,721 |
| `pglite.data` (PostgreSQL's share files) | 6,295,316 | 2,140,187 | 1,069,273 |
| `initdb.wasm` (fetched when a store is created) | 395,242 | 147,404 | 119,349 |
| JavaScript, 30 chunks (largest: PGlite 500,754; the ledger's glue 222,177; the worker 147,361) | 1,420,271 | 348,935 | 297,790 |
| Pages, styles, font, icon, `_headers` (9 files) | 62,539 | 45,843 | 44,121 |
| **Total without the tapes and the snapshot** (43 files) | **28,584,323** | **10,815,589** | **8,335,840** |
| The recorded tapes (IDX 1,010,756; U1 48,947; already gzip; fetched only for a replay) | 1,059,703 | 1,055,371 | 1,051,290 |
| Total with the tapes | 29,644,026 | 11,870,960 | 9,387,130 |
| The published snapshot (`snapshots/`: IDX, 10,399,232, and its index; fetched only when imported) | 10,401,096 | 10,186,757 | 10,004,868 |
| **Total with the tapes and the snapshot** | **40,045,122** | **22,057,717** | **19,391,998** |

A first visit downloads about the total without the tapes and the snapshot (the explorer does not load the other two
pages' few kilobytes): about 8.3 MB brotli or 10.8 MB gzip, which at 50 Mbit/s adds about 1.3 s or 1.7 s (10 Mbit/s:
6.7 s or 8.7 s; size ÷ bandwidth, computed, not measured) before the cold start above. The build took 5.2 s, the
snapshot generator included.

## Live sync (paced)

The browser figure comes from one live sync of the range in the browser build (not repeated: Stagenet is public, and
every request is paced), the Node figure from the repository's recorded live run of the same range by the Node
commands (`token-indexer/test/fixtures/live-range/stagenet-714485-715183.json`).

| | Browser | Node / PostgreSQL |
|---|---|---|
| When, where | 2026-10-10 00:35–00:44 UTC; the build of commit `9dc26d8` served from 127.0.0.1 to Chromium 153.0.8010.12 (`--headless=new`) in the Playwright image on this host; a new profile, the worker on OPFS | 2026-10-03; `chain-archive-sync/sync-cli.ts` then `token-indexer/mip0018/scan-cli.ts` in `node:24-bookworm`, PostgreSQL 17 |
| How | `range(714485, 715183)` on an empty store: sync and scan together in the worker; 20 heights per sync batch | the sync (200 heights per batch), then the scan |
| Pacing | ≥ 250 ms between request starts per endpoint, 4 heights in flight, retry and `Retry-After` as the Node commands | the same (the commands' defaults) |
| Time | **699 blocks synced and scanned in 510.6 s: 1.37 blocks/s** | sync 469.6 s + scan 4.8 s = 474.4 s: **1.47 blocks/s** |
| Requests | 2,202: node 1,468, indexer 734; all HTTP 200; 0 retries, 0 throttled | 2,111: node 1,406, indexer 705; 2,109 HTTP 200 and 2 transport time-outs, retried; 0 throttled |
| Result | archive digest `cb0d5e21…b119`, 37-table digest `af6583d0…c832c` | the same digests |

The live rate is set by the pacing, not by the browser: the node endpoint's 1,468 requests take at least 367 s at
4 starts per second. The browser asks for the finalized tip at every batch (two node requests and one indexer request
per batch of 20 heights: 35 batches against the Node command's 4 of 200), which accounts for its 62 extra node requests
and part of the difference; the small batches keep a `stop` and API requests waiting for little (see `README.md`). The
paced figure of the tab hidden is in [Hidden tab](#hidden-tab).

## Replay (unpaced)

The range synced and scanned from its recorded tape, with no pacing and no network, timed by the engine itself: from
the sync's `start` event to the scan step that reached 715183 (the browser's and the Node host's from their telemetry log
lines, `system` → `logs`; the PostgreSQL engine's from its events). Every run starts with an empty, migrated store and
checks both digests afterwards.

| Runtime, store (how) | Blocks/s | Sync + scan | Sync alone | Load |
|---|---|---|---|---|
| **Chrome worker, PGlite on OPFS** (`engine.html`, a new profile each run, 7 runs) | **267.0** (236.7–273.9) | 2,618 ms (2,552–2,953) | 2,374 ms | 2.0–3.2 |
| Node, the same worker host (`host.ts`: scheduler, session, telemetry), PGlite on a directory (7 runs) | 270.2 (253.5–274.9) | 2,587 ms (2,543–2,757) | 1,804 ms | 1.5–1.8 |
| Node, the same worker host, PGlite in memory (7 runs) | 275.7 (271.2–280.9) | 2,535 ms (2,488–2,577) | 1,765 ms | 1.5–1.8 |
| **Node, the engine on PostgreSQL 17** (`../engine/engine.ts`, the browser's 20 heights per sync batch and 10 blocks per scan step; 7 runs) | **506.2** (489.5–528.3) | 1,381 ms (1,323–1,428) | 1,111 ms | 1.5–1.8 |
| Node, the engine on PostgreSQL 17 with the Node commands' 200 / 100 (7 runs) | 509.1 (502.2–542.7) | 1,373 ms (1,288–1,392) | 1,100 ms | 1.5–1.8 |
| Node commands on PostgreSQL 17: `sync-cli.ts`, then `scan-cli.ts`, each its own process, the tape answered over HTTP (`../dev/live-range-check.ts replay`; 5 runs) | 250 | sync 1,766–1,790 ms + scan 1,005–1,022 ms, process start-up included | | 1.5–1.8 |

The Node runs were interleaved (one run of each in turn); each Node figure ran in a process of its own. The repository's
recorded replay of the Node commands (`token-indexer/test/fixtures/live-range/stagenet-714485-715183.json`: sync 5.0 s,
scan 4.4 s, about 74 blocks/s) was taken on another, slower host on 2026-10-03 and is not comparable with these.

In the browser the sync and the scan run together in one worker on one PGlite session, which also yields to the event
loop before each step and every 10 ms between statements (so API requests are answered during the replay). The Chrome
worker on OPFS and the same host in Node on PGlite replay at the same rate; PostgreSQL, a separate server process with
its own I/O, is about 1.9 times faster. Live, every runtime is limited by the pacing (see above), at less than 1 % of
these rates.

## Storage per block

The same IDX replay, the store measured empty (migrated) and after the 699 blocks.

| Measure | Empty | After 699 blocks | Per block |
|---|---|---|---|
| Browser, OPFS: the store's files (a walk of `umbradb-stagenet/` in the worker) | 42,307,211 B in 1,265 files | 47,543,731 B in 1,274 files | **7,491 B** |
| Browser, PGlite: `pg_database_size` | 9,871,483 B | 15,106,171 B | **7,489 B** |
| Browser, PGlite: `pg_total_relation_size` of every table of both schemas | 1,015,808 B | 6,250,496 B | 7,489 B |
| Node, PostgreSQL 17: `pg_total_relation_size` of every table of both schemas | 1,015,808 B | 6,283,264 B | **7,536 B** |

The 7 browser runs gave identical sizes (PGlite's `pg_database_size` and relation sizes are the same in Node, on a
directory and in memory). An empty store is mostly fixed cost: the data directory's own files (catalogs and template
databases) and a 16 MiB write-ahead-log segment, the largest file. After a reopen the store's files are 64,380,816 B in
1,278 files: a second 16 MiB file appears (a new write-ahead-log segment); the data is unchanged. `navigator.storage.estimate()` reported 995.3 MB in use right
after the store was created and 1,024.7 MB after the replay (Chrome counts the space it reserves for the store's open
files), and 73.7 MB after the reopen. On this range the blocks carry little: 69 transactions in 699 blocks; most of a
block's bytes are archived payloads: of the 6.25 MB the tables hold after the range, `chain_archive.chain_blobs`
(1,468 blobs) holds 3.99 MB, `chain_archive.blocks` 0.52 MB and `chain_archive.chain_blob_roles` 0.34 MB; the largest
MIP-0018 table, `mip0018_events`, 0.16 MB.

## Memory

Three runs of `engine.html`: boot (a first open), then the IDX replay. **WebAssembly memory**: the memories the worker's
modules import or export, tracked from the worker's first script (a probe around `WebAssembly.instantiate` and
`instantiateStreaming`, installed through a DevTools breakpoint before any of the worker's scripts) and sampled every
100 ms. **`performance.measureUserAgentSpecificMemory()`**: called from the page (cross-origin isolated by `_headers`;
Chromium run with `--enable-blink-features=ForceEagerMeasureMemory`). **Renderer**: the resident memory of the Chromium
renderer process that runs the page and its worker (`/proc/<pid>/status`, sampled every 200 ms).

| Measure | At boot (engine ready) | After the replay |
|---|---|---|
| WebAssembly memory, live | 467.3 MB: PGlite 197.7 MB, a second PGlite instance 197.7 MB and `initdb` 67.1 MB (the first open's database creation; garbage once collected), ledger-v9 4.7 MB | **208.0–208.5 MB**: PGlite 197.7 MB, ledger-v9 10.3–10.8 MB |
| WebAssembly memory, peak | **467.3 MB** at about 1.0 s of the worker's life (all three runs; one reached 471.4 MB at 2.0 s, the ledger grown before the collection) | |
| `measureUserAgentSpecificMemory()`, worker (`DedicatedWorkerGlobalScope`) | 222.5 MB (2 runs); 679.0 MB in the run where the creation's instances were not yet collected | **235.1–235.6 MB** |
| `measureUserAgentSpecificMemory()`, total | 225.9 MB (2 runs; 682.5 MB in the third), the page's share 2.6–2.8 MB | 238.6–239.1 MB |
| Renderer process, largest resident size over the run | | **1,006–1,121 MB** (high-water mark 1,034–1,147 MB) |

The second PGlite instance and `initdb` exist only while a store is created; a reopened store boots without them.

For comparison, the Node process's largest resident size over the boot and the IDX replay (`../dev/measure-node.ts
replay`, sampled every 50 ms, 3 runs each, load 3.5–4.6): the engine on PostgreSQL **241–257 MB** (the PostgreSQL
server's own processes not counted); the browser's worker host in Node on PGlite on a directory 787–970 MB, in memory
907–1,046 MB (both include creating the store, with its second PGlite instance).

## Hidden tab

The replay with the explorer's window shown or minimized (`document.visibilityState` "hidden" before the start and for
the whole run, checked), a new profile per run, alternating which comes first.

| Run | Visible | Hidden | Hidden takes longer by (95 % interval) |
|---|---|---|---|
| Unpaced, 5 pairs (load 2.5–3.4) | 268.6 blocks/s (265.0–272.7) | 251.9 blocks/s (225.6–255.8) | +10.3 % (+3.3 to +17.6 %) |
| Unpaced, `--disable-renderer-backgrounding`, 4 pairs (load 1.2–2.1) | 273.4 blocks/s (269.4–274.4) | 254.3 blocks/s (251.9–255.1) | +7.4 % (+5.3 to +9.4 %) |
| Paced (250 ms between request starts per endpoint, as on Stagenet), 1 pair (load 0.3–0.8) | 1.905 blocks/s (366.9 s) | 1.905 blocks/s (367.0 s, hidden for the whole 6.1 min) | 0.0 % |

Paced, as a live sync is, a hidden tab syncs exactly as fast as a visible one, also past the 5 minutes after which
Chrome throttles a hidden page's own timers: the engine runs in a dedicated worker, whose timers (the pacing) are not
throttled. Unpaced, the worker is 7–10 % slower while its page is hidden, also with Chrome's renderer backgrounding
(process priority) switched off; the worker yields to its event loop through a `MessageChannel`, not a timer. The
engine's own test `[[browser.worker.hidden-tab]]` (`browser-limits-chrome.test.ts`, one pair per run, the same host)
measured 228.5 blocks/s hidden against 270.4 visible. When Chrome freezes a background tab (for example with Energy
Saver), its worker stops with it and continues at its cursor once the tab is active again (`[[browser.tabs.in-flight]]`
freezes a leader tab).

## The status page's cost

What it costs the engine to have the system status page (`system.html`) open, against the budget: sync and scan
throughput fall by less than 5 %. The status page, while visible, makes the worker collect a snapshot about every 2 s
(a `/v1/status` read and the storage reading; the catalog statistics and the walk of the store's files about every
30 s) and draws it; hidden or closed, it makes the worker collect nothing.

**Design.** A replay lasts about 2.5 s and the host is shared, so single runs differ by more than the effect (a replay's
standard deviation over these rounds is about 6 %, and two runs can differ by 20 % or more). So: one browser, the explorer (`index.html`) leading in a window of its own, always
visible; the status page a follower in a second window, either shown (**open**: it watches and draws) or minimized
(**closed**: hidden, it watches nothing, as when it is not open); each arm replays the whole range again (`range`, which
drops the store's data first) and is timed by the engine's log lines; 30 rounds, each with both arms, in the order
open-closed then closed-open (ABBA), after one warm-up replay. The cost is the mean over the rounds of
log(open time / closed time), with its 95 % Student-t interval. The leader page stays visible in both arms: minimizing the
leader itself would also put the renderer that runs the worker in the background, which slows the worker by itself (see
[Hidden tab](#hidden-tab)), so that form (`--single`) is shown only for comparison.

| Run | Open | Closed | Cost: mean (95 % interval) | Rounds where open was slower |
|---|---|---|---|---|
| Unconstrained, 30 rounds (load 0.8–2.5) | 2,293.5 ms (2,234–2,660) | 2,389.5 ms (2,228–2,619) | **−1.4 % (−4.8 % to +2.2 %)** | 15 of 30 |
| **2 CPUs** (`--cpus=2 --cpuset-cpus=10,11`), 30 rounds (load 0.7–7.2) | 2,203.0 ms (2,154–2,482) | 2,214.5 ms (2,157–3,057) | **−0.1 % (−2.9 % to +2.7 %)** | 14 of 30 |
| 2 CPUs, the status page itself leading (`--single`: closed = the leader minimized), 10 rounds | 2,268.5 ms (2,180–2,786) | 2,528.0 ms (2,236–2,612) | −6.6 % (−11.3 % to −1.6 %) | 2 of 10 |

With the page open the worker collected and the page drew 1–2 snapshots per replay (one every 2 s); closed, none, and
the worker watched nothing. The catalog reading in a collection took 11–61 ms in all (5 statements, once per 30 s).
**The cost of an open status page is under the 5 % budget with 95 % confidence in both runs** (upper bounds +2.2 % and
+2.7 %); the measurements cannot tell it from zero. In the one-tab form the "closed" arm is the minimized leader, whose
worker is slower for being hidden (see above), so open looks faster there. The status page never forced a worker
restart, raised no policy violation and changed no digest.

## Activity listings on PGlite's planner, and planner statistics

PGlite runs no autovacuum, so a browser store is never analyzed (`pg_class.reltuples` stays -1) and never vacuumed.
The activity listings are kept to what a page serves by their own transaction-local planner settings (index scans
only); the activity bounded-cost test proves it on PostgreSQL only. Here the same scenario runs on PGlite and on
PostgreSQL 17 (`../dev/measure-node.ts planner`, Node, PGlite on a directory): contract Y mints token T, publishes its
metadata 100,000 times, withdraws it and emits one rejected event; a second identity of the same contract then publishes
100,000 times (200,002 events, 200,003 activity rows, 100,001 listed events; `pg_database_size` 282 MB on PGlite, 361 MB
on PostgreSQL). Each listing's statements run again under `EXPLAIN (ANALYZE, BUFFERS)` in one read-only transaction with
their settings applied; the buffers they read are compared with the test's bound, 100 + 20 per row the page may read. The
states: **natural** (never vacuumed or analyzed; on PostgreSQL the scenario's tables have autovacuum off), **vacuumed**
(the three listing tables), **fresh** (every table analyzed), **stale** (the listed events analyzed while they held two
live rows, then filled again).

Buffers read per page, PGlite 0.5.8 (PostgreSQL 18.3) and PostgreSQL 17.11 (the same on both except where shown):

| Listing (rows the page may read → bound) | Natural | Vacuumed | Fresh | Stale |
|---|---|---|---|---|
| contract activity, limit 1 (2 → 140) | **1,186** | 23 | 23 | 27 |
| contract activity, limit 100 (101 → 2,120) | **2,375** | 1,014 | 1,014 | 1,217 |
| contract activity, limit 100, page 2 (101 → 2,120) | 1,222 | 1,022 | 1,022 | 1,225 |
| contract activity, limit 1, descending (2 → 140) | 24 | 23 | 23 | 27 |
| color activity, limit 100, descending (202 → 4,140) | 1,217 (PostgreSQL 1,218) | 1,018 (1,019) | 1,018 (1,019) | 1,220 (1,221) |
| color activity, limit 1 (4 → 180) | **1,190** | 27 | 27 | 31 |
| color activity, limit 2, page 2 (6 → 220) | **1,201** | 36 | 36 | 42 |

- **PGlite plans the listings as PostgreSQL 17 does**: the same plan for every statement in every state, the same buffers
  within one. Planner statistics change nothing: the vacuumed (no statistics) and fresh columns are equal, and the stale
  statistics cost at most 203 buffers more.
- **Never vacuumed, a page that starts before the withdrawn rows steps over their dead index entries**: about 1,160
  buffers for 100,000 hidden rows (one per 86), above the bound for small pages, the same on PostgreSQL before its
  first vacuum (the test allows one buffer per 20 hidden rows there, 5,000 here). On PostgreSQL autovacuum ends that
  state; PGlite never leaves it. `VACUUM` of the three tables took 83 ms on PGlite (55 ms on PostgreSQL); `ANALYZE` of
  every table 152 ms (114 ms).
- Whole API requests (every statement of the request's read-only transaction, `createMip0018Handler`) read, natural /
  vacuumed / fresh / stale: `/v1/contracts/{Y}/activity?limit=50` 1,779 / 518 / 515 / 617 buffers,
  `/v1/tokens/{T}/activity?limit=50` 1,783 / 522 / 519 / 621, the `limit=100&order=desc` forms 1,217–1,222 / 1,018–1,023
  / 1,015–1,020 / 1,217–1,222; the same on both backends.

API latency through the handler, p50 / p95 in ms over 20 requests per route (after one), PGlite:

| Route | Natural | Vacuumed | Fresh | Stale |
|---|---|---|---|---|
| `/v1/status` | 0.63 / 0.74 | 0.57 / 0.91 | 0.56 / 0.96 | 0.54 / 0.56 |
| `/v1/tokens?limit=50` | 2.61 / 2.88 | 2.27 / 2.35 | 2.27 / 2.42 | 2.25 / 2.73 |
| `/v1/tokens/{T}` | 3.26 / 4.14 | 3.10 / 3.36 | 2.98 / 3.36 | 2.94 / 3.13 |
| `/v1/tokens/{T}/activity?limit=50` | 3.60 / 4.25 | 2.82 / 4.37 | 2.71 / 2.84 | 2.63 / 3.32 |
| `/v1/tokens/{T}/activity?limit=100&order=desc` | 4.69 / 5.51 | 4.18 / 5.11 | 3.76 / 4.50 | 3.76 / 4.00 |
| `/v1/contracts/{Y}/tokens?limit=50` | 3.45 / 4.17 | 2.76 / 3.24 | 2.57 / 3.25 | 2.51 / 2.65 |
| `/v1/contracts/{Y}/activity?limit=50` | 2.92 / 3.29 | 2.22 / 2.66 | 2.16 / 2.22 | 2.06 / 2.24 |
| `/v1/contracts/{Y}/activity?limit=100&order=desc` | 3.32 / 3.52 | 3.21 / 3.99 | 3.20 / 3.93 | 3.16 / 3.36 |
| `/v1/events?contract={Y}&limit=50` | 0.82 / 0.84 | 0.80 / 0.87 | 0.80 / 0.84 | 0.84 / 2.49 |

So on a store of this size `ANALYZE` makes no measurable difference on PGlite, and the never-vacuumed state costs
under 1 ms per activity page. On PostgreSQL 17 the same routes take 0.2–1.9 ms (p50) in the natural, vacuumed and fresh
states; in the stale state its color and contract activity routes take 103–152 ms (p50): the same plans and buffers as
above, spent in execution. PGlite answers them in 2.1–3.8 ms in that state.

## Reproduce

In the Playwright image (`mcr.microsoft.com/playwright:v1.63.0-noble`, where `findBrowser` finds Chromium), from the
repository root after `npm ci`:

```sh
npm run build:browser && node --import tsx token-indexer/dev/measure-browser.ts sizes
node --import tsx token-indexer/dev/measure-browser.ts cold --runs 7
node --import tsx token-indexer/dev/measure-browser.ts replay --runs 7
node --import tsx token-indexer/dev/measure-browser.ts memory --runs 3
node --import tsx token-indexer/dev/measure-browser.ts hidden --runs 5
node --import tsx token-indexer/dev/measure-browser.ts hidden --runs 1 --paced
node --import tsx token-indexer/dev/measure-browser.ts status-page --rounds 30      # also in a container with --cpus=2
PG_URL=postgres://… node --import tsx token-indexer/dev/measure-node.ts replay postgresql   # once per run; --node-batches
node --import tsx token-indexer/dev/measure-node.ts replay pglite-dir                       # or pglite-memory
node --import tsx token-indexer/dev/measure-node.ts planner pglite
PG_URL=postgres://… node --import tsx token-indexer/dev/measure-node.ts planner postgresql
```

Each prints one JSON line per run (`--out <file>` also appends it to a file); the status-page scenario's last line is
the cost with its interval. The live sync is not scripted: it reads public Stagenet.
