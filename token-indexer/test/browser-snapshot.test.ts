/**
 * Snapshots of the browser engine's store (`token-indexer/browser/snapshot.ts`, `snapshot-store.ts`), in Node: the worker
 * host runs on PGlite in memory (`memory://`) or on the Node file system (a store that outlives a host, as an OPFS store
 * outlives a tab), replaying the recorded U1 range (715402–715433) with no network. The same in Chrome, on OPFS, is
 * `browser-snapshot-chrome.test.ts`.
 *
 * - `[[browser.snapshot.file]]` — the file is a tar of `manifest.json` and `rows.tar.gz` (`tar` lists it), the rows one
 *   binary `COPY` entry per table chunk (`tar` lists them too) and the manifest every table with its columns and row
 *   count; everything that is not such a file is refused with its reason: not a snapshot, the earlier format (a whole
 *   database) or another manifest version (`format`), cut short anywhere (`truncated`); rows that are not gzip, not a
 *   tar of `<schema>.<table>.<n>.copy` files, entries out of order or misnumbered, a table this build does not have, rows
 *   that do not load into this build's store or do not match the manifest's counts, a size other than the manifest's
 *   (`corrupt`); another network or genesis block (`network`), other migrations (`schema`), another PGlite or Postgres
 *   version (`pglite`), rows whose size or SHA-256 differs (`hash`).
 * - `[[browser.snapshot.round-trip]]` — a store exported at height H (the engine still running) and imported into a new
 *   store holds the same data (equal archive and range-tables digests, the manifest's cursors, the same API answers);
 *   the saved configuration continues the archive with the automatic start off; a start then requests height H + 1
 *   first and nothing at or below H, and the finished store equals an uninterrupted run (U1's recorded live archive
 *   digest). The system snapshot's Snapshots section holds the same export and import records as `status`.
 * - `[[browser.snapshot.consistent]]` — exports taken while the sync and the scan write are each one state: every
 *   export's manifest equals its own data (cursors, block hash, migrations), its heights never go back, and the session
 *   was held only for the read.
 * - `[[browser.snapshot.refusals]]` — an import of a snapshot of another network, genesis block, schema version or
 *   PGlite version, with a changed byte, cut short, not a snapshot, or whose data contradicts its manifest is refused
 *   with its reason, and the store, the cursors, the saved configuration and a running engine are untouched.
 * - `[[browser.snapshot.journal]]` — a store with an import journal is replaced by the journal's snapshot when it is next
 *   opened (also over a half-written store: its files are removed and PGlite creates the store anew), and the journal
 *   stays until the opener removes it; an invalid journal (the swap never started) is dropped and the store opens as it
 *   was; a journal whose rows fail to load leaves an empty store and the failure; a host booting over a journal reports
 *   the import, saves the continuing configuration and only then removes the journal.
 * - `[[browser.snapshot.published]]` — the build's published snapshot of the recorded range 714485–715183 holds the
 *   recorded live sync (archive digest `cb0d5e21…`, range-tables digest `af6583d0…c832c`) and no NULL `bytea[]`
 *   element, its index validates and lists the three, and an import of it answers the explorer's API with no chain
 *   request; the generator refuses a range whose digests or NULL elements are not the recorded ones.
 * - `[[browser.snapshot.null-elements]]` — the snapshot integrity check the build runs (`snapshotDifferences`) compares
 *   the NULL `bytea[]` elements beside the two digests, which count a NULL element as empty bytes: a snapshot whose
 *   NULL element became empty bytes, or the reverse, has the same digests and is rejected.
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
  decodeSnapshotFile,
  encodeSnapshotFile,
  gzip,
  MANIFEST_ENTRY,
  PublishedSnapshotIndexSchema,
  readRows,
  readTar,
  ROWS_ENTRY,
  type RowsEntry,
  rowsEntryName,
  type SnapshotManifest,
  SnapshotRefusal,
  sha256Hex,
  writeTar,
} from "../browser/snapshot.ts";
import { exportSnapshot, loadSnapshot, openFinishingImport, prepareImport, readStoreFacts } from "../browser/snapshot-store.ts";
import { migrateStore, openStore } from "../browser/store.ts";
import { loadTape } from "../browser/tapes.ts";
import { makePublishedSnapshot, recordedRange, snapshotDifferences, snapshotDigests, writePublishedSnapshots } from "../dev/browser-snapshot.ts";
import { compareNullElements, noNullElements } from "../engine/range-tables.ts";
import { nodeStoreFiles } from "./helpers/worker-host.ts";

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


/** The rows entries of a snapshot's rows, in order. */
async function rowsOf(manifest: SnapshotManifest, data: Uint8Array): Promise<RowsEntry[]> {
  const out: RowsEntry[] = [];
  await readRows(manifest, data, async (e) => { out.push({ ...e, copy: e.copy.slice() }); });
  return out;
}

/** A snapshot file with these rows entries (and the manifest changed by `change`), its rows' size and hash made to
 *  match: a file crafted to pass the hash check. */
async function craft(file: Uint8Array, entries: (rows: RowsEntry[]) => RowsEntry[] | Promise<RowsEntry[]>, change: (m: SnapshotManifest) => void = () => {}): Promise<Uint8Array> {
  const { manifest, data } = decodeSnapshotFile(file);
  const tar = writeTar((await entries(await rowsOf(manifest, data))).map((e) => ({ name: rowsEntryName(e.table, e.chunk), data: e.copy })), 0);
  return craftRaw(file, tar, change);
}

/** A snapshot file whose rows are the gzip of `tar` (any bytes), its manifest's sizes and hash made to match. */
async function craftRaw(file: Uint8Array, tar: Uint8Array, change: (m: SnapshotManifest) => void = () => {}): Promise<Uint8Array> {
  const { manifest } = decodeSnapshotFile(file);
  const gz = await gzip(tar);
  const m = structuredClone(manifest);
  m.data = { ...m.data, bytes: gz.length, sha256: await sha256Hex(gz), tarBytes: tar.length };
  change(m);
  return encodeSnapshotFile(m, gz);
}

describe("browser engine snapshots", () => {
  it("[[browser.snapshot.file]] a snapshot file is a tar of manifest.json and rows.tar.gz, the rows of this build's tables only; anything else, or a manifest this engine cannot take, is refused with its reason", async () => {
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
    expect(execFileSync("tar", ["-tf", join(dir, exported.name)], { encoding: "utf8" }).trim().split("\n")).toEqual([MANIFEST_ENTRY, ROWS_ENTRY]);
    execFileSync("tar", ["-xf", join(dir, exported.name), "-C", dir]);
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_ENTRY), "utf8")) as SnapshotManifest;
    expect(manifest).toEqual(exported.manifest);
    expect(manifest.version).toBe(2);
    const data = new Uint8Array(readFileSync(join(dir, ROWS_ENTRY)));
    expect(await sha256Hex(data)).toBe(manifest.data.sha256);
    expect(data.length).toBe(manifest.data.bytes);
    await checkData(manifest, data);
    // The rows: one binary COPY entry per chunk of each table that holds rows, in the manifest's order.
    const listed = execFileSync("tar", ["-tzf", join(dir, ROWS_ENTRY)], { encoding: "utf8" }).trim().split("\n");
    const entries = await rowsOf(manifest, data);
    expect(listed).toEqual(entries.map((e) => rowsEntryName(e.table, e.chunk)));
    expect(entries.every((e) => new TextDecoder().decode(e.copy.subarray(0, 6)) === "PGCOPY")).toBe(true);
    const order = manifest.tables.map((t) => t.name);
    expect(entries.map((e) => order.indexOf(e.table))).toEqual([...entries.map((e) => order.indexOf(e.table))].sort((a, b) => a - b));
    expect(manifest.tables.map((t) => t.name)).toEqual(expect.arrayContaining(["chain_archive.chain_blobs", "chain_archive.blocks_p0", "chain_archive.blocks_default", "chain_archive.watermarks", "mip0018.mip0018_scan", "mip0018.mip0018_activity"]));
    expect(manifest.tables.some((t) => t.name.endsWith("._migrations"))).toBe(false);
    expect(manifest.tables.find((t) => t.name === "chain_archive.chain_blobs")!.columns).not.toContain("size_bytes"); // generated
    expect(manifest.tables.find((t) => t.name === "chain_archive.blocks_p0")!.rows).toBe(MID - U1.from + 1);
    expect(manifest.sequences).toEqual([{ name: "chain_archive.verifier_key_observations_id_seq", lastValue: expect.stringMatching(/^\d+$/), isCalled: expect.any(Boolean) }]);
    const expected = { network: "stagenet", genesisHash: manifest.genesisHash, schemaVersions: manifest.schemaVersions, pglite: manifest.pglite };
    await expect(prepareImport(new Blob([file as Uint8Array<ArrayBuffer>]), expected)).resolves.toMatchObject({ manifest });

    // The container: not a snapshot, the earlier format, another version, cut short.
    const decode = async (bytes: Uint8Array) => decodeSnapshotFile(bytes);
    expect(await refusalOf(decode(new TextEncoder().encode("hello")))).toBe("format");
    expect(await refusalOf(decode(new Uint8Array(0)))).toBe("format");
    expect(await refusalOf(decode(writeTar([{ name: "other.json", data: new Uint8Array(3) }], 0)))).toBe("format");
    expect(await refusalOf(decode(writeTar([{ name: MANIFEST_ENTRY, data: new TextEncoder().encode("{") }, { name: ROWS_ENTRY, data }], 0)))).toBe("format");
    expect(await refusalOf(decode(writeTar([{ name: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify({ ...manifest, version: 3 })) }, { name: ROWS_ENTRY, data }], 0)))).toBe("format");
    expect(await refusalOf(decode(writeTar([{ name: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify(manifest)) }, { name: ROWS_ENTRY, data }, { name: "x", data }], 0)))).toBe("format");
    expect(await refusalOf(decode(writeTar([{ name: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify(manifest)) }, { name: "data.tar.gz", data }], 0)))).toBe("format");
    const earlier = { ...manifest, version: 1, data: { ...manifest.data, file: "data.tar.gz" } };
    expect(() => decodeSnapshotFile(writeTar([{ name: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify(earlier)) }, { name: "data.tar.gz", data }], 0)))
      .toThrow(/^format: this snapshot has the earlier format \(version 1, a copy of the whole database, which can carry code as well as data\), which this build does not import: export a new snapshot with this build$/);
    const twice = { ...manifest, tables: [...manifest.tables, manifest.tables[0]!] };
    expect(await refusalOf(decode(writeTar([{ name: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify(twice)) }, { name: ROWS_ENTRY, data }], 0)))).toBe("format");
    const dataHeader = 512 + Math.ceil(new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`).length / 512) * 512;
    expect(new TextDecoder().decode(file.subarray(dataHeader, dataHeader + ROWS_ENTRY.length))).toBe(ROWS_ENTRY);
    const badSum = file.slice();
    badSum[dataHeader + 20]! ^= 1; // a byte of the rows entry's header
    expect(await refusalOf(decode(badSum))).toBe("format");
    const badManifest = file.slice();
    badManifest[512] = 0x5b; // the manifest's first character: "[" instead of "{"
    expect(await refusalOf(decode(badManifest))).toBe("format");
    for (const cut of [20, 511, 512, 700, 1024 + 512 + 10, file.length >> 1, file.length - 1024, file.length - 513, file.length - 1])
      expect(await refusalOf(decode(file.subarray(0, cut))), `cut at ${cut}`).toBe("truncated");

    // The rows: size, hash.
    expect(await refusalOf(checkData(manifest, data.subarray(1)))).toBe("hash");
    const flipped = data.slice();
    flipped[flipped.length >> 1]! ^= 0x40;
    expect(await refusalOf(checkData(manifest, flipped))).toBe("hash");

    // The rows, crafted to pass the hash: only this build's tables, in order, numbered, loading, as counted.
    const imports = async (bytes: Uint8Array) => prepareImport(new Blob([bytes as Uint8Array<ArrayBuffer>]), expected);
    const blob = entries.find((e) => e.table === "chain_archive.chain_blobs")!;
    const cases: Array<[string, Uint8Array, RegExp]> = [
      ["not gzip", encodeSnapshotFile({ ...manifest, data: { ...manifest.data, bytes: 15, sha256: await sha256Hex(new TextEncoder().encode("not gzip at all")) } }, new TextEncoder().encode("not gzip at all")), /do not decompress/],
      ["unpacks to fewer bytes than declared", await craftRaw(file, writeTar([], 0), (m) => { m.data.tarBytes += 512; }), /unpack to 1024 bytes; the manifest says 1536/],
      ["unpacks to more bytes than declared", await craftRaw(file, writeTar(entries.map((e) => ({ name: rowsEntryName(e.table, e.chunk), data: e.copy })), 0), (m) => { m.data.tarBytes = 1024; }), /more than the manifest's 1024 bytes/],
      ["a directory entry", await craftRaw(file, ((t) => { t[156] = 0x35; let n = 0; for (let i = 0; i < 512; i++) n += i >= 148 && i < 156 ? 32 : t[i]!; t.set(new TextEncoder().encode(`${n.toString(8).padStart(6, "0")}\0 `), 148); return t; })(writeTar([{ name: rowsEntryName(blob.table, 0), data: new Uint8Array(0) }], 0))), /is not a plain file/],
      ["an entry named otherwise", await craftRaw(file, writeTar([{ name: "../x.copy", data: blob.copy }], 0)), /is not named <schema>\.<table>\.<n>\.copy/],
      ["a table this build does not have", await craft(file, (r) => [{ ...r[0]!, table: "public.pwned" }, ...r.slice(1)]), /public\.pwned, which is not a table of this build/],
      ["out of order", await craft(file, (r) => [...r].reverse()), /come after those of a table that is loaded after it/],
      ["misnumbered", await craft(file, (r) => r.map((e) => (e === r[0] ? { ...e, chunk: 1 } : e))), /numbered 1 where 0 was due/],
      ["a row too few", await craft(file, (r) => r.filter((e) => e.table !== "mip0018.mip0018_scan")), /the rows of mip0018\.mip0018_scan are 0; the manifest says 1/],
      ["a manifest table this build does not have", await craft(file, (r) => r, (m) => { m.tables.push({ name: "public.pwned", columns: ["what"], rows: 0 }); }), /public\.pwned\(what\) is not a table of this build/],
      ["another column list", await craft(file, (r) => r, (m) => { m.tables[0]!.columns = [...m.tables[0]!.columns].reverse(); }), /is missing/],
      ["rows that break a constraint", await craft(file, (r) => r.filter((e) => e.table !== "chain_archive.chain_blobs")), /do not load into this build's store: .*(foreign key|chain_blob)/],
      ["not a COPY stream", await craft(file, (r) => r.map((e) => (e.table === "chain_archive.watermarks" ? { ...e, copy: new TextEncoder().encode("watermark rows, as text") } : e))), /chain_archive\.watermarks \(entry 0\) do not load/],
      ["another sequence", await craft(file, (r) => r, (m) => { m.sequences = [{ ...m.sequences[0]!, name: "chain_archive.other_seq" }]; }), /sequences \[chain_archive\.other_seq\] are not this build's/],
      ["facts other than the manifest's", await craft(file, (r) => r, (m) => { m.archive.height = MID - 1; }), /does not match its manifest: its archive is/],
    ];
    for (const [name, bytes, message] of cases) {
      const e = await imports(bytes).then(() => undefined, (x: unknown) => x);
      expect(e, name).toBeInstanceOf(SnapshotRefusal);
      expect((e as SnapshotRefusal).reason, name).toBe("corrupt");
      expect((e as SnapshotRefusal).message, name).toMatch(message);
    }

    // The manifest against this engine.
    const check = async (m: SnapshotManifest) => checkCompatible(m, expected);
    await expect(check(manifest)).resolves.toBeUndefined();
    expect(await refusalOf(check({ ...manifest, network: "preprod" }))).toBe("network");
    expect(await refusalOf(check({ ...manifest, genesisHash: `0x${"ab".repeat(32)}` }))).toBe("network");
    expect(await refusalOf(check({ ...manifest, schemaVersions: { ...manifest.schemaVersions, mip0018: manifest.schemaVersions.mip0018.slice(0, -1) } }))).toBe("schema");
    expect(await refusalOf(check({ ...manifest, schemaVersions: { ...manifest.schemaVersions, chain_archive: [...manifest.schemaVersions.chain_archive, "003_next"] } }))).toBe("schema");
    expect(await refusalOf(check({ ...manifest, pglite: { ...manifest.pglite, version: "0.5.9" } }))).toBe("pglite");
    expect(await refusalOf(check({ ...manifest, pglite: { ...manifest.pglite, serverVersion: "18.4" } }))).toBe("pglite");
    // The trial's store is this build's PGlite: a manifest of another PGlite is refused by it as well.
    const { pglite: _pglite, ...withoutPglite } = expected;
    const otherPglite = await craft(file, (r) => r, (m) => { m.pglite.version = "0.5.9"; });
    expect(await refusalOf(prepareImport(new Blob([otherPglite as Uint8Array<ArrayBuffer>]), withoutPglite))).toBe("pglite");
  }, 180_000);

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
    for (const k of ["readMs", "checkMs", "stageMs", "swapMs", "totalMs"] as const) expect(imported.timings[k]).toBeGreaterThanOrEqual(0);
    expect(await result<DigestResult>(b, "digest")).toEqual({ ...before, elapsedMs: expect.any(Number) });
    expect(await answers(b)).toEqual(aAnswers);
    expect(JSON.parse(await apiBody(b, "/v1/status"))).toMatchObject({ startHeight: U1.from, indexedHeight: MID });
    // The system snapshot's Snapshots section shows the same records (the source's export, this store's import).
    const sys = async (h: WorkerHost) => (await result<{ snapshot: { snapshots: unknown } }>(h, "system", { refresh: {} })).snapshot.snapshots;
    expect(await sys(a)).toEqual((await result<HostStatus>(a, "status")).snapshots);
    expect(await sys(b)).toEqual({ lastExport: null, lastImport: imported.status.snapshots.lastImport });
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
      // The trial an import runs: the rows loaded into a new store, its cursors, block hash and migrations equal the
      // manifest.
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

  it("[[browser.snapshot.journal]] an import journal replaces the store when it is next opened and stays until removed; an invalid one is dropped; rows that fail to load leave an empty store; a host booting over a journal saves the continuing configuration, then removes the journal", async () => {
    const source = await hostWithU1(MID);
    const file = await bytesOf((await result<ExportResult>(source, "export")).file);
    const { manifest } = decodeSnapshotFile(file);
    const root = tempDir("umbradb-journal-");
    const storeDir = join(root, "store");
    const journal = join(root, "store.import.snapshot.tar");
    const files = nodeStoreFiles(storeDir, journal);
    const facts = async (dir: string) => {
      const s = await openStore(dir);
      try {
        return await readStoreFacts(s.mip0018, "stagenet");
      } finally {
        await s.close();
      }
    };

    // A store with data of its own, half overwritten, and a journal: the open replaces the store with the snapshot.
    const other = await hostWithU1(U1.from + 2, { dataDir: storeDir });
    await closeHost(other);
    const own = await facts(storeDir);
    expect(own.archive?.height).toBe(U1.from + 2);
    writeFileSync(journal, file);
    writeFileSync(join(storeDir, "PG_VERSION"), "garbage");
    const importing: Array<SnapshotManifest | null> = [];
    const finished = await openFinishingImport((d, o) => openStore(d, o), storeDir, files, "stagenet", { beforeOpen: async (_d, m) => { importing.push(m); } });
    try {
      expect(importing).toEqual([manifest]);
      expect(finished.imported).toEqual(manifest);
      expect(finished.failure).toBeNull();
      expect(finished.store.created).toBe(true);
      expect((await readStoreFacts(finished.store.mip0018, "stagenet")).archive).toEqual(manifest.archive);
    } finally {
      await finished.store.close();
    }
    expect(existsSync(journal), "the journal stays until the opener removes it").toBe(true);
    await files.removeJournal();

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

    // `discardJournal` (a reset): the journal is dropped, not finished.
    writeFileSync(journal, file);
    const discarded = await openFinishingImport((d, o) => openStore(d, o), storeDir, files, "stagenet", { discardJournal: true });
    try {
      expect(discarded.imported).toBeNull();
    } finally {
      await discarded.store.close();
    }
    expect(existsSync(journal)).toBe(false);

    // A valid journal whose rows fail to load (here: the blobs left out, so a block references none): an empty store,
    // and the failure.
    writeFileSync(journal, await craft(file, (r) => r.filter((e) => e.table !== "chain_archive.chain_blobs")));
    const failing = await openFinishingImport((d, o) => openStore(d, o), storeDir, files, "stagenet");
    try {
      expect(failing.imported).toBeNull();
      expect(failing.failure).toMatch(/^the snapshot could not be loaded: corrupt: the rows of chain_archive\./);
      expect(await failing.store.mip0018`select 1 from pg_namespace where nspname = 'chain_archive'`).toHaveLength(0);
    } finally {
      await failing.store.close();
    }
    expect(existsSync(journal)).toBe(false);

    // A host booting over a journal reports the import and saves the configuration that continues it; the journal is
    // removed only after that.
    writeFileSync(journal, file);
    const settings = memorySettingsStore({ config: { source: { kind: "tape", range: "u1" }, startHeight: "tip", endHeight: U1.to }, autoStart: true });
    let journalAtSave: boolean | undefined;
    const watched = { ...settings, save: async (x: Parameters<typeof settings.save>[0]) => { journalAtSave = existsSync(journal); await settings.save(x); } };
    const host = newHost({ dataDir: storeDir, snapshotFiles: files, settings: watched });
    const s = await result<HostStatus>(host, "status").then(async () => { await host.boot(); return result<HostStatus>(host, "status"); });
    expect(s.boot.phase).toBe("ready");
    expect(s.cursors?.sync).toEqual({ height: MID, startHeight: U1.from });
    expect(s.snapshots.lastImport).toMatchObject({ sha256: manifest.data.sha256, bytes: null, manifest: { height: MID } });
    expect(s.settings).toEqual({ config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from }, autoStart: false });
    expect(journalAtSave, "the journal is still on file while the continuing configuration is saved").toBe(true);
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
    expect(range.nullElements).toEqual(noNullElements(["mip0018.mip0018_contract_actions"]));
    expect(entry).toMatchObject({ name: "idx", file: "umbradb-stagenet-714485-715183.snapshot.tar", digests: { archive: range.archiveDigest, tables: range.tablesDigest, nullElements: range.nullElements } });
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
    expect(compareNullElements(digest.nullElements, range.nullElements)).toEqual([]);
    expect(fetched).toBe(0);

    // The generator refuses a range whose digests are not the recorded ones, the NULL bytea[] elements included.
    await expect(makePublishedSnapshot({ ...range, tablesDigest: "0".repeat(64) }, null)).rejects.toThrow(/does not hold the recorded range/);
    const oneNull = { "mip0018.mip0018_contract_actions": { count: 1, sha256: "0".repeat(64) } };
    await expect(makePublishedSnapshot({ ...range, nullElements: oneNull }, null)).rejects.toThrow(/does not hold the recorded range: .*mip0018\.mip0018_contract_actions/);
  }, 300_000);

  it("[[browser.snapshot.null-elements]] the snapshot integrity check tells a NULL bytea[] element from an empty one, which the archive and range-tables digests cannot: a snapshot whose NULL element became empty bytes, or whose empty element became NULL, is rejected against the other's digests", async () => {
    const host = await hostWithU1(MID);
    const base = await bytesOf((await result<ExportResult>(host, "export")).file);
    const key = "mip0018.mip0018_contract_actions";
    // The base snapshot with one more maintenance action whose operations are `operations`, exported again.
    const variant = async (operations: string): Promise<Uint8Array> => {
      const { manifest, data } = decodeSnapshotFile(base);
      const store = await openStore("memory://");
      try {
        await migrateStore(store);
        await loadSnapshot(store, manifest, data, manifest.network);
        await store.mip0018.unsafe(`INSERT INTO mip0018.mip0018_contract_actions (network, block_height, tx_index, segment_id, action_index, tx_hash, action, contract_address, maintenance_counter, maintenance_updates, maintenance_operations)
          VALUES ('stagenet', ${MID}, 0, 0, 99, decode('${"11".repeat(32)}', 'hex'), 'maintenance', decode('${"22".repeat(32)}', 'hex'), 1, ARRAY['VerifierKeyInsert'], ${operations})`);
        const out = await exportSnapshot(store, { network: manifest.network, genesisHash: manifest.genesisHash, appCommit: null, now: () => Date.parse(manifest.createdAt) });
        return bytesOf(out.file);
      } finally {
        await store.close();
      }
    };
    const withNull = await variant("ARRAY[NULL]::bytea[]");
    const withEmpty = await variant("ARRAY['\\x'::bytea]");
    const nullDigests = await snapshotDigests(withNull);
    const emptyDigests = await snapshotDigests(withEmpty);
    // The archive and range-tables digests count a NULL element as empty bytes: they cannot tell the two apart.
    expect([emptyDigests.archive, emptyDigests.tables]).toEqual([nullDigests.archive, nullDigests.tables]);
    expect([nullDigests.nullElements[key]!.count, emptyDigests.nullElements[key]!.count]).toEqual([1, 0]);
    // The integrity check: each file holds its own digests and is rejected against the other's, in both directions.
    expect((await snapshotDifferences(withNull, nullDigests)).differences).toEqual([]);
    expect((await snapshotDifferences(withEmpty, emptyDigests)).differences).toEqual([]);
    const nullToEmpty = (await snapshotDifferences(withEmpty, nullDigests)).differences;
    const emptyToNull = (await snapshotDifferences(withNull, emptyDigests)).differences;
    expect(nullToEmpty).toEqual([expect.stringContaining(`${key}: 0 NULL bytea[] elements`)]);
    expect(emptyToNull).toEqual([expect.stringContaining(`${key}: 1 NULL bytea[] elements`)]);
  }, 180_000);
});
