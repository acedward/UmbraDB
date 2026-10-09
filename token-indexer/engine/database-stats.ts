/**
 * Database statistics for the system snapshot, read from the catalog through the injected `Sql`: the server's version,
 * `fsync` and database size, and per schema its applied migrations and per table its estimated rows
 * (`pg_class.reltuples`) and size on disk (`pg_total_relation_size`). Exact row counts (`count(*)`) are read only when
 * asked for.
 *
 * Cost: every read is its own autocommit statement — never a transaction, a reservation or a multi-statement text — so
 * the single session of a PGlite database is held for one short statement at a time, and the host's `between` hook
 * (default: one macrotask) runs between two statements, so queued API requests and loop steps take their turn. Each
 * statement's duration is recorded.
 *
 * PGlite never runs autovacuum, so a table it never analyzed has no estimate (`reltuples` is −1, reported `null`);
 * a partitioned table's own row has no estimate and no size on either backend (its partitions carry them, and
 * {@link TableStats.partitions} sums them).
 */
import type { UmbraDBSql } from "../../src/postgres/client.js";

export interface TableStats {
  name: string;
  kind: "table" | "partitioned" | "partition";
  partitionOf: string | null;
  /** `pg_class.reltuples`, or `null` when it is negative (no estimate yet). */
  estimatedRows: number | null;
  totalBytes: number;
  exactRows: number | null;
  partitions: { count: number; estimatedRows: number | null; totalBytes: number } | null;
}

export interface SchemaStats {
  name: string;
  exists: boolean;
  migrations: Array<{ name: string; appliedAt: number }>;
  tables: TableStats[];
}

export interface StatementTiming {
  label: string;
  ms: number;
}

export interface DatabaseStats {
  serverVersion: string;
  fsync: string;
  /** `version()`, and the PGlite version it names (`null` on PostgreSQL). */
  version: string;
  pgliteVersion: string | null;
  databaseBytes: number;
  schemas: SchemaStats[];
  statements: StatementTiming[];
}

export interface DatabaseStatsOptions {
  /** Monotonic milliseconds for statement durations (default `performance.now`). */
  monotonic?: () => number;
  /** Runs between two statements (default: wait one macrotask). */
  between?: () => Promise<void>;
}

const yieldMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** An int8 / numeric / float result as a number (postgres.js and the PGlite client give `bigint` or text for int8). */
export function toNumber(value: unknown, what: string): number {
  const n = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) throw new TypeError(`${what}: not a number (${String(value)})`);
  return n;
}

const timeOf = (value: unknown): number => (value instanceof Date ? value.getTime() : new Date(String(value)).getTime());

/** Runs statements one at a time, timing each and yielding between them. */
function runner(opts: DatabaseStatsOptions): { run<T>(label: string, q: () => PromiseLike<T>): Promise<T>; statements: StatementTiming[] } {
  const monotonic = opts.monotonic ?? (() => performance.now());
  const between = opts.between ?? yieldMacrotask;
  const statements: StatementTiming[] = [];
  let first = true;
  return {
    statements,
    async run<T>(label: string, q: () => PromiseLike<T>): Promise<T> {
      if (!first) await between();
      first = false;
      const t0 = monotonic();
      try {
        return await q();
      } finally {
        statements.push({ label, ms: monotonic() - t0 });
      }
    },
  };
}

interface TableRow {
  name: string;
  kind: string;
  reltuples: number;
  total_bytes: unknown;
  partition_of: string | null;
}

/** Reads the catalog statistics of `schemas`, one statement at a time (see the module documentation). */
export async function collectDatabaseStats(sql: UmbraDBSql, schemas: readonly string[], opts: DatabaseStatsOptions = {}): Promise<DatabaseStats> {
  const r = runner(opts);
  const [s] = await r.run("settings", () => sql<{ server_version: string; fsync: string; version: string; database_bytes: unknown }[]>`
    SELECT current_setting('server_version') AS server_version, current_setting('fsync') AS fsync, version() AS version,
           pg_database_size(current_database()) AS database_bytes`);
  const out: SchemaStats[] = [];
  for (const schema of schemas) {
    const rows = await r.run(`tables:${schema}`, () => sql<TableRow[]>`
      SELECT c.relname AS name, c.relkind::text AS kind, c.reltuples AS reltuples,
             pg_total_relation_size(c.oid) AS total_bytes, p.relname AS partition_of
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_inherits i ON c.relispartition AND i.inhrelid = c.oid
      LEFT JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
      WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`);
    const tables: TableStats[] = rows.map((t) => ({
      name: t.name,
      kind: t.kind === "p" ? "partitioned" : t.partition_of !== null ? "partition" : "table",
      partitionOf: t.partition_of,
      estimatedRows: t.reltuples < 0 ? null : t.reltuples,
      totalBytes: toNumber(t.total_bytes, `pg_total_relation_size(${schema}.${t.name})`),
      exactRows: null,
      partitions: null,
    }));
    for (const parent of tables.filter((t) => t.kind === "partitioned")) {
      const parts = tables.filter((t) => t.partitionOf === parent.name);
      parent.partitions = {
        count: parts.length,
        estimatedRows: parts.some((p) => p.estimatedRows === null) ? null : parts.reduce((a, p) => a + p.estimatedRows!, 0),
        totalBytes: parts.reduce((a, p) => a + p.totalBytes, 0),
      };
    }
    let migrations: SchemaStats["migrations"] = [];
    if (tables.some((t) => t.name === "_migrations")) {
      const m = await r.run(`migrations:${schema}`, () => sql<{ name: string; applied_at: unknown }[]>`
        SELECT name, applied_at FROM ${sql(schema)}._migrations ORDER BY applied_at, name`);
      migrations = m.map((x) => ({ name: x.name, appliedAt: timeOf(x.applied_at) }));
    }
    out.push({ name: schema, exists: rows.length > 0, migrations, tables });
  }
  const version = s!.version;
  return {
    serverVersion: s!.server_version,
    fsync: s!.fsync,
    version,
    pgliteVersion: /\(PGlite ([^)\s]+)\)/u.exec(version)?.[1] ?? null,
    databaseBytes: toNumber(s!.database_bytes, "pg_database_size"),
    schemas: out,
    statements: r.statements,
  };
}

/** `count(*)` of every table of `stats` (a partitioned table counts its partitions' rows), one statement each. */
export async function countRowsExact(
  sql: UmbraDBSql, stats: Pick<DatabaseStats, "schemas">, opts: DatabaseStatsOptions = {},
): Promise<{ counts: Map<string, number>; statements: StatementTiming[] }> {
  const r = runner(opts);
  const counts = new Map<string, number>();
  for (const schema of stats.schemas) {
    for (const t of schema.tables) {
      const [row] = await r.run(`count:${schema.name}.${t.name}`, () => sql<{ n: unknown }[]>`
        SELECT count(*) AS n FROM ${sql(schema.name)}.${sql(t.name)}`);
      counts.set(`${schema.name}.${t.name}`, toNumber(row!.n, `count(*) of ${schema.name}.${t.name}`));
    }
  }
  return { counts, statements: r.statements };
}
