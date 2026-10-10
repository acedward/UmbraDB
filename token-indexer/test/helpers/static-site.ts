/**
 * Local HTTP servers for the static build's browser tests, each on 127.0.0.1 at a random free port at or above 10000:
 *
 * - {@link serveStaticSite} serves a build folder, optionally with the header rules of its `_headers` file applied the
 *   way Netlify and Cloudflare Pages read them ({@link parseHeadersFile}), and optionally with extra routes;
 * - {@link serveCounter} answers every request with 200 and CORS `*` and counts them (an origin a page must not reach:
 *   a request it makes would succeed, so a refusal can only come from the page's policy);
 * - {@link serveHandler} serves any request handler the same way.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

export interface HeaderRule {
  pattern: string;
  headers: Array<[name: string, value: string]>;
}

/** The rules of a `_headers` file: a path pattern line, then its indented `Name: value` lines; `#` lines are comments. */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ pattern: line.trim(), headers: [] });
      continue;
    }
    const rule = rules.at(-1);
    const colon = line.indexOf(":");
    if (rule === undefined || colon < 0) throw new Error(`_headers: a header line outside a rule or without a colon: ${line}`);
    rule.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

/** The headers every matching rule gives a path (`*` matches any characters). */
export function headersFor(rules: readonly HeaderRule[], pathname: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rule of rules) {
    const re = new RegExp(`^${rule.pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    if (re.test(pathname)) out.push(...rule.headers);
  }
  return out;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".data": "application/octet-stream", ".gz": "application/gzip", ".json": "application/json",
};

export interface LocalServer {
  server: Server;
  origin: string;
  /** Requests received, by method and path (`GET /x`). */
  hits: Map<string, number>;
  close(): Promise<void>;
}

/** Serves `handler` on 127.0.0.1 at a random free port at or above 10000, counting requests in `hits`. */
export async function serveHandler(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<LocalServer> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const key = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    handler(req, res);
  });
  for (let attempt = 0; ; attempt++) {
    const port = 10_000 + Math.floor(Math.random() * 50_000);
    const ok = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => done(true));
    });
    if (ok) {
      return {
        server, origin: `http://127.0.0.1:${port}`, hits,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      };
    }
    if (attempt > 20) throw new Error("no free port at or above 10000 on 127.0.0.1");
  }
}

export interface StaticSiteOptions {
  /** Header rules applied to every answer of the site's files (none: no header beyond the content type). */
  headers?: readonly HeaderRule[];
  /** Extra routes, tried first; `true` = answered. */
  route?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
}

/** Serves `dir` (GET and HEAD; `/` is not mapped to a page) with `no-store` caching. */
export function serveStaticSite(dir: string, opts: StaticSiteOptions = {}): Promise<LocalServer> {
  const base = normalize(dir);
  return serveHandler((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (opts.route?.(req, res, url) === true) return;
    const file = normalize(join(base, decodeURIComponent(url.pathname)));
    if (!file.startsWith(base + sep) || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const headers: Record<string, string> = { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": String(body.length), "cache-control": "no-store" };
    for (const [name, value] of headersFor(opts.headers ?? [], url.pathname)) headers[name.toLowerCase()] = value;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

/** Answers anything with 200, `ok` and CORS `*` (preflights included), counting every request in `hits`. */
export function serveCounter(): Promise<LocalServer> {
  return serveHandler((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
    res.end("ok");
  });
}
