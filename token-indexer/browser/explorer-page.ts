/**
 * The main page of the static build (`index.html`): the indexer, with its header tabs (`shell.ts`) — the **Overview**
 * (the indexer section with its controls, `engine-panel.ts`, and the Modules section, `modules-view.ts`), the **Token
 * Indexer** tab (the MIP-0018 token explorer, `../mip0018/ui/page.js`, the same script `GET /ui` serves, reading the API
 * through the browser engine), the **Database** tab (`database-view.ts`) and a link to the system status page. The
 * order of the imports is the order they run: the engine connection and the explorer's host first
 * (`explorer-host.ts`), then the explorer script, which reads the host when it starts, then the rest of the page.
 *
 * For scripted use (the browser tests read it), `window.umbradbOverview` holds the overview's last sources, the tabs and
 * the Database tab's last answers, beside `window.umbradbEngine` (`explorer-host.ts`).
 */
import { client, persistence, tabs } from "./explorer-host.ts";
import "../mip0018/ui/page.js";
import { type DatabaseView, mountDatabaseView } from "./database-view.ts";
import { mountEnginePanel } from "./engine-panel.ts";
import { mountModulesView, type ModulesView } from "./modules-view.ts";
import type { PanelInputs } from "./panel-model.ts";
import { mountShell, type Shell } from "./shell.ts";

declare global {
  interface Window {
    umbradbOverview?: {
      /** The sources the overview drew last. */
      inputs(): PanelInputs | null;
      shell: Shell;
      database(): ReturnType<DatabaseView["latest"]>;
    };
  }
}

function byId(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`the page has no #${id}`);
  return n;
}

let modules: ModulesView | undefined;
let shell: Shell | undefined;
const panel = mountEnginePanel({
  client,
  tabs,
  parent: byId("overview"),
  persistence,
  onView: (view) => {
    modules?.update(view);
    shell?.setTokensAvailable(view.tokenIndexer);
  },
});
modules = mountModulesView({
  client,
  parent: byId("overview"),
  onSwitched: (status) => {
    shell?.setTokensAvailable(status.settings?.modules?.["token-indexer"] ?? true);
    void panel.refresh();
  },
});
const database = mountDatabaseView({ client, parent: byId("database") });
shell = mountShell({
  onShow: (tab, previous) => {
    panel.watch(tab === "overview");
    if (tab === "database") database.shown();
    // The explorer skipped its periodic refresh while hidden: it reads the engine again when shown.
    if (tab === "tokens" && previous !== null) document.getElementById("now")?.click();
  },
});

window.umbradbOverview = { inputs: () => panel.inputs(), shell, database: () => database.latest() };
