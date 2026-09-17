import * as migration000 from "../000_schema.js";
import * as tokenIndexCore from "./001_token_index_core.js";
import type { Migration } from "../../migrate.js";

/**
 * The `token_index` migration lineage — project 00020's token table (spec §6.1).
 *
 * Structurally identical to the `chain_archive` and `evm_rpc` lineages next door, for the same
 * reason and by the same mechanism: `000_schema.ts` is REUSED unchanged (its `up(sql, schema)` is
 * fully schema-parameterised, so running it against `token_index` bootstraps an independent
 * `token_index._migrations` table), and a caller selects this lineage with
 * `runMigrations(sql, { schema: "token_index", migrations: tokenIndexMigrations })`. No new runner
 * machinery was needed — `RunMigrationsOptions.migrations` already exists for exactly this.
 *
 * **Not wired into any executing path**, matching both sibling lineages' posture: nothing in
 * `src/` imports this. The consumer is `token-indexer/*`, which applies it explicitly against its
 * own schema — `src/` behaviour is untouched, a hard constraint of this project.
 *
 * The two built-in rows (NIGHT and DUST, owner decision Q7) are NOT part of the lineage: they are
 * per-`net` data, not schema. `001_token_index_core.ts` exports `seedBuiltinTokens(sql, schema,
 * net)` for that, which `token-indexer/migrate.ts` calls right after the lineage and `rebuild`
 * calls again after truncating.
 */
export const tokenIndexMigrations: Migration[] = [migration000, tokenIndexCore];

/** The conventional schema name this lineage lives in. */
export const TOKEN_INDEX_SCHEMA = "token_index";

export { seedBuiltinTokens, BUILTIN_KEYS } from "./001_token_index_core.js";
