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
 *   module's registry and the Node-only methods, each with its source, its state and (when callable) an editable
 *   example of its parameters and a Call button, the Node-only ones marked and not callable; the note says external
 *   wallets cannot connect; Call on every listed method shows the request it sent and the answer, which equals Node's
 *   (status, headers, body) — a result for each served method, `-32004` for each not-implemented one. No CSP
 *   violation, every request to the site.
 * - `[[browser.jsonrpc.answers]]` — every `POST` case of the differential (every method, refused parameters, the
 *   not-implemented and unknown methods, the envelope, notifications, batches, bodies that are not JSON, the size cap)
 *   sent as a `jsonrpc` request gets exactly Node's answer; a request the protocol refuses (no body, a body over its
 *   bound) is answered `bad-request`.
 * - `[[browser.jsonrpc.hostile]]` — hostile text (control, bidi, zero-width and markup characters) in edited parameters,
 *   in the parser's message about parameters that are not JSON, and in an indexer answer is drawn as text: the request
 *   and the message with visible marks, the indexer's text never passed on (the module answers `-32603`); nothing comes
 *   alive and no raw hidden character is drawn.
 * - `[[browser.jsonrpc.module-switch]]` — JSON RPC switched off from its checkbox: saved with the settings, its tab gone
 *   (a URL naming it shows the overview), `jsonrpc` requests refused `module-off`; a second tab shows the same and is
 *   refused through the leader; the choice holds when the leader closes (the next leader's worker) and after a reload;
 *   on again, the tab is back and the answers are Node's.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `MIP0018_UI_SCREENSHOTS=<dir>` saves PNGs (never committed).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyEvmRpcReader } from "../../evm-rpc/db.js";
import { IndexerGqlClient } from "../../evm-rpc/indexer-gql.js";
import { NOT_IMPLEMENTED_METHODS } from "../../evm-rpc/methods/not-implemented.js";
import { registerReadOnlyMethods } from "../../evm-rpc/read-only.js";
import { MethodRegistry } from "../../evm-rpc/registry.js";
import { createRpcServer } from "../../evm-rpc/server.js";
import { differentialCases } from "../../evm-rpc/test/differential-cases.js";
import { HEIGHT, recordedIndexerAnswer, recordedIndexerFetch } from "../../evm-rpc/test/recorded-indexer.js";
import { answerText, buildRequest, JSONRPC_TAB_NOTE, methodRows, SOURCE_LEGEND } from "../browser/jsonrpc-model.ts";
import { JSONRPC_CHAIN_ID, jsonRpcClientVersion } from "../browser/jsonrpc-module.ts";
import { INDEXER_MODULES } from "../browser/modules.ts";
import type { ApiResult, HostStatus } from "../browser/protocol.ts";
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

/** A row of the tab as drawn. */
const ROWS = `[...document.querySelectorAll('[data-field=jsonrpc-methods] tbody tr[data-method]')].map((tr) => ({
  method: tr.querySelector('[data-field=jsonrpc-method]').textContent, kind: tr.getAttribute('data-kind'),
  source: tr.querySelector('[data-field=jsonrpc-source]').textContent,
  state: tr.querySelector('[data-field=jsonrpc-state] > .d').textContent,
  note: tr.querySelector('[data-field=jsonrpc-method-note]')?.textContent ?? null,
  params: tr.querySelector('textarea')?.value ?? null,
  call: tr.querySelector('[data-action=jsonrpc-call]') !== null,
  nodeOnly: tr.querySelector('[data-field=jsonrpc-node-only]') !== null,
}))`;

/** The output row as drawn. */
const OUTPUT = `(() => {
  const o = document.querySelector('[data-field=jsonrpc-output]');
  if (o === null) return null;
  const t = (f) => o.querySelector('[data-field=' + f + ']')?.textContent ?? null;
  return { after: o.previousElementSibling?.getAttribute('data-method') ?? null, method: t('jsonrpc-output-method'), request: t('jsonrpc-request'),
    status: t('jsonrpc-status'), answer: t('jsonrpc-answer'), error: t('jsonrpc-error'), pending: t('jsonrpc-pending') };
})()`;
interface Output { after: string | null; method: string; request: string | null; status: string | null; answer: string | null; error: string | null; pending: string | null }

describe("the JSON RPC module in the static build in Chrome (served with its headers)", () => {
  let out: string;
  let site: LocalServer;
  const headerRules: HeaderRule[] = [];
  /** What the indexer's GraphQL route answers. */
  let indexer: (body: string) => { status: number; body: string } = recordedIndexerAnswer;
  let indexerRequests = 0;
  let node: Server;
  let nodePort: number;

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
          res.writeHead(a.status, { "content-type": "application/json" }).end(a.body);
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

  /** Node's answer to a `POST` with `body`. */
  function nodeAnswer(body: string): Promise<Answer> {
    const bytes = Buffer.from(body, "utf8");
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: nodePort, method: "POST", path: "/", headers: { "content-length": bytes.length } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const headers: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            if (!/^(date|connection|keep-alive)$/i.test(res.rawHeaders[i]!)) headers.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
          }
          resolve({ status: res.statusCode!, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      req.on("error", reject);
      req.end(bytes);
    });
  }

  const on = (p: Page) => (expr: string): Promise<Json> => p.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
  const status = (p: Page): Promise<HostStatus> => on(p)("c.status()");
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
    await p.goto(`${site.origin}${path}`);
    await p.waitFor("window.umbradbEngine !== undefined && window.umbradbOverview !== undefined", 30_000, "the main page");
    await p.eval("window.umbradbEngine.tabs.ready");
    expect(await p.eval("window.umbradbEngine.client.booted()")).toMatchObject({ phase: "ready", error: null });
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

  /** Clicks Call on `method`'s row and waits for its answer (or its error) in the output row. */
  async function callFromTab(p: Page, method: string): Promise<Output> {
    const before = await p.eval<number>(`window.umbradbOverview.jsonrpc().calls`);
    await p.eval(`document.querySelector('tr[data-method=${JSON.stringify(method)}] [data-action=jsonrpc-call]').click()`);
    await p.waitFor(`window.umbradbOverview.jsonrpc().calls > ${before} && window.umbradbOverview.jsonrpc().latest.pending === false`, 30_000, `the answer to ${method}`);
    return (await p.eval<Output>(OUTPUT))!;
  }

  it("[[browser.jsonrpc.tab]] on by default: the Modules row and the tab; every method of the registry and the Node-only ones listed with source, state, example parameters and Call; the note; Call on each shows the request and Node's answer; no CSP violation", async () => {
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

      // Every method: the registry's (the build's own) and the Node-only ones, as the model lists them.
      const expected = methodRows();
      const drawn = await p.eval<Json[]>(ROWS);
      expect(drawn).toEqual(expected.map((r) => ({
        method: r.method, kind: r.kind, source: r.source, state: r.state, note: r.note,
        params: r.callable ? r.params : null, call: r.callable, nodeOnly: !r.callable,
      })));
      expect(drawn.filter((r) => r.kind === "node-only").map((r) => r.method)).toEqual(["eth_getLogs", "eth_sendRawTransaction", "eth_subscribe", "eth_unsubscribe"]);
      expect(drawn.filter((r) => r.kind === "not-implemented").length).toBe(NOT_IMPLEMENTED_METHODS.length);
      expect(await p.eval("document.querySelector('[data-field=jsonrpc-note]').textContent")).toBe(JSONRPC_TAB_NOTE);
      expect(await p.eval("document.querySelector('[data-field=jsonrpc-legend]').textContent")).toBe(SOURCE_LEGEND);
      expect(JSONRPC_TAB_NOTE).toContain("External wallets cannot connect to a page");

      // Call on every callable method: the request shown is the one sent, the answer is Node's.
      let served = 0;
      let stubs = 0;
      for (const row of expected.filter((r) => r.callable)) {
        const output = await callFromTab(p, row.method);
        const call = (await p.eval<Json>("window.umbradbOverview.jsonrpc().latest")) as { method: string; body: string; answer: ApiResult; error: string | null };
        expect(call.method).toBe(row.method);
        expect(call.error, row.method).toBeNull();
        const id = (JSON.parse(call.body) as { id: number }).id;
        const built = buildRequest(id, row.method, row.params);
        expect(built.ok && call.body === built.body, row.method).toBe(true);
        expect(asAnswer(call.answer), row.method).toEqual(await nodeAnswer(call.body));
        const shown = answerText(call.answer);
        expect(output).toEqual({ after: row.method, method: row.method, request: built.ok ? built.text : null, status: shown.status, answer: shown.text, error: null, pending: null });
        const parsed = JSON.parse(call.answer.body) as { result?: unknown; error?: { code: number } };
        if (row.kind === "served") {
          expect(parsed.error, row.method).toBeUndefined();
          served++;
        } else {
          expect(parsed.error?.code, row.method).toBe(-32004);
          stubs++;
        }
      }
      expect([served, stubs]).toEqual([expected.filter((r) => r.kind === "served").length, NOT_IMPLEMENTED_METHODS.length]);
      expect(indexerRequests).toBeGreaterThan(0);
      await shot(p, "jsonrpc-tab.png");
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 300_000);

  it("[[browser.jsonrpc.answers]] every POST case of the differential through the engine gets Node's answer; requests the protocol refuses are answered bad-request", async () => {
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html");
      const cases = differentialCases().filter((c) => c.method === "POST");
      expect(cases.length).toBeGreaterThan(120);
      for (const c of cases) {
        const r = await viaEngine(p, c.body);
        expect("refused" in r ? r : asAnswer(r), c.name).toEqual(await nodeAnswer(c.body));
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

  it("[[browser.jsonrpc.hostile]] hostile text in edited parameters, in the parser's message and in an indexer answer is drawn as text with visible marks; the indexer's text is never passed on; nothing comes alive", async () => {
    const hostile = "\u202Egnp.exe\u200B\u0000<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=2</script>\u001b[31m \u2066iso\u2069";
    const b = await Browser.launch(browserExe!);
    try {
      const p = await open(b, "/index.html?tab=jsonrpc");
      const setParams = (method: string, text: string): Promise<void> =>
        p.eval(`(() => { const t = document.querySelector('tr[data-method=${JSON.stringify(method)}] textarea'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); })()`);

      // Hostile parameters: the request is drawn with marks; the method refuses them (-32602).
      await setParams("eth_getBalance", JSON.stringify([hostile, "latest"]));
      let output = await callFromTab(p, "eth_getBalance");
      expect(output.request).toContain(visibleText(JSON.stringify(hostile)));
      expect(output.request).toContain("⟨U+202E⟩gnp.exe⟨U+200B⟩");
      expect(JSON.parse((await p.eval<Json>("window.umbradbOverview.jsonrpc().latest")).answer.body)).toMatchObject({ error: { code: -32602 } });
      expect(await p.eval<string[]>("[...document.querySelectorAll('[data-field=jsonrpc-request] .mark-vis')].map((e) => e.textContent)")).toEqual(["⟨U+202E⟩", "⟨U+200B⟩", "⟨U+2066⟩", "⟨U+2069⟩"]);

      // Parameters that are not JSON: nothing is sent, and the parser's message (which quotes them) is drawn with marks.
      await setParams("eth_getBalance", `[${hostile}`);
      output = await callFromTab(p, "eth_getBalance");
      expect(output.request).toBeNull();
      expect(output.error).toMatch(/^the parameters are not JSON: /);
      expect(output.error).toContain("⟨U+202E⟩");
      expect((await p.eval<Json>("window.umbradbOverview.jsonrpc().latest")).body).toBeNull();

      // An indexer whose answers carry hostile text: the module refuses them (-32603), the text is never shown.
      indexer = (body) => {
        const a = recordedIndexerAnswer(body);
        if (!body.includes("block(offset: { height: $height })") && !/"query":"\{\s*block/.test(body)) return a;
        const parsed = JSON.parse(a.body) as { data?: { block?: Record<string, unknown> | null } };
        if (parsed.data?.block == null) return a;
        return { status: 200, body: JSON.stringify({ data: { block: { ...parsed.data.block, author: hostile, hash: hostile } } }) };
      };
      try {
        await setParams("eth_getBlockByNumber", JSON.stringify(["latest", false]));
        output = await callFromTab(p, "eth_getBlockByNumber");
        expect(JSON.parse((await p.eval<Json>("window.umbradbOverview.jsonrpc().latest")).answer.body)).toEqual({ jsonrpc: "2.0", id: expect.any(Number), error: { code: -32603, message: "Internal error" } });
        expect(output.answer).not.toContain("gnp.exe");
        // The same through GraphQL errors.
        indexer = () => ({ status: 200, body: JSON.stringify({ errors: [{ message: hostile }] }) });
        output = await callFromTab(p, "eth_blockNumber");
        expect(JSON.parse((await p.eval<Json>("window.umbradbOverview.jsonrpc().latest")).answer.body)).toMatchObject({ error: { code: -32603, message: "Internal error" } });
      } finally {
        indexer = recordedIndexerAnswer;
      }

      // Nothing came alive; no raw hidden character in the drawn text (the edited textarea aside) or in an attribute.
      expect(await p.eval("window.__pwned")).toBeUndefined();
      expect(await p.eval<number>("document.querySelectorAll('#jsonrpc-view img, #jsonrpc-view script').length")).toBe(0);
      await setParams("eth_getBalance", "[]");
      expect(await p.eval<string>("document.querySelector('#jsonrpc-view').innerText")).not.toMatch(HIDDEN_RAW);
      for (const a of await p.eval<string[]>("[...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value))")) expect(a).not.toMatch(HIDDEN_RAW_ATTR);
      await shot(p, "jsonrpc-hostile.png");
      await clean(p, true);
      await p.close();
    } finally {
      await b.close();
    }
  }, 240_000);

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
      const output = await callFromTab(leader, "eth_chainId");
      expect(output.answer).toContain("\"0x960\"");
      await clean(leader, true);
      await leader.close();
    } finally {
      await b.close();
    }
  }, 300_000);
});
