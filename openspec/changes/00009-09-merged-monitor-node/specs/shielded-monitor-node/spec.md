# Spec — the merged monitor-node (EARS)

Scope: `umbradb-shielded-monitor-node`, the balancer's registration routing, and the storage
API's block-centric commands. Governs `spec/00009` FR-002, FR-010, FR-011, FR-012, FR-025 and
FR-026 in the 00009-09 deployment. Supersedes the parts of
`00009-08-b-as-a-service/specs/shielded-monitor-storage-boundary/spec.md` that name key material
or leases.

## Key custody

- **MN-001** — The system SHALL NOT persist a viewing key. `monitors.key_serialized` SHALL be
  NULL for every row this system writes.
- **MN-002** — When a monitor-node accepts a viewing key, it SHALL zero-fill every byte buffer
  holding that key once the ledger handle exists, whether or not the handle was created.
- **MN-003** — When a held key is revoked, deleted, dropped after a `not-found` fence, or when the
  process shuts down, the node SHALL call `clear()` on that key's ledger handle exactly once.
- **MN-004** — When a monitor is paused, the node SHALL retain its key in memory and SHALL NOT
  scan with it; when the monitor resumes, the node SHALL NOT require the key to be re-sent.
- **MN-005** — The node SHALL NOT write a viewing key, a key fragment, or a fingerprint to any log
  record, and neither SHALL the balancer, which reads a registration body in order to route it.
- **MN-006** — A monitor-node SHALL acquire a key only through `POST /v1/monitors`.

## Scanning

- **MN-010** — At boot the node SHALL set its live watermark to the archive tip.
- **MN-011** — For each new block, the node SHALL deserialize each transaction at most once and
  SHALL test every live key against that deserialization.
- **MN-012** — The node SHALL commit each block with exactly ONE `advance-batch` covering every
  monitor it holds in the live phase, and SHALL advance its live watermark only after that commit
  succeeds.
- **MN-013** — When a key is registered, the node SHALL catch it up from its recorded coverage to
  the live watermark before including it in the live pass, and SHALL re-read the watermark after
  each page.
- **MN-014** — On a key's first live pass, the node SHALL compare that monitor's recorded
  `scannedThrough` with `H − 1`; when it is lower, the node SHALL record `[scannedThrough + 1,
  H − 1]` as a gap in the same transaction as the coverage move, and SHALL enqueue a back-sync for
  that range.
- **MN-015** — A back-sync SHALL write the range's associations and shrink, split or delete the
  gap rows it covers, and SHALL NOT move coverage.
- **MN-016** — When a block cannot be read or decoded, the node SHALL NOT advance its watermark
  past it.

## The storage API

- **MN-020** — `POST /v1/monitor-store/monitors` SHALL accept a 32-byte fingerprint and SHALL NOT
  accept key material.
- **MN-021** — When a registration names a `(net, fingerprint)` that already exists in a
  non-deleted state, the storage API SHALL return that monitor with its coverage and its gaps.
- **MN-022** — `POST /v1/monitor-store/advance-batch` SHALL execute exactly one database
  transaction, and SHALL report a fenced item in the 200 response body rather than failing the
  batch.
- **MN-023** — `POST /v1/monitor-store/monitors/<id>/fill-gap` SHALL execute exactly one database
  transaction, fenced by `expectedEpoch`.
- **MN-024** — `GET /v1/monitor-store/monitors/<id>/key-material`, `GET …/lease`,
  `POST /v1/monitor-store/leases/claim` and `POST …/leases/release` SHALL respond `410`.
- **MN-025** — The storage API SHALL NOT read or write `monitor_leases`.

## Routing

- **MN-030** — On `POST /v1/monitors` the balancer SHALL compute the key's fingerprint without
  loading the ledger WASM, and SHALL serialise the decision per fingerprint.
- **MN-031** — The balancer SHALL NOT route to a hinted node without confirming with that node
  that it holds the fingerprint.
- **MN-032** — When no node holds the fingerprint, the balancer SHALL forward to the healthy node
  reporting the fewest held keys, breaking ties by the shortest Queue B.
- **MN-033** — The balancer SHALL discard every hint naming a node it has observed to be
  unreachable or unhealthy.
- **MN-034** — The balancer SHALL respond `404` to any client request under `/internal/` and SHALL
  NOT forward it.
- **MN-035** — When a registration body cannot be turned into a fingerprint, the balancer SHALL
  forward it unrouted rather than producing its own error.
- **MN-036** — `GET /v1/monitors` and `GET /v1/monitors/<id>` through the balancer SHALL report
  `heldBy` as the answer of a fan-out across healthy nodes, and `keyNeeded` as true exactly when
  `heldBy` is null and the monitor's state is `backfilling` or `live`.
