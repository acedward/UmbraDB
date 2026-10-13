/**
 * Resumable chain archive CLI and reusable loop for the combined monitor entry point.
 *
 * Usage: `npm run archive:sync -- [--from <height>] [--to <height>] [--concurrency <n>]
 *        [--max-blocks <n>] [--min-interval-ms <ms>]`
 *
 * `--from`/`--to` archive a chosen range of FINALIZED blocks for development: `--from` is where a
 * FIRST run begins (a resumed run continues at the cursor; a `--from` that would leave a gap, or
 * that lies below the archive's first height, is refused); with `--to` the process exits 0 once the
 * cursor reaches that height (waiting for finality if the chain is not there yet). Without `--to`
 * it follows the finalized tip forever. Every block commits atomically with its cursor, so a kill
 * at any point resumes with no gap and no duplicate.
 *
 * **Environment** (flags win over the environment):
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `ARCHIVE_PG` | *(required)* | Postgres connection string for the archive database |
 * | `NET` | `preprod` | network id stored in `chain_archive.*.net` (e.g. `stagenet`) |
 * | `ARCHIVE_SCHEMA` | `chain_archive` | schema the lineage is bootstrapped into |
 * | `NODE_URL` | `https://rpc.preprod.midnight.network` | Substrate JSON-RPC endpoint |
 * | `INDEXER_URL` | `https://indexer.preprod.midnight.network/api/v4/graphql` | indexer GraphQL endpoint |
 * | `MAX_BLOCKS` | `200` | heights per `syncOnce` batch |
 * | `START_HEIGHT` | genesis | first height of a first run (`--from`) — the service start height |
 * | `END_HEIGHT` | none | last height, then exit 0 (`--to`) |
 * | `SYNC_CONCURRENCY` | `4` | heights fetched at once (1..16); writes stay in height order |
 * | `SYNC_MIN_INTERVAL_MS` | 250 on public hosts, else 0 | minimum spacing of request starts per endpoint |
 * | `SYNC_BACKOFF_BASE_MS` | `1000` | first back-off delay on 429/403/5xx/transport/non-JSON |
 * | `SYNC_BACKOFF_MAX_MS` | `60000` | back-off ceiling (per call and for the loop) |
 * | `SYNC_BACKOFF_MAX_ATTEMPTS` | `8` | attempts per network call before the batch fails and the loop backs off |
 */
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "../src/postgres/client.js";
import { jsonLog, publicEndpoint, publicErrorMessage } from "../wallet-monitor/log.js";
import { bootstrapChainArchiveSchema } from "./bootstrap.js";
import { abortableSleep } from "./retry.js";
import { ChainArchiveSyncService, SyncRangeError } from "./sync-service.js";

/** Settings that can come from the command line; anything unset falls back to the environment. */
export interface ArchiveSyncArgs {
  from?: number;
  to?: number;
  concurrency?: number;
  maxBlocks?: number;
  minIntervalMs?: number;
}

function nonNegativeInt(name: string, raw: string): number {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function positiveInt(name: string, raw: string): number {
  const value = nonNegativeInt(name, raw);
  if (value === 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return value;
}

function fromEnv<T>(raw: string | undefined, parse: (raw: string) => T): T | undefined {
  return raw === undefined || raw.trim() === "" ? undefined : parse(raw);
}

/** Parses the CLI flags (strict: an unknown flag or a positional argument is an error). */
export function parseArchiveSyncArgs(argv: readonly string[]): ArchiveSyncArgs {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      concurrency: { type: "string" },
      "max-blocks": { type: "string" },
      "min-interval-ms": { type: "string" },
    },
  });
  const out: ArchiveSyncArgs = {};
  if (values.from !== undefined) out.from = nonNegativeInt("--from", values.from);
  if (values.to !== undefined) out.to = nonNegativeInt("--to", values.to);
  if (values.concurrency !== undefined) out.concurrency = positiveInt("--concurrency", values.concurrency);
  if (values["max-blocks"] !== undefined) out.maxBlocks = positiveInt("--max-blocks", values["max-blocks"]);
  if (values["min-interval-ms"] !== undefined) {
    out.minIntervalMs = nonNegativeInt("--min-interval-ms", values["min-interval-ms"]);
  }
  if (out.from !== undefined && out.to !== undefined && out.to < out.from) {
    throw new Error(`--to ${out.to} is below --from ${out.from}`);
  }
  return out;
}

export async function runArchiveSync(signal: AbortSignal, args: ArchiveSyncArgs = {}): Promise<void> {
  const env = process.env;
  const connectionString = env.ARCHIVE_PG;
  if (!connectionString) throw new Error("ARCHIVE_PG is required (a Postgres connection string for the archive DB)");
  const net = env.NET ?? "preprod";
  const schema = env.ARCHIVE_SCHEMA ?? "chain_archive";
  const nodeUrl = env.NODE_URL ?? "https://rpc.preprod.midnight.network";
  const indexerUrl = env.INDEXER_URL ?? "https://indexer.preprod.midnight.network/api/v4/graphql";
  const maxBlocks = args.maxBlocks ?? fromEnv(env.MAX_BLOCKS, (r) => positiveInt("MAX_BLOCKS", r)) ?? 200;
  const startHeight = args.from ?? fromEnv(env.START_HEIGHT, (r) => nonNegativeInt("START_HEIGHT", r));
  const endHeight = args.to ?? fromEnv(env.END_HEIGHT, (r) => nonNegativeInt("END_HEIGHT", r));
  const concurrency = args.concurrency
    ?? fromEnv(env.SYNC_CONCURRENCY, (r) => positiveInt("SYNC_CONCURRENCY", r)) ?? 4;
  const minIntervalMs = args.minIntervalMs
    ?? fromEnv(env.SYNC_MIN_INTERVAL_MS, (r) => nonNegativeInt("SYNC_MIN_INTERVAL_MS", r));
  const backoffBaseMs = fromEnv(env.SYNC_BACKOFF_BASE_MS, (r) => positiveInt("SYNC_BACKOFF_BASE_MS", r)) ?? 1_000;
  const backoffMaxMs = fromEnv(env.SYNC_BACKOFF_MAX_MS, (r) => positiveInt("SYNC_BACKOFF_MAX_MS", r)) ?? 60_000;
  const backoffMaxAttempts = fromEnv(env.SYNC_BACKOFF_MAX_ATTEMPTS, (r) => positiveInt("SYNC_BACKOFF_MAX_ATTEMPTS", r)) ?? 8;
  if (startHeight !== undefined && endHeight !== undefined && endHeight < startHeight) {
    throw new Error(`end height ${endHeight} is below start height ${startHeight}`);
  }
  const endpoints = [nodeUrl, indexerUrl];
  const pacing = minIntervalMs === undefined ? {} : { minIntervalMs };

  const sql = createClient({ connectionString, schema });
  try {
    await bootstrapChainArchiveSchema(sql, schema);
    const service = new ChainArchiveSyncService({
      sql,
      net,
      schema,
      node: { url: nodeUrl, timeoutMs: 30_000, ...pacing },
      indexer: { url: indexerUrl, timeoutMs: 30_000, ...pacing },
      ...(startHeight === undefined ? {} : { startHeight }),
      ...(endHeight === undefined ? {} : { endHeight }),
      concurrency,
      signal,
      backoff: {
        baseDelayMs: backoffBaseMs,
        maxDelayMs: backoffMaxMs,
        maxAttempts: backoffMaxAttempts,
        // Every throttling answer is logged, with the status that caused the wait.
        onRetry: (info) => jsonLog("archive-sync", "backoff", {
          operation: info.operation, attempt: info.attempt, maxAttempts: info.maxAttempts,
          delayMs: info.delayMs, httpStatus: info.httpStatus, throttled: info.throttled,
          message: publicErrorMessage(info.message, endpoints),
        }),
      },
    });
    jsonLog("archive-sync", "start", {
      net,
      schema,
      nodeUrl: publicEndpoint(nodeUrl),
      indexerUrl: publicEndpoint(indexerUrl),
      from: startHeight ?? "genesis",
      to: endHeight ?? "follow",
      maxBlocks,
      concurrency: service.fetchConcurrency,
      minIntervalMs: service.minIntervalMs,
      cursor: (await service.getSyncCursor()) ?? null,
    });
    // The loop backs off exponentially (with jitter) after a failed batch instead of hammering a
    // throttling endpoint, and resets once a batch succeeds. Only an abort, a completed `--to`
    // range or a refused range ends it.
    let loopBackoffMs = backoffBaseMs;
    while (!signal.aborted) {
      try {
        const result = await service.syncOnce({ maxBlocks });
        jsonLog("archive-sync", "batch", {
          height: await service.getSyncedHeight(), ingested: result.ingestedBlocks,
          from: result.fromHeight, to: result.toHeight, tip: result.targetTipHeight,
          retries: result.retries, throttled: result.throttled, elapsedMs: result.elapsedMs,
        });
        loopBackoffMs = backoffBaseMs;
        if (result.reachedEnd) {
          jsonLog("archive-sync", "range-complete", { to: endHeight, height: await service.getSyncedHeight() });
          break;
        }
        if (result.ingestedBlocks === 0) await abortableSleep(10_000, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof SyncRangeError) {
          jsonLog("archive-sync", "range-refused", { message: error.message });
          throw error;
        }
        jsonLog("archive-sync", "error", {
          message: publicErrorMessage(error, endpoints),
          retryMs: loopBackoffMs,
        });
        await abortableSleep(Math.round(loopBackoffMs / 2 + Math.random() * (loopBackoffMs / 2)), signal);
        loopBackoffMs = Math.min(loopBackoffMs * 2, backoffMaxMs);
      }
    }
  } finally {
    jsonLog("archive-sync", "stop");
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const args = parseArchiveSyncArgs(process.argv.slice(2));
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await runArchiveSync(controller.signal, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
