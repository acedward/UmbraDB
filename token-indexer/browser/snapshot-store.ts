/**
 * Snapshots of the browser engine's store: export, import, and finishing an interrupted import. The file format and its
 * checks are `snapshot.ts`'s.
 *
 * **Export** ({@link exportSnapshot}) is a consistent read that does not stop the engine: it takes an exclusive
 * reservation of the store's single PGlite session, which is granted only between transactions, so every block is
 * either fully committed or not at all, and both cursors (the archive's and the scan's) are at a full block. Under it,
 * it reads what the manifest records (cursors, the archive block's hash, the applied migrations, the PGlite and
 * Postgres versions), runs `CHECKPOINT` and has PGlite write its data directory as a tar (a synchronous read of its
 * files). It releases the session before compressing, so the engine's loops and API requests wait only for the read.
 * An export changes nothing in the store.
 *
 * **Import** has two parts:
 * 1. {@link prepareImport}, which changes nothing: the file is decoded and its manifest checked against this engine
 *    (network, schema versions, PGlite version), the data's size and SHA-256 checked, the data directory unpacked and
 *    checked entry by entry, then loaded into a trial in-memory PGlite whose cursors, block hash and migrations must
 *    equal the manifest's. Any failure is a {@link SnapshotRefusal}.
 * 2. The swap, with the engine stopped and the store's lock held throughout: the snapshot file is first saved as the
 *    store's import journal ({@link SnapshotFiles}); then PGlite is closed ({@link Store.detach}), the store's files are
 *    removed, and the store is opened again from the snapshot's data directory (`loadDataDir`) by the same procedure
 *    that opens a store at boot ({@link openFinishingImport}): the opened store's cursors, block hash and migrations
 *    are checked against the manifest once more, and only then is the journal removed. A worker that ends anywhere in
 *    between leaves the journal, and the next open of the store finishes the import from it before PGlite opens the
 *    store, so a half-written store is never opened. A journal that cannot be read back as a valid snapshot means the
 *    swap never started (the journal is written completely before the store is touched): it is dropped. If loading
 *    the snapshot fails anyway, the journal and the store's files are dropped and the store opens empty, and the
 *    failure is reported.
 */
import type { PGlite } from "@electric-sql/pglite";
import { bytesToHex } from "../../src/postgres/bytes.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";
import {
  checkCompatible,
  checkData,
  decodeSnapshotFile,
  encodeSnapshotFile,
  gzip,
  MAX_SNAPSHOT_FILE_BYTES,
  pgliteVersionOf,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SnapshotExpectation,
  type SnapshotManifest,
  SnapshotManifestSchema,
  SnapshotRefusal,
  sha256Hex,
  snapshotFileName,
  readTar,
  unpackDataDir,
} from "./snapshot.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA, type OpenStoreOptions, type Store, type StoreLoad } from "./store.ts";

/** The MIME type of a snapshot file. */
export const SNAPSHOT_MIME_TYPE = "application/x-tar";

const elapsed = (monotonic: () => number, since: number): number => Math.round((monotonic() - since) * 10) / 10;

// ── What a store holds ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a manifest records about a store. */
export interface StoreFacts {
  pglite: SnapshotManifest["pglite"];
  schemaVersions: SnapshotManifest["schemaVersions"];
  /** `null` while the archive has no block. */
  archive: SnapshotManifest["archive"] | null;
  scan: SnapshotManifest["scan"];
}

/** Reads a store's facts through `sql` (one handle, so a reservation or a transaction reads one state). */
export async function readStoreFacts(sql: UmbraDBSql, network: string): Promise<StoreFacts> {
  const [v] = await sql<{ version: string; server: string }[]>`select version() as version, current_setting('server_version') as server`;
  const version = pgliteVersionOf(v!.version);
  if (version === null) throw new Error(`the store's database is not PGlite: ${v!.version}`);
  const names = async (schema: string): Promise<string[]> =>
    (await sql<{ name: string }[]>`select name from ${sql(schema)}._migrations order by name`).map((r) => r.name);
  const schemaVersions = { chain_archive: await names(ARCHIVE_SCHEMA), mip0018: await names(MIP0018_SCHEMA) };

  const archiveStore = new PgChainArchiveStore(sql, ARCHIVE_SCHEMA);
  const wm = (await archiveStore.getWatermark(`sync_cursor:${network}`)) as { height?: unknown; startHeight?: unknown } | undefined;
  let archive: StoreFacts["archive"] = null;
  if (wm !== undefined && typeof wm.height === "number") {
    const block = await archiveStore.getCanonicalBlockAtHeight(network, wm.height);
    if (block === undefined) throw new Error(`the archive's cursor is at ${wm.height}, but the archive holds no canonical block there`);
    archive = {
      startHeight: typeof wm.startHeight === "number" ? wm.startHeight : null,
      height: wm.height,
      blockHash: block.blockHash.replace(/^0x/, "").toLowerCase(),
    };
  }
  const [s] = await sql<{ from_height: bigint; next_height: bigint; last_block_hash: Uint8Array | null }[]>`
    SELECT from_height, next_height, last_block_hash FROM ${sql(MIP0018_SCHEMA)}.mip0018_scan WHERE network = ${network}`;
  const scan = s === undefined
    ? null
    : { fromHeight: Number(s.from_height), nextHeight: Number(s.next_height), lastBlockHash: s.last_block_hash === null ? null : bytesToHex(s.last_block_hash) };
  return { pglite: { version, serverVersion: v!.server }, schemaVersions, archive, scan };
}

/** Refuses a store whose facts are not the manifest's. */
export function checkFacts(manifest: SnapshotManifest, facts: StoreFacts): void {
  const want = { pglite: manifest.pglite, schemaVersions: manifest.schemaVersions, archive: manifest.archive, scan: manifest.scan };
  for (const key of ["archive", "scan", "schemaVersions", "pglite"] as const) {
    const a = JSON.stringify(facts[key]);
    const b = JSON.stringify(want[key]);
    if (a !== b) throw new SnapshotRefusal("corrupt", `the snapshot's data does not match its manifest: its ${key} is ${a}, the manifest says ${b}`);
  }
}

// ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ExportOptions {
  network: string;
  genesisHash: string | null;
  /** The build's commit, recorded in the manifest. */
  appCommit: string | null;
  /** Wall-clock time, epoch milliseconds (the manifest's `createdAt`). */
  now: () => number;
  /** Monotonic milliseconds for the timings. Default `performance.now`. */
  monotonic?: () => number;
}

export interface ExportedSnapshot {
  /** The snapshot file. */
  file: Blob;
  /** Its suggested file name. */
  name: string;
  manifest: SnapshotManifest;
  /** The file's size. */
  bytes: number;
  /** How long the store's session was held, the compression, and the whole export. */
  timings: { holdMs: number; compressMs: number; totalMs: number };
}

/** Exports the store (see the module documentation). Refused as `empty` while the archive has no block. */
export async function exportSnapshot(store: Store, opts: ExportOptions): Promise<ExportedSnapshot> {
  const monotonic = opts.monotonic ?? (() => performance.now());
  const t0 = monotonic();
  const reserved = await store.mip0018.reserve();
  const held = monotonic();
  let facts: StoreFacts;
  let dump: Blob;
  let holdMs: number;
  try {
    facts = await readStoreFacts(reserved as unknown as UmbraDBSql, opts.network);
    if (facts.archive === null) throw new SnapshotRefusal("empty", "the archive has no block yet: there is nothing to export");
    await reserved`CHECKPOINT`;
    dump = await store.pglite.dumpDataDir("none");
  } finally {
    holdMs = elapsed(monotonic, held);
    reserved.release();
  }
  const t1 = monotonic();
  const tar = new Uint8Array(await dump.arrayBuffer());
  const data = await gzip(tar);
  const compressMs = elapsed(monotonic, t1);
  const manifest: SnapshotManifest = SnapshotManifestSchema.parse({
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: new Date(opts.now()).toISOString(),
    network: opts.network,
    genesisHash: opts.genesisHash,
    archive: facts.archive,
    scan: facts.scan,
    schemaVersions: facts.schemaVersions,
    pglite: facts.pglite,
    build: { appCommit: opts.appCommit },
    data: { file: "data.tar.gz", encoding: "tar+gzip", bytes: data.length, sha256: await sha256Hex(data), tarBytes: tar.length },
  });
  const file = encodeSnapshotFile(manifest, data);
  return {
    file: new Blob([file as Uint8Array<ArrayBuffer>], { type: SNAPSHOT_MIME_TYPE }),
    name: snapshotFileName(manifest),
    manifest,
    bytes: file.length,
    timings: { holdMs, compressMs, totalMs: elapsed(monotonic, t0) },
  };
}

// ── Import ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A snapshot that passed every check, ready to replace a store. */
export interface PreparedImport {
  manifest: SnapshotManifest;
  /** The snapshot file (saved as the journal during the swap). */
  file: Uint8Array;
  /** Its data directory, a plain tar (what PGlite loads). */
  tar: Uint8Array;
  timings: { readMs: number; checkMs: number; unpackMs: number; trialMs: number };
}

/** Opens a PGlite database from a data directory tar (default: in memory, PGlite imported on demand). */
export type TrialOpener = (tar: Blob) => Promise<PGlite>;

const defaultTrial: TrialOpener = async (tar) => {
  const { PGlite } = await import("@electric-sql/pglite");
  return PGlite.create({ dataDir: "memory://", loadDataDir: tar });
};

/** The number of entries of a tar that {@link unpackDataDir} has checked. */
const tarEntryCount = (tar: Uint8Array): number =>
  readTar(tar, (d) => new SnapshotRefusal("corrupt", d), (d) => new SnapshotRefusal("corrupt", d)).length;

const tarBlob = (tar: Uint8Array): Blob => new Blob([tar as Uint8Array<ArrayBuffer>], { type: "application/x-tar" });

/**
 * Reads, checks and trial-loads a snapshot file (see the module documentation); changes nothing. Rejects with a
 * {@link SnapshotRefusal} naming the reason.
 */
export async function prepareImport(
  snapshot: Blob,
  expected: SnapshotExpectation,
  opts: { monotonic?: () => number; trial?: TrialOpener } = {},
): Promise<PreparedImport> {
  const monotonic = opts.monotonic ?? (() => performance.now());
  let t = monotonic();
  if (snapshot.size > MAX_SNAPSHOT_FILE_BYTES) throw new SnapshotRefusal("format", `the file is ${snapshot.size} bytes, more than the ${MAX_SNAPSHOT_FILE_BYTES} a snapshot may have`);
  const file = new Uint8Array(await snapshot.arrayBuffer());
  const readMs = elapsed(monotonic, t);
  t = monotonic();
  const { manifest, data } = decodeSnapshotFile(file);
  checkCompatible(manifest, expected);
  await checkData(manifest, data);
  const checkMs = elapsed(monotonic, t);
  t = monotonic();
  const tar = await unpackDataDir(manifest, data);
  const unpackMs = elapsed(monotonic, t);
  t = monotonic();
  let pg: PGlite;
  try {
    pg = await (opts.trial ?? defaultTrial)(tarBlob(tar));
  } catch (e) {
    throw new SnapshotRefusal("corrupt", `the snapshot's data directory does not open: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    let facts: StoreFacts;
    try {
      facts = await readStoreFacts(createPgliteClient({ pglite: pg, schema: MIP0018_SCHEMA }), manifest.network);
    } catch (e) {
      throw new SnapshotRefusal("corrupt", `the snapshot's data directory cannot be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    checkFacts(manifest, facts);
  } finally {
    await pg.close().catch(() => {});
  }
  return { manifest, file, tar, timings: { readMs, checkMs, unpackMs, trialMs: elapsed(monotonic, t) } };
}

// ── The journal and the store's files ────────────────────────────────────────────────────────────────────────────────

/** Where a store keeps its import journal, and how its database files are removed. */
export interface SnapshotFiles {
  /** The journal (a snapshot file), or `undefined` when there is none. */
  readJournal(): Promise<Uint8Array | undefined>;
  /** Saves the journal; it exists in full once this resolves (or not at all). */
  writeJournal(file: Uint8Array): Promise<void>;
  removeJournal(): Promise<void>;
  /** Removes the store's database files (PGlite closed). */
  removeStore(): Promise<void>;
}

/** The journal of a store that keeps no files (`memory://`): in memory; the store's files vanish when PGlite closes. */
export function memorySnapshotFiles(): SnapshotFiles {
  let journal: Uint8Array | undefined;
  return {
    readJournal: async () => journal,
    writeJournal: async (file) => { journal = file.slice(); },
    removeJournal: async () => { journal = undefined; },
    removeStore: async () => {},
  };
}

const isNotFound = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { name?: unknown }).name === "NotFoundError";

/**
 * The journal of an `opfs-ahp://<path>` store: the file `<last path segment>.import.snapshot.tar` beside the store's
 * directory in the Origin Private File System, written through a writable stream (the file's content is replaced
 * when the stream closes, so it is complete or absent). Removing the store removes its directory.
 */
export function opfsSnapshotFiles(dataDir: string, storage: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } | undefined = globalThis.navigator?.storage): SnapshotFiles {
  const segments = dataDir.slice("opfs-ahp://".length).split("/").filter((s) => s !== "");
  const leaf = segments.at(-1);
  if (!dataDir.startsWith("opfs-ahp://") || leaf === undefined) throw new RangeError(`not an OPFS store: ${dataDir}`);
  const journalName = `${leaf}.import.snapshot.tar`;
  const parent = async (): Promise<FileSystemDirectoryHandle> => {
    if (typeof storage?.getDirectory !== "function") throw new Error("this context has no Origin Private File System");
    let dir = await storage.getDirectory();
    for (const s of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
    return dir;
  };
  return {
    async readJournal() {
      try {
        const file = await (await (await parent()).getFileHandle(journalName)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
    },
    async writeJournal(file) {
      const handle = await (await parent()).getFileHandle(journalName, { create: true });
      const w = await handle.createWritable();
      await w.write(file as Uint8Array<ArrayBuffer>);
      await w.close();
    },
    async removeJournal() {
      try {
        await (await parent()).removeEntry(journalName);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
    async removeStore() {
      try {
        await (await parent()).removeEntry(leaf, { recursive: true });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
  };
}

/** The journal and files of the store `dataDir`: OPFS for `opfs-ahp://`, memory otherwise. */
export function snapshotFilesFor(dataDir: string): SnapshotFiles {
  return dataDir.startsWith("opfs-ahp://") ? opfsSnapshotFiles(dataDir) : memorySnapshotFiles();
}

// ── Opening a store, finishing an import ─────────────────────────────────────────────────────────────────────────────

/** Opens a store (`store.ts` `openStore`, with the options it receives here). */
export type StoreOpener = (dataDir: string, options: OpenStoreOptions) => Promise<Store>;

export interface OpenedStore {
  store: Store;
  /** The manifest of the import this open finished (`null`: none was pending). */
  imported: SnapshotManifest | null;
  /** Why a pending import could not be finished (the store was opened empty then), or `null`. */
  failure: string | null;
}

/**
 * Opens the store `dataDir`, first finishing an import its journal holds: under the store's lock, a valid journal's
 * snapshot replaces the store's files (removed, then loaded by PGlite as it opens), the opened store is checked against
 * the manifest, and the journal is removed. An invalid journal (the swap never started) is dropped. When the pending
 * import cannot be finished, the journal and the store's files are dropped and the store opens empty.
 */
export async function openFinishingImport(
  open: StoreOpener,
  dataDir: string,
  files: SnapshotFiles,
  network: string,
  options: OpenStoreOptions = {},
): Promise<OpenedStore> {
  let pending: SnapshotManifest | undefined;
  const prepare = async (dir: string): Promise<StoreLoad | undefined> => {
    await options.prepare?.(dir);
    const journal = await files.readJournal();
    if (journal === undefined) return undefined;
    let manifest: SnapshotManifest;
    let tar: Uint8Array;
    let entries: number;
    try {
      const decoded = decodeSnapshotFile(journal);
      await checkData(decoded.manifest, decoded.data);
      tar = await unpackDataDir(decoded.manifest, decoded.data);
      entries = tarEntryCount(tar);
      manifest = decoded.manifest;
    } catch {
      await files.removeJournal();
      return undefined;
    }
    await files.removeStore();
    pending = manifest;
    return { tar: tarBlob(tar), entries };
  };

  let store: Store;
  try {
    store = await open(dataDir, { ...options, prepare });
  } catch (e) {
    if (pending === undefined) throw e;
    return reopenEmpty(open, dataDir, files, options, undefined, `the snapshot could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (pending === undefined) return { store, imported: null, failure: null };
  try {
    checkFacts(pending, await readStoreFacts(store.mip0018, network));
  } catch (e) {
    const lock = await store.detach().catch(() => undefined);
    return reopenEmpty(open, dataDir, files, options, lock, `the loaded snapshot does not match its manifest: ${e instanceof Error ? e.message : String(e)}`);
  }
  await files.removeJournal();
  return { store, imported: pending, failure: null };
}

async function reopenEmpty(
  open: StoreOpener,
  dataDir: string,
  files: SnapshotFiles,
  options: OpenStoreOptions,
  lock: OpenStoreOptions["lock"],
  failure: string,
): Promise<OpenedStore> {
  const { lock: _unused, ...rest } = options;
  const prepare = async (dir: string): Promise<undefined> => {
    await rest.prepare?.(dir);
    await files.removeJournal();
    await files.removeStore();
    return undefined;
  };
  let store: Store;
  try {
    store = await open(dataDir, { ...rest, ...(lock === undefined ? {} : { lock }), prepare });
  } catch (e) {
    throw new Error(`${failure}; opening the store empty failed too: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { store, imported: null, failure };
}

/**
 * Replaces `store` with the prepared snapshot (see the module documentation) and returns the store opened again. The
 * engine must be stopped and no statement may be running on `store`. The store's lock stays held from the old store to
 * the new one.
 */
export async function replaceStore(
  store: Store,
  prepared: PreparedImport,
  open: StoreOpener,
  files: SnapshotFiles,
  options: OpenStoreOptions = {},
): Promise<OpenedStore> {
  await files.writeJournal(prepared.file);
  const lock = await store.detach();
  return openFinishingImport(open, store.dataDir, files, prepared.manifest.network, { ...options, ...(lock === undefined ? {} : { lock }) });
}
