# Deploying the shielded monitor: one database, one storage process, N monitor-nodes

**Status**: alpha (00009-09). No authentication, no encryption, one consumer. Read
[SECURITY.md](../SECURITY.md) before exposing any of this beyond loopback.

## The shape

```text
                        ┌──────────────────────────┐
   PostgreSQL  ◄────────┤ umbradb-storage-api      │  the ONLY process with a database
   (one database:       │  /v1/archive/*           │  credential in this deployment
    chain_archive +     │  /v1/monitor-store/*     │
    shielded_monitor)   └────────────▲─────────────┘
        ▲                            │ STORAGE_URL (HTTP/JSON)
        │                 ┌──────────┴───────────────────────────────┐
   umbradb-archive-sync   │                                          │
   (node-only ingest)     │                                          │
              ┌───────────┴───────────┐              ┌───────────────┴───────────┐
              │ monitor-node 1        │              │ monitor-node 2            │
              │  public API + /ui     │              │  public API + /ui         │
              │  /internal/* (private)│              │  /internal/* (private)    │
              │  Queue A: scan blocks │              │  Queue A: scan blocks     │
              │  Queue B: sync/back   │              │  Queue B: sync/back       │
              │  VIEWING KEYS, IN RAM │              │  VIEWING KEYS, IN RAM     │
              └───────────▲───────────┘              └───────────▲───────────────┘
                          └──────────────┬───────────────────────┘
                            umbradb-shielded-monitor-balancer
                              registration → the node holding that key
                              everything else → a uniformly random node
                                             ▲
                                          consumer
```

**A viewing key lives in the RAM of exactly one monitor-node and nowhere else** (00009-09, owner
decision Q28). It is never written to disk, never written to the database, and never logged; the
storage API is told only its SHA-256 **fingerprint**, which is the monitor's identity. A node that
restarts holds nothing: its monitors report `key needed` until the client re-sends the key, which
— because the fingerprint is the identity — finds the same monitor and resumes from its stored
coverage rather than rescanning history.

**Project B — the monitor-nodes and the balancer — has no database connection at all.** It reads and writes everything through
`STORAGE_URL`, and each of those processes **refuses to start** if any `*_PG` variable (or an
`ARCHIVE_SCHEMA` / `MONITOR_SCHEMA` / `SHIELDED_MONITOR_SCHEMA`) is present in its environment.
That is owner decision Q25, and the reason for it is the next step rather than this one: the
boundary crossed here is where at-rest encryption and a TEE's attested channel will sit, so it
has to exist — and be the only path — before either is built.

Two mechanisms keep the claim true rather than aspirational:

| mechanism | what it proves | where |
|---|---|---|
| the import guard | no module under `shielded-monitor/**` can reach `postgres`, `src/postgres/**` or the storage API by ANY chain of imports, static or dynamic | `test/shielded-monitor/import-boundary.test.ts` |
| the boot refusal | a leftover credential in a B process's environment stops it, naming the variable | `shielded-monitor/no-database.ts` |
| the key never persisted | no row of `monitors` holds key material in any state, and the serialized bytes are zero-filled the instant the ledger has them | `test/shielded-monitor/store.integration.test.ts`, `test/shielded-monitor/monitor-node.test.ts` |

## Environment matrix

Everything is configured through the environment; no process takes a configuration file, and none
needs an entrypoint script beyond picking a command.

### `umbradb-storage-api` (project A — holds the credential)

| variable | default | meaning |
|---|---|---|
| `ARCHIVE_PG` | `PG*` environment | connection string for the main database |
| `MONITOR_PG` | `ARCHIVE_PG` | project B's schema; normally the same database |
| `ARCHIVE_SCHEMA` | `chain_archive` | the archive's schema |
| `MONITOR_SCHEMA` | `shielded_monitor` | project B's schema |
| `STORAGE_BOOTSTRAP` | unset | `1` applies project B's migration lineage at boot |
| `NET` | `undeployed` | the one network this deployment serves |
| `STORAGE_HOST` / `STORAGE_PORT` | `127.0.0.1` / `8788` | bind address and port (`0` = kernel picks) |
| `STORAGE_MAX_BLOCKS` | `64` | whole blocks per archive page; a larger `max` is clamped |
| `STORAGE_HEARTBEAT_MS` | `15000` | SSE heartbeat on `/v1/archive/events` |
| `STORAGE_MAX_BODY` | `16777216` | monitor-store request body cap |

### `umbradb-shielded-monitor-node` (the API, the dashboard and both scan queues, in one process)

| variable | default | meaning |
|---|---|---|
| `STORAGE_URL` | — **required** | base URL of the storage API |
| `ARCHIVE_URL` | `STORAGE_URL` | where `/v1/archive/*` is served, if not the storage API |
| `NET` / `SHIELDED_MONITOR_NET` | `undeployed` | network id (`SHIELDED_MONITOR_NET` wins) |
| `MONITOR_NODE_ID` | random UUID | this node's name, shown as `held by` |
| `SOURCE_TIP` | unset | `off` reports `sourceTip: null` (no archive access at all) |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `8787` | bind address and port |
| `API_MAX_BODY_BYTES` | `65536` | request body cap |
| `API_MAX_PAGE` / `API_DEFAULT_PAGE` | `200` / `50` | matches page caps |
| `SCAN_POLL_MS` | `2000` | fallback poll interval (the SSE wake-up is an optimisation) |
| `SCAN_BATCH_BLOCKS` | `8` | whole blocks per Queue B page; Queue A is always 1 per commit |
| `SCAN_BLOCKS_PER_TURN` | `64` | blocks Queue A commits before yielding to requests |
| `NODE_STATUS_LOG_SECONDS` | `60` | seconds between status log lines; `0` disables |

Give every node its own `MONITOR_NODE_ID`. The default is a random UUID per process precisely so
two containers started from one image and one environment do not claim one identity — the
balancer's hint table would then point at "one" node that is really two.

### `umbradb-shielded-monitor-balancer`

| variable | default | meaning |
|---|---|---|
| `BALANCER_UPSTREAMS` | — **required** | comma-separated base URLs of the monitor-nodes |
| `BALANCER_HOST` / `BALANCER_PORT` | `127.0.0.1` / `8789` | bind address and port |
| `BALANCER_PROBE_MS` | `5000` | `/v1/health` probe interval; `0` disables probing |
| `BALANCER_TIMEOUT_MS` | `60000` | per-request timeout to an upstream |
| `BALANCER_MAX_BODY_BYTES` | `65536` | cap on a `POST /v1/monitors` body it reads in order to route it |
| `NET` / `SHIELDED_MONITOR_NET` | `undeployed` | the network a viewing key's HRP must match |

## Scaling

**Nodes scale by adding instances, and a key belongs to exactly one of them.** There is no lease
and no shared claim table: what a node holds in RAM IS the truth about who scans a monitor, so the
balancer asks rather than reads. On `POST /v1/monitors` it decodes the key far enough to compute
its fingerprint (a Bech32m decode and a SHA-256 — no ledger WASM), then:

1. consults its **hint table** and verifies the hint with `GET /internal/holds?fp=` on that node —
   a hint is never trusted without the check, because the node it names may have restarted;
2. on a miss, fans `holds` and `status` out to every healthy node — a node that answers `holds:
   true` wins whatever its load;
3. otherwise places the key on the node with the **fewest keys**, breaking ties by the **shortest
   Queue B**.

A node that dies takes its keys with it. That is the design: the monitors it held report
`key needed` (`heldBy: null` while their state is still `backfilling`/`live`), the balancer drops
every hint naming it, and the client re-sends the key — which routes to a survivor and resumes
from the coverage already in the database.

Correctness does not depend on any of this. Two nodes that somehow held one key would still
produce exactly the right associations: the per-monitor **epoch fence** and the monotonic coverage
guard live in one `UPDATE` inside `advance`/`advance-batch`, and a losing racer is told
`already-advanced`. The routing is what stops the waste, not what makes it safe.

**Reads scale for free.** The matches cursor is a per-monitor association sequence, not a server
handle, so a consumer may be moved between nodes mid-scroll and still sees exactly the sequence it
would have seen from one. The balancer picks a node **uniformly at random** for every route but
registration, excludes one that fails a `/v1/health` probe (and reinstates it when it recovers),
retries a **GET** once on another node, and **never retries a POST**. Every response carries
`X-Upstream`.

`GET /v1/monitors` and `GET /v1/monitors/<id>` are answered with `heldBy` and `keyNeeded` filled
in from a fan-out, because a node can only speak for itself: it cannot see its peers.
`/internal/*` is **never forwarded** — a client asking for it gets 404 from the balancer.

**The balancer forwards a DELETE to the holder.** `DELETE /v1/monitors/<id>` is the only lifecycle
operation there is (owner decision Q33) and is served by whichever node the balancer picked — it is
a storage operation — while the KEY it destroys sits in the RAM of a node that may not be that one.
So after a 2xx the balancer posts a best-effort `POST /internal/events
{"type":"stateChanged","monitorId":…}` to the node it believes holds that monitor (from the same
`holds` fan-out that fills `heldBy`), or to every healthy node when it has no belief. It is
fire-and-forget with a two-second timeout, sent after the client's response is already on the wire,
and a refused forward is logged and otherwise ignored: the holder's next `advance-batch` is fenced
`not-found` and drops the key anyway (measured at 2.8 s on the live demo). The forward is there
because "the key is gone" is the claim this system makes about deletion, and a claim worth making
is worth making in milliseconds.

**The storage API is currently one process.** It is stateless itself (all state is in PostgreSQL),
so several instances behind a balancer would work; nothing in this alpha needs it, and one fewer
moving part is worth more than the headroom.

## Running it

```sh
# Two monitor-nodes and a balancer, with a unique project name and a loopback port:
BALANCER_HOST_PORT=18789 docker compose -p umbradb-mystack \
  -f test/compose/docker-compose.yml \
  -f test/compose/docker-compose.shielded-monitor.yml \
  up -d node postgres archive-sync storage-api \
     shielded-monitor-node-1 shielded-monitor-node-2 shielded-monitor-balancer

# ... and the same thing as one command, with randomised ports and teardown:
npm run demo:shielded-monitor -- --split
```

One image (`Dockerfile.shielded-monitor`) with six commands: `node`, `balancer`, `derive-key`,
`storage`, `archive-sync`, `client`. One image rather than two because they share a lockfile, a
build and a vendored ledger; the separation that matters is which command runs with which
environment.

**The nodes have no volume, deliberately.** There is nothing to persist: coverage, associations
and lifecycle all live in the database, and the one thing a node holds that the database does not
— the viewing keys — must not survive the process.

## Migrating from the 00009-08 deployment (BREAKING)

Before 00009-09 project B ran as a scanner and a private API, sharing a viewing key through a
database column. **Both of those processes are gone.**

| gone | replacement |
|---|---|
| bin `umbradb-shielded-monitor` (scanner) | `umbradb-shielded-monitor-node` |
| bin `umbradb-shielded-monitor-api` | the same one process |
| image commands `scanner`, `api` | image command `node` |
| `SCAN_INSTANCE_ID`, `SCAN_LEASE_TTL_MS`, `SCAN_CONCURRENCY`, `MAX_MONITORS`, `SCAN_MAX_BATCHES`, `SCAN_ONCE`, `SCAN_BACKFILL_DETAILS` | removed — a node scans one block at a time for every key at once, so there is nothing to parallelise across monitors and no claim to own |
| `GET /v1/monitor-store/monitors/<id>/key-material` | **410 Gone** — the database holds no key material |
| `GET monitors/<id>/lease`, `POST leases/claim`, `POST leases/release` | **410 Gone** — there are no leases |
| `POST /v1/monitor-store/monitors` with `keySerialized` | takes `fingerprint` (32 bytes, base64) |

To migrate:

1. Apply migration `004_key_in_ram_and_gaps` (`STORAGE_BOOTSTRAP=1`, or run the harness). It
   relaxes one CHECK and adds `monitor_gaps`; it drops nothing and rewrites no row.
2. Replace each `scanner` + `api` pair with one `node` service. Keep `STORAGE_URL`; add
   `MONITOR_NODE_ID`; drop the scanner-only variables above.
3. Point `BALANCER_UPSTREAMS` at the nodes and give the balancer `NET`.
4. **Re-send every viewing key.** This is the one operational step with no automatic equivalent:
   the keys that were in the database are not loaded from it, so every existing monitor shows
   `key needed` until its client registers the key again. The re-send is idempotent and reaches
   the same monitor — the fingerprint is unchanged — and the node resumes from the stored
   coverage.

Existing coverage, associations and lifecycle history are untouched. `monitors.key_serialized` and
the `monitor_leases` table are left in place, unused and never written, and a later cleanup
migration drops them (open point OP-4: dropping them now would not be an additive migration).

If a B process still has a credential in its environment it will stop with a message naming the
variable. That is deliberate: a leftover `MONITOR_PG` is a live credential in the environment of a
process whose whole reason for existing is that it has none.

## What step 3 (the TEE profile) adds here

The seam is already the whole of B's egress, so the TEE step changes the **transport and the
payload**, not the topology:

- **mTLS and attestation on `STORAGE_URL`**, replacing the injectable `fetch` in
  `shielded-monitor/storage-http-client.ts` — the same seam the tests inject through today.
- **Record encryption at B's boundary**: the storage API currently stores B's fields as plaintext
  columns (owner Q25 option A, "first divide the process, then figure out the correct structure
  and add the encryption"). The alternative it deferred — opaque payloads the host never parses —
  is a change to this wire and this schema, and to nothing above them.
- **A B image with no storage code at all**: drop `dist-cli/storage-api`,
  `dist-cli/chain-archive-sync` and `dist-cli/src/postgres` from the attested image. The import
  guard already proves nothing in B loads them; a hardened build makes them absent.
- **The balancer's placement**: it decodes a submitted key in order to compute the fingerprint it
  routes by, so it is inside the trust boundary today (open point OP-1). The TEE step either moves
  it into the enclave or has the client send a precomputed fingerprint header instead, at which
  point the balancer never sees a key at all. Nothing else changes: the routing already works from
  the fingerprint alone.
- **Key material never needed an exit route**: 00009-08's `key-material` route was the single
  place a viewing key left the database. There is no such route and no such key, so the attested
  channel the TEE step adds carries only registration — the one moment a key crosses into B.
