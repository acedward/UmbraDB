#!/usr/bin/env node
/**
 * chain-archive-sync CLI -- runs {@link ChainArchiveSyncService} in a resumable loop against a
 * live Midnight node (JSON-RPC) + indexer (GraphQL), populating the `chain_archive` schema. This
 * is the production/ops entry point for finalized chain-archive ingest.
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
 *   NODE_ONLY       "1" forces node-only mode regardless of INDEXER_URL. Requires a historical
 *                   archive node for every range being ingested.
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
const REPLAY_VALIDATION = process.env.REPLAY_VALIDATION === "1";
const LEDGER_NETWORK_ID = process.env.LEDGER_NETWORK_ID;

/**
 * Read a positive-whole-number setting, or exit with a message naming what was wrong.
 *
 * Audit T6: `REPLAY_CHECKPOINT_INTERVAL=0` (and `NaN`, and fractional values) SILENTLY DISABLED
 * checkpointing. The service tests `height % interval === 0`; with `0` that is `NaN`, with `2.5`
 * it is almost never true -- so no checkpoint was ever written, no error was raised, and the only
 * symptom appeared much later as a restart replaying the entire chain. A misconfiguration that
 * turns a durability feature off must not look like a working configuration.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    // eslint-disable-next-line no-console
    console.error(
      `${name} must be a whole number >= 1; got "${raw}". Zero, fractional, negative and ` +
        "non-numeric values do not merely misconfigure this setting -- they disable the behaviour " +
        "it controls without any error, which is why they are rejected here rather than tolerated.",
    );
    process.exit(1);
  }
  return value;
}

const MAX_BLOCKS = positiveIntEnv("MAX_BLOCKS", 200);
const REPLAY_CHECKPOINT_INTERVAL = positiveIntEnv("REPLAY_CHECKPOINT_INTERVAL", 1000);

if (NODE_ONLY) {
  // Announced BEFORE connecting to Postgres, deliberately. Mode is known from the environment
  // alone, and an operator whose database is unreachable would otherwise hit a connection error
  // having never been told which ingest source they selected.
  //
  // Said at every start rather than once in a doc: first-time historical ingest reads per-block
  // metadata, events and runtime state, so a pruned endpoint cannot supply an omitted range.
  // eslint-disable-next-line no-console
  console.log(
    "[archive-sync] node-only mode enabled. Historical ingest requires an archive node because " +
      "System::Events and runtime state are read at each block; already-captured runtime metadata " +
      "and replay checkpoints remain local to this archive.",
  );
}

if (REPLAY_VALIDATION && (LEDGER_NETWORK_ID === undefined || LEDGER_NETWORK_ID.trim() === "")) {
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
await bootstrapChainArchiveSchema(sql, SCHEMA, { net: NET });
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
