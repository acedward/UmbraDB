/**
 * The engine page: joins the other tabs of this store (`tabs.ts`: the leader tab runs the engine worker under the page's
 * watchdog, the others proxy to it; the leader starts or resumes the engine), asks the browser to keep the site's
 * storage (`requestPersistentStorage`, from every tab: the grant is per site), shows this tab's role, its boot phase and
 * the engine's status (refreshed every second while the page is visible), and exposes the client as
 * `window.umbradbEngine` for scripted use (the browser tests drive the engine through it; `restarts()` lists the
 * watchdog's restarts of this tab's worker). `?watchdogLimitMs=<ms>` sets the watchdog's limit (default 30 s,
 * `supervisor.ts`). All text is set through `textContent`.
 */
import { type EngineClient, type PersistenceResult, requestPersistentStorage, startEngineWorker } from "./client.ts";
import type { RestartRecord, SupervisedEngine } from "./supervisor.ts";
import { connectEngineTabs, type EngineTabs, localEngineOf } from "./tabs.ts";

declare global {
  interface Window {
    umbradbEngine?: {
      client: EngineClient;
      tabs: EngineTabs;
      readonly worker: Worker | undefined;
      restarts(): RestartRecord[];
      loadedAt: number;
      persistence: Promise<PersistenceResult>;
    };
  }
}

const loadedAt = performance.now();
const persistence = requestPersistentStorage();
const limit = Number(new URLSearchParams(location.search).get("watchdogLimitMs"));
let supervised: SupervisedEngine<Worker> | undefined;
const tabs = connectEngineTabs({
  startWorker: () => {
    supervised = startEngineWorker(Number.isSafeInteger(limit) && limit >= 100 ? { limitMs: limit } : {});
    return localEngineOf(supervised);
  },
});
const client = tabs.client;
window.umbradbEngine = {
  client,
  tabs,
  /** This tab's engine worker while it leads. */
  get worker() {
    return tabs.worker();
  },
  restarts: () => supervised?.restarts() ?? [],
  loadedAt,
  persistence,
};

const roleEl = document.getElementById("role")!;
const tabsEl = document.getElementById("tabs")!;
const phaseEl = document.getElementById("phase")!;
const messageEl = document.getElementById("message")!;
const statusEl = document.getElementById("status")!;

tabs.onRoleChange((role) => {
  roleEl.textContent = role;
});

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
    tabsEl.textContent = String(await tabs.connectedTabs());
    const s = await client.status();
    phaseEl.textContent = s.boot.phase;
    statusEl.textContent = JSON.stringify({ boot: s.boot, store: s.store, cursors: s.cursors, engine: s.engine?.status ?? null, settings: s.settings, storage: s.storage, persistence: await persistence }, null, 2);
  } catch (e) {
    messageEl.hidden = false;
    messageEl.textContent = e instanceof Error ? e.message : String(e);
  }
}

// Leave at once when the page goes away (a follower takes over sooner); a page restored from the back/forward cache
// joins again from scratch.
addEventListener("pagehide", () => tabs.close());
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

void refresh();
setInterval(() => void refresh(), 1_000);
