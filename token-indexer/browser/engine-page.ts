/**
 * The engine page: starts the engine worker, shows its boot phase and its status (refreshed every second while the page
 * is visible), and exposes the client as `window.umbradbEngine` for scripted use (the browser tests drive the engine
 * through it). All text is set through `textContent`.
 */
import { type EngineClient, startEngineWorker } from "./client.ts";

declare global {
  interface Window {
    umbradbEngine?: { client: EngineClient; worker: Worker; loadedAt: number };
  }
}

const loadedAt = performance.now();
const { worker, client } = startEngineWorker();
window.umbradbEngine = { client, worker, loadedAt };

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
