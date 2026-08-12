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
 *   NODE_ONLY       "1" forces node-only mode regardless of INDEXER_URL. **EXPERIMENTAL** -- see
 *                   the warning below; not yet a general indexer replacement.
 *   ORACLE_CROSS_CHECK  "1" additionally validates every block's node-derived view against the
 *                   indexer's, throwing on disagreement (validation mode; off by default)
 *   REPLAY_VALIDATION   "1" applies every block to real ledger state as it is ingested and REFUSES
 *                   a block the reference indexer would refuse. Requires LEDGER_NETWORK_ID, an
 *                   unbroken run from genesis, and the patched ledger build. Off by default: it is
 *                   strictly slower and cannot start mid-chain without a checkpoint.
 *   LEDGER_NETWORK_ID   the LEDGER's network id (e.g. "undeployed"). Required by REPLAY_VALIDATION.
 *                   NOT the same as NET, which is this archive's row-scope label.
 *   REPLAY_CHECKPOINT_INTERVAL  blocks between replay checkpoints (default 1000)
 *   MAX_BLOCKS      blocks ingested per syncOnce call (default 200)
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
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS ?? "200");
const REPLAY_VALIDATION = process.env.REPLAY_VALIDATION === "1";
const LEDGER_NETWORK_ID = process.env.LEDGER_NETWORK_ID;
const REPLAY_CHECKPOINT_INTERVAL = Number(process.env.REPLAY_CHECKPOINT_INTERVAL ?? "1000");

if (NODE_ONLY) {
  // Announced BEFORE connecting to Postgres, deliberately. Mode is known from the environment
  // alone, and an operator whose database is unreachable would otherwise hit a connection error
  // having never been told which ingest source they selected.
  //
  // Said at every start rather than once in a doc: node-only ingest is correct where it completes
  // and refuses where it cannot, but it is NOT yet a general replacement for the indexer, and the
  // difference is invisible on a chain that happens not to exercise the gaps -- a devnet can look
  // like a clean cutover for weeks.
  // eslint-disable-next-line no-console
  console.warn(
    "[archive-sync] WARNING node-only mode is EXPERIMENTAL and not yet a general indexer " +
      "replacement. It archives extrinsic-borne transactions and system transactions, and REFUSES " +
      "(rather than silently omitting) runtime-generated event-borne system transactions, signed " +
      "or general framings, and runtimes whose call indices it has not been verified against. " +
      "Expect it to stop on a chain that produces any of those. Byte-parity with the indexer is " +
      "demonstrated only on the genesis/bare-extrinsic slice so far.",
  );
}

if (REPLAY_VALIDATION && LEDGER_NETWORK_ID === undefined) {
  // Checked here rather than left to the service constructor, which would print the banner below
  // with "undefined" in it and then throw from deeper in the stack. An operator misconfiguring
  // this should be told what to set, immediately.
  // eslint-disable-next-line no-console
  console.error(
    "REPLAY_VALIDATION=1 requires LEDGER_NETWORK_ID (the LEDGER's network id, e.g. \"undeployed\"). " +
      "It is NOT the same as NET, which is this archive's row-scope label -- initialising ledger " +
      "state against the wrong network invalidates every well-formedness check.",
  );
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log(`[archive-sync] replay validation ${REPLAY_VALIDATION ? "ON" : "off"}` +
  (REPLAY_VALIDATION ? ` (ledger network ${LEDGER_NETWORK_ID}, checkpoint every ${REPLAY_CHECKPOINT_INTERVAL})` : ""));

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
  // Audit round 3: replay gated ingest in tests but was unreachable from this CLI, so the
  // DEPLOYABLE path was never replay-gated -- the guarantee existed only where it was already
  // being asserted. Exposed here so an operator can actually turn it on.
  replayValidation: REPLAY_VALIDATION,
  ...(LEDGER_NETWORK_ID === undefined ? {} : { ledgerNetworkId: LEDGER_NETWORK_ID }),
  replayCheckpointInterval: REPLAY_CHECKPOINT_INTERVAL,
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
