/**
 * The browser engine's JSON RPC module: the EVM JSON-RPC module's read-only methods (`evm-rpc/read-only.ts`, the
 * methods `npm run evm-rpc` serves) answered inside the worker through the handler Node's server uses
 * (`evm-rpc/handler.ts`), so a request gets the answer Node gives for the same indexer answers.
 *
 * - **Requests**: {@link JsonRpcModule.handle} takes one JSON-RPC 2.0 request body, as Node's server takes a `POST`
 *   body, and answers what Node's server answers: the HTTP status, the headers and the body (a request or a batch, the
 *   1 MiB size cap, notifications answered 204 with no body).
 * - **Blocks and transactions** come from the network's Midnight indexer (GraphQL, the build's indexer URL), as in
 *   Node. Every indexer request first waits for its turn in a pacing queue (`pacing-queue.ts`: requests to a public
 *   endpoint start 250 ms apart, as the archive sync spaces its own) and only then starts, with its own timeout (Node's,
 *   20 s), so waiting never uses up a request's time.
 * - **Bounds**: at most {@link JSONRPC_MAX_REQUESTS} requests are answered at once; another one is refused at once
 *   ({@link JsonRpcModuleError} `busy`), never answered with an error of the module's own. A batch dispatches at most
 *   8 entries at a time, so at most 64 indexer requests ever wait for their turn.
 * - **The `evm_rpc` database** is a PGlite database in memory, made by the module's own migrations
 *   (`src/postgres/migrations/evm_rpc`) when the module starts and closed when it stops. It is empty: the wallet monitor
 *   and the relayer that fill it in Node do not run here, so its methods answer as an empty Node deployment does.
 *   Nothing of it is stored, and the engine's store (its tables, its snapshots) is not touched.
 * - **Configuration**: the chain ID is Node's default ({@link JSONRPC_CHAIN_ID}) and the client version
 *   `umbradb-evm-rpc/<package version>`, as Node reports it.
 */
import type { Sql } from "postgres";
import { defaultMinIntervalMs } from "../../chain-archive-sync/polite-http.js";
import { BATCH_CONCURRENCY, handleHttpRequest, type HttpAnswer, textBody } from "../../evm-rpc/handler.js";
import { IndexerGqlClient } from "../../evm-rpc/indexer-gql.js";
import { registerReadOnlyMethods } from "../../evm-rpc/read-only.js";
import { PostgresEvmRpcReader } from "../../evm-rpc/reader.js";
import { MethodRegistry, type RpcContext } from "../../evm-rpc/registry.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { EVM_RPC_SCHEMA, evmRpcMigrations } from "../../src/postgres/migrations/evm_rpc/index.js";
import { openPgliteClient } from "../../src/postgres/pglite-sql.js";
import { PacingQueue } from "./pacing-queue.ts";

/** The chain ID the module reports (`eth_chainId`, `net_version`): Node's default `CHAIN_ID`. */
export const JSONRPC_CHAIN_ID = 2400n;

/** The most requests the module answers at once. */
export const JSONRPC_MAX_REQUESTS = 8;

/** A request the module did not answer: `busy` (it was answering {@link JSONRPC_MAX_REQUESTS} requests), `stopped` (the
 *  module was closed before the request was answered, or before it came). */
export class JsonRpcModuleError extends Error {
  constructor(readonly code: "busy" | "stopped", message: string) {
    super(message);
    this.name = "JsonRpcModuleError";
  }
}

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
  /** The least time between two indexer requests' starts. Default: 250 ms for a public endpoint, else 0
   *  (`polite-http.ts`). */
  minIntervalMs?: number;
  /** Each indexer request's timeout, from its start. Default: Node's (20 s). */
  indexerTimeoutMs?: number;
  /** Opens the module's `evm_rpc` database. Default {@link openEvmRpcDatabase}. */
  openDatabase?: () => Promise<UmbraDBSql>;
}

export interface JsonRpcModule {
  /** The methods the module serves, from its registry (sorted). */
  readonly methods: readonly string[];
  /** Answers one request body as Node's server answers a `POST` with it; rejects with {@link JsonRpcModuleError} when
   *  the module is busy or stopped. */
  handle(body: string): Promise<HttpAnswer>;
  /** Stops the module: requests are refused from now on, the ones waiting for the indexer end at once (refused
   *  `stopped`), and the `evm_rpc` database is closed once no request reads it. */
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
  const stopped = (): JsonRpcModuleError => new JsonRpcModuleError("stopped", "the JSON RPC module is stopped");
  // Aborted when the module stops: ends the waits for a turn and the indexer requests in flight.
  const stopping = new AbortController();
  const turns = new PacingQueue({ minIntervalMs: opts.minIntervalMs ?? defaultMinIntervalMs(opts.indexerUrl), maxWaiting: JSONRPC_MAX_REQUESTS * BATCH_CONCURRENCY });
  const base = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    base(input, { ...init, signal: init?.signal == null ? stopping.signal : AbortSignal.any([init.signal, stopping.signal]) })) as typeof fetch;
  const ctx: RpcContext = {
    chainId: opts.chainId ?? JSONRPC_CHAIN_ID,
    clientVersion: opts.clientVersion,
    indexer: new IndexerGqlClient({
      url: opts.indexerUrl,
      fetchImpl,
      ...(opts.indexerTimeoutMs === undefined ? {} : { timeoutMs: opts.indexerTimeoutMs }),
      beforeRequest: () => turns.admit(stopping.signal),
    }),
    db: new PostgresEvmRpcReader(sql as unknown as Sql<{ bigint: bigint }>),
  };
  let closing: Promise<void> | undefined;
  let inFlight = 0;
  let drained: (() => void) | undefined;
  return {
    methods: registry.listMethods(),
    async handle(body: string): Promise<HttpAnswer> {
      if (closing !== undefined) throw stopped();
      if (inFlight >= JSONRPC_MAX_REQUESTS)
        throw new JsonRpcModuleError("busy", `the JSON RPC module is answering ${JSONRPC_MAX_REQUESTS} requests: try again once one is answered`);
      inFlight++;
      try {
        const answer = await handleHttpRequest("POST", textBody(body), registry, ctx);
        // Stopped while it was answered: its indexer requests may have been cut short, so its answer is not Node's.
        if (closing !== undefined) throw stopped();
        return answer;
      } finally {
        inFlight--;
        if (inFlight === 0) drained?.();
      }
    },
    close(): Promise<void> {
      closing ??= (async () => {
        const reason = stopped();
        stopping.abort(reason);
        turns.close(reason);
        if (inFlight > 0) await new Promise<void>((resolve) => (drained = resolve));
        await sql.end({ timeout: 5 });
      })();
      return closing;
    },
  };
}
