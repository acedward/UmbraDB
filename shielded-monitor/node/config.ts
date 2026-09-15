import { randomUUID } from "node:crypto";
import { loadApiConfig, type ApiConfig } from "../api/config.js";
import { assertNoDatabaseEnvironment } from "../no-database.js";
import { normalizeStorageBaseUrl } from "../storage-http-client.js";

/**
 * The monitor-node's configuration, read from the environment ONCE and validated eagerly
 * (00009-09).
 *
 * It is the union of what the two processes it replaces used to read — the private API's bind and
 * page settings, and the scanner's batching and polling settings — minus everything that
 * described the removed shapes: no `SCAN_CONCURRENCY` (a node scans one block at a time for every
 * key at once, so there is nothing to parallelise across monitors), no `SCAN_INSTANCE_ID` /
 * `SCAN_LEASE_TTL_MS` (leases are gone), and no details-backfill mode (that command was removed
 * with owner decision Q29).
 *
 * **Every numeric setting fails closed on a bad value**, as the scanner's did: a
 * `SCAN_POLL_MS=0` that silently became the default is exactly the class of bug this repository's
 * audit finding T6 records. A bad value stops the process with the name of the variable.
 */

export interface MonitorNodeEnvConfig {
  /** Everything the HTTP surface needs: bind address, page caps, net, `STORAGE_URL`. */
  readonly api: ApiConfig;
  /**
   * This node's name, as the balancer and the dashboard show it. Defaults to a random UUID so two
   * containers started from the same image do not claim the same identity — a shared node id would
   * make the balancer's hint table point at "one" node that is really two.
   */
  readonly nodeId: string;
  /** Fallback wake-up interval when no SSE height arrives. */
  readonly pollMs: number;
  /** Whole blocks per Queue B page. Queue A is always one block per commit (Rule B). */
  readonly syncBatchBlocks: number;
  /** Blocks Queue A commits per turn before yielding, so a node far behind still serves requests. */
  readonly liveBlocksPerTurn: number;
  /** Seconds between the node's own status log line. 0 disables it. */
  readonly statusLogSeconds: number;
}

export const MONITOR_NODE_ENV_DOC = `
Environment (umbradb-shielded-monitor-node):

  STORAGE_URL           base URL of the umbradb-storage-api that owns the main database
                        (REQUIRED), e.g. http://storage-api:8788. The node reads the archive AND
                        persists every monitor record through it. This process has no database
                        connection: it refuses to start if any *_PG variable, or an
                        ARCHIVE_SCHEMA/MONITOR_SCHEMA, is present in its environment.
  ARCHIVE_URL           optional: serve /v1/archive/* from a different base URL (a standalone
                        umbradb-archive-read-api). Defaults to STORAGE_URL.
  NET                   network id / row scope, e.g. "undeployed" (default "undeployed").
  SHIELDED_MONITOR_NET  same thing, for compatibility with the 00009-08 API environment.
  MONITOR_NODE_ID       this node's name, shown as "held by" (default: a random UUID).
  API_HOST              bind address (default 127.0.0.1).
  API_PORT              bind port, 0 asks the kernel for a free one (default 8787).
  API_MAX_BODY_BYTES    request body cap (default 65536).
  API_MAX_PAGE          matches page cap (default 200).
  API_DEFAULT_PAGE      matches page size when the caller does not ask (default 50).
  SCAN_POLL_MS          fallback wake-up interval when no SSE height arrives (default 2000).
  SCAN_BATCH_BLOCKS     whole blocks per Queue B page (default 8). Queue A is always 1 per commit.
  SCAN_BLOCKS_PER_TURN  blocks Queue A commits before yielding (default 64).
  NODE_STATUS_LOG_SECONDS  seconds between status log lines; 0 disables (default 60).

DUST wallet sync (spec 00016; the module is OFF unless DUST_DATABASE_URL is set):

  DUST_DATABASE_URL     read-only PostgreSQL connection string for the ARCHIVE database, for a
                        role with USAGE on the archive schema and SELECT on dust_events and
                        blocks only. Unset (the default) disables every /v1/dust/* route, which
                        then answers 503 DUST_DISABLED; the rest of the node is unaffected.
                        It must NOT be named *_PG: this process still refuses to start with any
                        such variable in its environment, waiver or no waiver.
  DUST_STATE_SNAPSHOT_DIR    where the mirror writes <net>.dust-state (default ./dust-state).
  DUST_STATE_POLL_MS         how often the mirror polls dust_events (default 2000).
  DUST_STATE_SNAPSHOT_EVERY  events between snapshots (default 20000).
  DUST_REPLAY_BATCH          events per replay call (default 1000).

This second connection is the ONE place project B touches a database, and it exists by an
explicit owner waiver for the DUST wallet-sync experiment (spec/00016-dust-wallet-sync.md §1).
It is read-only, confined to shielded-monitor/node/dust/, and the database sees the nullifiers a
wallet asks about -- an accepted leak for the test, removed when the enclave is real.

The node serves the public API, the dashboard at /ui, and /internal/* for the balancer. It holds
every registered viewing key in RAM and NOWHERE else: nothing is written to disk, the storage API
is told only the key's SHA-256 fingerprint, and every key is cleared on SIGTERM/SIGINT. A node
that restarts holds no keys; its monitors show "key needed" until the client re-sends them.

This process has NO AUTHENTICATION (owner decision Q3) and should be reachable only from the
balancer.
`.trim();

/** Thrown for any invalid configuration. Names the variable. */
export class MonitorNodeConfigError extends Error {
  constructor(readonly variable: string, message: string) {
    super(`invalid ${variable}: ${message}`);
    this.name = "MonitorNodeConfigError";
  }
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  // `/^\d+$/` rather than Number(): `Number(" 12 ")`, `Number("1e3")` and `Number("0x10")` all
  // succeed and none of them is what an operator meant to write in an env var.
  if (!/^\d+$/.test(raw.trim())) {
    throw new MonitorNodeConfigError(name, `${JSON.stringify(raw)} is not a decimal integer`);
  }
  const value = Number(raw.trim());
  if (value < min || value > max) throw new MonitorNodeConfigError(name, `${value} is outside ${min}..${max}`);
  return value;
}

/**
 * Builds the node's configuration.
 *
 * `NET` and `SHIELDED_MONITOR_NET` are both honoured, with `SHIELDED_MONITOR_NET` winning, because
 * the compose overlay and the demo script have set both since 00009-08 and an operator migrating a
 * running deployment should not have to rename a variable to start a node.
 */
export function loadMonitorNodeConfig(env: NodeJS.ProcessEnv = process.env): MonitorNodeEnvConfig {
  assertNoDatabaseEnvironment(env, "umbradb-shielded-monitor-node");
  const net = (env.SHIELDED_MONITOR_NET?.trim() ?? env.NET?.trim() ?? "").trim() || "undeployed";
  const api = loadApiConfig({ ...env, SHIELDED_MONITOR_NET: net });
  const nodeId = env.MONITOR_NODE_ID?.trim() ?? "";
  if (nodeId !== "" && !/^[A-Za-z0-9_.:-]{1,64}$/.test(nodeId)) {
    throw new MonitorNodeConfigError("MONITOR_NODE_ID", "must match /^[A-Za-z0-9_.:-]{1,64}$/");
  }
  return {
    api,
    nodeId: nodeId === "" ? randomUUID() : nodeId,
    pollMs: readInt(env, "SCAN_POLL_MS", 2_000, 10, 3_600_000),
    syncBatchBlocks: readInt(env, "SCAN_BATCH_BLOCKS", 8, 1, 10_000),
    liveBlocksPerTurn: readInt(env, "SCAN_BLOCKS_PER_TURN", 64, 1, 100_000),
    statusLogSeconds: readInt(env, "NODE_STATUS_LOG_SECONDS", 60, 0, 86_400),
  };
}

/** Re-exported so a caller that already holds a base URL can normalise it the same way. */
export { normalizeStorageBaseUrl };
