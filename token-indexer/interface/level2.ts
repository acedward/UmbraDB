import * as rt from "@midnight-ntwrk/compact-runtime";
import { sha256Hex } from "./commitment.js";

/**
 * Project 00024-02 task C5 — [B] **Level 2**: "every published verifier key equals its same-named
 * installed verifier key at the identified contract state" (MIP-SPEC-DRAFT.md; consumer step 4: "A
 * missing name, missing installed key, or mismatch fails Level 2"). A port of the reference
 * verifier's `levelTwo` + `wrapperBinding` (`src/verify.mjs` @ PR #6 `1cf9477`; `./SOURCE.md`):
 *
 *  1. every shipped `out/keys/<name>.verifier` must byte-equal the key the state installs under
 *     exactly `<name>` (`ContractState.operation(name).verifierKey`, `@midnight-ntwrk/compact-runtime`
 *     0.19.0); a bundle that ships no key at all proves nothing and fails;
 *  2. every circuit the bundle publishes (`out/compiler/contract-info.json`) that has an entry point on
 *     chain must ship its key — otherwise nothing ties that circuit to the chain;
 *  3. the `expectedVk` table compactc writes into `out/contract/index.js` must list the sha256 of each
 *     shipped key — READ AS TEXT, never imported (FR-013b: nothing from a bundle is executed).
 *
 * The state is the contract's CURRENT state as the event/state provider (the public indexer's
 * `contractAction(address) { state }`) reports it (spec Edge Cases: "L2 uses the current state"); the
 * record names where it came from ([B] consumer step 1).
 *
 * A state the provider cannot supply, or that does not deserialize, is the provider's problem, not
 * the bundle's: `unchecked` ("a failure or unavailable dependency stops every stronger claim").
 */

/** A compiler's contract-info.json is shallow (types nest a few levels); anything deeper is not one. */
export const MAX_CONTRACT_INFO_DEPTH = 64;
/** Circuits read from contract-info.json; beyond it the bundle is `unchecked` (a local limit). */
export const MAX_CIRCUITS = 10_000;
/** Longest rendered TYPE kept in a circuit summary (a display label; names are kept exact — E2-R6A). */
const MAX_TEXT = 128;
/** Circuits kept in the summary (it is stored with every result, so it stays small whatever a bundle
 *  claims; honest interfaces have a handful; `circuitsTruncated` says when more exist). Each kept
 *  circuit keeps every argument (E2-R7A). */
export const MAX_SUMMARY_CIRCUITS = 500;
/** Arguments, in all, of the circuits kept in the summary: every one is kept (E2-R7A), so their total
 *  is bounded before expansion — beyond it Level 2 is `unchecked` (E2-R8A). Honest interfaces have a
 *  few per circuit; this allows 500 circuits of 20. */
export const MAX_SUMMARY_ARGUMENTS = 10_000;
/** Deepest type rendered in a circuit summary. */
const MAX_TYPE_DEPTH = 16;

// ── the provider's state ────────────────────────────────────────────────────────────────────

export interface StateObservation {
  /** The serialized `ContractState`. */
  state: Buffer;
  /** Where the provider says it comes from: the contract action that produced it. */
  blockHeight: number | null;
  txHash: string | null;
}

/** The provider could not supply a usable state. */
export class StateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateUnavailableError";
  }
}

export interface StateSource {
  /** The contract's current state; throws {@link StateUnavailableError}. */
  stateOf(address: string): Promise<StateObservation>;
  /** Named in the verification record. */
  readonly description: string;
}

const STATE_QUERY = `query ContractState($address: HexEncoded!) {
  contractAction(address: $address) { address state transaction { hash block { height } } }
}`;

/**
 * How a provider URL is named in a verification record: its origin only (scheme, host, port). The
 * record is stored and served publicly, and a configured `INDEXER_HTTP` may carry a credential in its
 * userinfo, path (`/v3/<key>/…`), query (`?api_key=…`) or fragment (audit 02 E2-F4).
 */
export function providerOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === "null" ? `a ${u.protocol} URL` : u.origin;
  } catch {
    return "an unparseable URL";
  }
}

/** The largest `contractAction` response read (bytes; the state is hex in it, so ≈ 2× the state):
 *  a generous bound, well above any contract state a block can hold; beyond it Level 2 is `unchecked`
 *  (a local limit — audit 02 E2-F8), never a buffer of whatever the provider sends. */
export const MAX_STATE_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * A function that removes from a diagnostic every piece of `url` that may be a credential — the URL
 * itself, its userinfo, its path and every path segment, its query and every query value (as written
 * AND decoded), its fragment — a second line of defence: the state source's diagnostics are built
 * from safe categories only and quote no provider or exception text (audit 02 E2-R2B, E2-R3A).
 */
export function providerRedactor(url: string): (text: string) => string {
  const pieces = new Set<string>([url]);
  const decoded = (p: string): string => { try { return decodeURIComponent(p); } catch { return p; } };
  const add = (p: string): void => { pieces.add(p); pieces.add(decoded(p)); };
  try {
    const u = new URL(url);
    add(u.href); add(u.username); add(u.password); add(u.pathname); add(u.search); add(u.search.slice(1)); add(u.hash); add(u.hash.slice(1));
    for (const seg of u.pathname.split("/")) add(seg);
    for (const pair of u.search.slice(1).split("&")) { const eq = pair.indexOf("="); add(eq < 0 ? pair : pair.slice(eq + 1)); }
    for (const [, value] of u.searchParams) pieces.add(value);
  } catch { /* not a URL: only the text itself */ }
  const secrets = [...pieces].filter((p) => p.length >= 3).sort((a, b) => b.length - a.length);
  return (text: string): string => secrets.reduce((t, secret) => t.split(secret).join("[redacted]"), text);
}

/** An exception named by its class and code only — never its message, which may quote a URL. */
function errorCategory(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  const name = typeof e?.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
  const raw = e?.cause?.code ?? e?.code;
  const code = typeof raw === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(raw) ? ` ${raw}` : "";
  return `${name}${code}`;
}

/** The public indexer's `contractAction(address) { state }` (indexer 4.4, GraphQL v4). */
export class IndexerStateSource implements StateSource {
  readonly description: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly redact: (text: string) => string;

  constructor(private readonly opts: { url: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number }) {
    this.redact = providerRedactor(opts.url);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? MAX_STATE_RESPONSE_BYTES;
    this.description = `indexer contractAction(address) at ${providerOrigin(opts.url)}`;
  }

  async stateOf(address: string): Promise<StateObservation> {
    try {
      return await this.observe(address);
    } catch (error) {
      // Every message this source produces is stored in a public record: nothing of the configured
      // URL survives in it (E2-R2B).
      if (error instanceof StateUnavailableError) throw new StateUnavailableError(this.redact(error.message));
      throw error;
    }
  }

  private async observe(address: string): Promise<StateObservation> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: STATE_QUERY, variables: { address } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new StateUnavailableError(`contractAction request failed (${errorCategory(error)})`);
    }
    if (!res.ok) throw new StateUnavailableError(`contractAction HTTP ${res.status}`);
    const text = await this.boundedText(res);
    let body: { data?: { contractAction?: { state?: string; transaction?: { hash?: string; block?: { height?: number } } } | null }; errors?: { message: string }[] };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new StateUnavailableError("contractAction response was not JSON");
    }
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      // The provider's own words are not quoted: they may echo its key (E2-R3A).
      throw new StateUnavailableError(`contractAction GraphQL error (${body.errors.length} error${body.errors.length === 1 ? "" : "s"})`);
    }
    const action = body?.data?.contractAction;
    if (action === undefined || action === null) throw new StateUnavailableError(`the indexer knows no contract at ${address}`);
    const hex = String(action.state ?? "").replace(/^0x/i, "");
    if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new StateUnavailableError("contractAction state is not hex");
    const height = action.transaction?.block?.height;
    const tx = action.transaction?.hash;
    return {
      state: Buffer.from(hex, "hex"),
      blockHeight: typeof height === "number" && Number.isSafeInteger(height) ? height : null,
      txHash: typeof tx === "string" && /^(0x)?[0-9a-fA-F]{64}$/.test(tx) ? tx.replace(/^0x/i, "").toLowerCase() : null,
    };
  }

  /** The response body as text, at most {@link maxResponseBytes} (announced or counted while read). */
  private async boundedText(res: Response): Promise<string> {
    const cap = this.maxResponseBytes;
    const tooLarge = (): StateUnavailableError => new StateUnavailableError(`the contractAction response is larger than the ${cap}-byte limit; Level 2 was not run`);
    const announced = Number(res.headers.get("content-length"));
    if (res.headers.get("content-length") !== null && Number.isFinite(announced) && announced > cap) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    if (res.body === null) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > cap) { await reader.cancel().catch(() => undefined); throw tooLarge(); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof StateUnavailableError) throw error;
      throw new StateUnavailableError(`contractAction response could not be read (${errorCategory(error)})`);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

// ── the bundle side ─────────────────────────────────────────────────────────────────────────

export interface Level2Row {
  circuit: string;
  status: "OK" | "FAIL";
  reason?: string;
  /** sha256 of the shipped key, when there is one. */
  keySha256?: string;
}

export interface WrapperBinding {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  rows: { circuit: string; status: "OK" | "FAIL"; want?: string; got?: string; reason?: string }[];
}

export interface CircuitSummary {
  name: string;
  pure: boolean | null;
  arguments: { name: string; type: string }[];
  resultType: string;
  /** Whether the bundle ships a verifier key for it, and its sha256. */
  keySha256: string | null;
  /** Whether the state has an entry point of that name. */
  onChain: boolean;
  /** This circuit's Level 2 row, when it has one. */
  l2: "OK" | "FAIL" | null;
}

export interface Level2Result {
  outcome: "passed" | "failed" | "unchecked";
  reason?: string;
  rows: Level2Row[];
  wrapper: WrapperBinding;
  /** The state's installed operation names. */
  entryPoints: string[];
  circuits: CircuitSummary[];
  /** True when the summary was cut at {@link MAX_SUMMARY_CIRCUITS} (the check itself was not). */
  circuitsTruncated: boolean;
  witnesses: string[];
}

const KEYS_DIR = "out/keys/";

/**
 * The shipped keys: `out/keys/<name>.verifier`, sorted by name, whatever kind of entry each is — a
 * listed `out/keys/x.verifier/y` makes `x.verifier` a DIRECTORY, which the reference reports as "not a
 * regular file" (its `readdirSync` sees the entry), and so does this.
 */
export function shippedKeys(files: ReadonlyMap<string, Buffer>): Map<string, Buffer | { error: string }> {
  const out = new Map<string, Buffer | { error: string }>();
  for (const [path, body] of files) {
    if (!path.startsWith(KEYS_DIR)) continue;
    const rest = path.slice(KEYS_DIR.length);
    const entry = rest.split("/")[0]!;
    if (!entry.endsWith(".verifier")) continue;
    const name = entry.slice(0, -".verifier".length);
    out.set(name, rest.includes("/") ? { error: `out/keys/${entry} is not a regular file` } : body);
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The depth of a parsed JSON value, iteratively (a hostile value cannot overflow the stack here). */
export function jsonDepth(value: unknown, limit: number): number {
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d > max) max = d;
    if (max > limit) return max;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return max;
}

/** Values (every array element, object member and scalar) a contract-info.json may hold: an honest
 *  one has a few thousand; beyond this Level 2 is `unchecked` (a local limit, audit 02 E2-R8A). */
export const MAX_CONTRACT_INFO_VALUES = 200_000;

/** The depth and the number of values of a parsed JSON document, stopping once either limit is
 *  passed. A container's children are COUNTED before any of them is scheduled, so the walk itself never
 *  allocates more than `maxValues` entries (audit 02 E2-R9A: scheduling first and counting later
 *  allocated one tuple per child of a 4 000 000-element array before refusing it). */
export function jsonShape(value: unknown, maxDepth: number, maxValues: number, stats?: { maxStack: number }): { depth: number; values: number } {
  let depth = 0;
  let values = 1;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d > depth) depth = d;
    if (depth > maxDepth) return { depth, values };
    let size = 0;
    if (Array.isArray(v)) size = v.length;
    else for (const _k in v) { if (++size > maxValues) break; } // eslint-disable-line @typescript-eslint/no-unused-vars
    values += size;
    if (values > maxValues) return { depth, values };
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
    if (stats !== undefined && stack.length > stats.maxStack) stats.maxStack = stack.length; // test seam
  }
  return { depth, values };
}

/** `out/compiler/contract-info.json`, parsed as data, or why it cannot be (`error`: not a compiler's
 *  contract description — Level 2 fails; `limit`: over a local limit — Level 2 is not run). */
export function readContractInfo(files: ReadonlyMap<string, Buffer>): { info: Record<string, unknown> } | { error: string } | { limit: string } {
  const body = files.get("out/compiler/contract-info.json");
  if (body === undefined) return { error: "out/compiler/contract-info.json is missing or unreadable, so the published circuits cannot be checked" };
  const text = body.toString("utf8");
  // First a plain parse (iterative, fast) and one bounded walk for the shape: the exact-`maxval`
  // reviver below costs ~1 µs per value, so an 8 MiB file of 4 000 000 tiny values would hold the
  // event loop for seconds before any limit applied (audit 02 E2-R8A).
  let plain: unknown;
  try {
    plain = JSON.parse(text);
  } catch {
    return { error: "out/compiler/contract-info.json is missing or unreadable, so the published circuits cannot be checked" };
  }
  const shape = jsonShape(plain, MAX_CONTRACT_INFO_DEPTH, MAX_CONTRACT_INFO_VALUES);
  if (shape.depth > MAX_CONTRACT_INFO_DEPTH) {
    return { error: `out/compiler/contract-info.json is nested deeper than ${MAX_CONTRACT_INFO_DEPTH} levels, so it is not a compiler's contract description` };
  }
  if (shape.values > MAX_CONTRACT_INFO_VALUES) {
    return { limit: `out/compiler/contract-info.json holds more than ${MAX_CONTRACT_INFO_VALUES} values, over this indexer's limit; Level 2 was not run` };
  }
  if (plain === null || typeof plain !== "object" || Array.isArray(plain)) {
    return { error: "out/compiler/contract-info.json is missing or unreadable, so the published circuits cannot be checked" };
  }
  // `maxval` (a Uint's largest value) is written as exact decimal digits that a double cannot always
  // hold (2^64 − 1); the reviver keeps them exact from the source text, for display. The shape is
  // bounded above, so this parse is too.
  const info = JSON.parse(text, (key, value, context?: { source?: string }) =>
    (key === "maxval" && typeof value === "number" && !Number.isSafeInteger(value)
      && typeof context?.source === "string" && /^[0-9]+$/.test(context.source) ? BigInt(context.source) : value)) as Record<string, unknown>;
  return { info };
}

/** The `expectedVk` table exactly as compactc writes it: one line per circuit, name and sha256. */
const VK_TABLE = /^export const expectedVk = \{\n((?: {2}'[A-Za-z_$][A-Za-z0-9_$]*': '[0-9a-f]{64}',\n)*)\};$/m;
const VK_ROW = /^ {2}'([^']+)': '([0-9a-f]{64})',$/gm;

/**
 * `expectedVk` in the generated wrapper against the shipped keys, read as TEXT ([B]
 * `wrapperBinding`). No table (an older compiler) is skipped; a table in any other form, or a second
 * mention of `expectedVk`, fails.
 */
export function wrapperBinding(files: ReadonlyMap<string, Buffer>, keys = shippedKeys(files)): WrapperBinding {
  const js = files.get("out/contract/index.js");
  if (js === undefined) return { ok: false, rows: [], error: "out/contract/index.js could not be read (ENOENT)" };
  const source = js.toString("utf8");
  const mentions = source.match(/\bexpectedVk\b/g)?.length ?? 0;
  if (mentions === 0) return { ok: true, skipped: true, reason: "this compiler emits no expectedVk table", rows: [] };
  const table = VK_TABLE.exec(source);
  const expected = new Map<string, string>();
  for (const [, name, digest] of table?.[1]!.matchAll(VK_ROW) ?? []) {
    if (expected.has(name!)) { expected.clear(); break; }
    expected.set(name!, digest!);
  }
  if (table === null || mentions !== 1 || (table[1]!.length > 0 && expected.size === 0)) {
    return { ok: false, rows: [], error: "out/contract/index.js has an expectedVk table not in the form the compiler emits (read as text, not run)" };
  }
  const rows: WrapperBinding["rows"] = [];
  for (const [name, key] of keys) {
    const want = expected.get(name);
    if ("error" in key) { rows.push({ circuit: name, status: "FAIL", want, reason: key.error }); continue; }
    const got = sha256Hex(key);
    rows.push({ circuit: name, status: want === got ? "OK" : "FAIL", want, got });
  }
  return { ok: rows.every((r) => r.status === "OK"), rows };
}

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 3)}...` : s);

/** The largest value of a `Uint` type → its Compact spelling (`Uint<64>`, `Uint<0..100>`). */
function uintName(max: bigint): string {
  const bits = (max + 1n).toString(2).length - 1;
  return (1n << BigInt(bits)) - 1n === max ? `Uint<${bits}>` : `Uint<0..${max + 1n}>`;
}

/** A contract-info type → its Compact spelling, for display ([B] `renderType`), depth-bounded. */
export function renderType(t: unknown, maxval?: (t: Record<string, unknown>) => bigint | undefined, depth = 0): string {
  if (depth > MAX_TYPE_DEPTH) return "...";
  if (t === null || t === undefined) return "[]";
  if (typeof t !== "object") return "?";
  const o = t as Record<string, unknown>;
  const name = o["type-name"];
  const sub = (x: unknown): string => renderType(x, maxval, depth + 1);
  switch (name) {
    case "Bytes": return `Bytes<${String(o.length)}>`;
    case "Uint": {
      const m = maxval?.(o);
      return m === undefined ? "Uint" : uintName(m);
    }
    case "Opaque": return `Opaque<"${String(o.tsType)}">`;
    case "Struct": {
      if (typeof o.name !== "string" || o.name === "") return "Struct";
      if (o.name === "ContractAddress") return "ContractAddress";
      if ((o.name === "Either" || o.name === "Maybe") && Array.isArray(o.elements)) {
        const elements = (o.elements as Record<string, unknown>[]).filter((e) => e?.name !== "is_left" && e?.name !== "is_some");
        return `${o.name}<${elements.map((e) => sub(e?.type)).join(", ")}>`;
      }
      return o.name;
    }
    case "Map": return `Map<${sub(o.key)}, ${sub(o.value)}>`;
    case "Tuple": return Array.isArray(o.types) && o.types.length === 0 ? "[]" : `[${(Array.isArray(o.types) ? o.types : []).map(sub).join(", ")}]`;
    default: return typeof name === "string" ? name : "?";
  }
}

/** A `Uint`'s exact largest value from contract-info (a BigInt kept by `readContractInfo`, or a safe integer). */
const maxvalOf = (t: Record<string, unknown>): bigint | undefined => {
  const m = t.maxval;
  if (typeof m === "bigint") return m >= 0n ? m : undefined;
  if (typeof m === "number" && Number.isSafeInteger(m) && m >= 0) return BigInt(m);
  return undefined;
};

// ── Level 2 ─────────────────────────────────────────────────────────────────────────────────

/** Runs Level 2 over the Level 1–checked files and the provider's state bytes. Never throws for a
 *  check that does not pass. */
export function levelTwo(files: ReadonlyMap<string, Buffer>, stateBytes: Uint8Array): Level2Result {
  const empty = (outcome: Level2Result["outcome"], reason: string): Level2Result =>
    ({ outcome, reason, rows: [], wrapper: { ok: false, rows: [] }, entryPoints: [], circuits: [], circuitsTruncated: false, witnesses: [] });
  let state: rt.ContractState;
  try {
    state = rt.ContractState.deserialize(Uint8Array.from(stateBytes));
  } catch (error) {
    return empty("unchecked", `the provider's contract state does not deserialize (${(error as Error).message}); Level 2 was not run`);
  }
  const text = (op: unknown): string => (typeof op === "string" ? op : Buffer.from(op as Uint8Array).toString("utf8"));
  const entryPoints = state.operations().map(text).sort();
  const installed = (name: string): Uint8Array | undefined => {
    try {
      return state.operation(name)?.verifierKey;
    } catch {
      return undefined;
    }
  };

  const contractInfo = readContractInfo(files);
  if ("limit" in contractInfo) return empty("unchecked", contractInfo.limit);
  let circuitList: unknown[] = [];
  if ("info" in contractInfo && Array.isArray(contractInfo.info.circuits)) {
    circuitList = contractInfo.info.circuits;
    if (circuitList.length > MAX_CIRCUITS) {
      return empty("unchecked", `contract-info.json lists ${circuitList.length} circuits, over the ${MAX_CIRCUITS}-circuit limit; Level 2 was not run`);
    }
  }
  // The circuits the summary keeps — selected ONCE, for the argument budget and for the summary alike
  // (audit 02 E2-R9B: counting raw entries while summarising named ones let unnamed entries in front
  // hide an oversized circuit). The summary keeps every argument of each (E2-R7A), so their total is
  // bounded BEFORE anything is expanded (E2-R8A); beyond it this is a local limit, never a verdict.
  const named = circuitList
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object" && typeof (c as { name?: unknown }).name === "string");
  const kept = named.slice(0, MAX_SUMMARY_CIRCUITS);
  let argumentsTotal = 0;
  for (const c of kept) if (Array.isArray(c.arguments)) argumentsTotal += c.arguments.length;
  if (argumentsTotal > MAX_SUMMARY_ARGUMENTS) {
    return empty("unchecked", `contract-info.json declares ${argumentsTotal} circuit arguments, over the ${MAX_SUMMARY_ARGUMENTS}-argument limit; Level 2 was not run`);
  }

  const keys = shippedKeys(files);
  const rows: Level2Row[] = [];
  if (keys.size === 0) rows.push({ circuit: "(none)", status: "FAIL", reason: "the bundle ships no out/keys/*.verifier, so nothing can be checked" });
  for (const [name, key] of keys) {
    if ("error" in key) { rows.push({ circuit: name, status: "FAIL", reason: key.error }); continue; }
    const onChain = installed(name);
    if (onChain === undefined) { rows.push({ circuit: name, status: "FAIL", reason: "no verifier key on chain for this entry point", keySha256: sha256Hex(key) }); continue; }
    const ok = key.equals(Buffer.from(onChain));
    rows.push({ circuit: name, status: ok ? "OK" : "FAIL", ...(ok ? {} : { reason: "shipped key differs from the key on chain" }), keySha256: sha256Hex(key) });
  }
  if ("error" in contractInfo || !Array.isArray(contractInfo.info.circuits)) {
    rows.push({ circuit: "(contract-info)", status: "FAIL", reason: "error" in contractInfo ? contractInfo.error : "out/compiler/contract-info.json has no circuits array, so the published circuits cannot be checked" });
  }
  const opNames = new Set(entryPoints);
  for (const c of circuitList) {
    const name = (c as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || keys.has(name)) continue;
    if (opNames.has(name) || installed(name) !== undefined) {
      rows.push({ circuit: name, status: "FAIL", reason: "the bundle publishes this circuit and the chain has an entry point for it, but the bundle ships no verifier key for it" });
    }
  }
  const wrapper = wrapperBinding(files, keys);

  // The published circuits, for display (spec US1 scenario 4: "each circuit listed with its argument types").
  const maxval = maxvalOf;
  const rowOf = new Map(rows.map((r) => [r.circuit, r.status]));
  const circuits: CircuitSummary[] = kept
    .map((c) => {
      const name = c.name as string;
      const key = keys.get(name);
      return {
        // Names are identities: exact (bounded by the contract-info file cap), never clipped — two
        // circuits whose long names share a prefix stay two (audit 02 E2-R6A). Only rendered TYPES,
        // display labels, are clipped.
        name,
        pure: typeof c.pure === "boolean" ? c.pure : null,
        // Every argument, in order: a signature is what a consumer calls, so it is never cut short
        // (spec US1 scenario 4; audit 02 E2-R7A) — the contract-info file cap bounds it.
        arguments: (Array.isArray(c.arguments) ? c.arguments : []).map((a: unknown) => ({
          name: String((a as { name?: unknown } | null)?.name ?? ""),
          type: clip(renderType((a as { type?: unknown } | null)?.type, maxval)),
        })),
        resultType: clip(renderType(c["result-type"], maxval)),
        keySha256: key instanceof Buffer ? sha256Hex(key) : null,
        onChain: opNames.has(name),
        l2: rowOf.get(name) ?? null,
      };
    });
  const witnesses = "info" in contractInfo && Array.isArray(contractInfo.info.witnesses)
    ? (contractInfo.info.witnesses as unknown[]).slice(0, MAX_SUMMARY_CIRCUITS).map((w) => String((w as { name?: unknown } | null)?.name ?? w))
    : [];

  const failed = rows.find((r) => r.status === "FAIL");
  const outcome = failed === undefined && wrapper.ok ? "passed" : "failed";
  const reason = outcome === "passed"
    ? undefined
    : failed !== undefined
      ? `vk ${failed.circuit}: ${failed.reason ?? "FAIL"}`
      : wrapper.error ?? `wrapper expectedVk: ${wrapper.rows.filter((r) => r.status === "FAIL").map((r) => r.circuit).join(", ")} ${wrapper.rows.find((r) => r.status === "FAIL")?.reason ?? "does not match the shipped key"}`;
  return {
    outcome, ...(reason === undefined ? {} : { reason }), rows, wrapper, entryPoints, circuits,
    circuitsTruncated: named.length > MAX_SUMMARY_CIRCUITS, witnesses,
  };
}
