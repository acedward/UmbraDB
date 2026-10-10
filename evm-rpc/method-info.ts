/**
 * What a reader needs beside each method name of the module (the browser build's JSON RPC tab shows it): where the
 * answer comes from, in `METHODS.md`'s data-source tags, and an example of the method's parameters that the method
 * accepts. The method names themselves come from the registry (`read-only.ts`), not from here; a test checks that
 * {@link METHOD_NOTES} describes exactly the read-only registry's served methods and that {@link NODE_ONLY_METHODS}
 * are those only `npm run evm-rpc:all` registers. Runtime-neutral.
 *
 * Data-source tags: `config` (the chain ID and the package version), `const` (a compiled-in answer), `indexer` (the
 * Midnight indexer's GraphQL), `pg:<table>` (the `evm_rpc` database), `relay` (the relayer).
 */

export interface MethodNote {
  /** Where the answer comes from. */
  readonly source: string;
  /** Example parameters (positional) the method accepts. */
  readonly params: readonly unknown[];
  /** What else to know about the method here. */
  readonly note?: string;
}

const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const ZERO_HASH = `0x${"00".repeat(32)}`;

/** The served methods of the read-only entry point (the `-32004` methods aside). */
export const METHOD_NOTES: Readonly<Record<string, MethodNote>> = {
  eth_chainId: { source: "config", params: [] },
  net_version: { source: "config", params: [] },
  web3_clientVersion: { source: "config", params: [] },
  net_listening: { source: "const", params: [] },
  eth_syncing: { source: "const", params: [] },
  eth_accounts: { source: "const", params: [] },
  eth_gasPrice: { source: "const", params: [] },
  eth_estimateGas: { source: "const", params: [{ to: ZERO_ADDRESS, data: "0x" }] },
  eth_feeHistory: { source: "const; indexer for a block tag", params: ["0x4", "latest", [25, 75]] },
  eth_maxPriorityFeePerGas: { source: "const", params: [] },
  web3_sha3: { source: "const", params: ["0x68656c6c6f"] },
  eth_call: {
    source: "const",
    params: [{ to: ZERO_ADDRESS, data: "0x18160ddd" }, "latest"],
    note: "answers 0x for every call, as npm run evm-rpc does; the ERC20 views over the log ingest are served by Node only (npm run evm-rpc:all)",
  },
  eth_blockNumber: { source: "indexer", params: [] },
  eth_getBlockByNumber: { source: "indexer; pg:tx_index with full transactions", params: ["latest", false] },
  eth_getBlockByHash: { source: "indexer; pg:tx_index with full transactions", params: [ZERO_HASH, false] },
  eth_getBlockTransactionCountByHash: { source: "indexer", params: [ZERO_HASH] },
  eth_getBlockTransactionCountByNumber: { source: "indexer", params: ["latest"] },
  eth_getBalance: { source: "pg:balances, pg:address_map", params: [ZERO_ADDRESS, "latest"] },
  eth_getTransactionCount: { source: "pg:tx_index", params: [ZERO_ADDRESS, "latest"] },
  eth_getCode: { source: "pg:address_map", params: [ZERO_ADDRESS, "latest"] },
  eth_getTransactionByHash: { source: "pg:tx_index, then indexer", params: [ZERO_HASH] },
  eth_getTransactionReceipt: { source: "pg:tx_index, then indexer; pg:logs", params: [ZERO_HASH] },
  eth_getTransactionByBlockHashAndIndex: { source: "indexer; pg:tx_index", params: [ZERO_HASH, "0x0"] },
  eth_getTransactionByBlockNumberAndIndex: { source: "indexer; pg:tx_index", params: ["latest", "0x0"] },
  eth_getBlockReceipts: { source: "indexer; pg:tx_index, pg:logs", params: ["latest"] },
};

export interface NodeOnlyMethod {
  readonly method: string;
  /** Where Node serves it: HTTP (`EVM_RPC_PORT`), the WebSocket (`EVM_RPC_WS_PORT`), or both. */
  readonly surface: "HTTP" | "WebSocket" | "HTTP and WebSocket";
  readonly source: string;
  /** What it needs that only `npm run evm-rpc:all` runs. */
  readonly needs: string;
}

/** The methods only `npm run evm-rpc:all` serves (besides the ERC20 views of `eth_call`). */
export const NODE_ONLY_METHODS: readonly NodeOnlyMethod[] = [
  { method: "eth_getLogs", surface: "HTTP and WebSocket", source: "pg:logs, pg:address_map", needs: "the log ingest that fills evm_rpc.logs" },
  { method: "eth_sendRawTransaction", surface: "HTTP", source: "relay", needs: "a relayer (RELAY_URL)" },
  { method: "eth_subscribe", surface: "WebSocket", source: "pg:logs", needs: "the WebSocket server and the log ingest" },
  { method: "eth_unsubscribe", surface: "WebSocket", source: "const", needs: "the WebSocket server" },
];
