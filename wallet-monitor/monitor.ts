import { createClient } from "../src/postgres/client.js";
import { pathToFileURL } from "node:url";
import { watchedAddressesFromEnv } from "./address.js";
import { bootstrapEvmRpcSchema } from "./bootstrap.js";
import { jsonLog, publicEndpoint } from "./log.js";
import { WalletMonitorStore } from "./store.js";
import { subscribeUnshieldedTransactions } from "./subscription.js";

function defaultWsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}

export async function runWalletMonitor(signal: AbortSignal): Promise<void> {
  const connectionString = process.env.ARCHIVE_PG;
  if (!connectionString) throw new Error("ARCHIVE_PG is required (a Postgres connection string for the monitor DB)");
  const schema = process.env.EVM_RPC_SCHEMA ?? "evm_rpc";
  const indexerUrl = process.env.INDEXER_URL ?? "http://127.0.0.1:10001/api/v4/graphql";
  const indexerWs = process.env.INDEXER_WS ?? defaultWsUrl(indexerUrl);
  const addresses = watchedAddressesFromEnv();

  const sql = createClient({ connectionString, schema });
  try {
    await bootstrapEvmRpcSchema(sql, schema);
    const store = new WalletMonitorStore(sql, schema);
    jsonLog("wallet-monitor", "start", { schema, indexerWs: publicEndpoint(indexerWs), addresses });
    await Promise.all(addresses.map(async (address) => {
      await subscribeUnshieldedTransactions({
        url: indexerWs,
        address,
        signal,
        getCursor: () => store.getCursor(address),
        onEvent: async (event) => {
          await store.processEvent(address, event);
          if (event.__typename === "UnshieldedTransaction") {
            jsonLog("wallet-monitor", "transaction", {
              address,
              transactionId: event.transaction.id,
              hash: event.transaction.hash,
              created: event.createdUtxos.length,
              spent: event.spentUtxos.length,
            });
          } else {
            jsonLog("wallet-monitor", "progress", { address, transactionId: event.highestTransactionId });
          }
        },
        onReconnect: (error, retryMs) => {
          jsonLog("wallet-monitor", "reconnect", { address, message: String(error), retryMs });
        },
      });
    }));
  } finally {
    jsonLog("wallet-monitor", "stop");
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await runWalletMonitor(controller.signal);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
