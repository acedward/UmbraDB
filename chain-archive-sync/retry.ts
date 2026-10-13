import { IndexerClientError, IndexerClientParseError } from "./indexer-client.js";
import { NodeRpcError, NodeRpcParseError } from "./node-rpc-client.js";

/**
 * Bounded retry with exponential back-off for calls to the PUBLIC node and indexer endpoints. Applied
 * per network call, so one throttled request does not throw away the blocks already archived in a batch,
 * and the sync resumes by itself once the endpoint answers again.
 *
 * Retryable: HTTP 429 (rate limited), 403 (what a WAF in front of a public endpoint answers when it
 * decides a client is abusive -- observed on the public preprod RPC), 5xx (outage), a failed
 * transport (DNS, reset, timeout) and a 2xx whose body is not JSON (a proxy's error page). Never
 * retried: a JSON-RPC/GraphQL protocol error, a malformed block number, the "indexer has not yet
 * synced height N" signal and any database error -- those are surfaced to the caller's own loop.
 */

export interface RetryClassification {
  retryable: boolean;
  httpStatus: number | undefined;
  retryAfterMs: number | undefined;
}

export function isThrottlingStatus(status: number | undefined): boolean {
  return status === 429 || status === 403;
}

function retryableStatus(status: number): boolean {
  return isThrottlingStatus(status) || status >= 500;
}

export function classifyEndpointError(error: unknown): RetryClassification {
  if (error instanceof NodeRpcError || error instanceof IndexerClientError) {
    if (error.httpStatus !== undefined) {
      return { retryable: retryableStatus(error.httpStatus), httpStatus: error.httpStatus, retryAfterMs: error.retryAfterMs };
    }
    // The clients set `cause` only when the transport itself failed; a protocol error has neither.
    return { retryable: error.cause !== undefined, httpStatus: undefined, retryAfterMs: undefined };
  }
  if (error instanceof NodeRpcParseError || error instanceof IndexerClientParseError) {
    return { retryable: true, httpStatus: undefined, retryAfterMs: undefined };
  }
  return { retryable: false, httpStatus: undefined, retryAfterMs: undefined };
}

export interface RetryInfo {
  operation: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  httpStatus: number | undefined;
  throttled: boolean;
  message: string;
}

export interface BackoffOptions {
  /** Attempts per network call, including the first. Default 8 (about 2 minutes of waiting at the
   *  default schedule); after that the last error is thrown and the CLI's loop takes over. */
  maxAttempts?: number;
  /** First delay, doubled per attempt. Default 1_000 ms. */
  baseDelayMs?: number;
  /** Ceiling of one delay. Default 60_000 ms. */
  maxDelayMs?: number;
  /** Jitter: a uniform draw in `[delay/2, delay]`. Default true; tests set false. */
  jitter?: boolean;
  /** Test seam; the default sleeps for real and returns early when `signal` aborts. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait (the CLI logs every throttling answer). */
  onRetry?: (info: RetryInfo) => void;
}

export const DEFAULT_BACKOFF = { maxAttempts: 8, baseDelayMs: 1_000, maxDelayMs: 60_000, jitter: true } as const;

export interface RetryCounters {
  retries: number;
  throttled: number;
}

/** Sleeps `ms`, returning early when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Runs `call`, retrying the retryable failures on an exponential schedule (with jitter), honouring a
 * `Retry-After` header when it asks for a longer wait (never beyond `maxDelayMs`). Never swallows
 * the final failure.
 */
export async function withRetry<T>(
  operation: string,
  call: () => Promise<T>,
  opts: BackoffOptions = {},
  counters?: RetryCounters,
  signal?: AbortSignal,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_BACKOFF.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BACKOFF.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs;
  const jitter = opts.jitter ?? DEFAULT_BACKOFF.jitter;
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const { retryable, httpStatus, retryAfterMs } = classifyEndpointError(error);
      if (!retryable || attempt >= maxAttempts || signal?.aborted === true) throw error;
      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jittered = jitter ? exponential / 2 + Math.random() * (exponential / 2) : exponential;
      const delayMs = Math.round(Math.min(Math.max(retryAfterMs ?? 0, jittered), maxDelayMs));
      const throttled = isThrottlingStatus(httpStatus);
      if (counters !== undefined) {
        counters.retries++;
        if (throttled) counters.throttled++;
      }
      opts.onRetry?.({
        operation, attempt, maxAttempts, delayMs, httpStatus, throttled,
        message: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }
}
