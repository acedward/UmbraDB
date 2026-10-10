/**
 * The JSON-RPC methods' `evm_rpc` reader in Node: the runtime-neutral reader (`reader.ts`) over a postgres.js
 * connection pool.
 */
import postgres from "postgres";
import { PostgresEvmRpcReader } from "./reader.js";

export {
  canonicalHashFromRawRef, type DbTransaction, emptyEvmRpcReader, type EvmRpcReader, PostgresEvmRpcReader,
} from "./reader.js";

export function createPostgresEvmRpcReader(connectionString: string): PostgresEvmRpcReader {
  const sql = postgres(connectionString, {
    max: 5,
    types: { bigint: postgres.BigInt },
    connection: { statement_timeout: 30_000, lock_timeout: 5_000 },
  });
  return new PostgresEvmRpcReader(sql);
}
