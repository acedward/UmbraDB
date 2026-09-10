# shielded-monitor-api Specification (delta — change `00009-04-private-api-cli`)

## Purpose

Defines the **private HTTP/JSON contract** by which one consumer application registers a shielded
viewing key, reads monitor status and coverage, pages matches by cursor, and drives the
pause/resume/revoke/delete lifecycle — plus the reference consumer that exercises it.

Storage, key intake and lifecycle semantics are governed by `00009-02-monitor-store` and are not
restated here except where the wire contract constrains them. Relevance scanning (`00009-03`) is
out of scope: this API serves whatever coverage and associations the store holds.

Traceability: organizer spec `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
User Stories 1, 2, 3, 5 and 6; requirements FR-017, FR-018, FR-019, FR-020, FR-021, FR-023 and
FR-026; success criteria SC-004 and SC-008. User Story 4 (tenant isolation and confidentiality) is
DEFERRED by owner decision of 2026-09-10, which is why this specification contains no
authentication requirement — the absence is a recorded decision, not an omission.

## Requirements

### Requirement: The private API exposes the seven monitor operations over HTTP/JSON

The service SHALL expose `POST /v1/monitors`, `GET /v1/monitors/:id`,
`GET /v1/monitors/:id/matches`, `POST /v1/monitors/:id/pause`, `POST /v1/monitors/:id/resume`,
`POST /v1/monitors/:id/revoke` and `DELETE /v1/monitors/:id`. Every request body and every query
parameter SHALL be validated against a schema before any storage work happens. A viewing key
SHALL be accepted only in the body of `POST /v1/monitors`, and SHALL NOT appear in any response.

#### Scenario: Registration returns a monitor view without the key
- **WHEN** a valid viewing key for the deployment network is posted with a start height
- **THEN** the service SHALL answer `201` with an opaque monitor id, state `backfilling` and the
  coverage object
- **AND** the response SHALL contain neither the submitted key nor any fingerprint

#### Scenario: Registering the same key twice returns the same monitor
- **WHEN** the same key and network are registered a second time
- **THEN** the service SHALL answer `200` with the monitor id created by the first registration

#### Scenario: A malformed or wrong-network key is refused identically
- **WHEN** a key that is not Bech32m, or whose human-readable part names another network, or whose
  payload is not the ledger's canonical encoding, is submitted
- **THEN** the service SHALL answer `400` with one generic error code and one generic message
- **AND** the message SHALL be byte-identical across all three cases

#### Scenario: A viewing key is never accepted anywhere else
- **WHEN** any endpoint other than `POST /v1/monitors` is called
- **THEN** no request schema of that endpoint SHALL admit a viewing-key field

### Requirement: Unknown monitors answer 404 and revoked monitors answer 410

The service SHALL answer `404` for a monitor id that names nothing, **and** for one whose monitor
has been deleted, so that a deleted monitor is indistinguishable from one that never existed. The
service SHALL answer `410` for a monitor that has been revoked, for every operation except a
repeated revoke.

#### Scenario: A revoked monitor refuses status and matches
- **WHEN** status or matches are requested for a revoked monitor
- **THEN** the service SHALL answer `410`

#### Scenario: A deleted monitor answers as if it never existed
- **WHEN** any endpoint is called with the id of a deleted monitor
- **THEN** the service SHALL answer `404`
- **AND** the response SHALL be indistinguishable from the response for a never-issued id

#### Scenario: Revoke is idempotent
- **WHEN** revoke is called on an already-revoked monitor
- **THEN** the service SHALL answer `200` with the revoked monitor view

#### Scenario: An inadmissible lifecycle transition is a conflict, not a not-found
- **WHEN** resume is called on a monitor that is not paused
- **THEN** the service SHALL answer `409`

### Requirement: Matches are paged by an opaque cursor bound to its monitor

The matches endpoint SHALL return items in `(blockHeight, position)` order together with an opaque
`nextCursor`. The same cursor with the same page size SHALL return the same page. A cursor SHALL
carry the identity of the monitor it was minted for, and the service SHALL refuse a cursor whose
monitor differs from the one named in the path.

#### Scenario: Every match is returned exactly once across pages
- **WHEN** a consumer pages from an empty cursor with any page size until the returned page is
  short
- **THEN** the concatenation of the pages SHALL equal the monitor's association set exactly, in
  `(blockHeight, position)` order, with no duplicate and no omission

#### Scenario: The same cursor returns the same page
- **WHEN** the same cursor is submitted twice with the same page size
- **THEN** both responses SHALL carry the identical item list

#### Scenario: A cursor from another monitor is refused
- **WHEN** a cursor minted for monitor A is submitted on monitor B's matches endpoint
- **THEN** the service SHALL answer `400`
- **AND** no item of either monitor SHALL be returned

#### Scenario: A cursor beyond current coverage keeps its position
- **WHEN** a consumer polls with a cursor at the end of the current association set
- **THEN** the service SHALL answer with an empty item list and a `nextCursor` equal to the
  submitted cursor, so a repeated poll resumes from the same place

### Requirement: Every status and matches response carries coverage as block heights

Status and matches responses SHALL include `requestedStart`, `scannedFrom`, `scannedThrough` and
`sourceTip`. Heights SHALL be rendered as decimal strings so that a height above 2^53 cannot lose
precision. A range that has not been scanned SHALL be reported as an absent height, never as a
zero and never as an empty result.

#### Scenario: Not-yet-scanned is distinguishable from scanned-and-empty
- **WHEN** matches are read for a monitor whose coverage has not advanced
- **THEN** the item list SHALL be empty **and** `scannedFrom` and `scannedThrough` SHALL be absent

#### Scenario: Scanned-and-empty advances coverage while the page stays empty
- **WHEN** coverage advances over a range containing no matches
- **THEN** `scannedThrough` SHALL move to the new height while the item list stays empty

#### Scenario: An unobserved source tip is reported as unknown, never as zero
- **WHEN** the deployment has no source-tip provider configured
- **THEN** `sourceTip` SHALL be absent
- **AND** it SHALL NOT be rendered as `"0"`

### Requirement: The alpha API has no authentication and binds to loopback

The service SHALL NOT implement authentication, authorization, tenant scoping, rate limiting or
quotas in this alpha (owner decision, 2026-09-10). It SHALL bind `127.0.0.1` by default, SHALL
allow the bind address and port to be configured, and its documentation SHALL state that the
deployment is responsible for restricting network access.

#### Scenario: The default bind address is loopback
- **WHEN** the server is started with no host configured
- **THEN** it SHALL listen on `127.0.0.1`

#### Scenario: The documentation states the deployment restriction
- **WHEN** the API documentation and the README are read
- **THEN** both SHALL state that the API is unauthenticated and that network access must be
  restricted by the deployment

### Requirement: The API caps request body size and page size

The service SHALL enforce a maximum request body size and a maximum matches page size, both
configurable, and SHALL answer `400` with a typed error when either is exceeded. The body cap
SHALL be enforced while the body is being read, not after it has been buffered. The configured
page cap SHALL NOT exceed the store's own association page cap, and a configuration that exceeds
it SHALL fail at startup.

#### Scenario: An oversized body is refused before it is buffered
- **WHEN** a request body one byte larger than the configured maximum is sent
- **THEN** the service SHALL answer `400` with a body-too-large code
- **AND** SHALL NOT have retained the whole body in memory

#### Scenario: An out-of-range page size is refused
- **WHEN** a page size of zero, a negative page size, a non-numeric page size, or one above the
  configured maximum is requested
- **THEN** the service SHALL answer `400`

### Requirement: No viewing key appears in a log record or an error body

Log records, error bodies and any diagnostic the service emits SHALL NOT contain a viewing key in
any encoding. Request logging SHALL NOT include request bodies. An unmapped internal error SHALL
NOT forward its message to the client.

#### Scenario: A leak scan over a full exercise finds nothing
- **WHEN** every endpoint has been exercised, including registrations that fail at each intake
  stage
- **THEN** a scan of every captured log record and every captured error body for the Bech32m
  string, the serialized bytes in hexadecimal and the payload in base64 SHALL find zero
  occurrences

#### Scenario: The leak scan is proven capable of detecting a leak
- **WHEN** the same scan is applied to a record deliberately containing the key
- **THEN** the scan SHALL report the occurrence

#### Scenario: An unexpected internal fault does not echo its message
- **WHEN** a handler raises an error the mapper does not recognise
- **THEN** the response SHALL carry a fixed internal-error message and the request id, and SHALL
  NOT carry the raised message

### Requirement: A reference consumer completes the whole flow over HTTP alone

The repository SHALL ship a reference consumer command-line client that registers a key from a
file, reads status, polls matches with a cursor persisted in a file, and drives pause, resume,
revoke and delete. It SHALL communicate with the service only over HTTP, SHALL NOT import the
store, a database driver or a schema name, and SHALL print only monitor ids, coverage and
transaction hashes.

#### Scenario: The client completes register through delete
- **WHEN** the client is driven through register, status, poll, pause, resume, revoke and delete
  against a running service
- **THEN** every step SHALL succeed and the reported state and coverage SHALL match the service's

#### Scenario: Polling is idempotent across restarts
- **WHEN** poll is run twice with the same cursor file and no new associations exist
- **THEN** the second run SHALL print no transaction hash the first already printed
- **AND** the cursor file SHALL be unchanged

#### Scenario: The client holds no database dependency
- **WHEN** the client's import closure is audited
- **THEN** it SHALL contain only Node built-in modules

### Requirement: The API and the client are entry points of the same package

The service and the reference consumer SHALL each be a published command-line entry point of the
package, so a deployment runs them as separate processes from the archive ingester.

#### Scenario: Both entry points are declared and buildable
- **WHEN** the package is built
- **THEN** the file each declared entry point names SHALL exist in the build output
