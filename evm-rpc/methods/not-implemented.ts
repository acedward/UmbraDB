/**
 * The NYI policy (plan 00006 Phase 5, spec FR-009): every method the **official Ethereum
 * JSON-RPC spec** defines but this wallet-compatibility surface deliberately does not implement
 * answers `-32004 "Method not supported"` (EIP-1474's non-standard code for "method is not
 * implemented"), with `data` naming its classification, its reason and the doc that explains it.
 *
 * Why this matters, and why it is NOT the same as `-32601`:
 *   - `-32601 "Method not found"` is JSON-RPC 2.0's code for a method name the server does not
 *     recognise at all. It stays reserved for exactly that — a typo or a foreign namespace.
 *   - `-32004` tells a client "this name is real, I know it, I am choosing not to serve it".
 *     That is actionable: a wallet or library can fall back (e.g. poll `eth_getLogs` instead of
 *     installing a filter) rather than concluding the endpoint is broken or mis-versioned.
 *
 * The three classifications:
 *   - `n/a-by-design`  — structurally impossible on Midnight. Contract state is a ledger blob and
 *                        there is no EVM execution engine, storage trie or state proof to read, so
 *                        no future version of this service can answer these.
 *   - `intentionally-absent` — the capability exists somewhere else by design. Signing lives in
 *                        the wallet (`eth_accounts` is `[]`, so wallets never call these) and there
 *                        is no mining identity.
 *   - `backlog`        — implementable, deliberately deferred until a real consumer needs it.
 *                        Today that is only the stateful polling-filter family.
 *
 * This list is the single source of truth for METHODS.md's "Not implemented (-32004)" section.
 */
import { JSON_RPC_ERRORS, MethodRegistry, RpcError } from "../registry.js";

export type NotImplementedClass = "n/a-by-design" | "intentionally-absent" | "backlog";

export interface NotImplementedMethod {
  readonly method: string;
  readonly classification: NotImplementedClass;
  readonly reason: string;
}

/** Where a client should look for the full explanation; travels in every `-32004` `data`. */
export const NOT_IMPLEMENTED_DOC = "evm-rpc/METHODS.md#not-implemented--32004";

export const NOT_IMPLEMENTED_METHODS: readonly NotImplementedMethod[] = [
  // --- polling filter family (stateful; ethers v6 polls eth_getLogs instead) -------------------
  { method: "eth_newFilter", classification: "backlog", reason: "stateful polling filters; use eth_getLogs or eth_subscribe(\"logs\")" },
  { method: "eth_newBlockFilter", classification: "backlog", reason: "stateful polling filters; use eth_subscribe(\"newHeads\")" },
  { method: "eth_newPendingTransactionFilter", classification: "backlog", reason: "no mempool view: Midnight transactions are not observable before they are indexed" },
  { method: "eth_getFilterChanges", classification: "backlog", reason: "no filter registry to poll; no filter can be installed" },
  { method: "eth_getFilterLogs", classification: "backlog", reason: "no filter registry to poll; use eth_getLogs with the same filter object" },
  { method: "eth_uninstallFilter", classification: "backlog", reason: "no filter registry to uninstall from" },

  // --- signing / wallet-side methods ------------------------------------------------------------
  { method: "eth_sendTransaction", classification: "intentionally-absent", reason: "node-side signing; this service holds no keys (eth_accounts is []). Sign in the wallet and use eth_sendRawTransaction" },
  { method: "eth_sign", classification: "intentionally-absent", reason: "node-side signing; this service holds no keys" },
  { method: "eth_signTransaction", classification: "intentionally-absent", reason: "node-side signing; this service holds no keys" },
  { method: "eth_coinbase", classification: "intentionally-absent", reason: "no mining identity: Midnight blocks are authored by validators, not miners with a reward address" },

  // --- state-trie / execution-engine methods ----------------------------------------------------
  { method: "eth_getStorageAt", classification: "n/a-by-design", reason: "no EVM storage trie: contract state is a Midnight ledger blob" },
  { method: "eth_getStorageValues", classification: "n/a-by-design", reason: "no EVM storage trie: contract state is a Midnight ledger blob" },
  { method: "eth_getProof", classification: "n/a-by-design", reason: "no state trie, so no Merkle proofs to serve" },
  { method: "eth_createAccessList", classification: "n/a-by-design", reason: "no EVM execution engine to trace storage access" },
  { method: "eth_getBlockAccessList", classification: "n/a-by-design", reason: "no EVM execution engine and no per-block access list" },
  { method: "eth_simulateV1", classification: "n/a-by-design", reason: "no EVM execution engine to simulate against" },
  { method: "eth_fillTransaction", classification: "n/a-by-design", reason: "no EVM execution engine and no node-side signing" },
  { method: "eth_baseFee", classification: "n/a-by-design", reason: "legacy-fee chain: blocks carry no baseFeePerGas by design, which keeps wallets on type-0 transactions" },
  { method: "eth_blobBaseFee", classification: "n/a-by-design", reason: "no blob transactions on Midnight" },

  // --- discovery endpoints ----------------------------------------------------------------------
  { method: "eth_capabilities", classification: "backlog", reason: "advertises data-retention windows; nothing meaningful to declare for a local demo surface" },
  { method: "eth_config", classification: "backlog", reason: "advertises fork configuration; Midnight has no Ethereum fork schedule to report" },
];

/**
 * Registers one `-32004` stub per {@link NOT_IMPLEMENTED_METHODS} entry. Call AFTER the real
 * method registrations: the registry rejects duplicates, so a name that later gains a real
 * implementation must be removed from the list above rather than silently shadowed.
 */
export function registerNotImplementedMethods(registry: MethodRegistry): void {
  for (const entry of NOT_IMPLEMENTED_METHODS) {
    registry.registerMethod(entry.method, async () => {
      throw new RpcError(JSON_RPC_ERRORS.METHOD_NOT_SUPPORTED, "Method not supported", {
        method: entry.method,
        classification: entry.classification,
        reason: entry.reason,
        documentation: NOT_IMPLEMENTED_DOC,
      });
    });
  }
}
