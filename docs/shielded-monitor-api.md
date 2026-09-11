# The shielded-monitor private API

> Change: `openspec/changes/00009-04-private-api-cli/`. Storage and lifecycle semantics:
> `openspec/changes/00009-02-monitor-store/`. Backup and restore:
> [`shielded-monitor-restore.md`](shielded-monitor-restore.md).

`umbradb-shielded-monitor-api` is the private HTTP/JSON surface over the `shielded_monitor`
schema. One consumer application registers a Midnight shielded viewing key, watches the scan
coverage advance, and pages the matching transactions with an opaque cursor.

---

## Read this before you deploy it

**This API has no authentication.** No tokens, no passwords, no mutual TLS, no tenant scoping, no
rate limiting, no quotas. That is a deliberate alpha decision (owner, 2026-09-10), recorded in the
change proposal's non-goals, and it has a hard consequence:

> **Anyone who can open a TCP connection to this port can register a viewing key, read every
> monitor's matches, and revoke or delete any monitor. The deployment — not this service — is
> responsible for making sure nobody can.**

Bind loopback (the default) and reach it from the same host, or put it behind something that
authenticates. Do not expose the port.

Two further facts about the alpha's trust model, both inherited from the store:

- Registered viewing keys are stored **in plaintext** in `shielded_monitor.monitors`, and the
  wallet↔transaction associations are stored in plaintext in `shielded_monitor.associations`.
  Anyone with database access can read both. At-rest encryption is deferred.
- The cursor is opaque but **unsigned**. A caller can forge one. Because there is no
  authentication, this grants nothing a caller does not already have: a forged cursor can only
  reposition a caller within a monitor it can already read in full.

What the service **does** guarantee about key handling:

- A viewing key is accepted only in the body of `POST /v1/monitors`. No other endpoint takes one,
  in any position; no endpoint ever returns one.
- No log record and no error body contains a viewing key in any encoding. Request logging never
  sees a body, logs the matched *route pattern* rather than the raw URL, and logs no error message
  at all on the create route. A test asserts this with a positive control.
- Every key-intake failure — malformed Bech32m, wrong network, non-canonical payload, ledger
  rejection — answers with one identical generic error, so a caller cannot learn which check
  failed.

---

## Running it

```
SHIELDED_MONITOR_PG=postgres://user:pass@localhost:5432/umbradb \
SHIELDED_MONITOR_NET=undeployed \
umbradb-shielded-monitor-api
```

| Variable | Default | Meaning |
|---|---|---|
| `SHIELDED_MONITOR_PG` | the `PG*` environment | PostgreSQL connection string |
| `SHIELDED_MONITOR_SCHEMA` | `shielded_monitor` | the schema project B owns |
| `SHIELDED_MONITOR_NET` | `undeployed` | the one network this deployment serves; a key's Bech32m HRP must match it |
| `SHIELDED_MONITOR_BOOTSTRAP` | unset | `1` applies the migration lineage at boot (opt-in on purpose) |
| `ARCHIVE_SCHEMA` | `chain_archive` | the archive schema whose tip is reported as `sourceTip`; read-only, through the archive read contract |
| `SOURCE_TIP` | unset | `off` disables the tip reader, so `sourceTip` is always `null` — for an API deployed with no archive access |
| `API_HOST` | `127.0.0.1` | bind address |
| `API_PORT` | `8787` | bind port; `0` asks the kernel for a free one |
| `API_MAX_BODY_BYTES` | `65536` | request body cap; exceeding it is `400 BODY_TOO_LARGE` |
| `API_MAX_PAGE` | `200` | matches page cap; may not exceed the store's own cap of 1000, and a value above it fails at boot |
| `API_DEFAULT_PAGE` | `50` | page size when the caller does not ask for one |

The service is a **separate process** from the archive ingester (`umbradb-archive-sync`) and from
the scanner. It shares only the database.

Without a scanner running, the API is correct but idle: coverage never advances and no match ever
appears, because nothing is scanning. That is the honest state of a scanner-less deployment, and
the coverage object says so rather than reporting an empty result (see below).

---

## Endpoints

All requests and responses are JSON. `POST` with a body requires
`content-type: application/json`. Every response carries an `x-request-id` header, echoed in
error bodies.

### `POST /v1/monitors` — register a viewing key

```json
{ "viewingKey": "mn_shield-esk_undeployed1…", "startHeight": "earliest" }
```

`startHeight` accepts `"earliest"`, a JSON number, or a decimal string (use the string form above
2^53). It defaults to `"earliest"`.

- `201` — a monitor was created. Body: the monitor view.
- `200` — this key was already registered on this network; the body is the **existing** monitor
  (registration is idempotent per network and key).
- `400 INVALID_VIEWING_KEY` — one generic error for every intake failure.
- `400 VALIDATION_FAILED` — the body did not match the schema.
- `410 MONITOR_REVOKED` — this key's monitor was revoked. Re-enabling it requires an explicit
  `DELETE` first, so a blind client retry cannot undo a revocation.
- `415` — the content type was not `application/json`.

### `GET /v1/monitors` — list monitors

```json
{
  "items": [ { "monitorId": "…", "state": "live", "coverage": { … }, … } ],
  "sourceTip": "1204",
  "net": "undeployed"
}
```

Every monitor this deployment holds, **in creation order**, each item in exactly the shape
`GET /v1/monitors/:id` returns — the same builder, so the two cannot drift. `?limit=` is bounded by
`API_MAX_PAGE` and defaults to `API_DEFAULT_PAGE`; `400 VALIDATION_FAILED` outside that range.
`sourceTip` and `net` are repeated at the top level because they belong to the *deployment*, not to
any monitor, and an empty `items` would otherwise hide them.

**One asymmetry, chosen deliberately.** A **revoked** monitor IS listed, with `state: "revoked"`,
even though `GET /v1/monitors/:id` answers `410` for it. The `410` protects that monitor's *data*;
the list answers "what exists?". Hiding revoked monitors would mean revoking one makes it vanish
from the only view an operator has — leaving them unable to name the id that `DELETE` needs. The
list item carries nothing the `410` withholds: the id, the state, the coverage and the timestamps,
no key and no fingerprint.

A **deleted** monitor is never listed. That half is not negotiable: a deleted monitor must be
indistinguishable from one that never existed, and a tombstone in the list would break that
literally.

### `GET /ui` — the dashboard

A single self-contained HTML page, served by this same process. `GET /ui/` serves the same page;
`GET /` answers `302` to `/ui`. It loads **nothing** from any other origin — no framework, no CDN,
no font, no icon — and is served with `Content-Security-Policy: default-src 'self'` plus SHA-256
hashes of its own inline script and style, `form-action 'none'`, `frame-ancestors 'none'`,
`x-content-type-options: nosniff` and `referrer-policy: no-referrer`.

It shows health and the archive tip, a monitor table with state badges and a coverage bar, a
registration form, and the selected monitor's matches newest-first with cursor paging; it refreshes
every 3 seconds and the refresh can be paused. Coverage that is unknown renders as *not scanned* or
*unknown* — never as `0`.

A viewing key typed into the registration form is sent only in the `POST /v1/monitors` body. It is
never placed in a URL, never stored in the browser, never rendered back into the page, and never
written to a server log — registering through the page produces the same log record as registering
with `curl`, which the required test `shielded-monitor.api.key-never-logged` asserts over the page's
own request shape.

**The dashboard grants a browser exactly what `curl` already had.** It is the same unauthenticated
surface; see the deployment warning at the top of this document.

Walk-through: [`shielded-monitor-demo.md`](shielded-monitor-demo.md).

### `GET /v1/monitors/:id` — status

`200` with the monitor view; `404` if the id names nothing **or names a deleted monitor**;
`410` if the monitor is revoked.

### `GET /v1/monitors/:id/matches?cursor=…&limit=…` — page matches

```json
{
  "items": [ … ],
  "nextCursor": "…",
  "coverage": { "requestedStart": "0", "scannedFrom": "0", "scannedThrough": "1204", "sourceTip": null }
}
```

`400` for a malformed cursor, a cursor minted for a different monitor, or a `limit` outside
`1..API_MAX_PAGE`. `404`/`410` as above.

### `POST /v1/monitors/:id/pause` · `/resume` · `/revoke`

`200` with the monitor view. `resume` on a monitor that is not paused is `409
ILLEGAL_TRANSITION`. `revoke` is idempotent (`200` again on a revoked monitor). `pause` and
`resume` on a revoked monitor are `410`.

### `DELETE /v1/monitors/:id`

`204` when the monitor was deleted — the key and every association row are destroyed in one
transaction. `404` when the id names nothing, **including an id that was already deleted**: after
a delete, every endpoint for that id answers `404`, because the contract is that a deleted
monitor is indistinguishable from one that never existed.

### `GET /v1/health`

`200 {"status":"ok","net":"…"}`. Touches no table, so it stays green on an empty deployment with
zero monitors.

### Deriving a key to register

`umbradb-shielded-monitor-derive-key --seed-file <path> [--hd] [--net <id>] [--quiet]` turns a
32-byte hex seed **held in a file** into the Bech32m `mn_shield-esk_<net>` string this API accepts,
and prints the coin public key and encryption public key — the two public halves of the shielded
address to fund. `--hd` applies the wallet's own derivation, BIP-0032 `m/44'/2400'/<account>'/3/<index>`
over secp256k1, which is what `@midnightntwrk/wallet-sdk-hd` does. The seed is never read from the
command line and never printed.

---

## The monitor view

```json
{
  "monitorId": "9f0f…",
  "net": "undeployed",
  "state": "backfilling",
  "coverage": { "requestedStart": "0", "scannedFrom": null, "scannedThrough": null, "sourceTip": null },
  "matchingRuleVersion": "shielded-monitor/v1",
  "ledgerBuild": "ledger-v8@8.1.0-syshash.4",
  "createdAt": "2026-09-10T12:00:00.000Z",
  "updatedAt": "2026-09-10T12:00:00.000Z"
}
```

States: `backfilling` → `live`; `{backfilling, live}` ↔ `paused`; any → `revoked` → `deleted`;
plus terminal `failed` and `stale_source`. A `failed` or `stale_source` monitor additionally
carries `lastError: { code, atHeight? }` — the failure **class** only, never a driver message and
never caller input.

The view carries **no viewing key and no fingerprint**, by construction.

## The coverage object

Every status and every matches response carries all four fields:

| Field | Meaning |
|---|---|
| `requestedStart` | the height the consumer asked to start from |
| `scannedFrom` | the first height actually covered; `null` until the first advance |
| `scannedThrough` | the last height actually covered; `null` until the first advance |
| `sourceTip` | the archive's current tip; `null` when this deployment cannot observe it |

**Heights are decimal strings, never JSON numbers.** A block height above 2^53 would round
silently through a JSON number; a string cannot.

**`null` never means zero.** `scannedFrom: null` means *nothing has been scanned yet*, which is
different in kind from an empty `items` array — that distinction is the whole point of the
coverage object. A consumer that sees `items: []` with `scannedThrough: null` has learned "nobody
has looked", not "there is nothing there".

`sourceTip` is the archive's real current tip wherever the API can reach the archive — which is
the normal deployment, since both schemas live in one database. The tip is read through the
archive read contract only (two `SELECT`s, no write method in reach), so project B still never
writes to an archive table. On a deployment where the API has no archive access, set
`SOURCE_TIP=off` and the field is always `null`; it is also `null` while the archive holds no
block at all. It is reported as `null` rather than `0` precisely because `scannedThrough >=
sourceTip` would otherwise read as *caught up*.

## The match item

```json
{
  "cursor": "OWYwZj…",
  "blockHeight": "1204",
  "blockHash": "ab12…",
  "position": 3,
  "txHash": "cd34…",
  "protocolVersion": "1",
  "matchedSegments": [0, 2],
  "appliedOutcome": "unknown",
  "sourceOutcome": "success",
  "matchingRuleVersion": "shielded-monitor/v1",
  "ledgerBuild": "ledger-v8@8.1.0-syshash.4"
}
```

`appliedOutcome` is **always** `"unknown"`. The service detects that a transaction is *relevant to
your key*; it does not compute whether the transaction applied, and it never claims funds were
received. `sourceOutcome`, when present, is the **archive's** own replay verdict for that
transaction — advisory provenance, not a statement about your wallet, and it never replaces
`appliedOutcome`.

`matchedSegments` names every segment whose offer matched, including fallible segments. A match
in a fallible segment is still just a match: the segment may have failed.

## Match details (`blockTimestampMs`, `details`)

Each item also carries the transaction's **public zswap data** and the time of the block it sat
in. Both are `null` when the match was recorded before the service stored them — run the backfill
(`umbradb-shielded-monitor --backfill-details`, see `docs/shielded-monitor-scanner.md`). `null`
here means *not recorded yet*; it never means "this transaction had no outputs".

```json
{
  "blockTimestampMs": "1754395200000",
  "details": {
    "version": "shielded-monitor/match-details/v1",
    "ledgerBuild": "ledger-v8@8.1.0-syshash.4",
    "segments": [
      {
        "segment": 0,
        "matched": true,
        "outputs": [
          { "index": 0, "commitment": "854e92…", "mine": null },
          { "index": 1, "commitment": "92e368…", "mine": null },
          { "index": 2, "commitment": "f42b14…", "contractAddress": "cc8321…", "mine": false }
        ],
        "inputs": [{ "index": 0, "nullifier": "695481…" }],
        "transients": [
          { "index": 0, "commitment": "f42b14…", "nullifier": "695481…", "contractAddress": "cc8321…", "mine": false }
        ],
        "counts": { "outputs": 3, "inputs": 1, "transients": 1 },
        "mineAmong": 2
      }
    ],
    "totals": { "outputs": 3, "inputs": 1, "transients": 1, "mine": 0, "unattributed": 2 }
  }
}
```

| Field | Meaning |
|---|---|
| `blockTimestampMs` | the block's own `Timestamp::set` value, milliseconds, as a decimal string (never a JSON number, for the reason heights are strings) |
| `segments[].segment` | `0` is the guaranteed section — the ledger's own numbering; every other id is a fallible segment |
| `segments[].matched` | the very `EncryptionSecretKey.test(offer)` result that decided the match |
| `outputs[].commitment` | a **new shielded coin** created by this transaction |
| `inputs[].nullifier` | a coin this transaction **spent** |
| `transients[]` | a coin created *and* spent in the same transaction, so it has both |
| `contractAddress` | present when the entry is delivered to a contract rather than encrypted to a user key |
| `counts` | the TRUE list sizes, before truncation |
| `segments[].truncated` / `truncated` | present when a list was capped at 256 entries; `counts` still reports the real size |
| `totals.mine` / `totals.unattributed` | how many entries are provably yours, and how many could not be attributed |

### `mine` is three-valued, and every value is entailed by the ledger

| value | meaning |
|---|---|
| `true` | this entry **is** yours |
| `false` | this entry is **not** yours |
| `null` | **not attributable** with a viewing key alone |

The ledger's relevance predicate, `EncryptionSecretKey.test(offer)`, answers "does *anything* in
this offer decrypt under this key" — it is an `any()` over every output and transient ciphertext,
and the vendored ledger v8 build exposes no per-entry variant. Isolating one output into its own
offer (`ZswapOffer.fromOutput`) is refused for a value read out of an archived, proven
transaction, and the only per-coin API needs the full `ZswapSecretKeys` a viewing-key monitor does
not hold. So the service reports what it can prove:

- a segment whose `matched` is `false` gives **`mine: false` for every entry in it** — `test`
  returning false means *no* ciphertext decrypted;
- an entry with a `contractAddress` is **`mine: false`** — it carries no user ciphertext at all;
- in a matched segment, if exactly one candidate remains it is **`mine: true`** — something
  decrypted and there is nothing else it could have been;
- otherwise every candidate is **`null`**, and the segment carries `mineAmong: <n>`, i.e. *at
  least one of these n is yours*.

Both of those last two deductions are about the **whole** segment, so both go silent when a list
was truncated at the 256-entry cap: the entry that decrypted may sit past the cap, so nothing is
pinned and no `mineAmong` is published. The two negatives are unaffected — `test` returning false
is a fact about every ciphertext in the offer, seen or not, and a contract-owned entry carries
none either way.

Amounts, balances and spend detection are **out of scope** (they need the full key pair);
`appliedOutcome` stays `"unknown"` regardless of what `details` shows.

### `?details=0`

`GET /v1/monitors/:id/matches?details=0` omits **both** `blockTimestampMs` and `details`,
reproducing the pre-00009-07 item exactly — for a consumer paging a long history that does not
want the payload. Any other value, including an absent parameter, includes them: a typo fails
towards more data, never towards a silently smaller page.

## The cursor contract

- The cursor is **opaque**. Do not parse it, do not do arithmetic on it. Send back the
  `nextCursor` you were given.
- A cursor is **bound to its monitor**. Submitting monitor A's cursor on monitor B's matches
  endpoint is a `400`, not a silently wrong page.
- The **same cursor with the same `limit` returns the same page**. Associations are append-only
  under a monotone sequence, so no row can ever appear below a position you have already read.
- An **empty page returns your own cursor back**, not `null`. A poller can write `nextCursor` to
  its cursor file unconditionally on every tick, including at the end of the stream.
- Items are ordered by `(blockHeight, position)`. That ordering is structural: sequence numbers
  are allocated in that order inside the same transaction that advances coverage.

Polling loop, in words: read your cursor file → `GET …/matches?cursor=…` → persist `nextCursor`
→ process `items` → sleep. Persisting before processing means a crash re-reads a page you have
already stored rather than skipping one you have not; duplicate delivery is recoverable, a
skipped match is not.

## Error bodies

```json
{ "error": { "code": "MONITOR_REVOKED", "message": "monitor is revoked", "requestId": "…" } }
```

`code` is the contract; `message` is for humans and may change. A `400 VALIDATION_FAILED` may
carry `issues: [{path, message}]` — with any issue on the `viewingKey` path reduced to
`"invalid"`, so the field that holds a secret can never carry one into an error body.

| Code | Status | When |
|---|---|---|
| `VALIDATION_FAILED` | 400 | body or query parameter failed its schema; page size out of range |
| `INVALID_VIEWING_KEY` | 400 | any key-intake failure (one generic message for all of them) |
| `INVALID_CURSOR` | 400 | malformed cursor, or one minted for another monitor |
| `BODY_TOO_LARGE` | 400 | request body exceeded `API_MAX_BODY_BYTES` |
| `NOT_FOUND` | 404 | no such route |
| `MONITOR_NOT_FOUND` | 404 | no such monitor, or a deleted one |
| `METHOD_NOT_ALLOWED` | 405 | route exists, verb does not (an `allow` header lists the verbs) |
| `ILLEGAL_TRANSITION` | 409 | the lifecycle does not admit that transition from the current state |
| `MONITOR_FENCED` | 409 | the monitor changed under the request; reload and retry |
| `GONE` → `MONITOR_REVOKED` | 410 | the monitor is revoked |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `content-type` was not `application/json` |
| `INTERNAL_ERROR` | 500 / 503 | an unmapped fault, or storage unavailable |

A `500` never forwards the underlying message. An unexpected error's message is the one string
nobody has reviewed for what it might contain, and on the create route a driver message could
quote a bound parameter — which on that route is a viewing key.

---

## The reference consumer

`umbradb-shielded-monitor-client` is a minimal CLI that speaks only HTTP — it holds no database
credentials, imports no driver and knows no schema name.

```
umbradb-shielded-monitor-client register --key-file ./viewing.key --start earliest
umbradb-shielded-monitor-client status  --id <uuid>
umbradb-shielded-monitor-client poll    --id <uuid> --cursor-file ./monitor.cursor
umbradb-shielded-monitor-client pause   --id <uuid>
umbradb-shielded-monitor-client resume  --id <uuid>
umbradb-shielded-monitor-client revoke  --id <uuid>
umbradb-shielded-monitor-client delete  --id <uuid>
```

`--api <url>` (or `UMBRADB_API`) selects the service; the default is
`http://127.0.0.1:8787`.

The viewing key is read **only from a file**, never from `argv` — a key on a command line lands in
the shell history and in every `ps` listing on a shared host, and neither can be un-written.

`poll` persists `nextCursor` to `--cursor-file` with a temp-file-plus-rename, so an interrupted
run leaves either the old cursor or the new one, never an empty file that would replay the
consumer's whole history. Running `poll` twice with no new matches prints nothing new and leaves
the cursor file unchanged.

The client prints monitor ids, coverage, and per match the block height, position, transaction
hash, matched segments and `appliedOutcome`. Nothing else — and never a key.
