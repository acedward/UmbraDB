/**
 * The store's tables as the Database tab reads them (the `tables` and `rows` requests of `protocol.ts`), read-only,
 * through the injected `Sql`:
 *
 * - {@link listTables}: each schema's tables with their estimated rows and size, from the catalog statistics of the
 *   system snapshot (`../engine/database-stats.ts`: `pg_class.reltuples`, `pg_total_relation_size`,
 *   `pg_database_size`).
 * - {@link readRows}: one page of one table. The table is named by its schema and name, and both are looked up first:
 *   a schema that is not one of the store's, or a name that is not one of that schema's tables in the catalog, is
 *   refused ({@link TableRefusal}) before any statement names it; the names that reach SQL are the catalog's own,
 *   written by the client's identifier helper. Rows come by the primary key's columns, each descending (newest first
 *   for the tables whose key, after the network, leads with a block height: their highest heights first; any other key
 *   in its own descending order); a table without a primary key in physical order, the last written row first. Values are cut in SQL, so a page never carries a whole large value: a `bytea` value's
 *   first {@link ROWS_LIMITS}`.hexBytes` bytes and its length; any other value's text form (`::text`), its first
 *   `textChars` characters and its length. At most `maxLimit` rows from at most `maxOffset` rows deep.
 *
 * Cost: every read is an autocommit statement of its own (the catalog, then the page), never a transaction, so the
 * session is held for one short statement at a time and the engine's block transactions take their turns between them.
 * The values are data: a page draws them as text (`visible-text.ts`).
 */
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { collectDatabaseStats } from "../engine/database-stats.ts";
import { type Cell, type RowsResult, ROWS_LIMITS, type TablesResult } from "./protocol.ts";

/** A `rows` request naming a schema or table that is not the store's. */
export class TableRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableRefusal";
  }
}

const elapsedSince = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10;

/** The `tables` answer for the store's `schemas`. */
export async function listTables(sql: UmbraDBSql, schemas: readonly string[]): Promise<TablesResult> {
  const t0 = performance.now();
  const stats = await collectDatabaseStats(sql, schemas);
  return {
    databaseBytes: stats.databaseBytes,
    schemas: stats.schemas.map((s) => ({
      name: s.name,
      tables: s.tables.map((t) => ({
        name: t.name,
        kind: t.kind,
        partitionOf: t.partitionOf,
        // A partitioned table's own row has no estimate and no size: its partitions' total stands for it.
        estimatedRows: t.partitions !== null ? t.partitions.estimatedRows : t.estimatedRows,
        totalBytes: t.partitions !== null ? t.partitions.totalBytes : t.totalBytes,
      })),
    })),
    elapsedMs: elapsedSince(t0),
  };
}

export interface RowsRequest {
  schema: string;
  table: string;
  limit?: number;
  offset?: number;
}

interface ColumnRow {
  nsp: string;
  rel: string;
  name: string;
  type: string;
  base: string;
  key: number | null;
}

/** Lowercase hex of `bytes`. */
function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number(String(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`a length is not a count: ${String(value)}`);
  return n;
}

/** One value of a page as the answer carries it. */
function cellOf(bytea: boolean, value: unknown, length: unknown): Cell {
  if (value === null || value === undefined) return { kind: "null" };
  if (bytea) {
    if (!(value instanceof Uint8Array)) throw new TypeError("a bytea value was not read as bytes");
    return { kind: "bytes", hex: hexOf(value), bytes: count(length) };
  }
  return { kind: "text", text: String(value), chars: count(length) };
}

/** `parts` joined by commas, as one SQL fragment. */
function commaList(sql: UmbraDBSql, parts: ReturnType<UmbraDBSql>[]): ReturnType<UmbraDBSql> {
  return parts.reduce((list, part) => sql`${list}, ${part}`);
}

/** The `rows` answer: one page of a table of the store's `schemas` (see the module documentation). */
export async function readRows(sql: UmbraDBSql, schemas: readonly string[], request: RowsRequest): Promise<RowsResult> {
  const t0 = performance.now();
  const limit = request.limit ?? ROWS_LIMITS.defaultLimit;
  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ROWS_LIMITS.maxLimit) throw new TableRefusal(`the limit is 1 to ${ROWS_LIMITS.maxLimit} rows`);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > ROWS_LIMITS.maxOffset) throw new TableRefusal(`the offset is 0 to ${ROWS_LIMITS.maxOffset} rows`);
  if (!schemas.includes(request.schema)) throw new TableRefusal(`${JSON.stringify(request.schema)} is not a schema of the store (${schemas.join(", ")})`);

  // The catalog: the table's columns, their types and their places in the primary key (its key columns, not its
  // included ones). A name that is not a table of the schema gets no row.
  const columns = await sql<ColumnRow[]>`
    SELECT n.nspname AS nsp, c.relname AS rel, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
           t.typname AS base,
           (SELECT k.pos FROM pg_catalog.pg_index i
              CROSS JOIN LATERAL pg_catalog.array_position(i.indkey::int2[], a.attnum) AS k(pos)
              WHERE i.indrelid = c.oid AND i.indisprimary
                AND k.pos - pg_catalog.array_lower(i.indkey::int2[], 1) < i.indnkeyatts) AS key
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = ${request.schema} AND c.relname = ${request.table} AND c.relkind IN ('r', 'p')
    ORDER BY a.attnum`;
  if (columns.length === 0) throw new TableRefusal(`${JSON.stringify(request.table)} is not a table of the schema ${request.schema}`);
  const schema = columns[0]!.nsp;
  const table = columns[0]!.rel;
  const keyColumns = columns.filter((c) => c.key !== null).sort((a, b) => a.key! - b.key!).map((c) => c.name);

  const selected = commaList(sql, columns.map((c, i) => c.base === "bytea"
    ? sql`substring(${sql(c.name)} FROM 1 FOR ${ROWS_LIMITS.hexBytes}) AS ${sql(`v${i}`)}, octet_length(${sql(c.name)}) AS ${sql(`n${i}`)}`
    : sql`left(${sql(c.name)}::text, ${ROWS_LIMITS.textChars}) AS ${sql(`v${i}`)}, char_length(${sql(c.name)}::text) AS ${sql(`n${i}`)}`));
  const order = keyColumns.length === 0 ? sql`ctid DESC` : commaList(sql, keyColumns.map((k) => sql`${sql(k)} DESC`));
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${selected} FROM ${sql(schema)}.${sql(table)} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}`;

  return {
    schema,
    table,
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    orderBy: keyColumns,
    offset,
    limit,
    rows: rows.slice(0, limit).map((r) => columns.map((c, i) => cellOf(c.base === "bytea", r[`v${i}`], r[`n${i}`]))),
    more: rows.length > limit,
    elapsedMs: elapsedSince(t0),
  };
}
