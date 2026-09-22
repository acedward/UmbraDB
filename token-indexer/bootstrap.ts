import { runMigrations } from "../src/postgres/migrate.js";
import {
  seedBuiltinTokens,
  tokenIndexMigrations,
} from "../src/postgres/migrations/token_index/index.js";
import type { UmbraDBSql } from "../src/postgres/client.js";

/**
 * Applies the `token_index` lineage and inserts the two built-in rows for `net` — the real
 * invocation path for `tokenIndexMigrations`, mirroring `chain-archive-sync/bootstrap.ts`. This
 * codebase's established pattern is "the consuming module bootstraps its own schema on startup",
 * not a separate migration-runner binary, and `src/` may not import this direction anyway.
 *
 * Idempotent in both halves: `runMigrations` skips already-applied migrations, and the seeds are
 * `ON CONFLICT DO NOTHING`, so calling this on every start is safe and is what `serve` does.
 */
export async function bootstrapTokenIndexSchema(
  sql: UmbraDBSql, opts: { schema?: string; net: string },
): Promise<void> {
  const schema = opts.schema ?? "token_index";
  await runMigrations(sql, { schema, migrations: tokenIndexMigrations });
  await seedBuiltinTokens(sql, schema, opts.net);
}

/**
 * `rebuild` (spec §6.6): drops every derived row of one net and re-seeds the built-ins, leaving
 * the schema and the ARCHIVE untouched. This is the alpha's answer to a parser or schema change —
 * not to forks, which this lineage cannot have (the archive is finalized-only).
 *
 * **Required once after migration 003** (project 00023, owner decision Q3): that migration changes
 * the identity of `tokens` and adds the three activity tables, so an existing index has to be
 * regenerated from the archive. `rebuild` is what regenerates it, and spec 00023 FR-005 is the
 * assertion that it reproduces a live run's rows exactly, activity rows included.
 *
 * Deliberately per-`net` `DELETE`s rather than `TRUNCATE`: the same database may hold more than
 * one net's rows, and truncating would silently destroy another net's index.
 */
export async function rebuildTokenIndex(
  sql: UmbraDBSql, opts: { schema?: string; net: string },
): Promise<void> {
  const schema = opts.schema ?? "token_index";
  const net = opts.net;
  await sql.begin(async (tx) => {
    await tx`DELETE FROM ${tx(schema)}.token_activity WHERE net = ${net}`;
    await tx`DELETE FROM ${tx(schema)}.shielded_offers WHERE net = ${net}`;
    await tx`DELETE FROM ${tx(schema)}.contract_calls WHERE net = ${net}`;
    await tx`DELETE FROM ${tx(schema)}.token_metadata_kv WHERE net = ${net}`;
    await tx`DELETE FROM ${tx(schema)}.token_metadata_events WHERE net = ${net}`;
    await tx`DELETE FROM ${tx(schema)}.token_mints WHERE net = ${net}`;
    await tx`DELETE FROM ${tx(schema)}.tokens WHERE net = ${net}`;
    await tx`DELETE FROM ${tx(schema)}.pending_event_lookups WHERE net = ${net}`;
    await tx`DELETE FROM ${tx(schema)}.contracts WHERE net = ${net}`;
    await tx`DELETE FROM ${tx(schema)}.cursors WHERE net = ${net}`;
    await seedBuiltinTokens(tx, schema, net);
  });
}
