import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import type { TokenIndexerConfig } from "../config.js";
import { readStatus } from "../ingest/store.js";
import { DASHBOARD_CSP, serveUi } from "../ui/page.js";
import {
  TokenIndexQueries, decodeCursor, type TokenCursor, type TokenJson,
} from "./queries.js";

/**
 * Project 00020 — the read-only JSON API (spec §5), on Node's own `http`, no framework, in the
 * style of `evm-rpc/server.ts`.
 *
 * Route order matters and is deliberate:
 *
 *  1. `serveUi` first — it owns `GET /ui` and the `/` → `/ui` redirect (the page module contract).
 *  2. `/v1/*` and `/internal/*` — the documented API.
 *  3. Everything else falls through to the **tokenUri resolver** `GET /{token-name}/{id}`, which is
 *     what makes the reference contracts' on-chain `tokenUri` (`http://localhost:10020/constellations/orion`)
 *     a link that actually resolves. Registering it last is what keeps the named routes winning.
 *
 * Errors are `{ "error": { "code", "message" } }` with `400 TOKEN_BAD_REQUEST`,
 * `404 TOKEN_NOT_FOUND`, `409 TOKEN_AMBIGUOUS` and `503 TOKEN_DB_UNAVAILABLE`.
 */

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 100;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

const badRequest = (message: string): ApiError => new ApiError(400, "TOKEN_BAD_REQUEST", message);
const notFound = (message: string): ApiError => new ApiError(404, "TOKEN_NOT_FOUND", message);

/** Lowercase unprefixed 64-hex, or a `400` naming the field — never a silent truncation. */
function hex32(value: string, what: string): string {
  const v = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw badRequest(`${what} must be 64 hex characters`);
  return v.toLowerCase();
}

function kindParam(value: string): string {
  if (value !== "shielded" && value !== "unshielded") {
    throw badRequest(`kind must be "shielded" or "unshielded", got ${JSON.stringify(value)}`);
  }
  return value;
}

function limitParam(raw: string | null): number {
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function cursorParam<T>(raw: string | null): T | undefined {
  if (raw === null || raw === "") return undefined;
  try {
    return decodeCursor<T>(raw);
  } catch {
    throw badRequest("cursor is not a cursor this API issued");
  }
}

function enumParam(raw: string | null, allowed: readonly string[], what: string): string | undefined {
  if (raw === null || raw === "") return undefined;
  if (!allowed.includes(raw)) {
    throw badRequest(`${what} must be one of ${allowed.join(", ")}`);
  }
  return raw;
}

/** `Constellations · Orion` → `constellations`; used for both halves of the resolver path. */
export function slugOfFirstWord(name: string | null): string | null {
  if (name === null) return null;
  const first = name.trim().split(/[\s·:/|-]+/u)[0] ?? "";
  const slug = first.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  return slug === "" ? null : slug;
}

/** The full name as a slug — `Constellations · Orion` → `constellationsorion`. */
export function slugOfName(name: string | null): string | null {
  if (name === null) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  return slug === "" ? null : slug;
}

/** The domain separator's readable text: its UTF-8 bytes with the trailing NUL padding removed. */
export function domainText(domainSepHex: string): string | null {
  const bytes = Buffer.from(domainSepHex, "hex");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return null;
  }
}

/**
 * Does `token` answer to `/{name}/{id}`?
 *
 * `{name}`: the symbol (case-insensitive), the slug of the first word of the name, or the 64-hex
 * contract address. `{id}`: the domain separator's text after a `<symbol lowercase>:` prefix
 * (`orion` ↔ `cnst:orion`), the whole domain text, the token's own name slug, or the 64-hex domain
 * separator. All comparisons are case-insensitive, because a URL in a document is typed by hand.
 */
export function resolverMatches(token: TokenJson, name: string, id: string): boolean {
  const n = name.toLowerCase();
  const i = id.toLowerCase();

  const nameMatches = token.address === n
    || token.symbol?.toLowerCase() === n
    || slugOfFirstWord(token.name) === n;
  if (!nameMatches) return false;

  if (token.domainSep === i) return true;
  const text = domainText(token.domainSep)?.toLowerCase() ?? null;
  if (text === i) return true;
  if (text !== null) {
    const symbolPrefix = `${token.symbol?.toLowerCase() ?? ""}:`;
    if (token.symbol !== null && text.startsWith(symbolPrefix) && text.slice(symbolPrefix.length) === i) return true;
    const afterAnyColon = text.includes(":") ? text.slice(text.lastIndexOf(":") + 1) : null;
    if (afterAnyColon === i) return true;
  }
  if (slugOfName(token.name) === i) return true;
  const lastWord = token.name?.trim().split(/[\s·:/|-]+/u).pop()?.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  if (lastWord !== undefined && lastWord !== "" && lastWord === i) return true;
  return false;
}

export interface TokenApiOptions {
  sql: UmbraDBSql;
  config: TokenIndexerConfig;
}

export function createTokenApi(opts: TokenApiOptions): Server {
  const queries = new TokenIndexQueries(opts.sql, opts.config.schema, opts.config.net);

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendError(res, toApiError(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. The page owns /ui and /.
    if (serveUi(req, res)) return;

    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      sendError(res, new ApiError(405, "TOKEN_BAD_REQUEST", `method ${method} is not supported`));
      return;
    }
    const url = new URL(req.url ?? "/", "http://token-indexer.invalid");
    const segments = url.pathname.split("/").filter((s) => s !== "").map(decodeURIComponent);
    const query = url.searchParams;

    if (segments[0] === "internal" && segments[1] === "status" && segments.length === 2) {
      sendJson(res, 200, await readStatus(opts.sql, opts.config));
      return;
    }

    if (segments[0] === "v1") {
      await handleV1(segments.slice(1), query, res);
      return;
    }

    // 3. Everything else is the tokenUri resolver.
    await handleResolver(segments, req, res);
  }

  async function handleV1(segments: string[], query: URLSearchParams, res: ServerResponse): Promise<void> {
    // /v1/tokens
    if (segments[0] === "tokens" && segments.length === 1) {
      const page = await queries.listTokens({
        kind: enumParam(query.get("kind"), ["shielded", "unshielded"], "kind"),
        storage: enumParam(query.get("storage"), ["native", "ledger"], "storage"),
        status: enumParam(query.get("status"), ["observed", "declared", "described", "inconsistent", "builtin"], "status"),
        q: query.get("q") ?? undefined,
        limit: limitParam(query.get("limit")),
        cursor: cursorParam<TokenCursor>(query.get("cursor")),
      });
      sendJson(res, 200, page);
      return;
    }

    // /v1/tokens/by-color/:color
    if (segments[0] === "tokens" && segments[1] === "by-color" && segments.length === 3) {
      sendJson(res, 200, await queries.tokensByColor(hex32(segments[2]!, "color")));
      return;
    }

    // /v1/registry.json
    if (segments[0] === "registry.json" && segments.length === 1) {
      sendJson(res, 200, {
        net: opts.config.net,
        generatedAt: new Date().toISOString(),
        tokens: await queries.registry(),
      });
      return;
    }

    if (segments[0] === "contracts" && segments.length >= 2) {
      const address = hex32(segments[1]!, "address");

      // /v1/contracts/:address
      if (segments.length === 2) {
        const contract = await queries.contract(address);
        const tokens = await queries.tokensOfContract(address);
        if (contract === undefined && tokens.length === 0) throw notFound(`no contract ${address}`);
        sendJson(res, 200, {
          address,
          deployHeight: contract?.deployHeight ?? null,
          deployTxHash: contract?.deployTxHash ?? null,
          lastCallHeight: contract?.lastCallHeight ?? null,
          tokens,
          pendingLookups: await queries.pendingLookupsForContract(address),
        });
        return;
      }

      // /v1/contracts/:address/events
      if (segments[2] === "events" && segments.length === 3) {
        const appliedRaw = query.get("applied");
        const applied = appliedRaw === null || appliedRaw === ""
          ? undefined
          : appliedRaw === "true" ? true : appliedRaw === "false" ? false : undefined;
        if (appliedRaw !== null && appliedRaw !== "" && applied === undefined) {
          throw badRequest('applied must be "true" or "false"');
        }
        const domainSepRaw = query.get("domainSep");
        sendJson(res, 200, await queries.contractEvents(address, {
          applied,
          domainSep: domainSepRaw === null || domainSepRaw === "" ? undefined : hex32(domainSepRaw, "domainSep"),
          limit: limitParam(query.get("limit")),
          cursor: cursorParam<{ eventId: number }>(query.get("cursor")),
        }));
        return;
      }

      // /v1/contracts/:address/tokens/:domainSep/:kind[/metadata|/mints]
      if (segments[2] === "tokens" && segments.length >= 5) {
        const domainSep = hex32(segments[3]!, "domainSep");
        const kind = kindParam(segments[4]!);

        if (segments.length === 5) {
          const token = await queries.token(address, domainSep, kind);
          if (token === undefined) throw notFound(`no token ${address}/${domainSep}/${kind}`);
          sendJson(res, 200, token);
          return;
        }
        if (segments[5] === "metadata" && segments.length === 6) {
          sendJson(res, 200, { keys: await queries.metadataKeys(address, domainSep, kind) });
          return;
        }
        if (segments[5] === "mints" && segments.length === 6) {
          sendJson(res, 200, await queries.mints(address, domainSep, kind, {
            limit: limitParam(query.get("limit")),
            cursor: cursorParam(query.get("cursor")),
          }));
          return;
        }
      }
    }

    throw notFound(`no route /v1/${segments.join("/")}`);
  }

  /**
   * `GET /{token-name}/{id}` — the tokenUri resolver (spec §5). One match answers with the token's
   * metadata document; none is a 404; several is a `409 TOKEN_AMBIGUOUS` carrying the candidates,
   * because symbols are not unique on a public chain and guessing would be worse than asking.
   */
  async function handleResolver(segments: string[], req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (segments.length !== 2) {
      throw notFound(`no route /${segments.join("/")}`);
    }
    const [name, id] = segments as [string, string];
    const candidates = (await queries.resolverCandidates(name)).filter((t) => resolverMatches(t, name, id));

    if (candidates.length === 0) throw notFound(`nothing resolves /${name}/${id}`);
    if (candidates.length > 1) {
      throw new ApiError(409, "TOKEN_AMBIGUOUS", `/${name}/${id} matches ${candidates.length} tokens`,
        candidates.map((t) => ({ address: t.address, domainSep: t.domainSep, kind: t.kind })));
    }
    const token = candidates[0]!;

    // A browser following the link from the page gets the page's own token view.
    const accept = String(req.headers.accept ?? "");
    if (accept.includes("text/html")) {
      res.writeHead(302, {
        location: `/ui#/token/${token.address}/${token.domainSep}/${token.kind}`,
        "cache-control": "no-store", "content-length": "0",
      });
      res.end();
      return;
    }

    const keys = await queries.metadataKeys(token.address, token.domainSep, token.kind);
    const traits: Record<string, { value: string; text: string | null; updatedHeight: number; eventId: number }> = {};
    for (const key of keys) {
      traits[key.key] = {
        value: key.value, text: key.text, updatedHeight: key.updatedHeight, eventId: key.eventId,
      };
    }
    const metadata = (token.metadata ?? null) as Record<string, unknown> | null;
    sendJson(res, 200, {
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      description: metadata?.description ?? null,
      image: metadata?.image ?? null,
      tokenUri: token.tokenUri,
      traits,
      metadata,
      address: token.address,
      domainSep: token.domainSep,
      domainSepText: domainText(token.domainSep),
      kind: token.kind,
      storage: token.storage,
      color: token.color,
      status: token.status,
      mints: {
        count: token.mintCount,
        total: token.totalMinted,
        first: token.firstMintHeight,
        last: token.lastMintHeight,
      },
    });
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // Anything that reaches here from a query is a database problem, which is a 503 rather than a
  // 500: the index is a read-through view of Postgres, and a caller should retry.
  return new ApiError(503, "TOKEN_DB_UNAVAILABLE", message);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text, "utf8")),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // The page is served from this same origin, so the API answers under its CSP too.
    "content-security-policy": DASHBOARD_CSP,
  });
  res.end(text);
}

function sendError(res: ServerResponse, error: ApiError): void {
  if (res.headersSent) { res.end(); return; }
  sendJson(res, error.status, {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { candidates: error.details }),
    },
  });
}

/** Binds the API and resolves with the port actually bound — `0` asks the OS for a free one, which
 *  is what every test uses. */
export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
