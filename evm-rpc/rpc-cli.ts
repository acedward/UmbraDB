import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPostgresEvmRpcReader, emptyEvmRpcReader } from "./db.js";
import { IndexerGqlClient } from "./indexer-gql.js";
import { registerAccountMethods } from "./methods/accounts.js";
import { registerBlockMethods } from "./methods/blocks.js";
import { registerStaticMethods } from "./methods/static.js";
import { registerTransactionMethods } from "./methods/transactions.js";
import { defaultRegistry } from "./registry.js";
import { createRpcServer } from "./server.js";

function positivePort(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a TCP port`);
  return value;
}

function nonNegativeInteger(raw: string, name: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} must be a non-negative decimal integer`);
  return BigInt(raw);
}

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(resolve(here, "../package.json"), "utf8")) as { version: string };
const port = positivePort(process.env.EVM_RPC_PORT ?? "8545", "EVM_RPC_PORT");
const host = process.env.EVM_RPC_HOST ?? "0.0.0.0";
const chainId = nonNegativeInteger(process.env.CHAIN_ID ?? "2400", "CHAIN_ID");
const indexerUrl = process.env.INDEXER_URL ?? "http://127.0.0.1:10001/api/v4/graphql";
const postgresReader = process.env.PG_URL === undefined ? undefined : createPostgresEvmRpcReader(process.env.PG_URL);

registerStaticMethods(defaultRegistry);
registerBlockMethods(defaultRegistry);
registerAccountMethods(defaultRegistry);
registerTransactionMethods(defaultRegistry);

const server = createRpcServer({
  registry: defaultRegistry,
  ctx: {
    chainId,
    clientVersion: `umbradb-evm-rpc/${pkg.version}`,
    indexer: new IndexerGqlClient({ url: indexerUrl }),
    db: postgresReader ?? emptyEvmRpcReader,
  },
});

function publicEndpointLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<configured>";
  }
}

await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolveListen);
});
// eslint-disable-next-line no-console
console.log(`[evm-rpc] listening on http://${host}:${port} chainId=${chainId} indexer=${publicEndpointLabel(indexerUrl)} pg=${postgresReader === undefined ? "disabled" : "enabled"}`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    if (postgresReader !== undefined) await postgresReader.sql.end({ timeout: 5 });
    process.exitCode = 0;
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
