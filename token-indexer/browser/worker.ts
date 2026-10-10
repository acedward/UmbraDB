/**
 * The browser engine's dedicated module worker: the worker host (`host.ts`) on PGlite in OPFS, bound to the worker's
 * messages. It boots as soon as it loads (each phase is posted as a `boot` notice), answers every request with one
 * response, and posts the host's notices. A new store's default configuration and the storage guard's intervals come
 * from the build's settings (`config.ts`), and so do the build's facts (app commit, PGlite and ledger versions;
 * `vite.config.ts`), which the system snapshot shows. Start it with `startEngineWorker()` (`client.ts`); a page runs it
 * through `connectEngineTabs()` (`tabs.ts`), whose leader tab starts the engine.
 */
import "./zod-jitless.ts"; // first: before any zod schema exists (the static build's CSP refuses zod's JIT)
import { BROWSER_BUILD_CONFIG, BROWSER_DATA_DIR, BROWSER_INDEXER_URL, BROWSER_NETWORK, BROWSER_NODE_URL } from "./config.ts";
import { createWorkerHost } from "./host.ts";
import type { BuildInfo } from "./host-system.ts";
import { StartConfigSchema } from "./protocol.ts";
import { connectedTabsCounter, defaultLocks } from "./tab-locks.ts";

/** Replaced by the build (`vite.config.ts` `define`). */
declare const __UMBRADB_BUILD__: BuildInfo | undefined;

/** The tabs connected to this store, for the system snapshot (`null` without Web Locks). */
const locks = defaultLocks();
const connectedTabs = locks === undefined ? () => null : connectedTabsCounter(locks, BROWSER_DATA_DIR);

/** The worker's global scope, as far as this module uses it. */
const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

const host = createWorkerHost({
  network: BROWSER_NETWORK,
  dataDir: BROWSER_DATA_DIR,
  nodeUrl: BROWSER_NODE_URL,
  indexerUrl: BROWSER_INDEXER_URL,
  build: typeof __UMBRADB_BUILD__ === "undefined" ? null : __UMBRADB_BUILD__,
  system: { connectedTabs },
  defaultStart: StartConfigSchema.parse(BROWSER_BUILD_CONFIG.start ?? {}),
  ...(BROWSER_BUILD_CONFIG.quota === undefined ? {} : { quota: BROWSER_BUILD_CONFIG.quota }),
});

scope.addEventListener("message", (event) => {
  void host.receive(event.data).then((response) => scope.postMessage(response));
});
host.onNotice((notice) => scope.postMessage(notice));
void host.boot();
