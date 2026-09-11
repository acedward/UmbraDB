# Spec — the shielded-monitor storage boundary (EARS)

Scope: `umbradb-storage-api`, `HttpMonitorStore`, the no-database refusal, and the private-API
balancer. Governs `spec/00009` FR-010, FR-012, FR-025 and FR-026 in the split deployment.

## The storage API

- **SB-001** — The storage API SHALL expose the archive read contract at `/v1/archive/*` and the
  monitor store at `/v1/monitor-store/*` on one listener.
- **SB-002** — When the storage API receives a monitor-store command, it SHALL execute exactly one
  database transaction for that command.
- **SB-003** — When `POST /v1/monitor-store/monitors/<id>/advance` is received, the storage API
  SHALL commit that batch's associations, the coverage advance to `throughHeight` and (when
  supplied) the lease renewal in ONE transaction fenced by `expectedEpoch`.
- **SB-004** — When the stored epoch differs from `expectedEpoch`, or the monitor's state is not
  scannable, the storage API SHALL respond `409` with `error.code = "MONITOR_FENCED"` and SHALL
  write nothing.
- **SB-005** — When registration is received, the storage API SHALL derive the registration
  fingerprint from the submitted key bytes itself and SHALL NOT accept a client-supplied
  fingerprint.
- **SB-006** — The storage API SHALL bound every request body and SHALL respond `413` without
  reading the remainder of an oversized body.
- **SB-007** — The storage API's access log SHALL record the matched route pattern and SHALL NOT
  record a request body, a raw URL or a monitor id.
- **SB-008** — While no authentication is configured (alpha), the storage API SHALL bind loopback
  by default.

## The client

- **SB-010** — `HttpMonitorStore` SHALL implement `ShieldedMonitorStore` and SHALL produce, for
  every operation, the same observable result as `PgShieldedMonitorStore` on the same database
  state.
- **SB-011** — When the storage API returns a typed error, `HttpMonitorStore` SHALL throw the
  corresponding error class with the same discriminants.
- **SB-012** — When an `advance` request fails at the transport, `HttpMonitorStore` SHALL re-read
  the monitor before taking any further action, SHALL report `already-advanced` when coverage has
  reached `throughHeight`, SHALL resend at most once when coverage has not, and SHALL throw when
  the re-read cannot answer.
- **SB-013** — `HttpMonitorStore` SHALL NOT open a database connection, and no module under
  `shielded-monitor/**` SHALL be able to reach `postgres`, `src/postgres/**` or `storage-api/**`
  by any chain of imports.

## Project-B processes

- **SB-020** — When a project-B entry point starts and any `*_PG` variable, `ARCHIVE_SCHEMA`,
  `MONITOR_SCHEMA` or `SHIELDED_MONITOR_SCHEMA` is present in its environment, it SHALL refuse to
  start and SHALL name the variables it found.
- **SB-021** — When `STORAGE_URL` is absent, a project-B entry point SHALL refuse to start.
- **SB-022** — Where several scanner instances run against one storage API, each SHALL claim a
  monitor lease before scanning it and SHALL renew that lease inside the same transaction as the
  coverage advance; correctness SHALL NOT depend on the lease.

## The balancer

- **SB-030** — The balancer SHALL select one upstream uniformly at random per request.
- **SB-031** — The balancer SHALL exclude an upstream that fails its health probe and SHALL
  reinstate it when a later probe succeeds.
- **SB-032** — When no upstream is healthy, the balancer SHALL attempt every configured upstream
  rather than refusing outright.
- **SB-033** — The balancer SHALL retry a failed GET at most once on another upstream and SHALL
  NOT retry any other method.
- **SB-034** — The balancer SHALL set `X-Upstream` on every response it forwards.
