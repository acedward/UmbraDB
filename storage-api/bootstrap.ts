import { runMigrations } from "../src/postgres/migrate.js";
import { shieldedMonitorMigrations } from "../src/postgres/migrations/shielded_monitor/index.js";
import type { UmbraDBSql } from "../src/postgres/client.js";

/** The schema project B owns. Owner Rule B (organizer spec US5/FR-025): B writes here and
 *  nowhere else, and never to an archive table. */
export const DEFAULT_SHIELDED_MONITOR_SCHEMA = "shielded_monitor";

/**
 * Applies project B's independent migration lineage through the shared runner, the same shape
 * `chain-archive-sync/bootstrap.ts` uses for Tier-1.5. Idempotent: re-running against an
 * already-migrated schema applies zero migrations.
 *
 * A deployment that never calls this is byte-for-byte unaffected by project B — no existing
 * lineage, table or gate changes (organizer spec US6/SC-007).
 */
export async function bootstrapShieldedMonitorSchema(
  sql: UmbraDBSql,
  schema: string = DEFAULT_SHIELDED_MONITOR_SCHEMA,
): Promise<void> {
  await runMigrations(sql, { schema, migrations: shieldedMonitorMigrations });
}
