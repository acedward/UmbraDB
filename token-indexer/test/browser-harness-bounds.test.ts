/**
 * The bounds of the Chromium tests' driver (`helpers/cdp-browser.ts`), timed exactly: the driver's own `Connection` and
 * `Page` over a DevTools endpoint without a browser, with fake time; and `Browser.launch` with an executable that is not
 * a browser, in real time.
 *
 * - `[[browser.harness.command-bounds-timing]]` — each bound ends its wait when it says, and not 1 ms sooner:
 *   - a command never answered fails with `CommandTimeoutError` at its own bound, else at `COMMAND_TIMEOUT_MS` (ten
 *     minutes), and is then forgotten;
 *   - a load whose navigation is never answered fails at the load's time; one whose navigation answers late and whose
 *     load event never comes fails at the load's time too, counted from before the navigation was sent;
 *   - a wait whose first evaluation answers and whose next one never does fails at the wait's time: each evaluation has
 *     only the time the wait has left;
 *   - an evaluation in a worker whose first setup command is never answered fails with the setup's timeout at the
 *     evaluation's bound, never sent; one whose setup answers late has only the rest for the evaluation;
 *   - a crash that never comes fails at the crash's time, its `Page.crash` command forgotten then too;
 *   - a command that cannot be serialized, or that the socket refuses, fails at once and leaves no timer and nothing
 *     waiting;
 *   - an answer that comes after its command's bound is ignored: nothing throws, and the commands still waiting keep
 *     waiting for their own answers;
 *   - a browser launch whose DevTools line comes late and whose DevTools connection never opens fails at the launch's
 *     time, counted from its start, and one that never prints the line fails at it too; each ends the process it
 *     started.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
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
  private readonly listeners = new Map<string, Array<(ev: { data: string }) => void>>();
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
    for (const l of this.listeners.get("message") ?? []) l({ data: JSON.stringify(message) });
  }
  close(): void {
    for (const l of this.listeners.get("close") ?? []) l({ data: "" });
  }
}

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

/** Fake time for the timers the driver and the endpoint use, and `Date`. */
const fakeTime = (): void => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
};

const connections: Connection[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
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

/** Advances fake time to `ms` after `from` and says whether `t` has settled then. */
async function settledAt(t: { settled: () => boolean }, from: number, ms: number): Promise<boolean> {
  await vi.advanceTimersByTimeAsync(from + ms - Date.now());
  return t.settled();
}

/** Whether the process `pid` has ended, waited for at most 3 s (real time). */
async function ended(pid: number): Promise<boolean> {
  const end = Date.now() + 3_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("the Chromium tests' driver, timed", () => {
  it("[[browser.harness.command-bounds-timing]] each bound ends its wait when it says: a command's own bound and the ten-minute default; a load's, from before its navigation is sent; each evaluation of a wait, the wait's remaining time; a worker evaluation's, its setup included, never sent while the setup waits; a crash's, its command forgotten too; a command that cannot be serialized or sent leaves nothing behind; an answer after its bound is ignored; a browser launch's, its start and its DevTools connection together, ending the process", async () => {
    // A command's own bound, and the default.
    fakeTime();
    {
      const devtools = new FakeDevTools((c) => (c.method.startsWith("Test.") ? undefined : { result: {} }));
      const connection = connect(devtools);
      let t0 = Date.now();
      const own = track(connection.send("Test.never", {}, undefined, 250));
      expect(await settledAt(own, t0, 249), "a command's bound: waiting at 249 ms").toBe(false);
      expect(await settledAt(own, t0, 250), "a command's bound: ended at 250 ms").toBe(true);
      await expect(own.promise).rejects.toThrow(new CommandTimeoutError("Test.never", 250).message);
      await expect(own.promise).rejects.toBeInstanceOf(CommandTimeoutError);
      expect(connection.waiting, "forgotten at its bound").toBe(0);
      expect(COMMAND_TIMEOUT_MS).toBe(600_000);
      t0 = Date.now();
      const unbounded = track(connection.send("Test.neverDefault"));
      expect(await settledAt(unbounded, t0, COMMAND_TIMEOUT_MS - 1), "the default: waiting 1 ms before ten minutes").toBe(false);
      expect(await settledAt(unbounded, t0, COMMAND_TIMEOUT_MS), "the default: ended at ten minutes").toBe(true);
      await expect(unbounded.promise).rejects.toThrow("Test.neverDefault: no answer within 600000 ms");
      expect(connection.waiting).toBe(0);
    }

    // A load whose navigation is never answered, and one whose navigation answers after 600 ms and whose load event
    // never comes: both fail at the load's 1,000 ms (the load's check runs every 50 ms), counted from before the send.
    for (const navigation of [undefined, { result: { frameId: "frame" }, after: 600 }]) {
      const devtools = new FakeDevTools(pageAnswers((c) => (c.method === "Page.navigate" ? navigation : "default")));
      const { page } = await fakePage(devtools);
      const t0 = Date.now();
      const load = track(page.goto("http://page.test/", 1_000));
      const what = navigation === undefined ? "a navigation never answered" : "a navigation answered at 600 ms";
      expect(await settledAt(load, t0, 999), `${what}: waiting at 999 ms`).toBe(false);
      expect(await settledAt(load, t0, 1_050), `${what}: ended by 1,050 ms`).toBe(true);
      await expect(load.promise).rejects.toThrow("load of http://page.test/ timed out");
    }

    // A wait whose first evaluation answers "false" and whose next one, sent 100 ms later, is never answered: that
    // evaluation has the 900 ms the wait has left, so the wait fails at its 1,000 ms.
    {
      let evaluations = 0;
      const devtools = new FakeDevTools(pageAnswers((c) => {
        if (c.method !== "Runtime.evaluate") return "default";
        evaluations++;
        return evaluations === 1 ? { result: { result: { value: false } } } : undefined;
      }));
      const { page } = await fakePage(devtools);
      const t0 = Date.now();
      const wait = track(page.waitFor("window.ready", 1_000, "the page"));
      expect(await settledAt(wait, t0, 999), "a wait: waiting at 999 ms").toBe(false);
      expect(await settledAt(wait, t0, 1_000), "a wait: ended at 1,000 ms").toBe(true);
      await expect(wait.promise).rejects.toThrow("timed out waiting for the page");
      expect(evaluations).toBe(2);
    }

    // A worker evaluation: the worker's first setup command never answered — the evaluation fails with the setup's
    // timeout at its own bound and is never sent; the setup answered at 200 ms and the evaluation never — it fails at
    // its 300 ms, the evaluation having the 100 ms left.
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
      const what = setupAnswer === undefined ? "a setup never answered" : "a setup answered at 200 ms";
      expect(await settledAt(evaluation, t0, 299), `${what}: waiting at 299 ms`).toBe(false);
      expect(await settledAt(evaluation, t0, 300), `${what}: ended at 300 ms`).toBe(true);
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

    // A crash that never comes (no answer, no crash event): it fails at its 500 ms (checked every 10 ms), and its
    // `Page.crash` command is forgotten at 500 ms too; one whose crash event comes at 100 ms ends then.
    {
      const devtools = new FakeDevTools(pageAnswers((c) => (c.method === "Page.crash" ? undefined : "default")));
      const { page, connection } = await fakePage(devtools);
      let t0 = Date.now();
      const crash = track(page.crash(500));
      expect(await settledAt(crash, t0, 499), "a crash: waiting at 499 ms").toBe(false);
      expect(connection.waiting, "its command waiting at 499 ms").toBe(1);
      expect(await settledAt(crash, t0, 510), "a crash: ended by 510 ms").toBe(true);
      await expect(crash.promise).rejects.toThrow("the renderer did not crash");
      expect(connection.waiting, "its command forgotten at the crash's bound").toBe(0);
      t0 = Date.now();
      const crashing = track(page.crash(500));
      setTimeout(() => devtools.emit({ method: "Inspector.targetCrashed", sessionId: "page-session", params: {} }), 100);
      expect(await settledAt(crashing, t0, 110), "a crash event at 100 ms: ended by 110 ms").toBe(true);
      await expect(crashing.promise).resolves.toBeUndefined();
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
      expect(await settledAt(late, t0, 100)).toBe(true);
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

    // A browser launch, in real time, with an executable that is not a browser: it records its process id, prints the
    // DevTools line after `lineAfterMs` (never: null), pointing at an endpoint that accepts the connection but never
    // answers the WebSocket handshake, and ends by itself after 30 s (so a failed run leaves no process behind).
    const held: Socket[] = [];
    const endpoint = createServer((s) => { held.push(s); });
    await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", () => r()));
    const dir = mkdtempSync(join(tmpdir(), "umbradb-not-a-browser-"));
    try {
      const notABrowser = (name: string, lineAfterMs: number | null): { path: string; pid: () => number } => {
        const path = join(dir, `${name}.cjs`);
        const pidFile = join(dir, `${name}.pid`);
        const line = `DevTools listening on ws://127.0.0.1:${(endpoint.address() as AddressInfo).port}/devtools/browser/fake\n`;
        writeFileSync(path, [
          "#!/usr/bin/env node",
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
          lineAfterMs === null ? "" : `setTimeout(() => process.stderr.write(${JSON.stringify(line)}), ${lineAfterMs});`,
          "setTimeout(() => process.exit(0), 30000);",
        ].join("\n"));
        chmodSync(path, 0o755);
        return { path, pid: () => Number(readFileSync(pidFile, "utf8")) };
      };
      // The DevTools line at 500 ms: the connection has only the rest of the launch's 1,000 ms.
      const late = notABrowser("late-line", 500);
      let t0 = Date.now();
      await expect(Browser.launch(late.path, 1_000)).rejects.toThrow("the browser's DevTools connection did not open within 1000 ms");
      let took = Date.now() - t0;
      expect(took, "the launch's own 1,000 ms").toBeGreaterThanOrEqual(990);
      expect(took, "counted from the launch's start, not from the DevTools line").toBeLessThan(1_400);
      expect(await ended(late.pid()), "the process it started ended").toBe(true);
      // No DevTools line at all.
      const silent = notABrowser("no-line", null);
      t0 = Date.now();
      await expect(Browser.launch(silent.path, 1_000)).rejects.toThrow("the browser did not start within 1000 ms");
      took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(990);
      expect(took).toBeLessThan(1_400);
      expect(await ended(silent.pid()), "the process it started ended").toBe(true);
    } finally {
      for (const s of held) s.destroy();
      await new Promise<void>((r) => endpoint.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
