/**
 * A minimal `graphql-transport-ws` client, on Node's built-in global `WebSocket` (undici).
 *
 * Only the message types the indexer's subscription actually uses are implemented:
 * `connection_init` / `connection_ack`, `subscribe`, `next`, `error`, `complete`, and the
 * `ping`/`pong` keepalive. No `graphql-ws` package, no `subscriptions-transport-ws` legacy protocol
 * (a different, incompatible wire format that shares the name closely enough to be a trap).
 *
 * Reconnection is the reason this is a function taking a *factory* rather than a plain
 * subscribe call: on every (re)connect the variables are rebuilt, so the ingester resumes from the
 * cursor as it stands NOW rather than from the value captured when the process started.
 */

/** The subset of the `WebSocket` API used here — narrow enough for a test double to implement. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export const GRAPHQL_TRANSPORT_WS = "graphql-transport-ws";

const defaultWebSocketFactory: WebSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

export interface SubscriptionRequest {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
}

export interface RunSubscriptionOptions<T> {
  url: string;
  /** Rebuilt on every (re)connect so a resume cursor is always current. */
  request: () => SubscriptionRequest | Promise<SubscriptionRequest>;
  /** One `next` payload's `data`. Awaited — backpressure is the handler's to apply. */
  onData: (data: T) => Promise<void> | void;
  /** Non-fatal: a transport drop, or a GraphQL `error` message. The subscription then reconnects. */
  onError?: (error: Error) => void;
  /** The server sent `complete` (e.g. the filter's `toBlock` was reached). Ends the run. */
  onComplete?: () => void;
  /** Called after each successful `connection_ack`. */
  onConnected?: () => void;
  connectionInitPayload?: unknown;
  /** Backoff before reconnect attempt `attempt` (1-based). Default: 250ms doubling, capped at 10s. */
  reconnectDelayMs?: (attempt: number) => number;
  /** Bound on waiting for `connection_ack`. Default 15s. */
  ackTimeoutMs?: number;
  webSocketFactory?: WebSocketFactory;
  signal?: AbortSignal;
}

export interface SubscriptionHandle {
  /** Resolves once the run has stopped (aborted, or the server completed). */
  readonly done: Promise<void>;
  stop(): void;
}

const defaultBackoff = (attempt: number): number => Math.min(250 * 2 ** (attempt - 1), 10_000);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs one subscription, reconnecting until stopped or completed.
 *
 * Delivery is serialised: `onData` is awaited before the next `next` message is processed, so an
 * ingester writing to Postgres cannot be overtaken by the socket. Messages arriving while a handler
 * is in flight queue in order.
 */
export function runSubscription<T>(options: RunSubscriptionOptions<T>): SubscriptionHandle {
  const controller = new AbortController();
  const signal = options.signal;
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const backoff = options.reconnectDelayMs ?? defaultBackoff;
  const factory = options.webSocketFactory ?? defaultWebSocketFactory;
  const ackTimeoutMs = options.ackTimeoutMs ?? 15_000;

  const done = (async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      let completed = false;
      try {
        completed = await runOnce();
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      if (completed || controller.signal.aborted) break;
      attempt += 1;
      await sleep(backoff(attempt), controller.signal);
    }
  })();

  /** One connect→subscribe→drain cycle. Resolves `true` when the server said `complete`. */
  async function runOnce(): Promise<boolean> {
    const request = await options.request();
    if (controller.signal.aborted) return true;

    const socket = factory(options.url, [GRAPHQL_TRANSPORT_WS]);
    const subscriptionId = "1";

    // A serial queue: each `next` is handled to completion before the next one starts, and any
    // handler rejection tears the connection down rather than becoming an unhandled rejection.
    let chain: Promise<void> = Promise.resolve();
    let handlerError: Error | undefined;

    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let acked = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(ackTimer);
        controller.signal.removeEventListener("abort", onAbort);
        try {
          socket.close(1000, "done");
        } catch {
          /* already closing */
        }
        fn();
      };

      const ackTimer = setTimeout(() => {
        finish(() => reject(new Error(`graphql-ws: no connection_ack within ${ackTimeoutMs}ms`)));
      }, ackTimeoutMs);

      const onAbort = (): void => finish(() => resolve(true));
      controller.signal.addEventListener("abort", onAbort, { once: true });

      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "connection_init",
            ...(options.connectionInitPayload === undefined
              ? {}
              : { payload: options.connectionInitPayload }),
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        let message: { type?: string; id?: string; payload?: unknown };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          finish(() => reject(new Error("graphql-ws: server sent malformed JSON")));
          return;
        }

        switch (message.type) {
          case "connection_ack":
            acked = true;
            clearTimeout(ackTimer);
            options.onConnected?.();
            socket.send(
              JSON.stringify({ id: subscriptionId, type: "subscribe", payload: request }),
            );
            return;
          case "ping":
            socket.send(JSON.stringify({ type: "pong", payload: message.payload }));
            return;
          case "pong":
            return;
          case "next": {
            const payload = message.payload as { data?: T; errors?: unknown[] } | undefined;
            if (payload?.errors !== undefined && payload.errors.length > 0) {
              finish(() =>
                reject(new Error(`graphql-ws: query errors: ${JSON.stringify(payload.errors)}`)),
              );
              return;
            }
            if (payload?.data === undefined) return;
            const data = payload.data;
            chain = chain.then(async () => {
              if (handlerError !== undefined || settled) return;
              try {
                await options.onData(data);
              } catch (error) {
                handlerError = error instanceof Error ? error : new Error(String(error));
                finish(() => reject(handlerError!));
              }
            });
            return;
          }
          case "error":
            finish(() =>
              reject(new Error(`graphql-ws: subscription error: ${JSON.stringify(message.payload)}`)),
            );
            return;
          case "complete":
            // Drain whatever is already queued before declaring the run finished, so a final
            // batch is never dropped on the floor.
            void chain.then(() => {
              options.onComplete?.();
              finish(() => resolve(true));
            });
            return;
          default:
            return;
        }
      });

      socket.addEventListener("error", () => {
        // The `close` event follows; a bare `error` carries no useful detail in undici.
        if (!acked) finish(() => reject(new Error("graphql-ws: socket error before connection_ack")));
      });

      socket.addEventListener("close", (closeEvent) => {
        void chain.then(() => {
          finish(() =>
            handlerError !== undefined
              ? reject(handlerError)
              : reject(
                  new Error(
                    `graphql-ws: connection closed (code ${String(closeEvent.code ?? "?")})`,
                  ),
                ),
          );
        });
      });
    });
  }

  return {
    done,
    stop() {
      controller.abort();
    },
  };
}
