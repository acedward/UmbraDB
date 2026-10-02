import { runMigrations, type Migration } from "../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../src/postgres/migrations/chain_archive/index.js";
import * as txResultSegments from "../src/postgres/migrations/chain_archive/002_tx_result_segments.js";
import type { UmbraDBSql } from "../src/postgres/client.js";

/**
 * The lineage this consumer actually applies: the `src/`-owned `chainArchiveMigrations` plus
 * project 00020's additive `002_tx_result_segments` (spec FR-002 — `segments jsonb` on
 * `transactions`, so a `PARTIAL_SUCCESS` transaction's per-segment outcome is archived and the
 * token scanner never has to guess which fallible mint applied).
 *
 * Composed HERE rather than appended to `chainArchiveMigrations` in `src/`: nothing under `src/`
 * may be modified by this project (the repo's hard rule), and `test/postgres/chain-archive-migrate.test.ts`
 * pins that array's exact contents. `_migrations` tracks each migration by name, so an archive
 * bootstrapped by the old lineage picks the new one up on the next start — `ALTER TABLE … ADD
 * COLUMN` on the partitioned parent is metadata-only, with the column NULL for existing rows.
 */
export const chainArchiveMigrationsWithResults: Migration[] = [...chainArchiveMigrations, txResultSegments];

/**
 * The real invocation path `chainArchiveMigrations` was missing (`src/postgres/migrate.ts`'s own
 * doc: "nothing in this repo's application code passes this today"). Mirrors how the Tier-1
 * lineage is actually invoked in this codebase: there is no dedicated CLI entry point or npm
 * script for `tier1WalletMigrations` either (checked -- `package.json` has no `migrate` script,
 * and the only real callers of `runMigrations` anywhere in this repo are test setup helpers,
 * `test/postgres/setup.ts:26` and `test/postgres/chain-archive-migrate.test.ts`'s own direct
 * calls) -- this codebase's established pattern is "the consuming module bootstraps its own
 * schema on startup," not a separate migration-runner binary. `bootstrapChainArchiveSchema` is
 * that pattern's Tier-1.5 equivalent: the one real, non-test call site a production caller (or
 * this directory's own sync service / integration tests) uses before ingesting anything, and it
 * IS exercised for real against a live Postgres instance by
 * `test/integration/chain-archive-sync.integration.test.ts` (not just the already-existing
 * `test/postgres/chain-archive-migrate.test.ts` unit-level migration test).
 */
export async function bootstrapChainArchiveSchema(sql: UmbraDBSql, schema = "chain_archive"): Promise<void> {
  await runMigrations(sql, { schema, migrations: chainArchiveMigrationsWithResults });
}
