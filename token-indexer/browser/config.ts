/**
 * The browser build's settings: the network it indexes, the endpoints its sync reads by default, and where its store
 * lives (one OPFS directory per network, so a browser profile holds one store per network).
 *
 * The network and the two endpoints are fixed when the static site is built: `vite.config.ts` reads them from the
 * environment (`UMBRADB_BROWSER_NETWORK`, `UMBRADB_BROWSER_NODE_URL`, `UMBRADB_BROWSER_INDEXER_URL`; Stagenet when
 * unset), defines them as `__UMBRADB_BROWSER_CHAIN__` in the bundles, and admits exactly the endpoints' origins in the
 * pages' Content-Security-Policy (`connect-src`). Outside a build (Node tests) the Stagenet defaults apply.
 *
 * A build can also change the engine's start through Vite's `define` of `__UMBRADB_BROWSER_CONFIG__`, a JSON object:
 * `autoStart` (default true: the leader tab starts the store's saved configuration once its worker has booted, a new
 * store's at the finalized tip; `tabs.ts`), `start` (the configuration a new store starts with, a `StartConfig` of
 * `protocol.ts`; default `{}`: the endpoints below, from the tip) and `quota` (`checkEveryMs`, `recheckMs`,
 * `storeEveryMs` of the storage guard, `quota.ts`).
 */

/** A network and its two chain endpoints. */
export interface BrowserChain {
  readonly network: string;
  readonly nodeUrl: string;
  readonly indexerUrl: string;
}

/** The chain of a build configured with no environment: Stagenet. */
export const DEFAULT_BROWSER_CHAIN: BrowserChain = {
  network: "stagenet",
  nodeUrl: "https://rpc.stagenet.shielded.tools",
  indexerUrl: "https://indexer.stagenet.shielded.tools/api/v4/graphql",
};

/** Replaced by the build with the configured chain; undeclared outside a build. */
declare const __UMBRADB_BROWSER_CHAIN__: BrowserChain | undefined;

const chain: BrowserChain = typeof __UMBRADB_BROWSER_CHAIN__ === "undefined" ? DEFAULT_BROWSER_CHAIN : __UMBRADB_BROWSER_CHAIN__;

export const BROWSER_NETWORK = chain.network;
export const BROWSER_NODE_URL = chain.nodeUrl;
export const BROWSER_INDEXER_URL = chain.indexerUrl;
export const BROWSER_DATA_DIR = `opfs-ahp://umbradb-${BROWSER_NETWORK}`;

export interface BrowserBuildConfig {
  autoStart?: boolean;
  start?: unknown;
  quota?: { checkEveryMs?: number; recheckMs?: number; storeEveryMs?: number };
}

declare const __UMBRADB_BROWSER_CONFIG__: BrowserBuildConfig | undefined;

/** The build's settings (`{}` unless the build defines them). */
export const BROWSER_BUILD_CONFIG: BrowserBuildConfig = typeof __UMBRADB_BROWSER_CONFIG__ === "undefined" ? {} : __UMBRADB_BROWSER_CONFIG__;
