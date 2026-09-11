#!/usr/bin/env node
/**
 * One-shot backfill of `blocks.timestamp_ms` (migration 008) for blocks archived before the
 * column existed. Offline: reads only this archive's own blobs and captures -- no node, no
 * indexer -- so it runs against an archive whose source node has long since pruned the state the
 * metadata derives from.
 *
 * Safe to re-run and safe to run while ingest is live: every write is
 * `UPDATE ... WHERE timestamp_ms IS NULL`, so it fills gaps and never overwrites a value.
 *
 * Env:
 *   ARCHIVE_PG      Postgres connection string for the archive DB (REQUIRED)
 *   NET             network id / row scope (default "preprod")
 *   ARCHIVE_SCHEMA  schema name (default "chain_archive")
 *   BATCH_SIZE      blocks per batch (default 500)
 *   MAX_BLOCKS      stop after visiting this many blocks (default: all of them)
 *   DRY_RUN         "1" decodes and reports without writing
 *
 * Exit codes: 0 = every visited block now carries a timestamp; 1 = configuration error;
 * 2 = the run finished but some blocks could not be decoded (each one named on stderr). A
 * non-zero exit for undecodable blocks is deliberate -- silently leaving them NULL is exactly the
 * outcome an operator running this needs to be told about.
 *
 * Run:  ARCHIVE_PG=postgres://... NET=undeployed npx tsx chain-archive-sync/backfill-timestamps-cli.ts
 */
import { createClient } from "../src/postgres/client.js";
import { backfillBlockTimestamps } from "./backfill-block-timestamps.js";

const CONN = process.env.ARCHIVE_PG;
if (!CONN) {
  // eslint-disable-next-line no-console
  console.error("ARCHIVE_PG is required (a Postgres connection string for the archive DB).");
  process.exit(1);
}
const NET = process.env.NET ?? "preprod";
const SCHEMA = process.env.ARCHIVE_SCHEMA ?? "chain_archive";
const DRY_RUN = process.env.DRY_RUN === "1";

function positiveIntEnv(name: string, fallback: number | undefined): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    // eslint-disable-next-line no-console
    console.error(`${name} must be a whole number >= 1; got "${raw}".`);
    process.exit(1);
  }
  return value;
}

const BATCH_SIZE = positiveIntEnv("BATCH_SIZE", 500)!;
const MAX_BLOCKS = positiveIntEnv("MAX_BLOCKS", undefined);

const sql = createClient({ connectionString: CONN, schema: SCHEMA });
try {
  const result = await backfillBlockTimestamps(sql, {
    net: NET,
    schema: SCHEMA,
    batchSize: BATCH_SIZE,
    maxBlocks: MAX_BLOCKS,
    dryRun: DRY_RUN,
    // eslint-disable-next-line no-console
    onProgress: (message) => console.log(message),
  });
  // eslint-disable-next-line no-console
  console.log(
    `[backfill-timestamps] done: scanned=${result.scanned} decoded=${result.decoded} ` +
      `updated=${result.updated} unresolved=${result.unresolved.length}` +
      (DRY_RUN ? " (dry run: nothing was written)" : ""),
  );
  if (result.unresolved.length > 0) {
    for (const entry of result.unresolved) {
      // eslint-disable-next-line no-console
      console.error(`[backfill-timestamps] height ${entry.height} (${entry.blockHash}): ${entry.reason}`);
    }
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
} finally {
  await sql.end({ timeout: 5 });
}
