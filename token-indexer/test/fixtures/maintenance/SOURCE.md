# Maintenance-update fixture — project 00024-01 (question Q21)

`cnst18-staged-deploy.transactions.json` holds **29 real transactions** of one contract's staged
deploy on the 00024 **local** Midnight 2.x chain (network id `undeployed`, node 2.0.0-rc.4, ledger
crate 9.1.0.0-rc.3, dev-preset genesis `0x635663c0…356a`): the `ContractDeploy` of the
`CNST18` collection contract of `acedward/mip-0018-midnight-contracts` (branch
`feat/00024-01-mip-0018` @ `cb6c675`, task 01-A6b) with 11 of its 39 operations, then **28
maintenance transactions**, each a ledger `MaintenanceUpdate` carrying one `VerifierKeyInsert` for
one of the remaining circuits, signed by the contract's maintenance authority (counter 0 … 27).
This is how a contract whose verifier keys do not fit one block is deployed (spec 00024 Q20 (a)).

| Field | Value |
|---|---|
| Source file | `resources/00024-local-stack/runs/20260926T132443Z-01a6b/staged-fixture/transactions.json` of the organizer workspace (run 01-A6b, 2026-09-26 10:25–11:24 -03) |
| Read from | the stack's own `indexer-standalone` 4.4.0-rc.3 GraphQL API, by transaction hash, before the stack was torn down (the file's own `note`): `raw`, the block, the result status and the `contractActions` (`__typename`, `address`) are the indexer's; `row`, `kind`, `circuits` and `verifierKeySha256` are the deploy script's record of the same transactions (`staged-deploy.tsv` of that run) |
| Copied | verbatim, byte for byte — SHA-256 `e1d37f9ae4ea0b7fd9eb62a1d495d61a30766db30726ffcefd7e3310aab0817c`, 395 718 bytes (the test checks it) |
| Contract | `4846de74e8db124eff4fdff39e6abc764b5b5be621fdd6002e58377ef5a7af07` (`CNST18`) |
| Deploy | `19a9f17b2a907a2fc01429b2848102b470bd4ee000a634c00b81c579e8737dce`, block 326, 27 676 raw bytes, operations `mintPiece` + Orion's 10 declaration circuits |
| Inserts | 28 transactions, blocks 329 … 410 (every third block), 4 935 – 5 714 raw bytes each; `circuits[0]` names the inserted operation, `verifierKeySha256` the SHA-256 of the compiled `.verifier` file (`midnight:verifier-key[v6]:` ‖ the on-chain `rawVk`) |
| Status | every transaction `SUCCESS` (whole-transaction; no fallible segment) |

Every field is public chain data: raw transaction bytes, hashes, heights, the contract address
and the circuit names. No wallet seed, emitter secret or maintenance key is in the file (the
maintenance key signs the updates; only its signature is on chain). `rawSha256` equals `txHash`
for every row (on this chain the transaction hash is the SHA-256 of the raw bytes); the test
checks it.

What the file does **not** record, and what the test therefore synthesises: the block around each
transaction (parent hash, state root, body — the token scanner reads none of them) and the
archive's `protocol_version` column (set to `2000000`, the local runtime's `specVersion`, P0.1;
the scanner does not read it either). One block per transaction, at its real height, position 0 —
`token-indexer/test/helpers/archive-fixture.ts` `seedArchive`.

## What it proves

`token-indexer/test/maintenance-scan.test.ts` — `[[token-scan-maintenance-actions]]`: the real
ledger-v9 decoder classifies the deploy as one `deploy` action and each insert as one
`maintenance` action (no entry point, no transcript, no `log` op, no mint, no activity row, no
call record), and the scanner, over a real `chain_archive` schema, records the contract once at
its deploy height, asks the event source nothing, leaves no pending lookup and no error, and moves
its cursor past all 29 transactions (in one batch and in batches of 5; a re-scan changes nothing).
Before this fixture no test exercised the `maintenance` path of `ingest/decode.ts` `classify`
(question Q21); the only evidence was a ~1 h local-chain run.

## Re-recording

A new staged deploy (any `run-e2e.sh 01` run of the 00024 local stack) writes the same shape;
re-copy the file, update the SHA-256 above and in the test, and keep the counts (1 + 28) or
update them with the reason.
