import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { IndexerBlock } from "../../../../chain-archive-sync/indexer-client.js";
import type { SubstrateBlock } from "../../../../chain-archive-sync/node-rpc-client.js";
import { type ContractEventsPair, loadTapeByName } from "./stagenet-fixtures.js";

/**
 * Serves a recorded Stagenet archive tape (`record-tape.ts`) back over real HTTP, on 127.0.0.1 and
 * an ephemeral port, as a Substrate JSON-RPC node (`POST /rpc`) and a Midnight indexer GraphQL
 * endpoint (`POST /graphql`) -- exactly the calls `ChainArchiveSyncService` makes, so the sync and
 * the CLI run unchanged against recorded data (CI replays fixtures, no network).
 *
 * Also answers `chain_getBlockHash(0)` with the tape's genesis hash and, when given the recorded
 * `contractEvents` pairs, the indexer's `contractEvents` query.
 *
 * Test seams: per-height indexer overrides (synthetic transaction outcomes on real bytes), a
 * per-response delay (to kill a CLI mid-range), throttling injection (429/403/5xx with
 * `Retry-After`) and request counters.
 *
 * The answering logic (`createFakeChainAnswers`) is separate from its transports: `startFakeChain`
 * serves it over HTTP, `fakeChainFetch` answers the same requests as a `fetch` function, with no
 * socket at all.
 */

export interface TapeBlock {
  height: number;
  blockHash: string;
  nodeBlock: SubstrateBlock;
  indexerBlock: IndexerBlock;
}

export interface ArchiveTape {
  network: string;
  genesisHash: string;
  heights: number[];
  blocks: TapeBlock[];
}

/** A tape of this folder by file name: a plain tape, a compact range tape, or one of the
 *  manifest's aliases (a slice of the recorded ranges; see `stagenet-fixtures.ts`). */
export function loadTape(fileName: string): ArchiveTape {
  return loadTapeByName(fileName);
}

export interface Throttle {
  /** JSON-RPC method name, or `indexer.block` / `indexer.tip`. */
  operation: string;
  /** How many matching requests to answer with `status` before serving normally. */
  times: number;
  status: number;
  retryAfter?: string;
  /** Answer HTTP 200 with an HTML body instead (a proxy error page). */
  htmlBody?: boolean;
}

export interface FakeChainOptions {
  /** Height reported as finalized head / indexer tip. Default: the tape's highest height. */
  finalizedHeight?: number;
  /** Replaces the indexer's block for a height (e.g. a synthetic transaction outcome). */
  indexerOverrides?: Map<number, IndexerBlock>;
  /** Milliseconds every response waits before being sent. */
  delayMs?: number;
  throttles?: Throttle[];
  /** Recorded `contractEvents` answers (`loadContractEvents().pairs`); the indexer endpoint then
   *  answers `contractEvents(filter: { contractAddress, transactionHash }, limit, offset)` from them,
   *  in the recorded order. Without it every such query answers an empty list. */
  contractEvents?: readonly ContractEventsPair[];
}

export interface FakeChain {
  nodeUrl: string;
  indexerUrl: string;
  /** Requests served per operation (`chain_getBlock`, `indexer.block`, ...), throttled ones included. */
  counts: Map<string, number>;
  setFinalizedHeight(height: number): void;
  close(): Promise<void>;
}

/** One answer of the fake chain, as an HTTP response writes it. */
export interface FakeChainAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FakeChainAnswers {
  /** Answers one POST: `path` is `/rpc` (node) or `/graphql` (indexer), `body` the request's JSON text. */
  answer(path: string, body: string): Promise<FakeChainAnswer>;
  counts: Map<string, number>;
  setFinalizedHeight(height: number): void;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const noPrefix = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();

/** The fake chain's answers to the node's JSON-RPC and the indexer's GraphQL requests, with no transport. */
export function createFakeChainAnswers(tape: ArchiveTape, opts: FakeChainOptions = {}): FakeChainAnswers {
  const byHeight = new Map(tape.blocks.map((b) => [b.height, b]));
  const byHash = new Map(tape.blocks.map((b) => [noPrefix(b.blockHash), b]));
  let finalizedHeight = opts.finalizedHeight ?? Math.max(...tape.heights);
  const counts = new Map<string, number>();
  const throttles = (opts.throttles ?? []).map((t) => ({ ...t }));

  const count = (op: string): void => { counts.set(op, (counts.get(op) ?? 0) + 1); };
  const send = (status: number, body: unknown, headers: Record<string, string> = {}): FakeChainAnswer => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { status, headers: { "content-type": typeof body === "string" ? "text/html" : "application/json", ...headers }, body: text };
  };
  const throttled = (op: string): FakeChainAnswer | undefined => {
    const t = throttles.find((x) => x.operation === op && x.times > 0);
    if (t === undefined) return undefined;
    t.times--;
    if (t.htmlBody === true) return send(200, "<html><body>502 Bad Gateway</body></html>");
    return send(t.status, { error: "throttled" }, t.retryAfter === undefined ? {} : { "retry-after": t.retryAfter });
  };

  const rpc = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "chain_getFinalizedHead": {
        const b = byHeight.get(finalizedHeight);
        if (b === undefined) throw new Error(`tape has no block at finalized height ${finalizedHeight}`);
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
        throw new Error(`fake node: unsupported method ${method}`);
    }
  };

  const answer = async (path: string, text: string): Promise<FakeChainAnswer> => {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (opts.delayMs !== undefined && opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (path === "/rpc") {
      const { id, method, params } = body as { id: number; method: string; params: unknown[] };
      count(method);
      return throttled(method) ?? send(200, { jsonrpc: "2.0", id, result: rpc(method, params) });
    }
    if (path === "/graphql") {
      const variables = (body.variables ?? {}) as { height?: number; filter?: Record<string, unknown>; limit?: number; offset?: number };
      const height = variables.height;
      const isEvents = String(body.query).includes("contractEvents");
      const op = typeof height === "number" ? "indexer.block" : isEvents ? "indexer.contractEvents" : "indexer.tip";
      count(op);
      const t = throttled(op);
      if (t !== undefined) return t;
      if (isEvents) {
        const f = variables.filter ?? {};
        const pair = opts.contractEvents?.find((p) =>
          p.contractAddress === noPrefix(String(f.contractAddress ?? "")) && p.txHash === noPrefix(String(f.transactionHash ?? "")));
        const offset = variables.offset ?? 0;
        const events = (pair?.events ?? []).slice(offset, offset + (variables.limit ?? 500));
        return send(200, { data: { contractEvents: events } });
      }
      if (typeof height === "number") {
        const block = opts.indexerOverrides?.get(height) ?? byHeight.get(height)?.indexerBlock ?? null;
        return send(200, { data: { block } });
      }
      return send(200, { data: { block: { height: finalizedHeight } } });
    }
    return send(404, { error: "not found" });
  };

  return {
    answer: (path, text) => answer(path, text).catch((err: unknown) => send(500, { error: err instanceof Error ? err.message : String(err) })),
    counts,
    setFinalizedHeight: (h) => { finalizedHeight = h; },
  };
}

export async function startFakeChain(tape: ArchiveTape, opts: FakeChainOptions = {}): Promise<FakeChain> {
  const chain = createFakeChainAnswers(tape, opts);
  const server: Server = createServer((req, res) => {
    void readBody(req).then(
      (text) => chain.answer(req.url ?? "", text),
      (err: unknown): FakeChainAnswer => ({ status: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }),
    ).then((a) => {
      res.writeHead(a.status, a.headers);
      res.end(a.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    nodeUrl: `http://127.0.0.1:${port}/rpc`,
    indexerUrl: `http://127.0.0.1:${port}/graphql`,
    counts: chain.counts,
    setFinalizedHeight: chain.setFinalizedHeight,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

export interface FakeChainFetch {
  /** Answers `POST <nodeUrl>` and `POST <indexerUrl>` like the HTTP fake; any other URL is a transport failure. */
  fetch: typeof fetch;
  nodeUrl: string;
  indexerUrl: string;
  counts: Map<string, number>;
  setFinalizedHeight(height: number): void;
}

/** The fake chain as a `fetch` function (no socket): the same answers as {@link startFakeChain}'s server. */
export function fakeChainFetch(tape: ArchiveTape, opts: FakeChainOptions = {}): FakeChainFetch {
  const chain = createFakeChainAnswers(tape, opts);
  const origin = "http://fake-chain.invalid";
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    init?.signal?.throwIfAborted();
    if (url.origin !== origin) throw new TypeError(`fetch failed: no route to ${url.origin}`);
    const a = await chain.answer(url.pathname, typeof init?.body === "string" ? init.body : "");
    return new Response(a.body, { status: a.status, headers: a.headers });
  };
  return {
    fetch: fetchImpl as typeof fetch,
    nodeUrl: `${origin}/rpc`,
    indexerUrl: `${origin}/graphql`,
    counts: chain.counts,
    setFinalizedHeight: chain.setFinalizedHeight,
  };
}
