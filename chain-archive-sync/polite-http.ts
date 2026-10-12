/**
 * Politeness helpers shared by the node RPC and indexer GraphQL clients (live Stagenet ranges are read
 * from PUBLIC endpoints, so every request is paced and every throttling answer is honoured). Lives
 * outside `src/` like the clients themselves.
 */

/** Parses an HTTP `Retry-After` header in its delta-seconds form (the form the public Midnight
 *  endpoints send). Returns `undefined` when absent, empty, negative or in the HTTP-date form, so
 *  the caller falls back to its own exponential schedule. Capped at 10 minutes. */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (headerValue === null || headerValue === undefined) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === "" || !/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.round(seconds * 1000), 600_000);
}

/** Host suffixes of the public Midnight endpoints (Stagenet `*.shielded.tools`, the
 *  `midnight.network` preprod/mainnet hosts). Requests to them are paced by default. */
export const PUBLIC_HOST_SUFFIXES = ["shielded.tools", "midnight.network", "midnight.foundation"] as const;

/** Default minimum spacing between two request STARTS to one public endpoint: at most 4 requests
 *  per second per endpoint (the same bound the MIP-0018 reference implementation uses). */
export const PUBLIC_MIN_INTERVAL_MS = 250;

export function isPublicEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PUBLIC_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** The pacing default for one endpoint: {@link PUBLIC_MIN_INTERVAL_MS} for a public host, none
 *  for anything else (a local node, a test fake). */
export function defaultMinIntervalMs(url: string): number {
  return isPublicEndpoint(url) ? PUBLIC_MIN_INTERVAL_MS : 0;
}

/** What a client spaces its request starts with: its own {@link RequestPacer}, or a pacer it shares with the other
 *  clients of the same endpoint (the browser engine's, one per endpoint origin). */
export interface Pacer {
  readonly minIntervalMs: number;
  /** Resolves when the caller may start its request; rejects with the signal's reason as soon as `signal` ends (the
   *  caller's stop), and the caller never starts. */
  wait(signal?: AbortSignal): Promise<void>;
}

/** Waits for `wait` unless `signal` ends first: then rejects with its reason at once (no listener is left behind). */
export function unlessAborted(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return wait;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    wait.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve();
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Sleeps `ms`; a signal that ends clears the timer at once (so it never keeps a process up) and ends the sleep. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Spaces request starts at least `minIntervalMs` apart, across every concurrent caller of one
 * client (each call reserves the next free slot synchronously, then waits for it). `0` disables it.
 * A caller's signal ends its wait at once and clears its timer (its slot stays reserved, so the spacing never
 * shrinks).
 */
export class RequestPacer implements Pacer {
  private nextSlot = 0;

  constructor(
    readonly minIntervalMs: number,
    private readonly now: () => number = () => Date.now(),
    /** Sleeps `ms`, ending early (its timer cleared) when `signal` ends. */
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepUnlessAborted,
  ) {
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError(`minIntervalMs must be a non-negative number, got ${minIntervalMs}`);
    }
  }

  async wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw signal.reason;
    if (this.minIntervalMs === 0) return;
    const t = this.now();
    const slot = Math.max(t, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > t) await unlessAborted(this.sleep(slot - t, signal), signal);
  }
}
