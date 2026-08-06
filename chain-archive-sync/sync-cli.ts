/**
 * chain-archive-sync CLI -- runs {@link ChainArchiveSyncService} in a resumable loop against a
 * live Midnight node (JSON-RPC) + indexer (GraphQL), populating the `chain_archive` schema. This
 * is the production/ops entry point the feature previously lacked
 * (`docs/features/full-chain-storage.md` §4 noted "no CLI entry point or npm script").
 *
 * Resumable: each `syncOnce` advances a persisted watermark, so restarts continue where they left
 * off. Points at Midnight's hosted public Preprod endpoints by default; override for a local
 * (from-source) stack via NODE_URL / INDEXER_URL.
 *
 * Env:
 *   ARCHIVE_PG      Postgres connection string for the archive DB (REQUIRED)
 *   NET             network id / row scope (default "preprod")
 *   ARCHIVE_SCHEMA  schema name (default "chain_archive")
 *   NODE_URL        Substrate JSON-RPC endpoint (default hosted Preprod node)
 *   INDEXER_URL     indexer GraphQL endpoint. Sprint 9: OPTIONAL -- set to the indexer's URL
 *                   for indexer-sourced ingest + the node-vs-indexer oracle cross-check, or set
 *                   to the literal "none" (or leave the default and set NODE_ONLY=1) for
 *                   NODE-ONLY ingest with no indexer involvement at all. The historical default
 *                   (hosted Preprod indexer) is kept so existing invocations behave unchanged.
 *   NODE_ONLY       "1" forces node-only mode regardless of INDEXER_URL
 *   ORACLE_CROSS_CHECK  "1" additionally validates each block's node-derived view against the
 *                   indexer's, throwing on disagreement (validation mode; off by default)
 *   ORACLE_CROSS_CHECK  "1" additionally validates every block's node-derived view against the
 *                   indexer's, throwing on disagreement (validation mode; off by default)
 *   CAPTURE_CONTRACT_STATE  "1" additionally captures per-block contract ledger state +
 *                   zswap state root (sprint 9 Part 2; requires a built midnight-wallet
 *                   checkout -- see MIDNIGHT_WALLET_REPO in tx-replay-decoder.ts)
 *   MAX_BLOCKS      blocks ingested per syncOnce call (default 200)
 *   CAPTURE_ZSWAP_ROOT  "1" also captures midnight_zswapStateRoot per block into
 *                   blocks.zswap_state_root, which is what populates feed_zswap_roots_v1 for
 *                   effectstream's Midnight:ZswapRoot primitive. Costs one extra RPC per block
 *                   and needs a node serving historical state (--state-pruning archive).
 *
 * Run:  ARCHIVE_PG=postgres://user:pass@host:5432/db npx tsx chain-archive-sync/sync-cli.ts
 */
import { createClient } from "../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "./bootstrap.js";
import { ChainArchiveSyncService } from "./sync-service.js";

const CONN = process.env.ARCHIVE_PG;
if (!CONN) {
  // eslint-disable-next-line no-console
  console.error("ARCHIVE_PG is required (a Postgres connection string for the archive DB).");
  process.exit(1);
}
const NET = process.env.NET ?? "preprod";
const SCHEMA = process.env.ARCHIVE_SCHEMA ?? "chain_archive";
const NODE_URL = process.env.NODE_URL ?? "https://rpc.preprod.midnight.network";
const INDEXER_URL = process.env.INDEXER_URL ?? "https://indexer.preprod.midnight.network/api/v4/graphql";
const NODE_ONLY = process.env.NODE_ONLY === "1" || process.env.INDEXER_URL === "none";
// Validation mode: compare the node-derived view against the indexer's on every block. Off by
// default, so indexer-sourced ingest behaves exactly as it did before node reading existed.
const ORACLE_CROSS_CHECK = process.env.ORACLE_CROSS_CHECK === "1";
const CAPTURE_CONTRACT_STATE = process.env.CAPTURE_CONTRACT_STATE === "1";
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS ?? "200");
const CAPTURE_ZSWAP_ROOT = process.env.CAPTURE_ZSWAP_ROOT === "1";

const sql = createClient({ connectionString: CONN, schema: SCHEMA });
await bootstrapChainArchiveSchema(sql, SCHEMA);
const service = new ChainArchiveSyncService({
  sql,
  net: NET,
  schema: SCHEMA,
  node: { url: NODE_URL, timeoutMs: 30_000 },
  // Sprint 9: node-only mode passes NO indexer option at all -- the service then never
  // constructs an IndexerClient, so "no network call to any indexer endpoint" holds by
  // construction, not by configuration discipline.
  ...(NODE_ONLY ? {} : { indexer: { url: INDEXER_URL, timeoutMs: 30_000 } }),
  oracleCrossCheck: ORACLE_CROSS_CHECK,
  captureZswapRoot: CAPTURE_ZSWAP_ROOT,
  captureContractState: CAPTURE_CONTRACT_STATE,
});

let stop = false;
const requestStop = (): void => {
  stop = true;
};
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

// eslint-disable-next-line no-console
console.log(
  `[archive-sync] START net=${NET} schema=${SCHEMA} node=${NODE_URL} ` +
    `indexer=${NODE_ONLY ? "NONE (node-only mode)" : INDEXER_URL} ` +
    `oracle=${ORACLE_CROSS_CHECK ? "on" : "off"}`,
    `zswapRoot=${CAPTURE_ZSWAP_ROOT ? "captured" : "off"}`,
    `contract_state=${CAPTURE_CONTRACT_STATE ? "on" : "off"}`,
);
while (!stop) {
  try {
    const r = await service.syncOnce({ maxBlocks: MAX_BLOCKS });
    const height = await service.getSyncedHeight();
    // eslint-disable-next-line no-console
    console.log(
      `${new Date().toISOString()} synced_height=${height} ingested=${r.ingestedBlocks} tip=${r.targetTipHeight}`,
    );
    if (r.ingestedBlocks === 0) await new Promise((res) => setTimeout(res, 10_000));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`${new Date().toISOString()} error: ${(e as Error).message} (retry in 15s)`);
    await new Promise((res) => setTimeout(res, 15_000));
  }
}
// eslint-disable-next-line no-console
console.log("[archive-sync] stopping");
await sql.end({ timeout: 5 });
