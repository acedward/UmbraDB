/**
 * Part F combined entrypoint — the full read-path evm-rpc service in one process:
 *
 *   Part B: HTTP JSON-RPC server (static/blocks/accounts/transactions methods)
 *   Part C: eth_getLogs (registered into B's registry via the shim bridge),
 *           genesis backfill, contractEvents ingester, WS eth_subscribe server
 *
 * Run: `npm run evm-rpc:all`. Environment (union of both parts' documented env):
 *   EVM_RPC_PORT (8545) EVM_RPC_HOST (0.0.0.0) CHAIN_ID (2400) INDEXER_URL
 *   INDEXER_WS PG_URL WATCH_CONTRACTS_FILE EVM_RPC_WS_PORT (10021) EVM_RPC_SCHEMA (evm_rpc)
 *
 * `resolveLatestBlock` is wired to Part B's indexer head (not C's logs-table fallback),
 * exactly as get-logs.ts documents the merge should do.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createClient } from "../src/postgres/client.js";
import { createPostgresEvmRpcReader } from "./db.js";
import { IndexerGqlClient } from "./indexer-gql.js";
import { registerAccountMethods } from "./methods/accounts.js";
import { registerBlockMethods } from "./methods/blocks.js";
import { registerStaticMethods } from "./methods/static.js";
import { registerTransactionMethods } from "./methods/transactions.js";
import { defaultRegistry } from "./registry.js";
import { createRpcServer } from "./server.js";
import { loadEnv } from "./logs/config.js";
import { registerGetLogs } from "./logs/get-logs.js";
import { startIngest } from "./logs/ingest.js";
import { createSubscribeServer } from "./logs/subscribe.js";
import { backfillWatched } from "./logs/backfill.js";

function positivePort(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a TCP port`);
  return value;
}

function nonNegativeInteger(raw: string, name: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} must be a non-negative decimal integer`);
  return BigInt(raw);
}

const log = (event: string, extra: Record<string, unknown> = {}): void => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: "serve-all", event, ...extra }));
};

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(resolve(here, "../package.json"), "utf8")) as { version: string };

const httpPort = positivePort(process.env.EVM_RPC_PORT ?? "8545", "EVM_RPC_PORT");
const host = process.env.EVM_RPC_HOST ?? "0.0.0.0";
const chainId = nonNegativeInteger(process.env.CHAIN_ID ?? "2400", "CHAIN_ID");
const indexerUrl = process.env.INDEXER_URL ?? "http://127.0.0.1:10001/api/v4/graphql";
const logsEnv = loadEnv(); // INDEXER_WS, PG_URL, EVM_RPC_SCHEMA, EVM_RPC_WS_PORT, WATCH_CONTRACTS_FILE

const indexer = new IndexerGqlClient({ url: indexerUrl });
const dbReader = createPostgresEvmRpcReader(logsEnv.pgUrl);
const sql = createClient({ connectionString: logsEnv.pgUrl, schema: logsEnv.schema });

// --- Part B: HTTP JSON-RPC ---
registerStaticMethods(defaultRegistry);
registerBlockMethods(defaultRegistry);
registerAccountMethods(defaultRegistry);
registerTransactionMethods(defaultRegistry);

// --- Part C: eth_getLogs, backfill, ingest, WS ---
registerGetLogs({
  sql,
  schema: logsEnv.schema,
  resolveLatestBlock: async () => {
    const head = await indexer.getLatestBlock();
    if (head === undefined) throw new Error("indexer returned no latest block");
    return head.height;
  },
});
await backfillWatched(sql, logsEnv.schema, logsEnv.watchContracts);
const ingest = startIngest({
  sql,
  schema: logsEnv.schema,
  indexerWs: logsEnv.indexerWs,
  contracts: logsEnv.watchContracts,
  onError: (error, entry) => log("ingest-error", { message: error.message, contract: entry.address }),
});
const wsServer = createSubscribeServer({
  port: logsEnv.evmRpcWsPort,
  sql,
  schema: logsEnv.schema,
  onError: (error: Error) => log("ws-error", { message: error.message }),
});

const server = createRpcServer({
  registry: defaultRegistry,
  ctx: {
    chainId,
    clientVersion: `umbradb-evm-rpc/${pkg.version}`,
    indexer,
    db: dbReader,
  },
});

await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(httpPort, host, resolveListen);
});
log("listening", {
  http: `http://${host}:${httpPort}`,
  ws: `ws://${host}:${logsEnv.evmRpcWsPort}`,
  chainId: Number(chainId),
  watched: logsEnv.watchContracts.length,
});

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  log("stopping");
  ingest.stop();
  void (async () => {
    try {
      await ingest.done;
    } catch {
      // ingest reported its own errors via onError
    }
    await new Promise<void>((r) => server.close(() => r()));
    await wsServer.close();
    await dbReader.sql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
    process.exitCode = 0;
  })();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
