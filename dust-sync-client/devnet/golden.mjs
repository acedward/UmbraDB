#!/usr/bin/env node
/**
 * The golden run of `spec/00016-dust-wallet-sync.md` Story 5 (plan D3.3 steps 5, 5b and 6, and
 * D3.4's hand-off), as one command — so Phases 4 and 5 can repeat it rather than reconstruct it.
 *
 *   node dust-sync-client/devnet/golden.mjs --seed-file <path> --name w100 [--rtt-ms 40]
 *                                           [--repeat 3] [--skip-sdk] [--balance-at <unix>]
 *
 * In order:
 *   1. **the client** (`npm run dust:sync`) against the balancer this devnet recorded, priced at a
 *      single `--balance-at` that every later step reuses — DUST generates continuously, so two
 *      correct states read a minute apart differ legitimately and any comparison between them is
 *      worthless;
 *   2. **the golden at OUR tip** — `devnet/sdk/golden-at-event-id.ts` replays the indexer's own
 *      `dustLedgerEvents` with the wallet's key and stops at the event our mirror stopped at,
 *      identified by its RAW BYTES read out of `chain_archive.dust_events`. This is the comparison
 *      that will still work on preprod, where the archive sits far below the chain tip (gate G3);
 *   3. **the SDK's own state** at the chain tip (`devnet/sdk/sdk-dust-state.ts`) — the real
 *      baseline, and the only one that also gives the SDK's sync time;
 *   4. **`compare.mjs`** for both goldens: both roots, every live-UTxO field, the balance;
 *   5. **the hand-off** — the client's `--sdk-wrapper` fed to the SDK's own deserializer
 *      (`devnet/sdk/restore-smoke.ts`), with `--applied-index` taken from step 2's measurement of
 *      the indexer's numbering, never from ours.
 *
 * Everything lands in this devnet's `out/` directory as JSON, named by `--name`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_FILE = process.env.DEVNET_STATE_FILE ?? "/media/eddie/mn-nvme/00016/devnet/state.json";
const log = (message) => process.stdout.write(`${message}\n`);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const seedFile = arg("--seed-file");
const name = arg("--name", "wallet");
const rttMs = arg("--rtt-ms", "0");
const repeat = arg("--repeat", "1");
const skipSdk = process.argv.includes("--skip-sdk");
if (seedFile === undefined) {
  log("usage: golden.mjs --seed-file <path> --name <name> [--rtt-ms N] [--repeat N] [--skip-sdk]");
  process.exit(2);
}
if (!existsSync(STATE_FILE)) {
  log(`no devnet recorded at ${STATE_FILE}`);
  process.exit(2);
}
const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
const out = join(state.dir, "out");
const balanceAt = arg("--balance-at", String(Math.floor(Date.now() / 1000)));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.status !== 0) {
    log(`FAILED: ${command} ${args.join(" ")}`);
    if (result.stdout) log(result.stdout.slice(-4_000));
    if (result.stderr) log(result.stderr.slice(-4_000));
    throw new Error(`${command} exited ${result.status}`);
  }
  return result;
}

/** One `psql` read inside the devnet's own postgres container. */
function psqlQuery(sql) {
  const result = spawnSync(
    "docker",
    ["exec", "-i", `${state.project}-postgres-1`, "psql", "-At", "-U", "umbra", "-d", "umbra", "-f", "-"],
    { input: sql, encoding: "utf8" },
  );
  return (result.stdout ?? "").trim();
}

const clientOut = join(out, `${name}-client.json`);
const wrapperOut = join(out, `${name}-sdk-wrapper.json`);

log(`balanceAt ${balanceAt} (every step is priced at this instant)`);

// ── 1. the client ──────────────────────────────────────────────────────────────────────────────
log(`1/5 the client, ${repeat} run(s)${rttMs === "0" ? "" : ` with --rtt-ms ${rttMs}`}`);
run("npx", [
  "tsx",
  "dust-sync-client/cli.ts",
  "--seed-file", seedFile,
  "--url", state.urls.balancer,
  "--net", state.net,
  "--balance-at", balanceAt,
  "--rtt-ms", rttMs,
  "--repeat", repeat,
  "--out", clientOut,
  "--quiet",
]);
const clientReport = JSON.parse(readFileSync(clientOut, "utf8"));
const lastRun = clientReport.runs === undefined ? clientReport : clientReport.runs[clientReport.runs.length - 1];
if (clientReport.runs !== undefined) {
  // `compare.mjs` takes one state, not a series: write the last run out on its own.
  writeFileSync(clientOut.replace(/\.json$/, "-last.json"), `${JSON.stringify(lastRun, null, 2)}\n`);
}
const clientState = clientReport.runs === undefined ? clientOut : clientOut.replace(/\.json$/, "-last.json");
log(
  `    ${lastRun.stats.initialUtxos} initial UTxO(s), ${lastRun.stats.spendsFollowed} spend(s), ` +
    `${lastRun.stats.liveUtxos} live, ${lastRun.timing.rounds} round(s), ` +
    `${lastRun.timing.totalMs.toFixed(0)} ms, ${lastRun.stats.requests} request(s)`,
);

// ── 2. the golden at OUR tip ───────────────────────────────────────────────────────────────────
const tipEventId = lastRun.provedAt.atEventId;
const targetRaw = psqlQuery(
  `select encode(raw, 'hex') from chain_archive.dust_events where net = '${state.net}' and id = ${tipEventId};`,
);
if (!/^[0-9a-f]+$/.test(targetRaw)) throw new Error(`could not read the raw bytes of our event ${tipEventId}`);
log(`2/5 the golden at our own tip (our event id ${tipEventId}, ${targetRaw.length / 2} raw bytes)`);
run("bash", [
  "dust-sync-client/devnet/sdk-run.sh",
  "golden-at-event-id.ts",
  "--seed-file", seedFile,
  `TARGET_RAW=${targetRaw}`,
  `TARGET_ORDINAL=${tipEventId}`,
  `BALANCE_AT=${balanceAt}`,
  `OUT_NAME=${name}-golden-at-event.json`,
]);
const atEvent = JSON.parse(readFileSync(join(out, `${name}-golden-at-event.json`), "utf8"));
log(
  `    indexer id of that event: ${atEvent.indexerLastId}; our id: ${tipEventId}; ` +
    `offset ${atEvent.offsetVsOurOrdinal}; ${atEvent.events} event(s) replayed in ${atEvent.replayMs} ms`,
);

// ── 3. the SDK's own state ─────────────────────────────────────────────────────────────────────
if (!skipSdk) {
  log("3/5 the SDK's own sync (the baseline)");
  run("bash", [
    "dust-sync-client/devnet/sdk-run.sh",
    "sdk-dust-state.ts",
    "--seed-file", seedFile,
    `BALANCE_AT=${balanceAt}`,
    `OUT_NAME=${name}-sdk.json`,
  ]);
  const sdk = JSON.parse(readFileSync(join(out, `${name}-sdk.json`), "utf8"));
  log(`    SDK synced in ${sdk.elapsedMs} ms; appliedIndex ${sdk.appliedIndex}; ${sdk.utxos.length} live UTxO(s)`);
} else {
  log("3/5 skipped (--skip-sdk)");
}

// ── 4. the comparisons ─────────────────────────────────────────────────────────────────────────
log("4/5 comparisons");
let failures = 0;
for (const [label, golden] of [
  ["golden-at-our-tip", join(out, `${name}-golden-at-event.json`)],
  ...(skipSdk ? [] : [["sdk-at-chain-tip", join(out, `${name}-sdk.json`)]]),
]) {
  const result = spawnSync("node", ["dust-sync-client/devnet/compare.mjs", clientState, golden], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  writeFileSync(join(out, `${name}-compare-${label}.txt`), result.stdout ?? "");
  const verdict = result.status === 0 ? "MATCH" : "DIFFERENT";
  if (result.status !== 0) failures += 1;
  log(`    ${label}: ${verdict}  → ${join(out, `${name}-compare-${label}.txt`)}`);
  const tail = (result.stdout ?? "").trim().split("\n").slice(-1)[0];
  if (tail !== undefined) log(`      ${tail}`);
}

// ── 5. the hand-off ────────────────────────────────────────────────────────────────────────────
log("5/5 the hand-off to the SDK");
run("npx", [
  "tsx",
  "dust-sync-client/cli.ts",
  "--seed-file", seedFile,
  "--url", state.urls.balancer,
  "--net", state.net,
  "--balance-at", balanceAt,
  "--out", join(out, `${name}-client-for-wrapper.json`),
  "--sdk-wrapper", wrapperOut,
  "--applied-index", String(atEvent.appliedIndex),
  "--network-id", state.net,
  "--quiet",
]);
const smoke = run("bash", [
  "dust-sync-client/devnet/sdk-run.sh",
  "restore-smoke.ts",
  `WRAPPER=/out/${name}-sdk-wrapper.json`,
  `INDEXER_MAX_ID=${atEvent.indexerMaxId}`,
  `OUT_NAME=${name}-restore-smoke.json`,
]);
const smokeReport = JSON.parse(readFileSync(join(out, `${name}-restore-smoke.json`), "utf8"));
log(
  `    the SDK accepted the wrapper; appliedIndex ${smokeReport.appliedIndexAfterRestore}; ` +
    `it would replay ${smokeReport.eventsTheSdkWouldReplay} event(s) of ${smokeReport.indexerMaxId}`,
);
void smoke;

log("");
log(failures === 0 ? "GOLDEN RUN: every comparison matched." : `GOLDEN RUN: ${failures} comparison(s) DIFFERENT.`);
process.exit(failures === 0 ? 0 : 1);
