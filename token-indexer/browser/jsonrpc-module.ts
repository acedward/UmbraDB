/**
 * The browser engine's JSON RPC module: the EVM JSON-RPC module's read-only methods (`evm-rpc/read-only.ts`, the
 * methods `npm run evm-rpc` serves) answered inside the worker through the handler Node's server uses
 * (`evm-rpc/handler.ts`), so a request gets the answer Node gives for the same indexer answers.
 *
 * - **Requests**: {@link JsonRpcModule.handle} takes one JSON-RPC 2.0 request body, as Node's server takes a `POST`
 *   body, and answers what Node's server answers: the HTTP status, the headers and the body (a request or a batch, the
 *   1 MiB size cap, notifications answered 204 with no body).
 * - **Blocks and transactions** come from the network's Midnight indexer (GraphQL, the build's indexer URL), as in
 *   Node. Every indexer request first waits for its turn in the endpoint's pacing queue (`pacing-queue.ts`; in the
 *   engine the one queue of that origin, shared with the archive sync, so the worker as a whole starts at most one
 *   request every 250 ms on a public endpoint) and only then starts, with its own timeout (Node's, 20 s), so waiting
 *   never uses up a request's time. An answer `429` holds the queue for its `Retry-After` (1 s without one, 60 s at
 *   most, `MAX_HOLD_MS`): no request to that origin starts before then, while a caller that stops (the archive sync's
 *   run, a request of the module that ends) leaves its place at once; the request itself is answered as Node answers
 *   it (`-32603`).
 * - **Bounds**: at most {@link JSONRPC_MAX_REQUESTS} requests are answered at once; another one is refused at once
 *   ({@link JsonRpcModuleError} `busy`), never answered with an error of the module's own. At most
 *   {@link JSONRPC_INDEXER_SLOTS} of the module's indexer requests wait for their turn in the origin's queue or are in
 *   flight at once (a request is in flight until its answer's body is read); the others (8 requests, a batch
 *   dispatching 8 entries at a time) wait in the module, so a burst of calls never fills the queue ahead of the archive
 *   sync.
 * - **The `evm_rpc` database** is a PGlite database in memory, made by the module's own migrations
 *   (`src/postgres/migrations/evm_rpc`) when the module starts and closed when it stops. It is empty: the wallet monitor
 *   and the relayer that fill it in Node do not run here, so its methods answer as an empty Node deployment does.
 *   Nothing of it is stored, and the engine's store (its tables, its snapshots) is not touched.
 * - **Configuration**: the chain ID is the build's (`config.ts`, `UMBRADB_BROWSER_CHAIN_ID`), Node's default
 *   ({@link JSONRPC_CHAIN_ID}) unless the build sets one, as Node's `CHAIN_ID` is; the client version is
 *   `umbradb-evm-rpc/<package version>`, as Node reports it.
 */
import type { Sql } from "postgres";
import { defaultMinIntervalMs, parseRetryAfterMs } from "../../chain-archive-sync/polite-http.js";
import { handleHttpRequest, type HttpAnswer, textBody } from "../../evm-rpc/handler.js";
import { IndexerGqlClient } from "../../evm-rpc/indexer-gql.js";
import { registerReadOnlyMethods } from "../../evm-rpc/read-only.js";
import { PostgresEvmRpcReader } from "../../evm-rpc/reader.js";
import { MethodRegistry, type RpcContext } from "../../evm-rpc/registry.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { EVM_RPC_SCHEMA, evmRpcMigrations } from "../../src/postgres/migrations/evm_rpc/index.js";
import { openPgliteClient } from "../../src/postgres/pglite-sql.js";
import { PacingQueue } from "./pacing-queue.ts";

/** The chain ID the module reports (`eth_chainId`, `net_version`) unless given another: Node's default `CHAIN_ID`. */
export const JSONRPC_CHAIN_ID = 2400n;

/** The most requests the module answers at once. */
export const JSONRPC_MAX_REQUESTS = 8;
/** How long the worker waits for the module's start (an in-memory PGlite, its files fetched from the site, and the
 *  migrations: about a second) before it answers the waiting calls `internal`. The start itself cannot be cut short:
 *  until it ends, later calls are refused at once; once it ends, its late module is closed, and only then does a call
 *  start the module again (`host.ts`). */
export const JSONRPC_START_TIMEOUT_MS = 60_000;
/** The most indexer requests of the module waiting for their turn in the origin's queue or in flight at once. */
export const JSONRPC_INDEXER_SLOTS = 8;

/** `body` read through, calling `done` once when it ends: read to the end, failed, or cancelled by its reader. */
function releasingBody(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let over = false;
  const end = (): void => {
    if (over) return;
    over = true;
    done();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          end();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (e) {
        end();
        controller.error(e);
      }
    },
    async cancel(reason) {
      end();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** At most `n` holders at once, the others waiting in arrival order; a wait ends at once when its signal does. */
class Slots {
  #free: number;
  readonly #waiting: Array<{ resolve: () => void; signal: AbortSignal; onAbort: () => void }> = [];

  constructor(n: number) {
    this.#free = n;
  }

  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        signal,
        onAbort: (): void => {
          const at = this.#waiting.indexOf(waiter);
          if (at >= 0) this.#waiting.splice(at, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#free++;
      return;
    }
    next.signal.removeEventListener("abort", next.onAbort);
    next.resolve();
  }
}

/** How long a `429` without `Retry-After` holds the endpoint's queue (the sync's first back-off). */
export const THROTTLE_HOLD_MS = 1_000;

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
  /** The indexer endpoint's pacing queue, shared with the other clients of that origin (the engine's). Default: a queue
   *  of the module's own, `minIntervalMs` apart. */
  pacer?: PacingQueue;
  /** The least time between two indexer requests' starts in a queue of the module's own. Default: 250 ms for a public
   *  endpoint, else 0 (`polite-http.ts`). */
  minIntervalMs?: number;
  /** Each indexer request's timeout, from its start. Default: Node's (20 s). */
  indexerTimeoutMs?: number;
  /** Opens the module's `evm_rpc` database. Default {@link openEvmRpcDatabase}. */
  openDatabase?: () => Promise<UmbraDBSql>;
  /** The wall clock (ms) of {@link JsonRpcModule.lastIndexerProblem}. Default `Date.now`. */
  now?: () => number;
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
  /** The last indexer request that failed (no answer, or an HTTP status other than 2xx), with its time
   *  (the module's `now`), or `null`. Requests cut short by the module's stop are not counted. */
  lastIndexerProblem(): { at: number; message: string } | null;
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
  const ownTurns = opts.pacer === undefined
    ? new PacingQueue({ minIntervalMs: opts.minIntervalMs ?? defaultMinIntervalMs(opts.indexerUrl), maxWaiting: JSONRPC_INDEXER_SLOTS })
    : undefined;
  const turns = opts.pacer ?? ownTurns!;
  const base = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const origin = ((): string => {
    try {
      return new URL(opts.indexerUrl).origin;
    } catch {
      return "the indexer";
    }
  })();
  let problem: { at: number; message: string } | null = null;
  const now = opts.now ?? Date.now;
  // A slot is taken before the turn (`beforeRequest`) and given back once the request is over: its answer's body read
  // to the end (or failed, or cancelled), or at once when it failed, or for an answer whose body is not read (an HTTP
  // error, which the GraphQL client refuses unread: its body is cancelled).
  const slots = new Slots(JSONRPC_INDEXER_SLOTS);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let response: Response;
    try {
      response = await base(input, { ...init, signal: init?.signal == null ? stopping.signal : AbortSignal.any([init.signal, stopping.signal]) });
    } catch (e) {
      slots.release();
      if (!stopping.signal.aborted) problem = { at: now(), message: `a request to ${origin} failed: ${e instanceof Error ? e.message : String(e)}` };
      throw e;
    }
    if (response.status === 429) turns.holdFor(parseRetryAfterMs(response.headers.get("retry-after")) ?? THROTTLE_HOLD_MS);
    if (!response.ok) problem = { at: now(), message: `${origin} answered HTTP ${response.status}` };
    if (!response.ok || response.body === null) {
      slots.release();
      if (response.body !== null) void response.body.cancel().catch(() => {});
      return response;
    }
    return new Response(releasingBody(response.body, () => slots.release()), { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
  const ctx: RpcContext = {
    chainId: opts.chainId ?? JSONRPC_CHAIN_ID,
    clientVersion: opts.clientVersion,
    indexer: new IndexerGqlClient({
      url: opts.indexerUrl,
      fetchImpl,
      ...(opts.indexerTimeoutMs === undefined ? {} : { timeoutMs: opts.indexerTimeoutMs }),
      beforeRequest: async () => {
        await slots.acquire(stopping.signal);
        try {
          await turns.admit(stopping.signal);
        } catch (e) {
          slots.release();
          throw e;
        }
      },
    }),
    db: new PostgresEvmRpcReader(sql as unknown as Sql<{ bigint: bigint }>),
  };
  let closing: Promise<void> | undefined;
  let inFlight = 0;
  let drained: (() => void) | undefined;
  return {
    methods: registry.listMethods(),
    lastIndexerProblem: () => (problem === null ? null : { ...problem }),
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
        ownTurns?.close(reason);
        if (inFlight > 0) await new Promise<void>((resolve) => (drained = resolve));
        await sql.end({ timeout: 5 });
      })();
      return closing;
    },
  };
}
