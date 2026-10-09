/**
 * Schema-name rules shared by the PostgreSQL client (`client.ts`) and the PGlite client (`pglite-sql.ts`). This module
 * imports no driver, so a runtime that does not load postgres.js can validate schema names too.
 */

/** Default schema — see `openspec/changes/sprint-1-setup-and-temporal-kv/design.md` §0: a
 *  library default, not a name UmbraDB itself is embedded under. */
export const DEFAULT_SCHEMA = "umbradb";

/**
 * Schema names must be safe to interpolate as SQL identifiers via `postgres.js`'s `sql(name)`
 * helper. `sql(name)` already quotes/escapes correctly regardless of content, so this regex is
 * defense-in-depth (a malformed config value fails fast with a clear message here, rather than
 * producing confusing downstream DDL) — see design.md §2.
 *
 * **Length bound added after a cross-vendor audit**: Postgres truncates identifiers longer
 * than 63 bytes (`NAMEDATALEN - 1`) rather than rejecting them, so two configured schema names
 * agreeing on their first 63 characters would silently address the SAME physical schema —
 * while this module's own `hashtext()`-based advisory-lock keys (`migrate.ts`) hash the FULL
 * string and would NOT collide, letting two "different" schemas' migrations run unlocked
 * against one physical schema at the same time. Rejecting anything over the limit here closes
 * that gap at the source rather than relying on every caller of `hashtext()` to know about it.
 */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const POSTGRES_MAX_IDENTIFIER_BYTES = 63;

export function assertValidSchemaName(schema: string): void {
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new Error(`invalid schema name: ${JSON.stringify(schema)} (must match ${SCHEMA_NAME_PATTERN})`);
  }
  if (schema.length > POSTGRES_MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `invalid schema name: ${JSON.stringify(schema)} exceeds PostgreSQL's ${POSTGRES_MAX_IDENTIFIER_BYTES}-byte identifier limit`,
    );
  }
}
