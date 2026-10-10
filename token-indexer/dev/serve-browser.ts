/**
 * Serves the static browser build (`npm run build:browser` → `dist-browser/`) on this machine the way a static host
 * must serve it (`token-indexer/browser/README.md`, "Static hosting"):
 *
 * - every file with the headers its `_headers` file gives that path (the build writes one rule, `/*`: the
 *   Content-Security-Policy, which reaches the engine worker only as a response header, and cross-origin isolation);
 * - the content type of the file's extension ({@link CONTENT_TYPES}): `.wasm` as `application/wasm`, and the gzip
 *   tapes as `application/gzip` with no `Content-Encoding`, so the worker receives the compressed bytes whose SHA-256 it
 *   checks before it decompresses them;
 * - a path ending in `/` as that folder's `index.html` (the explorer), anything else as the file it names; nothing
 *   outside the folder.
 *
 *   npm run serve:browser [-- --dir dist-browser --host 127.0.0.1 --port 10100]
 *
 * `--port 0` takes any free port; the address is printed. The browser keeps the engine's store per origin (scheme,
 * host and port), so serve on the same address to find a store again. Chrome runs the engine only in a secure context:
 * `https:`, or `http:` on a loopback host (`127.0.0.1`, `localhost`). SIGINT/SIGTERM stop the server.
 *
 * The browser tests serve their builds through the same handler (`test/helpers/static-site.ts`).
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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

/** The content type of every kind of file the build writes; anything else is `application/octet-stream`. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".gz": "application/gzip",
  ".json": "application/json",
  ".tar": "application/x-tar",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export interface StaticSiteOptions {
  /** Header rules applied to every answer of the site's files (none: no header beyond the content type). */
  headers?: readonly HeaderRule[];
  /** Extra routes, tried first; `true` = answered. */
  route?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
}

/**
 * A request handler serving the files of `dir` (GET and HEAD) with `no-store` caching, each with its content type and
 * the headers `opts.headers` give its path; a path ending in `/` is that folder's `index.html`. Anything else is 404.
 */
export function staticSiteHandler(dir: string, opts: StaticSiteOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const base = normalize(resolve(dir));
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (opts.route?.(req, res, url) === true) return;
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = "";
    }
    const file = normalize(join(base, pathname.endsWith("/") ? `${pathname}index.html` : pathname));
    if (pathname === "" || !file.startsWith(base + sep) || (req.method !== "GET" && req.method !== "HEAD")) {
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
    const headers: Record<string, string> = { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "content-length": String(body.length), "cache-control": "no-store" };
    for (const [name, value] of headersFor(opts.headers ?? [], url.pathname)) headers[name.toLowerCase()] = value;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

export interface ServedSite {
  server: Server;
  /** `http://<host>:<port>` as bound. */
  origin: string;
  /** The header rules read from the build's `_headers`. */
  rules: HeaderRule[];
  close(): Promise<void>;
}

/** Serves the build in `dir` with the headers of its `_headers` file; fails when the build has none. */
export async function serveBrowserBuild(opts: { dir: string; host?: string; port?: number }): Promise<ServedSite> {
  const dir = resolve(opts.dir);
  let text: string;
  try {
    text = readFileSync(join(dir, "_headers"), "utf8");
  } catch {
    throw new Error(`${join(dir, "_headers")} is missing: serve the folder npm run build:browser writes (it writes that file)`);
  }
  const rules = parseHeadersFile(text);
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(staticSiteHandler(dir, { headers: rules }));
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 10_100, host, () => {
      server.off("error", fail);
      done();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    origin: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    rules,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { dir: { type: "string", default: "dist-browser" }, host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "10100" } },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`serve-browser: --port ${JSON.stringify(values.port)} is not a port (0 = any free port)`);
    process.exit(2);
  }
  let site: ServedSite;
  try {
    site = await serveBrowserBuild({ dir: values.dir!, host: values.host!, port });
  } catch (e) {
    console.error(`serve-browser: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const headerCount = site.rules.reduce((n, r) => n + r.headers.length, 0);
  console.log(`serving ${resolve(values.dir!)} at ${site.origin}/ with the ${headerCount} headers of its _headers file`);
  console.log(`  indexer:            ${site.origin}/ (overview, token explorer, database)`);
  console.log(`  system status page: ${site.origin}/system.html`);
  if (!["127.0.0.1", "localhost", "::1"].includes(values.host!))
    console.log("  note: Chrome runs the engine only in a secure context: open the site through a loopback address (127.0.0.1, localhost) or serve it over https");
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void site.close().then(() => process.exit(0)));
}
