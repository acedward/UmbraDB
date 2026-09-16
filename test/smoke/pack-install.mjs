#!/usr/bin/env node
/**
 * G1 / acceptance A5-A8: packed-tarball install smoke test (task 7.1).
 *
 * Proves the frozen 1.0.0 surface actually resolves for a REAL consumer of the PUBLISHED package --
 * not the in-repo `src/`. It splits into Docker-INDEPENDENT oracles (which run UNCONDITIONALLY -- they
 * need no Docker) and ONE Docker-dependent oracle (the migrate + round-trip, via Testcontainers):
 *
 *   Docker-independent (always run):
 *     1. `npm pack` UmbraDB and assert the tarball ships `dist/index.d.ts` (A6);
 *     2. install that tarball into a THROWAWAY scratch project (never a real consumer app -- the
 *        indexer-agnostic boundary, council/A ruling (b)) and confirm the declaration is present (A8);
 *     3. assert a deep import `umbradb/src/postgres/temporal-kv.js` FAILS with
 *        `ERR_PACKAGE_PATH_NOT_EXPORTED` -- the strict `exports` map (A8);
 *     4. write a scratch TypeScript CONSUMER that imports the frozen names from "umbradb" and uses
 *        them, then compile it with `tsc --noEmit --strict` (noImplicitAny), resolving through the
 *        INSTALLED package's `exports.types`; assert zero errors and no implicit-any / missing-
 *        declaration diagnostic. This proves the shipped `.d.ts` actually types a consumer (A5).
 *
 *   Docker-dependent (gated):
 *     5. from the scratch project, `import { createClient, runMigrations, PgTemporalKV, StorageError }
 *        from "umbradb"`, run `runMigrations` + a `PgTemporalKV.put`/`get` round-trip against a
 *        Testcontainers Postgres, and assert the written value is read back (A7).
 *
 * GATING (audit BLOCK 9): the Docker-independent oracles (1-4) run UNCONDITIONALLY -- they neve
 * skip. Only oracle 5 needs Docker. In CI (`process.env.CI`) a MISSING Docker FAILS the run (a
 * required workflow must never report green having tested nothing; ubuntu-latest ships Docker).
 * Locally, without Docker, ONLY oracle 5 is skipped -- with a clear notice -- while 1-4 still run.
 * `npm run test:smoke` runs `npm run build` first (task 3 dist dependency).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shell = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function fail(msg) {
  console.error(`\npack-install smoke: FAIL -- ${msg}`);
  process.exit(1);
}

// ---- 0. environment detection (NON-fatal here; the oracles below decide what needs Docker) -------
const dockerAvailable = run("docker", ["info", "--format", "{{.ServerVersion}}"]).status === 0;
// Robust CI detection (mirrors scripts/mutation-per-adapter.mjs): GitHub Actions sets CI=true.
const isCI = !!process.env.CI && process.env.CI !== "false" && process.env.CI !== "0";

// ---- 0b. dist/ built? (task 3 dependency) -- unconditional --------------------------------------
for (const f of ["dist/index.js", "dist/index.d.ts"]) {
  if (!existsSync(join(repoRoot, f))) {
    fail(`${f} missing -- run \`npm run build\` first (\`npm run test:smoke\` does this for you).`);
  }
}

// ---- 0c. the repo's TypeScript compiler (for the BLOCK-8 consumer compile) ----------------------
const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tscBin)) {
  fail(`typescript compiler not found at ${tscBin} -- devDependencies must be installed to run the packed-.d.ts consumer compile (A5).`);
}

const scratch = mkdtempSync(join(tmpdir(), "umbradb-smoke-"));
let tarballPath;
let container;

/** Docker-INDEPENDENT oracles (1-4). These run unconditionally; they never skip. */
async function dockerIndependentOracles() {
  // ---- 1. npm pack + assert dist/index.d.ts ships in the tarball (A6) ---------------------------
  const pack = run("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: repoRoot });
  if (pack.status !== 0) fail(`npm pack failed:\n${pack.stderr}`);
  let packMeta;
  try {
    const jsonStart = pack.stdout.indexOf("[");
    packMeta = JSON.parse(pack.stdout.slice(jsonStart));
  } catch (e) {
    fail(`could not parse \`npm pack --json\` output: ${String(e)}\n${pack.stdout}`);
  }
  const entry = packMeta[0];
  tarballPath = join(scratch, entry.filename);
  const shippedPaths = (entry.files ?? []).map((f) => f.path);
  if (!shippedPaths.includes("dist/index.d.ts")) {
    fail(`dist/index.d.ts is NOT in the packed tarball. Shipped:\n${shippedPaths.join("\n")}`);
  }
  console.log(`pack-install smoke: packed ${entry.filename} (dist/index.d.ts present in tarball).`);

  // ---- 2. install the tarball into the throwaway scratch project -------------------------------
  writeFileSync(
    join(scratch, "package.json"),
    `${JSON.stringify({ name: "umbradb-smoke-consumer", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
  );
  const install = run(
    "npm",
    ["install", tarballPath, "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: scratch },
  );
  if (install.status !== 0) fail(`npm install of the tarball failed:\n${install.stderr}`);

  const installedDts = join(scratch, "node_modules", "umbradb", "dist", "index.d.ts");
  if (!existsSync(installedDts)) fail("installed package is missing dist/index.d.ts (A8).");
  console.log("pack-install smoke: tarball installed into scratch project; dist/index.d.ts present.");

  // ---- 3. deep import of an internal module MUST fail (strict exports map, A8) ------------------
  writeFileSync(
    join(scratch, "deep-import.mjs"),
    [
      "try {",
      "  await import('umbradb/src/postgres/temporal-kv.js');",
      "  console.error('DEEP_IMPORT_RESOLVED');",
      "  process.exit(5);",
      "} catch (e) {",
      "  if (e && e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') { console.log('DEEP_IMPORT_BLOCKED'); process.exit(0); }",
      "  console.error('DEEP_IMPORT_WRONG_ERROR ' + (e && e.code) + ' ' + String(e));",
      "  process.exit(6);",
      "}",
      "",
    ].join("\n"),
  );
  const deep = run(process.execPath, ["deep-import.mjs"], { cwd: scratch });
  if (deep.status !== 0 || !deep.stdout.includes("DEEP_IMPORT_BLOCKED")) {
    fail(`deep import of umbradb/src/postgres/temporal-kv.js was not blocked as expected:\n${deep.stdout}\n${deep.stderr}`);
  }
  console.log("pack-install smoke: deep import umbradb/src/postgres/temporal-kv.js correctly blocked (ERR_PACKAGE_PATH_NOT_EXPORTED).");

  // ---- 4. compile a scratch TS consumer against the INSTALLED package's exports.types (A5) ------
  //   Proves the shipped dist/index.d.ts actually types a real consumer: the module resolves through
  //   package.json `exports.types`, every frozen name is a concrete non-`any` type, and there is no
  //   implicit-any / missing-declaration diagnostic under `--strict` / `noImplicitAny`.
  writeFileSync(join(scratch, "tsconfig.smoke.json"), `${JSON.stringify({
    compilerOptions: {
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2022",
      lib: ["es2022"],
      strict: true,
      noImplicitAny: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    files: ["consumer.ts"],
  }, null, 2)}\n`);

  writeFileSync(join(scratch, "consumer.ts"), CONSUMER_TS);

  const tsc = run(process.execPath, [tscBin, "--noEmit", "--project", "tsconfig.smoke.json"], { cwd: scratch });
  const tscOut = `${tsc.stdout}\n${tsc.stderr}`;
  if (tsc.status !== 0 || /error TS\d+/.test(tscOut)) {
    fail(`the packed .d.ts did NOT type a consumer cleanly (A5). tsc output:\n${tscOut}`);
  }
  if (/implicitly has an .*any.* type/.test(tscOut) || /Cannot find module 'umbradb'/.test(tscOut)) {
    fail(`packed-.d.ts consumer compile surfaced an implicit-any / missing-declaration diagnostic (A5):\n${tscOut}`);
  }
  console.log("pack-install smoke: scratch TS consumer compiled against the installed umbradb .d.ts under --strict/noImplicitAny with zero errors (A5).");

  // ---- 6. the chain-archive-sync CLI is actually DEPLOYABLE from the tarball (audit T6) --------
  //
  // `package.json` advertised an `archive:sync` script while `npm pack` shipped `dist` and docs
  // only -- no CLI, and `tsx` and the ledger were devDependencies. So the documented operational
  // entry point did not exist in the release artifact at all, and nothing noticed because every
  // test ran it from the repo. These oracles run it from the INSTALLED package, which is the only
  // place the claim can be checked.
  const shipsCli = shippedPaths.includes("dist-cli/chain-archive-sync/sync-cli.js");
  if (!shipsCli) fail("dist-cli/chain-archive-sync/sync-cli.js is NOT in the packed tarball (T6).");

  // The runtime-metadata captures are read with `new URL("./<file>", import.meta.url)`, i.e. next
  // to the module -- `tsc` does not copy them, so they must be copied into the build explicitly.
  // Without them the CLI throws ENOENT only for runtimes whose metadata it cannot fetch live,
  // which is exactly the situation the captures exist for.
  const shippedCaptures = shippedPaths.filter((p) => p.endsWith(".scale"));
  if (shippedCaptures.length === 0) {
    fail("no .scale runtime-metadata captures in the packed tarball -- the CLI cannot fall back (T6).");
  }

  const binPath = join(scratch, "node_modules", ".bin", "umbradb-archive-sync");
  if (!existsSync(binPath)) fail("installed package did not link the umbradb-archive-sync bin (T6).");

  // The vendored ledger must be a real runtime dependency of the INSTALLED package, not a
  // devDependency that happens to exist in the repo. All FIVE exports replay needs are checked, so
  // a tarball carrying a stale vendored build fails here rather than during ingest.
  //
  // Five, not four: `LedgerState.ledgerStateRoot` was checked by `vendored-ledger.yml` against the
  // REPO TREE but not here against the packed tarball, so a pack that shipped a stale vendored
  // build missing exactly that export passed this smoke. Same bytes in practice today (SHA256SUMS
  // + `files: ["vendor"]`), which is why it never fired -- but "in practice" is what this smoke
  // exists to stop assuming, and it is the export the whole replay-validation comparison reads.
  // Each export is reported by name so a failure says WHICH one is missing rather than just that
  // one is.
  writeFileSync(
    join(scratch, "cli-ledger.mjs"),
    [
      "const m = await import('@midnight-ntwrk/ledger-v8');",
      "const required = {",
      "  'SystemTransaction.transactionHash': typeof m.SystemTransaction?.prototype?.transactionHash === 'function',",
      "  'SystemTransaction.cost': typeof m.SystemTransaction?.prototype?.cost === 'function',",
      "  'LedgerParameters.clampAndNormalizeFullness': typeof m.LedgerParameters?.prototype?.clampAndNormalizeFullness === 'function',",
      "  'LedgerState.closeBlock': typeof m.LedgerState?.prototype?.closeBlock === 'function',",
      "  'LedgerState.ledgerStateRoot': typeof m.LedgerState?.prototype?.ledgerStateRoot === 'function',",
      "};",
      "const missing = Object.entries(required).filter(([, present]) => !present).map(([name]) => name);",
      "console.log(missing.length === 0 ? 'LEDGER_OK' : 'LEDGER_MISSING_EXPORTS: ' + missing.join(', '));",
      "process.exit(missing.length === 0 ? 0 : 6);",
      "",
    ].join("\n"),
  );
  const ledgerCheck = run(process.execPath, ["cli-ledger.mjs"], { cwd: scratch });
  if (ledgerCheck.status !== 0 || !ledgerCheck.stdout.includes("LEDGER_OK")) {
    fail(`the installed package cannot resolve the vendored ledger with the replay exports (T6):\n${ledgerCheck.stdout}\n${ledgerCheck.stderr}`);
  }

  // Invoke the CLI for real. A config that DISABLES checkpointing must be rejected, not accepted:
  // `height % 0` is NaN, so interval 0 silently wrote no checkpoints at all, and the only symptom
  // was a much later restart replaying the whole chain. `ARCHIVE_PG` points nowhere on purpose --
  // these must fail on configuration, before any database access.
  const unreachablePg = "postgres://u:p@127.0.0.1:1/none";
  for (const bad of ["0", "2.5", "-1", "abc"]) {
    const r = run(binPath, [], {
      cwd: scratch,
      env: { ...process.env, ARCHIVE_PG: unreachablePg, REPLAY_CHECKPOINT_INTERVAL: bad },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.status === 0 || !/REPLAY_CHECKPOINT_INTERVAL must be a whole number/.test(out)) {
      fail(`packed CLI accepted REPLAY_CHECKPOINT_INTERVAL=${bad} (T6). exit=${r.status}\n${out}`);
    }
  }

  // Replay validation without a ledger network must also be refused -- including for an EMPTY
  // string, which the previous `=== undefined` check let through.
  const noNetwork = run(binPath, [], {
    cwd: scratch,
    env: { ...process.env, ARCHIVE_PG: unreachablePg, REPLAY_VALIDATION: "1", LEDGER_NETWORK_ID: "" },
  });
  if (noNetwork.status === 0 || !/requires LEDGER_NETWORK_ID/.test(`${noNetwork.stdout}\n${noNetwork.stderr}`)) {
    fail(`packed CLI accepted REPLAY_VALIDATION=1 with an empty LEDGER_NETWORK_ID (T6). exit=${noNetwork.status}`);
  }

  // And a VALID configuration must get PAST validation -- otherwise the four rejections above
  // would also pass on a CLI that refuses everything.
  const good = run(binPath, [], {
    cwd: scratch,
    env: { ...process.env, ARCHIVE_PG: unreachablePg, REPLAY_CHECKPOINT_INTERVAL: "500" },
  });
  const goodOut = `${good.stdout}\n${good.stderr}`;
  if (/REPLAY_CHECKPOINT_INTERVAL must be/.test(goodOut)) {
    fail(`packed CLI rejected a VALID checkpoint interval (T6):\n${goodOut}`);
  }
  if (!/\[archive-sync\]/.test(goodOut)) {
    fail(`packed CLI did not reach its startup banner with a valid config (T6):\n${goodOut}`);
  }
  console.log("pack-install smoke: packed chain-archive-sync CLI runs, resolves the vendored ledger, and validates its configuration (T6).");
}

/** Docker-DEPENDENT oracle (5): migrate + put/get round-trip against a Testcontainers Postgres. */
async function roundTripOracle() {
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const connectionUri = container.getConnectionUri();

  writeFileSync(
    join(scratch, "consume.mjs"),
    [
      "import { createClient, runMigrations, PgTemporalKV, StorageError } from 'umbradb';",
      "if (typeof StorageError !== 'function') { console.error('StorageError is not a function'); process.exit(3); }",
      "const schema = 'smoke_test';",
      "const sql = createClient({ connectionString: process.env.DATABASE_URL, schema });",
      "try {",
      "  await runMigrations(sql, { schema });",
      "  const kv = new PgTemporalKV(sql);",
      "  const written = await kv.put('smoke', 'default', 'k', { n: 42, s: 'hello' });",
      "  if (written.version !== 1n) { console.error('unexpected version ' + written.version); process.exit(7); }",
      "  const read = await kv.get('smoke', 'default', 'k');",
      "  const ok = read && read.value && read.value.n === 42 && read.value.s === 'hello';",
      "  if (!ok) { console.error('round-trip mismatch: ' + JSON.stringify(read)); process.exit(4); }",
      "  console.log('SMOKE_OK ' + JSON.stringify(read.value));",
      "} finally {",
      "  await sql.end({ timeout: 5 });",
      "}",
      "",
    ].join("\n"),
  );
  const consume = run(process.execPath, ["consume.mjs"], {
    cwd: scratch,
    env: { ...process.env, DATABASE_URL: connectionUri },
  });
  if (consume.status !== 0 || !consume.stdout.includes("SMOKE_OK")) {
    fail(`consumer import + migrate + round-trip failed:\n${consume.stdout}\n${consume.stderr}`);
  }
  console.log(`pack-install smoke: root import + runMigrations + put/get round-trip OK -- ${consume.stdout.trim().split("\n").pop()}`);
}

async function main() {
  // Docker-independent oracles ALWAYS run (audit BLOCK 9 -- never skip pack/install/import/type).
  await dockerIndependentOracles();

  // The migrate + round-trip is the ONLY Docker-dependent oracle.
  if (dockerAvailable) {
    await roundTripOracle();
    console.log("\npack-install smoke: PASS -- packed surface resolves for a fresh consumer; deep import blocked; .d.ts shipped AND type-checks a consumer; migrate + round-trip OK.");
  } else if (isCI) {
    // A required CI workflow must never report green having tested nothing (audit BLOCK 9).
    fail("Docker is REQUIRED in CI (ubuntu-latest ships Docker) but `docker info` failed -- the runMigrations + round-trip oracle cannot run and MUST NOT be silently skipped. The Docker-independent oracles (pack/install/import/deep-import/type-declaration) all ran; only the round-trip is missing, and in CI that is a failure.");
  } else {
    console.log("\npack-install smoke: NOTICE -- Docker absent locally; skipping ONLY the runMigrations + round-trip oracle (5). The pack/install/import/deep-import/type-declaration oracles (1-4) ran unconditionally.");
    console.log("pack-install smoke: PASS (Docker-independent oracles) -- packed surface resolves; deep import blocked; .d.ts shipped AND type-checks a consumer. Round-trip skipped (no Docker).");
  }
}

// ---- the BLOCK-8 scratch consumer source (imports + uses the frozen names) -----------------------
const CONSUMER_TS = `// BLOCK 8 (acceptance A5): a scratch TypeScript consumer of the INSTALLED "umbradb" package. It
// imports the frozen names (resolving through package.json exports.types) and uses them; compiling it
// with tsc --noEmit --strict (noImplicitAny) with zero errors proves the shipped dist/index.d.ts
// actually types a real consumer -- no missing declaration, no implicit any.
import {
  createClient, runMigrations, saveAndAdvance, Rollback, DEFAULT_SCHEMA,
  PgTemporalKV, PgCheckpointStore, PgWatermarks, PgTransactionLeaseLayer,
  PgTransactionHistoryStorage, PgWalletStateEnvelopeStore,
  StorageError, ValidationError, ConnectionError,
  MigrationLockTimeoutError, TransactionFaultError, LeaseTimeoutError,
} from "umbradb";
import type {
  UmbraDBSql, UmbraDBConnectionOptions, Migration, RunMigrationsOptions,
  SaveAndAdvanceDeps, SaveAndAdvanceCursor, Retryability,
  TemporalKV, CheckpointStore, Watermarks, TransactionLeaseLayer, TransactionHistoryStorage,
  WalletStateEnvelope,
  SharedStorageErrorCode, TemporalKVErrorCode, CheckpointStoreErrorCode,
  TransactionLeaseErrorCode, WalletStateEnvelopeErrorCode,
} from "umbradb";

// If an imported symbol resolved to \`any\` in the shipped .d.ts, IsAny<T> is true and NotAny<T>
// becomes ["UNEXPECTED_ANY"]; assigning \`true\` to that type then fails to compile.
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? ["UNEXPECTED_ANY"] : true;

const _g_createClient: NotAny<typeof createClient> = true;
const _g_runMigrations: NotAny<typeof runMigrations> = true;
const _g_saveAndAdvance: NotAny<typeof saveAndAdvance> = true;
const _g_StorageError: NotAny<typeof StorageError> = true;
const _g_Retryability: NotAny<Retryability> = true;
const _g_Shared: NotAny<SharedStorageErrorCode> = true;
const _g_TKV: NotAny<TemporalKVErrorCode> = true;
const _g_Ckpt: NotAny<CheckpointStoreErrorCode> = true;
const _g_Lease: NotAny<TransactionLeaseErrorCode> = true;
const _g_Env: NotAny<WalletStateEnvelopeErrorCode> = true;
const _g_SAAD: NotAny<SaveAndAdvanceDeps> = true;
const _g_SAAC: NotAny<SaveAndAdvanceCursor> = true;

// Use the runtime values so the import is a real dependency on the shipped declarations.
const schema: string = DEFAULT_SCHEMA;
const conn = new ConnectionError("connection lost");
const connRetryable: Retryability = conn.retryable;
const migErr = new MigrationLockTimeoutError("smoke_schema", 10);
const migRetryable: Retryability = migErr.retryable;

void [
  _g_createClient, _g_runMigrations, _g_saveAndAdvance, _g_StorageError,
  _g_Retryability, _g_Shared, _g_TKV, _g_Ckpt, _g_Lease, _g_Env, _g_SAAD, _g_SAAC,
  schema, connRetryable, migRetryable,
  saveAndAdvance, Rollback, PgTemporalKV, PgCheckpointStore, PgWatermarks, PgTransactionLeaseLayer,
  PgTransactionHistoryStorage, PgWalletStateEnvelopeStore, ValidationError, TransactionFaultError,
  LeaseTimeoutError, createClient, runMigrations,
];

// Type-only references so the frozen type imports must resolve too.
type _Types = [
  UmbraDBSql, UmbraDBConnectionOptions, Migration, RunMigrationsOptions,
  TemporalKV, CheckpointStore, Watermarks, TransactionLeaseLayer, TransactionHistoryStorage,
  WalletStateEnvelope,
];
export type { _Types };
`;

main()
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    try { if (container) await container.stop(); } catch { /* best effort */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    // Remove any stray tarball npm may have left in repoRoot (belt-and-suspenders; we pack into scratch).
    try {
      for (const f of readdirSync(repoRoot)) {
        if (/^umbradb-.*\.tgz$/.test(f)) rmSync(join(repoRoot, f), { force: true });
      }
    } catch { /* best effort */ }
  });
