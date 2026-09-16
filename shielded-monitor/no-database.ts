/**
 * The boot-time refusal that makes "project B has no database" an operational fact rather than a
 * code-review observation (sub-plan 00009-08 v2; owner question Q25; `spec/00009` FR-025).
 *
 * ── Why a refusal and not a warning ─────────────────────────────────────────────────────────
 * Two mechanisms already say B holds no database: the import guard
 * (`test/shielded-monitor/import-boundary.test.ts`) proves no module under `shielded-monitor/**`
 * can reach `postgres` or `src/postgres/**` by any chain of imports, and the v2 entry points
 * simply have no connection string to use. Neither of them notices a `MONITOR_PG` left in a
 * container's environment after a migration to the split topology — and that leftover is not
 * cosmetic: it is a **live credential for the main database** sitting in the environment of a
 * process whose entire reason for existing is that it has none. Anything that later execs inside
 * that container inherits it.
 *
 * So the process names the variables it found and exits. There is no "it probably meant".
 *
 * ── What it refuses ─────────────────────────────────────────────────────────────────────────
 * - any variable whose name ends in `_PG` (`MONITOR_PG`, `ARCHIVE_PG`, `SHIELDED_MONITOR_PG`, …)
 *   — the connection-string convention this repository uses everywhere;
 * - the schema names of A's and B's tables, which describe a topology in which this process
 *   reaches a database directly and which Rule B says B must not carry at all.
 *
 * It deliberately does NOT refuse libpq's own `PGHOST`/`PGUSER`/`PGPASSWORD` family: those are
 * inert here (B ships no driver to read them), they are frequently set in a developer's shell for
 * unrelated reasons, and failing a scanner because someone has `psql` configured would be a
 * refusal with no security value.
 */

/** Schema variables that describe the removed in-process topology. */
const REFUSED_SCHEMA_VARIABLES = ["ARCHIVE_SCHEMA", "MONITOR_SCHEMA", "SHIELDED_MONITOR_SCHEMA"] as const;

/** Thrown by {@link assertNoDatabaseEnvironment}; the CLI prints the message and exits 1. */
export class DatabaseEnvironmentError extends Error {
  constructor(readonly component: string, readonly variables: readonly string[]) {
    super(
      `${component} found database configuration in its environment: ${variables.join(", ")}.\n\n` +
        "Project B has no database connection in this topology (owner decision Q25): it reads and " +
        "writes everything through STORAGE_URL, and umbradb-storage-api is the only process that " +
        "holds a credential for the main database. Refusing to start rather than running with a " +
        "credential in the environment of a process that must not have one.\n\n" +
        "If you are migrating from the single-host deployment: move these variables to the " +
        "umbradb-storage-api service and give this one STORAGE_URL. See " +
        "docs/shielded-monitor-deployment.md.",
    );
    this.name = "DatabaseEnvironmentError";
  }
}

/** Every refused variable present in `env`, in the order they are listed above. */
export function databaseVariablesIn(env: NodeJS.ProcessEnv): string[] {
  const found = Object.keys(env)
    .filter((name) => name.endsWith("_PG") && (env[name] ?? "").trim() !== "")
    .sort();
  for (const name of REFUSED_SCHEMA_VARIABLES) {
    if ((env[name] ?? "").trim() !== "") found.push(name);
  }
  return found;
}

/** @throws {DatabaseEnvironmentError} when any refused variable is set. */
export function assertNoDatabaseEnvironment(env: NodeJS.ProcessEnv, component: string): void {
  const found = databaseVariablesIn(env);
  if (found.length > 0) throw new DatabaseEnvironmentError(component, found);
}
