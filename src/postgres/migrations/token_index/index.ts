import * as migration000 from "../000_schema.js";
import * as tokenIndexCore from "./001_token_index_core.js";
import * as mipLayout from "./002_mip_xxxx_layout.js";
import * as tokenActivity from "./003_token_activity.js";
import * as mip0018 from "./004_mip_0018.js";
import * as multipartPackages from "./005_multipart_packages.js";
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
 * MIP PR #315 draft shape and DROPS and recreates what `001` built (spec 00021 FR-107, Q3); `003`
 * is project 00023's — the colour identity, the `seen` status and the three activity tables — and
 * drops and recreates what `002` built for the same reason (spec 00023 Q3: the index is reindexed
 * from scratch, so breaking changes are allowed); `004` is the FINAL MIP-0018 shape — the event
 * name is the version, so the two metadata tables gain `name_variant` and the kv table gains
 * Null — and drops and recreates those two, for the same Q3 reason; `005` is project 00024-01's —
 * a metadata event row becomes a [Y] multi-part PACKAGE (merged payload, parts, segment, phase),
 * `val_len` reaches 65 535 (MIP-0018 amended in place, UC-1) and the ordering carries the
 * transaction position (MIP §6.2) — and drops and recreates the two metadata tables and the retry
 * queue (spec 00024 Q3: everything is in development, no data migration). All of them run, in
 * order, on a fresh database — the derived tables live for the length of one migration run there, which costs
 * nothing and keeps the lineage honest about how this schema actually got here.
 *
 * **Not wired into any executing path**, matching both sibling lineages' posture: nothing in
 * `src/` imports this. The consumer is `token-indexer/*`, which applies it explicitly against its
 * own schema — `src/` behaviour is untouched, a hard constraint of these projects.
 *
 * The two built-in rows (NIGHT and DUST, 00020 owner decision Q7) are NOT part of the lineage: they
 * are per-`net` data, not schema. They are defined beside the migration that last changed the
 * `tokens` table — still `003_token_activity.ts`, because `004` touches only the two metadata
 * tables — and `token-indexer/bootstrap.ts` inserts them right after the lineage runs (`rebuild`
 * calls the same function again after deleting). 004 does delete their rows, exactly as it deletes
 * every other derived row, and the re-seed that follows the lineage puts them back unchanged. 002's
 * copy stays where it is, as history: a database that applied 002 seeded itself against 002's
 * table shape.
 */
export const tokenIndexMigrations: Migration[] = [
  migration000, tokenIndexCore, mipLayout, tokenActivity, mip0018, multipartPackages,
];

/** The conventional schema name this lineage lives in. */
export const TOKEN_INDEX_SCHEMA = "token_index";

export { seedBuiltinTokens, BUILTIN_KEYS } from "./003_token_activity.js";
