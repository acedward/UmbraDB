/**
 * The browser engine's static build for the Chrome tests: built with Vite (`token-indexer/browser/vite.config.ts`, plus
 * any `define`) into a temporary folder, served from 127.0.0.1 on a random free port at or above 10000, with the chain's
 * two endpoints (`/chain/rpc`, `/chain/graphql`) answered by a swappable handler (a recorded range, or a refusal while
 * the test says the chain is down); and a driver for the engine page (`engine.html`, whose `window.umbradbEngine` holds
 * the client) in a page of `cdp-browser.ts`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostStatus } from "../../browser/protocol.ts";
import type { Page } from "./cdp-browser.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const BROWSER_CONFIG = join(REPO_ROOT, "token-indexer/browser/vite.config.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".data": "application/octet-stream",
  ".gz": "application/gzip", ".json": "application/json", ".css": "text/css",
};

/** Answers one chain request (path `/rpc` or `/graphql`, the request body). */
export type ChainAnswer = (path: string, body: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

export interface EngineSite {
  origin: string;
  /** The folder of the built site it serves (it can be set after the server starts, when the build needs `origin`). */
  dir: string;
  /** The chain's endpoints as the engine's `network` source names them. */
  nodeUrl: string;
  indexerUrl: string;
  /** The handler of the chain's endpoints; replace it to change what the chain answers. */
  chain: ChainAnswer;
  /** Chain requests received, in order: `[path, JSON-RPC method or "graphql"]`. */
  chainRequests: Array<{ path: string; method: string; height: number | null }>;
  close(): Promise<void>;
}

/** A chain that refuses every request with 503 (an unreachable or failing endpoint). */
export const chainDown: ChainAnswer = async () => ({ status: 503, headers: { "content-type": "text/plain" }, body: "down" });

/** The JSON-RPC method (or `graphql`) and the height a chain request asks for, for the request log. */
function describe(path: string, body: string): { method: string; height: number | null } {
  try {
    const b = JSON.parse(body) as { method?: string; params?: unknown[]; variables?: { height?: number } };
    if (path === "/rpc") return { method: b.method ?? "?", height: typeof b.params?.[0] === "number" ? (b.params[0] as number) : null };
    return { method: "graphql", height: typeof b.variables?.height === "number" ? b.variables.height : null };
  } catch {
    return { method: "?", height: null };
  }
}

/** Serves the built site and the chain on 127.0.0.1. */
export async function serveEngineSite(dir = "", chain: ChainAnswer = chainDown): Promise<EngineSite> {
  const site = { dir, chain, chainRequests: [] as EngineSite["chainRequests"] } as EngineSite;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/chain/")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const path = url.pathname.slice("/chain".length);
        const body = Buffer.concat(chunks).toString("utf8");
        site.chainRequests.push({ path, ...describe(path, body) });
        void site.chain(path, body).then((a) => {
          res.writeHead(a.status, { ...a.headers, "access-control-allow-origin": "*" });
          res.end(a.body);
        }, () => res.writeHead(500).end());
      });
      return;
    }
    const file = normalize(join(site.dir, decodeURIComponent(url.pathname)));
    if (site.dir === "" || !file.startsWith(site.dir + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": body.length, "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  for (let attempt = 0; ; attempt++) {
    const port = 10_000 + Math.floor(Math.random() * 50_000);
    const ok = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => done(true));
    });
    if (ok) {
      site.origin = `http://127.0.0.1:${port}`;
      break;
    }
    if (attempt > 20) throw new Error("no free port at or above 10000 on 127.0.0.1");
  }
  site.nodeUrl = `${site.origin}/chain/rpc`;
  site.indexerUrl = `${site.origin}/chain/graphql`;
  site.close = () => new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
  return site;
}

/** The `define` of a build whose engine does not start by itself. */
export const NO_AUTO_START = { __UMBRADB_BROWSER_CONFIG__: JSON.stringify({ autoStart: false }) };

/** Builds the static site into a new temporary folder (removed with `rmSync` by the caller); `define` as Vite's. */
export async function buildEngineSite(define: Record<string, string>): Promise<string> {
  const { build } = await import("vite");
  const out = mkdtempSync(join(tmpdir(), "umbradb-browser-build-"));
  try {
    await build({ logLevel: "silent", configFile: BROWSER_CONFIG, define, build: { outDir: out, emptyOutDir: true } });
  } catch (e) {
    rmSync(out, { recursive: true, force: true });
    throw new Error(`the browser build failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

/** Drives the engine page in `page`. */
export function engineDriver(page: Page, site: () => EngineSite) {
  const engine = (expr: string): Promise<Json> => page.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
  const status = (): Promise<HostStatus> => engine("c.status()");
  return {
    engine,
    status,
    async api(target: string): Promise<{ status: number; body: Json }> {
      const r = (await engine(`c.api("GET", ${JSON.stringify(target)})`)) as { status: number; body: string };
      return { status: r.status, body: JSON.parse(r.body) };
    },
    async until(what: string, ok: (s: HostStatus) => boolean, timeoutMs = 120_000): Promise<HostStatus> {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const s = await status();
        if (ok(s)) return s;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ boot: s.boot.phase, cursors: s.cursors, engine: s.engine?.status })}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    /** Loads the engine page and waits until the worker's boot has ended. */
    async open(): Promise<HostStatus> {
      await page.goto(`${site().origin}/engine.html`);
      await page.waitFor("window.umbradbEngine !== undefined", 30_000, "the engine page");
      await page.eval("window.umbradbEngine.client.booted()");
      return status();
    },
  };
}

interface CdpConnection {
  send(method: string, params?: Json, sessionId?: string): Promise<Json>;
  on(method: string, listener: (params: Json, sessionId: string | undefined) => void): void;
}

/**
 * Evaluates expressions in the dedicated workers of `page` (the engine's worker): the page's DevTools session
 * auto-attaches to its workers, without pausing them, and `eval` runs in the newest one still attached (a reload
 * replaces it). For tests that replace a browser API inside the worker, such as `navigator.storage.estimate`.
 */
export async function workerSessions(page: Page): Promise<{ eval(expression: string, timeoutMs?: number): Promise<Json> }> {
  const conn = (page as unknown as { conn: CdpConnection }).conn;
  const attached: string[] = [];
  conn.on("Target.attachedToTarget", (p, s) => {
    if (s === page.sessionId && p.targetInfo?.type === "worker") attached.push(p.sessionId as string);
  });
  conn.on("Target.detachedFromTarget", (p, s) => {
    if (s !== page.sessionId) return;
    const i = attached.indexOf(p.sessionId as string);
    if (i >= 0) attached.splice(i, 1);
  });
  await conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page.sessionId);
  return {
    async eval(expression: string, timeoutMs = 10_000): Promise<Json> {
      const end = Date.now() + timeoutMs;
      while (attached.length === 0) {
        if (Date.now() > end) throw new Error("no worker attached to the page");
        await new Promise((r) => setTimeout(r, 50));
      }
      const r = await conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, attached[attached.length - 1]);
      if (r.exceptionDetails !== undefined) throw new Error(`worker evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
  };
}
