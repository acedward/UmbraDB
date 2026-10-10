/**
 * The methods of the read-only entry point (`npm run evm-rpc`, `rpc-cli.ts`), runtime-neutral: the chain constants and
 * configuration, blocks and transactions from the Midnight indexer, accounts and transactions from the `evm_rpc`
 * database, and the `-32004` answers of the methods this surface does not serve. Node's entry point and the browser
 * engine's JSON RPC module register exactly these.
 */
import { registerAccountMethods } from "./methods/accounts.js";
import { registerBlockMethods } from "./methods/blocks.js";
import { registerNotImplementedMethods } from "./methods/not-implemented.js";
import { registerStaticMethods } from "./methods/static.js";
import { registerTransactionMethods } from "./methods/transactions.js";
import type { MethodRegistry } from "./registry.js";

export function registerReadOnlyMethods(registry: MethodRegistry): void {
  registerStaticMethods(registry);
  registerBlockMethods(registry);
  registerAccountMethods(registry);
  registerTransactionMethods(registry);
  // Last: spec-defined methods this surface deliberately does not serve answer -32004, not -32601.
  registerNotImplementedMethods(registry);
}
