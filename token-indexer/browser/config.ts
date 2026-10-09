/**
 * The browser build's settings: the network it indexes, the endpoints its sync reads by default, and where its store
 * lives (one OPFS directory per network, so a browser profile holds one store per network).
 */
export const BROWSER_NETWORK = "stagenet";
export const BROWSER_NODE_URL = "https://rpc.stagenet.shielded.tools";
export const BROWSER_INDEXER_URL = "https://indexer.stagenet.shielded.tools/api/v4/graphql";
export const BROWSER_DATA_DIR = `opfs-ahp://umbradb-${BROWSER_NETWORK}`;
