/**
 * One MIP-0018 API handler reached two ways: over HTTP through the `node:http` wrapper (`api-node.ts`), and directly
 * through its `handle()` (`api.ts`). Every request is sent both ways, HTTP first, and the two answers must be
 * identical: the status, every header the handler sets (Node's server adds only its own `date`, `connection` and
 * `keep-alive`) and the body. The direct call gets exactly the method and request target the HTTP server received.
 */
import type { IncomingMessage, Server } from "node:http";
import { expect } from "vitest";
import type { Mip0018Handler } from "../../mip0018/api.ts";
import { createMip0018Server, listen } from "../../mip0018/api-node.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
export interface Resp { status: number; headers: Headers; text: string; json: Json }

/** Headers Node's HTTP server writes on its own; the handler's answer never carries them. */
const SERVER_HEADERS = new Set(["date", "connection", "keep-alive"]);
/** Request header that pairs an HTTP request with what the server received (the API ignores request headers). */
const TAG = "x-both-ways-request";
let tags = 0;

export interface BothWays {
  base: string;
  server: Server;
  api: Mip0018Handler;
  /** Method and request target the server received, by tag. */
  received: Map<string, { method: string; target: string }>;
}

/** Serves `api` over HTTP on 127.0.0.1 (a free port) and keeps it reachable directly. */
export async function serveBothWays(api: Mip0018Handler): Promise<BothWays> {
  const received = new Map<string, { method: string; target: string }>();
  // The static-routes hook sees every request first: it records what arrived and answers nothing.
  const server = createMip0018Server(api, (req: IncomingMessage) => {
    const tag = req.headers[TAG];
    if (typeof tag === "string") received.set(tag, { method: req.method ?? "GET", target: req.url ?? "/" });
    return false;
  });
  const port = await listen(server, 0, "127.0.0.1");
  return { base: `http://127.0.0.1:${port}`, server, api, received };
}

function parse(text: string): Json {
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One request over HTTP only. */
export async function httpRequest(base: string, path: string, init?: RequestInit): Promise<Resp> {
  const r = await fetch(base + path, init);
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, json: parse(text) };
}

/** One request sent both ways; asserts the two answers are identical and returns the HTTP one. */
export async function requestBothWays(w: BothWays, path: string, init: RequestInit = {}): Promise<Resp> {
  const tag = String(++tags);
  const headers = new Headers(init.headers);
  headers.set(TAG, tag);
  const http = await httpRequest(w.base, path, { ...init, headers });
  const seen = w.received.get(tag);
  w.received.delete(tag);
  expect(seen, `${path}: received by the HTTP server`).toBeDefined();
  const direct = await w.api.handle(seen!.method, seen!.target);
  const httpHeaders = Object.fromEntries([...http.headers].filter(([name]) => !SERVER_HEADERS.has(name)));
  expect({ status: direct.status, headers: direct.headers, body: direct.body }, `${seen!.method} ${seen!.target}: handle() equals HTTP`)
    .toEqual({ status: http.status, headers: httpHeaders, body: http.text });
  return http;
}
