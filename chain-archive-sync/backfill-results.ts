import type { UmbraDBSql } from "../src/postgres/client.js";
import type { TransactionResult } from "../src/interfaces/chain-archive-store.js";
import { IndexerClient } from "./indexer-client.js";
import { mapTransactionResult } from "./sync-service.js";

/**
 * Project 00020, spec FR-002 — fill `chain_archive.transactions.result` and `segments` for blocks
 * archived BEFORE the sync learned to write them.
 *
 * Why it exists: `transactions.result` has been in the schema all along but was never written
 * (verified 2026-09-16), and `segments` is new. Every archive that already exists — including this
 * project's own Stagenet archive, whose sync process was started before this change and must not be
 * restarted — therefore has NULLs there. The token scanner cannot tell "succeeded" from "unknown",
 * so it refuses to count a mint from a transaction whose result it does not know; this is the
 * repair path that makes those transactions countable.
 *
 * It re-queries the indexer per BLOCK (the same `block(offset: {height})` query the sync itself
 * uses, so no new server surface) and updates only rows whose `result IS NULL`, which makes it
 * idempotent and safe to run against a live, growing archive while the sync is running: the sync
 * writes its own rows, this fills the old ones, and the `WHERE result IS NULL` predicate means the
 * two can never fight over a row.
 *
 * System transactions are skipped entirely: `transactionResult` is declared on the SDL's
 * `RegularTransaction` only, so a system transaction has no result to backfill and its NULL is
 * correct, not missing. `token-indexer`'s scanner skips them too (they carry no contract actions).
 */

export interface BackfillResultsOptions {
  sql: UmbraDBSql;
  schema: string;
  net: string;
  /** GraphQL v4 endpoint — the same one the sync uses. */
  indexerUrl: string;
  /** Lowest height to consider (inclusive). Default: the archive's own lowest. */
  fromHeight?: number;
  /** Highest height to consider (inclusive). Default: the archive's own highest. */
  toHeight?: number;
  /** Stop after this many blocks in one call — bounds a `serve` loop's work per tick. */
  maxBlocks?: number;
  /** Injection seam for tests. */
  client?: Pick<IndexerClient, "getBlockByHeight">;
  onBlock?: (info: { height: number; updated: number }) => void;
}

export interface BackfillResultsOutcome {
  /** Blocks that still had at least one regular transaction with a NULL result when we looked. */
  blocksExamined: number;
  /** Rows actually updated. */
  transactionsUpdated: number;
  /** Heights the indexer could not serve (it is behind, or the block is gone) — left for later. */
  blocksUnavailable: number;
  /** The highest height examined, so a caller can page. */
  lastHeight: number | undefined;
}

/** Heights (ascending) that still hold at least one regular transaction with no archived result. */
export async function heightsMissingResults(
  sql: UmbraDBSql, schema: string, net: string,
  opts: { fromHeight?: number; toHeight?: number; limit: number },
): Promise<number[]> {
  const rows = await sql<{ block_height: string }[]>`
    SELECT DISTINCT block_height
    FROM ${sql(schema)}.transactions
    WHERE net = ${net}
      AND kind = 'regular'
      AND result IS NULL
      AND (${opts.fromHeight ?? null}::bigint IS NULL OR block_height >= ${opts.fromHeight ?? null})
      AND (${opts.toHeight ?? null}::bigint IS NULL OR block_height <= ${opts.toHeight ?? null})
    ORDER BY block_height
    LIMIT ${opts.limit}
  `;
  return rows.map((r) => Number(r.block_height));
}

export async function backfillTransactionResults(
  opts: BackfillResultsOptions,
): Promise<BackfillResultsOutcome> {
  const { sql, schema, net } = opts;
  const client = opts.client ?? new IndexerClient({ url: opts.indexerUrl });
  const maxBlocks = opts.maxBlocks ?? 500;
  const heights = await heightsMissingResults(sql, schema, net, {
    fromHeight: opts.fromHeight, toHeight: opts.toHeight, limit: maxBlocks,
  });

  let transactionsUpdated = 0;
  let blocksUnavailable = 0;
  let lastHeight: number | undefined;

  for (const height of heights) {
    const block = await client.getBlockByHeight(height);
    lastHeight = height;
    if (block === undefined) {
      blocksUnavailable++;
      continue;
    }
    let updatedHere = 0;
    for (const tx of block.transactions) {
      const result: TransactionResult | undefined = mapTransactionResult(tx.transactionResult);
      if (result === undefined) continue;
      const segments = tx.transactionResult?.segments ?? null;
      const updated = await sql`
        UPDATE ${sql(schema)}.transactions
        SET result = ${result},
            segments = ${segments === null ? null : sql.json(segments.map((s) => ({ id: s.id, success: s.success })))}
        WHERE net = ${net}
          AND block_height = ${height}
          AND tx_hash = ${Buffer.from(stripHexPrefix(tx.hash), "hex")}
          AND result IS NULL
      `;
      updatedHere += updated.count;
    }
    transactionsUpdated += updatedHere;
    opts.onBlock?.({ height, updated: updatedHere });
  }

  return {
    blocksExamined: heights.length,
    transactionsUpdated,
    blocksUnavailable,
    lastHeight,
  };
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}
