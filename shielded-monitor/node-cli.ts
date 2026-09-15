#!/usr/bin/env node
import { openArchiveSource } from "./archive-source.js";
import { createShieldedMonitorApi, stderrLogger } from "./api/server.js";
import { archiveSourceTip, unknownSourceTip } from "./api/source-tip.js";
import { loadMonitorNodeConfig, MONITOR_NODE_ENV_DOC } from "./node/config.js";
import { createDustModule } from "./node/dust/index.js";
import { MonitorNode } from "./node/monitor-node.js";
import { HttpMonitorStore } from "./storage-http-client.js";

/**
 * `umbradb-shielded-monitor-node` — **the** project-B process (00009-09; owner decision Q28).
 *
 * ── What it replaces ────────────────────────────────────────────────────────────────────────
 * `umbradb-shielded-monitor` (the scanner) and `umbradb-shielded-monitor-api` (the private API)
 * are gone. They were two processes sharing one database row for a viewing key; they are now one
 * process sharing one RAM key store, which is the whole point: fewer things inside the future
 * enclave, and no key anywhere outside it.
 *
 * ```text
 *   balancer ──► this process ──HTTP──► umbradb-storage-api ──► the one main PostgreSQL
 *                 │  public API + /ui   (the only holder of a database credential)
 *                 │  /internal/* (balancer only)
 *                 │  Queue A: get-tip → scan every new block once, for every held key
 *                 └  Queue B: sync-key(fp) · back-sync(fp, from, to)
 *
 *   The viewing keys live HERE, in RAM, and nowhere else. Not on disk, not in the database,
 *   not in a log line. The storage API is told a SHA-256 fingerprint and nothing more.
 * ```
 *
 * ── Shutdown is a security step, not just tidiness ──────────────────────────────────────────
 * SIGTERM and SIGINT stop the queues, close the listener, and **clear every key** — the ledger's
 * own `clear()` on each handle, so the secrets are zeroed in the WASM heap rather than left for
 * whatever reads the process's memory afterwards. That is why the handler awaits the node's stop
 * before exiting instead of calling `process.exit` immediately.
 *
 * Run:  STORAGE_URL=http://127.0.0.1:8788 npx tsx shielded-monitor/node-cli.ts
 */
export async function runMonitorNode(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  const config = loadMonitorNodeConfig(env);

  // Project B's whole persistence surface: one base URL, no pool, no migration, no schema.
  const store = new HttpMonitorStore(config.api.storageUrl, {
    userAgent: "umbradb-shielded-monitor-node",
  });
  const source = openArchiveSource({
    archiveUrl: config.api.archiveUrl,
    logger: (line) => process.stderr.write(`${line}\n`),
  });

  const node = new MonitorNode(source.archive, store, source.wake, {
    net: config.api.net,
    nodeId: config.nodeId,
    pollMs: config.pollMs,
    syncBatchBlocks: config.syncBatchBlocks,
    liveBlocksPerTurn: config.liveBlocksPerTurn,
    // Over a network boundary the claimed identity of a transaction and the bytes under it are two
    // separate things a page asserts (Q23). In this topology the archive is always remote.
    verifyTxIdentity: source.remote,
    logger: (line) => process.stderr.write(`${line}\n`),
  });

  // The DUST module (project 00016), or nothing when `DUST_DATABASE_URL` is unset. Built BEFORE
  // the listener so a bad `DUST_*` value stops the process with the variable's name rather than
  // half-starting a node whose DUST routes would answer 503 for a reason nobody can see.
  const dust = createDustModule(env, {
    net: config.api.net,
    logger: (line) => process.stderr.write(`${line}\n`),
  });

  const api = createShieldedMonitorApi({
    store,
    config: config.api,
    node,
    ...(dust !== undefined ? { dust } : {}),
    sourceTipProvider: config.api.sourceTipDisabled
      ? unknownSourceTip()
      : archiveSourceTip(source.archive),
    logger: stderrLogger(),
  });

  // The listener first, then the queues: a node that is reachable before it has read the archive
  // tip answers `liveWatermark: null` on `/internal/status`, which is exactly what it should say,
  // whereas a node that is scanning but unreachable is invisible to the balancer.
  const address = await api.listen();
  await node.start();
  // AFTER the listener: the mirror's cold fold takes minutes on a real chain, and during it the
  // DUST routes must be reachable to answer `503 DUST_NOT_READY` (00016 Story 2 scenario 3) while
  // every monitor-store route works as before.
  await dust?.start();

  const statusTimer = config.statusLogSeconds > 0
    ? setInterval(() => {
        // Counts, heights and this node's own name. Never a monitor id, never a key (FR-023).
        process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...node.status() })}\n`);
      }, config.statusLogSeconds * 1000)
    : undefined;
  statusTimer?.unref?.();

  process.stderr.write(
    `${JSON.stringify({
      at: new Date().toISOString(),
      event: "listening",
      host: address.host,
      port: address.port,
      net: config.api.net,
      nodeId: config.nodeId,
      storage: config.api.storageUrl,
      dust: dust === undefined
        ? "disabled (no DUST_DATABASE_URL)"
        : "enabled — a SECOND, read-only connection to the archive database (spec 00016 §1 waiver)",
      archive: source.describe,
      wake: source.wake.describe,
      database: "none (owner decision Q25) — all state is reached through STORAGE_URL",
      keys: "in RAM only (owner decision Q28) — never written, cleared on shutdown",
      authentication: "none (owner decision Q3) — reachable only through the balancer",
    })}\n`,
  );

  return async () => {
    if (statusTimer !== undefined) clearInterval(statusTimer);
    await api.close();
    await node.stop();
    // Last: the mirror writes its final snapshot here (FR-012), and a node that snapshotted
    // before closing its listener could still fold a batch after the snapshot was written.
    await dust?.stop();
  };
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  // eslint-disable-next-line no-console
  console.log(MONITOR_NODE_ENV_DOC);
  process.exit(0);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runMonitorNode().then(
    (shutdown) => {
      let stopping = false;
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          if (stopping) return;
          stopping = true;
          process.stderr.write(`${signal}: stopping and clearing every held key\n`);
          void shutdown().then(
            () => process.exit(0),
            () => process.exit(1),
          );
        });
      }
    },
    (err: unknown) => {
      // The message only: a boot failure is a configuration or connection fault, and a stack trace
      // here is noise in a container log.
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
