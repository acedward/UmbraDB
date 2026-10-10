/**
 * Snapshots made to carry more than rows, in Node: the worker host (`token-indexer/browser/host.ts`) on PGlite in memory
 * or on the Node file system, the recorded U1 range (715402–715433) replayed with no network.
 *
 * - `[[browser.snapshot.data-only]]` — a store whose database holds code (row triggers that forge the blocks synced
 *   later, an event trigger that installs them again whenever the migrations create the table, functions, a view, a
 *   rule, a database setting) exports only rows: imported, the store's catalog is a store's of this build exactly, and
 *   the blocks synced after the import are the chain's (U1's recorded live archive digest). A table the build does not
 *   have is refused. Rows are taken as rows: a changed row arrives as written, and nothing runs. A snapshot of the
 *   earlier format (the whole database, here with that code in it) is refused with a message that says so, and nothing
 *   changes.
 * - `[[browser.snapshot.reset-removes-code]]` — code put into the database of a store (the same triggers, event trigger,
 *   functions and setting) does not survive `reset` or `range`: the store's files are removed (a file left in its
 *   directory too) and a new store is made by the migrations; its catalog is a fresh store's, and the blocks synced
 *   afterwards are the chain's.
 * - `[[browser.snapshot.start-height]]` — the first height an archive records is the start an import saves: a snapshot
 *   whose archive says it starts below its lowest block (at genesis) or above it, or whose scan starts below the
 *   archive, is refused and nothing changes; an honest one is imported with its first block as the saved start.
 * - `[[browser.snapshot.bounds]]` — a small file whose rows declare a huge uncompressed size is refused quickly, holding
 *   little memory: rows that are all zeros (the tar ends at once, and data follows its end), an entry whose header
 *   declares more than an entry may hold, rows that unpack to more than declared, and a declared size above the
 *   ceiling.
 */
import { createGzip } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import type { DigestResult, ExportResult, HostStatus, ImportResult } from "../browser/protocol.ts";
import { memorySettingsStore } from "../browser/settings.ts";
import {
  decodeSnapshotFile,
  encodeSnapshotFile,
  gzip,
  MAX_ROWS_ENTRY_BYTES,
  MAX_ROWS_TAR_BYTES,
  rowsEntryName,
  type SnapshotManifest,
  sha256Hex,
  writeTar,
} from "../browser/snapshot.ts";
import { memoryStoreIdentity } from "../browser/store-identity.ts";
import { call, nodeStoreFiles, result, testHost, type TestHost, U1, untilStatus } from "./helpers/worker-host.ts";

const FAST = { sync: { idleMs: 50 }, scan: { idleMs: 100 } };
const U1_TAPE = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, ...FAST } as const;
const MID = U1.from + 15;
/** U1's recorded live archive digest. */
const U1_ARCHIVE = "fa89d909911b0408fd7651ad58be68430b96e8d1cada804683d5206eaface959";

/** Code an attacker puts into a store's database: a row trigger that forges the author of every block inserted, an
 *  event trigger that installs it again when the migrations create `chain_archive.blocks`, a view, a rule and a
 *  database setting. */
const EVIL = `
CREATE TABLE public.pwned (at timestamptz DEFAULT now(), what text);
CREATE FUNCTION public.evil_row() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO public.pwned(what) VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' ' || NEW.height);
  NEW.author := '\\xdeadbeef'::bytea;
  RETURN NEW;
END $f$;
CREATE TRIGGER evil BEFORE INSERT ON chain_archive.blocks FOR EACH ROW EXECUTE FUNCTION public.evil_row();
CREATE FUNCTION public.reinstall() RETURNS event_trigger LANGUAGE plpgsql AS $f$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE' AND object_identity = 'chain_archive.blocks' LOOP
    EXECUTE 'CREATE TRIGGER evil BEFORE INSERT ON chain_archive.blocks FOR EACH ROW EXECUTE FUNCTION public.evil_row()';
  END LOOP;
END $f$;
CREATE EVENT TRIGGER reinstall ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.reinstall();
CREATE FUNCTION mip0018.helper() RETURNS int LANGUAGE sql AS $f$ SELECT 1 $f$;
CREATE VIEW chain_archive.everything AS SELECT * FROM chain_archive.watermarks;
CREATE RULE log_watermarks AS ON UPDATE TO chain_archive.watermarks DO ALSO INSERT INTO public.pwned(what) VALUES ('watermark');
ALTER DATABASE postgres SET work_mem = '1MB';
`;

/** What a store's catalog holds beyond PostgreSQL's own: functions, triggers, event triggers, rules, policies, views,
 *  tables and settings, by name. A store of this build has exactly what its migrations make. */
async function catalog(sql: UmbraDBSql): Promise<Record<string, string[]>> {
  const names = async (q: Promise<Array<{ n: string }>>) => (await q).map((r) => r.n).sort();
  return {
    functions: await names(sql`SELECT n.nspname || '.' || p.proname AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')`),
    triggers: await names(sql`SELECT tgrelid::regclass::text || '.' || tgname AS n FROM pg_trigger WHERE NOT tgisinternal`),
    eventTriggers: await names(sql`SELECT evtname AS n FROM pg_event_trigger`),
    rules: await names(sql`SELECT ev_class::regclass::text || '.' || rulename AS n FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')`),
    policies: await names(sql`SELECT polrelid::regclass::text || '.' || polname AS n FROM pg_policy`),
    relations: await names(sql`SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`),
    settings: await names(sql`SELECT array_to_string(setconfig, ',') AS n FROM pg_db_role_setting`),
    extensions: await names(sql`SELECT extname AS n FROM pg_extension`),
  };
}

const opened: TestHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const t of opened.splice(0)) await t.host.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function host(over: Parameters<typeof testHost>[0] = {}): TestHost {
  const t = testHost({ settings: memorySettingsStore(), storeIdentity: memoryStoreIdentity(), ...over });
  opened.push(t);
  return t;
}
const current = (t: TestHost): UmbraDBSql => t.opened.filter((s) => !s.session.closed).at(-1)!.mip0018;
const untilU1 = (t: TestHost, to: number = U1.to) => untilStatus(t.host, `U1 up to ${to}`, (s) => s.cursors?.sync?.height === to && s.cursors.scan?.nextHeight === to + 1);

async function exportedU1(to: number): Promise<{ file: Uint8Array; digest: DigestResult }> {
  const a = host();
  await result(a.host, "start", { config: { ...U1_TAPE, endHeight: to } });
  await untilU1(a, to);
  await result(a.host, "stop");
  const exported = await result<ExportResult>(a.host, "export");
  return { file: new Uint8Array(await exported.file.arrayBuffer()), digest: await result<DigestResult>(a.host, "digest") };
}

/** The catalog of a store of this build, freshly booted. */
async function freshCatalog(): Promise<Record<string, string[]>> {
  const f = host();
  await f.host.boot();
  return catalog(current(f));
}

describe("snapshots made to carry more than rows", () => {
  it("[[browser.snapshot.data-only]] a store holding code exports only its rows: imported, the catalog is this build's and later blocks are the chain's; a table the build lacks is refused; a changed row is a row; the earlier format (a whole database) is refused", async () => {
    const honest = await exportedU1(MID);
    const fresh = await freshCatalog();
    expect(fresh.eventTriggers).toEqual([]);
    expect(fresh.functions!.some((f) => f.startsWith("public."))).toBe(false);

    // The attacker's store: the honest snapshot imported, then code put into its database.
    const x = host();
    await result<ImportResult>(x.host, "import", { snapshot: new Blob([honest.file as Uint8Array<ArrayBuffer>]) });
    const xs = current(x);
    await xs.unsafe(EVIL);
    expect((await catalog(xs)).eventTriggers).toEqual(["reinstall"]);

    // A table of the attacker's own in a schema the snapshot holds: its rows are exported, and the import refuses them.
    await xs.unsafe("CREATE TABLE chain_archive.pwned (what text); INSERT INTO chain_archive.pwned VALUES ('x')");
    const withTable = new Uint8Array(await (await result<ExportResult>(x.host, "export")).file.arrayBuffer());
    expect(decodeSnapshotFile(withTable).manifest.tables.map((t) => t.name)).toContain("chain_archive.pwned");
    const victim = host();
    await result(victim.host, "start", { config: { ...U1_TAPE, endHeight: U1.from + 3 } });
    await untilU1(victim, U1.from + 3);
    const before = await result<DigestResult>(victim.host, "digest");
    const refusedTable = await call(victim.host, "import", { snapshot: new Blob([withTable as Uint8Array<ArrayBuffer>]) });
    expect(refusedTable.ok).toBe(false);
    if (!refusedTable.ok) expect(refusedTable.error).toMatchObject({ code: "snapshot-refused", message: expect.stringMatching(/^corrupt: the snapshot's tables are not this build's: chain_archive\.pwned\(what\) is not a table of this build/) });
    expect(await result<DigestResult>(victim.host, "digest")).toEqual({ ...before, elapsedMs: expect.any(Number) });
    await xs.unsafe("DROP TABLE chain_archive.pwned");

    // The attacker's export now: only the rows of this build's tables (every trigger, function, view and rule stays
    // behind), with one row changed on purpose.
    await xs.unsafe(`UPDATE chain_archive.blocks SET author = '\\xc0ffee'::bytea WHERE height = ${U1.from + 1}`);
    const crafted = new Uint8Array(await (await result<ExportResult>(x.host, "export")).file.arrayBuffer());
    const { manifest } = decodeSnapshotFile(crafted);
    expect(manifest.tables.map((t) => t.name).filter((n) => !n.startsWith("chain_archive.") && !n.startsWith("mip0018."))).toEqual([]);

    // The victim imports it: accepted (its rows are rows of this build's tables), and nothing of the code arrives.
    const imported = await result<ImportResult>(victim.host, "import", { snapshot: new Blob([crafted as Uint8Array<ArrayBuffer>]) });
    expect(imported.status.cursors?.sync).toEqual({ height: MID, startHeight: U1.from });
    const vs = current(victim);
    expect(await catalog(vs)).toEqual(fresh);
    // The changed row arrived as written: a snapshot's rows are trusted data (its SHA-256 detects damage, not who made it).
    expect((await vs<{ author: Uint8Array }[]>`SELECT author FROM chain_archive.blocks WHERE height = ${U1.from + 1}`)[0]!.author).toEqual(new Uint8Array([0xc0, 0xff, 0xee]));
    // The blocks synced after the import are the chain's: only the changed row differs from the recorded run.
    await result(victim.host, "start", { config: U1_TAPE });
    await untilU1(victim);
    expect((await vs<{ n: number }[]>`SELECT count(*)::int AS n FROM chain_archive.blocks WHERE author = '\\xdeadbeef'::bytea`)[0]!.n).toBe(0);
    const authors = await vs<{ height: bigint; author: Uint8Array | null }[]>`SELECT height, author FROM chain_archive.blocks ORDER BY height`;
    const ref = host();
    await result(ref.host, "start", { config: U1_TAPE });
    await untilU1(ref);
    const refAuthors = await current(ref)<{ height: bigint; author: Uint8Array | null }[]>`SELECT height, author FROM chain_archive.blocks ORDER BY height`;
    const hex = (b: Uint8Array | null): string | null => (b === null ? null : Buffer.from(b).toString("hex"));
    expect(authors.map((a) => Number(a.height))).toEqual(refAuthors.map((a) => Number(a.height)));
    const differing = authors.filter((a, i) => hex(a.author) !== hex(refAuthors[i]!.author)).map((a) => Number(a.height));
    expect(differing).toEqual([U1.from + 1]);
    expect((await result<DigestResult>(ref.host, "digest")).archive.sha256).toBe(U1_ARCHIVE);

    // The earlier format: the attacker's whole database (the code in it) as a version 1 snapshot is refused, and
    // nothing changes.
    const victim2 = host();
    await result(victim2.host, "start", { config: { ...U1_TAPE, endHeight: U1.from + 3 } });
    await untilU1(victim2, U1.from + 3);
    const before2 = await result<DigestResult>(victim2.host, "digest");
    const xStore = x.opened.filter((s) => !s.session.closed).at(-1)!;
    await xStore.mip0018`CHECKPOINT`;
    const dataDir = new Uint8Array(await (await xStore.pglite.dumpDataDir("none")).arrayBuffer());
    const data = await gzip(dataDir);
    const v1 = { ...manifest, version: 1, data: { file: "data.tar.gz", encoding: "tar+gzip", bytes: data.length, sha256: await sha256Hex(data), tarBytes: dataDir.length } } as unknown as SnapshotManifest;
    const v1File = writeTar([{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(v1)) }, { name: "data.tar.gz", data }], 0);
    const refused = await call(victim2.host, "import", { snapshot: new Blob([v1File as Uint8Array<ArrayBuffer>]) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toEqual({ code: "snapshot-refused", message: "format: this snapshot has the earlier format (version 1, a copy of the whole database, which can carry code as well as data), which this build does not import: export a new snapshot with this build" });
    expect(await result<DigestResult>(victim2.host, "digest")).toEqual({ ...before2, elapsedMs: expect.any(Number) });
    expect(await catalog(current(victim2))).toEqual(fresh);
  }, 300_000);

  it("[[browser.snapshot.reset-removes-code]] code put into a store's database does not survive reset or range: the store's files are removed and a new store made by the migrations; later blocks are the chain's", async () => {
    const fresh = await freshCatalog();
    const dir = mkdtempSync(join(tmpdir(), "umbradb-reset-code-"));
    dirs.push(dir, `${dir}.import.snapshot.tar`);
    const t = host({ dataDir: dir, snapshotFiles: nodeStoreFiles(dir) });
    await result(t.host, "start", { config: { ...U1_TAPE, endHeight: U1.from + 3 } });
    await untilU1(t, U1.from + 3);
    for (const request of ["reset", "range"] as const) {
      const sql = current(t);
      await sql.unsafe(EVIL);
      expect((await catalog(sql)).eventTriggers).toEqual(["reinstall"]);
      writeFileSync(join(dir, "left-behind"), "a file of the old store");
      await result(t.host, "stop");
      const s = request === "reset" ? await result<HostStatus>(t.host, "reset") : await result<HostStatus>(t.host, "range", { startHeight: U1.from });
      expect(s.boot).toMatchObject({ phase: "ready", storeProblem: null });
      expect(s.store?.created, request).toBe(true);
      expect(existsSync(join(dir, "left-behind")), `${request}: every file of the old store is removed`).toBe(false);
      const after = current(t);
      expect(await catalog(after), request).toEqual(fresh);
      await untilU1(t, request === "reset" ? U1.from + 3 : U1.to);
      expect((await after<{ n: number }[]>`SELECT count(*)::int AS n FROM chain_archive.blocks WHERE author = '\\xdeadbeef'::bytea`)[0]!.n, request).toBe(0);
    }
    expect((await result<DigestResult>(t.host, "digest")).archive.sha256).toBe(U1_ARCHIVE);
  }, 300_000);

  it("[[browser.snapshot.bounds]] a small file whose rows declare a huge size is refused quickly with little memory: all zeros, an oversized entry, more than declared, a size above the ceiling", async () => {
    const { file } = await exportedU1(U1.from + 3);
    const { manifest } = decodeSnapshotFile(file);
    const victim = host();
    await victim.host.boot();
    const GiB = 1024 ** 3;
    const gzipOf = async (chunks: () => Generator<Uint8Array>) => new Uint8Array(await buffer(Readable.from(chunks()).pipe(createGzip({ level: 9 }))));
    const zeros = function* (n: number) { const c = new Uint8Array(1 << 20); for (let i = 0; i < n / c.length; i++) yield c; };
    const withRows = async (rows: Uint8Array, tarBytes: number) =>
      encodeSnapshotFile({ ...manifest, data: { ...manifest.data, bytes: rows.length, sha256: await sha256Hex(rows), tarBytes } }, rows);
    const header = writeTar([{ name: rowsEntryName("chain_archive.chain_blobs", 0), data: new Uint8Array(0) }], 0).subarray(0, 512).slice();
    const big = (size: number) => {
      const h = header.slice();
      h.set(new TextEncoder().encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
      h.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
      return h;
    };
    const cases: Array<[string, Uint8Array, RegExp]> = [
      ["1 GiB of zeros", await withRows(await gzipOf(() => zeros(GiB)), GiB), /^corrupt: the rows are damaged: data follows the tar's end marker at byte 1024$/],
      ["an entry declaring 1 GiB", await withRows(await gzipOf(function* () { yield big(GiB); yield* zeros(GiB); }), GiB + 1536), new RegExp(`declares ${GiB} bytes, more than the ${MAX_ROWS_ENTRY_BYTES} an entry may have$`)],
      ["more than declared", await withRows(await gzipOf(function* () { yield big(32 * 1024 ** 2); yield* zeros(256 * 1024 ** 2); }), 4096), /they unpack to more than the manifest's 4096 bytes$/],
      ["a declared size above the ceiling", await withRows(await gzipOf(() => zeros(1 << 20)), MAX_ROWS_TAR_BYTES + 512), /^format: not an UmbraDB snapshot file: its manifest is invalid \(data\.tarBytes/],
    ];
    for (const [name, bytes, message] of cases) {
      expect(bytes.length, `${name}: a small file`).toBeLessThan(8 * 1024 ** 2);
      let peak = 0;
      const base = process.memoryUsage().arrayBuffers;
      const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); }, 2);
      const t0 = performance.now();
      const r = await call(victim.host, "import", { snapshot: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
      const ms = performance.now() - t0;
      clearInterval(sample);
      peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
      expect(r.ok, name).toBe(false);
      if (!r.ok) {
        expect(r.error.code, name).toBe("snapshot-refused");
        expect(r.error.message, name).toMatch(message);
      }
      expect(ms, `${name}: refused quickly`).toBeLessThan(10_000);
      expect(peak, `${name}: held little memory (${(peak / 1024 ** 2).toFixed(1)} MiB above the start)`).toBeLessThan(MAX_ROWS_ENTRY_BYTES + 64 * 1024 ** 2);
      console.log(`bounds ${name}: file ${bytes.length} B, refused in ${ms.toFixed(0)} ms, peak +${(peak / 1024 ** 2).toFixed(1)} MiB`);
    }
    expect((await result<HostStatus>(victim.host, "status")).boot.phase).toBe("ready");
  }, 300_000);
  it("[[browser.snapshot.start-height]] a snapshot whose archive says it starts below or above its lowest block, or whose scan starts below the archive, is refused with nothing changed; an honest one is imported and its start saved", async () => {
    const a = host();
    await result(a.host, "start", { config: { ...U1_TAPE, endHeight: U1.from + 3 } });
    await untilU1(a, U1.from + 3);
    await result(a.host, "stop");
    const sql = current(a);
    const exportWith = async (startHeight: number, scanFrom: number): Promise<Blob> => {
      await sql`UPDATE chain_archive.watermarks SET value = jsonb_set(value, '{startHeight}', to_jsonb(${startHeight}::int)) WHERE kind = 'chain_archive' AND key = 'sync_cursor:stagenet'`;
      await sql`UPDATE mip0018.mip0018_scan SET from_height = ${scanFrom} WHERE network = 'stagenet'`;
      return (await result<ExportResult>(a.host, "export")).file;
    };
    const victim = host({ settings: memorySettingsStore({ config: { source: { kind: "tape", range: "u1" } }, autoStart: true }) });
    await victim.host.boot();
    const before = await result<HostStatus>(victim.host, "status");
    const cases: Array<[string, number, number, string]> = [
      ["an archive that says it starts at genesis", 0, U1.from, `corrupt: the snapshot's archive starts at its lowest block, ${U1.from}, but its manifest says ${0}`],
      ["an archive that says it starts above its lowest block", U1.from + 2, U1.from + 2, `corrupt: the snapshot's archive starts at its lowest block, ${U1.from}, but its manifest says ${U1.from + 2}`],
      ["a scan that starts below the archive", U1.from, 0, `corrupt: the snapshot's scan starts at 0, below its archive's first height ${U1.from}`],
    ];
    for (const [name, startHeight, scanFrom, message] of cases) {
      const file = await exportWith(startHeight, scanFrom);
      const r = await call(victim.host, "import", { snapshot: file });
      expect(r, name).toMatchObject({ ok: false, error: { code: "snapshot-refused", message } });
      expect((await result<HostStatus>(victim.host, "status")).settings, `${name}: nothing changed`).toEqual(before.settings);
    }
    const honest = await exportWith(U1.from, U1.from);
    const imported = await result<ImportResult>(victim.host, "import", { snapshot: honest });
    expect(imported.status.settings).toEqual({ config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from }, autoStart: false });
  }, 120_000);
});
