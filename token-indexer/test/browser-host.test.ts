/**
 * The browser engine's worker host (`token-indexer/browser/host.ts`) and its protocol, client, capability check and
 * tape catalog, in Node: the host runs on an in-memory PGlite (`memory://`) exactly as the worker runs it on OPFS, with
 * the recorded U1 range replayed inside the host (no network). The worker in Chrome, on OPFS, across a reload, is
 * `browser-worker.test.ts`.
 *
 * - `[[browser.host.boot]]` — the boot phases in order, both schema lineages migrated, the store's facts, the API
 *   answering before any start (`scanner: "off"`).
 * - `[[browser.host.protocol]]` — every malformed message gets the right error code; `export` of an empty archive and
 *   `import` of a file that is not a snapshot are refused (`snapshot-refused`); a first start with no start height
 *   begins at the finalized tip.
 * - `[[browser.host.hostile-message]]` — a message whose version or type is an object that cannot be turned into text
 *   (no usable `toString`, a throwing `Symbol.toPrimitive`, a throwing getter) gets an error response, never a
 *   rejection; the page's parser of worker messages reports such a message as invalid without throwing.
 * - `[[browser.host.sync-failed]]` — a sync loop that ends with an error (a refused range) ends the engine: it is
 *   reported failed with the sync's error (status and `engine` notice), the scan does not go on alone, the API keeps
 *   answering, and a new start runs.
 * - `[[browser.host.engine]]` — start, run, stop, restart: the cursors and the API follow the replayed range, a restart
 *   continues at the cursor, and every block is fetched once.
 * - `[[browser.host.refusals]]` — an unsupported browser opens nothing; a ledger build with renamed classes fails the
 *   boot and leaves the store closed.
 * - `[[browser.capabilities]]` — the capability check on browser-like environments.
 * - `[[browser.client]]` — the page's client over a message channel: results, errors, notices, invalid messages.
 * - `[[browser.tapes]]` — the tape catalog equals the tapes' manifest, and a damaged tape is refused.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ArchiveTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeFetch } from "../../chain-archive-sync/tape-replay.js";
import { type CapabilityEnvironment, checkCapabilities } from "../browser/capabilities.ts";
import { createEngineClient, EngineError } from "../browser/client.ts";
import { createWorkerHost, type WorkerHost, type WorkerHostOptions } from "../browser/host.ts";
import { type CapabilityReport, type HostStatus, type Notice, parseRequest, parseWorkerMessage, PROTOCOL_VERSION, type Response } from "../browser/protocol.ts";
import { openStore, type Store } from "../browser/store.ts";
import { loadTape, TAPE_ASSETS } from "../browser/tapes.ts";

const U1 = { from: 715402, to: 715433 } as const;

const SUPPORTED: CapabilityReport = {
  supported: true,
  message: "",
  missing: [],
  checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: true },
  browser: "Chromium 153",
};

/** `fetch` for the tape catalog's `file:` URLs, counting the files read. */
function fileFetch(reads: string[] = [], transform: (b: Uint8Array) => Uint8Array = (b) => b): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    reads.push(url);
    return new Response(new Uint8Array(transform(new Uint8Array(readFileSync(fileURLToPath(url))))));
  }) as typeof fetch;
}

const hosts: WorkerHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});

function newHost(over: Partial<WorkerHostOptions> = {}): { host: WorkerHost; notices: Notice[]; logs: string[]; opened: Store[] } {
  const notices: Notice[] = [];
  const logs: string[] = [];
  const opened: Store[] = [];
  const host = createWorkerHost({
    network: "stagenet",
    dataDir: "memory://",
    nodeUrl: "https://node.invalid/",
    indexerUrl: "https://indexer.invalid/",
    checkCapabilities: async () => SUPPORTED,
    openStore: async (dir, o) => {
      const s = await openStore(dir, o);
      opened.push(s);
      return s;
    },
    loadTape: (range) => loadTape(range, fileFetch()),
    log: (level, message) => logs.push(`${level} ${message}`),
    ...over,
  });
  host.onNotice((n) => notices.push(n));
  hosts.push(host);
  return { host, notices, logs, opened };
}

let nextId = 1;
async function call(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<Response> {
  return host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
}
async function result<T = unknown>(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await call(host, type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
}
const errorOf = async (host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<{ code: string; message: string }> => {
  const r = await call(host, type, params);
  expect(r.ok, `${type} should fail`).toBe(false);
  return (r as Extract<Response, { ok: false }>).error;
};
const apiJson = async (host: WorkerHost, target: string): Promise<{ status: number; body: any }> => {
  const r = await result<{ status: number; body: string }>(host, "api", { method: "GET", target });
  return { status: r.status, body: JSON.parse(r.body) };
};

async function until(host: WorkerHost, what: string, ok: (s: HostStatus) => boolean, timeoutMs = 60_000): Promise<HostStatus> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await result<HostStatus>(host, "status");
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s.engine?.status ?? s.boot)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const FAST = { sync: { idleMs: 100 }, scan: { idleMs: 100 } };

describe("browser engine host", () => {
  it("[[browser.host.boot]] boots through capabilities, store, ledger and migrate to ready; both schema lineages are migrated; the API answers before any start", async () => {
    const { host, notices } = newHost();
    const before = await result<HostStatus>(host, "status");
    expect(before.boot.phase).toBe("starting");
    expect(before.store).toBeNull();
    expect(before.cursors).toBeNull();

    const boot = await host.boot();
    expect(boot.phase).toBe("ready");
    expect(boot.error).toBeNull();
    expect(boot.capabilities).toEqual(SUPPORTED);
    expect(notices.filter((n) => n.notice === "boot").map((n) => (n as Extract<Notice, { notice: "boot" }>).boot.phase))
      .toEqual(["capabilities", "store", "ledger", "migrate", "ready"]);
    for (const k of ["capabilitiesMs", "storeMs", "ledgerMs", "migrateMs", "totalMs"] as const) expect(boot.timings[k]).toBeGreaterThanOrEqual(0);

    const s = await result<HostStatus>(host, "status");
    expect(s.protocol).toBe(PROTOCOL_VERSION);
    expect(s.network).toBe("stagenet");
    expect(s.store).toMatchObject({ dataDir: "memory://", created: true, fsync: "off", durability: "non-durable" });
    expect(s.store!.serverVersion).toMatch(/^18\./);
    const { chainArchiveMigrations } = await import("../../src/postgres/migrations/chain_archive/index.js");
    const { mip0018Migrations } = await import("../../src/postgres/migrations/mip0018/index.js");
    expect(s.store!.migrations.archive).toEqual(chainArchiveMigrations.map((m) => m.name).sort());
    expect(s.store!.migrations.mip0018).toEqual(mip0018Migrations.map((m) => m.name).sort());
    expect(s.cursors).toEqual({ sync: null, scan: null });
    expect(s.engine).toBeNull();

    const st = await apiJson(host, "/v1/status");
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ network: "stagenet", scanner: "off", startHeight: null, indexedHeight: null, archiveHeight: null, durability: "non-durable" });
    expect((await result<{ status: number }>(host, "api", { method: "GET", target: "/v1/nope" })).status).toBe(404);
    expect((await result<{ status: number }>(host, "api", { method: "POST", target: "/v1/status" })).status).toBe(405);
    expect(await host.boot()).toEqual(boot); // the boot runs once
  }, 60_000);

  it("[[browser.host.protocol]] a malformed message gets bad-request, another version unsupported-version, an unknown type unknown-type; export of an empty archive and import of a file that is not a snapshot are refused; a first start with no start height begins at the finalized tip", async () => {
    const { host } = newHost();
    const fails = async (raw: unknown): Promise<Extract<Response, { ok: false }>> => {
      const r = await host.receive(raw);
      expect(r.ok, JSON.stringify(raw)).toBe(false);
      return r as Extract<Response, { ok: false }>;
    };
    expect(await fails("status")).toMatchObject({ id: null, request: null, error: { code: "bad-request" } });
    expect(await fails(null)).toMatchObject({ id: null, error: { code: "bad-request" } });
    expect(await fails({ v: 2, id: 5, type: "status" })).toMatchObject({ id: 5, request: "status", error: { code: "unsupported-version" } });
    expect(await fails({ id: 6, type: "status" })).toMatchObject({ id: 6, error: { code: "unsupported-version" } });
    expect(await fails({ v: 1, id: 7, type: "gossip" })).toMatchObject({ id: 7, request: null, error: { code: "unknown-type" } });
    expect(await fails({ v: 1, id: 8 })).toMatchObject({ id: 8, error: { code: "unknown-type" } });
    expect(await fails({ v: 1, id: 0, type: "status" })).toMatchObject({ id: null, error: { code: "bad-request" } });
    expect(await fails({ v: 1, id: 9, type: "status", extra: 1 })).toMatchObject({ id: 9, error: { code: "bad-request" } });
    expect(await fails({ v: 1, id: 10, type: "api", method: "GET" })).toMatchObject({ id: 10, request: "api", error: { code: "bad-request" } });
    expect(await fails({ v: 1, id: 11, type: "api", method: "GET", target: 7 })).toMatchObject({ error: { code: "bad-request" } });
    expect(await fails({ v: 1, id: 12, type: "start", config: { startHeight: -1 } })).toMatchObject({ error: { code: "bad-request" } });
    expect((await fails({ v: 1, id: 13, type: "start", config: { startHeight: 10, endHeight: 9 } })).error.message).toContain("endHeight");
    expect(await fails({ v: 1, id: 14, type: "start", config: { source: { kind: "tape", range: "nope" } } })).toMatchObject({ error: { code: "bad-request" } });
    expect(await fails({ v: 1, id: 15, type: "start", config: { source: { kind: "network", nodeUrl: "ftp://x" } } })).toMatchObject({ error: { code: "bad-request" } });
    expect(await fails({ v: 1, id: 16, type: "start", config: { source: { kind: "network", nodeUrl: "https://u:p@node.example/" } } })).toMatchObject({ error: { code: "bad-request" } });
    expect(await fails({ v: 1, id: 17, type: "start", config: { sync: { maxBlocks: 0 } } })).toMatchObject({ error: { code: "bad-request" } });
    expect(await fails({ v: 1, id: 18, type: "import", snapshot: "x" })).toMatchObject({ error: { code: "bad-request" } });

    expect(await fails({ v: 1, id: 19, type: "range", startHeight: "top" })).toMatchObject({ error: { code: "bad-request" } });
    expect((await result<HostStatus>(host, "stop")).engine).toBeNull(); // stop with nothing running is a no-op
    for (const [type, params, reason] of [["export", {}, "empty"], ["import", { snapshot: new Blob(["x"]) }, "format"]] as const) {
      const e = await errorOf(host, type, params);
      expect(e.code, type).toBe("snapshot-refused");
      expect(e.message, type).toMatch(new RegExp(`^${reason}: `));
    }
    // No start height on an empty archive: the finalized tip (the tape's highest height), never genesis.
    await result(host, "start", { config: { source: { kind: "tape", range: "u1" }, ...FAST } });
    const atTip = await until(host, "the tip block", (s) => s.cursors?.scan?.nextHeight === U1.to + 1);
    expect(atTip.cursors!.sync).toEqual({ height: U1.to, startHeight: U1.to });
  }, 60_000);

  it("[[browser.host.hostile-message]] a version or type that cannot be turned into text gets an error response, never a rejection; the page's parser reports such a worker message as invalid", async () => {
    const { host } = newHost();
    const noText = { toString: 0 };
    const throwing = { [Symbol.toPrimitive]: () => { throw new Error("no primitive"); } };
    const bare = Object.create(null) as object;
    for (const v of [noText, throwing, bare, [noText]]) {
      const r = await host.receive({ v, id: 1, type: "status" });
      expect(r).toMatchObject({ ok: false, id: 1, request: "status", error: { code: "unsupported-version" } });
      expect((r as Extract<Response, { ok: false }>).error.message).toMatch(/^protocol version (an object|an array) is not 1$/);
      expect(parseRequest({ v, id: 2, type: "stop" })).toMatchObject({ ok: false, error: { code: "unsupported-version" } });
      expect(parseWorkerMessage({ v, type: "response" })).toMatchObject({ kind: "invalid" });
    }
    for (const type of [noText, throwing, bare]) {
      expect(await host.receive({ v: PROTOCOL_VERSION, id: 3, type })).toMatchObject({ ok: false, id: 3, error: { code: "unknown-type" } });
      expect(parseWorkerMessage({ v: PROTOCOL_VERSION, type })).toMatchObject({ kind: "invalid", message: "unknown message type (an object)" });
    }
    const getter = Object.defineProperty({ id: 4, type: "status" }, "v", { get: () => { throw new Error("no version"); }, enumerable: true });
    expect(await host.receive(getter)).toMatchObject({ ok: false, id: null, request: null, error: { code: "bad-request" } });
    expect(parseWorkerMessage(getter)).toMatchObject({ kind: "invalid" });
    expect(parseRequest({ v: 2, id: 5, type: "status" })).toMatchObject({ error: { message: "protocol version 2 is not 1" } });
    expect((await result<HostStatus>(host, "status")).protocol).toBe(PROTOCOL_VERSION);
  }, 60_000);

  it("[[browser.host.sync-failed]] a sync loop that ends with an error ends the engine: reported failed with the sync's error in the status and an engine notice, the scan does not follow alone, the API keeps answering, a new start runs", async () => {
    const { host, notices } = newHost();
    const first = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.from + 5, ...FAST };
    await result(host, "start", { config: first });
    await until(host, "the first range", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === U1.from + 6);
    await result(host, "stop");
    // A start above the cursor + 1 is a range the archive cannot honour: the sync loop ends with an error.
    const refused = { ...first, startHeight: U1.from + 10, endHeight: U1.to };
    expect((await result<HostStatus>(host, "start", { config: refused })).engine).toMatchObject({ running: true });
    const failed = await until(host, "the engine failed", (s) => s.engine?.running === false);
    expect(failed.engine!.error).toMatch(/^the sync stopped: --from 715412 /);
    expect(failed.engine!.status.sync.phase).toBe("failed");
    expect(failed.engine!.status.scan.phase).toBe("stopped");
    expect(notices.filter((n) => n.notice === "engine").map((n) => (n as Extract<Notice, { notice: "engine" }>).engine).at(-1)).toEqual({ state: "failed", error: failed.engine!.error });
    expect((await result<{ status: number }>(host, "api", { method: "GET", target: "/v1/status" })).status).toBe(200);
    // A new start runs (the configuration the archive can continue).
    expect((await result<HostStatus>(host, "start", { config: { ...first, endHeight: U1.from + 8 } })).engine).toMatchObject({ running: true, error: null });
    await until(host, "the next range", (s) => s.cursors?.sync?.height === U1.from + 8 && s.cursors?.scan?.nextHeight === U1.from + 9);
    expect((await host.receive({ v: PROTOCOL_VERSION, id: 99, type: "status" })).ok).toBe(true);
  }, 60_000);

  it("[[browser.host.engine]] start syncs and scans the replayed range; stop leaves both cursors at a full block; a restart continues at the cursor", async () => {
    const tapes: ArchiveTape[] = [];
    const { host, notices } = newHost({
      loadTape: async (range) => {
        const t = await loadTape(range, fileFetch());
        tapes.push(t);
        return t;
      },
    });
    const mid = U1.from + 15;
    const first = await result<HostStatus>(host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: mid, ...FAST } });
    expect(first.engine).toMatchObject({ running: true, error: null });
    expect((await errorOf(host, "start", { config: { startHeight: U1.from } })).code).toBe("already-running");
    const done = await until(host, "the first range", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === mid + 1);
    expect(done.cursors).toMatchObject({ sync: { height: mid, startHeight: U1.from }, scan: { fromHeight: U1.from, nextHeight: mid + 1 } });
    expect(done.engine!.status.sync.startHeight).toBe(U1.from);
    expect(done.engine!.status.scan.scanner).toBe("following");
    const running = await apiJson(host, "/v1/status");
    expect(running.body).toMatchObject({ scanner: "following", startHeight: U1.from, indexedHeight: mid, archiveHeight: mid });

    const stopped = await result<HostStatus>(host, "stop");
    expect(stopped.engine).toMatchObject({ running: false, error: null });
    expect(stopped.engine!.status.sync.phase).toBe("done");
    expect(stopped.engine!.status.scan.phase).toBe("stopped");
    expect(stopped.cursors).toEqual(done.cursors);
    const idle = await apiJson(host, "/v1/status");
    expect(idle.body).toEqual({ ...running.body, scanner: "off" });
    const tokensBefore = await apiJson(host, "/v1/tokens");

    // A restart: no start height needed, the archive continues at its cursor up to the tape's tip.
    await result<HostStatus>(host, "start", { config: { source: { kind: "tape", range: "u1" }, ...FAST } });
    const end = await until(host, "the rest of the range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
    expect(end.cursors).toMatchObject({ sync: { height: U1.to, startHeight: U1.from }, scan: { fromHeight: U1.from, nextHeight: U1.to + 1 } });
    expect(end.engine!.config).toEqual({ source: { kind: "tape", range: "u1" }, ...FAST });
    await result(host, "stop");
    expect((await apiJson(host, "/v1/status")).body).toMatchObject({ startHeight: U1.from, indexedHeight: U1.to, archiveHeight: U1.to, scanner: "off" });
    expect((await apiJson(host, "/v1/tokens")).status).toBe(tokensBefore.status);
    expect(notices.filter((n) => n.notice === "engine").map((n) => (n as Extract<Notice, { notice: "engine" }>).engine.state))
      .toEqual(["running", "stopped", "running", "stopped"]);

    expect(tapes).toHaveLength(2); // each start loads the recorded range
  }, 120_000);

  it("[[browser.host.engine-network]] a network source: every height is fetched once across a stop and a restart", async () => {
    // The node and the indexer answer from the recorded range through the host's `fetch`, as the network would.
    const replay = createTapeFetch(await loadTape("u1", fileFetch()));
    const { host } = newHost({ fetch: replay.fetchImpl });
    const net = { source: { kind: "network", nodeUrl: replay.nodeUrl, indexerUrl: replay.indexerUrl }, ...FAST };
    await result(host, "start", { config: { ...net, startHeight: U1.from, endHeight: U1.from + 9 } });
    await until(host, "ten blocks", (s) => s.engine!.status.sync.phase === "done");
    await result(host, "stop");
    await result(host, "start", { config: net });
    await until(host, "the range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
    await result(host, "stop");
    expect(replay.counts.get("chain_getBlock")).toBe(U1.to - U1.from + 1);
    expect(replay.counts.get("indexer.block")).toBe(U1.to - U1.from + 1);
  }, 120_000);

  it("[[browser.host.refusals]] an unsupported browser opens no store and starts nothing; a ledger build with renamed classes fails the boot and closes the store", async () => {
    const refused: CapabilityReport = { ...SUPPORTED, supported: false, missing: ["syncAccessHandle"], message: "Chrome only: no sync access handles", checks: { ...SUPPORTED.checks, syncAccessHandle: false } };
    const u = newHost({ checkCapabilities: async () => refused });
    const boot = await u.host.boot();
    expect(boot).toMatchObject({ phase: "unsupported", error: "Chrome only: no sync access handles", capabilities: refused });
    expect(boot.timings.storeMs).toBeNull();
    expect(u.opened).toHaveLength(0);
    expect(await errorOf(u.host, "api", { method: "GET", target: "/v1/status" })).toEqual({ code: "unsupported-browser", message: "Chrome only: no sync access handles" });
    expect((await errorOf(u.host, "start", { config: { startHeight: 1 } })).code).toBe("unsupported-browser");
    const us = await result<HostStatus>(u.host, "status");
    expect(us).toMatchObject({ store: null, engine: null, cursors: null });

    const mangled = newHost({ loadLedger: async () => ({ Transaction: class e {}, ContractCall: class t {}, ContractDeploy: class n {}, MaintenanceUpdate: class r {} }) });
    const b = await mangled.host.boot();
    expect(b.phase).toBe("failed");
    expect(b.error).toContain("renamed its class Transaction");
    expect(mangled.opened).toHaveLength(1);
    expect(mangled.opened[0]!.pglite.closed).toBe(true);
    expect((await errorOf(mangled.host, "api", { method: "GET", target: "/v1/status" })).code).toBe("boot-failed");
    expect(mangled.logs.some((l) => l.startsWith("error boot failed"))).toBe(true);

    // The real ledger keeps its names (this is what the worker checks in the browser bundle too).
    const ledger = await import("@midnightntwrk/ledger-v9");
    expect([ledger.Transaction.name, ledger.ContractCall.name, ledger.ContractDeploy.name, ledger.MaintenanceUpdate.name])
      .toEqual(["Transaction", "ContractCall", "ContractDeploy", "MaintenanceUpdate"]);
  }, 60_000);
});

describe("browser capability check", () => {
  /** A Chromium-like worker scope with a working OPFS. */
  function env(over: { brands?: Array<{ brand: string; version: string }>; syncHandle?: "works" | "throws" | "absent"; storage?: boolean; locks?: boolean; bc?: boolean; persist?: boolean } = {}): CapabilityEnvironment & { files: Set<string> } {
    const files = new Set<string>();
    const handleProto = over.syncHandle === "absent" ? {} : { createSyncAccessHandle() {} };
    const root = {
      async getFileHandle(name: string, o?: { create?: boolean }) {
        if (o?.create === true) files.add(name);
        return over.syncHandle === "absent" ? {} : {
          async createSyncAccessHandle() {
            if (over.syncHandle === "throws") throw new Error("NoModificationAllowedError");
            return { close() {} };
          },
        };
      },
      async removeEntry(name: string) { files.delete(name); },
    };
    return {
      files,
      navigator: {
        userAgentData: { brands: over.brands ?? [{ brand: "Chromium", version: "153" }, { brand: "Google Chrome", version: "153" }, { brand: "Not.A/Brand", version: "99" }] },
        ...(over.storage === false ? {} : { storage: { getDirectory: async () => root, ...(over.persist === false ? {} : { persisted: async () => false }) } }),
        ...(over.locks === false ? {} : { locks: {} }),
      },
      ...(over.bc === false ? {} : { BroadcastChannel: class {} }),
      FileSystemFileHandle: { prototype: handleProto },
    };
  }

  it("[[browser.capabilities]] Chrome with OPFS sync access handles, Web Locks, BroadcastChannel and persistent storage is supported; each missing piece is named in a Chrome-only refusal", async () => {
    const ok = env();
    const r = await checkCapabilities(ok);
    expect(r).toEqual({ supported: true, message: "", missing: [], checks: SUPPORTED.checks, browser: "Google Chrome 153" });
    expect(ok.files.size).toBe(0); // the probe file is removed

    const firefox = await checkCapabilities(env({ brands: [] }));
    expect(firefox).toMatchObject({ supported: false, missing: ["chromium"], browser: null });
    expect(firefox.message).toBe("Chrome only: UmbraDB's browser engine runs in Google Chrome (desktop). This browser lacks Google Chrome (or another Chromium browser).");

    const blocked = env({ syncHandle: "throws" });
    expect(await checkCapabilities(blocked)).toMatchObject({ supported: false, missing: ["syncAccessHandle"] });
    expect(blocked.files.size).toBe(0);
    expect(await checkCapabilities(env({ syncHandle: "absent" }))).toMatchObject({ missing: ["syncAccessHandle"] });
    expect(await checkCapabilities(env({ storage: false }))).toMatchObject({ missing: ["opfs", "syncAccessHandle", "persistentStorage"] });
    const none = await checkCapabilities(env({ brands: [{ brand: "Chromium", version: "120" }], locks: false, bc: false, persist: false }));
    expect(none).toMatchObject({ supported: false, missing: ["webLocks", "broadcastChannel", "persistentStorage"], browser: "Chromium 120" });
    expect(none.message).toContain("Web Locks, BroadcastChannel, persistent storage");
    expect(await checkCapabilities({})).toMatchObject({ supported: false, missing: ["chromium", "opfs", "syncAccessHandle", "webLocks", "broadcastChannel", "persistentStorage"] });
  });
});

describe("browser engine client", () => {
  it("[[browser.client]] the client turns requests into validated results over a message channel: errors carry the worker's code, notices reach listeners, invalid messages are reported and dropped, close rejects what is pending", async () => {
    const { host } = newHost();
    const channel = new MessageChannel();
    const workerSide = channel.port2;
    let tamper: ((m: any) => any) | undefined;
    workerSide.onmessage = (e: MessageEvent) => { void host.receive(e.data).then((r) => workerSide.postMessage(tamper === undefined ? r : tamper(r))); };
    host.onNotice((n) => workerSide.postMessage(n));
    void host.boot(); // as the worker does when it loads
    const pagePort = channel.port1 as unknown as MessagePort;
    const client = createEngineClient({
      postMessage: (m) => pagePort.postMessage(m),
      addEventListener: (t, l) => pagePort.addEventListener(t, l as (e: MessageEvent) => void),
      removeEventListener: (t, l) => pagePort.removeEventListener(t, l as (e: MessageEvent) => void),
    });
    pagePort.start();
    const invalid: string[] = [];
    client.onInvalid((m) => invalid.push(m));
    const notices: Notice[] = [];
    client.onNotice((n) => notices.push(n));
    try {
      const boot = await client.booted();
      expect(boot.phase).toBe("ready");
      expect(notices.some((n) => n.notice === "boot" && n.boot.phase === "ready")).toBe(true);
      const s = await client.status();
      expect(s.store?.created).toBe(true);
      const a = await client.api("GET", "/v1/status");
      expect(a.status).toBe(200);
      expect(JSON.parse(a.body).scanner).toBe("off");
      expect(a.headers["content-type"]).toContain("application/json");

      for (const e of await Promise.all([client.export(), client.import(new Blob(["x"]))].map((p) => p.then(() => undefined, (x: unknown) => x)))) {
        expect(e).toBeInstanceOf(EngineError);
        expect((e as EngineError).code).toBe("snapshot-refused");
      }
      const refused = await client.range(10, 9).then(() => undefined, (x: unknown) => x as EngineError);
      expect(refused).toMatchObject({ code: "bad-request", request: "range" });

      tamper = (r) => ({ ...r, result: { ...r.result, status: "two hundred" } });
      expect(await client.api("GET", "/v1/status").then(() => undefined, (x: EngineError) => x.code)).toBe("bad-response");
      tamper = (r) => ({ ...r, request: "status" });
      expect(await client.api("GET", "/v1/status").then(() => undefined, (x: EngineError) => x.code)).toBe("bad-response");
      tamper = undefined;

      workerSide.postMessage({ v: 1, type: "gossip" });
      workerSide.postMessage({ v: 9, type: "notice" });
      workerSide.postMessage({ v: 1, type: "response", id: 999_999, request: "status", ok: true, result: {} });
      await client.status(); // the junk above arrived before this answer
      expect(invalid).toHaveLength(3);

      tamper = () => ({ dropped: true });
      const pending = client.status();
      client.close();
      expect(await pending.then(() => undefined, (x: EngineError) => x.code)).toBe("closed");
      expect(await client.status().then(() => undefined, (x: EngineError) => x.code)).toBe("closed");
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }, 60_000);
});

describe("browser tape catalog", () => {
  it("[[browser.tapes]] the catalog's files and SHA-256 values are the tapes' manifest; a tape that does not match its hash is refused", async () => {
    const manifest = JSON.parse(readFileSync(new URL("../browser/tapes/manifest.json", import.meta.url), "utf8")) as { tapes: Array<{ range: string; path: string; sha256: string }> };
    expect(Object.fromEntries(manifest.tapes.map((t) => [t.range, { file: t.path, sha256: t.sha256 }])))
      .toEqual(Object.fromEntries(Object.entries(TAPE_ASSETS).map(([k, a]) => [k, { file: a.file, sha256: a.sha256 }])));
    for (const a of Object.values(TAPE_ASSETS)) expect(a.url().pathname.endsWith(`/token-indexer/browser/tapes/${a.file}`)).toBe(true);

    const reads: string[] = [];
    const tape = await loadTape("u1", fileFetch(reads));
    expect(reads).toHaveLength(1);
    expect(tape.network).toBe("stagenet");
    expect(Math.min(...tape.heights)).toBe(U1.from);
    expect(Math.max(...tape.heights)).toBe(U1.to);
    const flipped = (b: Uint8Array): Uint8Array => { const c = new Uint8Array(b); c[c.length - 1]! ^= 1; return c; };
    await expect(loadTape("u1", fileFetch([], flipped))).rejects.toThrow(/SHA-256 [0-9a-f]{64} is not the recorded 7c9beb9e/);
    await expect(loadTape("u1", (async () => new Response("", { status: 404 })) as typeof fetch)).rejects.toThrow("HTTP 404");
  });
});

