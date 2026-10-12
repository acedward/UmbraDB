/**
 * The bounds of the Chromium tests' driver (`helpers/cdp-browser.ts`), timed exactly: the driver's own `Connection` and
 * `Page` over a DevTools endpoint without a browser, with fake time.
 *
 * - `[[browser.harness.command-bounds-timing]]` — an evaluation in a worker whose first setup command is never answered
 *   is still waiting 1 ms before its own bound and fails with the setup's timeout at the bound, the evaluation never
 *   sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, Page } from "./helpers/cdp-browser.ts";

/** A DevTools command as the driver sends it. */
interface Command { id: number; method: string; params: Record<string, unknown>; sessionId?: string }

/** How the endpoint answers a command: with `result` at once, with `result` after `after` ms, or never (`undefined`). */
type Answer = { result: unknown; after?: number } | undefined;

/** A DevTools endpoint without a browser: it records every command sent, answers each as `answer` says, and can send
 *  events. */
class FakeDevTools {
  readonly sent: Command[] = [];
  private readonly listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor(private readonly answer: (command: Command) => Answer) {}
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(text: string): void {
    const command = JSON.parse(text) as Command;
    this.sent.push(command);
    const a = this.answer(command);
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

/** The answers a page's opening needs; `own` first. */
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

const connections: Connection[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  vi.useRealTimers();
});

/** A page of the driver over `devtools`, with fake time from now on. */
async function fakePage(devtools: FakeDevTools, opts: { workers?: boolean } = {}): Promise<{ page: Page; connection: Connection }> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const connection = new Connection(devtools as unknown as WebSocket);
  connections.push(connection);
  const page = await Page.open(connection, opts);
  return { page, connection };
}

describe("the Chromium tests' driver, timed", () => {
  it("[[browser.harness.command-bounds-timing]] an evaluation in a worker whose setup is never answered waits until its own bound, then fails with the setup's timeout, never sent", async () => {
    const devtools = new FakeDevTools(pageAnswers((c) => (c.sessionId === "worker-session" && c.method === "Runtime.enable" ? undefined : "default")));
    const { page, connection } = await fakePage(devtools, { workers: true });
    devtools.emit({
      method: "Target.attachedToTarget", sessionId: "page-session",
      params: { sessionId: "worker-session", targetInfo: { type: "worker", targetId: "worker-target", url: "http://worker.test/w.js" }, waitingForDebugger: true },
    });
    expect(page.workerSessions).toEqual(["worker-session"]);
    const evaluation = track(page.evalWorker("1 + 1", 300));
    await vi.advanceTimersByTimeAsync(299);
    expect(evaluation.settled(), "still waiting at 299 ms").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(evaluation.settled(), "ended at 300 ms").toBe(true);
    await expect(evaluation.promise).rejects.toThrow("the worker's setup: no answer within 300 ms");
    expect(devtools.sent.filter((c) => c.sessionId === "worker-session").map((c) => c.method), "the evaluation never sent").toEqual(["Runtime.enable"]);
    expect(connection.waiting).toBe(1);
  }, 30_000);
});
