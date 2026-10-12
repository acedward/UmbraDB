/**
 * Records Node's JSON-RPC server's answers to every case of `../wire-cases.ts` into `node-answers.json`: the server of
 * `../../server.ts` with the methods `npm run evm-rpc` registers (no database) and the border cases' test-only methods,
 * over the recorded indexer (`../recorded-indexer.ts`), each case sent over TCP as raw bytes.
 *
 * Run it only to change the recorded answers on purpose (a deliberate change of what Node's server answers):
 *
 *     npx tsx evm-rpc/test/fixtures/record-node-answers.ts
 *
 * The tests (`../node-answers.test.ts`) then hold Node's server and the browser engine's handler to the new file.
 */
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { emptyEvmRpcReader } from "../../db.js";
import { IndexerGqlClient } from "../../indexer-gql.js";
import { registerAccountMethods } from "../../methods/accounts.js";
import { registerBlockMethods } from "../../methods/blocks.js";
import { registerNotImplementedMethods } from "../../methods/not-implemented.js";
import { registerStaticMethods } from "../../methods/static.js";
import { registerTransactionMethods } from "../../methods/transactions.js";
import { MethodRegistry } from "../../registry.js";
import { createRpcServer } from "../../server.js";
import { parseAnswer, type RecordedAnswer, sendRaw, writeRecording } from "../node-answers.js";
import { recordedIndexerFetch } from "../recorded-indexer.js";
import { registerWireTestMethods, wireCases } from "../wire-cases.js";

/** The registry the recorded answers come from: `rpc-cli.ts`'s registrations, in its order, and the test methods. */
export function recordingRegistry(): MethodRegistry {
  const registry = new MethodRegistry();
  registerStaticMethods(registry);
  registerBlockMethods(registry);
  registerAccountMethods(registry);
  registerTransactionMethods(registry);
  registerNotImplementedMethods(registry);
  registerWireTestMethods(registry);
  return registry;
}

const ABOUT =
  "Node's evm-rpc HTTP server's answers to the cases of wire-cases.ts (status line, headers in order without Date, body as text up to 1,024 bytes, else its length, SHA-256 and start), with the methods npm run evm-rpc registers (no database) and the test methods of wire-cases.ts, over the recorded indexer. A different answer is a change of Node's behaviour: record the file again on purpose with npx tsx evm-rpc/test/fixtures/record-node-answers.ts.";

async function main(): Promise<void> {
  const server = createRpcServer({
    registry: recordingRegistry(),
    ctx: {
      chainId: 2400n,
      clientVersion: "umbradb-evm-rpc/0.9.5",
      indexer: new IndexerGqlClient({ url: "http://indexer.test/graphql", fetchImpl: recordedIndexerFetch().fetch }),
      db: emptyEvmRpcReader,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const answers: RecordedAnswer[] = [];
  for (const c of wireCases()) answers.push(parseAnswer(c.name, await sendRaw(port, c.raw)));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  writeRecording({ about: ABOUT, answers });
  console.log(`recorded ${answers.length} answers`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
