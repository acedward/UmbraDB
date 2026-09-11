import { ARCHIVE_PROGRESS_CHANNEL } from "../src/postgres/archive-conventions.js";
import type { UmbraDBSql } from "../src/postgres/client.js";

/**
 * The archive's progress signal, as the read API republishes it (organizer sub-plan 00009-08).
 *
 * A-side only. The archive's writer emits `NOTIFY chain_archive_progress, '<net>:<height>'`
 * INSIDE each height's own transaction (00009-01), so an arrival means "this height is readable"
 * and a rolled-back height delivers nothing. In a SPLIT deployment project B has no connection to
 * the archive's database at all, so it cannot `LISTEN`; this module is the bridge that turns that
 * PostgreSQL notification into an HTTP event stream B can subscribe to.
 *
 * **Still an optimisation, never a contract.** PostgreSQL does not queue notifications for a
 * disconnected listener, an SSE connection can drop, and a proxy can buffer. Every consumer must
 * remain correct on polling alone — which is why `SCAN_POLL_MS` exists on both sides of the wire
 * and why nothing in B's scanner reads the height out of the event.
 */

/** One archive progress event. */
export interface ArchiveProgressEvent {
  readonly net: string;
  readonly height: number;
}

/** A subscription handle. `close()` is idempotent. */
export interface ArchiveProgressSubscription {
  close(): Promise<void>;
}

/**
 * A source of archive progress events.
 *
 * An interface rather than the PostgreSQL call directly, for the same reason the read contract is
 * an interface: the server must be testable without a database, and a future source (a message
 * bus, a chained read API) implements this without the server changing.
 */
export interface ArchiveProgressEvents {
  subscribe(listener: (event: ArchiveProgressEvent) => void): Promise<ArchiveProgressSubscription>;
}

/** Parses the writer's `"<net>:<height>"` payload. Returns `undefined` for anything else rather
 *  than throwing: a malformed notification is not worth taking a server down for, and the
 *  consumer's polling fallback covers the missed wake-up. */
export function parseProgressPayload(payload: string): ArchiveProgressEvent | undefined {
  const separator = payload.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const net = payload.slice(0, separator);
  const height = Number(payload.slice(separator + 1));
  if (!Number.isSafeInteger(height) || height < 0) return undefined;
  return { net, height };
}

/**
 * The PostgreSQL implementation: one `LISTEN` connection, fanned out to every subscriber.
 *
 * One connection for all subscribers, not one per subscriber: an unauthenticated endpoint that
 * opened a database connection per HTTP client would be a trivial way to exhaust the archive's
 * connection pool from outside. Subscribers are held in a `Set` and the underlying `LISTEN` is
 * released when the last one leaves.
 */
export function pgArchiveProgressEvents(sql: UmbraDBSql): ArchiveProgressEvents {
  const listeners = new Set<(event: ArchiveProgressEvent) => void>();
  let handle: { unlisten: () => Promise<unknown> } | undefined;
  let attaching: Promise<void> | undefined;

  const attach = async (): Promise<void> => {
    if (handle !== undefined) return;
    attaching ??= (async () => {
      handle = await sql.listen(ARCHIVE_PROGRESS_CHANNEL, (payload) => {
        const event = parseProgressPayload(payload);
        if (event === undefined) return;
        for (const listener of listeners) listener(event);
      });
    })().finally(() => {
      attaching = undefined;
    });
    await attaching;
  };

  return {
    async subscribe(listener) {
      listeners.add(listener);
      try {
        await attach();
      } catch (err) {
        listeners.delete(listener);
        throw err;
      }
      let closed = false;
      return {
        close: async () => {
          if (closed) return;
          closed = true;
          listeners.delete(listener);
          if (listeners.size === 0 && handle !== undefined) {
            const open = handle;
            handle = undefined;
            await open.unlisten().catch(() => undefined);
          }
        },
      };
    },
  };
}
