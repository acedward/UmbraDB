/**
 * The MIP-0018 read-only JSON API (contract: `token-indexer/API.md`) as one runtime-neutral handler: routes,
 * validation, errors and the request cap. `handle(method, target)` answers `{ status, headers, body }` from an injected
 * `Sql` alone, so the same router runs behind Node's own `http` server (`api-node.ts`, used by `serve-cli.ts`) and in
 * any other host that hands it a method and a request target. The pattern of the UmbraDB services: keyset pagination,
 * one error envelope, a read snapshot per request.
 *
 * - `GET`/`HEAD` only (405 otherwise, with `Allow`); strict input: 32-byte hex path values, kinds 1–3, no unknown or
 *   repeated query parameters, `limit` 1–500, cursors only as issued (bound to their endpoint and filter).
 * - Every request runs in ONE `REPEATABLE READ READ ONLY` transaction: all statements of an answer see one database
 *   state while the scan commits blocks, and the API cannot write.
 * - Errors: `{ "error": { "code", "message" } }`; messages name the parameter, never echo the input, never carry
 *   internal details (database and unexpected errors go to the injected log and are answered generically).
 * - JSON bodies are pure ASCII: every non-ASCII character and `<`, `>`, `&` are `\uXXXX` escapes, so hostile text
 *   (bidi controls, invisible characters) never travels raw; JSON.parse gives the exact text back.
 * - Bounded cost: no answer reads all keys of an identity, all rejected events of a contract or all members of a group
 *   (`api-views.ts`), and at most `maxConcurrentRequests` requests are admitted at once (default 8); beyond that a
 *   request is answered at once with 503 `BUSY` and `Retry-After: 1`, before any database work, never queued. On
 *   PostgreSQL the default stays below the connection pool's 10, so the scan loop of the same `serve` process always
 *   gets a connection; on a database with a single session the admitted requests wait for that session, and the cap
 *   bounds that queue.
 * - Never fetches a URI or anything remote; heights only.
 * - Runtime-neutral: it imports no Node built-in and reads no Node global; the host injects the `Sql` and the log.
 */
import type { UmbraDBSql } from "../../src/postgres/client.js";
import {
  type ActivityOptions,
  contractActivity,
  contractTokens,
  DEFAULT_SCHEMAS,
  decodeCursor,
  type EventFilter,
  eventsPage,
  identityDetail,
  KNOWN_GENESIS,
  lookup,
  parseContractTokensCursor,
  parseEventsCursor,
  parseFieldsCursor,
  parseTokensCursor,
  type ScannerState,
  status,
  tokenActivity,
  tokenByColor,
  tokensPage,
  type ViewContext,
} from "./api-views.ts";

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 100;
/** Requests admitted at once by default; more are refused with 503 `BUSY`. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;

export class ApiError extends Error {
  override name = "ApiError";
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const badRequest = (message: string): ApiError => new ApiError(400, "BAD_REQUEST", message);
const notFound = (message: string): ApiError => new ApiError(404, "NOT_FOUND", message);
const orNotFound = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw notFound(message);
  return value;
};

export interface Mip0018HandlerOptions {
  sql: UmbraDBSql;
  network: string;
  /** Schema of the `mip0018` lineage (default `mip0018`). */
  schema?: string;
  /** Schema of the chain archive (default `chain_archive`; read for `archiveHeight` only). */
  archiveSchema?: string;
  /** Genesis hash reported by `/v1/status` (default: the known network's, else `null`). */
  genesisHash?: string | null;
  /** State of the scan loop of the same process (default `off`: API only). */
  scannerState?: () => ScannerState;
  /** Log line of an error answered generically (503 `UNAVAILABLE`, 500 `INTERNAL`); default `console.error`. */
  log?: (line: string) => void;
  /** Requests admitted at once (default {@link DEFAULT_MAX_CONCURRENT_REQUESTS}); more are answered 503 `BUSY`. */
  maxConcurrentRequests?: number;
}

/** One answer of the API, as an HTTP response writes it. */
export interface ApiResponse {
  status: number;
  /** Lower-case names in write order; `content-length` is the UTF-8 byte length of the JSON text, also for `HEAD`. */
  headers: Record<string, string>;
  /** The JSON text (pure ASCII); empty for `HEAD`. */
  body: string;
}

export interface Mip0018Handler {
  /**
   * Answers one request: `method` as received, `target` the request target (path and query, as in an HTTP request
   * line). Every error of the request is answered (400, 404, 405, 500, 503), not thrown. An admitted request counts
   * against the cap until its database work has ended.
   */
  handle(method: string, target: string): Promise<ApiResponse>;
}

// ── Input validation ─────────────────────────────────────────────────────────────────────────────────────────────

/** A 32-byte value as lowercase hex; an optional `0x` prefix and upper case are accepted. */
export function hex32(value: string, what: string): string {
  const v = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw badRequest(`${what} must be 32 bytes as 64 hex digits`);
  return v.toLowerCase();
}

export function kindParam(value: string): number {
  if (value === "1" || value === "2" || value === "3") return Number(value);
  throw badRequest("kind must be 1, 2 or 3");
}

function limitParam(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > MAX_LIMIT) throw badRequest(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  return Number(raw);
}

function cursorParam<T>(raw: string | undefined, parse: (v: unknown) => T | undefined): T | undefined {
  if (raw === undefined) return undefined;
  const decoded = decodeCursor(raw);
  const c = decoded === undefined ? undefined : parse(decoded);
  if (c === undefined) throw badRequest("cursor is not a cursor this endpoint issued");
  return c;
}

/** `limit`, `cursor` and `order` of the activity listings (`activity.ts` binds a cursor to its listing and order). */
function activityParams(q: ReadonlyMap<string, string>): ActivityOptions {
  const order = q.get("order");
  if (order !== undefined && order !== "asc" && order !== "desc") throw badRequest("order must be asc or desc");
  const cursor = q.get("cursor");
  return { limit: limitParam(q.get("limit")), ...(cursor === undefined ? {} : { cursor }), ...(order === undefined ? {} : { order }) };
}

/** Query parameters of a route: only `allowed` names, each at most once, none empty. */
function queryParams(search: URLSearchParams, allowed: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of search) {
    if (!allowed.includes(name)) throw badRequest("unknown query parameter");
    if (out.has(name)) throw badRequest(`query parameter ${name} is given more than once`);
    if (value === "") throw badRequest(`query parameter ${name} is empty`);
    out.set(name, value);
  }
  return out;
}

// ── Output ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** JSON with every non-ASCII character and `<`, `>`, `&` escaped: the body is pure ASCII and parses to the same value. */
export function toAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
} as const;

const UTF8 = new TextEncoder();

function answer(status: number, value: unknown, head: boolean, extra: Record<string, string> = {}): ApiResponse {
  const text = toAsciiJson(value);
  return { status, headers: { ...JSON_HEADERS, ...extra, "content-length": String(UTF8.encode(text).byteLength) }, body: head ? "" : text };
}

const BUSY = { error: { code: "BUSY", message: "too many requests in progress; retry shortly" } } as const;

/**
 * Whether an error comes from the database driver or the connection (→ 503 `UNAVAILABLE`) rather than from this code
 * (→ 500 `INTERNAL`): a `PostgresError` (postgres.js), or a connection, resource or operator-intervention error code.
 */
export function isDatabaseError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { name?: unknown; code?: unknown };
  if (err.name === "PostgresError") return true;
  return typeof err.code === "string" && /^(CONNECT|CONNECTION_|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE|57P|08|53)/.test(err.code);
}

function toApiError(error: unknown, log: (line: string) => void): ApiError {
  if (error instanceof ApiError) return error;
  // The activity read helpers refuse a bad limit, order or cursor with messages that never echo the input.
  if (error instanceof Error && error.name === "ActivityQueryError") return badRequest(error.message);
  const message = error instanceof Error ? error.message : String(error);
  if (isDatabaseError(error)) {
    log(JSON.stringify({ event: "api-error", status: 503, error: message }));
    return new ApiError(503, "UNAVAILABLE", "the index database cannot be read");
  }
  log(JSON.stringify({ event: "api-error", status: 500, error: message }));
  return new ApiError(500, "INTERNAL", "internal error");
}

// ── Handler ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function createMip0018Handler(opts: Mip0018HandlerOptions): Mip0018Handler {
  const schema = opts.schema ?? DEFAULT_SCHEMAS.schema;
  const archiveSchema = opts.archiveSchema ?? DEFAULT_SCHEMAS.archiveSchema;
  const genesis = opts.genesisHash !== undefined ? opts.genesisHash : (KNOWN_GENESIS[opts.network] ?? null);
  const log = opts.log ?? ((line: string) => console.error(line));
  const maxConcurrent = opts.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError(`maxConcurrentRequests must be a positive integer, got ${maxConcurrent}`);
  let inFlight = 0;

  return {
    handle(method: string, target: string): Promise<ApiResponse> {
      const head = method.toUpperCase() === "HEAD";
      // Checked and counted before anything else, method and path included: a refusal costs nothing.
      if (inFlight >= maxConcurrent) return Promise.resolve(answer(503, BUSY, head, { "retry-after": "1" }));
      inFlight++;
      return run(method, target).finally(() => { inFlight--; }).then(
        (body) => answer(200, body, head),
        (error: unknown) => {
          const e = toApiError(error, log);
          return answer(e.status, { error: { code: e.code, message: e.message } }, head, e.status === 405 ? { allow: "GET, HEAD" } : {});
        },
      );
    },
  };

  async function run(requestMethod: string, target: string): Promise<unknown> {
    const method = requestMethod.toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new ApiError(405, "METHOD_NOT_ALLOWED", "only GET and HEAD are supported");
    let url: URL;
    try {
      url = new URL(target, "http://mip0018.invalid");
    } catch {
      throw badRequest("malformed request target");
    }
    const raw = url.pathname.split("/").slice(1);
    if (raw.some((s) => s === "")) throw notFound("no such route");
    let segments: string[];
    try {
      segments = raw.map((s) => decodeURIComponent(s));
    } catch {
      throw badRequest("malformed path");
    }
    if (segments[0] !== "v1") throw notFound("no such route");
    const route = resolve(segments.slice(1));
    const query = queryParams(url.searchParams, route.params);
    return opts.sql.begin("isolation level repeatable read read only", (tx) =>
      route.run({ sql: tx, network: opts.network, schema, archiveSchema }, query));
  }

  interface Route {
    params: readonly string[];
    run: (ctx: ViewContext, query: Map<string, string>) => Promise<unknown>;
  }

  /** Path → route; path values are validated here (400), unknown paths are 404. */
  function resolve(s: readonly string[]): Route {
    const [a, b, c, d] = s;
    if (a === "status" && s.length === 1)
      return { params: [], run: (ctx) => status(ctx, genesis, opts.scannerState?.() ?? "off") };
    if (a === "tokens" && s.length === 1)
      return {
        params: ["limit", "cursor"],
        run: (ctx, q) => tokensPage(ctx, limitParam(q.get("limit")), cursorParam(q.get("cursor"), parseTokensCursor)),
      };
    if (a === "tokens" && s.length === 2) {
      const color = hex32(b!, "color");
      return {
        params: [],
        run: async (ctx) => orNotFound(await tokenByColor(ctx, color), "no token with this color in the indexed range"),
      };
    }
    if (a === "tokens" && s.length === 3 && c === "activity") {
      const color = hex32(b!, "color");
      return {
        params: ["limit", "cursor", "order"],
        run: async (ctx, q) => orNotFound(await tokenActivity(ctx, color, activityParams(q)), "no token with this color in the indexed range"),
      };
    }
    if (a === "contracts" && s.length === 3 && c === "activity") {
      const address = hex32(b!, "address");
      return {
        params: ["limit", "cursor", "order"],
        run: async (ctx, q) => orNotFound(await contractActivity(ctx, address, activityParams(q)), "no such contract in the indexed range"),
      };
    }
    if (a === "identities" && s.length === 4) {
      const ref = { contractAddress: hex32(b!, "contract"), domainSep: hex32(c!, "domainSep"), kind: kindParam(d!) };
      return {
        params: ["limit", "cursor"],
        run: async (ctx, q) => {
          const fieldsCursor = cursorParam(q.get("cursor"), (v) => parseFieldsCursor(v, ref));
          return orNotFound(
            await identityDetail(ctx, ref, { fieldsLimit: limitParam(q.get("limit")), ...(fieldsCursor === undefined ? {} : { fieldsCursor }) }),
            "no such token identity",
          );
        },
      };
    }
    if (a === "contracts" && s.length === 3 && c === "tokens") {
      const address = hex32(b!, "address");
      return {
        params: ["limit", "cursor"],
        run: async (ctx, q) => orNotFound(
          await contractTokens(ctx, address, limitParam(q.get("limit")), cursorParam(q.get("cursor"), (v) => parseContractTokensCursor(v, address))),
          "no such contract in the indexed range",
        ),
      };
    }
    if (a === "lookup" && s.length === 2) {
      const color = hex32(b!, "color");
      return {
        params: ["held"],
        run: (ctx, q) => {
          const held = q.get("held");
          if (held !== "shielded" && held !== "unshielded") throw badRequest("held must be shielded or unshielded");
          return lookup(ctx, color, held);
        },
      };
    }
    if (a === "events" && s.length === 1)
      return {
        params: ["contract", "tx", "limit", "cursor"],
        run: (ctx, q) => {
          const filter: EventFilter = {};
          const contract = q.get("contract");
          const tx = q.get("tx");
          if (contract !== undefined) filter.contract = hex32(contract, "contract");
          if (tx !== undefined) filter.tx = hex32(tx, "tx");
          if (filter.contract === undefined && filter.tx === undefined) throw badRequest("give contract, tx or both");
          return eventsPage(ctx, filter, limitParam(q.get("limit")), cursorParam(q.get("cursor"), (v) => parseEventsCursor(v, filter)));
        },
      };
    throw notFound("no such route");
  }
}
