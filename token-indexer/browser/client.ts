/**
 * The page's side of the engine protocol (`protocol.ts`): each request becomes a promise of its validated result.
 *
 * `createEngineClient(endpoint)` works over anything that carries messages both ways (a `Worker`, a `MessagePort`);
 * `startEngineWorker()` starts the engine's dedicated module worker (`worker.ts`) under the page's watchdog
 * (`supervisor.ts`) and returns a client for it. A request resolves with its result once the worker's response arrives
 * and its result passes the protocol's schema; it rejects with an {@link EngineError} carrying the worker's error
 * code, or `bad-response` (a response that fails validation), `worker-error` (the worker failed to load or crashed),
 * `restarted` (the watchdog replaced the worker before it answered; an `api` request gets the API's 503 answer
 * instead) or `closed` (the client was closed). A page that shares the engine with other tabs (`tabs.ts`) can also get
 * `leader-changed` and `leader-unavailable`. `requestPersistentStorage()` asks the browser to keep the site's storage:
 * `navigator.storage.persist()` exists only in a window, so a page asks, and the worker reports the outcome as
 * `persisted`.
 */
import {
  type ApiResult,
  type BootState,
  type DigestResult,
  type ErrorCode,
  type ExportResult,
  type HostStatus,
  type ImportResult,
  type Notice,
  type ParamsOf,
  parseResult,
  parseWorkerMessage,
  PROTOCOL_VERSION,
  type RequestType,
  type ResultOf,
  type StartConfig,
  type SystemResult,
  type WatchdogResult,
} from "./protocol.ts";
import { type SupervisedEngine, type SupervisorOptions, superviseWorker } from "./supervisor.ts";
import { trustedWorkerConstructor } from "./trusted-worker.ts";

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
  /** The watchdog replaced the worker before it answered (`supervisor.ts`). */
  | "restarted"
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
  /** Starts `config`, or the saved configuration when it is omitted. */
  start(config?: StartConfig): Promise<HostStatus>;
  stop(): Promise<HostStatus>;
  /** Drops the store's data and starts the new range (`"tip"`: from the finalized tip, following it). */
  range(startHeight: number | "tip", endHeight?: number): Promise<HostStatus>;
  /** Drops the store's data and starts the saved configuration again. */
  reset(): Promise<HostStatus>;
  /** A snapshot file of the store (`snapshot.ts`), taken while the engine runs. */
  export(): Promise<ExportResult>;
  /** Replaces the store with a snapshot file; refused (`snapshot-refused`, nothing changed) when it does not match. */
  import(snapshot: Blob): Promise<ImportResult>;
  /** The store's archive and range-tables digests (one read-only transaction). */
  digest(): Promise<DigestResult>;
  /** The boot state once the boot has ended (`ready`, `unsupported` or `failed`). */
  booted(): Promise<BootState>;
  /** Adds a notice listener; returns the function that removes it. */
  onNotice(listener: (notice: Notice) => void): () => void;
  /** Adds a listener for incoming messages that fail validation (they are dropped). */
  onInvalid(listener: (message: string) => void): () => void;
  /** Rejects every pending request with `reason` (default `closed`) and stops listening. */
  close(reason?: EngineError): void;
  /** The system snapshot: `watch` (as `viewer`) or one `refresh`. */
  system(params: ParamsOf<"system">): Promise<SystemResult>;
  /** Sets the worker's watchdog limit and heartbeat (the supervisor sends it to each worker it starts). */
  watchdog(params: ParamsOf<"watchdog">): Promise<WatchdogResult>;
  /**
   * Settles every pending request because the worker that would answer it was replaced (`reason` says why): an `api`
   * request resolves with the API's 503 `UNAVAILABLE` answer ({@link unavailableAnswer}), any other request rejects
   * with `restarted`. The client stays open for the next worker.
   */
  interrupt(reason: string): void;
}

/**
 * The API's answer when the index database cannot be read (503 `UNAVAILABLE`, `token-indexer/API.md`), exactly as the
 * API handler writes it (`token-indexer/mip0018/api.ts`): what an API request in flight gets when the watchdog
 * replaces the worker answering it.
 */
export function unavailableAnswer(method: string): ApiResult {
  const text = JSON.stringify({ error: { code: "UNAVAILABLE", message: "the index database cannot be read" } });
  return {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "content-length": String(new TextEncoder().encode(text).byteLength),
    },
    body: method.toUpperCase() === "HEAD" ? "" : text,
  };
}

const ENDED: ReadonlySet<BootState["phase"]> = new Set(["ready", "unsupported", "failed"]);

export function createEngineClient(endpoint: EngineEndpoint): EngineClient {
  let nextId = 1;
  let closedWith: EngineError | undefined;
  const pending = new Map<number, { type: RequestType; params: unknown; resolve: (v: unknown) => void; reject: (e: EngineError) => void }>();
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
      pending.set(id, { type, params, resolve: resolve as (v: unknown) => void, reject });
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
    start: (config) => request("start", config === undefined ? {} : { config }),
    stop: () => request("stop", {}),
    range: (startHeight, endHeight) => request("range", endHeight === undefined ? { startHeight } : { startHeight, endHeight }),
    reset: () => request("reset", {}),
    export: () => request("export", {}),
    import: (snapshot) => request("import", { snapshot }),
    digest: () => request("digest", {}),

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

    system: (params) => request("system", params),
    watchdog: (params) => request("watchdog", params),

    interrupt(reason) {
      const settled = [...pending.values()];
      pending.clear();
      for (const p of settled) {
        if (p.type === "api") p.resolve(unavailableAnswer((p.params as { method: string }).method));
        else p.reject(new EngineError("restarted", reason, p.type));
      }
    },
  };
  return client;
}

/** The answer to the page's request to keep the site's storage. */
export interface PersistenceResult {
  /** Whether `navigator.storage.persist()` was called (not when the storage was already persistent). */
  requested: boolean;
  /** Whether the site's storage is persistent now. */
  persisted: boolean;
  error: string | null;
}

/** Asks the browser to keep this site's storage (`navigator.storage.persist()`) unless it already does, and reports the
 *  answer. A refusal changes nothing else: the engine runs, and its status reports `persisted: false`. */
export async function requestPersistentStorage(
  storage: Pick<StorageManager, "persist" | "persisted"> | undefined = globalThis.navigator?.storage,
): Promise<PersistenceResult> {
  if (typeof storage?.persist !== "function" || typeof storage.persisted !== "function")
    return { requested: false, persisted: false, error: "navigator.storage.persist is not available" };
  try {
    if (await storage.persisted()) return { requested: false, persisted: true, error: null };
    return { requested: true, persisted: await storage.persist(), error: null };
  } catch (e) {
    return { requested: true, persisted: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Options of {@link startEngineWorker}: the watchdog's (`supervisor.ts`); `limitMs: null` turns it off. */
export type EngineWorkerOptions = Omit<SupervisorOptions, "createWorker">;

/**
 * Starts the engine's dedicated module worker under the page's watchdog (`supervisor.ts`) and returns a client for it.
 * The client stays the same when the watchdog replaces the worker; `worker` is the current one. A worker that fails to
 * load or crashes closes the client with `worker-error`.
 */
export function startEngineWorker(options: EngineWorkerOptions = {}): SupervisedEngine<Worker> {
  return superviseWorker<Worker>({
    ...options,
    createWorker: (onError) => {
      // The page's Trusted Types policy makes the worker's URL; the call keeps the `new Worker(new URL(…, import.meta.url))`
      // form that the bundler rewrites to the built worker's URL.
      const Worker = trustedWorkerConstructor();
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "umbradb-engine" });
      worker.addEventListener("error", (event) => onError(event.message === "" ? "the engine worker failed" : event.message));
      return worker;
    },
  });
}
