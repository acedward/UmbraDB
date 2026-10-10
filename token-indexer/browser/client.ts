/**
 * The page's side of the engine protocol (`protocol.ts`): each request becomes a promise of its validated result.
 *
 * `createEngineClient(endpoint)` works over anything that carries messages both ways (a `Worker`, a `MessagePort`);
 * `startEngineWorker()` starts the engine's dedicated module worker (`worker.ts`) and returns a client for it. A request
 * resolves with its result once the worker's response arrives and its result passes the protocol's schema; it rejects
 * with an {@link EngineError} carrying the worker's error code, or `bad-response` (a response that fails validation),
 * `worker-error` (the worker failed to load or crashed) or `closed` (the client was closed). A page that shares the engine
 * with other tabs (`tabs.ts`) can also get `leader-changed` and `leader-unavailable`.
 */
import {
  type ApiResult,
  type BootState,
  type ErrorCode,
  type HostStatus,
  type Notice,
  type ParamsOf,
  parseResult,
  parseWorkerMessage,
  PROTOCOL_VERSION,
  type RequestType,
  type ResultOf,
  type StartConfig,
} from "./protocol.ts";

/** Something that carries messages both ways. */
export interface EngineEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export type EngineErrorCode =
  | ErrorCode
  | "bad-response"
  | "worker-error"
  | "closed"
  /** The leader tab closed while a request that changes state was in flight to it (`tabs.ts`). */
  | "leader-changed"
  /** No leader tab answered in time (`tabs.ts`). */
  | "leader-unavailable";

export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string, readonly request: RequestType | null = null) {
    super(message);
    this.name = "EngineError";
  }
}

export interface EngineClient {
  /** Any request of the protocol. */
  request<T extends RequestType>(type: T, params: ParamsOf<T>): Promise<ResultOf<T>>;
  status(): Promise<HostStatus>;
  /** One API request (`token-indexer/API.md`); the answer as the API handler gives it. */
  api(method: string, target: string): Promise<ApiResult>;
  start(config?: StartConfig): Promise<HostStatus>;
  stop(): Promise<HostStatus>;
  range(startHeight: number | "tip", endHeight?: number): Promise<never>;
  reset(): Promise<never>;
  export(): Promise<never>;
  import(snapshot: Blob): Promise<never>;
  /** The boot state once the boot has ended (`ready`, `unsupported` or `failed`). */
  booted(): Promise<BootState>;
  /** Adds a notice listener; returns the function that removes it. */
  onNotice(listener: (notice: Notice) => void): () => void;
  /** Adds a listener for incoming messages that fail validation (they are dropped). */
  onInvalid(listener: (message: string) => void): () => void;
  /** Rejects every pending request with `reason` (default `closed`) and stops listening. */
  close(reason?: EngineError): void;
}

const ENDED: ReadonlySet<BootState["phase"]> = new Set(["ready", "unsupported", "failed"]);

export function createEngineClient(endpoint: EngineEndpoint): EngineClient {
  let nextId = 1;
  let closedWith: EngineError | undefined;
  const pending = new Map<number, { type: RequestType; resolve: (v: unknown) => void; reject: (e: EngineError) => void }>();
  const noticeListeners = new Set<(notice: Notice) => void>();
  const invalidListeners = new Set<(message: string) => void>();

  const invalid = (message: string): void => {
    for (const l of [...invalidListeners]) l(message);
  };

  const onMessage = (event: MessageEvent): void => {
    const m = parseWorkerMessage(event.data);
    if (m.kind === "invalid") return invalid(m.message);
    if (m.kind === "notice") {
      for (const l of [...noticeListeners]) l(m.notice);
      return;
    }
    const r = m.response;
    const p = r.id === null ? undefined : pending.get(r.id);
    if (p === undefined) return invalid(`a response to no pending request (id ${String(r.id)})`);
    pending.delete(r.id!);
    if (r.request !== p.type) return p.reject(new EngineError("bad-response", `a ${String(r.request)} response to a ${p.type} request`, p.type));
    if (!r.ok) return p.reject(new EngineError(r.error.code, r.error.message, p.type));
    const result = parseResult(p.type, r.result);
    if (!result.ok) return p.reject(new EngineError("bad-response", `the ${p.type} result is invalid: ${result.message}`, p.type));
    p.resolve(result.result);
  };
  endpoint.addEventListener("message", onMessage);

  function request<T extends RequestType>(type: T, params: ParamsOf<T>): Promise<ResultOf<T>> {
    if (closedWith !== undefined) return Promise.reject(closedWith);
    const id = nextId++;
    return new Promise<ResultOf<T>>((resolve, reject) => {
      pending.set(id, { type, resolve: resolve as (v: unknown) => void, reject });
      try {
        endpoint.postMessage({ ...params, v: PROTOCOL_VERSION, id, type });
      } catch (e) {
        pending.delete(id);
        reject(new EngineError("closed", `the request could not be sent: ${e instanceof Error ? e.message : String(e)}`, type));
      }
    });
  }

  const client: EngineClient = {
    request,
    status: () => request("status", {}),
    api: (method, target) => request("api", { method, target }),
    start: (config = {}) => request("start", { config }),
    stop: () => request("stop", {}),
    range: (startHeight, endHeight) => request("range", endHeight === undefined ? { startHeight } : { startHeight, endHeight }),
    reset: () => request("reset", {}),
    export: () => request("export", {}),
    import: (snapshot) => request("import", { snapshot }),

    booted(): Promise<BootState> {
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (boot: BootState): void => {
          if (done || !ENDED.has(boot.phase)) return;
          done = true;
          off();
          resolve(boot);
        };
        const off = client.onNotice((n) => { if (n.notice === "boot") finish(n.boot); });
        request("status", {}).then((s) => finish(s.boot), (e: unknown) => {
          if (done) return;
          done = true;
          off();
          reject(e);
        });
      });
    },

    onNotice(listener) {
      noticeListeners.add(listener);
      return () => { noticeListeners.delete(listener); };
    },

    onInvalid(listener) {
      invalidListeners.add(listener);
      return () => { invalidListeners.delete(listener); };
    },

    close(reason = new EngineError("closed", "the engine client is closed")) {
      if (closedWith !== undefined) return;
      closedWith = reason;
      endpoint.removeEventListener("message", onMessage);
      for (const p of pending.values()) p.reject(new EngineError(reason.code, reason.message, p.type));
      pending.clear();
    },
  };
  return client;
}

/** Starts the engine's dedicated module worker and returns it with a client; a worker that fails to load or crashes
 *  closes the client with `worker-error`. */
export function startEngineWorker(): { worker: Worker; client: EngineClient } {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "umbradb-engine" });
  const client = createEngineClient(worker);
  worker.addEventListener("error", (event) => {
    client.close(new EngineError("worker-error", event.message === "" ? "the engine worker failed" : event.message));
    worker.terminate();
  });
  return { worker, client };
}
