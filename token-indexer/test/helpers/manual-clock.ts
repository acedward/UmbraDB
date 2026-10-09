/**
 * A clock for the engine whose time moves only when the test moves it: every `sleep` waits until `next()`, `advance()`
 * or the background driver (`drive()`) reaches its end, or until its signal aborts. Every requested duration is kept
 * in `sleeps`, in request order.
 */
import type { EngineClock } from "../../engine/engine.ts";

interface Pending { at: number; ms: number; end: () => void }

export class ManualClock implements EngineClock {
  private t: number;
  private pending: Pending[] = [];
  private onSleep: Array<() => void> = [];
  /** Every requested sleep, in milliseconds, in request order (aborted ones included). */
  readonly sleeps: number[] = [];

  constructor(start = 1_760_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const p: Pending = { at: this.t + ms, ms, end: () => finish() };
      const finish = (): void => {
        this.pending = this.pending.filter((x) => x !== p);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      signal.addEventListener("abort", finish, { once: true });
      this.pending.push(p);
      const waiters = this.onSleep;
      this.onSleep = [];
      for (const w of waiters) w();
    });
  }

  /** The durations of the sleeps waiting now, in request order. */
  get waiting(): number[] {
    return this.pending.map((p) => p.ms);
  }

  /** Resolves once at least `n` sleeps are waiting. */
  async untilWaiting(n = 1): Promise<void> {
    while (this.pending.length < n) await new Promise<void>((r) => this.onSleep.push(r));
  }

  /** Moves time by `ms` and ends every sleep due by then. */
  advance(ms: number): void {
    this.t += ms;
    for (const p of [...this.pending].filter((x) => x.at <= this.t)) p.end();
  }

  /** Moves time to the end of the earliest waiting sleep and ends it (and any other due then); returns the step. */
  next(): number {
    if (this.pending.length === 0) return 0;
    const step = Math.max(0, Math.min(...this.pending.map((p) => p.at)) - this.t);
    this.advance(step);
    return step;
  }

  /** Ends every sleep as soon as it is requested (time jumps to its end); returns the function that stops driving. */
  drive(): () => void {
    let on = true;
    void (async () => {
      while (on) {
        await this.untilWaiting();
        await new Promise((r) => setTimeout(r, 0)); // let the other loop's work interleave
        if (on) this.next();
      }
    })();
    return () => {
      on = false;
    };
  }
}
