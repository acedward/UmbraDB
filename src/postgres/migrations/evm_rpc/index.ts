import * as migration000 from "../000_schema.js";
import * as evmRpcCore from "./001_evm_rpc_core.js";
import type { Migration } from "../../migrate.js";

/** Independent, additive migration lineage for the `evm_rpc` schema. */
export const evmRpcMigrations: Migration[] = [migration000, evmRpcCore];
