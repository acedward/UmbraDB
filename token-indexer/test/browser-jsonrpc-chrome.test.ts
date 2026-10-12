/**
 * The JSON RPC module in the static build's main page (`token-indexer/browser/index.html`) in Chrome: the build (Vite,
 * into a temporary folder; the engine never starts by itself; the network's indexer is this test's server) served from
 * 127.0.0.1 through the static host's handler (`dev/serve-browser.ts`) with its `_headers` (the Content-Security-Policy
 * with Trusted Types, cross-origin isolation), driven over the DevTools protocol (`helpers/cdp-browser.ts`). The
 * indexer's GraphQL route answers from the recorded indexer (`evm-rpc/test/recorded-indexer.ts`); Node's answers are
 * those of `npm run evm-rpc`'s server (`evm-rpc/server.ts`, the read-only methods, no database) over the same recorded
 * answers, in this process. Never Stagenet.
 *
 * - `[[browser.jsonrpc.tab]]` — JSON RPC is on by default: its Modules row is checked and switchable, with the roadmap's
 *   description and what it exposes now, and the JSON RPC tab is in the header; the tab lists every method of the
 *   module's registry and the Node-only methods in their groups, and each one chosen shows its name, source, group,
 *   summary, note and parameter fields as the model has them, the Node-only ones with no form and no Call; for every
 *   callable method the request the form makes from its example is the example's, and Call sends it and shows Node's
 *   answer (status, headers, body) — a result for each served method, `-32004` for each not-implemented one. No "no
 *   estimate" text anywhere on the page; no CSP violation, every request to the site.
 * - `[[browser.jsonrpc.page-structure]]` — the JSON RPC tab's page has the token explorer page's structure (header with
 *   the wordmark, rule, title and subtitle; sub-tabs, separator, strip and refresh button; banner; main view; footer)
 *   and its look (the same computed styles, part by part); its title, subtitle, sub-tabs and footer note (external
 *   wallets cannot connect to a page); the strip's figures are the module's state, and refresh reads it again.
 * - `[[browser.jsonrpc.routes]]` — the tab's view and method are in the URL's query, the token explorer's routes in its
 *   fragment: picking JSON RPC's sub-tabs and methods, back and forward, never changes the explorer's route or makes it
 *   draw again, and following the explorer's routes never changes JSON RPC's view; a reload or a shared URL opens the
 *   same view and method; a method the URL names that is not listed is ignored.
 * - `[[browser.jsonrpc.explorer]]` — the method list: its groups and counts, the search, the keyboard (arrows, Home, End,
 *   Escape, Enter); the form's typed fields (checked as typed, with their messages, a decimal number made a quantity, a
 *   block number, a block left out, a checkbox, percentiles) and the request they make, live; the JSON mode and back;
 *   copy as JSON and as `curl`; Ctrl+Enter calls; a Node-only method is described and never called; on a narrow
 *   screen the list is above the form.
 * - `[[browser.jsonrpc.next-calls]]` — the answer as a tree (quantities with their decimal value) or as text; a block
 *   number, a block hash and a transaction hash in an answer open and make the call that reads them, each answered as
 *   Node answers it; the history lists the page's calls newest first, opens one or runs it again (the same request but
 *   its id), survives a reload of the tab and can be cleared.
 * - `[[browser.jsonrpc.status]]` — the status view's figures, each equal to its source: the engine's `jsonrpc-state`
 *   answer, which itself equals the build's chain ID and indexer, Node's answers to `eth_chainId` and
 *   `web3_clientVersion`, the list's method counts, the tab's own calls (and one made beside it, read again by refresh
 *   and every 5 s), and an indexer error.
 * - `[[browser.jsonrpc.answers]]` — every `POST` case of the differential (every method, refused parameters, the
 *   not-implemented and unknown methods, the envelope, notifications, batches, bodies that are not JSON, the size cap,
 *   lone surrogates) sent as a `jsonrpc` request gets exactly Node's answer, as Node's server answers now and as
 *   recorded (`evm-rpc/test/fixtures/node-answers.json`; the client version aside, which is the build's); a request the protocol refuses (no body, a body over its
 *   bound) is answered `bad-request`.
 * - `[[browser.jsonrpc.hostile]]` — hostile text (control, bidi, zero-width and markup characters) in parameters written
 *   as JSON, in the parser's message about parameters that are not JSON, in a form field, in the history read back from
 *   storage, and in an indexer answer is drawn as text: the request, the message and the history with visible marks,
 *   the indexer's text never passed on (the module answers `-32603`); parameters nested too deep are refused with a
 *   message and cannot be called; nothing comes alive, nothing throws and no raw hidden character is drawn.
 * - `[[browser.jsonrpc.editor-bounds]]` — the editor's paths keep the JSON text's bounds: parameters nested too deep
 *   are refused in JSON mode and never reach the form (the form keeps its values and says why, nothing throws); a form
 *   field longer than the parameters may be is refused (no request, no `curl` line, Call disabled, nothing long drawn);
 *   at the bound, the request is sent and its `curl` line (four characters per quote) is shown cut and copied whole.
 * - `[[browser.jsonrpc.concurrent-calls]]` — Call on a slow method and then on a fast one: each answer is kept with its
 *   method, the slow one shown while it is awaited and once it comes, never over the other's, and the call reported as
 *   the last is the last one made.
 * - `[[browser.jsonrpc.module-switch]]` — JSON RPC switched off from its checkbox: saved with the settings, its tab gone
 *   (a URL naming it shows the overview), `jsonrpc` requests refused `module-off`; a second tab shows the same and is
 *   refused through the leader; the choice holds when the leader closes (the next leader's worker) and after a reload;
 *   on again, the tab is back and the answers are Node's.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `MIP0018_UI_SCREENSHOTS=<dir>` saves PNGs (never committed).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMinIntervalMs } from "../../chain-archive-sync/polite-http.js";
import { emptyEvmRpcReader } from "../../evm-rpc/db.js";
import { IndexerGqlClient } from "../../evm-rpc/indexer-gql.js";
import { NOT_IMPLEMENTED_METHODS } from "../../evm-rpc/methods/not-implemented.js";
import { registerReadOnlyMethods } from "../../evm-rpc/read-only.js";
import { MethodRegistry } from "../../evm-rpc/registry.js";
import { createRpcServer } from "../../evm-rpc/server.js";
import { differentialCases } from "../../evm-rpc/test/differential-cases.js";
import { handlerAnswer, loadRecording, sendToServer } from "../../evm-rpc/test/node-answers.js";
import { BLOCK_HASH, HEIGHT, recordedIndexerAnswer, recordedIndexerFetch, TX_HASH } from "../../evm-rpc/test/recorded-indexer.js";
import {
  answerText,
  curlCommand,
  filterRows,
  HISTORY_KEY,
  JSONRPC_SUBTITLE,
  JSONRPC_TAB_NOTE,
  JSONRPC_TITLE,
  KIND_HINTS,
  MAX_PARAMS_CHARS,
  MAX_SHOWN_CHARS,
  METHOD_GROUPS,
  methodRows,
  requestFor,
  SOURCE_LEGEND,
  statusFigures,
  stripParts,
} from "../browser/jsonrpc-model.ts";
import { JSONRPC_CHAIN_ID, jsonRpcClientVersion } from "../browser/jsonrpc-module.ts";
import { INDEXER_MODULES } from "../browser/modules.ts";
import type { ApiResult, HostStatus, JsonRpcStateResult } from "../browser/protocol.ts";
import { visibleText } from "../browser/visible-text.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { BROWSER_CONFIG } from "./helpers/engine-site.ts";
import { type HeaderRule, type LocalServer, parseHeadersFile, serveStaticSite } from "./helpers/static-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SHOTS = process.env.MIP0018_UI_SCREENSHOTS;
// Raw characters that must never reach the drawn text (tab and newline excepted in innerText) or an attribute.
const HIDDEN_RAW = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const HIDDEN_RAW_ATTR = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

const browserExe = findBrowser();

interface Answer {
  status: number;
  headers: [string, string][];
  body: string;
}

const asAnswer = (r: ApiResult): Answer => ({ status: r.status, headers: Object.entries(r.headers), body: r.body });

/** The JSON RPC tab's state (`window.umbradbOverview.jsonrpc()`). */
const RPC = "window.umbradbOverview.jsonrpc()";

/** The method list as drawn: each group with its label, its count and its methods shown. */
const LIST = `[...document.querySelectorAll('#rpc-view .rpc-group')].map((g) => ({ group: g.getAttribute('data-group'),
  label: g.querySelector('h2').firstChild.textContent, count: g.querySelector('[data-field=rpc-group-count]').textContent.trim(), hidden: g.hidden,
  methods: [...g.querySelectorAll('a.rpc-method')].filter((a) => !a.parentElement.hidden).map((a) => [a.textContent, a.getAttribute('data-kind')]) }))`;
interface ListGroup { group: string; label: string; count: string; hidden: boolean; methods: [string, string][] }

/** The chosen method as drawn. */
const DETAIL = `(() => {
  const d = document.querySelector('[data-field=rpc-detail]');
  const t = (f) => d.querySelector('[data-field=' + f + ']')?.textContent ?? null;
  const shown = (f) => { const v = t(f); return v === '' ? null : v; };
  return { method: t('rpc-method-name'), source: t('rpc-source'), group: t('rpc-group'), summary: t('rpc-summary'), note: t('rpc-method-note'),
    nodeOnly: t('rpc-node-only'), call: d.querySelector('[data-action=rpc-call]') !== null, form: d.querySelector('[data-field=rpc-form]') !== null,
    raw: d.querySelector('[data-input=rpc-raw]')?.value ?? null,
    fields: [...d.querySelectorAll('.rpc-field')].map((f) => ({ kind: f.getAttribute('data-kind'), label: f.querySelector('label').textContent,
      error: f.querySelector('[data-field=rpc-param-error]').textContent, invalid: f.querySelector('#' + f.querySelector('label').htmlFor).getAttribute('aria-invalid') })),
    preview: shown('rpc-preview'), requestError: shown('rpc-request-error'), curl: shown('rpc-curl'), modeNote: shown('rpc-mode-note'),
    callDisabled: d.querySelector('[data-action=rpc-call]')?.disabled ?? null };
})()`;
interface Detail {
  method: string; source: string; group: string; summary: string; note: string | null; nodeOnly: string | null; call: boolean; form: boolean; raw: string | null;
  fields: Array<{ kind: string; label: string; error: string; invalid: string | null }>; preview: string | null; requestError: string | null; curl: string | null;
  modeNote: string | null; callDisabled: boolean | null;
}

/** The chosen method's answer as drawn. */
const PANE = `(() => {
  const p = document.querySelector('[data-field=rpc-answer-pane]');
  if (p === null) return null;
  const t = (f) => p.querySelector('[data-field=' + f + ']')?.textContent ?? null;
  const text = p.querySelector('[data-field=rpc-answer]');
  const tree = p.querySelector('[data-field=rpc-tree]');
  return { status: t('rpc-status'), time: t('rpc-time'), id: t('rpc-answer-id'), answer: text === null ? null : text.textContent, textShown: text !== null && !text.hidden,
    error: t('rpc-error'), pending: t('rpc-pending'), tree: tree !== null && !tree.hidden, none: t('rpc-no-answer') };
})()`;
interface Pane { status: string | null; time: string | null; id: string | null; answer: string | null; textShown: boolean; error: string | null; pending: string | null; tree: boolean; none: string | null }

/** The structure of a module page (`panel`'s children): tags, classes, roles and live regions, down to the parts whose
 *  content is the module's own (the wordmark, title, subtitle, links, strip, button, banner, view and footer). The
 *  explorer's refresh button is `#now`, a module page's `.now`: their look is compared, not their names. */
const SIGNATURE = (panel: string): string => `(() => {
  const sig = (e) => {
    const tag = e.tagName.toLowerCase();
    let s = tag + [...e.classList].filter((c) => c !== 'on' && c !== 'now').sort().map((c) => '.' + c).join('');
    for (const a of ['role', 'aria-live']) if (e.hasAttribute(a)) s += '[' + a + '=' + e.getAttribute(a) + ']';
    const leaf = ['svg', 'main', 'footer', 'h1', 'a', 'button'].includes(tag) || e.classList.contains('banner') || e.classList.contains('strip') || e.classList.contains('sub') || e.children.length === 0;
    return leaf ? s : { [s]: [...e.children].map(sig) };
  };
  return [...document.getElementById(${JSON.stringify(panel)}).children].map(sig);
})()`;

/** The look of a module page's parts (computed styles), the banner shown for the reading. */
const LOOK = (panel: string): string => `(() => {
  const root = document.getElementById(${JSON.stringify(panel)});
  const q = (sel) => root.querySelector(sel);
  const st = (e, props) => { const c = getComputedStyle(e); return Object.fromEntries(props.map((p) => [p, c.getPropertyValue(p)])); };
  const banner = q(':scope > .banner');
  const was = banner.hidden;
  banner.hidden = false;
  const out = {
    header: st(q(':scope > header'), ['padding-top', 'padding-right', 'padding-left', 'background-color', 'border-bottom-width', 'border-bottom-style', 'border-bottom-color']),
    brand: st(q(':scope > header > .brand'), ['display', 'column-gap', 'align-items']),
    logo: st(q(':scope > header > .brand > svg'), ['display']),
    rule: st(q(':scope > header > .brand > .rule'), ['display']),
    h1: st(q(':scope > header h1'), ['font-size', 'font-weight', 'color', 'margin-top', 'letter-spacing']),
    sub: st(q(':scope > header .sub'), ['font-size', 'font-weight', 'color']),
    nav: st(q(':scope > header > nav.tabs'), ['display', 'column-gap', 'padding-top', 'flex-wrap', 'align-items']),
    link: st(q(':scope > header > nav.tabs > a:not(.on)'), ['padding-top', 'padding-left', 'color', 'font-weight', 'text-decoration-line', 'border-bottom-width', 'border-bottom-color']),
    on: st(q(':scope > header > nav.tabs > a.on'), ['color', 'border-bottom-color', 'border-bottom-width']),
    sep: st(q(':scope > header > nav.tabs > .sep'), ['flex-grow']),
    strip: st(q(':scope > header > nav.tabs > .strip'), ['font-size', 'color', 'white-space', 'margin-right']),
    refresh: st(q(':scope > header > nav.tabs > button'), ['background-color', 'color', 'border-top-color', 'font-size', 'font-weight', 'padding-top', 'padding-left']),
    banner: st(banner, ['margin-top', 'margin-left', 'padding-top', 'border-top-color', 'background-color', 'color', 'font-size', 'white-space']),
    main: st(q(':scope > main'), ['padding-top', 'padding-left', 'display', 'row-gap']),
    footer: st(q(':scope > footer'), ['padding-left', 'padding-bottom', 'color', 'font-size', 'max-width']),
  };
  banner.hidden = was;
  return out;
})()`;

/** The status view's figures as drawn: field, label, value, whether marked bad. */
const FIGURES = `[...document.querySelectorAll('[data-field=rpc-status-view] .kv .v')].map((v) => [v.getAttribute('data-field'), v.previousElementSibling.textContent, v.textContent, v.hasAttribute('data-bad')])`;

/** The history as drawn: method, parameters, outcome. */
const HISTORY = `[...document.querySelectorAll('[data-field=rpc-history-row]')].map((tr) => [...tr.querySelectorAll('td')].slice(1, 4).map((td) => td.textContent))`;

describe("the JSON RPC module in the static build in Chrome (served with its headers)", () => {
  let out: string;
  let site: LocalServer;
  const headerRules: HeaderRule[] = [];
  /** What the indexer's GraphQL route answers. */
  let indexer: (body: string) => { status: number; body: string } = recordedIndexerAnswer;
  let indexerRequests = 0;
  /** How long the indexer's route waits before it answers. */
  let indexerDelayMs = 0;
  let node: Server;
  let nodePort: number;
  const rows = methodRows();

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    out = mkdtempSync(join(tmpdir(), "umbradb-jsonrpc-build-"));
    site = await serveStaticSite(out, {
      headers: headerRules,
      route: (req, res, url) => {
        if (!url.pathname.startsWith("/chain/")) return false;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          if (url.pathname !== "/chain/graphql") {
            res.writeHead(503, { "content-type": "text/plain" }).end("down");
            return;
          }
          indexerRequests += 1;
          const a = indexer(Buffer.concat(chunks).toString("utf8"));
          setTimeout(() => res.writeHead(a.status, { "content-type": "application/json" }).end(a.body), indexerDelayMs);
        });
        return true;
      },
    });
    // The build's chain: this site's routes (the build admits their origin, its own, in `connect-src`).
    const env = { node: process.env.UMBRADB_BROWSER_NODE_URL, indexer: process.env.UMBRADB_BROWSER_INDEXER_URL };
    process.env.UMBRADB_BROWSER_NODE_URL = `${site.origin}/chain/rpc`;
    process.env.UMBRADB_BROWSER_INDEXER_URL = `${site.origin}/chain/graphql`;
    try {
      const { build } = await import("vite");
      await build({ logLevel: "silent", configFile: BROWSER_CONFIG, define: { __UMBRADB_BROWSER_CONFIG__: JSON.stringify({ autoStart: false }) }, build: { outDir: out, emptyOutDir: true } });
    } finally {
      for (const [k, v] of [["UMBRADB_BROWSER_NODE_URL", env.node], ["UMBRADB_BROWSER_INDEXER_URL", env.indexer]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    headerRules.push(...parseHeadersFile(readFileSync(join(out, "_headers"), "utf8")));

    // `npm run evm-rpc` without a database, over the same indexer answers.
    const registry = new MethodRegistry();
    registerReadOnlyMethods(registry);
    node = createRpcServer({
      registry,
      ctx: {
        chainId: JSONRPC_CHAIN_ID,
        clientVersion: jsonRpcClientVersion(PACKAGE_VERSION),
        indexer: new IndexerGqlClient({ url: "http://indexer.test/graphql", fetchImpl: recordedIndexerFetch().fetch }),
        db: emptyEvmRpcReader,
      },
    });
    for (let attempt = 0; ; attempt++) {
      const port = 10_000 + Math.floor(Math.random() * 50_000);
      const ok = await new Promise<boolean>((done) => {
        node.once("error", () => done(false));
        node.listen(port, "127.0.0.1", () => done(true));
      });
      if (ok) {
        nodePort = (node.address() as AddressInfo).port;
        break;
      }
      if (attempt > 20) throw new Error("no free port at or above 10000 on 127.0.0.1");
    }
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((r) => (node === undefined ? r() : node.close(() => r())));
    await site?.close();
    if (out !== undefined) rmSync(out, { recursive: true, force: true });
  });

  /** Node's answer to a `POST` with `body` (a connection of its own; a failure names the request). */
  async function nodeAnswer(body: string): Promise<Answer> {
    const a = await sendToServer(nodePort, "POST", body);
    return { status: a.status, headers: a.headers, body: a.body.toString("utf8") };
  }

  const on = (p: Page) => (expr: string): Promise<Json> => p.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
  const status = (p: Page): Promise<HostStatus> => on(p)("c.status()");
  const engineState = (p: Page): Promise<JsonRpcStateResult> => on(p)(`c.request("jsonrpc-state", {})`);
  /** The engine's answer to a `jsonrpc` request, or its refusal as `{ refused: code }`. */
  const viaEngine = (p: Page, body: string): Promise<ApiResult | { refused: string; message: string }> =>
    on(p)(`c.request("jsonrpc", { body: ${JSON.stringify(body)} }).catch((e) => ({ refused: e.code, message: e.message }))`);

  async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await read();
      if (ok(v)) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 1200)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Opens `path` in a new tab of `b`, in a window of its own (visible), and waits for the engine's boot. */
  async function open(b: Browser, path: string): Promise<Page> {
    const p = await b.newPage({ workers: true, newWindow: true });
    await p.goto(`${site.origin}${path}`, 30_000, async () => {
      await p.waitFor("window.umbradbEngine !== undefined && window.umbradbOverview !== undefined", 30_000, "the main page");
      await p.eval("window.umbradbEngine.tabs.ready");
      expect(await p.eval("window.umbradbEngine.client.booted()")).toMatchObject({ phase: "ready", error: null });
    });
    return p;
  }

  async function reload(p: Page): Promise<void> {
    const href = await p.eval<string>("location.href");
    await p.goto("about:blank");
    await p.goto(href);
    await p.waitFor("window.umbradbEngine !== undefined && window.umbradbOverview !== undefined", 30_000, "the main page again");
    expect(await p.eval("window.umbradbEngine.client.booted()")).toMatchObject({ phase: "ready" });
  }

  async function clean(p: Page, worker: boolean): Promise<void> {
    expect(await p.eval("window.__cspViolations")).toEqual([]);
    if (worker && p.workers.some((w) => w.running)) expect(await p.evalWorker("self.__cspViolations")).toEqual([]);
    expect(p.logs.filter((l) => /Content Security Policy|Trusted Type|content security/i.test(l.text))).toEqual([]);
    expect(p.exceptions).toEqual([]);
    expect(p.console.filter((c) => c.type === "error" || c.type === "assert")).toEqual([]);
    expect(p.requests.filter((r) => !r.url.startsWith(`${site.origin}/`) && !r.url.startsWith("blob:") && !r.url.startsWith("data:")).map((r) => r.url)).toEqual([]);
  }

  async function shot(p: Page, name: string): Promise<void> {
    if (SHOTS === undefined || SHOTS === "") return;
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, name), await p.screenshot());
  }

  /** Chooses `method` in the list (a click) and waits for its detail. */
  async function pick(p: Page, method: string): Promise<Detail> {
    await p.eval(`document.querySelector('a.rpc-method[data-method=${JSON.stringify(method)}]').click()`);
    await p.waitFor(`${RPC}.method === ${JSON.stringify(method)} && document.querySelector('[data-field=rpc-method-name]')?.textContent === ${JSON.stringify(method)}`, 10_000, `${method} chosen`);
    return p.eval<Detail>(DETAIL);
  }

  /** Waits for the call numbered over `before` on `method` to be answered, and returns its answer as drawn. */
  async function answered(p: Page, method: string, before: number): Promise<Pane> {
    await p.waitFor(`(() => { const j = ${RPC}; return j.calls > ${before} && j.byMethod[${JSON.stringify(method)}]?.pending === false && j.method === ${JSON.stringify(method)}; })()`, 30_000, `the answer to ${method}`);
    return (await p.eval<Pane>(PANE))!;
  }

  /** Clicks Call on the chosen method (`method`, chosen first when given) and waits for its answer. */
  async function callFromTab(p: Page, method?: string): Promise<Pane> {
    if (method !== undefined) await pick(p, method);
    const m = await p.eval<string>(`${RPC}.method`);
    const before = await p.eval<number>(`${RPC}.calls`);
    await p.eval("document.querySelector('[data-field=rpc-detail] [data-action=rpc-call]').click()");
    return answered(p, m, before);
  }

  /** Sets the form's field `i` (its text, its block choice) as typing does. */
  const setField = (p: Page, i: number, value: string, input = "rpc-param"): Promise<void> =>
    p.eval(`(() => { const box = document.querySelector('.rpc-field[data-param="${i}"]'); const e = ${input === "rpc-param" ? `box.querySelector('#rpc-param-${i}')` : `box.querySelector('[data-input=${input}]')`};
      e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
  /** Sets the JSON mode's text as typing does. */
  const setRaw = (p: Page, text: string): Promise<void> =>
    p.eval(`(() => { const t = document.querySelector('[data-input=rpc-raw]'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  /** A key pressed on the focused element (`modifiers`: 2 Ctrl). */
  async function key(p: Page, name: string, keyCode: number, modifiers = 0): Promise<void> {
    await p.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: name, windowsVirtualKeyCode: keyCode, modifiers });
    await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: keyCode, modifiers });
  }
  const focused = (p: Page): Promise<string | null> => p.eval("document.activeElement?.getAttribute('data-method') ?? document.activeElement?.id ?? null");
  /** The request the chosen method's editor makes now (parsed), or `null`. */
  const previewOf = async (p: Page): Promise<Json> => {
    const body = await p.eval<string | null>(`${RPC}.preview`);
    return body === null ? null : JSON.parse(body);
  };

  it("[[browser.jsonrpc.tab]] on by default: the Modules row and the tab; every method listed in its groups and shown as the model has it; each callable method's example makes the example's request and Call shows Node's answer; no 'no estimate' text; no CSP violation", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html");
      const jsonrpcModule = INDEXER_MODULES.find((m) => m.id === "jsonrpc")!;
      expect(jsonrpcModule.engineModule).toBe("jsonrpc");
      await p.waitFor("document.getElementById('module-jsonrpc').disabled === false", 30_000, "the JSON RPC switch");
      expect(await p.eval(`(() => { const tr = document.querySelector('#modules tr[data-module=jsonrpc]'); const box = tr.querySelector('input[type=checkbox]');
        return { checked: box.checked, disabled: box.disabled, state: tr.getAttribute('data-state'), description: tr.querySelector('[data-field=module-description]').textContent,
          now: tr.querySelector('[data-field=module-now]').textContent }; })()`)).toEqual({
        checked: true, disabled: false, state: "on", description: jsonrpcModule.description, now: jsonrpcModule.now,
      });
      expect(await p.eval("[...document.querySelectorAll('header.product nav a')].map((a) => [a.id, a.textContent, a.getAttribute('href'), a.hidden])")).toEqual([
        ["tab-overview", "Overview", "?tab=overview", false],
        ["tab-tokens", "Token Indexer", "?tab=tokens", false],
        ["tab-jsonrpc", "JSON RPC", "?tab=jsonrpc", false],
        ["tab-database", "Database", "?tab=database", false],
        ["system-link", "system status", "./system.html", false],
      ]);
      await p.eval("document.getElementById('tab-jsonrpc').click()");
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'jsonrpc'", 15_000, "the JSON RPC tab");
      expect(await p.eval("[location.search, document.title]")).toEqual(["?tab=jsonrpc", "UmbraDB JSON RPC"]);
      expect(await p.eval("document.querySelector('#tab-panel-jsonrpc > footer').textContent")).toBe(JSONRPC_TAB_NOTE);
      expect(await p.eval("document.querySelector('[data-field=rpc-legend]').textContent")).toBe(SOURCE_LEGEND);

      // Every method, in its group: the registry's (the build's own) and the Node-only ones, as the model lists them.
      const groups = METHOD_GROUPS.map((g) => ({ g, members: rows.filter((r) => r.group === g.id) })).filter((x) => x.members.length > 0);
      expect(await p.eval<ListGroup[]>(LIST)).toEqual(groups.map(({ g, members }) => ({ group: g.id, label: g.label, count: String(members.length), hidden: false, methods: members.map((r) => [r.method, r.kind]) })));
      expect(rows.filter((r) => r.kind === "node-only").map((r) => r.method)).toEqual(["eth_getLogs", "eth_sendRawTransaction", "eth_subscribe", "eth_unsubscribe"]);
      expect(rows.filter((r) => r.kind === "not-implemented").length).toBe(NOT_IMPLEMENTED_METHODS.length);

      // Each method chosen: as the model has it. Each callable one: its example's request; Call sends it; Node's answer.
      let served = 0;
      let stubs = 0;
      for (const row of rows) {
        const d = await pick(p, row.method);
        const groupLabel = METHOD_GROUPS.find((g) => g.id === row.group)!.label;
        expect({ method: d.method, source: d.source, group: d.group, summary: d.summary, note: d.note, call: d.call, form: d.form }, row.method).toEqual({
          method: row.method, source: row.source, group: groupLabel === row.source ? null : groupLabel, summary: row.summary, note: row.note, call: row.callable, form: row.callable,
        });
        expect(d.fields.map((f) => [f.kind, f.label]), row.method).toEqual(row.paramSpecs.map((s) => [s.kind, `${s.name}${s.optional === true ? " (optional)" : ""}`]));
        if (!row.callable) {
          expect(d.nodeOnly, row.method).toMatch(/^Served by Node only/);
          expect(await p.eval(`${RPC}.preview`)).toBeNull();
          continue;
        }
        const nextId = await p.eval<number>(`${RPC}.nextId`);
        const expected = requestFor(nextId, row.method, row.example);
        expect(expected.ok).toBe(true);
        if (!expected.ok) continue;
        expect(await p.eval(`${RPC}.preview`), row.method).toBe(expected.body);
        expect(d.preview, row.method).toBe(expected.text);
        expect(d.curl, row.method).toBe(curlCommand(expected.body));
        const pane = await callFromTab(p);
        const call = (await p.eval<Json>(`${RPC}.latest`)) as { method: string; body: string; answer: ApiResult; error: string | null };
        expect([call.method, call.body, call.error], row.method).toEqual([row.method, expected.body, null]);
        expect(asAnswer(call.answer), row.method).toEqual(await nodeAnswer(call.body));
        const shown = answerText(call.answer);
        expect({ status: pane.status, answer: pane.answer, error: pane.error, pending: pane.pending, tree: pane.tree, id: pane.id }, row.method).toEqual({
          status: shown.status, answer: shown.text, error: null, pending: null, tree: true, id: `request id ${nextId}`,
        });
        expect(pane.time, row.method).toMatch(/^\d+ ms$/);
        const parsed = JSON.parse(call.answer.body) as { result?: unknown; error?: { code: number } };
        if (row.kind === "served") {
          expect(parsed.error, row.method).toBeUndefined();
          served++;
        } else {
          expect(parsed.error?.code, row.method).toBe(-32004);
          stubs++;
        }
      }
      expect([served, stubs]).toEqual([rows.filter((r) => r.kind === "served").length, NOT_IMPLEMENTED_METHODS.length]);
      expect(indexerRequests).toBeGreaterThan(0);
      // No "no estimate" text anywhere on the page, every tab included.
      expect(await p.eval<string>("document.body.textContent")).not.toContain("no estimate");
      await shot(p, "jsonrpc-tab.png");
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 600_000);

  it("[[browser.jsonrpc.page-structure]] the JSON RPC tab's page has the token explorer page's structure and look: header, sub-tabs, strip and refresh, banner, view, footer; its strip is the module's state", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html?tab=tokens");
      await p.waitFor("document.getElementById('nav-list').className === 'on'", 30_000, "the explorer's list");
      const explorer = { signature: await p.eval(SIGNATURE("tab-panel-tokens")), look: await p.eval(LOOK("tab-panel-tokens")) };
      await p.eval("document.getElementById('tab-jsonrpc').click()");
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'jsonrpc' && document.getElementById('rpc-strip').textContent.startsWith('module ')", 15_000, "the JSON RPC tab and its strip");
      const page = { signature: await p.eval(SIGNATURE("tab-panel-jsonrpc")), look: await p.eval(LOOK("tab-panel-jsonrpc")) };
      expect(page.signature).toEqual(explorer.signature);
      expect(page.signature).toEqual([
        { header: [{ "div.brand": ["svg", "span.rule", "h1", "span.sub"] }, { "nav.tabs": ["a", "a", "span.sep", "span.strip", "button"] }] },
        "div.banner[role=alert]",
        "main[aria-live=polite]",
        "footer.foot",
      ]);
      expect(page.look).toEqual(explorer.look);
      expect(page.look.logo.display).toBe("none");
      expect(page.look.refresh["background-color"]).not.toBe("rgba(0, 0, 0, 0)");

      // Its own words.
      expect(await p.eval(`(() => { const h = document.querySelector('#tab-panel-jsonrpc > header');
        return [h.querySelector('h1').textContent, h.querySelector('.sub').textContent, [...h.querySelectorAll('nav.tabs > a')].map((a) => [a.id, a.textContent, a.className]),
          h.querySelector('nav.tabs > button').textContent, document.querySelector('#tab-panel-jsonrpc > .banner').hidden, document.querySelector('#tab-panel-jsonrpc > footer').textContent]; })()`)).toEqual([
        JSONRPC_TITLE, JSONRPC_SUBTITLE, [["rpc-nav-methods", "methods", "on"], ["rpc-nav-status", "status", ""]], "refresh", true, JSONRPC_TAB_NOTE,
      ]);
      expect(JSONRPC_TITLE).toBe("JSON-RPC explorer");
      expect(JSONRPC_SUBTITLE).toBe("Ethereum-style eth_* endpoints over Midnight");
      expect(JSONRPC_TAB_NOTE).toContain("External wallets cannot connect to a page");

      // The strip: the module's state; refresh reads it again.
      const strip = (s: JsonRpcStateResult): string => stripParts(s).map((x) => `${x.label} ${x.value}`).join("  ·  ");
      expect(await p.eval("document.getElementById('rpc-strip').textContent")).toBe(strip(await engineState(p)));
      expect(await p.eval("[...document.querySelectorAll('#rpc-strip b')].map((e) => e.textContent)")).toEqual(stripParts(await engineState(p)).map((x) => x.value));
      expect(JSON.parse(((await viaEngine(p, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }))) as ApiResult).body)).toMatchObject({ result: "0x960" });
      await p.eval("document.getElementById('rpc-now').click()");
      await p.waitFor("document.getElementById('rpc-strip').textContent.includes('answered 1')", 10_000, "the strip read again");
      expect(await p.eval("document.getElementById('rpc-strip').textContent")).toBe(strip(await engineState(p)));
      await shot(p, "jsonrpc-structure.png");
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 180_000);

  it("[[browser.jsonrpc.routes]] the tab's view and method in the URL's query, the explorer's route in its fragment: neither disturbs the other; reloads and shared URLs open the same view and method", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      // The explorer on its status route.
      const p = await open(b, "/index.html#/status");
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'tokens' && document.getElementById('nav-status').className === 'on'", 30_000, "the explorer's status");
      const where = (): Promise<[string, string, string]> => p.eval("[location.search, location.hash, document.body.getAttribute('data-tab-shown')]");
      const rpcView = (): Promise<[string, boolean, boolean, string]> =>
        p.eval(`[${RPC}.view, document.querySelector('[data-field=rpc-methods-view]').hidden, document.querySelector('[data-field=rpc-status-view]').hidden, document.querySelector('#tab-panel-jsonrpc nav.tabs a.on').id]`);
      const renders = (): Promise<string | null> => p.eval("document.body.getAttribute('data-renders')");

      await p.eval("document.getElementById('tab-jsonrpc').click()");
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'jsonrpc'", 10_000, "the JSON RPC tab");
      const drawn = await renders();
      expect(await where()).toEqual(["?tab=jsonrpc", "#/status", "jsonrpc"]);
      expect(await rpcView()).toEqual(["methods", false, true, "rpc-nav-methods"]);

      // JSON RPC's sub-tabs: a new history entry each, the explorer's route untouched and not drawn again.
      await p.eval("document.getElementById('rpc-nav-status').click()");
      expect(await where()).toEqual(["?tab=jsonrpc&rpc=status", "#/status", "jsonrpc"]);
      expect(await rpcView()).toEqual(["status", true, false, "rpc-nav-status"]);
      await p.eval("history.back()");
      await p.waitFor(`${RPC}.view === 'methods'`, 10_000, "back to the methods");
      expect(await where()).toEqual(["?tab=jsonrpc", "#/status", "jsonrpc"]);
      expect(await rpcView()).toEqual(["methods", false, true, "rpc-nav-methods"]);
      await p.eval("history.forward()");
      await p.waitFor(`${RPC}.view === 'status'`, 10_000, "forward to the status");
      expect(await rpcView()).toEqual(["status", true, false, "rpc-nav-status"]);
      expect(await renders()).toBe(drawn);

      // The explorer's routes: JSON RPC's view stays.
      await p.eval("document.getElementById('tab-tokens').click()");
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'tokens'", 10_000, "the Token Indexer tab");
      expect(await where()).toEqual(["?tab=tokens&rpc=status", "#/status", "tokens"]);
      expect(await p.eval("document.getElementById('nav-status').className")).toBe("on");
      await p.eval("document.getElementById('nav-list').click()");
      await p.waitFor("location.hash === '#/' && document.getElementById('nav-list').className === 'on'", 10_000, "the explorer's list");
      expect(await where()).toEqual(["?tab=tokens&rpc=status", "#/", "tokens"]);
      await p.eval("document.getElementById('tab-jsonrpc').click()");
      await p.waitFor("document.body.getAttribute('data-tab-shown') === 'jsonrpc'", 10_000, "the JSON RPC tab again");
      expect(await rpcView()).toEqual(["status", true, false, "rpc-nav-status"]);
      expect(await where()).toEqual(["?tab=jsonrpc&rpc=status", "#/", "jsonrpc"]);

      // A method chosen: in the URL (replacing the entry), the fragment kept.
      await p.eval("document.getElementById('rpc-nav-methods').click()");
      await pick(p, "eth_getBalance");
      expect(await where()).toEqual(["?tab=jsonrpc&rpc=methods&rpc-method=eth_getBalance", "#/", "jsonrpc"]);
      await pick(p, "eth_call");
      expect(await where()).toEqual(["?tab=jsonrpc&rpc=methods&rpc-method=eth_call", "#/", "jsonrpc"]);
      expect(await p.eval("document.getElementById('rpc-nav-status').href")).toBe(`${site.origin}/index.html?tab=jsonrpc&rpc=status&rpc-method=eth_call#/`);
      await p.eval("history.back()");
      await p.waitFor(`${RPC}.view === 'status'`, 10_000, "back to the status");
      expect(await where()).toEqual(["?tab=jsonrpc&rpc=status", "#/", "jsonrpc"]);

      // A shared URL: the view and the method it names.
      await p.goto(`${site.origin}/index.html?tab=jsonrpc&rpc=status&rpc-method=eth_getBalance#/status`);
      await p.waitFor("window.umbradbOverview !== undefined", 30_000, "the shared URL");
      expect(await rpcView()).toEqual(["status", true, false, "rpc-nav-status"]);
      expect(await p.eval(`${RPC}.method`)).toBe("eth_getBalance");
      await p.eval("document.getElementById('rpc-nav-methods').click()");
      expect(await p.eval("document.querySelector('[data-field=rpc-method-name]').textContent")).toBe("eth_getBalance");
      expect(await where()).toEqual(["?tab=jsonrpc&rpc=methods&rpc-method=eth_getBalance", "#/status", "jsonrpc"]);
      // A reload keeps it.
      await reload(p);
      expect([await p.eval(`${RPC}.view`), await p.eval(`${RPC}.method`), ...(await where())]).toEqual(["methods", "eth_getBalance", "?tab=jsonrpc&rpc=methods&rpc-method=eth_getBalance", "#/status", "jsonrpc"]);
      // A method the URL names that is not listed: ignored.
      await p.goto(`${site.origin}/index.html?tab=jsonrpc&rpc-method=%3Cimg%20src%3Dx%3E`);
      await p.waitFor("window.umbradbOverview !== undefined", 30_000, "the URL with an unknown method");
      expect(await p.eval(`${RPC}.method`)).toBe(rows[0]!.method);
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 180_000);

  it("[[browser.jsonrpc.explorer]] the list, its search and its keyboard; the typed fields and their messages; the request, live; JSON mode; copy as JSON and curl; Ctrl+Enter; a Node-only method never called; the narrow layout", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html?tab=jsonrpc");
      expect(await p.eval("document.querySelector('[data-field=rpc-list-count]').textContent")).toBe(`${rows.length} methods`);

      // The search: the model's matches, groups without one hidden.
      const searchFor = async (q: string): Promise<ListGroup[]> => {
        await p.eval(`(() => { const s = document.getElementById('rpc-search'); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event('input')); })()`);
        return p.eval<ListGroup[]>(LIST);
      };
      for (const q of ["block hash", "PG:", "receipt indexer", "nothing like this"]) {
        const want = filterRows(rows, q);
        const list = await searchFor(q);
        expect(list.flatMap((g) => g.methods.map((m) => m[0])), q).toEqual(want.map((r) => r.method));
        for (const g of list) expect([g.group, g.hidden, g.count], q).toEqual([g.group, !want.some((r) => r.group === g.group), String(want.filter((r) => r.group === g.group).length)]);
        expect(await p.eval("document.querySelector('[data-field=rpc-list-count]').textContent"), q).toBe(want.length === 0 ? `no method matches (of ${rows.length})` : `${want.length} of ${rows.length} methods`);
      }
      await searchFor("");

      // The keyboard: typing in the search, the arrows, Home, End, Escape, Enter.
      await p.eval("document.getElementById('rpc-search').focus()");
      await p.send("Input.insertText", { text: "transaction" });
      const matches = filterRows(rows, "transaction").map((r) => r.method);
      expect(matches.length).toBeGreaterThan(3);
      await key(p, "ArrowDown", 40);
      expect([await focused(p), await p.eval(`${RPC}.method`)]).toEqual([matches[0], matches[0]]);
      await key(p, "ArrowDown", 40);
      await key(p, "ArrowDown", 40);
      expect([await focused(p), await p.eval(`${RPC}.method`)]).toEqual([matches[2], matches[2]]);
      await key(p, "ArrowUp", 38);
      expect(await focused(p)).toBe(matches[1]);
      await key(p, "End", 35);
      expect([await focused(p), await p.eval(`${RPC}.method`)]).toEqual([matches.at(-1), matches.at(-1)]);
      expect(await p.eval("new URLSearchParams(location.search).get('rpc-method')")).toBe(matches.at(-1));
      await key(p, "Home", 36);
      expect(await focused(p)).toBe(matches[0]);
      await key(p, "Escape", 27);
      expect(await focused(p)).toBe("rpc-search");
      await p.eval("document.getElementById('rpc-search').select()");
      await p.send("Input.insertText", { text: "balance" });
      await key(p, "Enter", 13);
      expect([await focused(p), await p.eval(`${RPC}.method`)]).toEqual([filterRows(rows, "balance")[0]!.method, filterRows(rows, "balance")[0]!.method]);
      await searchFor("");

      // The typed fields: checked as typed, the request live.
      const address = `0x${"ab".repeat(20)}`;
      let d = await pick(p, "eth_getBalance");
      expect(d.fields.map((f) => [f.kind, f.label, f.error, f.invalid])).toEqual([["address", "address", "", "false"], ["blockTag", "block (optional)", "", "false"]]);
      await setField(p, 0, "0x12");
      d = await p.eval<Detail>(DETAIL);
      expect([d.fields[0]!.error, d.fields[0]!.invalid, d.preview, d.callDisabled]).toEqual([`address: ${KIND_HINTS.address}`, "true", null, true]);
      expect(d.requestError).toBe(`the form needs a fix: address: ${KIND_HINTS.address}`);
      expect(await p.eval(`${RPC}.preview`)).toBeNull();
      await setField(p, 0, address);
      expect((await previewOf(p)).params).toEqual([address, "latest"]);
      await setField(p, 1, "number");
      await setField(p, 1, "41", "rpc-param-number");
      expect((await previewOf(p)).params).toEqual([address, "0x29"]);
      await setField(p, 1, "forty", "rpc-param-number");
      expect((await p.eval<Detail>(DETAIL)).fields[1]!.error).toBe("block: a block number is a decimal number, or 0x and hex digits");
      await setField(p, 1, "omit");
      expect((await previewOf(p)).params).toEqual([address]);
      await setField(p, 1, "safe");
      expect((await previewOf(p)).params).toEqual([address, "safe"]);
      d = await pick(p, "eth_getTransactionByBlockNumberAndIndex");
      await setField(p, 1, "3");
      expect((await previewOf(p)).params).toEqual(["latest", "0x3"]);
      d = await pick(p, "eth_getBlockByNumber");
      await p.eval("document.getElementById('rpc-param-1').click()");
      expect((await previewOf(p)).params).toEqual(["latest", true]);
      d = await pick(p, "eth_feeHistory");
      await setField(p, 2, "10, 90");
      await setField(p, 0, "16");
      expect((await previewOf(p)).params).toEqual(["0x10", "latest", [10, 90]]);
      await setField(p, 2, "10, 900");
      expect((await p.eval<Detail>(DETAIL)).fields[2]!.error).toBe(`reward percentiles: ${KIND_HINTS.percentiles}`);
      // Each method keeps its own edits.
      d = await pick(p, "eth_getBalance");
      expect((await previewOf(p)).params).toEqual([address, "safe"]);

      // JSON mode: the form's parameters as JSON, and back.
      await p.eval("document.querySelector('[data-action=rpc-mode-raw]').click()");
      d = await p.eval<Detail>(DETAIL);
      expect([d.form, d.raw, await p.eval(`${RPC}.mode`)]).toEqual([false, JSON.stringify([address, "safe"]), "raw"]);
      await setRaw(p, JSON.stringify([address, "earliest"]));
      expect((await previewOf(p)).params).toEqual([address, "earliest"]);
      await setRaw(p, "");
      expect(await previewOf(p)).toEqual({ jsonrpc: "2.0", id: await p.eval(`${RPC}.nextId`), method: "eth_getBalance" });
      await setRaw(p, '{"by":"name"}');
      expect((await previewOf(p)).params).toEqual({ by: "name" });
      await p.eval("document.querySelector('[data-action=rpc-mode-form]').click()");
      d = await p.eval<Detail>(DETAIL);
      expect([d.form, d.modeNote, (await previewOf(p)).params]).toEqual([true, "the JSON is not a list of this method's parameters: the form keeps its own values", [address, "safe"]]);
      await p.eval("document.querySelector('[data-action=rpc-mode-raw]').click()");
      await setRaw(p, JSON.stringify([address, "0x2a"]));
      await p.eval("document.querySelector('[data-action=rpc-mode-form]').click()");
      expect(await p.eval("[document.getElementById('rpc-param-1').value, document.querySelector('[data-input=rpc-param-number]').value]")).toEqual(["number", "0x2a"]);
      expect((await previewOf(p)).params).toEqual([address, "0x2a"]);

      // Copy as JSON and as curl (for Node's npm run evm-rpc); the curl line shown is the same.
      const body = (await p.eval<string>(`${RPC}.preview`))!;
      await p.eval("document.querySelector('[data-action=rpc-copy-json]').click()");
      await p.waitFor("document.querySelector('[data-field=rpc-copied]').textContent !== ''", 5_000, "the copy");
      expect([await p.eval(`${RPC}.copied`), await p.eval("document.querySelector('[data-field=rpc-copied]').textContent")]).toEqual([body, "the request (JSON) copied"]);
      await p.eval("document.querySelector('[data-action=rpc-copy-curl]').click()");
      await p.waitFor("document.querySelector('[data-field=rpc-copied]').textContent === 'the curl command copied'", 5_000, "the curl copy");
      expect(await p.eval(`${RPC}.copied`)).toBe(curlCommand(body));
      expect((await p.eval<Detail>(DETAIL)).curl).toBe(curlCommand(body));
      expect(curlCommand(body)).toContain(" http://127.0.0.1:8545");

      // Ctrl+Enter calls, from a field.
      const before = await p.eval<number>(`${RPC}.calls`);
      await p.eval("document.getElementById('rpc-param-0').focus()");
      await key(p, "Enter", 13, 2);
      const pane = await answered(p, "eth_getBalance", before);
      expect((await p.eval<Json>(`${RPC}.latest`)).body).toBe(body);
      expect(asAnswer((await p.eval<Json>(`${RPC}.latest`)).answer)).toEqual(await nodeAnswer(body));
      expect(pane.status).toBe("HTTP 200");

      // A Node-only method: described, no form, no Call, never called.
      d = await pick(p, "eth_getLogs");
      expect([d.nodeOnly, d.call, d.form, d.fields, await p.eval(`${RPC}.preview`)]).toEqual(["Served by Node only (npm run evm-rpc:all): this page lists it and never calls it.", false, false, [], null]);
      expect(await p.eval("new URLSearchParams(location.search).get('rpc-method')")).toBe("eth_getLogs");
      const calls = await p.eval<number>(`${RPC}.calls`);
      await p.eval("document.querySelector('a.rpc-method[data-method=eth_getLogs]').focus()");
      await key(p, "Enter", 13, 2);
      expect(await p.eval(`${RPC}.calls`)).toBe(calls);
      await shot(p, "jsonrpc-explorer.png");

      // The narrow layout: the list above the form; wide, beside it.
      const layout = (): Promise<{ list: Json; detail: Json }> => p.eval("(() => { const r = (s) => document.querySelector(s).getBoundingClientRect().toJSON(); return { list: r('.rpc-list'), detail: r('.rpc-detail') }; })()");
      let l = await layout();
      expect(l.list.right).toBeLessThanOrEqual(l.detail.left);
      await p.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
      await p.waitFor("document.querySelector('.rpc-list').getBoundingClientRect().bottom <= document.querySelector('.rpc-detail').getBoundingClientRect().top + 1", 5_000, "the narrow layout");
      l = await layout();
      expect(Math.abs(l.list.width - l.detail.width)).toBeLessThan(2);
      expect(await p.eval("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
      await shot(p, "jsonrpc-narrow.png");
      await p.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 240_000);

  it("[[browser.jsonrpc.next-calls]] the answer as a tree or as text; block numbers, block hashes and transaction hashes open their calls, answered as Node; the history opens and runs calls again, survives a reload and is cleared", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html?tab=jsonrpc&rpc-method=eth_blockNumber");
      await p.eval(`sessionStorage.removeItem(${JSON.stringify(HISTORY_KEY)})`);
      let pane = await callFromTab(p);
      expect([pane.tree, pane.textShown]).toEqual([true, false]);
      /** The leaf of the tree whose key is `key` (its first), its value, decimal and next calls. */
      const leaf = (k: string, nth = 0): Promise<Json> => p.eval(`(() => { const l = [...document.querySelectorAll('[data-field=rpc-tree] .leaf')].filter((x) => x.querySelector('.k')?.textContent === ${JSON.stringify(k)})[${nth}];
        return l === undefined ? null : { value: l.querySelector('.v').textContent, decimal: l.querySelector('[data-field=rpc-decimal]')?.textContent ?? null,
          next: [...l.querySelectorAll('[data-action=rpc-next]')].map((b) => [b.textContent, b.getAttribute('data-next-method')]) }; })()`);
      expect(await leaf("result")).toEqual({ value: '"0x2a"', decimal: " = 42", next: [["open block", "eth_getBlockByNumber"]] });
      // The text view.
      await p.eval("document.querySelector('[data-action=rpc-answer-text]').click()");
      pane = (await p.eval<Pane>(PANE))!;
      expect([pane.tree, pane.textShown, pane.answer]).toEqual([false, true, answerText((await p.eval<Json>(`${RPC}.latest`)).answer).text]);
      await p.eval("document.querySelector('[data-action=rpc-answer-tree]').click()");

      /** Clicks the next call `label` of the leaf `k` and checks the call it makes and its answer, Node's. */
      const follow = async (k: string, label: string, method: string, params: unknown[], nth = 0): Promise<void> => {
        const before = await p.eval<number>(`${RPC}.calls`);
        await p.eval(`[...document.querySelectorAll('[data-field=rpc-tree] .leaf')].filter((x) => x.querySelector('.k')?.textContent === ${JSON.stringify(k)})[${nth}]
          .querySelector('[data-action=rpc-next][data-next-method=${JSON.stringify(method)}]').click()`);
        await answered(p, method, before);
        const call = (await p.eval<Json>(`${RPC}.latest`)) as { method: string; body: string; answer: ApiResult };
        expect([call.method, JSON.parse(call.body).params], `${label} from ${k}`).toEqual([method, params]);
        expect(asAnswer(call.answer), `${label} from ${k}`).toEqual(await nodeAnswer(call.body));
        expect(new URLSearchParams(await p.eval<string>("location.search")).get("rpc-method")).toBe(method);
      };
      await follow("result", "open block", "eth_getBlockByNumber", ["0x2a", false]);
      // The form holds the call made.
      expect(await p.eval("[document.getElementById('rpc-param-0').value, document.querySelector('[data-input=rpc-param-number]').value, document.getElementById('rpc-param-1').checked]")).toEqual(["number", "0x2a", false]);
      expect(await leaf("number")).toEqual({ value: '"0x2a"', decimal: " = 42", next: [["open block", "eth_getBlockByNumber"]] });
      expect(await leaf("hash")).toMatchObject({ decimal: null, next: [["open block", "eth_getBlockByHash"]] });
      expect(await leaf("0")).toMatchObject({ value: `"0x${TX_HASH.success}"`, next: [["open transaction", "eth_getTransactionByHash"], ["open receipt", "eth_getTransactionReceipt"]] });
      expect(await leaf("miner")).toMatchObject({ next: [] });
      await follow("parentHash", "open block", "eth_getBlockByHash", [`0x${BLOCK_HASH.h41}`, false]);
      expect(await leaf("number")).toMatchObject({ value: `"0x${HEIGHT.h41.toString(16)}"`, decimal: ` = ${HEIGHT.h41}` });

      // The history: newest first; "run again" on the block 42 call, then its first transaction's receipt.
      const history = (): Promise<string[][]> => p.eval<string[][]>(HISTORY);
      expect(await history()).toEqual([
        ["eth_getBlockByHash", JSON.stringify([`0x${BLOCK_HASH.h41}`, false]), expect.stringMatching(/^result \{/)],
        ["eth_getBlockByNumber", '["0x2a",false]', expect.stringMatching(/^result \{/)],
        ["eth_blockNumber", "[]", 'result "0x2a"'],
      ]);
      let before = await p.eval<number>(`${RPC}.calls`);
      await p.eval("document.querySelector('[data-field=rpc-history-row][data-index=\"1\"] [data-action=rpc-history-run]').click()");
      await answered(p, "eth_getBlockByNumber", before);
      expect(JSON.parse((await p.eval<Json>(`${RPC}.latest`)).body)).toMatchObject({ method: "eth_getBlockByNumber", params: ["0x2a", false] });
      await follow("0", "open receipt", "eth_getTransactionReceipt", [`0x${TX_HASH.success}`]);
      expect(await leaf("transactionHash")).toMatchObject({ next: [["open transaction", "eth_getTransactionByHash"], ["open receipt", "eth_getTransactionReceipt"]] });
      await follow("transactionHash", "open transaction", "eth_getTransactionByHash", [`0x${TX_HASH.success}`]);
      await follow("blockNumber", "open block", "eth_getBlockByNumber", ["0x2a", false]);
      expect((await history()).length).toBe(await p.eval(`${RPC}.calls`));

      // "open": chosen with its parameters, not called; "run again" on the oldest: the same request but its id.
      const calls = await p.eval<number>(`${RPC}.calls`);
      const rowsNow = await history();
      const oldest = rowsNow.length - 1;
      await p.eval(`document.querySelector('[data-field=rpc-history-row][data-index="${oldest - 1}"] [data-action=rpc-history-open]').click()`);
      expect([await p.eval(`${RPC}.calls`), await p.eval(`${RPC}.method`), (await previewOf(p)).params]).toEqual([calls, "eth_getBlockByNumber", ["0x2a", false]]);
      before = calls;
      await p.eval(`document.querySelector('[data-field=rpc-history-row][data-index="${oldest}"] [data-action=rpc-history-run]').click()`);
      await answered(p, "eth_blockNumber", before);
      const again = JSON.parse((await p.eval<Json>(`${RPC}.latest`)).body);
      expect(again).toEqual({ jsonrpc: "2.0", id: again.id, method: "eth_blockNumber", params: [] });
      expect((await history())[0]).toEqual(["eth_blockNumber", "[]", 'result "0x2a"']);

      await shot(p, "jsonrpc-next-calls.png");
      // A reload of the tab keeps the history; clear empties it.
      const kept = await history();
      await reload(p);
      await p.waitFor("document.querySelectorAll('[data-field=rpc-history-row]').length > 0", 10_000, "the history after a reload");
      expect(await history()).toEqual(kept);
      expect(await p.eval(`${RPC}.stored`)).toBe(true);
      await p.eval("document.querySelector('[data-action=rpc-history-clear]').click()");
      expect([await history(), await p.eval(`sessionStorage.getItem(${JSON.stringify(HISTORY_KEY)})`), await p.eval("document.querySelector('[data-field=rpc-history-empty]').textContent")]).toEqual([[], null, "no calls yet"]);
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 240_000);

  it("[[browser.jsonrpc.status]] the status view's figures equal their sources: the engine's state, the build's chain and indexer, Node's answers, the list's counts, the tab's calls, an indexer error; read again by refresh and every 5 s", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html?tab=jsonrpc&rpc=status");
      await p.waitFor("document.querySelectorAll('[data-field=rpc-status-view] .kv .v').length > 0", 15_000, "the status view");
      const figures = async (): Promise<Array<[string, string, string, boolean]>> => p.eval(FIGURES);
      const expectedFigures = (s: JsonRpcStateResult): Array<[string, string, string, boolean]> => statusFigures(s, Date.now()).map((f) => [f.field, f.label, f.value, f.bad ?? false]);
      const indexerUrl = `${site.origin}/chain/graphql`;

      // Before any call.
      let s = await engineState(p);
      expect(s).toEqual({
        enabled: true,
        database: "none",
        chainId: JSONRPC_CHAIN_ID.toString(),
        clientVersion: jsonRpcClientVersion(PACKAGE_VERSION),
        indexerUrl,
        methods: { served: rows.filter((r) => r.kind === "served").length, notImplemented: NOT_IMPLEMENTED_METHODS.length, nodeOnly: rows.filter((r) => r.kind === "node-only").length },
        calls: { answered: 0, inFlight: 0, refusedBusy: 0, refusedOff: 0, failed: 0 },
        pacing: { origin: site.origin, minIntervalMs: defaultMinIntervalMs(indexerUrl), waiting: 0, heldForMs: 0 },
        lastError: null,
      });
      expect(await figures()).toEqual(expectedFigures(s));
      expect(await p.eval("document.querySelector('#tab-panel-jsonrpc > .banner').hidden")).toBe(true);
      // The methods' counts are the list's groups'.
      const list = await p.eval<ListGroup[]>(LIST);
      const counted = (ids: string[]): number => list.filter((g) => ids.includes(g.group)).reduce((a, g) => a + Number(g.count), 0);
      expect([counted(["indexer", "config", "database"]), counted(["not-implemented"]), counted(["node-only"])]).toEqual([s.methods.served, s.methods.notImplemented, s.methods.nodeOnly]);

      // Calls from the tab: the chain ID and the client version are Node's answers; the calls are counted.
      await p.eval("document.getElementById('rpc-nav-methods').click()");
      const result = async (method: string): Promise<unknown> => {
        await callFromTab(p, method);
        return JSON.parse((await p.eval<Json>(`${RPC}.latest`)).answer.body).result;
      };
      expect(await result("eth_chainId")).toBe(`0x${BigInt(s.chainId).toString(16)}`);
      expect(await result("net_version")).toBe(s.chainId);
      expect(await result("web3_clientVersion")).toBe(s.clientVersion);
      expect(JSON.parse((await nodeAnswer(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion" }))).body).result).toBe(s.clientVersion);
      await p.eval("document.getElementById('rpc-nav-status').click()");
      await p.waitFor("document.querySelector('[data-field=\"rpc-state.calls\"]')?.textContent.startsWith('3 answered')", 10_000, "the calls counted");
      s = await engineState(p);
      expect([s.calls.answered, s.database]).toEqual([await p.eval(`${RPC}.calls`), "open"]);
      expect(await figures()).toEqual(expectedFigures(s));

      // An indexer error: the last error, with its origin.
      indexer = () => ({ status: 500, body: "{}" });
      try {
        await p.eval("document.getElementById('rpc-nav-methods').click()");
        await callFromTab(p, "eth_blockNumber");
      } finally {
        indexer = recordedIndexerAnswer;
      }
      await p.eval("document.getElementById('rpc-nav-status').click()");
      await p.waitFor("document.querySelector('[data-field=\"rpc-state.lastError\"]')?.textContent !== 'none'", 10_000, "the last error");
      s = await engineState(p);
      expect(s.lastError?.message).toBe(`${site.origin} answered HTTP 500`);
      const lastError = (await figures()).find((f) => f[0] === "rpc-state.lastError")!;
      expect(lastError).toEqual(["rpc-state.lastError", "last error", expect.stringMatching(new RegExp(`^${site.origin.replaceAll(".", "\\.")} answered HTTP 500 \\(\\d+ s ago\\)$`)), true]);
      expect((await figures()).filter((f) => f[0] !== "rpc-state.lastError")).toEqual(expectedFigures(s).filter((f) => f[0] !== "rpc-state.lastError"));

      // A call beside the tab: refresh reads it; so does the next 5 s reading.
      await viaEngine(p, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }));
      await p.eval("document.getElementById('rpc-now').click()");
      await p.waitFor("document.querySelector('[data-field=\"rpc-state.calls\"]').textContent.startsWith('5 answered')", 10_000, "refresh");
      await viaEngine(p, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_chainId" }));
      await p.waitFor("document.querySelector('[data-field=\"rpc-state.calls\"]').textContent.startsWith('6 answered')", 8_000, "the next reading");
      s = await engineState(p);
      expect((await figures()).filter((f) => f[0] !== "rpc-state.lastError")).toEqual(expectedFigures(s).filter((f) => f[0] !== "rpc-state.lastError"));
      expect(await p.eval("document.getElementById('rpc-strip').textContent")).toBe(stripParts(s).map((x) => `${x.label} ${x.value}`).join("  ·  "));
      await shot(p, "jsonrpc-status.png");
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 180_000);

  it("[[browser.jsonrpc.answers]] every POST case of the differential through the engine gets Node's answer; requests the protocol refuses are answered bad-request", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html");
      const cases = differentialCases().filter((c) => c.method === "POST");
      expect(cases.length).toBeGreaterThan(120);
      const recorded = new Map(loadRecording().answers.map((r) => [r.case, r]));
      for (const c of cases) {
        const r = await viaEngine(p, c.body);
        expect("refused" in r ? r : asAnswer(r), c.name).toEqual(await nodeAnswer(c.body));
        // Node's answer as recorded, but for the client version, which is the build's package version here.
        if (!("refused" in r) && !c.body.includes("web3_clientVersion")) expect(handlerAnswer(c.name, r, recorded.get(c.name)!), c.name).toEqual(recorded.get(c.name));
      }
      expect(await on(p)(`c.request("jsonrpc", {}).catch((e) => e.code)`)).toBe("bad-request");
      expect(await on(p)(`c.request("jsonrpc", { body: 7 }).catch((e) => e.code)`)).toBe("bad-request");
      expect(await on(p)(`c.request("jsonrpc", { body: " ".repeat(2 * 1048576 + 1) }).catch((e) => e.code)`)).toBe("bad-request");
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 300_000);

  it("[[browser.jsonrpc.hostile]] hostile text in parameters written as JSON, in the parser's message, in a form field, in the stored history and in an indexer answer is drawn as text with visible marks; the indexer's text is never passed on; nothing comes alive", async () => {
    const hostile = "\u202Egnp.exe\u200B\u0000<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=2</script>\u001b[31m \u2066iso\u2069";
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html?tab=jsonrpc&rpc-method=eth_getBalance");
      await p.eval("document.querySelector('[data-action=rpc-mode-raw]').click()");

      // Hostile parameters: the request is drawn with marks; the method refuses them (-32602).
      await setRaw(p, JSON.stringify([hostile, "latest"]));
      let d = await p.eval<Detail>(DETAIL);
      expect(d.preview).toContain(visibleText(JSON.stringify(hostile)));
      expect(d.preview).toContain("⟨U+202E⟩gnp.exe⟨U+200B⟩");
      expect(await p.eval<string[]>("[...document.querySelectorAll('[data-field=rpc-preview] .mark-vis')].map((e) => e.textContent)")).toEqual(["⟨U+202E⟩", "⟨U+200B⟩", "⟨U+2066⟩", "⟨U+2069⟩"]);
      await callFromTab(p);
      expect(JSON.parse((await p.eval<Json>(`${RPC}.latest`)).answer.body)).toMatchObject({ error: { code: -32602 } });
      // The history draws its parameters with marks.
      expect((await p.eval<string[][]>(HISTORY))[0]![1]).toContain("⟨U+202E⟩gnp.exe⟨U+200B⟩");

      // Parameters that are not JSON: no request, Call disabled, and the parser's message (which quotes them) with marks.
      const calls = await p.eval<number>(`${RPC}.calls`);
      await setRaw(p, `[${hostile}`);
      d = await p.eval<Detail>(DETAIL);
      expect([d.preview, d.callDisabled]).toEqual([null, true]);
      expect(d.requestError).toMatch(/^the parameters are not JSON: /);
      expect(d.requestError).toContain("⟨U+202E⟩");
      await p.eval("document.querySelector('[data-action=rpc-call]').click()");
      expect(await p.eval(`${RPC}.calls`)).toBe(calls);

      // Parameters nested far deeper than the tab sends (deep enough to break serialization): a message, no exception.
      await setRaw(p, `${"[".repeat(10_000)}${"]".repeat(10_000)}`);
      d = await p.eval<Detail>(DETAIL);
      expect([d.preview, d.requestError, d.callDisabled]).toEqual([null, "the parameters nest deeper than 64 levels", true]);

      // A form field holding hostile text: the field's message, which never repeats it.
      await p.eval("document.querySelector('[data-action=rpc-mode-form]').click()");
      await setField(p, 0, hostile);
      d = await p.eval<Detail>(DETAIL);
      expect(d.fields[0]!.error).toBe(`address: ${KIND_HINTS.address}`);

      // An indexer whose answers carry hostile text: the module refuses them (-32603), the text is never shown.
      indexer = (body) => {
        const a = recordedIndexerAnswer(body);
        if (!body.includes("block(offset: { height: $height })") && !/"query":"\{\s*block/.test(body)) return a;
        const parsed = JSON.parse(a.body) as { data?: { block?: Record<string, unknown> | null } };
        if (parsed.data?.block == null) return a;
        return { status: 200, body: JSON.stringify({ data: { block: { ...parsed.data.block, author: hostile, hash: hostile } } }) };
      };
      try {
        let pane = await callFromTab(p, "eth_getBlockByNumber");
        expect(JSON.parse((await p.eval<Json>(`${RPC}.latest`)).answer.body)).toEqual({ jsonrpc: "2.0", id: expect.any(Number), error: { code: -32603, message: "Internal error" } });
        expect(pane.answer).not.toContain("gnp.exe");
        // The same through GraphQL errors.
        indexer = () => ({ status: 200, body: JSON.stringify({ errors: [{ message: hostile }] }) });
        pane = await callFromTab(p, "eth_blockNumber");
        expect(JSON.parse((await p.eval<Json>(`${RPC}.latest`)).answer.body)).toMatchObject({ error: { code: -32603, message: "Internal error" } });
        expect(pane.answer).not.toContain("gnp.exe");
      } finally {
        indexer = recordedIndexerAnswer;
      }

      // A history in storage with hostile text: drawn with marks; an entry of a method that is not listed is dropped.
      await p.eval(`sessionStorage.setItem(${JSON.stringify(HISTORY_KEY)}, ${JSON.stringify(JSON.stringify([
        { method: "eth_getBalance", params: JSON.stringify([hostile]), at: 1, outcome: hostile },
        { method: hostile, params: "[]", at: 2, outcome: "x" },
      ]))})`);
      await reload(p);
      expect(await p.eval<string[][]>(HISTORY)).toEqual([["eth_getBalance", visibleText(JSON.stringify([hostile])), visibleText(hostile)]]);

      // Nothing came alive; no raw hidden character in the drawn text or in an attribute.
      expect(await p.eval("window.__pwned")).toBeUndefined();
      expect(await p.eval<number>("document.querySelectorAll('#tab-panel-jsonrpc img, #tab-panel-jsonrpc script').length")).toBe(0);
      expect(await p.eval<string>("document.getElementById('tab-panel-jsonrpc').innerText")).not.toMatch(HIDDEN_RAW);
      for (const a of await p.eval<string[]>("[...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value))")) expect(a).not.toMatch(HIDDEN_RAW_ATTR);
      await shot(p, "jsonrpc-hostile.png");
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 240_000);

  it("[[browser.jsonrpc.editor-bounds]] the editor's paths keep the JSON text's bounds: too deep never reaches the form, a form too long is refused, the curl line at the bound is shown cut and copied whole; nothing throws", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html?tab=jsonrpc&rpc-method=eth_call");
      const example = (await previewOf(p)).params;
      // JSON nested too deep: refused there; the form does not take it, keeps its values and says why.
      await p.eval("document.querySelector('[data-action=rpc-mode-raw]').click()");
      // As deep as the JSON text's length allows (65,536 characters).
      await setRaw(p, `[{"x":${"[".repeat(32_000)}${"]".repeat(32_000)}}]`);
      let d = await p.eval<Detail>(DETAIL);
      expect([d.preview, d.requestError, d.callDisabled]).toEqual([null, "the parameters nest deeper than 64 levels", true]);
      await p.eval("document.querySelector('[data-action=rpc-mode-form]').click()");
      d = await p.eval<Detail>(DETAIL);
      expect([d.form, d.modeNote]).toEqual([true, "the JSON cannot be put in the form: the parameters nest deeper than 64 levels"]);
      expect((await previewOf(p)).params).toEqual(example);
      expect(p.exceptions).toEqual([]);

      // A form field longer than the parameters may be: refused, no request, no curl line, nothing long drawn.
      await pick(p, "web3_sha3");
      await setField(p, 0, `0x${"aa".repeat(200_000)}`);
      d = await p.eval<Detail>(DETAIL);
      expect([d.fields[0]!.error, d.preview, d.curl, d.callDisabled]).toEqual([`data: longer than ${MAX_PARAMS_CHARS} characters`, null, null, true]);
      expect(await p.eval(`${RPC}.preview`)).toBeNull();
      expect(await p.eval<number>("document.getElementById('tab-panel-jsonrpc').textContent.length")).toBeLessThan(20_000);
      // Its JSON mode does not take it either.
      await p.eval("document.querySelector('[data-action=rpc-mode-raw]').click()");
      expect((await p.eval<Detail>(DETAIL)).raw!.length).toBeLessThan(1_000);
      await p.eval("document.querySelector('[data-action=rpc-mode-form]').click()");

      // At the bound: sent; its curl line, four characters per quote, shown cut and copied whole.
      await pick(p, "eth_call");
      await p.eval("document.querySelector('[data-action=rpc-mode-raw]').click()");
      await setRaw(p, `["${"'".repeat(MAX_PARAMS_CHARS - 4)}"]`);
      d = await p.eval<Detail>(DETAIL);
      expect(d.requestError).toBeNull();
      const body = (await p.eval<string>(`${RPC}.preview`))!;
      expect(d.curl!.length).toBeLessThanOrEqual(MAX_SHOWN_CHARS + 60);
      expect(d.curl).toMatch(/… \(cut: [\d,]+ characters in all\)$/);
      await p.eval("document.querySelector('[data-action=rpc-copy-curl]').click()");
      await p.waitFor("document.querySelector('[data-field=rpc-copied]').textContent === 'the curl command copied'", 5_000, "the curl copy");
      expect(await p.eval(`${RPC}.copied`)).toBe(curlCommand(body));
      const pane = await callFromTab(p);
      expect(asAnswer((await p.eval<Json>(`${RPC}.latest`)).answer)).toEqual(await nodeAnswer(body));
      expect(pane.status).toBe("HTTP 200");
      // The history keeps the call and draws its parameters cut.
      expect((await p.eval<string[][]>(HISTORY))[0]![1]!.length).toBeLessThanOrEqual(120);
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 180_000);

  it("[[browser.jsonrpc.concurrent-calls]] calls on two methods at once: each answer kept with its method, the slow one shown while awaited and once it comes, never over the other's; the last call made is the one reported", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html?tab=jsonrpc");
      // A slow indexer-backed call, then a fast constant one that answers first.
      indexerDelayMs = 1_500;
      try {
        await pick(p, "eth_blockNumber");
        await p.eval("document.querySelector('[data-action=rpc-call]').click()");
        expect(((await p.eval<Pane>(PANE))!).pending).toBe("calling…");
        expect(await p.eval("document.querySelector('[data-action=rpc-call]').disabled")).toBe(true);
        await pick(p, "eth_chainId");
        await p.eval("document.querySelector('[data-action=rpc-call]').click()");
        await p.waitFor(`${RPC}.byMethod.eth_chainId?.pending === false`, 15_000, "the fast answer");
        const fast = (await p.eval<Pane>(PANE))!;
        expect([fast.pending, fast.answer?.includes('"0x960"')]).toEqual([null, true]);
        expect(await p.eval(`${RPC}.byMethod.eth_blockNumber.pending`)).toBe(true);
        await pick(p, "eth_blockNumber");
        expect(((await p.eval<Pane>(PANE))!).pending).toBe("calling…");
        await p.waitFor(`${RPC}.byMethod.eth_blockNumber.pending === false`, 15_000, "the slow answer");
      } finally {
        indexerDelayMs = 0;
      }
      const slow = (await p.eval<Pane>(PANE))!;
      expect([slow.pending, slow.answer?.includes('"0x2a"')]).toEqual([null, true]);
      await pick(p, "eth_chainId");
      expect(((await p.eval<Pane>(PANE))!).answer?.includes('"0x960"')).toBe(true);
      // The last call made (eth_chainId), though the other answered after it.
      expect((await p.eval<Json>(`${RPC}.latest`)).method).toBe("eth_chainId");
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 120_000);

  it("[[browser.jsonrpc.module-switch]] off from its checkbox: saved, the tab gone, requests refused module-off; a second tab the same; holds through a leader change and a reload; on again, the tab back and Node's answers", async () => {
    const b = await Browser.launch(browserExe!);
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [`0x${HEIGHT.h41.toString(16)}`, true] });
    try {
      let leader = await open(b, "/index.html?tab=jsonrpc");
      expect(asAnswer((await viaEngine(leader, request)) as ApiResult)).toEqual(await nodeAnswer(request));
      await leader.waitFor("document.getElementById('module-jsonrpc').disabled === false", 30_000, "the switch");

      // Off.
      await leader.eval("document.getElementById('module-jsonrpc').click()");
      await leader.waitFor("/^the JSON RPC module is off/.test(document.querySelector('#modules [data-field=modules-message]').textContent)", 30_000, "the switch's answer");
      expect((await status(leader)).settings?.modules).toEqual({ jsonrpc: false });
      expect(await leader.eval("[document.getElementById('tab-jsonrpc').hidden, document.body.getAttribute('data-tab-shown'), location.search]")).toEqual([true, "overview", "?tab=overview"]);
      expect(await leader.eval("[document.getElementById('module-jsonrpc').checked, document.querySelector('#modules tr[data-module=jsonrpc]').getAttribute('data-state')]")).toEqual([false, "off"]);
      expect(await viaEngine(leader, request)).toEqual({ refused: "module-off", message: expect.stringContaining("JSON RPC module is off") });
      expect((await engineState(leader)).enabled).toBe(false);
      // The token indexer's switch is its own.
      expect(await leader.eval("document.getElementById('module-token-indexer').checked")).toBe(true);
      // A URL naming the tab shows the overview.
      await leader.goto(`${site.origin}/index.html?tab=jsonrpc`);
      await leader.waitFor("window.umbradbOverview !== undefined && document.body.getAttribute('data-tab-shown') === 'overview' && location.search === '?tab=overview'", 30_000, "the overview instead of the hidden tab");
      await leader.eval("window.umbradbEngine.client.booted()");

      // A second tab: the same, and refused through the leader.
      const follower = await open(b, "/index.html");
      expect(await follower.eval("window.umbradbEngine.tabs.role()")).toBe("follower");
      await follower.waitFor("document.getElementById('module-jsonrpc').checked === false && document.getElementById('tab-jsonrpc').hidden === true", 30_000, "the follower's module state");
      expect(await viaEngine(follower, request)).toMatchObject({ refused: "module-off" });

      // The leader closes: the next leader's worker reads the choice.
      await leader.close();
      await follower.waitFor("window.umbradbEngine.tabs.role() === 'leader'", 30_000, "the follower to lead");
      await follower.eval("window.umbradbEngine.client.booted()");
      expect(await waitFor("the next leader's refusal", () => viaEngine(follower, request), (r) => "refused" in r && r.refused === "module-off")).toMatchObject({ refused: "module-off" });

      // A reload keeps it.
      leader = follower;
      await reload(leader);
      await leader.waitFor("document.getElementById('module-jsonrpc').disabled === false && document.getElementById('module-jsonrpc').checked === false && document.getElementById('tab-jsonrpc').hidden === true", 30_000, "the choice after a reload");
      expect(await viaEngine(leader, request)).toMatchObject({ refused: "module-off" });

      // On again: the tab is back, the answers are Node's.
      await leader.eval("document.getElementById('module-jsonrpc').click()");
      await leader.waitFor("/^the JSON RPC module is on/.test(document.querySelector('#modules [data-field=modules-message]').textContent)", 30_000, "the switch's answer");
      expect((await status(leader)).settings?.modules).toEqual({ jsonrpc: true });
      expect(await leader.eval("document.getElementById('tab-jsonrpc').hidden")).toBe(false);
      expect(asAnswer((await viaEngine(leader, request)) as ApiResult)).toEqual(await nodeAnswer(request));
      await leader.eval("document.getElementById('tab-jsonrpc').click()");
      const pane = await callFromTab(leader, "eth_chainId");
      expect(pane.answer).toContain("\"0x960\"");
      await clean(leader, true);
      await leader.close();
    } finally {
      await b.close();
    }
  }, 300_000);
});
