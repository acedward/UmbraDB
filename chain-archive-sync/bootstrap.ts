import { runMigrations } from "../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../src/postgres/migrations/chain_archive/index.js";
import type { UmbraDBSql } from "../src/postgres/client.js";

/**
 * Tier-1.5 bootstrap used by the packaged archive-sync CLI before ingest. It applies the complete
 * independent lineage through the shared migration runner; integration and migration tests invoke
 * this same path against real PostgreSQL rather than maintaining a test-only schema setup.
 */
export async function bootstrapChainArchiveSchema(sql: UmbraDBSql, schema = "chain_archive"): Promise<void> {
  await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
}
