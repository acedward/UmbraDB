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
  };
}

/** The indexer endpoint, or a hard error naming what needs it. */
export function requireIndexerHttp(config: TokenIndexerConfig, what: string): string {
  if (config.indexerHttp === undefined) {
    throw new Error(`token-indexer config: INDEXER_HTTP is required for ${what}`);
  }
  return config.indexerHttp;
}
