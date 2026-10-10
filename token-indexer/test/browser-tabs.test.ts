/**
 * One engine across tabs (`token-indexer/browser/tabs.ts`, `tab-locks.ts`, the store lock in `store.ts`), in Node: each
 * "tab" is a `connectEngineTabs()` with its own view of an in-memory Web Locks manager and BroadcastChannel hub, so a
 * tab can be closed abruptly (its locks released and its channels cut with none of its code running, as when a browser
 * tab closes or crashes), and its engine worker is a scripted engine whose answers name the tab that runs it. The same
 * code in Chrome, with real tabs, workers and OPFS, is `browser-tabs-chrome.test.ts`.
 *
 * - `[[browser.tabs.election]]` — the first tab leads and is the only one to start a worker; the others follow it; when
 *   the leader closes the oldest follower leads and the rest follow it; presence counts the open tabs; without Web Locks
 *   or BroadcastChannel a tab runs alone.
 * - `[[browser.tabs.proxy]]` — a follower's requests (reads and state changes alike) are answered by the leader's engine
 *   exactly as the leader's own; errors keep the leader's code; the leader's notices reach followers; a relayed system
 *   snapshot is marked as relayed.
 * - `[[browser.tabs.handover-rule]]` — requests in flight when the leader closes: `status`, `api` and `export` are sent
 *   again and answered by the next leader; the others fail with `leader-changed`; a late answer from the old leader is
 *   ignored; with no leader a request fails with `leader-unavailable` after the wait; the new leader resumes the engine
 *   the old one was running, and only then.
 * - `[[browser.tabs.messages]]` — invalid tab messages are reported and ignored; an unknown request type is refused by
 *   the leader; closing rejects what is pending and releases the tab's locks.
 * - `[[browser.store.lock]]` — the store lock admits one holder, the next waits for its release, and a wait that runs out
 *   fails naming the store.
 */
import { describe, expect, it } from "vitest";
import type { SystemSnapshot } from "../engine/system-snapshot.ts";
import { createEngineClient, type EngineClient, EngineError, type EngineEndpoint } from "../browser/client.ts";
import { type HostStatus, type Notice, PROTOCOL_VERSION, type StartConfig } from "../browser/protocol.ts";
import { acquireStoreLock } from "../browser/store.ts";
import { connectedTabsCounter, leaderLockName, type LockInfoLike, type LockLike, type LockManagerLike, type LockRequestOptions, storeLockName, tabLockName } from "../browser/tab-locks.ts";
import { asRelayed, type ChannelLike, connectEngineTabs, type EngineTabs, type EngineTabsOptions, tabChannelName, tabsChannelName } from "../browser/tabs.ts";

const SCOPE = "opfs-ahp://umbradb-test";

// ── An in-memory Web Locks manager whose clients can die ─────────────────────────────────────────────────────────────

interface Waiter { client: string; grant: () => void; drop: () => void }

class FakeLocks {
  private readonly held = new Map<string, { client: string; release: () => void }>();
  private readonly queues = new Map<string, Waiter[]>();
  private readonly dead = new Set<string>();

  view(client: string): LockManagerLike {
    const request = (name: string, a: LockRequestOptions | ((l: LockLike | null) => unknown), b?: (l: LockLike | null) => unknown): Promise<unknown> => {
      const options = typeof a === "function" ? {} : a;
      const callback = typeof a === "function" ? a : b!;
      return new Promise((resolve, reject) => {
        if (this.dead.has(client)) return; // a closed context runs nothing
        const grant = (): void => {
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            if (this.held.get(name)?.release === release) this.held.delete(name);
            this.next(name);
          };
          this.held.set(name, { client, release });
          queueMicrotask(() => {
            let out: unknown;
            try {
              out = callback({ name });
            } catch (e) {
              release();
              reject(e);
              return;
            }
            Promise.resolve(out).then((v) => { release(); resolve(v); }, (e: unknown) => { release(); reject(e); });
          });
        };
        const queue = this.queues.get(name) ?? [];
        if (!this.held.has(name) && queue.length === 0) return grant();
        if (options.ifAvailable === true) {
          queueMicrotask(() => Promise.resolve(callback(null)).then(resolve, reject));
          return;
        }
        const waiter: Waiter = { client, grant, drop: () => {} };
        if (options.signal !== undefined) {
          const onAbort = (): void => {
            const q = this.queues.get(name) ?? [];
            const i = q.indexOf(waiter);
            if (i < 0) return;
            q.splice(i, 1);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (options.signal.aborted) return onAbort();
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
        queue.push(waiter);
        this.queues.set(name, queue);
      });
    };
    return {
      request: request as LockManagerLike["request"],
      query: async () => this.snapshot(),
    };
  }

  private next(name: string): void {
    if (this.held.has(name)) return;
    const q = this.queues.get(name) ?? [];
    const w = q.shift();
    if (q.length === 0) this.queues.delete(name);
    w?.grant();
  }

  snapshot(): { held: LockInfoLike[]; pending: LockInfoLike[] } {
    return {
      held: [...this.held].map(([name, h]) => ({ name, clientId: h.client, mode: "exclusive" })),
      pending: [...this.queues].flatMap(([name, q]) => q.map((w) => ({ name, clientId: w.client, mode: "exclusive" }))),
    };
  }

  /** The context `client` ended: its queued requests vanish and its locks are released, with none of its code run. */
  kill(client: string): void {
    this.dead.add(client);
    for (const [name, q] of this.queues) this.queues.set(name, q.filter((w) => w.client !== client));
    for (const h of [...this.held.values()]) if (h.client === client) h.release();
  }
}

// ── An in-memory BroadcastChannel hub whose clients can die ──────────────────────────────────────────────────────────

class FakeChannels {
  private readonly open = new Set<{ name: string; client: string; listeners: Set<(e: MessageEvent) => void>; closed: boolean }>();

  for(client: string): (name: string) => ChannelLike {
    return (name) => {
      const ch = { name, client, listeners: new Set<(e: MessageEvent) => void>(), closed: false };
      this.open.add(ch);
      return {
        postMessage: (message: unknown) => {
          if (ch.closed) throw new Error("channel closed");
          const data = structuredClone(message);
          for (const other of this.open) {
            if (other === ch || other.name !== name) continue;
            setTimeout(() => {
              if (other.closed) return;
              for (const l of [...other.listeners]) l({ data } as MessageEvent);
            }, 0);
          }
        },
        addEventListener: (type: string, l: (e: MessageEvent) => void) => {
          if (type === "message") ch.listeners.add(l);
        },
        close: () => {
          ch.closed = true;
          this.open.delete(ch);
        },
      };
    };
  }

  kill(client: string): void {
    for (const ch of [...this.open]) if (ch.client === client) { ch.closed = true; this.open.delete(ch); }
  }
}

// ── A scripted engine worker ─────────────────────────────────────────────────────────────────────────────────────────

interface FakeEngine {
  name: string;
  client: EngineClient;
  calls: Array<{ type: string; params: Record<string, unknown> }>;
  /** Request types whose answers are held until {@link release}. */
  hold: Set<string>;
  release(): void;
  dead: boolean;
  state: { engine: { running: boolean; config: StartConfig } | null };
  notify(notice: Notice): void;
}

function hostStatus(engine: FakeEngine["state"]["engine"]): HostStatus {
  return {
    protocol: PROTOCOL_VERSION,
    network: "stagenet",
    boot: { phase: "ready", error: null, capabilities: null, storeProblem: null, timings: { capabilitiesMs: 0, storeMs: 0, ledgerMs: 0, migrateMs: 0, totalMs: 0 } },
    store: null,
    engine: engine === null ? null : {
      running: engine.running,
      config: engine.config,
      status: {
        started: engine.running,
        stopping: false,
        sync: { phase: engine.running ? "running" : "stopped", failures: 0 },
        scan: { phase: engine.running ? "running" : "stopped", failures: 0, scanner: engine.running ? "following" : "off" },
        api: { inFlight: 0, maxConcurrentRequests: 8 },
      },
      error: null,
    },
    cursors: { sync: null, scan: null },
    settings: null,
    storage: null,
    snapshots: { lastExport: null, lastImport: null },
  };
}

function fakeEngine(name: string): FakeEngine {
  const listeners = new Set<(e: MessageEvent) => void>();
  const parked: Array<() => void> = [];
  const emit = (data: unknown): void => {
    if (engine.dead) return;
    queueMicrotask(() => { for (const l of [...listeners]) l({ data } as MessageEvent); });
  };
  const ok = (id: number, request: string, result: unknown): void => emit({ v: PROTOCOL_VERSION, type: "response", id, request, ok: true, result });
  const err = (id: number, request: string, code: string, message: string): void =>
    emit({ v: PROTOCOL_VERSION, type: "response", id, request, ok: false, error: { code, message } });
  const answer = (m: Record<string, unknown>): void => {
    const { id, type } = m as { id: number; type: string };
    switch (type) {
      case "status":
        return ok(id, type, hostStatus(engine.state.engine));
      case "api":
        return ok(id, type, { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: name, method: m.method, target: m.target }) });
      case "start":
        if (engine.state.engine?.running === true) return err(id, type, "already-running", "the engine is running; stop it first");
        engine.state.engine = { running: true, config: m.config as StartConfig };
        engine.notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "running", error: null } });
        return ok(id, type, hostStatus(engine.state.engine));
      case "stop":
        if (engine.state.engine !== null) engine.state.engine = { ...engine.state.engine, running: false };
        engine.notify({ v: PROTOCOL_VERSION, type: "notice", notice: "engine", engine: { state: "stopped", error: null } });
        return ok(id, type, hostStatus(engine.state.engine));
      default:
        return err(id, type, type === "nope" ? "unknown-type" : "not-implemented", `${type} is not implemented by this worker`);
    }
  };
  const endpoint: EngineEndpoint = {
    postMessage(message) {
      const m = message as Record<string, unknown>;
      const { v: _v, id: _id, type, ...params } = m;
      engine.calls.push({ type: String(type), params });
      if (engine.hold.has(String(type))) parked.push(() => answer(m));
      else answer(m);
    },
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
  };
  const engine: FakeEngine = {
    name,
    client: createEngineClient(endpoint),
    calls: [],
    hold: new Set(),
    release() {
      this.hold.clear();
      for (const p of parked.splice(0)) p();
    },
    dead: false,
    state: { engine: null },
    notify: (notice) => emit(notice),
  };
  return engine;
}

// ── The tabs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function browser(options: Partial<EngineTabsOptions> = {}) {
  const locks = new FakeLocks();
  const channels = new FakeChannels();
  const engines: FakeEngine[] = [];
  const tabs: EngineTabs[] = [];
  const open = (id: string, over: Partial<EngineTabsOptions> = {}): EngineTabs => {
    const t = connectEngineTabs({
      scope: SCOPE,
      tabId: id,
      locks: locks.view(id),
      openChannel: channels.for(id),
      startWorker: () => {
        const e = fakeEngine(id);
        engines.push(e);
        return { client: e.client, terminate: () => { e.dead = true; } };
      },
      leaderWaitMs: 400,
      log: () => {},
      now: () => 1_000,
      ...options,
      ...over,
    });
    tabs.push(t);
    return t;
  };
  /** The tab closes abruptly: its locks and channels go, its worker dies, none of its code runs. */
  const kill = (t: EngineTabs): void => {
    locks.kill(t.tabId);
    channels.kill(t.tabId);
    for (const e of engines) if (e.name === t.tabId) e.dead = true;
  };
  const engineOf = (t: EngineTabs): FakeEngine | undefined => engines.find((e) => e.name === t.tabId);
  return { locks, channels, engines, tabs, open, kill, engineOf };
}

async function until(what: string, ok: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Settles a promise into a plain value, so pending requests can be inspected later. */
function track<T>(p: Promise<T>): { settled: boolean; value?: T; code?: string; message?: string } {
  const out: { settled: boolean; value?: T; code?: string; message?: string } = { settled: false };
  p.then(
    (value) => { out.settled = true; out.value = value; },
    (e: unknown) => { out.settled = true; out.code = e instanceof EngineError ? e.code : "?"; out.message = e instanceof Error ? e.message : String(e); },
  );
  return out;
}

const apiBody = async (t: EngineTabs, target: string): Promise<{ engine: string; target: string }> =>
  JSON.parse((await t.client.api("GET", target)).body) as { engine: string; target: string };

const TAPE: StartConfig = { source: { kind: "tape", range: "u1" }, startHeight: 715402, endHeight: 715433 };

describe("one engine across tabs", () => {
  it("[[browser.tabs.election]] the first tab leads and alone starts a worker; the others follow; when the leader closes the oldest follower leads and the rest follow it; presence counts open tabs; without Web Locks or BroadcastChannel a tab runs alone", async () => {
    const b = browser();
    const a = b.open("a");
    expect(a.role()).toBe("connecting");
    expect(await a.ready).toBe("leader");
    expect(a.leader()).toBe("a");
    const second = b.open("b");
    const third = b.open("c");
    expect(await second.ready).toBe("follower");
    expect(await third.ready).toBe("follower");
    await until("both followers know the leader", () => second.leader() === "a" && third.leader() === "a");
    expect(b.engines.map((e) => e.name)).toEqual(["a"]);
    expect(second.worker()).toBeUndefined();
    for (const t of [a, second, third]) expect(await t.connectedTabs()).toBe(3);
    const snap = b.locks.snapshot();
    expect(snap.held.filter((l) => l.name === leaderLockName(SCOPE))).toEqual([{ name: leaderLockName(SCOPE), clientId: "a", mode: "exclusive" }]);
    expect(snap.pending.filter((l) => l.name === leaderLockName(SCOPE)).map((l) => l.clientId)).toEqual(["b", "c"]);

    const seen: string[] = [];
    third.onRoleChange((role, leader) => seen.push(`${role}:${leader}`));
    b.kill(a);
    await until("the oldest follower leads", () => second.role() === "leader" && third.leader() === "b");
    expect(b.engines.map((e) => e.name)).toEqual(["a", "b"]);
    expect(seen).toEqual(["follower:b"]);
    expect(await third.connectedTabs()).toBe(2);
    const counter = connectedTabsCounter(b.locks.view("probe"), SCOPE);
    expect(counter()).toBeNull();
    await until("a presence reading", () => counter() === 2);

    second.close();
    await until("the last tab leads", () => third.role() === "leader");
    expect(second.role()).toBe("closed");
    expect(b.engines.map((e) => [e.name, e.dead])).toEqual([["a", true], ["b", true], ["c", false]]);
    expect(await third.connectedTabs()).toBe(1);

    const lone = browser({ locks: null, openChannel: null });
    const solo = lone.open("solo");
    expect(await solo.ready).toBe("leader");
    expect(lone.engines).toHaveLength(1);
    expect(await solo.connectedTabs()).toBe(1);
    expect((await apiBody(solo, "/v1/status")).engine).toBe("solo");
  });

  it("[[browser.tabs.proxy]] a follower's requests, reads and state changes alike, are answered by the leader's engine as the leader's own are; errors keep the leader's code; notices reach followers; a relayed system snapshot is marked relayed", async () => {
    const b = browser();
    const a = b.open("a");
    await a.ready;
    const f = b.open("f");
    await f.ready;
    const notices: Notice[] = [];
    f.client.onNotice((n) => notices.push(n));

    expect(await f.client.status()).toEqual(await a.client.status());
    expect(await f.client.api("GET", "/v1/tokens")).toEqual(await a.client.api("GET", "/v1/tokens"));
    expect(await apiBody(f, "/v1/tokens")).toEqual({ engine: "a", method: "GET", target: "/v1/tokens" });
    expect(await f.client.booted()).toMatchObject({ phase: "ready" });

    const started = await f.client.start(TAPE);
    expect(started.engine).toMatchObject({ running: true, config: TAPE });
    expect(b.engineOf(a)!.calls.filter((c) => c.type === "start")).toEqual([{ type: "start", params: { config: TAPE } }]);
    await until("the engine notice reaches the follower", () => notices.some((n) => n.notice === "engine" && n.engine.state === "running"));
    const again = await f.client.start({}).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(EngineError);
    expect(again).toMatchObject({ code: "already-running", request: "start" });
    expect(await f.client.range("tip").catch((e: EngineError) => e.code)).toBe("not-implemented");
    expect(await f.client.reset().catch((e: EngineError) => e.code)).toBe("not-implemented");
    expect((await f.client.stop()).engine).toMatchObject({ running: false });
    expect(b.engines).toHaveLength(1);

    const snapshot = {
      format: "umbradb-system-snapshot", version: 1, generatedAt: 1, role: "leader", relayedAt: null,
    } as unknown as SystemSnapshot;
    // A complete snapshot is validated by relayedSnapshot; an incomplete one is refused rather than relayed unchecked.
    expect(() => asRelayed(snapshot, 5)).toThrow();
    const full = await import("../engine/system-snapshot.ts");
    const valid = full.SystemSnapshotSchema.parse(minimalSnapshot());
    expect(asRelayed(valid, 5)).toEqual({ ...valid, role: "follower", relayedAt: 5 });
    expect(asRelayed({ watching: true, snapshot: valid }, 7)).toEqual({ watching: true, snapshot: { ...valid, role: "follower", relayedAt: 7 } });
    expect(asRelayed({ status: 200, body: "{}" }, 7)).toEqual({ status: 200, body: "{}" });
  });

  it("[[browser.tabs.handover-rule]] in flight when the leader closes: status, api and export are answered by the next leader, other requests fail leader-changed, a late answer from the old leader is ignored; with no leader a request fails leader-unavailable; the new leader resumes the running engine, and only then", async () => {
    const b = browser();
    const a = b.open("a");
    await a.ready;
    const next = b.open("b");
    const other = b.open("c");
    await next.ready;
    await other.ready;
    await until("followers know the leader", () => next.leader() === "a" && other.leader() === "a");
    await other.client.start(TAPE);
    await until("the running engine is reported to the followers", async () => b.engineOf(a)!.state.engine?.running === true);
    // Let the leader's report (after its engine notice) reach the followers.
    await new Promise((r) => setTimeout(r, 50));

    b.engineOf(a)!.hold = new Set(["status", "api", "stop", "start", "reset", "export"]);
    const callsBefore = b.engineOf(a)!.calls.length;
    const inFlight = {
      otherStatus: track(other.client.status()),
      otherApi: track(other.client.api("GET", "/v1/status")),
      otherExport: track(other.client.export()),
      otherStop: track(other.client.stop()),
      otherStart: track(other.client.start(TAPE)),
      nextStatus: track(next.client.status()),
      nextReset: track(next.client.reset()),
    };
    await until("the leader received every request", () => b.engineOf(a)!.calls.length >= callsBefore + 7);
    await new Promise((r) => setTimeout(r, 30));
    expect(Object.values(inFlight).every((t) => !t.settled)).toBe(true);

    // The next leader's engine holds its answers too, so a forged late answer from the old leader can be tried.
    b.kill(a);
    await until("the next tab leads", () => next.role() === "leader" && other.leader() === "b");
    await until("the in-flight state changes failed", () => inFlight.otherStop.settled && inFlight.otherStart.settled && inFlight.nextReset.settled);
    for (const t of [inFlight.otherStop, inFlight.otherStart, inFlight.nextReset]) {
      expect(t.code).toBe("leader-changed");
      expect(t.message).toMatch(/may or may not have been applied/);
    }
    await until("the in-flight reads were answered by the next leader", () => inFlight.otherStatus.settled && inFlight.otherApi.settled && inFlight.nextStatus.settled);
    expect(JSON.parse(inFlight.otherApi.value!.body)).toMatchObject({ engine: "b", target: "/v1/status" });
    expect(inFlight.otherStatus.value!.protocol).toBe(PROTOCOL_VERSION);
    expect(inFlight.nextStatus.value!.protocol).toBe(PROTOCOL_VERSION);
    await until("the export was answered by the next leader", () => inFlight.otherExport.settled);
    expect(inFlight.otherExport.code).toBe("not-implemented");
    const nextEngine = b.engineOf(next)!;
    expect(nextEngine.calls.filter((c) => c.type === "export")).toHaveLength(1);
    expect(nextEngine.calls.filter((c) => ["stop", "reset"].includes(c.type))).toEqual([]);

    // The new leader resumed the configuration the old one was running.
    await until("the engine resumed", () => nextEngine.state.engine?.running === true);
    expect(nextEngine.calls.filter((c) => c.type === "start")).toEqual([{ type: "start", params: { config: TAPE } }]);

    // A late answer from the old leader, for a request that has moved to the new leader, is ignored.
    nextEngine.hold = new Set(["api"]);
    const moved = track(other.client.api("GET", "/v1/tokens"));
    await until("the request reached the new leader", () => nextEngine.calls.some((c) => c.type === "api" && c.params.target === "/v1/tokens"));
    const forged = b.channels.for("a-ghost")(tabChannelName(SCOPE, "c"));
    forged.postMessage({ v: PROTOCOL_VERSION, kind: "response", from: "a", id: 7, ok: true, result: { status: 500, headers: {}, body: "{}" } });
    forged.postMessage({ v: PROTOCOL_VERSION, kind: "response", from: "a", id: 8, ok: true, result: { status: 500, headers: {}, body: "{}" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(moved.settled).toBe(false);
    nextEngine.release();
    await until("the new leader answered", () => moved.settled);
    expect(JSON.parse(moved.value!.body)).toMatchObject({ engine: "b" });

    // A stopped engine is not resumed by the next leader.
    await other.client.stop();
    await new Promise((r) => setTimeout(r, 50));
    b.kill(next);
    await until("the last tab leads", () => other.role() === "leader");
    const lastEngine = b.engineOf(other)!;
    await until("the last leader booted and read its status", () => lastEngine.calls.filter((c) => c.type === "status").length >= 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(lastEngine.calls.filter((c) => c.type === "start")).toEqual([]);

    // No leader: a lock held by a context that never answers.
    const c = browser();
    void c.locks.view("ghost").request(leaderLockName(SCOPE), () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 5));
    const waiting = c.open("w");
    expect(await waiting.ready).toBe("follower");
    const t0 = Date.now();
    const lost = await waiting.client.status().catch((e: unknown) => e);
    expect(lost).toMatchObject({ code: "leader-unavailable", request: "status" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    // A request made while no leader is known is sent once one is.
    const queued = track(waiting.client.api("GET", "/v1/status"));
    c.locks.kill("ghost");
    await until("the waiting tab leads and answers", () => queued.settled);
    expect(JSON.parse(queued.value!.body)).toMatchObject({ engine: "w" });
  });

  it("[[browser.tabs.messages]] invalid tab messages are reported and ignored; the leader refuses an unknown request type; closing rejects what is pending and releases the tab's locks", async () => {
    const b = browser();
    const a = b.open("a");
    await a.ready;
    const f = b.open("f");
    await f.ready;
    await until("the follower knows the leader", () => f.leader() === "a");
    const invalid: string[] = [];
    f.client.onInvalid((m) => invalid.push(m));
    const raw = b.channels.for("x")(tabsChannelName(SCOPE));
    raw.postMessage({ v: 99, kind: "leader", from: "z", engine: null });
    raw.postMessage({ v: PROTOCOL_VERSION, kind: "gossip", from: "z" });
    raw.postMessage("hello");
    await until("three invalid messages reported", () => invalid.length === 3);
    expect(f.leader()).toBe("a");

    const answers: unknown[] = [];
    const inbox = b.channels.for("probe")(tabChannelName(SCOPE, "probe"));
    inbox.addEventListener("message", (e) => answers.push(e.data));
    raw.postMessage({ v: PROTOCOL_VERSION, kind: "request", from: "probe", to: "a", id: 1, type: "nope", params: {} });
    await until("the leader answered the probe", () => answers.length === 1);
    expect(answers[0]).toMatchObject({ kind: "response", from: "a", id: 1, ok: false, error: { code: "unknown-type" } });

    b.engineOf(a)!.hold = new Set(["status"]);
    const pending = track(f.client.status());
    await new Promise((r) => setTimeout(r, 20));
    f.close();
    await until("the pending request failed", () => pending.settled);
    expect(pending.code).toBe("closed");
    expect(await f.client.status().catch((e: EngineError) => e.code)).toBe("closed");
    expect(f.role()).toBe("closed");
    expect(b.locks.snapshot().held.map((l) => l.name)).not.toContain(tabLockName(SCOPE, "f"));
    expect(b.locks.snapshot().pending.map((l) => l.clientId)).not.toContain("f");
    expect(await a.connectedTabs()).toBe(1);
    a.close();
    await until("every lock released", () => b.locks.snapshot().held.length === 0 && b.locks.snapshot().pending.length === 0);
    expect(b.engineOf(a)!.dead).toBe(true);
  });

  it("[[browser.store.lock]] the store lock admits one holder; the next waits for its release; a wait that runs out fails naming the store", async () => {
    const locks = new FakeLocks();
    const first = await acquireStoreLock("opfs-ahp://s", locks.view("w1"), 1_000);
    let secondHeld = false;
    const second = acquireStoreLock("opfs-ahp://s", locks.view("w2"), 1_000).then((l) => { secondHeld = true; return l; });
    await new Promise((r) => setTimeout(r, 30));
    expect(secondHeld).toBe(false);
    expect(locks.snapshot().held).toEqual([{ name: storeLockName("opfs-ahp://s"), clientId: "w1", mode: "exclusive" }]);
    await expect(acquireStoreLock("opfs-ahp://s", locks.view("w3"), 50)).rejects.toThrow(
      "the store opfs-ahp://s is open in another engine worker (another tab of this browser profile?) and was not released within 50 ms",
    );
    first.release();
    (await second).release();
    expect(secondHeld).toBe(true);
    // A worker that ends without closing the store releases it too.
    await acquireStoreLock("opfs-ahp://s", locks.view("w4"), 1_000);
    locks.kill("w4");
    (await acquireStoreLock("opfs-ahp://s", locks.view("w5"), 1_000)).release();
    await until("the lock released", () => locks.snapshot().held.length === 0);
    expect(locks.snapshot()).toEqual({ held: [], pending: [] });
  });
});

function minimalSnapshot(): SystemSnapshot {
  const endpoint = {
    requests: 0, inFlight: 0, ok: 0, http429: 0, http403: 0, http5xx: 0, httpOther: 0, transportErrors: 0, aborted: 0,
    retries: 0, throttledRetries: 0, lastRequestAt: null, lastOkAt: null, lastFailureAt: null,
  };
  return {
    format: "umbradb-system-snapshot", version: 1, generatedAt: 1, role: "leader", relayedAt: null,
    overview: {
      health: { state: "stopped", label: "stopped", reason: null }, startHeight: null, archiveHeight: null, scanHeight: null, finalizedTip: null, finalizedTipAt: null,
      lag: { blocks: null, archiveBlocks: null, scanBehindArchive: null, seconds: null, secondsPerBlock: null, catchUpSeconds: null },
    },
    configuration: {
      network: "stagenet", genesisHash: null, endpoints: { node: null, indexer: null }, schemas: { archive: "chain_archive", mip0018: "mip0018" },
      sync: null, scan: null, retry: null, start: { mode: "tip", startHeight: null, endHeight: null, autoStart: true }, durability: null,
      watchdogLimitMs: null, api: { maxConcurrentRequests: 8 },
      build: { appCommit: null, pgliteVersion: null, postgresVersion: null, ledgerVersion: null, mip: null, vendored: null },
    },
    sync: {
      phase: "off", archiveStart: null, archiveHeight: null, nodeFinalizedHeight: null, indexerTipHeight: null, finalizedTip: null, blocksPerSecond: 0,
      ingestedSinceStart: 0, endpoints: { node: endpoint, indexer: endpoint }, lastSuccessAt: null, nextAttemptAt: null, lastError: null, failures: 0,
    },
    scan: {
      phase: "off", scanner: "off", startHeight: null, nextHeight: null, lagBehindArchive: null, blocksPerSecond: 0, scannedSinceStart: 0,
      totals: { transactions: 0, events: 0, mints: 0, sightings: 0, actions: 0 }, unresolvedEvents: null, lastSuccessAt: null, nextAttemptAt: null, lastError: null, failures: 0,
    },
    databases: { dataDir: null, serverVersion: null, fsync: null, durability: null, databaseBytes: null, schemas: [], collectedAt: null, statements: [], exactRowsAt: null, error: null },
    storage: {
      usageBytes: null, quotaBytes: null, persisted: null, estimatedAt: null, pauseAtBytes: null, paused: false, pausedReason: null, databaseBytes: null,
      bytesPerBlock: { store: null, growth: null },
    },
    api: { inFlight: 0, maxConcurrentRequests: 8, served: 0, byStatus: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }, busy: 0, latencyMs: { p50: null, p95: null, samples: 0, window: 1_000 } },
    engine: {
      started: false, stopping: false, connectedTabs: null, startedAt: 1, uptimeMs: 0, watchdogRestarts: 0, lastWatchdogRestart: null, pgliteReopens: 0,
      lastReopenAt: null, failedStatementsSinceOpen: 0, failedStatementsTotal: 0,
    },
    browser: null,
    snapshots: { lastExport: null, lastImport: null },
    logs: [],
    collection: { watching: false, countersEveryMs: 2_000, databaseEveryMs: 30_000, statusAt: null, statusError: null },
  } as SystemSnapshot;
}
