/**
 * The MIP-0018 read-only JSON API over Node's own `http` server, no framework: a thin wrapper that hands each request's
 * method and target to the runtime-neutral handler (`api.ts`) and writes its answer as it is — status, headers (the
 * CSP, `content-type` and `content-length` included) and body. Static routes (the explorer page, `ui/page.ts`
 * `serveUi`) can be answered in front of it through the `ui` hook; `serve()` (`serve-cli.ts`) mounts them so.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMip0018Handler, type Mip0018Handler, type Mip0018HandlerOptions } from "./api.ts";

/** Static routes answered before the API: `true` when it answered the request, else `false` with `res` untouched. */
export type StaticRoutes = (req: IncomingMessage, res: ServerResponse) => boolean;

export interface Mip0018ApiOptions extends Mip0018HandlerOptions {
  /** Server-side log line (errors), default stderr. */
  log?: (line: string) => void;
  /**
   * Static routes answered before the API (the explorer page, `ui/page.ts` `serveUi`). Default: none (`/ui` is then a
   * 404 like any unknown path).
   */
  ui?: StaticRoutes;
}

/** The API's HTTP server: a handler built from `opts` behind {@link createMip0018Server}. */
export function createMip0018Api(opts: Mip0018ApiOptions): Server {
  const { ui, ...handler } = opts;
  return createMip0018Server(createMip0018Handler({ ...handler, log: opts.log ?? ((line: string) => process.stderr.write(`${line}\n`)) }), ui);
}

/** Serves `api` over HTTP: the `ui` routes first (when given), then every other request through `api.handle`. */
export function createMip0018Server(api: Mip0018Handler, ui?: StaticRoutes): Server {
  return createServer((req, res) => {
    if (ui?.(req, res) === true) return;
    void api.handle(req.method ?? "GET", req.url ?? "/").then((r) => {
      res.writeHead(r.status, r.headers);
      res.end(r.body === "" ? undefined : r.body);
    });
  });
}

/** Binds the server and resolves with the port actually bound (`0` asks the OS for a free one). */
export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePort((server.address() as AddressInfo).port);
    });
  });
}
