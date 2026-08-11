/**
 * A local stand-in for Part B's `evm-rpc/registry.ts`, matching its
 * `registerMethod(name, handler)` signature.
 *
 * Part B is not in this clone, so C's `eth_getLogs` / `eth_subscribe` would have nothing to
 * register against. This shim exists ONLY to keep the registration call sites in their final shape:
 * at the Part F merge, the imports change from `../registry-shim.js` to `../registry.js` and nothing
 * else moves. It is deliberately trivial — a Map plus the JSON-RPC error type — rather than a second
 * competing RPC framework.
 */

/** A JSON-RPC method handler. `params` is the raw `params` array from the request. */
export type JsonRpcHandler = (params: readonly unknown[]) => Promise<unknown> | unknown;

/**
 * A JSON-RPC error carrying a wire `code`. The two codes Part C must produce are
 * `-32602` (invalid params) and `-32005` (limit exceeded, geth's "query returned more than N
 * results").
 */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_LIMIT_EXCEEDED = -32005;

const methods = new Map<string, JsonRpcHandler>();

/** Registers `handler` under `name`. Re-registering a name is an error, not a silent overwrite. */
export function registerMethod(name: string, handler: JsonRpcHandler): void {
  if (methods.has(name)) {
    throw new Error(`registry: method "${name}" is already registered`);
  }
  methods.set(name, handler);
}

export function getMethod(name: string): JsonRpcHandler | undefined {
  return methods.get(name);
}

export function registeredMethods(): string[] {
  return [...methods.keys()].sort();
}

/** Test-only: drops every registration so suites do not leak into one another. */
export function clearRegistry(): void {
  methods.clear();
}
