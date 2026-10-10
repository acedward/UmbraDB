/**
 * What "identical tables" means for the range checks: EVERY base table of the chain-archive schema and of the `mip0018`
 * schema — found in the catalog, not listed by hand, so a table added later is compared too — with every column except
 *
 * - wall-clock columns (any `timestamp`/`date`/`time`/`interval` type: `synced_at`, `created_at`, `updated_at`,
 *   `applied_at`), which record when a row was written, not what the chain says; and
 * - surrogate keys (identity / sequence columns, e.g. `verifier_key_observations.id`), whose values depend on how
 *   many inserts were attempted (a rolled-back block after a kill consumes sequence values).
 *
 * Rows are normalized (bytes as lowercase hex, 64-bit integers as decimal strings), written as canonical JSON (keys
 * sorted at every depth) and sorted as strings, so the order of rows in the database and the collation never matter.
 * A NULL element of a `bytea[]` column is normalized as empty bytes, which is how postgres.js 3.4 reads it (PGlite
 * reads it as `null`), so both drivers give the same rows and the same digest. The distinction is kept beside the
 * digest instead: {@link NullElements} counts the NULL elements of every table with a `bytea[]` column and hashes where
 * they are (each row holding one, with the positions of its NULL elements), read by SQL so that both drivers see them;
 * {@link compareNullElements} compares two runs' and the range checks compare them with the digests.
 * Each table gets a row count and the SHA-256 of its sorted rows; the excluded columns are listed with the digest so a
 * reader can see what was left out. Table keys are `archive.<table>` and `mip0018.<table>`: the schema names of two runs
 * may differ.
 *
 * It runs unchanged in Node (the range checks, `../dev/live-range-check.ts`) and in the browser engine's worker (its
 * `digest` request): no `Buffer` and no `node:*` import.
 */
import { bytesToHex, sha256Hex } from "../../src/postgres/bytes.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";

export interface TableDigest {
  rows: number;
  sha256: string;
  /** Columns left out, as `column (reason)`. */
  excluded: string[];
}

export interface RangeTables {
  /** `archive.<table>` / `mip0018.<table>` → digest. */
  tables: Record<string, TableDigest>;
  /** SHA-256 over the canonical JSON of `tables`. */
  sha256: string;
}

/**
 * The NULL elements of `bytea[]` columns, which the row digests count as empty bytes: for every table with such a
 * column (`archive.<table>` / `mip0018.<table>`), how many there are and the SHA-256 of the sorted lines
 * `<row as in the digest>\t<{"column": [positions]}>` of the rows holding one (empty text: none).
 */
export type NullElements = Record<string, { count: number; sha256: string }>;

/** JSON with object keys sorted at every depth (arrays keep their order). */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const utf8 = new TextEncoder();
const sha256 = (s: string): string => sha256Hex(utf8.encode(s));

function normalize(v: unknown): unknown {
  if (v instanceof Uint8Array) return bytesToHex(v);
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

const WALL_CLOCK = /^(timestamp|date|time|interval)/;

/** The row with every NULL element of its `bytea[]` columns as empty bytes (postgres.js reads them so; PGlite as `null`). */
function nullElementsAsEmpty(row: Record<string, unknown>, byteaArrays: readonly string[]): Record<string, unknown> {
  for (const c of byteaArrays) {
    const v = row[c];
    if (Array.isArray(v)) row[c] = v.map((x) => (x === null ? new Uint8Array(0) : x));
  }
  return row;
}

interface ColumnInfo { table_name: string; column_name: string; data_type: string; udt_name: string; is_identity: string; column_default: string | null }

/** The result column holding the 1-based positions of a `bytea[]` column's NULL elements (`null`: none). */
const nullPositionsColumn = (i: number): string => `umbradb_null_positions_${i}`;

/** Every base table of `schema`: its rows as sorted canonical JSON strings, the excluded columns, and for a table with a
 *  `bytea[]` column its NULL elements (see {@link NullElements}). */
export async function schemaRows(sql: UmbraDBSql, schema: string): Promise<Map<string, { rows: string[]; excluded: string[]; nullElements?: { count: number; sha256: string } }>> {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const columns = await sql<ColumnInfo[]>`
    SELECT table_name, column_name, data_type, udt_name, is_identity, column_default FROM information_schema.columns
    WHERE table_schema = ${schema} ORDER BY table_name, ordinal_position`;
  const out = new Map<string, { rows: string[]; excluded: string[]; nullElements?: { count: number; sha256: string } }>();
  for (const { table_name: table } of tables) {
    const kept: string[] = [];
    const excluded: string[] = [];
    const byteaArrays: string[] = [];
    for (const c of columns.filter((x) => x.table_name === table)) {
      if (WALL_CLOCK.test(c.data_type)) excluded.push(`${c.column_name} (wall clock)`);
      else if (c.is_identity === "YES" || (c.column_default ?? "").startsWith("nextval(")) excluded.push(`${c.column_name} (surrogate key)`);
      else {
        kept.push(c.column_name);
        if (c.udt_name === "_bytea") byteaArrays.push(c.column_name);
      }
    }
    if (kept.length === 0) {
      const [counted] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.${sql(table)}`;
      out.set(table, { rows: Array.from({ length: counted?.n ?? 0 }, () => "{}"), excluded });
      continue;
    }
    // An empty list would be sent as a parameter: no fragment at all when the table has no `bytea[]` column.
    const positions = byteaArrays.length === 0 ? sql`` : byteaArrays.map((c, i) =>
      sql`, (SELECT array_agg(n::int ORDER BY n) FROM unnest(${sql(c)}) WITH ORDINALITY AS e(x, n) WHERE x IS NULL) AS ${sql(nullPositionsColumn(i))}`);
    const rows: string[] = [];
    const nullLines: string[] = [];
    let nullCount = 0;
    for (const r of await sql<Record<string, unknown>[]>`SELECT ${sql(kept)}${positions} FROM ${sql(schema)}.${sql(table)}`) {
      const row = { ...r };
      const at: Record<string, number[]> = {};
      byteaArrays.forEach((c, i) => {
        const p = row[nullPositionsColumn(i)];
        delete row[nullPositionsColumn(i)];
        if (Array.isArray(p) && p.length > 0) {
          at[c] = p.map(Number);
          nullCount += p.length;
        }
      });
      const line = canonical(normalize(nullElementsAsEmpty(row, byteaArrays)));
      rows.push(line);
      if (Object.keys(at).length > 0) nullLines.push(`${line}\t${canonical(at)}`);
    }
    rows.sort();
    nullLines.sort();
    out.set(table, { rows, excluded, ...(byteaArrays.length === 0 ? {} : { nullElements: { count: nullCount, sha256: sha256(nullLines.join("\n")) } }) });
  }
  return out;
}

/** Digest of the archive schema and the `mip0018` schema of one run, with the NULL `bytea[]` elements beside it. */
export async function rangeTables(sql: UmbraDBSql, archiveSchema: string, mipSchema: string): Promise<{ digest: RangeTables; rows: Map<string, string[]>; nullElements: NullElements }> {
  const tables: Record<string, TableDigest> = {};
  const rows = new Map<string, string[]>();
  const nullElements: NullElements = {};
  for (const [role, schema] of [["archive", archiveSchema], ["mip0018", mipSchema]] as const) {
    for (const [table, t] of await schemaRows(sql, schema)) {
      tables[`${role}.${table}`] = { rows: t.rows.length, sha256: sha256(t.rows.join("\n")), excluded: t.excluded };
      rows.set(`${role}.${table}`, t.rows);
      if (t.nullElements !== undefined) nullElements[`${role}.${table}`] = t.nullElements;
    }
  }
  return { digest: { tables, sha256: sha256(canonical(tables)) }, rows, nullElements };
}

/** The NULL elements of a run with none in any table that has a `bytea[]` column (the tables named). */
export function noNullElements(tables: readonly string[]): NullElements {
  return Object.fromEntries(tables.map((t) => [t, { count: 0, sha256: sha256("") }]));
}

/** Per-table differences between two runs' NULL `bytea[]` elements ([] when they are the same). */
export function compareNullElements(a: NullElements, b: NullElements): string[] {
  const d: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[k];
    const y = b[k];
    if (x === undefined || y === undefined) d.push(`${k}: NULL bytea[] elements only in ${x === undefined ? "second" : "first"}`);
    else if (x.count !== y.count || x.sha256 !== y.sha256) d.push(`${k}: ${x.count} NULL bytea[] elements ${x.sha256.slice(0, 12)} vs ${y.count} ${y.sha256.slice(0, 12)}`);
  }
  return d;
}

/** Per-table differences between two digests ([] when every table is identical). */
export function compareTables(a: RangeTables, b: RangeTables): string[] {
  const d: string[] = [];
  for (const k of [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort()) {
    const x = a.tables[k];
    const y = b.tables[k];
    if (x === undefined || y === undefined) d.push(`${k}: only in ${x === undefined ? "second" : "first"}`);
    else if (x.rows !== y.rows || x.sha256 !== y.sha256) d.push(`${k}: ${x.rows} rows ${x.sha256.slice(0, 12)} vs ${y.rows} rows ${y.sha256.slice(0, 12)}`);
    else if (canonical(x.excluded) !== canonical(y.excluded)) d.push(`${k}: excluded columns differ`);
  }
  return d;
}

/** The first row that differs between two runs' rows of one table (for a readable failure). */
export function firstDifference(a: string[], b: string[]): string | undefined {
  const sa = new Set(a);
  const sb = new Set(b);
  const onlyA = a.find((r) => !sb.has(r));
  const onlyB = b.find((r) => !sa.has(r));
  if (onlyA === undefined && onlyB === undefined) return a.length === b.length ? undefined : `row counts ${a.length} vs ${b.length}`;
  return `first only: ${onlyA?.slice(0, 400) ?? "-"} | second only: ${onlyB?.slice(0, 400) ?? "-"}`;
}
