/**
 * The browser engine's worker host (`token-indexer/browser/host.ts`) in Node, for tests: a host on PGlite (`memory://`
 * or a directory) with a supported-browser capability report, the tape catalog read from the repository's files, its
 * notices and log lines recorded, the stores it opens kept, and a page-side client over a `MessageChannel`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEngineClient, type EngineClient } from "../../browser/client.ts";
import { createWorkerHost, type WorkerHost, type WorkerHostOptions } from "../../browser/host.ts";
import { type CapabilityReport, type HostStatus, type Notice, PROTOCOL_VERSION, type Response } from "../../browser/protocol.ts";
import { openStore, type Store } from "../../browser/store.ts";
import { loadTape } from "../../browser/tapes.ts";

export const U1 = { from: 715402, to: 715433 } as const;
export const IDX = { from: 714485, to: 715183 } as const;

export const SUPPORTED: CapabilityReport = {
  supported: true,
  message: "",
  missing: [],
  checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: true },
  browser: "Chromium 153",
};

/** `fetch` for the tape catalog's `file:` URLs. */
export function fileFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    return new Response(new Uint8Array(readFileSync(fileURLToPath(url))));
  }) as typeof fetch;
}

export interface TestHost {
  host: WorkerHost;
  notices: Notice[];
  logs: string[];
  /** Every store the host opened, in order (a reopen adds one). */
  opened: Store[];
}

/** A host with test defaults; `over` replaces any option. Close it with `host.close()`. */
export function testHost(over: Partial<WorkerHostOptions> = {}): TestHost {
  const notices: Notice[] = [];
  const logs: string[] = [];
  const opened: Store[] = [];
  const host = createWorkerHost({
    network: "stagenet",
    dataDir: "memory://",
    nodeUrl: "https://node.invalid/",
    indexerUrl: "https://indexer.invalid/",
    checkCapabilities: async () => SUPPORTED,
    openStore: async (dir, o) => {
      const s = await openStore(dir, o);
      opened.push(s);
      return s;
    },
    loadTape: (range) => loadTape(range, fileFetch()),
    log: (level, message) => logs.push(`${level} ${message}`),
    ...over,
  });
  host.onNotice((n) => notices.push(n));
  return { host, notices, logs, opened };
}

let nextId = 1;
export async function call(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<Response> {
  return host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
}
export async function result<T = unknown>(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await call(host, type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiJson(host: WorkerHost, target: string): Promise<{ status: number; body: any }> {
  const r = await result<{ status: number; body: string }>(host, "api", { method: "GET", target });
  return { status: r.status, body: JSON.parse(r.body) };
}

export async function untilStatus(host: WorkerHost, what: string, ok: (s: HostStatus) => boolean, timeoutMs = 60_000): Promise<HostStatus> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await result<HostStatus>(host, "status");
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s.engine?.status ?? s.boot)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A page-side client of `host` over a `MessageChannel`, as the worker binds it (notices included). */
export function channelClient(host: WorkerHost): { client: EngineClient; close(): void } {
  const channel = new MessageChannel();
  const workerSide = channel.port2;
  workerSide.onmessage = (e: MessageEvent) => {
    void host.receive(e.data).then((r) => workerSide.postMessage(r));
  };
  const off = host.onNotice((n) => workerSide.postMessage(n));
  const pagePort = channel.port1;
  const client = createEngineClient({
    postMessage: (m) => pagePort.postMessage(m),
    addEventListener: (t, l) => pagePort.addEventListener(t, l as (e: MessageEvent) => void),
    removeEventListener: (t, l) => pagePort.removeEventListener(t, l as (e: MessageEvent) => void),
  });
  pagePort.start();
  return {
    client,
    close() {
      off();
      client.close();
      channel.port1.close();
      channel.port2.close();
    },
  };
}
