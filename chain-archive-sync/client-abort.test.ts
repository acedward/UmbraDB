/**
 * The node and indexer clients stop when their caller does (`signal`): a wait for the pacer's turn and a request in
 * flight end at once, and nothing is fetched after the stop.
 *
 * - `[[archive.clients.abort]]` — each client, given a stop signal: a call waiting for a shared pacer's turn (a pacer
 *   that would hold it for ten minutes) passes the signal to the pacer and ends at once when the signal ends, its
 *   request never made; a request in flight ends at once, long before its timeout; a call after the stop makes no
 *   request; a client's own pacer (`RequestPacer`) stops waiting when the signal ends.
 * - `[[archive.pacer.timers]]` — a `RequestPacer` wait ended by its signal leaves no timer behind (its slot stays
 *   reserved: the next wait is still spaced), so a Node process whose sync stops exits at once: a child process that
 *   reserves a slot a minute ahead and stops ends within seconds.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { IndexerClient } from "./indexer-client.js";
import { NodeRpcClient } from "./node-rpc-client.js";
import { type Pacer, RequestPacer } from "./polite-http.js";

/** A shared pacer whose turn does not come for ten minutes, unless its caller's signal ends the wait. */
function heldPacer(): Pacer & { signals: Array<AbortSignal | undefined> } {
  const signals: Array<AbortSignal | undefined> = [];
  return {
    minIntervalMs: 250,
    signals,
    wait(signal?: AbortSignal): Promise<void> {
      signals.push(signal);
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 600_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const clients = [
  { name: "indexer", url: "https://indexer.example.test/api/v4/graphql", call: (o: ConstructorParameters<typeof IndexerClient>[0]) => new IndexerClient(o).getTipHeight() },
  { name: "node", url: "https://rpc.example.test/", call: (o: ConstructorParameters<typeof NodeRpcClient>[0]) => new NodeRpcClient(o).getFinalizedHead() },
] as const;

describe("the node and indexer clients' stop signal", () => {
  it("[[archive.clients.abort]] a wait for the pacer's turn and a request in flight end at once when the client's signal ends; nothing is fetched after; the client's own pacer stops waiting too", async () => {
    for (const c of clients) {
      // Waiting for the shared pacer's turn: the signal goes to the pacer; the stop ends the wait; no request.
      let fetched = 0;
      const pacer = heldPacer();
      const stop = new AbortController();
      const waiting = c.call({ url: c.url, fetchImpl: (async () => { fetched++; return new Response("{}"); }) as typeof fetch, pacer, signal: stop.signal });
      const outcome = waiting.then(() => "answered", (e: unknown) => (e as Error).message);
      await tick();
      expect(pacer.signals, c.name).toEqual([stop.signal]);
      const t0 = performance.now();
      stop.abort(new Error("stopped"));
      expect(await outcome, c.name).toBe("stopped");
      expect(performance.now() - t0, c.name).toBeLessThan(200);
      expect(fetched, c.name).toBe(0);

      // A request in flight ends at once, long before its 20 s timeout.
      const stop2 = new AbortController();
      let started = 0;
      const inFlight = c.call({
        url: c.url,
        timeoutMs: 20_000,
        signal: stop2.signal,
        fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => {
          started++;
          return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
        }) as typeof fetch,
      }).then(() => "answered", () => "ended");
      await tick();
      expect(started, c.name).toBe(1);
      const t1 = performance.now();
      stop2.abort(new Error("stopped"));
      expect(await inFlight, c.name).toBe("ended");
      expect(performance.now() - t1, c.name).toBeLessThan(200);

      // A call after the stop makes no request.
      let late = 0;
      const after = await c.call({ url: c.url, signal: stop2.signal, fetchImpl: (async () => { late++; return new Response("{}"); }) as typeof fetch }).then(() => "answered", () => "refused");
      expect([after, late], c.name).toEqual(["refused", 0]);
    }

    // The client's own pacer: a wait for a later slot ends when the signal does.
    const own = new RequestPacer(60_000);
    await own.wait();
    const stop = new AbortController();
    const slot = own.wait(stop.signal).then(() => "admitted", (e: unknown) => (e as Error).message);
    await tick();
    const t2 = performance.now();
    stop.abort(new Error("stopped"));
    expect(await slot).toBe("stopped");
    expect(performance.now() - t2).toBeLessThan(200);
    await expect(own.wait(AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
  });

  it("[[archive.pacer.timers]] a pacer wait ended by its signal leaves no timer behind and keeps its slot reserved; a process that stops its waits exits at once", async () => {
    vi.useFakeTimers();
    try {
      const pacer = new RequestPacer(60_000);
      await pacer.wait();
      expect(vi.getTimerCount()).toBe(0);
      const stop = new AbortController();
      const waiting = pacer.wait(stop.signal).then(() => "admitted", (e: unknown) => (e as Error).message);
      expect(vi.getTimerCount()).toBe(1);
      stop.abort(new Error("stopped"));
      expect(await waiting).toBe("stopped");
      expect(vi.getTimerCount()).toBe(0);
      // The cancelled wait's slot stays reserved: the next wait is a slot later still.
      const t0 = Date.now();
      let admittedAt = 0;
      const next = pacer.wait().then(() => { admittedAt = Date.now(); });
      await vi.advanceTimersByTimeAsync(120_000);
      await next;
      expect(admittedAt - t0).toBe(120_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    // A real process: a slot reserved a minute ahead, its wait stopped, and nothing else to do: it exits at once.
    const module = fileURLToPath(new URL("./polite-http.ts", import.meta.url));
    const script = `const { RequestPacer } = await import(${JSON.stringify(module)});
const pacer = new RequestPacer(60_000);
await pacer.wait();
const stop = new AbortController();
const waiting = pacer.wait(stop.signal).catch((e) => e.message);
stop.abort(new Error("stopped"));
console.log(await waiting);`;
    const t1 = performance.now();
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 30_000 }, (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
    });
    expect(out.trim()).toBe("stopped");
    expect(performance.now() - t1).toBeLessThan(15_000);
  }, 60_000);
});
