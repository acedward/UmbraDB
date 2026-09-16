import { DustSyncError } from "./errors.js";

/**
 * The client's only I/O: `GET`/`POST` against the balancer, counted and delayed.
 *
 * ── `rttDelayMs` is a MEASUREMENT instrument, not a retry knob ───────────────────────────────
 * Spec §7 asks for every run twice: on loopback and "with a simulated 40 ms RTT". The delay is
 * applied CLIENT-side before each request, so a loopback run and a delayed one differ in exactly
 * one variable and the difference is `requests × rtt`. Doing it here rather than in the sync
 * keeps that true for every request the algorithm makes, including ones added later.
 *
 * ── What is counted ─────────────────────────────────────────────────────────────────────────
 * `requests` and `bytesIn` feed §5.5 step 10's `stats`. `bytesIn` is the length of the response
 * BODY as received (before JSON parsing), which is the number a deployment cares about — segment
 * hex dominates it — and the one an operator can compare with a proxy log.
 *
 * ── Custody ─────────────────────────────────────────────────────────────────────────────────
 * The lookup body carries the wallet's nullifiers. Nothing here logs a URL, a body or a response.
 * The only thing an error carries is the route PATTERN, the status and the node's error code —
 * never the request, because a lookup request is the wallet's spend chain (SC-006).
 */

export interface DustHttpOptions {
  /** Balancer base URL, e.g. `http://127.0.0.1:12345`. */
  readonly baseUrl: string;
  /** Client-side delay before every request, in milliseconds (spec §7). */
  readonly rttDelayMs?: number;
  /** Injected for tests and for a browser that ships its own fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout. A wallet that hangs on one request has failed, not stalled. */
  readonly timeoutMs?: number;
}

export class DustHttpClient {
  private readonly base: string;
  private readonly rttDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  requests = 0;
  bytesIn = 0;

  constructor(options: DustHttpOptions) {
    const trimmed = options.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(trimmed)) {
      throw new DustSyncError("DUST_SYNC_INVALID_INPUT", "baseUrl must be an http(s) URL");
    }
    this.base = trimmed;
    this.rttDelayMs = options.rttDelayMs ?? 0;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `GET /v1/dust/<route>?<query>`. `route` is the pattern that may appear in an error. */
  async get<T>(route: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${this.base}/v1/dust/${route}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return await this.send<T>(route, url, undefined);
  }

  /** `POST /v1/dust/lookup`. The body is never logged, never retried and never stored. */
  async post<T>(route: string, body: unknown): Promise<T> {
    const url = new URL(`${this.base}/v1/dust/${route}`);
    return await this.send<T>(route, url, JSON.stringify(body));
  }

  private async send<T>(route: string, url: URL, body: string | undefined): Promise<T> {
    if (this.rttDelayMs > 0) await delay(this.rttDelayMs);
    this.requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new DustSyncError("DUST_SYNC_HTTP", `the node did not answer ${route}`, {
        route,
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    this.bytesIn += Buffer.byteLength(text, "utf8");
    if (response.status !== 200) {
      // The node's own error code (§4) is the useful part and is safe to carry: it is one of a
      // fixed vocabulary and names no caller input.
      let code = "";
      try {
        code = String((JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "");
      } catch {
        code = "";
      }
      throw new DustSyncError("DUST_SYNC_HTTP", `${route} answered ${response.status}`, {
        route,
        status: response.status,
        code,
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DustSyncError("DUST_SYNC_HTTP", `${route} answered a 200 that is not JSON`, { route });
    }
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
