/**
 * The browser engine's snapshot file: a whole store (both schemas' data, as PGlite's data directory) plus a manifest
 * that says what it holds, in one file a user downloads and imports again (`snapshot-store.ts` makes and loads it).
 *
 * **File:** an uncompressed POSIX tar (ustar) holding exactly two regular files, in this order (so `tar -tf` lists and
 * `tar -xf` extracts them):
 *
 * | Entry | Content |
 * |---|---|
 * | `manifest.json` | the {@link SnapshotManifest}, UTF-8 JSON |
 * | `data.tar.gz` | PGlite's data directory (`dumpDataDir`): a ustar of `PGDATA`, gzip-compressed |
 *
 * **Manifest:** the network (and its genesis hash), the last fully committed archive block (height and hash) and the
 * scan cursor at the same instant, the applied migrations of both schema lineages, the PGlite and Postgres versions,
 * the build's commit, and the data entry's size, uncompressed size and SHA-256.
 *
 * **Refusals** ({@link SnapshotRefusal}, each with a reason): the file is not a snapshot of this format (`format`), it is
 * cut short (`truncated`), it is of another network (`network`), its schema versions differ from this build's
 * (`schema`), it was written by another PGlite version (`pglite`), its data does not match the manifest's SHA-256
 * (`hash`), or its data does not unpack into a data directory that matches the manifest (`corrupt`). An export of an
 * archive with no block is refused as `empty`.
 *
 * Runtime-neutral (a worker and Node): compression through `CompressionStream`/`DecompressionStream`, hashing through
 * Web Crypto when present, else `@noble/hashes`.
 */
import { z } from "zod";
import { sha256Hex as nobleSha256Hex } from "../../src/postgres/bytes.js";

export const SNAPSHOT_FORMAT = "umbradb-browser-snapshot";
export const SNAPSHOT_VERSION = 1;

/** The container's entries, in order. */
export const MANIFEST_ENTRY = "manifest.json";
export const DATA_ENTRY = "data.tar.gz";

/** The largest snapshot file an import reads. */
export const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 ** 3;
/** The largest data directory (uncompressed tar) an import unpacks. */
export const MAX_DATA_DIR_BYTES = 4 * 1024 ** 3;
/** The largest manifest an import parses. */
const MAX_MANIFEST_BYTES = 64 * 1024;

export const REFUSAL_REASONS = ["format", "truncated", "network", "schema", "pglite", "hash", "corrupt", "empty"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** A snapshot that is refused: nothing was changed. The message starts with the reason (`network: …`). */
export class SnapshotRefusal extends Error {
  constructor(readonly reason: RefusalReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SnapshotRefusal";
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const height = z.int().min(0);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const migrationName = z.string().min(1).max(200);

export const SnapshotManifestSchema = z.strictObject({
  format: z.literal(SNAPSHOT_FORMAT),
  version: z.literal(SNAPSHOT_VERSION),
  /** When the snapshot was taken (ISO 8601, UTC). */
  createdAt: z.iso.datetime(),
  network: z.string().min(1).max(64),
  /** The network's genesis block hash as `/v1/status` reports it, or `null` when the build does not know it. */
  genesisHash: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
  /** The archive's first height and its last fully committed block (`height`, `blockHash`): a sync started on the
   *  imported store continues at `height + 1`. */
  archive: z.strictObject({ startHeight: height.nullable(), height, blockHash: hex64 }),
  /** The scan cursor read at the same instant (it may be behind the archive; the scan catches up after an import), or
   *  `null` before the scan's first block. */
  scan: z.strictObject({ fromHeight: height, nextHeight: height, lastBlockHash: hex64.nullable() }).nullable(),
  /** The applied migrations of each schema lineage, in order. */
  schemaVersions: z.strictObject({ chain_archive: z.array(migrationName), mip0018: z.array(migrationName) }),
  pglite: z.strictObject({ version: z.string().min(1).max(64), serverVersion: z.string().min(1).max(64) }),
  build: z.strictObject({ appCommit: z.string().max(64).nullable() }),
  data: z.strictObject({
    file: z.literal(DATA_ENTRY),
    encoding: z.literal("tar+gzip"),
    /** Size and SHA-256 (lower-case hex) of the `data.tar.gz` entry. */
    bytes: z.int().min(1).max(MAX_SNAPSHOT_FILE_BYTES),
    sha256: hex64,
    /** Size of the uncompressed tar. */
    tarBytes: z.int().min(1).max(MAX_DATA_DIR_BYTES),
  }),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

/** The snapshot's summary in the engine's system snapshot (`engine/system-snapshot.ts` `SnapshotRecordSchema`). */
export interface SnapshotRecord {
  at: number;
  sha256: string;
  bytes: number | null;
  manifest: { network: string; height: number; blockHash: string; schemaVersions: Record<string, string[]>; pgliteVersion: string };
}

/** The summary of an export or import of `manifest` at `at` (epoch milliseconds); `bytes` is the snapshot file's size. */
export function snapshotRecord(manifest: SnapshotManifest, at: number, bytes: number | null): SnapshotRecord {
  return {
    at,
    sha256: manifest.data.sha256,
    bytes,
    manifest: {
      network: manifest.network,
      height: manifest.archive.height,
      blockHash: manifest.archive.blockHash,
      schemaVersions: { chain_archive: [...manifest.schemaVersions.chain_archive], mip0018: [...manifest.schemaVersions.mip0018] },
      pgliteVersion: manifest.pglite.version,
    },
  };
}

/** The file name of a snapshot: `umbradb-<network>-<first height>-<height>.snapshot.tar`. */
export function snapshotFileName(manifest: Pick<SnapshotManifest, "network" | "archive">): string {
  const network = manifest.network.replace(/[^A-Za-z0-9_-]/g, "_");
  return `umbradb-${network}-${manifest.archive.startHeight ?? manifest.archive.height}-${manifest.archive.height}.snapshot.tar`;
}

/** What this engine accepts: its network, its schema versions and its PGlite. */
export interface SnapshotExpectation {
  network: string;
  genesisHash: string | null;
  schemaVersions: SnapshotManifest["schemaVersions"];
  pglite: SnapshotManifest["pglite"];
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Refuses a manifest this engine cannot take: another network, other schema versions, another PGlite. */
export function checkCompatible(manifest: SnapshotManifest, expected: SnapshotExpectation): void {
  if (manifest.network !== expected.network)
    throw new SnapshotRefusal("network", `the snapshot is of the network ${JSON.stringify(manifest.network)}; this engine indexes ${JSON.stringify(expected.network)}`);
  if (manifest.genesisHash !== null && expected.genesisHash !== null && manifest.genesisHash !== expected.genesisHash)
    throw new SnapshotRefusal("network", `the snapshot's genesis block ${manifest.genesisHash} is not this network's ${expected.genesisHash}`);
  for (const schema of ["chain_archive", "mip0018"] as const) {
    const theirs = manifest.schemaVersions[schema];
    const ours = expected.schemaVersions[schema];
    if (!sameList(theirs, ours))
      throw new SnapshotRefusal("schema", `the snapshot's ${schema} migrations [${theirs.join(", ")}] are not this build's [${ours.join(", ")}]`);
  }
  if (manifest.pglite.version !== expected.pglite.version || manifest.pglite.serverVersion !== expected.pglite.serverVersion)
    throw new SnapshotRefusal(
      "pglite",
      `the snapshot was written by PGlite ${manifest.pglite.version} (PostgreSQL ${manifest.pglite.serverVersion}); this build runs PGlite ${expected.pglite.version} (PostgreSQL ${expected.pglite.serverVersion})`,
    );
}

/** The PGlite version in a `select version()` answer (`PostgreSQL 18.3 (PGlite 0.5.8) on …`), or `null`. */
export function pgliteVersionOf(version: string): string | null {
  return /\(PGlite ([^)\s]+)\)/.exec(version)?.[1] ?? null;
}

// ── Bytes ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** SHA-256 of `bytes`, lower-case hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) return nobleSha256Hex(bytes);
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number, tooLarge: () => Error): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** gzip of `bytes`. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return readAll(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip")), Number.MAX_SAFE_INTEGER, () => new Error("unreachable"));
}

/** The gzip stream `bytes` decompressed; refused as `corrupt` when it is not gzip, is damaged, or exceeds `maxBytes`. */
export async function gunzip(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  try {
    return await readAll(
      new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip")),
      maxBytes,
      () => new SnapshotRefusal("corrupt", `the data directory unpacks to more than the manifest's ${maxBytes} bytes`),
    );
  } catch (e) {
    if (e instanceof SnapshotRefusal) throw e;
    throw new SnapshotRefusal("corrupt", `the data does not decompress: ${e instanceof Error ? e.message || e.name : String(e)}`);
  }
}

// ── ustar ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TarEntry {
  /** The header's name field. */
  name: string;
  /** The header's ustar prefix field (empty in every tar written here and by PGlite). */
  prefix: string;
  /** `file` (`0` or NUL) or `directory` (`5`); anything else is `other` with its type flag. */
  type: "file" | "directory" | "other";
  typeFlag: string;
  size: number;
  /** Offset of the entry's content in the tar. */
  offset: number;
}

function writeString(h: Uint8Array, at: number, len: number, s: string): void {
  const b = encoder.encode(s);
  if (b.length > len) throw new RangeError(`tar field too long: ${s}`);
  h.set(b, at);
}
function writeOctal(h: Uint8Array, at: number, len: number, n: number): void {
  writeString(h, at, len, `${n.toString(8).padStart(len - 1, "0")}\0`);
}
function readString(h: Uint8Array, at: number, len: number): string {
  const field = h.subarray(at, at + len);
  const end = field.indexOf(0);
  return decoder.decode(end < 0 ? field : field.subarray(0, end));
}
function readOctal(h: Uint8Array, at: number, len: number): number | undefined {
  const s = readString(h, at, len).trim();
  if (!/^[0-7]+$/.test(s)) return s === "" ? 0 : undefined;
  return parseInt(s, 8);
}
function checksumOf(h: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum;
}

/** A ustar of regular files (mode 0644, owner 0, the given modification time in seconds). */
export function writeTar(files: readonly { name: string; data: Uint8Array }[], mtimeSeconds: number): Uint8Array {
  const size = files.reduce((n, f) => n + BLOCK + Math.ceil(f.data.length / BLOCK) * BLOCK, 0) + 2 * BLOCK;
  const out = new Uint8Array(size);
  let at = 0;
  for (const f of files) {
    const h = out.subarray(at, at + BLOCK);
    writeString(h, 0, 100, f.name);
    writeOctal(h, 100, 8, 0o644);
    writeOctal(h, 108, 8, 0);
    writeOctal(h, 116, 8, 0);
    writeOctal(h, 124, 12, f.data.length);
    writeOctal(h, 136, 12, Math.max(0, Math.floor(mtimeSeconds)));
    h[156] = 0x30; // "0": a regular file
    writeString(h, 257, 6, "ustar\0");
    writeString(h, 263, 2, "00");
    writeString(h, 148, 8, `${checksumOf(h).toString(8).padStart(6, "0")}\0 `);
    out.set(f.data, at + BLOCK);
    at += BLOCK + Math.ceil(f.data.length / BLOCK) * BLOCK;
  }
  return out;
}

/**
 * The entries of a ustar, checked block by block: every header's checksum and size, every entry complete, and the end
 * marker (two zero blocks) present. `cut` names what a missing part means (`truncated` for a file that was cut short).
 */
export function readTar(tar: Uint8Array, damaged: (detail: string) => SnapshotRefusal, cut: (detail: string) => SnapshotRefusal): TarEntry[] {
  const entries: TarEntry[] = [];
  let at = 0;
  for (;;) {
    if (at + BLOCK > tar.length) throw cut(`the tar ends inside a header at byte ${at} of ${tar.length}`);
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) {
      if (at + 2 * BLOCK > tar.length) throw cut("the tar's end marker is incomplete");
      if (!tar.subarray(at + BLOCK, at + 2 * BLOCK).every((b) => b === 0)) throw damaged(`a zero block at byte ${at} is followed by data`);
      return entries;
    }
    const sum = readOctal(h, 148, 8);
    if (sum === undefined || sum !== checksumOf(h)) throw damaged(`the tar header at byte ${at} has a bad checksum`);
    const magic = String.fromCharCode(...h.subarray(257, 265));
    if (magic !== "ustar\u000000" && magic !== "ustar  \u0000") throw damaged(`the tar header at byte ${at} is not a ustar header`);
    const size = readOctal(h, 124, 12);
    if (size === undefined) throw damaged(`the tar header at byte ${at} has a bad size`);
    const name = readString(h, 0, 100);
    const prefix = readString(h, 345, 155);
    const flag = String.fromCharCode(h[156]!);
    const type = flag === "0" || flag === "\0" ? "file" : flag === "5" ? "directory" : "other";
    const offset = at + BLOCK;
    if (offset + size > tar.length) throw cut(`the entry ${JSON.stringify(name)} needs ${size} bytes; the tar ends after ${tar.length - offset}`);
    entries.push({ name, prefix, type, typeFlag: flag, size, offset });
    at = offset + Math.ceil(size / BLOCK) * BLOCK;
  }
}

// ── The snapshot file ────────────────────────────────────────────────────────────────────────────────────────────────

/** The snapshot file of `manifest` and its data (`data.tar.gz`). */
export function encodeSnapshotFile(manifest: SnapshotManifest, data: Uint8Array): Uint8Array {
  const json = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return writeTar([{ name: MANIFEST_ENTRY, data: json }, { name: DATA_ENTRY, data }], Date.parse(manifest.createdAt) / 1000);
}

/**
 * Reads a snapshot file: its two entries and the manifest, validated against {@link SnapshotManifestSchema}. Refused as
 * `format` (not a snapshot file of this format and version) or `truncated` (cut short). The data is checked against the
 * manifest by {@link checkData}.
 */
export function decodeSnapshotFile(file: Uint8Array): { manifest: SnapshotManifest; data: Uint8Array } {
  if (file.length > MAX_SNAPSHOT_FILE_BYTES) throw new SnapshotRefusal("format", `the file is ${file.length} bytes, more than the ${MAX_SNAPSHOT_FILE_BYTES} a snapshot may have`);
  if (file.length === 0) throw new SnapshotRefusal("format", "the file is empty");
  const format = (d: string) => new SnapshotRefusal("format", `not an UmbraDB snapshot file: ${d}`);
  const cut = (d: string) => new SnapshotRefusal("truncated", `the file is cut short: ${d}`);
  if (!startsWithManifestEntry(file)) throw format(`it does not start with the ${MANIFEST_ENTRY} entry`);
  const entries = readTar(file, format, cut);
  if (entries.length !== 2 || entries[0]!.name !== MANIFEST_ENTRY || entries[1]!.name !== DATA_ENTRY || entries.some((e) => e.type !== "file" || e.prefix !== ""))
    throw format(`it holds ${entries.map((e) => JSON.stringify(e.name)).join(", ")}, not ${MANIFEST_ENTRY} and ${DATA_ENTRY}`);
  const m = entries[0]!;
  if (m.size > MAX_MANIFEST_BYTES) throw format(`its manifest is ${m.size} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(file.subarray(m.offset, m.offset + m.size)));
  } catch {
    throw format("its manifest is not JSON");
  }
  const parsed = SnapshotManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const head = raw as { format?: unknown; version?: unknown } | null;
    if (head?.format === SNAPSHOT_FORMAT && head.version !== SNAPSHOT_VERSION)
      throw format(`its manifest version ${JSON.stringify(head.version)} is not ${SNAPSHOT_VERSION}`);
    throw format(`its manifest is invalid (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ")})`);
  }
  const d = entries[1]!;
  return { manifest: parsed.data, data: file.subarray(d.offset, d.offset + d.size) };
}

/** Whether `file` starts with a ustar header whose name is the manifest's (a cut file still has it). */
function startsWithManifestEntry(file: Uint8Array): boolean {
  const name = encoder.encode(`${MANIFEST_ENTRY}\0`);
  return file.length >= name.length && name.every((b, i) => file[i] === b);
}

/** Refuses data whose size or SHA-256 differs from the manifest's. */
export async function checkData(manifest: SnapshotManifest, data: Uint8Array): Promise<void> {
  if (data.length !== manifest.data.bytes) throw new SnapshotRefusal("hash", `the data has ${data.length} bytes; the manifest says ${manifest.data.bytes}`);
  const digest = await sha256Hex(data);
  if (digest !== manifest.data.sha256) throw new SnapshotRefusal("hash", `the data's SHA-256 is ${digest}; the manifest says ${manifest.data.sha256}`);
}

// ── The data directory ───────────────────────────────────────────────────────────────────────────────────────────────

/** A data directory entry name as PGlite writes it: `/` then path segments of letters, digits, `_`, `-` and `.`. */
const DATA_DIR_NAME = /^(?:\/[A-Za-z0-9_.-]{1,255})+$/;

/**
 * Unpacks a snapshot's data (gzip of PGlite's data directory tar), refusing anything but a data directory: every entry a
 * regular file or a directory whose name stays inside the data directory (no `.` or `..` segment, no link), the size the
 * manifest gives, and a `PG_VERSION` file. Returns the plain tar.
 */
export async function unpackDataDir(manifest: SnapshotManifest, data: Uint8Array): Promise<Uint8Array> {
  const tar = await gunzip(data, manifest.data.tarBytes);
  if (tar.length !== manifest.data.tarBytes) throw new SnapshotRefusal("corrupt", `the data directory has ${tar.length} bytes; the manifest says ${manifest.data.tarBytes}`);
  const corrupt = (d: string) => new SnapshotRefusal("corrupt", `the data directory is damaged: ${d}`);
  const entries = readTar(tar, corrupt, corrupt);
  if (entries.length === 0) throw corrupt("it is empty");
  for (const e of entries) {
    if (e.type === "other") throw corrupt(`the entry ${JSON.stringify(e.name)} is of tar type ${JSON.stringify(e.typeFlag)}, not a file or a directory`);
    if (e.type === "directory" && e.size !== 0) throw corrupt(`the directory entry ${JSON.stringify(e.name)} has content`);
    if (e.prefix !== "") throw corrupt(`the entry ${JSON.stringify(e.name)} has a name prefix`);
    const name = e.name.replace(/\/$/, "");
    if (!DATA_DIR_NAME.test(name) || name.split("/").some((s) => s === "." || s === ".."))
      throw corrupt(`the entry ${JSON.stringify(e.name)} is not a path inside the data directory`);
  }
  if (!entries.some((e) => e.type === "file" && e.name === "/PG_VERSION")) throw corrupt("it has no PG_VERSION file");
  return tar;
}

// ── Published snapshots ──────────────────────────────────────────────────────────────────────────────────────────────

/** Where a static build lists the snapshots it publishes, relative to its pages. */
export const PUBLISHED_INDEX_PATH = "snapshots/index.json";
export const PUBLISHED_INDEX_FORMAT = "umbradb-browser-snapshots";

/** `snapshots/index.json`: the snapshot files a build publishes beside its pages, with their manifests. */
export const PublishedSnapshotIndexSchema = z.strictObject({
  format: z.literal(PUBLISHED_INDEX_FORMAT),
  version: z.literal(1),
  snapshots: z.array(
    z.strictObject({
      /** A short name (`idx`: the recorded range Stagenet 714485–715183). */
      name: z.string().regex(/^[a-z0-9-]{1,32}$/),
      /** The file, relative to the index. */
      file: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/),
      bytes: z.int().min(1),
      /** SHA-256 of the whole file. */
      sha256: hex64,
      manifest: SnapshotManifestSchema,
      /** The digests the build checked the snapshot's store against before publishing it: the archive digest
       *  (`chain_archive`'s 7 tables) and the range-tables digest (every table of both schemas). */
      digests: z.strictObject({ archive: hex64, tables: hex64 }),
    }),
  ),
});
export type PublishedSnapshotIndex = z.infer<typeof PublishedSnapshotIndexSchema>;
