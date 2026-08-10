/**
 * C-G4 — `eth_subscribe` / `eth_unsubscribe` over WebSocket, on `EVM_RPC_WS_PORT` (10021).
 *
 * Two subscription kinds:
 *   - `logs` — fed by the ingester's POST-COMMIT tail (`IngestOptions.onCommitted`). Feeding from
 *     after the commit rather than from the mapper means a subscriber is never told about a log that
 *     a rolled-back transaction then erased.
 *   - `newHeads` — fed by a {@link BlockSource}. Part C owns no chain head (Part B does), so the
 *     default source polls the distinct `(block_number, block_hash)` pairs present in
 *     `evm_rpc.logs`. That is honest about what this part actually knows; at the Part F merge a real
 *     head source is injected here and nothing else changes.
 *
 * Any OTHER JSON-RPC method arriving on this socket is delegated to the registry (Part B's, via the
 * shim). Part C deliberately does not implement `eth_chainId`, `eth_blockNumber` and friends — those
 * are Part B's, and squatting on them would create exactly the duplicate-registration conflict the
 * merge has to avoid.
 */

import { createWebSocketServer, type WsConnection, type WsServer } from "./ws.js";
import { getMethod, JsonRpcError } from "../registry-shim.js";
import { toHex, type LogRow } from "./event-map.js";
import { matchesFilter, parseSubscriptionFilter, type SubscriptionFilter } from "./log-filter.js";
import type { SqlLike } from "./address-map.js";
import type { RpcLog } from "./get-logs.js";

/** The `newHeads` payload. A minimal EVM header — enough for a client to observe progress. */
export interface BlockHeader {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  [extra: string]: unknown;
}

export interface BlockSource {
  /** Starts producing headers. Returns a stop function. */
  start(emit: (header: BlockHeader) => void): () => void;
}

export interface SubscribeServerOptions {
  port: number;
  host?: string;
  blockSource?: BlockSource;
  /** Required only when relying on the default, `logs`-table-derived block source. */
  sql?: SqlLike;
  schema?: string;
  /** Poll interval for the default block source. Default 1000ms. */
  blockPollMs?: number;
  onError?: (error: Error) => void;
}

interface Subscription {
  id: string;
  kind: "logs" | "newHeads";
  filter?: SubscriptionFilter;
  connection: WsConnection;
}

export interface SubscribeServer {
  listen(): Promise<number>;
  close(): Promise<void>;
  /** Publishes committed rows to matching `logs` subscribers. Called from the ingester. */
  publishLogs(rows: readonly LogRow[]): void;
  publishHead(header: BlockHeader): void;
  readonly subscriptionCount: number;
}

const quantity = (value: number | bigint): string => `0x${value.toString(16)}`;

/** Renders a mapped row into the `eth_subscribe("logs")` payload — the same shape `eth_getLogs`
 *  returns, so a client can use one decoder for both. */
export function rowToRpcLog(row: LogRow): RpcLog {
  return {
    address: `0x${toHex(row.address)}`,
    topics: row.topics.map((topic) => `0x${toHex(topic)}`),
    data: `0x${toHex(row.data)}`,
    blockNumber: quantity(row.blockNumber),
    blockHash: `0x${toHex(row.blockHash)}`,
    transactionHash: `0x${toHex(row.txHash)}`,
    transactionIndex: quantity(row.txIndex),
    logIndex: quantity(row.logIndex),
    removed: row.removed,
  };
}

/**
 * The default `newHeads` source: polls `evm_rpc.logs` for block coordinates it has not yet
 * announced. Deliberately limited — it can only ever see blocks that produced a watched log, which
 * is why this is injectable rather than authoritative.
 */
export function createLogsTableBlockSource(
  sql: SqlLike,
  schema: string,
  pollMs = 1_000,
): BlockSource {
  return {
    start(emit) {
      let lastAnnounced = -1n;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const poll = async (): Promise<void> => {
        const rows = await sql<{ block_number: bigint; block_hash: Buffer }[]>`
          SELECT DISTINCT block_number, block_hash FROM ${sql(schema)}.logs
          WHERE block_number > ${lastAnnounced}
          ORDER BY block_number
        `;
        for (const row of rows) {
          if (stopped) return;
          lastAnnounced = row.block_number;
          emit({
            number: quantity(row.block_number),
            hash: `0x${toHex(row.block_hash)}`,
            // Part C has no parent linkage; a real head source supplies it at the Part F merge.
            parentHash: `0x${"00".repeat(32)}`,
            timestamp: "0x0",
          });
        }
      };

      const loop = (): void => {
        if (stopped) return;
        void poll()
          .catch(() => {
            /* a transient query failure must not kill the poller */
          })
          .finally(() => {
            if (stopped) return;
            timer = setTimeout(loop, pollMs);
            timer.unref?.();
          });
      };
      loop();

      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    },
  };
}

export function createSubscribeServer(options: SubscribeServerOptions): SubscribeServer {
  const subscriptions = new Map<string, Subscription>();
  let nextSubscriptionId = 1;
  let stopBlockSource: (() => void) | undefined;

  const blockSource =
    options.blockSource ??
    (options.sql !== undefined && options.schema !== undefined
      ? createLogsTableBlockSource(options.sql, options.schema, options.blockPollMs)
      : undefined);

  const notify = (subscription: Subscription, result: unknown): void => {
    subscription.connection.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: { subscription: subscription.id, result },
      }),
    );
  };

  const server: WsServer = createWebSocketServer({
    onConnection(connection) {
      connection.onMessage((text) => {
        void handleMessage(connection, text);
      });
      connection.onClose(() => {
        // Drop every subscription belonging to this socket, so a reconnecting client does not leave
        // publishers writing into a dead connection forever.
        for (const [id, subscription] of [...subscriptions]) {
          if (subscription.connection === connection) subscriptions.delete(id);
        }
      });
    },
  });

  async function handleMessage(connection: WsConnection, text: string): Promise<void> {
    let request: { id?: unknown; method?: string; params?: unknown[] };
    try {
      request = JSON.parse(text) as typeof request;
    } catch {
      connection.send(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      );
      return;
    }
    const id = request.id ?? null;
    const params = Array.isArray(request.params) ? request.params : [];

    const respond = (result: unknown): void => {
      connection.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    };
    const fail = (code: number, message: string): void => {
      connection.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
    };

    try {
      if (request.method === "eth_subscribe") {
        const kind = params[0];
        if (kind === "logs") {
          const subscription: Subscription = {
            id: quantity(nextSubscriptionId++),
            kind: "logs",
            filter: parseSubscriptionFilter(params[1]),
            connection,
          };
          subscriptions.set(subscription.id, subscription);
          respond(subscription.id);
          return;
        }
        if (kind === "newHeads") {
          const subscription: Subscription = {
            id: quantity(nextSubscriptionId++),
            kind: "newHeads",
            connection,
          };
          subscriptions.set(subscription.id, subscription);
          respond(subscription.id);
          return;
        }
        fail(-32602, `unsupported subscription type: ${String(kind)}`);
        return;
      }

      if (request.method === "eth_unsubscribe") {
        const target = params[0];
        // geth returns false (not an error) for an unknown id.
        respond(typeof target === "string" ? subscriptions.delete(target) : false);
        return;
      }

      // Everything else belongs to Part B; the registry is the single owner of those methods.
      const handler = request.method === undefined ? undefined : getMethod(request.method);
      if (handler === undefined) {
        fail(-32601, `method not found: ${String(request.method)}`);
        return;
      }
      respond(await handler(params));
    } catch (error) {
      if (error instanceof JsonRpcError) {
        fail(error.code, error.message);
        return;
      }
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      fail(-32603, "Internal error");
    }
  }

  return {
    get subscriptionCount() {
      return subscriptions.size;
    },
    async listen(): Promise<number> {
      const port = await server.listen(options.port, options.host);
      if (blockSource !== undefined) {
        stopBlockSource = blockSource.start((header) => {
          for (const subscription of subscriptions.values()) {
            if (subscription.kind === "newHeads") notify(subscription, header);
          }
        });
      }
      return port;
    },
    async close(): Promise<void> {
      stopBlockSource?.();
      subscriptions.clear();
      await server.close();
    },
    publishLogs(rows: readonly LogRow[]): void {
      if (subscriptions.size === 0) return;
      const rendered = rows.map(rowToRpcLog);
      for (const subscription of subscriptions.values()) {
        if (subscription.kind !== "logs") continue;
        for (const log of rendered) {
          if (subscription.filter === undefined || matchesFilter(log, subscription.filter)) {
            notify(subscription, log);
          }
        }
      }
    },
    publishHead(header: BlockHeader): void {
      for (const subscription of subscriptions.values()) {
        if (subscription.kind === "newHeads") notify(subscription, header);
      }
    },
  };
}
