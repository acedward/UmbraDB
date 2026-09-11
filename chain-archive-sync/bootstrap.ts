import { PgChainArchiveStore } from "../src/postgres/chain-archive-store.js";
import { runMigrations } from "../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../src/postgres/migrations/chain_archive/index.js";
import type { UmbraDBSql } from "../src/postgres/client.js";

/**
 * Tier-1.5 bootstrap used by the packaged archive-sync CLI before ingest. It applies the complete
 * independent lineage through the shared migration runner; integration and migration tests invoke
 * this same path against real PostgreSQL rather than maintaining a test-only schema setup.
 *
 * `net` is optional and, when given, additionally mints this archive's instance identity for that
 * net (spec/00009 FR-028) so it exists from bootstrap rather than from the first ingested block.
 * Minting is idempotent -- an archive already carrying an identity keeps it -- so passing `net` on
 * every boot is safe and is what the CLI does.
 */
export async function bootstrapChainArchiveSchema(
  sql: UmbraDBSql, schema = "chain_archive", opts?: { net?: string },
): Promise<void> {
  await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
  if (opts?.net !== undefined) {
    await new PgChainArchiveStore(sql, schema).ensureArchiveInstanceId(opts.net);
  }
}
