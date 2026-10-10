/**
 * The browser engine's capability check, run in the worker before anything else: the engine needs a Chromium browser
 * (Google Chrome, desktop) with the Origin Private File System and its synchronous access handles (PGlite's `opfs-ahp`
 * store; Chrome exposes them in dedicated workers only), Web Locks and BroadcastChannel (one engine across tabs) and
 * persistent storage. `navigator.storage.persist()`, which asks for it, exists only in a window, so the worker checks
 * its counterpart `navigator.storage.persisted()`, part of the same API. When any is missing the worker reports the
 * check and starts nothing: no store is opened and no engine runs.
 *
 * The sync access handle check opens a real one on a probe file in the OPFS root (then closes and removes it), so a
 * browser that declares the API but refuses it (for example a private window that blocks OPFS) is refused too.
 */
import type { CapabilityReport } from "./protocol.ts";

/** The parts of a worker's global scope the check reads (injectable for tests). */
export interface CapabilityEnvironment {
  navigator?: {
    userAgentData?: { brands?: ReadonlyArray<{ brand: string; version: string }> };
    storage?: { getDirectory?: () => Promise<OpfsDirectory>; persisted?: unknown };
    locks?: unknown;
  };
  BroadcastChannel?: unknown;
  FileSystemFileHandle?: { prototype: object };
}

/** The OPFS calls the probe makes. */
interface OpfsDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown>;
  removeEntry(name: string): Promise<void>;
}

type Check = keyof CapabilityReport["checks"];

/** What each check needs, as the user is told. */
const NEEDS: Record<Check, string> = {
  chromium: "Google Chrome (or another Chromium browser)",
  opfs: "the Origin Private File System",
  syncAccessHandle: "OPFS sync access handles in a worker",
  webLocks: "Web Locks",
  broadcastChannel: "BroadcastChannel",
  persistentStorage: "persistent storage (navigator.storage.persisted)",
};

/** The browser's brand and major version, preferring Google Chrome, then Chromium. */
function browserOf(env: CapabilityEnvironment): string | null {
  const brands = env.navigator?.userAgentData?.brands ?? [];
  const pick = brands.find((b) => b.brand === "Google Chrome") ?? brands.find((b) => b.brand === "Chromium") ?? brands.find((b) => !/not.?a.?brand/i.test(b.brand));
  return pick === undefined ? null : `${pick.brand} ${pick.version}`;
}

/** Opens and closes a sync access handle on a probe file in the OPFS root; false when any step fails. */
async function probeSyncAccessHandle(root: OpfsDirectory): Promise<boolean> {
  const name = `.umbradb-probe-${Math.random().toString(36).slice(2, 10)}`;
  let created = false;
  try {
    const fh = (await root.getFileHandle(name, { create: true })) as { createSyncAccessHandle?: () => Promise<{ close(): void }> };
    created = true;
    if (typeof fh.createSyncAccessHandle !== "function") return false;
    const handle = await fh.createSyncAccessHandle();
    handle.close();
    return true;
  } catch {
    return false;
  } finally {
    if (created) await root.removeEntry(name).catch(() => {});
  }
}

/** Runs every check; `supported` only when all pass. */
export async function checkCapabilities(env: CapabilityEnvironment = globalThis as CapabilityEnvironment): Promise<CapabilityReport> {
  const nav = env.navigator;
  const chromium = (nav?.userAgentData?.brands ?? []).some((b) => b.brand === "Chromium");
  let root: OpfsDirectory | undefined;
  try {
    root = typeof nav?.storage?.getDirectory === "function" ? await nav.storage.getDirectory() : undefined;
  } catch {
    root = undefined;
  }
  const declared = env.FileSystemFileHandle !== undefined && "createSyncAccessHandle" in env.FileSystemFileHandle.prototype;
  const checks: CapabilityReport["checks"] = {
    chromium,
    opfs: root !== undefined,
    syncAccessHandle: root !== undefined && declared && (await probeSyncAccessHandle(root)),
    webLocks: typeof nav?.locks === "object" && nav.locks !== null,
    broadcastChannel: typeof env.BroadcastChannel === "function",
    persistentStorage: typeof nav?.storage?.persisted === "function",
  };
  const missing = (Object.keys(checks) as Check[]).filter((k) => !checks[k]);
  const message = missing.length === 0
    ? ""
    : `Chrome only: UmbraDB's browser engine runs in Google Chrome (desktop). This browser lacks ${missing.map((k) => NEEDS[k]).join(", ")}.`;
  return { supported: missing.length === 0, message, missing, checks, browser: browserOf(env) };
}
