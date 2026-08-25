export interface SubscriptionTransaction {
  __typename: string;
  id: number;
  hash: string;
  block: { height: number; hash: string };
  transactionResult?: { status: string };
  fee?: string;
}

export interface SubscriptionUtxo {
  owner: string;
  tokenType: string;
  value: string;
  intentHash: string;
  outputIndex: number;
  ctime: number | null;
  initialNonce: string;
  registeredForDustGeneration: boolean;
  createdAtTransaction: { id: number };
  spentAtTransaction: { id: number } | null;
}

export type UnshieldedSubscriptionEvent =
  | {
      __typename: "UnshieldedTransaction";
      transaction: SubscriptionTransaction;
      createdUtxos: SubscriptionUtxo[];
      spentUtxos: SubscriptionUtxo[];
    }
  | { __typename: "UnshieldedTransactionsProgress"; highestTransactionId: number };

export const UNSHIELDED_SUBSCRIPTION = `
  subscription WatchUnshielded($address: UnshieldedAddress!, $transactionId: Int) {
    unshieldedTransactions(address: $address, transactionId: $transactionId) {
      __typename
      ... on UnshieldedTransaction {
        transaction {
          __typename id hash
          block { height hash }
          ... on RegularTransaction { transactionResult { status } fee }
        }
        createdUtxos {
          owner tokenType value intentHash outputIndex ctime initialNonce registeredForDustGeneration
          createdAtTransaction { id }
          spentAtTransaction { id }
        }
        spentUtxos {
          owner tokenType value intentHash outputIndex ctime initialNonce registeredForDustGeneration
          createdAtTransaction { id }
          spentAtTransaction { id }
        }
      }
      ... on UnshieldedTransactionsProgress { highestTransactionId }
    }
  }
`;

interface SubscribeOptions {
  url: string;
  address: string;
  getCursor: () => Promise<number | undefined>;
  onEvent: (event: UnshieldedSubscriptionEvent) => Promise<void>;
  signal: AbortSignal;
  onReconnect?: (error: unknown, delayMs: number) => void;
  connectionTimeoutMs?: number;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function messageData(event: MessageEvent): string {
  if (typeof event.data === "string") return event.data;
  if (event.data instanceof ArrayBuffer) return Buffer.from(event.data).toString("utf8");
  if (ArrayBuffer.isView(event.data)) return Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString("utf8");
  return String(event.data);
}

async function runConnection(opts: SubscribeOptions, cursor: number | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(opts.url, "graphql-transport-ws");
    let settled = false;
    let subscribed = false;
    let processing = Promise.resolve();
    const handshakeTimer = setTimeout(
      () => finish(new Error("indexer websocket open/ack timeout")),
      opts.connectionTimeoutMs ?? 10_000,
    );
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      opts.signal.removeEventListener("abort", abort);
      try { socket.close(1000, "monitor stopping"); } catch { /* already closed */ }
      if (error === undefined) resolve(); else reject(error);
    };
    const abort = (): void => {
      try { socket.close(1000, "monitor stopping"); } catch { /* already closed */ }
      // Drain the event chain before resolving, so the caller never closes Postgres under an
      // in-flight co-transactional UTXO/balance/cursor write.
      void processing.then(() => finish(), finish);
    };
    opts.signal.addEventListener("abort", abort, { once: true });

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "connection_init", payload: {} }));
    });
    socket.addEventListener("message", (raw) => {
      let message: { type?: string; id?: string; payload?: unknown };
      try {
        message = JSON.parse(messageData(raw)) as typeof message;
      } catch (error) {
        finish(new Error(`indexer websocket returned malformed JSON: ${String(error)}`));
        return;
      }
      if (message.type === "connection_ack" && !subscribed) {
        clearTimeout(handshakeTimer);
        subscribed = true;
        socket.send(JSON.stringify({
          id: "watch",
          type: "subscribe",
          payload: {
            query: UNSHIELDED_SUBSCRIPTION,
            variables: { address: opts.address, transactionId: cursor ?? null },
          },
        }));
      } else if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", payload: message.payload ?? null }));
      } else if (message.type === "next") {
        const payload = message.payload as {
          data?: { unshieldedTransactions?: UnshieldedSubscriptionEvent };
          errors?: { message?: string }[];
        };
        if (payload.errors?.length) {
          finish(new Error(payload.errors.map((error) => error.message ?? JSON.stringify(error)).join("; ")));
          return;
        }
        const event = payload.data?.unshieldedTransactions;
        if (event !== undefined && !opts.signal.aborted) {
          processing = processing.then(() => opts.onEvent(event));
          void processing.catch(finish);
        }
      } else if (message.type === "error") {
        finish(new Error(`indexer subscription error: ${JSON.stringify(message.payload)}`));
      } else if (message.type === "complete") {
        void processing.then(() => finish(), finish);
      }
    });
    socket.addEventListener("error", () => finish(new Error("indexer websocket transport error")));
    socket.addEventListener("close", (event) => {
      void processing.then(
        () => finish(opts.signal.aborted ? undefined : new Error(`indexer websocket closed (${event.code} ${event.reason})`)),
        finish,
      );
    });
  });
}

/** Reconnecting at-least-once subscription; durable cursor ownership stays with the caller. */
export async function subscribeUnshieldedTransactions(opts: SubscribeOptions): Promise<void> {
  let attempt = 0;
  while (!opts.signal.aborted) {
    try {
      const cursor = await opts.getCursor();
      await runConnection(opts, cursor);
      attempt = 0;
    } catch (error) {
      if (opts.signal.aborted) break;
      const retryMs = Math.min(15_000, 500 * (2 ** Math.min(attempt++, 5)));
      opts.onReconnect?.(error, retryMs);
      await delay(retryMs, opts.signal);
    }
  }
}
