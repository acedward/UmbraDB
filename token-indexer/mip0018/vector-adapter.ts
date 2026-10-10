#!/usr/bin/env node
/**
 * UmbraDB's pure MIP-0018 vector adapter: the runner contract of the vendored vectors
 * (`token-indexer/vendor/mip0018/vectors/README.md`, "Runner contract") over stdin/stdout, answered by the pure
 * consumer of `./vector-consumer.ts` (the vendored codec and UmbraDB's own state module, `./state.ts`). No database —
 * the Postgres adapter answers the same requests through the real store.
 *
 *   node token-indexer/vendor/mip0018/vectors/tools/run.ts --consumer "node token-indexer/mip0018/vector-adapter.ts"
 *
 * One JSON request per stdin line, exactly one JSON response per stdout line, in order.
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { handleRequest } from "./vector-consumer.ts";

export {
  decodeInput,
  decodeResponse,
  type DisplayRequest,
  handleRequest,
  type Json,
  stateInput,
  stateResponse,
  type StateStep,
} from "./vector-consumer.ts";

/** Reads one JSON request per line from stdin and writes one JSON response per line to stdout. */
export function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ id: null, error: `invalid JSON: ${(e as Error).message}` })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(handleRequest(req))}\n`);
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
