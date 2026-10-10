/**
 * Local HTTP servers for the static build's browser tests, each on 127.0.0.1 at a random free port at or above 10000:
 *
 * - {@link serveStaticSite} serves a build folder through the handler `npm run serve:browser` uses
 *   (`../../dev/serve-browser.ts`: the content types, the header rules of a `_headers` file applied the way Netlify
 *   and Cloudflare Pages read them), optionally with those rules ({@link parseHeadersFile}) and with extra routes;
 * - {@link serveCounter} answers every request with 200 and CORS `*` and counts them (an origin a page must not reach:
 *   a request it makes would succeed, so a refusal can only come from the page's policy);
 * - {@link serveHandler} serves any request handler the same way.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type StaticSiteOptions, staticSiteHandler } from "../../dev/serve-browser.ts";

export { type HeaderRule, headersFor, parseHeadersFile, type StaticSiteOptions } from "../../dev/serve-browser.ts";

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

/** Serves `dir` (GET and HEAD; a path ending in `/` is its `index.html`) with `no-store` caching. */
export function serveStaticSite(dir: string, opts: StaticSiteOptions = {}): Promise<LocalServer> {
  return serveHandler(staticSiteHandler(dir, opts));
}

/** Answers anything with 200, `ok` and CORS `*` (preflights included), counting every request in `hits`. */
export function serveCounter(): Promise<LocalServer> {
  return serveHandler((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
    res.end("ok");
  });
}
