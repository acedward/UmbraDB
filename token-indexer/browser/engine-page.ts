/**
 * The engine page: starts the engine worker (under the page's watchdog), shows its boot phase and its status (refreshed
 * every second while the page is visible), and exposes the client as `window.umbradbEngine` for scripted use (the
 * browser tests drive the engine through it; `worker` is the current worker, `restarts()` the watchdog's restarts).
 * `?watchdogLimitMs=<ms>` sets the watchdog's limit (default 30 s, `supervisor.ts`). All text is set through
 * `textContent`.
 */
import { type EngineClient, startEngineWorker } from "./client.ts";
import type { RestartRecord } from "./supervisor.ts";

declare global {
  interface Window {
    umbradbEngine?: { client: EngineClient; readonly worker: Worker; restarts(): RestartRecord[]; loadedAt: number };
  }
}

const loadedAt = performance.now();
const limit = Number(new URLSearchParams(location.search).get("watchdogLimitMs"));
const engine = startEngineWorker(Number.isSafeInteger(limit) && limit >= 100 ? { limitMs: limit } : {});
const client = engine.client;
window.umbradbEngine = { client, get worker() { return engine.worker; }, restarts: () => engine.restarts(), loadedAt };

const phaseEl = document.getElementById("phase")!;
const messageEl = document.getElementById("message")!;
const statusEl = document.getElementById("status")!;

client.onNotice((n) => {
  if (n.notice !== "boot") return;
  phaseEl.textContent = n.boot.phase;
  if (n.boot.error !== null) {
    messageEl.hidden = false;
    messageEl.textContent = n.boot.error;
  }
});

async function refresh(): Promise<void> {
  if (document.visibilityState !== "visible") return;
  try {
    const s = await client.status();
    phaseEl.textContent = s.boot.phase;
    statusEl.textContent = JSON.stringify({ boot: s.boot, store: s.store, cursors: s.cursors, engine: s.engine?.status ?? null }, null, 2);
  } catch (e) {
    messageEl.hidden = false;
    messageEl.textContent = e instanceof Error ? e.message : String(e);
  }
}

void refresh();
setInterval(() => void refresh(), 1_000);
