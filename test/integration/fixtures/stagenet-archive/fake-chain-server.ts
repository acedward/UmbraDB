import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { IndexerBlock } from "../../../../chain-archive-sync/indexer-client.js";
import type { SubstrateBlock } from "../../../../chain-archive-sync/node-rpc-client.js";
import { type ContractEventsPair, loadTapeByName } from "./stagenet-fixtures.js";

/**
 * Serves a recorded Stagenet archive tape (`record-tape.ts`) back over real HTTP, on 127.0.0.1 and
 * an ephemeral port, as a Substrate JSON-RPC node (`POST /rpc`) and a Midnight indexer GraphQL
 * endpoint (`POST /graphql`) -- exactly the calls `ChainArchiveSyncService` makes, so the sync and
 * the CLI run unchanged against recorded data (project 00026, Q11: CI replays fixtures, no network).
 *
 * Also answers `chain_getBlockHash(0)` with the tape's genesis hash and, when given the recorded
 * `contractEvents` pairs, the indexer's `contractEvents` query (sub-plan D1).
 *
 * Test seams: per-height indexer overrides (synthetic transaction outcomes on real bytes), a
 * per-response delay (to kill a CLI mid-range), throttling injection (429/403/5xx with
 * `Retry-After`) and request counters.
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

/** A tape of this folder by file name: a plain A2 tape, a compact range tape, or one of the
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const noPrefix = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();

export async function startFakeChain(tape: ArchiveTape, opts: FakeChainOptions = {}): Promise<FakeChain> {
  const byHeight = new Map(tape.blocks.map((b) => [b.height, b]));
  const byHash = new Map(tape.blocks.map((b) => [noPrefix(b.blockHash), b]));
  let finalizedHeight = opts.finalizedHeight ?? Math.max(...tape.heights);
  const counts = new Map<string, number>();
  const throttles = (opts.throttles ?? []).map((t) => ({ ...t }));

  const count = (op: string): void => { counts.set(op, (counts.get(op) ?? 0) + 1); };
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": typeof body === "string" ? "text/html" : "application/json", ...headers });
    res.end(text);
  };
  const throttled = (op: string, res: ServerResponse): boolean => {
    const t = throttles.find((x) => x.operation === op && x.times > 0);
    if (t === undefined) return false;
    t.times--;
    if (t.htmlBody === true) send(res, 200, "<html><body>502 Bad Gateway</body></html>");
    else send(res, t.status, { error: "throttled" }, t.retryAfter === undefined ? {} : { "retry-after": t.retryAfter });
    return true;
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

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      if (opts.delayMs !== undefined && opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (req.url === "/rpc") {
        const { id, method, params } = body as { id: number; method: string; params: unknown[] };
        count(method);
        if (throttled(method, res)) return;
        send(res, 200, { jsonrpc: "2.0", id, result: rpc(method, params) });
        return;
      }
      if (req.url === "/graphql") {
        const variables = (body.variables ?? {}) as { height?: number; filter?: Record<string, unknown>; limit?: number; offset?: number };
        const height = variables.height;
        const isEvents = String(body.query).includes("contractEvents");
        const op = typeof height === "number" ? "indexer.block" : isEvents ? "indexer.contractEvents" : "indexer.tip";
        count(op);
        if (throttled(op, res)) return;
        if (isEvents) {
          const f = variables.filter ?? {};
          const pair = opts.contractEvents?.find((p) =>
            p.contractAddress === noPrefix(String(f.contractAddress ?? "")) && p.txHash === noPrefix(String(f.transactionHash ?? "")));
          const offset = variables.offset ?? 0;
          const events = (pair?.events ?? []).slice(offset, offset + (variables.limit ?? 500));
          send(res, 200, { data: { contractEvents: events } });
        } else if (typeof height === "number") {
          const block = opts.indexerOverrides?.get(height) ?? byHeight.get(height)?.indexerBlock ?? null;
          send(res, 200, { data: { block } });
        } else {
          send(res, 200, { data: { block: { height: finalizedHeight } } });
        }
        return;
      }
      send(res, 404, { error: "not found" });
    })().catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    nodeUrl: `http://127.0.0.1:${port}/rpc`,
    indexerUrl: `http://127.0.0.1:${port}/graphql`,
    counts,
    setFinalizedHeight: (h) => { finalizedHeight = h; },
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
