/**
 * What the page's watchdog (`token-indexer/browser/supervisor.ts`) starts on the worker it puts in place of a stuck one,
 * and what the next leader tab (`tabs.ts`) starts after a handover: the store's saved configuration, when its saved
 * settings say to start by itself, whatever request started the engine and whatever the old worker or tab was in the
 * middle of. The worker hosts run in this thread behind channels the test can silence, on PGlite in one directory, with
 * the saved settings, the store's identity and the snapshot journal outliving each worker (as the files beside an OPFS
 * store do); the supervisor's clock is driven by the test, and the tabs share in-memory Web Locks and channels.
 *
 * - `[[browser.watchdog.restore-default-start]]` — an engine started with no configuration (the leader tab's automatic
 *   start, the engine panel's start) runs again on the new worker, with the configuration it ran.
 * - `[[browser.watchdog.restore-after-range]]` — after a `range`, the new worker runs the range, not the configuration
 *   before it, and the saved configuration stays the range.
 * - `[[browser.watchdog.restore-after-import]]` — after an `import`, which stops the engine, the new worker starts
 *   nothing and the automatic start stays off.
 * - `[[browser.watchdog.restore-during-replacement]]` — a worker that stops answering while a `range` replaces its store
 *   (after its engine's stop was reported), or while the range's own start runs on the new store (the engine stopped
 *   before the range): the new worker's boot finishes the replacement the saved settings ask for, and the restore starts
 *   the new range from the saved settings.
 * - `[[browser.tabs.handover-mid-replacement]]` — two tabs on one store, the leader's worker under the watchdog: the next
 *   leader tab starts what the store's saved settings say once its worker has booted, never what the closed leader last
 *   reported running: after an import the leader's watchdog finished (its worker had stopped answering once the journal
 *   was saved), nothing; the leader closed in the middle of an import, nothing (its boot finishes the import); in the
 *   middle of a `range`, the new range on a new store; in the middle of a `reset`, the saved configuration on a new
 *   store.
 * - `[[browser.watchdog.restore-module-off]]` — the token indexer switched off stays off on the new worker: the restart
 *   sends the engine's configuration, which carries no module, and the new worker's engine takes the switch from the
 *   saved settings, so its archive goes on while the scan stays where it stopped; switched on again, the scan catches
 *   up.
 * - `[[browser.watchdog.restore-interrupted-import]]` — a worker that stops answering once an import's journal is saved,
 *   with its engine still running (its stop never reported): the new worker's boot finishes the import, and the new
 *   worker starts nothing on the snapshot's store; the configuration that continues the snapshot stays saved, with no
 *   automatic start.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EngineError } from "../browser/client.ts";
import { createWorkerHost, type WorkerHost } from "../browser/host.ts";
import type { Notice, StartConfig } from "../browser/protocol.ts";
import { memorySettingsStore } from "../browser/settings.ts";
import type { SnapshotFiles } from "../browser/snapshot-store.ts";
import { openStore } from "../browser/store.ts";
import { memoryStoreIdentity } from "../browser/store-identity.ts";
import { DEFAULT_LONG_LIMIT_MS, superviseWorker, type SupervisedEngine, type WorkerLike } from "../browser/supervisor.ts";
import { connectEngineTabs, type EngineTabs, resumeOrAutoStart } from "../browser/tabs.ts";
import { loadTape } from "../browser/tapes.ts";
import { FakeChannels, FakeLocks } from "./helpers/fake-tabs.ts";
import { fileFetch, SUPPORTED, U1, until } from "./helpers/worker-host.ts";

const FAST = { sync: { idleMs: 100 }, scan: { idleMs: 100 } };
const U1_TAPE = { source: { kind: "tape" as const, range: "u1" as const } };
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A host in this thread behind a channel the test can silence (both ways), standing in for a worker. */
interface ChannelWorker extends WorkerLike {
  silent: boolean;
  readonly terminated: boolean;
  received: Array<{ type?: string; config?: StartConfig }>;
}

/** Each new host waits until the previous one has closed (as the store's lock makes a browser worker wait). */
let previousGone: Promise<unknown> = Promise.resolve();
/** Hosts held where they hold no store open, for good: terminated, they end there (as a browser worker does). */
const frozen = new Set<WorkerHost>();

function channelWorker(make: () => WorkerHost): ChannelWorker {
  const before = previousGone;
  const host = make();
  const channel = new MessageChannel();
  const w: ChannelWorker = {
    silent: false,
    terminated: false,
    received: [],
    postMessage: (m) => channel.port1.postMessage(m),
    addEventListener: (_t, l) => channel.port1.addEventListener("message", l as (e: MessageEvent) => void),
    removeEventListener: (_t, l) => channel.port1.removeEventListener("message", l as (e: MessageEvent) => void),
    terminate() {
      if (w.terminated) return;
      (w as { terminated: boolean }).terminated = true;
      channel.port1.close();
      channel.port2.close();
      previousGone = frozen.has(host) ? Promise.resolve() : host.close();
    },
  };
  const live = (): boolean => !w.silent && !w.terminated;
  channel.port2.onmessage = (e: MessageEvent) => {
    if (!live()) return;
    w.received.push(e.data as { type?: string });
    void before.then(() => host.receive(e.data)).then((r) => { if (live()) channel.port2.postMessage(r); });
  };
  host.onNotice((n) => { if (live()) channel.port2.postMessage(n); });
  channel.port1.start();
  void before.then(() => host.boot());
  previousGone = new Promise(() => {}); // until terminated
  return w;
}

/**
 * A point a worker can be held at: once armed, the next host to pass it waits there. A hold that `freezes` never lets
 * it go (the point holds no store open, so the host is left there, and a terminated worker ends there as a browser
 * worker does); any other hold waits for {@link letGo}, which fails the step (the host then closes the store it has
 * open, and its close can finish).
 */
class Hold {
  armed = false;
  reached = false;
  private fail: ((e: Error) => void) | undefined;
  constructor(private readonly freezes: boolean) {}
  async pass(host: WorkerHost): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    this.reached = true;
    if (this.freezes) {
      frozen.add(host);
      await new Promise<never>(() => {});
    }
    await new Promise<void>((_resolve, reject) => { this.fail = reject; });
  }
  letGo(): void {
    this.fail?.(new Error("the worker was terminated"));
  }
}

/** A store whose settings, identity and snapshot journal outlive each worker (as the files beside an OPFS store do),
 *  with points a worker can be held at: removing the store's files (frozen there: PGlite is closed at that point) and
 *  loading a recorded range (let go with an error). */
interface SharedStore {
  storeDir: string;
  journal: string;
  settings: ReturnType<typeof memorySettingsStore>;
  host: () => WorkerHost;
  holds: { removeStore: Hold; loadTape: Hold };
}

function sharedStore(defaultStart: StartConfig): SharedStore {
  const dir = mkdtempSync(join(tmpdir(), "umbradb-watchdog-restore-"));
  dirs.push(dir);
  const storeDir = join(dir, "store");
  const journal = join(dir, "journal.tar");
  const settings = memorySettingsStore();
  const storeIdentity = memoryStoreIdentity();
  const holds = { removeStore: new Hold(true), loadTape: new Hold(false) };
  const host = (): WorkerHost => {
    const snapshotFiles: SnapshotFiles = {
      readJournal: async () => (existsSync(journal) ? new Uint8Array(readFileSync(journal)) : undefined),
      writeJournal: async (file) => writeFileSync(journal, file),
      removeJournal: async () => rmSync(journal, { force: true }),
      storeExists: async () => existsSync(join(storeDir, "PG_VERSION")),
      removeStore: async () => {
        await holds.removeStore.pass(h);
        rmSync(storeDir, { recursive: true, force: true });
      },
    };
    const h: WorkerHost = createWorkerHost({
      network: "stagenet",
      dataDir: storeDir,
      nodeUrl: "https://node.invalid/",
      indexerUrl: "https://indexer.invalid/",
      checkCapabilities: async () => SUPPORTED,
      openStore,
      settings,
      snapshotFiles,
      storeIdentity,
      defaultStart,
      loadTape: async (range) => {
        await holds.loadTape.pass(h);
        return loadTape(range, fileFetch());
      },
      log: () => {},
    });
    return h;
  };
  return { storeDir, journal, settings, host, holds };
}

interface Rig {
  engine: SupervisedEngine<ChannelWorker>;
  workers: ChannelWorker[];
  settings: ReturnType<typeof memorySettingsStore>;
  /** The import journal's file (beside the store). */
  journal: string;
  holds: SharedStore["holds"];
  /** Silences the current worker until the supervisor has replaced it (past even the long requests' limit), then waits
   *  for the new worker's boot. */
  restart(): Promise<ChannelWorker>;
  close(): Promise<void>;
}

/** A page's watchdog over workers on `store`, its clock driven by the test. */
function supervised(store: SharedStore): Rig {
  let now = 0;
  let check: () => void = () => {};
  const workers: ChannelWorker[] = [];
  const engine = superviseWorker<ChannelWorker>({
    createWorker: () => {
      const w = channelWorker(store.host);
      workers.push(w);
      return w;
    },
    limitMs: 1_000,
    heartbeatMs: 20,
    graceMs: 100,
    now: () => now,
    setInterval: (fn) => { check = fn; return 1; },
    clearInterval: () => {},
    sleep: () => Promise.resolve(),
  });
  return {
    engine,
    workers,
    settings: store.settings,
    journal: store.journal,
    holds: store.holds,
    async restart() {
      const count = workers.length;
      workers[count - 1]!.silent = true;
      // Past the limit while a long request (range, reset, import) is in flight too.
      now += DEFAULT_LONG_LIMIT_MS + 1;
      check();
      now += 101;
      check();
      expect(workers).toHaveLength(count + 1);
      const next = workers[count]!;
      await until(async () => (await engine.client.status().catch(() => undefined))?.boot.phase === "ready", "the new worker's boot", 30_000);
      return next;
    },
    async close() {
      engine.close();
      await previousGone;
    },
  };
}

/** Workers on one store directory whose settings, store identity and snapshot journal outlive each worker. */
function rig(defaultStart: StartConfig): Rig {
  return supervised(sharedStore(defaultStart));
}

describe("page watchdog: what a restart starts", () => {
  it("[[browser.watchdog.restore-default-start]] an engine started with no configuration (the automatic start, the panel's start) runs again on the new worker with the configuration it ran", async () => {
    const ran: StartConfig = { ...U1_TAPE, startHeight: U1.from, endHeight: U1.from + 9, ...FAST };
    const r = rig(ran);
    try {
      const c = r.engine.client;
      expect((await c.booted()).phase).toBe("ready");
      await c.start();
      expect((await c.status()).engine).toMatchObject({ running: true, config: ran });
      const next = await r.restart();
      await until(() => next.received.some((m) => m.type === "start"), "the engine started on the new worker", 30_000);
      expect(next.received.find((m) => m.type === "start")).toMatchObject({ config: ran });
      await until(async () => (await c.status()).engine?.status.sync.phase === "done", "the restored engine's range");
      const s = await c.status();
      expect(s.engine).toMatchObject({ running: true, config: ran, error: null });
      expect(s.cursors?.sync?.height).toBe(U1.from + 9);
      expect(s.settings).toEqual({ config: ran, autoStart: true });
    } finally {
      await r.close();
    }
  }, 120_000);

  it("[[browser.watchdog.restore-after-range]] after a range the new worker runs the range, not the configuration before it, and the saved configuration stays the range", async () => {
    const first: StartConfig = { ...U1_TAPE, startHeight: U1.from, endHeight: U1.from + 3, ...FAST };
    const r = rig(first);
    try {
      const c = r.engine.client;
      expect((await c.booted()).phase).toBe("ready");
      await c.start(first);
      await until(async () => (await c.status()).engine?.status.sync.phase === "done", "the first range");
      const ranged = await c.range(U1.from + 12, U1.from + 20);
      const range: StartConfig = { ...first, startHeight: U1.from + 12, endHeight: U1.from + 20 };
      expect(ranged.engine).toMatchObject({ running: true, config: range });
      const next = await r.restart();
      await until(() => next.received.some((m) => m.type === "start"), "the engine started on the new worker", 30_000);
      expect(next.received.find((m) => m.type === "start")).toMatchObject({ config: range });
      await until(async () => (await c.status()).engine?.status.sync.phase === "done", "the range on the new worker");
      const s = await c.status();
      expect(s.engine).toMatchObject({ running: true, config: range, error: null });
      expect(s.cursors?.sync).toEqual({ height: U1.from + 20, startHeight: U1.from + 12 });
      expect(s.settings).toEqual({ config: range, autoStart: true });
    } finally {
      await r.close();
    }
  }, 120_000);

  it("[[browser.watchdog.restore-after-import]] after an import, which stops the engine, the new worker starts nothing and the automatic start stays off", async () => {
    const config: StartConfig = { ...U1_TAPE, startHeight: U1.from, endHeight: U1.from + 6, ...FAST };
    const r = rig(config);
    try {
      const c = r.engine.client;
      expect((await c.booted()).phase).toBe("ready");
      await c.start(config);
      await until(async () => (await c.status()).engine?.status.sync.phase === "done", "the range");
      const exported = await c.export();
      const imported = await c.import(exported.file);
      expect(imported.status.engine?.running).toBe(false);
      expect(imported.status.settings?.autoStart).toBe(false);
      const next = await r.restart();
      await until(() => next.received.some((m) => m.type === "status"), "a request to the new worker", 30_000);
      expect(next.received.some((m) => m.type === "start")).toBe(false);
      const s = await c.status();
      expect(s.engine).toBeNull();
      expect(s.settings?.autoStart).toBe(false);
      expect(s.cursors?.sync).toEqual({ height: U1.from + 6, startHeight: U1.from });
    } finally {
      await r.close();
    }
  }, 120_000);

  it("[[browser.watchdog.restore-interrupted-import]] a worker that stops answering once an import's journal is saved, its engine still running: the new worker's boot finishes the import and starts nothing on the snapshot's store; the continuing configuration stays saved with no automatic start", async () => {
    const first: StartConfig = { ...U1_TAPE, startHeight: U1.from, endHeight: U1.from + 6, ...FAST };
    const later: StartConfig = { ...first, endHeight: U1.from + 12 };
    const r = rig(first);
    try {
      const c = r.engine.client;
      expect((await c.booted()).phase).toBe("ready");
      await c.start(first);
      await until(async () => (await c.status()).engine?.status.sync.phase === "done", "the snapshot's range");
      const exported = await c.export();
      await c.stop();
      const running = await c.start(later);
      expect(running.engine).toMatchObject({ running: true, config: later });
      await until(async () => (await c.status()).cursors?.sync?.height === U1.from + 12, "the store past the snapshot");
      // The import's journal is saved and the worker stops answering before its engine's stop is reported.
      r.workers.at(-1)!.silent = true;
      writeFileSync(r.journal, new Uint8Array(await exported.file.arrayBuffer()));
      const next = await r.restart();
      // The restore runs right after the new worker's boot; give it time to send whatever it sends.
      const end = Date.now() + 1_000;
      while (Date.now() < end) {
        expect(next.received.some((m) => m.type === "start"), "a start sent to the new worker").toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const s = await c.status();
      expect(s.snapshots.lastImport?.manifest.height).toBe(U1.from + 6);
      expect(s.cursors?.sync).toEqual({ height: U1.from + 6, startHeight: U1.from });
      expect(s.engine).toBeNull();
      const { endHeight: _end, ...continuing } = later;
      expect(s.settings).toEqual({ config: continuing, autoStart: false });
      expect(existsSync(r.journal)).toBe(false);
      expect(next.received.some((m) => m.type === "start")).toBe(false);
    } finally {
      await r.close();
    }
  }, 120_000);

  it("[[browser.watchdog.restore-module-off]] the token indexer switched off stays off on the new worker: the restart sends the configuration, with no module in it, and the saved switch keeps the scan stopped while the archive goes on; on again, the scan catches up", async () => {
    // A finalized tip that rises one block every 300 ms: the archive is still growing when the worker is replaced.
    const ran: StartConfig = { source: { kind: "tape", range: "u1", finalizedHeight: U1.from + 4, advance: { everyMs: 300, by: 1 } }, startHeight: U1.from, endHeight: U1.to, ...FAST };
    const r = rig(ran);
    try {
      const c = r.engine.client;
      expect((await c.booted()).phase).toBe("ready");
      const off = await c.request("module", { module: "token-indexer", enabled: false });
      expect(off.settings?.modules).toEqual({ "token-indexer": false });
      await c.start(ran);
      await until(async () => ((await c.status()).cursors?.sync?.height ?? 0) >= U1.from, "the archive's first block");
      const before = await c.status();
      expect(before.engine).toMatchObject({ running: true, config: ran });
      expect(before.engine?.status.scan).toMatchObject({ phase: "off", scanner: "off" });
      const archivedBefore = before.cursors!.sync!.height;
      expect(archivedBefore).toBeLessThan(U1.to);

      const next = await r.restart();
      await until(() => next.received.some((m) => m.type === "start"), "the engine started on the new worker", 30_000);
      expect(next.received.find((m) => m.type === "start")).toMatchObject({ config: ran });
      expect(next.received.some((m) => m.type === "module")).toBe(false);
      await until(async () => (await c.status()).cursors?.sync?.height === U1.to, "the archive on the new worker");
      const after = await c.status();
      expect(after.cursors?.sync?.height).toBeGreaterThan(archivedBefore);
      expect(after.engine).toMatchObject({ running: true, config: ran, error: null });
      expect(after.engine?.status.scan).toMatchObject({ phase: "off", scanner: "off" });
      expect(after.cursors?.scan).toBeNull();
      expect(after.settings).toEqual({ config: ran, autoStart: true, modules: { "token-indexer": false } });

      const on = await c.request("module", { module: "token-indexer", enabled: true });
      expect(on.settings?.modules).toEqual({ "token-indexer": true });
      await until(async () => (await c.status()).cursors?.scan?.nextHeight === U1.to + 1, "the scan catching up on the new worker");
      expect((await c.status()).engine?.status.scan).toMatchObject({ scanner: "following" });
    } finally {
      await r.close();
    }
  }, 120_000);
  it("[[browser.watchdog.restore-during-replacement]] a worker that stops answering while a range replaces its store (its engine's stop already reported), or while the range's own start runs (from a stopped engine): the new worker's boot finishes what the saved settings ask for and the restore starts the new range from them", async () => {
    const first: StartConfig = { ...U1_TAPE, startHeight: U1.from, endHeight: U1.from + 3, ...FAST };
    const range: StartConfig = { ...first, startHeight: U1.from + 12, endHeight: U1.from + 20 };
    for (const at of ["replacing the store", "starting the range"] as const) {
      const r = rig(first);
      try {
        const c = r.engine.client;
        const notices: Notice[] = [];
        c.onNotice((n) => notices.push(n));
        expect((await c.booted()).phase).toBe("ready");
        await c.start(first);
        await until(async () => (await c.status()).engine?.status.sync.phase === "done", `${at}: the first range`);
        if (at === "starting the range") await c.stop();
        const hold = at === "replacing the store" ? r.holds.removeStore : r.holds.loadTape;
        hold.armed = true;
        const ranging = c.range(range.startHeight as number, range.endHeight).then(() => "answered", (e: EngineError) => e.code);
        await until(() => hold.reached, `${at}: the worker held`, 30_000);
        if (at === "replacing the store") expect(notices.filter((n) => n.notice === "engine").at(-1), at).toMatchObject({ engine: { state: "stopped" } });
        const restarted = r.restart();
        if (at === "starting the range") hold.letGo();
        const next = await restarted;
        expect(await ranging, at).toBe("restarted");
        await until(() => next.received.some((m) => m.type === "start"), `${at}: the range started on the new worker`, 30_000);
        expect(next.received.find((m) => m.type === "start"), at).toMatchObject({ config: range });
        await until(async () => (await c.status()).engine?.status.sync.phase === "done", `${at}: the range on the new worker`);
        const s = await c.status();
        expect(s.engine, at).toMatchObject({ running: true, config: range, error: null });
        expect(s.cursors?.sync, at).toEqual({ height: U1.from + 20, startHeight: U1.from + 12 });
        expect(s.settings, at).toEqual({ config: range, autoStart: true });
        expect(await r.settings.load(), at).toEqual({ config: range, autoStart: true });
      } finally {
        await r.close();
      }
    }
  }, 180_000);

  it("[[browser.tabs.handover-mid-replacement]] the next leader tab starts what the store's saved settings say, never what the closed leader last reported: after an import the leader's watchdog finished, nothing; mid-import, nothing on the snapshot's store; mid-range, the new range on a new store; mid-reset, the saved configuration on a new store", async () => {
    const first: StartConfig = { ...U1_TAPE, startHeight: U1.from, endHeight: U1.from + 6, ...FAST };
    const later: StartConfig = { ...first, endHeight: U1.from + 12 };
    const { endHeight: _end, ...continuing } = first;
    const cases = ["import finished by the watchdog", "mid-import", "mid-range", "mid-reset"] as const;
    for (const what of cases) {
      const store = sharedStore(first);
      const locks = new FakeLocks();
      const channels = new FakeChannels();
      const rigs = new Map<string, Rig>();
      const open = (id: string): EngineTabs => connectEngineTabs({
        scope: "opfs-ahp://umbradb-handover",
        tabId: id,
        locks: locks.view(id),
        openChannel: channels.for(id),
        startWorker: () => {
          const r = supervised(store);
          rigs.set(id, r);
          return { client: r.engine.client, terminate: () => r.engine.close() };
        },
        leaderWaitMs: 30_000,
        log: () => {},
        resume: resumeOrAutoStart(true),
      });
      /** The tab closes abruptly: its worker ends, its locks and channels go, none of its code runs. */
      const kill = (t: EngineTabs): void => {
        rigs.get(t.tabId)!.engine.close();
        locks.kill(t.tabId);
        channels.kill(t.tabId);
      };
      const leader = open("leader");
      const follower = open("follower");
      try {
        expect(await leader.ready, what).toBe("leader");
        expect(await follower.ready, what).toBe("follower");
        const lc = leader.client;
        // The leader's automatic start runs the store's saved configuration (a new store's: the default, `first`).
        await until(async () => (await lc.status()).engine?.status.sync.phase === "done", `${what}: the first range`);
        const exported = what.includes("import") ? await lc.export() : undefined;
        await lc.stop();
        expect((await lc.start(later)).engine, what).toMatchObject({ running: true, config: later });
        await until(async () => (await lc.status()).cursors?.sync?.height === U1.from + 12, `${what}: the store past the snapshot`);
        await new Promise((resolve) => setTimeout(resolve, 100)); // the leader's report reaches the follower
        expect(follower.leader(), what).toBe("leader");

        if (what === "import finished by the watchdog") {
          // The import's journal is saved and the worker stops answering before its engine's stop is reported.
          const r = rigs.get("leader")!;
          r.workers.at(-1)!.silent = true;
          writeFileSync(r.journal, new Uint8Array(await exported!.file.arrayBuffer()));
          const restored = await r.restart();
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(restored.received.some((m) => m.type === "start"), `${what}: a start sent by the leader's watchdog`).toBe(false);
          expect((await lc.status()).settings, what).toEqual({ config: continuing, autoStart: false });
        } else {
          const hold = store.holds.removeStore;
          hold.armed = true;
          if (what === "mid-import") void lc.import(exported!.file).catch(() => {});
          if (what === "mid-range") void lc.range(U1.from + 12, U1.from + 20).catch(() => {});
          if (what === "mid-reset") void lc.reset().catch(() => {});
          await until(() => hold.reached, `${what}: the leader's worker in the middle of it`, 30_000);
        }
        kill(leader);
        await until(() => follower.role() === "leader", `${what}: the follower leads`, 30_000);
        const fc = follower.client;
        await until(async () => (await fc.status().catch(() => undefined))?.boot.phase === "ready", `${what}: the new leader's worker`, 30_000);
        const worker = rigs.get("follower")!.workers[0]!;
        // The new leader's resume runs once its worker has booted; give it time to send whatever it sends.
        await until(() => worker.received.filter((m) => m.type === "status").length >= 2, `${what}: the new leader's resume`, 30_000);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const starts = worker.received.filter((m) => m.type === "start");
        if (what === "import finished by the watchdog" || what === "mid-import") {
          expect(starts, `${what}: a start sent by the new leader`).toEqual([]);
          const s = await fc.status();
          expect(s.engine, what).toBeNull();
          expect(s.cursors?.sync, what).toEqual({ height: U1.from + 6, startHeight: U1.from });
          expect(s.settings, what).toEqual({ config: continuing, autoStart: false });
        } else {
          const expected = what === "mid-range" ? { ...later, startHeight: U1.from + 12, endHeight: U1.from + 20 } : later;
          expect(starts, what).toHaveLength(1);
          expect(starts[0], what).toMatchObject({ config: expected });
          const s = await fc.status();
          expect(s.store?.created, `${what}: a new store`).toBe(true);
          await until(async () => (await fc.status()).engine?.status.sync.phase === "done", `${what}: the new leader's range`);
          const done = await fc.status();
          expect(done.engine, what).toMatchObject({ running: true, config: expected, error: null });
          expect(done.cursors?.sync, what).toEqual({ height: expected.endHeight, startHeight: expected.startHeight });
          expect(done.settings, what).toEqual({ config: expected, autoStart: true });
        }
      } finally {
        follower.close();
        leader.close();
        await rigs.get("follower")?.close();
        await previousGone;
      }
    }
  }, 300_000);
});
