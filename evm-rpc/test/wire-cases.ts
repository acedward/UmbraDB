/**
 * The HTTP requests whose answers from Node's JSON-RPC server are recorded in `fixtures/node-answers.json`: every
 * differential case (`differential-cases.ts`) and the transport's border cases — other HTTP methods, `Expect:
 * 100-continue`, a body with no length, chunked bodies at and over the size cap, bytes that are not UTF-8, a
 * byte-order mark, NUL, prototype-named members and methods, very deep `params` and `id`, unusual ids, a very long id,
 * batches over the response cap, results and error data that are not JSON values (served by test-only methods), a
 * mixed batch of 100. Each case is the raw request (bytes on the wire) and, for a `POST` whose body is text, that
 * text (the form the browser engine's handler takes).
 */
import { MethodRegistry, RpcError } from "../registry.js";
import { differentialCases } from "./differential-cases.js";

export interface WireCase {
  name: string;
  /** The request as sent: request line, headers, body. */
  raw: Uint8Array;
  /** The body of a `POST` as text, when the browser engine's handler can be given the same request. */
  text: string | null;
}

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A request with `Content-Length` (unless `noLength`) and `Connection: close`. A text body is sent as UTF-8; Node
 *  decodes it so, a lone surrogate becoming U+FFFD's bytes, as `TextEncoder` writes it. */
function request(method: string, body: Uint8Array | string, extra: string[] = [], opts: { noLength?: boolean; contentType?: string } = {}): Uint8Array {
  const b = typeof body === "string" ? utf8(body) : body;
  const head = [`${method} / HTTP/1.1`, "Host: evm-rpc.test", `Content-Type: ${opts.contentType ?? "application/json"}`, ...(opts.noLength === true ? [] : [`Content-Length: ${b.length}`]), "Connection: close", ...extra];
  return concat(latin1(`${head.join("\r\n")}\r\n\r\n`), b);
}

/** A `POST` with a chunked body. */
function chunked(body: Uint8Array, chunk = 65_536): Uint8Array {
  const parts = [latin1(["POST / HTTP/1.1", "Host: evm-rpc.test", "Content-Type: application/json", "Transfer-Encoding: chunked", "Connection: close"].join("\r\n") + "\r\n\r\n")];
  for (let i = 0; i < body.length; i += chunk) {
    const c = body.subarray(i, i + chunk);
    parts.push(latin1(`${c.length.toString(16)}\r\n`), c, latin1("\r\n"));
  }
  parts.push(latin1("0\r\n\r\n"));
  return concat(...parts);
}

const call = (id: unknown, method: string, params?: unknown): string =>
  JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });

/** The test-only methods the border cases call: results and error data that are not JSON values, and big results. */
export function registerWireTestMethods(registry: MethodRegistry): void {
  registry.registerMethod("test_big", async (params) => "x".repeat(Number((params as unknown[])[0])));
  registry.registerMethod("test_bigint", async () => 1n);
  registry.registerMethod("test_undefined", async () => undefined);
  registry.registerMethod("test_tojson", async () => ({ toJSON: () => ({ ok: true }) }));
  registry.registerMethod("test_error_bigint_data", async () => {
    throw new RpcError(-32099, "custom", { n: 1n });
  });
  registry.registerMethod("test_error_hidden_data", async () => {
    throw new RpcError(-32099, `custom ${String.fromCharCode(0x202e)}`, { hidden: `a${String.fromCharCode(0x0000, 0x200b)}b` });
  });
}

/** Every case, in a fixed order: the differential cases, then the border cases. */
export function wireCases(): WireCase[] {
  const cases: WireCase[] = differentialCases().map((c) => ({ name: c.name, raw: request(c.method, c.body), text: c.method === "POST" ? c.body : null }));
  const post = (name: string, body: string): void => {
    cases.push({ name, raw: request("POST", body), text: body });
  };
  const ch = (...codes: number[]): string => String.fromCharCode(...codes);
  const chainId = call(1, "eth_chainId");

  // Transport.
  cases.push({ name: "HEAD request", raw: request("HEAD", ""), text: null });
  cases.push({ name: "DELETE request with a body", raw: request("DELETE", chainId), text: null });
  cases.push({ name: "PATCH request", raw: request("PATCH", ""), text: null });
  cases.push({ name: "POST with Expect: 100-continue", raw: request("POST", chainId, ["Expect: 100-continue"]), text: null });
  cases.push({ name: "POST with no length and no body", raw: request("POST", "", [], { noLength: true }), text: null });
  cases.push({ name: "POST as text/plain", raw: request("POST", chainId, [], { contentType: "text/plain" }), text: null });
  cases.push({ name: "chunked body at the cap", raw: chunked(utf8(`${chainId}${" ".repeat(1_048_576 - chainId.length)}`)), text: null });
  cases.push({ name: "chunked body over the cap", raw: chunked(utf8(`${chainId}${" ".repeat(1_048_577)}`)), text: null });
  cases.push({ name: "bytes that are not UTF-8 in an id", raw: request("POST", concat(utf8('{"jsonrpc":"2.0","id":"'), Uint8Array.of(0xff, 0xfe, 0xc3), utf8('","method":"eth_chainId"}'))), text: null });

  // Bodies and envelopes.
  post("a NUL after the request", `${chainId}${ch(0)}`);
  post("a byte-order mark and a request", `${ch(0xfeff)}${chainId}`);
  post("a __proto__ member", '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","__proto__":{"id":2,"params":"x"}}');
  post("an envelope inside __proto__", '{"__proto__":{"jsonrpc":"2.0","method":"eth_chainId","id":1}}');
  for (const method of ["__proto__", "constructor", "toString", "hasOwnProperty"]) post(`method ${method}`, call(1, method));
  post("params 400,000 levels deep", `{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":${"[".repeat(400_000)}${"]".repeat(400_000)}}`);
  post("an id 200,000 levels deep", `{"jsonrpc":"2.0","id":${"[".repeat(200_000)}${"]".repeat(200_000)},"method":"eth_chainId"}`);
  post("id 1e309", '{"jsonrpc":"2.0","id":1e309,"method":"eth_chainId"}');
  post("id -0", '{"jsonrpc":"2.0","id":-0,"method":"eth_chainId"}');
  post("id 1e21", '{"jsonrpc":"2.0","id":1e21,"method":"eth_chainId"}');
  post("an escaped lone surrogate in an id", '{"jsonrpc":"2.0","id":"a\\ud800b","method":"eth_chainId"}');
  post("a line separator in an id", `{"jsonrpc":"2.0","id":"a${ch(0x2028)}b","method":"eth_chainId"}`);
  post("an id of 900,000 characters", call("i".repeat(900_000), "eth_chainId"));

  // Results, errors and batches.
  post("a result that is a BigInt", call(1, "test_bigint"));
  post("a result that is undefined", call(1, "test_undefined"));
  post("a result with toJSON", call(1, "test_tojson"));
  post("error data that is a BigInt", call(1, "test_error_bigint_data"));
  post("error data with hidden characters", call(1, "test_error_hidden_data"));
  post("a single result over 1 MiB", call(1, "test_big", [2_000_000]));
  post("a batch over the response cap", `[${[call(1, "test_big", [600_000]), call(2, "test_big", [600_000]), call(3, "eth_chainId"), call(4, "test_big", [10])].join(",")}]`);
  post("a batch just under the response cap", `[${Array.from({ length: 30 }, (_, i) => call(i, "test_big", [34_900])).join(",")}]`);
  post("a mixed batch of 100", `[${Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId" }) : call(i, i % 2 === 1 ? "eth_fooBar" : "net_version"))).join(",")}]`);
  return cases;
}
