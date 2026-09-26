/**
 * Project 00020 — the token indexer's configuration surface (spec FR-013).
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `PG_URL` | *(required)* | Postgres connection string; holds BOTH `chain_archive` (the input) and `token_index` (the output) |
 * | `INDEXER_HTTP` | *(required for `serve`/`scan`)* | the indexer's GraphQL v4 HTTP endpoint — the event source; no websocket is used |
 * | `NET` | `stagenet` | the network id string, exactly as `chain_archive.*.net` stores it |
 * | `TOKEN_API_PORT` | `10020` | the API port — the port baked into the reference pieces' `tokenUri`; tests pick a random free port |
 * | `TOKEN_INDEX_SCHEMA` | `token_index` | schema the token lineage lives in |
 * | `ARCHIVE_SCHEMA` | `chain_archive` | schema the archive lives in (the same name `chain-archive-sync` uses) |
 * | `TOKEN_SCAN_BATCH` | `500` | transactions decoded per scan batch |
 * | `TOKEN_LIVE_2X` | *(unset)* | opt-in marker for the live Stagenet tests only |
 * | `TOKEN_INTERFACE_RECHECK_MS` | `86400000` (24 h) | re-verify every current public interface this often (00024 FR-011b) |
 * | `TOKEN_INTERFACE_FETCH_DEADLINE_MS` | `120000` | one deadline for all requests of one bundle (FR-011) |
 * | `TOKEN_INTERFACE_MAX_INDEX_BYTES` / `_MAX_FILES` / `_MAX_FILE_BYTES` / `_MAX_BUNDLE_BYTES` | 256 KiB / 1000 / 8 MiB / 16 MiB | Level 1 caps (beyond → `unchecked`) |
 * | `TOKEN_INTERFACE_L3` | `on` | `off` records Level 3 `not_run` ("disabled") instead of compiling |
 * | `TOKEN_INTERFACE_L3_DEADLINE_MS` | `1800000` | the Level 3 compile deadline (beyond → `not_run`) |
 * | `COMPACT_BIN` | `compact` | the Compact CLI Level 3 runs as `compile +<version>` |
 * | `TOKEN_INTERFACE_ALLOW_PRIVATE_HOSTS` | *(unset)* | **TEST-ONLY**: `1` lets the bundle fetch reach private/loopback hosts (the local stack's bundle server, spec §6.1) |
 *
 * Validated with `zod`, already a RUNTIME dependency of this repo — no new dependency, and a
 * malformed value fails at startup naming the variable rather than surfacing later as an
 * `undefined` deep inside a query.
 */

import { z } from "zod";

/** A port this project is allowed to bind: ≥ 1024 in general, and the workspace rule is ≥ 10000
 *  for anything this project starts. The schema accepts any valid port so a test can pass a
 *  random high one; the CLI's own default is 10020. */
const PortSchema = z.coerce.number().int().min(1).max(65_535);

export const TokenIndexerEnvSchema = z.object({
  PG_URL: z.string().min(1),
  INDEXER_HTTP: z.string().url().optional(),
  NET: z.string().min(1).default("stagenet"),
  TOKEN_API_PORT: PortSchema.default(10_020),
  TOKEN_INDEX_SCHEMA: z.string().min(1).default("token_index"),
  ARCHIVE_SCHEMA: z.string().min(1).default("chain_archive"),
  TOKEN_SCAN_BATCH: z.coerce.number().int().min(1).max(5_000).default(500),
  TOKEN_LIVE_2X: z.string().optional(),
  TOKEN_INTERFACE_RECHECK_MS: z.coerce.number().int().min(1_000).default(86_400_000),
  TOKEN_INTERFACE_FETCH_DEADLINE_MS: z.coerce.number().int().min(100).default(120_000),
  TOKEN_INTERFACE_MAX_INDEX_BYTES: z.coerce.number().int().min(1).default(256 * 1024),
  TOKEN_INTERFACE_MAX_FILES: z.coerce.number().int().min(1).default(1_000),
  TOKEN_INTERFACE_MAX_FILE_BYTES: z.coerce.number().int().min(1).default(8 * 1024 * 1024),
  TOKEN_INTERFACE_MAX_BUNDLE_BYTES: z.coerce.number().int().min(1).default(16 * 1024 * 1024),
  TOKEN_INTERFACE_L3: z.enum(["on", "off"]).default("on"),
  TOKEN_INTERFACE_L3_DEADLINE_MS: z.coerce.number().int().min(1_000).default(1_800_000),
  COMPACT_BIN: z.string().min(1).default("compact"),
  TOKEN_INTERFACE_ALLOW_PRIVATE_HOSTS: z.enum(["0", "1"]).optional(),
});

/** Project 00024-02: how public interfaces are verified (spec FR-011, FR-011b, FR-013). */
export interface InterfaceConfig {
  recheckMs: number;
  fetchDeadlineMs: number;
  /** TEST-ONLY: allow private/loopback destinations (the local stack's bundle server). */
  allowPrivateHosts: boolean;
  limits: { maxIndexBytes: number; maxFiles: number; maxFileBytes: number; maxBundleBytes: number };
  level3: { enabled: boolean; compactBin: string; deadlineMs: number };
}

export const DEFAULT_INTERFACE_CONFIG: InterfaceConfig = Object.freeze({
  recheckMs: 86_400_000,
  fetchDeadlineMs: 120_000,
  allowPrivateHosts: false,
  limits: Object.freeze({ maxIndexBytes: 256 * 1024, maxFiles: 1_000, maxFileBytes: 8 * 1024 * 1024, maxBundleBytes: 16 * 1024 * 1024 }),
  level3: Object.freeze({ enabled: true, compactBin: "compact", deadlineMs: 1_800_000 }),
});

export interface TokenIndexerConfig {
  pgUrl: string;
  /** `undefined` is legal for `migrate`, `status`, `derive-color` and `serve --api-only`, which
   *  never touch the indexer; the scanner asserts it is present before its first lookup. */
  indexerHttp: string | undefined;
  net: string;
  apiPort: number;
  schema: string;
  archiveSchema: string;
  scanBatch: number;
  live2x: boolean;
  /** Public-interface verification (00024-02). Absent in older call sites: the defaults apply. */
  interfaces?: InterfaceConfig;
}

/**
 * Reads and validates the documented environment. Throws naming the offending variable — a token
 * indexer pointed at the wrong schema or the wrong net writes plausible-looking rows that are
 * silently about another chain, which is far worse than failing at startup.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): TokenIndexerConfig {
  const parsed = TokenIndexerEnvSchema.safeParse({
    PG_URL: env.PG_URL,
    INDEXER_HTTP: env.INDEXER_HTTP,
    NET: env.NET,
    TOKEN_API_PORT: env.TOKEN_API_PORT,
    TOKEN_INDEX_SCHEMA: env.TOKEN_INDEX_SCHEMA,
    ARCHIVE_SCHEMA: env.ARCHIVE_SCHEMA,
    TOKEN_SCAN_BATCH: env.TOKEN_SCAN_BATCH,
    TOKEN_LIVE_2X: env.TOKEN_LIVE_2X,
    TOKEN_INTERFACE_RECHECK_MS: env.TOKEN_INTERFACE_RECHECK_MS,
    TOKEN_INTERFACE_FETCH_DEADLINE_MS: env.TOKEN_INTERFACE_FETCH_DEADLINE_MS,
    TOKEN_INTERFACE_MAX_INDEX_BYTES: env.TOKEN_INTERFACE_MAX_INDEX_BYTES,
    TOKEN_INTERFACE_MAX_FILES: env.TOKEN_INTERFACE_MAX_FILES,
    TOKEN_INTERFACE_MAX_FILE_BYTES: env.TOKEN_INTERFACE_MAX_FILE_BYTES,
    TOKEN_INTERFACE_MAX_BUNDLE_BYTES: env.TOKEN_INTERFACE_MAX_BUNDLE_BYTES,
    TOKEN_INTERFACE_L3: env.TOKEN_INTERFACE_L3,
    TOKEN_INTERFACE_L3_DEADLINE_MS: env.TOKEN_INTERFACE_L3_DEADLINE_MS,
    COMPACT_BIN: env.COMPACT_BIN,
    TOKEN_INTERFACE_ALLOW_PRIVATE_HOSTS: env.TOKEN_INTERFACE_ALLOW_PRIVATE_HOSTS,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`token-indexer config: ${issues}`);
  }
  const value = parsed.data;
  return {
    pgUrl: value.PG_URL,
    indexerHttp: value.INDEXER_HTTP,
    net: value.NET,
    apiPort: value.TOKEN_API_PORT,
    schema: value.TOKEN_INDEX_SCHEMA,
    archiveSchema: value.ARCHIVE_SCHEMA,
    scanBatch: value.TOKEN_SCAN_BATCH,
    live2x: value.TOKEN_LIVE_2X === "1",
    interfaces: {
      recheckMs: value.TOKEN_INTERFACE_RECHECK_MS,
      fetchDeadlineMs: value.TOKEN_INTERFACE_FETCH_DEADLINE_MS,
      allowPrivateHosts: value.TOKEN_INTERFACE_ALLOW_PRIVATE_HOSTS === "1",
      limits: {
        maxIndexBytes: value.TOKEN_INTERFACE_MAX_INDEX_BYTES,
        maxFiles: value.TOKEN_INTERFACE_MAX_FILES,
        maxFileBytes: value.TOKEN_INTERFACE_MAX_FILE_BYTES,
        maxBundleBytes: value.TOKEN_INTERFACE_MAX_BUNDLE_BYTES,
      },
      level3: { enabled: value.TOKEN_INTERFACE_L3 === "on", compactBin: value.COMPACT_BIN, deadlineMs: value.TOKEN_INTERFACE_L3_DEADLINE_MS },
    },
  };
}

/** The indexer endpoint, or a hard error naming what needs it. */
export function requireIndexerHttp(config: TokenIndexerConfig, what: string): string {
  if (config.indexerHttp === undefined) {
    throw new Error(`token-indexer config: INDEXER_HTTP is required for ${what}`);
  }
  return config.indexerHttp;
}
