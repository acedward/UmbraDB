/**
 * What the JSON RPC tab (`jsonrpc-view.ts`) shows, computed with no DOM.
 *
 * - **The methods** are the module's registry (`evm-rpc/read-only.ts`, the methods the engine serves, the same build's
 *   registry) and the methods only Node's full entry point serves (`evm-rpc/method-info.ts`). Each is in one group of
 *   the list, by where its answer comes from in this browser: the indexer, configuration and constants, the module's
 *   database (empty here), not implemented (`-32004`), Node only (listed, never called).
 * - **A call's parameters** come from a form with one typed field per parameter (`evm-rpc/method-info.ts` `ParamSpec`):
 *   each field is checked and turned into the value Node expects (a number into a canonical hex quantity, a block tag
 *   or number, a boolean, …); trailing optional fields may be left out. The parameters can also be written as JSON.
 * - **A call** is one JSON-RPC 2.0 request, `{"jsonrpc":"2.0","id":n,"method":…,"params":…}`. The request and the
 *   answer are shown as text (JSON indented by two spaces, cut at {@link MAX_SHOWN_CHARS}), the answer also as a tree
 *   whose quantities show their decimal value and whose block numbers, block hashes and transaction hashes open the
 *   call that reads them. A request can be copied as JSON or as a `curl` command for Node's `npm run evm-rpc`.
 * - **The page's URL** holds the tab's view (`rpc=methods|status`) and the chosen method (`rpc-method`) in its query,
 *   beside the shell's `tab`; the token explorer's routes are its fragment (`#/…`), which the tab never changes.
 * - **The history** of the page's calls (newest first, at most {@link MAX_HISTORY}) is kept in the tab's
 *   `sessionStorage` when the browser lets the page use it; what is read back from it is checked first.
 */
import { METHOD_NOTES, NODE_ONLY_METHODS, type ParamKind, type ParamSpec } from "../../evm-rpc/method-info.js";
import { NOT_IMPLEMENTED_METHODS } from "../../evm-rpc/methods/not-implemented.js";
import { registerReadOnlyMethods } from "../../evm-rpc/read-only.js";
import { MethodRegistry } from "../../evm-rpc/registry.js";
import type { JsonRpcStateResult } from "./protocol.ts";

/** How the engine treats a method: it answers it, it answers `-32004`, or only Node serves it. */
export type MethodKind = "served" | "not-implemented" | "node-only";

/** The groups of the method list, in their order. */
export const METHOD_GROUPS = [
  { id: "indexer", label: "indexer" },
  { id: "config", label: "configuration and constants" },
  { id: "database", label: "database (empty here)" },
  { id: "not-implemented", label: "not implemented (-32004)" },
  { id: "node-only", label: "Node only" },
] as const;
export type MethodGroup = (typeof METHOD_GROUPS)[number]["id"];

export interface MethodRow {
  method: string;
  kind: MethodKind;
  group: MethodGroup;
  /** Where the answer comes from (`METHODS.md`'s data-source tags). */
  source: string;
  /** What the method answers, in one line. */
  summary: string;
  /** The method's state in words. */
  state: string;
  /** The kinds of its parameters (none for a not-implemented or a Node-only method). */
  paramSpecs: readonly ParamSpec[];
  /** The parameters to start from. */
  example: readonly unknown[];
  /** The parameters to start from, as JSON text on one line (`""` for a Node-only method). */
  params: string;
  /** What else to know, or `null`. */
  note: string | null;
  /** Whether the tab offers a call (not for a Node-only method). */
  callable: boolean;
}

/** The title and subtitle of the tab's page. */
export const JSONRPC_TITLE = "JSON-RPC explorer";
export const JSONRPC_SUBTITLE = "Ethereum-style eth_* endpoints over Midnight";

/** The footer note of the tab: what it calls and that nothing outside the page can. */
export const JSONRPC_TAB_NOTE =
  "The EVM JSON-RPC module's methods, answered inside this browser's engine as Node's npm run evm-rpc answers them. " +
  "External wallets cannot connect to a page: the module has no address for them, only this tab calls it.";

/** The data-source tags, in words. */
export const SOURCE_LEGEND =
  "config: the chain ID and the package version · const: a fixed answer · indexer: the network's Midnight indexer (GraphQL) · " +
  "pg:…: the module's evm_rpc database, empty in this browser (the wallet monitor and the relayer that fill it run in Node) · relay: the relayer";

/** Where Node's `npm run evm-rpc` listens by default (`EVM_RPC_PORT` 8545): the address of the copied `curl` command. */
export const NODE_EVM_RPC_URL = "http://127.0.0.1:8545";

/** The names the module's registry serves: the read-only entry point's registrations. */
export function registryMethods(): string[] {
  const registry = new MethodRegistry();
  registerReadOnlyMethods(registry);
  return [...registry.listMethods()];
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * The group of a served method by its source, as it answers in this browser: the indexer when its source starts with
 * it or falls back to it (the database it reads first is empty here), the database when its source starts with a
 * `pg:` table, else configuration and constants.
 */
export function groupOfSource(source: string): MethodGroup {
  if (source.startsWith("indexer") || /\bthen indexer\b/.test(source)) return "indexer";
  if (source.startsWith("pg:")) return "database";
  return "config";
}

const byName = (a: { method: string }, b: { method: string }): number => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0);

/**
 * The tab's rows, in the list's order: the groups of {@link METHOD_GROUPS} in turn, each sorted by name. The served and
 * not-implemented methods are `registered`'s (default: {@link registryMethods}); a registered method without notes is
 * still listed (in the configuration group, source "see METHODS.md", no parameters).
 */
export function methodRows(registered: readonly string[] = registryMethods()): MethodRow[] {
  const stubs = new Map(NOT_IMPLEMENTED_METHODS.map((m) => [m.method, m]));
  const rows: MethodRow[] = [];
  for (const method of registered) {
    const stub = stubs.get(method);
    if (stub !== undefined) {
      rows.push({
        method,
        kind: "not-implemented",
        group: "not-implemented",
        source: "none",
        summary: `answers -32004 Method not supported (${stub.classification})`,
        state: `not implemented (-32004): ${stub.classification}`,
        paramSpecs: [],
        example: [],
        params: "[]",
        note: stub.reason,
        callable: true,
      });
      continue;
    }
    const note = METHOD_NOTES[method];
    const source = note?.source ?? "see METHODS.md";
    rows.push({
      method,
      kind: "served",
      group: note === undefined ? "config" : groupOfSource(source),
      source,
      summary: note?.summary ?? "see METHODS.md",
      state: "served here",
      paramSpecs: note?.paramSpecs ?? [],
      example: note?.params ?? [],
      params: JSON.stringify(note?.params ?? []),
      note: note?.note ?? null,
      callable: true,
    });
  }
  for (const m of NODE_ONLY_METHODS) {
    if (registered.includes(m.method)) continue;
    rows.push({
      method: m.method,
      kind: "node-only",
      group: "node-only",
      source: m.source,
      summary: m.summary,
      state: "served by Node only",
      paramSpecs: [],
      example: [],
      params: "",
      note: `npm run evm-rpc:all, over ${m.surface}: needs ${m.needs}`,
      callable: false,
    });
  }
  const order: readonly MethodGroup[] = METHOD_GROUPS.map((g) => g.id);
  return rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || byName(a, b));
}

/** The rows a search keeps: those whose name, source, summary or state hold every word of `query` (case aside). */
export function filterRows(rows: readonly MethodRow[], query: string): MethodRow[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [...rows];
  return rows.filter((r) => {
    const text = `${r.method} ${r.source} ${r.summary} ${r.state}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

// ── Typed fields ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The block tags Node accepts (`evm-rpc/methods/common.ts` `resolveBlockTag`). */
export const BLOCK_TAGS = ["latest", "earliest", "pending", "safe", "finalized"] as const;
export type BlockTag = (typeof BLOCK_TAGS)[number];

/** A field's value as the form holds it: text, a checkbox, or a block (a tag, a number, a hash, or left out). */
export type FieldValue =
  | { kind: "text"; text: string }
  | { kind: "boolean"; checked: boolean }
  | { kind: "block"; choice: BlockTag | "number" | "hash" | "omit"; number: string; hash: string };

/** What a field of each kind holds, in words (the field's hint, and its message when it holds something else). */
export const KIND_HINTS: Readonly<Record<ParamKind, string>> = {
  address: "an address: 0x and 40 hex digits",
  hash: "a hash: 0x and 64 hex digits",
  quantity: "a number: decimal, or 0x and hex digits",
  blockTag: "a block tag, or a block number",
  blockRef: "a block tag, a block number or a block hash",
  boolean: "true when checked",
  data: "data: 0x and an even number of hex digits",
  percentiles: "numbers from 0 to 100, separated by commas",
  object: "a JSON object",
};

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
/** The longest number a quantity field takes, in characters (a 256-bit number has 78 decimal digits). */
const MAX_QUANTITY_CHARS = 80;

/** The form's values for `params` under `specs` (a missing value: an empty field, a block left out when optional). */
export function fieldsFromParams(specs: readonly ParamSpec[], params: readonly unknown[]): FieldValue[] {
  return specs.map((spec, i): FieldValue => {
    const v = params[i];
    if (spec.kind === "boolean") return { kind: "boolean", checked: v === true };
    if (spec.kind === "blockTag" || spec.kind === "blockRef") {
      if (typeof v === "string" && (BLOCK_TAGS as readonly string[]).includes(v)) return { kind: "block", choice: v as BlockTag, number: "", hash: "" };
      if (typeof v === "string" && spec.kind === "blockRef" && HEX32.test(v)) return { kind: "block", choice: "hash", number: "", hash: v };
      if (typeof v === "string") return { kind: "block", choice: "number", number: v, hash: "" };
      if (v !== undefined) return { kind: "block", choice: "number", number: JSON.stringify(v) ?? "", hash: "" };
      return { kind: "block", choice: spec.optional === true ? "omit" : "latest", number: "", hash: "" };
    }
    if (v === undefined) return { kind: "text", text: "" };
    if (spec.kind === "percentiles" && Array.isArray(v) && v.every((x) => typeof x === "number")) return { kind: "text", text: v.join(", ") };
    if (typeof v === "string" && spec.kind !== "object") return { kind: "text", text: v };
    return { kind: "text", text: JSON.stringify(v) ?? "" };
  });
}

/** A number written in decimal or as `0x` hex, as the canonical hex quantity Node expects; `null` if it is neither. */
export function quantityOf(text: string): string | null {
  const t = text.trim();
  if (t.length > MAX_QUANTITY_CHARS) return null;
  if (/^[0-9]+$/.test(t) || HEX.test(t)) return `0x${BigInt(t).toString(16)}`;
  return null;
}

type FieldRead = { ok: true; value: unknown; omitted: boolean } | { ok: false; error: string };

function readField(spec: ParamSpec, v: FieldValue): FieldRead {
  const bad = (what: string = KIND_HINTS[spec.kind]): FieldRead => ({ ok: false, error: `${spec.name}: ${what}` });
  const value = (x: unknown): FieldRead => ({ ok: true, value: x, omitted: false });
  if (spec.kind === "boolean") return value(v.kind === "boolean" && v.checked);
  if (spec.kind === "blockTag" || spec.kind === "blockRef") {
    if (v.kind !== "block") return bad();
    if (v.choice === "omit") return spec.optional === true ? { ok: true, value: undefined, omitted: true } : bad();
    if (v.choice === "number") {
      const q = quantityOf(v.number);
      return q === null ? bad("a block number is a decimal number, or 0x and hex digits") : value(q);
    }
    if (v.choice === "hash") return spec.kind === "blockRef" && HEX32.test(v.hash.trim()) ? value(v.hash.trim()) : bad(KIND_HINTS.hash);
    return value(v.choice);
  }
  const t = v.kind === "text" ? v.text.trim() : "";
  if (t === "" && spec.optional === true) return { ok: true, value: undefined, omitted: true };
  switch (spec.kind) {
    case "address":
      return /^0x[0-9a-fA-F]{40}$/.test(t) ? value(t) : bad();
    case "hash":
      return HEX32.test(t) ? value(t) : bad();
    case "data":
      return /^0x(?:[0-9a-fA-F]{2})*$/.test(t) ? value(t) : bad();
    case "quantity": {
      const q = quantityOf(t);
      return q === null ? bad() : value(q);
    }
    case "percentiles": {
      if (t === "") return value([]);
      const parts = t.split(",").map((p) => p.trim());
      const numbers = parts.map((p) => (/^[0-9]{1,3}(?:\.[0-9]{1,6})?$/.test(p) ? Number(p) : Number.NaN));
      return numbers.every((n) => n >= 0 && n <= 100) ? value(numbers) : bad();
    }
    case "object": {
      if (t.length > MAX_PARAMS_CHARS) return bad(`longer than ${MAX_PARAMS_CHARS} characters`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(t) as unknown;
      } catch {
        return bad();
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return bad();
      if (nestingDepth(parsed) > MAX_PARAMS_DEPTH - 1) return bad(`nested deeper than ${MAX_PARAMS_DEPTH - 1} levels`);
      return value(parsed);
    }
  }
}

export type FormResult = { ok: true; params: unknown[] } | { ok: false; errors: Array<string | null> };

/**
 * The parameters a form holds: each field read and checked (`errors[i]` says what is wrong with field `i`, `null` when
 * nothing is); optional fields left out at the end are dropped, and one may be left out only when every field after it
 * is too.
 */
export function paramsFromFields(specs: readonly ParamSpec[], values: readonly FieldValue[]): FormResult {
  const read = specs.map((s, i) => readField(s, values[i] ?? { kind: "text", text: "" }));
  const errors: Array<string | null> = read.map((r) => (r.ok ? null : r.error));
  let last = -1;
  read.forEach((r, i) => {
    if (!r.ok || !r.omitted) last = i;
  });
  read.forEach((r, i) => {
    if (r.ok && r.omitted && i < last) errors[i] = `${specs[i]!.name}: needed when a later parameter is given`;
  });
  if (errors.some((e) => e !== null)) return { ok: false, errors };
  return { ok: true, params: read.slice(0, last + 1).map((r) => (r.ok ? r.value : undefined)) };
}

// ── Requests and answers ─────────────────────────────────────────────────────────────────────────────────────────────

/** Limits of a call the tab sends: the characters of the parameters' text. */
export const MAX_PARAMS_CHARS = 65_536;
/** Limits of a call the tab sends: how deep arrays and objects may nest in the parameters. */
export const MAX_PARAMS_DEPTH = 64;
/** The most characters of a request or an answer the tab shows; a longer one is shown cut, with its length. */
export const MAX_SHOWN_CHARS = 262_144;

export type BuiltRequest = { ok: true; body: string; text: string } | { ok: false; error: string };

/** How deep arrays and objects nest in `value` (a scalar: 0), counted without recursion. */
export function nestingDepth(value: unknown): number {
  let deepest = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (typeof v !== "object" || v === null) continue;
    if (depth > deepest) deepest = depth;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1]);
  }
  return deepest;
}

/** `text`, or its first {@link MAX_SHOWN_CHARS} characters and its length when it is longer. */
function shown(text: string): string {
  return text.length <= MAX_SHOWN_CHARS ? text : `${text.slice(0, MAX_SHOWN_CHARS)}… (cut: ${text.length.toLocaleString("en-US")} characters in all)`;
}

/**
 * The JSON-RPC 2.0 request for `method` with `params` (`undefined`: no `params` member): its body (compact JSON, what the
 * engine receives) and its text (indented, cut at {@link MAX_SHOWN_CHARS}). Parameters nested deeper than
 * {@link MAX_PARAMS_DEPTH}, or anything that cannot be written as JSON, make no request. Never throws.
 */
export function requestFor(id: number, method: string, params: unknown): BuiltRequest {
  const request: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) {
    if (nestingDepth(params) > MAX_PARAMS_DEPTH) return { ok: false, error: `the parameters nest deeper than ${MAX_PARAMS_DEPTH} levels` };
    request.params = params;
  }
  try {
    return { ok: true, body: JSON.stringify(request), text: shown(json(request)) };
  } catch (e) {
    return { ok: false, error: `the request could not be written as JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The JSON-RPC 2.0 request for `method` with its parameters written as JSON (empty: no `params` member). Parameters that
 * are not JSON or longer than {@link MAX_PARAMS_CHARS} make no request; see {@link requestFor}. Never throws.
 */
export function buildRequest(id: number, method: string, paramsText: string): BuiltRequest {
  if (paramsText.length > MAX_PARAMS_CHARS) return { ok: false, error: `the parameters are longer than ${MAX_PARAMS_CHARS} characters` };
  if (paramsText.trim() === "") return requestFor(id, method, undefined);
  let params: unknown;
  try {
    params = JSON.parse(paramsText) as unknown;
  } catch (e) {
    return { ok: false, error: `the parameters are not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  return requestFor(id, method, params);
}

/** The `curl` command that sends the request `body` to Node's `npm run evm-rpc` at `url` (the body single-quoted for a
 *  POSIX shell). */
export function curlCommand(body: string, url: string = NODE_EVM_RPC_URL): string {
  return `curl -s -X POST -H 'Content-Type: application/json' --data '${body.replaceAll("'", "'\\''")}' ${url}`;
}

/** An answer as the tab shows it as text: the status line and the body (JSON indented, anything else as it is; cut at
 *  {@link MAX_SHOWN_CHARS}), and whether the text is indented JSON (whose line breaks are layout, not data). */
export function answerText(answer: { status: number; body: string }): { status: string; text: string; json: boolean } {
  const status = answer.status === 204 ? "HTTP 204: no answer (a notification)" : `HTTP ${answer.status}`;
  if (answer.body === "") return { status, text: "", json: false };
  try {
    return { status, text: shown(json(JSON.parse(answer.body))), json: true };
  } catch {
    return { status, text: shown(answer.body), json: false };
  }
}

/** A call a value of an answer opens: the method, its parameters, and the link's words. */
export interface NextCall {
  method: string;
  params: unknown[];
  label: string;
}

/** A node of an answer's tree. */
export interface TreeNode {
  /** The member's name or the item's index (`null` for the root). */
  key: string | null;
  kind: "object" | "array" | "string" | "number" | "boolean" | "null";
  /** A scalar's text (a string as it is, without quotes; `""` for an object or an array). */
  text: string;
  /** A quantity's value in decimal, else `null`. */
  decimal: string | null;
  children: TreeNode[];
  /** Members or items left out once the tree holds {@link MAX_TREE_NODES} nodes (the text view has them). */
  more: number;
  /** The calls the value opens. */
  next: NextCall[];
}

/** The most nodes an answer's tree holds; the text view holds the rest. */
export const MAX_TREE_NODES = 2_000;

/** A quantity worth a decimal: canonical hex of at most 16 digits (hashes, addresses and blooms are longer). */
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/;

const blockByNumber = (v: string): NextCall => ({ method: "eth_getBlockByNumber", params: [v, false], label: "open block" });
const blockByHash = (v: string): NextCall => ({ method: "eth_getBlockByHash", params: [v, false], label: "open block" });
const transactionCalls = (v: string): NextCall[] => [
  { method: "eth_getTransactionByHash", params: [v], label: "open transaction" },
  { method: "eth_getTransactionReceipt", params: [v], label: "open receipt" },
];

/** The calls a string of an answer opens, by its member name, the object holding it, and the array holding it. */
function nextCalls(value: string, key: string | null, holder: Record<string, unknown> | null, arrayKey: string | null, rootOf: string | null): NextCall[] {
  if (rootOf === "eth_blockNumber") return QUANTITY.test(value) ? [blockByNumber(value)] : [];
  if (key === "number" || key === "blockNumber") return QUANTITY.test(value) ? [blockByNumber(value)] : [];
  if (!HEX32.test(value)) return [];
  if (key === "blockHash" || key === "parentHash") return [blockByHash(value)];
  if (key === "transactionHash") return transactionCalls(value);
  if (key === "hash" && holder !== null) {
    if ("parentHash" in holder || "miner" in holder) return [blockByHash(value)];
    if ("transactionIndex" in holder) return transactionCalls(value);
  }
  if (arrayKey === "transactions") return transactionCalls(value);
  return [];
}

/** The tree of a JSON answer `body` (already parsed) to a call of `method`: the `result` member is the method's value. */
export function answerTree(body: unknown, method: string): TreeNode {
  const leaf = (key: string | null): TreeNode => ({ key, kind: "null", text: "null", decimal: null, children: [], more: 0, next: [] });
  // Iterative, so an answer nested as deep as JSON allows never overflows the stack; at most MAX_TREE_NODES nodes.
  const root = leaf(null);
  let made = 1;
  const stack: Array<{ value: unknown; node: TreeNode; holder: Record<string, unknown> | null; arrayKey: string | null; rootOf: string | null }> = [
    { value: body, node: root, holder: null, arrayKey: null, rootOf: null },
  ];
  while (stack.length > 0) {
    const { value, node, holder, arrayKey, rootOf } = stack.pop()!;
    if (typeof value === "object" && value !== null) {
      const isArray = Array.isArray(value);
      node.kind = isArray ? "array" : "object";
      node.text = "";
      const entries: Array<[string, unknown]> = isArray ? (value as unknown[]).map((x, i) => [String(i), x]) : Object.entries(value);
      const isEnvelope = node === root && !isArray && "jsonrpc" in value;
      const children: typeof stack = [];
      for (const [k, x] of entries) {
        if (made >= MAX_TREE_NODES) {
          node.more++;
          continue;
        }
        made++;
        const child = leaf(k);
        node.children.push(child);
        children.push({ value: x, node: child, holder: isArray ? null : (value as Record<string, unknown>), arrayKey: isArray ? node.key : null, rootOf: isEnvelope && k === "result" ? method : null });
      }
      // Pushed in reverse, so the first member is filled first.
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
      continue;
    }
    if (typeof value === "string") {
      node.kind = "string";
      node.text = value;
      node.decimal = QUANTITY.test(value) ? BigInt(value).toString(10) : null;
      node.next = nextCalls(value, node.key, holder, arrayKey, rootOf);
    } else if (typeof value === "number" || typeof value === "boolean") {
      node.kind = typeof value === "number" ? "number" : "boolean";
      node.text = String(value);
    }
  }
  return root;
}

// ── The page's URL ───────────────────────────────────────────────────────────────────────────────────────────────────

export const RPC_VIEWS = ["methods", "status"] as const;
export type RpcView = (typeof RPC_VIEWS)[number];

/** The tab's view and method a URL's query names (`rpc`, `rpc-method`); no view or an unknown one is the methods view. */
export function rpcRouteOf(search: string): { view: RpcView; method: string | null } {
  const q = new URLSearchParams(search);
  const method = q.get("rpc-method");
  return { view: q.get("rpc") === "status" ? "status" : "methods", method: method === null || method === "" ? null : method };
}

/** `href` with the tab's view and method set (its other parameters, the shell's `tab` among them, and its fragment kept). */
export function urlWithRpcRoute(href: string, route: { view: RpcView; method: string | null }): string {
  const u = new URL(href);
  u.searchParams.set("rpc", route.view);
  if (route.method === null) u.searchParams.delete("rpc-method");
  else u.searchParams.set("rpc-method", route.method);
  return u.toString();
}

// ── History ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A call of the page's history: the method, its parameters as JSON text (`""`: none), when (ms), and its outcome. */
export interface HistoryEntry {
  method: string;
  params: string;
  at: number;
  outcome: string;
}

/** The most calls the history keeps. */
export const MAX_HISTORY = 50;
/** Where the history is kept in `sessionStorage`. */
export const HISTORY_KEY = "umbradb.jsonrpc.history";
const MAX_OUTCOME_CHARS = 200;

/** The history after `entry`: newest first, at most {@link MAX_HISTORY} (parameters too long to send are not kept). */
export function withHistory(history: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  if (entry.params.length > MAX_PARAMS_CHARS) return [...history];
  return [{ ...entry, outcome: entry.outcome.slice(0, MAX_OUTCOME_CHARS) }, ...history].slice(0, MAX_HISTORY);
}

/** The history read back from its stored text: entries of the methods in `known` only, with parameters the tab could
 *  send; anything else is dropped. Never throws. */
export function parseHistory(text: string | null, known: ReadonlySet<string>): HistoryEntry[] {
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const e of raw.slice(0, MAX_HISTORY)) {
    if (typeof e !== "object" || e === null) continue;
    const { method, params, at, outcome } = e as Record<string, unknown>;
    if (typeof method !== "string" || !known.has(method) || typeof params !== "string" || typeof at !== "number" || !Number.isFinite(at)) continue;
    if (typeof outcome !== "string" || outcome.length > MAX_OUTCOME_CHARS) continue;
    if (params !== "" && !buildRequest(0, method, params).ok) continue;
    out.push({ method, params, at, outcome });
  }
  return out;
}

/** An answer's outcome in a few words: its result's or error's start, or why there is none. */
export function outcomeOf(answer: { status: number; body: string } | null, error: string | null): string {
  if (answer === null) return (error ?? "no answer").slice(0, MAX_OUTCOME_CHARS);
  let text = `HTTP ${answer.status}`;
  try {
    const parsed = JSON.parse(answer.body) as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      if (parsed.error !== undefined) text = `error ${String(parsed.error?.code)}: ${String(parsed.error?.message)}`;
      else if ("result" in parsed) text = `result ${JSON.stringify(parsed.result) ?? "undefined"}`;
    } else if (Array.isArray(parsed)) text = `${parsed.length} answers`;
  } catch {
    // the status line
  }
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

// ── The status view ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One figure of the status view: its field name, its label and its value as text. */
export interface StatusFigure {
  field: string;
  label: string;
  value: string;
  bad?: boolean;
}

const n = (x: number): string => x.toLocaleString("en-US");
const DATABASE_TEXT: Record<JsonRpcStateResult["database"], string> = {
  none: "none yet (made in memory at the first call)",
  starting: "being made",
  open: "open, in memory (empty: its tables are filled in Node)",
  closing: "being closed",
};

/** How long ago `at` was, from `now` (both ms). */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** The status view's figures, each from the engine's `jsonrpc-state` answer `s`; `now` (ms) dates the last error. */
export function statusFigures(s: JsonRpcStateResult, now: number): StatusFigure[] {
  const p = s.pacing;
  const pacing = [p.minIntervalMs === 0 ? "requests not spaced" : `one request every ${n(p.minIntervalMs)} ms`, `${n(p.waiting)} waiting`];
  if (p.heldForMs > 0) pacing.push(`held ${n(Math.ceil(p.heldForMs / 1000))} s more (Retry-After)`);
  return [
    { field: "rpc-state.enabled", label: "module", value: s.enabled ? "on" : "off", bad: !s.enabled },
    { field: "rpc-state.database", label: "evm_rpc database", value: DATABASE_TEXT[s.database] },
    { field: "rpc-state.methods", label: "methods", value: `${n(s.methods.served)} served here · ${n(s.methods.notImplemented)} not implemented (-32004) · ${n(s.methods.nodeOnly)} served by Node only` },
    { field: "rpc-state.chainId", label: "chain ID", value: `${s.chainId} (0x${BigInt(s.chainId).toString(16)})` },
    { field: "rpc-state.clientVersion", label: "client version", value: s.clientVersion },
    { field: "rpc-state.indexerUrl", label: "indexer", value: s.indexerUrl },
    {
      field: "rpc-state.calls",
      label: "calls since the engine started",
      value: `${n(s.calls.answered)} answered · ${n(s.calls.inFlight)} in flight · ${n(s.calls.refusedBusy)} refused busy · ${n(s.calls.refusedOff)} refused off · ${n(s.calls.failed)} failed`,
    },
    { field: "rpc-state.pacing", label: `pacing of ${p.origin}`, value: pacing.join(" · ") },
    { field: "rpc-state.lastError", label: "last error", value: s.lastError === null ? "none" : `${s.lastError.message} (${agoText(s.lastError.at, now)})`, bad: s.lastError !== null },
  ];
}

/** The strip's figures: the switch, the calls answered and in flight, the requests waiting for the indexer. */
export function stripParts(s: JsonRpcStateResult): Array<{ label: string; value: string }> {
  return [
    { label: "module", value: s.enabled ? "on" : "off" },
    { label: "answered", value: n(s.calls.answered) },
    { label: "in flight", value: n(s.calls.inFlight) },
    { label: "waiting", value: n(s.pacing.waiting) },
  ];
}
