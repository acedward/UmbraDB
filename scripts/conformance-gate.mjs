#!/usr/bin/env node
/**
 * The required conformance gate (v1.0.0-recovery-testing, Task 7 — `design.md` §0/§1.1).
 *
 * One command, two guarantees:
 *   1. `vitest run` with the coverage gate (thresholds in `vitest.config.ts`) — the crash, soak
 *      and differential suites run with `UMBRADB_LIVE_PREPROD` UNSET, so they execute against
 *      Testcontainers and do NOT self-skip; a Jest-compatible JSON report is emitted.
 *   2. the `check-required-tests.ts` reconciliation over that report — fails the gate by id if any
 *      manifest `"required"` test did not execute-and-pass (a re-introduced `describe.skipIf`
 *      turns the gate red by id, not by luck); `"deferred"` optional-feature ids reconcile as
 *      `skipped-pending-feature` and never fail the gate.
 *
 * The gate exits non-zero if EITHER vitest (tests OR coverage threshold) OR the reconciliation
 * fails. vitest runs first and always to completion; the reconciliation runs even when vitest
 * failed so a skipped required id is still NAMED. Extra CLI args are forwarded to vitest
 * (e.g. a file filter for a scoped local run).
 *
 * ── `VITEST_MAX_WORKERS`: uncapped by default, capped when you ask ───────────────────────────
 * Set `VITEST_MAX_WORKERS=N` to cap this run's worker count; leave it unset for vitest's own
 * default. The default is deliberately UNCHANGED: a dedicated CI runner should use every core,
 * and capping there would slow the required gate to fix a problem it does not have.
 *
 * On a SHARED machine it does have that problem. ~15 of this repo's test files provision their
 * own Postgres via Testcontainers, so an uncapped `--coverage` run asks a busy box for a
 * dozen-plus database containers at once; measured here, that produced container-startup
 * timeouts in a DIFFERENT random subset of crash/soak/migrate tests on every run -- including
 * against a commit whose suite was known-good, which makes the gate read as a regression it did
 * not find. `test/compose/docker-compose.yml`'s header documents the identical effect and the
 * identical fix for the in-container runner, and uses this same env var name; capping at 2 here
 * made `check-required-tests` reconcile all 25 required ids.
 *
 * An explicit `--maxWorkers=` in the forwarded CLI args still wins -- the env-derived flag is
 * placed BEFORE them.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(repoRoot, ".conformance-report.json");
const checker = resolve(repoRoot, "test/integration/check-required-tests.ts");
const forwarded = process.argv.slice(2);

const env = { ...process.env };
// Belt-and-suspenders: the crash/soak/differential suites run on Testcontainers, not the live
// tier — make sure the live gate is unset so nothing self-skips behind it.
delete env.UMBRADB_LIVE_PREPROD;

// Unset -> no flag at all, i.e. vitest's own default (correct on a dedicated CI runner).
const maxWorkers = process.env.VITEST_MAX_WORKERS?.trim();
// `[1-9]\d*` not `\d+`: `--maxWorkers=0` is not a cap, it is a nonsense value vitest would have
// to interpret, and it would arrive here looking deliberate.
if (maxWorkers !== undefined && maxWorkers !== "" && !/^[1-9]\d*$/.test(maxWorkers)) {
  console.error(
    `conformance-gate: VITEST_MAX_WORKERS must be a positive integer, got ${JSON.stringify(maxWorkers)}.`,
  );
  process.exit(1);
}
const workerArgs = maxWorkers ? [`--maxWorkers=${maxWorkers}`] : [];
if (workerArgs.length > 0) console.log(`conformance-gate: capping vitest at ${maxWorkers} worker(s) (VITEST_MAX_WORKERS).`);

const vitest = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--coverage",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${reportPath}`,
    ...workerArgs,
    ...forwarded,
  ],
  { cwd: repoRoot, env, stdio: "inherit", shell: process.platform === "win32" },
);
const vitestExit = vitest.status ?? 1;

if (!existsSync(reportPath)) {
  console.error(
    `\nconformance-gate: FATAL — vitest produced no JSON report at ${reportPath}; cannot reconcile required tests.`,
  );
  process.exit(vitestExit || 1);
}

console.log("\nconformance-gate: reconciling the required-tests manifest against the run…");
const check = spawnSync(
  "node",
  ["--import", "tsx", checker, reportPath],
  { cwd: repoRoot, env, stdio: "inherit", shell: process.platform === "win32" },
);
const checkExit = check.status ?? 1;

if (vitestExit !== 0) console.error(`conformance-gate: vitest exited ${vitestExit} (tests or coverage threshold failed).`);
if (checkExit !== 0) console.error(`conformance-gate: check-required-tests exited ${checkExit} (a required test did not execute-and-pass).`);

process.exit(vitestExit || checkExit);
