import type { Server } from "node:http";
import { createClient, type UmbraDBSql } from "../src/postgres/client.js";
import { jsonLog } from "../wallet-monitor/log.js";
import { backfillTransactionResults } from "../chain-archive-sync/backfill-results.js";
import { loadLedgerV9 } from "../chain-archive-sync/tx-replay-decoder.js";
import { createTokenApi, listen } from "./api/server.js";
import { bootstrapTokenIndexSchema } from "./bootstrap.js";
import { requireIndexerHttp, type TokenIndexerConfig } from "./config.js";
import { IndexerEventSource, drainPendingLookups } from "./ingest/events.js";
import { TokenScanner } from "./ingest/scan.js";

/**
 * Project 00020 — `token-indexer serve` (spec §6.6): the scanner, the event-lookup drain, the
 * archive-result backfill drain and the JSON API in one process.
 *
 * Four independent loops rather than one, on purpose: a slow indexer must never stall the scanner,
 * and a stalled scanner must never take the API down. Each loop catches its own errors, logs them
 * and tries again on its own timer.
 *
 *  - **scan** — decodes archived transactions into rows (fast when there is work, idle-polls at the
 *    archive tip).
 *  - **lookups** — retries `pending_event_lookups` rows whose backoff has expired.
 *  - **results** — fills `chain_archive.transactions.result`/`segments` for blocks archived by a
 *    sync that predates spec FR-002 (the one running on this host does). The scanner blocks on a
 *    transaction whose result it does not know, so this loop is what unblocks it.
 *  - **api** — the read-only surface, plus the page at `/ui`.
 */

export type ServeMode = "both" | "api-only" | "ingest-only";

export interface ServeHandle {
  port: number | undefined;
  stop(): Promise<void>;
}

const SCAN_IDLE_MS = 2_000;
const SCAN_BUSY_MS = 50;
const DRAIN_INTERVAL_MS = 5_000;
const RESULTS_INTERVAL_MS = 3_000;
const ERROR_BACKOFF_MS = 10_000;

export async function serve(
  config: TokenIndexerConfig, mode: ServeMode = "both",
  opts: { sql?: UmbraDBSql; signal?: AbortSignal } = {},
): Promise<ServeHandle> {
  const sql = opts.sql ?? createClient({ connectionString: config.pgUrl, schema: config.schema });
  const ownsSql = opts.sql === undefined;
  await bootstrapTokenIndexSchema(sql, { schema: config.schema, net: config.net });

  const stopper = new AbortController();
  opts.signal?.addEventListener("abort", () => stopper.abort(), { once: true });
  const signal = stopper.signal;
  const loops: Promise<void>[] = [];
  let server: Server | undefined;
  let port: number | undefined;
  /** Shared with the API: `GET /v1/transactions/:hash` decodes on request (Q5). In `api-only`
   *  mode nothing loads it here, and `createTokenApi` loads it lazily on the first such request. */
  let ledgerForApi: unknown;

  if (mode !== "api-only") {
    const indexerHttp = requireIndexerHttp(config, "serve (the ingest half)");
    const eventSource = new IndexerEventSource({ url: indexerHttp });
    const ledger = await loadLedgerV9();
    ledgerForApi = ledger;
    const scanner = new TokenScanner({
      sql, schema: config.schema, archiveSchema: config.archiveSchema, net: config.net,
      eventSource, ledger, batchSize: config.scanBatch,
    });

    loops.push(loop("scan", signal, async () => {
      const outcome = await scanner.scanOnce();
      if (outcome.transactionsScanned > 0 || outcome.waitingForResult !== undefined) {
        jsonLog("token-indexer", "scan", {
          scanned: outcome.transactionsScanned, deploys: outcome.deploys, calls: outcome.calls,
          mints: outcome.mints, lookups: outcome.lookups, lookupsShort: outcome.lookupsShort,
          eventsApplied: outcome.eventsApplied, eventsRejected: outcome.eventsRejected,
          skippedUnknownResult: outcome.skippedUnknownResult,
          // Project 00023's five (FR-013), so a live `serve` shows the activity index filling.
          activityRows: outcome.activityRows, seenTokens: outcome.seenTokens,
          shieldedOffers: outcome.shieldedOffers,
          undisclosedShieldedOffers: outcome.undisclosedShieldedOffers,
          contractCalls: outcome.contractCalls,
          height: outcome.cursor.height, position: outcome.cursor.position,
          waitingForResult: outcome.waitingForResult?.txHash,
        });
      }
      return outcome.transactionsScanned > 0 ? SCAN_BUSY_MS : SCAN_IDLE_MS;
    }));

    loops.push(loop("lookups", signal, async () => {
      const outcome = await drainPendingLookups(sql, config.schema, config.net, eventSource, { ledger });
      if (outcome.attempted > 0) jsonLog("token-indexer", "lookups.drain", { ...outcome });
      return DRAIN_INTERVAL_MS;
    }));

    // The archive-result drain uses its OWN client, on the archive schema.
    const archiveSql = createClient({ connectionString: config.pgUrl, schema: config.archiveSchema });
    loops.push(loop("results", signal, async () => {
      const outcome = await backfillTransactionResults({
        sql: archiveSql, schema: config.archiveSchema, net: config.net,
        indexerUrl: indexerHttp, maxBlocks: 200,
      });
      if (outcome.blocksExamined > 0) jsonLog("token-indexer", "results.backfill", { ...outcome });
      return RESULTS_INTERVAL_MS;
    }, async () => { await archiveSql.end({ timeout: 5 }); }));
  }

  if (mode !== "ingest-only") {
    server = createTokenApi({ sql, config, ledger: ledgerForApi });
    port = await listen(server, config.apiPort);
    jsonLog("token-indexer", "api.listening", { port, net: config.net, schema: config.schema });
  }

  const stop = async (): Promise<void> => {
    stopper.abort();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server.closeAllConnections?.();
    }
    await Promise.allSettled(loops);
    if (ownsSql) await sql.end({ timeout: 5 });
  };

  if (opts.sql === undefined && opts.signal === undefined) {
    // Running as the CLI's `serve`: keep the process alive until a signal arrives.
    for (const name of ["SIGINT", "SIGTERM"] as const) {
      process.once(name, () => {
        jsonLog("token-indexer", "shutdown", { signal: name });
        void stop().then(() => { process.exitCode = 0; });
      });
    }
  }

  return { port, stop };
}

/**
 * One self-healing loop. `body` returns the delay before its next turn; a thrown error is logged
 * and the loop waits {@link ERROR_BACKOFF_MS} rather than exiting — a token indexer that dies
 * because the indexer returned a 503 would be worse than one that retries quietly.
 */
async function loop(
  name: string, signal: AbortSignal, body: () => Promise<number>, cleanup?: () => Promise<void>,
): Promise<void> {
  try {
    while (!signal.aborted) {
      let delayMs = ERROR_BACKOFF_MS;
      try {
        delayMs = await body();
      } catch (error) {
        jsonLog("token-indexer", `${name}.error`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (signal.aborted) break;
      await sleep(delayMs, signal);
    }
  } finally {
    await cleanup?.();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
