import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ArchiveTape } from "../../../../chain-archive-sync/archive-tape.js";
import {
  createTapeFetch, createTapeReplay, TAPE_GRAPHQL_PATH, TAPE_RPC_PATH, type TapeReplay, type TapeReplayOptions,
  type TapeResponse, type TapeThrottle,
} from "../../../../chain-archive-sync/tape-replay.js";
import { loadTapeByName } from "./stagenet-fixtures.js";

/**
 * Serves a recorded Stagenet archive tape (`record-tape.ts`) back over real HTTP, on 127.0.0.1 and
 * an ephemeral port, as a Substrate JSON-RPC node (`POST /rpc`) and a Midnight indexer GraphQL
 * endpoint (`POST /graphql`) -- exactly the calls `ChainArchiveSyncService` makes, so the sync and
 * the CLI run unchanged against recorded data (CI replays fixtures, no network).
 *
 * The answers come from the runtime-neutral tape replay (`chain-archive-sync/tape-replay.ts`), the
 * same core that `createTapeFetch` puts behind a `fetch`-shaped function: this file only carries
 * requests and answers over `node:http`. The options are the replay's: the reported finalized
 * height (fixed, set by hand, or rising with a clock), the recorded `contractEvents` answers, and the
 * test seams (per-height indexer overrides, a per-response delay, throttling injection, request
 * counters).
 */

export type { ArchiveTape, TapeBlock } from "../../../../chain-archive-sync/archive-tape.js";

/** A tape of this folder by file name: a plain tape, a compact range tape, or one of the
 *  manifest's aliases (a slice of the recorded ranges; see `stagenet-fixtures.ts`). */
export function loadTape(fileName: string): ArchiveTape {
  return loadTapeByName(fileName);
}

export type Throttle = TapeThrottle;

export type FakeChainOptions = TapeReplayOptions;

export interface FakeChain {
  nodeUrl: string;
  indexerUrl: string;
  /** Requests served per operation (`chain_getBlock`, `indexer.block`, ...), throttled ones included. */
  counts: Map<string, number>;
  /** The finalized height reported right now. */
  finalizedHeight(): number;
  setFinalizedHeight(height: number): void;
  /** Raises the reported finalized height (see `TapeReplay.advanceFinalizedHeight`). */
  advanceFinalizedHeight(blocks?: number): number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeChain(tape: ArchiveTape, opts: FakeChainOptions = {}): Promise<FakeChain> {
  const replay = createTapeReplay(tape, opts);
  const server: Server = createServer((req, res) => {
    void (async () => {
      const answer = await replay.answer(req.url ?? "", await readBody(req));
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    })().catch((err: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    nodeUrl: `http://127.0.0.1:${port}${TAPE_RPC_PATH}`,
    indexerUrl: `http://127.0.0.1:${port}${TAPE_GRAPHQL_PATH}`,
    counts: replay.counts,
    finalizedHeight: replay.finalizedHeight,
    setFinalizedHeight: replay.setFinalizedHeight,
    advanceFinalizedHeight: replay.advanceFinalizedHeight,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** One answer of the fake chain, as an HTTP response writes it. */
export type FakeChainAnswer = TapeResponse;

/** The fake chain's answers with no transport: the tape replay's core. */
export type FakeChainAnswers = TapeReplay;

/** The fake chain's answers to the node's JSON-RPC and the indexer's GraphQL requests, with no transport. */
export function createFakeChainAnswers(tape: ArchiveTape, opts: FakeChainOptions = {}): FakeChainAnswers {
  return createTapeReplay(tape, opts);
}

export interface FakeChainFetch {
  /** Answers `POST <nodeUrl>` and `POST <indexerUrl>` like the HTTP fake; any other origin is a transport failure. */
  fetch: typeof fetch;
  nodeUrl: string;
  indexerUrl: string;
  counts: Map<string, number>;
  finalizedHeight(): number;
  setFinalizedHeight(height: number): void;
  advanceFinalizedHeight(blocks?: number): number;
}

/** The fake chain as a `fetch` function (no socket): the same answers as {@link startFakeChain}'s server, from the
 *  tape replay's `createTapeFetch` on the origin `http://fake-chain.invalid`. */
export function fakeChainFetch(tape: ArchiveTape, opts: FakeChainOptions = {}): FakeChainFetch {
  const t = createTapeFetch(tape, { ...opts, origin: "http://fake-chain.invalid" });
  return {
    fetch: t.fetchImpl,
    nodeUrl: t.nodeUrl,
    indexerUrl: t.indexerUrl,
    counts: t.counts,
    finalizedHeight: t.finalizedHeight,
    setFinalizedHeight: t.setFinalizedHeight,
    advanceFinalizedHeight: t.advanceFinalizedHeight,
  };
}
