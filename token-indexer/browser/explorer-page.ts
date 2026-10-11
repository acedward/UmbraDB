/**
 * The main page of the static build (`index.html`): the indexer, with its header tabs (`shell.ts`) — the **Overview**
 * (the indexer section with its controls, `engine-panel.ts`, and the Modules section, `modules-view.ts`), the **Token
 * Indexer** tab (the MIP-0018 token explorer, `../mip0018/ui/page.js`, the same script `GET /ui` serves, reading the API
 * through the browser engine), the **JSON RPC** tab (`jsonrpc-view.ts`), the **Database** tab (`database-view.ts`) and
 * a link to the system status page. The
 * order of the imports is the order they run: the engine connection and the explorer's host first
 * (`explorer-host.ts`), then the explorer script, which reads the host when it starts, then the rest of the page.
 *
 * For scripted use (the browser tests read it), `window.umbradbOverview` holds the overview's last sources, the tabs, the
 * Database tab's last answers and the JSON RPC tab's last call, beside `window.umbradbEngine` (`explorer-host.ts`).
 */
import { client, persistence, tabs } from "./explorer-host.ts";
import "../mip0018/ui/page.js";
import { type DatabaseView, mountDatabaseView } from "./database-view.ts";
import { type JsonRpcCall, mountJsonRpcView } from "./jsonrpc-view.ts";
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
      /** The JSON RPC tab: how many calls it has made, and the last one. */
      jsonrpc(): { calls: number; latest: JsonRpcCall | null };
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
    shell?.setAvailable("tokens", view.tokenIndexer);
    shell?.setAvailable("jsonrpc", view.jsonRpc);
  },
});
modules = mountModulesView({
  client,
  parent: byId("overview"),
  onSwitched: (module, status) => {
    shell?.setAvailable(module === "jsonrpc" ? "jsonrpc" : "tokens", status.settings?.modules?.[module] ?? true);
    void panel.refresh();
  },
});
const database = mountDatabaseView({ client, parent: byId("database") });
const jsonrpc = mountJsonRpcView({ client, parent: byId("jsonrpc") });
shell = mountShell({
  onShow: (tab, previous) => {
    panel.watch(tab === "overview");
    if (tab === "database") database.shown();
    // The explorer skipped its periodic refresh while hidden: it reads the engine again when shown.
    if (tab === "tokens" && previous !== null) document.getElementById("now")?.click();
  },
});

window.umbradbOverview = { inputs: () => panel.inputs(), shell, database: () => database.latest(), jsonrpc: () => ({ calls: jsonrpc.calls(), latest: jsonrpc.latest() }) };
