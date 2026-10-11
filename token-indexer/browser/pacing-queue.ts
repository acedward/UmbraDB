/**
 * A first-in, first-out queue that lets its callers start one at a time, at least `minIntervalMs` apart (the spacing
 * the archive sync keeps on a public endpoint, `chain-archive-sync/polite-http.ts`), optionally with a bound on how many
 * may wait. The browser engine keeps one per endpoint origin (`host.ts`), shared by every client of that endpoint: the
 * archive sync's clients wait in it (`Pacer.wait`), and the JSON RPC module (`jsonrpc-module.ts`) admits each indexer
 * request through it before the request's timeout starts, so waiting for a turn never uses up a request's time.
 *
 * - {@link PacingQueue.admit} resolves when the caller may start. A caller that finds `maxWaiting` callers waiting is
 *   refused at once ({@link QueueFullError}).
 * - A wait can be cancelled with an `AbortSignal`: the caller leaves the queue (it is refused with the signal's reason)
 *   and the callers after it move up.
 * - {@link PacingQueue.holdFor} lets no caller start for a while (an endpoint's `Retry-After`).
 * - {@link PacingQueue.close} refuses every waiting and later caller with its reason.
 *
 * Runtime-neutral; the clock can be replaced (tests).
 */
import type { Pacer } from "../../chain-archive-sync/polite-http.js";

/** The clock the queue reads and the timer it sets. Default: `performance.now`, `setTimeout`, `clearTimeout`. */
export interface PacingClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface PacingQueueOptions {
  /** The least time between two starts (0: no spacing). */
  minIntervalMs: number;
  /** The most callers that may wait. Default: no bound. */
  maxWaiting?: number;
  clock?: PacingClock;
}

/** A caller refused because the queue already holds as many waiting callers as it may. */
export class QueueFullError extends Error {
  constructor(maxWaiting: number) {
    super(`${maxWaiting} requests are already waiting for their turn`);
    this.name = "QueueFullError";
  }
}

interface Waiter {
  resolve(): void;
  reject(reason: unknown): void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

const systemClock: PacingClock = {
  now: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PacingQueue implements Pacer {
  readonly #interval: number;
  readonly #maxWaiting: number;
  readonly #clock: PacingClock;
  #lastStart = Number.NEGATIVE_INFINITY;
  /** No caller starts before this time (a hold). */
  #notBefore = Number.NEGATIVE_INFINITY;
  #waiting: Waiter[] = [];
  #timer: unknown;
  #timerSet = false;
  #closed: Error | undefined;

  constructor(opts: PacingQueueOptions) {
    if (!Number.isFinite(opts.minIntervalMs) || opts.minIntervalMs < 0) throw new RangeError(`minIntervalMs must be a non-negative number, got ${opts.minIntervalMs}`);
    const maxWaiting = opts.maxWaiting ?? Number.POSITIVE_INFINITY;
    if (!(maxWaiting === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxWaiting) && maxWaiting >= 0))) throw new RangeError(`maxWaiting must be a non-negative integer, got ${maxWaiting}`);
    this.#interval = opts.minIntervalMs;
    this.#maxWaiting = maxWaiting;
    this.#clock = opts.clock ?? systemClock;
  }

  /** Callers waiting now. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** The least time between two starts. */
  get minIntervalMs(): number {
    return this.#interval;
  }

  /** {@link PacingQueue.admit} with no cancellation (the archive sync's clients). */
  wait(): Promise<void> {
    return this.admit();
  }

  /** Lets no caller start until `ms` from now (a later hold wins; an earlier one changes nothing). */
  holdFor(ms: number): void {
    if (!(ms > 0) || this.#closed !== undefined) return;
    const until = this.#clock.now() + ms;
    if (until <= this.#notBefore) return;
    this.#notBefore = until;
    // A timer set for an earlier start is set again for the hold.
    this.#clearTimer();
    this.#pump();
  }

  /** Resolves when the caller may start; see the module documentation for the refusals. */
  admit(signal?: AbortSignal): Promise<void> {
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    if (this.#waiting.length > 0 && this.#waiting.length >= this.#maxWaiting) return Promise.reject(new QueueFullError(this.#maxWaiting));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: undefined };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const at = this.#waiting.indexOf(waiter);
          if (at < 0) return;
          this.#waiting.splice(at, 1);
          reject(signal.reason);
          this.#pump();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiting.push(waiter);
      this.#pump();
    });
  }

  /** Refuses every waiting caller and every later one with `reason`. */
  close(reason: Error): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    this.#clearTimer();
    for (const w of this.#waiting.splice(0)) {
      this.#detach(w);
      w.reject(reason);
    }
  }

  #detach(w: Waiter): void {
    if (w.onAbort !== undefined) w.signal?.removeEventListener("abort", w.onAbort);
  }

  #clearTimer(): void {
    if (!this.#timerSet) return;
    this.#clock.clearTimer(this.#timer);
    this.#timerSet = false;
  }

  /** Lets the first waiting caller start when its slot has come, or sets the timer for that slot. */
  #pump(): void {
    if (this.#timerSet) return;
    while (this.#waiting.length > 0) {
      const delay = Math.max(this.#lastStart + this.#interval, this.#notBefore) - this.#clock.now();
      if (delay > 0) {
        this.#timerSet = true;
        this.#timer = this.#clock.setTimer(() => {
          this.#timerSet = false;
          this.#pump();
        }, delay);
        return;
      }
      const w = this.#waiting.shift()!;
      this.#detach(w);
      this.#lastStart = this.#clock.now();
      w.resolve();
    }
  }
}
