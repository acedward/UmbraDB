# Page fixtures — project 00024-03, Phase 03-B (`[[token-ui-origin]]`)

Real responses of the token-indexer API, read with **GET only** on **2026-09-27 20:37 UTC** from the
owner's review stack of project 00024-02 (run `resources/00024-local-stack/runs/20260927T144704Z-02`,
compose project `umbra-00024-local`, API `http://127.0.0.1:27222`; token indexer = UmbraDB
`feat/00024-02-public-interface` @ `c29d7d4`, the same API code this branch serves — the 03-C guard
keeps it unchanged). The chain is the local dev chain of that run: projects 01 and 02 deployed from
an empty chain (the 11 MIP-18 contracts, the 4 PI contracts and 02-D's 7 LSUNPI fixture instances);
public local-chain data only, no secret (counts-only scan before the commit: 0 hits). 53 requests,
all HTTP 200. (`interfaces.json`, the answer of `/v1/interfaces?limit=100`, was removed in 03-E1a
(audit finding F4): the page no longer reads that route.)

Trimmed, nothing else changed: every `report` (the verification record) is dropped — the page never
reads it; a `checkHistory` longer than 3 rows (the retried `deadline` instance had 100) is cut to its
3 newest; `tokens.json` keeps 10 of the 30 rows of `/v1/tokens?limit=500` (NIGHT, DUST, one token
of each of the four PI contracts, SNEB18, LMOON18, one `observed` and one `seen` row); JSON
re-serialised compact.

| File | What it holds (request) | Used for |
|---|---|---|
| `token-sneb18.json` | SNEB18 (`47a7c52e…f398a2`, domainSep `umbra:sneb18`, kind 1): the token route, `/metadata`, `/mints?limit=200`, `/v1/contracts/:address`, `/v1/contracts/:address/events?limit=500`, `/transactions?limit=200` | a 3-part MIP-0018 `metadata` package (events 105–107); SNEBDU's MIP-0018 twin (US6 scenario 1) |
| `token-lmoon18.json` | LMOON18 (`fcb58d36…29d1dc`, `umbra:lmoon18`, kind 2): the same routes, `/calls?limit=200` instead of transactions | `description`: a text (event 78), a Null (80), then a 2-part value (82–83) — P1 and the history (US6 scenario 3's rule); `name` renamed once |
| `token-lsunpi.json` | LSUNPI (`34a5f9bf…20bb1e`, `umbra:lsunpi`, kind 2): the same routes + `/v1/contracts/:address/interface` | a newer broken bundle `current` + `failed` at L1, the first publication `historical` + `verified` L1/L2/L3 (Q14); `repository` the only declaration (US6 scenario 2) |
| `token-uprompi.json` | UPROMPI (`5f28efc4…8afc3`, `umbra:uprompi`, kind 0): the same routes + interface | a 235-byte URL published as a **2-part** [Y] package (events 331–332), verified L1/L2/L3; 21 files, 9 keys, 9 circuits with argument types, 1 witness |
| `token-sstarpi.json` | SSTARPI (`b76d3853…5f5f93`, `umbra:sstarpi`, kind 1): the same routes + interface | a verified shielded PI token with mints and activity |
| `interface-outcomes.json` | `/v1/contracts/:address/interface` and `/v1/contracts/:address` of 02-D's LSUNPI fixture instances, keyed by the fixture name in their URL: `valid`, `compiler-not-installed`, `tampered-file`, `wrong-hash`, `breach`, `deadline`, `over-size-cap` | verified L1/L2/L3; verified L1/L2 with L3 `not_run` (no compiler 0.33.0); failed at L1 (three causes); failed at L1 after a verified check (`verifiedUntil`); `unchecked` by a deadline and by the size cap |
| `tokens.json` | 10 rows of `/v1/tokens?limit=500` | the list's interface column and multi-part badges |

The statuses this stack cannot show — `pending`, `unfetchable`, `unreachable`, `stale` — a
`failed` at L2, a URL of the 262 112-byte maximum (1 024 parts) and a diagnostic bounded by the
indexer's own rule ("… [N characters omitted]", `interface/verify.ts`) are built by the test from
these payloads and the API's types (`INTERFACE_STATUSES`), not recorded.

Capture script (organizer scratch, not committed): GET each route with `urllib`, drop `report`, cut
`checkHistory`, write compact JSON.
