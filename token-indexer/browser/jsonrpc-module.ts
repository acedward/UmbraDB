/**
 * The browser engine's JSON RPC module: the EVM JSON-RPC module's read-only methods (`evm-rpc/read-only.ts`, the
 * methods `npm run evm-rpc` serves) answered inside the worker through the handler Node's server uses
 * (`evm-rpc/handler.ts`), so a request gets the answer Node gives for the same indexer answers.
 *
 * - **Requests**: {@link JsonRpcModule.handle} takes one JSON-RPC 2.0 request body, as Node's server takes a `POST`
 *   body, and answers what Node's server answers: the HTTP status, the headers and the body (a request or a batch, the
 *   1 MiB size cap, notifications answered 204 with no body).
 * - **Blocks and transactions** come from the network's Midnight indexer (GraphQL, the build's indexer URL), as in
 *   Node. Requests to a public endpoint are spaced as the archive sync spaces its own (`polite-http.ts`).
 * - **The `evm_rpc` database** is a PGlite database in memory, made by the module's own migrations
 *   (`src/postgres/migrations/evm_rpc`) when the module starts and closed when it stops. It is empty: the wallet monitor
 *   and the relayer that fill it in Node do not run here, so its methods answer as an empty Node deployment does.
 *   Nothing of it is stored, and the engine's store (its tables, its snapshots) is not touched.
 * - **Configuration**: the chain ID is Node's default ({@link JSONRPC_CHAIN_ID}) and the client version
 *   `umbradb-evm-rpc/<package version>`, as Node reports it.
 */
import type { Sql } from "postgres";
import { defaultMinIntervalMs, RequestPacer } from "../../chain-archive-sync/polite-http.js";
import { handleHttpRequest, type HttpAnswer, textBody } from "../../evm-rpc/handler.js";
import { IndexerGqlClient } from "../../evm-rpc/indexer-gql.js";
import { registerReadOnlyMethods } from "../../evm-rpc/read-only.js";
import { PostgresEvmRpcReader } from "../../evm-rpc/reader.js";
import { MethodRegistry, type RpcContext } from "../../evm-rpc/registry.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { EVM_RPC_SCHEMA, evmRpcMigrations } from "../../src/postgres/migrations/evm_rpc/index.js";
import { openPgliteClient } from "../../src/postgres/pglite-sql.js";

/** The chain ID the module reports (`eth_chainId`, `net_version`): Node's default `CHAIN_ID`. */
export const JSONRPC_CHAIN_ID = 2400n;

/** The client version the module reports (`web3_clientVersion`) for a package version, as Node reports it. */
export const jsonRpcClientVersion = (packageVersion: string): string => `umbradb-evm-rpc/${packageVersion}`;

export interface JsonRpcModuleOptions {
  /** The network's Midnight indexer (GraphQL). */
  indexerUrl: string;
  /** `web3_clientVersion`'s answer ({@link jsonRpcClientVersion}). */
  clientVersion: string;
  /** Default {@link JSONRPC_CHAIN_ID}. */
  chainId?: bigint;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Opens the module's `evm_rpc` database. Default {@link openEvmRpcDatabase}. */
  openDatabase?: () => Promise<UmbraDBSql>;
}

export interface JsonRpcModule {
  /** The methods the module serves, from its registry (sorted). */
  readonly methods: readonly string[];
  /** Answers one request body as Node's server answers a `POST` with it. */
  handle(body: string): Promise<HttpAnswer>;
  /** Closes the `evm_rpc` database; later requests are refused. */
  close(): Promise<void>;
}

/** A new, empty PGlite database in memory with a client of the `evm_rpc` schema. */
export function openEvmRpcDatabase(): Promise<UmbraDBSql> {
  return openPgliteClient({ schema: EVM_RPC_SCHEMA });
}

/** Opens the module's database, runs its migrations and makes the handler's registry and context. */
export async function startJsonRpcModule(opts: JsonRpcModuleOptions): Promise<JsonRpcModule> {
  const sql = await (opts.openDatabase ?? openEvmRpcDatabase)();
  try {
    await runMigrations(sql, { schema: EVM_RPC_SCHEMA, migrations: evmRpcMigrations });
  } catch (e) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw e;
  }
  const registry = new MethodRegistry();
  registerReadOnlyMethods(registry);
  const pacer = new RequestPacer(defaultMinIntervalMs(opts.indexerUrl));
  const base = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const paced = (async (input: RequestInfo | URL, init?: RequestInit) => {
    await pacer.wait();
    return base(input, init);
  }) as typeof fetch;
  const ctx: RpcContext = {
    chainId: opts.chainId ?? JSONRPC_CHAIN_ID,
    clientVersion: opts.clientVersion,
    indexer: new IndexerGqlClient({ url: opts.indexerUrl, fetchImpl: paced }),
    db: new PostgresEvmRpcReader(sql as unknown as Sql<{ bigint: bigint }>),
  };
  let closed = false;
  return {
    methods: registry.listMethods(),
    async handle(body: string): Promise<HttpAnswer> {
      if (closed) throw new Error("the JSON RPC module is stopped");
      return handleHttpRequest("POST", textBody(body), registry, ctx);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await sql.end({ timeout: 5 });
    },
  };
}
