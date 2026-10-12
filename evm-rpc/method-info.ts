/**
 * What a reader needs beside each method name of the module (the browser build's JSON RPC tab shows it): where the
 * answer comes from, in `METHODS.md`'s data-source tags, what it answers in one line (`METHODS.md`'s summaries), the
 * kind of each of its parameters (for a form with one typed field per parameter), and an example of the method's
 * parameters that the method accepts. The method names themselves come from the registry (`read-only.ts`), not from here; a test checks that
 * {@link METHOD_NOTES} describes exactly the read-only registry's served methods and that {@link NODE_ONLY_METHODS}
 * are those only `npm run evm-rpc:all` registers. Runtime-neutral.
 *
 * Data-source tags: `config` (the chain ID and the package version), `const` (a compiled-in answer), `indexer` (the
 * Midnight indexer's GraphQL), `pg:<table>` (the `evm_rpc` database), `relay` (the relayer).
 */

/**
 * The kind of one parameter, for a form with one typed field per parameter: `address` (20 bytes, `0x` and 40 hex
 * digits), `hash` (32 bytes), `quantity` (a canonical hex quantity), `blockTag` (`latest`, `earliest`, `pending`,
 * `safe`, `finalized` or a block number), `blockRef` (a block tag, a block number or a 32-byte block hash), `boolean`,
 * `data` (`0x` and an even number of hex digits), `percentiles` (numbers from 0 to 100), `object` (any JSON object).
 */
export type ParamKind = "address" | "hash" | "quantity" | "blockTag" | "blockRef" | "boolean" | "data" | "percentiles" | "object";

export interface ParamSpec {
  readonly name: string;
  readonly kind: ParamKind;
  /** A trailing parameter that may be left out. */
  readonly optional?: boolean;
}

export interface MethodNote {
  /** Where the answer comes from. */
  readonly source: string;
  /** What the method answers, in one line. */
  readonly summary: string;
  /** Its positional parameters, in order. */
  readonly paramSpecs: readonly ParamSpec[];
  /** Example parameters (positional) the method accepts. */
  readonly params: readonly unknown[];
  /** What else to know about the method here. */
  readonly note?: string;
}

const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const ZERO_HASH = `0x${"00".repeat(32)}`;

const none: readonly ParamSpec[] = [];
const account: readonly ParamSpec[] = [{ name: "address", kind: "address" }, { name: "block", kind: "blockTag", optional: true }];
const call: readonly ParamSpec[] = [{ name: "transaction", kind: "object" }, { name: "block", kind: "blockTag", optional: true }];

/** The served methods of the read-only entry point (the `-32004` methods aside). */
export const METHOD_NOTES: Readonly<Record<string, MethodNote>> = {
  eth_chainId: { source: "config", summary: "the chain ID, as a quantity", paramSpecs: none, params: [] },
  net_version: { source: "config", summary: "the chain ID, as a decimal string", paramSpecs: none, params: [] },
  web3_clientVersion: { source: "config", summary: "the service's name and version", paramSpecs: none, params: [] },
  net_listening: { source: "const", summary: "true: the service answers", paramSpecs: none, params: [] },
  eth_syncing: { source: "const", summary: "always false", paramSpecs: none, params: [] },
  eth_accounts: { source: "const", summary: "no accounts: keys live in the wallet", paramSpecs: none, params: [] },
  eth_gasPrice: { source: "const", summary: "1 gwei, for wallets that need a fee figure", paramSpecs: none, params: [] },
  eth_estimateGas: { source: "const", summary: "always 21,000 gas", paramSpecs: call, params: [{ to: ZERO_ADDRESS, data: "0x" }] },
  eth_feeHistory: {
    source: "const; indexer for a block tag",
    summary: "zero fees over a range of blocks ending at the given one",
    paramSpecs: [{ name: "block count", kind: "quantity" }, { name: "newest block", kind: "blockTag" }, { name: "reward percentiles", kind: "percentiles", optional: true }],
    params: ["0x4", "latest", [25, 75]],
  },
  eth_maxPriorityFeePerGas: { source: "const", summary: "0: a legacy-fee chain", paramSpecs: none, params: [] },
  web3_sha3: { source: "const", summary: "the Keccak-256 hash of the data", paramSpecs: [{ name: "data", kind: "data" }], params: ["0x68656c6c6f"] },
  eth_call: {
    source: "const",
    summary: "the call's return data: 0x here",
    paramSpecs: call,
    params: [{ to: ZERO_ADDRESS, data: "0x18160ddd" }, "latest"],
    note: "answers 0x for every call, as npm run evm-rpc does; the ERC20 views over the log ingest are served by Node only (npm run evm-rpc:all)",
  },
  eth_blockNumber: { source: "indexer", summary: "the indexer's latest block height", paramSpecs: none, params: [] },
  eth_getBlockByNumber: {
    source: "indexer; pg:tx_index with full transactions",
    summary: "a block, by tag or number, with its transaction hashes or whole transactions",
    paramSpecs: [{ name: "block", kind: "blockTag" }, { name: "full transactions", kind: "boolean" }],
    params: ["latest", false],
  },
  eth_getBlockByHash: {
    source: "indexer; pg:tx_index with full transactions",
    summary: "a block, by hash, with its transaction hashes or whole transactions",
    paramSpecs: [{ name: "block hash", kind: "hash" }, { name: "full transactions", kind: "boolean" }],
    params: [ZERO_HASH, false],
  },
  eth_getBlockTransactionCountByHash: { source: "indexer", summary: "how many transactions a block holds, by hash", paramSpecs: [{ name: "block hash", kind: "hash" }], params: [ZERO_HASH] },
  eth_getBlockTransactionCountByNumber: { source: "indexer", summary: "how many transactions a block holds, by tag or number", paramSpecs: [{ name: "block", kind: "blockTag" }], params: ["latest"] },
  eth_getBalance: { source: "pg:balances, pg:address_map", summary: "an address's native balance, scaled to 18 decimals", paramSpecs: account, params: [ZERO_ADDRESS, "latest"] },
  eth_getTransactionCount: { source: "pg:tx_index", summary: "how many transactions an address has sent", paramSpecs: account, params: [ZERO_ADDRESS, "latest"] },
  eth_getCode: { source: "pg:address_map", summary: "a marker for a contract address, else 0x", paramSpecs: account, params: [ZERO_ADDRESS, "latest"] },
  eth_getTransactionByHash: { source: "pg:tx_index, then indexer", summary: "a transaction, by hash", paramSpecs: [{ name: "transaction hash", kind: "hash" }], params: [ZERO_HASH] },
  eth_getTransactionReceipt: { source: "pg:tx_index, then indexer; pg:logs", summary: "a transaction's receipt: status, fee, logs", paramSpecs: [{ name: "transaction hash", kind: "hash" }], params: [ZERO_HASH] },
  eth_getTransactionByBlockHashAndIndex: {
    source: "indexer; pg:tx_index",
    summary: "the transaction at a position of a block, by block hash",
    paramSpecs: [{ name: "block hash", kind: "hash" }, { name: "index", kind: "quantity" }],
    params: [ZERO_HASH, "0x0"],
  },
  eth_getTransactionByBlockNumberAndIndex: {
    source: "indexer; pg:tx_index",
    summary: "the transaction at a position of a block, by tag or number",
    paramSpecs: [{ name: "block", kind: "blockTag" }, { name: "index", kind: "quantity" }],
    params: ["latest", "0x0"],
  },
  eth_getBlockReceipts: { source: "indexer; pg:tx_index, pg:logs", summary: "every receipt of a block, by tag, number or hash", paramSpecs: [{ name: "block", kind: "blockRef" }], params: ["latest"] },
};

export interface NodeOnlyMethod {
  readonly method: string;
  /** Where Node serves it: HTTP (`EVM_RPC_PORT`), the WebSocket (`EVM_RPC_WS_PORT`), or both. */
  readonly surface: "HTTP" | "WebSocket" | "HTTP and WebSocket";
  readonly source: string;
  /** What the method answers, in one line. */
  readonly summary: string;
  /** What it needs that only `npm run evm-rpc:all` runs. */
  readonly needs: string;
}

/** The methods only `npm run evm-rpc:all` serves (besides the ERC20 views of `eth_call`). */
export const NODE_ONLY_METHODS: readonly NodeOnlyMethod[] = [
  { method: "eth_getLogs", surface: "HTTP and WebSocket", source: "pg:logs, pg:address_map", summary: "the logs that match a filter", needs: "the log ingest that fills evm_rpc.logs" },
  { method: "eth_sendRawTransaction", surface: "HTTP", source: "relay", summary: "sends a signed transaction through the relayer", needs: "a relayer (RELAY_URL)" },
  { method: "eth_subscribe", surface: "WebSocket", source: "pg:logs", summary: "a subscription to new logs", needs: "the WebSocket server and the log ingest" },
  { method: "eth_unsubscribe", surface: "WebSocket", source: "const", summary: "ends a subscription", needs: "the WebSocket server" },
];
