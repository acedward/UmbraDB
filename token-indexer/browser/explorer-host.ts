/**
 * The explorer page's connection to the browser engine, made before the explorer script runs (`explorer-page.ts`
 * imports this module first): the page joins the other tabs of the store (`tabs.ts`: the leader tab runs the engine
 * worker and starts or resumes it, the others proxy to it), asks the browser to keep the site's storage
 * (`requestPersistentStorage`, from every tab), installs `window.umbradbExplorerHost` (`explorer-transport.ts`: the
 * explorer's API reads go to the engine) and exposes the client as `window.umbradbEngine`, as the engine page does, for
 * scripted use (the browser tests drive the engine through it).
 */
import { requestPersistentStorage } from "./client.ts";
import { engineExplorerHost, type ExplorerHost } from "./explorer-transport.ts";
import { connectEngineTabs } from "./tabs.ts";

declare global {
  interface Window {
    umbradbExplorerHost?: ExplorerHost;
  }
}

const loadedAt = performance.now();
const persistence = requestPersistentStorage();
export const tabs = connectEngineTabs();
export const client = tabs.client;

window.umbradbEngine = {
  client,
  tabs,
  /** This tab's engine worker while it leads. */
  get worker() {
    return tabs.worker();
  },
  loadedAt,
  persistence,
};
window.umbradbExplorerHost = engineExplorerHost(client);

// Leave at once when the page goes away (a follower takes over sooner); a page restored from the back/forward cache
// joins again from scratch.
addEventListener("pagehide", () => tabs.close());
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
