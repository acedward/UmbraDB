import * as migration000 from "../000_schema.js";
import * as evmRpcCore from "./001_evm_rpc_core.js";
import * as logs from "./010_logs.js";
import type { Migration } from "../../migrate.js";

/**
 * The `evm_rpc` migration lineage — the EVM-compatibility schema.
 *
 * Structurally identical to the Tier-1.5 `chain_archive` lineage next door, for the same reason and
 * by the same mechanism: `000_schema.ts` is REUSED unchanged (its `up(sql, schema)` was already
 * fully schema-parameterised, so running it against `evm_rpc` bootstraps an independent
 * `evm_rpc._migrations` table), and a caller selects this lineage via
 * `runMigrations(sql, { schema: "evm_rpc", migrations: evmRpcMigrations })`. No new runner
 * machinery was needed — `RunMigrationsOptions.migrations` already exists for exactly this.
 *
 * Lineage order (fixed at the Part F merge, as both parts' headers anticipated):
 * `001_evm_rpc_core` (Part A1/A2 — `address_map`, `balances`, `utxos`, `tx_index`) runs BEFORE
 * `010_logs` (Part C — `logs`, `log_cursors`; creates `address_map` with `IF NOT EXISTS`, a
 * no-op after 001). Databases migrated by either branch alone upgrade cleanly: `_migrations`
 * tracks each file individually and `010_logs` was written to tolerate 001 having run first
 * or not at all.
 *
 * **Not wired into any executing path** — matching `chainArchiveMigrations`' own posture. Nothing
 * in `src/` imports this; `src/` behaviour is untouched, which is a hard constraint of the plan.
 * The consumers are `wallet-monitor/*`, `evm-rpc/logs/*` (the ingester and `eth_getLogs`) and the
 * tests, which apply it explicitly against their own schema.
 */
export const evmRpcMigrations: Migration[] = [migration000, evmRpcCore, logs];

/** The conventional schema name this lineage lives in. */
export const EVM_RPC_SCHEMA = "evm_rpc";
