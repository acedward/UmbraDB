/**
 * The worker's engine scheduler. PGlite answers inside the worker without I/O, and a replayed tape answers `fetch` the
 * same way, so the engine's loops would never give the worker's event loop a turn: incoming messages (API requests,
 * `stop`) and timers would wait until the loops are idle. Before each sync batch and each scan step the scheduler
 * yields one task through a `MessageChannel` (unlike `setTimeout(0)`, it is not clamped to 4 ms when repeated).
 */
import type { EngineScheduler } from "../engine/engine.ts";

/** Resolves in a new task of the event loop. */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel !== "function") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Yields to the event loop, then runs the step. */
export const yieldingScheduler: EngineScheduler = async (_kind, step) => {
  await yieldToEventLoop();
  return step();
};
