/**
 * What the JSON-RPC methods read from the module's `evm_rpc` database, runtime-neutral (no Node API): the reader
 * interface, the empty reader, and the SQL reader over any postgres.js-compatible client (postgres.js in Node, the
 * PGlite client `src/postgres/pglite-sql.ts` in a browser). Byte values are `Uint8Array`s (postgres.js returns a
 * `Buffer`, a `Uint8Array` subclass; PGlite a plain `Uint8Array`) and are read with `src/postgres/bytes.ts`.
 */
import type { Sql } from "postgres";
import { bytesToHex, hexToBytes } from "../src/postgres/bytes.js";
// TYPE-only: the receipt log shape is `eth_getLogs`' own, so the two surfaces cannot describe the
// same row differently. Erased at compile time, so this adds no runtime dependency on the log module.
import type { RpcLog } from "./logs/get-logs.js";

export interface DbTransaction {
  readonly hash: Uint8Array;
  readonly blockHeight: bigint | null;
  readonly blockHash: Uint8Array | null;
  readonly status: string | null;
  readonly fee: bigint | null;
  readonly fromAddress: Uint8Array | null;
  readonly toAddress: Uint8Array | null;
  readonly nonce: bigint;
  readonly rawRef: string | null;
  /**
   * The MIDNIGHT transaction hash this row denotes, when that is NOT the row's own key —
   * `null` when the key already IS the Midnight hash.
   *
   * `evm_rpc.tx_index.hash` is deliberately not a single namespace:
   *   - the wallet monitor keys a row on the Midnight transaction hash, which is exactly what
   *     the indexer's block query reports for it;
   *   - the relayer keys a row on the **eth-side** transaction hash — the hash MetaMask
   *     computed, polls with, and is the only identifier it will ever ask about — and records
   *     the Midnight hash it maps to in `raw_ref` as `relayer:midnight:<hash>`.
   *
   * Everything that has to POSITION the row inside its block (`transactionIndex`) or JOIN it
   * against `evm_rpc.logs` must use the Midnight hash; everything that ECHOES an identifier
   * back to the caller must use the key it was asked about. This field is what keeps those
   * two apart instead of silently conflating them.
   */
  readonly canonicalHash: Uint8Array | null;
}

/** `relayer:midnight:<64 hex>` — the only `raw_ref` form that names a different Midnight hash. */
const RELAYER_MIDNIGHT_REF = /^relayer:midnight:([0-9a-fA-F]{64})$/;

/**
 * The Midnight transaction hash a `tx_index` row's `raw_ref` names, or `null` when the row's own
 * key is already that hash (the wallet-monitor's `indexer:transaction:<id>` rows, and any
 * provenance this does not recognise — an unknown `raw_ref` must never be guessed at).
 */
export function canonicalHashFromRawRef(rawRef: string | null | undefined): Uint8Array | null {
  if (rawRef === null || rawRef === undefined) return null;
  const match = RELAYER_MIDNIGHT_REF.exec(rawRef);
  return match === null ? null : hexToBytes(match[1]!.toLowerCase());
}

export interface EvmRpcReader {
  getNativeBalance(address: Uint8Array): Promise<bigint | undefined>;
  getTransactionCount(address: Uint8Array): Promise<bigint>;
  getAddressKind(address: Uint8Array): Promise<string | undefined>;
  getTransactionByHash(hash: Uint8Array): Promise<DbTransaction | undefined>;
  /**
   * Every `evm_rpc.logs` row of one transaction, in `(txIndex, logIndex)` order — the receipts'
   * `logs` array. `hash` must be the **Midnight** transaction hash (`logs.tx_hash` is written by
   * the ingester from the indexer's own transaction identity), which is why receipts join on
   * {@link DbTransaction.canonicalHash} rather than on the key they were queried by.
   *
   * Returns the identical objects `eth_getLogs` serves, from the identical columns: a receipt and
   * a log query must never describe the same row differently.
   */
  getLogsByTransactionHash(hash: Uint8Array): Promise<RpcLog[]>;
}

export const emptyEvmRpcReader: EvmRpcReader = {
  async getNativeBalance() { return undefined; },
  async getTransactionCount() { return 0n; },
  async getAddressKind() { return undefined; },
  async getTransactionByHash() { return undefined; },
  async getLogsByTransactionHash() { return []; },
};

type RpcSql = Sql<{ bigint: bigint }>;

interface DbLogRow {
  readonly evm_addr: Uint8Array;
  readonly block_number: bigint;
  readonly block_hash: Uint8Array;
  readonly tx_hash: Uint8Array;
  readonly tx_index: number;
  readonly log_index: number;
  readonly topic0: Uint8Array;
  readonly topic1: Uint8Array | null;
  readonly topic2: Uint8Array | null;
  readonly topic3: Uint8Array | null;
  readonly data: Uint8Array;
  readonly removed: boolean;
}

const TOPIC_COLUMNS = ["topic0", "topic1", "topic2", "topic3"] as const;

/** The native token's type: 32 zero bytes. */
const NATIVE_TOKEN_TYPE = new Uint8Array(32);

const hex = (value: Uint8Array): string => `0x${bytesToHex(value)}`;
const quantity = (value: number | bigint): string => `0x${value.toString(16)}`;

interface DbTransactionRow {
  readonly hash: Uint8Array;
  readonly block_height: bigint | null;
  readonly block_hash: Uint8Array | null;
  readonly status: string | null;
  readonly fee: string | bigint | null;
  readonly from_addr: Uint8Array | null;
  readonly to_addr: Uint8Array | null;
  readonly nonce: bigint;
  readonly raw_ref: string | null;
}

/** The reader over the `evm_rpc` schema of a postgres.js-compatible client whose `int8` values are `bigint`s. */
export class PostgresEvmRpcReader implements EvmRpcReader {
  constructor(readonly sql: RpcSql) {}

  async getNativeBalance(address: Uint8Array): Promise<bigint | undefined> {
    const rows = await this.sql<{ value: string }[]>`
      SELECT b.value::text AS value
      FROM evm_rpc.address_map AS a
      JOIN evm_rpc.balances AS b ON b.address_id = a.id
      WHERE a.evm_addr = ${address}
        AND b.token_type = ${NATIVE_TOKEN_TYPE}
      LIMIT 1
    `;
    return rows[0] === undefined ? undefined : BigInt(rows[0].value);
  }

  async getTransactionCount(address: Uint8Array): Promise<bigint> {
    const rows = await this.sql<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM evm_rpc.tx_index AS t
      JOIN evm_rpc.address_map AS a ON a.id = t.from_id
      WHERE a.evm_addr = ${address}
    `;
    return rows[0]?.count ?? 0n;
  }

  async getAddressKind(address: Uint8Array): Promise<string | undefined> {
    const rows = await this.sql<{ kind: string }[]>`
      SELECT kind FROM evm_rpc.address_map WHERE evm_addr = ${address} LIMIT 1
    `;
    return rows[0]?.kind;
  }

  async getTransactionByHash(hash: Uint8Array): Promise<DbTransaction | undefined> {
    const rows = await this.sql<DbTransactionRow[]>`
      SELECT t.hash, t.block_height, t.block_hash, t.status, t.fee,
             from_map.evm_addr AS from_addr, to_map.evm_addr AS to_addr, t.raw_ref,
             CASE WHEN t.from_id IS NULL THEN 0::bigint ELSE (
               SELECT count(*)::bigint
               FROM evm_rpc.tx_index AS prior
               WHERE prior.from_id = t.from_id
                 AND (prior.block_height < t.block_height OR
                      (prior.block_height = t.block_height AND prior.hash < t.hash))
             ) END AS nonce
      FROM evm_rpc.tx_index AS t
      LEFT JOIN evm_rpc.address_map AS from_map ON from_map.id = t.from_id
      LEFT JOIN evm_rpc.address_map AS to_map ON to_map.id = t.to_id
      WHERE t.hash = ${hash}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      hash: row.hash,
      blockHeight: row.block_height,
      blockHash: row.block_hash,
      status: row.status,
      fee: row.fee === null ? null : BigInt(row.fee),
      fromAddress: row.from_addr,
      toAddress: row.to_addr,
      nonce: row.nonce,
      rawRef: row.raw_ref,
      canonicalHash: canonicalHashFromRawRef(row.raw_ref),
    };
  }

  async getLogsByTransactionHash(hash: Uint8Array): Promise<RpcLog[]> {
    // `logs_tx_hash_idx (tx_hash, log_index)` exists for exactly this read (010_logs.ts).
    const rows = await this.sql<DbLogRow[]>`
      SELECT a.evm_addr, l.block_number, l.block_hash, l.tx_hash, l.tx_index, l.log_index,
             l.topic0, l.topic1, l.topic2, l.topic3, l.data, l.removed
      FROM evm_rpc.logs AS l
      JOIN evm_rpc.address_map AS a ON a.id = l.address_id
      WHERE l.tx_hash = ${hash}
      ORDER BY l.tx_index, l.log_index
    `;
    return rows.map((row) => {
      const topics: string[] = [];
      for (const column of TOPIC_COLUMNS) {
        const value = row[column];
        // Contiguous by the `logs_topics_contiguous` DDL constraint, so the first gap ends them.
        if (value === null || value === undefined) break;
        topics.push(hex(value));
      }
      return {
        address: hex(row.evm_addr),
        topics,
        data: hex(row.data),
        blockNumber: quantity(row.block_number),
        blockHash: hex(row.block_hash),
        transactionHash: hex(row.tx_hash),
        transactionIndex: quantity(row.tx_index),
        logIndex: quantity(row.log_index),
        removed: row.removed,
      };
    });
  }
}
