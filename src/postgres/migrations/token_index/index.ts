import * as migration000 from "../000_schema.js";
import * as tokenIndexCore from "./001_token_index_core.js";
import * as mipLayout from "./002_mip_xxxx_layout.js";
import type { Migration } from "../../migrate.js";

/**
 * The `token_index` migration lineage — the token table of projects 00020 and 00021.
 *
 * Structurally identical to the `chain_archive` and `evm_rpc` lineages next door, for the same
 * reason and by the same mechanism: `000_schema.ts` is REUSED unchanged (its `up(sql, schema)` is
 * fully schema-parameterised, so running it against `token_index` bootstraps an independent
 * `token_index._migrations` table), and a caller selects this lineage with
 * `runMigrations(sql, { schema: "token_index", migrations: tokenIndexMigrations })`. No new runner
 * machinery was needed — `RunMigrationsOptions.migrations` already exists for exactly this.
 *
 * `001` is the 00020 shape (`kind` as a word, `storage` as an independent column, `key_text` in the
 * kv primary key, a `len` byte and no value type) and is kept verbatim as history; `002` is the
 * MIP PR #315 shape and DROPS and recreates what `001` built (spec 00021 FR-107, Q3). Both run, in
 * order, on a fresh database — the derived tables live for the length of one migration run there,
 * which costs nothing and keeps the lineage honest about how this schema actually got here.
 *
 * **Not wired into any executing path**, matching both sibling lineages' posture: nothing in
 * `src/` imports this. The consumer is `token-indexer/*`, which applies it explicitly against its
 * own schema — `src/` behaviour is untouched, a hard constraint of these projects.
 *
 * The two built-in rows (NIGHT and DUST, 00020 owner decision Q7) are NOT part of the lineage: they
 * are per-`net` data, not schema. They are defined beside the CURRENT shape, in
 * `002_mip_xxxx_layout.ts`, and `token-indexer/bootstrap.ts` inserts them right after the lineage
 * runs (`rebuild` calls the same function again after deleting).
 */
export const tokenIndexMigrations: Migration[] = [migration000, tokenIndexCore, mipLayout];

/** The conventional schema name this lineage lives in. */
export const TOKEN_INDEX_SCHEMA = "token_index";

export { seedBuiltinTokens, BUILTIN_KEYS } from "./002_mip_xxxx_layout.js";
