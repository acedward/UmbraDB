/**
 * Part C's configuration surface: the `WATCH_CONTRACTS_FILE` JSON and the four environment
 * variables the plan's interface section names (`INDEXER_WS`, `PG_URL`, `EVM_RPC_WS_PORT`,
 * `WATCH_CONTRACTS_FILE`).
 *
 * Validated with `zod`, which is already a RUNTIME dependency of this repo — no new dependency, and
 * a malformed watch file fails at startup with the offending path named rather than surfacing later
 * as a confusing `undefined` deep inside the mapper.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

/** Unprefixed hex of even length — the form the indexer serves and the watch file must use. */
const unprefixedHex = z
  .string()
  .regex(/^[0-9a-fA-F]+$/, "must be unprefixed hex (no 0x) containing only hex digits")
  .refine((value) => value.length % 2 === 0, "must have an even number of hex digits");

export const WatchEntrySchema = z.object({
  /** The Midnight contract address, unprefixed hex, as `ContractEventFilter.contractAddress`. */
  address: unprefixedHex,
  profile: z.enum(["erc20", "erc721", "misc"]),
  /** Optional lower block bound for the very first ingest of this contract. */
  fromBlock: z.number().int().nonnegative().optional(),
  /**
   * Optional path to Part D's `out/deployment.json`, for the C-G5 genesis backfill. Kept on the
   * watch entry rather than in a separate file so one config describes one contract completely.
   */
  deploymentFile: z.string().optional(),
});

export type WatchEntry = z.infer<typeof WatchEntrySchema>;

export const WatchConfigSchema = z.array(WatchEntrySchema);

/** Parses and validates watch-config JSON. Duplicate addresses are rejected: two subscriptions on
 *  one contract would race on the same `log_cursors` row and interleave their cursor writes. */
export function parseWatchConfig(json: string): WatchEntry[] {
  const parsed = WatchConfigSchema.parse(JSON.parse(json) as unknown);
  const seen = new Set<string>();
  for (const entry of parsed) {
    const key = entry.address.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`watch config: duplicate address ${entry.address}`);
    }
    seen.add(key);
  }
  return parsed;
}

export function loadWatchConfigFile(path: string): WatchEntry[] {
  try {
    return parseWatchConfig(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `watch config: failed to load "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface LogsEnv {
  indexerWs: string;
  pgUrl: string;
  schema: string;
  evmRpcWsPort: number;
  watchContracts: WatchEntry[];
}

/** Reads the documented environment. Throws naming the missing variable rather than defaulting to
 *  something that would quietly ingest from the wrong place. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): LogsEnv {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`config: ${name} is required`);
    }
    return value;
  };
  const watchFile = required("WATCH_CONTRACTS_FILE");
  const port = env.EVM_RPC_WS_PORT ?? "10021";
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error(`config: EVM_RPC_WS_PORT is not a valid port: "${port}"`);
  }
  return {
    indexerWs: required("INDEXER_WS"),
    pgUrl: required("PG_URL"),
    schema: env.EVM_RPC_SCHEMA ?? "evm_rpc",
    evmRpcWsPort: parsedPort,
    watchContracts: loadWatchConfigFile(watchFile),
  };
}
