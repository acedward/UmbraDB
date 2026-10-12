/**
 * The page's side of the system snapshot (`../engine/system-snapshot.ts`), for a status page:
 *
 * - {@link followSystem} watches the engine's snapshots while the page is visible: it sends `system { watch: true }`
 *   when the page is (or becomes) visible, `system { watch: false }` when it is hidden and when it goes away
 *   (`pagehide`), and hands each `system` notice to the caller. The worker collects nothing while no viewer watches.
 *   Each call watches as a viewer of its own (unless named), so pages and tabs never unwatch each other; when an engine
 *   worker has booted (the leader tab changed, or the watchdog replaced the worker) the watch is sent again.
 * - {@link refreshSystem} collects one snapshot now (with the database statistics, and exact row counts on demand).
 * - {@link diagnosticsFile} is "Download diagnostics": the snapshot as JSON (`diagnosticsJson`, its log lines included,
 *   redacted and validated again) with a file name.
 */
import { diagnosticsJson, type SystemSnapshot } from "../engine/system-snapshot.ts";
import type { EngineClient } from "./client.ts";

export { diagnosticsJson };

/** The parts of `document` and `window` that {@link followSystem} uses. */
export interface PageLike {
  document: { readonly visibilityState: string; addEventListener(type: "visibilitychange", l: () => void): void; removeEventListener(type: "visibilitychange", l: () => void): void };
  addEventListener(type: "pagehide", l: () => void): void;
  removeEventListener(type: "pagehide", l: () => void): void;
}

export interface FollowSystemOptions {
  onSnapshot: (snapshot: SystemSnapshot) => void;
  /** A watch or unwatch request failed. */
  onError?: (error: unknown) => void;
  /** The viewer's name (default: a new one per call). */
  viewer?: string;
  /** Default: the global `window`. */
  page?: PageLike;
}

/** Follows the engine's snapshots while the page is visible; returns the function that stops (and unwatches). */
export function followSystem(client: EngineClient, opts: FollowSystemOptions): () => void {
  const page = opts.page ?? (globalThis as unknown as PageLike);
  const viewer = opts.viewer ?? `page-${Math.random().toString(36).slice(2, 12)}`;
  let watching: boolean | undefined;
  let stopped = false;
  const send = (watch: boolean): void => {
    if (watching === watch) return;
    watching = watch;
    client.system({ watch, viewer }).catch((e: unknown) => opts.onError?.(e));
  };
  const sync = (): void => {
    if (!stopped) send(page.document.visibilityState === "visible");
  };
  const hide = (): void => send(false);
  const off = client.onNotice((n) => {
    if (n.notice === "system" && watching === true) opts.onSnapshot(n.snapshot);
    // A worker that has just booted knows no viewer yet.
    if (n.notice === "boot" && n.boot.phase === "ready" && watching === true) client.system({ watch: true, viewer }).catch((e: unknown) => opts.onError?.(e));
  });
  page.document.addEventListener("visibilitychange", sync);
  page.addEventListener("pagehide", hide);
  sync();
  return () => {
    stopped = true;
    off();
    page.document.removeEventListener("visibilitychange", sync);
    page.removeEventListener("pagehide", hide);
    send(false);
  };
}

/** One snapshot collected now: the database statistics are read again, exact row counts only with `exactCounts`. */
export async function refreshSystem(client: EngineClient, opts: { exactCounts?: boolean } = {}): Promise<SystemSnapshot> {
  const r = await client.system({ refresh: { database: true, ...(opts.exactCounts === true ? { exactCounts: true } : {}) } });
  return r.snapshot!;
}

/** "Download diagnostics": the file name and the JSON text of a snapshot. */
export function diagnosticsFile(snapshot: SystemSnapshot): { name: string; type: string; text: string } {
  const at = new Date(snapshot.generatedAt).toISOString().replace(/[:.]/g, "-");
  return { name: `umbradb-diagnostics-${at}.json`, type: "application/json", text: diagnosticsJson(snapshot) };
}
