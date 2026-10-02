# Recorded Stagenet events and transactions — the [Y] live examples (project 00024-01)

Four READ-ONLY GraphQL responses of the public Stagenet indexer, recorded for
`[[multipart-segment-from-raw]]` (`token-indexer/test/multipart-stagenet.test.ts`). Nothing was
deployed, funded or signed to obtain them; no wallet was used.

| Field | Value |
|---|---|
| Endpoint | `https://indexer.stagenet.shielded.tools/api/v4/graphql` |
| Recorded at | 2026-09-25T22:40:07Z (plan `00024-01` task B2; organizer evidence note §01-B research) |
| Contract | `27a8be750856ace6276eef6be2e456947c395364ae08f6cf2c1ace5dd319a2c8` — [Y]'s example emitter, event name `example:message[v1]` |
| Source of the examples | `acedward/compact-multi-part-event` PR #1 @ `f2425f2`, `MIP-SPEC-DRAFT.md` "Implementation" |
| Decoded with | `@midnightntwrk/ledger-v9` 1.0.0-rc.3 and 1.0.0-rc.5 (same result) |

| File | Query | Holds |
|---|---|---|
| `events-3a4c54e9….json` | `contractEvents(filter: { contractAddress: <contract>, transactionHash: "3a4c54e9…fcdd" }, limit: 500, offset: 0) { __typename id raw contractAddress transaction { hash block { height hash } } … on MiscContractEvent { name payload } }` | events 45258 (intent 5392), 45259–45261 (intent 45345) |
| `events-dacd1930….json` | the same, `transactionHash: "dacd1930…3074"` | event 45275 (intent 54287) |
| `tx-3a4c54e9….json` | `transactions(offset: { hash: "3a4c54e9…fcdd" }) { __typename id hash protocolVersion raw block { height hash } … on RegularTransaction { transactionResult { status segments { id success } } identifiers } }` | block 618048, SUCCESS, intents 1, 5392, 45345 |
| `tx-dacd1930….json` | the same, `hash: "dacd1930…3074"` | block 618059, SUCCESS, intents 1, 54287 |

The files are the responses as served, re-indented with `python3 -m json.tool --indent 2` (no
field changed). SHA-256 of the files as committed:

```
e628a5eecf15f3153b03ec0d896195c30ef5e3e90ab3c8a0166ffc4a7eb56105  events-3a4c54e93bb80ecc7574738e06fd82ef7f8ff3265a6bddc350c225bd92fafcdd.json
6d3843e0c5605ab3b3cab372393c7ec36da61081fc1c1e4f0b5d142ddf997050  events-dacd193039b14f8833a17c7964923de2c95dd18eaec5dcd62ac5166772553074.json
d49fde6f73aecb500d1763bec7030c95384b9792736b2a52701e1a313adafe96  tx-3a4c54e93bb80ecc7574738e06fd82ef7f8ff3265a6bddc350c225bd92fafcdd.json
3db2f17d9b8f05ae54c0defb20782eb2c5254ef9416648ddcb6232b48a126668  tx-dacd193039b14f8833a17c7964923de2c95dd18eaec5dcd62ac5166772553074.json
```

The packages [Y] reports for them, which the test reproduces with `example:message[v1]` opted in
in a TEST configuration only (spec 00024 US2): intent 5392 — 1 part, SHA-256
`40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880`; intent 45345 — 3 parts, 768
bytes, SHA-256 `f5d7cc3852a3ae6f9948a8a84062358c722e2c0415e1490615b2fa4185023ebf`; the second
transaction's intent 54287 — the same 256 bytes as intent 5392, a separate package.

Re-record (read-only) with the two queries above and `curl -sS -H 'content-type: application/json'
-d @<query.json> <endpoint>`.
