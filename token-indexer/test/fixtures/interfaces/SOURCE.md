# Public-interface test fixtures (project 00024-02)

Public data only: no key, seed or secret is recorded here.

## `live-stagenet-event.json` — a real `mip-xxxx:public-interface[v1]` event

| | |
|---|---|
| What | The one `publishBundle` event of the live example contract of the Public Interfaces draft ([B], `acedward/public-interfaces-for-compact-contracts` PR #6 `1cf9477`, `deploy-tools/deployment.json`, README "historical Stagenet deployment") |
| Contract | `5d3233163cd730afb8a31b3e61e77fbd5949fa05d35920bd2b5cea32febaa0f6` |
| Transaction | `79fa53ab3601a373b778d3c0f6d457784457c5540276b254c85d55a7bc55b3de`, block 608267 |
| Commitment / URL | `4814bf93c6c0a6c81c7839f9be72c80365c2a4179d58171e7acd40906be30891` / `https://compact-off-chain-circuits.pages.dev/public-interface/erc20-private/index.json` (both as [B]'s README records them) |
| Read from | the Stagenet public indexer `https://indexer.stagenet.shielded.tools/api/v4/graphql`, 2026-09-26, read-only (`contractEvents(filter: { contractAddress, types: [MISC] })`), by project 00024-02-A |
| Copied from | `acedward/mip-public-interfaces` `feat/00024-02-public-interface` @ `c47e64e3ed79116afb5a16765e9e44b692b64398`, `tools/public-interface/test/fixtures/live-event.json`, byte for byte |
| SHA-256 | `84678e4b3adbbb6c90446b208bcbbd0856f3723c04a2ceade498dd97226b3e8f` (2 022 bytes) |

Used by `[[interface-event-golden]]`: its `raw` decodes with `@midnightntwrk/ledger-v9` 1.0.0-rc.5 to a
contract `Misc` event of the pinned name whose payload is the typed payload, and the indexer's reader and
decoder turn it into the commitment and URL [B] recorded.
