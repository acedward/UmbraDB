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
import { loadTokenMeta, registerErc20Call } from "./methods/erc20-call.js";
import { defaultRegistry, RpcError } from "./registry.js";
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

// --- Part E: eth_sendRawTransaction (write path) ---
// The relayer (evm-relayer repo) runs as its own process — separate dependency tree (midnight-js
// providers, Compact managed contract) that we deliberately don't import here. It exposes
// POST /eth_sendRawTransaction {rawTx}. Wired only when RELAY_URL is set, so the read-path
// service still runs standalone.
const relayUrl = process.env.RELAY_URL;
if (relayUrl !== undefined) {
  defaultRegistry.registerMethod("eth_sendRawTransaction", async (params) => {
    const list = Array.isArray(params) ? params : params === undefined ? [] : [params];
    if (typeof list[0] !== "string") throw new Error("expected [rawTxHex]");
    const resp = await fetch(`${relayUrl}/eth_sendRawTransaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawTx: list[0] }),
    });
    const body = (await resp.json()) as { result?: string; error?: string; code?: number };
    if (!resp.ok || body.error !== undefined) {
      throw new RpcError(body.code ?? -32000, body.error ?? `relayer HTTP ${resp.status}`);
    }
    return body.result;
  });
  log("relay-wired", { relayUrl });
}

// --- Demo bridge: token balance shown as NIGHT (env DEMO_TOKEN_AS_NIGHT=1) ---
// MetaMask's account number is eth_getBalance = NATIVE NIGHT, which an eth-keyed demo user
// never holds (the relayer pays all fees). With this flag, eth_getBalance ADDS the address's
// token balance folded from Transfer logs (received − sent, ×10^18) on top of the native value,
// so minted/transferred tokens are visible as the account balance in MetaMask. DEMO semantics —
// it deliberately conflates native and token value; never enable outside a demo stack.
if (process.env.DEMO_TOKEN_AS_NIGHT === "1") {
  const native = defaultRegistry.getMethod("eth_getBalance");
  if (native === undefined) throw new Error("eth_getBalance not registered yet");
  defaultRegistry.registerMethod(
    "eth_getBalance",
    async (params, ctx) => {
      const nativeHex = (await native(params, ctx)) as string;
      const first = Array.isArray(params) ? params[0] : undefined;
      if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) return nativeHex;
      const addrHex = first.slice(2).toLowerCase();
      const rows = await sql<{ dir: string; amount_hex: string }[]>`
        SELECT CASE WHEN topic1 = decode(${"0".repeat(24) + addrHex}, 'hex')
                     AND topic2 = decode(${"0".repeat(24) + addrHex}, 'hex') THEN 'self'
                    WHEN topic2 = decode(${"0".repeat(24) + addrHex}, 'hex') THEN 'in'
                    ELSE 'out' END AS dir,
               encode(data, 'hex') AS amount_hex
        FROM ${sql(logsEnv.schema)}.logs
        WHERE topic0 = decode(${"ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"}, 'hex')
          AND (topic1 = decode(${"0".repeat(24) + addrHex}, 'hex')
               OR topic2 = decode(${"0".repeat(24) + addrHex}, 'hex'))
      `;
      let token = 0n;
      for (const r of rows) {
        if (r.dir === "self") continue; // self-transfer nets zero
        const v = r.amount_hex.length === 0 ? 0n : BigInt(`0x${r.amount_hex}`);
        token += r.dir === "in" ? v : -v;
      }
      if (token < 0n) token = 0n; // defensive floor
      const total = BigInt(nativeHex) + token * 10n ** 18n;
      return `0x${total.toString(16)}`;
    },
    { replace: true },
  );
  log("demo-token-as-night", { enabled: true });
}

// --- eth_call for ERC20 views (lets MetaMask import/display/send the watched tokens) ---
const tokens = loadTokenMeta(process.env.WATCH_CONTRACTS_FILE ?? "./watch.json");
registerErc20Call({ registry: defaultRegistry, sql, schema: logsEnv.schema, tokens });
log("erc20-call-registered", {
  tokens: tokens.map((t) => ({ symbol: t.symbol, evmAddr: `0x${t.evmAddr}`, decimals: t.decimals })),
});

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
const wsServer = createSubscribeServer({
  port: logsEnv.evmRpcWsPort,
  sql,
  schema: logsEnv.schema,
  onError: (error: Error) => log("ws-error", { message: error.message }),
});
const ingest = startIngest({
  sql,
  schema: logsEnv.schema,
  indexerWs: logsEnv.indexerWs,
  contracts: logsEnv.watchContracts,
  // Post-commit rows feed live eth_subscribe("logs") tails — see IngestEvents.onCommitted.
  onCommitted: (rows) => wsServer.publishLogs(rows),
  onError: (error, entry) => log("ingest-error", { message: error.message, contract: entry.address }),
});
await wsServer.listen();

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
