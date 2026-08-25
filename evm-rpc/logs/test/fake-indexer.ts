/**
 * A fake Midnight indexer speaking `graphql-transport-ws` over the minimal server in `../ws.ts`.
 *
 * WHY: the Part A stack (node + indexer + proof server, ports 10000-10002) does not exist in this
 * clone, so a LIVE end-to-end run of the ingester is not available here. This double makes
 * everything about the ingester except real-indexer wire compatibility testable and deterministic:
 * cursor resume, at-least-once redelivery, the split-pair hazard, reconnection, and crash recovery.
 *
 * It is deliberately faithful on the points that matter to the ingester's correctness:
 *   - `id` is an INCLUSIVE resume cursor;
 *   - events are delivered in monotonic `id` order, one per `next` message;
 *   - `maxId` reflects the highest id the indexer currently knows about;
 *   - `filter.contractAddress` is honoured (and mandatory, as in the real SDL);
 *   - redelivery can be forced, since real delivery is only at-least-once.
 *
 * It is NOT a GraphQL server: it does not parse the query document, it answers the one subscription
 * this repo sends. `test/verify-parity.ts` is what closes the loop against a real indexer.
 */

import { createWebSocketServer, type WsConnection, type WsServer } from "../ws.js";
import { GRAPHQL_TRANSPORT_WS } from "../graphql-ws.js";
import type { MidnightEvent } from "../event-map.js";

interface ActiveSubscription {
  connection: WsConnection;
  id: string;
  contractAddress: string;
  /** Highest id already sent on this subscription. */
  sent: number;
}

export interface FakeIndexerOptions {
  /** Deliver every event twice, exercising the at-least-once contract. */
  duplicateEveryEvent?: boolean;
  /**
   * Drop the connection ONCE, after this many `next` messages, forcing a reconnect+resume. Fires
   * a single time: a cumulative counter would re-drop on every reconnect and livelock the client.
   */
  dropAfterMessages?: number;
  /** Send `complete` once the backlog is drained instead of streaming live. */
  completeWhenDrained?: boolean;
}

export interface FakeIndexer {
  readonly url: string;
  /** Appends events to the indexed log and pushes them to matching live subscriptions. */
  emit(...events: MidnightEvent[]): void;
  /** Resume cursors requested by each `subscribe`, in order — proves restart behaviour. */
  readonly requestedCursors: number[];
  readonly subscribeCount: number;
  close(): Promise<void>;
}

export async function startFakeIndexer(options: FakeIndexerOptions = {}): Promise<FakeIndexer> {
  const log: MidnightEvent[] = [];
  const subscriptions = new Set<ActiveSubscription>();
  const requestedCursors: number[] = [];
  let subscribeCount = 0;
  let messagesSent = 0;
  let hasDropped = false;

  const maxId = (): number => log.reduce((max, event) => (event.id > max ? event.id : max), 0);

  const deliver = (subscription: ActiveSubscription, event: MidnightEvent): void => {
    const payload = {
      id: subscription.id,
      type: "next",
      payload: { data: { contractEvents: { ...event, maxId: maxId() } } },
    };
    subscription.connection.send(JSON.stringify(payload));
    messagesSent += 1;
    if (options.duplicateEveryEvent === true) {
      subscription.connection.send(JSON.stringify(payload));
      messagesSent += 1;
    }
    if (
      options.dropAfterMessages !== undefined &&
      !hasDropped &&
      messagesSent >= options.dropAfterMessages &&
      !subscription.connection.closed
    ) {
      hasDropped = true;
      subscriptions.delete(subscription);
      subscription.connection.close(1011, "fake indexer: forced drop");
    }
  };

  /** Sends every not-yet-sent event matching the subscription's filter. */
  const pump = (subscription: ActiveSubscription): void => {
    for (const event of log) {
      if (subscription.connection.closed) return;
      if (event.id < subscription.sent) continue;
      if (event.contractAddress !== subscription.contractAddress) continue;
      subscription.sent = event.id + 1;
      deliver(subscription, event);
    }
    if (options.completeWhenDrained === true && !subscription.connection.closed) {
      subscription.connection.send(JSON.stringify({ id: subscription.id, type: "complete" }));
    }
  };

  const server: WsServer = createWebSocketServer({
    protocols: [GRAPHQL_TRANSPORT_WS],
    onConnection(connection) {
      connection.onMessage((text) => {
        const message = JSON.parse(text) as {
          type?: string;
          id?: string;
          payload?: { variables?: { filter?: { contractAddress?: string }; id?: number } };
        };
        if (message.type === "connection_init") {
          connection.send(JSON.stringify({ type: "connection_ack" }));
          return;
        }
        if (message.type === "ping") {
          connection.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (message.type === "subscribe") {
          const variables = message.payload?.variables;
          const contractAddress = variables?.filter?.contractAddress;
          if (contractAddress === undefined) {
            // Mirrors the SDL: contractAddress is non-null on the filter.
            connection.send(
              JSON.stringify({
                id: message.id,
                type: "error",
                payload: [{ message: "filter.contractAddress is required" }],
              }),
            );
            return;
          }
          const cursor = variables?.id ?? 0;
          requestedCursors.push(cursor);
          subscribeCount += 1;
          const subscription: ActiveSubscription = {
            connection,
            id: message.id ?? "1",
            contractAddress,
            sent: cursor,
          };
          subscriptions.add(subscription);
          connection.onClose(() => subscriptions.delete(subscription));
          pump(subscription);
          return;
        }
        if (message.type === "complete") {
          for (const subscription of [...subscriptions]) {
            if (subscription.connection === connection) subscriptions.delete(subscription);
          }
        }
      });
    },
  });

  const port = await server.listen(0);

  return {
    url: `ws://127.0.0.1:${port}/api/v4/graphql/ws`,
    requestedCursors,
    get subscribeCount() {
      return subscribeCount;
    },
    emit(...events: MidnightEvent[]) {
      log.push(...events);
      log.sort((a, b) => a.id - b.id);
      for (const subscription of [...subscriptions]) pump(subscription);
    },
    close: () => server.close(),
  };
}
