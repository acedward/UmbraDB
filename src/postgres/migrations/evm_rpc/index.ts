import * as migration000 from "../000_schema.js";
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
 * **Part C contributes only `010_logs`.** This lineage is OWNED by Part A1/A2, which contributes
 * the earlier-numbered migrations (`address_map` among them); that work is not in this clone, so
 * this array currently lists just the schema bootstrap plus C's own migration. At the Part F merge
 * the A1/A2 entries are inserted BEFORE `logs` in this same array and nothing here needs
 * renumbering — see `010_logs.ts`'s header for why it is numbered `010` and why it creates
 * `address_map` with `IF NOT EXISTS`.
 *
 * **Not wired into any executing path** — matching `chainArchiveMigrations`' own posture. Nothing
 * in `src/` imports this; `src/` behaviour is untouched by Part C, which is a hard constraint of
 * the plan. The consumers are `evm-rpc/logs/*` (the ingester and `eth_getLogs`) and the tests,
 * which apply it explicitly against their own schema.
 */
export const evmRpcMigrations: Migration[] = [migration000, logs];

/** The conventional schema name this lineage lives in. */
export const EVM_RPC_SCHEMA = "evm_rpc";
