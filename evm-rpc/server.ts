import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  JSON_RPC_ERRORS, MethodRegistry, RpcError, defaultRegistry, type RpcContext,
} from "./registry.js";

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

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

const MAX_REQUEST_BYTES = 1_048_576;
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
      const bytes = Buffer.byteLength(JSON.stringify(response)) + separatorBytes;
      if (responseBytes + bytes <= MAX_BATCH_RESPONSE_BYTES) {
        responses.push(response);
        responseBytes += bytes;
        continue;
      }
      const limited = failure(response.id, new RpcError(-32005, "Batch response limit exceeded"));
      responses.push(limited);
      responseBytes += Buffer.byteLength(JSON.stringify(limited)) + separatorBytes;
    }
  }
  return responses.length === 0 ? undefined : responses;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new RpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function setCors(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(serialized));
  response.end(serialized);
}

export interface RpcServerOptions {
  readonly ctx: RpcContext;
  readonly registry?: MethodRegistry;
}

export function createRpcServer(options: RpcServerOptions): Server {
  const registry = options.registry ?? defaultRegistry;
  return createServer(async (request, response) => {
    setCors(response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST, OPTIONS");
      sendJson(response, 405, failure(null, new RpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "POST required")));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(request));
    } catch (error) {
      const rpcError = error instanceof RpcError
        ? error
        : new RpcError(JSON_RPC_ERRORS.PARSE_ERROR, "Parse error");
      sendJson(response, error instanceof RpcError ? 413 : 200, failure(null, rpcError));
      return;
    }

    const result = await dispatchPayload(parsed, registry, options.ctx);
    if (result === undefined) {
      response.statusCode = 204;
      response.end();
      return;
    }
    try {
      sendJson(response, 200, result);
    } catch {
      sendJson(response, 200, failure(null, new RpcError(JSON_RPC_ERRORS.INTERNAL_ERROR, "Internal error")));
    }
  });
}
