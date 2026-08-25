import type { UmbraDBSql } from "../src/postgres/client.js";
import { runMigrations } from "../src/postgres/migrate.js";
import { evmRpcMigrations } from "../src/postgres/migrations/evm_rpc/index.js";

export async function bootstrapEvmRpcSchema(sql: UmbraDBSql, schema = "evm_rpc"): Promise<void> {
  await runMigrations(sql, { schema, migrations: evmRpcMigrations });
}
