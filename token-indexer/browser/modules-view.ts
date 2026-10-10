/**
 * The Modules section at the bottom of the overview (static build, `index.html`): one row per module of the indexer
 * (`modules.ts`), with its name, its one-line description and an on/off checkbox. Token Indexer (MIP-0018) is the one
 * this build has: its checkbox is the engine's `module` switch (off, the MIP-0018 scan stops at a block boundary while
 * the chain archive keeps syncing, and its tab is hidden; on, the scan continues from its cursor), and it shows the
 * engine's saved choice. Every other module is planned: unchecked, disabled and marked "planned".
 *
 * Text is drawn as text nodes; a refusal from the engine is drawn with the explorer's hidden-character rules
 * (`visible-text.ts`).
 */
import type { EngineClient } from "./client.ts";
import { messageOf } from "./engine-panel.ts";
import { INDEXER_MODULES } from "./modules.ts";
import type { PanelView } from "./panel-model.ts";
import type { HostStatus } from "./protocol.ts";
import { dataNode } from "./visible-text.ts";

export interface ModulesViewOptions {
  client: EngineClient;
  /** The section is appended to this element. */
  parent: Element;
  /** Called with the engine's status after the token indexer was switched. */
  onSwitched?: (status: HostStatus) => void;
}

export interface ModulesView {
  readonly element: HTMLElement;
  /** Draws the token indexer's state from the overview's view. */
  update(view: PanelView): void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
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
  let toggle: HTMLInputElement | null = null;
  let tokenState: HTMLElement | null = null;
  let tokenRow: HTMLTableRowElement | null = null;
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
    tr.append(cell, nameCell, node("td", "wide note", m.description), stateCell);
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
      toggle = box;
      tokenState = state;
      tokenRow = tr;
    }
    body.append(tr);
  }
  root.append(table);
  const message = node("div", "note");
  message.setAttribute("data-field", "modules-message");
  message.setAttribute("role", "status");
  root.append(message);
  opts.parent.append(root);

  let busy = false;
  let ready = false;
  const say = (text: string): void => {
    message.replaceChildren(dataNode(document, text));
  };
  const drawOn = (on: boolean): void => {
    if (toggle === null || tokenState === null || tokenRow === null) return;
    toggle.checked = on;
    tokenRow.setAttribute("data-state", on ? "on" : "off");
    tokenState.textContent = on ? "on" : "off";
    tokenState.classList.toggle("ok", on);
    tokenState.classList.toggle("warn", !on);
  };

  toggle?.addEventListener("change", () => {
    const box = toggle!;
    const enabled = box.checked;
    busy = true;
    box.disabled = true;
    say(enabled ? "switching the token indexer on…" : "switching the token indexer off: the scan stops after its block in flight…");
    opts.client.request("module", { module: "token-indexer", enabled }).then(
      (status) => {
        drawOn(status.settings?.modules?.["token-indexer"] ?? true);
        say(enabled
          ? "the token indexer is on: the scan continues from its cursor"
          : "the token indexer is off: the scan stopped at a block boundary; the chain archive keeps syncing");
        opts.onSwitched?.(status);
      },
      (e: unknown) => {
        drawOn(!enabled);
        say(`the token indexer was not switched · ${messageOf(e)}`);
      },
    ).finally(() => {
      busy = false;
      box.disabled = !ready;
    });
  });

  return {
    element: root,
    update(view: PanelView): void {
      ready = view.ready;
      if (toggle === null || busy) return;
      toggle.disabled = !ready;
      drawOn(view.tokenIndexer);
    },
  };
}
