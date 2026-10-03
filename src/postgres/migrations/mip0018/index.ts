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
 *
 * Edited in place before the first release (final-audit re-check R4): this lineage is new in PR #26 and unreleased, so
 * its migrations were changed in place (C4: entry points as `bytea`; D5: `unresolved` events and the bounded-read
 * indexes) instead of adding upgrade migrations (owner decision Q7: fresh
 * deployment). `runMigrations` records applied migrations by name only and never re-runs an edited one, so a `mip0018`
 * schema created by an earlier build of PR #26 keeps its earlier tables and checks: drop it and let the scan recreate it
 * (every row is rebuilt from the chain archive; `token-indexer/README.md`, "How to run"). After the first release,
 * changes go into new migrations.
 */
export const mip0018Migrations: Migration[] = [migration000, mip0018Core, mip0018Scan, mip0018Activity];

/** The conventional schema name this lineage lives in. */
export const MIP0018_SCHEMA = "mip0018";
