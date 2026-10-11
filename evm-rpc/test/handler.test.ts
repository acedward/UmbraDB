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
 * - `[[evm-rpc.handler.utf8-length]]` — the handler's UTF-8 length equals Node's `Buffer.byteLength`, and its reading
 *   of text equals Node's decoding of the text's UTF-8 bytes, for ASCII, two-, three- and four-byte characters, lone
 *   surrogates and a byte-order mark.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asReadFromUtf8, handleHttpRequest, type HttpAnswer, MAX_REQUEST_BYTES, requestTooLarge, textBody, utf8ByteLength } from "../handler.js";
import { emptyEvmRpcReader } from "../db.js";
import { IndexerGqlClient } from "../indexer-gql.js";
import { NOT_IMPLEMENTED_METHODS } from "../methods/not-implemented.js";
import { registerReadOnlyMethods } from "../read-only.js";
import { MethodRegistry, type RpcContext } from "../registry.js";
import { createRpcServer } from "../server.js";
import { differentialCases, FAILING_CALLS, VALID_CALLS } from "./differential-cases.js";
import { sendToServer, type WireAnswer } from "./node-answers.js";
import { recordedIndexerFetch } from "./recorded-indexer.js";

function readOnlyContext(): RpcContext {
  return {
    chainId: 2400n,
    clientVersion: "umbradb-evm-rpc/0.9.5",
    indexer: new IndexerGqlClient({ url: "http://indexer.test/graphql", fetchImpl: recordedIndexerFetch().fetch }),
    db: emptyEvmRpcReader,
  };
}

const viaHttp = (port: number, method: string, body: string): Promise<WireAnswer> => sendToServer(port, method, body);

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

  it("[[evm-rpc.handler.utf8-length]] the UTF-8 length is Buffer.byteLength's, and text reads as Node decodes its UTF-8 bytes, lone surrogates and a byte-order mark included", () => {
    const samples = ["", "plain ascii", "\u00fc\u00df", "\u20ac\u4e2d", "\u{1f600}\u{10ffff}", "\ud800", "x\udc00y", "\u{10ffff}", "\ud83d", "\ud83d\u{1f600}"];
    for (let i = 0; i < 200; i++) {
      let s = "";
      for (let j = 0; j < 12; j++) s += String.fromCharCode(Math.floor(Math.random() * 0x10000));
      samples.push(s);
    }
    samples.push(`${String.fromCharCode(0xfeff)}{}`, `a${String.fromCharCode(0xdbff)}`, String.fromCharCode(0xdc00, 0xd800, 0xdc00));
    for (const s of samples) {
      expect(utf8ByteLength(s), JSON.stringify(s)).toBe(Buffer.byteLength(s, "utf8"));
      expect(asReadFromUtf8(s), JSON.stringify(s)).toBe(Buffer.from(s, "utf8").toString("utf8"));
    }
    const plain = "no surrogates here";
    expect(asReadFromUtf8(plain)).toBe(plain);
  });
});
