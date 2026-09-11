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
