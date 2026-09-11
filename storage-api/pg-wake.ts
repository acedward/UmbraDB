import { ARCHIVE_PROGRESS_CHANNEL } from "../src/postgres/archive-conventions.js";
import type { ArchiveWakeSource } from "../shielded-monitor/wake.js";

/**
 * `LISTEN chain_archive_progress` as an {@link ArchiveWakeSource} — the **A-side** wake source
 * (00009-08 v2).
 *
 * ── Why it is here and not in `shielded-monitor/wake.ts` ────────────────────────────────────
 * Until v2 this lived next to the SSE wake source, because the scanner could be configured
 * either way. Under owner decision Q25 project B has no database connection at all, so it can
 * never `LISTEN` to anything: the storage API is what holds the connection, and it republishes
 * the archive's `NOTIFY` as `GET /v1/archive/events` for B to subscribe to
 * (`archive-read-api/events.ts`). Leaving this function in `shielded-monitor/` would have left
 * project B carrying the archive's channel name and a driver-shaped interface for a mode it
 * cannot be in — and it would have tripped the import-boundary guard, which now forbids any path
 * from `shielded-monitor/**` into `src/postgres/**`.
 *
 * It stays in the repository because it is still the right wake source for a caller that DOES
 * hold a connection to the archive's database: the benchmark and the in-process scanner
 * integration suites drive the scheduler directly, with no HTTP anywhere, and a `LISTEN` there is
 * both correct and faster than polling.
 *
 * **Still an optimisation, never a contract.** PostgreSQL does not queue notifications for a
 * disconnected listener, so every consumer stays correct on polling alone — which is why nothing
 * reads the height out of the payload.
 */

/** The minimal surface {@link pgListenWake} needs: a connection, used ONLY to `LISTEN`. Typed
 *  structurally so this module does not depend on the driver's client type. */
export interface ListenCapable {
  listen(channel: string, onNotify: (payload: string) => void): Promise<{ unlisten: () => Promise<unknown> }>;
}

export function pgListenWake(sql: ListenCapable): ArchiveWakeSource {
  return {
    describe: `LISTEN ${ARCHIVE_PROGRESS_CHANNEL}`,
    async subscribe(net, onWake) {
      const handle = await sql.listen(ARCHIVE_PROGRESS_CHANNEL, (payload) => {
        // The payload is `<net>:<height>`. Only the net is used — the height is advisory, and the
        // scanner re-reads coverage rather than trusting a message.
        if (!payload.startsWith(`${net}:`)) return;
        onWake();
      });
      return { close: async () => { await handle.unlisten().catch(() => undefined); } };
    },
  };
}
