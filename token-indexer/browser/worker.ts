/**
 * The browser engine's dedicated module worker: the worker host (`host.ts`) on PGlite in OPFS, bound to the worker's
 * messages. It boots as soon as it loads (each phase is posted as a `boot` notice), answers every request with one
 * response, and posts the host's notices. Start it with `startEngineWorker()` (`client.ts`).
 */
import { BROWSER_DATA_DIR, BROWSER_INDEXER_URL, BROWSER_NETWORK, BROWSER_NODE_URL } from "./config.ts";
import { createWorkerHost } from "./host.ts";

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
});

scope.addEventListener("message", (event) => {
  void host.receive(event.data).then((response) => scope.postMessage(response));
});
host.onNotice((notice) => scope.postMessage(notice));
void host.boot();
