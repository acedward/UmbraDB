/**
 * The JSON RPC tab of the static build (`index.html`): a module page (`module-page.ts`, the token explorer's structure)
 * titled "JSON-RPC explorer", with two views, each in the URL's query (`rpc=methods|status`, `jsonrpc-model.ts`):
 *
 * - **methods** — on the left, the module's methods (`jsonrpc-model.ts` `methodRows`) with a search, grouped by where
 *   their answer comes from; on the right, the chosen method (also in the URL, `rpc-method`): its name, source and
 *   summary, a form with one typed field per parameter (each checked as it is typed) or its parameters as JSON, the
 *   JSON-RPC request it makes (live), Call, and copy as JSON or as a `curl` command for Node's `npm run evm-rpc`; the
 *   answer as a tree (quantities with their decimal value; block numbers, block hashes and transaction hashes open the
 *   call that reads them) or as text, with the time it took. Below, the history of the page's calls, each run again in
 *   one click. A Node-only method is listed and described, never called. The list is used with the keyboard (the arrow
 *   keys, Home, End, Escape back to the search; Ctrl+Enter calls); on a narrow screen it is above the form.
 * - **status** — the module's state, each figure from the engine's `jsonrpc-state` answer: on or off, its database,
 *   its methods, the chain ID, the client version, the indexer, the calls answered, in flight and refused, the pacing
 *   queue of the indexer's origin, the last error. The strip shows the switch, the calls and the queue on every view;
 *   both are read again every 5 s while the tab is shown, after each call, and by the refresh button.
 *
 * Calls go through the engine (`jsonrpc` of `protocol.ts`: one JSON-RPC 2.0 request per message, answered by the
 * module's handler inside the worker as Node's `npm run evm-rpc` answers it). Every name, request and answer is drawn
 * with the explorer's hidden-character rules (`visible-text.ts`), as text nodes; nothing is parsed as markup and no
 * `style` attribute is set.
 */
import type { EngineClient } from "./client.ts";
import { messageOf } from "./engine-panel.ts";
import {
  answerText,
  answerTree,
  BLOCK_TAGS,
  type BuiltRequest,
  buildRequest,
  curlCommand,
  type FieldValue,
  fieldsFromParams,
  filterRows,
  HISTORY_KEY,
  type HistoryEntry,
  JSONRPC_SUBTITLE,
  JSONRPC_TAB_NOTE,
  JSONRPC_TITLE,
  KIND_HINTS,
  METHOD_GROUPS,
  type MethodRow,
  methodRows,
  NODE_EVM_RPC_URL,
  outcomeOf,
  paramsFromFields,
  paramsOfText,
  parseHistory,
  requestFor,
  type RpcView,
  rpcRouteOf,
  shownText,
  SOURCE_LEGEND,
  statusFigures,
  stripParts,
  type TreeNode,
  urlWithRpcRoute,
  withHistory,
} from "./jsonrpc-model.ts";
import { mountModulePage } from "./module-page.ts";
import type { ApiResult, JsonRpcStateResult } from "./protocol.ts";
import { urlWithTab } from "./shell.ts";
import { dataNode } from "./visible-text.ts";

export interface JsonRpcViewOptions {
  client: EngineClient;
  /** The tab's panel: the page is appended to it. */
  parent: HTMLElement;
  /** Where the history is kept; default the tab's `sessionStorage` when the browser lets the page use it. */
  storage?: Storage | null;
}

/** A call: its number, its method, the body sent, whether its answer is awaited, the answer or the error shown
 *  instead, and how long it took (ms). */
export interface JsonRpcCall {
  seq: number;
  method: string;
  body: string;
  pending: boolean;
  answer: ApiResult | null;
  error: string | null;
  ms: number | null;
}

/** The tab as shown now (for scripted checks). */
export interface JsonRpcViewState {
  view: RpcView;
  method: string;
  mode: "form" | "raw";
  /** The request the chosen method's editor makes now (`null` while it holds an error), and that error. */
  preview: string | null;
  requestError: string | null;
  /** The id the next call gets. */
  nextId: number;
  /** The last text put on the clipboard. */
  copied: string | null;
  history: HistoryEntry[];
  /** Whether the history is kept in `sessionStorage` (else in memory). */
  stored: boolean;
  /** The module's state last read, and the error of the last read. */
  status: JsonRpcStateResult | null;
  statusError: string | null;
  /** Each method's last call. */
  byMethod: Record<string, JsonRpcCall>;
}

export interface JsonRpcView {
  /** The methods listed. */
  readonly rows: readonly MethodRow[];
  /** The tab is shown (its state read now and every 5 s) or hidden (not read). */
  shown(on: boolean): void;
  /** How many calls the tab has made. */
  calls(): number;
  /** The last call made, as shown now. */
  latest(): JsonRpcCall | null;
  state(): JsonRpcViewState;
}

/** How often the module's state is read while the tab is shown. */
const STATE_EVERY_MS = 5_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function field<E extends HTMLElement>(e: E, name: string): E {
  e.setAttribute("data-field", name);
  return e;
}

function button(text: string, action: string, cls?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.setAttribute("data-action", action);
  return b;
}

/** Indented JSON as text nodes, line by line: its line breaks are the indentation's (JSON writes one inside a value as
 *  `\n`), so they stay line breaks; every line is data. */
function jsonLines(text: string): Node[] {
  const out: Node[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) out.push(document.createTextNode("\n"));
    out.push(dataNode(document, line));
  });
  return out;
}

/** A `pre` holding `text` as data. Indented JSON (`json`) is drawn line by line: its line breaks are the indentation's
 *  (JSON writes one inside a value as `\n`), so they stay line breaks; any other line break is data and is marked. */
function dataPre(text: string, name: string, json: boolean): HTMLPreElement {
  const pre = field(el("pre"), name);
  pre.append(...(json ? jsonLines(text) : [dataNode(document, text)]));
  return pre;
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const clock = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

export function mountJsonRpcView(opts: JsonRpcViewOptions): JsonRpcView {
  const rows = methodRows();
  const rowOf = new Map(rows.map((r) => [r.method, r]));
  const known = new Set(rows.filter((r) => r.callable).map((r) => r.method));
  const storage = opts.storage === undefined ? sessionStore() : opts.storage;

  const initial = rpcRouteOf(location.search);
  let view: RpcView = initial.view;
  let selected: MethodRow = (initial.method !== null ? rowOf.get(initial.method) : undefined) ?? rows[0]!;
  let mode: "form" | "raw" = "form";
  let answerMode: "tree" | "text" = "tree";
  /** Each method's editor: its fields and its JSON text. */
  const drafts = new Map<string, { fields: FieldValue[]; raw: string; note: string | null }>();
  const draftOf = (r: MethodRow) => {
    let d = drafts.get(r.method);
    if (d === undefined) {
      d = { fields: fieldsFromParams(r.paramSpecs, r.example), raw: r.params, note: null };
      drafts.set(r.method, d);
    }
    return d;
  };
  let nextId = 1;
  let calls = 0;
  let lastMade = 0;
  let last: JsonRpcCall | null = null;
  const byMethod = new Map<string, JsonRpcCall>();
  let copied: string | null = null;
  let callHistory: HistoryEntry[] = [];
  let stored = storage !== null;
  try {
    callHistory = parseHistory(storage?.getItem(HISTORY_KEY) ?? null, known);
  } catch {
    stored = false;
  }
  let status: JsonRpcStateResult | null = null;
  let statusError: string | null = null;
  let statusReading = false;
  let shownNow = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** A sub-tab's link: this URL with the tab, the view and the method it names (a method is named once chosen). */
  const routeHref = (v: string): string => urlWithRpcRoute(urlWithTab(location.href, "jsonrpc"), { view: v as RpcView, method: rpcRouteOf(location.search).method });
  const page = mountModulePage({
    parent: opts.parent,
    idPrefix: "rpc",
    title: JSONRPC_TITLE,
    subtitle: JSONRPC_SUBTITLE,
    views: [
      { id: "methods", label: "methods", href: "?tab=jsonrpc&rpc=methods" },
      { id: "status", label: "status", href: "?tab=jsonrpc&rpc=status" },
    ],
    footer: JSONRPC_TAB_NOTE,
    onView: (v) => {
      pushRoute(v as RpcView);
      showView(v as RpcView);
    },
    onRefresh: () => void readState(),
  });

  // ── The methods view ───────────────────────────────────────────────────────────────────────────────────────────────
  const explorer = field(el("div", "rpc-explorer"), "rpc-methods-view");
  const list = explorer.appendChild(el("nav", "rpc-list"));
  list.setAttribute("aria-label", "methods");
  const search = list.appendChild(el("input"));
  search.type = "search";
  search.id = "rpc-search";
  search.placeholder = "search methods";
  search.setAttribute("aria-label", "search methods");
  search.autocomplete = "off";
  search.spellcheck = false;
  const count = list.appendChild(field(el("div", "note"), "rpc-list-count"));
  const groups = list.appendChild(el("div", "rpc-groups"));
  const links = new Map<string, HTMLAnchorElement>();
  const groupEls = new Map<string, { box: HTMLElement; count: HTMLElement }>();
  for (const g of METHOD_GROUPS) {
    const members = rows.filter((r) => r.group === g.id);
    if (members.length === 0) continue;
    const box = groups.appendChild(el("div", "rpc-group"));
    box.setAttribute("data-group", g.id);
    const h = box.appendChild(el("h2", undefined, g.label));
    const c = h.appendChild(field(el("span", "note"), "rpc-group-count"));
    groupEls.set(g.id, { box, count: c });
    const ul = box.appendChild(el("ul"));
    for (const r of members) {
      const a = el("a", "rpc-method");
      a.append(dataNode(document, r.method));
      a.href = urlWithRpcRoute(urlWithTab(location.href, "jsonrpc"), { view: "methods", method: r.method });
      a.setAttribute("data-method", r.method);
      a.setAttribute("data-kind", r.kind);
      a.tabIndex = -1;
      a.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        select(r.method, true);
      });
      a.addEventListener("keydown", (event) => onListKey(event, r.method));
      links.set(r.method, a);
      ul.appendChild(el("li")).append(a);
    }
  }
  list.append(field(el("p", "note", SOURCE_LEGEND), "rpc-legend"));
  const detail = explorer.appendChild(field(el("section", "rpc-detail"), "rpc-detail"));
  const historyBox = field(el("section", "rpc-history"), "rpc-history");
  // ── The status view ────────────────────────────────────────────────────────────────────────────────────────────────
  const statusBox = field(el("section", "rpc-status"), "rpc-status-view");
  page.main.append(explorer, historyBox, statusBox);

  function visibleMethods(): string[] {
    return [...links].filter(([, a]) => !a.parentElement!.hidden).map(([m]) => m);
  }

  function applySearch(): void {
    const shown = new Set(filterRows(rows, search.value).map((r) => r.method));
    for (const [m, a] of links) a.parentElement!.hidden = !shown.has(m);
    for (const g of METHOD_GROUPS) {
      const e = groupEls.get(g.id);
      if (e === undefined) continue;
      const n = rows.filter((r) => r.group === g.id && shown.has(r.method)).length;
      e.box.hidden = n === 0;
      e.count.textContent = ` ${n}`;
    }
    count.textContent = shown.size === rows.length ? `${rows.length} methods` : shown.size === 0 ? `no method matches (of ${rows.length})` : `${shown.size} of ${rows.length} methods`;
  }

  function onListKey(event: KeyboardEvent, method: string): void {
    const shown = visibleMethods();
    const at = shown.indexOf(method);
    let to: string | undefined;
    if (event.key === "ArrowDown") to = shown[Math.min(shown.length - 1, at + 1)];
    else if (event.key === "ArrowUp") to = at <= 0 ? undefined : shown[at - 1];
    else if (event.key === "Home") to = shown[0];
    else if (event.key === "End") to = shown[shown.length - 1];
    else if (event.key === "Escape") {
      event.preventDefault();
      search.focus();
      return;
    } else return;
    event.preventDefault();
    if (event.key === "ArrowUp" && at <= 0) {
      search.focus();
      return;
    }
    if (to !== undefined) {
      select(to, true);
      links.get(to)!.focus();
    }
  }

  search.addEventListener("input", applySearch);
  search.addEventListener("keydown", (event) => {
    const first = visibleMethods()[0];
    if (first === undefined) return;
    if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      const to = event.key === "Enter" || !visibleMethods().includes(selected.method) ? first : selected.method;
      select(to, true);
      links.get(to)!.focus();
    }
  });

  // ── The chosen method ──────────────────────────────────────────────────────────────────────────────────────────────
  let preview: { pre: HTMLElement; error: HTMLElement; curl: HTMLElement; call: HTMLButtonElement | null } | null = null;
  let answerBox: HTMLElement | null = null;
  let fieldErrors: HTMLElement[] = [];
  let controls: Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = [];

  /** The request the chosen method's editor makes now, with the id the next call gets. */
  function currentRequest(): BuiltRequest {
    const d = draftOf(selected);
    if (mode === "raw") return buildRequest(nextId, selected.method, d.raw);
    const r = paramsFromFields(selected.paramSpecs, d.fields);
    if (!r.ok) return { ok: false, error: `the form needs a fix: ${[...r.errors.filter((e) => e !== null), ...(r.error === undefined ? [] : [r.error])].join("; ")}` };
    return requestFor(nextId, selected.method, r.params);
  }

  function drawPreview(): void {
    if (preview === null) return;
    const built = currentRequest();
    if (mode === "form") {
      const r = paramsFromFields(selected.paramSpecs, draftOf(selected).fields);
      fieldErrors.forEach((e, i) => {
        const msg = r.ok ? null : r.errors[i] ?? null;
        e.replaceChildren(...(msg === null ? [] : [dataNode(document, msg)]));
        controls[i]?.setAttribute("aria-invalid", msg === null ? "false" : "true");
      });
    }
    preview.pre.replaceChildren(...(built.ok ? jsonLines(built.text) : []));
    preview.error.replaceChildren(...(built.ok ? [] : [dataNode(document, built.error)]));
    preview.curl.replaceChildren(...(built.ok ? [dataNode(document, shownText(curlCommand(built.body)))] : []));
    if (preview.call !== null) preview.call.disabled = !built.ok || byMethod.get(selected.method)?.pending === true;
  }

  function fieldControl(i: number): HTMLElement {
    const spec = selected.paramSpecs[i]!;
    const d = draftOf(selected);
    const v = d.fields[i]!;
    const box = el("div", "rpc-field");
    box.setAttribute("data-param", String(i));
    box.setAttribute("data-kind", spec.kind);
    const id = `rpc-param-${i}`;
    const label = box.appendChild(el("label", undefined, spec.name));
    label.htmlFor = id;
    if (spec.optional === true) label.append(el("span", "note", " (optional)"));
    const hint = box.appendChild(el("span", "note", ` ${KIND_HINTS[spec.kind]}`));
    hint.id = `${id}-hint`;
    const row = box.appendChild(el("div", "row"));
    let main: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (v.kind === "boolean") {
      const c = el("input");
      c.type = "checkbox";
      c.checked = v.checked;
      c.addEventListener("change", () => {
        d.fields[i] = { kind: "boolean", checked: c.checked };
        drawPreview();
      });
      main = c;
      row.append(c);
    } else if (v.kind === "block") {
      const s = el("select");
      const choices: Array<[string, string]> = BLOCK_TAGS.map((t) => [t, t]);
      choices.push(["number", "a block number"]);
      if (spec.kind === "blockRef") choices.push(["hash", "a block hash"]);
      if (spec.optional === true) choices.push(["omit", "left out"]);
      for (const [value, text] of choices) {
        const o = el("option", undefined, text);
        o.value = value;
        s.append(o);
      }
      s.value = v.choice;
      const num = el("input");
      num.type = "text";
      num.value = v.number;
      num.placeholder = "decimal, or 0x and hex digits";
      num.setAttribute("aria-label", `${spec.name}: block number`);
      num.setAttribute("data-input", "rpc-param-number");
      const hash = el("input");
      hash.type = "text";
      hash.value = v.hash;
      hash.placeholder = "0x and 64 hex digits";
      hash.setAttribute("aria-label", `${spec.name}: block hash`);
      hash.setAttribute("data-input", "rpc-param-hash");
      for (const t of [num, hash]) {
        t.spellcheck = false;
        t.autocomplete = "off";
      }
      const sync = (): void => {
        num.hidden = s.value !== "number";
        hash.hidden = s.value !== "hash";
        d.fields[i] = { kind: "block", choice: s.value as typeof v.choice, number: num.value, hash: hash.value };
        drawPreview();
      };
      s.addEventListener("change", sync);
      num.addEventListener("input", sync);
      hash.addEventListener("input", sync);
      num.hidden = v.choice !== "number";
      hash.hidden = v.choice !== "hash";
      main = s;
      row.append(s, num, hash);
    } else {
      const t = spec.kind === "object" ? el("textarea") : el("input");
      if (t instanceof HTMLInputElement) t.type = "text";
      else t.rows = 3;
      t.value = v.text;
      t.spellcheck = false;
      t.autocomplete = "off";
      t.addEventListener("input", () => {
        d.fields[i] = { kind: "text", text: t.value };
        drawPreview();
      });
      main = t;
      row.append(t);
    }
    main.id = id;
    main.setAttribute("data-input", main.getAttribute("data-input") ?? "rpc-param");
    const error = box.appendChild(field(el("div", "err"), "rpc-param-error"));
    error.id = `${id}-error`;
    main.setAttribute("aria-describedby", `${id}-hint ${id}-error`);
    fieldErrors[i] = error;
    controls[i] = main;
    return box;
  }

  function drawDetail(): void {
    const r = selected;
    preview = null;
    answerBox = null;
    fieldErrors = [];
    controls = [];
    const parts: Node[] = [];
    const title = el("div", "row rpc-title");
    const h = title.appendChild(field(el("h3"), "rpc-method-name"));
    h.append(dataNode(document, r.method));
    const source = title.appendChild(field(el("span", "chip"), "rpc-source"));
    source.append(dataNode(document, r.source));
    // The list's group, unless the source already says it.
    const group = METHOD_GROUPS.find((g) => g.id === r.group)!.label;
    if (group !== r.source) title.append(field(el("span", `chip rpc-kind-${r.kind}`, group), "rpc-group"));
    parts.push(title);
    const summary = field(el("p", "rpc-summary"), "rpc-summary");
    summary.append(dataNode(document, r.summary));
    parts.push(summary);
    if (r.note !== null) {
      const note = field(el("p", "note"), "rpc-method-note");
      note.append(dataNode(document, r.note));
      parts.push(note);
    }
    if (!r.callable) {
      parts.push(field(el("p", "rpc-node-only", "Served by Node only (npm run evm-rpc:all): this page lists it and never calls it."), "rpc-node-only"));
      detail.replaceChildren(...parts);
      return;
    }
    const d = draftOf(r);
    const modes = el("div", "row rpc-modes");
    modes.append(el("span", "note", "parameters"));
    const formBtn = modes.appendChild(button("form", "rpc-mode-form", "mini"));
    const rawBtn = modes.appendChild(button("JSON", "rpc-mode-raw", "mini"));
    formBtn.setAttribute("aria-pressed", String(mode === "form"));
    rawBtn.setAttribute("aria-pressed", String(mode === "raw"));
    formBtn.addEventListener("click", () => setMode("form"));
    rawBtn.addEventListener("click", () => setMode("raw"));
    parts.push(modes);
    if (d.note !== null) {
      const note = field(el("div", "note"), "rpc-mode-note");
      note.append(dataNode(document, d.note));
      parts.push(note);
    }
    if (mode === "form") {
      const form = field(el("form", "rpc-form"), "rpc-form");
      form.noValidate = true;
      form.addEventListener("submit", (event) => event.preventDefault());
      if (r.paramSpecs.length === 0) form.append(field(el("p", "note", "no parameters"), "rpc-no-params"));
      for (let i = 0; i < r.paramSpecs.length; i++) form.append(fieldControl(i));
      parts.push(form);
    } else {
      const raw = el("textarea", "rpc-raw");
      raw.value = d.raw;
      raw.rows = Math.min(10, Math.max(3, d.raw.split("\n").length));
      raw.spellcheck = false;
      raw.setAttribute("aria-label", `${r.method} parameters as JSON`);
      raw.setAttribute("data-input", "rpc-raw");
      raw.addEventListener("input", () => {
        d.raw = raw.value;
        drawPreview();
      });
      parts.push(raw);
    }
    parts.push(el("h2", "rpc-sub", "request"));
    const pre = field(el("pre", "rpc-preview"), "rpc-preview");
    pre.setAttribute("aria-live", "off");
    const error = field(el("div", "err"), "rpc-request-error");
    const actions = el("div", "row rpc-actions");
    const call = actions.appendChild(button("Call", "rpc-call", "now"));
    call.addEventListener("click", () => callNow());
    const copyJson = actions.appendChild(button("copy JSON", "rpc-copy-json"));
    const copyCurl = actions.appendChild(button("copy curl", "rpc-copy-curl"));
    const copiedNote = actions.appendChild(field(el("span", "note"), "rpc-copied"));
    actions.append(el("span", "note", "Ctrl+Enter calls"));
    const copy = (what: "json" | "curl"): void => {
      const built = currentRequest();
      if (!built.ok) return;
      putOnClipboard(what === "json" ? built.body : curlCommand(built.body), what === "json" ? "the request (JSON)" : "the curl command", copiedNote);
    };
    copyJson.addEventListener("click", () => copy("json"));
    copyCurl.addEventListener("click", () => copy("curl"));
    const curlBox = el("details", "rpc-curl");
    curlBox.append(el("summary", "note", `as curl, for Node's npm run evm-rpc at ${NODE_EVM_RPC_URL}`));
    const curl = curlBox.appendChild(field(el("pre"), "rpc-curl"));
    parts.push(pre, error, actions, curlBox);
    answerBox = field(el("div", "rpc-answer"), "rpc-answer-pane");
    parts.push(answerBox);
    detail.replaceChildren(...parts);
    preview = { pre, error, curl, call };
    drawPreview();
    drawAnswer();
  }

  function setMode(to: "form" | "raw"): void {
    if (to === mode) return;
    const r = selected;
    const d = draftOf(r);
    d.note = null;
    if (to === "raw") {
      const p = paramsFromFields(r.paramSpecs, d.fields);
      if (p.ok) d.raw = JSON.stringify(p.params);
    } else {
      // The JSON text's own check first: what the tab could not send never reaches the form.
      const read = paramsOfText(d.raw);
      if (!read.ok) d.note = `the JSON cannot be put in the form: ${read.error}`;
      else if (Array.isArray(read.params) && read.params.length <= r.paramSpecs.length) d.fields = fieldsFromParams(r.paramSpecs, read.params);
      else d.note = "the JSON is not a list of this method's parameters: the form keeps its own values";
    }
    mode = to;
    drawDetail();
  }

  function putOnClipboard(text: string, what: string, note: HTMLElement): void {
    copied = text;
    const done = (): void => {
      note.textContent = `${what} copied`;
    };
    const fallback = (): void => {
      const ta = el("textarea", "cpbuf");
      ta.value = text;
      ta.readOnly = true;
      document.body.append(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // nothing leaves the page either way
      }
      ta.remove();
      done();
    };
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        navigator.clipboard.writeText(text).then(done, fallback);
        return;
      }
    } catch {
      // the selection below
    }
    fallback();
  }

  // ── Answers ────────────────────────────────────────────────────────────────────────────────────────────────────────
  function drawTree(t: TreeNode, depth: number): HTMLElement {
    const key = (): Node[] => {
      if (t.key === null) return [];
      const k = el("span", "k");
      k.append(dataNode(document, t.key));
      return [k, document.createTextNode(": ")];
    };
    if (t.kind === "object" || t.kind === "array") {
      const box = el("details", "node");
      box.open = depth < 4;
      const s = box.appendChild(el("summary"));
      const size = t.children.length + t.more;
      s.append(...key(), el("span", "note", t.kind === "array" ? `[${size}]` : `{${size}}`));
      const kids = box.appendChild(el("div", "kids"));
      for (const c of t.children) kids.append(drawTree(c, depth + 1));
      if (t.more > 0) kids.append(el("div", "note", `… ${t.more} more (in the text view)`));
      return box;
    }
    const leaf = el("div", "leaf");
    leaf.append(...key());
    const v = el("span", `v v-${t.kind}`);
    if (t.kind === "string") v.append(document.createTextNode('"'), dataNode(document, t.text), document.createTextNode('"'));
    else v.textContent = t.text;
    leaf.append(v);
    if (t.cut > 0) leaf.append(field(el("span", "note", `… ${t.cut.toLocaleString("en-US")} more characters (in the text view)`), "rpc-leaf-cut"));
    if (t.decimal !== null) leaf.append(field(el("span", "note dec", ` = ${t.decimal}`), "rpc-decimal"));
    for (const next of t.next) {
      const b = button(next.label, "rpc-next", "mini");
      b.setAttribute("data-next-method", next.method);
      b.title = `${next.method} ${JSON.stringify(next.params)}`;
      b.addEventListener("click", () => open(next.method, JSON.stringify(next.params), true));
      leaf.append(b);
    }
    return leaf;
  }

  function drawAnswer(): void {
    if (answerBox === null) return;
    const c = byMethod.get(selected.method);
    if (c === undefined) {
      answerBox.replaceChildren(field(el("p", "note", "no call yet"), "rpc-no-answer"));
      return;
    }
    const parts: Node[] = [];
    const head = el("h2", "rpc-sub", "answer");
    if (c.answer !== null) {
      const shown = answerText(c.answer);
      const s = field(el("span"), "rpc-status");
      s.append(dataNode(document, shown.status));
      head.append(document.createTextNode(" · "), s);
    }
    if (c.ms !== null) head.append(document.createTextNode(" · "), field(el("span", undefined, `${Math.round(c.ms)} ms`), "rpc-time"));
    head.append(document.createTextNode(" · "), field(el("span", undefined, `request id ${String((JSON.parse(c.body) as { id: unknown }).id)}`), "rpc-answer-id"));
    parts.push(head);
    if (c.pending) parts.push(field(el("div", "note", "calling…"), "rpc-pending"));
    if (c.error !== null) {
      const e = field(el("div", "err"), "rpc-error");
      e.setAttribute("role", "status");
      e.append(dataNode(document, c.error));
      parts.push(e);
    }
    if (c.answer !== null) {
      const shown = answerText(c.answer);
      let tree: HTMLElement | null = null;
      if (shown.json) {
        const toggles = el("div", "row");
        const treeBtn = toggles.appendChild(button("tree", "rpc-answer-tree", "mini"));
        const textBtn = toggles.appendChild(button("text", "rpc-answer-text", "mini"));
        treeBtn.setAttribute("aria-pressed", String(answerMode === "tree"));
        textBtn.setAttribute("aria-pressed", String(answerMode === "text"));
        treeBtn.addEventListener("click", () => {
          answerMode = "tree";
          drawAnswer();
        });
        textBtn.addEventListener("click", () => {
          answerMode = "text";
          drawAnswer();
        });
        parts.push(toggles);
        tree = field(el("div", "rpc-tree"), "rpc-tree");
        tree.append(drawTree(answerTree(JSON.parse(c.answer.body), c.method), 0));
        tree.hidden = answerMode !== "tree";
        parts.push(tree);
      }
      const text = dataPre(shown.text, "rpc-answer", shown.json);
      text.hidden = shown.json && answerMode === "tree";
      parts.push(text);
    }
    answerBox.replaceChildren(...parts);
  }

  // ── Calls ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  function record(c: JsonRpcCall): void {
    const had = byMethod.get(c.method);
    if (had === undefined || had.seq <= c.seq) byMethod.set(c.method, c);
    if (c.seq === lastMade) last = c;
    if (selected.method === c.method) {
      drawAnswer();
      drawPreview();
    }
  }

  function callNow(): void {
    if (!selected.callable || byMethod.get(selected.method)?.pending === true) return;
    const built = currentRequest();
    if (!built.ok) return;
    const method = selected.method;
    nextId++;
    const seq = ++calls;
    lastMade = seq;
    const t0 = performance.now();
    const call: JsonRpcCall = { seq, method, body: built.body, pending: true, answer: null, error: null, ms: null };
    record(call);
    const sent = JSON.parse(built.body) as { params?: unknown };
    const params = "params" in sent ? JSON.stringify(sent.params) : "";
    const done = (c: JsonRpcCall): void => {
      record(c);
      addHistory({ method, params, at: Date.now(), outcome: outcomeOf(c.answer, c.error) });
      void readState();
    };
    opts.client.request("jsonrpc", { body: built.body }).then(
      (answer) => done({ ...call, pending: false, answer, ms: performance.now() - t0 }),
      (e: unknown) => done({ ...call, pending: false, error: `no answer · ${messageOf(e)}`, ms: performance.now() - t0 }),
    );
    drawPreview();
  }

  // ── History ────────────────────────────────────────────────────────────────────────────────────────────────────────
  function addHistory(entry: HistoryEntry): void {
    callHistory = withHistory(callHistory, entry);
    saveHistory();
    drawHistory();
  }

  function saveHistory(): void {
    if (storage === null) return;
    try {
      if (callHistory.length === 0) storage.removeItem(HISTORY_KEY);
      else storage.setItem(HISTORY_KEY, JSON.stringify(callHistory));
      stored = true;
    } catch {
      stored = false;
    }
  }

  function drawHistory(): void {
    const head = el("div", "row head");
    head.append(el("h2", undefined, "history"));
    head.append(field(el("span", "note", stored ? "the calls of this page, kept in this browser tab" : "the calls of this page, kept in memory (this browser does not let the page keep them)"), "rpc-history-kept"));
    const clear = head.appendChild(button("clear", "rpc-history-clear", "mini"));
    clear.disabled = callHistory.length === 0;
    clear.addEventListener("click", () => {
      callHistory = [];
      saveHistory();
      drawHistory();
    });
    if (callHistory.length === 0) {
      historyBox.replaceChildren(head, field(el("p", "note", "no calls yet"), "rpc-history-empty"));
      return;
    }
    const table = el("table");
    const hr = table.appendChild(el("thead")).appendChild(el("tr"));
    for (const c of ["time", "method", "parameters", "outcome", ""]) hr.append(el("th", undefined, c));
    const body = table.appendChild(el("tbody"));
    callHistory.forEach((h, i) => {
      const tr = field(el("tr"), "rpc-history-row");
      tr.setAttribute("data-index", String(i));
      tr.append(el("td", "mono", clock(h.at)));
      const m = tr.appendChild(el("td", "mono"));
      m.append(dataNode(document, h.method));
      const p = tr.appendChild(el("td", "mono params"));
      p.append(dataNode(document, h.params.length > 120 ? `${h.params.slice(0, 119)}…` : h.params === "" ? "(none)" : h.params));
      const o = tr.appendChild(el("td", "outcome"));
      o.append(dataNode(document, h.outcome));
      const a = tr.appendChild(el("td"));
      const openBtn = a.appendChild(button("open", "rpc-history-open", "mini"));
      const again = a.appendChild(button("run again", "rpc-history-run", "mini"));
      openBtn.addEventListener("click", () => open(h.method, h.params, false));
      again.addEventListener("click", () => open(h.method, h.params, true));
      body.append(tr);
    });
    const scroll = el("div", "scroll");
    scroll.append(table);
    historyBox.replaceChildren(head, scroll);
  }

  /** Chooses `method` with the parameters `paramsText` (JSON, `""`: none) in its editor (the form when it holds them
   *  exactly, else the JSON), and calls it when `call`. */
  function open(method: string, paramsText: string, call: boolean): void {
    const r = rowOf.get(method);
    if (r === undefined || !r.callable) return;
    const d = draftOf(r);
    d.raw = paramsText;
    d.note = null;
    const read = paramsOfText(paramsText);
    const parsed = read.ok ? read.params : undefined;
    let fits = false;
    if (Array.isArray(parsed)) {
      const fields = fieldsFromParams(r.paramSpecs, parsed);
      const back = paramsFromFields(r.paramSpecs, fields);
      fits = back.ok && JSON.stringify(back.params) === JSON.stringify(parsed);
      if (fits) d.fields = fields;
    }
    mode = fits ? "form" : "raw";
    select(method, true, true);
    if (call) callNow();
  }

  // ── Choosing ───────────────────────────────────────────────────────────────────────────────────────────────────────
  function select(method: string, write: boolean, redraw = false): void {
    const r = rowOf.get(method);
    if (r === undefined) return;
    const changed = r !== selected;
    selected = r;
    for (const [m, a] of links) {
      const on = m === method;
      a.classList.toggle("on", on);
      a.tabIndex = on ? 0 : -1;
      if (on) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
    if (write && rpcRouteOf(location.search).method !== method) history.replaceState(null, "", urlWithRpcRoute(location.href, { view, method }));
    page.setHrefs(routeHref);
    if (changed || redraw || preview === null) drawDetail();
  }

  function pushRoute(v: RpcView): void {
    if (rpcRouteOf(location.search).view !== v || new URLSearchParams(location.search).get("rpc") === null) {
      history.pushState(null, "", urlWithRpcRoute(location.href, { view: v, method: rpcRouteOf(location.search).method }));
    }
    page.setHrefs(routeHref);
  }

  function showView(v: RpcView): void {
    view = v;
    page.setView(v);
    explorer.hidden = v !== "methods";
    historyBox.hidden = v !== "methods";
    statusBox.hidden = v !== "status";
    if (v === "status") void readState();
  }

  detail.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      callNow();
    }
  });

  addEventListener("popstate", () => {
    const route = rpcRouteOf(location.search);
    if (route.method !== null && rowOf.has(route.method)) select(route.method, false);
    page.setHrefs(routeHref);
    showView(route.view);
  });

  // ── The module's state ─────────────────────────────────────────────────────────────────────────────────────────────
  function drawState(): void {
    if (status !== null) page.setStrip(stripParts(status), statusError === null ? undefined : "state not read");
    else page.setStrip([], statusError === null ? "reading…" : "state not read");
    page.setBanner(statusError === null ? [] : [`the engine did not answer the module's state: ${statusError}`]);
    const parts: Node[] = [el("h2", undefined, "status")];
    if (status === null) {
      parts.push(statusError === null ? el("div", "note", "reading…") : field(el("div", "err", "the module's state could not be read"), "rpc-state-error"));
      statusBox.replaceChildren(...parts);
      return;
    }
    const kv = el("div", "kv");
    for (const f of statusFigures(status, Date.now())) {
      kv.append(el("div", "k", f.label));
      const v = field(el("div", "v"), f.field);
      if (f.bad === true) v.setAttribute("data-bad", "true");
      v.append(dataNode(document, f.value));
      kv.append(v);
    }
    parts.push(kv);
    parts.push(field(el("p", "note", `read at ${clock(Date.now())}; read again every ${STATE_EVERY_MS / 1000} s while this tab is shown`), "rpc-state-read"));
    statusBox.replaceChildren(...parts);
  }

  async function readState(): Promise<void> {
    if (statusReading) return;
    statusReading = true;
    page.refresh.disabled = true;
    try {
      status = await opts.client.request("jsonrpc-state", {});
      statusError = null;
    } catch (e) {
      statusError = messageOf(e);
    } finally {
      statusReading = false;
      page.refresh.disabled = false;
    }
    drawState();
  }

  applySearch();
  select(selected.method, false, true);
  showView(view);
  drawState();
  drawHistory();

  return {
    rows,
    shown(on: boolean): void {
      if (on === shownNow) return;
      shownNow = on;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (on) {
        void readState();
        timer = setInterval(() => void readState(), STATE_EVERY_MS);
      }
    },
    calls: () => calls,
    latest: () => (last === null ? null : structuredClone(last)),
    state(): JsonRpcViewState {
      const built = selected.callable ? currentRequest() : null;
      return {
        view,
        method: selected.method,
        mode,
        preview: built !== null && built.ok ? built.body : null,
        requestError: built !== null && !built.ok ? built.error : null,
        nextId,
        copied,
        history: structuredClone(callHistory),
        stored,
        status: status === null ? null : structuredClone(status),
        statusError,
        byMethod: structuredClone(Object.fromEntries(byMethod)),
      };
    },
  };
}
