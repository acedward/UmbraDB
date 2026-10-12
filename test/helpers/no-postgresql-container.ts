/**
 * Stands in for `@testcontainers/postgresql` when the tests run on PGlite (`UMBRADB_BACKEND=pglite`, see
 * `vitest.config.ts`): a test file that still starts its own PostgreSQL container fails at once, naming the two ways
 * out, instead of quietly running on PostgreSQL.
 */
export class PostgreSqlContainer {
  constructor(image?: string) {
    throw new Error(
      `UMBRADB_BACKEND=pglite: this test file starts a PostgreSQL container (${image ?? "no image"}); open its database ` +
        "with openTestDatabase() (test/helpers/test-database.ts), or list the file in POSTGRESQL_ONLY.files " +
        "(test/helpers/postgresql-only.ts) with the reason",
    );
  }
}
