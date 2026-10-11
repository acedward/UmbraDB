/**
 * The EVM JSON-RPC module over Node's own `http` server: a thin wrapper that reads each request's body (at most
 * `MAX_REQUEST_BYTES`, decoded as UTF-8) and hands its method and body to the runtime-neutral handler
 * (`handler.ts`), then writes the handler's answer as it is — status, headers and body.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { handleHttpRequest, MAX_REQUEST_BYTES, requestTooLarge } from "./handler.js";
import { MethodRegistry, defaultRegistry, type RpcContext } from "./registry.js";

export { dispatchPayload, dispatchRequest, type JsonRpcResponse } from "./handler.js";

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw requestTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface RpcServerOptions {
  readonly ctx: RpcContext;
  readonly registry?: MethodRegistry;
}

export function createRpcServer(options: RpcServerOptions): Server {
  const registry = options.registry ?? defaultRegistry;
  return createServer(async (request, response) => {
    const answer = await handleHttpRequest(request.method ?? "", () => readBody(request), registry, options.ctx);
    response.statusCode = answer.status;
    for (const [name, value] of Object.entries(answer.headers)) response.setHeader(name, value);
    if (answer.body === "") response.end();
    else response.end(answer.body);
  });
}
