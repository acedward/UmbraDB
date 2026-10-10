/**
 * The static build's security headers, checked on the build output (Node, Vite; no browser): the policy every page
 * carries and the `_headers` file beside them (`token-indexer/browser/build-csp.ts`), the build-time chain that sets
 * `connect-src`, and the Trusted Types policy that makes the engine worker's URL (`token-indexer/browser/trusted-worker.ts`).
 * The same build is exercised in Chrome by `browser-csp.test.ts`.
 *
 * - `[[browser.csp.policy]]` — the default build: `engine.html` opens its `<head>` with the meta policy (its inline
 *   style admitted by the SHA-256 of the bytes written) and `no-referrer`; `_headers` gives every path the same policy
 *   plus `frame-ancestors 'none'`, cross-origin isolation and the hardening headers; `connect-src` is the site and the two
 *   Stagenet origins; nothing admits `'unsafe-eval'` or `'unsafe-inline'`; the bundles carry Stagenet's endpoints.
 * - `[[browser.csp.every-page]]` — any HTML input gets the policy with the hashes of its own inline scripts and styles,
 *   `_headers` admits the union, the prelude module runs first in each page; a page with an inline event handler, a
 *   `style` attribute or a `javascript:` URL fails the build.
 * - `[[browser.csp.chain-config]]` — the chain comes from `UMBRADB_BROWSER_*` (https, or http on a loopback host; no
 *   credentials; a network id), and a build configured with other endpoints admits exactly their origins and carries them.
 * - `[[browser.csp.trusted-worker]]` — the worker policy accepts only a same-origin script inside the loading module's
 *   directory, is created once under its allowed name, and hands the `Worker` constructor its result.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { browserChainFromEnv, chainOrigins, staticSecurity } from "../browser/build-csp.ts";
import { DEFAULT_BROWSER_CHAIN } from "../browser/config.ts";
import { parseHeadersFile } from "./helpers/static-site.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG = join(ROOT, "token-indexer/browser/vite.config.ts");
const CHAIN_ENV = ["UMBRADB_BROWSER_NETWORK", "UMBRADB_BROWSER_NODE_URL", "UMBRADB_BROWSER_INDEXER_URL"] as const;

const sha = (text: string): string => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

/** The policy the build must write, given its hashes and `connect-src` origins. */
function expectedPolicy(connect: string[], scripts: string[], styles: string[], header: boolean): string {
  return [
    "default-src 'none'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...scripts].join(" "),
    ["style-src 'self'", ...styles].join(" "),
    "img-src 'self'",
    "font-src 'self'",
    ["connect-src 'self'", ...connect].join(" "),
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    ...(header ? ["frame-ancestors 'none'"] : []),
    "require-trusted-types-for 'script'",
    "trusted-types umbradb-engine-worker",
  ].join("; ");
}

function expectedHeaders(csp: string): string {
  return [
    "# Security headers for every file of this static build; written by the build (token-indexer/browser/build-csp.ts).",
    "# Netlify and Cloudflare Pages read this file; other hosts must send the same headers (token-indexer/browser/README.md).",
    "/*",
    `  Content-Security-Policy: ${csp}`,
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Embedder-Policy: require-corp",
    "  Cross-Origin-Resource-Policy: same-origin",
    "  Referrer-Policy: no-referrer",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "",
  ].join("\n");
}

/** The meta policy of a written page (it must open the `<head>`, right after `<meta charset>`). */
function metaPolicy(html: string): string {
  const m = /<head>\s*<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy" content="([^"]*)">\s*<meta name="referrer" content="no-referrer">/.exec(html);
  if (m === null) throw new Error(`the page does not open its head with the policy:\n${html}`);
  return m[1]!.replace(/&quot;/g, '"');
}

const inlineBlocks = (html: string, tag: "script" | "style"): string[] =>
  [...html.matchAll(new RegExp(`<${tag}(?![^>]*\\ssrc=)[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!).filter((t) => t !== "");

/** Builds with Vite (output in a new temporary folder); returns the folder, or the build's error message. */
async function build(opts: Record<string, unknown>, env: Partial<Record<(typeof CHAIN_ENV)[number], string>> = {}): Promise<{ out: string; error?: string }> {
  const { build: viteBuild } = await import("vite");
  const out = mkdtempSync(join(tmpdir(), "umbradb-csp-build-"));
  const saved = CHAIN_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of CHAIN_ENV) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const o = opts as { build?: Record<string, unknown> };
    await viteBuild({ logLevel: "silent", ...opts, build: { ...o.build, outDir: out, emptyOutDir: true } });
    return { out };
  } catch (e) {
    return { out, error: e instanceof Error ? e.message : String(e) };
  } finally {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

describe("static build security headers", () => {
  let out: string;

  beforeAll(async () => {
    const r = await build({ configFile: CONFIG });
    temps.push(r.out);
    if (r.error !== undefined) throw new Error(`the browser build failed: ${r.error}`);
    out = r.out;
  }, 120_000);

  it("[[browser.csp.policy]] the default build: engine.html opens its head with the policy (inline style by its SHA-256) and no-referrer; _headers gives every path the same policy plus frame-ancestors, cross-origin isolation and hardening headers; connect-src is the site and the two Stagenet origins; no unsafe-eval or unsafe-inline", () => {
    expect(readdirSync(out).sort()).toEqual(["THIRD-PARTY-NOTICES.txt", "_headers", "assets", "engine.html", "index.html", "system.html"]);
    const html = read(out, "engine.html");
    expect(inlineBlocks(html, "script")).toEqual([]);
    const styles = inlineBlocks(html, "style");
    expect(styles).toHaveLength(1);
    const stagenet = ["https://rpc.stagenet.shielded.tools", "https://indexer.stagenet.shielded.tools"];
    const meta = metaPolicy(html);
    expect(meta).toBe(expectedPolicy(stagenet, [], [sha(styles[0]!)], false));
    const header = expectedPolicy(stagenet, [], [sha(styles[0]!)], true);
    expect(read(out, "_headers")).toBe(expectedHeaders(header));
    expect(parseHeadersFile(read(out, "_headers"))).toEqual([{ pattern: "/*", headers: expect.arrayContaining([["Content-Security-Policy", header]]) }]);
    for (const policy of [meta, header]) {
      expect(policy).not.toMatch(/'unsafe-eval'|'unsafe-inline'|'unsafe-hashes'|\*|data:|blob:|http:/);
      expect(policy.split("; ").map((d) => d.split(" ")[0])).not.toContain("report-uri");
    }

    // Both bundles carry the chain the policy admits.
    const js = readdirSync(join(out, "assets")).filter((f) => f.endsWith(".js"));
    const worker = js.find((f) => /^worker-.*\.js$/.test(f))!;
    expect(read(join(out, "assets"), worker)).toContain(DEFAULT_BROWSER_CHAIN.nodeUrl);
    expect(read(join(out, "assets"), worker)).toContain(DEFAULT_BROWSER_CHAIN.indexerUrl);
    expect(js.filter((f) => read(join(out, "assets"), f).includes("umbradb-engine-worker")).length).toBeGreaterThan(0);
  });

  it("[[browser.csp.every-page]] every HTML input gets the policy with its own inline hashes, _headers admits their union, the prelude runs first in each page; inline event handlers, style attributes and javascript: URLs fail the build", async () => {
    const root = mkdtempSync(join(tmpdir(), "umbradb-csp-pages-"));
    temps.push(root);
    const file = (name: string, text: string): string => {
      writeFileSync(join(root, name), text);
      return join(root, name);
    };
    file("prelude.ts", 'console.log("prelude-marker");\n');
    file("a.ts", 'import "./a.css";\nconsole.log("page-a-marker");\n');
    file("a.css", "main { color: navy; }\n");
    file("b.ts", 'console.log("page-b-marker");\n');
    const a = file("a.html", '<!doctype html>\n<html><head><meta charset="utf-8"><title>a</title>\n<style>h1 { color: teal }</style>\n<script>window.inlineA = 1;</script>\n<script type="module" src="./a.ts"></script>\n</head><body><h1>a</h1><script>window.inlineA2 = 2;</script></body></html>\n');
    const b = file("b.html", '<!doctype html>\n<html><head><meta charset="utf-8"><title>b</title>\n<style>p { margin: 0 }</style>\n<script type="module" src="./b.ts"></script>\n</head><body><p>b</p></body></html>\n');
    const plugin = (): ReturnType<typeof staticSecurity> => staticSecurity({ connectSrc: ["https://node.example", "https://indexer.example:8443"], prelude: join(root, "prelude.ts"), root });
    const site = (input: Record<string, string>) => ({ configFile: false, root, base: "./", plugins: [plugin()], build: { target: "esnext", assetsInlineLimit: 0, rolldownOptions: { input } } });

    const r = await build(site({ a, b }));
    temps.push(r.out);
    expect(r.error).toBeUndefined();
    const connect = ["https://node.example", "https://indexer.example:8443"];
    const hashes: { scripts: string[]; styles: string[] } = { scripts: [], styles: [] };
    for (const page of ["a.html", "b.html"]) {
      const html = read(r.out, page);
      const scripts = inlineBlocks(html, "script").map(sha);
      const styles = inlineBlocks(html, "style").map(sha);
      expect(styles).toHaveLength(1);
      expect(metaPolicy(html)).toBe(expectedPolicy(connect, scripts, styles, false));
      hashes.scripts.push(...scripts);
      hashes.styles.push(...styles);
      // The page's entry module runs the prelude first: inline before the page's code, or as its first import.
      const entry = /<script type="module" crossorigin src="\.\/(assets\/[^"]+)"><\/script>/.exec(html)![1]!;
      const code = read(r.out, entry);
      const marker = page === "a.html" ? "page-a-marker" : "page-b-marker";
      expect(code).toContain(marker);
      if (code.includes("prelude-marker")) expect(code.indexOf("prelude-marker")).toBeLessThan(code.indexOf(marker));
      else expect(read(join(r.out, "assets"), /^import\s*["'`]\.\/([^"'`]+)["'`]/.exec(code)![1]!)).toContain("prelude-marker");
    }
    expect(hashes.scripts).toHaveLength(2); // page a's two inline scripts
    expect(read(r.out, "a.html")).toMatch(/<link rel="stylesheet" crossorigin href="\.\/assets\/a-[\w-]+\.css">/); // admitted by style-src 'self'
    expect(read(r.out, "_headers")).toBe(expectedHeaders(expectedPolicy(connect, [...hashes.scripts].sort(), [...hashes.styles].sort(), true)));

    const refused = async (name: string, body: string): Promise<string | undefined> => {
      const page = file(name, `<!doctype html>\n<html><head><meta charset="utf-8"><title>x</title></head><body>${body}</body></html>\n`);
      const x = await build(site({ [name.replace(".html", "")]: page }));
      temps.push(x.out);
      return x.error;
    };
    expect(await refused("handler.html", '<button type="button" onclick="go()">go</button>')).toContain("handler.html: the Content-Security-Policy would block an inline event handler (onclick)");
    expect(await refused("styled.html", '<p style="color: red">x</p>')).toContain("styled.html: the Content-Security-Policy would block a style attribute");
    expect(await refused("link.html", '<a href="javascript:void 0">x</a>')).toContain("link.html: the Content-Security-Policy would block a javascript: URL");
    // Attribute text that only looks like a handler is fine.
    expect(await refused("text.html", '<p title="say onclick=x and style=y">onclick="z" style="w"</p>')).toBeUndefined();
    expect(() => staticSecurity({ connectSrc: ["https://node.example/rpc"] })).toThrow("connect-src: https://node.example/rpc is not an origin");
  }, 120_000);

  it("[[browser.csp.chain-config]] the chain comes from UMBRADB_BROWSER_* (https, or http on a loopback host, no credentials, a network id); a build configured with other endpoints admits exactly their origins and carries them", async () => {
    expect(browserChainFromEnv({})).toEqual(DEFAULT_BROWSER_CHAIN);
    expect(browserChainFromEnv({ UMBRADB_BROWSER_NETWORK: "", UMBRADB_BROWSER_NODE_URL: "" })).toEqual(DEFAULT_BROWSER_CHAIN);
    const custom = { UMBRADB_BROWSER_NETWORK: "preprod", UMBRADB_BROWSER_NODE_URL: "https://rpc.preprod.example", UMBRADB_BROWSER_INDEXER_URL: "https://indexer.preprod.example/api/v4/graphql" };
    expect(browserChainFromEnv(custom)).toEqual({ network: "preprod", nodeUrl: "https://rpc.preprod.example", indexerUrl: "https://indexer.preprod.example/api/v4/graphql" });
    expect(browserChainFromEnv({ UMBRADB_BROWSER_NODE_URL: "http://127.0.0.1:12345/chain/rpc" }).nodeUrl).toBe("http://127.0.0.1:12345/chain/rpc");
    expect(browserChainFromEnv({ UMBRADB_BROWSER_INDEXER_URL: "http://localhost:9/graphql" }).indexerUrl).toBe("http://localhost:9/graphql");
    expect(() => browserChainFromEnv({ UMBRADB_BROWSER_NODE_URL: "http://rpc.example" })).toThrow("UMBRADB_BROWSER_NODE_URL: http://rpc.example is not https");
    expect(() => browserChainFromEnv({ UMBRADB_BROWSER_INDEXER_URL: "wss://indexer.example" })).toThrow("is not https");
    expect(() => browserChainFromEnv({ UMBRADB_BROWSER_NODE_URL: "https://user:secret@rpc.example" })).toThrow("the URL carries credentials");
    expect(() => browserChainFromEnv({ UMBRADB_BROWSER_NODE_URL: "rpc.example" })).toThrow("is not an absolute URL");
    expect(() => browserChainFromEnv({ UMBRADB_BROWSER_NETWORK: "Stage Net" })).toThrow("is not a network id");
    expect(chainOrigins({ network: "x", nodeUrl: "https://chain.example/rpc", indexerUrl: "https://chain.example/graphql" })).toEqual(["https://chain.example"]);
    expect(chainOrigins(DEFAULT_BROWSER_CHAIN)).toEqual(["https://rpc.stagenet.shielded.tools", "https://indexer.stagenet.shielded.tools"]);

    const r = await build({ configFile: CONFIG }, custom);
    temps.push(r.out);
    expect(r.error).toBeUndefined();
    const html = read(r.out, "engine.html");
    const style = sha(inlineBlocks(html, "style")[0]!);
    const origins = ["https://rpc.preprod.example", "https://indexer.preprod.example"];
    expect(metaPolicy(html)).toBe(expectedPolicy(origins, [], [style], false));
    expect(read(r.out, "_headers")).toBe(expectedHeaders(expectedPolicy(origins, [], [style], true)));
    const assets = join(r.out, "assets");
    const all = readdirSync(assets).filter((f) => f.endsWith(".js")).map((f) => read(assets, f)).join("\n");
    expect(all).toContain("https://indexer.preprod.example/api/v4/graphql");
    expect(all).toMatch(/network:\s*["'`]preprod["'`]/);
    expect(all).not.toContain("stagenet.shielded.tools");
    expect((await build({ configFile: CONFIG }, { UMBRADB_BROWSER_NODE_URL: "http://rpc.example" })).error).toContain("UMBRADB_BROWSER_NODE_URL: http://rpc.example is not https");
  }, 120_000);
});

describe("the engine worker's Trusted Types policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("[[browser.csp.trusted-worker]] accepts only a same-origin script inside the loading module's directory, is created once under its allowed name, and hands the Worker constructor its result", async () => {
    const { checkWorkerScriptUrl, ENGINE_WORKER_POLICY } = await import("../browser/trusted-worker.ts");
    expect(ENGINE_WORKER_POLICY).toBe("umbradb-engine-worker");
    const built = "https://site.example/app/assets/engine-1.js";
    expect(checkWorkerScriptUrl("worker-2.js", built, "https://site.example")).toBe("https://site.example/app/assets/worker-2.js");
    expect(checkWorkerScriptUrl("https://site.example/app/assets/worker-2.js", built, "https://site.example")).toBe("https://site.example/app/assets/worker-2.js");
    const dev = "http://127.0.0.1:5173/trusted-worker.ts";
    expect(checkWorkerScriptUrl("/worker.ts?worker_file&type=module", dev, "http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/worker.ts?worker_file&type=module");
    for (const [input, why] of [
      ["https://other.example/app/assets/worker-2.js", "https://other.example is not this page's origin"],
      ["../worker-2.js", "/app/worker-2.js is outside /app/assets/"],
      ["%2e%2e/evil.js", "/app/evil.js is outside /app/assets/"],
      ["/app/other/worker.js", "/app/other/worker.js is outside /app/assets/"],
      ["data:text/javascript,1", "null is not this page's origin"],
      ["blob:https://site.example/1234", "is outside /app/assets/"],
      ["http://[", "is not a URL"],
    ] as const) expect(() => checkWorkerScriptUrl(input, built, "https://site.example"), input).toThrow(why);
    expect(() => checkWorkerScriptUrl("worker-2.js", built, "https://elsewhere.example")).toThrow(TypeError);

    // Without Trusted Types the constructor is the global Worker.
    class FakeWorker {
      constructor(readonly scriptUrl: unknown, readonly options?: unknown) {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    expect((await import("../browser/trusted-worker.ts")).trustedWorkerConstructor()).toBe(FakeWorker);

    // With Trusted Types: one policy, under the allowed name, whose output reaches the Worker constructor.
    vi.resetModules();
    const created: string[] = [];
    vi.stubGlobal("trustedTypes", {
      createPolicy(name: string, rules: { createScriptURL(input: string): string }) {
        created.push(name);
        return { createScriptURL: (input: string) => ({ trusted: rules.createScriptURL(input) }) };
      },
    });
    const mod = await import("../browser/trusted-worker.ts");
    const moduleDir = new URL(".", new URL("../browser/trusted-worker.ts", import.meta.url));
    vi.stubGlobal("location", { origin: moduleDir.origin });
    const W = mod.trustedWorkerConstructor();
    const w = new W(new URL("worker.ts", moduleDir), { type: "module", name: "umbradb-engine" }) as unknown as FakeWorker;
    expect(w).toBeInstanceOf(FakeWorker);
    expect(w.scriptUrl).toEqual({ trusted: new URL("worker.ts", moduleDir).href });
    expect(w.options).toEqual({ type: "module", name: "umbradb-engine" });
    mod.trustedWorkerConstructor();
    expect(created).toEqual(["umbradb-engine-worker"]);
    expect(() => new W("https://other.example/worker.js")).toThrow("is not this page's origin");
  });
});
