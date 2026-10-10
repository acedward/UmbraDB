/**
 * Writes the snapshots the static browser build publishes, into `<out>/snapshots/` (`npm run build:browser` runs it on
 * `dist-browser/` after Vite): today one, `idx`, the recorded Stagenet range 714485–715183.
 *
 * The snapshot is made the way a browser makes one: the browser engine's worker host (`token-indexer/browser/host.ts`)
 * runs in Node on an in-memory PGlite (the same PGlite build as the browser's), replays the range's gzip tape
 * (`token-indexer/browser/tapes/`) through the sync and the scan, and answers an `export` request. The file is then
 * read back as an import reads it (`snapshot.ts`: container, manifest, SHA-256), its rows are loaded into a new store made
 * by the migrations (`snapshot-store.ts`, as an import's trial does), and that store's archive digest, range-tables
 * digest and NULL `bytea[]` elements (which the range-tables digest counts as empty bytes, `range-tables.ts`) are
 * computed there and compared with the recorded live sync of the same range (`test/integration/fixtures/stagenet-archive/manifest.json` and
 * `token-indexer/test/fixtures/live-range/stagenet-714485-715183.json`; the range holds no NULL `bytea[]` element):
 * a snapshot that differs in any of the three is not written ({@link snapshotDifferences}).
 * `snapshots/index.json` lists the file with its size, SHA-256, manifest and the three (`PublishedSnapshotIndexSchema`).
 *
 * The file's bytes depend on the range, the build and one time only, so two builds of one commit write the same bytes:
 * the exported file is remade ({@link snapshotAt}) with that time as the manifest's `createdAt`, as its tar entries'
 * times, and as every wall-clock value of its rows (when a row was written: the `timestamp` columns, which the digests
 * do not read). The time is `SOURCE_DATE_EPOCH` (seconds) when set, else the time of the build's commit, else the time
 * the range was recorded ({@link publishedTime}); never the clock.
 *
 *   node --import tsx token-indexer/dev/browser-snapshot.ts [--out dist-browser]
 *
 * The build's commit in the manifest is `UMBRADB_APP_COMMIT`, else `git rev-parse HEAD`, else none.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { archiveDigest, dumpArchive } from "../../test/integration/fixtures/stagenet-archive/archive-digest.js";
import { createWorkerHost } from "../browser/host.ts";
import { type ExportResult, type HostStatus, PROTOCOL_VERSION, type Response } from "../browser/protocol.ts";
import {
  checkData,
  decodeSnapshotFile,
  encodeRows,
  encodeSnapshotFile,
  PUBLISHED_INDEX_FORMAT,
  PUBLISHED_INDEX_PATH,
  type PublishedSnapshotIndex,
  PublishedSnapshotIndexSchema,
  readRows,
  type RowsEntry,
  sha256Hex,
  type SnapshotManifest,
  SnapshotManifestSchema,
} from "../browser/snapshot.ts";
import { loadSnapshot } from "../browser/snapshot-store.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA, migrateStore, openStore } from "../browser/store.ts";
import { loadTape } from "../browser/tapes.ts";
import { compareNullElements, type NullElements, noNullElements, rangeTables } from "./range-tables.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The recorded range a published snapshot holds, and the digests of its recorded live sync. */
export interface PublishedRange {
  name: string;
  tape: "idx";
  from: number;
  to: number;
  archiveDigest: string;
  tablesDigest: string;
  /** The NULL `bytea[]` elements of the range's tables, which the range-tables digest counts as empty bytes. */
  nullElements: NullElements;
}

/** What a snapshot's store holds, as the integrity check compares it: the archive digest, the range-tables digest and
 *  the NULL `bytea[]` elements beside it. */
export interface SnapshotDigests {
  archive: string;
  tables: string;
  nullElements: NullElements;
}

/** The recorded digests of the range `name` (`idx`). */
export function recordedRange(name = "idx"): PublishedRange {
  const manifest = JSON.parse(readFileSync(join(ROOT, "test/integration/fixtures/stagenet-archive/manifest.json"), "utf8")) as {
    ranges: Array<{ name: string; from: number; to: number; liveSync: { archiveDigest: { sha256: string } } }>;
  };
  const range = manifest.ranges.find((r) => r.name === name);
  if (range === undefined || name !== "idx") throw new Error(`no recorded range ${JSON.stringify(name)} to publish`);
  const live = JSON.parse(readFileSync(join(ROOT, "token-indexer/test/fixtures/live-range/stagenet-714485-715183.json"), "utf8")) as {
    range: { from: number; to: number };
    liveTables: { sha256: string };
  };
  if (live.range.from !== range.from || live.range.to !== range.to) throw new Error("the live-range fixture is not the idx range");
  // The range holds no NULL `bytea[]` element (`[[mip0018.live-range.replay-equals-live]]` checks its replay).
  const nullElements = noNullElements(["mip0018.mip0018_contract_actions"]);
  return { name, tape: "idx", from: range.from, to: range.to, archiveDigest: range.liveSync.archiveDigest.sha256, tablesDigest: live.liveTables.sha256, nullElements };
}

/** `fetch` for the tape catalog's `file:` URLs. */
const fileFetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  return new Response(new Uint8Array(readFileSync(fileURLToPath(url))));
}) as typeof fetch;

/** PostgreSQL's epoch, 2000-01-01T00:00:00Z, in Unix milliseconds: a binary `timestamp` value counts microseconds from it. */
const PG_EPOCH_MS = Date.UTC(2000, 0, 1);

/**
 * The time of a published snapshot, epoch milliseconds in whole seconds: `SOURCE_DATE_EPOCH` (seconds, the
 * reproducible-builds convention) when set, else the committer time of the checkout's `HEAD`, else the time the
 * recorded ranges were captured (`recordedAt` of the fixtures' manifest).
 */
export function publishedTime(): number {
  const env = process.env.SOURCE_DATE_EPOCH;
  if (env !== undefined && env !== "") {
    if (!/^\d{1,12}$/.test(env)) throw new Error(`SOURCE_DATE_EPOCH must be whole seconds, got ${JSON.stringify(env)}`);
    return Number(env) * 1000;
  }
  try {
    const seconds = execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^\d+$/.test(seconds)) return Number(seconds) * 1000;
  } catch {
    // not a git checkout
  }
  const { recordedAt } = JSON.parse(readFileSync(join(ROOT, "test/integration/fixtures/stagenet-archive/manifest.json"), "utf8")) as { recordedAt: string };
  return Math.floor(Date.parse(recordedAt) / 1000) * 1000;
}

/** For each table of a snapshot that has wall-clock columns, their positions in the manifest's column list; the column
 *  types are read from a store made by this build's migrations. A `date`, `time` or `interval` column is refused (no
 *  table has one; {@link snapshotAt} rewrites 8-byte timestamps only). */
async function wallClockColumns(manifest: SnapshotManifest): Promise<Map<string, Set<number>>> {
  const store = await openStore("memory://");
  try {
    await migrateStore(store);
    const sql = store.mip0018;
    const rows = await sql<{ table_schema: string; table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema IN (${ARCHIVE_SCHEMA}, ${MIP0018_SCHEMA}) AND data_type ~ '^(timestamp|date|time|interval)'`;
    const out = new Map<string, Set<number>>();
    for (const t of manifest.tables) {
      const positions = new Set<number>();
      for (const r of rows.filter((x) => `${x.table_schema}.${x.table_name}` === t.name)) {
        const i = t.columns.indexOf(r.column_name);
        if (i === -1) continue;
        if (!r.data_type.startsWith("timestamp")) throw new Error(`${t.name}.${r.column_name} is a ${r.data_type} column: a published snapshot rewrites timestamp columns only`);
        positions.add(i);
      }
      if (positions.size > 0) out.set(t.name, positions);
    }
    return out;
  } finally {
    await store.close();
  }
}

/** A binary COPY chunk (header, rows, trailer) with every non-NULL value of the columns at `positions` (8-byte
 *  timestamps) set to `micros`. */
function setTimestamps(copy: Uint8Array, positions: ReadonlySet<number>, micros: bigint): Uint8Array {
  const out = copy.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let at = 11 + 4; // signature, flags
  at += 4 + view.getInt32(at); // header extension
  for (;;) {
    const fields = view.getInt16(at);
    at += 2;
    if (fields === -1) return out;
    for (let f = 0; f < fields; f++) {
      const length = view.getInt32(at);
      at += 4;
      if (length < 0) continue;
      if (positions.has(f)) {
        if (length !== 8) throw new Error(`a timestamp value of ${length} bytes in a binary COPY row`);
        view.setBigInt64(at, micros);
      }
      at += length;
    }
  }
}

/**
 * The snapshot `file` remade so that its bytes depend on its rows and `at` (epoch milliseconds, whole seconds) only:
 * `at` is its manifest's `createdAt`, its tar entries' times and every wall-clock value of its rows (when a row was
 * written). What the digests read is unchanged.
 */
export async function snapshotAt(file: Uint8Array, at: number): Promise<Uint8Array> {
  if (!Number.isInteger(at / 1000)) throw new RangeError(`a snapshot's time is whole seconds, got ${at} ms`);
  const { manifest, data } = decodeSnapshotFile(file);
  await checkData(manifest, data);
  const columns = await wallClockColumns(manifest);
  const micros = BigInt(at - PG_EPOCH_MS) * 1000n;
  const entries: RowsEntry[] = [];
  await readRows(manifest, data, async (e) => {
    const positions = columns.get(e.table);
    entries.push({ ...e, copy: positions === undefined ? e.copy.slice() : setTimestamps(e.copy, positions, micros) });
  });
  const rows = await encodeRows(entries, at / 1000);
  const remade = SnapshotManifestSchema.parse({
    ...manifest,
    createdAt: new Date(at).toISOString(),
    data: { ...manifest.data, bytes: rows.data.length, sha256: await sha256Hex(rows.data), tarBytes: rows.tarBytes },
  });
  return encodeSnapshotFile(remade, rows.data);
}

function appCommit(): string | null {
  const env = process.env.UMBRADB_APP_COMMIT;
  if (env !== undefined && env !== "") return env;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The archive digest, the range-tables digest and the NULL `bytea[]` elements of a snapshot file's store (its rows
 *  loaded into a new store). */
export async function snapshotDigests(file: Uint8Array): Promise<{ manifest: SnapshotManifest } & SnapshotDigests> {
  const { manifest, data } = decodeSnapshotFile(file);
  await checkData(manifest, data);
  const store = await openStore("memory://");
  try {
    await migrateStore(store);
    await loadSnapshot(store, manifest, data, manifest.network);
    const archive = archiveDigest(await dumpArchive(store.mip0018, ARCHIVE_SCHEMA)).sha256;
    const { digest, nullElements } = await rangeTables(store.mip0018, ARCHIVE_SCHEMA, MIP0018_SCHEMA);
    return { manifest, archive, tables: digest.sha256, nullElements };
  } finally {
    await store.close();
  }
}

/** The integrity check of a snapshot file against what its store must hold: how its digests and NULL `bytea[]`
 *  elements differ from `expected` (none: it holds them). */
export async function snapshotDifferences(file: Uint8Array, expected: SnapshotDigests): Promise<{ manifest: SnapshotManifest; digests: SnapshotDigests; differences: string[] }> {
  const { manifest, archive, tables, nullElements } = await snapshotDigests(file);
  const differences: string[] = [];
  if (archive !== expected.archive) differences.push(`archive digest ${archive} (expected ${expected.archive})`);
  if (tables !== expected.tables) differences.push(`range-tables digest ${tables} (expected ${expected.tables})`);
  differences.push(...compareNullElements(nullElements, expected.nullElements));
  return { manifest, digests: { archive, tables, nullElements }, differences };
}

/** Makes the snapshot of `range` at time `at` (see the module documentation); resolves with the file and its checked
 *  digests. */
export async function makePublishedSnapshot(range: PublishedRange = recordedRange(), commit: string | null = appCommit(), at: number = publishedTime()): Promise<{ file: Uint8Array; name: string; manifest: SnapshotManifest; digests: SnapshotDigests }> {
  let nextId = 1;
  const host = createWorkerHost({
    network: "stagenet",
    dataDir: "memory://",
    nodeUrl: "https://node.invalid/",
    indexerUrl: "https://indexer.invalid/",
    checkCapabilities: async () => ({
      supported: true,
      message: "",
      missing: [],
      checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: true },
      browser: null,
    }),
    loadTape: (r) => loadTape(r, fileFetch),
    build: { appCommit: commit, pgliteVersion: null, ledgerVersion: null },
    log: (level, message) => { if (level === "error") console.error(message); },
  });
  const call = async <T>(type: string, params: Record<string, unknown> = {}): Promise<T> => {
    const r: Response = await host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
    if (!r.ok) throw new Error(`${type}: ${r.error.code}: ${r.error.message}`);
    return r.result as T;
  };
  try {
    const boot = await host.boot();
    if (boot.phase !== "ready") throw new Error(`the host did not boot: ${boot.error}`);
    await call("start", { config: { source: { kind: "tape", range: range.tape }, startHeight: range.from, endHeight: range.to, sync: { maxBlocks: 100, idleMs: 50 }, scan: { batch: 100, idleMs: 100 } } });
    const deadline = Date.now() + 300_000;
    for (;;) {
      const s = await call<HostStatus>("status");
      if (s.engine?.error) throw new Error(`the engine failed: ${s.engine.error}`);
      if (s.cursors?.sync?.height === range.to && s.cursors.scan?.nextHeight === range.to + 1) break;
      if (Date.now() > deadline) throw new Error(`the replay of ${range.from}–${range.to} did not finish: ${JSON.stringify(s.cursors)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    await call("stop");
    const exported = await call<ExportResult>("export");
    const file = await snapshotAt(new Uint8Array(await exported.file.arrayBuffer()), at);
    const { manifest, digests, differences } = await snapshotDifferences(file, { archive: range.archiveDigest, tables: range.tablesDigest, nullElements: range.nullElements });
    if (differences.length > 0) throw new Error(`the snapshot of ${range.from}–${range.to} does not hold the recorded range: ${differences.join("; ")}`);
    return { file, name: exported.name, manifest, digests };
  } finally {
    await host.close();
  }
}

/** Writes `<out>/snapshots/<file>` and `<out>/snapshots/index.json`; resolves with the index. */
export async function writePublishedSnapshots(out: string, range: PublishedRange = recordedRange()): Promise<PublishedSnapshotIndex> {
  const made = await makePublishedSnapshot(range);
  const dir = join(out, "snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, made.name), made.file);
  const index = PublishedSnapshotIndexSchema.parse({
    format: PUBLISHED_INDEX_FORMAT,
    version: 1,
    snapshots: [{ name: range.name, file: made.name, bytes: made.file.length, sha256: await sha256Hex(made.file), manifest: made.manifest, digests: made.digests }],
  });
  writeFileSync(join(out, PUBLISHED_INDEX_PATH), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string", default: join(ROOT, "dist-browser") } } });
  const t0 = performance.now();
  const index = await writePublishedSnapshots(resolve(values.out!));
  for (const s of index.snapshots)
    console.log(`snapshots/${s.file}: ${s.bytes} bytes, sha256 ${s.sha256}; ${s.manifest.network} ${s.manifest.archive.startHeight}–${s.manifest.archive.height}; archive ${s.digests.archive}, tables ${s.digests.tables}, NULL bytea[] elements ${Object.values(s.digests.nullElements).reduce((n, x) => n + x.count, 0)} (${Math.round(performance.now() - t0)} ms)`);
}
