/**
 * The bounds of the Chromium tests' driver (`helpers/cdp-browser.ts`), timed exactly with fake time: the driver's own
 * `Connection` and `Page` over a DevTools endpoint without a browser, and `Browser.launch` with its process and socket
 * replaced (its `LaunchSeam`); then one real launch of an executable that is not a browser, as a smoke case.
 *
 * - `[[browser.harness.command-bounds-timing]]` — each bound is still waiting 1 ms before it and has ended at it:
 *   - a command never answered fails with `CommandTimeoutError` at its own bound, else at `COMMAND_TIMEOUT_MS` (ten
 *     minutes), and is then forgotten;
 *   - a load whose navigation is never answered, and one whose navigation answers late and whose load event never
 *     comes, fail at the load's time, counted from before the navigation was sent; a load event ends the load at once;
 *   - a wait whose next evaluation is never answered, and one whose every evaluation answers "no", fail at the wait's
 *     time (each evaluation has only the time the wait has left);
 *   - an evaluation in a worker whose first setup command is never answered fails with the setup's timeout at the
 *     evaluation's bound, never sent; one whose setup answers late has only the rest for the evaluation;
 *   - a crash that never comes fails at the crash's time, its `Page.crash` command forgotten at that time too; a crash
 *     event ends it at once;
 *   - a browser launch whose process never prints its DevTools line fails at the launch's time with the start's error;
 *     one whose line comes at 2,000 ms and whose DevTools socket never opens fails at the launch's 3,000 ms with the
 *     connection's error, the socket closed; each kills its process and removes the profile directory it created; one
 *     whose socket opens resolves then, and closing it ends the process and removes the profile; one whose spawn throws
 *     fails with that error and leaves no profile;
 *   - a command that cannot be serialized, or that the socket refuses, fails at once and leaves no timer and nothing
 *     waiting; an answer that comes after its command's bound is ignored (nothing throws, and the commands still
 *     waiting keep waiting for their own answers);
 *   - a real launch of an executable that never prints the line fails with the start's error, its process ended and
 *     its profile directory removed.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Browser, COMMAND_TIMEOUT_MS, CommandTimeoutError, Connection, Page } from "./helpers/cdp-browser.ts";

/** A DevTools command as the driver sends it. */
interface Command { id: number; method: string; params: Record<string, unknown>; sessionId?: string }

/** How the endpoint answers a command: with `result` at once, with `result` after `after` ms, never (`undefined`), or by
 *  refusing it as the socket does when it is closing (`"refuse"`: `send` throws). */
type Answer = { result: unknown; after?: number } | "refuse" | undefined;

/** A DevTools endpoint without a browser: it records every command sent, answers each as `answer` says, and can send
 *  events and answers of its own. */
class FakeDevTools {
  readonly sent: Command[] = [];
  protected readonly listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor(private readonly answer: (command: Command) => Answer) {}
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(text: string): void {
    const command = JSON.parse(text) as Command;
    const a = this.answer(command);
    if (a === "refuse") throw new Error(`${command.method}: the socket is closing`);
    this.sent.push(command);
    if (a === undefined) return;
    if (a.after === undefined) queueMicrotask(() => this.emit({ id: command.id, result: a.result }));
    else setTimeout(() => this.emit({ id: command.id, result: a.result }), a.after);
  }
  emit(message: unknown): void {
    this.dispatch("message", JSON.stringify(message));
  }
  close(): void {
    this.dispatch("close", "");
  }
  protected dispatch(type: string, data: string): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

/** A DevTools socket for `Browser.launch` without a browser: it never answers, and opens when the test says. */
class FakeSocket extends FakeDevTools {
  closes = 0;
  constructor(readonly url: string) {
    super(() => undefined);
  }
  open(): void {
    this.dispatch("open", "");
  }
  override close(): void {
    this.closes++;
    super.close();
  }
}

/** A browser process for `Browser.launch` without a browser: it prints what the test gives it on stderr, and a kill
 *  ends it (its exit reported a moment later, as a process's is). */
class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];
  constructor(readonly args: string[]) {
    super();
  }
  print(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  }
  /** The profile directory the launch gave it. */
  get profile(): string {
    return profileOf(this.args);
  }
}

/** The profile directory in a launch's arguments. */
function profileOf(args: string[]): string {
  return args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
}

/** What the case's launches started — profile directories, processes, sockets — cleaned after it whatever its outcome
 *  (a launch still waiting when an assertion fails included), before real time is restored. */
const launched = {
  profiles: [] as string[],
  processes: [] as Array<{ exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean }>,
  sockets: [] as Array<{ close(): void }>,
};

/** The answers a page's opening needs; `own` first (`"default"`: these). */
const pageAnswers = (own: (c: Command) => Answer | "default" = () => "default") => (c: Command): Answer => {
  const a = own(c);
  if (a !== "default") return a;
  if (c.method === "Target.createTarget") return { result: { targetId: "page-target" } };
  if (c.method === "Target.attachToTarget") return { result: { sessionId: "page-session" } };
  return { result: {} };
};

/** A promise and whether it has settled, read without awaiting it. */
function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return { promise, settled: () => done };
}

/** Advances fake time to 1 ms before `from + bound`, checks that `t` still waits, then to `from + bound` and checks
 *  that it has ended: no allowance on either side. */
async function endsExactlyAt(t: { settled: () => boolean }, from: number, bound: number, what: string): Promise<void> {
  await vi.advanceTimersByTimeAsync(from + bound - 1 - Date.now());
  expect(t.settled(), `${what}: still waiting at ${bound - 1} ms`).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.settled(), `${what}: ended at ${bound} ms`).toBe(true);
}

const connections: Connection[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const s of launched.sockets.splice(0)) s.close();
  for (const p of launched.processes.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  for (const d of launched.profiles.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

/** The driver's connection to `devtools`. */
function connect(devtools: FakeDevTools): Connection {
  const connection = new Connection(devtools as unknown as WebSocket);
  connections.push(connection);
  return connection;
}

/** A page of the driver over `devtools`. */
async function fakePage(devtools: FakeDevTools, opts: { workers?: boolean } = {}): Promise<{ page: Page; connection: Connection }> {
  const connection = connect(devtools);
  return { page: await Page.open(connection, opts), connection };
}

describe("the Chromium tests' driver, timed", () => {
  it("[[browser.harness.command-bounds-timing]] each bound is still waiting 1 ms before it and has ended at it: a command's own and the ten-minute default; a load's, from before its navigation is sent; each evaluation of a wait, the wait's remaining time; a worker evaluation's, its setup included, never sent while the setup waits; a crash's and its command's; a browser launch's start and DevTools connection together, its process killed, its socket closed and its profile removed, also when its spawn throws; a command that cannot be serialized or sent leaves nothing behind; an answer after its bound is ignored; a real launch that fails ends its process and removes its profile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });

    // A command's own bound, and the default.
    {
      const devtools = new FakeDevTools((c) => (c.method.startsWith("Test.") ? undefined : { result: {} }));
      const connection = connect(devtools);
      let t0 = Date.now();
      const own = track(connection.send("Test.never", {}, undefined, 250));
      await endsExactlyAt(own, t0, 250, "a command's bound");
      await expect(own.promise).rejects.toThrow(new CommandTimeoutError("Test.never", 250).message);
      await expect(own.promise).rejects.toBeInstanceOf(CommandTimeoutError);
      expect(connection.waiting, "forgotten at its bound").toBe(0);
      expect(COMMAND_TIMEOUT_MS).toBe(600_000);
      t0 = Date.now();
      const unbounded = track(connection.send("Test.neverDefault"));
      await endsExactlyAt(unbounded, t0, COMMAND_TIMEOUT_MS, "the default");
      await expect(unbounded.promise).rejects.toThrow("Test.neverDefault: no answer within 600000 ms");
      expect(connection.waiting).toBe(0);
    }

    // Loads of 1,000 ms: the navigation never answered; the navigation answered at 600 ms and no load event — both end
    // at 1,000 ms, counted from before the send; the navigation answered at 100 ms and the load event at 300 ms — the
    // load ends at 300 ms.
    for (const [navigation, loadEventAt] of [[undefined, null], [{ result: { frameId: "frame" }, after: 600 }, null], [{ result: { frameId: "frame" }, after: 100 }, 300]] as const) {
      const devtools = new FakeDevTools(pageAnswers((c) => (c.method === "Page.navigate" ? navigation : "default")));
      const { page } = await fakePage(devtools);
      const t0 = Date.now();
      const load = track(page.goto("http://page.test/", 1_000));
      if (loadEventAt !== null) {
        setTimeout(() => devtools.emit({ method: "Page.loadEventFired", sessionId: "page-session", params: {} }), loadEventAt);
        await endsExactlyAt(load, t0, loadEventAt, "a load whose load event comes at 300 ms");
        await expect(load.promise).resolves.toBeUndefined();
        continue;
      }
      await endsExactlyAt(load, t0, 1_000, navigation === undefined ? "a navigation never answered" : "a navigation answered at 600 ms");
      await expect(load.promise).rejects.toThrow("load of http://page.test/ timed out");
    }

    // Waits: the first evaluation answers "no" and the next one, sent 100 ms later, never answers — it has the 900 ms
    // the wait has left, so the wait ends at its 1,000 ms; every evaluation answers "no" — a 950 ms wait ends at 950 ms.
    for (const [never, timeoutMs] of [[true, 1_000], [false, 950]] as const) {
      let evaluations = 0;
      const devtools = new FakeDevTools(pageAnswers((c) => {
        if (c.method !== "Runtime.evaluate") return "default";
        evaluations++;
        return evaluations > 1 && never ? undefined : { result: { result: { value: false } } };
      }));
      const { page } = await fakePage(devtools);
      const t0 = Date.now();
      const wait = track(page.waitFor("window.ready", timeoutMs, "the page"));
      await endsExactlyAt(wait, t0, timeoutMs, never ? "a wait whose second evaluation never answers" : "a wait answered no every time");
      await expect(wait.promise).rejects.toThrow("timed out waiting for the page");
      if (never) expect(evaluations).toBe(2);
    }

    // Worker evaluations of 300 ms: the worker's first setup command never answered — the setup's timeout at 300 ms, the
    // evaluation never sent; the setup answered at 200 ms and the evaluation never — it ends at 300 ms, the evaluation
    // having the 100 ms left.
    for (const setupAnswer of [undefined, { result: {}, after: 200 }]) {
      const devtools = new FakeDevTools(pageAnswers((c) => {
        if (c.sessionId !== "worker-session") return "default";
        if (c.method === "Runtime.enable") return setupAnswer;
        if (c.method === "Runtime.evaluate" && c.params.expression === "1 + 1") return undefined;
        return { result: {} };
      }));
      const { page, connection } = await fakePage(devtools, { workers: true });
      devtools.emit({
        method: "Target.attachedToTarget", sessionId: "page-session",
        params: { sessionId: "worker-session", targetInfo: { type: "worker", targetId: "worker-target", url: "http://worker.test/w.js" }, waitingForDebugger: true },
      });
      expect(page.workerSessions).toEqual(["worker-session"]);
      const t0 = Date.now();
      const evaluation = track(page.evalWorker("1 + 1", 300));
      await endsExactlyAt(evaluation, t0, 300, setupAnswer === undefined ? "a setup never answered" : "a setup answered at 200 ms");
      const sentToWorker = devtools.sent.filter((c) => c.sessionId === "worker-session");
      if (setupAnswer === undefined) {
        await expect(evaluation.promise).rejects.toThrow("the worker's setup: no answer within 300 ms");
        expect(sentToWorker.map((c) => c.method), "the evaluation never sent").toEqual(["Runtime.enable"]);
        expect(connection.waiting, "the setup's command, waiting for its own bound").toBe(1);
      } else {
        await expect(evaluation.promise).rejects.toThrow("Runtime.evaluate: no answer within 100 ms");
        expect(sentToWorker.filter((c) => c.params.expression === "1 + 1"), "the evaluation sent once").toHaveLength(1);
      }
    }

    // A crash of 500 ms that never comes (no answer, no crash event): it ends at 500 ms, and its `Page.crash` command
    // is forgotten at 500 ms too; one whose crash event comes at 100 ms ends then.
    {
      const devtools = new FakeDevTools(pageAnswers((c) => (c.method === "Page.crash" ? undefined : "default")));
      const { page, connection } = await fakePage(devtools);
      let t0 = Date.now();
      const crash = track(page.crash(500));
      await vi.advanceTimersByTimeAsync(499);
      expect(crash.settled(), "a crash: still waiting at 499 ms").toBe(false);
      expect(connection.waiting, "its command still waiting at 499 ms").toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(crash.settled(), "a crash: ended at 500 ms").toBe(true);
      expect(connection.waiting, "its command forgotten at 500 ms").toBe(0);
      await expect(crash.promise).rejects.toThrow("the renderer did not crash");
      t0 = Date.now();
      const crashing = track(page.crash(500));
      setTimeout(() => devtools.emit({ method: "Inspector.targetCrashed", sessionId: "page-session", params: {} }), 100);
      await endsExactlyAt(crashing, t0, 100, "a crash event at 100 ms");
      await expect(crashing.promise).resolves.toBeUndefined();
    }

    // Browser launches, the process and socket replaced: one whose process never prints its DevTools line (1,000 ms);
    // one whose line comes at 2,000 ms and whose socket never opens (3,000 ms); one whose line comes at 100 ms and whose
    // socket opens at 200 ms.
    for (const [lineAt, opensAt, timeoutMs] of [[null, null, 1_000], [2_000, null, 3_000], [100, 200, 3_000]] as const) {
      const children: FakeChild[] = [];
      const sockets: FakeSocket[] = [];
      const seam = {
        spawn: (_e: string, args: string[]): ChildProcess => {
          const c = new FakeChild(args);
          children.push(c);
          launched.profiles.push(c.profile);
          launched.processes.push(c);
          return c as unknown as ChildProcess;
        },
        socket: (url: string): WebSocket => {
          const s = new FakeSocket(url);
          sockets.push(s);
          launched.sockets.push(s);
          if (opensAt !== null) setTimeout(() => s.open(), opensAt - lineAt!);
          return s as unknown as WebSocket;
        },
      };
      const t0 = Date.now();
      const launch = track(Browser.launch("not-a-browser", timeoutMs, seam));
      const child = children[0]!;
      expect(existsSync(child.profile), "the launch's profile directory").toBe(true);
      if (lineAt !== null) setTimeout(() => child.print("DevTools listening on ws://127.0.0.1:9/devtools/browser/fake\n"), lineAt);
      if (opensAt !== null) {
        await endsExactlyAt(launch, t0, opensAt, "a launch whose socket opens at 200 ms");
        const browser = await launch.promise;
        expect(sockets.map((s) => s.url)).toEqual(["ws://127.0.0.1:9/devtools/browser/fake"]);
        const closing = browser.close();
        await vi.advanceTimersByTimeAsync(5_000);
        await closing;
        expect(child.kills).toEqual(["SIGKILL"]);
        expect(existsSync(child.profile), "its profile removed when it closes").toBe(false);
        continue;
      }
      await endsExactlyAt(launch, t0, timeoutMs, lineAt === null ? "a launch that never prints its line" : "a launch whose socket never opens");
      if (lineAt === null) {
        await expect(launch.promise).rejects.toThrow("the browser did not start within 1000 ms");
        expect(sockets, "no socket opened").toEqual([]);
      } else {
        await expect(launch.promise).rejects.toThrow("the browser's DevTools connection did not open within 3000 ms");
        expect(sockets.map((s) => [s.url, s.closes]), "the socket closed").toEqual([["ws://127.0.0.1:9/devtools/browser/fake", 1]]);
      }
      expect(child.kills, "its process killed").toEqual(["SIGKILL"]);
      expect(existsSync(child.profile), "its profile removed").toBe(false);
    }

    // A launch whose spawn throws: it fails with that error, and the profile it created is removed.
    {
      const profiles: string[] = [];
      const spawnThrows = (_e: string, args: string[]): ChildProcess => {
        profiles.push(profileOf(args));
        launched.profiles.push(profileOf(args));
        throw new Error("spawn failed");
      };
      await expect(Browser.launch("not-a-browser", 1_000, { spawn: spawnThrows })).rejects.toThrow("spawn failed");
      expect(profiles).toHaveLength(1);
      expect(existsSync(profiles[0]!), "its profile removed").toBe(false);
    }

    // A command that cannot be serialized, and one the socket refuses: each fails at once, with no timer and nothing
    // waiting left behind.
    {
      const devtools = new FakeDevTools((c) => (c.method === "Test.refused" ? "refuse" : { result: {} }));
      const connection = connect(devtools);
      const timers = vi.getTimerCount();
      await expect(connection.send("Test.big", { value: 1n })).rejects.toBeInstanceOf(TypeError);
      await expect(connection.send("Test.refused")).rejects.toThrow("Test.refused: the socket is closing");
      expect(connection.waiting).toBe(0);
      expect(vi.getTimerCount(), "no timer left").toBe(timers);
    }

    // An answer after its command's bound: ignored — nothing throws, and a command still waiting is not answered by it.
    {
      const devtools = new FakeDevTools((c) => (c.method.startsWith("Test.") ? undefined : { result: {} }));
      const connection = connect(devtools);
      const t0 = Date.now();
      const late = track(connection.send("Test.late", {}, undefined, 100));
      const waiting = track(connection.send("Test.waiting", {}, undefined, 10_000));
      await endsExactlyAt(late, t0, 100, "a command's bound");
      await expect(late.promise).rejects.toBeInstanceOf(CommandTimeoutError);
      expect(connection.waiting, "only the command still waiting").toBe(1);
      const lateId = devtools.sent.find((c) => c.method === "Test.late")!.id;
      expect(() => devtools.emit({ id: lateId, result: { from: "the late answer" } })).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(waiting.settled(), "the other command still waits").toBe(false);
      expect(connection.waiting).toBe(1);
      devtools.emit({ id: devtools.sent.find((c) => c.method === "Test.waiting")!.id, result: { from: "its own answer" } });
      await expect(waiting.promise).resolves.toEqual({ from: "its own answer" });
      expect(connection.waiting).toBe(0);
    }
    vi.useRealTimers();

    // A real launch of an executable that is not a browser and never prints the DevTools line (it ends by itself after
    // 30 s, so a failed run leaves no process): the start's error, its process ended, its profile removed. No timing is
    // asserted here; the test's own timeout is the watchdog.
    const dir = mkdtempSync(join(tmpdir(), "umbradb-not-a-browser-"));
    try {
      const path = join(dir, "silent.cjs");
      writeFileSync(path, ["#!/usr/bin/env node", "setTimeout(() => process.exit(0), 30000);"].join("\n"));
      chmodSync(path, 0o755);
      const started: Array<{ child: ChildProcess; args: string[] }> = [];
      const realSpawn = (e: string, args: string[]): ChildProcess => {
        const child = spawn(e, args, { stdio: ["ignore", "ignore", "pipe"] });
        started.push({ child, args });
        launched.profiles.push(profileOf(args));
        launched.processes.push(child);
        return child;
      };
      await expect(Browser.launch(path, 1_000, { spawn: realSpawn })).rejects.toThrow("the browser did not start within 1000 ms");
      const { child, args } = started[0]!;
      if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once("exit", r));
      expect(child.signalCode, "its process ended by the launch").toBe("SIGKILL");
      expect(existsSync(profileOf(args)), "its profile removed").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
