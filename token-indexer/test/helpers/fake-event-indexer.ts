import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

/**
 * A real HTTP GraphQL endpoint that answers `contractEvents` — so the event source under test is
 * the real `IndexerEventSource` doing a real `fetch`, including its paging, its error handling and
 * its request body, rather than a stubbed method.
 *
 * Listens on an EPHEMERAL port the OS picks (`listen(0)`), which is both free by construction and
 * well above this workspace's ≥ 10000 rule in practice; the URL is read back from the socket.
 */

export interface FakeEvent {
  id: number;
  typename?: string;
  contractAddress: string;
  txHash: string;
  blockHeight: number;
  nameHex?: string;
  payloadHex?: string;
  /** The serialized ledger `Event` served as `raw` (project 00024-01) — see `fakeRawEvent`. */
  rawHex?: string;
}

export interface FakeEventIndexer {
  url: string;
  /** Events keyed `${txHash}:${address}` — mutate between calls to model the indexer catching up. */
  events: Map<string, FakeEvent[]>;
  /** Every request the source made, in order — so a test can assert the retry actually happened. */
  requests: { txHash: string; address: string; limit: number; offset: number }[];
  /** Force the next `n` responses to be an HTTP error, to exercise the retry queue. */
  failNext: number;
  close(): Promise<void>;
}

export async function startFakeEventIndexer(): Promise<FakeEventIndexer> {
  const state: Omit<FakeEventIndexer, "url" | "close"> = {
    events: new Map(),
    requests: [],
    failNext: 0,
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      if (state.failNext > 0) {
        state.failNext--;
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("upstream unavailable");
        return;
      }
      const parsed = JSON.parse(body) as {
        variables: { filter: { contractAddress: string; transactionHash: string }; limit: number; offset: number };
      };
      const { filter, limit, offset } = parsed.variables;
      state.requests.push({
        txHash: filter.transactionHash, address: filter.contractAddress, limit, offset,
      });
      const all = state.events.get(`${filter.transactionHash}:${filter.contractAddress}`) ?? [];
      const page = all.slice(offset, offset + limit).map((event) => ({
        __typename: event.typename ?? "MiscContractEvent",
        id: event.id,
        contractAddress: event.contractAddress,
        transaction: { hash: event.txHash, block: { height: event.blockHeight } },
        ...(event.nameHex === undefined ? {} : { name: event.nameHex }),
        ...(event.payloadHex === undefined ? {} : { payload: event.payloadHex }),
        ...(event.rawHex === undefined ? {} : { raw: event.rawHex }),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { contractEvents: page } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  // `Object.assign` onto the SAME object the request handler closed over — a spread would copy
  // `failNext` by value and a test's `indexer.failNext = 2` would then never reach the server.
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/api/v4/graphql`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
    }),
  });
}
