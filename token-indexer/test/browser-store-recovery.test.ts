/**
 * A store the browser engine cannot use, in Node (the worker host on PGlite in memory, the recorded U1 range replayed
 * with no network): the store's identity (`token-indexer/browser/store-identity.ts`) and the boot's `store` phase
 * (`host.ts`). The same on OPFS in Chrome is `browser-crash-chrome.test.ts`.
 *
 * - `[[browser.host.store-version]]` — a store whose identity names another PGlite version is refused before PGlite
 *   opens it: the boot ends `failed` with `storeProblem: "version"` and a message that names both versions and says
 *   "reset … or load a snapshot made by this build"; nothing reads the store (`status` has no store and no cursors, `api`,
 *   `digest`, `start` and `export` answer `boot-failed`). `reset` then replaces the store and runs the rest of the boot:
 *   `ready`, the saved configuration started, the identity rewritten with the running versions. A store with no
 *   identity on file opens and gets one; one with the running version opens unchanged.
 * - `[[browser.host.store-version-import]]` — a refused store is replaced by a snapshot made by this build: the import
 *   loads it, the boot ends `ready` with the snapshot's data (equal digests and cursors), the engine stopped with the
 *   continuing configuration saved, and the identity rewritten; a snapshot of another PGlite version is refused and the
 *   store stays refused.
 * - `[[browser.host.store-recovery]]` — a store that completed a boot before (its identity is on file) and now fails to
 *   open ends the boot `failed` with `storeProblem: "unopenable"`, the error and the same two choices; `range` replaces
 *   it and starts the range. A new store (no identity, no database files) is marked "creating" before PGlite creates
 *   it; if its open fails (its creation never completed) it is removed and created again by the boot itself, with a
 *   warning; a store held by another worker is never removed (`storeProblem` stays `null`).
 * - `[[browser.panel.store-problem]]` — the engine panel's view: a boot that failed because of the store (refused,
 *   unopenable or unusable) keeps `reset`,
 *   `range` and `import` usable (`recoverable`) and shows the boot's message; any other failed or unsupported boot does
 *   not. Its storage line says when the browser refused to keep the site's storage (or asking failed), and that the
 *   engine runs anyway.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerHost, WorkerHostOptions } from "../browser/host.ts";
import type { BootState, DigestResult, ExportResult, HostStatus, ImportResult } from "../browser/protocol.ts";
import { panelView, persistenceText } from "../browser/panel-model.ts";
import { memorySettingsStore } from "../browser/settings.ts";
import { decodeSnapshotFile, encodeSnapshotFile } from "../browser/snapshot.ts";
import { memorySnapshotFiles } from "../browser/snapshot-store.ts";
import { openStore, StoreBusyError } from "../browser/store.ts";
import { memoryStoreIdentity, type StoreIdentity } from "../browser/store-identity.ts";
import { call, result, testHost, untilStatus, U1 } from "./helpers/worker-host.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PGLITE = (JSON.parse(readFileSync(`${ROOT}node_modules/@electric-sql/pglite/package.json`, "utf8")) as { version: string }).version;
const BUILD = { appCommit: null, pgliteVersion: PGLITE, ledgerVersion: null };
const OLD: StoreIdentity = { format: 1, pglite: "0.4.6", postgres: "17.5" };
const U1_CONFIG = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, sync: { idleMs: 50 }, scan: { idleMs: 100 } } as const;
const RECOVERY = /reset it \(its data is dropped and synced again\) or load a snapshot made by this build/;

const hosts: WorkerHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});

/** A host whose opens of the store by PGlite (after the files were prepared under the lock: a refusal there is no
 *  open) and removals of the store's files are counted (an open can be made to fail), with the given identity on file.
 *  The trial store of an import (`memory://` opened apart) is not counted. */
function host(over: Partial<WorkerHostOptions> & { failOpens?: number | ((n: number) => Error | undefined) } = {}) {
  const opens: Array<{ removed: number }> = [];
  let removals = 0;
  let attempts = 0;
  const files = memorySnapshotFiles();
  const { failOpens, ...rest } = over;
  const logs: string[] = [];
  const t = testHost({
    build: BUILD,
    settings: memorySettingsStore({ config: U1_CONFIG, autoStart: true }),
    snapshotFiles: { ...files, removeStore: async () => { removals++; await files.removeStore(); } },
    log: (level, message) => logs.push(`${level} ${message}`),
    snapshotTrial: () => openStore("memory://"),
    openStore: async (dir, o) => {
      const n = ++attempts;
      const fail = typeof failOpens === "function" ? failOpens(n) : failOpens !== undefined && n <= failOpens ? new Error(`open ${n} failed`) : undefined;
      const before = removals;
      // As `openStore` does: the files are prepared under the lock, then PGlite opens the store (or fails).
      const prepare = async (d: string): Promise<void> => {
        await o?.prepare?.(d);
        opens.push({ removed: removals - before });
      };
      if (fail === undefined) return openStore(dir, { ...o, prepare });
      await prepare(dir);
      throw fail;
    },
    ...rest,
  });
  hosts.push(t.host);
  return { ...t, opens, logs };
}

const boot = async (h: WorkerHost): Promise<BootState> => h.boot();
const code = async (h: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<string> => {
  const r = await call(h, type, params);
  return r.ok ? "ok" : r.error.code;
};

describe("a store the browser engine cannot use", () => {
  it("[[browser.host.store-version]] a store written by another PGlite version is refused unopened with reset or a snapshot as the choices; reset replaces it, starts the saved configuration and rewrites the identity; a store with no identity or the running version opens", async () => {
    const identity = memoryStoreIdentity(OLD);
    const t = host({ storeIdentity: identity });
    const b = await boot(t.host);
    expect(b).toMatchObject({ phase: "failed", storeProblem: "version" });
    expect(b.error).toContain(`written by PGlite ${OLD.pglite} (PostgreSQL ${OLD.postgres})`);
    expect(b.error).toContain(`this build runs PGlite ${PGLITE}`);
    expect(b.error).toMatch(RECOVERY);
    expect(t.opens, "PGlite never opened the refused store").toEqual([]);
    const s = await result<HostStatus>(t.host, "status");
    expect(s).toMatchObject({ store: null, cursors: null, engine: null });
    for (const type of ["start", "digest", "export"]) expect(await code(t.host, type), type).toBe("boot-failed");
    expect(await code(t.host, "api", { method: "GET", target: "/v1/status" })).toBe("boot-failed");
    expect(await identity.load(), "the identity stays until the store is replaced").toEqual(OLD);

    // reset: the store's files and identity are removed under the lock, the boot runs again, the saved range starts.
    const after = await result<HostStatus>(t.host, "reset");
    expect(t.opens, "one open, which removed the store's files first").toEqual([{ removed: 1 }]);
    expect(after.boot).toMatchObject({ phase: "ready", error: null, storeProblem: null });
    expect(after.store).toMatchObject({ created: true });
    expect(after.engine).toMatchObject({ running: true, config: U1_CONFIG });
    await untilStatus(t.host, "the U1 range", (x) => x.cursors?.sync?.height === U1.to && x.cursors?.scan?.nextHeight === U1.to + 1);
    expect(await identity.load()).toEqual({ format: 1, pglite: PGLITE, postgres: after.store!.serverVersion });
    expect(t.logs.some((l) => l.startsWith("warn the store is removed and created again"))).toBe(true);

    // No identity on file: opened, and the identity written. The running version on file: opened, left as it is.
    const none = memoryStoreIdentity();
    const fresh = host({ storeIdentity: none });
    expect(await boot(fresh.host)).toMatchObject({ phase: "ready", storeProblem: null });
    expect(await none.load()).toEqual({ format: 1, pglite: PGLITE, postgres: expect.stringMatching(/^\d+\.\d+/) });
    const same = memoryStoreIdentity({ format: 1, pglite: PGLITE, postgres: "18.3" });
    let saves = 0;
    const counting = { ...same, save: async (i: StoreIdentity) => { saves++; await same.save(i); } };
    const kept = host({ storeIdentity: counting });
    expect(await boot(kept.host)).toMatchObject({ phase: "ready" });
    expect(saves, "an identity that already names the running versions is not written again").toBe(0);

    // Without the running version (a host built without it) nothing is refused.
    const unknown = host({ storeIdentity: memoryStoreIdentity(OLD), build: null });
    expect(await boot(unknown.host)).toMatchObject({ phase: "ready" });
  }, 120_000);

  it("[[browser.host.store-version-import]] a refused store is replaced by a snapshot made by this build: its data, cursors and digests, the engine stopped with the continuing configuration, the identity rewritten; a snapshot of another PGlite version is refused and the store stays refused", async () => {
    // A snapshot of U1 from a store of this build.
    const source = host();
    expect(await boot(source.host)).toMatchObject({ phase: "ready" });
    await result(source.host, "start", { config: { ...U1_CONFIG, endHeight: U1.from + 20 } });
    const at = await untilStatus(source.host, "the snapshot's height", (x) => x.cursors?.sync?.height === U1.from + 20 && x.cursors?.scan?.nextHeight === U1.from + 21);
    const exported = await result<ExportResult>(source.host, "export");
    const sourceDigest = await result<DigestResult>(source.host, "digest");

    const identity = memoryStoreIdentity(OLD);
    const t = host({ storeIdentity: identity, settings: memorySettingsStore({ config: { source: { kind: "tape", range: "u1" } }, autoStart: true }) });
    expect(await boot(t.host)).toMatchObject({ phase: "failed", storeProblem: "version" });

    // Another PGlite version's snapshot: refused before anything changes.
    const { manifest, data } = decodeSnapshotFile(new Uint8Array(await exported.file.arrayBuffer()));
    const forged = encodeSnapshotFile({ ...manifest, pglite: { ...manifest.pglite, version: "0.6.0" } }, data);
    const refused = await call(t.host, "import", { snapshot: new Blob([forged as Uint8Array<ArrayBuffer>]) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatchObject({ code: "snapshot-refused", message: expect.stringMatching(/^pglite: /) });
    expect((await result<HostStatus>(t.host, "status")).boot).toMatchObject({ phase: "failed", storeProblem: "version" });
    expect(t.opens).toEqual([]);

    const imported = await result<ImportResult>(t.host, "import", { snapshot: exported.file });
    expect(imported.manifest.archive.height).toBe(U1.from + 20);
    expect(imported.status.boot).toMatchObject({ phase: "ready", storeProblem: null });
    expect(imported.status.cursors).toEqual(at.cursors);
    expect(imported.status.engine).toBeNull();
    expect(imported.status.settings).toEqual({ config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from }, autoStart: false });
    expect(imported.status.snapshots.lastImport).toMatchObject({ bytes: exported.bytes, manifest: { height: U1.from + 20 } });
    const d = await result<DigestResult>(t.host, "digest");
    expect(d.archive.sha256).toBe(sourceDigest.archive.sha256);
    expect(d.tables.sha256).toBe(sourceDigest.tables.sha256);
    expect(await identity.load()).toMatchObject({ pglite: PGLITE });
    // The store continues the snapshot's archive.
    await result(t.host, "start");
    await untilStatus(t.host, "the rest of U1", (x) => x.cursors?.sync?.height === U1.to && x.cursors?.scan?.nextHeight === U1.to + 1);
  }, 120_000);

  it("[[browser.host.store-recovery]] a store that completed a boot and fails to open is reported with the same choices and replaced by range; a store whose creation never completed is created again by the boot; a store held by another worker is never removed", async () => {
    // Identity on file (a boot completed before), then PGlite fails to open it.
    const t = host({ storeIdentity: memoryStoreIdentity({ format: 1, pglite: PGLITE, postgres: "18.3" }), failOpens: 1 });
    const b = await boot(t.host);
    expect(b).toMatchObject({ phase: "failed", storeProblem: "unopenable" });
    expect(b.error).toContain("the store could not be opened (open 1 failed)");
    expect(b.error).toMatch(RECOVERY);
    expect(t.opens).toEqual([{ removed: 0 }]);
    expect(await code(t.host, "range", { startHeight: U1.from, endHeight: U1.from - 1 }), "a bad range changes nothing").toBe("bad-request");
    expect((await result<HostStatus>(t.host, "status")).boot.storeProblem).toBe("unopenable");
    const ranged = await result<HostStatus>(t.host, "range", { startHeight: U1.from + 10, endHeight: U1.from + 12 });
    expect(t.opens).toEqual([{ removed: 0 }, { removed: 1 }]);
    expect(ranged.boot).toMatchObject({ phase: "ready", storeProblem: null });
    expect(ranged.engine?.config).toMatchObject({ startHeight: U1.from + 10, endHeight: U1.from + 12 });
    await untilStatus(t.host, "the new range", (x) => x.cursors?.sync?.height === U1.from + 12);

    // No identity: the creation never completed; the boot removes the files and creates the store again.
    const c = host({ storeIdentity: memoryStoreIdentity(), failOpens: 1 });
    expect(await boot(c.host)).toMatchObject({ phase: "ready", storeProblem: null });
    expect(c.opens).toEqual([{ removed: 0 }, { removed: 1 }]);
    expect(c.logs.some((l) => /^warn the store's first boot did not complete and it cannot be opened \(open 1 failed\): it is created again$/.test(l))).toBe(true);

    // Held by another worker: not a broken store; nothing is removed.
    const busy = host({ storeIdentity: memoryStoreIdentity(), failOpens: (n) => (n === 1 ? new StoreBusyError("the store is open in another engine worker") : undefined) });
    expect(await boot(busy.host)).toMatchObject({ phase: "failed", storeProblem: null, error: "the store is open in another engine worker" });
    expect(busy.opens).toEqual([{ removed: 0 }]);
    expect(await code(busy.host, "reset"), "reset does not remove a store another worker holds").toBe("boot-failed");
    expect(busy.opens).toHaveLength(1);
  }, 120_000);

  it("[[browser.panel.store-problem]] the panel keeps reset, range and import usable after a boot that failed because of the store, and says when the browser refused to keep the site's storage", () => {
    const timings = { capabilitiesMs: null, storeMs: null, ledgerMs: null, migrateMs: null, totalMs: null };
    const status = (boot: Partial<BootState>): HostStatus => ({
      protocol: 1, network: "stagenet", store: null, engine: null, cursors: null, settings: null, storage: null,
      snapshots: { lastExport: null, lastImport: null },
      boot: { phase: "failed", error: "the store could not be opened (x): reset it (its data is dropped and synced again) or load a snapshot made by this build", capabilities: null, storeProblem: null, timings, ...boot },
    });
    const view = (boot: Partial<BootState>) => panelView({ role: "leader", connectedTabs: 1, status: status(boot), statusError: null, api: null, pageStorage: null });
    for (const problem of ["version", "unopenable", "unusable"] as const) {
      const v = view({ storeProblem: problem });
      expect(v).toMatchObject({ state: "failed", recoverable: true, ready: false });
      expect(v.stateDetail).toMatch(RECOVERY);
    }
    expect(view({ storeProblem: null, error: "the ledger build renamed its class" })).toMatchObject({ state: "failed", recoverable: false });
    expect(view({ phase: "unsupported", error: "Chrome only" })).toMatchObject({ state: "unsupported", recoverable: false });
    expect(view({ phase: "ready", error: null })).toMatchObject({ ready: true, recoverable: false });

    expect(persistenceText(false, { requested: true, persisted: false, error: null })).toBe("persistent: no (the browser refused to keep this site's storage, so it may clear the store when space runs low; the engine runs anyway)");
    expect(persistenceText(false, { requested: true, persisted: false, error: "denied" })).toBe("persistent: no (asking the browser to keep this site's storage failed: denied; the engine runs anyway)");
    expect(persistenceText(true, { requested: true, persisted: true, error: null })).toBe("persistent: yes");
    expect(persistenceText(false, null)).toBe("persistent: no");
    expect(persistenceText(null, undefined)).toBe("persistent: unknown");
    const page = panelView({ role: "leader", connectedTabs: 1, status: null, statusError: null, api: null, pageStorage: { usageBytes: 1_000_000, quotaBytes: 2_000_000, persisted: false }, persistence: { requested: true, persisted: false, error: null } });
    expect(page.storage).toBe("browser reports 1.0 MB used of 2.0 MB \u00b7 persistent: no (the browser refused to keep this site's storage, so it may clear the store when space runs low; the engine runs anyway)");
  });
});
