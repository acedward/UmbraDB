import postgres, { type Sql } from "postgres";

export interface DbTransaction {
  readonly hash: Buffer;
  readonly blockHeight: bigint | null;
  readonly blockHash: Buffer | null;
  readonly status: string | null;
  readonly fee: bigint | null;
  readonly fromAddress: Buffer | null;
  readonly toAddress: Buffer | null;
  readonly nonce: bigint;
  readonly rawRef: string | null;
}

export interface EvmRpcReader {
  getNativeBalance(address: Buffer): Promise<bigint | undefined>;
  getTransactionCount(address: Buffer): Promise<bigint>;
  getAddressKind(address: Buffer): Promise<string | undefined>;
  getTransactionByHash(hash: Buffer): Promise<DbTransaction | undefined>;
}

export const emptyEvmRpcReader: EvmRpcReader = {
  async getNativeBalance() { return undefined; },
  async getTransactionCount() { return 0n; },
  async getAddressKind() { return undefined; },
  async getTransactionByHash() { return undefined; },
};

type RpcSql = Sql<{ bigint: bigint }>;

interface DbTransactionRow {
  readonly hash: Buffer;
  readonly block_height: bigint | null;
  readonly block_hash: Buffer | null;
  readonly status: string | null;
  readonly fee: string | bigint | null;
  readonly from_addr: Buffer | null;
  readonly to_addr: Buffer | null;
  readonly nonce: bigint;
  readonly raw_ref: string | null;
}

export class PostgresEvmRpcReader implements EvmRpcReader {
  constructor(readonly sql: RpcSql) {}

  async getNativeBalance(address: Buffer): Promise<bigint | undefined> {
    const rows = await this.sql<{ value: string }[]>`
      SELECT b.value::text AS value
      FROM evm_rpc.address_map AS a
      JOIN evm_rpc.balances AS b ON b.address_id = a.id
      WHERE a.evm_addr = ${address}
        AND b.token_type = ${Buffer.alloc(32)}
      LIMIT 1
    `;
    return rows[0] === undefined ? undefined : BigInt(rows[0].value);
  }

  async getTransactionCount(address: Buffer): Promise<bigint> {
    const rows = await this.sql<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM evm_rpc.tx_index AS t
      JOIN evm_rpc.address_map AS a ON a.id = t.from_id
      WHERE a.evm_addr = ${address}
    `;
    return rows[0]?.count ?? 0n;
  }

  async getAddressKind(address: Buffer): Promise<string | undefined> {
    const rows = await this.sql<{ kind: string }[]>`
      SELECT kind FROM evm_rpc.address_map WHERE evm_addr = ${address} LIMIT 1
    `;
    return rows[0]?.kind;
  }

  async getTransactionByHash(hash: Buffer): Promise<DbTransaction | undefined> {
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
    };
  }
}

export function createPostgresEvmRpcReader(connectionString: string): PostgresEvmRpcReader {
  const sql = postgres(connectionString, {
    max: 5,
    types: { bigint: postgres.BigInt },
    connection: { statement_timeout: 30_000, lock_timeout: 5_000 },
  });
  return new PostgresEvmRpcReader(sql);
}
