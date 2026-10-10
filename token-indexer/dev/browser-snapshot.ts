/**
 * Writes the snapshots the static browser build publishes, into `<out>/snapshots/` (`npm run build:browser` runs it on
 * `dist-browser/` after Vite): today one, `idx`, the recorded Stagenet range 714485–715183.
 *
 * The snapshot is made the way a browser makes one: the browser engine's worker host (`token-indexer/browser/host.ts`)
 * runs in Node on an in-memory PGlite (the same PGlite build as the browser's), replays the range's gzip tape
 * (`token-indexer/browser/tapes/`) through the sync and the scan, and answers an `export` request. The file is then
 * read back as an import reads it (`snapshot.ts`: container, manifest, SHA-256, data directory), its data directory is
 * loaded into a new PGlite, and the store's archive digest and range-tables digest are computed there and compared with
 * the recorded live sync of the same range (`test/integration/fixtures/stagenet-archive/manifest.json` and
 * `token-indexer/test/fixtures/live-range/stagenet-714485-715183.json`): a snapshot whose digests differ is not written.
 * `snapshots/index.json` lists the file with its size, SHA-256, manifest and digests (`PublishedSnapshotIndexSchema`).
 *
 * The file's bytes differ from build to build (the manifest's time, the data directory's file times and the identifier
 * PGlite's `initdb` gives each new database); what it holds, as the two digests describe it, does not.
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
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";
import { archiveDigest, dumpArchive } from "../../test/integration/fixtures/stagenet-archive/archive-digest.js";
import { createWorkerHost } from "../browser/host.ts";
import { type ExportResult, type HostStatus, PROTOCOL_VERSION, type Response } from "../browser/protocol.ts";
import {
  decodeSnapshotFile,
  PUBLISHED_INDEX_FORMAT,
  PUBLISHED_INDEX_PATH,
  type PublishedSnapshotIndex,
  PublishedSnapshotIndexSchema,
  sha256Hex,
  type SnapshotManifest,
  unpackDataDir,
} from "../browser/snapshot.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA } from "../browser/store.ts";
import { loadTape } from "../browser/tapes.ts";
import { rangeTables } from "./range-tables.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The recorded range a published snapshot holds, and the digests of its recorded live sync. */
export interface PublishedRange {
  name: string;
  tape: "idx";
  from: number;
  to: number;
  archiveDigest: string;
  tablesDigest: string;
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
  return { name, tape: "idx", from: range.from, to: range.to, archiveDigest: range.liveSync.archiveDigest.sha256, tablesDigest: live.liveTables.sha256 };
}

/** `fetch` for the tape catalog's `file:` URLs. */
const fileFetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  return new Response(new Uint8Array(readFileSync(fileURLToPath(url))));
}) as typeof fetch;

function appCommit(): string | null {
  const env = process.env.UMBRADB_APP_COMMIT;
  if (env !== undefined && env !== "") return env;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The archive digest and the range-tables digest of a snapshot file's store (its data directory loaded into PGlite). */
export async function snapshotDigests(file: Uint8Array): Promise<{ manifest: SnapshotManifest; archive: string; tables: string }> {
  const { manifest, data } = decodeSnapshotFile(file);
  const tar = await unpackDataDir(manifest, data);
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = await PGlite.create({ dataDir: "memory://", loadDataDir: new Blob([tar as Uint8Array<ArrayBuffer>], { type: "application/x-tar" }) });
  try {
    const sql = createPgliteClient({ pglite: pg, schema: MIP0018_SCHEMA });
    const archive = archiveDigest(await dumpArchive(sql, ARCHIVE_SCHEMA)).sha256;
    const { digest } = await rangeTables(sql, ARCHIVE_SCHEMA, MIP0018_SCHEMA);
    return { manifest, archive, tables: digest.sha256 };
  } finally {
    await pg.close();
  }
}

/** Makes the snapshot of `range` (see the module documentation); resolves with the file and its checked digests. */
export async function makePublishedSnapshot(range: PublishedRange = recordedRange(), commit: string | null = appCommit()): Promise<{ file: Uint8Array; name: string; manifest: SnapshotManifest; digests: { archive: string; tables: string } }> {
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
    appCommit: commit,
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
    const file = new Uint8Array(await exported.file.arrayBuffer());
    const digests = await snapshotDigests(file);
    if (digests.archive !== range.archiveDigest || digests.tables !== range.tablesDigest)
      throw new Error(
        `the snapshot of ${range.from}–${range.to} does not hold the recorded range: archive digest ${digests.archive} (recorded ${range.archiveDigest}), ` +
          `range-tables digest ${digests.tables} (recorded ${range.tablesDigest})`,
      );
    return { file, name: exported.name, manifest: exported.manifest, digests: { archive: digests.archive, tables: digests.tables } };
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
    console.log(`snapshots/${s.file}: ${s.bytes} bytes, sha256 ${s.sha256}; ${s.manifest.network} ${s.manifest.archive.startHeight}–${s.manifest.archive.height}; archive ${s.digests.archive}, tables ${s.digests.tables} (${Math.round(performance.now() - t0)} ms)`);
}
