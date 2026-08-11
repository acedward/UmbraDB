# Part C runbook — events ingestion + `eth_getLogs`

## What runs where

| Piece | File | Entry |
|---|---|---|
| Mapping (pure) | `event-map.ts` | library |
| Ingester | `ingest.ts` | `startIngest(options)` |
| `eth_getLogs` | `get-logs.ts` | `registerGetLogs({ sql, schema })` |
| `eth_subscribe` (WS) | `subscribe.ts` | `createSubscribeServer({ port, sql, schema })` |
| Genesis backfill | `backfill.ts` | `backfillWatched(sql, schema, entries)` |
| Schema | `src/postgres/migrations/evm_rpc/010_logs.ts` | `runMigrations(sql, { schema: "evm_rpc", migrations: evmRpcMigrations })` |

## Environment

```bash
set -a; source ../stack/STACK.env; set +a     # from midnight-evm-compat/stack
export WATCH_CONTRACTS_FILE=./watch.json
export EVM_RPC_WS_PORT=10021                  # STACK.env exposes it as EVM_RPC_WS
export PG_URL="$ARCHIVE_PG"
```

`watch.json`:

```json
[{ "address": "<unprefixed hex Midnight contract address>", "profile": "erc20", "fromBlock": 0,
   "deploymentFile": "../compact-end-2-end/dapps/evm-erc20/out/deployment.json" }]
```

`profile` ∈ `erc20` | `erc721` | `misc`. `deploymentFile` is optional and only drives the C-G5
genesis backfill.

## Offline verification (no stack needed)

```bash
npm run test:conformance
```

Runs the whole repo gate. Part C's own suites, if you want them alone:

```bash
npx vitest run evm-rpc/logs/test/
```

These use `test/fake-indexer.ts` — a `graphql-transport-ws` server that is faithful on the points
the ingester's correctness depends on (inclusive resume cursor, monotonic ids, one event per `next`,
forced redelivery, forced disconnects). Real Postgres comes from Testcontainers, so the database
half is never mocked.

## Live verification (needs the Part A stack up)

```bash
set -a; source ../stack/STACK.env; set +a
npx tsx evm-rpc/logs/test/live-check.ts --migrate
```

Six phases, each PASS/FAIL/SKIP: indexer schema shape, **the real indexer accepting `ingest.ts`'s
exact selection set**, the migration applying alongside A1/A2's tables, the real
`graphql-transport-ws` handshake, `eth_getLogs` off the live database, and the `eth_subscribe`
server binding on 10021. Phase 4 is the one thing the fake indexer cannot establish — that the wire
format Part C speaks is the one the indexer speaks.

### Once a contract is actually emitting

Everything above passes with **zero** contract events on chain, because no contract has been
deployed yet. The remaining step needs an emitting contract — either Part D's token, or the
ready-made emitter at `compact-end-2-end/dapps/events/` (a FungibleToken fork using `emit`; see
`compact-end-2-end/RUNNING.md`).

```bash
# 1. deploy + transfer, so real events exist
#    (from compact-end-2-end, per its RUNNING.md)

# 2. point watch.json at the deployed address, then ingest
npx tsx -e '
  import { createClient } from "./src/postgres/client.js";
  import { startIngest } from "./evm-rpc/logs/ingest.js";
  import { loadEnv } from "./evm-rpc/logs/config.js";
  const env = loadEnv();
  const sql = createClient({ connectionString: env.pgUrl, schema: env.schema });
  startIngest({ sql, schema: env.schema, indexerWs: env.indexerWs,
                contracts: env.watchContracts, onProgress: console.log });
'

# 3. parity: eth_getLogs === mapEvents(raw GraphQL contractEvents)
INDEXER_HTTP="$INDEXER_URL" npx tsx evm-rpc/logs/test/verify-parity.ts
```

Then the remaining plan checks:

- rows appear within a block of each transfer — watch `onProgress`;
- restart the ingester, full replay, `select count(*) from evm_rpc.logs` unchanged;
- `kill -9` mid-batch leaves no partial state (also covered offline by
  `test/ingest-crash.test.ts`, which kills a real spawned worker);
- an `ethers.WebSocketProvider` receives a Transfer log within 2 blocks (also covered offline by
  `test/subscribe.test.ts`, which drives the server with a real ethers client);
- logs-derived balances equal on-chain balances — `foldTransferBalances` in `backfill.ts`, and the
  dashboard check `stack/dashboard/checks/20_logs_present.sql`.

## Operational notes

- **The idle flush sets the latency floor.** A transaction's logs land at most `idleFlushMs`
  (default 1500ms) after its last event, because the trailing transaction is held until something
  proves it closed. Lowering it below block time is safe; raising it above delays the tip. See
  `LOGMAP.md` §"Batch boundaries" for why `maxId` is deliberately not used to shortcut this.
- **A restart always re-reads a little.** The cursor only advances to a transaction boundary, so a
  restart replays the held tail. Inserts are `ON CONFLICT DO NOTHING`, so the row count does not
  move.
- **`eth_getLogs` never calls the indexer.** It reads Postgres only, so RPC reads keep working when
  the indexer is unreachable — the ingester falls behind, reads do not fail.
- **`latest` is Part C's own tip, not the chain's.** With no Part B, `resolveLatestBlock` defaults to
  the highest block in `logs`. Inject the real head at the Part F merge.
- **Reorgs are not handled.** `removed` is always `false`. The column exists so the row shape is
  `eth_getLogs`-complete and a later part can add rewind without a migration.
