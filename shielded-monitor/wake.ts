import { ARCHIVE_PROGRESS_CHANNEL } from "../src/postgres/archive-conventions.js";
import { ARCHIVE_READ_ROUTES, decodeProgressEvent } from "../src/interfaces/archive-read-wire.js";
import { normalizeArchiveBaseUrl, type FetchLike } from "./archive-http-client.js";

/**
 * How the scanner learns that the archive has moved (organizer sub-plan 00009-08; `spec/00009`
 * US2).
 *
 * **The wake-up is an OPTIMISATION and never a contract.** Every implementation here may miss
 * events — PostgreSQL does not queue `NOTIFY` for a disconnected listener, an SSE stream can drop
 * mid-flight, a proxy can buffer — so `SCAN_POLL_MS` still fires and the scheduler re-reads
 * coverage from its own schema rather than trusting a message. Nothing acts on the height a wake
 * carries; a wake means "look again", nothing more. That is what lets {@link NO_WAKE} be a
 * correct implementation.
 *
 * **Why it became a seam in 00009-08.** Until now the scheduler held B's own `UmbraDBSql` and
 * called `sql.listen(ARCHIVE_PROGRESS_CHANNEL)` on it. That works only while A and B share one
 * PostgreSQL server. In a SPLIT deployment B's database is a different server that nobody
 * notifies, so the `LISTEN` would attach successfully, never fire, and the tail would silently
 * degrade to polling with nothing in the logs to say so. The seam makes the choice explicit and
 * configuration-driven: shared database → {@link pgListenWake}; `ARCHIVE_URL` → {@link sseWake}.
 */

export interface ArchiveWakeSubscription {
  close(): Promise<void>;
}

export interface ArchiveWakeSource {
  /** A short, log-safe description of where wake-ups come from, printed in the scanner's boot
   *  banner so an operator can see which one is in effect. */
  readonly describe: string;
  /** `onWake` is called with no argument: the height is deliberately not passed on, so no caller
   *  can start depending on a signal that is allowed to be lost. */
  subscribe(net: string, onWake: () => void): Promise<ArchiveWakeSubscription>;
}

/** Polling only. Correct, just less prompt — and the honest choice when no signal is available. */
export const NO_WAKE: ArchiveWakeSource = {
  describe: "polling only",
  subscribe: async () => ({ close: async () => undefined }),
};

/** The minimal surface {@link pgListenWake} needs: B's own connection, used ONLY to `LISTEN`.
 *  Typed structurally so this module does not have to import the driver's client type. */
export interface ListenCapable {
  listen(channel: string, onNotify: (payload: string) => void): Promise<{ unlisten: () => Promise<unknown> }>;
}

/**
 * `LISTEN chain_archive_progress` on a connection to the database that also holds the archive.
 *
 * Valid ONLY when A and B share a PostgreSQL server — which is the single-host deployment mode,
 * and the mode this repository shipped before 00009-08. In a split deployment this would attach
 * to B's own database and never hear anything; the configuration refuses to build it there.
 */
export function pgListenWake(sql: ListenCapable): ArchiveWakeSource {
  return {
    describe: `LISTEN ${ARCHIVE_PROGRESS_CHANNEL}`,
    async subscribe(net, onWake) {
      const handle = await sql.listen(ARCHIVE_PROGRESS_CHANNEL, (payload) => {
        // The payload is `<net>:<height>`. Only the net is used — the height is advisory, and the
        // scanner re-reads coverage from its own schema rather than trusting a message.
        if (!payload.startsWith(`${net}:`)) return;
        onWake();
      });
      return { close: async () => { await handle.unlisten().catch(() => undefined); } };
    },
  };
}

export interface SseWakeOptions {
  readonly fetch?: FetchLike;
  /** Delay before the first reconnect attempt; doubles up to {@link maxReconnectDelayMs}. */
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly logger?: (line: string) => void;
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * `GET /v1/archive/events` as a wake-up source: a hand-rolled SSE reader with reconnect.
 *
 * **Hand-rolled, deliberately.** Node has no `EventSource` and this repository adds no runtime
 * dependency for one (`design/design.md` §7). The format this needs to read is three lines and a
 * blank one; an `eventsource` package would be more code in the supply chain than in this file.
 *
 * **Reconnect is the whole reliability story.** A stream that ends — server restart, proxy idle
 * timeout, network blip — is reconnected with exponential backoff, and the scanner keeps polling
 * throughout, so the only thing a dropped stream costs is promptness. A reconnect loop that gave
 * up would turn a transient fault into a permanently laggy tail.
 */
export function sseWake(baseUrl: string, options: SseWakeOptions = {}): ArchiveWakeSource {
  const base = normalizeArchiveBaseUrl(baseUrl);
  const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const firstDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const maxDelay = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  const log = options.logger ?? (() => undefined);

  return {
    describe: `SSE ${base}${ARCHIVE_READ_ROUTES.events}`,
    async subscribe(net, onWake) {
      const controller = new AbortController();
      let closed = false;
      let delay = firstDelay;

      const loop = (async () => {
        while (!closed) {
          try {
            const url = new URL(`${base}${ARCHIVE_READ_ROUTES.events}`);
            url.searchParams.set("net", net);
            const response = await doFetch(url.toString(), {
              method: "GET",
              headers: { accept: "text/event-stream" },
              signal: controller.signal,
            });
            if (!response.ok || response.body === null) {
              throw new Error(`events stream answered ${response.status} ${response.statusText}`);
            }
            // Connected: the backoff resets here rather than on the first byte, because a server
            // that accepts and then sits idle is the NORMAL state of a quiet chain.
            delay = firstDelay;
            await readEventStream(response.body, net, onWake, () => closed);
            if (!closed) log(`[shielded-monitor-scanner] archive event stream ended; reconnecting`);
          } catch (err) {
            if (closed) return;
            log(
              `[shielded-monitor-scanner] archive event stream unavailable (${
                err instanceof Error ? err.message : String(err)
              }); retrying in ${delay} ms — polling continues meanwhile`,
            );
          }
          if (closed) return;
          await sleep(delay, controller.signal);
          delay = Math.min(delay * 2, maxDelay);
        }
      })();

      return {
        close: async () => {
          closed = true;
          controller.abort();
          await loop.catch(() => undefined);
        },
      };
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Reads one SSE body to its end, calling `onWake` for every `progress` event whose net matches.
 *
 * Exported for its own test: the parser is the part of this module that can be wrong in a way
 * that costs nothing visible (a mis-split frame just means a missed wake-up, and polling hides
 * it), so it is tested directly against a hand-written stream.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  net: string,
  onWake: () => void,
  isClosed: () => boolean = () => false,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (isClosed()) return;
      buffer += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line. `\r\n` is accepted because the spec allows it and
      // an intermediary may rewrite line endings.
      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + (/\r\n\r\n/.test(buffer.slice(separator, separator + 4)) ? 4 : 2));
        handleFrame(frame, net, onWake);
        separator = buffer.search(/\r?\n\r?\n/);
      }
      // A peer that never sends a blank line would otherwise grow this buffer without bound.
      if (buffer.length > 1_000_000) buffer = "";
    }
  } finally {
    reader.releaseLock?.();
  }
}

function handleFrame(frame: string, net: string, onWake: () => void): void {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    // A comment — the heartbeat. Proof the stream is alive, and nothing else.
    if (rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const value = colon === -1 ? "" : rawLine.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (event !== "progress" || data.length === 0) return;
  try {
    const parsed: unknown = JSON.parse(data.join("\n"));
    const progress = decodeProgressEvent(parsed);
    if (progress.net !== net) return;
  } catch {
    // A frame this client cannot read is not worth failing over: the wake-up is advisory, and
    // polling covers it. It is deliberately NOT treated as a wake, so a stream of garbage cannot
    // spin the scheduler.
    return;
  }
  onWake();
}
