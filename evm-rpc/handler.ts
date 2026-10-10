/**
 * The JSON-RPC 2.0 handler of the EVM JSON-RPC module, runtime-neutral (no Node API): Node's HTTP server
 * (`server.ts`) and the browser engine's JSON RPC module (`token-indexer/browser/jsonrpc-module.ts`) both answer
 * through it, so a request gets the same answer from both.
 *
 * {@link dispatchPayload} answers one decoded payload (a request or a batch) from a method registry;
 * {@link handleHttpRequest} answers one HTTP request the way the HTTP surface does: its status, its headers (CORS, the
 * content type and length) and its body, for an HTTP method and a body. The transport rules are those of
 * `METHODS.md` ("Transport and envelope").
 */
import { JSON_RPC_ERRORS, type MethodRegistry, RpcError, type RpcContext } from "./registry.js";

type JsonRpcId = string | number | null;

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** The largest request body read, in bytes of UTF-8. */
export const MAX_REQUEST_BYTES = 1_048_576;
const MAX_BATCH_ENTRIES = 100;
const BATCH_CONCURRENCY = 8;
const MAX_BATCH_RESPONSE_BYTES = 1_048_576;

function failure(id: JsonRpcId, error: RpcError): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}

/**
 * The length of `text` in bytes of UTF-8, as Node's `Buffer.byteLength(text, "utf8")` counts it: a lone surrogate
 * counts as the three bytes of the replacement character it is encoded as.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Canonicalizes a handler-owned value so transport serialization cannot invoke its code again. */
function jsonSafeValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("value is not representable as JSON");
  return JSON.parse(serialized) as unknown;
}

/** Dispatches one decoded request. `undefined` means a JSON-RPC notification. */
export async function dispatchRequest(
  input: unknown,
  registry: MethodRegistry,
  ctx: RpcContext,
): Promise<JsonRpcResponse | undefined> {
  if (!isRecord(input)) {
    return failure(null, new RpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request"));
  }
  const hasId = Object.hasOwn(input, "id");
  const id = hasId && validId(input.id) ? input.id : null;
  if (input.jsonrpc !== "2.0" || typeof input.method !== "string" || (hasId && !validId(input.id))) {
    return failure(id, new RpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request"));
  }
  const isNotification = !hasId;
  if (input.params !== undefined && !Array.isArray(input.params) && !isRecord(input.params)) {
    return isNotification ? undefined : failure(id, new RpcError(JSON_RPC_ERRORS.INVALID_PARAMS, "Invalid params"));
  }
  const handler = registry.getMethod(input.method);
  if (handler === undefined) {
    return isNotification ? undefined : failure(id, new RpcError(JSON_RPC_ERRORS.METHOD_NOT_FOUND, "Method not found"));
  }

  try {
    // Canonicalize plugin-owned values at the per-entry boundary. This rejects BigInt, cycles,
    // undefined/functions, and isolates toJSON execution from the later HTTP serializer.
    const result = jsonSafeValue(await handler(input.params, ctx));
    return isNotification ? undefined : { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (isNotification) return undefined;
    if (error instanceof RpcError) {
      try {
        const data = error.data === undefined ? undefined : jsonSafeValue(error.data);
        return failure(id, new RpcError(error.code, error.message, data));
      } catch {
        return failure(id, new RpcError(JSON_RPC_ERRORS.INTERNAL_ERROR, "Internal error"));
      }
    }
    return failure(id, new RpcError(JSON_RPC_ERRORS.INTERNAL_ERROR, "Internal error"));
  }
}

export async function dispatchPayload(
  input: unknown,
  registry: MethodRegistry,
  ctx: RpcContext,
): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  if (!Array.isArray(input)) return dispatchRequest(input, registry, ctx);
  if (input.length === 0) {
    return failure(null, new RpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request"));
  }
  if (input.length > MAX_BATCH_ENTRIES) {
    return failure(null, new RpcError(JSON_RPC_ERRORS.INVALID_REQUEST, `Batch exceeds ${MAX_BATCH_ENTRIES} entries`));
  }
  const responses: JsonRpcResponse[] = [];
  let responseBytes = 2; // JSON array brackets
  for (let offset = 0; offset < input.length; offset += BATCH_CONCURRENCY) {
    // Resolve bounded chunks, then account for them in input order. This avoids retaining every
    // large result while keeping deterministic batch ordering.
    const chunk = await Promise.all(input.slice(offset, offset + BATCH_CONCURRENCY)
      .map((entry) => dispatchRequest(entry, registry, ctx)));
    for (const response of chunk) {
      if (response === undefined) continue;
      const separatorBytes = responses.length === 0 ? 0 : 1;
      const bytes = utf8ByteLength(JSON.stringify(response)) + separatorBytes;
      if (responseBytes + bytes <= MAX_BATCH_RESPONSE_BYTES) {
        responses.push(response);
        responseBytes += bytes;
        continue;
      }
      const limited = failure(response.id, new RpcError(-32005, "Batch response limit exceeded"));
      responses.push(limited);
      responseBytes += utf8ByteLength(JSON.stringify(limited)) + separatorBytes;
    }
  }
  return responses.length === 0 ? undefined : responses;
}

/** One HTTP answer: status, headers in the order they are sent, and the body (empty: none). */
export interface HttpAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The CORS headers of every answer (allow-all, `METHODS.md` "Transport and envelope"). */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonAnswer(status: number, body: unknown, extra: Record<string, string> = {}): HttpAnswer {
  const serialized = JSON.stringify(body);
  return {
    status,
    headers: { ...CORS_HEADERS, ...extra, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(utf8ByteLength(serialized)) },
    body: serialized,
  };
}

/** The error a body reader throws for a body over {@link MAX_REQUEST_BYTES} (answered HTTP 413). */
export function requestTooLarge(): RpcError {
  return new RpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "Request body too large");
}

/** A body reader for a body already in memory as text: it refuses a body over {@link MAX_REQUEST_BYTES}. */
export function textBody(text: string): () => Promise<string> {
  return async () => {
    if (utf8ByteLength(text) > MAX_REQUEST_BYTES) throw requestTooLarge();
    return text;
  };
}

/**
 * Answers one HTTP request: `OPTIONS` → 204 (CORS preflight); any method but `POST` → 405 with `Allow`; then the body
 * (read only for `POST`, through `readBody`): a body the reader refuses as too large (it throws an `RpcError`) → 413;
 * a body that cannot be read or parsed as JSON → `-32700`; otherwise the payload's answer, or 204 with no body when it
 * holds only notifications.
 */
export async function handleHttpRequest(
  method: string,
  readBody: () => Promise<string>,
  registry: MethodRegistry,
  ctx: RpcContext,
): Promise<HttpAnswer> {
  if (method === "OPTIONS") return { status: 204, headers: { ...CORS_HEADERS }, body: "" };
  if (method !== "POST") {
    return jsonAnswer(405, failure(null, new RpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "POST required")), { Allow: "POST, OPTIONS" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody());
  } catch (error) {
    const rpcError = error instanceof RpcError
      ? error
      : new RpcError(JSON_RPC_ERRORS.PARSE_ERROR, "Parse error");
    return jsonAnswer(error instanceof RpcError ? 413 : 200, failure(null, rpcError));
  }

  const result = await dispatchPayload(parsed, registry, ctx);
  if (result === undefined) return { status: 204, headers: { ...CORS_HEADERS }, body: "" };
  try {
    return jsonAnswer(200, result);
  } catch {
    return jsonAnswer(200, failure(null, new RpcError(JSON_RPC_ERRORS.INTERNAL_ERROR, "Internal error")));
  }
}
