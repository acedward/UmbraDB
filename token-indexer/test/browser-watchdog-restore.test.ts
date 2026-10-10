/**
 * What the page's watchdog (`token-indexer/browser/supervisor.ts`) starts on the worker it puts in place of a stuck one:
 * the engine the worker last reported running, with the configuration it reported, whatever request started it. The
 * worker hosts run in this thread behind channels the test can silence, on PGlite in one directory, with the saved
 * settings and the snapshot journal outliving each worker (as the files beside an OPFS store do); the supervisor's clock
 * is driven by the test.
 *
 * - `[[browser.watchdog.restore-default-start]]` — an engine started with no configuration (the leader tab's automatic
 *   start, the engine panel's start) runs again on the new worker, with the configuration it ran.
 * - `[[browser.watchdog.restore-after-range]]` — after a `range`, the new worker runs the range, not the configuration
 *   before it, and the saved configuration stays the range.
 * - `[[browser.watchdog.restore-after-import]]` — after an `import`, which stops the engine, the new worker starts
 *   nothing and the automatic start stays off.
 * - `[[browser.watchdog.restore-module-off]]` — the token indexer switched off stays off on the new worker: the restart
 *   sends the engine's configuration, which carries no module, and the new worker's engine takes the switch from the
 *   saved settings, so its archive goes on while the scan stays where it stopped; switched on again, the scan catches
 *   up.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createWorkerHost, type WorkerHost } from "../browser/host.ts";
import type { StartConfig } from "../browser/protocol.ts";
import { memorySettingsStore } from "../browser/settings.ts";
import type { SnapshotFiles } from "../browser/snapshot-store.ts";
import { openStore } from "../browser/store.ts";
import { superviseWorker, type SupervisedEngine, type WorkerLike } from "../browser/supervisor.ts";
import { loadTape } from "../browser/tapes.ts";
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
      previousGone = host.close();
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

interface Rig {
  engine: SupervisedEngine<ChannelWorker>;
  workers: ChannelWorker[];
  settings: ReturnType<typeof memorySettingsStore>;
  /** Silences the current worker until the supervisor has replaced it. */
  restart(): Promise<ChannelWorker>;
  close(): Promise<void>;
}

/** Workers on one store directory whose settings and snapshot journal outlive each worker. */
function rig(defaultStart: StartConfig): Rig {
  const dir = mkdtempSync(join(tmpdir(), "umbradb-watchdog-restore-"));
  dirs.push(dir);
  const storeDir = join(dir, "store");
  const journal = join(dir, "journal.tar");
  const settings = memorySettingsStore();
  const snapshotFiles: SnapshotFiles = {
    readJournal: async () => (existsSync(journal) ? new Uint8Array(readFileSync(journal)) : undefined),
    writeJournal: async (file) => writeFileSync(journal, file),
    removeJournal: async () => rmSync(journal, { force: true }),
    removeStore: async () => rmSync(storeDir, { recursive: true, force: true }),
  };
  let now = 0;
  let check: () => void = () => {};
  const workers: ChannelWorker[] = [];
  const engine = superviseWorker<ChannelWorker>({
    createWorker: () => {
      const w = channelWorker(() => createWorkerHost({
        network: "stagenet",
        dataDir: storeDir,
        nodeUrl: "https://node.invalid/",
        indexerUrl: "https://indexer.invalid/",
        checkCapabilities: async () => SUPPORTED,
        openStore,
        settings,
        snapshotFiles,
        defaultStart,
        loadTape: (range) => loadTape(range, fileFetch()),
        log: () => {},
      }));
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
    settings,
    async restart() {
      const count = workers.length;
      workers[count - 1]!.silent = true;
      now += 1_001;
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
});
