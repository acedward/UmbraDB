/** Resumable chain archive CLI and reusable loop for the combined monitor entry point.
 *
 * **Environment (the complete list this entry point reads; `chain-archive-sync/README.md` is the
 * documentation copy):**
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `ARCHIVE_PG` | *(required)* | Postgres connection string for the archive database |
 * | `NET` | `preprod` | free-form network id stored in `chain_archive.*.net` (this project uses `stagenet`) |
 * | `ARCHIVE_SCHEMA` | `chain_archive` | schema the lineage is bootstrapped into |
 * | `NODE_URL` | `https://rpc.preprod.midnight.network` | Substrate JSON-RPC endpoint |
 * | `INDEXER_URL` | `https://indexer.preprod.midnight.network/api/v4/graphql` | indexer GraphQL endpoint |
 * | `MAX_BLOCKS` | `200` | heights per `syncOnce` batch |
 * | `START_HEIGHT` | *(genesis)* | **new** -- `head` or a height; where a FIRST run starts (project 00020, spec FR-015) |
 * | `SYNC_CONCURRENCY` | `8` | **new** -- heights fetched at once; writes stay in height order (FR-016) |
 * | `SYNC_BACKOFF_BASE_MS` | `1000` | **new** -- first back-off delay on 429/403/5xx (FR-016) |
 * | `SYNC_BACKOFF_MAX_MS` | `60000` | **new** -- back-off ceiling, for both the per-call and the loop back-off |
 * | `SYNC_BACKOFF_MAX_ATTEMPTS` | `8` | **new** -- attempts per network call before the batch fails and the loop retries |
 */
import { pathToFileURL } from "node:url";
import { createClient } from "../src/postgres/client.js";
import { jsonLog, publicEndpoint, publicErrorMessage } from "../wallet-monitor/log.js";
import { bootstrapChainArchiveSchema } from "./bootstrap.js";
import { ChainArchiveSyncService, type SyncStartHeight } from "./sync-service.js";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** `START_HEIGHT` (spec FR-015): `head` (case-insensitive) or a non-negative integer height.
 *  Unset keeps the historical genesis start. A malformed value is a hard error at startup rather
 *  than a silent fallback -- starting a fresh archive at the wrong height is expensive to undo. */
export function parseStartHeight(raw: string | undefined): SyncStartHeight | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (value.toLowerCase() === "head") return "head";
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new Error(`START_HEIGHT must be "head" or a non-negative integer height, got ${JSON.stringify(raw)}`);
  }
  return height;
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function runArchiveSync(signal: AbortSignal): Promise<void> {
  const connectionString = process.env.ARCHIVE_PG;
  if (!connectionString) throw new Error("ARCHIVE_PG is required (a Postgres connection string for the archive DB)");
  const net = process.env.NET ?? "preprod";
  const schema = process.env.ARCHIVE_SCHEMA ?? "chain_archive";
  const nodeUrl = process.env.NODE_URL ?? "https://rpc.preprod.midnight.network";
  const indexerUrl = process.env.INDEXER_URL ?? "https://indexer.preprod.midnight.network/api/v4/graphql";
  const maxBlocks = Number(process.env.MAX_BLOCKS ?? "200");
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks <= 0) throw new Error("MAX_BLOCKS must be a positive integer");
  const startHeight = parseStartHeight(process.env.START_HEIGHT);
  // 8 is the deployed default (spec FR-016); the service's own default stays 1 so every existing
  // caller and test keeps the historical sequential behaviour unless it opts in.
  const concurrency = positiveInt("SYNC_CONCURRENCY", process.env.SYNC_CONCURRENCY, 8);
  const backoffBaseMs = positiveInt("SYNC_BACKOFF_BASE_MS", process.env.SYNC_BACKOFF_BASE_MS, 1_000);
  const backoffMaxMs = positiveInt("SYNC_BACKOFF_MAX_MS", process.env.SYNC_BACKOFF_MAX_MS, 60_000);
  const backoffMaxAttempts = positiveInt("SYNC_BACKOFF_MAX_ATTEMPTS", process.env.SYNC_BACKOFF_MAX_ATTEMPTS, 8);

  const sql = createClient({ connectionString, schema });
  try {
    await bootstrapChainArchiveSchema(sql, schema);
    const service = new ChainArchiveSyncService({
      sql,
      net,
      schema,
      node: { url: nodeUrl, timeoutMs: 30_000 },
      indexer: { url: indexerUrl, timeoutMs: 30_000 },
      startHeight,
      concurrency,
      signal,
      backoff: {
        baseDelayMs: backoffBaseMs,
        maxDelayMs: backoffMaxMs,
        maxAttempts: backoffMaxAttempts,
        // FR-016: "any throttling is logged" -- one line per wait, with the status that caused it.
        onRetry: (info) => jsonLog("archive-sync", "backoff", {
          operation: info.operation, attempt: info.attempt, maxAttempts: info.maxAttempts,
          delayMs: info.delayMs, httpStatus: info.httpStatus, throttled: info.throttled,
          message: publicErrorMessage(info.message, [nodeUrl, indexerUrl]),
        }),
      },
    });
    jsonLog("archive-sync", "start", {
      net,
      schema,
      nodeUrl: publicEndpoint(nodeUrl),
      indexerUrl: publicEndpoint(indexerUrl),
      maxBlocks,
      concurrency: service.fetchConcurrency,
      startHeight: startHeight ?? "genesis",
    });
    // FR-016: the loop itself also backs off exponentially (with jitter) after a failed batch
    // instead of hammering a throttling endpoint every 15 s, and resets the moment a batch
    // succeeds. It never exits on an endpoint error -- only an abort ends it.
    let loopBackoffMs = backoffBaseMs;
    while (!signal.aborted) {
      try {
        const result = await service.syncOnce({ maxBlocks });
        const height = await service.getSyncedHeight();
        jsonLog("archive-sync", "batch", {
          height, ingested: result.ingestedBlocks, tip: result.targetTipHeight,
          from: result.fromHeight, startedFrom: result.startHeightSource,
          blocksPerSecond: result.blocksPerSecond, elapsedMs: result.elapsedMs,
          retries: result.retries, throttled: result.throttled,
        });
        loopBackoffMs = backoffBaseMs;
        if (result.ingestedBlocks === 0) await delay(10_000, signal);
      } catch (error) {
        if (signal.aborted) break;
        const partial = (error as { partialSync?: { ingestedBlocks: number; fromHeight: number; toHeight: number } }).partialSync;
        jsonLog("archive-sync", "error", {
          message: publicErrorMessage(error, [nodeUrl, indexerUrl]),
          retryMs: loopBackoffMs,
          ...(partial === undefined ? {} : { partialIngested: partial.ingestedBlocks, partialFrom: partial.fromHeight, partialTo: partial.toHeight }),
        });
        await delay(Math.round(loopBackoffMs / 2 + Math.random() * (loopBackoffMs / 2)), signal);
        loopBackoffMs = Math.min(loopBackoffMs * 2, backoffMaxMs);
      }
    }
  } finally {
    jsonLog("archive-sync", "stop");
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await runArchiveSync(controller.signal);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
