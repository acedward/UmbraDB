/**
 * The browser build's settings: the network it indexes, the endpoints its sync reads by default, and where its store
 * lives (one OPFS directory per network, so a browser profile holds one store per network).
 *
 * A build can change the engine's start through Vite's `define` of `__UMBRADB_BROWSER_CONFIG__`, a JSON object:
 * `autoStart` (default true: the leader tab starts the store's saved configuration once its worker has booted, a new
 * store's at the finalized tip; `tabs.ts`), `start` (the configuration a new store starts with, a `StartConfig` of
 * `protocol.ts`; default `{}`: the network endpoints below, from the tip) and `quota` (`checkEveryMs`, `recheckMs`,
 * `storeEveryMs` of the storage guard, `quota.ts`).
 */
export const BROWSER_NETWORK = "stagenet";
export const BROWSER_NODE_URL = "https://rpc.stagenet.shielded.tools";
export const BROWSER_INDEXER_URL = "https://indexer.stagenet.shielded.tools/api/v4/graphql";
export const BROWSER_DATA_DIR = `opfs-ahp://umbradb-${BROWSER_NETWORK}`;

export interface BrowserBuildConfig {
  autoStart?: boolean;
  start?: unknown;
  quota?: { checkEveryMs?: number; recheckMs?: number; storeEveryMs?: number };
}

declare const __UMBRADB_BROWSER_CONFIG__: BrowserBuildConfig | undefined;

/** The build's settings (`{}` unless the build defines them). */
export const BROWSER_BUILD_CONFIG: BrowserBuildConfig = typeof __UMBRADB_BROWSER_CONFIG__ === "undefined" ? {} : __UMBRADB_BROWSER_CONFIG__;
