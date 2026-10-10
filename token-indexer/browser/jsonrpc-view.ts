/**
 * The JSON RPC tab of the static build (`index.html`): the EVM JSON-RPC module's methods (`jsonrpc-model.ts`), each
 * with the source of its answer, its state, an editable example of its parameters and a Call button, and the answers,
 * through the engine (`jsonrpc` of `protocol.ts`: one JSON-RPC 2.0 request per message, answered by the module's
 * handler inside the worker as Node's `npm run evm-rpc` answers it).
 *
 * - A note says what the tab calls and that external wallets cannot connect to a page; a legend explains the sources.
 * - A Node-only method is marked "served by Node only" and has no parameters and no Call button.
 * - A call shows, in a row under its method: the request as sent (JSON, indented) and the answer: its HTTP status and
 *   its body (JSON, indented), or why there is none (parameters that are not JSON, a refusal from the engine, such as
 *   the module switched off).
 *
 * Every name, request and answer is drawn with the explorer's hidden-character rules (`visible-text.ts`), as text
 * nodes; nothing is parsed as markup and no `style` attribute is set.
 */
import type { EngineClient } from "./client.ts";
import { messageOf } from "./engine-panel.ts";
import { answerText, buildRequest, JSONRPC_TAB_NOTE, type MethodRow, methodRows, SOURCE_LEGEND } from "./jsonrpc-model.ts";
import type { ApiResult } from "./protocol.ts";
import { dataNode } from "./visible-text.ts";

export interface JsonRpcViewOptions {
  client: EngineClient;
  /** The view is appended to this element. */
  parent: Element;
}

/** The last call: its method, the body sent (`null` when none was sent), whether its answer is awaited, the answer,
 *  and the error shown instead of one. */
export interface JsonRpcCall {
  method: string;
  body: string | null;
  pending: boolean;
  answer: ApiResult | null;
  error: string | null;
}

export interface JsonRpcView {
  readonly element: HTMLElement;
  /** The rows listed. */
  readonly rows: readonly MethodRow[];
  /** How many times Call was used (for scripted checks). */
  calls(): number;
  /** The last call (for scripted checks). */
  latest(): JsonRpcCall | null;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** A cell holding `text` as data. */
function dataCell(text: string, field: string, cls?: string): HTMLTableCellElement {
  const td = node("td", cls);
  td.setAttribute("data-field", field);
  td.append(dataNode(document, text));
  return td;
}

/** A `pre` holding `text` as data. Indented JSON (`json`) is drawn line by line: its line breaks are the indentation's
 *  (JSON writes one inside a value as `\n`), so they stay line breaks; any other line break is data and is marked. */
function dataPre(text: string, field: string, json: boolean): HTMLPreElement {
  const pre = node("pre");
  pre.setAttribute("data-field", field);
  if (!json) {
    pre.append(dataNode(document, text));
    return pre;
  }
  text.split("\n").forEach((line, i) => {
    if (i > 0) pre.append(document.createTextNode("\n"));
    pre.append(dataNode(document, line));
  });
  return pre;
}

export function mountJsonRpcView(opts: JsonRpcViewOptions): JsonRpcView {
  const rows = methodRows();
  const root = node("section", "jsonrpc-view");
  root.id = "jsonrpc-view";
  root.setAttribute("aria-label", "JSON RPC");
  const head = node("div", "row head");
  head.append(node("h2", undefined, "JSON RPC"));
  const counts = node("span", "note");
  counts.setAttribute("data-field", "jsonrpc-counts");
  const served = rows.filter((r) => r.kind === "served").length;
  const stubs = rows.filter((r) => r.kind === "not-implemented").length;
  const nodeOnly = rows.filter((r) => r.kind === "node-only").length;
  counts.textContent = `${rows.length} methods: ${served} served here, ${stubs} not implemented (-32004), ${nodeOnly} served by Node only`;
  head.append(counts);
  root.append(head);
  const note = node("p", "note", JSONRPC_TAB_NOTE);
  note.setAttribute("data-field", "jsonrpc-note");
  const legend = node("p", "note", SOURCE_LEGEND);
  legend.setAttribute("data-field", "jsonrpc-legend");
  root.append(note, legend);

  const table = node("table", "methods");
  table.setAttribute("data-field", "jsonrpc-methods");
  const headRow = node("tr");
  for (const c of ["method", "source", "state", "parameters", ""]) headRow.append(node("th", undefined, c));
  table.appendChild(node("thead")).append(headRow);
  const body = table.appendChild(node("tbody"));
  root.append(table);
  opts.parent.append(root);

  let nextId = 1;
  let calls = 0;
  let last: JsonRpcCall | null = null;
  /** The row under the method last called, holding its request and answer. */
  const output = node("tr", "output");
  output.setAttribute("data-field", "jsonrpc-output");
  const outputCell = node("td");
  outputCell.colSpan = 5;
  output.append(outputCell);

  function show(after: HTMLTableRowElement, call: JsonRpcCall, requestText: string | null): void {
    last = call;
    const parts: HTMLElement[] = [];
    const title = node("div", "note");
    title.setAttribute("data-field", "jsonrpc-output-method");
    title.append(dataNode(document, call.method));
    parts.push(title);
    if (requestText !== null) {
      parts.push(node("h3", undefined, "request"), dataPre(requestText, "jsonrpc-request", true));
    }
    if (call.answer !== null) {
      const shown = answerText(call.answer);
      const status = node("h3", undefined, "answer · ");
      const s = node("span");
      s.setAttribute("data-field", "jsonrpc-status");
      s.append(dataNode(document, shown.status));
      status.append(s);
      parts.push(status, dataPre(shown.text, "jsonrpc-answer", shown.json));
    }
    if (call.pending) {
      const waiting = node("div", "note", "calling…");
      waiting.setAttribute("data-field", "jsonrpc-pending");
      parts.push(waiting);
    }
    if (call.error !== null) {
      const error = node("div", "note bad");
      error.setAttribute("data-field", "jsonrpc-error");
      error.setAttribute("role", "status");
      error.append(dataNode(document, call.error));
      parts.push(error);
    }
    outputCell.replaceChildren(...parts);
    after.after(output);
  }

  for (const row of rows) {
    const tr = node("tr");
    tr.setAttribute("data-method", row.method);
    tr.setAttribute("data-kind", row.kind);
    tr.append(dataCell(row.method, "jsonrpc-method", "name"), dataCell(row.source, "jsonrpc-source"));
    const state = dataCell(row.state, "jsonrpc-state");
    if (row.note !== null) {
      const n = node("div", "note");
      n.setAttribute("data-field", "jsonrpc-method-note");
      n.append(dataNode(document, row.note));
      state.append(n);
    }
    tr.append(state);
    const paramsCell = node("td", "params");
    const actionCell = node("td", "action");
    if (row.callable) {
      const params = node("textarea");
      params.value = row.params;
      params.rows = Math.min(4, Math.max(1, Math.ceil(row.params.length / 44)));
      params.spellcheck = false;
      params.setAttribute("aria-label", `${row.method} parameters`);
      params.setAttribute("data-input", "jsonrpc-params");
      paramsCell.append(params);
      const call = node("button", "mini", "Call");
      call.type = "button";
      call.setAttribute("data-action", "jsonrpc-call");
      actionCell.append(call);
      call.addEventListener("click", () => {
        calls++;
        const built = buildRequest(nextId++, row.method, params.value);
        if (!built.ok) {
          show(tr, { method: row.method, body: null, pending: false, answer: null, error: built.error }, null);
          return;
        }
        call.disabled = true;
        show(tr, { method: row.method, body: built.body, pending: true, answer: null, error: null }, built.text);
        opts.client.request("jsonrpc", { body: built.body }).then(
          (answer) => show(tr, { method: row.method, body: built.body, pending: false, answer, error: null }, built.text),
          (e: unknown) => show(tr, { method: row.method, body: built.body, pending: false, answer: null, error: `no answer · ${messageOf(e)}` }, built.text),
        ).finally(() => {
          call.disabled = false;
        });
      });
    } else {
      paramsCell.append(dataNode(document, "—"));
      const mark = node("span", "chip", "Node only");
      mark.setAttribute("data-field", "jsonrpc-node-only");
      actionCell.append(mark);
    }
    tr.append(paramsCell, actionCell);
    body.append(tr);
  }

  return {
    element: root,
    rows,
    calls: () => calls,
    latest: () => (last === null ? null : { ...last, answer: last.answer === null ? null : { ...last.answer, headers: { ...last.answer.headers } } }),
  };
}
