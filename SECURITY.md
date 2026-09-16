# Security policy & threat model

UmbraDB is a single-node, single-writer storage **library** for Midnight clients. It is **not** a
service, not a distributed system, and not a multi-tenant database. Its security properties follow
directly from that shape, and this document states — as **binding assumptions a deployer must
uphold** — the trust boundaries the code relies on but does **not** itself enforce. The single
acute InfoSec risk for a project like this is a deployer over-trusting a boundary the library never
implemented; the purpose of this file is to remove that risk by naming every such boundary
explicitly.

If a statement below is phrased as a **MUST**, it is a precondition for safe operation, not a
recommendation. Where a claim rests on code, the file and line are cited so it can be re-verified
against the tree.

## Trust model (the assumptions the code is built on)

### T-A1 — Single trusted writer, one trust domain

The deployer **MUST** ensure exactly **one trusted process** holds the Postgres connection and
drives all reads and writes. There is **no adversarial API caller**: every consumer of the public
API (`createClient`, the five adapters, `PgWalletStateEnvelopeStore`) MUST be inside one trust
domain. The library performs no authentication, authorization, rate-limiting, or per-caller
isolation of its own — it is a storage engine, and the process embedding it is responsible for who
may call it.

This is the library's explicit design posture, not an accident: the connection-pool and lease code
states it in-line — "this project's single-writer deployment model does not expect callers to probe
for exhaustion" (`src/postgres/transaction-lease.ts:328`). The advisory-lock lease
(`acquireLease`/`withLease`) coordinates a single logical writer against itself across processes;
it is **not** a security mechanism that fences off a hostile writer.

### T-A2 — Trusted Postgres, disk, backups, and operator

The deployer **MUST** ensure the Postgres instance UmbraDB connects to, the disk that instance
writes to, its backups, its replicas, and the operator who administers it are all **trusted**. The
DB role UmbraDB connects as owns every schema it touches and may read and write every byte UmbraDB
stores. UmbraDB provides no defense against a compromised database server, a stolen backup, or a
malicious DBA — protecting those is the deployer's responsibility (see *Data at rest*, below).

## `schema` is namespacing, NOT a security or tenant boundary

Every UmbraDB adapter accepts a Postgres `schema` (defaulting to the client's configured schema).
A `schema` is an **organizational namespacing convenience only**. It is **NOT** a security or
tenant boundary:

- All queries run under **one** DB role that owns every schema it is pointed at.
- A caller can point any adapter at **any** schema; nothing in the library prevents it. Cross-schema
  access is prevented **only** by T-A1 (the single trusted writer chooses which schema to use), not
  by any access control the library enforces.

Therefore, **if you ever need real multi-tenancy** (mutually-distrusting tenants that must not read
or write each other's data), you **MUST** enforce it at the **Postgres level** — a role per tenant
with `GRANT`s scoped to that tenant's schema, and/or row-level security (RLS) — and **never** rely
on the UmbraDB `schema` argument for isolation. UmbraDB will not, and is not designed to, keep two
tenants apart on its own.

## The chunk pool is one global trust domain with an observable cross-wallet side channel

`CheckpointStore` (and `PgWalletStateEnvelopeStore`, which is built on it) stores large snapshots as
content-addressed chunks in a **single global, content-addressed pool that is shared across all
wallets** — not partitioned per wallet or per network. A chunk is written once, keyed by the hash of
its own bytes, and re-used ("deduplicated") by any later checkpoint — for the same wallet or a
**different** one — whose data contains an identical chunk. The dedup upsert is a global
`ON CONFLICT (hash) DO UPDATE SET created_at = now()`
(`src/postgres/checkpoint-store.ts:233`) and garbage collection reclaims a chunk only when **no**
manifest **anywhere in the store** still references it (`src/postgres/checkpoint-store.ts:518-527`).

Because that pool is global, chunk **existence** and garbage-collection **behavior** are
**observable across wallets** through two side channels. Both are the classic cross-user
deduplication oracle (Harnik–Pinkas–Shulman-Peleg):

1. **A `save`-timing existence oracle.** Writing a chunk whose bytes are **not yet** in the pool
   performs a first-time `bytea` write of up to a full 4 MiB chunk; writing a chunk whose bytes are
   **already** present degenerates to a metadata-only `ON CONFLICT` no-op. The latency difference
   lets one wallet **confirm whether a given chunk already exists** in the shared pool — i.e.
   whether some **other** wallet has already stored those exact bytes.
2. **A `prune` reclaim oracle.** `prune` returns `reclaimedBytes`/`reclaimedChunks`
   (`src/postgres/checkpoint-store.ts:527,531`). Whether a chunk this wallet just unreferenced is
   actually reclaimed depends on whether **another** wallet's manifest still references it. The
   return value therefore leaks **cross-wallet reference state** — whether a different wallet is
   still holding the same chunk.

**Consequence — a binding deployment condition.** Placing **mutually-distrusting principals** on one
UmbraDB store is an **UNSUPPORTED** deployment. "Multiple wallets" in UmbraDB means one user's wallet
application managing several of that user's own wallets — **one trust domain** — **not**
multi-tenancy across users who must not learn about each other's data. If you need the latter, give
each principal its **own** database/store (see also T-A1 and the multi-tenancy redirect above).

**Bound on the leak — a known-content confirmation oracle at the configured chunk granularity.**
Chunking is **fixed-size**, not content-defined: `save` splits the payload into fixed `chunkSize`
slices (`splitChunks`, `src/postgres/checkpoint-store.ts:103-107`). `chunkSize` is
**caller-configurable** — any positive value (up to 16 MiB) via `SaveCheckpointOptionsSchema`
(`src/interfaces/checkpoint-store.ts:43`), defaulting to `DEFAULT_CHUNK_SIZE = 4 MiB`
(`src/postgres/checkpoint-store.ts:33`) — and a payload's final slice may be **shorter** than
`chunkSize`. The oracle therefore **confirms the existence of a chunk whose exact bytes the attacker
already possesses**, at the **granularity of the deployment's configured chunk size**: at the 4 MiB
default it confirms a whole 4 MiB-aligned block, but a **smaller** configured `chunkSize` yields
**finer-grained** confirmation — down to sub-field granularity if a deployment configures small
chunks. It is a **known-content confirmation** oracle, **not** an arbitrary-extraction primitive:
the attacker learns only whether bytes they **already hold** are present, never the contents of an
unknown secret revealed to them wholesale. (As with any confirmation oracle, an attacker who can
already enumerate a *small* candidate space could confirm-by-guessing within it; that too is bounded
by the trust model, not by the chunk size.) **What removes the risk is the single-trust-domain
requirement above — not the chunk size:** every principal on one store is mutually trusting, so no
adversary is positioned to run the oracle at any granularity.

## Data at rest — NO encryption is provided (a binding deployer precondition)

**UmbraDB provides NO at-rest encryption and NO encryption hook of its own.** Payloads are persisted
as **plaintext** `bytea`. In particular the wallet-state envelope path encodes state with
`new TextEncoder().encode(JSON.stringify(...))`
(`src/interfaces/wallet-state-envelope.ts:144`) and stores the result directly as plaintext chunks.
For a Midnight **shielded** wallet those bytes include **spending-key / coin-secret material**;
anyone who can read the Postgres data files, a backup, or a replica can read that material in the
clear.

**Therefore a deployer persisting secret-bearing payloads MUST do one of the following** (this is a
requirement, not a suggestion):

- **Encrypt the storage substrate** — encrypt the disk/volume backing Postgres, use Postgres
  transparent data encryption (TDE), and encrypt every backup and replica. This applies to **all**
  users. It is the only mitigation available *without writing code* to callers of the **envelope
  store** (`PgWalletStateEnvelopeStore`), because that path is **NOT** byte-opaque: its
  `save(envelope)` **always** plaintext-`encode()`s the state to `bytea`
  (`src/postgres/wallet-state-envelope.ts:38` → `src/interfaces/wallet-state-envelope.ts:144`), so
  a deployer cannot simply hand it ciphertext.

  *Precision (audit correction): there is **no built-in encryption hook** on that path, which is not
  the same as there being no alternative. `PgWalletStateEnvelopeStore` composes over an **injected**
  `CheckpointStore`, so a caller MAY supply a decorator that encrypts in `save` and decrypts in
  `load` before delegating to `PgCheckpointStore`. That is caller-written code UmbraDB neither ships
  nor validates — and it forfeits cross-wallet dedup, since ciphertext does not collide — but it is
  a real option and this document previously said it did not exist.* **OR**
- **Pass ciphertext to the raw byte-level `CheckpointStore.save` — NOT the envelope store.** Only the
  raw `CheckpointStore.save(id, data)` is byte-opaque: it accepts a `Uint8Array` and stores exactly
  those bytes, returning them verbatim; it neither inspects nor transforms them. A deployer using
  **that** API MAY encrypt the payload **before** handing it to UmbraDB, so only ciphertext ever
  reaches the database. (The envelope store offers no such control today; the `EnvelopeCipher`
  at-rest-encryption seam — a documented 1.1 fast-follow, see *Scope* below — is what will let
  envelope-store users inject encryption.)

If neither mitigation is in place, secret-bearing wallet state is stored in the clear. This is
CWE-312 (cleartext storage of sensitive information) and is an **accepted, documented** property of
the 1.0.0 library — the obligation to close it sits with the deployer.

## Shielded monitors (`shielded_monitor` schema) — alpha trust model

The `shielded_monitor` schema, added by the 00009-02 change
(`openspec/changes/00009-02-monitor-store/`), registers Midnight **shielded viewing keys** so a
scanner can find the finalized transactions relevant to them. Its trust model is deliberately
narrower than the rest of this document's, and the narrowness is an owner decision of 2026-09-10
(User Story 4 of the feature specification deferred), not an implementation gap.

**What is stored, and who can read it.**

- **No viewing key is stored at all** (00009-09, owner decision Q28). A key lives in the RAM of
  exactly one `umbradb-shielded-monitor-node` and nowhere else: not on disk, not in the database,
  not in a log. `shielded_monitor.monitors.key_serialized` — the column that used to hold the
  plaintext key — **no longer exists**: migration 004 drops it (open point OP-4), so naming it is
  a syntax error rather than a query returning NULLs, which is the difference between a promise
  and a property. `test/shielded-monitor/migrations.integration.test.ts` asserts the column's
  absence and that a write naming it fails.
  **This is the single largest change to this trust model since the schema was added**: a backup,
  replica or dump of `shielded_monitor` no longer contains key material, and reading the schema no
  longer lets anyone decrypt a wallet's history. What it still exposes is the LINKAGE below.
- `shielded_monitor.associations` holds the wallet↔transaction association tuples in plaintext
  columns: network, block height and hash, position, transaction hash, protocol version and the
  matched segment ids. Anyone with read access learns **which transactions are relevant to which
  registered key** — the exact linkage the shielded protocol otherwise hides.
- `shielded_monitor.monitors.fingerprint` is an **unkeyed** SHA-256 over a domain string, the
  network id and the serialized key, and since 00009-09 it is the monitor's ONLY identity.
  Someone holding a candidate key can confirm whether it is registered by recomputing it. That was
  the lesser exposure while the key sat in plaintext beside it; now that the key is gone it is the
  principal one, and keyed fingerprints move up the deferred list below accordingly.
- `shielded_monitor.monitor_gaps` (00009-09) holds ranges of block heights that were never scanned
  for a monitor. Heights and a monitor id: the same class of linkage `associations` carries, and
  nothing derived from a key.

**What the alpha does enforce.**

- Viewing keys are accepted only in a request body / from a file, never from a command line
  (`storage-api/harness-cli.ts` reads `--key-file`, never `argv`), so a key does not land in
  shell history or a `ps` listing.
- The in-memory key type redacts itself under every stringification path — `toString`,
  `JSON.stringify`, template interpolation and `util.inspect` — and exposes its bytes only through
  one explicitly-named accessor. A test with a positive control asserts no path leaks the payload
  (`test/shielded-monitor/viewing-key.test.ts`).
- Every key-intake failure returns one generic, identically-worded error, so a caller cannot use
  the error to distinguish a bad checksum from a wrong network from a bad payload.
- Project B writes **only** its own schema and never an archive table; this is proved at runtime by
  running the whole flow under a PostgreSQL role holding only `USAGE`/`SELECT` on `chain_archive`
  (`test/shielded-monitor/schema-isolation.integration.test.ts`).

**The monitor-node (`umbradb-shielded-monitor-node`, 00009-09) is where every viewing key lives.**

It replaces the 00009-03 scanner and the 00009-04 private API, which were two processes sharing a
key through a database column. One process now serves the public API and the dashboard, runs both
scan queues, and is the sole custodian of the keys it was sent.

- **Key lifetime is the key's registration, and its end is a `clear()`.** A submitted key is
  decoded, validated by the ledger, fingerprinted, handed to `EncryptionSecretKey.deserialize`,
  and the serialized byte buffer is **zero-filled immediately** — both the copy the ledger saw and
  the `ShieldedViewingKey` object's own, which the request handler's closure would otherwise keep
  alive for whatever a heap dump or a core file might capture. From that point the only
  representation is a WASM handle, and every path a key leaves by — delete, a fenced `not-found`,
  SIGTERM/SIGINT — goes through the one method that calls `clear()`. Asserted
  directly (`test/shielded-monitor/monitor-node.test.ts`), because "cleared in a `finally`" is the
  kind of claim that rots silently.
- **A key is GIVEN or it is DELETED** (owner decision Q33): those are the only two things a
  consumer can do to a monitor. A key whose monitor merely STOPPED — an undecodable transaction,
  an archive rebuilt underneath it — is kept and skipped: the monitor's matches stay readable, and
  a stopped scan is not a reason to destroy a key its owner has not asked to delete. A DELETED
  monitor's key is destroyed at once, by the delete the balancer forwards to its holder, and by
  the `not-found` fence on that node's next block if the forward is lost.
- **A restart destroys every key it held, by design.** The monitors then report `key needed` and
  the client re-sends. That is the recovery path, not a failure of one: it is also the property
  that makes "the keys are only in RAM" verifiable rather than asserted.
- **No monitor id reaches a log line or a metric label.** Metric labels are a closed union the
  type system will not let a monitor id into, and the scheduler prints the failure class plus the
  stable error code rather than the error's own message, which carried the id. A log naming which
  monitor matched and when is a per-wallet signal to anyone who can read the log — the same
  linkage `associations` exposes, arriving by a different route.
- It reaches the archive **only** through `ArchiveReadContract`, an object whose whole surface is
  two read methods, and its write set is audited at runtime against `shielded_monitor.*`
  (`test/integration/crash/shielded-monitor-batch-atomicity.crash.test.ts`).

**The public API — now served by the monitor-node — is unauthenticated by design.**

Added by the 00009-04 change (`openspec/changes/00009-04-private-api-cli/`) and folded into the
monitor-node by 00009-09, it serves the monitors above over HTTP/JSON with **no authentication, no
authorization, no tenant scoping, no rate limiting and no quotas** (owner decision, 2026-09-10).
Its only admission controls are a request-body size cap and a page-size cap.

A monitor-node additionally serves `/internal/*` — `status`, `holds`, `events` — for the balancer.
Those routes return counts, heights, this node's name and booleans; none of them returns a key, a
fingerprint or anything derived from one, because the balancer addresses keys by a fingerprint it
computed itself. **A node must be reachable only from the balancer**, which is what the compose
topology arranges and what the balancer's blanket 404 on `/internal/*` backs up from the other
side.

- **Anyone who can open a TCP connection to its port can register a viewing key, read every
  monitor's matches, and delete any monitor — destroying its matches and the key held for it.** It binds `127.0.0.1` by default, and a
  deployment that binds anything else **must** restrict network access by other means. It speaks
  plain HTTP; terminating TLS is the deployment's job.
- The cursor is opaque but **unsigned** — a caller can forge one. With no authentication this
  grants nothing extra: a forged cursor can only reposition a caller inside a monitor it can
  already read in full. Signing is on the deferred list below.
- What the API does enforce: a viewing key is accepted **only** in the body of
  `POST /v1/monitors` and is never returned; request logging never sees a body, logs the matched
  route pattern rather than the raw URL, and logs no error message at all on the create route; an
  unmapped internal error never forwards its message to the client (a driver message can quote a
  bound parameter, and on that route a bound parameter is a key). A test with a positive control
  scans every captured log record and error body for the key in three encodings
  (`test/shielded-monitor/api.integration.test.ts`).
- **It reads the archive, read-only, to report `sourceTip`** (00009-05). On a deployment where
  the archive shares the database, the API process constructs a `PgArchiveReadContract` — two
  `SELECT`s, no schema name of its own, no write method in reach — so a consumer can tell
  "scanned and empty" from "not scanned yet" (FR-020). The database role the API runs as
  therefore needs `USAGE`/`SELECT` on the archive schema and nothing more; `SOURCE_TIP=off`
  removes the need entirely, at the cost of reporting `sourceTip: null` forever.
- **The same process serves a dashboard at `/ui`** (00009-06). It changes the trust story in
  exactly one way — it makes the unauthenticated surface reachable from a browser tab rather than
  only from `curl` — and in no other: it adds no route that writes anything the API did not
  already expose, no session, no cookie, and no credential of any kind. The page states its own
  lack of authentication above the fold, so a reader cannot mistake "it has a UI" for "it has a
  login".
  - It is **one HTML string compiled into the binary**, with no framework, no bundler and no
    external resource; `package.json`'s `dependencies` is unchanged by it. That is a supply-chain
    property, not a style preference, and it is asserted by a required test that scans the served
    document for any absolute URL or subresource-loading attribute, with a positive control
    (`shielded-monitor.ui.self-contained-no-external-resources`).
  - It is served under `Content-Security-Policy: default-src 'self'` naming the SHA-256 hashes of
    its own inline script and style — not `'unsafe-inline'` — plus `form-action 'none'`,
    `frame-ancestors 'none'`, `base-uri 'none'`, `img-src 'none'` and `object-src 'none'`, with
    `x-content-type-options: nosniff` and `referrer-policy: no-referrer`.
  - A viewing key typed into its registration field is sent only in the `POST /v1/monitors` body.
    It is never placed in a URL, never written to `localStorage`/`sessionStorage`/a cookie, never
    rendered back into the document, and the field is cleared before the request is issued. The
    required key-not-logged test exercises the page's own request shape and scans the served HTML
    alongside the logs and error bodies.
  - The page builds its DOM with `textContent` only and contains no markup-assigning sink at all,
    so no value a response carries can become HTML. A test asserts the absence by literal search.
- **`umbradb-shielded-monitor-derive-key`** (00009-06) reads a seed **from a file only** — never
  from `argv`, because an argument lands in the shell history and in every `ps` listing on a
  shared host. It prints the viewing key (secret, and printing it is the command's purpose), the
  coin public key and the encryption public key (public). It never prints the seed, the derived
  role seed or the coin secret key, and it zeroes both the seed buffer and the derived role seed
  before returning. A test asserts the absence of both in stdout and stderr, with a positive
  control.

**The storage boundary (`umbradb-storage-api`, 00009-08 v2) is the new security-relevant hop.**

Owner decision Q25 removed project B's database connection entirely: the monitor-nodes and the
balancer hold one base URL (`STORAGE_URL`) and no credential at all, and one A-side process — `umbradb-storage-api` — owns the single main database
and executes each of B's operations as exactly one transaction. Two consequences, and they pull in
opposite directions:

- **Better**: there is now exactly ONE process in the deployment holding a database credential,
  and a leftover credential in a B process's environment is a hard startup refusal rather than an
  unnoticed privilege (`shielded-monitor/no-database.ts`; the import guard
  `test/shielded-monitor/import-boundary.test.ts` additionally proves no B module can reach
  `postgres` or `src/postgres/**` by any chain of imports, static or dynamic). This is the seam a
  TEE profile attests and encrypts across, and it exists before the encryption does deliberately
  (owner Q25: "first divide the process, then figure out the correct structure and add the
  encryption").
- **Better again, since 00009-09**: no key crosses this hop at all. Registration sends a 32-byte
  fingerprint, and `GET …/key-material` is **410 Gone** along with the three lease routes. The
  worst a plaintext capture of this hop yields is the linkage — which monitor matched which
  transaction — not the ability to decrypt a wallet.
- **Still worse than it should be**: the alpha has no transport security anywhere and the storage
  API is **unauthenticated by design** (owner Q3), binding loopback by default. Anyone who can open
  a TCP connection to it can read every archived block and read or delete every monitor.
  Run it on loopback or on a private network, and treat reaching it as equivalent to reading the
  database.

The access log records the route PATTERN, the status and a request id — never a body, never a raw
URL, and never a monitor id — so key material cannot reach a log through it
(`test/storage-api/storage-api.test.ts`).

**The balancer (`umbradb-shielded-monitor-balancer`)** terminates nothing and authenticates
nothing; it is a request router in front of the monitor-nodes. It never retries a POST (a replayed
registration would be a request the consumer never made), refuses to forward `/internal/*` at all,
and adds `X-Upstream` to every response, which names an internal node — do not expose it to an
untrusted network any more than the nodes it fronts.

**It handles a viewing key, briefly** (00009-09, open point **OP-1**, accepted by the owner). To
route `POST /v1/monitors` to the node that already holds that key, it decodes the submitted string
and computes the key's fingerprint: a Bech32m decode and a SHA-256, no ledger. So a key exists in
the balancer's memory for the length of one function call. It is not retained, not logged (the
required test `shielded-monitor.key-never-logged-through-the-balancer-and-the-node` captures the
balancer's and the node's logs and searches them, with a positive control), and not forwarded
anywhere but to the chosen node. **The balancer is therefore inside the trust boundary**, alongside
the nodes and not alongside the client. The TEE step resolves this one of two ways — move it into
the enclave, or have the client send a precomputed fingerprint header so the balancer never sees a
key — and the routing already works from the fingerprint alone either way.

**Deferred hardening — required before any multi-tenant or hosted deployment.**

| Deferred control | Consequence of its absence today |
|---|---|
| ~~At-rest encryption of `key_serialized`~~ — **resolved differently by 00009-09**: the key is not stored at all | — (the exposure is gone; migration 004 drops the column outright) |
| A way for a node to reacquire a key without the client | A node restart makes every monitor it held report `key needed` until its client re-sends; there is no sealed-key store and no operator-side recovery |
| Keyed (HMAC) fingerprints | A guessed key can be confirmed by recomputing its fingerprint |
| Encrypted association content | The wallet↔transaction linkage is readable by anyone with database access |
| Tenant isolation and non-oracular cross-tenant behaviour | There is no tenant concept; one consumer credential, one trust domain |
| Authentication on the private API, and signed cursors | Anyone who can reach the port is fully authorized — through `curl` or through the `/ui` dashboard, which is the same surface; a cursor can be forged |
| Least-privilege database roles as a shipped script | The privilege split exists only as a test instrument, not as a deployment artefact |
| The full redaction/leakage gate over logs, metrics and database dumps | Only the key-not-logged property is asserted today |
| Transport security and authentication on `STORAGE_URL` (mTLS + attestation) | Anything that can reach the storage API can read every archived block and read or delete every monitor (no key crosses this hop since 00009-09) |
| Transport security on the client → balancer hop | A registration carries the viewing key in the clear to the balancer, which is the one moment a key crosses into project B (open point OP-1) |
| Encryption of B's records at the storage boundary (opaque payloads the host never parses) | The host stores B's fields as plaintext columns, so the storage API's own operator sees everything B does |

**Deployment requirement.** Until the table above is closed, run this schema only in a
single-tenant, operator-trusted deployment on an encrypted substrate, with the private API bound
to localhost and network access restricted, and with every backup encrypted and access-controlled
as key material.

## Commit policy — what may and may not go into git

- **No key, seed, password, or credential with ANY value may EVER be committed to this repository** —
  not mainnet, not "just testnet with real funds," not "temporarily." Secret-bearing files are
  **generated locally, never committed**, and are created with `chmod 600` (owner read/write only).
- **One suppressed historical finding, with justification.** A single Midnight **Preview testnet** wallet
  artifact was historically committed at `nix/midnight-env/test-wallets/preview-test-wallet.json`.
  Preview `tDUST` has **no monetary value** and exists only to let the dev environment transact on a
  throwaway testnet without re-funding on every fresh machine. That specific historical **finding**
  is suppressed by **exact fingerprint** in `.gitleaksignore` — deliberately not by a path allowlist
  in `.gitleaks.toml`, because a path allowlist exempts that path *forever* and would hide a real
  key committed there later. As of 1.0.0 that file is **no longer tracked**
  (untracked + `.gitignore`d); it is replaced by `preview-test-wallet.example.json` (non-secret
  placeholders) and a `generate-test-wallet.sh` generator (see
  `nix/midnight-env/test-wallets/README.md`). Its bytes remain in git **history** (no history
  rewrite was performed, because the key is verified valueless); the go-forward guard is the
  **full-history `gitleaks` gate** in CI (`.github/workflows/supply-chain.yml`), which suppresses
  exactly that one historical path and the `.example` placeholder — and fails on a real secret
  anywhere else.
- **CI enforces this.** Every pull request and every push to `main` is scanned by `gitleaks` over
  full git history; any new secret fails the build — including on the two historical paths,
  because the suppression is by exact finding fingerprint, not by path.

## Reporting a vulnerability

If you discover a security vulnerability in UmbraDB, please report it **privately** rather than
opening a public issue:

- Use GitHub's **private vulnerability reporting** ("Report a vulnerability" under the repository's
  **Security** tab), or
- Email the maintainers at the contact address listed in the repository's project metadata.

Please include the affected version/commit, a description of the issue and its impact, and
reproduction steps where possible. We will acknowledge the report, investigate, and coordinate a fix
and disclosure timeline with you. Because UmbraDB's trust model assumes a single trusted writer and
a trusted database (T-A1/T-A2), please frame findings against that model — a report that assumes an
adversarial caller or a hostile co-tenant is describing a deployment this library explicitly does
not support (see above), not a library vulnerability.

## Scope — documented preconditions vs. implemented controls (1.0.0)

This document **documents** several security preconditions that the 1.0.0 library does **NOT
implement**. They are the P1 fast-follows tracked for a later release. A reader must **not** mistake
a documented precondition here for an implemented control:

- **Keyed / scoped chunk addressing → 1.1.** The cross-wallet dedup side channel above would be
  closed by keying chunk addresses per trust domain (so chunks never dedup across principals). This
  is a **1.1 code fast-follow**; 1.0.0 addresses it by **documentation only** (this file + the
  `CheckpointStore` interface caveats). **Not implemented in 1.0.0.**
- **`EnvelopeCipher` (at-rest encryption seam).** An injectable encryption seam on the envelope path
  that would let the library encrypt secret-bearing payloads itself. 1.0.0 provides **no** such seam;
  the binding "encrypt the substrate or pass ciphertext" precondition above stands in its place.
  **Not implemented in 1.0.0.**
- **VerifyFull-by-default TLS for the dev stack.** The `nix/midnight-env` db-sync TLS tooling
  defaults to `Require` (encryption, no server-identity validation) and offers an **opt-in** `--ca`
  VerifyFull path; a VerifyFull **default** is **not** shipped (see `nix/midnight-env/README.md` for
  the caveat and the reasoning). **Default not flipped in 1.0.0.**
- **Two-role Postgres topology.** A split between a privileged migration/DDL role and a
  least-privilege runtime role is **not** provided; 1.0.0 assumes one owning role (T-A2). **Not
  implemented in 1.0.0.**

Each of these is a deliberate 1.0.0 scope decision, documented so the boundary is legible.
