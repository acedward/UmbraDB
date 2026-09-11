#!/usr/bin/env node
/**
 * `npm run demo:shielded-monitor` — the wallet-free half of `docs/shielded-monitor-demo.md`,
 * as one command (organizer sub-plan 00009-06).
 *
 * It brings up this repository's own Compose devnet under a unique project name and randomised
 * loopback-only ports, ingests node-only, starts the scanner and the API, derives a demo viewing
 * key, registers it, waits for coverage to reach the archive tip, and prints the dashboard URL.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────────────────────
 * Step 7 of the runbook — a real shielded transfer — needs the Midnight wallet SDK, which is not
 * a dependency of this repository and must not become one, and it needs a decision about funds.
 * That step stays in the document, where a human reads it before doing it.
 *
 * ── Why the port and project-name discipline is not optional ────────────────────────────────
 * This is written to run on a SHARED machine. A fixed port would collide with another stack, and
 * a fixed project name would tear down someone else's containers. Worse, a shared host very
 * plausibly has a foreign Midnight devnet on the canonical `127.0.0.1:9944`, which reports the
 * same `undeployed1` chain name this stack does — so a demo that relied on a default endpoint
 * could silently run against someone else's chain and appear to work. Every endpoint here is
 * therefore explicit, loopback-only and above 10000, and teardown is scoped to this run's own
 * project name.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILES = [
  "-f", join(repoRoot, "test/compose/docker-compose.yml"),
  "-f", join(repoRoot, "test/compose/docker-compose.hostports.yml"),
];

const USAGE = `npm run demo:shielded-monitor — bring the shielded monitor up and open the dashboard

Usage:
  npm run demo:shielded-monitor                 bring it up and print the dashboard URL
  npm run demo:shielded-monitor -- --down       tear down the most recent run
  npm run demo:shielded-monitor -- --project P  act on a specific compose project
  npm run demo:shielded-monitor -- --keep       leave the stack running after Ctrl-C (default: tear down)
  npm run demo:shielded-monitor -- --help

Needs Docker and Node >= 24. It brings up only \`node\` and \`postgres\` — UmbraDB's ingest is
node-only, and no indexer or proof server is started. It does NOT produce a shielded transaction;
that is step 7 of docs/shielded-monitor-demo.md and needs a wallet.

Everything it writes (logs, the demo seed, the viewing key) goes to a temporary directory outside
the repository, printed at startup and removed by --down.
`;

const STATE_FILE = join(tmpdir(), "umbradb-demo-shielded-monitor.json");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000);
}

/** Runs `docker compose` for ONE project.
 *
 *  `env` is not optional in spirit: the host-ports overlay reads `NODE_HOST_PORT` and friends, and
 *  without them compose falls back to its own defaults (19944, 15432, …) — fixed numbers that
 *  would collide with a parallel run and that this demo's whole port discipline exists to avoid.
 *  Teardown passes them too, so compose resolves the same configuration it brought up. */
function compose(args, options = {}) {
  return spawnSync("docker", ["compose", "-p", options.project, ...COMPOSE_FILES, ...args], {
    cwd: repoRoot,
    stdio: options.quiet === true ? "pipe" : "inherit",
    encoding: "utf8",
    env: { ...process.env, ...composeEnv(options.ports) },
  });
}

/** The host-port block the overlay interpolates. `undefined` ports (teardown without a recorded
 *  state file) leave compose on its own defaults, which is harmless for `down`. */
function composeEnv(ports) {
  if (ports === undefined) return {};
  return {
    NODE_HOST_PORT: String(ports.node),
    INDEXER_HOST_PORT: String(ports.indexer),
    PROOF_HOST_PORT: String(ports.proof),
    POSTGRES_HOST_PORT: String(ports.postgres),
  };
}

function requireDocker() {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (probe.status !== 0) {
    log("docker is not available (or the daemon is not running); this demo needs it.");
    process.exit(1);
  }
}

async function waitFor(what, probe, { timeoutMs = 300_000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`waiting for ${what} `);
  for (;;) {
    let ok = false;
    try {
      ok = await probe();
    } catch {
      ok = false;
    }
    if (ok) {
      process.stdout.write(" ok\n");
      return;
    }
    if (Date.now() > deadline) {
      process.stdout.write(" TIMED OUT\n");
      throw new Error(`timed out waiting for ${what}`);
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function json(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

function startChild(name, command, args, env, dir, children) {
  const out = createWriteStream(join(dir, `${name}.log`));
  const child = spawn(command, args, { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ["ignore", out, out] });
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal === null) log(`! ${name} exited with code ${code}; see ${join(dir, `${name}.log`)}`);
  });
  children.push({ name, child });
  return child;
}

function stopChildren(children) {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

async function down(project, dir, ports) {
  log(`tearing down ${project}`);
  compose(["down", "-v", "--remove-orphans"], { project, ports });
  const left = spawnSync("docker", ["ps", "-a", "--filter", `name=${project}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  const names = (left.stdout ?? "").trim();
  log(names === "" ? "nothing left under that project name." : `WARNING: still present: ${names}`);
  if (dir !== undefined && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    log(`removed ${dir} (it held the demo seed and viewing key)`);
  }
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE, { force: true });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  const projectFlag = argv.indexOf("--project");
  const previous = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : undefined;

  if (argv.includes("--down")) {
    const project = projectFlag >= 0 ? argv[projectFlag + 1] : previous?.project;
    if (project === undefined) {
      log("no previous run recorded; pass --project <name>.");
      return 2;
    }
    await down(project, projectFlag >= 0 ? undefined : previous?.dir, previous?.ports);
    return 0;
  }

  requireDocker();

  const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout?.trim();
  const project = projectFlag >= 0 ? argv[projectFlag + 1] : `umbradb-00009-06-${sha || Date.now().toString(36)}`;
  const ports = {
    node: randomPort(),
    indexer: randomPort(),
    proof: randomPort(),
    postgres: randomPort(),
    api: randomPort(),
  };
  const dir = mkdtempSync(join(tmpdir(), "umbradb-demo-"));
  writeFileSync(STATE_FILE, JSON.stringify({ project, dir, ports }, null, 2));

  const children = [];
  let keep = argv.includes("--keep");
  const cleanup = async () => {
    stopChildren(children);
    if (!keep) await down(project, dir, ports);
    else log(`left running: ${project} (tear down with: npm run demo:shielded-monitor -- --down)`);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void cleanup().then(() => process.exit(130));
    });
  }

  log(`project ${project}`);
  log(`ports    node=${ports.node} postgres=${ports.postgres} api=${ports.api} (127.0.0.1 only)`);
  log(`workdir  ${dir}`);
  log("");

  try {
    // ── 1. the devnet: node and postgres only ────────────────────────────────────────────────
    log("1/6 bringing up node + postgres (node-only ingest: no indexer, no proof server)");
    const up = compose(["up", "-d", "node", "postgres"], { project, ports });
    if (up.status !== 0) throw new Error("docker compose up failed");

    const nodeUrl = `http://127.0.0.1:${ports.node}`;
    await waitFor("the node", async () => {
      const response = await fetch(nodeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "system_chain", params: [] }),
      });
      return response.ok;
    });

    // ── 2. ingest ────────────────────────────────────────────────────────────────────────────
    const pg = `postgres://umbra:umbra@127.0.0.1:${ports.postgres}/umbra`;
    log("2/6 starting the archive sync (node-only, from genesis)");
    startChild("archive-sync", "npx", ["tsx", "chain-archive-sync/sync-cli.ts"], {
      ARCHIVE_PG: pg,
      NET: "undeployed",
      NODE_URL: nodeUrl,
      NODE_ONLY: "1",
    }, dir, children);

    // ── 3. scanner + API ─────────────────────────────────────────────────────────────────────
    log("3/6 starting the scanner and the API");
    startChild("scanner", "npx", ["tsx", "shielded-monitor/scanner-cli.ts"], {
      MONITOR_PG: pg,
      NET: "undeployed",
      SCAN_BATCH_BLOCKS: "8",
      SCAN_POLL_MS: "2000",
    }, dir, children);
    startChild("api", "npx", ["tsx", "shielded-monitor/api/server-cli.ts"], {
      SHIELDED_MONITOR_PG: pg,
      SHIELDED_MONITOR_NET: "undeployed",
      SHIELDED_MONITOR_BOOTSTRAP: "1",
      API_HOST: "127.0.0.1",
      API_PORT: String(ports.api),
    }, dir, children);

    const api = `http://127.0.0.1:${ports.api}`;
    await waitFor("the API", async () => (await json(`${api}/v1/health`)).status === 200);

    // ── 4. a demo key ────────────────────────────────────────────────────────────────────────
    log("4/6 deriving a demo viewing key");
    const seedFile = join(dir, "seed.hex");
    writeFileSync(seedFile, `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}\n`, {
      mode: 0o600,
    });
    const derived = spawnSync("npx", ["tsx", "shielded-monitor/derive-key-cli.ts", "--seed-file", seedFile, "--hd"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (derived.status !== 0) throw new Error(`derive-key failed: ${derived.stderr}`);
    const key = JSON.parse(derived.stdout.slice(0, derived.stdout.indexOf("\n#")));
    writeFileSync(join(dir, "viewing-key.txt"), `${key.viewingKey}\n`, { mode: 0o600 });
    log(`    shielded address to fund: coinPublicKey=${key.coinPublicKey}`);
    log(`                              encryptionPublicKey=${key.encryptionPublicKey}`);

    // ── 5. register ──────────────────────────────────────────────────────────────────────────
    log("5/6 registering it");
    const created = await json(`${api}/v1/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewingKey: key.viewingKey, startHeight: "earliest" }),
    });
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(`registration answered ${created.status}: ${JSON.stringify(created.body)}`);
    }
    const monitorId = created.body.monitorId;
    log(`    monitor ${monitorId}`);

    // ── 6. wait for coverage to catch up ─────────────────────────────────────────────────────
    log("6/6 waiting for coverage to reach the archive tip");
    await waitFor("coverage", async () => {
      const list = await json(`${api}/v1/monitors`);
      const monitor = list.body?.items?.find((m) => m.monitorId === monitorId);
      const { scannedThrough, sourceTip } = monitor?.coverage ?? {};
      return scannedThrough !== null && sourceTip !== null && scannedThrough === sourceTip;
    });

    const list = await json(`${api}/v1/monitors`);
    const monitor = list.body.items.find((m) => m.monitorId === monitorId);
    log("");
    log(`    state     ${monitor.state}`);
    log(`    coverage  start ${monitor.coverage.requestedStart} · from ${monitor.coverage.scannedFrom}` +
        ` · through ${monitor.coverage.scannedThrough} · tip ${monitor.coverage.sourceTip}`);
    log("");
    log(`    DASHBOARD  ${api}/ui`);
    log("");
    log("    No matches is the correct answer on a fresh devnet: nothing on this chain is");
    log("    encrypted to that key yet. To make one appear, follow step 7 of");
    log("    docs/shielded-monitor-demo.md — it needs the Midnight wallet SDK, out of tree.");
    log("");
    log(`    logs       ${dir}/{archive-sync,scanner,api}.log`);
    log("    Ctrl-C to stop and tear down (pass --keep to leave the stack up).");

    // Hold the process so the child services keep running and Ctrl-C reaches the handler above.
    await new Promise(() => {});
    return 0;
  } catch (err) {
    log(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
    log(`logs in ${dir}`);
    keep = false;
    await cleanup();
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
