/**
 * Snapshots of the browser engine's store (`token-indexer/browser/snapshot.ts`, `snapshot-store.ts`), in Node: the worker
 * host runs on PGlite in memory (`memory://`) or on the Node file system (a store that outlives a host, as an OPFS store
 * outlives a tab), replaying the recorded U1 range (715402–715433) with no network. The same in Chrome, on OPFS, is
 * `browser-snapshot-chrome.test.ts`.
 *
 * - `[[browser.snapshot.file]]` — the file is a tar of `manifest.json` and `data.tar.gz` (`tar` lists it); everything
 *   that is not such a file is refused with its reason: not a snapshot or another manifest version (`format`), cut short
 *   anywhere (`truncated`), a data directory entry outside the data directory, a link, a directory with content, no
 *   `PG_VERSION`, damaged gzip or a size other than the manifest's (`corrupt`); another network or genesis block
 *   (`network`), other migrations (`schema`), another PGlite or Postgres version (`pglite`), data whose size or SHA-256
 *   differs (`hash`).
 * - `[[browser.snapshot.round-trip]]` — a store exported at height H (the engine still running) and imported into a new
 *   store holds the same data (equal archive and range-tables digests, the manifest's cursors, the same API answers);
 *   the saved configuration continues the archive with the automatic start off; a start then requests height H + 1
 *   first and nothing at or below H, and the finished store equals an uninterrupted run (U1's recorded live archive
 *   digest).
 * - `[[browser.snapshot.consistent]]` — exports taken while the sync and the scan write are each one state: every
 *   export's manifest equals its own data (cursors, block hash, migrations), its heights never go back, and the session
 *   was held only for the read.
 * - `[[browser.snapshot.refusals]]` — an import of a snapshot of another network, genesis block, schema version or
 *   PGlite version, with a changed byte, cut short, not a snapshot, or whose data contradicts its manifest is refused
 *   with its reason, and the store, the cursors, the saved configuration and a running engine are untouched.
 * - `[[browser.snapshot.journal]]` — a store with an import journal is finished from it before PGlite opens it (also
 *   over a half-written store); an invalid journal (the swap never started) is dropped and the store opens as it was;
 *   a snapshot that fails to load leaves an empty store and the failure; a host booting over a journal reports the
 *   import and saves the continuing configuration.
 * - `[[browser.snapshot.published]]` — the build's published snapshot of the recorded range 714485–715183 holds the
 *   recorded live sync (archive digest `cb0d5e21…`, range-tables digest `af6583d0…c832c`), its index validates, and an
 *   import of it answers the explorer's API with no chain request.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ArchiveTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeFetch } from "../../chain-archive-sync/tape-replay.js";
import { createWorkerHost, type WorkerHost, type WorkerHostOptions } from "../browser/host.ts";
import { type CapabilityReport, type DigestResult, type ExportResult, type HostStatus, type ImportResult, PROTOCOL_VERSION, type Response } from "../browser/protocol.ts";
import { memorySettingsStore } from "../browser/settings.ts";
import {
  checkCompatible,
  checkData,
  DATA_ENTRY,
  decodeSnapshotFile,
  encodeSnapshotFile,
  gzip,
  MANIFEST_ENTRY,
  PublishedSnapshotIndexSchema,
  readTar,
  type SnapshotManifest,
  SnapshotRefusal,
  sha256Hex,
  unpackDataDir,
  writeTar,
} from "../browser/snapshot.ts";
import { openFinishingImport, prepareImport, readStoreFacts, type SnapshotFiles } from "../browser/snapshot-store.ts";
import { openStore } from "../browser/store.ts";
import { loadTape } from "../browser/tapes.ts";
import { makePublishedSnapshot, recordedRange, writePublishedSnapshots } from "../dev/browser-snapshot.ts";

const U1 = { from: 715402, to: 715433 } as const;
const MID = U1.from + 15;
const FAST = { sync: { idleMs: 50 }, scan: { idleMs: 100 } };

const SUPPORTED: CapabilityReport = {
  supported: true,
  message: "",
  missing: [],
  checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: true },
  browser: "Chromium 153",
};

const MANIFEST = JSON.parse(readFileSync(new URL("../../test/integration/fixtures/stagenet-archive/manifest.json", import.meta.url), "utf8")) as {
  ranges: Array<{ name: string; liveSync: { archiveDigest: { sha256: string } } }>;
};
const U1_ARCHIVE = MANIFEST.ranges.find((r) => r.name === "u1")!.liveSync.archiveDigest.sha256;

const fileFetch: typeof fetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(fileURLToPath(input instanceof Request ? input.url : String(input)))))) as typeof fetch;

let u1: ArchiveTape | undefined;
const u1Tape = async (): Promise<ArchiveTape> => (u1 ??= await loadTape("u1", fileFetch));

const hosts: WorkerHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

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

async function closeHost(h: WorkerHost): Promise<void> {
  hosts.splice(hosts.indexOf(h), 1);
  await h.close();
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
async function errorOf(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<{ code: string; message: string }> {
  const r = await call(host, type, params);
  if (r.ok) throw new Error(`${type} should fail`);
  return r.error;
}
const apiBody = async (host: WorkerHost, target: string): Promise<string> => (await result<{ body: string }>(host, "api", { method: "GET", target })).body;

async function until(host: WorkerHost, what: string, ok: (s: HostStatus) => boolean, timeoutMs = 60_000): Promise<HostStatus> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await result<HostStatus>(host, "status");
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ cursors: s.cursors, engine: s.engine?.status })}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const bytesOf = async (b: Blob): Promise<Uint8Array> => new Uint8Array(await b.arrayBuffer());

/** The snapshot file with its manifest changed by `change` (the data unchanged). */
function withManifest(file: Uint8Array, change: (m: SnapshotManifest) => void): Uint8Array {
  const { manifest, data } = decodeSnapshotFile(file);
  const m = structuredClone(manifest);
  change(m);
  return encodeSnapshotFile(m, data);
}

/** A host holding U1 synced and scanned up to `to`, its engine stopped. */
async function hostWithU1(to: number, over: Partial<WorkerHostOptions> = {}): Promise<WorkerHost> {
  const host = newHost(over);
  await result(host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: to, ...FAST } });
  await until(host, `U1 up to ${to}`, (s) => s.cursors?.sync?.height === to && s.cursors.scan?.nextHeight === to + 1);
  await result(host, "stop");
  return host;
}

const refusalOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof SnapshotRefusal) return e.reason;
    throw e;
  }
  throw new Error("not refused");
};

/** Snapshot files of a store, kept in a directory of the Node file system (the OPFS journal's stand-in). */
function nodeSnapshotFiles(storeDir: string, journal: string): SnapshotFiles {
  return {
    readJournal: async () => (existsSync(journal) ? new Uint8Array(readFileSync(journal)) : undefined),
    writeJournal: async (file) => writeFileSync(journal, file),
    removeJournal: async () => rmSync(journal, { force: true }),
    removeStore: async () => rmSync(storeDir, { recursive: true, force: true }),
  };
}

describe("browser engine snapshots", () => {
  it("[[browser.snapshot.file]] a snapshot file is a tar of manifest.json and data.tar.gz; anything else, or a manifest this engine cannot take, is refused with its reason", async () => {
    const host = await hostWithU1(MID);
    const exported = await result<ExportResult>(host, "export");
    const file = await bytesOf(exported.file);
    expect(exported.name).toBe(`umbradb-stagenet-${U1.from}-${MID}.snapshot.tar`);
    expect(exported.file.type).toBe("application/x-tar");
    expect(exported.bytes).toBe(file.length);
    expect(file.length % 512).toBe(0);

    // Readable with tar.
    const dir = tempDir("umbradb-snapshot-file-");
    writeFileSync(join(dir, exported.name), file);
    expect(execFileSync("tar", ["-tf", join(dir, exported.name)], { encoding: "utf8" }).trim().split("\n")).toEqual([MANIFEST_ENTRY, DATA_ENTRY]);
    execFileSync("tar", ["-xf", join(dir, exported.name), "-C", dir]);
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_ENTRY), "utf8")) as SnapshotManifest;
    expect(manifest).toEqual(exported.manifest);
    const data = new Uint8Array(readFileSync(join(dir, DATA_ENTRY)));
    expect(await sha256Hex(data)).toBe(manifest.data.sha256);
    expect(data.length).toBe(manifest.data.bytes);
    await checkData(manifest, data);

    // The container: not a snapshot, another version, cut short.
    const decode = async (bytes: Uint8Array) => decodeSnapshotFile(bytes);
    expect(await refusalOf(decode(new TextEncoder().encode("hello")))).toBe("format");
    expect(await refusalOf(decode(new Uint8Array(0)))).toBe("format");
    expect(await refusalOf(decode(writeTar([{ name: "other.json", data: new Uint8Array(3) }], 0)))).toBe("format");
    expect(await refusalOf(decode(writeTar([{ name: MANIFEST_ENTRY, data: new TextEncoder().encode("{") }, { name: DATA_ENTRY, data }], 0)))).toBe("format");
    expect(await refusalOf(decode(writeTar([{ name: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify({ ...manifest, version: 2 })) }, { name: DATA_ENTRY, data }], 0)))).toBe("format");
    expect(await refusalOf(decode(writeTar([{ name: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify(manifest)) }, { name: DATA_ENTRY, data }, { name: "x", data }], 0)))).toBe("format");
    const dataHeader = 512 + Math.ceil(new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`).length / 512) * 512;
    expect(new TextDecoder().decode(file.subarray(dataHeader, dataHeader + DATA_ENTRY.length))).toBe(DATA_ENTRY);
    const badSum = file.slice();
    badSum[dataHeader + 20]! ^= 1; // a byte of the data entry's header
    expect(await refusalOf(decode(badSum))).toBe("format");
    const badManifest = file.slice();
    badManifest[512] = 0x5b; // the manifest's first character: "[" instead of "{"
    expect(await refusalOf(decode(badManifest))).toBe("format");
    for (const cut of [20, 511, 512, 700, 1024 + 512 + 10, file.length >> 1, file.length - 1024, file.length - 513, file.length - 1])
      expect(await refusalOf(decode(file.subarray(0, cut))), `cut at ${cut}`).toBe("truncated");

    // The data: size, hash.
    expect(await refusalOf(checkData(manifest, data.subarray(1)))).toBe("hash");
    const flipped = data.slice();
    flipped[flipped.length >> 1]! ^= 0x40;
    expect(await refusalOf(checkData(manifest, flipped))).toBe("hash");

    // The data directory: only files and directories inside it, as the manifest describes.
    const tar = await unpackDataDir(manifest, data);
    const entries = readTar(tar, (d) => new SnapshotRefusal("corrupt", d), (d) => new SnapshotRefusal("corrupt", d));
    expect(entries.some((e) => e.name === "/PG_VERSION" && e.type === "file")).toBe(true);
    expect(entries.every((e) => e.name.startsWith("/") && !e.name.includes(".."))).toBe(true);
    const repack = async (files: { name: string; data: Uint8Array }[]) => {
      const t = writeTar(files, 0);
      const gz = await gzip(t);
      return unpackDataDir({ ...manifest, data: { ...manifest.data, bytes: gz.length, tarBytes: t.length, sha256: await sha256Hex(gz) } }, gz);
    };
    const pgVersion = { name: "/PG_VERSION", data: new TextEncoder().encode("18\n") };
    await expect(repack([pgVersion])).resolves.toBeInstanceOf(Uint8Array);
    for (const bad of ["/../lib/postgresql/plpgsql.so", "/base/../../x", "relative", "/a//b", "/./x", "/x\\y"])
      expect(await refusalOf(repack([pgVersion, { name: bad, data: new Uint8Array(1) }])), bad).toBe("corrupt");
    expect(await refusalOf(repack([{ name: "/global/pg_control", data: new Uint8Array(1) }]))).toBe("corrupt");
    const link = writeTar([pgVersion, { name: "/l", data: new Uint8Array(0) }], 0);
    const at = 1024; // the second header: PG_VERSION takes a header and one data block
    expect(new TextDecoder().decode(link.subarray(at, at + 2))).toBe("/l");
    link[at + 156] = 0x32; // type "2", a symbolic link
    let sum = 0;
    for (let i = at; i < at + 512; i++) sum += i >= at + 148 && i < at + 156 ? 32 : link[i]!;
    link.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), at + 148);
    const linkGz = await gzip(link);
    expect(await refusalOf(unpackDataDir({ ...manifest, data: { ...manifest.data, bytes: linkGz.length, tarBytes: link.length, sha256: await sha256Hex(linkGz) } }, linkGz))).toBe("corrupt");
    expect(await refusalOf(unpackDataDir(manifest, new TextEncoder().encode("not gzip at all")))).toBe("corrupt");
    expect(await refusalOf(unpackDataDir({ ...manifest, data: { ...manifest.data, tarBytes: manifest.data.tarBytes - 1 } }, data))).toBe("corrupt");
    expect(await refusalOf(unpackDataDir({ ...manifest, data: { ...manifest.data, tarBytes: manifest.data.tarBytes + 512 } }, data))).toBe("corrupt");

    // The manifest against this engine.
    const expected = { network: "stagenet", genesisHash: manifest.genesisHash, schemaVersions: manifest.schemaVersions, pglite: manifest.pglite };
    const check = async (m: SnapshotManifest) => checkCompatible(m, expected);
    await expect(check(manifest)).resolves.toBeUndefined();
    expect(await refusalOf(check({ ...manifest, network: "preprod" }))).toBe("network");
    expect(await refusalOf(check({ ...manifest, genesisHash: `0x${"ab".repeat(32)}` }))).toBe("network");
    expect(await refusalOf(check({ ...manifest, schemaVersions: { ...manifest.schemaVersions, mip0018: manifest.schemaVersions.mip0018.slice(0, -1) } }))).toBe("schema");
    expect(await refusalOf(check({ ...manifest, schemaVersions: { ...manifest.schemaVersions, chain_archive: [...manifest.schemaVersions.chain_archive, "003_next"] } }))).toBe("schema");
    expect(await refusalOf(check({ ...manifest, pglite: { ...manifest.pglite, version: "0.5.9" } }))).toBe("pglite");
    expect(await refusalOf(check({ ...manifest, pglite: { ...manifest.pglite, serverVersion: "18.4" } }))).toBe("pglite");
  }, 120_000);

  it("[[browser.snapshot.round-trip]] a store exported at height H and imported into a new store holds the same data; the saved configuration continues the archive; a start requests H + 1 first and finishes as an uninterrupted run", async () => {
    const tape = await u1Tape();
    // The source: U1 answered in process, while the engine keeps running after the range's end.
    const a = newHost();
    await result(a, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: MID, ...FAST } });
    await until(a, "U1 up to MID", (s) => s.cursors?.sync?.height === MID && s.cursors.scan?.nextHeight === MID + 1);
    const running = await result<HostStatus>(a, "status");
    expect(running.engine?.running).toBe(true);
    const exported = await result<ExportResult>(a, "export");
    expect((await result<HostStatus>(a, "status")).engine?.running).toBe(true); // export did not stop the engine
    const before = await result<DigestResult>(a, "digest");
    const blockAtMid = tape.blocks.find((b) => b.height === MID)!.blockHash.replace(/^0x/, "");
    expect(exported.manifest).toMatchObject({
      network: "stagenet",
      genesisHash: "0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491",
      archive: { startHeight: U1.from, height: MID, blockHash: blockAtMid },
      scan: { fromHeight: U1.from, nextHeight: MID + 1, lastBlockHash: blockAtMid },
      schemaVersions: { chain_archive: running.store!.migrations.archive, mip0018: running.store!.migrations.mip0018 },
      pglite: { version: "0.5.8", serverVersion: running.store!.serverVersion },
    });
    expect((await result<HostStatus>(a, "status")).snapshots.lastExport).toMatchObject({
      sha256: exported.manifest.data.sha256, bytes: exported.bytes,
      manifest: { network: "stagenet", height: MID, blockHash: blockAtMid, pgliteVersion: "0.5.8" },
    });
    const answers = async (h: WorkerHost) => Promise.all(["/v1/tokens", `/v1/contracts/${"0".repeat(64)}/tokens`].map((t) => apiBody(h, t)));
    const aAnswers = await answers(a);

    // A new store; its chain is the network source, answered from the same tape, with every request recorded.
    const requests: Array<{ method: string; height: number | null }> = [];
    const chain = createTapeFetch(tape);
    const heightOf = new Map(tape.blocks.map((b) => [b.blockHash.replace(/^0x/, ""), b.height]));
    const recording: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: unknown[]; variables?: { height?: number } };
      const method = body.method ?? "indexer";
      const height = method === "chain_getBlockHash" ? Number(body.params?.[0]) : method === "chain_getBlock" ? heightOf.get(String(body.params?.[0]).replace(/^0x/, "")) ?? null : typeof body.variables?.height === "number" ? body.variables.height : null;
      requests.push({ method, height });
      return chain.fetchImpl(input, init);
    };
    const settings = memorySettingsStore();
    const b = newHost({ nodeUrl: chain.nodeUrl, indexerUrl: chain.indexerUrl, fetch: recording, settings });
    await result<HostStatus>(b, "status");
    const imported = await result<ImportResult>(b, "import", { snapshot: exported.file });
    expect(imported.manifest).toEqual(exported.manifest);
    expect(imported.status.cursors).toEqual({ sync: { height: MID, startHeight: U1.from }, scan: { fromHeight: U1.from, nextHeight: MID + 1, lastBlockHash: blockAtMid } });
    expect(imported.status.engine).toBeNull();
    expect(imported.status.store?.migrations).toEqual(running.store!.migrations);
    expect(imported.status.snapshots.lastImport).toMatchObject({ sha256: exported.manifest.data.sha256, bytes: exported.bytes, manifest: { height: MID } });
    expect(imported.status.settings).toEqual({ config: { startHeight: U1.from }, autoStart: false });
    expect(await settings.load()).toEqual({ config: { startHeight: U1.from }, autoStart: false });
    for (const k of ["readMs", "checkMs", "unpackMs", "trialMs", "swapMs", "totalMs"] as const) expect(imported.timings[k]).toBeGreaterThanOrEqual(0);
    expect(await result<DigestResult>(b, "digest")).toEqual({ ...before, elapsedMs: expect.any(Number) });
    expect(await answers(b)).toEqual(aAnswers);
    expect(JSON.parse(await apiBody(b, "/v1/status"))).toMatchObject({ startHeight: U1.from, indexedHeight: MID });
    expect(requests).toEqual([]); // the import read nothing from the chain

    // A start with the saved configuration continues at H + 1.
    await result(b, "start", {});
    await until(b, "U1 to the end", (s) => s.cursors?.sync?.height === U1.to && s.cursors.scan?.nextHeight === U1.to + 1);
    const blockRequests = requests.filter((r) => r.height !== null);
    expect(blockRequests[0]).toEqual({ method: "chain_getBlockHash", height: MID + 1 });
    expect(blockRequests.every((r) => r.height! > MID)).toBe(true);
    for (let h = MID + 1; h <= U1.to; h++) expect(blockRequests.filter((r) => r.height === h && r.method === "chain_getBlockHash"), `height ${h}`).toHaveLength(1);

    // The finished store equals an uninterrupted run of the whole range.
    const whole = await hostWithU1(U1.to);
    const wholeDigest = await result<DigestResult>(whole, "digest");
    const continued = await result<DigestResult>(b, "digest");
    expect(continued.archive.sha256).toBe(U1_ARCHIVE);
    expect(continued.tables.sha256).toBe(wholeDigest.tables.sha256);
  }, 180_000);

  it("[[browser.snapshot.consistent]] exports taken while the sync and the scan write are each one state of the store", async () => {
    const tape = await u1Tape();
    const chain = createTapeFetch(tape);
    // A slow chain, so that the exports fall between the blocks the engine writes.
    const slow: typeof fetch = async (input, init) => {
      await new Promise((r) => setTimeout(r, 4));
      return chain.fetchImpl(input, init);
    };
    const host = newHost({ nodeUrl: chain.nodeUrl, indexerUrl: chain.indexerUrl, fetch: slow });
    await result(host, "start", { config: { startHeight: U1.from, sync: { maxBlocks: 2, concurrency: 1, idleMs: 50 }, scan: { batch: 1, idleMs: 100 } } });
    await until(host, "the first blocks", (s) => (s.cursors?.sync?.height ?? 0) >= U1.from + 1);
    const status = await result<HostStatus>(host, "status");
    const expected = { network: "stagenet", genesisHash: "0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491", schemaVersions: { chain_archive: status.store!.migrations.archive, mip0018: status.store!.migrations.mip0018 }, pglite: { version: "0.5.8", serverVersion: status.store!.serverVersion } };
    const heights: number[] = [];
    for (let i = 0; i < 4; i++) {
      const exported = await result<ExportResult>(host, "export");
      // The trial an import runs: the data directory opened, its cursors, block hash and migrations equal the manifest.
      const prepared = await prepareImport(exported.file, expected);
      expect(prepared.manifest).toEqual(exported.manifest);
      expect(exported.timings.holdMs).toBeLessThan(2_000);
      heights.push(exported.manifest.archive.height);
      if (exported.manifest.scan !== null) expect(exported.manifest.scan.nextHeight).toBeLessThanOrEqual(exported.manifest.archive.height + 1);
    }
    expect([...heights].sort((x, y) => x - y)).toEqual(heights);
    expect(new Set(heights).size, `export heights ${heights.join(", ")}`).toBeGreaterThan(1); // the engine wrote between them
    expect(heights[0]!).toBeLessThan(U1.to);
    const s = await result<HostStatus>(host, "status");
    expect(s.engine?.running).toBe(true);
  }, 120_000);

  it("[[browser.snapshot.refusals]] snapshots of another network, genesis block, schema version or PGlite version, changed, cut short, not a snapshot, or contradicting their manifest are refused with the reason, and nothing changes", async () => {
    const source = await hostWithU1(MID);
    const file = await bytesOf((await result<ExportResult>(source, "export")).file);
    const { manifest, data } = decodeSnapshotFile(file);

    const settings = memorySettingsStore();
    const target = newHost({ settings });
    await result(target, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.from + 5, ...FAST } });
    await until(target, "a few blocks", (s) => s.cursors?.scan?.nextHeight === U1.from + 6);
    const digest = await result<DigestResult>(target, "digest");
    const status = await result<HostStatus>(target, "status");
    expect(status.engine?.running).toBe(true);

    const flipped = data.slice();
    flipped[flipped.length >> 1]! ^= 0x40;
    const cases: Array<[string, Uint8Array, string]> = [
      ["network", withManifest(file, (m) => { m.network = "preprod"; }), "network"],
      ["genesis", withManifest(file, (m) => { m.genesisHash = `0x${"ab".repeat(32)}`; }), "network"],
      ["schema", withManifest(file, (m) => { m.schemaVersions.mip0018.pop(); }), "schema"],
      ["schema, a newer one", withManifest(file, (m) => { m.schemaVersions.mip0018.push("004_later"); }), "schema"],
      ["pglite", withManifest(file, (m) => { m.pglite.version = "0.5.9"; }), "pglite"],
      ["hash", encodeSnapshotFile(manifest, flipped), "hash"],
      ["hash, another sha256", withManifest(file, (m) => { m.data.sha256 = "0".repeat(64); }), "hash"],
      ["truncated, half", file.subarray(0, file.length >> 1), "truncated"],
      ["truncated, last byte", file.subarray(0, file.length - 1), "truncated"],
      ["not a snapshot", new TextEncoder().encode("PGlite data? no."), "format"],
      ["data contradicts the manifest", withManifest(file, (m) => { m.archive.height = MID - 1; }), "corrupt"],
      ["a manifest without the scan cursor", withManifest(file, (m) => { m.scan = null; }), "corrupt"],
    ];
    for (const [name, bytes, reason] of cases) {
      const e = await errorOf(target, "import", { snapshot: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
      expect(e.code, name).toBe("snapshot-refused");
      expect(e.message, name).toMatch(new RegExp(`^${reason}: `));
    }
    // Nothing changed: the engine still runs, and the store holds what it held (the engine ends its range meanwhile).
    const after = await until(target, "the range's end", (s) => s.cursors?.scan?.nextHeight === U1.from + 6);
    expect(after.engine?.running).toBe(true);
    expect(after.snapshots.lastImport).toBeNull();
    expect(after.cursors).toEqual(status.cursors);
    expect(await result<DigestResult>(target, "digest")).toEqual({ ...digest, elapsedMs: expect.any(Number) });
    expect(await settings.load()).toEqual(status.settings);
  }, 180_000);

  it("[[browser.snapshot.journal]] an import journal is finished before PGlite opens the store; an invalid one is dropped; a snapshot that fails to load leaves an empty store; a host booting over a journal reports the import", async () => {
    const source = await hostWithU1(MID);
    const file = await bytesOf((await result<ExportResult>(source, "export")).file);
    const { manifest } = decodeSnapshotFile(file);
    const root = tempDir("umbradb-journal-");
    const storeDir = join(root, "store");
    const journal = join(root, "store.import.snapshot.tar");
    const files = nodeSnapshotFiles(storeDir, journal);
    const facts = async (dir: string) => {
      const s = await openStore(dir);
      try {
        return await readStoreFacts(s.mip0018, "stagenet");
      } finally {
        await s.close();
      }
    };

    // A store with data of its own, half overwritten, and a journal: the open finishes the import.
    const other = await hostWithU1(U1.from + 2, { dataDir: storeDir });
    await closeHost(other);
    const own = await facts(storeDir);
    expect(own.archive?.height).toBe(U1.from + 2);
    writeFileSync(journal, file);
    writeFileSync(join(storeDir, "PG_VERSION"), "garbage");
    const finished = await openFinishingImport((d, o) => openStore(d, o), storeDir, files, "stagenet");
    try {
      expect(finished.imported).toEqual(manifest);
      expect(finished.failure).toBeNull();
      expect((await readStoreFacts(finished.store.mip0018, "stagenet")).archive).toEqual(manifest.archive);
    } finally {
      await finished.store.close();
    }
    expect(existsSync(journal)).toBe(false);

    // An invalid journal (cut short: the swap never started): dropped, the store opens as it was.
    writeFileSync(journal, file.subarray(0, file.length >> 1));
    const kept = await openFinishingImport((d, o) => openStore(d, o), storeDir, files, "stagenet");
    try {
      expect(kept.imported).toBeNull();
      expect((await readStoreFacts(kept.store.mip0018, "stagenet")).archive).toEqual(manifest.archive);
    } finally {
      await kept.store.close();
    }
    expect(existsSync(journal)).toBe(false);

    // A valid journal whose load fails: an empty store, and the failure.
    writeFileSync(journal, file);
    const failing = await openFinishingImport(async (d, o) => {
      const load = await o.prepare?.(d);
      if (load instanceof Blob) throw new Error("no space left");
      return openStore(d, { ...o, prepare: async () => {} });
    }, storeDir, files, "stagenet");
    try {
      expect(failing.imported).toBeNull();
      expect(failing.failure).toContain("no space left");
    } finally {
      await failing.store.close();
    }
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(join(storeDir, "PG_VERSION"))).toBe(true); // a new database (PGlite's initdb)
    const fresh = await openStore(storeDir);
    try {
      expect(await fresh.mip0018`select 1 from pg_namespace where nspname = 'chain_archive'`).toHaveLength(0);
    } finally {
      await fresh.close();
    }

    // A host booting over a journal reports the import and saves the configuration that continues it.
    writeFileSync(journal, file);
    const settings = memorySettingsStore({ config: { source: { kind: "tape", range: "u1" }, startHeight: "tip", endHeight: U1.to }, autoStart: true });
    const host = newHost({ dataDir: storeDir, snapshotFiles: files, settings });
    const s = await result<HostStatus>(host, "status").then(async () => { await host.boot(); return result<HostStatus>(host, "status"); });
    expect(s.boot.phase).toBe("ready");
    expect(s.cursors?.sync).toEqual({ height: MID, startHeight: U1.from });
    expect(s.snapshots.lastImport).toMatchObject({ sha256: manifest.data.sha256, bytes: null, manifest: { height: MID } });
    expect(s.settings).toEqual({ config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from }, autoStart: false });
    expect(existsSync(journal)).toBe(false);
  }, 180_000);

  it("[[browser.snapshot.published]] the published snapshot of 714485–715183 holds the recorded live sync, its index validates, and an import of it answers the API with no chain request", async () => {
    const range = recordedRange();
    expect(range).toMatchObject({ from: 714485, to: 715183, archiveDigest: "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119", tablesDigest: "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c" });
    const out = tempDir("umbradb-published-");
    const index = await writePublishedSnapshots(out, range);
    expect(PublishedSnapshotIndexSchema.parse(JSON.parse(readFileSync(join(out, "snapshots/index.json"), "utf8")))).toEqual(index);
    expect(index.snapshots).toHaveLength(1);
    const entry = index.snapshots[0]!;
    expect(entry).toMatchObject({ name: "idx", file: "umbradb-stagenet-714485-715183.snapshot.tar", digests: { archive: range.archiveDigest, tables: range.tablesDigest } });
    expect(entry.manifest.archive).toMatchObject({ startHeight: 714485, height: 715183 });
    expect(entry.manifest.scan).toMatchObject({ fromHeight: 714485, nextHeight: 715184 });
    const file = new Uint8Array(readFileSync(join(out, "snapshots", entry.file)));
    expect(file.length).toBe(entry.bytes);
    expect(await sha256Hex(file)).toBe(entry.sha256);

    // Imported into a new store: the API answers with no chain request (no fetch at all).
    let fetched = 0;
    const host = newHost({ fetch: (async () => { fetched++; throw new TypeError("no network"); }) as typeof fetch, loadTape: async () => { throw new Error("no tape"); } });
    const imported = await result<ImportResult>(host, "import", { snapshot: new Blob([file as Uint8Array<ArrayBuffer>]) });
    expect(imported.status.cursors?.sync).toEqual({ height: 715183, startHeight: 714485 });
    expect(JSON.parse(await apiBody(host, "/v1/status"))).toMatchObject({ startHeight: 714485, indexedHeight: 715183, archiveHeight: 715183 });
    const tokens = JSON.parse(await apiBody(host, "/v1/tokens")) as { items: unknown[] };
    expect(tokens.items.length).toBeGreaterThan(0);
    const digest = await result<DigestResult>(host, "digest");
    expect(digest.archive.sha256).toBe(range.archiveDigest);
    expect(digest.tables.sha256).toBe(range.tablesDigest);
    expect(fetched).toBe(0);

    // The generator refuses a range whose digests are not the recorded ones.
    await expect(makePublishedSnapshot({ ...range, tablesDigest: "0".repeat(64) }, null)).rejects.toThrow(/does not hold the recorded range/);
  }, 300_000);
});
