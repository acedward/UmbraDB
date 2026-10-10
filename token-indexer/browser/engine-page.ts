/**
 * The engine page: starts the engine worker, asks the browser to keep the site's storage, shows the boot phase and the
 * status (refreshed every second while the page is visible), and exposes the client as `window.umbradbEngine` for
 * scripted use (the browser tests drive the engine through it). All text is set through `textContent`.
 */
import { type EngineClient, type PersistenceResult, startEngineWorker } from "./client.ts";

declare global {
  interface Window {
    umbradbEngine?: { client: EngineClient; worker: Worker; loadedAt: number; persistence: Promise<PersistenceResult> };
  }
}

const loadedAt = performance.now();
const { worker, client, persistence } = startEngineWorker();
window.umbradbEngine = { client, worker, loadedAt, persistence };

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
    statusEl.textContent = JSON.stringify({ boot: s.boot, store: s.store, cursors: s.cursors, engine: s.engine?.status ?? null, settings: s.settings, storage: s.storage, persistence: await persistence }, null, 2);
  } catch (e) {
    messageEl.hidden = false;
    messageEl.textContent = e instanceof Error ? e.message : String(e);
  }
}

void refresh();
setInterval(() => void refresh(), 1_000);
