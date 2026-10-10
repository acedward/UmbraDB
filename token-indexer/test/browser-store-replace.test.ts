/**
 * Replacing the browser engine's store (an import, `reset`, `range`) when something fails or the worker ends midway, in
 * Node: the worker host (`token-indexer/browser/host.ts`) on PGlite in memory or on the Node file system (a store that
 * outlives a host, as an OPFS store outlives a tab), the recorded U1 range (715402–715433) replayed with no network.
 * A "reload" is a new host on the same store, journal, settings and identity.
 *
 * - `[[browser.host.import-failures]]` — a failure at each step of an import: the trial (refused: nothing changes, the
 *   engine keeps running), saving the journal (the browser refuses the write: nothing changes, the engine keeps
 *   running, and `reset` still works), opening the store again, its migrations, saving its identity, saving the
 *   configuration that continues the import: the import fails, every store it opened is closed, the boot says the
 *   store is the problem (so `reset`, `range` and `import` are offered and work), and the journal stays, so a reload
 *   finishes the import.
 * - `[[browser.host.import-interrupted]]` — a worker that ends at each boundary of an import (the journal saved, the
 *   store's files removed, the rows loaded, the identity saved, the continuing configuration saved) leaves a store that
 *   the next boot opens whole: the snapshot's, with the configuration that continues it saved and the journal gone.
 * - `[[browser.host.import-retry-keeps-journal]]` — an import whose continuing configuration could not be saved keeps its
 *   journal; an import tried again whose journal the browser refuses to write changes nothing and keeps that journal,
 *   so the next boot finishes the first import (its store and the configuration that continues it); an OPFS journal
 *   write that fails leaves a journal on file as it was and leaves no file where there was none.
 * - `[[browser.host.boot-failure-recovery]]` — a boot that fails after the store opened (its migrations) says the store
 *   is the problem and closes it; `reset`, `range` and `import` replace it and the boot completes. A ledger that fails
 *   to load is not the store's problem: nothing offers to drop the store's data for it.
 * - `[[browser.host.store-identity-states]]` — the identity file: a boot that cannot save the identity fails (the store
 *   closed, the problem reported); an identity file that cannot be read is reported and the store is neither opened nor
 *   removed; a store with database files but no identity that fails to open is reported, not removed; a store marked
 *   "creating" that fails to open is created again; a new store is marked "creating" before PGlite creates it; the OPFS
 *   file reads missing as absent and unreadable or invalid content as unreadable.
 * - `[[browser.host.range-interrupted]]` — a worker that ends right after `range` or `reset` saved its settings, or while
 *   its engine stops for it, leaves the replacement to the next boot: the old store is removed, the new one holds
 *   nothing, the saved settings are the new ones with no replacement left to do, and a start runs them on the new store
 *   (a range that starts above the old archive's cursor leaves no gap to refuse).
 * - `[[browser.host.range-saved-first]]` — `range` saves the new range before it replaces the store: when that save
 *   fails nothing changes, and a worker that ends while the store is replaced leaves the new range (with the automatic
 *   start and the mark that the store is to be replaced) saved, so the next boot starts it on the new store.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerHostOptions } from "../browser/host.ts";
import { panelView } from "../browser/panel-model.ts";
import type { BootState, DigestResult, EngineSettings, ExportResult, HostStatus, ImportResult, StartConfig } from "../browser/protocol.ts";
import { type EngineSettingsStore, memorySettingsStore } from "../browser/settings.ts";
import { encodeSnapshotFile, decodeSnapshotFile } from "../browser/snapshot.ts";
import { memorySnapshotFiles, opfsSnapshotFiles, type SnapshotFiles } from "../browser/snapshot-store.ts";
import { yieldingScheduler } from "../browser/scheduler.ts";
import { migrateStore, openStore, type Store } from "../browser/store.ts";
import { memoryStoreIdentity, opfsStoreIdentity, type StoreIdentityFile } from "../browser/store-identity.ts";
import { call, nodeStoreFiles, result, testHost, type TestHost, U1, untilStatus } from "./helpers/worker-host.ts";

const FAST = { sync: { idleMs: 50 }, scan: { idleMs: 100 } };
const U1_TAPE = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST } as const;
const MID = U1.from + 15;
const RECOVERY = /reset it \(its data is dropped and synced again\) or load a snapshot made by this build$/;

const hosts: TestHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const t of hosts.splice(0)) await t.host.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function host(over: Partial<WorkerHostOptions> = {}): TestHost {
  const t = testHost({ settings: memorySettingsStore(), storeIdentity: memoryStoreIdentity(), ...over });
  hosts.push(t);
  return t;
}
/** A host left as a worker that ended (never closed: whatever it was doing never finishes). */
function abandoned(over: Partial<WorkerHostOptions>): TestHost {
  return testHost({ settings: memorySettingsStore(), storeIdentity: memoryStoreIdentity(), ...over });
}
function storeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "umbradb-replace-"));
  dirs.push(d, `${d}.import.snapshot.tar`);
  return d;
}
const openStores = (t: TestHost): Store[] => t.opened.filter((s) => !s.session.closed);

/** An OPFS root holding files only (`getDirectory`), whose writable streams replace a file's content when they close, as
 *  the browser's do; `failWrites` makes every stream's write fail as when the quota is exceeded. */
function fakeOpfsRoot(): { getDirectory: () => Promise<FileSystemDirectoryHandle>; files: Map<string, Uint8Array>; failWrites: boolean } {
  const notFound = (): Error => Object.assign(new Error("not found"), { name: "NotFoundError" });
  const root = {
    files: new Map<string, Uint8Array>(),
    failWrites: false,
    getDirectory: async () => dir as unknown as FileSystemDirectoryHandle,
  };
  const dir = {
    getFileHandle: async (name: string, o?: { create?: boolean }) => {
      if (!root.files.has(name)) {
        if (o?.create !== true) throw notFound();
        root.files.set(name, new Uint8Array());
      }
      return {
        getFile: async () => new Blob([root.files.get(name)! as Uint8Array<ArrayBuffer>]),
        createWritable: async () => {
          let content: Uint8Array | undefined;
          return {
            write: async (data: Uint8Array) => {
              if (root.failWrites) throw Object.assign(new Error("the quota is exceeded"), { name: "QuotaExceededError" });
              content = data.slice();
            },
            abort: async () => {},
            close: async () => { root.files.set(name, content ?? new Uint8Array()); },
          };
        },
      };
    },
    removeEntry: async (name: string) => {
      if (!root.files.delete(name)) throw notFound();
    },
  };
  return root;
}
const untilU1 = (t: TestHost, to: number = U1.to) => untilStatus(t.host, `U1 up to ${to}`, (s) => s.cursors?.sync?.height === to && s.cursors.scan?.nextHeight === to + 1);
const never = new Promise<never>(() => {});

let snapshot: { file: Blob; manifest: ImportResult["manifest"]; digest: DigestResult } | undefined;
/** A snapshot of U1 up to MID. */
async function snapshotAtMid(): Promise<NonNullable<typeof snapshot>> {
  if (snapshot !== undefined) return snapshot;
  const a = host();
  await result(a.host, "start", { config: { ...U1_TAPE, endHeight: MID } });
  await untilU1(a, MID);
  await result(a.host, "stop");
  const exported = await result<ExportResult>(a.host, "export");
  snapshot = { file: exported.file, manifest: exported.manifest, digest: await result<DigestResult>(a.host, "digest") };
  return snapshot;
}
/** The configuration that continues the snapshot, after a worker that ran U1 (its source and tuning kept). */
const CONTINUING: EngineSettings = { config: { ...U1_TAPE }, autoStart: false };

/** A host on U1 up to U1.from + 3 with its engine running (`over` may make a step of an import fail). */
async function running(over: Partial<WorkerHostOptions> = {}): Promise<TestHost> {
  const t = host({ settings: memorySettingsStore({ config: { source: { kind: "tape", range: "u1" } }, autoStart: true }), ...over });
  await result(t.host, "start", { config: { ...U1_TAPE, endHeight: U1.from + 3 } });
  await untilU1(t, U1.from + 3);
  return t;
}

describe("replacing the browser engine's store", () => {
  it("[[browser.host.import-failures]] a failure at each step of an import closes every store it opened; before the journal nothing changes; after it the store is reported, reset/range/import work, and a reload finishes the import", async () => {
    const snap = await snapshotAtMid();
    const { manifest, data } = decodeSnapshotFile(new Uint8Array(await snap.file.arrayBuffer()));

    // The trial: rows that do not load are refused; nothing changes and the engine keeps running.
    {
      const t = await running();
      const before = await result<DigestResult>(t.host, "digest");
      const broken = encodeSnapshotFile({ ...manifest, archive: { ...manifest.archive, height: MID - 1 } }, data);
      const r = await call(t.host, "import", { snapshot: new Blob([broken as Uint8Array<ArrayBuffer>]) });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("snapshot-refused");
      const s = await result<HostStatus>(t.host, "status");
      expect(s.engine?.running).toBe(true);
      expect(await result<DigestResult>(t.host, "digest")).toEqual({ ...before, elapsedMs: expect.any(Number) });
      expect(openStores(t), "only the store in use is open (the trial's is closed)").toEqual([t.opened[0]]);
    }

    // The journal cannot be saved (the browser refuses the write): nothing changes, the engine keeps running, and the
    // store stays in use (the API answers; reset works).
    {
      const files = memorySnapshotFiles();
      const quota = Object.assign(new Error("the quota is exceeded"), { name: "QuotaExceededError" });
      const t = await running({ snapshotFiles: { ...files, writeJournal: async () => { throw quota; } } });
      const before = await result<DigestResult>(t.host, "digest");
      const r = await call(t.host, "import", { snapshot: snap.file });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toEqual({ code: "snapshot-failed", message: "the import's journal could not be saved (the quota is exceeded): nothing was changed" });
      const s = await result<HostStatus>(t.host, "status");
      expect(s.boot).toMatchObject({ phase: "ready", storeProblem: null });
      expect(s.engine?.running).toBe(true);
      expect(await files.readJournal()).toBeUndefined();
      expect(await result<DigestResult>(t.host, "digest")).toEqual({ ...before, elapsedMs: expect.any(Number) });
      expect((await result<{ status: number }>(t.host, "api", { method: "GET", target: "/v1/status" })).status).toBe(200);
      expect(openStores(t)).toEqual([t.opened[0]]);
      await result(t.host, "stop");
      expect((await result<HostStatus>(t.host, "reset")).boot).toMatchObject({ phase: "ready", storeProblem: null });
      expect(openStores(t)).toHaveLength(1);
    }

    // After the journal: each later step made to fail once. The import fails, every store it opened is closed, the
    // store is reported (reset, range and import offered), and a reload on the same journal finishes the import.
    const steps: Array<{ name: string; problem: BootState["storeProblem"]; message: RegExp; inject: (fail: () => boolean, opened: Store[]) => Partial<WorkerHostOptions> }> = [
      {
        name: "opening the store again",
        problem: "unopenable",
        message: /^the store could not be opened \(the store's files are still held\): /,
        inject: (fail, opened) => ({
          openStore: async (dir, o) => {
            if (o?.prepare !== undefined && fail()) throw new Error("the store's files are still held");
            const s = await openStore(dir, o);
            opened.push(s);
            return s;
          },
        }),
      },
      {
        name: "its migrations",
        problem: "unusable",
        message: /^the store could not be used \(a migration failed\): /,
        inject: (fail) => ({ migrate: async (s) => { if (fail()) throw new Error("a migration failed"); await migrateStore(s); } }),
      },
      {
        name: "saving its identity",
        problem: "unusable",
        message: /^the store could not be used \(its identity could not be saved: the quota is exceeded\): /,
        inject: (fail) => {
          const identity = memoryStoreIdentity();
          return { storeIdentity: { ...identity, save: async (i) => { if (fail()) throw new Error("the quota is exceeded"); await identity.save(i); } } };
        },
      },
      {
        name: "saving the continuing configuration",
        problem: "unusable",
        message: /^the store could not be used \(the configuration that continues the imported snapshot could not be saved: the quota is exceeded\): /,
        inject: (fail) => {
          const settings = memorySettingsStore({ config: { source: { kind: "tape", range: "u1" } }, autoStart: true });
          return { settings: { ...settings, save: async (x) => { if (fail()) throw new Error("the quota is exceeded"); await settings.save(x); } } };
        },
      },
    ];
    for (const step of steps) {
      let armed = false;
      let failures = 0;
      const fail = (): boolean => {
        if (!armed) return false;
        armed = false;
        failures++;
        return true;
      };
      const files = memorySnapshotFiles();
      const settings = memorySettingsStore({ config: { source: { kind: "tape", range: "u1" } }, autoStart: true });
      const stepOpened: Store[] = [];
      const injected = step.inject(fail, stepOpened);
      const t = await running({ snapshotFiles: files, settings, ...injected });
      const stores = (): Store[] => [...openStores(t), ...stepOpened.filter((x) => !x.session.closed)];
      armed = true;
      const r = await call(t.host, "import", { snapshot: snap.file });
      expect(failures, step.name).toBe(1);
      expect(r.ok, step.name).toBe(false);
      if (!r.ok) {
        expect(r.error.code, step.name).toBe("snapshot-failed");
        expect(r.error.message, step.name).toMatch(/^the snapshot was checked, but the store could not be used after it/);
      }
      const s = await result<HostStatus>(t.host, "status");
      expect(s.boot, step.name).toMatchObject({ phase: "failed", storeProblem: step.problem });
      expect(s.boot.error, step.name).toMatch(step.message);
      expect(s.boot.error, step.name).toMatch(RECOVERY);
      expect(panelView({ role: "leader", connectedTabs: 1, status: s, statusError: null, api: null, pageStorage: null }).recoverable, step.name).toBe(true);
      expect(stores(), `${step.name}: every store the import opened is closed`).toEqual([]);
      expect(await files.readJournal(), `${step.name}: the journal stays`).toBeDefined();

      // A reload on the same journal, settings and identity finishes the import.
      const reload = host({ snapshotFiles: files, settings, ...injected });
      const reloadOpened = stepOpened.length;
      const b = await reload.host.boot();
      expect(b, step.name).toMatchObject({ phase: "ready", storeProblem: null });
      const after = await result<HostStatus>(reload.host, "status");
      expect(after.cursors?.sync, step.name).toEqual({ height: MID, startHeight: U1.from });
      expect(after.settings, step.name).toEqual(CONTINUING);
      expect(await files.readJournal(), `${step.name}: the journal is removed once the import is finished`).toBeUndefined();
      expect(await result<DigestResult>(reload.host, "digest"), step.name).toEqual({ ...snap.digest, elapsedMs: expect.any(Number) });

      // In the failed worker, reset, range and import each replace the store.
      const reloadStores = stepOpened.slice(reloadOpened);
      expect((await result<ImportResult>(t.host, "import", { snapshot: snap.file })).status.boot, step.name).toMatchObject({ phase: "ready", storeProblem: null });
      expect(stores().filter((x) => !reloadStores.includes(x) && !reload.opened.includes(x)), step.name).toHaveLength(1);
    }
  }, 300_000);

  it("[[browser.host.import-interrupted]] a worker that ends at each boundary of an import leaves a store the next boot opens whole: the snapshot's, its configuration saved, the journal gone", async () => {
    const snap = await snapshotAtMid();
    const boundaries = ["journal saved", "store files removed", "rows loaded", "identity saved", "configuration saved"] as const;
    for (const boundary of boundaries) {
      const dir = storeDir();
      const files = nodeStoreFiles(dir);
      const identity = memoryStoreIdentity();
      const settings = memorySettingsStore({ config: { source: { kind: "tape", range: "u1" } }, autoStart: true });
      let reached = false;
      const stop = async (at: (typeof boundaries)[number]): Promise<void> => {
        if (boundary !== at || !armed) return;
        reached = true;
        await never;
      };
      let armed = false;
      const hooked: Partial<WorkerHostOptions> = {
        dataDir: dir,
        snapshotFiles: {
          ...files,
          writeJournal: async (f) => { await files.writeJournal(f); await stop("journal saved"); },
          removeStore: async () => { await files.removeStore(); await stop("store files removed"); },
          removeJournal: async () => { await stop("configuration saved"); await files.removeJournal(); },
        },
        migrate: async (s) => { await migrateStore(s); await stop("rows loaded"); },
        storeIdentity: { ...identity, save: async (i) => { await identity.save(i); await stop("identity saved"); } },
        settings,
      };
      // The worker before: U1 up to U1.from + 3, engine running.
      const w = abandoned(hooked);
      await result(w.host, "start", { config: { ...U1_TAPE, endHeight: U1.from + 3 } });
      await untilU1(w, U1.from + 3);
      await result(w.host, "stop");
      armed = true;
      void call(w.host, "import", { snapshot: snap.file });
      const end = Date.now() + 60_000;
      while (!reached) {
        if (Date.now() > end) throw new Error(`${boundary}: the import never reached it`);
        await new Promise((r) => setTimeout(r, 10));
      }
      armed = false;
      // The worker ends there; the next one boots on the same store, journal, settings and identity.
      const next = host({ dataDir: dir, snapshotFiles: files, storeIdentity: identity, settings });
      expect(await next.host.boot(), boundary).toMatchObject({ phase: "ready", storeProblem: null });
      const s = await result<HostStatus>(next.host, "status");
      expect(s.cursors?.sync, boundary).toEqual({ height: MID, startHeight: U1.from });
      expect(await result<DigestResult>(next.host, "digest"), boundary).toEqual({ ...snap.digest, elapsedMs: expect.any(Number) });
      expect(await settings.load(), `${boundary}: the configuration that continues the import`).toEqual(CONTINUING);
      expect(await identity.load(), boundary).toMatchObject({ format: 1 });
      expect(existsSync(`${dir}.import.snapshot.tar`), `${boundary}: the journal is gone`).toBe(false);
      await next.host.close();
      hosts.splice(hosts.indexOf(next), 1);
    }
  }, 300_000);

  it("[[browser.host.import-retry-keeps-journal]] an import whose continuing configuration could not be saved keeps its journal; an import tried again whose journal cannot be saved changes nothing and keeps that journal, so the next boot finishes the first import; an OPFS journal write that fails leaves the file as it was", async () => {
    const snap = await snapshotAtMid();
    const dir = storeDir();
    const files = nodeStoreFiles(dir);
    const identity = memoryStoreIdentity();
    const saved = memorySettingsStore({ config: { source: { kind: "tape", range: "u1" } }, autoStart: true });
    const quota = (): Error => Object.assign(new Error("the quota is exceeded"), { name: "QuotaExceededError" });
    let settingsFail = false;
    let journalFail = false;
    const t = host({
      dataDir: dir,
      storeIdentity: identity,
      settings: { ...saved, save: async (x) => { if (settingsFail) throw quota(); await saved.save(x); } },
      snapshotFiles: { ...files, writeJournal: async (f) => { if (journalFail) throw quota(); await files.writeJournal(f); } },
    });
    await result(t.host, "start", { config: { ...U1_TAPE, endHeight: U1.from + 3 } });
    await untilU1(t, U1.from + 3);

    // The first import loads the rows, but the configuration that continues it cannot be saved: its journal stays.
    settingsFail = true;
    const first = await call(t.host, "import", { snapshot: snap.file });
    expect(first.ok).toBe(false);
    settingsFail = false;
    const journal = await files.readJournal();
    expect(journal, "the first import's journal").toBeDefined();
    expect((await result<HostStatus>(t.host, "status")).boot).toMatchObject({ phase: "failed", storeProblem: "unusable" });

    // Tried again while the journal cannot be written: refused, nothing changed, the first import's journal kept.
    journalFail = true;
    const retry = await call(t.host, "import", { snapshot: snap.file });
    expect(retry).toMatchObject({ ok: false, error: { code: "snapshot-failed", message: "the import's journal could not be saved (the quota is exceeded): nothing was changed" } });
    expect(await files.readJournal(), "the first import's journal, kept").toEqual(journal);
    journalFail = false;
    await t.host.close();
    hosts.splice(hosts.indexOf(t), 1);

    // The next boot finishes the first import: the snapshot's store with the configuration that continues it.
    const next = host({ dataDir: dir, snapshotFiles: files, storeIdentity: identity, settings: saved });
    expect(await next.host.boot()).toMatchObject({ phase: "ready", storeProblem: null });
    const s = await result<HostStatus>(next.host, "status");
    expect(s.cursors?.sync).toEqual({ height: MID, startHeight: U1.from });
    expect(s.settings).toEqual(CONTINUING);
    expect(await saved.load()).toEqual(CONTINUING);
    expect(await files.readJournal()).toBeUndefined();
    expect(await result<DigestResult>(next.host, "digest")).toEqual({ ...snap.digest, elapsedMs: expect.any(Number) });

    // The OPFS journal: a write that fails leaves a journal on file as it was, and leaves no file where there was none.
    const opfs = fakeOpfsRoot();
    const journalFile = "umbradb-stagenet.import.snapshot.tar";
    const opfsFiles = opfsSnapshotFiles("opfs-ahp://umbradb-stagenet", opfs);
    await opfsFiles.writeJournal(new Uint8Array([1, 2, 3]));
    opfs.failWrites = true;
    await expect(opfsFiles.writeJournal(new Uint8Array([4, 5, 6, 7]))).rejects.toThrow("the quota is exceeded");
    expect(await opfsFiles.readJournal()).toEqual(new Uint8Array([1, 2, 3]));
    opfs.failWrites = false;
    await opfsFiles.removeJournal();
    expect(opfs.files.has(journalFile)).toBe(false);
    opfs.failWrites = true;
    await expect(opfsFiles.writeJournal(new Uint8Array([4, 5, 6, 7]))).rejects.toThrow("the quota is exceeded");
    expect(opfs.files.has(journalFile), "no journal file left by the failed write").toBe(false);
    expect(await opfsFiles.readJournal()).toBeUndefined();
  }, 300_000);

  it("[[browser.host.boot-failure-recovery]] a boot that fails after the store opened reports the store and closes it; reset, range and import replace it; a ledger that fails to load offers nothing", async () => {
    const snap = await snapshotAtMid();
    for (const request of ["reset", "range", "import"] as const) {
      let failing = true;
      const t = host({ migrate: async (s) => { if (failing) throw new Error("the newest migration fails on this store's data"); await migrateStore(s); } });
      const b = await t.host.boot();
      expect(b, request).toMatchObject({ phase: "failed", storeProblem: "unusable" });
      expect(b.error, request).toBe("the store could not be used (the newest migration fails on this store's data): reset it (its data is dropped and synced again) or load a snapshot made by this build");
      expect(openStores(t), request).toEqual([]);
      for (const type of ["start", "export", "digest"]) expect((await call(t.host, type)).ok, `${request}: ${type}`).toBe(false);
      failing = false;
      const params = request === "range" ? { startHeight: U1.from, endHeight: U1.from + 3 } : request === "import" ? { snapshot: snap.file } : {};
      const r = await call(t.host, request, params);
      expect(r.ok, request).toBe(true);
      const s = await result<HostStatus>(t.host, "status");
      expect(s.boot, request).toMatchObject({ phase: "ready", storeProblem: null });
      expect(openStores(t), request).toHaveLength(1);
    }
    // A ledger build that fails to load: the boot fails, but the store is not the problem.
    const l = host({ loadLedger: async () => { throw new Error("the ledger's WASM did not load"); } });
    expect(await l.host.boot()).toMatchObject({ phase: "failed", storeProblem: null, error: "the ledger's WASM did not load" });
    expect((await call(l.host, "reset")).ok).toBe(false);
  }, 300_000);

  it("[[browser.host.store-identity-states]] a boot that cannot save the identity fails; an unreadable identity is reported and its store neither opened nor removed; a store with files but no identity is reported; one marked creating is created again; a new store is marked creating first; the OPFS file's states", async () => {
    const events: string[] = [];
    const recording = (base: StoreIdentityFile, over: Partial<StoreIdentityFile> = {}): StoreIdentityFile => ({
      ...base,
      markCreating: async () => { events.push("mark creating"); await base.markCreating(); },
      save: async (i) => { events.push("save identity"); await base.save(i); },
      ...over,
    });
    const counted = (files: SnapshotFiles) => {
      const c = { removals: 0, opens: 0 };
      return { c, files: { ...files, removeStore: async () => { c.removals++; events.push("remove store"); await files.removeStore(); } } };
    };

    // A new store: marked "creating" before PGlite creates it, the identity saved once the boot completed.
    {
      const identity = memoryStoreIdentity();
      const t = host({ storeIdentity: recording(identity), openStore: async (d, o) => openStore(d, { ...o, prepare: async (x) => { await o?.prepare?.(x); events.push("PGlite opens"); } }) });
      expect(await t.host.boot()).toMatchObject({ phase: "ready" });
      expect(events).toEqual(["mark creating", "PGlite opens", "save identity"]);
      expect(await identity.read()).toMatchObject({ kind: "identity" });
      events.length = 0;
    }

    // The identity cannot be saved: the boot fails, the store is closed, and nothing was started.
    {
      let failing = true;
      const identity = memoryStoreIdentity();
      const t = host({ storeIdentity: { ...identity, save: async (i) => { if (failing) throw new Error("the quota is exceeded"); await identity.save(i); } } });
      expect(await t.host.boot()).toMatchObject({ phase: "failed", storeProblem: "unusable", error: "the store could not be used (its identity could not be saved: the quota is exceeded): reset it (its data is dropped and synced again) or load a snapshot made by this build" });
      expect(openStores(t)).toEqual([]);
      failing = false;
      expect((await result<HostStatus>(t.host, "reset")).boot).toMatchObject({ phase: "ready" });
    }

    // An identity file that cannot be read: reported; the store is neither opened by PGlite nor removed.
    {
      const { c, files } = counted(memorySnapshotFiles());
      const t = host({
        snapshotFiles: files,
        storeIdentity: { ...memoryStoreIdentity(), read: async () => ({ kind: "unreadable", error: "the file is not JSON" }) },
        openStore: async (d, o) => openStore(d, { ...o, prepare: async (x) => { await o?.prepare?.(x); c.opens++; } }),
      });
      const b = await t.host.boot();
      expect(b).toMatchObject({ phase: "failed", storeProblem: "unopenable" });
      expect(b.error).toBe("the store's identity file cannot be read (the file is not JSON), so which PGlite version wrote the store is unknown and it is not opened: reset it (its data is dropped and synced again) or load a snapshot made by this build");
      expect(c).toEqual({ removals: 0, opens: 0 });
    }

    // Database files but no identity, and PGlite fails to open them: reported, not removed.
    {
      const { c, files } = counted({ ...memorySnapshotFiles(), storeExists: async () => true });
      const t = host({ snapshotFiles: files, storeIdentity: memoryStoreIdentity(), openStore: async (d, o) => { await o?.prepare?.(d); throw new Error("PGlite cannot open these files"); } });
      expect(await t.host.boot()).toMatchObject({ phase: "failed", storeProblem: "unopenable", error: "the store could not be opened (PGlite cannot open these files): reset it (its data is dropped and synced again) or load a snapshot made by this build" });
      expect(c.removals).toBe(0);
    }

    // Marked "creating" (its first boot never completed), and PGlite fails to open it: created again, with a warning.
    {
      const { c, files } = counted({ ...memorySnapshotFiles(), storeExists: async () => true });
      let opens = 0;
      const t = host({ snapshotFiles: files, storeIdentity: memoryStoreIdentity("creating"), openStore: async (d, o) => { if (++opens === 1) { await o?.prepare?.(d); throw new Error("No more file handles available in the pool"); } return openStore(d, o); } });
      expect(await t.host.boot()).toMatchObject({ phase: "ready", storeProblem: null });
      expect(c.removals).toBe(1);
      expect(t.logs).toContain("warn the store's first boot did not complete and it cannot be opened (No more file handles available in the pool): it is created again");
    }

    // The OPFS file: missing → absent; not JSON, not an identity, or unreadable → unreadable; "creating"; an identity.
    const fake = (content: string | Error | undefined) => ({
      getDirectory: async () => ({
        getFileHandle: async () => {
          if (content === undefined) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
          return { getFile: async () => ({ text: async () => { if (content instanceof Error) throw content; return content; } }) };
        },
      }) as unknown as FileSystemDirectoryHandle,
    });
    const read = (content: string | Error | undefined) => opfsStoreIdentity("opfs-ahp://umbradb-stagenet", fake(content)).read();
    expect(await read(undefined)).toEqual({ kind: "absent" });
    expect(await read("{")).toEqual({ kind: "unreadable", error: "the file is not JSON" });
    expect(await read(JSON.stringify({ format: 1, pglite: 5 }))).toEqual({ kind: "unreadable", error: "the file is not a store identity" });
    expect(await read(Object.assign(new Error("could not read"), { name: "NotReadableError" }))).toEqual({ kind: "unreadable", error: "could not read" });
    expect(await read(JSON.stringify({ format: 1, creating: true }))).toEqual({ kind: "creating" });
    expect(await read(JSON.stringify({ format: 1, pglite: "0.5.8", postgres: "18.3" }))).toEqual({ kind: "identity", identity: { format: 1, pglite: "0.5.8", postgres: "18.3" } });
  }, 300_000);

  it("[[browser.host.range-saved-first]] range saves the new range before it replaces the store: a failed save changes nothing, and a worker that ends during the replacement leaves the new range saved for the next boot", async () => {
    // The save fails: refused, nothing changed.
    {
      const settings = memorySettingsStore();
      let failing = false;
      const t = await running({ settings: { ...settings, save: async (x) => { if (failing) throw new Error("the quota is exceeded"); await settings.save(x); } } });
      await result(t.host, "stop");
      const before = await result<DigestResult>(t.host, "digest");
      const saved = await settings.load();
      failing = true;
      const r = await call(t.host, "range", { startHeight: U1.from + 10, endHeight: U1.from + 12 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toEqual({ code: "start-failed", message: "the new range could not be saved (the quota is exceeded): nothing was changed" });
      expect(await result<DigestResult>(t.host, "digest")).toEqual({ ...before, elapsedMs: expect.any(Number) });
      expect(await settings.load()).toEqual(saved);
      expect(openStores(t)).toEqual([t.opened[0]]);
    }

    // The worker ends while the store is replaced (here: once its files are removed): the new range is saved, with the
    // automatic start, and the next boot's start runs it on the new store.
    const dir = storeDir();
    const files = nodeStoreFiles(dir);
    const identity = memoryStoreIdentity();
    const settings: EngineSettingsStore = memorySettingsStore();
    let armed = false;
    let reached = false;
    const w = abandoned({
      dataDir: dir,
      settings,
      storeIdentity: identity,
      snapshotFiles: { ...files, removeStore: async () => { await files.removeStore(); if (armed) { reached = true; await never; } } },
    });
    await result(w.host, "start", { config: { ...U1_TAPE, endHeight: U1.from + 3 } });
    await untilU1(w, U1.from + 3);
    armed = true;
    const range = { ...U1_TAPE, startHeight: U1.from + 10, endHeight: U1.from + 12 };
    void call(w.host, "range", { startHeight: range.startHeight, endHeight: range.endHeight });
    const end = Date.now() + 60_000;
    while (!reached) {
      if (Date.now() > end) throw new Error("the range never replaced the store");
      await new Promise((r) => setTimeout(r, 10));
    }
    // Saved with the mark that the store is to be replaced by a new one, which the next boot does first.
    expect(await settings.load()).toEqual({ config: range, autoStart: true, newStore: true });
    const next = host({ dataDir: dir, snapshotFiles: files, storeIdentity: identity, settings });
    expect(await next.host.boot()).toMatchObject({ phase: "ready", storeProblem: null });
    // The leader tab's automatic start: a start with no configuration runs the saved one.
    const started = await result<HostStatus>(next.host, "start");
    expect(started.engine?.config).toEqual(range);
    const done = await untilStatus(next.host, "the new range", (s) => s.cursors?.sync?.height === U1.from + 12);
    expect(done.cursors?.sync).toEqual({ height: U1.from + 12, startHeight: U1.from + 10 });
  }, 300_000);
  it("[[browser.host.range-interrupted]] a worker that ends right after range or reset saved its settings, or while its engine stops for it, leaves the replacement to the next boot: the old store is removed, the new one holds nothing, the settings are the new ones with no replacement left to do, and a start runs them", async () => {
    // A finalized tip that rises one block every 100 ms (from U1.from + 3 for each new host): the engine is running when
    // the replacement is asked for, and the next host's range is reached.
    const config: StartConfig = { source: { kind: "tape", range: "u1", finalizedHeight: U1.from + 3, advance: { everyMs: 100, by: 1 } }, startHeight: U1.from, ...FAST };
    const cases = [
      { what: "range, right after its settings are saved", request: "range", at: "saved" },
      { what: "range, while its engine stops", request: "range", at: "stopping" },
      { what: "reset, right after its settings are saved", request: "reset", at: "saved" },
    ] as const;
    for (const c of cases) {
      const dir = storeDir();
      const files = nodeStoreFiles(dir);
      const identity = memoryStoreIdentity();
      const saved = memorySettingsStore();
      let armed: "saved" | "stopping" | undefined;
      let reached = false;
      const w = abandoned({
        dataDir: dir,
        snapshotFiles: files,
        storeIdentity: identity,
        settings: { ...saved, save: async (x) => { await saved.save(x); if (armed === "saved") { reached = true; await never; } } },
        // While armed for "stopping", the engine's next step never runs, so its stop never ends.
        schedule: async (kind, step) => {
          if (armed === "stopping") { reached = true; await never; }
          return yieldingScheduler(kind, step);
        },
      });
      await result(w.host, "start", { config });
      await untilStatus(w.host, `${c.what}: the archive's first blocks`, (s) => (s.cursors?.sync?.height ?? 0) >= U1.from + 3 && (s.cursors?.scan?.nextHeight ?? 0) > U1.from + 3);
      const expected: StartConfig = c.request === "range" ? { ...config, startHeight: U1.from + 10, endHeight: U1.from + 12 } : config;
      armed = c.at;
      void call(w.host, c.request, c.request === "range" ? { startHeight: U1.from + 10, endHeight: U1.from + 12 } : {});
      const end = Date.now() + 60_000;
      while (!reached || (await saved.load())?.config.startHeight !== expected.startHeight || (c.request === "reset" && (await saved.load())?.autoStart !== true)) {
        if (Date.now() > end) throw new Error(`${c.what}: the request never got there`);
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 50));

      // The page is closed there; the next one boots on the same store, settings and identity.
      const next = host({ dataDir: dir, snapshotFiles: files, storeIdentity: identity, settings: saved });
      expect(await next.host.boot(), c.what).toMatchObject({ phase: "ready", storeProblem: null });
      const booted = await result<HostStatus>(next.host, "status");
      expect(booted.cursors, `${c.what}: the new store holds nothing`).toEqual({ sync: null, scan: null });
      expect(booted.settings, c.what).toEqual({ config: expected, autoStart: true });
      expect(await saved.load(), `${c.what}: no replacement left to do`).toEqual({ config: expected, autoStart: true });
      // The leader tab's automatic start: a start with no configuration runs the saved one.
      expect((await result<HostStatus>(next.host, "start")).engine?.config, c.what).toEqual(expected);
      const to = c.request === "range" ? U1.from + 12 : U1.from + 5;
      const done = await untilStatus(next.host, `${c.what}: the new store's archive`, (s) => (s.cursors?.sync?.height ?? 0) >= to);
      expect(done.cursors?.sync?.startHeight, c.what).toBe(expected.startHeight);
      expect(done.engine?.error, c.what).toBeNull();
      await next.host.close();
      hosts.splice(hosts.indexOf(next), 1);
    }
  }, 300_000);
});
