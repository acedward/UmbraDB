#!/usr/bin/env node
/**
 * The suite on PGlite in Node (`npm run test:pglite`): no database server, no Docker.
 *
 *   1. `vitest run` with `UMBRADB_BACKEND=pglite`: every test file opens an in-memory PGlite database
 *      (`test/helpers/test-database.ts`); the PostgreSQL-only files are not collected and the PostgreSQL-only tests are
 *      skipped (`test/helpers/postgresql-only.ts`, which gives each one's reason); a JSON report is written.
 *   2. `check-required-tests.ts --postgresql-only` over that report: every required id passed, except the listed
 *      PostgreSQL-only ones, which must be not run (their file) or skipped (their test), never run.
 *
 * No coverage thresholds: they belong to the PostgreSQL gate (`npm run test:conformance`), which runs every file.
 * Exits non-zero if either step fails. Extra arguments are passed to vitest (for example a file filter).
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(repoRoot, ".pglite-report.json");
const checker = resolve(repoRoot, "test/integration/check-required-tests.ts");
const forwarded = process.argv.slice(2);

const env = { ...process.env, UMBRADB_BACKEND: "pglite" };
delete env.UMBRADB_LIVE_PREPROD;
rmSync(reportPath, { force: true });

const vitest = spawnSync(
  "npx",
  ["vitest", "run", "--reporter=default", "--reporter=json", `--outputFile=${reportPath}`, ...forwarded],
  { cwd: repoRoot, env, stdio: "inherit", shell: process.platform === "win32" },
);
const vitestExit = vitest.status ?? 1;

if (!existsSync(reportPath)) {
  console.error(`\npglite-gate: FATAL — vitest produced no JSON report at ${reportPath}; cannot reconcile required tests.`);
  process.exit(vitestExit || 1);
}

console.log("\npglite-gate: reconciling the required-tests manifest (PostgreSQL-only ids allowed) against the run…");
const check = spawnSync("node", ["--import", "tsx", checker, reportPath, "--postgresql-only"], {
  cwd: repoRoot, env, stdio: "inherit", shell: process.platform === "win32",
});
const checkExit = check.status ?? 1;

if (vitestExit !== 0) console.error(`pglite-gate: vitest exited ${vitestExit}.`);
if (checkExit !== 0) console.error(`pglite-gate: check-required-tests exited ${checkExit} (a required test did not pass on PGlite and is not PostgreSQL-only).`);

process.exit(vitestExit || checkExit);
