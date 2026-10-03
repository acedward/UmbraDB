/**
 * The MIP-0018 read-only JSON API (project 00026, sub-plan C1; spec FR-020…FR-022; contract: `token-indexer/API.md`).
 * Node's own `http`, no framework — the pattern of the UmbraDB services (PR #19's token API was read as a guide for
 * the pattern only: keyset pagination, one error envelope, a read snapshot per request).
 *
 * - `GET`/`HEAD` only (405 otherwise, with `Allow`); strict input: 32-byte hex path values, kinds 1–3, no unknown or
 *   repeated query parameters, `limit` 1–500, cursors only as issued (bound to their endpoint and filter).
 * - Every request runs in ONE `REPEATABLE READ READ ONLY` transaction: all statements of an answer see one database
 *   state while the scan commits blocks, and the API cannot write.
 * - Errors: `{ "error": { "code", "message" } }`; messages name the parameter, never echo the input, never carry
 *   internal details (database and unexpected errors are logged server-side and answered generically).
 * - JSON bodies are pure ASCII: every non-ASCII character and `<`, `>`, `&` are `\uXXXX` escapes, so hostile text
 *   (bidi controls, invisible characters) never travels raw; JSON.parse gives the exact text back.
 * - Never fetches a URI or anything remote; heights only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

export interface Mip0018ApiOptions {
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
  /** Server-side log line (errors), default stderr. */
  log?: (line: string) => void;
  /**
   * Static routes answered before the API (sub-plan C3: the explorer page, `ui/page.ts` `serveUi`); returns `true`
   * when it answered the request. Default: none (`/ui` is then a 404 like any unknown path).
   */
  ui?: (req: IncomingMessage, res: ServerResponse) => boolean;
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

/** `limit`, `cursor` and `order` of the activity listings (C2's helpers check the cursor against listing and order). */
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

function send(res: ServerResponse, statusCode: number, body: unknown, head: boolean, extra: Record<string, string> = {}): void {
  const text = toAsciiJson(body);
  res.writeHead(statusCode, { ...JSON_HEADERS, ...extra, "content-length": String(Buffer.byteLength(text, "utf8")) });
  res.end(head ? undefined : text);
}

/** Whether an error comes from the database driver or the connection (→ 503) rather than from this code (→ 500). */
function isDatabaseError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { name?: unknown; code?: unknown };
  if (err.name === "PostgresError") return true;
  return typeof err.code === "string" && /^(CONNECT|CONNECTION_|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE|57P|08|53)/.test(err.code);
}

// ── Server ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function createMip0018Api(opts: Mip0018ApiOptions): Server {
  const schema = opts.schema ?? DEFAULT_SCHEMAS.schema;
  const archiveSchema = opts.archiveSchema ?? DEFAULT_SCHEMAS.archiveSchema;
  const genesis = opts.genesisHash !== undefined ? opts.genesisHash : (KNOWN_GENESIS[opts.network] ?? null);
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  return createServer((req, res) => {
    if (opts.ui?.(req, res) === true) return;
    const head = (req.method ?? "GET").toUpperCase() === "HEAD";
    void handle(req).then(
      (body) => send(res, 200, body, head),
      (error: unknown) => {
        const e = toApiError(error);
        if (res.headersSent) {
          res.end();
          return;
        }
        send(res, e.status, { error: { code: e.code, message: e.message } }, head, e.status === 405 ? { allow: "GET, HEAD" } : {});
      },
    );
  });

  function toApiError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    // C2's read helpers refuse a bad limit, order or cursor with messages that never echo the input.
    if (error instanceof Error && error.name === "ActivityQueryError") return badRequest(error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (isDatabaseError(error)) {
      log(JSON.stringify({ event: "api-error", status: 503, error: message }));
      return new ApiError(503, "UNAVAILABLE", "the index database cannot be read");
    }
    log(JSON.stringify({ event: "api-error", status: 500, error: message }));
    return new ApiError(500, "INTERNAL", "internal error");
  }

  async function handle(req: IncomingMessage): Promise<unknown> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new ApiError(405, "METHOD_NOT_ALLOWED", "only GET and HEAD are supported");
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://mip0018.invalid");
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
      return { params: [], run: async (ctx) => orNotFound(await identityDetail(ctx, ref), "no such token identity") };
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

/** Binds the server and resolves with the port actually bound (`0` asks the OS for a free one). */
export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePort((server.address() as AddressInfo).port);
    });
  });
}
