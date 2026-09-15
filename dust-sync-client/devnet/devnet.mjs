#!/usr/bin/env node
/**
 * The devnet golden environment of `spec/00016-dust-wallet-sync.md` (plan D3.3 steps 1–3), as one
 * idempotent command.
 *
 *   node dust-sync-client/devnet/devnet.mjs up      bring the whole stack up, print its URLs
 *   node dust-sync-client/devnet/devnet.mjs down    tear down whatever `up` recorded
 *   node dust-sync-client/devnet/devnet.mjs status  print the recorded state and what is alive
 *
 * What it brings up, and why each piece is there:
 *   1. a Compose devnet — **node** (the chain), **indexer** (the wallet SDK syncs through it and
 *      it is the oracle for the hand-off's event ids), **proof-server** (a DUST fee spend carries
 *      a proof), **postgres** (the archive);
 *   2. the UmbraDB **ingest** with `REPLAY_VALIDATION=1` — without it no DUST event is ever
 *      captured and the whole stack serves an empty table (FR-003);
 *   3. a **`dust_reader`** role with exactly the grants `docs/shielded-monitor-deployment.md`
 *      prescribes, created here rather than by hand so the run proves the documented recipe;
 *   4. the **storage API**, one **monitor-node** with `DUST_DATABASE_URL`, and the **balancer** —
 *      the client talks to the balancer, which is what makes the run cover FR-018 as well.
 *
 * ── Shared-host discipline (plan §0) ────────────────────────────────────────────────────────
 * Project name `umbra-00016-devnet-<random>`; every port random, ≥ 10000, loopback only, and
 * checked free before use; everything it writes goes under `/media/eddie/mn-nvme/00016/devnet/`,
 * never onto `/`. `down` touches only this run's own project name and only the pids it started.
 * Nothing here ever runs a bare `docker compose down`.
 *
 * ── Why the children are detached ───────────────────────────────────────────────────────────
 * `npm run demo:shielded-monitor` holds its children and blocks; this script must EXIT so the
 * golden scripts can run afterwards, so each child is started `detached` (its own process group)
 * with its pid recorded. Killing the group matters: `npx tsx` runs node and esbuild as children,
 * and a bare `kill <pid>` leaves them holding the port.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_ROOT = process.env.DEVNET_DATA_ROOT ?? "/media/eddie/mn-nvme/00016/devnet";
const STATE_FILE = process.env.DEVNET_STATE_FILE ?? join(DATA_ROOT, "state.json");
const COMPOSE_FILES = [
  "-f", join(repoRoot, "test/compose/docker-compose.yml"),
  "-f", join(repoRoot, "test/compose/docker-compose.hostports.yml"),
];
const NET = "undeployed";
/** Below this much free memory the stack is not started: the host also carries a preprod node
 *  import and a 20-hour ingest, and a Compose devnet that gets OOM-killed halfway is worse than
 *  one that never started. */
const MIN_AVAILABLE_MB = 2_500;

const log = (message) => process.stdout.write(`${message}\n`);

function readState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : undefined;
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function availableMb() {
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  const match = /MemAvailable:\s+(\d+) kB/.exec(meminfo);
  return match === null ? Number.POSITIVE_INFINITY : Math.floor(Number(match[1]) / 1024);
}

/** A free loopback port ≥ 10000, proved free by binding it (a `ss` scan races; a bind does not). */
async function freePort(taken) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 10_000 + Math.floor(Math.random() * 45_000);
    if (taken.has(port)) continue;
    const free = await new Promise((done) => {
      const server = createServer();
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
    });
    if (free) {
      taken.add(port);
      return port;
    }
  }
  throw new Error("could not find a free port above 10000");
}

function compose(args, state, options = {}) {
  return spawnSync("docker", ["compose", "-p", state.project, ...COMPOSE_FILES, ...args], {
    cwd: repoRoot,
    stdio: options.quiet === true ? "pipe" : "inherit",
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_HOST_PORT: String(state.ports.node),
      INDEXER_HOST_PORT: String(state.ports.indexer),
      PROOF_HOST_PORT: String(state.ports.proof),
      POSTGRES_HOST_PORT: String(state.ports.postgres),
    },
  });
}

async function waitFor(what, probe, { timeoutMs = 600_000, intervalMs = 2_000 } = {}) {
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

/** Starts a long-running child in its OWN process group, so the whole group can be signalled. */
function startChild(state, name, args, env) {
  const logPath = join(state.dir, `${name}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn("npx", args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  child.unref();
  state.children.push({ name, pid: child.pid, log: logPath });
  log(`    ${name} pid ${child.pid} → ${logPath}`);
  return child.pid;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopChild(entry) {
  if (entry.pid === undefined || !alive(entry.pid)) return;
  try {
    // The GROUP: `npx tsx` leaves node and esbuild children behind a bare kill.
    process.kill(-entry.pid, "SIGTERM");
  } catch {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** `psql` inside the devnet's own postgres container, statements on STDIN so nothing sensitive
 *  ever reaches a command line. */
function psql(state, sql, { database = "umbra", user = "umbra" } = {}) {
  const container = `${state.project}-postgres-1`;
  const result = spawnSync("docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database, "-f", "-"], {
    input: sql,
    encoding: "utf8",
  });
  return result;
}

function psqlQuery(state, sql) {
  const container = `${state.project}-postgres-1`;
  const result = spawnSync("docker", ["exec", "-i", container, "psql", "-At", "-U", "umbra", "-d", "umbra", "-f", "-"], {
    input: sql,
    encoding: "utf8",
  });
  return (result.stdout ?? "").trim();
}

async function up(argv) {
  const previous = readState();
  if (previous !== undefined && argv.includes("--reuse")) {
    log(`reusing ${previous.project}`);
    return 0;
  }
  if (previous !== undefined) {
    log(`a previous run is recorded (${previous.project}); tear it down first or pass --reuse.`);
    return 2;
  }
  const available = availableMb();
  log(`memory available: ${available} MB`);
  if (available < MIN_AVAILABLE_MB && !argv.includes("--force")) {
    log(`refusing to start: less than ${MIN_AVAILABLE_MB} MB available. Pass --force to override.`);
    return 2;
  }

  const taken = new Set();
  const ports = {
    node: await freePort(taken),
    indexer: await freePort(taken),
    proof: await freePort(taken),
    postgres: await freePort(taken),
    storage: await freePort(taken),
    api: await freePort(taken),
    balancer: await freePort(taken),
  };
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = `umbra-00016-devnet-${suffix}`;
  const dir = join(DATA_ROOT, project);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "dust-state"), { recursive: true });
  mkdirSync(join(dir, "out"), { recursive: true });

  const state = {
    project,
    dir,
    ports,
    net: NET,
    children: [],
    startedAt: new Date().toISOString(),
    urls: {
      node: `http://127.0.0.1:${ports.node}`,
      indexer: `http://127.0.0.1:${ports.indexer}/api/v4/graphql`,
      indexerWs: `ws://127.0.0.1:${ports.indexer}/api/v4/graphql/ws`,
      proof: `http://127.0.0.1:${ports.proof}`,
      storage: `http://127.0.0.1:${ports.storage}`,
      monitorNode: `http://127.0.0.1:${ports.api}`,
      balancer: `http://127.0.0.1:${ports.balancer}`,
    },
    // The compose stack's own credential, fixed in `docker-compose.yml`. Not a secret: this
    // database exists for the length of one run and is bound to loopback.
    archivePg: `postgres://umbra:umbra@127.0.0.1:${ports.postgres}/umbra`,
    dustReaderPg: `postgres://dust_reader:dust_reader@127.0.0.1:${ports.postgres}/umbra`,
  };
  writeState(state);
  log(`project  ${project}`);
  log(`workdir  ${dir}`);
  log(`ports    node=${ports.node} indexer=${ports.indexer} proof=${ports.proof} postgres=${ports.postgres}`);
  log(`         storage=${ports.storage} monitor-node=${ports.api} balancer=${ports.balancer} (127.0.0.1 only)`);

  try {
    log("1/7 docker compose up: node, indexer, proof-server, postgres");
    const upResult = compose(["up", "-d", "node", "indexer", "proof-server", "postgres"], state);
    if (upResult.status !== 0) throw new Error("docker compose up failed");

    await waitFor("the node", async () => {
      const response = await fetch(state.urls.node, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "system_chain", params: [] }),
      });
      return response.ok;
    });
    await waitFor("postgres", async () => psqlQuery(state, "select 1;") === "1");
    await waitFor(
      "the indexer",
      async () => {
        const response = await fetch(state.urls.indexer, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ block { height } }" }),
        });
        if (!response.ok) return false;
        const body = await response.json();
        return body?.data?.block?.height !== undefined;
      },
      { timeoutMs: 600_000 },
    );

    log("2/7 the ingest, with replay validation ON (no DUST events without it)");
    startChild(state, "archive-sync", ["tsx", "chain-archive-sync/sync-cli.ts"], {
      ARCHIVE_PG: state.archivePg,
      NET,
      NODE_URL: state.urls.node,
      NODE_ONLY: "1",
      REPLAY_VALIDATION: "1",
      LEDGER_NETWORK_ID: "undeployed",
      REPLAY_CHECKPOINT_INTERVAL: "200",
    });
    writeState(state);
    await waitFor("the archive to reach genesis with DUST capture", async () => {
      const count = psqlQuery(state, "select count(*) from chain_archive.dust_events;");
      return /^\d+$/.test(count) && Number(count) > 0;
    });
    log(`    dust_events rows so far: ${psqlQuery(state, "select count(*) from chain_archive.dust_events;")}`);

    log("3/7 the dust_reader role, exactly as docs/shielded-monitor-deployment.md prescribes");
    const grant = psql(
      state,
      [
        "DROP ROLE IF EXISTS dust_reader;",
        "CREATE ROLE dust_reader LOGIN PASSWORD 'dust_reader';",
        "REVOKE ALL ON SCHEMA public FROM dust_reader;",
        "GRANT USAGE ON SCHEMA chain_archive TO dust_reader;",
        "GRANT SELECT ON chain_archive.dust_events, chain_archive.blocks TO dust_reader;",
      ].join("\n"),
    );
    if (grant.status !== 0) throw new Error(`granting dust_reader failed: ${grant.stderr}`);

    log("4/7 the storage API (the one process with a write credential)");
    startChild(state, "storage-api", ["tsx", "storage-api/server-cli.ts"], {
      ARCHIVE_PG: state.archivePg,
      NET,
      STORAGE_HOST: "127.0.0.1",
      STORAGE_PORT: String(ports.storage),
      STORAGE_BOOTSTRAP: "1",
    });
    writeState(state);
    await waitFor("the storage API", async () => (await json(`${state.urls.storage}/v1/health`)).status === 200);

    log("5/7 the monitor-node, with the DUST module on the read-only role");
    startChild(state, "monitor-node", ["tsx", "shielded-monitor/node-cli.ts"], {
      STORAGE_URL: state.urls.storage,
      SHIELDED_MONITOR_NET: NET,
      MONITOR_NODE_ID: "dust-node-1",
      API_HOST: "127.0.0.1",
      API_PORT: String(ports.api),
      SCAN_BATCH_BLOCKS: "8",
      SCAN_POLL_MS: "2000",
      DUST_DATABASE_URL: state.dustReaderPg,
      DUST_STATE_SNAPSHOT_DIR: join(dir, "dust-state"),
      DUST_STATE_POLL_MS: "1000",
      DUST_STATE_SNAPSHOT_EVERY: "5000",
    });
    writeState(state);
    await waitFor("the monitor-node", async () => (await json(`${state.urls.monitorNode}/v1/health`)).status === 200);

    log("6/7 the balancer (FR-018: /v1/dust/* is forwarded to a healthy node)");
    startChild(state, "balancer", ["tsx", "shielded-monitor/balancer/balancer-cli.ts"], {
      BALANCER_UPSTREAMS: state.urls.monitorNode,
      BALANCER_HOST: "127.0.0.1",
      BALANCER_PORT: String(ports.balancer),
      BALANCER_PROBE_MS: "2000",
      NET,
    });
    writeState(state);
    await waitFor("the balancer", async () => (await json(`${state.urls.balancer}/v1/health`)).status === 200);

    log("7/7 the DUST mirror");
    await waitFor(
      "GET /v1/dust/tip through the balancer",
      async () => (await json(`${state.urls.balancer}/v1/dust/tip?net=${NET}`)).status === 200,
    );
    const tip = await json(`${state.urls.balancer}/v1/dust/tip?net=${NET}`);
    log("");
    log(`    tip        atEventId=${tip.body.atEventId} height=${tip.body.atHeight}`);
    log(`    trees      commitmentFirstFree=${tip.body.commitmentFirstFree} generationFirstFree=${tip.body.generationFirstFree}`);
    log("");
    log(`    BALANCER   ${state.urls.balancer}   (the URL the client uses)`);
    log(`    indexer    ${state.urls.indexer}`);
    log(`    node       ${state.urls.node}`);
    log(`    proof      ${state.urls.proof}`);
    log(`    state      ${STATE_FILE}`);
    log(`    logs       ${dir}/*.log`);
    log("");
    log(`    tear down: node dust-sync-client/devnet/devnet.mjs down`);
    writeState(state);
    return 0;
  } catch (error) {
    log(`\nfailed: ${error instanceof Error ? error.message : String(error)}`);
    log(`logs in ${dir}`);
    await down([]);
    return 1;
  }
}

async function down(argv) {
  const state = readState();
  if (state === undefined) {
    log("no run recorded.");
    return 0;
  }
  log(`tearing down ${state.project}`);
  for (const child of state.children ?? []) stopChild(child);
  // Give them a moment to close their listeners before compose takes the database away.
  await new Promise((r) => setTimeout(r, 2_000));
  for (const child of state.children ?? []) {
    if (child.pid !== undefined && alive(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  compose(["down", "-v", "--remove-orphans"], state);
  const left = spawnSync("docker", ["ps", "-a", "--filter", `name=${state.project}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  const names = (left.stdout ?? "").trim();
  log(names === "" ? "nothing left under that project name." : `WARNING: still present: ${names}`);
  if (argv.includes("--purge") && state.dir !== undefined && existsSync(state.dir)) {
    rmSync(state.dir, { recursive: true, force: true });
    log(`removed ${state.dir}`);
  }
  rmSync(STATE_FILE, { force: true });
  return 0;
}

async function status() {
  const state = readState();
  if (state === undefined) {
    log("no run recorded.");
    return 1;
  }
  log(JSON.stringify({ ...state, children: (state.children ?? []).map((c) => ({ ...c, alive: alive(c.pid) })) }, null, 2));
  return 0;
}

const argv = process.argv.slice(2);
const command = argv[0] ?? "status";
const action = command === "up" ? up : command === "down" ? down : status;
action(argv).then(
  (code) => process.exit(code),
  (error) => {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
