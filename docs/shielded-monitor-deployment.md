# Deploying the shielded monitor: one database, one storage process, N of everything else

**Status**: alpha (00009-08 v2). No authentication, no encryption, one consumer. Read
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
                 ┌────────┴────────┐                    ┌────────────┴───────────┐
                 │ scanner ×N      │                    │ private API ×M         │
                 │ (leases)        │                    │ (+ /ui dashboard)      │
                 └─────────────────┘                    └────────────▲───────────┘
                                                                     │
                                              umbradb-shielded-monitor-balancer
                                                  (uniform random per request)
                                                                     ▲
                                                                  consumer
```

**Project B — the scanner, the private API and its dashboard, the details backfill and the
balancer — has no database connection at all.** It reads and writes everything through
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

### `umbradb-shielded-monitor` (scanner)

| variable | default | meaning |
|---|---|---|
| `STORAGE_URL` | — **required** | base URL of the storage API |
| `ARCHIVE_URL` | `STORAGE_URL` | where `/v1/archive/*` is served, if not the storage API |
| `NET` | `undeployed` | network id |
| `SCAN_INSTANCE_ID` | random UUID | this instance's lease owner name |
| `SCAN_LEASE_TTL_MS` | `30000` | how long a claim survives without renewal |
| `SCAN_BATCH_BLOCKS` | `1` | whole blocks per batch, and therefore per commit |
| `SCAN_CONCURRENCY` | `4` | monitors scanned in parallel |
| `SCAN_POLL_MS` | `2000` | fallback poll interval (the SSE wake-up is an optimisation) |
| `MAX_MONITORS` | `100` | monitors picked up per cycle |
| `SCAN_MAX_BATCHES` | `64` | batches one monitor may run before others get a turn |
| `SCAN_BUDGET_TX_PER_S` | unset | optional per-monitor throughput ceiling |
| `SCAN_ONCE` | unset | `1` runs a single cycle and exits |
| `SCAN_BACKFILL_DETAILS` | unset | `1` runs the 00009-07 details backfill and exits |

### `umbradb-shielded-monitor-api` (private API + dashboard)

| variable | default | meaning |
|---|---|---|
| `STORAGE_URL` | — **required** | base URL of the storage API |
| `ARCHIVE_URL` | `STORAGE_URL` | where `/v1/archive/*` is served, for `sourceTip` |
| `SHIELDED_MONITOR_NET` | `undeployed` | network id |
| `SOURCE_TIP` | unset | `off` reports `sourceTip: null` (no archive access at all) |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `8787` | bind address and port |
| `API_MAX_BODY_BYTES` | `65536` | request body cap |
| `API_MAX_PAGE` / `API_DEFAULT_PAGE` | `200` / `50` | matches page caps |

### `umbradb-shielded-monitor-balancer`

| variable | default | meaning |
|---|---|---|
| `BALANCER_UPSTREAMS` | — **required** | comma-separated base URLs of the API instances |
| `BALANCER_HOST` / `BALANCER_PORT` | `127.0.0.1` / `8789` | bind address and port |
| `BALANCER_PROBE_MS` | `5000` | `/v1/health` probe interval; `0` disables probing |
| `BALANCER_TIMEOUT_MS` | `60000` | per-request timeout to an upstream |

## Scaling

**Scanners scale by adding instances.** Each claims a **monitor lease** before working on a
monitor and renews it *inside the same server-side transaction* as the coverage advance, so a
height is never durable under a lapsed claim. A lease is an optimisation and nothing more: what
makes two scanners safe is the per-monitor **epoch fence** and the monotonic coverage guard, both
of which live in one `UPDATE` inside `advance`. Remove the leases entirely and the associations
would still be exactly right — just computed twice. Give every instance its own
`SCAN_INSTANCE_ID`; the default is a random UUID per process precisely so two containers started
from one image and one environment do not share an owner string and renew each other's claims.

An instance that dies mid-turn has its monitors taken over after `SCAN_LEASE_TTL_MS`. A graceful
stop (SIGTERM) hands them back immediately.

**API instances scale behind the balancer.** They are stateless: the matches cursor is a
per-monitor association sequence, not a server handle, so a consumer may be moved between
instances mid-scroll and still sees exactly the sequence it would have seen from one. The
balancer picks an upstream **uniformly at random per request**, excludes an upstream that fails a
`/v1/health` probe (and reinstates it when it recovers), retries a **GET** once on another
upstream, and **never retries a POST** — a replayed `POST /v1/monitors` would be a registration
the consumer never made. Every response carries `X-Upstream`.

**The storage API is currently one process.** It is stateless itself (all state is in PostgreSQL),
so several instances behind a balancer would work; nothing in this alpha needs it, and one fewer
moving part is worth more than the headroom.

## Running it

```sh
# The 2x2 test deployment, with a unique project name and a loopback port:
BALANCER_HOST_PORT=18789 docker compose -p umbradb-mystack \
  -f test/compose/docker-compose.yml \
  -f test/compose/docker-compose.shielded-monitor.yml \
  up -d node postgres archive-sync storage-api \
     shielded-monitor-scanner-1 shielded-monitor-scanner-2 \
     shielded-monitor-api-1 shielded-monitor-api-2 shielded-monitor-balancer

# ... and the same thing as one command, with randomised ports and teardown:
npm run demo:shielded-monitor -- --split
```

One image (`Dockerfile.shielded-monitor`) with six commands: `scanner`, `api`, `balancer`,
`derive-key`, `storage`, `archive-sync`. One image rather than two because they share a lockfile,
a build and a vendored ledger; the separation that matters is which command runs with which
environment.

## Migrating from the single-host deployment

Before 00009-08 v2 the scanner and the API took `MONITOR_PG` / `SHIELDED_MONITOR_PG` and reached
the archive schema in the same database. **That mode is gone** — those processes now require
`STORAGE_URL` and refuse to start while a `*_PG` variable is present.

1. Deploy `umbradb-storage-api` with the connection string the scanner used
   (`ARCHIVE_PG=<dsn>`), plus `STORAGE_BOOTSTRAP=1` on its first start if the
   `shielded_monitor` lineage is not applied yet.
2. Replace `MONITOR_PG` / `SHIELDED_MONITOR_PG` / `ARCHIVE_SCHEMA` in the scanner and API
   services with a single `STORAGE_URL` pointing at it.
3. Nothing in the database changes. The schema is the same, the rows are the same, and the
   migration lineage is the same (00009-08 adds `003_monitor_leases`, which is additive).

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
- **Key material out of the process**: `GET /v1/monitor-store/monitors/<id>/key-material` is the
  single route through which a viewing key leaves the database, which is what makes an attested
  channel (or a sealed-key handle) a local change rather than a rewrite.
