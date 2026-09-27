import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * Project 00024-02 — a real HTTP host for bundles, for the fetch guard and the drain tests: the
 * indexer's own transport (`interface/fetch-guard.ts`) talks to it over TCP, exactly as it would to a
 * publisher's host. Listens on 127.0.0.1 on an OS-chosen ephemeral port (free by construction; the
 * workspace's ≥ 10000 rule holds in practice). Records every request.
 *
 * `files` maps a URL path (`/pi/index.json`) to its body; `routes` override a path with a behaviour.
 */

export type Route =
  | { kind: "redirect"; location: string; status?: number }
  | { kind: "status"; status: number }
  | { kind: "stall" }
  /** Destroys the connection without an answer (the client sees a reset). */
  | { kind: "reset" }
  | { kind: "body"; body: Buffer; headers?: Record<string, string>; chunked?: boolean };

export interface BundleHost {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  port: number;
  files: Map<string, Buffer>;
  routes: Map<string, Route>;
  requests: { path: string; headers: IncomingMessage["headers"] }[];
  /** Serve `bundle` (path → bytes) under `base` (e.g. `/pi/`). */
  mount(base: string, bundle: ReadonlyMap<string, Buffer>): void;
  close(): Promise<void>;
}

export async function startBundleHost(): Promise<BundleHost> {
  const files = new Map<string, Buffer>();
  const routes = new Map<string, Route>();
  const requests: BundleHost["requests"] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURI((req.url ?? "/").split("?")[0]!);
    requests.push({ path, headers: req.headers });
    const route = routes.get(path);
    if (route?.kind === "stall") return; // never answers; the client's deadline must end it
    if (route?.kind === "reset") { req.socket.destroy(); return; }
    if (route?.kind === "redirect") {
      res.writeHead(route.status ?? 302, route.location === "" ? {} : { location: route.location });
      res.end();
      return;
    }
    if (route?.kind === "status") {
      res.writeHead(route.status, { "content-type": "text/plain" });
      res.end(`status ${route.status}`);
      return;
    }
    const body = route?.kind === "body" ? route.body : files.get(path);
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const headers: Record<string, string> = { "content-type": "application/octet-stream", ...(route?.kind === "body" ? route.headers ?? {} : {}) };
    if (route?.kind === "body" && route.chunked === true) {
      res.writeHead(200, headers); // no Content-Length: chunked transfer
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      res.end(body.subarray(Math.floor(body.length / 2)));
      return;
    }
    res.writeHead(200, { ...headers, "content-length": String(body.length) });
    res.end(body);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    files,
    routes,
    requests,
    mount(base, bundle) {
      for (const [p, body] of bundle) files.set(`${base}${p}`, body);
    },
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
    }),
  };
}
