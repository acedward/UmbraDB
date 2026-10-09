/**
 * The tests that run on PostgreSQL only, and why: the one machine-readable list behind the database switch
 * (`UMBRADB_BACKEND`, `test/helpers/test-database.ts`).
 *
 * - `files`: test files that are not run when the backend is PGlite (`vitest.config.ts` excludes them). Their required
 *   ids are reconciled as PostgreSQL-only by `check-required-tests.ts --postgresql-only`.
 * - `tests`: single tests of files that do run on PGlite. Each is skipped there through {@link skipOnPglite} and must
 *   be reported skipped, never passed.
 * - `parts`: parts of tests that run on both backends; the part runs only on PostgreSQL ({@link onPostgresql}, by the
 *   part's name), the rest of the test runs on both.
 *
 * Every entry names its file (repository-relative) and the reason. This module has no dependencies, so the Vitest
 * configuration and the reconciliation can read it.
 */

export type TestBackend = "postgres" | "pglite";

/** The database the tests run on: `UMBRADB_BACKEND` = `postgres` (default) or `pglite`. */
export function testBackendFrom(value: string | undefined): TestBackend {
  if (value === undefined || value === "" || value === "postgres") return "postgres";
  if (value === "pglite") return "pglite";
  throw new Error(`UMBRADB_BACKEND must be "postgres" or "pglite", got ${JSON.stringify(value)}`);
}

export const TEST_BACKEND: TestBackend = testBackendFrom(process.env.UMBRADB_BACKEND);

export interface PostgresqlOnlyTest {
  file: string;
  reason: string;
}

export interface PostgresqlOnlyPart {
  /** The part's name, unique, as passed to {@link onPostgresql}. */
  part: string;
  file: string;
  /** The test holding the part: its `[[id]]`, or its title when it has none. */
  test: string;
  reason: string;
}

const WALLET_STORAGE =
  "the wallet-storage library (checkpoint store, temporal key-value store, transaction lease, watermarks and their " +
  "durability contract): PostgreSQL by design (server-side timeouts, several sessions, advisory locks, pooler and " +
  "durability checks); the token indexer does not use it";
const CRASH =
  "kills PostgreSQL backends, the PostgreSQL server or a writer process connected to it by URL, and checks what the " +
  "server kept; an in-memory PGlite database lives in the test process";
const EVM_RPC = "the EVM RPC service and its log store: not part of the token indexer; its tests start PostgreSQL";
const WALLET_MONITOR = "the wallet monitor: not part of the token indexer; its tests start PostgreSQL";

export const POSTGRESQL_ONLY: {
  files: Record<string, string>;
  tests: Record<string, PostgresqlOnlyTest>;
  parts: PostgresqlOnlyPart[];
} = {
  files: {
    // The wallet-storage library.
    "test/postgres/checkpoint-id-validation.test.ts": WALLET_STORAGE,
    "test/postgres/checkpoint-store-cotx.test.ts": WALLET_STORAGE,
    "test/postgres/checkpoint-store.property.test.ts": WALLET_STORAGE,
    "test/postgres/checkpoint-store.test.ts": WALLET_STORAGE,
    "test/postgres/differential-equivalence.test.ts": WALLET_STORAGE,
    "test/postgres/json-depth.test.ts": WALLET_STORAGE,
    "test/postgres/perf-batching.test.ts": WALLET_STORAGE,
    "test/postgres/save-and-advance.property.test.ts": WALLET_STORAGE,
    "test/postgres/save-and-advance.test.ts": WALLET_STORAGE,
    "test/postgres/temporal-kv.property.test.ts": WALLET_STORAGE,
    "test/postgres/temporal-kv.test.ts": WALLET_STORAGE,
    "test/postgres/transaction-history-storage.property.test.ts": WALLET_STORAGE,
    "test/postgres/transaction-history-storage.test.ts": WALLET_STORAGE,
    "test/postgres/transaction-lease.property.test.ts": WALLET_STORAGE,
    "test/postgres/transaction-lease.test.ts": WALLET_STORAGE,
    "test/postgres/wallet-state-envelope.test.ts": WALLET_STORAGE,
    "test/postgres/watermarks.property.test.ts": WALLET_STORAGE,
    "test/postgres/watermarks.test.ts": WALLET_STORAGE,
    "test/postgres/with-lease-release-fault.test.ts": WALLET_STORAGE,
    "test/integration/pg-tx-history-adapter.test.ts": WALLET_STORAGE,
    "test/integration/soak/full-sync-soak.integration.test.ts": WALLET_STORAGE,
    "test/integration/soak/load-under-prune.integration.test.ts": WALLET_STORAGE,
    "test/integration/preprod-db-sync.integration.test.ts": WALLET_STORAGE,
    "test/integration/cold-boot-recovery.integration.test.ts": WALLET_STORAGE,
    // PostgreSQL server behaviour.
    "test/postgres/timeouts.test.ts": "statement_timeout, lock_timeout and idle_in_transaction_session_timeout of PostgreSQL connections; PGlite does not enforce statement_timeout and has one session",
    "test/postgres/migration-lock-timeout.test.ts": "a migration lock held by a second PostgreSQL session and the lock_timeout bound; PGlite has one session",
    "test/postgres/migrate.test.ts": "the migration runner with the wallet-storage lineage (btree_gist) on concurrent PostgreSQL sessions, and connection failures by URL; the chain-archive and mip0018 lineages migrate through the same runner on PGlite in the token-indexer and chain-archive tests",
    "test/postgres/durability-probe.test.ts": "the durability probe against PostgreSQL servers started with fsync, full_page_writes and synchronous_commit settings, and its pooler check across sessions",
    "test/postgres/errors.test.ts": "SQLSTATE routing of PostgreSQL errors raised by the migrated chain-archive schema, through a PostgreSQL connection",
    "test/postgres/pglite-sql.differential.test.ts": "compares the PGlite client with postgres.js on PostgreSQL 17, so it needs PostgreSQL",
    // Crash runs.
    "test/integration/crash/crash-harness.smoke.test.ts": CRASH,
    "test/integration/crash/cursor-durability.crash.test.ts": CRASH,
    "test/integration/crash/lease-nonwedge.crash.test.ts": CRASH,
    "test/integration/crash/pg-kill-save.crash.test.ts": CRASH,
    "test/integration/crash/process-kill-save.crash.test.ts": CRASH,
    "test/integration/crash/saveandadvance-cotx.crash.test.ts": CRASH,
    // Other services.
    "evm-rpc/logs/test/backfill.test.ts": EVM_RPC,
    "evm-rpc/logs/test/get-logs.test.ts": EVM_RPC,
    "evm-rpc/logs/test/ingest-crash.test.ts": EVM_RPC,
    "evm-rpc/logs/test/ingest.test.ts": EVM_RPC,
    "evm-rpc/logs/test/migration-and-store.test.ts": EVM_RPC,
    "evm-rpc/logs/test/subscribe.test.ts": EVM_RPC,
    "evm-rpc/test/receipt-logs.test.ts": EVM_RPC,
    "wallet-monitor/store.test.ts": WALLET_MONITOR,
    "wallet-monitor/tx-hash-backfill.test.ts": WALLET_MONITOR,
  },
  tests: {
    "mip0018.activity.kill-resume": {
      file: "token-indexer/test/mip0018-activity.test.ts",
      reason: "SIGKILLs the scan CLI, a child process connected to PostgreSQL by URL, inside a block's transaction and terminates its server backends; a crash inside a block on PGlite is [[mip0018.scan.resume-identical]]",
    },
    "mip0018.activity.bounded-cost": {
      file: "token-indexer/test/mip0018-activity.test.ts",
      reason: "measures the PostgreSQL planner: auto_explain buffer counts read from server notices on a second session, with autovacuum off and VACUUM/ANALYZE statistics states",
    },
    "mip0018.scan.cli": {
      file: "token-indexer/test/mip0018-scan.test.ts",
      reason: "the scan CLI opens its database from PG_URL (a PostgreSQL server)",
    },
    "mip0018.vectors.pg-runner-cli": {
      file: "token-indexer/test/mip0018-vectors-pg.test.ts",
      reason: "the vector adapter runs as a child process that opens its database from PG_URL (a PostgreSQL server); the same 110 requests through the same consumer run on PGlite in [[mip0018.vectors.pg-adapter]]",
    },
    "archive.sync.resume-kill-identical": {
      file: "test/integration/chain-archive-sync-range.integration.test.ts",
      reason: "SIGKILLs the archive sync CLI, a child process connected to PostgreSQL by URL (ARCHIVE_PG), and resumes it",
    },
  },
  parts: [
    {
      part: "serve-cli-process",
      file: "token-indexer/test/mip0018-api.test.ts",
      test: "[[mip0018.api.serve-cli]]",
      reason: "the serve CLI as a child process and its argument checks open the database from PG_URL (a PostgreSQL server); serve() with the scan loop, a stalled scan and the usage check run on both",
    },
    {
      part: "role-delete-lock-race",
      file: "test/postgres/chain-archive-migrate.test.ts",
      test: "v4: rejects deleting a chain_blob_roles row still referenced by a live row, allows deleting an unreferenced one, and closes the concurrent-deletion race",
      reason: "two reserved sessions, one blocked on the other's row lock until it commits; PGlite has one session, so the second reservation waits for the first (the guard's rejections run on both)",
    },
  ],
};

/** The PostgreSQL-only files, as `vitest` exclude patterns. */
export const POSTGRESQL_ONLY_FILES: readonly string[] = Object.keys(POSTGRESQL_ONLY.files);

/**
 * True when the backend is PGlite and `id` is a listed PostgreSQL-only test: `it.skipIf(skipOnPglite(id))(…)`.
 * Throws for an id that is not listed, so a test cannot be skipped on PGlite without a reason here.
 */
export function skipOnPglite(id: string, backend: TestBackend = TEST_BACKEND): boolean {
  if (POSTGRESQL_ONLY.tests[id] === undefined) throw new Error(`[[${id}]] is not in POSTGRESQL_ONLY.tests (test/helpers/postgresql-only.ts)`);
  return backend === "pglite";
}

/**
 * True when the backend is PostgreSQL, for a listed PostgreSQL-only part of a test: `if (onPostgresql(part)) …`.
 * Throws for a part that is not listed.
 */
export function onPostgresql(part: string, backend: TestBackend = TEST_BACKEND): boolean {
  if (!POSTGRESQL_ONLY.parts.some((p) => p.part === part))
    throw new Error(`part "${part}" is not in POSTGRESQL_ONLY.parts (test/helpers/postgresql-only.ts)`);
  return backend === "postgres";
}
