/**
 * The explorer page's connection to the browser engine, made before the explorer script runs (`explorer-page.ts`
 * imports this module first): the page joins the other tabs of the store (`tabs.ts`: the leader tab runs the engine
 * worker and starts or resumes it, the others proxy to it), asks the browser to keep the site's storage
 * (`requestPersistentStorage`, from every tab), installs `window.umbradbExplorerHost` (`explorer-transport.ts`: the
 * explorer's API reads go to the engine) and exposes the client as `window.umbradbEngine`, as the engine page does, for
 * scripted use (the browser tests drive the engine through it), with the same snapshot helpers (`snapshot-page.ts`). The leader tab's worker runs under the page's watchdog
 * (`supervisor.ts`; `?watchdogLimitMs=<ms>` sets its limit, as on the engine page): an API read caught in a restart
 * gets the API's 503 `UNAVAILABLE`, which the explorer shows like any failed read.
 */
import { requestPersistentStorage, startEngineWorker } from "./client.ts";
import { engineExplorerHost, type ExplorerHost } from "./explorer-transport.ts";
import { fetchPublishedSnapshot, publishedSnapshots, saveSnapshotFile } from "./snapshot-page.ts";
import type { SupervisedEngine } from "./supervisor.ts";
import { connectEngineTabs, localEngineOf } from "./tabs.ts";

declare global {
  interface Window {
    umbradbExplorerHost?: ExplorerHost;
  }
}

const loadedAt = performance.now();
export const persistence = requestPersistentStorage();
const limit = Number(new URLSearchParams(location.search).get("watchdogLimitMs"));
let supervised: SupervisedEngine<Worker> | undefined;
export const tabs = connectEngineTabs({
  startWorker: () => {
    supervised = startEngineWorker(Number.isSafeInteger(limit) && limit >= 100 ? { limitMs: limit } : {});
    return localEngineOf(supervised);
  },
});
export const client = tabs.client;

window.umbradbEngine = {
  client,
  tabs,
  /** This tab's engine worker while it leads. */
  get worker() {
    return tabs.worker();
  },
  restarts: () => supervised?.restarts() ?? [],
  loadedAt,
  persistence,
  snapshots: {
    save: saveSnapshotFile,
    list: () => publishedSnapshots(location.href),
    published: (name) => fetchPublishedSnapshot(name, location.href),
  },
};
// The explorer is shown while its tab's panel is (`shell.ts`); a page without the tabs always shows it.
window.umbradbExplorerHost = engineExplorerHost(client, () => document.getElementById("tab-panel-tokens")?.hidden !== true);

// Leave at once when the page goes away (a follower takes over sooner); a page restored from the back/forward cache
// joins again from scratch.
addEventListener("pagehide", () => tabs.close());
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
