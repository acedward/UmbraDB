/**
 * The browser engine's snapshot file: the rows of every table of the store (both schemas) plus a manifest that says
 * what they are, in one file a user downloads and imports again (`snapshot-store.ts` makes and loads it). The file holds
 * data only: nothing of a database (catalog, functions, triggers, settings or files) is ever taken from it. An import
 * creates a new store with this build's migrations and loads the rows into it.
 *
 * **File:** an uncompressed POSIX tar (ustar) holding exactly two regular files, in this order (so `tar -tf` lists and
 * `tar -xf` extracts them):
 *
 * | Entry | Content |
 * |---|---|
 * | `manifest.json` | the {@link SnapshotManifest}, UTF-8 JSON |
 * | `rows.tar.gz` | the rows: a ustar, gzip-compressed, of entries named `<schema>.<table>.<n>.copy` (`n` = 000000, 000001, …), each a PostgreSQL binary `COPY` stream of whole rows of that table, in the manifest's columns |
 *
 * **Manifest:** the network (and its genesis hash), the last fully committed archive block (height and hash) and the
 * scan cursor at the same instant, the applied migrations of both schema lineages, the PGlite and Postgres versions,
 * the build's commit, every table (`<schema>.<table>`, leaf partitions included) with its columns and its number of
 * rows in the order the rows are loaded, the identity sequences' values, and the rows entry's size, uncompressed size
 * and SHA-256.
 *
 * **Refusals** ({@link SnapshotRefusal}, each with a reason): the file is not a snapshot of this format and version
 * (`format`; a snapshot of the earlier format, a whole database, is refused with a message that says so), it is cut
 * short (`truncated`), it is of another network (`network`), its schema versions differ from this build's (`schema`),
 * it was written by another PGlite version (`pglite`), its rows do not match the manifest's SHA-256 (`hash`), or its
 * rows do not unpack, do not load into a store of this build, or do not match the manifest (`corrupt`). An export of an
 * archive with no block is refused as `empty`.
 *
 * **Bounds:** the rows are decompressed and parsed as a stream, never as a whole: an import holds at most one rows entry
 * ({@link MAX_ROWS_ENTRY_BYTES}) besides the file, refuses the rows as soon as they unpack to more than the manifest's
 * uncompressed size (itself at most {@link MAX_ROWS_TAR_BYTES}) or, past {@link ROWS_EXPANSION_FLOOR_BYTES}, to more
 * than {@link MAX_ROWS_EXPANSION} times what was read of them (so the rows an import's trial loads stay in proportion
 * to the file), and refuses anything after the tar's end marker.
 *
 * Runtime-neutral (a worker and Node): compression through `CompressionStream`/`DecompressionStream`, hashing through
 * Web Crypto when present, else `@noble/hashes`.
 */
import { z } from "zod";
import { sha256Hex as nobleSha256Hex } from "../../src/postgres/bytes.js";

export const SNAPSHOT_FORMAT = "umbradb-browser-snapshot";
export const SNAPSHOT_VERSION = 2;

/** The container's entries, in order. */
export const MANIFEST_ENTRY = "manifest.json";
export const ROWS_ENTRY = "rows.tar.gz";

/** The largest snapshot file an import reads. */
export const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 ** 3;
/** The largest uncompressed rows tar a manifest may declare. */
export const MAX_ROWS_TAR_BYTES = 4 * 1024 ** 3;
/** How many times the size of the compressed rows read so far they may unpack to, past the first
 *  {@link ROWS_EXPANSION_FLOOR_BYTES}: a snapshot's rows (hashes, transactions, blocks) unpack to about twice their size,
 *  the published one 1.8 times. */
export const MAX_ROWS_EXPANSION = 16;
/** What the rows may unpack to before {@link MAX_ROWS_EXPANSION} applies (a small store's rows are mostly tar padding). */
export const ROWS_EXPANSION_FLOOR_BYTES = 64 * 1024 ** 2;
/** The compressed rows are handed to the decompressor in pieces of this size. */
const EXPANSION_PIECE_BYTES = 64 * 1024;
/** The largest rows entry (one `COPY` stream) an import holds. */
export const MAX_ROWS_ENTRY_BYTES = 64 * 1024 ** 2;
/** The most rows entries an import reads. */
export const MAX_ROWS_ENTRIES = 100_000;
/** An export splits a table's rows into entries of about this size (a row is never split). */
export const ROWS_CHUNK_BYTES = 4 * 1024 ** 2;
/** The largest manifest an import parses. */
const MAX_MANIFEST_BYTES = 256 * 1024;

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
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
/** `<schema>.<table>` (or `<schema>.<sequence>`), lower-case SQL identifiers. */
const qualifiedName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/);

export const SnapshotTableSchema = z.strictObject({
  /** `<schema>.<table>`. */
  name: qualifiedName,
  /** The columns of each row, in order (generated columns are left out: the store computes them). */
  columns: z.array(z.string().regex(identifier)).min(1).max(1_600),
  rows: z.int().min(0),
});
export type SnapshotTable = z.infer<typeof SnapshotTableSchema>;

export const SnapshotSequenceSchema = z.strictObject({
  /** `<schema>.<sequence>`. */
  name: qualifiedName,
  /** `last_value`, as a decimal 64-bit integer. */
  lastValue: z.string().regex(/^-?[0-9]{1,19}$/),
  isCalled: z.boolean(),
});
export type SnapshotSequence = z.infer<typeof SnapshotSequenceSchema>;

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
  /** Every table of the store, in the order its rows are loaded (a table after the tables it references). */
  tables: z.array(SnapshotTableSchema).min(1).max(1_000),
  /** The values of the store's identity sequences. */
  sequences: z.array(SnapshotSequenceSchema).max(1_000),
  data: z.strictObject({
    file: z.literal(ROWS_ENTRY),
    encoding: z.literal("tar+gzip"),
    /** Size and SHA-256 (lower-case hex) of the `rows.tar.gz` entry. */
    bytes: z.int().min(1).max(MAX_SNAPSHOT_FILE_BYTES),
    sha256: hex64,
    /** Size of the uncompressed tar. */
    tarBytes: z.int().min(1024).max(MAX_ROWS_TAR_BYTES),
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

/** What this engine accepts: its network, its schema versions and (as far as it knows before an import runs) its
 *  PGlite and PostgreSQL versions. */
export interface SnapshotExpectation {
  network: string;
  genesisHash: string | null;
  schemaVersions: SnapshotManifest["schemaVersions"];
  pglite?: { version: string; serverVersion?: string };
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
  const pglite = expected.pglite;
  if (pglite !== undefined && (manifest.pglite.version !== pglite.version || (pglite.serverVersion !== undefined && manifest.pglite.serverVersion !== pglite.serverVersion)))
    throw new SnapshotRefusal(
      "pglite",
      `the snapshot was written by PGlite ${manifest.pglite.version} (PostgreSQL ${manifest.pglite.serverVersion}); this build runs PGlite ${pglite.version}${pglite.serverVersion === undefined ? "" : ` (PostgreSQL ${pglite.serverVersion})`}`,
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

/** gzip of `bytes`. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ── ustar ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TarEntry {
  /** The header's name field. */
  name: string;
  /** The header's ustar prefix field (empty in every tar written here). */
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

/** A ustar header's fields, checked: checksum, magic and size (`undefined` for an all-zero block, the end marker's). */
function parseHeader(h: Uint8Array, at: number, damaged: (detail: string) => SnapshotRefusal): Omit<TarEntry, "offset"> | undefined {
  if (h.every((b) => b === 0)) return undefined;
  const sum = readOctal(h, 148, 8);
  if (sum === undefined || sum !== checksumOf(h)) throw damaged(`the tar header at byte ${at} has a bad checksum`);
  const magic = String.fromCharCode(...h.subarray(257, 265));
  if (magic !== "ustar\u000000" && magic !== "ustar  \u0000") throw damaged(`the tar header at byte ${at} is not a ustar header`);
  const size = readOctal(h, 124, 12);
  if (size === undefined) throw damaged(`the tar header at byte ${at} has a bad size`);
  const flag = String.fromCharCode(h[156]!);
  return {
    name: readString(h, 0, 100),
    prefix: readString(h, 345, 155),
    type: flag === "0" || flag === "\0" ? "file" : flag === "5" ? "directory" : "other",
    typeFlag: flag,
    size,
  };
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
    const header = parseHeader(tar.subarray(at, at + BLOCK), at, damaged);
    if (header === undefined) {
      if (at + 2 * BLOCK > tar.length) throw cut("the tar's end marker is incomplete");
      if (!tar.subarray(at + BLOCK, at + 2 * BLOCK).every((b) => b === 0)) throw damaged(`a zero block at byte ${at} is followed by data`);
      return entries;
    }
    const offset = at + BLOCK;
    if (offset + header.size > tar.length) throw cut(`the entry ${JSON.stringify(header.name)} needs ${header.size} bytes; the tar ends after ${tar.length - offset}`);
    entries.push({ ...header, offset });
    at = offset + Math.ceil(header.size / BLOCK) * BLOCK;
  }
}

// ── The snapshot file ────────────────────────────────────────────────────────────────────────────────────────────────

/** The snapshot file of `manifest` and its rows (`rows.tar.gz`). */
export function encodeSnapshotFile(manifest: SnapshotManifest, rows: Uint8Array): Uint8Array {
  const json = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return writeTar([{ name: MANIFEST_ENTRY, data: json }, { name: ROWS_ENTRY, data: rows }], Date.parse(manifest.createdAt) / 1000);
}

/**
 * Reads a snapshot file: its two entries and the manifest, validated against {@link SnapshotManifestSchema}. Refused as
 * `format` (not a snapshot file of this format and version) or `truncated` (cut short). The rows are checked against
 * the manifest by {@link checkData} and {@link readRows}.
 */
export function decodeSnapshotFile(file: Uint8Array): { manifest: SnapshotManifest; data: Uint8Array } {
  if (file.length > MAX_SNAPSHOT_FILE_BYTES) throw new SnapshotRefusal("format", `the file is ${file.length} bytes, more than the ${MAX_SNAPSHOT_FILE_BYTES} a snapshot may have`);
  if (file.length === 0) throw new SnapshotRefusal("format", "the file is empty");
  const format = (d: string) => new SnapshotRefusal("format", `not an UmbraDB snapshot file: ${d}`);
  const cut = (d: string) => new SnapshotRefusal("truncated", `the file is cut short: ${d}`);
  if (!startsWithManifestEntry(file)) throw format(`it does not start with the ${MANIFEST_ENTRY} entry`);
  const entries = readTar(file, format, cut);
  const m = entries[0]!;
  if (m.type !== "file" || m.prefix !== "") throw format(`its first entry is not the ${MANIFEST_ENTRY} file`);
  if (m.size > MAX_MANIFEST_BYTES) throw format(`its manifest is ${m.size} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(file.subarray(m.offset, m.offset + m.size)));
  } catch {
    throw format("its manifest is not JSON");
  }
  const head = raw as { format?: unknown; version?: unknown } | null;
  if (head !== null && typeof head === "object" && head.format === SNAPSHOT_FORMAT && head.version !== SNAPSHOT_VERSION) {
    if (head.version === 1)
      throw new SnapshotRefusal(
        "format",
        "this snapshot has the earlier format (version 1, a copy of the whole database, which can carry code as well as data), which this build does not import: export a new snapshot with this build",
      );
    throw format(`its manifest version ${JSON.stringify(head.version)} is not ${SNAPSHOT_VERSION}`);
  }
  if (entries.length !== 2 || entries[1]!.name !== ROWS_ENTRY || entries.some((e) => e.type !== "file" || e.prefix !== ""))
    throw format(`it holds ${entries.map((e) => JSON.stringify(e.name)).join(", ")}, not ${MANIFEST_ENTRY} and ${ROWS_ENTRY}`);
  const parsed = SnapshotManifestSchema.safeParse(raw);
  if (!parsed.success)
    throw format(`its manifest is invalid (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ")})`);
  const names = new Set<string>();
  for (const t of [...parsed.data.tables, ...parsed.data.sequences]) {
    if (names.has(t.name)) throw format(`its manifest names ${t.name} twice`);
    names.add(t.name);
  }
  const d = entries[1]!;
  return { manifest: parsed.data, data: file.subarray(d.offset, d.offset + d.size) };
}

/** Whether `file` starts with a ustar header whose name is the manifest's (a cut file still has it). */
function startsWithManifestEntry(file: Uint8Array): boolean {
  const name = encoder.encode(`${MANIFEST_ENTRY}\0`);
  return file.length >= name.length && name.every((b, i) => file[i] === b);
}

/** Refuses rows whose size or SHA-256 differs from the manifest's. */
export async function checkData(manifest: SnapshotManifest, data: Uint8Array): Promise<void> {
  if (data.length !== manifest.data.bytes) throw new SnapshotRefusal("hash", `the rows have ${data.length} bytes; the manifest says ${manifest.data.bytes}`);
  const digest = await sha256Hex(data);
  if (digest !== manifest.data.sha256) throw new SnapshotRefusal("hash", `the rows' SHA-256 is ${digest}; the manifest says ${manifest.data.sha256}`);
}

// ── The rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One rows entry: chunk `chunk` (from 0) of the table `table` (`<schema>.<table>`), a binary `COPY` stream. */
export interface RowsEntry {
  table: string;
  chunk: number;
  copy: Uint8Array;
}

/** The name of a rows entry. */
export const rowsEntryName = (table: string, chunk: number): string => `${table}.${String(chunk).padStart(6, "0")}.copy`;
const ROWS_ENTRY_NAME = /^([a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62})\.([0-9]{6})\.copy$/;

/** The rows entry (`rows.tar.gz`) of these rows entries, in order, and its uncompressed size. */
export async function encodeRows(entries: readonly RowsEntry[], mtimeSeconds: number): Promise<{ data: Uint8Array; tarBytes: number }> {
  const tar = writeTar(entries.map((e) => ({ name: rowsEntryName(e.table, e.chunk), data: e.copy })), mtimeSeconds);
  return { data: await gzip(tar), tarBytes: tar.length };
}

/** Bytes pulled from a stream in exact amounts; `total` counts what the stream gave so far. */
class StreamTaker {
  private readonly chunks: Uint8Array[] = [];
  private head = 0;
  private buffered = 0;
  private ended = false;
  total = 0;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly limit: number,
    private readonly tooLarge: () => Error,
    private readonly budget: () => number = () => Infinity,
    private readonly overBudget: () => Error = tooLarge,
  ) {}

  /** Pulls until `n` bytes are buffered; false when the stream ends first. Throws as soon as the stream has given more
   *  than `limit` bytes, or more than `budget()` (asked after each read). */
  private async fill(n: number): Promise<boolean> {
    while (this.buffered < n) {
      if (this.ended) return false;
      const { done, value } = await this.reader.read();
      if (done) {
        this.ended = true;
        continue;
      }
      this.total += value.length;
      if (this.total > this.limit) throw this.tooLarge();
      if (this.total > this.budget()) throw this.overBudget();
      this.chunks.push(value);
      this.buffered += value.length;
    }
    return true;
  }

  /** Exactly `n` bytes, or `undefined` when the stream ends before. */
  async take(n: number): Promise<Uint8Array | undefined> {
    if (!(await this.fill(n))) return undefined;
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0]!;
      const k = Math.min(n - at, c.length - this.head);
      out.set(c.subarray(this.head, this.head + k), at);
      at += k;
      this.head += k;
      if (this.head === c.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    this.buffered -= n;
    return out;
  }

  /** Whether any byte follows (reads on to find out). */
  async more(): Promise<boolean> {
    return this.fill(1);
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

/**
 * Reads the rows entry (`rows.tar.gz`) as a stream and hands each rows entry to `onEntry`, in order, before reading the
 * next. Refused as `corrupt` (nothing more is read) when the data is not gzip, unpacks to more than the manifest's
 * `tarBytes` (checked as the bytes arrive) or to fewer, unpacks to more than {@link MAX_ROWS_EXPANSION} times the
 * compressed bytes read so far once past {@link ROWS_EXPANSION_FLOOR_BYTES}, is not a ustar of regular files named
 * `<schema>.<table>.<n>.copy`, holds an entry larger than {@link MAX_ROWS_ENTRY_BYTES} (checked from its header, before
 * it is read) or more than {@link MAX_ROWS_ENTRIES} entries, or has anything after its end marker. `onEntry` may refuse
 * an entry by throwing.
 */
export async function readRows(manifest: SnapshotManifest, data: Uint8Array, onEntry: (entry: RowsEntry) => Promise<void>): Promise<void> {
  const corrupt = (d: string) => new SnapshotRefusal("corrupt", `the rows are damaged: ${d}`);
  const limit = manifest.data.tarBytes;
  const tooLarge = () => corrupt(`they unpack to more than the manifest's ${limit} bytes`);
  // The compressed rows go to the decompressor a piece at a time, so what they unpack to is weighed against what was
  // read of them.
  let read = 0;
  const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      pull(c) {
        if (read >= data.length) return c.close();
        const piece = data.subarray(read, Math.min(data.length, read + EXPANSION_PIECE_BYTES)) as Uint8Array<ArrayBuffer>;
        read += piece.length;
        c.enqueue(piece);
      },
    },
    { highWaterMark: 0 },
  );
  const taker = new StreamTaker(
    compressed.pipeThrough(new DecompressionStream("gzip")).getReader(),
    limit,
    tooLarge,
    () => Math.max(ROWS_EXPANSION_FLOOR_BYTES, MAX_ROWS_EXPANSION * read),
    () => corrupt(`they unpack to more than ${MAX_ROWS_EXPANSION} times the ${read} compressed bytes read so far (past the first ${ROWS_EXPANSION_FLOOR_BYTES} bytes)`),
  );
  try {
    let at = 0;
    let count = 0;
    for (;;) {
      const h = await taker.take(BLOCK);
      if (h === undefined) throw corrupt(`the tar ends inside a header at byte ${at}`);
      const header = parseHeader(h, at, corrupt);
      if (header === undefined) {
        const second = await taker.take(BLOCK);
        if (second === undefined || !second.every((b) => b === 0)) throw corrupt(`the tar's end marker at byte ${at} is incomplete`);
        if (await taker.more()) throw corrupt(`data follows the tar's end marker at byte ${at + 2 * BLOCK}`);
        if (taker.total !== limit) throw corrupt(`they unpack to ${taker.total} bytes; the manifest says ${limit}`);
        return;
      }
      if (++count > MAX_ROWS_ENTRIES) throw corrupt(`they hold more than ${MAX_ROWS_ENTRIES} entries`);
      if (header.type !== "file" || header.prefix !== "") throw corrupt(`the entry ${JSON.stringify(header.name)} is not a plain file`);
      const name = ROWS_ENTRY_NAME.exec(header.name);
      if (name === null) throw corrupt(`the entry ${JSON.stringify(header.name)} is not named <schema>.<table>.<n>.copy`);
      if (header.size > MAX_ROWS_ENTRY_BYTES) throw corrupt(`the entry ${JSON.stringify(header.name)} declares ${header.size} bytes, more than the ${MAX_ROWS_ENTRY_BYTES} an entry may have`);
      const padded = Math.ceil(header.size / BLOCK) * BLOCK;
      if (at + BLOCK + padded + 2 * BLOCK > limit) throw tooLarge();
      const content = await taker.take(padded);
      if (content === undefined) throw corrupt(`the entry ${JSON.stringify(header.name)} is cut short`);
      await onEntry({ table: name[1]!, chunk: Number(name[2]), copy: content.subarray(0, header.size) });
      at += BLOCK + padded;
    }
  } catch (e) {
    await taker.cancel();
    if (e instanceof SnapshotRefusal) throw e;
    if (e instanceof TypeError) throw corrupt(`they do not decompress: ${e.message || e.name}`);
    throw e;
  }
}

// ── PostgreSQL binary COPY streams ───────────────────────────────────────────────────────────────────────────────────

const COPY_SIGNATURE = [0x50, 0x47, 0x43, 0x4f, 0x50, 0x59, 0x0a, 0xff, 0x0d, 0x0a, 0x00];

/** The length of a binary `COPY` stream's header (signature, flags, header extension); throws when it is not one. */
function copyHeaderLength(copy: Uint8Array): number {
  if (copy.length < 19 || COPY_SIGNATURE.some((b, i) => copy[i] !== b)) throw new Error("not a binary COPY stream");
  const extension = new DataView(copy.buffer, copy.byteOffset, copy.byteLength).getUint32(15);
  if (19 + extension > copy.length) throw new Error("the binary COPY stream's header is cut short");
  return 19 + extension;
}

/**
 * Splits a binary `COPY` stream into streams of whole rows of about `chunkBytes` each (a row larger than that is one
 * stream on its own), each with the original header and the end-of-data trailer, and counts the rows: no streams for
 * no rows. Throws when `copy` is not a complete binary `COPY` stream.
 */
export function splitCopy(copy: Uint8Array, chunkBytes: number = ROWS_CHUNK_BYTES): { chunks: Uint8Array[]; rows: number } {
  const headerLength = copyHeaderLength(copy);
  const header = copy.subarray(0, headerLength);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const chunks: Uint8Array[] = [];
  let rows = 0;
  let at = headerLength;
  let start = at;
  const emit = (end: number): void => {
    if (end === start) return;
    const chunk = new Uint8Array(headerLength + (end - start) + 2);
    chunk.set(header, 0);
    chunk.set(copy.subarray(start, end), headerLength);
    chunk[chunk.length - 2] = 0xff;
    chunk[chunk.length - 1] = 0xff;
    chunks.push(chunk);
    start = end;
  };
  for (;;) {
    if (at + 2 > copy.length) throw new Error("the binary COPY stream ends without its trailer");
    const fields = view.getInt16(at);
    if (fields === -1) {
      emit(at);
      return { chunks, rows };
    }
    if (fields < 0) throw new Error(`a binary COPY row has ${fields} fields`);
    let p = at + 2;
    for (let f = 0; f < fields; f++) {
      if (p + 4 > copy.length) throw new Error("a binary COPY row is cut short");
      const len = view.getInt32(p);
      p += 4 + Math.max(0, len);
      if (p > copy.length) throw new Error("a binary COPY field is cut short");
    }
    at = p;
    rows++;
    if (at - start >= chunkBytes) emit(at);
  }
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
       *  (`chain_archive`'s 7 tables), the range-tables digest (every table of both schemas) and, beside it, the NULL
       *  `bytea[]` elements of each table with such a column, which that digest counts as empty bytes (count and hash
       *  of where they are, `range-tables.ts`). */
      digests: z.strictObject({
        archive: hex64,
        tables: hex64,
        nullElements: z.record(z.string().max(200), z.strictObject({ count: z.int().min(0), sha256: hex64 })),
      }),
    }),
  ),
});
export type PublishedSnapshotIndex = z.infer<typeof PublishedSnapshotIndexSchema>;
