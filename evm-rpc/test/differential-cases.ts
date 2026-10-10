/**
 * Requests for the JSON-RPC differential tests: every method the read-only entry point (`npm run evm-rpc`) registers,
 * called with valid parameters against the recorded indexer (`recorded-indexer.ts`) and with wrong ones; every
 * not-implemented method; unknown method names; the JSON-RPC 2.0 envelope's rules (ids, params, notifications);
 * batches; bodies that are not JSON; and the request size cap. Each case is the HTTP method and the exact body text.
 */
import { NOT_IMPLEMENTED_METHODS } from "../methods/not-implemented.js";
import { BLOCK_HASH, HEIGHT, TX_HASH } from "./recorded-indexer.js";

export interface DifferentialCase {
  name: string;
  /** The HTTP method (`POST` unless the case is about the method). */
  method: string;
  body: string;
}

const hex = (n: number): string => `0x${n.toString(16)}`;
const h = (unprefixed: string): string => `0x${unprefixed}`;
const ADDRESS = `0x${"12".repeat(20)}`;
const UNKNOWN_HASH = `0x${"bb".repeat(32)}`;

/** `[method, params]` calls with valid parameters (and some with a `null` answer), one or more per method. */
export const VALID_CALLS: ReadonlyArray<readonly [string, unknown[]]> = [
  ["eth_chainId", []],
  ["net_version", []],
  ["web3_clientVersion", []],
  ["net_listening", []],
  ["eth_syncing", []],
  ["eth_accounts", []],
  ["eth_gasPrice", []],
  ["eth_maxPriorityFeePerGas", []],
  ["eth_estimateGas", [{ to: ADDRESS, data: "0x" }]],
  ["eth_estimateGas", ["not-a-transaction", "latest"]],
  ["eth_call", [{ to: ADDRESS, data: "0x18160ddd" }, "latest"]],
  ["eth_feeHistory", ["0x4", "latest", [25, 75]]],
  ["eth_feeHistory", ["0x3", hex(HEIGHT.head), []]],
  ["eth_feeHistory", ["0x5", "0x2"]],
  ["eth_feeHistory", ["0x0", "latest", [50]]],
  ["web3_sha3", ["0x"]],
  ["web3_sha3", ["0x68656c6c6f"]],
  ["eth_blockNumber", []],
  ["eth_getBlockByNumber", ["latest", false]],
  ["eth_getBlockByNumber", ["latest", true]],
  ["eth_getBlockByNumber", [hex(HEIGHT.h41), true]],
  ["eth_getBlockByNumber", [hex(HEIGHT.h40), false]],
  ["eth_getBlockByNumber", ["earliest", false]],
  ["eth_getBlockByNumber", ["pending", false]],
  ["eth_getBlockByNumber", ["0x63", false]],
  ["eth_getBlockByHash", [h(BLOCK_HASH.head), false]],
  ["eth_getBlockByHash", [h(BLOCK_HASH.h41).toUpperCase().replace("0X", "0x"), true]],
  ["eth_getBlockByHash", [UNKNOWN_HASH, false]],
  ["eth_getBlockTransactionCountByHash", [h(BLOCK_HASH.head)]],
  ["eth_getBlockTransactionCountByHash", [UNKNOWN_HASH]],
  ["eth_getBlockTransactionCountByNumber", ["latest"]],
  ["eth_getBlockTransactionCountByNumber", [hex(HEIGHT.h40)]],
  ["eth_getBlockTransactionCountByNumber", ["0x63"]],
  ["eth_getBalance", [ADDRESS, "latest"]],
  ["eth_getBalance", [ADDRESS]],
  ["eth_getTransactionCount", [ADDRESS, "pending"]],
  ["eth_getCode", [ADDRESS, "latest"]],
  ["eth_getTransactionByHash", [h(TX_HASH.success)]],
  ["eth_getTransactionByHash", [h(TX_HASH.duplicate)]],
  ["eth_getTransactionByHash", [h(TX_HASH.unlisted)]],
  ["eth_getTransactionByHash", [UNKNOWN_HASH]],
  ["eth_getTransactionReceipt", [h(TX_HASH.success)]],
  ["eth_getTransactionReceipt", [h(TX_HASH.partial)]],
  ["eth_getTransactionReceipt", [h(TX_HASH.failure)]],
  ["eth_getTransactionReceipt", [UNKNOWN_HASH]],
  ["eth_getTransactionByBlockHashAndIndex", [h(BLOCK_HASH.head), "0x1"]],
  ["eth_getTransactionByBlockHashAndIndex", [h(BLOCK_HASH.head), "0x5"]],
  ["eth_getTransactionByBlockNumberAndIndex", ["latest", "0x0"]],
  ["eth_getTransactionByBlockNumberAndIndex", [hex(HEIGHT.h41), "0x1"]],
  ["eth_getBlockReceipts", ["latest"]],
  ["eth_getBlockReceipts", [h(BLOCK_HASH.h41)]],
  ["eth_getBlockReceipts", [hex(HEIGHT.h40)]],
  ["eth_getBlockReceipts", ["0x63"]],
];

/** Calls the methods refuse (`-32602`), or that fail in the indexer (`-32603`). */
export const FAILING_CALLS: ReadonlyArray<readonly [string, unknown]> = [
  ["eth_chainId", ["extra"]],
  ["eth_chainId", { by: "name" }],
  ["eth_estimateGas", []],
  ["eth_call", []],
  ["eth_feeHistory", ["0x2", "yesterday", []]],
  ["eth_feeHistory", ["0x401", "latest", []]],
  ["eth_feeHistory", ["0x2", "latest", [101]]],
  ["web3_sha3", ["0x1"]],
  ["web3_sha3", ["text"]],
  ["eth_blockNumber", ["latest"]],
  ["eth_getBlockByNumber", ["0x0baa", false]],
  ["eth_getBlockByNumber", ["latest"]],
  ["eth_getBlockByNumber", ["latest", "false"]],
  ["eth_getBlockByNumber", ["0x80000000", false]],
  ["eth_getBlockByNumber", [hex(HEIGHT.httpFailure), false]],
  ["eth_getBlockByHash", ["0x1234", false]],
  ["eth_getBlockTransactionCountByHash", ["0x12"]],
  ["eth_getBlockTransactionCountByNumber", ["garbage"]],
  ["eth_getBalance", ["0x12"]],
  ["eth_getBalance", [ADDRESS, 7]],
  ["eth_getTransactionCount", []],
  ["eth_getCode", [ADDRESS, "latest", "extra"]],
  ["eth_getTransactionByHash", ["0x12"]],
  ["eth_getTransactionByHash", [h(TX_HASH.graphqlError)]],
  ["eth_getTransactionReceipt", [h(TX_HASH.graphqlError)]],
  ["eth_getTransactionByBlockHashAndIndex", [h(BLOCK_HASH.head), "0x01"]],
  ["eth_getTransactionByBlockNumberAndIndex", ["latest", "1"]],
  ["eth_getBlockReceipts", [{ blockHash: h(BLOCK_HASH.head) }]],
];

const call = (id: number | string | null, method: string, params?: unknown): Record<string, unknown> =>
  params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
const post = (name: string, body: unknown): DifferentialCase => ({ name, method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

/** Every case, in a fixed order. */
export function differentialCases(): DifferentialCase[] {
  const cases: DifferentialCase[] = [];
  let id = 1;
  for (const [method, params] of VALID_CALLS) cases.push(post(`${method} ${JSON.stringify(params)}`, call(id++, method, params)));
  for (const [method, params] of FAILING_CALLS) cases.push(post(`${method} ${JSON.stringify(params)} (refused)`, call(id++, method, params)));
  for (const { method } of NOT_IMPLEMENTED_METHODS) cases.push(post(`${method} (not implemented)`, call(id++, method, [])));
  for (const method of ["eth_fooBar", "debug_traceTransaction", "admin_peers", "personal_sign", ""]) cases.push(post(`${method || "(empty name)"} (unknown)`, call(id++, method, [])));

  // The envelope.
  cases.push(post("no params member", call("no-params", "eth_chainId")));
  cases.push(post("string id", call("wallet-7", "eth_chainId", [])));
  cases.push(post("null id", call(null, "net_version", [])));
  cases.push(post("fractional id", call(1.5, "net_version", [])));
  cases.push(post("id with hidden characters", call("id ‮​<b>x</b> ü\u{1f600}", "eth_chainId", [])));
  cases.push(post("boolean id", { jsonrpc: "2.0", id: true, method: "eth_chainId" }));
  cases.push(post("object id", { jsonrpc: "2.0", id: { a: 1 }, method: "eth_chainId" }));
  cases.push(post("no jsonrpc member", { id: 1, method: "eth_chainId" }));
  cases.push(post("jsonrpc 1.0", { jsonrpc: "1.0", id: 1, method: "eth_chainId" }));
  cases.push(post("method is a number", { jsonrpc: "2.0", id: 1, method: 7 }));
  cases.push(post("params is a string", call(1, "eth_chainId", "x")));
  cases.push(post("params is null", call(1, "eth_chainId", null)));
  cases.push(post("unknown members", { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [], extra: { nested: [1] } }));
  cases.push(post("notification", { jsonrpc: "2.0", method: "eth_chainId", params: [] }));
  cases.push(post("notification of an unknown method", { jsonrpc: "2.0", method: "eth_fooBar" }));
  cases.push(post("notification with string params", { jsonrpc: "2.0", method: "eth_chainId", params: "x" }));

  // Batches.
  cases.push(post("batch", [
    call(1, "eth_chainId", []),
    call(2, "eth_getBlockByNumber", ["latest", false]),
    { jsonrpc: "2.0", method: "net_version", params: [] },
    call(3, "eth_fooBar", []),
    call(4, "eth_getStorageAt", []),
    call(5, "eth_getBalance", ["0x12"]),
    7,
    "text",
    call(6, "eth_getTransactionReceipt", [h(TX_HASH.success)]),
  ]));
  cases.push(post("batch of ten (more than one concurrent chunk)", Array.from({ length: 10 }, (_, i) => call(i, i % 2 === 0 ? "eth_blockNumber" : "eth_getBlockByNumber", i % 2 === 0 ? [] : [hex(HEIGHT.h41 - (i % 3)), false]))));
  cases.push(post("batch of notifications only", [{ jsonrpc: "2.0", method: "eth_chainId" }, { jsonrpc: "2.0", method: "net_version" }]));
  cases.push(post("empty batch", []));
  cases.push(post("batch of 100", Array.from({ length: 100 }, (_, i) => call(i, "eth_chainId", []))));
  cases.push(post("batch of 101", Array.from({ length: 101 }, (_, i) => call(i, "eth_chainId", []))));

  // Bodies that are not a request.
  for (const [name, body] of [["truncated JSON", "{"], ["empty body", ""], ["not JSON", "nul"], ["unterminated batch", "[1,"], ["a string", "\"text\""], ["a number", "123"], ["null", "null"], ["whitespace around", "  \n {\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"eth_chainId\"}\n "]] as const) {
    cases.push(post(name, body));
  }

  // The request size cap (1 MiB): at the cap the request is read, one byte over it is refused (HTTP 413).
  const request = JSON.stringify(call(1, "eth_chainId", []));
  const atCap = request + " ".repeat(1_048_576 - request.length);
  cases.push(post("body of exactly 1 MiB", atCap));
  cases.push(post("body one byte over 1 MiB", `${atCap} `));
  cases.push(post("body over 1 MiB by its multi-byte characters", `${request}${"ü".repeat(524_288)}`));

  // HTTP methods other than POST.
  for (const method of ["GET", "PUT", "OPTIONS"]) cases.push({ name: `${method} request`, method, body: method === "PUT" ? request : "" });
  return cases;
}
