# Proposal — 00009-08: project B as a distinct deployable, with no database of its own

> Organizer spec: `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
> (approved 2026-09-10). Organizer sub-plan: `plans/00009-08-b-as-a-service.md` (v2).
> Owner decision that drives this shape: organizer question **Q25** (2026-09-11).
> This change stacks on `00009-07-match-details` (PR #15).

## Why this change exists

`spec/00009` FR-025 says project B's only access to project A is a read-only interface "with no
schema knowledge in B, so B can later run in a separate process or TEE", and FR-026 says the
scanner and the API run as separate processes. Both were true of the CODE and neither was true of
the DEPLOYMENT: every B process opened its own PostgreSQL connection, held a credential for the
main database, and constructed A's storage adapter for the archive. A "separate process" that
shares the database is not the separation the TEE step needs, because the boundary an attested
unit has to cross is exactly the one that did not exist.

The owner's Q25 decision is the strong form: **project B must have no database connection at
all.** It reads and writes its own state through one HTTP channel to an A-side process that owns
the single main database, so that encryption and attestation can later sit at that boundary
without moving anything above it.

An earlier attempt (v1 of this sub-plan) gave B its own PostgreSQL. The owner rejected a second
database; that work survives only as the lease design, which is now A-side state reached through
the storage API.

## What this change delivers

- **`umbradb-storage-api`** — one process, two route families, one credential:
  - `/v1/archive/*`, mounted from the SAME router `umbradb-archive-read-api` serves (one
    implementation, two processes);
  - `/v1/monitor-store/*`, **command-shaped**: one call is one `BEGIN … COMMIT`, and the commands
    are the store's methods, not its tables. `POST …/advance` carries a height's associations, its
    coverage advance and the caller's lease renewal in one body and one transaction, fenced by the
    monitor's epoch — a stale epoch is **409** with the rejection and the observed epoch/state.
- **`HttpMonitorStore`** (`shielded-monitor/storage-http-client.ts`) — project B's entire
  persistence surface, implementing the same `ShieldedMonitorStore` interface the PostgreSQL store
  implements, reconstructing the same typed errors, and resolving the one failure HTTP adds (a
  lost response after a commit) by **re-reading the monitor before retrying**, never by a second
  POST.
- **No database anywhere in B.** `shielded-monitor/no-database.ts` refuses to start a B process
  whose environment carries any `*_PG` variable; `test/shielded-monitor/import-boundary.test.ts`
  fails if any module under `shielded-monitor/**` can reach `postgres`, `src/postgres/**` or the
  storage API by any chain of imports, static or dynamic. The PostgreSQL store and the migration
  bootstrap moved to `storage-api/`.
- **`umbradb-shielded-monitor-balancer`** — a uniform-random balancer in front of the private API
  instances, with health exclusion and reinstatement, one retry for GET only, and `X-Upstream`.
- **Deployment**: one image with six commands (`Dockerfile.shielded-monitor`), a Compose overlay
  running **two scanners, two API instances, a balancer and one storage API over one database**,
  `npm run demo:shielded-monitor -- --split`, and `docs/shielded-monitor-deployment.md`.

## What it deliberately does not deliver

- **No encryption and no authentication.** Owner decisions Q3 and Q10/Q25. A registration carries
  a viewing key in the clear over the storage hop, and the storage API is unauthenticated and
  loopback-by-default. The boundary exists so that the TEE step has somewhere to put mTLS,
  attestation and record encryption — and Q25 chose option A (plaintext fields today) explicitly
  so that the process split lands before the schema question is reopened.
- **No second database, no schema change beyond the additive `003_monitor_leases`.**
- **No new runtime dependency.** `node:http`, the global `fetch`, and the `zod` this repository
  already ships.

## Breaking change

`umbradb-shielded-monitor` and `umbradb-shielded-monitor-api` no longer accept a database
connection: `MONITOR_PG`, `SHIELDED_MONITOR_PG`, `SHIELDED_MONITOR_SCHEMA`, `ARCHIVE_SCHEMA` and
`SHIELDED_MONITOR_BOOTSTRAP` are gone from them, and they refuse to start while any `*_PG`
variable is present. The database itself is untouched. The migration is three environment edits
plus one new service; `docs/shielded-monitor-deployment.md` states it.
