/**
 * C-G2 — the ingester: one `contractEvents` subscription per watched contract, mapped through
 * `event-map.ts` and written with `store.ts`.
 *
 * ── The three properties this is built around ──────────────────────────────────────────────────
 * 1. **Atomicity.** Rows and the cursor that accounts for them land in ONE transaction
 *    (`store.writeLogs`). A `kill -9` between them would otherwise be able to leave the cursor past
 *    logs that were never written — a permanent, silent hole, since the subscription never replays
 *    those ids.
 * 2. **Idempotency.** Delivery is at-least-once and a restart deliberately re-reads the held-back
 *    tail, so every insert is `ON CONFLICT (source_event_id) DO NOTHING`.
 * 3. **No split pairs.** A Spend/Receive pair straddling a delivery boundary would map to a bogus
 *    burn plus a bogus mint. Events are buffered and only whole transactions are mapped; the
 *    trailing transaction is held until something proves it closed (see `flushReason` below).
 */

import { fromHex, mapEvents, splitCompleteTransactions, type AbiProfile, type AddressMapper, type LogRow, type MapWarning, type MidnightEvent } from "./event-map.js";
import { AddressIdCache } from "./address-map.js";
import { readCursor, writeLogs, type SqlPool } from "./store.js";
import { runSubscription, type SubscriptionHandle, type WebSocketFactory } from "./graphql-ws.js";
import type { WatchEntry } from "./config.js";

/**
 * The subscription document. Every concrete `ContractEvent` type contributes its own fields via an
 * inline fragment; `PausedEvent`/`UnpausedEvent` declare none beyond the interface, so they need no
 * fragment.
 *
 * `transaction.block.transactions { hash }` is selected ONLY to recover `tx_index`, which the SDL
 * exposes no direct field for (LOGMAP.md §"tx_index", plan Open question Q2).
 */
export const CONTRACT_EVENTS_SUBSCRIPTION = `
subscription IngestContractEvents($filter: ContractEventFilter!, $id: Int) {
  contractEvents(filter: $filter, id: $id) {
    __typename
    id
    maxId
    contractAddress
    transactionId
    transaction {
      hash
      block { height hash transactions { hash } }
    }
    ... on UnshieldedSpendEvent {
      sender { kind userAddress contractAddress }
      domainSep tokenType amount
    }
    ... on UnshieldedReceiveEvent {
      recipient { kind userAddress contractAddress }
      domainSep tokenType amount
    }
    ... on UnshieldedMintEvent { domainSep tokenType amount }
    ... on UnshieldedBurnEvent {
      sender { kind userAddress contractAddress }
      tokenType amount
    }
    ... on ShieldedSpendEvent { nullifier }
    ... on ShieldedReceiveEvent { commitment ciphertext receivingContractAddress }
    ... on ShieldedMintEvent { commitment domainSep amount }
    ... on ShieldedBurnEvent { nullifier amount }
    ... on MiscContractEvent { name payload }
  }
}`.trim();

/** The `data` shape one `next` message carries — the subscription yields ONE event per message. */
interface ContractEventsData {
  contractEvents: MidnightEvent;
}

export interface IngestEvents {
  onWarning?: (warning: MapWarning, entry: WatchEntry) => void;
  /**
   * Called AFTER each batch commits, with the rows that actually landed. This is the live tail
   * C-G4's `eth_subscribe("logs", …)` is fed from — deliberately post-commit, so a subscriber can
   * never be told about a log that a rollback then erased.
   */
  onCommitted?: (rows: readonly LogRow[], entry: WatchEntry) => void;
  onError?: (error: Error, entry: WatchEntry) => void;
  onConnected?: (entry: WatchEntry) => void;
  /** Diagnostic progress line. */
  onProgress?: (message: string) => void;
}

export interface IngestOptions extends IngestEvents {
  sql: SqlPool;
  schema: string;
  /** e.g. `ws://127.0.0.1:10001/api/v4/graphql/ws`. */
  indexerWs: string;
  contracts: readonly WatchEntry[];
  /**
   * How long to wait, with no further event arriving, before flushing a held-back trailing
   * transaction. A block's events are indexed together, so an idle gap well beyond block time
   * proves the transaction closed. Default 1500ms — comfortably under one block, so a transfer's
   * logs still land "within a block" as C-G2 requires, while never risking a split pair.
   */
  idleFlushMs?: number;
  addressMapper?: AddressMapper;
  webSocketFactory?: WebSocketFactory;
  signal?: AbortSignal;
}

export interface IngestHandle {
  /** Resolves when every per-contract subscription has stopped. */
  readonly done: Promise<void>;
  stop(): void;
}

/** Starts one subscription per watched contract. */
export function startIngest(options: IngestOptions): IngestHandle {
  const handles = options.contracts.map((entry) => startContractIngest(entry, options));
  return {
    done: Promise.all(handles.map((h) => h.done)).then(() => undefined),
    stop() {
      for (const handle of handles) handle.stop();
    },
  };
}

function startContractIngest(entry: WatchEntry, options: IngestOptions): SubscriptionHandle {
  const idleFlushMs = options.idleFlushMs ?? 1_500;
  const cache = new AddressIdCache();
  const contractAddressBytes = fromHex(entry.address);
  const contractIdentity = { kind: "contract" as const, hex: entry.address };

  /** Events of the trailing, not-yet-provably-closed transaction. */
  let buffer: MidnightEvent[] = [];
  /** Ids currently buffered — guards against redelivery within one connection. */
  const bufferedIds = new Set<number>();
  /**
   * Highest event id already durably accounted for. Any event at or below it has been committed
   * (or was covered by a prior run's cursor), so redelivering it must be ignored.
   *
   * This is not merely an optimisation. A pair is keyed on its LOWER id, so a redelivered lone
   * Receive would not conflict on `source_event_id` and would insert a spurious mint. Comparing
   * against a monotonic high-water mark closes that hole; `ON CONFLICT` alone does not.
   */
  let committedThrough = -1;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Incremented on every (re)subscribe. An idle-flush timer captures the generation it was armed
   * under and does nothing if the connection has since been replaced — otherwise a timer armed
   * while a transaction was still incomplete could fire during a disconnect and commit half of it
   * as a bogus burn, which is the very corruption the buffer exists to prevent.
   */
  let generation = 0;
  /** Serialises flushes so an idle-timer flush cannot interleave with an event-driven one. */
  let flushChain: Promise<void> = Promise.resolve();

  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  /** Maps and commits `events` (which must be whole transactions), then advances the cursor. */
  const commit = async (events: MidnightEvent[]): Promise<void> => {
    if (events.length === 0) return;
    const rows = mapEvents(events, entry.profile as AbiProfile, options.addressMapper, {
      onWarning: (warning) => options.onWarning?.(warning, entry),
    });
    // The cursor advances to the highest id CONSUMED, not the highest id that produced a row: a
    // pair consumes two ids and yields one row, and resuming from the row's id would redeliver the
    // partner forever.
    const lastEventId = events.reduce((max, event) => (event.id > max ? event.id : max), -1);
    const result = await writeLogs(options.sql, options.schema, rows, {
      contractIdentity,
      cursor: { contractAddress: contractAddressBytes, lastEventId },
      cache,
      addressMapper: options.addressMapper,
    });
    for (const event of events) bufferedIds.delete(event.id);
    if (lastEventId > committedThrough) committedThrough = lastEventId;
    options.onProgress?.(
      `${entry.address.slice(0, 8)}…: committed ${result.inserted} row(s) ` +
        `(${result.skipped} duplicate) through event ${lastEventId}`,
    );
    if (result.inserted > 0) options.onCommitted?.(rows, entry);
  };

  /** Flushes the whole buffer, treating the trailing transaction as closed. */
  const flushAll = (): Promise<void> => {
    const events = buffer;
    buffer = [];
    return commit(events);
  };

  /**
   * Schedules the trailing transaction's flush. The captured `generation` means a timer armed under
   * a connection that has since dropped and been replaced simply does nothing — the replacement
   * replays those events from the durable cursor anyway.
   */
  const armIdleFlush = (): void => {
    const armedUnder = generation;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (armedUnder !== generation) return;
      void enqueue(async () => {
        if (armedUnder !== generation) return;
        await flushAll();
      }).catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), entry);
      });
    }, idleFlushMs);
    // Do not keep the process alive purely for a pending idle flush.
    idleTimer.unref?.();
  };

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    flushChain = flushChain.then(work, (error) => {
      // Surface and re-throw: a failed write must tear the subscription down so it reconnects and
      // replays from the last durable cursor, never silently skip a batch.
      throw error;
    });
    return flushChain;
  };

  const handle = runSubscription<ContractEventsData>({
    url: options.indexerWs,
    signal: options.signal,
    webSocketFactory: options.webSocketFactory,
    onConnected: () => options.onConnected?.(entry),
    onError: (error) => {
      // A dropped connection lands here. Disarm the idle flush and drop the buffer immediately:
      // its trailing transaction is incomplete, and committing it now would fabricate a burn.
      // The generation guard is the backstop if a timer has already been scheduled.
      clearIdleTimer();
      buffer = [];
      bufferedIds.clear();
      options.onError?.(error, entry);
    },
    request: async () => {
      // Rebuilt on every (re)connect so a reconnect resumes from the CURRENT durable cursor.
      const cursor = await readCursor(options.sql, options.schema, contractAddressBytes);
      // Anything held in memory was never committed; drop it so the replay is the single source.
      generation += 1;
      clearIdleTimer();
      buffer = [];
      bufferedIds.clear();
      if (cursor !== null && cursor > committedThrough) committedThrough = cursor;
      const filter: Record<string, unknown> = { contractAddress: entry.address };
      if (entry.fromBlock !== undefined && cursor === null) filter.fromBlock = entry.fromBlock;
      return {
        query: CONTRACT_EVENTS_SUBSCRIPTION,
        operationName: "IngestContractEvents",
        // `id` is an INCLUSIVE cursor, so resume at last + 1. A fresh contract starts at 0.
        variables: { filter, id: cursor === null ? 0 : cursor + 1 },
      };
    },
    onData: async (data) => {
      const event = data.contractEvents;
      if (event === undefined || event === null) return;

      // Redelivery guards come FIRST, and specifically before `clearIdleTimer()`: a duplicate that
      // disarmed an already-armed flush without re-arming it would leave the buffer stranded
      // forever, which is a hang rather than a wrong row.
      if (bufferedIds.has(event.id)) return;
      if (event.id <= committedThrough) return;

      clearIdleTimer();
      buffer.push(event);
      bufferedIds.add(event.id);

      const { complete, pending } = splitCompleteTransactions(buffer);
      if (complete.length > 0) {
        buffer = pending;
        await enqueue(() => commit(complete));
      }

      // Arm the idle flush: if nothing more arrives, the trailing transaction is closed.
      //
      // NOTE: `id === maxId` is deliberately NOT used as a flush trigger, even though it looks like
      // a cheap way to avoid this wait. It is unsafe for exactly the case this buffer exists to
      // protect: while a transfer's Spend is the newest indexed event, `id === maxId` holds, and
      // flushing there would emit a bogus burn — then a bogus mint when the Receive lands. `maxId`
      // can only ever say "nothing newer YET", never "this transaction is closed". The two safe
      // signals are an event from a DIFFERENT transaction (handled above) and this idle timeout.
      if (buffer.length > 0) armIdleFlush();
    },
    onComplete: () => {
      clearIdleTimer();
      void enqueue(flushAll).catch(() => {
        /* reported through onError by the chain */
      });
    },
  });

  const stop = handle.stop.bind(handle);
  return {
    done: handle.done.finally(() => clearIdleTimer()),
    stop() {
      clearIdleTimer();
      stop();
    },
  };
}
