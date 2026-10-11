/**
 * The browser build's settings: the network it indexes, the endpoints its sync reads by default, and where its store
 * lives (one OPFS directory per network, so a browser profile holds one store per network).
 *
 * The network, the two endpoints and the JSON RPC module's chain ID are fixed when the static site is built:
 * `vite.config.ts` reads them from the environment (`UMBRADB_BROWSER_NETWORK`, `UMBRADB_BROWSER_NODE_URL`,
 * `UMBRADB_BROWSER_INDEXER_URL`, `UMBRADB_BROWSER_CHAIN_ID`; Stagenet and Node's default chain ID 2400 when unset), defines them as `__UMBRADB_BROWSER_CHAIN__` in the bundles, and admits exactly the endpoints' origins in the
 * pages' Content-Security-Policy (`connect-src`). Outside a build (Node tests) the Stagenet defaults apply. The
 * archive sync and the JSON RPC module both read the chain through these endpoints.
 *
 * A build can also change the engine's start through Vite's `define` of `__UMBRADB_BROWSER_CONFIG__`, a JSON object:
 * `autoStart` (default true: the leader tab starts the store's saved configuration once its worker has booted, a new
 * store's at the finalized tip; `tabs.ts`), `start` (the configuration a new store starts with, a `StartConfig` of
 * `protocol.ts`; default `{}`: the endpoints below, from the tip) and `quota` (`checkEveryMs`, `recheckMs`,
 * `storeEveryMs` of the storage guard, `quota.ts`).
 */

/** A network, its two chain endpoints, and the chain ID the JSON RPC module reports for it. */
export interface BrowserChain {
  readonly network: string;
  readonly nodeUrl: string;
  readonly indexerUrl: string;
  /** The JSON RPC module's chain ID (`eth_chainId`, `net_version`), a non-negative decimal integer as Node's `CHAIN_ID`
   *  is; 2400, Node's default, unless the build sets it. */
  readonly chainId: string;
}

/** Node's default `CHAIN_ID` (`evm-rpc/rpc-cli.ts`), the JSON RPC module's chain ID unless a build sets one. */
export const DEFAULT_CHAIN_ID = "2400";

/** The chain of a build configured with no environment: Stagenet. */
export const DEFAULT_BROWSER_CHAIN: BrowserChain = {
  network: "stagenet",
  nodeUrl: "https://rpc.stagenet.shielded.tools",
  indexerUrl: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
  chainId: DEFAULT_CHAIN_ID,
};

/** Replaced by the build with the configured chain; undeclared outside a build. */
declare const __UMBRADB_BROWSER_CHAIN__: BrowserChain | undefined;

const chain: BrowserChain = typeof __UMBRADB_BROWSER_CHAIN__ === "undefined" ? DEFAULT_BROWSER_CHAIN : __UMBRADB_BROWSER_CHAIN__;

export const BROWSER_NETWORK = chain.network;
export const BROWSER_NODE_URL = chain.nodeUrl;
export const BROWSER_INDEXER_URL = chain.indexerUrl;
/** A chain defined without a chain ID reports Node's default. */
export const BROWSER_CHAIN_ID: string = (chain as Partial<BrowserChain>).chainId ?? DEFAULT_CHAIN_ID;
export const BROWSER_DATA_DIR = `opfs-ahp://umbradb-${BROWSER_NETWORK}`;

/** Replaced by the build with the package's version (`package.json`); undeclared outside a build. */
declare const __UMBRADB_PACKAGE_VERSION__: string | undefined;

/** The package's version, which the JSON RPC module reports (`web3_clientVersion`); "unknown" outside a build. */
export const BROWSER_PACKAGE_VERSION: string = typeof __UMBRADB_PACKAGE_VERSION__ === "undefined" ? "unknown" : __UMBRADB_PACKAGE_VERSION__;

export interface BrowserBuildConfig {
  autoStart?: boolean;
  start?: unknown;
  quota?: { checkEveryMs?: number; recheckMs?: number; storeEveryMs?: number };
}

declare const __UMBRADB_BROWSER_CONFIG__: BrowserBuildConfig | undefined;

/** The build's settings (`{}` unless the build defines them). */
export const BROWSER_BUILD_CONFIG: BrowserBuildConfig = typeof __UMBRADB_BROWSER_CONFIG__ === "undefined" ? {} : __UMBRADB_BROWSER_CONFIG__;
