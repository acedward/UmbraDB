/**
 * The page's watchdog over the engine worker. A statement runs synchronously inside the worker (PGlite is WebAssembly
 * on the worker's thread, and `statement_timeout` has no effect there), so a statement that does not return leaves the
 * worker unable to answer anything, its own timers included: only the page can end it.
 *
 * - **Heartbeat:** the supervisor's first message to every worker it starts is a `watchdog` request (the limit, the
 *   heartbeat interval and the counts carried over); from then on the worker posts a `heartbeat` notice every
 *   `heartbeatMs`. Any message from the worker counts as a sign of life.
 * - **Detection:** when nothing has arrived for `limitMs`, the worker is suspect; if nothing arrives during the next
 *   `graceMs` either, it is stuck. The grace keeps a page whose timers ran late (a hidden or frozen tab, whose worker is
 *   frozen with it) from mistaking that for a stuck worker: a live worker answers within one heartbeat.
 * - **Restart:** the stuck worker is terminated (its statement ends with it: every block commits in its own
 *   transaction, so the stored cursors are at the last full block) and a new one is started. Requests it had not
 *   answered are settled at once: an `api` request with the API's 503 `UNAVAILABLE` answer, any other request with the
 *   error `restarted`. The new worker gets the carried counts (restarts including this one, with the time and reason,
 *   and PGlite reopens, which the old worker's heartbeats reported), boots, and gets back what the page had set up: the
 *   system snapshot viewers, and the engine the worker last reported running, with the configuration it reported (it
 *   continues at the stored cursors). That report is the engine in the host status a successful `start`, `stop`,
 *   `range`, `reset` or `import` answers with, whatever started it (a `start` with no configuration runs the saved
 *   one); an `engine` notice that it stopped or failed clears it. So an engine the page stopped, that an import stopped,
 *   or that failed by itself is not started again, and a restart after a `range` runs the range. Nor is an engine
 *   started when the new worker's boot finished an import (one the restart interrupted once its journal was saved):
 *   the store is then the snapshot's, which an import leaves with its engine stopped.
 * - **Long requests:** while a request whose work may legitimately keep the worker busy for long is in flight (`range`
 *   and `reset` replace the store with a new one, `export` reads every table, `import` loads a snapshot twice;
 *   {@link LONG_REQUESTS}), the limit is `longLimitMs` instead.
 * - **Limits:** more than `maxRestarts` restarts within `restartWindowMs` close the client with `worker-error` instead
 *   of restarting again. A new worker whose boot fails right after a restart (for example while the old worker's OPFS
 *   handles are still being released) is replaced again after a short wait, up to `bootRetries` times.
 */
import { createEngineClient, type EngineClient, type EngineEndpoint, EngineError } from "./client.ts";
import {
  type CarriedCountsMessage,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_SYSTEM_VIEWER,
  type HostStatus,
  parseResult,
  parseWorkerMessage,
  type StartConfig,
} from "./protocol.ts";

/** Default limit: how long the worker may stay silent before it is restarted. */
export const DEFAULT_WATCHDOG_LIMIT_MS = 30_000;
export const DEFAULT_MAX_RESTARTS = 3;
export const DEFAULT_RESTART_WINDOW_MS = 10 * 60_000;
export const DEFAULT_BOOT_RETRIES = 5;
/** Default limit while a long request is in flight. */
export const DEFAULT_LONG_LIMIT_MS = 10 * 60_000;
/** The requests during which the worker may stay silent up to `longLimitMs`. */
export const LONG_REQUESTS: ReadonlySet<string> = new Set(["range", "reset", "export", "import"]);
/** The requests whose answer reports the engine (a host status), from which the supervisor learns what runs. */
const LIFECYCLE_REQUESTS: ReadonlySet<string> = new Set(["start", "stop", "range", "reset", "import"]);

/** A worker as the supervisor drives it. */
export interface WorkerLike extends EngineEndpoint {
  terminate(): void;
}

export interface RestartRecord {
  /** Epoch milliseconds. */
  at: number;
  reason: string;
}

export interface SupervisorOptions<W extends WorkerLike = WorkerLike> {
  /** Starts a worker; `onError` is called when it fails to load or crashes. */
  createWorker: (onError: (message: string) => void) => W;
  /** Silence after which the worker is suspect. Default {@link DEFAULT_WATCHDOG_LIMIT_MS}; `null`: no watchdog. */
  limitMs?: number | null;
  /** The worker's heartbeat interval. Default {@link DEFAULT_HEARTBEAT_MS}. */
  heartbeatMs?: number;
  /** Silence after the worker became suspect before it is restarted. Default twice the heartbeat interval. */
  graceMs?: number;
  /** The limit while a {@link LONG_REQUESTS} request is in flight. Default {@link DEFAULT_LONG_LIMIT_MS}. */
  longLimitMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  bootRetries?: number;
  /** Monotonic milliseconds (default `performance.now`) and epoch milliseconds (default `Date.now`). */
  now?: () => number;
  wallNow?: () => number;
  /** Timers (default the global ones). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each restart, and for problems while restoring the new worker. */
  onRestart?: (restart: RestartRecord & { count: number }) => void;
  onProblem?: (message: string) => void;
}

export interface SupervisedEngine<W extends WorkerLike = WorkerLike> {
  /** The same client across restarts. */
  readonly client: EngineClient;
  /** The current worker. */
  readonly worker: W;
  /** Restarts so far, oldest first. */
  restarts(): RestartRecord[];
  /** Stops watching, terminates the worker and closes the client. */
  close(): void;
}

/** One endpoint for the client whose worker can be replaced. */
class SwitchingEndpoint<W extends WorkerLike> implements EngineEndpoint {
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  private readonly forward = (event: MessageEvent): void => {
    for (const l of [...this.listeners]) l(event);
  };

  constructor(public current: W, private readonly outgoing: (message: unknown) => void) {
    current.addEventListener("message", this.forward);
  }

  swap(next: W): void {
    this.current.removeEventListener("message", this.forward);
    this.current = next;
    next.addEventListener("message", this.forward);
  }

  postMessage(message: unknown): void {
    this.outgoing(message);
    this.current.postMessage(message);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** The host status a successful lifecycle request answered with (an import's is inside its result), once validated. */
function reportedStatus(type: string, result: unknown): HostStatus | undefined {
  if (type === "import") {
    const r = parseResult("import", result);
    return r.ok ? r.result.status : undefined;
  }
  const r = parseResult(type as "start" | "stop" | "range" | "reset", result);
  return r.ok ? r.result : undefined;
}

export function superviseWorker<W extends WorkerLike>(opts: SupervisorOptions<W>): SupervisedEngine<W> {
  const limitMs = opts.limitMs === undefined ? DEFAULT_WATCHDOG_LIMIT_MS : opts.limitMs;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const graceMs = opts.graceMs ?? 2 * heartbeatMs;
  const longLimitMs = opts.longLimitMs ?? DEFAULT_LONG_LIMIT_MS;
  const maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const restartWindowMs = opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
  const bootRetries = opts.bootRetries ?? DEFAULT_BOOT_RETRIES;
  const now = opts.now ?? (() => performance.now());
  const wallNow = opts.wallNow ?? (() => Date.now());
  const setTimer = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (limitMs !== null && (!Number.isFinite(limitMs) || limitMs <= 0)) throw new RangeError(`limitMs must be a positive number or null, got ${limitMs}`);

  // What the page set up, replayed on a new worker.
  const sent = new Map<number, { type: string; watch?: boolean; viewer?: string }>();
  /** Ids of the long requests in flight. */
  const long = new Set<number>();
  /** The configuration of the engine the worker last reported running; `undefined` when none runs. */
  let engineConfig: StartConfig | undefined;
  const viewers = new Set<string>();
  let carried: CarriedCountsMessage = { watchdogRestarts: 0, lastWatchdogRestart: null, pgliteReopens: 0 };
  const restarts: RestartRecord[] = [];

  let lastSeen = now();
  let suspectAt: number | undefined;
  let closed = false;
  let timer: unknown;
  let generation = 0;

  function outgoing(message: unknown): void {
    if (!isRecord(message) || typeof message.id !== "number") return;
    if (typeof message.type === "string" && LONG_REQUESTS.has(message.type)) long.add(message.id);
    if (typeof message.type === "string" && LIFECYCLE_REQUESTS.has(message.type)) sent.set(message.id, { type: message.type });
    else if (message.type === "system" && typeof message.watch === "boolean")
      sent.set(message.id, { type: "system", watch: message.watch, viewer: typeof message.viewer === "string" ? message.viewer : DEFAULT_SYSTEM_VIEWER });
  }

  function incoming(event: MessageEvent): void {
    lastSeen = now();
    suspectAt = undefined;
    const m = parseWorkerMessage(event.data);
    if (m.kind === "notice") {
      if (m.notice.notice === "heartbeat") carried = m.notice.heartbeat.carried;
      else if (m.notice.notice === "engine" && m.notice.engine.state !== "running") engineConfig = undefined;
      return;
    }
    if (m.kind !== "response" || m.response.id === null) return;
    long.delete(m.response.id);
    const s = sent.get(m.response.id);
    if (s === undefined) return;
    sent.delete(m.response.id);
    if (!m.response.ok) return;
    if (LIFECYCLE_REQUESTS.has(s.type)) {
      const status = reportedStatus(s.type, m.response.result);
      if (status !== undefined) engineConfig = status.engine?.running === true ? status.engine.config : undefined;
    } else if (s.type === "system" && s.viewer !== undefined) {
      if (s.watch === true) viewers.add(s.viewer);
      else viewers.delete(s.viewer);
    }
  }

  const onError = (message: string): void => {
    if (closed) return;
    client.close(new EngineError("worker-error", message));
    close();
  };

  const endpoint = new SwitchingEndpoint<W>(opts.createWorker(onError), outgoing);
  endpoint.addEventListener("message", incoming);
  const client = createEngineClient(endpoint);

  /** The first message to each worker: the watchdog, with the counts carried over. */
  const arm = (counts?: CarriedCountsMessage): Promise<unknown> =>
    limitMs === null ? Promise.resolve() : client.watchdog({ limitMs, heartbeatMs, ...(counts === undefined ? {} : { carried: counts }) });

  /** Restores what the page had set up on a new worker. */
  async function restore(gen: number, counts: CarriedCountsMessage): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await arm(counts);
      const boot = await client.booted();
      if (gen !== generation || closed) return;
      if (boot.phase === "ready") break;
      if (boot.phase !== "failed" || attempt >= bootRetries) {
        opts.onProblem?.(`the restarted engine worker did not boot: ${boot.error ?? boot.phase}`);
        return;
      }
      await sleep(200 * (attempt + 1));
      if (gen !== generation || closed) return;
      replace();
    }
    for (const viewer of [...viewers]) await client.system({ watch: true, viewer });
    const config = engineConfig;
    if (config === undefined) return;
    // A boot that finished an import (one the restart interrupted once its journal was saved, before the engine's stop
    // was reported) has replaced the store with the snapshot's; an import stops the engine, so nothing is started.
    const finishedImport = (await client.status()).snapshots.lastImport !== null;
    if (gen !== generation || closed) return;
    if (finishedImport) {
      if (engineConfig === config) engineConfig = undefined;
      return;
    }
    try {
      await client.start(config);
    } catch (e) {
      if (gen === generation && engineConfig === config) engineConfig = undefined;
      throw e;
    }
  }

  /** Terminates the current worker and starts a new one in its place. */
  function replace(): void {
    endpoint.current.terminate();
    sent.clear();
    long.clear();
    endpoint.swap(opts.createWorker(onError));
    lastSeen = now();
    suspectAt = undefined;
  }

  function restart(reason: string): void {
    const at = wallNow();
    restarts.push({ at, reason });
    const recent = restarts.filter((r) => r.at > at - restartWindowMs).length;
    const counts: CarriedCountsMessage = { watchdogRestarts: carried.watchdogRestarts + 1, lastWatchdogRestart: { at, reason }, pgliteReopens: carried.pgliteReopens };
    carried = counts;
    if (recent > maxRestarts) {
      client.close(new EngineError("worker-error", `the engine worker stopped answering ${recent} times within ${Math.round(restartWindowMs / 1000)} s; it is not restarted again (last: ${reason})`));
      close();
      return;
    }
    client.interrupt(reason);
    replace();
    const gen = ++generation;
    opts.onRestart?.({ at, reason, count: counts.watchdogRestarts });
    restore(gen, counts).catch((e: unknown) => {
      if (gen === generation && !closed) opts.onProblem?.(`restoring the restarted engine worker failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  function check(): void {
    if (closed || limitMs === null) return;
    const t = now();
    const limit = long.size > 0 ? Math.max(limitMs, longLimitMs) : limitMs;
    if (t - lastSeen < limit) {
      suspectAt = undefined;
      return;
    }
    if (suspectAt === undefined) {
      suspectAt = t;
      return;
    }
    if (t - suspectAt >= graceMs) restart(`the engine worker sent nothing for ${Math.round(t - lastSeen)} ms (limit ${limit} ms)`);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimer(timer);
    endpoint.current.terminate();
    client.close();
  }

  if (limitMs !== null) {
    void arm().catch(() => {});
    timer = setTimer(check, Math.max(10, Math.min(heartbeatMs, limitMs / 4)));
  }

  return {
    client,
    get worker() {
      return endpoint.current;
    },
    restarts: () => restarts.map((r) => ({ ...r })),
    close,
  };
}
