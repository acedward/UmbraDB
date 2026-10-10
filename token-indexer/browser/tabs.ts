/**
 * One engine across the tabs of a browser profile: `connectEngineTabs()` gives a page an {@link EngineClient} that works
 * the same in every tab, while exactly one tab, the **leader**, runs the engine worker (and so the only PGlite on the
 * store, the sync and the scan).
 *
 * **Election (Web Locks, `tab-locks.ts`).** Every tab holds a presence lock for its lifetime. A tab that finds the
 * leader lock free takes it and becomes leader: it starts the engine worker (`startEngineWorker()`) and keeps the lock
 * until it closes. Every other tab is a **follower**: it starts no worker and queues for the leader lock, so when the
 * leader closes (or crashes) the oldest follower is granted the lock and takes over. Leadership belongs to the tab, not
 * to its worker: a worker the leader tab replaces (a restart after a failure) keeps the same leader.
 *
 * **Proxy (BroadcastChannel).** A follower sends each request (`type`, `params`) to the leader on the store's channel;
 * the leader performs it through its own engine client, exactly as for its own page, and answers on the follower's
 * own channel. So both tabs get the same answers (validated again on arrival), every request type works from any tab
 * (`start`, `stop`, `range`, `reset`, `export` and `import` included), and the leader relays its worker's notices to
 * every follower. A system snapshot a follower receives is marked as relayed (`relayedSnapshot`).
 *
 * **Handover.** A tab that becomes leader announces itself; then, after its worker has booted on the same store, it
 * resumes what the previous leader last reported running (the same `start` configuration, which continues at the
 * stored cursors), or, with nothing to resume, starts the store's saved configuration when it says to start by itself
 * (a new store: the build's default, at the finalized tip) — {@link EngineTabsOptions.resume} changes that. Requests in flight to a leader that closed follow one
 * rule:
 * - `status`, `api`, `export` and `digest` change nothing, so they are sent again to the next leader (which may be this
 *   tab) and answered by it;
 * - every other type (`start`, `stop`, `range`, `reset`, `import`, and any type added later until it is listed as
 *   repeatable) is not sent again: it fails with `leader-changed`, because it may or may not have been applied — read
 *   the status, then decide;
 * - a request made while no leader is known waits for one up to {@link EngineTabsOptions.leaderWaitMs}, then fails with
 *   `leader-unavailable`.
 * A request to a leader that is open but not answering (a frozen tab) waits for it to answer or close.
 *
 * In a browser without Web Locks or BroadcastChannel the tab runs alone as leader, so its worker's capability check can
 * report the browser as unsupported.
 */
import { z } from "zod";
import { relayedSnapshot, type SystemSnapshot } from "../engine/system-snapshot.ts";
import { type EngineClient, EngineError, type EngineErrorCode, startEngineWorker } from "./client.ts";
import { BROWSER_BUILD_CONFIG, BROWSER_DATA_DIR } from "./config.ts";
import {
  type BootState,
  type Notice,
  type ParamsOf,
  parseResult,
  parseWorkerMessage,
  PROTOCOL_VERSION,
  REQUEST_TYPES,
  type RequestType,
  type ResultOf,
  type StartConfig,
  StartConfigSchema,
} from "./protocol.ts";
import {
  countConnectedTabs,
  defaultLocks,
  type HeldLock,
  holdLock,
  leaderLockName,
  type LockManagerLike,
  tabLockName,
  whenTabGone,
} from "./tab-locks.ts";

/** How long a request waits for a leader by default. */
export const LEADER_WAIT_MS = 10_000;

/** The request types a follower sends again to the next leader when the leader it was sent to closed. */
export const REPEATABLE_REQUEST_TYPES: ReadonlySet<RequestType> = new Set<RequestType>(["status", "api", "export", "digest"]);

export const tabsChannelName = (scope: string): string => `umbradb-engine:${scope}`;
export const tabChannelName = (scope: string, tab: string): string => `umbradb-engine:${scope}:tab:${tab}`;

/** Something that carries messages to the other tabs (a `BroadcastChannel`). */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "messageerror", listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** The engine worker a leader tab runs. */
export interface LocalEngine {
  client: EngineClient;
  worker?: Worker;
  /** Stops the worker. Default: `worker.terminate()`. */
  terminate?: () => void;
}

/** What the leader last reported about its engine: the configuration of the last `start`, and whether it runs. */
export interface EngineRecord {
  running: boolean;
  config: StartConfig;
}

export type TabRole = "connecting" | "leader" | "follower" | "closed";
export type TabLogLevel = "info" | "warn" | "error";

export interface EngineTabsOptions {
  /** The store the tabs share; lock and channel names derive from it. Default: the build's data directory. */
  scope?: string;
  /** Default: `navigator.locks`; `null`: none (the tab runs alone). */
  locks?: LockManagerLike | null;
  /** Default: `new BroadcastChannel(name)`; `null`: none (the tab runs alone). */
  openChannel?: ((name: string) => ChannelLike) | null;
  /** Starts the engine worker when this tab becomes leader. Default: {@link startEngineWorker}. */
  startWorker?: () => LocalEngine;
  /** How long a request waits for a leader. Default {@link LEADER_WAIT_MS}. */
  leaderWaitMs?: number;
  /** This tab's id. Default: a random UUID. */
  tabId?: string;
  /**
   * Runs once this tab has become leader and its worker has booted, with what the previous leader last reported (`null`
   * when nothing was reported, e.g. the first tab). Default: {@link resumeOrAutoStart} with the build's `autoStart`.
   */
  resume?: (previous: EngineRecord | null, client: EngineClient) => Promise<void>;
  /** Default: the console. */
  log?: (level: TabLogLevel, message: string) => void;
  /** Wall-clock milliseconds, for the time a follower received a relayed snapshot. Default `Date.now`. */
  now?: () => number;
}

export interface EngineTabs {
  readonly tabId: string;
  /** The engine client of this tab: the leader's own engine in the leader, proxied to the leader in a follower. */
  readonly client: EngineClient;
  /** Resolves with the first role (`leader` or `follower`), or `closed`. */
  readonly ready: Promise<TabRole>;
  role(): TabRole;
  /** The leader tab's id, once known. */
  leader(): string | null;
  /** This tab's engine worker (a leader's only). */
  worker(): Worker | undefined;
  /** The number of open tabs on this store, this one included. */
  connectedTabs(): Promise<number>;
  /** Adds a listener for role and leader changes; returns the function that removes it. */
  onRoleChange(listener: (role: TabRole, leader: string | null) => void): () => void;
  /** Leaves: releases the locks (a follower takes over if this tab led), stops the worker, rejects pending requests. */
  close(): void;
}

// ── Messages between tabs ────────────────────────────────────────────────────────────────────────────────────────────

const tabId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const engineRecord = z
  .strictObject({ running: z.boolean(), config: z.custom<StartConfig>((v) => StartConfigSchema.safeParse(v).success, "a start configuration") })
  .nullable();
const v = z.literal(PROTOCOL_VERSION);
const requestId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Messages on the store's channel (every tab) and on a tab's own channel (responses to it). */
export const TabMessageSchema = z.discriminatedUnion("kind", [
  /** A tab that does not know the leader asks it to announce itself. */
  z.strictObject({ v, kind: z.literal("hello"), from: tabId }),
  /** The leader announces itself and what its engine is running. */
  z.strictObject({ v, kind: z.literal("leader"), from: tabId, engine: engineRecord }),
  /** A follower's request for the leader `to`. */
  z.strictObject({ v, kind: z.literal("request"), from: tabId, to: tabId, id: requestId, type: z.string().max(64), params: z.record(z.string(), z.unknown()) }),
  /** A worker notice, relayed by the leader. */
  z.strictObject({ v, kind: z.literal("notice"), from: tabId, notice: z.unknown() }),
  /** The leader's answer to a follower's request (on the follower's channel). */
  z.discriminatedUnion("ok", [
    z.strictObject({ v, kind: z.literal("response"), from: tabId, id: requestId, ok: z.literal(true), result: z.unknown() }),
    z.strictObject({
      v,
      kind: z.literal("response"),
      from: tabId,
      id: requestId,
      ok: z.literal(false),
      error: z.strictObject({ code: z.string().regex(/^[a-z][a-z-]{0,63}$/), message: z.string().max(4096) }),
    }),
  ]),
]);
export type TabMessage = z.infer<typeof TabMessageSchema>;

// ── Relayed system snapshots ─────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isSnapshot = (x: unknown): x is SystemSnapshot => isRecord(x) && x.format === "umbradb-system-snapshot";

/** A value a follower received from the leader, as the follower shows it: a system snapshot (the value itself, or its
 *  `snapshot` member) is marked relayed at `receivedAt` (`relayedSnapshot`); anything else is unchanged. */
export function asRelayed<T>(value: T, receivedAt: number): T {
  if (isSnapshot(value)) return relayedSnapshot(value, receivedAt) as T;
  if (isRecord(value) && isSnapshot(value.snapshot)) return { ...value, snapshot: relayedSnapshot(value.snapshot, receivedAt) } as T;
  return value;
}

// ── The tabs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Entry {
  id: number;
  type: RequestType;
  params: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: EngineError) => void;
  /** The tab the request was last sent to; `null` while it waits for a leader. */
  sentTo: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const ENDED: ReadonlySet<BootState["phase"]> = new Set(["ready", "unsupported", "failed"]);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const defaultLog = (level: TabLogLevel, message: string): void => {
  const line = `[umbradb tabs] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};

/** Starts again what the previous leader was running. */
export async function resumePrevious(previous: EngineRecord | null, client: EngineClient): Promise<void> {
  if (previous?.running === true) await client.start(previous.config);
}

/**
 * The default {@link EngineTabsOptions.resume}: start again what the previous leader was running; otherwise, with
 * `autoStart` (the build's setting, default true), start the store's saved configuration when it says to start by
 * itself (`start` with no configuration: a new store's is the build's default, from the finalized tip; a `stop` request
 * turned it off).
 */
export function resumeOrAutoStart(autoStart: boolean = BROWSER_BUILD_CONFIG.autoStart ?? true): (previous: EngineRecord | null, client: EngineClient) => Promise<void> {
  return async (previous, client) => {
    if (previous?.running === true) return resumePrevious(previous, client);
    if (!autoStart) return;
    const s = await client.status();
    if (s.engine === null && s.settings?.autoStart === true) await client.start();
  };
}

const noChannel = (): ChannelLike => ({ postMessage() {}, addEventListener() {}, close() {} });

function defaultOpenChannel(): ((name: string) => ChannelLike) | undefined {
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel;
  return typeof BC === "function" ? (name) => new BC(name) : undefined;
}

function defaultStartWorker(): LocalEngine {
  const { worker, client } = startEngineWorker();
  return { worker, client, terminate: () => worker.terminate() };
}

export function connectEngineTabs(opts: EngineTabsOptions = {}): EngineTabs {
  const scope = opts.scope ?? BROWSER_DATA_DIR;
  const self = opts.tabId ?? crypto.randomUUID();
  if (!tabId.safeParse(self).success) throw new RangeError(`a tab id is 1 to 64 letters, digits or dashes, not ${JSON.stringify(self)}`);
  const locks = opts.locks === null ? undefined : (opts.locks ?? defaultLocks());
  const openChannel = opts.openChannel === null ? undefined : (opts.openChannel ?? defaultOpenChannel());
  const alone = locks === undefined || openChannel === undefined;
  const open = openChannel ?? noChannel;
  const startWorker = opts.startWorker ?? defaultStartWorker;
  const leaderWaitMs = opts.leaderWaitMs ?? LEADER_WAIT_MS;
  const resume = opts.resume ?? resumeOrAutoStart();
  const log = opts.log ?? defaultLog;
  const now = opts.now ?? (() => Date.now());

  let role: TabRole = "connecting";
  let leaderId: string | null = null;
  let local: LocalEngine | undefined;
  /** What the leader last reported (this tab's own report once it leads). */
  let record: EngineRecord | null = null;
  let closedWith: EngineError | undefined;
  let nextId = 1;
  const pending = new Map<number, Entry>();
  const noticeListeners = new Set<(notice: Notice) => void>();
  const invalidListeners = new Set<(message: string) => void>();
  const roleListeners = new Set<(role: TabRole, leader: string | null) => void>();
  const outboxes = new Map<string, ChannelLike>();
  const abort = new AbortController();
  let presence: HeldLock | undefined;
  let leadership: HeldLock | undefined;
  let resolveReady!: (role: TabRole) => void;
  const ready = new Promise<TabRole>((r) => (resolveReady = r));

  const main = open(tabsChannelName(scope));
  const inbox = open(tabChannelName(scope, self));

  const invalid = (message: string): void => {
    for (const l of [...invalidListeners]) l(message);
  };
  const dispatchNotice = (notice: Notice): void => {
    for (const l of [...noticeListeners]) l(notice);
  };
  const setRole = (next: TabRole, leader: string | null): void => {
    if (role === next && leaderId === leader) return;
    role = next;
    leaderId = leader;
    if (next !== "connecting") resolveReady(next);
    for (const l of [...roleListeners]) {
      try {
        l(next, leader);
      } catch (e) {
        log("error", `role listener failed: ${messageOf(e)}`);
      }
    }
  };
  const post = (channel: ChannelLike, message: TabMessage): void => {
    if (closedWith !== undefined) return;
    try {
      channel.postMessage(message);
    } catch (e) {
      log("warn", `a message to the other tabs could not be sent: ${messageOf(e)}`);
    }
  };

  // ── Requests from this tab ─────────────────────────────────────────────────────────────────────────────────────────

  function settle(e: Entry, from: string, outcome: { ok: true; result: unknown } | { ok: false; error: EngineError }): void {
    if (pending.get(e.id) !== e || e.sentTo !== from) return; // answered already, or by a leader it is no longer with
    pending.delete(e.id);
    if (e.timer !== undefined) clearTimeout(e.timer);
    if (outcome.ok) e.resolve(outcome.result);
    else e.reject(outcome.error);
  }

  const fail = (e: Entry, code: EngineErrorCode, message: string): void => {
    pending.delete(e.id);
    if (e.timer !== undefined) clearTimeout(e.timer);
    e.reject(new EngineError(code, message, e.type));
  };

  /** Sends a request to the current leader (this tab's own engine when it leads), or keeps it waiting for one. */
  function dispatch(e: Entry): void {
    if (role === "leader" && local !== undefined) {
      e.sentTo = self;
      if (e.timer !== undefined) clearTimeout(e.timer);
      e.timer = undefined;
      local.client.request(e.type, e.params as ParamsOf<typeof e.type>).then(
        (result) => settle(e, self, { ok: true, result }),
        (err: unknown) => settle(e, self, { ok: false, error: err instanceof EngineError ? err : new EngineError("internal", messageOf(err), e.type) }),
      );
      return;
    }
    if (role === "follower" && leaderId !== null) {
      e.sentTo = leaderId;
      if (e.timer !== undefined) clearTimeout(e.timer);
      e.timer = undefined;
      post(main, { v: PROTOCOL_VERSION, kind: "request", from: self, to: leaderId, id: e.id, type: e.type, params: e.params });
      return;
    }
    e.sentTo = null;
    e.timer ??= setTimeout(() => {
      if (pending.get(e.id) === e && e.sentTo === null)
        fail(e, "leader-unavailable", `no leader tab answered within ${leaderWaitMs} ms (another tab's engine may be starting or not responding)`);
    }, leaderWaitMs);
  }

  /** The leader changed from `previous` (a tab that closed): requests in flight to it follow the handover rule. */
  function handOver(previous: string | null): void {
    for (const e of [...pending.values()]) {
      if (e.sentTo === null) dispatch(e);
      else if (e.sentTo === previous && previous !== self) {
        if (REPEATABLE_REQUEST_TYPES.has(e.type)) dispatch(e);
        else fail(e, "leader-changed", `the leader tab closed while this ${e.type} request was in flight to it; it may or may not have been applied`);
      }
    }
  }

  function request<T extends RequestType>(type: T, params: ParamsOf<T>): Promise<ResultOf<T>> {
    if (closedWith !== undefined) return Promise.reject(new EngineError(closedWith.code, closedWith.message, type));
    return new Promise<ResultOf<T>>((resolve, reject) => {
      const e: Entry = { id: nextId++, type, params: params as Record<string, unknown>, resolve: resolve as (v: unknown) => void, reject, sentTo: null, timer: undefined };
      pending.set(e.id, e);
      dispatch(e);
    });
  }

  // ── Leader ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  const announce = (): void => post(main, { v: PROTOCOL_VERSION, kind: "leader", from: self, engine: record });

  async function refreshRecord(): Promise<void> {
    const engine = local;
    if (engine === undefined || role !== "leader") return;
    try {
      const s = await engine.client.status();
      // Until this tab's engine has been started, the previous leader's report stands (a later leader resumes it).
      if (s.engine !== null) record = { running: s.engine.running, config: s.engine.config };
      announce();
    } catch (e) {
      log("warn", `the engine status could not be read: ${messageOf(e)}`);
    }
  }

  function onLocalNotice(notice: Notice): void {
    dispatchNotice(notice);
    post(main, { v: PROTOCOL_VERSION, kind: "notice", from: self, notice });
    if (notice.notice === "engine") void refreshRecord();
  }

  /** The channel answering the follower `tab`, closed once that tab has closed. */
  function outbox(tab: string): ChannelLike {
    let c = outboxes.get(tab);
    if (c === undefined) {
      c = open(tabChannelName(scope, tab));
      outboxes.set(tab, c);
      if (locks !== undefined)
        void whenTabGone(locks, scope, tab, abort.signal).then(() => {
          outboxes.get(tab)?.close();
          outboxes.delete(tab);
        });
    }
    return c;
  }

  function serve(m: Extract<TabMessage, { kind: "request" }>): void {
    const reply = (body: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }): void =>
      post(outbox(m.from), { v: PROTOCOL_VERSION, kind: "response", from: self, id: m.id, ...body } as TabMessage);
    if (role !== "leader" || local === undefined) {
      reply({ ok: false, error: { code: "leader-changed", message: "this tab is not the leader" } });
      return;
    }
    if (!(REQUEST_TYPES as readonly string[]).includes(m.type)) {
      reply({ ok: false, error: { code: "unknown-type", message: `request type ${JSON.stringify(m.type)} is not part of protocol version ${PROTOCOL_VERSION}` } });
      return;
    }
    const type = m.type as RequestType;
    local.client.request(type, m.params as ParamsOf<typeof type>).then(
      (result) => reply({ ok: true, result }),
      (err: unknown) => reply({ ok: false, error: err instanceof EngineError ? { code: err.code, message: err.message } : { code: "internal", message: messageOf(err) } }),
    );
  }

  function becomeLeader(): void {
    if (closedWith !== undefined) {
      leadership?.release();
      return;
    }
    const previous = leaderId;
    const inherited = record;
    try {
      local = startWorker();
    } catch (e) {
      log("error", `the engine worker could not be started: ${messageOf(e)}`);
      throw e;
    }
    local.client.onNotice(onLocalNotice);
    local.client.onInvalid(invalid);
    setRole("leader", self);
    announce();
    handOver(previous);
    const engine = local;
    void (async () => {
      try {
        const boot = await engine.client.booted();
        if (boot.phase !== "ready") return;
        await resume(inherited, engine.client);
      } catch (e) {
        log("warn", `resuming the engine failed: ${messageOf(e)}`);
      }
      await refreshRecord();
    })();
  }

  // ── Messages from other tabs ───────────────────────────────────────────────────────────────────────────────────────

  function onMain(event: MessageEvent): void {
    const parsed = TabMessageSchema.safeParse(event.data);
    if (!parsed.success) return invalid(`a tab message is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    const m = parsed.data;
    if (m.from === self || closedWith !== undefined) return;
    switch (m.kind) {
      case "hello":
        if (role === "leader") announce();
        return;
      case "leader": {
        if (role === "leader") {
          log("warn", `tab ${m.from} announced itself as leader while this tab leads`);
          return;
        }
        record = m.engine;
        if (leaderId !== m.from) {
          const previous = leaderId;
          setRole("follower", m.from);
          handOver(previous);
        }
        return;
      }
      case "request":
        if (m.to === self) serve(m);
        return;
      case "notice": {
        if (role !== "follower" || m.from !== leaderId) return;
        const w = parseWorkerMessage(m.notice);
        if (w.kind !== "notice") return invalid(`a relayed notice is invalid: ${w.kind === "invalid" ? w.message : "not a notice"}`);
        try {
          dispatchNotice(asRelayed(w.notice, now()));
        } catch (e) {
          invalid(`a relayed notice is invalid: ${messageOf(e)}`);
        }
        return;
      }
      case "response":
        return; // responses travel on the requester's own channel
    }
  }

  function onInbox(event: MessageEvent): void {
    const parsed = TabMessageSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.kind !== "response") return invalid("a message on this tab's channel is not a response");
    const m = parsed.data;
    const e = pending.get(m.id);
    if (e === undefined || e.sentTo !== m.from) return; // a late answer from a leader the request has moved on from
    if (!m.ok) return settle(e, m.from, { ok: false, error: new EngineError(m.error.code as EngineErrorCode, m.error.message, e.type) });
    const r = parseResult(e.type, m.result);
    if (!r.ok) return settle(e, m.from, { ok: false, error: new EngineError("bad-response", `the ${e.type} result is invalid: ${r.message}`, e.type) });
    try {
      settle(e, m.from, { ok: true, result: asRelayed(r.result, now()) });
    } catch (err) {
      settle(e, m.from, { ok: false, error: new EngineError("bad-response", `the ${e.type} result is invalid: ${messageOf(err)}`, e.type) });
    }
  }

  main.addEventListener("message", onMain);
  main.addEventListener("messageerror", () => invalid("a tab message could not be read"));
  inbox.addEventListener("message", onInbox);
  inbox.addEventListener("messageerror", () => invalid("a message on this tab's channel could not be read"));

  async function connect(): Promise<void> {
    if (alone) {
      log("warn", "Web Locks or BroadcastChannel are missing: this tab runs the engine alone");
      becomeLeader();
      return;
    }
    presence = holdLock(locks, tabLockName(scope, self));
    await presence.acquired;
    if (closedWith !== undefined) return;
    const first = holdLock(locks, leaderLockName(scope), { ifAvailable: true });
    if (await first.acquired) {
      leadership = first;
      becomeLeader();
      return;
    }
    if (closedWith !== undefined) return;
    setRole("follower", null);
    post(main, { v: PROTOCOL_VERSION, kind: "hello", from: self });
    leadership = holdLock(locks, leaderLockName(scope), { signal: abort.signal });
    if ((await leadership.acquired) && closedWith === undefined) becomeLeader();
  }

  function close(reason: EngineError = new EngineError("closed", "the engine client is closed")): void {
    if (closedWith !== undefined) return;
    closedWith = reason;
    abort.abort();
    leadership?.release();
    presence?.release();
    if (local !== undefined) {
      local.client.close(reason);
      if (local.terminate !== undefined) local.terminate();
      else local.worker?.terminate();
    }
    main.close();
    inbox.close();
    for (const c of outboxes.values()) c.close();
    outboxes.clear();
    for (const e of [...pending.values()]) fail(e, reason.code, reason.message);
    setRole("closed", null);
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

    close,
  };

  void connect().catch((e: unknown) => {
    log("error", `joining the other tabs failed: ${messageOf(e)}`);
    close(new EngineError("internal", `joining the other tabs failed: ${messageOf(e)}`));
  });

  return {
    tabId: self,
    client,
    ready,
    role: () => role,
    leader: () => leaderId,
    worker: () => local?.worker,
    connectedTabs: async () => (locks === undefined ? 1 : countConnectedTabs(locks, scope)),
    onRoleChange(listener) {
      roleListeners.add(listener);
      return () => { roleListeners.delete(listener); };
    },
    close: () => close(),
  };
}
