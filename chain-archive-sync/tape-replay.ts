import type { ArchiveTape } from "./archive-tape.js";
import type { IndexerBlock } from "./indexer-client.js";

/**
 * Answers the archive sync's network calls from a recorded tape, with no network and no Node API: the Substrate
 * JSON-RPC calls (`POST /rpc`: `chain_getFinalizedHead`, `chain_getBlockHash`, `chain_getHeader`, `chain_getBlock`)
 * and the Midnight indexer's GraphQL (`POST /graphql`: the tip, `block(offset: { height })` and, when given the
 * recorded answers, `contractEvents`), exactly the calls `ChainArchiveSyncService` makes. `chain_getBlockHash(0)`
 * answers the tape's genesis hash.
 *
 * {@link createTapeReplay} is the answering core: a request path and body text in, a status, headers and body text
 * out. {@link createTapeFetch} puts it behind a function with `fetch`'s signature, to hand to the node and indexer
 * clients as their `fetchImpl`: a runtime without sockets, such as a browser worker, replays a tape this way, offline.
 * The test suite's `node:http` fake chain serves the same core over real HTTP.
 *
 * The reported finalized height (node finalized head and indexer tip alike) is the tape's highest height unless set.
 * It can move: by hand ({@link TapeReplay.setFinalizedHeight}, {@link TapeReplay.advanceFinalizedHeight}) or with a
 * clock ({@link TipAdvance}), so a follower sees new finalized blocks arrive.
 *
 * Test seams: per-height indexer overrides (synthetic transaction outcomes on real bytes), a per-response delay,
 * throttling injection (429/403/5xx with `Retry-After`, or an HTML page with status 200) and request counters.
 */

/** The JSON-RPC path. */
export const TAPE_RPC_PATH = "/rpc";
/** The GraphQL path. */
export const TAPE_GRAPHQL_PATH = "/graphql";
/** The origin {@link createTapeFetch} answers by default: the `.invalid` top-level domain never resolves, so the URLs
 *  cannot reach a real host if handed to another `fetch` by mistake. */
export const DEFAULT_TAPE_ORIGIN = "http://tape.invalid";

export interface TapeThrottle {
  /** JSON-RPC method name, or `indexer.block` / `indexer.tip` / `indexer.contractEvents`. */
  operation: string;
  /** How many matching requests to answer with `status` before serving normally. */
  times: number;
  status: number;
  retryAfter?: string;
  /** Answer HTTP 200 with an HTML body instead (a proxy error page). */
  htmlBody?: boolean;
}

/** The recorded `contractEvents` answer for one (contract, transaction) pair: every event, in the indexer's order. */
export interface TapeContractEvents {
  /** Lower-case hex without `0x`. */
  contractAddress: string;
  /** Lower-case hex without `0x`. */
  txHash: string;
  events: readonly unknown[];
}

/** A reported finalized height that rises with a clock: `by` blocks every `everyMs` milliseconds of `now()` since the
 *  height was last set, up to `until`. */
export interface TipAdvance {
  /** Milliseconds per step (> 0). */
  everyMs: number;
  /** Blocks per step (a positive integer). Default 1. */
  by?: number;
  /** The highest height it reports. Default: the tape's highest height. */
  until?: number;
}

export interface TapeReplayOptions {
  /** Height reported as finalized head / indexer tip. Default: the tape's highest height. */
  finalizedHeight?: number;
  /** Lets the reported height rise with the clock. Without it the height moves only by hand. */
  advance?: TipAdvance;
  /** The clock of {@link advance} and of the manual moves, in milliseconds. Default `Date.now`. */
  now?: () => number;
  /** Replaces the indexer's block for a height (e.g. a synthetic transaction outcome). */
  indexerOverrides?: ReadonlyMap<number, IndexerBlock>;
  /** Milliseconds every response waits before being answered. */
  delayMs?: number;
  throttles?: readonly TapeThrottle[];
  /** Recorded `contractEvents` answers; the indexer then answers
   *  `contractEvents(filter: { contractAddress, transactionHash }, limit, offset)` from them, in the recorded order.
   *  Without them every such query answers an empty list. */
  contractEvents?: readonly TapeContractEvents[];
}

/** One answer: the HTTP status, the response headers (lower-case names) and the body text. */
export interface TapeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface TapeReplay {
  /**
   * Answers one request. `target` is the request path (`/rpc`, `/graphql`; anything else is 404) and `body` the request
   * body text. A body that is not JSON, an unsupported JSON-RPC method or a finalized height missing from the tape
   * answers 500 with `{ error }`. Rejects only when `signal` aborts, with its reason.
   */
  answer(target: string, body: string, signal?: AbortSignal): Promise<TapeResponse>;
  /** Requests served per operation (`chain_getBlock`, `indexer.block`, ...), throttled ones included. */
  readonly counts: Map<string, number>;
  /** The finalized height reported right now. */
  finalizedHeight(): number;
  /** Reports `height` from now on (the clock's advance, if any, counts from now). */
  setFinalizedHeight(height: number): void;
  /** Raises the reported height by `blocks` (default 1), never past the advance's `until` or the tape's highest
   *  height, and returns the new height. */
  advanceFinalizedHeight(blocks?: number): number;
}

const noPrefix = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();

const isPositiveInteger = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/** Waits `ms`, or rejects with `signal`'s reason as soon as it aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createTapeReplay(tape: ArchiveTape, opts: TapeReplayOptions = {}): TapeReplay {
  const byHeight = new Map(tape.blocks.map((b) => [b.height, b]));
  const byHash = new Map(tape.blocks.map((b) => [noPrefix(b.blockHash), b]));
  const highest = Math.max(...tape.heights);
  const now = opts.now ?? (() => Date.now());
  const advance = opts.advance;
  if (advance !== undefined) {
    if (!Number.isFinite(advance.everyMs) || advance.everyMs <= 0) {
      throw new RangeError(`advance.everyMs must be a positive number, got ${advance.everyMs}`);
    }
    if (advance.by !== undefined && !isPositiveInteger(advance.by)) {
      throw new RangeError(`advance.by must be a positive integer, got ${advance.by}`);
    }
    if (advance.until !== undefined && !Number.isSafeInteger(advance.until)) {
      throw new RangeError(`advance.until must be a safe integer, got ${advance.until}`);
    }
  }
  const ceiling = advance?.until ?? highest;
  let base = opts.finalizedHeight ?? highest;
  let since = now();
  const counts = new Map<string, number>();
  const throttles = (opts.throttles ?? []).map((t) => ({ ...t }));

  const finalizedHeight = (): number => {
    if (advance === undefined || base >= ceiling) return base;
    const steps = Math.floor((now() - since) / advance.everyMs);
    return steps <= 0 ? base : Math.min(base + steps * (advance.by ?? 1), ceiling);
  };
  const setFinalizedHeight = (height: number): void => {
    base = height;
    since = now();
  };
  const advanceFinalizedHeight = (blocks = 1): number => {
    if (!Number.isSafeInteger(blocks) || blocks < 0) {
      throw new RangeError(`blocks must be a non-negative integer, got ${blocks}`);
    }
    const current = finalizedHeight();
    setFinalizedHeight(current >= ceiling ? current : Math.min(current + blocks, ceiling));
    return base;
  };

  const count = (op: string): void => { counts.set(op, (counts.get(op) ?? 0) + 1); };
  const respond = (status: number, body: unknown, headers: Record<string, string> = {}): TapeResponse => ({
    status,
    headers: { "content-type": typeof body === "string" ? "text/html" : "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const throttled = (op: string): TapeResponse | undefined => {
    const t = throttles.find((x) => x.operation === op && x.times > 0);
    if (t === undefined) return undefined;
    t.times--;
    if (t.htmlBody === true) return respond(200, "<html><body>502 Bad Gateway</body></html>");
    return respond(t.status, { error: "throttled" }, t.retryAfter === undefined ? {} : { "retry-after": t.retryAfter });
  };

  const rpc = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "chain_getFinalizedHead": {
        const height = finalizedHeight();
        const b = byHeight.get(height);
        if (b === undefined) throw new Error(`tape has no block at finalized height ${height}`);
        return b.blockHash;
      }
      case "chain_getBlockHash": {
        const b = byHeight.get(params[0] as number);
        if (b === undefined && params[0] === 0) return tape.genesisHash;
        return b === undefined ? null : b.blockHash;
      }
      case "chain_getHeader":
      case "chain_getBlock": {
        const b = byHash.get(noPrefix(params[0] as string));
        if (b === undefined) return null;
        return method === "chain_getHeader" ? b.nodeBlock.block.header : b.nodeBlock;
      }
      default:
        throw new Error(`tape replay: unsupported JSON-RPC method ${method}`);
    }
  };

  const route = (target: string, body: Record<string, unknown>): TapeResponse => {
    if (target === TAPE_RPC_PATH) {
      const { id, method, params } = body as { id: number; method: string; params: unknown[] };
      count(method);
      return throttled(method) ?? respond(200, { jsonrpc: "2.0", id, result: rpc(method, params) });
    }
    if (target === TAPE_GRAPHQL_PATH) {
      const variables = (body.variables ?? {}) as { height?: number; filter?: Record<string, unknown>; limit?: number; offset?: number };
      const height = variables.height;
      const isEvents = String(body.query).includes("contractEvents");
      const op = typeof height === "number" ? "indexer.block" : isEvents ? "indexer.contractEvents" : "indexer.tip";
      count(op);
      const refused = throttled(op);
      if (refused !== undefined) return refused;
      if (isEvents) {
        const f = variables.filter ?? {};
        const pair = opts.contractEvents?.find((p) =>
          p.contractAddress === noPrefix(String(f.contractAddress ?? "")) && p.txHash === noPrefix(String(f.transactionHash ?? "")));
        const offset = variables.offset ?? 0;
        const events = (pair?.events ?? []).slice(offset, offset + (variables.limit ?? 500));
        return respond(200, { data: { contractEvents: events } });
      }
      if (typeof height === "number") {
        const block = opts.indexerOverrides?.get(height) ?? byHeight.get(height)?.indexerBlock ?? null;
        return respond(200, { data: { block } });
      }
      return respond(200, { data: { block: { height: finalizedHeight() } } });
    }
    return respond(404, { error: "not found" });
  };

  const failure = (err: unknown): TapeResponse => respond(500, { error: err instanceof Error ? err.message : String(err) });

  return {
    async answer(target, body, signal) {
      signal?.throwIfAborted();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch (err) {
        return failure(err);
      }
      if (opts.delayMs !== undefined && opts.delayMs > 0) await sleep(opts.delayMs, signal);
      try {
        return route(target, parsed);
      } catch (err) {
        return failure(err);
      }
    },
    counts,
    finalizedHeight,
    setFinalizedHeight,
    advanceFinalizedHeight,
  };
}

export interface TapeFetchOptions extends TapeReplayOptions {
  /** The origin the function answers (scheme, host, port). Default {@link DEFAULT_TAPE_ORIGIN}. */
  origin?: string;
}

export interface TapeFetch extends TapeReplay {
  /** The node's JSON-RPC URL (`<origin>/rpc`). */
  readonly nodeUrl: string;
  /** The indexer's GraphQL URL (`<origin>/graphql`). */
  readonly indexerUrl: string;
  /**
   * A function with `fetch`'s signature that answers requests to the origin from the tape; a request to any other
   * origin rejects with a `TypeError`, as a failed fetch does. It honours the request's `signal`. A plain function, so
   * the clients may call it as a method.
   */
  readonly fetchImpl: typeof fetch;
}

/** A tape replay behind a function with `fetch`'s signature: hand `fetchImpl`, `nodeUrl` and `indexerUrl` to the node
 *  and indexer clients (or to anything that builds them) to sync from the tape with no network. */
export function createTapeFetch(tape: ArchiveTape, opts: TapeFetchOptions = {}): TapeFetch {
  const replay = createTapeReplay(tape, opts);
  const origin = new URL(opts.origin ?? DEFAULT_TAPE_ORIGIN).origin;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin) throw new TypeError(`tape replay answers ${origin} only, not ${url.origin}`);
    const body = await request.text();
    const answer = await replay.answer(url.pathname + url.search, body, request.signal);
    return new Response(request.method === "HEAD" ? null : answer.body, { status: answer.status, headers: answer.headers });
  };
  return {
    ...replay,
    nodeUrl: `${origin}${TAPE_RPC_PATH}`,
    indexerUrl: `${origin}${TAPE_GRAPHQL_PATH}`,
    fetchImpl,
  };
}
