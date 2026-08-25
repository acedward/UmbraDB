/**
 * `evm_rpc.tx_index` canonical-hash repair pass (plan 00006 Phase 7 / Q2 option (a)).
 *
 * THE INVARIANT IT ENFORCES: a row the wallet monitor wrote is keyed on the transaction hash the
 * indexer's **block query** reports for it — the one hash `eth_getTransactionByHash`,
 * `eth_getTransactionReceipt` and `evm_rpc.logs.tx_hash` all agree on. The monitor's own writes
 * already satisfy it (the `unshieldedTransactions` subscription and the block query return the
 * same `Transaction.hash`, measured 7/7 live before this pass existed), so on a healthy database
 * this is a no-op. It exists because "already true" and "guaranteed" are different things: the
 * hash is a PRIMARY KEY that every other surface joins on, and nothing else re-checks it.
 *
 * WHAT IT REPAIRS, concretely:
 *   1. a row whose stored hash disagrees with the block query for the same transaction — rewritten
 *      to the block query's hash (this is the case Q2 predicted);
 *   2. a row whose `block_hash` no longer matches the block at its height, while the transaction
 *      itself is still listed there — the block hash is refreshed.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *   - rows written by the **relayer** (`raw_ref = relayer:midnight:<hash>`). Those are keyed on the
 *     ETH-side transaction hash on purpose: it is the identifier MetaMask computed and is polling
 *     with, and the Midnight hash they map to is already recorded in `raw_ref`. Rewriting them
 *     would delete the only mapping the wallet's own receipt polling can use. `evm-rpc/db.ts`
 *     reads that mapping instead (`canonicalHashFromRawRef`).
 *   - rows of unrecognised provenance. An unknown `raw_ref` is never guessed at.
 *
 * MATCHING IS BY INDEXER TRANSACTION ID, not by hash — matching by hash could only ever confirm
 * what is already stored, which is precisely the thing under suspicion. The monitor records the
 * id it ingested as `raw_ref = indexer:transaction:<id>`, and the block query returns the same ids,
 * so the correspondence is exact even for a block holding several transactions.
 *
 * CRASH SAFETY (S-G3): every rewrite is its own transaction and every one of them is idempotent
 * (re-running finds the hash already canonical and does nothing). The completion watermark is
 * written LAST, so a `kill -9` at any point leaves a database that is either already repaired or
 * still due for a repair that will simply run again.
 */
import type { UmbraDBSql } from "../src/postgres/client.js";
import type { IndexerBlock } from "../evm-rpc/indexer-gql.js";
import { jsonLog } from "./log.js";

/** Bumped only when the pass's own semantics change, which is what makes it re-run everywhere. */
export const TX_HASH_BACKFILL_VERSION = 1;
const WATERMARK_KIND = "tx_index_canonical_hash_backfill";
const WATERMARK_KEY = "monitor";

/** `indexer:transaction:<id>` — the wallet monitor's own provenance marker. */
const MONITOR_REF = /^indexer:transaction:([0-9]+)$/;

export interface TxHashBackfillResult {
  /** Monitor-written rows examined. */
  scanned: number;
  /** Rows whose PRIMARY KEY was rewritten to the block query's hash. */
  rewritten: number;
  /** Rows whose `block_hash` was refreshed from the block query. */
  blockHashRefreshed: number;
  /**
   * Rows the block query cannot place at all — the height exists but lists no transaction with
   * that id. On a local stack this means the row survived a chain reset that the transaction did
   * not. They are left untouched (deleting a user's history on a heuristic is not this pass's
   * call) and are why the pass re-runs instead of latching: a lagging indexer resolves later.
   */
  unresolvable: number;
  /** Rows whose provenance this pass does not own (relayer rows, unknown `raw_ref`). */
  skipped: number;
  /** True when a recorded completion let the whole scan be skipped. */
  alreadyComplete: boolean;
}

interface TxIndexRow {
  hash: Buffer;
  block_height: string | bigint;
  block_hash: Buffer | null;
  raw_ref: string | null;
}

interface WatermarkRow {
  value: { version?: number; unresolvable?: number };
}

export interface TxHashBackfillOptions {
  sql: UmbraDBSql;
  schema?: string;
  /** Only `getBlockByHeight` is used; taking the narrow shape keeps the pass trivially fakeable. */
  indexer: { getBlockByHeight(height: number): Promise<IndexerBlock | undefined> };
  /** Defaults to the module's structured logger; injectable so tests can stay quiet. */
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

async function recordedCompletion(sql: UmbraDBSql, schema: string): Promise<WatermarkRow["value"] | undefined> {
  const rows = await sql<WatermarkRow[]>`
    SELECT value FROM ${sql(schema)}.watermarks
    WHERE kind = ${WATERMARK_KIND} AND key = ${WATERMARK_KEY}
  `;
  return rows[0]?.value;
}

/**
 * Rewrites one row's primary key. Ordered so the two ways this can be reached converge:
 * if a row under the canonical hash ALREADY exists (a later monitor run wrote it before the
 * repair ran), the stale duplicate is dropped and the canonical row stands; otherwise the stale
 * row is renamed in place, keeping its mapped `from_id`/`to_id`.
 */
async function rewriteHash(sql: UmbraDBSql, schema: string, stale: Buffer, canonical: Buffer): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM ${tx(schema)}.tx_index
      WHERE hash = ${stale}
        AND EXISTS (SELECT 1 FROM ${tx(schema)}.tx_index WHERE hash = ${canonical})
    `;
    await tx`UPDATE ${tx(schema)}.tx_index SET hash = ${canonical} WHERE hash = ${stale}`;
  });
}

export async function backfillCanonicalTxHashes(options: TxHashBackfillOptions): Promise<TxHashBackfillResult> {
  const { sql, indexer } = options;
  const schema = options.schema ?? "evm_rpc";
  const log = options.log ?? ((event, extra = {}) => jsonLog("wallet-monitor", event, extra));
  const result: TxHashBackfillResult = {
    scanned: 0, rewritten: 0, blockHashRefreshed: 0, unresolvable: 0, skipped: 0, alreadyComplete: false,
  };

  const previous = await recordedCompletion(sql, schema);
  // A clean previous run latches; one that left unresolvable rows does not, so the pass keeps
  // re-checking them until the indexer can place them (or a human removes them).
  if (previous?.version === TX_HASH_BACKFILL_VERSION && (previous.unresolvable ?? 0) === 0) {
    return { ...result, alreadyComplete: true };
  }

  const rows = await sql<TxIndexRow[]>`
    SELECT hash, block_height, block_hash, raw_ref
    FROM ${sql(schema)}.tx_index
    ORDER BY block_height, hash
  `;

  const blocks = new Map<number, IndexerBlock | undefined>();
  for (const row of rows) {
    const match = row.raw_ref === null ? null : MONITOR_REF.exec(row.raw_ref);
    if (match === null) {
      result.skipped += 1;
      continue;
    }
    result.scanned += 1;

    const height = Number(row.block_height);
    if (!Number.isSafeInteger(height) || height < 0 || height > 2_147_483_647) {
      result.unresolvable += 1;
      continue;
    }
    if (!blocks.has(height)) blocks.set(height, await indexer.getBlockByHeight(height));
    const block = blocks.get(height);
    const transactionId = Number(match[1]);
    const entry = block?.transactions.find((candidate) => candidate.id === transactionId);
    if (block === undefined || entry === undefined) {
      result.unresolvable += 1;
      log("tx-hash-backfill-unresolvable", {
        hash: `0x${row.hash.toString("hex")}`, blockHeight: height, transactionId,
      });
      continue;
    }

    const canonical = Buffer.from(entry.hash.replace(/^0x/, ""), "hex");
    if (canonical.length !== 32) {
      result.unresolvable += 1;
      continue;
    }
    if (!canonical.equals(row.hash)) {
      await rewriteHash(sql, schema, row.hash, canonical);
      result.rewritten += 1;
      log("tx-hash-backfill-rewrite", {
        from: `0x${row.hash.toString("hex")}`, to: `0x${canonical.toString("hex")}`, blockHeight: height,
      });
    }

    const blockHash = Buffer.from(block.hash.replace(/^0x/, ""), "hex");
    if (blockHash.length === 32 && !blockHash.equals(row.block_hash ?? Buffer.alloc(0))) {
      await sql`
        UPDATE ${sql(schema)}.tx_index SET block_hash = ${blockHash} WHERE hash = ${canonical}
      `;
      result.blockHashRefreshed += 1;
    }
  }

  // Written only after every rewrite has committed — a crash before this point simply re-runs.
  await sql`
    INSERT INTO ${sql(schema)}.watermarks (kind, key, value)
    VALUES (${WATERMARK_KIND}, ${WATERMARK_KEY}, ${sql.json({
      version: TX_HASH_BACKFILL_VERSION,
      scanned: result.scanned,
      rewritten: result.rewritten,
      blockHashRefreshed: result.blockHashRefreshed,
      unresolvable: result.unresolvable,
      completedAt: new Date().toISOString(),
    })})
    ON CONFLICT (kind, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
  return result;
}
