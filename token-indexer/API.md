# MIP-0018 token indexer — read-only JSON API (contract)

Project 00026, sub-plan C1. The API serves what the MIP-0018 scan stored in Postgres (schema `mip0018`): the
NIGHT/DUST rows, every token identity that is minted or described, the colors seen in public data, the current
metadata fields, symbol groups, ✓/⚠ marks, the color lookup and the chain events with their classification.

Authority: MIP-0018 PR #340 head `274a84f221bcfc17e4b73e2c8b32fd8c028ea092` (final text, per-key tombstones). Nothing
of an earlier draft is served. The explorer page (sub-plan C3) uses only these endpoints.

- Server: `node:http`, no framework. `GET` and `HEAD` only. Read-only: every request runs in one
  `REPEATABLE READ READ ONLY` transaction, so all parts of one answer come from one database state.
- Entry point: `token-indexer/mip0018/serve-cli.ts` (see [Running](#running)).
- Implementation: `token-indexer/mip0018/api.ts` (routes, validation, errors) and `api-views.ts` (queries, shapes).
- The explorer page (`GET /ui`, sub-plan C3, `token-indexer/mip0018/ui/README.md`) is served by `serve()` through the
  server's optional `ui` hook; `createMip0018Api` without the hook answers `/ui` with 404 like any unknown path.

## General rules

| Rule | Meaning |
|---|---|
| Heights only | Positions are block heights and indexes; no wall-clock time is served. |
| Never fetches | The API never fetches a URI or any remote content (a type-4 URI value is served as text only). No origins model. |
| Bytes | Every byte string is lowercase hex without `0x` (`"hex"`). A text view (`"text"` / `"utf8"`) is added only where the bytes are valid UTF-8 and the type says text; an integer view (`"integer"`, a decimal string) only for type-2 values. Values are never re-interpreted as another type (MIP "Value types"). |
| No defaults | A common field that was never set, or whose current value is unusable, is `null` in `common`; no default such as 0 or 18 decimals. |
| Hostile text | Text is data. The JSON body is pure ASCII: every non-ASCII character (bidi controls, zero-width characters, …) and `<`, `>`, `&` are written as `\uXXXX` escapes; control characters (NUL …) are JSON escapes. Parsing the JSON gives the exact text back. |
| Not referenced after withdrawal | A token identity exists only while one of its fields has a value (MIP "Applying records", per-key tombstones). Once its last field is deleted it is not referenced anywhere — not in listings, lookups, groups, events or the contract view — exactly as if it had never been described: a never-minted one answers 404, a minted one is shown only as a minted token (`described: false`, no fields, no group). A deleted field's earlier values are never served. |
| Events carry no values | The event endpoint serves position, contract, classification and reason only — never an event's name, payload, header (`domainSep`, `kind`) or decoded values (mid-project audit QA2, Q15). Only MIP-0018-named events (`accept`, `reject`) are served; other `Misc` events (`ignore`) are not (Q19). |
| Marks | `mark` is decided by one function (`state.ts` `tokenMark`, owner Q14 (a)): `ok` (✓) usable `name`, `symbol` and `decimals` and no rejected MIP-0018 event from the token's contract; `partial` (⚠) one of the three missing or unusable; `incorrect` (⚠) the contract has a rejected MIP-0018 event (reasons listed in chain order); `none` no metadata and no rejected event. Usable `standards` identifiers are returned as `tags` (self-declared, never proof). Current state only (assumption A13). |
| Groups | Symbol groups as the MIP defines them: identities of one contract with the same usable `symbol` bytes; only groups of two or more members (Q6). |
| NIGHT / DUST | Protocol tokens, outside MIP-0018; served as built-in rows with no mark. NIGHT's color is 32 zero bytes; DUST has no color. |

### Errors

Every error is

```json
{ "error": { "code": "BAD_REQUEST", "message": "color must be 64 hex characters" } }
```

| Status | `code` | When |
|---:|---|---|
| 400 | `BAD_REQUEST` | Malformed path value (hex length, kind not 1–3), unknown or repeated query parameter, bad `limit` or `order`, a cursor this endpoint (listing, filter, order) did not issue, missing required parameter |
| 404 | `NOT_FOUND` | No such route, or the color / identity / contract is not known |
| 405 | `METHOD_NOT_ALLOWED` | Any method other than `GET`/`HEAD` (header `Allow: GET, HEAD`) |
| 503 | `UNAVAILABLE` | The database cannot be read (message is generic) |
| 500 | `INTERNAL` | Anything else (message is generic) |

Messages name the parameter, never echo the input, and never carry internal details (no SQL, stack or driver text).

Input rules: `color`, `contract`/`address`, `domainSep` and `tx` are exactly 32 bytes = 64 hex digits (an optional
`0x` prefix and upper case are accepted and normalised); `kind` is `1`, `2` or `3`; a path with an empty segment
(double or trailing slash) is not a route (404).

### Pagination

Lists are keyset-paginated: `?limit=` (integer 1–500, default 100) and `?cursor=` (opaque; copy `nextCursor` from
the previous page). A page is

```json
{ "items": [ … ], "nextCursor": "eyJlIjoidG9rZW5zIiwi…" }
```

`nextCursor` is `null` on the last page. A cursor is bound to its endpoint (and filter); any other string is a 400.

### Response headers

`content-type: application/json; charset=utf-8`, `cache-control: no-store`, `x-content-type-options: nosniff`,
`content-security-policy: default-src 'none'; frame-ancestors 'none'`, `referrer-policy: no-referrer`.

## Shared shapes

**Position** — where something happened: `{ "height": 714501, "txIndex": 0, "txHash": "a6fff9fb…" }`.

**MintStats** — the indexed mints of one kind of a color:

```json
{ "firstMint": { "height": 714643, "txIndex": 0, "txHash": "395076e7…" }, "mints": 1, "amount": "100000", "amountDisplay": "1000.00" }
```

`amount` is the exact sum (decimal string); `amountDisplay` is `amount / 10^decimals` with the identity's usable
`decimals` (MIP "Common fields"), or `null` when it has none.

**Mark** — `{ "mark": "ok" | "partial" | "incorrect" | "none", "reasons": ["reserved-valtype"], "reasonCount": 1, "missing": ["decimals"], "tags": ["mip-0004"] }`.
`reasons` lists the first 100 rejection reasons of the contract in chain order, `reasonCount` all of them (every
rejected event is in `/v1/events`); `missing` (for `partial`) names the unusable or absent common keys.

**Common** — the usable common fields only: `{ "name": "Acme Gold", "symbol": "AGLD", "decimals": "6", "standards": ["mip-0004"] }`
(each `null` when absent or unusable; `decimals` is a decimal string — it can be up to 2^248 − 1; `standards` is the
parsed list, `[]` for an empty value).

**Field** — one current field of an identity, in the order their current values were set:

```json
{
  "key": { "hex": "6e616d65", "utf8": "name" },
  "valType": 1, "valTypeName": "utf8",
  "value": { "hex": "41636d6520476f6c64", "text": "Acme Gold" },
  "usable": true,
  "updatedAt": { "height": 714501, "txIndex": 0, "eventIndex": 0, "record": 0 }
}
```

`key.utf8` is `null` when the key is not valid UTF-8. `valTypeName`: 0 `bytes` (hex only), 1 `utf8` (`text`),
2 `uint` (`integer`), 3 `json` (`text`), 4 `uri` (`text`; never fetched). `usable` is `true`/`false` for the four
common keys and `null` for any other key.

**Group** — `{ "symbol": { "hex": "414344", "utf8": "ACD" }, "members": [ { "domainSep": "6d69…", "kind": 1 }, … ] }`.

**TokenSummary** — one row of the token list:

```json
{
  "id": "identity/98a90519…7dcf/6d69702d…0000/3",
  "source": "identity",
  "kind": 3, "kindName": "ledger",
  "color": null,
  "contractAddress": "98a90519419e2ebb514b7c6ce87ee7f6f4f9753d9ee6f533c5d1c25b9d437dcf",
  "domainSep": "6d69702d303031383a6578616d706c653a66756e6769626c6500000000000000",
  "name": "Acme Gold", "symbol": "AGLD", "decimals": "6",
  "described": true,
  "minted": null,
  "firstSeen": null, "evidence": [],
  "mark": { "mark": "ok", "reasons": [], "reasonCount": 0, "missing": [], "tags": [] },
  "note": null
}
```

| `source` | Row | Fields |
|---|---|---|
| `builtin` | NIGHT, DUST | `kind`, `contractAddress`, `domainSep` `null`; `name`/`symbol`/`decimals` the protocol values; `note`; `mark` `null` |
| `identity` | an identity that is minted (kinds 1/2) or described (any kind) | `color` = the minted color (kinds 1/2 with an indexed mint), else `null`; `minted` = MintStats of this kind or `null`; `name`/`symbol`/`decimals` = usable values or `null`; `described` = has fields now |
| `seen` | a color seen in public data (unshielded UTXOs, offer deltas, contract unshielded effects) with no indexed mint | `color`, `firstSeen` (Position), `evidence` (`unshielded-utxo`, `shielded-offer`, `contract-unshielded`); `mark.mark` `none` |

`kindName`: 1 `shielded`, 2 `unshielded`, 3 `ledger`.

**IdentityDetail** — one token identity:

```json
{
  "network": "stagenet",
  "contractAddress": "86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f",
  "domainSep": "6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000",
  "kind": 1, "kindName": "shielded",
  "color": "04239924…bc16",
  "minted": { "firstMint": { … }, "mints": 1, "amount": "100000", "amountDisplay": "1000.00" },
  "described": true,
  "common": { "name": "Acme Dollar", "symbol": "ACD", "decimals": "2", "standards": null },
  "fields": [ Field, … ],
  "group": { "symbol": { "hex": "414344", "utf8": "ACD" }, "members": [ … 3 members … ] },
  "mark": { "mark": "ok", "reasons": [], "reasonCount": 0, "missing": [], "tags": [] }
}
```

A minted identity that is not (or no longer) described: `described: false`, `common` all `null`, `fields: []`,
`group: null`, `mark` from its contract's rejections only (`incorrect` or `none`).

## Endpoints

### `GET /v1/status`

```json
{
  "network": "stagenet",
  "genesisHash": "0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491",
  "startHeight": 714485,
  "indexedHeight": 715183,
  "archiveHeight": 715183,
  "mip": { "id": "MIP-0018", "commit": "274a84f221bcfc17e4b73e2c8b32fd8c028ea092" },
  "vendored": { "repository": "https://github.com/midnight-experiments/mip-0018", "commit": "daec1f19747b09f4e245885ab0dd9ecc789a82ce" },
  "scanner": "following"
}
```

`startHeight` = the scan's first height, `indexedHeight` = the last scanned height (the scan cursor), `archiveHeight`
= the chain archive's last height (all `null` before anything is scanned/archived). `genesisHash` is the configured
network's (`null` when unknown). `scanner`: `following` (this process runs the scan loop), `stalled` (the loop's last
attempt failed; it retries), `off` (API only).

### `GET /v1/tokens?limit=&cursor=`

Page of TokenSummary: NIGHT, DUST, then identities by `(contractAddress, domainSep, kind)`, then seen colors by color.

### `GET /v1/tokens/{color}`

The token(s) of one color:

```json
{
  "color": "04239924…bc16",
  "builtin": null,
  "contractAddress": "86acf80f…570f", "domainSep": "6d69702d…0000",
  "firstSeen": { "height": 714643, "txIndex": 0, "txHash": "…" }, "evidence": ["shielded-offer", "unshielded-utxo"],
  "identities": [ IdentityDetail (kind 1), IdentityDetail (kind 2) ],
  "related": [ { "contractAddress": "86acf80f…570f", "domainSep": "6d69702d…0000", "kind": 3 } ]
}
```

- NIGHT's color (64 zeros): `builtin` = `{ "symbol": "NIGHT", "name": "NIGHT", "decimals": "6", "note": "…" }`, no identities.
- A minted color: its `(contractAddress, domainSep)` from the mint table; `identities` = kinds 1 and 2 of that pair
  that are minted or described; `related` = other described identities of the same pair (kind 3).
- A color only seen: `contractAddress`/`domainSep` `null`, `identities: []`.
- Anything else: 404.

### `GET /v1/identities/{contract}/{domainSep}/{kind}`

IdentityDetail. 404 when the identity is neither described nor minted (this includes a withdrawn, never-minted one).

### `GET /v1/contracts/{address}/tokens?limit=&cursor=`

```json
{ "contractAddress": "f2d1b6eb…51d6", "groups": [ Group, … ], "items": [ TokenSummary, … ], "nextCursor": null }
```

`items` = the contract's identities (minted or described) by `(domainSep, kind)`; `groups` = all its symbol groups of
two or more members. 404 when the contract is not known to the scan (no applied call, deploy, update, mint or field).

### `GET /v1/lookup/{color}?held=shielded|unshielded`

MIP "Lookup": the color resolves through the mint table to `(contractAddress, domainSep)`; the kind is given by the
holding (`shielded` → 1, `unshielded` → 2), not by the color. `held` is required.

```json
{ "color": "04239924…bc16", "held": "shielded", "found": true, "result": "identity",
  "builtin": null, "identity": IdentityDetail (kind 1), "seen": null, "indexedRange": { "from": 714485, "to": 715183 } }
```

| `result` | When |
|---|---|
| `identity` | a mint of the color was indexed; `identity` = that pair with the held kind (possibly `described: false`) |
| `builtin` | NIGHT's zero color (`builtin` filled) |
| `not-minted-in-indexed-range` | no mint of the color in the scanned range (`found: false`); `seen` = `{ firstSeen, evidence }` when the color appeared in public data, else `null` |

### `GET /v1/events?contract=&tx=&limit=&cursor=`

The MIP-0018-named events (`accept`, `reject`) of one contract and/or one transaction (at least one filter
required), in chain order (block, transaction, event — the MIP's within-transaction order):

```json
{ "items": [ { "height": 715109, "txIndex": 0, "txHash": "75c43430…", "eventIndex": 1, "segment": 53948, "phase": "guaranteed",
               "contractAddress": "65553c65…ceb9", "classification": "reject", "reason": "reserved-valtype" } ],
  "nextCursor": null }
```

`reason` is `null` for an accepted event. Never the event's bytes, header or values (QA2).

### `GET /v1/tokens/{color}/activity?limit=&cursor=&order=`

The transactions that touched a token (sub-plan C2's rows; roles and rules: questions Q26, assumption A16): the
color's own rows (`mint`, `utxo-created`, `utxo-spent`, `contract-in`, `contract-out`, `shielded-offer`) and the
`metadata-event` rows of the contract that minted it, in chain order (`order=asc`, default) or newest first
(`order=desc`). Heights only. Wallet addresses are Bech32m (`mn_addr_stagenet1…`); contracts, colors and hashes are
hex — never Bech32m. A metadata row carries counts and the first event's index, never values. C03's token
(abridged: hashes shortened, optional fields such as `phase`/`segment`/`direction` shown only where certain):

```json
{
  "color": "8e01e392…8484",
  "contractAddress": "a3df52605d8b7210aa3e5cdc82de4bb2911975bc42c1a68be77044723b705f21",
  "items": [
    { "height": 714617, "txIndex": 0, "itemIndex": 0, "txHash": "2ec3accadb…", "role": "utxo-created",
      "color": "8e01e392…8484", "amount": "1000000",
      "wallet": "mn_addr_stagenet1vw57646su9y5z6myarm93m6kcn62j97z0yma94lfkhmta6pz5h5q6utr3k",
      "utxo": { "intentHash": "0c038f28…9260", "outputIndex": 0 } },
    { "height": 714617, "txIndex": 0, "itemIndex": 1, "txHash": "2ec3accadb…", "role": "mint", "color": "8e01e392…8484", "amount": "1000000",
      "contract": "a3df5260…5f21", "actionIndex": 0, "entryPoint": { "hex": "6d696e74", "text": "mint" }, "domainSep": "…", "kind": 2, "wallet": "mn_addr_stagenet1vw57646su9y5z6myarm93m6kcn62j97z0yma94lfkhmta6pz5h5q6utr3k" },
    { "height": 714624, "txIndex": 0, "itemIndex": 0, "txHash": "7f7cc752db…", "role": "metadata-event", "contract": "a3df5260…5f21",
      "events": { "accepted": 1, "rejected": 0, "firstEventIndex": 0 } }
  ],
  "nextCursor": null
}
```

Row fields (C2's `ActivityItem`; a field absent from a row does not apply to it): `height`, `txIndex`, `itemIndex`,
`txHash`, `role`, `phase`, `segment`, `color`, `amount` (unsigned decimal) with `direction` (`in`/`out`), `contract`,
`actionIndex`, `entryPoint`, `domainSep` and `kind` (mint rows), `wallet` (Bech32m), `recipientContract` (hex),
`utxo` (`intentHash`, `outputIndex`), `events` (`accepted`, `rejected`, `firstEventIndex`). `contractAddress` is
`null` for a color with no indexed mint (NIGHT, a seen-only color). 404 when the color is not known in the indexed
range (as `/v1/tokens/{color}`). `limit` 1–500 (default 100); the cursor is bound to the listing and the order.

`entryPoint` (rows of a contract call: `mint`, `contract-in`, `contract-out`) is an object, because an entry point is
arbitrary bytes on the ledger (NUL, control, bidi and non-UTF-8 bytes included): `{ "hex": "6d696e74", "text": "mint" }`
— `hex` is always the exact bytes; `text` is present only when the entry point is printable by the ledger's own rule
for showing an entry point as a string (non-empty, every byte an ASCII letter or digit or one of `'+-_":/\?#$^*&.`).
Anything else is served as hex only, e.g. `{ "hex": "6d696e7400" }` for `mint` followed by a NUL byte.

### `GET /v1/contracts/{address}/activity?limit=&cursor=&order=`

A contract's metadata transactions — the activity of a kind-3 identity, which has no color: one `metadata-event` row
per transaction with accepted or rejected MIP-0018 events of that contract (counts and the first event's index;
never values or the identity). Same paging and errors; 404 when the scan never saw the contract.

```json
{ "contractAddress": "9d93b919…40e3",
  "items": [ { "height": 714796, "txIndex": 0, "itemIndex": 0, "txHash": "71fb2c2d9a…", "role": "metadata-event", "contract": "9d93b919…40e3",
               "events": { "accepted": 1, "rejected": 0, "firstEventIndex": 0 } } ],
  "nextCursor": "…" }
```

## Running

```sh
# 1. archive a range (or follow the tip): chain-archive-sync
ARCHIVE_PG=postgres://… NET=stagenet node --import tsx chain-archive-sync/sync-cli.ts --from 714485 --to 715183
# 2. serve: scans the archive (following its cursor) and answers the API
PG_URL=postgres://… node --import tsx token-indexer/mip0018/serve-cli.ts --network stagenet [--port 10026] [--host 127.0.0.1]
```

See the header of `serve-cli.ts` for every flag and environment variable (`--api-only`, schemas, genesis).
