/**
 * Node's JSON-RPC HTTP server and the handler the browser engine uses answer as recorded in
 * `fixtures/node-answers.json`: the server's wire answers (status line, headers in order, body) to every case of
 * `wire-cases.ts` — the differential cases and the transport's border cases. A change to what Node's server writes, or
 * to the handler's rules, shows here, by case; the file is written by `fixtures/record-node-answers.ts` and is only
 * recorded again on purpose (see that script).
 *
 * - `[[evm-rpc.server.recorded-answers]]` — the server, registered as `rpc-cli.ts` registers it (no database) plus the
 *   border cases' test methods, over the recorded indexer, answers each case sent as raw bytes over TCP exactly as
 *   recorded: one answer per case, in the cases' order.
 * - `[[evm-rpc.handler.recorded-answers]]` — the handler, given each case whose request is a `POST` with a text body as
 *   the browser engine gives it (`textBody`), answers with the recorded status, the recorded headers (Node's own
 *   `Connection` aside) and the recorded body.
 */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { emptyEvmRpcReader } from "../db.js";
import { handleHttpRequest, textBody } from "../handler.js";
import { IndexerGqlClient } from "../indexer-gql.js";
import type { RpcContext } from "../registry.js";
import { createRpcServer } from "../server.js";
import { recordingRegistry } from "./fixtures/record-node-answers.js";
import { handlerAnswer, loadRecording, parseAnswer, sendRaw } from "./node-answers.js";
import { recordedIndexerFetch } from "./recorded-indexer.js";
import { wireCases } from "./wire-cases.js";

function context(): RpcContext {
  return {
    chainId: 2400n,
    clientVersion: "umbradb-evm-rpc/0.9.5",
    indexer: new IndexerGqlClient({ url: "http://indexer.test/graphql", fetchImpl: recordedIndexerFetch().fetch }),
    db: emptyEvmRpcReader,
  };
}

describe("Node's JSON-RPC server and the browser's handler answer as recorded", () => {
  const recording = loadRecording();
  const cases = wireCases();

  it("[[evm-rpc.server.recorded-answers]] every case sent as raw bytes is answered on the wire exactly as recorded", async () => {
    expect(cases.map((c) => c.name)).toEqual(recording.answers.map((a) => a.case));
    expect(cases.length).toBeGreaterThan(180);
    const server = createRpcServer({ registry: recordingRegistry(), ctx: context() });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      for (const [i, c] of cases.entries()) expect(parseAnswer(c.name, await sendRaw(port, c.raw)), c.name).toEqual(recording.answers[i]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);

  it("[[evm-rpc.handler.recorded-answers]] every POST with a text body, given to the handler as the browser engine gives it, is answered as recorded", async () => {
    const registry = recordingRegistry();
    let compared = 0;
    for (const [i, c] of cases.entries()) {
      if (c.text === null) continue;
      const recorded = recording.answers[i]!;
      const answer = await handleHttpRequest("POST", textBody(c.text), registry, context());
      expect(handlerAnswer(c.name, answer, recorded), c.name).toEqual({ ...recorded, interim: undefined });
      compared++;
    }
    expect(compared).toBeGreaterThan(160);
  }, 120_000);
});
