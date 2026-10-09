/**
 * The database a test file runs on, PostgreSQL or PGlite, chosen by `UMBRADB_BACKEND` (`postgres`, the default, or
 * `pglite`).
 *
 * - PostgreSQL: one Postgres 17 container (Testcontainers) per test file; each client is `createClient` on it.
 * - PGlite: one in-memory PGlite database per test file, in the test process; each client is a PGlite client
 *   (`src/postgres/pglite-sql.ts`) over it, and all of them share its one session.
 *
 * A file opens its database once (`openTestDatabase()` in `beforeAll`), takes one client per schema with
 * `db.client(schema)`, and stops it in `afterAll`. Tests that need a PostgreSQL server (a child process connecting by
 * URL, server settings, several sessions) are listed in `postgresql-only.ts`; `connectionUri()` throws on PGlite.
 *
 * The test clients read every type as the PostgreSQL clients do (`createClient`): int8 as `bigint`, numeric as text,
 * bytea as `Buffer`; and a PGlite database error carries the name and the `constraint_name` field of a postgres.js
 * `PostgresError`.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createClient, type UmbraDBConnectionOptions, type UmbraDBSql } from "../../src/postgres/client.js";
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";
import { TEST_BACKEND, type TestBackend } from "./postgresql-only.ts";

export { TEST_BACKEND, type TestBackend } from "./postgresql-only.ts";

/** The PostgreSQL image every test container runs. */
export const POSTGRES_IMAGE = "postgres:17-alpine";

export type TestClientOptions = Pick<UmbraDBConnectionOptions, "maxConnections">;

export interface TestDatabase {
  readonly backend: TestBackend;
  /** A client whose schema and `search_path` is `schema`. `maxConnections` applies to PostgreSQL only (PGlite has one
   *  session). */
  client(schema: string, options?: TestClientOptions): UmbraDBSql;
  /** The PostgreSQL connection URI, for a child process or a second driver. Throws on PGlite. */
  connectionUri(): string;
  /** Ends every client it handed out, then stops the container or closes the PGlite database. */
  stop(): Promise<void>;
}

// ── PGlite setup ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A PGlite database error as postgres.js reports one: named `PostgresError`, with the violated constraint in
 *  `constraint_name` (PGlite: `constraint`). */
function asPostgresError(e: unknown): unknown {
  const err = e as { name?: unknown; code?: unknown; severity?: unknown; constraint?: unknown; constraint_name?: unknown } | null;
  if (err === null || typeof err !== "object" || typeof err.code !== "string" || typeof err.severity !== "string") return e;
  err.name = "PostgresError";
  if (typeof err.constraint === "string" && err.constraint_name === undefined) err.constraint_name = err.constraint;
  return e;
}

/**
 * Opens the in-memory PGlite database of a test file and returns the options of its clients. PGlite starts here
 * without its `-F` start parameter, so `fsync` reads `on` and the migrations' durability probe accepts it; int8 is
 * parsed as `bigint` and bytea as `Buffer` (also inside arrays, hence instance parsers).
 */
async function openPglite(): Promise<{ pglite: PGlite; mapError: (e: unknown) => unknown }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = await PGlite.create({
    startParams: PGlite.defaultStartParams.filter((p) => p !== "-F"),
    parsers: { 20: (x: string) => BigInt(x), 17: (x: string) => Buffer.from(x.slice(2), "hex") },
  });
  return { pglite, mapError: asPostgresError };
}

// ── The database ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Opens the test file's database on {@link TEST_BACKEND}. */
export async function openTestDatabase(backend: TestBackend = TEST_BACKEND): Promise<TestDatabase> {
  const clients: UmbraDBSql[] = [];
  const track = (sql: UmbraDBSql): UmbraDBSql => {
    clients.push(sql);
    return sql;
  };
  const endClients = async (): Promise<void> => {
    for (const c of clients.splice(0)) await c.end({ timeout: 5 }).catch(() => undefined);
  };

  if (backend === "pglite") {
    const { pglite, mapError } = await openPglite();
    return {
      backend,
      client: (schema) => track(createPgliteClient({ pglite, schema, mapError })),
      connectionUri: () => {
        throw new Error("connectionUri(): an in-memory PGlite database has no server to connect to (UMBRADB_BACKEND=pglite)");
      },
      stop: async () => {
        await endClients();
        if (!pglite.closed) await pglite.close();
      },
    };
  }

  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  return {
    backend,
    client: (schema, options = {}) => track(createClient({ connectionString: container.getConnectionUri(), schema, ...options })),
    connectionUri: () => container.getConnectionUri(),
    stop: async () => {
      await endClients();
      await container.stop();
    },
  };
}
