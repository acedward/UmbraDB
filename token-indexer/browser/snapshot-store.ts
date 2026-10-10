/**
 * Snapshots of the browser engine's store: export, import, and finishing an interrupted import. The file format and its
 * checks are `snapshot.ts`'s. A snapshot carries rows only; a store is only ever made by this build's migrations, and
 * an import loads the rows into such a store.
 *
 * **The store's tables** ({@link storeLayout}): every table of the two schemas that holds rows (plain tables and leaf
 * partitions; the migration runners' `_migrations` are left out, the migrations write them), with its columns
 * (generated columns left out: the store computes them), read from the catalog in the order rows can be loaded (a table
 * after every table it references, ties in the order the migrations created them), and the identity sequences with
 * the column each one numbers.
 *
 * **Export** ({@link exportSnapshot}) is a consistent read that does not stop the engine: it takes an exclusive
 * reservation of the store's single PGlite session, which is granted only between transactions, so every block is
 * either fully committed or not at all, and both cursors (the archive's and the scan's) are at a full block. Under it,
 * it reads what the manifest records (cursors, the archive block's hash, the applied migrations, the PGlite and
 * Postgres versions), then each table's rows (`COPY … TO` in PostgreSQL's binary format) and the sequences' values. It
 * releases the session before splitting and compressing, so the engine's loops and API requests wait only for the read.
 * An export changes nothing in the store.
 *
 * **Loading** ({@link loadSnapshot}) puts a snapshot's rows into a store the migrations just made: the manifest's tables
 * and columns must be the store's, the rows entries arrive in the manifest's table order (each table's chunks
 * numbered from 0), each is loaded with `COPY … FROM` with every constraint and trigger of the store in force, the row
 * counts and the sequences are checked and set, all in one transaction; then the store's cursors, block hash,
 * migrations and PGlite version must be the manifest's. Rows can only be rows: nothing in them is run.
 *
 * **Import** has two parts:
 * 1. {@link prepareImport}, which changes nothing: the file is decoded and its manifest checked against this engine
 *    (network, schema versions, PGlite version), the rows' size and SHA-256 checked, then the whole snapshot is loaded
 *    into a trial store in memory (made by the migrations, as above) and checked. Any failure is a
 *    {@link SnapshotRefusal}.
 * 2. The swap (`host.ts`), with the engine stopped and the store's lock held throughout: the snapshot file is first saved
 *    as the store's import journal ({@link SnapshotFiles}); then PGlite is closed ({@link Store.detach}), and the store
 *    is opened again by the procedure that opens a store at boot ({@link openFinishingImport}): with a journal pending,
 *    the store's files are removed, PGlite creates the store anew, the migrations run and the journal's rows are loaded
 *    and checked as in the trial. The journal is removed only once the host has also saved what follows from the import
 *    (the store's identity and the configuration that continues it). A worker that ends anywhere in between leaves the
 *    journal, and the next open of the store finishes the import from it before the store is used, so a half-built
 *    store is never used. A journal that cannot be read back as a valid snapshot means the swap never started (the
 *    journal is written completely before the store is touched): it is dropped. If loading the journal fails anyway,
 *    the journal and the store's files are dropped, the store opens empty, and the failure is reported.
 */
import { bytesToHex } from "../../src/postgres/bytes.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import {
  checkCompatible,
  checkData,
  decodeSnapshotFile,
  encodeRows,
  encodeSnapshotFile,
  MAX_SNAPSHOT_FILE_BYTES,
  pgliteVersionOf,
  readRows,
  ROWS_ENTRY,
  type RowsEntry,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SnapshotExpectation,
  type SnapshotManifest,
  SnapshotManifestSchema,
  SnapshotRefusal,
  type SnapshotSequence,
  type SnapshotTable,
  sha256Hex,
  snapshotFileName,
  splitCopy,
} from "./snapshot.ts";
import { ARCHIVE_SCHEMA, MIP0018_SCHEMA, migrateStore, openStore, type OpenStoreOptions, type Store, storeExists } from "./store.ts";

/** The MIME type of a snapshot file. */
export const SNAPSHOT_MIME_TYPE = "application/x-tar";

const elapsed = (monotonic: () => number, since: number): number => Math.round((monotonic() - since) * 10) / 10;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

// ── The store's tables ───────────────────────────────────────────────────────────────────────────────────────────────

/** A table that holds rows: `<schema>.<table>`, its columns, and the tables it references. */
export interface LayoutTable {
  name: string;
  columns: string[];
  references: string[];
}

/** An identity sequence (`<schema>.<sequence>`) and the column it numbers (`<schema>.<table>`, column), if any. */
export interface LayoutSequence {
  name: string;
  owner: { table: string; column: string } | null;
}

export interface StoreLayout {
  /** In the order rows can be loaded. */
  tables: LayoutTable[];
  sequences: LayoutSequence[];
}

/** The schemas a snapshot holds. */
export const SNAPSHOT_SCHEMAS = [ARCHIVE_SCHEMA, MIP0018_SCHEMA] as const;

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
/** `"schema"."name"` of a `schema.name` read from the catalog (identifiers without a dot). */
const qualified = (name: string): string => {
  const dot = name.indexOf(".");
  return `${quoteIdent(name.slice(0, dot))}.${quoteIdent(name.slice(dot + 1))}`;
};

/** The store's tables and identity sequences (see the module documentation), read through `sql`. */
export async function storeLayout(sql: UmbraDBSql): Promise<StoreLayout> {
  const [archive, mip] = SNAPSHOT_SCHEMAS;
  const rels = await sql<{ oid: number; name: string; kind: string }[]>`
    SELECT c.oid::int AS oid, n.nspname || '.' || c.relname AS name, c.relkind::text AS kind
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN (${archive}, ${mip}) AND c.relkind IN ('r', 'p', 'S')`;
  const columns = await sql<{ oid: number; name: string }[]>`
    SELECT a.attrelid::int AS oid, a.attname AS name
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN (${archive}, ${mip}) AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
    ORDER BY a.attrelid, a.attnum`;
  const inherits = await sql<{ child: number; parent: number }[]>`SELECT inhrelid::int AS child, inhparent::int AS parent FROM pg_catalog.pg_inherits`;
  const foreignKeys = await sql<{ table: number; references: number }[]>`
    SELECT conrelid::int AS table, confrelid::int AS references FROM pg_catalog.pg_constraint
    WHERE contype = 'f' AND connamespace IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname IN (${archive}, ${mip}))`;
  const owners = await sql<{ sequence: number; table: number; column: string }[]>`
    SELECT d.objid::int AS sequence, d.refobjid::int AS table, a.attname AS column
    FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i')`;

  const byOid = new Map(rels.map((r) => [r.oid, r]));
  const children = new Map<number, number[]>();
  for (const i of inherits) if (byOid.has(i.child) && byOid.has(i.parent)) children.set(i.parent, [...(children.get(i.parent) ?? []), i.child]);
  const leaves = (oid: number): number[] => (byOid.get(oid)?.kind === "r" ? [oid] : (children.get(oid) ?? []).flatMap(leaves));
  const tables = rels.filter((r) => r.kind === "r" && !r.name.endsWith("._migrations"));
  const references = new Map<number, Set<number>>(tables.map((t) => [t.oid, new Set<number>()]));
  for (const fk of foreignKeys)
    for (const from of leaves(fk.table)) for (const to of leaves(fk.references)) if (from !== to) references.get(from)?.add(to);

  // Rows can be loaded in this order: a table after every table it references, ties in the order the migrations created
  // the tables (their triggers check other tables the same way: the blob roles a block references).
  const ordered: typeof tables = [];
  const done = new Set<number>();
  const left = [...tables].sort((a, b) => a.oid - b.oid);
  while (left.length > 0) {
    const i = left.findIndex((t) => [...references.get(t.oid)!].every((r) => done.has(r) || !references.has(r)));
    if (i < 0) throw new Error(`the store's tables reference each other in a cycle: ${left.map((t) => t.name).join(", ")}`);
    const [t] = left.splice(i, 1);
    ordered.push(t!);
    done.add(t!.oid);
  }
  return {
    tables: ordered.map((t) => ({
      name: t.name,
      columns: columns.filter((c) => c.oid === t.oid).map((c) => c.name),
      references: [...references.get(t.oid)!].map((r) => byOid.get(r)!.name).sort(),
    })),
    sequences: rels
      .filter((r) => r.kind === "S")
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((s) => {
        const o = owners.find((x) => x.sequence === s.oid);
        const table = o === undefined ? undefined : byOid.get(o.table);
        return { name: s.name, owner: o === undefined || table === undefined ? null : { table: table.name, column: o.column } };
      }),
  };
}

/** The raw session of a store, for `COPY` through PGlite's `/dev/blob` (a statement's `blob` option and result). */
interface CopySession {
  query(query: string, params?: unknown[], options?: { blob?: Blob }): Promise<{ blob?: Blob; affectedRows?: number; rows: Array<Record<string, unknown>> }>;
}
const copySession = (s: Store): CopySession => s.session as unknown as CopySession;
const copyStatement = (t: Pick<LayoutTable, "name" | "columns">, direction: "TO" | "FROM"): string =>
  `COPY ${qualified(t.name)} (${t.columns.map(quoteIdent).join(", ")}) ${direction} '/dev/blob' WITH (FORMAT binary)`;

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
  /** How long the store's session was held, the splitting and compression, and the whole export. */
  timings: { holdMs: number; compressMs: number; totalMs: number };
}

/** Exports the store (see the module documentation). Refused as `empty` while the archive has no block. */
export async function exportSnapshot(store: Store, opts: ExportOptions): Promise<ExportedSnapshot> {
  const monotonic = opts.monotonic ?? (() => performance.now());
  const t0 = monotonic();
  const reserved = await store.mip0018.reserve();
  const held = monotonic();
  let facts: StoreFacts;
  const copies: Array<{ table: LayoutTable; copy: Uint8Array }> = [];
  const sequences: SnapshotSequence[] = [];
  let holdMs: number;
  try {
    const sql = reserved as unknown as UmbraDBSql;
    facts = await readStoreFacts(sql, opts.network);
    if (facts.archive === null) throw new SnapshotRefusal("empty", "the archive has no block yet: there is nothing to export");
    const layout = await storeLayout(sql);
    for (const table of layout.tables) {
      // A statement on the reserved handle before each read: the requests waiting for the session see the reservation
      // in use (`pglite-sql.ts` fails a statement that waits on an idle reservation for too long).
      await sql`SELECT 1`;
      const r = await copySession(store).query(copyStatement(table, "TO"));
      if (r.blob === undefined) throw new Error(`reading the rows of ${table.name} gave no data`);
      copies.push({ table, copy: new Uint8Array(await r.blob.arrayBuffer()) });
    }
    for (const s of layout.sequences) {
      const dot = s.name.indexOf(".");
      const [v] = await sql<{ last_value: string; is_called: boolean }[]>`
        SELECT last_value::text AS last_value, is_called FROM ${sql(s.name.slice(0, dot))}.${sql(s.name.slice(dot + 1))}`;
      sequences.push({ name: s.name, lastValue: v!.last_value, isCalled: v!.is_called });
    }
  } finally {
    holdMs = elapsed(monotonic, held);
    reserved.release();
  }
  const t1 = monotonic();
  const createdAt = new Date(opts.now()).toISOString();
  const entries: RowsEntry[] = [];
  const tables: SnapshotTable[] = [];
  for (const { table, copy } of copies) {
    const { chunks, rows } = splitCopy(copy);
    chunks.forEach((c, chunk) => entries.push({ table: table.name, chunk, copy: c }));
    tables.push({ name: table.name, columns: table.columns, rows });
  }
  const { data, tarBytes } = await encodeRows(entries, Date.parse(createdAt) / 1000);
  const compressMs = elapsed(monotonic, t1);
  const manifest: SnapshotManifest = SnapshotManifestSchema.parse({
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt,
    network: opts.network,
    genesisHash: opts.genesisHash,
    archive: facts.archive,
    scan: facts.scan,
    schemaVersions: facts.schemaVersions,
    pglite: facts.pglite,
    build: { appCommit: opts.appCommit },
    tables,
    sequences,
    data: { file: ROWS_ENTRY, encoding: "tar+gzip", bytes: data.length, sha256: await sha256Hex(data), tarBytes },
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

// ── Loading a snapshot into a new store ──────────────────────────────────────────────────────────────────────────────

/** Refuses a manifest whose tables, columns or sequences are not the store's. */
function checkLayout(manifest: SnapshotManifest, layout: StoreLayout): void {
  const theirs = manifest.tables.map((t) => `${t.name}(${t.columns.join(",")})`);
  const ours = layout.tables.map((t) => `${t.name}(${t.columns.join(",")})`);
  const missing = ours.filter((t) => !theirs.includes(t));
  const extra = theirs.filter((t) => !ours.includes(t));
  if (missing.length > 0 || extra.length > 0)
    throw new SnapshotRefusal("corrupt", `the snapshot's tables are not this build's: ${[...extra.map((t) => `${t} is not a table of this build`), ...missing.map((t) => `${t} is missing`)].slice(0, 4).join("; ")}`);
  if (theirs.some((t, i) => t !== ours[i])) throw new SnapshotRefusal("corrupt", `the snapshot lists this build's tables in another order than the one their rows load in: ${layout.tables.map((t) => t.name).join(", ")}`);
  const seqTheirs = manifest.sequences.map((s) => s.name).sort();
  const seqOurs = layout.sequences.map((s) => s.name).sort();
  if (seqTheirs.join() !== seqOurs.join()) throw new SnapshotRefusal("corrupt", `the snapshot's sequences [${seqTheirs.join(", ")}] are not this build's [${seqOurs.join(", ")}]`);
}

/** What a load did. */
export interface LoadedSnapshot {
  rows: number;
  entries: number;
  elapsedMs: number;
}

/**
 * Loads the snapshot's rows into `store`, a store this build's migrations made that holds no rows yet, in one
 * transaction, and checks the result against the manifest (see the module documentation). Rejects with a
 * {@link SnapshotRefusal} (`corrupt`) and leaves the store without the rows when the rows do not load or do not match.
 */
export async function loadSnapshot(store: Store, manifest: SnapshotManifest, data: Uint8Array, network: string, monotonic: () => number = () => performance.now()): Promise<LoadedSnapshot> {
  const t0 = monotonic();
  const corrupt = (d: string) => new SnapshotRefusal("corrupt", d);
  const layout = await storeLayout(store.mip0018);
  checkLayout(manifest, layout);
  const position = new Map(layout.tables.map((t, i) => [t.name, i]));
  const loaded = new Map<string, number>();
  const db = copySession(store);
  let current = -1;
  let nextChunk = 0;
  let entries = 0;
  await db.query("BEGIN");
  try {
    await readRows(manifest, data, async (e) => {
      const at = position.get(e.table);
      if (at === undefined) throw corrupt(`the rows hold an entry of ${e.table}, which is not a table of this build`);
      if (at !== current) {
        if (at < current) throw corrupt(`the rows of ${e.table} come after those of a table that is loaded after it`);
        current = at;
        nextChunk = 0;
      }
      if (e.chunk !== nextChunk) throw corrupt(`the rows of ${e.table} are numbered ${e.chunk} where ${nextChunk} was due`);
      nextChunk++;
      entries++;
      const table = layout.tables[at]!;
      let n: number;
      try {
        n = (await db.query(copyStatement(table, "FROM"), [], { blob: new Blob([e.copy as Uint8Array<ArrayBuffer>]) })).affectedRows ?? 0;
      } catch (err) {
        throw corrupt(`the rows of ${e.table} (entry ${e.chunk}) do not load into this build's store: ${messageOf(err)}`);
      }
      loaded.set(e.table, (loaded.get(e.table) ?? 0) + n);
    });
    for (const t of manifest.tables) {
      const n = loaded.get(t.name) ?? 0;
      if (n !== t.rows) throw corrupt(`the rows of ${t.name} are ${n}; the manifest says ${t.rows}`);
    }
    for (const s of manifest.sequences) {
      const owner = layout.sequences.find((x) => x.name === s.name)!.owner;
      try {
        await db.query(`SELECT pg_catalog.setval('${qualified(s.name).replaceAll("'", "''")}'::regclass, $1::bigint, $2::boolean)`, [s.lastValue, s.isCalled]);
      } catch (err) {
        throw corrupt(`the sequence ${s.name} cannot be set to ${s.lastValue}: ${messageOf(err)}`);
      }
      if (owner !== null) {
        const [m] = (await db.query(`SELECT max(${quoteIdent(owner.column)})::text AS max FROM ${qualified(owner.table)}`)).rows as Array<{ max: string | null }>;
        const next = BigInt(s.lastValue) + (s.isCalled ? 1n : 0n);
        if (m?.max !== null && m?.max !== undefined && BigInt(m.max) >= next)
          throw corrupt(`the sequence ${s.name} would next give ${next}, a value ${owner.table}.${owner.column} already holds (up to ${m.max})`);
      }
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  }
  // As the engine reads them: every table's rows, and the facts the manifest records.
  for (const t of manifest.tables) {
    const dot = t.name.indexOf(".");
    const [c] = await store.mip0018<{ n: bigint }[]>`SELECT count(*) AS n FROM ${store.mip0018(t.name.slice(0, dot))}.${store.mip0018(t.name.slice(dot + 1))}`;
    if (Number(c!.n) !== t.rows) throw corrupt(`${t.name} holds ${c!.n} rows after the load; the manifest says ${t.rows}`);
  }
  let facts: StoreFacts;
  try {
    facts = await readStoreFacts(store.mip0018, network);
  } catch (e) {
    throw corrupt(`the loaded rows cannot be read as a store: ${messageOf(e)}`);
  }
  checkFacts(manifest, facts);
  return { rows: manifest.tables.reduce((n, t) => n + t.rows, 0), entries, elapsedMs: elapsed(monotonic, t0) };
}

// ── Import ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A snapshot that passed every check, ready to replace a store. */
export interface PreparedImport {
  manifest: SnapshotManifest;
  /** The snapshot file (saved as the journal during the swap). */
  file: Uint8Array;
  timings: { readMs: number; checkMs: number; stageMs: number };
}

/** Opens a new, empty store for the trial (default: PGlite in memory). */
export type TrialOpener = () => Promise<Store>;

const defaultTrial: TrialOpener = () => openStore("memory://");

/**
 * Reads, checks and trial-loads a snapshot file (see the module documentation); changes nothing. Rejects with a
 * {@link SnapshotRefusal} naming the reason. The trial store is closed whatever happens.
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
  const trial = await (opts.trial ?? defaultTrial)();
  try {
    await migrateStore(trial);
    const [v] = await trial.mip0018<{ version: string; server: string }[]>`select version() as version, current_setting('server_version') as server`;
    checkCompatible(manifest, { ...expected, pglite: { version: pgliteVersionOf(v!.version) ?? v!.version, serverVersion: v!.server } });
    await loadSnapshot(trial, manifest, data, expected.network, monotonic);
  } finally {
    await trial.close().catch(() => {});
  }
  return { manifest, file, timings: { readMs, checkMs, stageMs: elapsed(monotonic, t) } };
}

// ── The journal and the store's files ────────────────────────────────────────────────────────────────────────────────

/** Where a store keeps its import journal, and how its database files are found and removed. */
export interface SnapshotFiles {
  /** The journal (a snapshot file), or `undefined` when there is none. */
  readJournal(): Promise<Uint8Array | undefined>;
  /** Saves the journal; it exists in full once this resolves (or not at all). */
  writeJournal(file: Uint8Array): Promise<void>;
  removeJournal(): Promise<void>;
  /** Whether the store has database files (PGlite would open it rather than create it). */
  storeExists(): Promise<boolean>;
  /** Removes all of the store's database files (PGlite closed). */
  removeStore(): Promise<void>;
}

/** The journal of a store that keeps no files (`memory://`): in memory; the store's files vanish when PGlite closes. */
export function memorySnapshotFiles(): SnapshotFiles {
  let journal: Uint8Array | undefined;
  return {
    readJournal: async () => journal,
    writeJournal: async (file) => { journal = file.slice(); },
    removeJournal: async () => { journal = undefined; },
    storeExists: async () => false,
    removeStore: async () => {},
  };
}

const isNotFound = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { name?: unknown }).name === "NotFoundError";

/**
 * The journal of an `opfs-ahp://<path>` store: the file `<last path segment>.import.snapshot.tar` beside the store's
 * directory in the Origin Private File System, written through a writable stream (the file's content is replaced
 * when the stream closes, so it is complete or absent). Removing the store removes its directory and every file in it.
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
      try {
        await w.write(file as Uint8Array<ArrayBuffer>);
      } catch (e) {
        // A stream that is aborted leaves the file as it was (absent).
        await w.abort().catch(() => {});
        throw e;
      }
      await w.close();
    },
    async removeJournal() {
      try {
        await (await parent()).removeEntry(journalName);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
    storeExists: () => storeExists(dataDir, storage),
    async removeStore() {
      try {
        await (await parent()).removeEntry(leaf, { recursive: true });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
  };
}

/** The journal and files of the store `dataDir`: OPFS for `opfs-ahp://`, memory for `memory://`. Any other store (a
 *  directory PGlite keeps on a file system) gets its journal in memory, and its files cannot be removed from here:
 *  pass {@link SnapshotFiles} for it. */
export function snapshotFilesFor(dataDir: string): SnapshotFiles {
  if (dataDir.startsWith("opfs-ahp://")) return opfsSnapshotFiles(dataDir);
  const files = memorySnapshotFiles();
  if (dataDir.startsWith("memory://")) return files;
  return { ...files, removeStore: async () => { throw new Error(`the files of the store ${dataDir} cannot be removed here`); } };
}

// ── Opening a store, finishing an import ─────────────────────────────────────────────────────────────────────────────

/** Opens a store (`store.ts` `openStore`, with the options it receives here). */
export type StoreOpener = (dataDir: string, options: OpenStoreOptions) => Promise<Store>;

export interface OpenedStore {
  store: Store;
  /** The manifest of the import this open finished (`null`: none was pending). Its journal is still on file: remove
   *  it ({@link SnapshotFiles.removeJournal}) once what follows from the import is saved. */
  imported: SnapshotManifest | null;
  /** Why a pending import could not be finished (the store was opened empty then), or `null`. */
  failure: string | null;
}

export interface FinishingOptions extends Omit<OpenStoreOptions, "prepare"> {
  /** Drops a pending import instead of finishing it (the store's files are replaced otherwise: `reset`). */
  discardJournal?: boolean;
  /** Runs under the store's lock before PGlite opens the store, with the manifest of the import that replaces the
   *  store (`null`: none); it may refuse the open by throwing. */
  beforeOpen?: (dataDir: string, importing: SnapshotManifest | null) => Promise<void>;
}

/**
 * Opens the store `dataDir`, first finishing an import its journal holds: under the store's lock, a valid journal's
 * snapshot replaces the store (its files removed, PGlite creating it anew, the migrations, the rows loaded and checked).
 * An invalid journal (the swap never started) is dropped. When the pending import cannot be finished, the journal and
 * the store's files are dropped and the store opens empty.
 */
export async function openFinishingImport(
  open: StoreOpener,
  dataDir: string,
  files: SnapshotFiles,
  network: string,
  options: FinishingOptions = {},
): Promise<OpenedStore> {
  const { discardJournal = false, beforeOpen, ...openOptions } = options;
  let pending: { manifest: SnapshotManifest; data: Uint8Array } | undefined;
  /** The store's files were changed (the pending import began replacing them). */
  let replacing = false;
  const prepare = async (dir: string): Promise<void> => {
    if (discardJournal) await files.removeJournal();
    else {
      const journal = await files.readJournal();
      if (journal !== undefined) {
        try {
          const decoded = decodeSnapshotFile(journal);
          await checkData(decoded.manifest, decoded.data);
          pending = decoded;
        } catch {
          await files.removeJournal();
        }
      }
    }
    await beforeOpen?.(dir, pending?.manifest ?? null);
    if (pending !== undefined) {
      replacing = true;
      await files.removeStore();
    }
  };

  let store: Store;
  try {
    store = await open(dataDir, { ...openOptions, prepare });
  } catch (e) {
    if (!replacing) throw e;
    return reopenEmpty(open, dataDir, files, openOptions, undefined, `the snapshot could not be loaded: ${messageOf(e)}`);
  }
  if (pending === undefined) return { store, imported: null, failure: null };
  try {
    await migrateStore(store);
    await loadSnapshot(store, pending.manifest, pending.data, network);
  } catch (e) {
    const lock = await store.detach().catch(() => undefined);
    return reopenEmpty(open, dataDir, files, openOptions, lock, `the snapshot could not be loaded: ${messageOf(e)}`);
  }
  return { store, imported: pending.manifest, failure: null };
}

async function reopenEmpty(
  open: StoreOpener,
  dataDir: string,
  files: SnapshotFiles,
  options: Omit<OpenStoreOptions, "prepare">,
  lock: OpenStoreOptions["lock"],
  failure: string,
): Promise<OpenedStore> {
  const { lock: _unused, ...rest } = options;
  const prepare = async (): Promise<void> => {
    await files.removeJournal();
    await files.removeStore();
  };
  let store: Store;
  try {
    store = await open(dataDir, { ...rest, ...(lock === undefined ? {} : { lock }), prepare });
  } catch (e) {
    throw new Error(`${failure}; opening the store empty failed too: ${messageOf(e)}`);
  }
  return { store, imported: null, failure };
}
