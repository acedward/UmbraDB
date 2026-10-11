/**
 * The Modules section at the bottom of the overview (static build, `index.html`): one row per module of the indexer
 * (`modules.ts`), with its name, its one-line description (and what the build has of it now) and an on/off checkbox.
 * Two modules are available, each checkbox the engine's `module` switch showing the engine's saved choice: Token
 * Indexer (MIP-0018; off, the MIP-0018 scan stops at a block boundary while the chain archive keeps syncing, and its tab
 * is hidden; on, the scan continues from its cursor) and JSON RPC (off, its tab is hidden and its requests are refused;
 * on, its tab calls its methods). Every other module is planned: unchecked, disabled and marked "planned".
 *
 * Text is drawn as text nodes; a refusal from the engine is drawn with the explorer's hidden-character rules
 * (`visible-text.ts`).
 */
import type { EngineClient } from "./client.ts";
import { messageOf } from "./engine-panel.ts";
import { INDEXER_MODULES } from "./modules.ts";
import type { PanelView } from "./panel-model.ts";
import type { HostStatus, ModuleId } from "./protocol.ts";
import { dataNode } from "./visible-text.ts";

export interface ModulesViewOptions {
  client: EngineClient;
  /** The section is appended to this element. */
  parent: Element;
  /** Called with the module and the engine's status after a module was switched. */
  onSwitched?: (module: ModuleId, status: HostStatus) => void;
}

export interface ModulesView {
  readonly element: HTMLElement;
  /** Draws the available modules' states from the overview's view. */
  update(view: PanelView): void;
}

/** What the section says while a module is switched, once it is, and when it was not. */
const SAYS: Record<ModuleId, { switching: Record<"on" | "off", string>; done: Record<"on" | "off", string>; failed: string }> = {
  "token-indexer": {
    switching: { on: "switching the token indexer on…", off: "switching the token indexer off: the scan stops after its block in flight…" },
    done: {
      on: "the token indexer is on: the scan continues from its cursor",
      off: "the token indexer is off: the scan stopped at a block boundary; the chain archive keeps syncing",
    },
    failed: "the token indexer was not switched",
  },
  jsonrpc: {
    switching: { on: "switching the JSON RPC module on…", off: "switching the JSON RPC module off…" },
    done: {
      on: "the JSON RPC module is on: its tab calls its methods",
      off: "the JSON RPC module is off: its tab is hidden and its requests are refused",
    },
    failed: "the JSON RPC module was not switched",
  },
};

/** A module's state in the overview's view. */
const isOn = (view: PanelView, module: ModuleId): boolean => (module === "jsonrpc" ? view.jsonRpc : view.tokenIndexer);

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

interface Toggle {
  module: ModuleId;
  box: HTMLInputElement;
  state: HTMLElement;
  row: HTMLTableRowElement;
  busy: boolean;
}

export function mountModulesView(opts: ModulesViewOptions): ModulesView {
  const root = node("section", "modules");
  root.id = "modules";
  root.setAttribute("aria-label", "modules");
  const head = node("div", "row head");
  head.append(node("h2", undefined, "modules"));
  head.append(node("span", "note", "the indexer's modules: what it indexes beyond the chain archive"));
  root.append(head);

  const table = node("table");
  table.setAttribute("data-field", "modules");
  const body = table.appendChild(node("tbody"));
  const toggles: Toggle[] = [];
  for (const m of INDEXER_MODULES) {
    const tr = node("tr");
    tr.setAttribute("data-module", m.id);
    const box = node("input");
    box.type = "checkbox";
    box.id = `module-${m.id}`;
    box.setAttribute("data-module-toggle", m.id);
    const cell = node("td", "toggle");
    cell.append(box);
    const name = node("label", "name", m.name);
    name.htmlFor = box.id;
    const nameCell = node("td");
    nameCell.append(name);
    const state = node("span", "chip");
    state.setAttribute("data-field", "module-state");
    const stateCell = node("td");
    stateCell.append(state);
    const descriptionCell = node("td", "wide note");
    const description = node("span", undefined, m.description);
    description.setAttribute("data-field", "module-description");
    descriptionCell.append(description);
    if (m.now !== undefined) {
      const now = node("div", "now", m.now);
      now.setAttribute("data-field", "module-now");
      descriptionCell.append(now);
    }
    tr.append(cell, nameCell, descriptionCell, stateCell);
    if (m.engineModule === null) {
      box.checked = false;
      box.disabled = true;
      tr.setAttribute("data-state", "planned");
      state.textContent = "planned";
    } else {
      // Until the engine has answered, the switch waits (the saved choice is not known yet).
      box.checked = true;
      box.disabled = true;
      tr.setAttribute("data-state", "on");
      state.textContent = "on";
      state.classList.add("ok");
      toggles.push({ module: m.engineModule, box, state, row: tr, busy: false });
    }
    body.append(tr);
  }
  root.append(table);
  const message = node("div", "note");
  message.setAttribute("data-field", "modules-message");
  message.setAttribute("role", "status");
  root.append(message);
  opts.parent.append(root);

  let ready = false;
  const say = (text: string): void => {
    message.replaceChildren(dataNode(document, text));
  };
  const drawOn = (t: Toggle, on: boolean): void => {
    t.box.checked = on;
    t.row.setAttribute("data-state", on ? "on" : "off");
    t.state.textContent = on ? "on" : "off";
    t.state.classList.toggle("ok", on);
    t.state.classList.toggle("warn", !on);
  };

  for (const t of toggles) {
    const says = SAYS[t.module];
    t.box.addEventListener("change", () => {
      const enabled = t.box.checked;
      t.busy = true;
      t.box.disabled = true;
      say(says.switching[enabled ? "on" : "off"]);
      opts.client.request("module", { module: t.module, enabled }).then(
        (status) => {
          drawOn(t, status.settings?.modules?.[t.module] ?? true);
          say(says.done[enabled ? "on" : "off"]);
          opts.onSwitched?.(t.module, status);
        },
        (e: unknown) => {
          drawOn(t, !enabled);
          say(`${says.failed} · ${messageOf(e)}`);
        },
      ).finally(() => {
        t.busy = false;
        t.box.disabled = !ready;
      });
    });
  }

  return {
    element: root,
    update(view: PanelView): void {
      ready = view.ready;
      for (const t of toggles) {
        if (t.busy) continue;
        t.box.disabled = !ready;
        drawOn(t, isOn(view, t.module));
      }
    },
  };
}
