/**
 * Node's JSON-RPC HTTP server answers every differential case as recorded: the SHA-256 of each answer (status code,
 * the headers the server sets in order, the body's bytes) is in `fixtures/node-answers.json`. The handler test
 * (`handler.test.ts`) shows the handler answers as the server does; this one fixes what the server answers, so a change
 * of Node's answers shows here, by case.
 *
 * - `[[evm-rpc.server.recorded-answers]]` — the server, registered as `rpc-cli.ts` registers it (the read-only methods,
 *   no database) over the recorded indexer, answers each case of `differential-cases.ts` with exactly the recorded
 *   bytes; the recording has one answer per case, in the cases' order.
 *
 * `EVM_RPC_RECORD_ANSWERS=1` writes the file from the server's answers instead of comparing (a deliberate change of
 * Node's answers).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { emptyEvmRpcReader } from "../db.js";
import { IndexerGqlClient } from "../indexer-gql.js";
import { registerReadOnlyMethods } from "../read-only.js";
import { MethodRegistry } from "../registry.js";
import { createRpcServer } from "../server.js";
import { differentialCases } from "./differential-cases.js";
import { recordedIndexerFetch } from "./recorded-indexer.js";

const FIXTURE = new URL("./fixtures/node-answers.json", import.meta.url);

interface Recording {
  about: string;
  answers: Array<{ case: string; sha256: string }>;
}

/** The SHA-256 of the server's answer to `body` sent with `method`. */
function answerDigest(port: number, method: string, body: string): Promise<string> {
  const bytes = Buffer.from(body, "utf8");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: "/", headers: { "content-type": "application/json", "content-length": bytes.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const head: string[] = [String(res.statusCode)];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          if (!/^(date|connection|keep-alive)$/i.test(res.rawHeaders[i]!)) head.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
        }
        resolve(createHash("sha256").update(`${head.join("\n")}\n\n`).update(Buffer.concat(chunks)).digest("hex"));
      });
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

describe("Node's JSON-RPC server answers as recorded", () => {
  it("[[evm-rpc.server.recorded-answers]] every differential case is answered with exactly the recorded bytes", async () => {
    const registry = new MethodRegistry();
    registerReadOnlyMethods(registry);
    const server = createRpcServer({
      registry,
      ctx: {
        chainId: 2400n,
        clientVersion: "umbradb-evm-rpc/0.9.5",
        indexer: new IndexerGqlClient({ url: "http://indexer.test/graphql", fetchImpl: recordedIndexerFetch().fetch }),
        db: emptyEvmRpcReader,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const answers: Recording["answers"] = [];
      for (const c of differentialCases()) answers.push({ case: c.name, sha256: await answerDigest(port, c.method, c.body) });
      const recording = JSON.parse(readFileSync(FIXTURE, "utf8")) as Recording;
      if (process.env.EVM_RPC_RECORD_ANSWERS === "1") {
        writeFileSync(FIXTURE, `${JSON.stringify({ about: recording.about, answers }, null, 2)}\n`);
        return;
      }
      expect(answers.map((a) => a.case)).toEqual(recording.answers.map((a) => a.case));
      for (const [i, a] of answers.entries()) expect(a.sha256, a.case).toBe(recording.answers[i]!.sha256);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
