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

## `pi-fixture/` — a synthetic FULL-source bundle built by the patched reference tools

Built 2026-09-26 by project 00024-02 task C3, **before** 02-B5's real bundles exist (the tests that must
consume 02-B5's bundles are listed in `plans/00024-02-public-interface.md` as "waits for 02-B5").

| | |
|---|---|
| Contract | `bundle/src/PiFixture.compact` — a counter with a ledger write (`increment`), a ledger read (`read`) and a circuit that takes a witness (`guardedIncrement`, the emitter-secret pattern of spec Q12; verify-only under UC-3). Never deployed. |
| Compiler | `compact compile +0.34.0` (host compact CLI 0.2.0), with keys (4.6 s) |
| Tools | the PATCHED public-interface tools of `acedward/mip-public-interfaces` `feat/00024-02-public-interface` @ `c47e64e3ed79116afb5a16765e9e44b692b64398` (`tools/public-interface`: [B] PR #6 `1cf9477` + UC-3 `2e537e9` + UC-2 `4206371`), used as a library from a `git archive` of that commit (read-only; its `node_modules` linked, not modified) |
| Script | `build-script.mjs.txt` (the exact script; not run by the tests — it needs that tool copy) |
| Bundle | `bundle/` = `deployCheck({ interfaceSrc: PiFixture.compact, interfaceOut = fullOut = the build, url: http://bundles.test/pi-fixture/index.json })` — 11 files (index.json + the 10 it lists), index.json `hash` = commitment `bb0a01afa52f34f3ef21294ad1829ee6f4f8618294f5eb36481657740b0373d2`; deploy-check: every key IDENTICAL, witnesses `[emitterSecret]`, verify-only `[guardedIncrement]` |
| `state.hex` | the contract's `ContractState` after its constructor (emitter hash = SHA-256 of a public test phrase), with the three verifier keys installed — what a deploy leaves (as the tool's `simulate-deploy`) |
| `state-wrong-increment-key.hex` | the same state with `increment`'s key replaced by `read`'s (Level 2 must fail) |
| `payload-short.hex` / `payload-long.hex` | `assemblePayload(commitment, url)` for the short URL (1 part) and a 340-byte URL (2 parts) |
| `reference-verdicts.json` | the patched `public-interface-verify` (`verify({ bundleDir, eventPayload, stateBytes, level: 3 })`, compiler pinned to 0.34.0) on: `valid` → level 3; `valid-two-part-url` → level 3; `tampered-file` (byte 100 of `out/contract/index.js` flipped) → L1 fails on that file's sha256; `wrong-hash` (index.json `hash` = SHA-256("not the commitment"), re-serialized `JSON.stringify(i, null, 2) + "\n"`) → L1 fails on the hash; `wrong-installed-key` → L2 fails (`increment`); `compiler-0.33.0` (package.json `compact.compiler` = 0.33.0, re-serialized the same way, index rebuilt) → level 3 with `versionMismatch` (the reference compiles with whatever is installed; this indexer reports L3 `not_run` — a policy difference audit F4 excludes from parity) |

SHA-256 of every file (`sha256sum`, paths relative to `pi-fixture/`):

```
95bfccb805496e9ae07aa8745ce00efb04a489ee11bdc4474ab50037deb6dbec  build-script.mjs.txt
6fc124297305d36542ef5a85276992051580c5b6b24bd73981f3f2f53fe87744  bundle/index.json
0d2cf8ab9df9d67e73e12a5f4334914ca0567bc0448c8dcbc583681ef9a9166b  bundle/out/compiler/contract-info.json
bf333dad494a6eb8be01c6361aa1612458369a325f07f52c7e2daf31ba288e12  bundle/out/contract/index.d.ts
696f9fbd6182dac9ee64df9ec599d1ae5a8c08bf2e8c419a3eb0de5497747f30  bundle/out/contract/index.js
5a065fe7d8eab2a582f428e11c2ea63aaf70607a54f69cfd5c711b5c53d91b32  bundle/out/contract/package.json
0e92ab0941bd088287d8ec4a3a3cf36473a202129957aea5a13b09214f433564  bundle/out/keys/guardedIncrement.verifier
62d768951a97c18af8cb385f8c0fe6488a4dbfbebce83ea08b21914a0ebe7789  bundle/out/keys/increment.verifier
62bc962997f0d591fe4fd452e596f6a4b813ccd2a08b5583cd02f1fe809ffa16  bundle/out/keys/read.verifier
e84897f26677e4fedb9bf8fc8d8a6e51b7109bbd5076a682d956274328b46b39  bundle/package.json
4ddcfee254fd6d3ae2fcb68b8a06896baa5f14270cba8fae73fff129212466ce  bundle/README.md
635e10d358404710a2fbdf9249106b6b7f201150eac76755f1efdb054de52b56  bundle/src/PiFixture.compact
72a324c09de6f1a0ef9bb46582ef926f0904a1e6627895f7dd08b03e4073c073  payload-long.hex
d0ddd2ed2ef1a7d46518134e1e2a1da67053ade06da9203d4912b4db2697bcbc  payload-short.hex
939a09c5ea15a116b8a008ec2f86ceeb0c5f372a2694652d814a517bcc0c3996  reference-verdicts.json
006914952bf11ef0191100a39c1ac8e7bd70de95760336cf63fcfa77e4b371b4  state.hex
7f142fd05f9d9a357f0952ad15b4a2348313709b2dca2e434e99f0cf123aff58  state-wrong-increment-key.hex
```

The UmbraDB tests derive the same variants from `bundle/` with the same transformations and check that the
derived `index.json` has the SHA-256 recorded for that verdict (`indexSha256`), so every recorded reference
conclusion is tied to byte-identical inputs.
