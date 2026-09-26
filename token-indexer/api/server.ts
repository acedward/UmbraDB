import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { loadLedgerV9 } from "../../chain-archive-sync/tx-replay-decoder.js";
import type { TokenIndexerConfig } from "../config.js";
import { decodeTokenFlows } from "../ingest/decode.js";
import { readStatus } from "../ingest/store.js";
import { DASHBOARD_CSP, serveUi } from "../ui/page.js";
import {
  TokenIndexQueries, decodeCursor,
  type ActivityCursor, type ContractCallCursor, type ShieldedOfferCursor,
  type TokenCursor, type TokenJson, type TraitJson,
} from "./queries.js";

/**
 * Project 00020 — the read-only JSON API (spec §5), on Node's own `http`, no framework, in the
 * style of `evm-rpc/server.ts`.
 *
 * Amended by project 00021 (FR-106): `Token.kind` is the MIP's byte 0–3 with `privacy`/`storage`
 * beside it, `:kind` path segments take `0`–`3` (and, for one release, the old words mapped to the
 * two native kinds), traits carry their `val-type`/`val-len` and any projection error, and
 * `GET /v1/contracts/:address/tokens/:domainSep` lists the rows sharing that pair — the MIP's
 * "a consumer MAY link rows that share `(contractAddress, domainSep)`" (§4).
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

/** How long a chain-head reading is reused before another is fetched (owner decision Q21). The
 *  status view auto-refreshes every 10 s, so one cached reading per refresh is the point. */
export const CHAIN_HEAD_TTL_MS = 10_000;
/** …and how long the fetch itself may take before the status route gives up on it and answers
 *  without a head. The archive is the source of facts; the head is a convenience. */
const CHAIN_HEAD_TIMEOUT_MS = 2_500;

/**
 * Reads the chain's own head from the public indexer, at most once per {@link CHAIN_HEAD_TTL_MS}.
 *
 * Every failure mode ends in `null` rather than an exception: no indexer configured, a network
 * error, a non-200, a GraphQL error, a body that is not a number, or a call that takes longer than
 * {@link CHAIN_HEAD_TIMEOUT_MS}. `GET /internal/status` must answer from the database alone; this
 * number is the one thing in it the database cannot know, and it is never allowed to hold the
 * route up or break it. A reading already in flight is shared rather than duplicated.
 */
export function makeChainHeadReader(
  indexerHttp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): () => Promise<number | null> {
  if (indexerHttp === undefined || indexerHttp === "") return async () => null;
  let cachedAt = 0;
  let cached: number | null = null;
  let inFlight: Promise<number | null> | null = null;

  const readOnce = async (): Promise<number | null> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CHAIN_HEAD_TIMEOUT_MS);
    try {
      const res = await fetchImpl(indexerHttp, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ block { height } }" }),
        signal: abort.signal,
      });
      if (!res.ok) return null;
      const body = await res.json() as { data?: { block?: { height?: unknown } | null } };
      const height = body.data?.block?.height;
      return typeof height === "number" && Number.isFinite(height) ? height : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return async () => {
    const now = Date.now();
    if (now - cachedAt < CHAIN_HEAD_TTL_MS) return cached;
    if (inFlight !== null) return inFlight;
    inFlight = readOnce().then((value) => {
      // A failed reading is cached too, so a dead indexer costs one call per TTL, not one per hit.
      cached = value;
      cachedAt = Date.now();
      inFlight = null;
      return value;
    });
    return inFlight;
  };
}

/** Spec FR-001's seven roles, for the `?role=` filter. A typo is a 400 naming all seven rather
 *  than an empty page that reads as "there are none". */
export const ACTIVITY_ROLES = [
  "utxo_out", "utxo_in", "contract_in", "contract_out", "mint", "shielded_delta", "reward",
] as const;

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

/**
 * The `:kind` path segment and the `kind=` filter (FR-106, spec Q2).
 *
 * The MIP's identity carries the kind BYTE, so `0`–`3` is the spelling. The 00020 words `shielded`
 * and `unshielded` are accepted for one release and mapped to the two NATIVE kinds (1 and 0) — the
 * only ones they could ever have meant, since 00020 had no ledger rows keyed by kind. Anything else
 * is a 400 that says both spellings out loud rather than guessing.
 */
export function kindParam(value: string): number {
  if (value === "0" || value === "1" || value === "2" || value === "3") return Number(value);
  if (value === "shielded") return 1;
  if (value === "unshielded") return 0;
  throw badRequest(
    `kind must be 0, 1, 2 or 3 (or, for one release, "shielded"/"unshielded" for the native kinds), `
    + `got ${JSON.stringify(value)}`,
  );
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
/** A token the `/{name}/{id}` resolver can answer for: one whose contract is known. */
export type ResolvableToken = TokenJson & { address: string; domainSep: string };

export function resolverMatches(token: TokenJson, name: string, id: string): token is ResolvableToken {
  const n = name.toLowerCase();
  const i = id.toLowerCase();

  // A `seen` row has no contract and no separator, so no `/{name}/{id}` path can name it: it is
  // reachable by colour alone (00023 US5). Bail out before every comparison below assumes a string.
  if (token.address === null || token.domainSep === null) return false;

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
  /** The loaded ledger module, for `GET /v1/transactions/:hash`, which decodes on request (Q5).
   *  `serve` passes the one it already loaded; when it is absent — `serve --api-only`, or a test
   *  that never calls the route — it is loaded lazily on the first request and cached, so no
   *  process pays for the WASM until something actually needs a decode. */
  ledger?: unknown;
}

export function createTokenApi(opts: TokenApiOptions): Server {
  const queries = new TokenIndexQueries(
    opts.sql, opts.config.schema, opts.config.net, opts.config.archiveSchema,
  );
  const chainHead = makeChainHeadReader(opts.config.indexerHttp);
  let ledgerPromise: Promise<unknown> | undefined =
    opts.ledger === undefined ? undefined : Promise.resolve(opts.ledger);
  const ledgerOf = async (): Promise<unknown> => {
    ledgerPromise ??= loadLedgerV9();
    return ledgerPromise;
  };

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
      sendJson(res, 200, await readStatus(opts.sql, opts.config, chainHead));
      return;
    }

    // Every data route answers from ONE database snapshot (01-D audit F6): a token's values, their
    // origins, its traits and its mints are read by separate statements, and a fold committing in
    // between must not show in some of them and not in others.
    if (segments[0] === "v1") {
      await queries.inSnapshot(() => handleV1(segments.slice(1), query, res));
      return;
    }

    // 3. Everything else is the tokenUri resolver.
    await queries.inSnapshot(() => handleResolver(segments, req, res));
  }

  /** Spec §5's read-time `Token` counts. A LEDGER kind has no colour and therefore no activity
   *  row; its physical key is a private digest that never leaves the schema, so the counts are
   *  zeros rather than a query that could never match. */
  async function countsOf(token: TokenJson): Promise<{
    activityCount: number; lastActivityHeight: number | null;
    disclosedTransactions?: number; undisclosedShieldedOffers?: number;
  }> {
    if (token.color === null) return { activityCount: 0, lastActivityHeight: null };
    return queries.tokenCounts(token.color, token.kind);
  }

  async function handleV1(segments: string[], query: URLSearchParams, res: ServerResponse): Promise<void> {
    // /v1/tokens
    if (segments[0] === "tokens" && segments.length === 1) {
      const rawKind = query.get("kind");
      const page = await queries.listTokens({
        kind: rawKind === null || rawKind === "" ? undefined : kindParam(rawKind),
        privacy: enumParam(query.get("privacy"), ["shielded", "unshielded"], "privacy"),
        storage: enumParam(query.get("storage"), ["native", "ledger"], "storage"),
        // MIP §7.2's three consumer states, this repository's `builtin`, and 00023's `seen` — a
        // colour public data proves exists whose issuer is not knowable (US5). The 00020 status for
        // a self-contradicting row no longer exists, so asking for it is a 400 rather than an empty
        // page that looks like an answer.
        status: enumParam(query.get("status"), ["seen", "observed", "declared", "described", "builtin"], "status"),
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

    // /v1/colors/:color — everything this index knows about one colour, in one document: the
    // contract behind it, the domain separator, the native row(s) carrying the colour with their
    // typed traits and mint history, and the other rows under the same (contract, domainSep).
    //
    // A colour is derived from (domainSep, address) alone, so it does not pin the kind: an
    // unshielded and a shielded mint under one domain separator share it, and both rows are
    // returned under `tokens`. Ledger rows (kind 2/3) never have a colour; when one shares the
    // pair it is listed under `related`. `mints` is the first page (`?limit=`, oldest first); its
    // `nextCursor` continues on the per-token `/mints` route.
    if (segments[0] === "colors" && segments.length === 2) {
      const color = hex32(segments[1]!, "color");
      const limit = limitParam(query.get("limit"));
      const rows = await queries.tokensByColor(color);
      if (rows.length === 0) throw notFound(`no token has colour ${color}`);
      // A `seen` row (00023 US5) has no contract at all: the colour is public, the issuer is not.
      // The document then carries `address: null`, no contract, no traits and no mints — which is
      // exactly what is known — rather than inventing a contract the chain never revealed.
      const withContract = rows.find((t) => t.address !== null && t.domainSep !== null);
      const address = withContract?.address ?? null;
      const domainSep = withContract?.domainSep ?? null;
      const builtin = rows.every((t) => t.status === "builtin");
      const [contract, pair] = await Promise.all([
        builtin || address === null ? Promise.resolve(undefined) : queries.contract(address),
        builtin || address === null || domainSep === null
          ? Promise.resolve(rows)
          : queries.tokensOfContractDomain(address, domainSep),
      ]);
      const tokens = await Promise.all(rows.map(async (token) => {
        const counts = await countsOf(token);
        if (token.address === null || token.domainSep === null) {
          return { ...token, ...counts, traits: [], mints: { items: [], nextCursor: null } };
        }
        const [traits, mints] = await Promise.all([
          queries.metadataKeys(token.address, token.domainSep, token.kind),
          queries.mints(token.address, token.domainSep, token.kind, { limit }),
        ]);
        return { ...token, ...counts, traits, mints };
      }));
      const carried = new Set(rows.map((t) => t.kind));
      sendJson(res, 200, {
        color,
        address,
        domainSep,
        domainSepText: domainSep === null ? null : domainText(domainSep),
        builtin,
        contract: contract ?? null,
        tokens,
        related: pair.filter((t) => !carried.has(t.kind)),
      });
      return;
    }

    // /v1/colors/:color/transactions — one colour's activity, both kinds unless narrowed (FR-008).
    // This is the route a `seen` row's page uses: a colour whose issuer is not knowable has no
    // `(address, domainSep)` to build the token route from (US5).
    if (segments[0] === "colors" && segments[2] === "transactions" && segments.length === 3) {
      const color = hex32(segments[1]!, "color");
      const rawKind = query.get("kind");
      sendJson(res, 200, await queries.activityOfColor(color, {
        kind: rawKind === null || rawKind === "" ? undefined : kindParam(rawKind),
        role: enumParam(query.get("role"), ACTIVITY_ROLES, "role"),
        limit: limitParam(query.get("limit")),
        cursor: cursorParam<ActivityCursor>(query.get("cursor")),
      }));
      return;
    }

    // /v1/transactions/:hash — the full public decode of §4, computed from the ARCHIVED BYTES on
    // request (owner decision Q5): no stored document to go stale, and a decoder fix needs no
    // rebuild. The stored activity rows come with it, each with its token resolved.
    if (segments[0] === "transactions" && segments.length === 2) {
      const hash = hex32(segments[1]!, "hash");
      const archived = await queries.archivedTransaction(hash);
      if (archived === undefined) throw notFound(`no archived transaction ${hash}`);
      const flows = decodeTokenFlows(
        await ledgerOf(), new Uint8Array(archived.raw),
        // A transaction the archive has not resolved yet cannot be attributed; the view still
        // decodes in full, with every section marked uncounted rather than silently counted.
        archived.result ?? "failure", archived.segments, archived.txHash,
      );
      const activity = await queries.activityOfTx(hash);
      // Spec §5's `deltas[] {color, delta, tokenName?}`: a delta names a SHIELDED colour (kind 1),
      // so the name beside it is that row's — resolved here rather than stored, like every other
      // identity in this API.
      const deltaColors = new Set<string>();
      for (const offer of flows.view.offers) for (const d of offer.deltas) deltaColors.add(d.color);
      const names = await queries.tokenNamesOfColors([...deltaColors], 1);
      const offers = flows.view.offers.map((offer) => ({
        ...offer,
        deltas: offer.deltas.map((d) => ({ ...d, tokenName: names[d.color]?.name ?? null })),
      }));
      sendJson(res, 200, {
        ...flows.view,
        offers,
        // The archive's own facts about where and how it landed (no wall-clock time — Q1).
        blockHeight: archived.blockHeight,
        blockHash: archived.blockHash,
        txPosition: archived.txPosition,
        protocolVersion: archived.protocolVersion,
        transactionKind: archived.kind,
        result: archived.result,
        segments: archived.segments,
        activity,
      });
      return;
    }

    // /v1/shielded-offers — every zswap offer on the chain; `undisclosed=true` is the list behind
    // the disclosure panel's chain-wide figure (FR-018, US4): "any of these may be this token; the
    // ledger does not say".
    if (segments[0] === "shielded-offers" && segments.length === 1) {
      const raw = query.get("undisclosed");
      const undisclosed = raw === null || raw === ""
        ? undefined
        : raw === "true" ? true : raw === "false" ? false : undefined;
      if (raw !== null && raw !== "" && undisclosed === undefined) {
        throw badRequest('undisclosed must be "true" or "false"');
      }
      sendJson(res, 200, await queries.shieldedOffers({
        undisclosed,
        limit: limitParam(query.get("limit")),
        cursor: cursorParam<ShieldedOfferCursor>(query.get("cursor")),
      }));
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

      // /v1/contracts/:address/calls — every call of this contract with every public field of
      // each transcript (FR-020, US7). This is a LEDGER token's only activity, and the page lists
      // it under the owner's note: only public data is listed; we do not have access to the code
      // this executes, so what a call means for balances is defined by the contract and is not
      // readable here (Q4).
      if (segments[2] === "calls" && segments.length === 3) {
        sendJson(res, 200, await queries.callsOfContract(address, {
          limit: limitParam(query.get("limit")),
          cursor: cursorParam<ContractCallCursor>(query.get("cursor")),
        }));
        return;
      }

      // /v1/contracts/:address/tokens/:domainSep — every row sharing that pair (MIP §4's "a
      // consumer MAY link rows that share (contractAddress, domainSep)"; FR-106). This is how the
      // Ledger Liar's two rows are shown as one asset in two representations rather than as a
      // contradiction, and how a dual-minted domain separator shows its shielded and unshielded
      // halves side by side.
      if (segments[2] === "tokens" && segments.length === 4) {
        const domainSep = hex32(segments[3]!, "domainSep");
        const tokens = await queries.tokensOfContractDomain(address, domainSep);
        if (tokens.length === 0) throw notFound(`no token ${address}/${domainSep}`);
        sendJson(res, 200, { address, domainSep, domainSepText: domainText(domainSep), tokens });
        return;
      }

      // /v1/contracts/:address/tokens/:domainSep/:kind[/metadata|/mints]
      if (segments[2] === "tokens" && segments.length >= 5) {
        const domainSep = hex32(segments[3]!, "domainSep");
        const kind = kindParam(segments[4]!);

        if (segments.length === 5) {
          const token = await queries.token(address, domainSep, kind);
          if (token === undefined) throw notFound(`no token ${address}/${domainSep}/${kind}`);
          // The read-time counts spec §5 adds (00023): how much activity this token has, where it
          // last moved, and — for a shielded native token — how many transactions published its
          // colour against how many offers chain-wide published none (US4).
          sendJson(res, 200, { ...token, ...await countsOf(token) });
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
        // /v1/contracts/:address/tokens/:domainSep/:kind/transactions (FR-006)
        if (segments[5] === "transactions" && segments.length === 6) {
          const token = await queries.token(address, domainSep, kind);
          if (token === undefined) throw notFound(`no token ${address}/${domainSep}/${kind}`);
          // For the two NATIVE kinds the physical key IS the colour, so the token route and the
          // colour route are the same query. A LEDGER kind has no colour and therefore no activity
          // row at all: the answer is an empty page, and `shieldedVisibility: "calls-only"` on the
          // token tells the page to show `/calls` instead (US7).
          const tokenKey = token.color ?? undefined;
          if (tokenKey === undefined) {
            sendJson(res, 200, { items: [], nextCursor: null });
            return;
          }
          sendJson(res, 200, await queries.activityOfToken(tokenKey, kind, {
            role: enumParam(query.get("role"), ACTIVITY_ROLES, "role"),
            limit: limitParam(query.get("limit")),
            cursor: cursorParam<ActivityCursor>(query.get("cursor")),
          }));
          return;
        }
      }
    }

    throw notFound(`no route /v1/${segments.join("/")}`);
  }

  /**
   * `GET /{token-name}/{id}` and `GET /{token-name}/{id}/{kind}` — the tokenUri resolver (spec §5).
   * One match answers with the token's metadata document; none is a 404; several is a
   * `409 TOKEN_AMBIGUOUS` carrying the candidates, because symbols are not unique on a public chain
   * and guessing would be worse than asking.
   *
   * **The optional third segment is 00021's doing** (question Q11). Under MIP §4 the kind byte is
   * part of the identity, so a two-segment path can now name two real tokens: a domain separator
   * minted both shielded and unshielded, or a contract that declares a ledger book and mints
   * natively. The two-segment form is left exactly as it was — it is what contracts bake into their
   * `tokenUri` — and a caller that hits the 409 can append the kind the 409 just told it about.
   */
  async function handleResolver(segments: string[], req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (segments.length !== 2 && segments.length !== 3) {
      throw notFound(`no route /${segments.join("/")}`);
    }
    const [name, id] = segments as [string, string];
    const kind = segments.length === 3 ? kindParam(segments[2]!) : undefined;
    const candidates = (await queries.resolverCandidates(name))
      .filter((t): t is ResolvableToken => resolverMatches(t, name, id))
      .filter((t) => kind === undefined || t.kind === kind);

    const path = segments.map((s) => `/${s}`).join("");
    if (candidates.length === 0) throw notFound(`nothing resolves ${path}`);
    if (candidates.length > 1) {
      throw new ApiError(409, "TOKEN_AMBIGUOUS",
        `${path} matches ${candidates.length} tokens — append the kind byte to choose one`,
        candidates.map((t) => ({
          address: t.address, domainSep: t.domainSep, kind: t.kind,
          privacy: t.privacy, storage: t.storage, path: `${path}/${t.kind}`,
        })));
    }
    const token = candidates[0]!;

    // The resolver always answers with the metadata document itself, also to a browser: the whole
    // point of a tokenUri is to open it and read what the token declared (owner, 2026-09-17 — the
    // earlier Accept: text/html redirect to the page's token view made the link look inert). The
    // page opens these links in a new tab, so the explorer stays where it was.

    const keys = await queries.metadataKeys(token.address, token.domainSep, token.kind);
    // Keyed by the key's TEXT where it has one and by `hex:<bytes>` where it does not: MIP §5.1
    // allows a key that is not UTF-8 at all, and a JSON object still has to name it somehow.
    const traits: Record<string, Omit<TraitJson, "key" | "updatedTxHash">> = {};
    for (const key of keys) {
      const { key: text, updatedTxHash: _tx, ...rest } = key;
      traits[text ?? `hex:${key.keyHex}`] = rest;
    }
    const metadata = (token.metadata ?? null) as Record<string, unknown> | null;
    // The other representations of this asset (MIP §4): the rows sharing (address, domainSep).
    const linked = (await queries.tokensOfContractDomain(token.address, token.domainSep))
      .filter((t) => t.kind !== token.kind)
      .map((t) => ({
        kind: t.kind, privacy: t.privacy, storage: t.storage, status: t.status,
        name: t.name, symbol: t.symbol, color: t.color,
      }));
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
      privacy: token.privacy,
      storage: token.storage,
      linked,
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
