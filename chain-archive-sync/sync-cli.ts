/** Resumable chain archive CLI and reusable loop for the combined monitor entry point. */
import { pathToFileURL } from "node:url";
import { createClient } from "../src/postgres/client.js";
import { jsonLog, publicEndpoint, publicErrorMessage } from "../wallet-monitor/log.js";
import { bootstrapChainArchiveSchema } from "./bootstrap.js";
import { ChainArchiveSyncService } from "./sync-service.js";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
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

  const sql = createClient({ connectionString, schema });
  try {
    await bootstrapChainArchiveSchema(sql, schema);
    const service = new ChainArchiveSyncService({
      sql,
      net,
      schema,
      node: { url: nodeUrl, timeoutMs: 30_000 },
      indexer: { url: indexerUrl, timeoutMs: 30_000 },
    });
    jsonLog("archive-sync", "start", {
      net,
      schema,
      nodeUrl: publicEndpoint(nodeUrl),
      indexerUrl: publicEndpoint(indexerUrl),
    });
    while (!signal.aborted) {
      try {
        const result = await service.syncOnce({ maxBlocks });
        const height = await service.getSyncedHeight();
        jsonLog("archive-sync", "batch", { height, ingested: result.ingestedBlocks, tip: result.targetTipHeight });
        if (result.ingestedBlocks === 0) await delay(10_000, signal);
      } catch (error) {
        if (signal.aborted) break;
        jsonLog("archive-sync", "error", {
          message: publicErrorMessage(error, [nodeUrl, indexerUrl]),
          retryMs: 15_000,
        });
        await delay(15_000, signal);
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
