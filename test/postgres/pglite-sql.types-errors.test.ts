/**
 * The PGlite client's result types and errors against postgres.js on PostgreSQL 17 (Testcontainers): the same
 * statements on both backends give values of the same types, and the same failures give errors with postgres.js's
 * shape that `translatePostgresError` (the error catalog) and the API's `isDatabaseError` route the same way.
 *
 * The PGlite database is in memory and started without PGlite's `-F` start parameter (`fsync=on`), so the chain-archive
 * migrations run under the PostgreSQL durability rule on both backends.
 */
import { PGlite } from "@electric-sql/pglite";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDatabaseError } from "../../token-indexer/mip0018/api.ts";
import { ConnectionError } from "../../src/interfaces/storage-errors.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import {
  isConnectionFailure,
  isLockTimeout,
  isStatementTimeout,
  translatePostgresError,
  UnrecognizedPostgresError,
} from "../../src/postgres/errors.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import {
  createPgliteClient,
  normalizePgliteError,
  PGLITE_PARSERS,
  PglitePostgresError,
  PgliteSqlError,
} from "../../src/postgres/pglite-sql.js";

const SCHEMA = "errors_catalog";
const h = (n: number): Uint8Array => {
  const out = new Uint8Array(32);
  out[31] = n;
  return out;
};

/** A value compared across the backends: a `Buffer` (postgres.js) as the plain bytes, other values unchanged. */
function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Array.from(value) };
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return typeof value === "bigint" ? { bigint: value.toString() } : value;
}

/** What the error catalog and the API make of an error, plus the postgres.js fields both backends must report alike. */
function routed(error: unknown): Record<string, unknown> {
  const e = error as Record<string, unknown>;
  const translated = translatePostgresError(error);
  return {
    translated: translated.constructor.name,
    constraintName: (translated as { constraintName?: unknown }).constraintName,
    faultKind: (translated as { faultKind?: unknown }).faultKind,
    databaseError: isDatabaseError(error),
    statementTimeout: isStatementTimeout(error),
    lockTimeout: isLockTimeout(error),
    connectionFailure: isConnectionFailure(error),
    name: e.name,
    code: e.code,
    fields: Object.fromEntries(
      ["severity_local", "severity", "message", "hint", "where", "schema_name", "table_name", "column_name", "data type_name", "constraint_name"]
        .map((k) => [k, e[k]]),
    ),
    hasDetail: typeof e.detail === "string",
    // The server's source position (file, line, routine) differs between PostgreSQL majors; the field names do not.
    keys: Object.keys(e).sort(),
  };
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the statement to fail");
}

describe("PGlite client: result types and errors as on PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let pglite: PGlite;
  const backends: Array<{ name: string; sql: UmbraDBSql }> = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pglite = await PGlite.create({ startParams: PGlite.defaultStartParams.filter((p) => p !== "-F") });
    backends.push(
      { name: "postgres", sql: createClient({ connectionString: container.getConnectionUri(), schema: SCHEMA }) },
      { name: "pglite", sql: createPgliteClient({ pglite, schema: SCHEMA }) },
    );
    for (const b of backends) await runMigrations(b.sql, { schema: SCHEMA, migrations: chainArchiveMigrations });
  }, 180_000);

  afterAll(async () => {
    for (const b of backends) await b.sql.end({ timeout: 5 });
    await pglite?.close();
    await container?.stop();
  }, 60_000);

  /** Runs `make` on both backends and returns the two results. */
  async function both<T>(make: (sql: UmbraDBSql) => Promise<T>): Promise<[T, T]> {
    const out: T[] = [];
    for (const b of backends) out.push(await make(b.sql));
    return out as [T, T];
  }

  it("[[pglite.types.results]] int8 is always a bigint (also in int8[]), numeric the decimal text, bytea the bytes, on both backends", async () => {
    const [pg, lite] = await both(async (sql) => [...(await sql`
      SELECT 1::int8 AS small, (-9007199254740993)::int8 AS big, count(*) AS n,
             ARRAY[1, -3]::int8[] AS arr, '{{1,2},{3,4}}'::int8[] AS nested, '{}'::int8[] AS empty,
             1.50::numeric AS num, ARRAY[1.5, 2]::numeric[] AS nums, 123456789012345678901234567890::numeric(39,0) AS amount,
             '\\x0102'::bytea AS b, 7::int4 AS i4`)]);
    expect(plain(lite)).toEqual(plain(pg));
    const row = lite![0]!;
    expect([row.small, row.big, row.n]).toEqual([1n, -9007199254740993n, 1n]);
    expect([row.arr, row.nested, row.empty]).toEqual([[1n, -3n], [[1n, 2n], [3n, 4n]], []]);
    expect([row.num, row.nums, row.amount]).toEqual(["1.50", ["1.5", "2"], "123456789012345678901234567890"]);
    expect([row.b, row.i4]).toEqual([new Uint8Array([1, 2]), 7]);
    expect(row.b).not.toBeInstanceOf(Buffer);
    // A NULL int8[] element is null (postgres.js's bigint type cannot parse one and fails the statement); explicit
    // array bounds are read too. The caller's parsers win per oid.
    expect([...(await backends[1]!.sql`SELECT ARRAY[1, NULL]::int8[] AS a`)]).toEqual([{ a: [1n, null] }]);
    expect(PGLITE_PARSERS[1016]!("[0:1]={5,NULL}", 1016)).toEqual([5n, null]);
    const custom = createPgliteClient({ pglite, schema: SCHEMA, parsers: { 1700: (x) => Number(x) } });
    expect([...(await custom`SELECT 2::int8 AS i, 2.5::numeric AS n`)]).toEqual([{ i: 2n, n: 2.5 }]);
  });

  const cases: Array<{
    /** The test's id in the required-test manifest. */
    id: string;
    name: string;
    run: (sql: UmbraDBSql) => Promise<unknown>;
    expected: Record<string, unknown>;
  }> = [
    {
      id: "pglite.errors.check-blob-role",
      name: "23514 from a chain-archive trigger (blob-role completeness)",
      run: async (sql) => {
        const unclassified = h(1);
        await sql`insert into ${sql(SCHEMA)}.chain_blobs (hash, data) values (${unclassified}, ${new Uint8Array([0x78])})`;
        return failure(() => sql`insert into ${sql(SCHEMA)}.blocks
          (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash)
          values ('net', ${h(2)}, 1, ${h(0)}, ${h(3)}, ${h(4)}, ${unclassified})`);
      },
      expected: { translated: "ChainArchiveInvariantError", constraintName: "chain_blob_roles_completeness" },
    },
    {
      id: "pglite.errors.check-unfinalize",
      name: "23514 from un-finalizing a finalized block",
      run: async (sql) => {
        const header = h(10);
        await sql`insert into ${sql(SCHEMA)}.chain_blobs (hash, data) values (${header}, ${new Uint8Array([0x78])})`;
        await sql`insert into ${sql(SCHEMA)}.chain_blob_roles (blob_hash, role) values (${header}, 'block_header')`;
        await sql`insert into ${sql(SCHEMA)}.blocks
          (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash, is_canonical, status, finalized)
          values ('net', ${h(11)}, 2, ${h(0)}, ${h(3)}, ${h(4)}, ${header}, true, 'canonical', true)`;
        return failure(() => sql`update ${sql(SCHEMA)}.blocks set finalized = false, is_canonical = false, status = 'orphaned'
          where net = 'net' and height = 2 and block_hash = ${h(11)}`);
      },
      expected: { translated: "ChainArchiveInvariantError", constraintName: "blocks_finalized_monotonic" },
    },
    {
      id: "pglite.errors.check-role-referenced",
      name: "23514 from deleting a blob role still referenced",
      run: async (sql) => {
        const header = h(20);
        await sql`insert into ${sql(SCHEMA)}.chain_blobs (hash, data) values (${header}, ${new Uint8Array([0x78])})`;
        await sql`insert into ${sql(SCHEMA)}.chain_blob_roles (blob_hash, role) values (${header}, 'block_header')`;
        await sql`insert into ${sql(SCHEMA)}.blocks
          (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash)
          values ('net', ${h(21)}, 3, ${h(0)}, ${h(3)}, ${h(4)}, ${header})`;
        return failure(() => sql`delete from ${sql(SCHEMA)}.chain_blob_roles where blob_hash = ${header} and role = 'block_header'`);
      },
      expected: { translated: "ChainArchiveInvariantError", constraintName: "chain_blob_roles_removal_guard" },
    },
    {
      id: "pglite.errors.check-status-enum",
      name: "23514 from an ordinary chain-archive CHECK (status enum)",
      run: async (sql) => {
        const header = h(30);
        await sql`insert into ${sql(SCHEMA)}.chain_blobs (hash, data) values (${header}, ${new Uint8Array([0x78])})`;
        await sql`insert into ${sql(SCHEMA)}.chain_blob_roles (blob_hash, role) values (${header}, 'block_header')`;
        return failure(() => sql.unsafe(
          `insert into "${SCHEMA}".blocks (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash, status)
           values ('net', $1, 4, $2, $3, $4, $5, 'not-a-real-status')`,
          [h(31), h(0), h(3), h(4), header],
        ));
      },
      expected: { translated: "ChainArchiveCheckViolationError", constraintName: "blocks_status_check" },
    },
    {
      id: "pglite.errors.check-canonical",
      name: "23514 from the canonical CHECK (a finalized block un-marked as canonical)",
      run: async (sql) => {
        const header = h(40);
        await sql`insert into ${sql(SCHEMA)}.chain_blobs (hash, data) values (${header}, ${new Uint8Array([0x78])})`;
        await sql`insert into ${sql(SCHEMA)}.chain_blob_roles (blob_hash, role) values (${header}, 'block_header')`;
        return failure(() => sql`insert into ${sql(SCHEMA)}.blocks
          (net, block_hash, height, parent_hash, state_root, extrinsics_root, header_blob_hash, is_canonical, status, finalized)
          values ('net', ${h(41)}, 5, ${h(0)}, ${h(3)}, ${h(4)}, ${header}, false, 'orphaned', true)`);
      },
      expected: { translated: "ChainArchiveCheckViolationError" },
    },
    {
      id: "pglite.errors.unique",
      name: "23505 unique violation",
      run: async (sql) => {
        await sql`create table ${sql(SCHEMA)}.uniq (id int primary key, u text unique)`;
        await sql`insert into ${sql(SCHEMA)}.uniq values (1, 'a')`;
        return failure(() => sql`insert into ${sql(SCHEMA)}.uniq values (2, 'a')`);
      },
      expected: { translated: "UnrecognizedPostgresError", databaseError: true, code: "23505" },
    },
    {
      id: "pglite.errors.not-null",
      name: "23502 not-null violation (column_name)",
      run: (sql) => failure(() => sql`insert into ${sql(SCHEMA)}.uniq (id, u) values (${null}, 'b')`),
      expected: { translated: "UnrecognizedPostgresError", code: "23502" },
    },
    {
      id: "pglite.errors.missing-relation",
      name: "42P01 missing relation",
      run: (sql) => failure(() => sql`select * from ${sql(SCHEMA)}.no_such_table`),
      expected: { translated: "UnrecognizedPostgresError", databaseError: true, code: "42P01" },
    },
    {
      id: "pglite.errors.serialization",
      name: "40001 serialization failure",
      run: (sql) => failure(() => sql`do $$ begin raise exception 'conflict' using errcode = '40001'; end $$`),
      expected: { translated: "TransactionFaultError", faultKind: "serialization-failure" },
    },
    {
      id: "pglite.errors.deadlock",
      name: "40P01 deadlock",
      run: (sql) => failure(() => sql`do $$ begin raise exception 'cycle' using errcode = '40P01'; end $$`),
      expected: { translated: "TransactionFaultError", faultKind: "deadlock" },
    },
    {
      id: "pglite.errors.cancelled",
      name: "57014 statement cancelled",
      run: (sql) => failure(() => sql`do $$ begin raise exception 'cancelled' using errcode = '57014'; end $$`),
      expected: { translated: "UnrecognizedPostgresError", statementTimeout: true, databaseError: true },
    },
    {
      id: "pglite.errors.lock-not-available",
      name: "55P03 lock not available",
      run: (sql) => failure(() => sql`do $$ begin raise exception 'busy' using errcode = '55P03'; end $$`),
      expected: { translated: "UnrecognizedPostgresError", lockTimeout: true },
    },
    {
      id: "pglite.errors.failed-in-transaction",
      name: "a failed statement inside a transaction (the transaction is rolled back with the error)",
      run: (sql) => failure(() => sql.begin(async (tx) => {
        await tx`insert into ${tx(SCHEMA)}.uniq values (3, 'c')`;
        await tx`insert into ${tx(SCHEMA)}.uniq values (4, 'c')`;
      })),
      expected: { translated: "UnrecognizedPostgresError", code: "23505", databaseError: true },
    },
  ];

  for (const c of cases)
    it(`[[${c.id}]] ${c.name}: the same error shape and the same routing on both backends`, async () => {
      const [pg, lite] = await both(c.run);
      expect(lite).toBeInstanceOf(PglitePostgresError);
      expect(routed(lite)).toEqual(routed(pg));
      expect(routed(lite)).toMatchObject({ name: "PostgresError", databaseError: true, ...c.expected });
      // postgres.js keeps the statement and its parameters off the enumerable fields; so does the PGlite client.
      expect(Object.keys(lite as object)).not.toContain("query");
      expect(typeof (lite as { query?: unknown }).query).toBe("string");
    });

  it("[[pglite.errors.fields]] the fields postgres.js reads: constraint_name, table_name, schema_name, column_name and detail equal on both backends", async () => {
    const [pg, lite] = await both((sql) => failure(() => sql`insert into ${sql(SCHEMA)}.uniq values (9, 'a')`));
    for (const k of ["constraint_name", "table_name", "schema_name", "detail", "message"])
      expect((lite as Record<string, unknown>)[k], k).toEqual((pg as Record<string, unknown>)[k]);
    expect((lite as Record<string, unknown>).constraint_name).toBe("uniq_u_key");
    const [pgNull, liteNull] = await both((sql) => failure(() => sql`insert into ${sql(SCHEMA)}.uniq (id, u) values (${null}, 'z')`));
    expect((liteNull as Record<string, unknown>).column_name).toBe("id");
    expect((liteNull as Record<string, unknown>).column_name).toEqual((pgNull as Record<string, unknown>).column_name);
  });

  it("[[pglite.errors.connection-ended]] a client that has ended fails with CONNECTION_ENDED on both backends: a connection error, a database error", async () => {
    const ended = [
      createClient({ connectionString: container.getConnectionUri(), schema: SCHEMA }),
      createPgliteClient({ pglite, schema: SCHEMA }),
    ];
    const errors: unknown[] = [];
    for (const sql of ended) {
      await sql.end();
      errors.push(await failure(() => sql`select 1`));
    }
    for (const e of errors) {
      expect((e as { code?: unknown }).code).toBe("CONNECTION_ENDED");
      expect(translatePostgresError(e)).toBeInstanceOf(ConnectionError);
      expect(isDatabaseError(e)).toBe(true);
    }
    expect(errors[1]).toBeInstanceOf(PgliteSqlError);
  });

  it("[[pglite.errors.connection-closed]] a closed PGlite database fails with CONNECTION_CLOSED, a code postgres.js gives for a closed connection: a connection error, a database error", async () => {
    const db = await PGlite.create();
    const sql = createPgliteClient({ pglite: db, schema: "public" });
    expect([...(await sql`select 1 as one`)]).toEqual([{ one: 1 }]);
    await db.close();
    for (const run of [() => sql`select 1`, () => sql.begin((tx) => tx`select 1`), () => createPgliteClient({ pglite: db, schema: "other" })`select 1`]) {
      const e = await failure(run);
      expect(e).toBeInstanceOf(PgliteSqlError);
      expect((e as PgliteSqlError).code).toBe("CONNECTION_CLOSED");
      expect(translatePostgresError(e)).toBeInstanceOf(ConnectionError);
      expect(isDatabaseError(e)).toBe(true);
    }
  });

  it("[[pglite.errors.session-deadlock]] the single PGlite session: a statement that can never get it fails with PGLITE_SESSION_DEADLOCK, a database error (503), passed through unchanged by the error catalog", async () => {
    const sql = createPgliteClient({ pglite, schema: SCHEMA, deadlockTimeoutMs: 100 });
    const e = await failure(() => sql.begin(async () => sql`select 1`));
    expect([(e as PgliteSqlError).code, isDatabaseError(e)]).toEqual(["PGLITE_SESSION_DEADLOCK", true]);
    expect(translatePostgresError(e)).toBe(e);
    // The client's own usage errors stay internal errors (500), as postgres.js's do.
    const undef = await failure(() => sql`select ${undefined as never}`);
    expect([(undef as PgliteSqlError).code, isDatabaseError(undef)]).toEqual(["UNDEFINED_VALUE", false]);
  });

  it("[[pglite.errors.normalize]] normalizePgliteError: PGlite's own error is recognized by shape too; non-database values pass unchanged", async () => {
    const raw = createPgliteClient({ pglite, schema: SCHEMA, mapError: (e) => e });
    const e = await failure(() => raw`select * from ${raw(SCHEMA)}.no_such_table`);
    expect([(e as Error).name, (e as { code?: unknown }).code, e instanceof PglitePostgresError]).toEqual(["error", "42P01", false]);
    expect(isDatabaseError(e)).toBe(true);
    expect(translatePostgresError(e)).toBeInstanceOf(UnrecognizedPostgresError);
    const n = normalizePgliteError(e) as PglitePostgresError;
    expect([n.name, n.code, n.severity, n.message, n.query]).toEqual(["PostgresError", "42P01", "ERROR", (e as Error).message, `select * from "${SCHEMA}".no_such_table`]);
    expect(normalizePgliteError(n)).toBe(n);
    const notDb = [new Error("plain"), Object.assign(new Error("app"), { code: "ENOENT" }), Object.assign(new Error("lookalike"), { code: "23505" }), "text", null];
    for (const v of notDb) expect(normalizePgliteError(v)).toBe(v);
    // Without a severity, a SQLSTATE-looking code alone is not a database error (unchanged behaviour).
    expect(isDatabaseError(Object.assign(new Error("lookalike"), { code: "23505" }))).toBe(false);
    expect(isDatabaseError(Object.assign(new Error("app"), { code: "VALIDATION_FAILED", severity: "ERROR" }))).toBe(false);
  });
});
