import { DEFAULT_ARCHIVE_SCHEMA } from "../src/postgres/archive-conventions.js";

/**
 * The archive read API's configuration, read from the environment once and validated eagerly
 * (organizer sub-plan 00009-08).
 *
 * Same posture as `shielded-monitor/api/config.ts`: a bad value stops the process with the name
 * of the variable, never falls back to a default that silently disables the bound it was meant to
 * impose.
 */

/**
 * The default bind address.
 *
 * **This API has no authentication** (lean alpha, owner decision Q3 — the same decision that
 * governs project B's private API). Anyone who can open a TCP connection to this port can read
 * the archive's entire finalized history. Every byte it serves is already public on chain, so the
 * exposure is availability and bandwidth rather than confidentiality — but loopback is still the
 * default, and a deployment that binds anything else must restrict network access itself. The TEE
 * step (step 3) is where this boundary grows mTLS and attestation; see
 * `docs/shielded-monitor-deployment.md`.
 */
export const DEFAULT_ARCHIVE_READ_HOST = "127.0.0.1";
export const DEFAULT_ARCHIVE_READ_PORT = 8790;

/**
 * The default and maximum number of WHOLE BLOCKS one page may carry.
 *
 * The cap is the reason this is a configuration value at all: `readBlocksSince` counts blocks,
 * and a block can hold hundreds of transactions with tens of kilobytes of raw bytes each, so an
 * unbounded `max` is a request that can ask one process to buffer an arbitrary amount of memory
 * on behalf of an unauthenticated caller. A request above the cap is CLAMPED rather than refused:
 * the contract already permits a page to hold fewer blocks than asked (a page never splits a
 * block, so short pages are normal), and a client that resumes from the last returned height —
 * which the interface requires — is correct either way.
 */
export const DEFAULT_MAX_BLOCKS_PER_PAGE = 64;
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

export interface ArchiveReadApiConfig {
  readonly host: string;
  readonly port: number;
  /** The one network this deployment serves; used when a request names none. */
  readonly net: string;
  readonly schema: string;
  readonly maxBlocksPerPage: number;
  readonly sseHeartbeatMs: number;
  /** PostgreSQL connection string for the ARCHIVE database. Absent means "use the PG*
   *  environment", exactly as `createClient` does. */
  readonly connectionString?: string;
}

export class ArchiveReadApiConfigError extends Error {
  constructor(readonly variable: string, message: string) {
    super(`invalid ${variable}: ${message}`);
    this.name = "ArchiveReadApiConfigError";
  }
}

export const ARCHIVE_READ_ENV_DOC = `
Environment (umbradb-archive-read-api):

  ARCHIVE_PG               PostgreSQL connection string for the ARCHIVE database
                           (falls back to the PG* environment when unset).
  ARCHIVE_SCHEMA           schema the archive was ingested into (default "${DEFAULT_ARCHIVE_SCHEMA}").
  NET                      the one network this deployment serves (default "undeployed").
  ARCHIVE_READ_HOST        bind address (default "${DEFAULT_ARCHIVE_READ_HOST}").
  ARCHIVE_READ_PORT        bind port, 0 asks the kernel for a free one (default ${DEFAULT_ARCHIVE_READ_PORT}).
  ARCHIVE_READ_MAX_BLOCKS  whole blocks per page, and the cap a larger request is clamped to
                           (default ${DEFAULT_MAX_BLOCKS_PER_PAGE}).
  ARCHIVE_READ_HEARTBEAT_MS  seconds*1000 between SSE heartbeat comments (default ${DEFAULT_SSE_HEARTBEAT_MS}).

Routes: GET /v1/health, /v1/archive/identity, /v1/archive/blocks?after=&max=,
        /v1/archive/tip, /v1/archive/events (text/event-stream).

This API is UNAUTHENTICATED by design (lean alpha). Bind it to loopback, or restrict network
access at the deployment. It is READ-ONLY: it holds no write path to the archive at all.
`.trim();

function readInt(
  env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ArchiveReadApiConfigError(name, `${JSON.stringify(raw)} is not a decimal integer`);
  }
  const value = Number(raw.trim());
  if (value < min || value > max) throw new ArchiveReadApiConfigError(name, `${value} is outside ${min}..${max}`);
  return value;
}

export function loadArchiveReadApiConfig(env: NodeJS.ProcessEnv = process.env): ArchiveReadApiConfig {
  const net = env.NET?.trim() ?? "undeployed";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(net)) {
    throw new ArchiveReadApiConfigError("NET", "must match /^[A-Za-z0-9_-]{1,64}$/");
  }
  const host = env.ARCHIVE_READ_HOST?.trim() ?? DEFAULT_ARCHIVE_READ_HOST;
  if (host === "") throw new ArchiveReadApiConfigError("ARCHIVE_READ_HOST", "must not be empty");
  const connectionString = env.ARCHIVE_PG?.trim();
  return {
    host,
    port: readInt(env, "ARCHIVE_READ_PORT", DEFAULT_ARCHIVE_READ_PORT, 0, 65535),
    net,
    schema: env.ARCHIVE_SCHEMA?.trim() || DEFAULT_ARCHIVE_SCHEMA,
    maxBlocksPerPage: readInt(env, "ARCHIVE_READ_MAX_BLOCKS", DEFAULT_MAX_BLOCKS_PER_PAGE, 1, 10_000),
    sseHeartbeatMs: readInt(env, "ARCHIVE_READ_HEARTBEAT_MS", DEFAULT_SSE_HEARTBEAT_MS, 1_000, 600_000),
    ...(connectionString === undefined || connectionString === "" ? {} : { connectionString }),
  };
}
