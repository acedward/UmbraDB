import { DEFAULT_ARCHIVE_SCHEMA } from "../../src/postgres/archive-conventions.js";
import { normalizeArchiveBaseUrl } from "../archive-http-client.js";
import { DEFAULT_SHIELDED_MONITOR_SCHEMA } from "../bootstrap.js";
import { MAX_ASSOCIATION_PAGE } from "../store.js";

/**
 * Configuration for the private API (organizer spec FR-018, FR-021).
 *
 * Everything is read once, at boot, and validated there — a misconfiguration is a startup
 * failure with a named variable, never a surprise on the request that first happens to trip it.
 */

/**
 * The default bind address (organizer spec FR-018, owner decision Q3).
 *
 * **This alpha has no authentication.** Anyone who can open a TCP connection to this port can
 * register a viewing key, read every monitor's matches, and delete any monitor. Loopback is the
 * only thing standing between that and the network, so it is the default and the documentation
 * (`docs/shielded-monitor-api.md`, `README.md`, `SECURITY.md`) states that a deployment binding
 * anything else MUST restrict network access by other means.
 */
export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 8787;
/** 64 KiB. A create body is one Bech32m key plus a small integer; 64 KiB is three orders of
 *  magnitude of headroom and still small enough that the cap is meaningful. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_MAX_PAGE = 200;
export const DEFAULT_PAGE = 50;

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly maxPage: number;
  readonly defaultPage: number;
  /** The single network this deployment serves (spec assumption: one network per deployment).
   *  Key intake validates a submitted key's HRP against it. */
  readonly net: string;
  readonly schema: string;
  /**
   * `ARCHIVE_URL` — the base URL of an `umbradb-archive-read-api` (00009-08). Set means the API
   * reports `sourceTip` by asking that process, and holds no credential for A's database.
   */
  readonly archiveUrl?: string;
  /** Single-host mode only: the archive schema in the SAME database, read through the read
   *  contract to report `sourceTip`. Ignored when {@link archiveUrl} is set. */
  readonly archiveSchema: string;
  /** `SOURCE_TIP=off`: report `sourceTip: null`, for an API deployed with no archive access at
   *  all. The honest answer for that deployment, and never a substitute for a real tip. */
  readonly sourceTipDisabled: boolean;
}

/** Thrown for any invalid configuration. Names the variable, so an operator does not have to
 *  guess which of six numbers was wrong. */
export class ApiConfigError extends Error {
  constructor(readonly variable: string, message: string) {
    super(`invalid ${variable}: ${message}`);
    this.name = "ApiConfigError";
  }
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  // `/^\d+$/` rather than Number(): `Number(" 12 ")`, `Number("1e3")` and `Number("0x10")` all
  // succeed and none of them is what an operator meant to write in an env var.
  if (!/^\d+$/.test(raw.trim())) throw new ApiConfigError(name, `${JSON.stringify(raw)} is not a decimal integer`);
  const value = Number(raw.trim());
  if (value < min || value > max) throw new ApiConfigError(name, `${value} is outside ${min}..${max}`);
  return value;
}

/**
 * Builds the configuration from an environment.
 *
 * The one cross-field rule is the page cap: `API_MAX_PAGE` may not exceed the store's own
 * `MAX_ASSOCIATION_PAGE`, which 00009-02 deliberately placed at the store so that no in-process
 * caller can request an unbounded page either. Letting the API's cap exceed the store's would
 * mean a request inside the API's limit is rejected by the store as a `VALIDATION_FAILED` — a
 * 400 whose cause is a *server* misconfiguration. Failing at boot instead is the difference
 * between one clear error and a class of confusing ones.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const maxPage = readInt(env, "API_MAX_PAGE", DEFAULT_MAX_PAGE, 1, MAX_ASSOCIATION_PAGE);
  const defaultPage = readInt(env, "API_DEFAULT_PAGE", Math.min(DEFAULT_PAGE, maxPage), 1, maxPage);
  const net = env.SHIELDED_MONITOR_NET?.trim() ?? "undeployed";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(net)) {
    throw new ApiConfigError("SHIELDED_MONITOR_NET", "must match /^[A-Za-z0-9_-]{1,64}$/");
  }
  const host = env.API_HOST?.trim() ?? DEFAULT_API_HOST;
  if (host === "") throw new ApiConfigError("API_HOST", "must not be empty");
  return {
    ...readArchiveAccess(env),
    host,
    // Port 0 is legitimate and useful — it asks the kernel for a free port, which is exactly what
    // a test wants on a shared host — so the range starts at 0, not 1.
    port: readInt(env, "API_PORT", DEFAULT_API_PORT, 0, 65535),
    maxBodyBytes: readInt(env, "API_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, 1, 8 * 1024 * 1024),
    maxPage,
    defaultPage,
    net,
    schema: env.SHIELDED_MONITOR_SCHEMA?.trim() ?? DEFAULT_SHIELDED_MONITOR_SCHEMA,
  };
}

/**
 * How this API process reaches the archive in order to report `sourceTip` — and the one
 * configuration it refuses (00009-08).
 *
 * `ARCHIVE_URL` and the archive DATABASE settings describe two different deployments. Accepting
 * both and silently preferring one would leave the other in the environment as a false
 * description of the process — and in the `ARCHIVE_PG` case, as a live credential for A's
 * database inside a container whose entire reason for existing is that it has none. So the
 * process names both variables and refuses to start.
 */
function readArchiveAccess(env: NodeJS.ProcessEnv): {
  archiveUrl?: string; archiveSchema: string; sourceTipDisabled: boolean;
} {
  const sourceTipDisabled = env.SOURCE_TIP?.trim().toLowerCase() === "off";
  const archiveSchema = env.ARCHIVE_SCHEMA?.trim() || DEFAULT_ARCHIVE_SCHEMA;
  const raw = env.ARCHIVE_URL?.trim();
  if (raw === undefined || raw === "") return { archiveSchema, sourceTipDisabled };

  const conflicting = (["ARCHIVE_SCHEMA", "ARCHIVE_PG"] as const).filter(
    (name) => env[name] !== undefined && env[name]!.trim() !== "",
  );
  if (conflicting.length > 0) {
    throw new ApiConfigError(
      "ARCHIVE_URL",
      `it is set (${raw}) and so ${conflicting.length === 1 ? "is" : "are"} ${conflicting.join(", ")}. ` +
        "ARCHIVE_URL says the archive is another process reached over HTTP; the database settings " +
        "say it is a schema in this process's own database. Refusing to start rather than picking " +
        "one and leaving the other as a false description of the deployment.",
    );
  }
  try {
    return { archiveUrl: normalizeArchiveBaseUrl(raw), archiveSchema, sourceTipDisabled };
  } catch (err) {
    throw new ApiConfigError("ARCHIVE_URL", err instanceof Error ? err.message : String(err));
  }
}
