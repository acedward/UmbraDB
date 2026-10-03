import * as migration000 from "../000_schema.js";
import * as mip0018Core from "./001_mip0018_core.js";
import * as mip0018Scan from "./002_mip0018_scan.js";
import * as mip0018Activity from "./003_mip0018_activity.js";
import type { Migration } from "../../migrate.js";

/**
 * The `mip0018` migration lineage — MIP-0018 token metadata (project 00026, fresh schema per Q7).
 *
 * Same mechanism as the `chain_archive` and `evm_rpc` lineages: `000_schema.ts` is reused unchanged to bootstrap an
 * independent `mip0018._migrations` table, and a caller selects this lineage with
 * `runMigrations(sql, { schema: MIP0018_SCHEMA, migrations: mip0018Migrations })`. Nothing in `src/` imports it; the
 * token indexer (`token-indexer/`) and its tests apply it explicitly.
 *
 * `002_mip0018_scan` (sub-plans A3/B2): the scan cursor, mints, color sightings, contract actions and the NIGHT/DUST
 * rows written by the scan over the chain archive, in the same schema as the event log so that one block commits in
 * one transaction.
 *
 * `003_mip0018_activity` (sub-plan C2): the token activity rows (public token flows and metadata transactions) the
 * same scan writes per applied transaction.
 */
export const mip0018Migrations: Migration[] = [migration000, mip0018Core, mip0018Scan, mip0018Activity];

/** The conventional schema name this lineage lives in. */
export const MIP0018_SCHEMA = "mip0018";
