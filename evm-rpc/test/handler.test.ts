/**
 * Node's JSON-RPC HTTP server (`../server.ts`) and the runtime-neutral handler it wraps (`../handler.ts`) answer every
 * request identically, so the browser engine's JSON RPC module, which answers through the same handler, gives Node's
 * answers.
 *
 * - `[[evm-rpc.handler.differential]]` — for every case of `differential-cases.ts` (every method the read-only entry
 *   point registers, called with valid parameters against the recorded indexer and with refused ones; every
 *   not-implemented method; unknown names; the envelope's rules; notifications; batches; bodies that are not JSON; the
 *   1 MiB request cap, also reached by multi-byte characters; methods other than `POST`), the server's HTTP answer
 *   (status, every header it sets in its order, the body's bytes) equals the handler's answer for the same method and
 *   body, read as bytes the way the server reads them and as text the way the browser engine passes it; the cases call
 *   every registered method.
 * - `[[evm-rpc.handler.utf8-length]]` — the handler's UTF-8 length equals Node's `Buffer.byteLength` for ASCII,
 *   two-, three- and four-byte characters and lone surrogates.
 */
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleHttpRequest, type HttpAnswer, MAX_REQUEST_BYTES, requestTooLarge, textBody, utf8ByteLength } from "../handler.js";
import { emptyEvmRpcReader } from "../db.js";
import { IndexerGqlClient } from "../indexer-gql.js";
import { NOT_IMPLEMENTED_METHODS } from "../methods/not-implemented.js";
import { registerReadOnlyMethods } from "../read-only.js";
import { MethodRegistry, type RpcContext } from "../registry.js";
import { createRpcServer } from "../server.js";
import { differentialCases, FAILING_CALLS, VALID_CALLS } from "./differential-cases.js";
import { recordedIndexerFetch } from "./recorded-indexer.js";

/** Headers Node's HTTP server adds by itself, outside the handler's answer. */
const NODE_OWN_HEADERS = /^(date|connection|keep-alive)$/i;

function readOnlyContext(): RpcContext {
  return {
    chainId: 2400n,
    clientVersion: "umbradb-evm-rpc/0.9.5",
    indexer: new IndexerGqlClient({ url: "http://indexer.test/graphql", fetchImpl: recordedIndexerFetch().fetch }),
    db: emptyEvmRpcReader,
  };
}

interface WireAnswer {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

function viaHttp(port: number, method: string, body: string): Promise<WireAnswer> {
  const bytes = Buffer.from(body, "utf8");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: "/", headers: { "content-type": "application/json", "content-length": bytes.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const headers: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          if (!NODE_OWN_HEADERS.test(res.rawHeaders[i]!)) headers.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
        }
        resolve({ status: res.statusCode!, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

/** The answer as it goes over the wire: a body of no bytes for an empty body. */
const wire = (a: HttpAnswer): WireAnswer => ({ status: a.status, headers: Object.entries(a.headers), body: Buffer.from(a.body, "utf8") });

describe("the JSON-RPC handler answers as Node's HTTP server", () => {
  const registry = new MethodRegistry();
  registerReadOnlyMethods(registry);
  let server: ReturnType<typeof createRpcServer>;
  let port: number;

  beforeAll(async () => {
    server = createRpcServer({ registry, ctx: readOnlyContext() });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("[[evm-rpc.handler.differential]] every case: the server's status, headers and body bytes equal the handler's, from bytes and from text", async () => {
    const called = new Set([...VALID_CALLS, ...FAILING_CALLS].map(([method]) => method));
    for (const { method } of NOT_IMPLEMENTED_METHODS) called.add(method);
    expect(registry.listMethods().filter((m) => !called.has(m))).toEqual([]);

    const cases = differentialCases();
    expect(cases.length).toBeGreaterThan(120);
    const statuses = new Set<number>();
    for (const c of cases) {
      const http = await viaHttp(port, c.method, c.body);
      statuses.add(http.status);
      const fromBytes = await handleHttpRequest(c.method, async () => {
        const bytes = Buffer.from(c.body, "utf8");
        if (bytes.length > MAX_REQUEST_BYTES) throw requestTooLarge();
        return bytes.toString("utf8");
      }, registry, readOnlyContext());
      const fromText = await handleHttpRequest(c.method, textBody(c.body), registry, readOnlyContext());
      expect(wire(fromBytes), c.name).toEqual(http);
      expect(wire(fromText), c.name).toEqual(http);
    }
    // The cases reach every kind of answer: success, notifications only, the request cap and a method other than POST.
    expect([...statuses].sort()).toEqual([200, 204, 405, 413]);
  }, 120_000);

  it("[[evm-rpc.handler.utf8-length]] the UTF-8 length is Buffer.byteLength's, lone surrogates included", () => {
    const samples = ["", "plain ascii", "üß", "€中", "\u{1f600}\u{10ffff}", "\ud800", "x\udc00y", "􏿿", "\ud83d", "\ud83d😀"];
    for (let i = 0; i < 200; i++) {
      let s = "";
      for (let j = 0; j < 12; j++) s += String.fromCharCode(Math.floor(Math.random() * 0x10000));
      samples.push(s);
    }
    for (const s of samples) expect(utf8ByteLength(s), JSON.stringify(s)).toBe(Buffer.byteLength(s, "utf8"));
  });
});
