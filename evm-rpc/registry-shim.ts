/**
 * Part F merge bridge: Part C's registration surface, now backed by Part B's registry.
 *
 * Pre-merge this file was a standalone stand-in (a bare Map) so `evm-rpc/logs/*` had something
 * to register against. Post-merge it does two jobs, keeping every C call site unchanged:
 *
 * 1. It still keeps its OWN map of C-registered handlers — `getMethod` serves the WS
 *    subscription server (`logs/subscribe.ts`), which dispatches without an `RpcContext`.
 * 2. Every registration is ALSO forwarded into Part B's process-wide `defaultRegistry`
 *    (wrapped so B's `(params, ctx)` calling convention feeds C's `(paramsArray)` handlers),
 *    so the HTTP JSON-RPC server dispatches `eth_getLogs` etc. natively. The forward uses
 *    `replace: true` so test suites that `clearRegistry()` and re-register don't trip B's
 *    duplicate guard; first-registration uniqueness is still enforced by the local map.
 *
 * `JsonRpcError` is now a subclass of B's `RpcError`, so errors thrown by C handlers pass
 * B's `instanceof RpcError` check and keep their wire codes (`-32602`, `-32005`).
 */
import { defaultRegistry, RpcError } from "./registry.js";

/** A JSON-RPC method handler. `params` is the raw `params` array from the request. */
export type JsonRpcHandler = (params: readonly unknown[]) => Promise<unknown> | unknown;

/**
 * A JSON-RPC error carrying a wire `code`. The two codes Part C must produce are
 * `-32602` (invalid params) and `-32005` (limit exceeded, geth's "query returned more than N
 * results").
 */
export class JsonRpcError extends RpcError {
  constructor(code: number, message: string, data?: unknown) {
    super(code, message, data);
    this.name = "JsonRpcError";
  }
}

export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_LIMIT_EXCEEDED = -32005;

const methods = new Map<string, JsonRpcHandler>();

function toParamsArray(params: unknown): readonly unknown[] {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? params : [params];
}

/** Registers `handler` under `name`. Re-registering a name is an error, not a silent overwrite. */
export function registerMethod(name: string, handler: JsonRpcHandler): void {
  if (methods.has(name)) {
    throw new Error(`registry: method "${name}" is already registered`);
  }
  methods.set(name, handler);
  defaultRegistry.registerMethod(name, async (params, _ctx) => handler(toParamsArray(params)), {
    replace: true,
  });
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
