# shielded-monitor-dashboard Specification (delta — change `00009-06-dashboard`)

## Purpose

Defines the **operator-facing surface** of the shielded monitor: the list route that answers "what
monitors exist?", the HTML dashboard the API process serves so coverage can be watched rather than
polled by hand, and the command that turns a seed into a registrable viewing key and a fundable
address.

Storage and lifecycle semantics are governed by `00009-02-monitor-store`, relevance by
`00009-03-relevance-scanner`, and the consumer wire contract by `00009-04-private-api-cli`. This
delta adds to that contract and changes none of it.

Traceability: organizer spec `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`
User Stories 1, 2, 3 and 6; requirements FR-011, FR-017, FR-018, FR-020, FR-021, FR-023, FR-026.
User Story 4 is DEFERRED by owner decision of 2026-09-10; this surface therefore carries **no
authentication**, which is a recorded decision and is stated on the page itself.

## Requirements

### Requirement: The service lists every monitor it holds

The service SHALL expose `GET /v1/monitors` returning every monitor whose state is not `deleted`,
each rendered in the same view shape as `GET /v1/monitors/:id`, ordered by creation time with a
stable tiebreak. The page size SHALL be bounded by the same cap as the matches route, and no item
SHALL carry a viewing key or a fingerprint.

#### Scenario: An empty deployment lists nothing
- **WHEN** the list is read on a deployment with no monitors
- **THEN** the service SHALL answer `200` with an empty item array

#### Scenario: Monitors appear in creation order whatever their state
- **GIVEN** monitors registered in a known order and driven into `backfilling`, `live`, `paused`
  and `failed`
- **WHEN** the list is read
- **THEN** every one of them SHALL appear exactly once, in registration order
- **AND** each SHALL carry the state, the coverage object, the provenance versions and
  `appliedOutcome` semantics of the single-monitor view

#### Scenario: A revoked monitor is listed although reading it individually is refused
- **GIVEN** a revoked monitor
- **WHEN** the list is read
- **THEN** the revoked monitor SHALL appear with state `revoked`
- **AND** `GET /v1/monitors/:id` for that same id SHALL still answer `410`

#### Scenario: A deleted monitor is not listed
- **GIVEN** a deleted monitor
- **WHEN** the list is read
- **THEN** no item SHALL name it, and it SHALL be indistinguishable from a monitor that never
  existed

#### Scenario: The page cap is enforced with a typed error
- **WHEN** the list is requested with a page size of zero, a non-integer, or one above the
  configured maximum
- **THEN** the service SHALL answer `400` with the validation error code

### Requirement: The service serves a self-contained dashboard

The service SHALL serve an HTML dashboard at `GET /ui` and `GET /ui/`, and SHALL redirect `GET /`
to it. The page SHALL load no resource from any origin other than the serving origin, SHALL be
served with a Content Security Policy that admits only this page's own code, and SHALL require no
build step, no framework and no runtime dependency beyond those the service already has.

#### Scenario: The dashboard is served with its policy
- **WHEN** `GET /ui` is requested
- **THEN** the service SHALL answer `200` with `content-type: text/html; charset=utf-8`
- **AND** SHALL set a `content-security-policy` header whose default source is the serving origin
  and whose script and style sources are hashes of the page's own inline code

#### Scenario: The dashboard references nothing external
- **WHEN** the served HTML is inspected
- **THEN** no attribute or stylesheet declaration SHALL reference an absolute `http://` or
  `https://` URL

#### Scenario: Every path the page calls exists
- **WHEN** the API paths appearing in the served HTML are compared with the service's route table
- **THEN** every one of them SHALL resolve to a declared route

#### Scenario: The bare root leads to the page
- **WHEN** `GET /` is requested
- **THEN** the service SHALL answer `302` with a location naming the dashboard

#### Scenario: Coverage that is not known is never drawn as zero
- **GIVEN** a monitor whose scan has not started, or a deployment that cannot observe the archive
  tip
- **WHEN** the dashboard renders that monitor
- **THEN** the unscanned coverage values SHALL read as "not scanned" and the unobservable tip SHALL
  read as "unknown"
- **AND** an empty match list SHALL be rendered together with the coverage that explains it

### Requirement: The dashboard handles the viewing key exactly as the API does

The dashboard SHALL accept a viewing key only in its registration field, SHALL transmit it only in
the body of the registration request, and SHALL NOT place it in a URL, retain it in browser
storage, echo it into the page, or cause it to be written to a server log.

#### Scenario: Registering through the page leaves no key in the logs
- **WHEN** a monitor is registered through the request the dashboard issues, and every other
  endpoint is exercised with the same key
- **THEN** a scan of the service's log records, its response bodies and the served HTML SHALL find
  the key in none of its encodings
- **AND** the same scan SHALL find the key when it is deliberately planted, proving the scan works

#### Scenario: The key field does not survive the request
- **WHEN** a registration attempt completes, whether it succeeded or was refused
- **THEN** the field SHALL be empty and the key SHALL appear nowhere in the page

### Requirement: A viewing key can be derived from a seed by a shipped command

The package SHALL ship a command that reads a seed from a **file**, derives the shielded
encryption secret key, and prints the Bech32m viewing key for the named network together with the
coin public key and the encryption public key. It SHALL support both the raw-seed key and the
hierarchical-deterministic role key a wallet uses, and SHALL never accept a seed as a command-line
argument.

#### Scenario: The derived key is the one the service accepts
- **WHEN** the command is run on a seed
- **THEN** the printed Bech32m string SHALL be accepted by the service's own key intake for that
  network, and SHALL equal the string the repository's own key-encoding path produces for that seed

#### Scenario: The hierarchical derivation matches the wallet
- **WHEN** the command is run with hierarchical derivation on a seed for which a wallet-derived
  vector exists
- **THEN** the derived coin public key and encryption public key SHALL equal the wallet's

#### Scenario: A seed on the command line is refused
- **WHEN** the seed is supplied as a command-line argument rather than a file
- **THEN** the command SHALL exit with its usage code and SHALL name the file flag

#### Scenario: The seed is never printed
- **WHEN** the command succeeds or fails for any reason
- **THEN** neither its standard output nor its standard error SHALL contain the seed

### Requirement: The demonstration is runnable from a document

The repository SHALL carry a runbook that brings the stack up on an isolated Compose project,
ingests, scans, serves the API and the dashboard, registers a derived key, and tears everything
down. It SHALL state which steps need Docker, which need the proof server, and that a foreign
devnet must never be used.

#### Scenario: The wallet-free half runs unattended
- **WHEN** the runbook's non-wallet steps are executed
- **THEN** the archive SHALL ingest, coverage SHALL advance, and the dashboard SHALL be reachable
  on the loopback port the runbook chose

#### Scenario: Teardown leaves nothing behind
- **WHEN** the teardown step is executed
- **THEN** no container, network or volume of that project name SHALL remain, and no unrelated
  stack SHALL be affected
