/**
 * A Midnight indexer that answers the JSON-RPC module's GraphQL queries (`../indexer-gql.ts`) from a fixed set of
 * blocks and transactions, in the shape the indexer's GraphQL v4 answers them: the head and three earlier blocks, a
 * genesis block, transactions with each result status, a hash the indexer reports twice, a transaction whose own block
 * does not list it, a query that the indexer answers with a GraphQL error and a height it answers with HTTP 503.
 *
 * The same answers serve every runtime: {@link recordedIndexerAnswer} answers a request body (a test server's GraphQL
 * route, for the browser build), {@link recordedIndexerFetch} is a `fetch` for `IndexerGqlClient` (Node).
 */
import type { IndexerBlock, IndexerTransaction } from "../indexer-gql.js";

const fill = (pair: string, bytes: number): string => pair.repeat(bytes);
const hash32 = (pair: string): string => fill(pair, 32);

/** Block hashes (unprefixed, as the indexer writes them). */
export const BLOCK_HASH = {
  genesis: hash32("0a"),
  h40: hash32("a0"),
  h41: hash32("a1"),
  head: hash32("aa"),
} as const;

/** Transaction hashes (unprefixed). */
export const TX_HASH = {
  /** Block 42, index 0: `SUCCESS`, every segment successful. */
  success: hash32("cc"),
  /** Block 42, index 1: `PARTIAL_SUCCESS`. */
  partial: hash32("dd"),
  /** Block 41, index 0: `FAILURE`. */
  failure: hash32("c1"),
  /** Block 41, index 1: the indexer reports two transactions for this hash. */
  duplicate: hash32("d1"),
  /** Reported in block 41, which does not list it. */
  unlisted: hash32("ee"),
  /** The indexer answers a GraphQL error for it. */
  graphqlError: hash32("9e"),
} as const;

/** Heights. */
export const HEIGHT = { genesis: 0, h40: 40, h41: 41, head: 42, httpFailure: 999 } as const;

/** A 20-byte block author, and a 32-byte one (not an EVM address: the block's miner is the zero address). */
const AUTHOR_20 = fill("11", 20);
const AUTHOR_32 = fill("22", 32);

const block = (b: Omit<IndexerBlock, "transactions"> & { transactions: readonly string[] }, firstId: number): IndexerBlock => ({
  ...b,
  transactions: b.transactions.map((hash, i) => ({ id: firstId + i, hash })),
});

/** The recorded blocks by height. Timestamps as the live indexer reports them (milliseconds), genesis's as 0. */
export const RECORDED_BLOCKS: ReadonlyMap<number, IndexerBlock> = new Map([
  [HEIGHT.genesis, block({ hash: BLOCK_HASH.genesis, height: HEIGHT.genesis, timestamp: 0, author: null, parent: null, transactions: [] }, 1)],
  [HEIGHT.h40, block({ hash: BLOCK_HASH.h40, height: HEIGHT.h40, timestamp: 1_786_399_988_000, author: AUTHOR_32, parent: { hash: hash32("9f") }, transactions: [] }, 100)],
  [HEIGHT.h41, block({ hash: BLOCK_HASH.h41, height: HEIGHT.h41, timestamp: 1_786_399_994_000, author: AUTHOR_20, parent: { hash: BLOCK_HASH.h40 }, transactions: [TX_HASH.failure, TX_HASH.duplicate] }, 101)],
  [HEIGHT.head, block({ hash: BLOCK_HASH.head, height: HEIGHT.head, timestamp: 1_786_400_000_123, author: AUTHOR_20, parent: { hash: BLOCK_HASH.h41 }, transactions: [TX_HASH.success, TX_HASH.partial] }, 103)],
]);

const blockRef = (height: number): IndexerTransaction["block"] => {
  const b = RECORDED_BLOCKS.get(height)!;
  return { height: b.height, hash: b.hash, timestamp: b.timestamp };
};

const regular = (hash: string, height: number, fee: string, status: string, segments: { id: number; success: boolean }[] | null): IndexerTransaction => ({
  __typename: "RegularTransaction",
  hash,
  block: blockRef(height),
  raw: "0102",
  fee,
  identifiers: ["01"],
  transactionResult: { status, segments },
});

/** The recorded transactions-by-hash answers (the indexer's list for each hash). */
export const RECORDED_TRANSACTIONS: ReadonlyMap<string, readonly IndexerTransaction[]> = new Map([
  [TX_HASH.success, [regular(TX_HASH.success, HEIGHT.head, "21000", "SUCCESS", [{ id: 0, success: true }, { id: 1, success: true }])]],
  [TX_HASH.partial, [regular(TX_HASH.partial, HEIGHT.head, "35000", "PARTIAL_SUCCESS", [{ id: 0, success: true }, { id: 1, success: false }])]],
  [TX_HASH.failure, [regular(TX_HASH.failure, HEIGHT.h41, "0", "FAILURE", null)]],
  [TX_HASH.duplicate, [regular(TX_HASH.duplicate, HEIGHT.h41, "12", "SUCCESS", []), regular(TX_HASH.duplicate, HEIGHT.h41, "12", "SUCCESS", [])]],
  [TX_HASH.unlisted, [regular(TX_HASH.unlisted, HEIGHT.h41, "7", "SUCCESS", [])]],
]);

interface GraphQlRequest {
  query?: unknown;
  variables?: { height?: unknown; hash?: unknown };
}

const json = (status: number, value: unknown): { status: number; body: string } => ({ status, body: JSON.stringify(value) });

/**
 * The indexer's answer to one GraphQL request body: `{ status, body }`. A request this indexer does not know (not one
 * of the JSON-RPC module's four queries) is answered with a GraphQL error.
 */
export function recordedIndexerAnswer(requestBody: string): { status: number; body: string } {
  let request: GraphQlRequest;
  try {
    request = JSON.parse(requestBody) as GraphQlRequest;
  } catch {
    return json(400, { errors: [{ message: "invalid JSON" }] });
  }
  const query = typeof request.query === "string" ? request.query : "";
  const vars = request.variables ?? {};
  if (query.includes("transactions(offset: { hash: $hash })")) {
    if (vars.hash === TX_HASH.graphqlError) return json(200, { errors: [{ message: "query too complex" }] });
    return json(200, { data: { transactions: RECORDED_TRANSACTIONS.get(String(vars.hash)) ?? [] } });
  }
  if (query.includes("block(offset: { height: $height })")) {
    if (vars.height === HEIGHT.httpFailure) return { status: 503, body: "service unavailable" };
    return json(200, { data: { block: RECORDED_BLOCKS.get(Number(vars.height)) ?? null } });
  }
  if (query.includes("block(offset: { hash: $hash })")) {
    const found = [...RECORDED_BLOCKS.values()].find((b) => b.hash === vars.hash);
    return json(200, { data: { block: found ?? null } });
  }
  if (/^\{\s*block\s*\{/.test(query.trim())) return json(200, { data: { block: RECORDED_BLOCKS.get(HEIGHT.head) } });
  return json(200, { errors: [{ message: "unknown query" }] });
}

/** `fetch` answering every POST with {@link recordedIndexerAnswer}; `requests` counts the calls. */
export function recordedIndexerFetch(): { fetch: typeof fetch; requests: () => number } {
  let requests = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    const answer = recordedIndexerAnswer(typeof init?.body === "string" ? init.body : "");
    return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests: () => requests };
}
