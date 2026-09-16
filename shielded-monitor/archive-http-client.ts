import type {
  ArchiveBlockPage,
  ArchiveIdentity,
  ArchiveReadContract,
} from "../src/interfaces/archive-read-contract.js";
import {
  ARCHIVE_READ_ROUTES,
  ArchiveReadApiErrorSchema,
  decodeBlockPage,
  decodeIdentity,
} from "../src/interfaces/archive-read-wire.js";

/**
 * {@link ArchiveReadContract}, over HTTP (organizer sub-plan 00009-08; `spec/00009` FR-025).
 *
 * This is the whole of project B's dependency on project A in a split deployment: one base URL,
 * two methods, no database credential, no schema name, no SQL. `spec/00009` FR-025 asks for
 * exactly this — "an interface with no schema knowledge in B, so B can later run in a separate
 * process or TEE" — and the interface it implements is the SAME one the in-process PostgreSQL
 * implementation satisfies, so nothing above this line knows which one it is holding.
 *
 * **Fail closed, everywhere.** A non-2xx, an unparseable body, a payload that does not match the
 * wire schema and a page whose blocks are not parent-linked all THROW. None of them produces an
 * empty page — because an empty page means "you are at the tip", and a scanner that read it as
 * such would report itself caught up with a stretch of history it never saw.
 *
 * **No new dependency.** Node's global `fetch` (`undici`, built in since Node 18) and
 * `AbortSignal.timeout`. The `fetch` implementation is injectable for tests, which is also what a
 * future mTLS/attested transport would replace at the TEE step.
 */

/** The archive read API answered, but not with something this client can use. */
export class ArchiveHttpError extends Error {
  readonly code = "ARCHIVE_HTTP_ERROR" as const;
  constructor(
    readonly status: number,
    readonly serverCode: string | undefined,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveHttpError";
  }
}

/** The archive read API could not be reached at all (DNS, connection refused, timeout, aborted). */
export class ArchiveUnreachableError extends Error {
  readonly code = "ARCHIVE_UNREACHABLE" as const;
  constructor(readonly url: string, override readonly cause: unknown) {
    super(
      `the archive read API at ${url} could not be reached: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "ArchiveUnreachableError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpArchiveReadContractOptions {
  /** Per-request timeout. A page can be megabytes over a slow link, so this is generous; it
   *  exists to stop a hung connection from wedging a scan worker forever, not to be tight. */
  readonly requestTimeoutMs?: number;
  readonly fetch?: FetchLike;
  /** Sent as `user-agent`, so an operator reading the read API's access log can tell which
   *  component is paging it. Carries no monitor id and nothing key-derived. */
  readonly userAgent?: string;
}

export const DEFAULT_ARCHIVE_REQUEST_TIMEOUT_MS = 60_000;

/** Trims a trailing slash so `${base}${route}` never produces a double slash — which some
 *  proxies normalise and some do not, and a 404 from path normalisation is a miserable thing to
 *  debug. */
export function normalizeArchiveBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      `ARCHIVE_URL must be a bare base URL (scheme, host, optional path), got ${JSON.stringify(baseUrl)}`,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export class HttpArchiveReadContract implements ArchiveReadContract {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly doFetch: FetchLike;
  private readonly userAgent: string;

  constructor(baseUrl: string, options: HttpArchiveReadContractOptions = {}) {
    this.base = normalizeArchiveBaseUrl(baseUrl);
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_ARCHIVE_REQUEST_TIMEOUT_MS;
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent ?? "umbradb-shielded-monitor";
  }

  /** The base URL this client pages, for log lines and for the deployment banner. Never contains
   *  a credential: the read API is unauthenticated in the alpha. */
  get baseUrl(): string {
    return this.base;
  }

  async readBlocksSince(net: string, afterHeight: number, maxBlocks: number): Promise<ArchiveBlockPage> {
    if (!Number.isSafeInteger(afterHeight) || afterHeight < -1) {
      throw new Error(`afterHeight must be a safe integer >= -1; got ${String(afterHeight)}`);
    }
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) {
      throw new Error(`maxBlocks must be a positive integer; got ${String(maxBlocks)}`);
    }
    const url = this.url(ARCHIVE_READ_ROUTES.blocks, {
      net, after: String(afterHeight), max: String(maxBlocks),
    });
    return decodeBlockPage(await this.getJson(url));
  }

  async getArchiveIdentity(net: string): Promise<ArchiveIdentity | undefined> {
    const url = this.url(ARCHIVE_READ_ROUTES.identity, { net });
    const body = await this.getJson(url, { allowNotFound: true });
    // `undefined` is the contract's "this archive cannot yet say who it is" — the archive has no
    // genesis block, or its schema was never bootstrapped. The server says so with a 404, and the
    // scanner's own `checkArchiveIdentity` already treats it as "nothing to scan", not an error.
    return body === undefined ? undefined : decodeIdentity(body);
  }

  private url(route: string, params: Record<string, string>): string {
    const url = new URL(`${this.base}${route}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  private async getJson(url: string, opts: { allowNotFound?: boolean } = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ArchiveUnreachableError(url, err);
    }

    const text = await response.text().catch(() => "");
    if (response.status === 404 && opts.allowNotFound === true) return undefined;
    if (!response.ok) {
      const parsed = ArchiveReadApiErrorSchema.safeParse(safeJson(text));
      throw new ArchiveHttpError(
        response.status,
        parsed.success ? parsed.data.error.code : undefined,
        url,
        parsed.success
          ? `the archive read API refused ${url}: ${response.status} ${parsed.data.error.code} — ${parsed.data.error.message}`
          : `the archive read API refused ${url}: ${response.status} ${response.statusText}`,
      );
    }
    const body = safeJson(text);
    if (body === undefined) {
      throw new ArchiveHttpError(response.status, undefined, url, `${url} returned a body that is not JSON`);
    }
    return body;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
