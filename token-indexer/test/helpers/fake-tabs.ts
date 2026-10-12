/**
 * In-memory stand-ins for the browser's Web Locks manager and BroadcastChannel, whose clients (tabs, workers) can die:
 * a dead client's locks are released and its queued requests and channels vanish with none of its code running, as
 * when a browser tab closes or crashes.
 */
import type { LockInfoLike, LockLike, LockManagerLike, LockRequestOptions } from "../../browser/tab-locks.ts";
import type { ChannelLike } from "../../browser/tabs.ts";

// ── An in-memory Web Locks manager whose clients can die ─────────────────────────────────────────────────────────────

interface Waiter { client: string; grant: () => void; drop: () => void }

export class FakeLocks {
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

export class FakeChannels {
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
