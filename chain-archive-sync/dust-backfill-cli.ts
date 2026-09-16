#!/usr/bin/env node
/**
 * `dust:backfill` -- fill `chain_archive.dust_events` for an archive that was ingested before
 * 00016, or whose capture went `gap` (`spec/00016-dust-wallet-sync.md` FR-004, §5.4).
 *
 * WHAT IT IS. A replay over blocks the archive already holds, doing exactly what a replay-on
 * ingest would have done: the DUST events are not recoverable from the archived bytes alone --
 * a spend's commitment index, a generation entry's dtime and an initial UTxO's tree position all
 * come from applying the block to the ledger state as it stood at that height. Each block's body
 * and `System::Events` are read back from the node to reconstruct EXECUTION order, which is not
 * the archive's row order.
 *
 * WHICH NODE. A LOCAL archive node. Roughly five JSON-RPC calls per block, and the public preprod
 * endpoint bans bursts -- pointing this at it will get the host blocked, not throttled.
 *
 * RESUMABLE AND IDEMPOTENT. Progress is the same per-net capture watermark the ingest advances
 * (`dust_capture:<net>`), so a kill loses at most the block in flight, a re-run continues, and a
 * finished backfill hands over to a live ingest with no gap at the seam. It stops at the sync
 * watermark: above it there is no block row for the rows' foreign key, and racing the ingest would
 * mean two writers assigning ids.
 *
 * Env:
 *   ARCHIVE_PG         Postgres connection string for the archive DB (REQUIRED)
 *   NET                network id / row scope (default "preprod")
 *   ARCHIVE_SCHEMA     schema name (default "chain_archive")
 *   NODE_URL           Substrate JSON-RPC endpoint of a LOCAL archive node (REQUIRED)
 *   LEDGER_NETWORK_ID  the LEDGER's network id, e.g. "undeployed" (REQUIRED). NOT the same as NET.
 *   MAX_BLOCKS         heights per pass (default 500). Bounds one transaction-free chunk of work,
 *                      not the total: the CLI loops until the table reaches the sync watermark.
 *
 * Run:  ARCHIVE_PG=… NODE_URL=http://127.0.0.1:9944 LEDGER_NETWORK_ID=undeployed \
 *         npx tsx chain-archive-sync/dust-backfill-cli.ts
 */
import { createClient } from "../src/postgres/client.js";
import { ChainArchiveSyncService } from "./sync-service.js";

const CONN = process.env.ARCHIVE_PG;
const NODE_URL = process.env.NODE_URL;
const LEDGER_NETWORK_ID = process.env.LEDGER_NETWORK_ID;
const NET = process.env.NET ?? "preprod";
const SCHEMA = process.env.ARCHIVE_SCHEMA ?? "chain_archive";

function required(name: string, value: string | undefined, why: string): string {
  if (value === undefined || value.trim() === "") {
    // eslint-disable-next-line no-console
    console.error(`${name} is required: ${why}`);
    process.exit(1);
  }
  return value;
}

const conn = required("ARCHIVE_PG", CONN, "a Postgres connection string for the archive DB.");
const nodeUrl = required(
  "NODE_URL", NODE_URL,
  "the JSON-RPC endpoint of a LOCAL archive node. The backfill reads each block's body and " +
    "System::Events (about five calls per block); a public endpoint will ban that, not throttle it.",
);
const ledgerNetworkId = required(
  "LEDGER_NETWORK_ID", LEDGER_NETWORK_ID,
  "the LEDGER's network id (e.g. \"undeployed\"). It is not the same as NET, which is this " +
    "archive's row-scope label, and folding against the wrong network produces different events " +
    "rather than an error.",
);

const rawMaxBlocks = process.env.MAX_BLOCKS;
const maxBlocks = rawMaxBlocks === undefined || rawMaxBlocks === "" ? 500 : Number(rawMaxBlocks);
if (!Number.isInteger(maxBlocks) || maxBlocks < 1) {
  // eslint-disable-next-line no-console
  console.error(`MAX_BLOCKS must be a whole number >= 1; got "${rawMaxBlocks}".`);
  process.exit(1);
}

const sql = createClient({ connectionString: conn, schema: SCHEMA });
// Deliberately NOT bootstrapping the schema: this CLI fills a table in an archive that already
// exists, and creating one here would turn "wrong ARCHIVE_PG" into a silently empty new archive.
const service = new ChainArchiveSyncService({
  sql,
  net: NET,
  schema: SCHEMA,
  node: { url: nodeUrl, timeoutMs: 30_000 },
  ledgerNetworkId,
});

let stop = false;
const requestStop = (): void => { stop = true; };
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

// eslint-disable-next-line no-console
console.log(
  `[dust-backfill] START net=${NET} schema=${SCHEMA} node=${nodeUrl} ` +
    `ledgerNetwork=${ledgerNetworkId} maxBlocks=${maxBlocks}`,
);

let exitCode = 0;
try {
  let totalBlocks = 0;
  let totalRows = 0;
  // Question Q-22 option C: the backfill fills `dust_parameters` on the same pass, so the run
  // reports both. Usually 1 (the genesis or resume row) plus one per parameter change it walked
  // past -- a number that stays 1 on every chain that has never changed its DUST parameters.
  let totalParameterRows = 0;
  const startedAt = Date.now();
  while (!stop) {
    const pass = await service.backfillDustEvents({ maxBlocks });
    totalBlocks += pass.blocks;
    totalRows += pass.rows;
    totalParameterRows += pass.parameterRows;
    if (pass.blocks > 0 || pass.parameterRows > 0) {
      const elapsed = (Date.now() - startedAt) / 1000;
      // eslint-disable-next-line no-console
      console.log(
        `${new Date().toISOString()} heights ${pass.fromHeight}..${pass.toHeight} ` +
          `rows=${pass.rows} params=${pass.parameterRows} total_blocks=${totalBlocks} ` +
          `total_rows=${totalRows} total_params=${totalParameterRows} ` +
          `blocks_per_s=${(totalBlocks / Math.max(elapsed, 0.001)).toFixed(1)}`,
      );
    }
    if (pass.done) {
      // eslint-disable-next-line no-console
      console.log(
        `[dust-backfill] DONE: dust_events now covers every archived height for net ${NET} ` +
          `(this run: ${totalBlocks} heights, ${totalRows} rows, ` +
          `${totalParameterRows} dust_parameters rows).`,
      );
      break;
    }
  }
  if (stop) {
    // eslint-disable-next-line no-console
    console.log("[dust-backfill] stopping; re-run to continue from the capture watermark");
  }
} catch (err) {
  exitCode = 1;
  // eslint-disable-next-line no-console
  console.error(`[dust-backfill] FAILED: ${(err as Error).message}`);
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(exitCode);
