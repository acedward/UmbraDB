/**
 * What the JSON RPC tab (`jsonrpc-view.ts`) shows, computed with no DOM: one row per method of the EVM JSON-RPC module
 * and the text of a call.
 *
 * - **The methods** are the module's registry (`evm-rpc/read-only.ts`, the methods the engine serves, the same build's
 *   registry) and the methods only Node's full entry point serves (`evm-rpc/method-info.ts`): a served method with the
 *   source of its answer (`METHODS.md`'s data-source tags) and an example of its parameters; a not-implemented method
 *   (`-32004`) with its classification; a Node-only method marked "served by Node only", with no call.
 * - **A call** is one JSON-RPC 2.0 request: `{"jsonrpc":"2.0","id":n,"method":…,"params":…}` with the parameters the
 *   user edited (JSON; empty: no `params` member). The request and the answer are shown as text: JSON indented by two
 *   spaces (its line breaks are the indentation's: JSON writes a line break inside a value as `\n`), a body that is not
 *   JSON as it is.
 */
import { METHOD_NOTES, NODE_ONLY_METHODS } from "../../evm-rpc/method-info.js";
import { NOT_IMPLEMENTED_METHODS } from "../../evm-rpc/methods/not-implemented.js";
import { registerReadOnlyMethods } from "../../evm-rpc/read-only.js";
import { MethodRegistry } from "../../evm-rpc/registry.js";

/** How the engine treats a method: it answers it, it answers `-32004`, or only Node serves it. */
export type MethodKind = "served" | "not-implemented" | "node-only";

export interface MethodRow {
  method: string;
  kind: MethodKind;
  /** Where the answer comes from. */
  source: string;
  /** The row's state in words. */
  state: string;
  /** The parameters to start from, as JSON text on one line (`""` for a Node-only method). */
  params: string;
  /** What else to know, or `null`. */
  note: string | null;
  /** Whether the tab offers a call (not for a Node-only method). */
  callable: boolean;
}

/** The note on the tab: what it calls and that nothing outside the page can. */
export const JSONRPC_TAB_NOTE =
  "The EVM JSON-RPC module's methods, answered inside this browser's engine as Node's npm run evm-rpc answers them. " +
  "External wallets cannot connect to a page: the module has no address for them, only this tab calls it.";

/** The data-source tags, in words. */
export const SOURCE_LEGEND =
  "config: the chain ID and the package version · const: a fixed answer · indexer: the network's Midnight indexer (GraphQL) · " +
  "pg:…: the module's evm_rpc database, empty in this browser (the wallet monitor and the relayer that fill it run in Node) · relay: the relayer";

/** The names the module's registry serves: the read-only entry point's registrations. */
export function registryMethods(): string[] {
  const registry = new MethodRegistry();
  registerReadOnlyMethods(registry);
  return [...registry.listMethods()];
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * The tab's rows: the served methods of `registered` (default: {@link registryMethods}), then the Node-only ones, then
 * the not-implemented ones, each group sorted by name. A registered method without notes is still listed (source
 * "see METHODS.md", parameters `[]`).
 */
export function methodRows(registered: readonly string[] = registryMethods()): MethodRow[] {
  const stubs = new Map(NOT_IMPLEMENTED_METHODS.map((m) => [m.method, m]));
  const served: MethodRow[] = [];
  const notImplemented: MethodRow[] = [];
  for (const method of [...registered].sort()) {
    const stub = stubs.get(method);
    if (stub !== undefined) {
      notImplemented.push({
        method,
        kind: "not-implemented",
        source: "none",
        state: `not implemented (-32004): ${stub.classification}`,
        params: "[]",
        note: stub.reason,
        callable: true,
      });
      continue;
    }
    const note = METHOD_NOTES[method];
    served.push({
      method,
      kind: "served",
      source: note?.source ?? "see METHODS.md",
      state: "served here",
      params: JSON.stringify(note?.params ?? []),
      note: note?.note ?? null,
      callable: true,
    });
  }
  const nodeOnly: MethodRow[] = NODE_ONLY_METHODS.filter((m) => !registered.includes(m.method))
    .sort((a, b) => (a.method < b.method ? -1 : 1))
    .map((m) => ({
      method: m.method,
      kind: "node-only",
      source: m.source,
      state: "served by Node only",
      params: "",
      note: `npm run evm-rpc:all, over ${m.surface}: needs ${m.needs}`,
      callable: false,
    }));
  return [...served, ...nodeOnly, ...notImplemented];
}

/** Limits of a call the tab sends: the characters of the parameters' text. */
export const MAX_PARAMS_CHARS = 65_536;

export type BuiltRequest = { ok: true; body: string; text: string } | { ok: false; error: string };

/**
 * The JSON-RPC 2.0 request for `method` with the edited parameters: its body (compact JSON, what the engine receives)
 * and its text (indented). Parameters that are not JSON, or longer than {@link MAX_PARAMS_CHARS}, make no request.
 */
export function buildRequest(id: number, method: string, paramsText: string): BuiltRequest {
  if (paramsText.length > MAX_PARAMS_CHARS) return { ok: false, error: `the parameters are longer than ${MAX_PARAMS_CHARS} characters` };
  const request: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (paramsText.trim() !== "") {
    try {
      request.params = JSON.parse(paramsText) as unknown;
    } catch (e) {
      return { ok: false, error: `the parameters are not JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { ok: true, body: JSON.stringify(request), text: json(request) };
}

/** An answer as the tab shows it: the status line and the body as text (JSON indented, anything else as it is), and
 *  whether the text is indented JSON (whose line breaks are layout, not data). */
export function answerText(answer: { status: number; body: string }): { status: string; text: string; json: boolean } {
  const status = answer.status === 204 ? "HTTP 204: no answer (a notification)" : `HTTP ${answer.status}`;
  if (answer.body === "") return { status, text: "", json: false };
  try {
    return { status, text: json(JSON.parse(answer.body)), json: true };
  } catch {
    return { status, text: answer.body, json: false };
  }
}
