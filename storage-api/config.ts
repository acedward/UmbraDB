import { DEFAULT_ARCHIVE_SCHEMA } from "../src/postgres/archive-conventions.js";
import { DEFAULT_SHIELDED_MONITOR_SCHEMA } from "./bootstrap.js";

/**
 * `umbradb-storage-api`'s configuration, read from the environment once and validated eagerly
 * (sub-plan 00009-08 v2).
 *
 * Same posture as every other config module here: a bad value stops the process with the name of
 * the variable, never falls back to a default that silently disables the bound it was meant to
 * impose.
 *
 * **One database.** `ARCHIVE_PG` and `MONITOR_PG` normally name the SAME PostgreSQL — that is the
 * point of owner decision Q25: there is one main database, and this process is the only thing
 * that holds a credential for it. They are separate variables so a deployment that later splits
 * the two schemas across servers does not need a code change; when they are equal (or one is
 * omitted) the process opens ONE pool.
 */

/**
 * The default bind address.
 *
 * **This API has no authentication** (lean alpha, owner decision Q3/Q10). Anyone who can open a
 * TCP connection to this port can read every archived block AND read, write and delete every
 * monitor — including the serialized viewing keys, which travel over this hop in plaintext
 * because the alpha has no encryption anywhere. Loopback is the default, and a deployment binding
 * anything else MUST restrict network access itself. This boundary is exactly where the TEE step
 * adds mTLS, attestation and the record encryption Q25 defers; see
 * `docs/shielded-monitor-deployment.md` and `SECURITY.md`.
 */
export const DEFAULT_STORAGE_HOST = "127.0.0.1";
export const DEFAULT_STORAGE_PORT = 8788;

/** Whole blocks per archive page, and the cap a larger request is clamped to. Same value and
 *  same reasoning as the standalone read API's. */
export const DEFAULT_STORAGE_MAX_BLOCKS_PER_PAGE = 64;
export const DEFAULT_STORAGE_SSE_HEARTBEAT_MS = 15_000;

/**
 * The request-body cap for monitor-store commands.
 *
 * Much larger than the private API's 64 KiB, and deliberately: an `advance` body carries a whole
 * batch's associations INCLUDING their 00009-07 detail documents, each of which the store itself
 * bounds at 256 KiB. A 16 MiB cap admits a batch of several dozen detail-bearing matches and
 * still refuses a body that could only be an attempt to make the process allocate.
 */
export const DEFAULT_STORAGE_MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface StorageApiConfig {
  readonly host: string;
  readonly port: number;
  /** The one network this deployment serves; used when an archive request names none. */
  readonly net: string;
  readonly archiveSchema: string;
  readonly monitorSchema: string;
  readonly maxBlocksPerPage: number;
  readonly sseHeartbeatMs: number;
  readonly maxBodyBytes: number;
  /** PostgreSQL connection string for the ARCHIVE side. Absent means "use the PG* environment",
   *  exactly as `createClient` does. */
  readonly archiveConnectionString?: string;
  /** PostgreSQL connection string for the MONITOR side. Absent means "the same one the archive
   *  uses" — the single-main-database deployment. */
  readonly monitorConnectionString?: string;
  /** `STORAGE_BOOTSTRAP=1` applies project B's migration lineage at boot. Opt-in, because a
   *  service that silently migrates on boot can migrate a production database because somebody
   *  started it with the wrong connection string. */
  readonly bootstrap: boolean;
}

export class StorageApiConfigError extends Error {
  constructor(readonly variable: string, message: string) {
    super(`invalid ${variable}: ${message}`);
    this.name = "StorageApiConfigError";
  }
}

export const STORAGE_API_ENV_DOC = `
Environment (umbradb-storage-api):

  ARCHIVE_PG            PostgreSQL connection string for the main database
                        (falls back to the PG* environment when unset).
  MONITOR_PG            connection string for project B's schema; defaults to ARCHIVE_PG,
                        which is the one-main-database deployment.
  ARCHIVE_SCHEMA        schema the archive was ingested into (default "${DEFAULT_ARCHIVE_SCHEMA}").
  MONITOR_SCHEMA        schema project B's records live in (default "${DEFAULT_SHIELDED_MONITOR_SCHEMA}").
  STORAGE_BOOTSTRAP     "1" applies project B's migration lineage at boot.
  NET                   the one network this deployment serves (default "undeployed").
  STORAGE_HOST          bind address (default "${DEFAULT_STORAGE_HOST}").
  STORAGE_PORT          bind port, 0 asks the kernel for a free one (default ${DEFAULT_STORAGE_PORT}).
  STORAGE_MAX_BLOCKS    whole blocks per archive page, and the cap a larger request is clamped
                        to (default ${DEFAULT_STORAGE_MAX_BLOCKS_PER_PAGE}).
  STORAGE_HEARTBEAT_MS  milliseconds between SSE heartbeat comments (default ${DEFAULT_STORAGE_SSE_HEARTBEAT_MS}).
  STORAGE_MAX_BODY      request body cap in bytes for monitor-store commands
                        (default ${DEFAULT_STORAGE_MAX_BODY_BYTES}).

Routes:
  GET  /v1/health
  GET  /v1/archive/identity | /v1/archive/blocks?net=&after=&max= | /v1/archive/tip
  GET  /v1/archive/events                             (text/event-stream)
  GET  /v1/monitor-store/monitors?state=&limit=
  GET  /v1/monitor-store/monitors/<id>[?includeRevoked=1]
  GET  /v1/monitor-store/monitors/by-fingerprint/<base64url>?net=
  GET  /v1/monitor-store/monitors/<id>/associations?afterSeq=&limit=&missingDetails=1
  GET  /v1/monitor-store/monitors/<id>/lifecycle | /key-material | /lease
  GET  /v1/monitor-store/revocations
  POST /v1/monitor-store/monitors                     (register)
  POST /v1/monitor-store/monitors/<id>/advance        (ONE transaction: associations + coverage + lease)
  POST /v1/monitor-store/monitors/<id>/transition     (goLive|pause|resume|revoke|delete|markFailed|markStaleSource)
  POST /v1/monitor-store/monitors/<id>/bind-source
  POST /v1/monitor-store/monitors/<id>/association-details
  POST /v1/monitor-store/leases/claim | /v1/monitor-store/leases/release
  POST /v1/monitor-store/audit

This API is UNAUTHENTICATED by design (lean alpha, owner Q3) and carries viewing keys in
plaintext (no encryption in the alpha, owner Q10/Q25). Bind it to loopback, or restrict network
access at the deployment.
`.trim();

function readInt(
  env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new StorageApiConfigError(name, `${JSON.stringify(raw)} is not a decimal integer`);
  }
  const value = Number(raw.trim());
  if (value < min || value > max) throw new StorageApiConfigError(name, `${value} is outside ${min}..${max}`);
  return value;
}

export function loadStorageApiConfig(env: NodeJS.ProcessEnv = process.env): StorageApiConfig {
  const net = env.NET?.trim() ?? "undeployed";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(net)) {
    throw new StorageApiConfigError("NET", "must match /^[A-Za-z0-9_-]{1,64}$/");
  }
  const host = env.STORAGE_HOST?.trim() ?? DEFAULT_STORAGE_HOST;
  if (host === "") throw new StorageApiConfigError("STORAGE_HOST", "must not be empty");
  const archiveConnectionString = env.ARCHIVE_PG?.trim();
  const monitorConnectionString = env.MONITOR_PG?.trim();
  return {
    host,
    port: readInt(env, "STORAGE_PORT", DEFAULT_STORAGE_PORT, 0, 65535),
    net,
    archiveSchema: env.ARCHIVE_SCHEMA?.trim() || DEFAULT_ARCHIVE_SCHEMA,
    monitorSchema: env.MONITOR_SCHEMA?.trim() || DEFAULT_SHIELDED_MONITOR_SCHEMA,
    maxBlocksPerPage: readInt(env, "STORAGE_MAX_BLOCKS", DEFAULT_STORAGE_MAX_BLOCKS_PER_PAGE, 1, 10_000),
    sseHeartbeatMs: readInt(env, "STORAGE_HEARTBEAT_MS", DEFAULT_STORAGE_SSE_HEARTBEAT_MS, 1_000, 600_000),
    maxBodyBytes: readInt(env, "STORAGE_MAX_BODY", DEFAULT_STORAGE_MAX_BODY_BYTES, 1024, 256 * 1024 * 1024),
    ...(archiveConnectionString === undefined || archiveConnectionString === ""
      ? {}
      : { archiveConnectionString }),
    ...(monitorConnectionString === undefined || monitorConnectionString === ""
      ? {}
      : { monitorConnectionString }),
    bootstrap: env.STORAGE_BOOTSTRAP === "1",
  };
}
