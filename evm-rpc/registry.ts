import type { EvmRpcReader } from "./db.js";
import type { IndexerReader } from "./indexer-gql.js";

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcContext {
  readonly chainId: bigint;
  readonly clientVersion: string;
  readonly indexer: IndexerReader;
  readonly db: EvmRpcReader;
}

export type RpcHandler = (params: unknown, ctx: RpcContext) => Promise<unknown>;

export interface RegisterMethodOptions {
  readonly replace?: boolean;
}

export class MethodRegistry {
  readonly #methods = new Map<string, RpcHandler>();

  registerMethod(name: string, handler: RpcHandler, options: RegisterMethodOptions = {}): void {
    if (name.length === 0) throw new Error("RPC method name must not be empty");
    if (this.#methods.has(name) && options.replace !== true) {
      throw new Error(`RPC method already registered: ${name}`);
    }
    this.#methods.set(name, handler);
  }

  getMethod(name: string): RpcHandler | undefined {
    return this.#methods.get(name);
  }

  listMethods(): readonly string[] {
    return [...this.#methods.keys()].sort();
  }
}

export const defaultRegistry = new MethodRegistry();

/** Process-wide plugin seam used by the Part C and Part E modules. */
export function registerMethod(name: string, handler: RpcHandler, options?: RegisterMethodOptions): void {
  defaultRegistry.registerMethod(name, handler, options);
}

