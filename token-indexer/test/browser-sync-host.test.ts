/**
 * The browser engine's worker host (`token-indexer/browser/host.ts`) in Node, on an in-memory PGlite (`memory://`), for
 * what the sync adds to it; the same host runs in Chrome's worker on OPFS (`browser-sync.test.ts`).
 *
 * - `[[browser.host.digest]]` — `digest` gives the store's archive digest and the digest of every table of both
 *   schemas, read in one transaction; on the replayed U1 range the archive digest is the recorded live sync's.
 * - `[[browser.host.start-tip]]` — a start with no start height begins a new archive at the finalized tip
 *   (`/v1/status` `startHeight` = the tip) and saves its configuration; a `start` with no configuration runs the saved
 *   one (a new store: the default configuration), as the leader tab does once the worker has booted; a reopened store
 *   resumes at its cursor through the gap (every height fetched once, the first height kept); a `stop` turns the
 *   automatic start off until the next `start`.
 * - `[[browser.tabs.auto-start]]` — the leader tab's default resume: the previous leader's running configuration, else
 *   the saved configuration when it says to start by itself, else nothing; never with the build's automatic start off.
 * - `[[browser.host.range-reset]]` — `range` replaces the store with a new one and starts the new range (a range whose
 *   end is below its start is refused and changes nothing); `reset` replaces it and runs the same range again, to the
 *   same digests; `range("tip")` follows the tip again; the hook before a wipe is called each time; a reopened store keeps
 *   the range's end.
 * - `[[browser.host.quota]]` — the storage guard pauses the sync once the browser's usage reaches the quota minus the
 *   headroom (`paused (quota)` on the health line, the API still answering), a stop while paused returns at once, and
 *   the sync resumes once the usage is back under the threshold minus the margin.
 * - `[[browser.host.pacing]]` — with the default Stagenet endpoints, the browser engine spaces request starts 250 ms
 *   apart per endpoint and honours a 429's `Retry-After`, as the Node commands do.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ArchiveTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeFetch, createTapeReplay } from "../../chain-archive-sync/tape-replay.js";
import { deriveHealth } from "../engine/telemetry.ts";
import { BROWSER_INDEXER_URL, BROWSER_NODE_URL } from "../browser/config.ts";
import { createWorkerHost, type WorkerHost, type WorkerHostOptions } from "../browser/host.ts";
import { type CapabilityReport, type DigestResult, type HostStatus, PROTOCOL_VERSION, type Response, type StartConfig } from "../browser/protocol.ts";
import { pauseThresholdBytes, QUOTA_RULE, type StorageEnvironment } from "../browser/quota.ts";
import { memorySettingsStore } from "../browser/settings.ts";
import { resumeOrAutoStart } from "../browser/tabs.ts";
import type { EngineClient } from "../browser/client.ts";
import { loadTape } from "../browser/tapes.ts";
import { nodeStoreFiles } from "./helpers/worker-host.ts";

const U1 = { from: 715402, to: 715433 } as const;
const FAST = { sync: { idleMs: 100 }, scan: { idleMs: 100 } };

const SUPPORTED: CapabilityReport = {
  supported: true,
  message: "",
  missing: [],
  checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: true },
  browser: "Chromium 153",
};

const MANIFEST = JSON.parse(readFileSync(new URL("../../test/integration/fixtures/stagenet-archive/manifest.json", import.meta.url), "utf8")) as {
  ranges: Array<{ name: string; liveSync: { archiveDigest: DigestResult["archive"] } }>;
};

/** `fetch` for the tape catalog's `file:` URLs. */
const fileFetch: typeof fetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(fileURLToPath(input instanceof Request ? input.url : String(input)))))) as typeof fetch;

const hosts: WorkerHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Closes a host the test is done with (a closed tab). */
async function closeHost(h: WorkerHost): Promise<void> {
  hosts.splice(hosts.indexOf(h), 1);
  await h.close();
}

/** A store directory that outlives one host (PGlite on the Node file system), as an OPFS store outlives a tab. */
function storeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "umbradb-host-store-"));
  dirs.push(d);
  return d;
}

let u1: ArchiveTape | undefined;
const u1Tape = async (): Promise<ArchiveTape> => (u1 ??= await loadTape("u1", fileFetch));

function newHost(over: Partial<WorkerHostOptions> = {}): WorkerHost {
  const host = createWorkerHost({
    network: "stagenet",
    dataDir: "memory://",
    nodeUrl: "https://node.invalid/",
    indexerUrl: "https://indexer.invalid/",
    checkCapabilities: async () => SUPPORTED,
    loadTape: (range) => loadTape(range, fileFetch),
    log: () => {},
    ...over,
  });
  hosts.push(host);
  return host;
}

let nextId = 1;
async function result<T = unknown>(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<T> {
  const r: Response = await host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
  if (!r.ok) throw new Error(`${type}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
}
async function errorOf(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<{ code: string; message: string }> {
  const r: Response = await host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
  if (r.ok) throw new Error(`${type} should fail`);
  return r.error;
}
const apiJson = async (host: WorkerHost, target: string): Promise<{ status: number; body: any }> => {
  const r = await result<{ status: number; body: string }>(host, "api", { method: "GET", target });
  return { status: r.status, body: JSON.parse(r.body) };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(host: WorkerHost, what: string, ok: (s: HostStatus) => boolean, timeoutMs = 60_000): Promise<HostStatus> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await result<HostStatus>(host, "status");
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s.engine?.status ?? s.boot)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("browser engine host: sync", () => {
  it("[[browser.host.digest]] digest gives the archive digest and the digest of every table of both schemas in one transaction; the replayed U1 range gives the recorded live archive digest", async () => {
    const host = newHost();
    const empty = await result<DigestResult>(host, "digest");
    expect(empty.archive.tables.blocks).toMatchObject({ rows: 0 });
    expect(Object.keys(empty.tables.tables)).toHaveLength(37);
    expect(empty.elapsedMs).toBeGreaterThanOrEqual(0);

    await result(host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.to, ...FAST } });
    // While the engine runs, a digest is one consistent state: its archive rows agree with its own cursor.
    const during = await result<DigestResult>(host, "digest");
    expect(during.tables.tables["archive.blocks"]!.rows).toBe(during.archive.tables.blocks!.rows);
    await until(host, "U1 synced and scanned", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === U1.to + 1);
    const done = await result<DigestResult>(host, "digest");
    expect(done.archive).toEqual(MANIFEST.ranges.find((r) => r.name === "u1")!.liveSync.archiveDigest);
    expect(done.tables.tables["archive.blocks"]).toMatchObject({ rows: U1.to - U1.from + 1 });
    expect(done.tables.sha256).toMatch(/^[0-9a-f]{64}$/);
    await result(host, "stop");
    expect(await result<DigestResult>(host, "digest")).toMatchObject({ archive: done.archive, tables: done.tables });
  }, 120_000);

  it("[[browser.host.start-tip]] a start with no start height begins at the finalized tip; a start with no configuration runs the saved one; a reopened store resumes at its cursor through the gap; a stop turns the automatic start off", async () => {
    // A start with no start height on an empty store: the tip the endpoints serve (here the tape's, 715420).
    const plain = createTapeFetch(await u1Tape(), { finalizedHeight: 715420 });
    const h0 = newHost({ fetch: plain.fetchImpl });
    const net0: StartConfig = { source: { kind: "network", nodeUrl: plain.nodeUrl, indexerUrl: plain.indexerUrl }, ...FAST };
    const started = await result<HostStatus>(h0, "start", { config: net0 });
    expect(started.settings).toEqual({ config: net0, autoStart: true });
    const at = await until(h0, "the tip block", (s) => s.cursors?.scan?.nextHeight === 715421);
    expect(at.cursors!.sync).toEqual({ height: 715420, startHeight: 715420 });
    expect((await apiJson(h0, "/v1/status")).body).toMatchObject({ startHeight: 715420, archiveHeight: 715420, indexedHeight: 715420 });

    // A new store on a directory that outlives the host: its saved configuration is the default one, and a start with
    // no configuration (what the leader tab sends once the worker has booted) runs it, from the tip.
    const dir = storeDir();
    const settings = memorySettingsStore();
    const replay = createTapeFetch(await u1Tape(), { finalizedHeight: 715410 });
    const net: StartConfig = { source: { kind: "network", nodeUrl: replay.nodeUrl, indexerUrl: replay.indexerUrl }, ...FAST };
    const opts = { dataDir: dir, settings, defaultStart: net, fetch: replay.fetchImpl };
    const a = newHost(opts);
    expect((await a.boot()).phase).toBe("ready");
    expect((await result<HostStatus>(a, "status")).settings).toEqual({ config: net, autoStart: true });
    await result(a, "start");
    const first = await until(a, "the start at the tip", (s) => s.cursors?.scan?.nextHeight === 715411);
    expect(first.engine).toMatchObject({ running: true, config: net });
    expect(first.cursors!.sync).toEqual({ height: 715410, startHeight: 715410 });
    expect(first.settings).toEqual({ config: net, autoStart: true });
    await closeHost(a);

    // Reopened after the tip moved on: it resumes at its cursor and fetches each height of the gap once.
    replay.setFinalizedHeight(715420);
    const b = newHost(opts);
    await result(b, "start");
    const caught = await until(b, "the gap", (s) => s.cursors?.sync?.height === 715420 && s.cursors?.scan?.nextHeight === 715421);
    expect(caught.cursors!.sync).toEqual({ height: 715420, startHeight: 715410 });
    expect(replay.counts.get("chain_getBlock")).toBe(715420 - 715410 + 1);
    expect(replay.counts.get("indexer.block")).toBe(715420 - 715410 + 1);
    expect((await apiJson(b, "/v1/status")).body).toMatchObject({ startHeight: 715410, archiveHeight: 715420 });

    // A stop request turns the automatic start off until the next start.
    const stopped = await result<HostStatus>(b, "stop");
    expect(stopped.settings).toEqual({ config: net, autoStart: false });
    await closeHost(b);
    const c = newHost(opts);
    await c.boot();
    await sleep(200);
    const idle = await result<HostStatus>(c, "status");
    expect(idle.engine).toBeNull();
    expect(idle.settings).toEqual({ config: net, autoStart: false });
    const again = await result<HostStatus>(c, "start");
    expect(again.engine).toMatchObject({ running: true, config: net });
    expect(again.settings).toEqual({ config: net, autoStart: true });
  }, 120_000);

  it("[[browser.host.range-reset]] range replaces the store and starts the new range; reset runs it again to the same digests; range tip follows again; a reopened store keeps the range's end", async () => {
    const dir = storeDir();
    const settings = memorySettingsStore();
    const replay = createTapeFetch(await u1Tape());
    const net: StartConfig = { source: { kind: "network", nodeUrl: replay.nodeUrl, indexerUrl: replay.indexerUrl }, ...FAST };
    const wiped: string[] = [];
    const opts = { dataDir: dir, snapshotFiles: nodeStoreFiles(dir), settings, defaultStart: net, fetch: replay.fetchImpl, beforeWipe: async (s: { dataDir: string }) => { wiped.push(s.dataDir); } };
    const h = newHost(opts);
    await result(h, "start");
    await until(h, "the tip", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);

    // A range whose end is below its start is refused before anything is dropped.
    expect((await errorOf(h, "range", { startHeight: 715410, endHeight: 715405 })).code).toBe("bad-request");
    expect(wiped).toEqual([]);
    expect((await result<HostStatus>(h, "status")).cursors!.sync).toEqual({ height: U1.to, startHeight: U1.to });

    const r = await result<HostStatus>(h, "range", { startHeight: 715402, endHeight: 715410 });
    expect(wiped).toEqual([dir]);
    expect(r.engine).toMatchObject({ running: true, config: { ...net, startHeight: 715402, endHeight: 715410 } });
    expect(r.settings).toEqual({ config: { ...net, startHeight: 715402, endHeight: 715410 }, autoStart: true });
    const done = await until(h, "the range", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === 715411);
    expect(done.cursors!.sync).toEqual({ height: 715410, startHeight: 715402 });
    expect((await apiJson(h, "/v1/status")).body).toMatchObject({ startHeight: 715402, archiveHeight: 715410, indexedHeight: 715410 });
    const d1 = await result<DigestResult>(h, "digest");
    expect(d1.archive.tables.blocks!.rows).toBe(9);

    // reset: the same range again, from nothing, to the same digests.
    await result<HostStatus>(h, "reset");
    expect(wiped).toEqual([dir, dir]);
    await until(h, "the range again", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === 715411);
    const d2 = await result<DigestResult>(h, "digest");
    expect({ archive: d2.archive, tables: d2.tables }).toEqual({ archive: d1.archive, tables: d1.tables });

    // A reopened store keeps the range's end: its saved configuration ends at once, past nothing.
    await closeHost(h);
    const h2 = newHost(opts);
    expect((await result<HostStatus>(h2, "start")).settings).toEqual(r.settings);
    const kept = await until(h2, "the resumed range", (s) => s.engine?.status.sync.phase === "done");
    expect(kept.cursors!.sync).toEqual({ height: 715410, startHeight: 715402 });

    // range tip: a new archive at the tip, following it.
    const t = await result<HostStatus>(h2, "range", { startHeight: "tip" });
    expect(t.settings!.config).toEqual({ ...net, startHeight: "tip" });
    const tip = await until(h2, "the tip", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);
    expect(tip.cursors!.sync).toEqual({ height: U1.to, startHeight: U1.to });
    expect(tip.engine!.status.sync.endHeight).toBeUndefined();
    expect(wiped).toEqual([dir, dir, dir]);
  }, 120_000);

  it("[[browser.host.quota]] the sync pauses before the quota (paused (quota)), a stop while paused returns at once, and it resumes once the usage is back under the threshold minus the margin", async () => {
    const quota = 1_000_000_000;
    const pauseAt = pauseThresholdBytes(quota);
    expect(pauseAt).toBe(quota - Math.max(QUOTA_RULE.minHeadroomBytes, quota * QUOTA_RULE.headroomFraction));
    expect(pauseThresholdBytes(100 * 1024 ** 3)).toBe(90 * 1024 ** 3); // 10 % above 2.56 GiB
    const usage = { now: 100_000_000 };
    const env: StorageEnvironment = {
      estimate: async () => ({ usage: usage.now, quota }),
      persisted: async () => false,
      storeBytes: async () => 42_000_000,
    };
    const h = newHost({ storage: env, quota: { checkEveryMs: 0, recheckMs: 50, storeEveryMs: 0 } });
    const config = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, sync: { maxBlocks: 2, idleMs: 100 }, scan: { idleMs: 100 } };
    await result(h, "start", { config });
    await until(h, "a few blocks", (s) => (s.cursors?.sync?.height ?? 0) >= U1.from + 3);
    expect((await result<HostStatus>(h, "status")).storage).toMatchObject({ usageBytes: 100_000_000, quotaBytes: quota, pauseAtBytes: pauseAt, paused: false, pausedReason: null, persisted: false });

    usage.now = pauseAt;
    const paused = await until(h, "the pause", (s) => s.storage?.paused === true);
    expect(paused.storage).toMatchObject({ usageBytes: pauseAt, quotaBytes: quota, pauseAtBytes: pauseAt, paused: true, storeBytes: 42_000_000, persisted: false });
    expect(paused.storage!.pausedReason).toContain("the sync pauses at");
    expect(paused.storage!.pausedReason).toContain("the store's files hold 40.1 MiB");
    await sleep(300);
    const held = (await result<HostStatus>(h, "status")).cursors!.sync!.height;
    await sleep(500);
    expect((await result<HostStatus>(h, "status")).cursors!.sync!.height).toBe(held);
    expect(held).toBeLessThan(U1.to);
    expect((await apiJson(h, "/v1/status")).status).toBe(200); // the API keeps answering
    const s = await result<HostStatus>(h, "status");
    const health = deriveHealth({
      fatal: null,
      engine: {
        started: s.engine!.status.started,
        stopping: s.engine!.status.stopping,
        sync: { phase: s.engine!.status.sync.phase, lastError: s.engine!.status.sync.lastError, endHeight: s.engine!.status.sync.endHeight },
        scan: { phase: s.engine!.status.scan.phase, lastError: s.engine!.status.scan.lastError, scanner: s.engine!.status.scan.scanner },
      },
      network: { retryingNow: false, failedOnNetwork: false, lastRequestFailed: false, lastRetryMessage: null },
      quota: { paused: s.storage!.paused, reason: s.storage!.pausedReason },
      tip: U1.to, archiveHeight: held, scanHeight: held, startHeight: U1.from,
    });
    expect(health).toMatchObject({ state: "paused-quota", label: "paused (quota)", reason: s.storage!.pausedReason });

    // A stop while paused returns at once; a start stays paused.
    const t0 = Date.now();
    await result(h, "stop");
    expect(Date.now() - t0).toBeLessThan(1_000);
    await result(h, "start", { config });
    await sleep(300);
    expect((await result<HostStatus>(h, "status")).cursors!.sync!.height).toBe(held);

    // Inside the margin it stays paused; under it, the sync resumes and finishes.
    usage.now = pauseAt - QUOTA_RULE.resumeMarginBytes + 1;
    await sleep(300);
    expect((await result<HostStatus>(h, "status")).storage!.paused).toBe(true);
    usage.now = pauseAt - QUOTA_RULE.resumeMarginBytes - 1;
    const resumed = await until(h, "the rest of the range", (st) => st.cursors?.sync?.height === U1.to);
    expect(resumed.storage).toMatchObject({ paused: false, pausedReason: null });
  }, 120_000);

  it("[[browser.host.pacing]] with the default Stagenet endpoints, request starts are 250 ms apart per endpoint and a 429's Retry-After is honoured", async () => {
    const replay = createTapeReplay(await u1Tape(), { throttles: [{ operation: "chain_getBlock", times: 1, status: 429, retryAfter: "1" }] });
    const starts = new Map<string, number[]>();
    const route = (url: URL): string => {
      if (`${url.origin}${url.pathname}`.replace(/\/$/, "") === BROWSER_NODE_URL) return "/rpc";
      if (`${url.origin}${url.pathname}` === BROWSER_INDEXER_URL) return "/graphql";
      throw new TypeError(`no route to ${url.href}`);
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      starts.set(url.origin, [...(starts.get(url.origin) ?? []), Date.now()]);
      const a = await replay.answer(route(url), await request.text());
      return new Response(a.body, { status: a.status, headers: a.headers });
    };
    const logs: string[] = [];
    const h = newHost({ nodeUrl: BROWSER_NODE_URL, indexerUrl: BROWSER_INDEXER_URL, fetch: fetchImpl, log: (level, m) => logs.push(`${level} ${m}`) });
    await result(h, "start", { config: { startHeight: U1.from, endHeight: U1.from + 3, ...FAST } });
    await until(h, "four blocks", (s) => s.engine!.status.sync.phase === "done");
    expect(starts.size).toBe(2);
    // The pacer spaces the start SLOTS 250 ms apart; a request whose timer fires late (the event loop busy with a
    // statement) starts late in its slot, so the next gap can be shorter by that lateness while the slots keep their
    // spacing. Allowed lateness: 100 ms (62 ms seen with the Chromium tests running beside this file on a loaded host). A
    // pacer with a shorter interval fails the run's total.
    const LATE_MS = 100;
    for (const [origin, times] of starts) {
      expect(times.length, origin).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `${origin} request ${i}`).toBeGreaterThanOrEqual(250 - LATE_MS);
      expect(times.at(-1)! - times[0]!, `${origin}: ${times.length} starts`).toBeGreaterThanOrEqual(250 * (times.length - 1) - LATE_MS);
    }
    expect(logs, logs.join("\n")).toContain("warn sync chain_getBlock retried in 1000 ms: chain_getBlock: HTTP 429 from https://rpc.stagenet.shielded.tools//");
  }, 120_000);
});

describe("leader tab: automatic start", () => {
  /** A client that records the starts it is asked for and reports `status` as given. */
  function fakeClient(status: Partial<HostStatus>): { client: EngineClient; starts: Array<StartConfig | undefined> } {
    const starts: Array<StartConfig | undefined> = [];
    const client = {
      status: async () => status as HostStatus,
      start: async (config?: StartConfig) => {
        starts.push(config);
        return status as HostStatus;
      },
    } as unknown as EngineClient;
    return { client, starts };
  }

  it("[[browser.tabs.auto-start]] the leader resumes the previous leader's running configuration, else starts the saved configuration when it says to start by itself, else nothing; with the build's automatic start off it starts only a previous leader's", async () => {
    const config: StartConfig = { source: { kind: "tape", range: "u1" }, startHeight: 715402 };
    const saved = (autoStart: boolean) => ({ engine: null, settings: { config: {}, autoStart } });

    const resumed = fakeClient(saved(true));
    await resumeOrAutoStart(true)({ running: true, config }, resumed.client);
    expect(resumed.starts).toEqual([config]);

    const fresh = fakeClient(saved(true));
    await resumeOrAutoStart(true)(null, fresh.client);
    expect(fresh.starts).toEqual([undefined]); // the saved configuration

    const stopped = fakeClient(saved(false));
    await resumeOrAutoStart(true)(null, stopped.client);
    await resumeOrAutoStart(true)({ running: false, config }, stopped.client);
    expect(stopped.starts).toEqual([]);

    const off = fakeClient(saved(true));
    await resumeOrAutoStart(false)(null, off.client);
    expect(off.starts).toEqual([]);
    await resumeOrAutoStart(false)({ running: true, config }, off.client);
    expect(off.starts).toEqual([config]);

    const busy = fakeClient({ engine: { running: true } as HostStatus["engine"], settings: { config: {}, autoStart: true } });
    await resumeOrAutoStart(true)(null, busy.client);
    expect(busy.starts).toEqual([]);
  });
});
