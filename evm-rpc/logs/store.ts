/**
 * The write path for `evm_rpc.logs` + `evm_rpc.log_cursors`.
 *
 * ── The one invariant this file exists to hold ─────────────────────────────────────────────────
 * Log rows and the cursor that accounts for them are written in ONE transaction. If they were two,
 * a crash between them leaves either logs that will be re-derived on restart (duplicates, caught
 * only by the `source_event_id` unique index) or a cursor past logs that were never written (a
 * PERMANENT hole — the subscription never replays those ids, and no later pass notices). The second
 * is silent and unrecoverable, which is why "one transaction" is not a nicety here.
 *
 * `ON CONFLICT (source_event_id) DO NOTHING` handles the at-least-once delivery the indexer
 * documents for `contractEvents`, and equally handles a restart replaying the tail that
 * `splitCompleteTransactions` deliberately held back.
 */

import type { LogRow, MidnightIdentity } from "./event-map.js";
import { AddressIdCache, resolveAddressId, type SqlLike } from "./address-map.js";
import type { AddressMapper } from "./event-map.js";

export interface CursorUpdate {
  /** The watched Midnight contract address bytes — `log_cursors`' primary key. */
  contractAddress: Uint8Array;
  /** Highest source event id whose logs are included in this same transaction. */
  lastEventId: number;
}

export interface WriteLogsOptions {
  /** Identity of the emitting contract, so `address_map` registration can be resolved. */
  contractIdentity: MidnightIdentity;
  cursor?: CursorUpdate;
  cache?: AddressIdCache;
  addressMapper?: AddressMapper;
}

export interface WriteLogsResult {
  /** Rows actually inserted — less than `rows.length` when duplicates were skipped. */
  inserted: number;
  /** Rows whose `source_event_id` already existed. */
  skipped: number;
}

/** A postgres pool exposing `.begin` (a reserved connection does not — see `src/postgres/migrate.ts`). */
export type SqlPool = SqlLike & {
  begin: <T>(fn: (tx: SqlLike) => Promise<T>) => Promise<T>;
};

/**
 * Writes `rows` and advances the cursor, atomically.
 *
 * Every row is assumed to belong to `options.contractIdentity` — the ingester runs one
 * subscription per watched contract, so a batch never spans contracts.
 */
export async function writeLogs(
  sql: SqlPool,
  schema: string,
  rows: readonly LogRow[],
  options: WriteLogsOptions,
): Promise<WriteLogsResult> {
  if (rows.length === 0) {
    if (options.cursor !== undefined) {
      await advanceCursor(sql, schema, options.cursor);
    }
    return { inserted: 0, skipped: 0 };
  }

  // Staged rather than written straight into the shared cache: an id learned inside a transaction
  // that later rolls back must not outlive it.
  const staged: Array<[MidnightIdentity, bigint]> = [];

  const result = await sql.begin(async (tx) => {
    const addressId = await resolveAddressId(tx, schema, options.contractIdentity, {
      firstSeenBlock: Number(rows[0]!.blockNumber),
      addressMapper: options.addressMapper,
      cache: options.cache,
    });
    if (options.cache?.get(options.contractIdentity) === undefined) {
      staged.push([options.contractIdentity, addressId]);
    }

    const values = rows.map((row) => ({
      address_id: addressId,
      block_number: BigInt(row.blockNumber),
      block_hash: Buffer.from(row.blockHash),
      tx_hash: Buffer.from(row.txHash),
      tx_index: row.txIndex,
      log_index: row.logIndex,
      topic0: Buffer.from(row.topics[0]!),
      topic1: row.topics[1] === undefined ? null : Buffer.from(row.topics[1]),
      topic2: row.topics[2] === undefined ? null : Buffer.from(row.topics[2]),
      topic3: row.topics[3] === undefined ? null : Buffer.from(row.topics[3]),
      data: Buffer.from(row.data),
      removed: row.removed,
      source_event_id: BigInt(row.sourceEventId),
    }));

    // Columns are inferred from the object keys, which every element of `values` builds
    // identically above — an explicit column list adds nothing here and fights the driver's types.
    const inserted = await tx<{ id: bigint }[]>`
      INSERT INTO ${tx(schema)}.logs ${tx(values)}
      ON CONFLICT (source_event_id) DO NOTHING
      RETURNING id
    `;

    if (options.cursor !== undefined) {
      await upsertCursor(tx, schema, options.cursor);
    }
    return { inserted: inserted.length, skipped: rows.length - inserted.length };
  });

  for (const [identity, id] of staged) options.cache?.set(identity, id);
  return result;
}

async function upsertCursor(sql: SqlLike, schema: string, cursor: CursorUpdate): Promise<void> {
  await sql`
    INSERT INTO ${sql(schema)}.log_cursors (contract_address, last_event_id)
    VALUES (${Buffer.from(cursor.contractAddress)}, ${BigInt(cursor.lastEventId)})
    ON CONFLICT (contract_address) DO UPDATE
      SET last_event_id = GREATEST(
            ${sql(schema)}.log_cursors.last_event_id,
            EXCLUDED.last_event_id
          ),
          updated_at = now()
  `;
}

/**
 * Advances the cursor on its own. `GREATEST` makes this monotonic: an out-of-order or replayed
 * batch can never move the cursor BACKWARDS, which would otherwise re-open a window the ingester
 * has already durably covered.
 */
export async function advanceCursor(
  sql: SqlLike,
  schema: string,
  cursor: CursorUpdate,
): Promise<void> {
  await upsertCursor(sql, schema, cursor);
}

/** The resume point for a watched contract: `last_event_id`, or `null` if never ingested. */
export async function readCursor(
  sql: SqlLike,
  schema: string,
  contractAddress: Uint8Array,
): Promise<number | null> {
  const rows = await sql<{ last_event_id: bigint }[]>`
    SELECT last_event_id FROM ${sql(schema)}.log_cursors
    WHERE contract_address = ${Buffer.from(contractAddress)}
  `;
  const value = rows[0]?.last_event_id;
  return value === undefined ? null : Number(value);
}
