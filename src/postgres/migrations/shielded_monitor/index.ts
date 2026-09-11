import * as migration000 from "../000_schema.js";
import * as shieldedMonitorCore from "./001_core.js";
import * as shieldedMonitorAssociationDetails from "./002_association_details.js";
import type { Migration } from "../../migrate.js";

/**
 * The project-B shielded-monitor migration lineage (organizer spec
 * `/home/eddie/todo/Umbra/spec/00009-wallet-data-store-availability.md`; design in
 * `openspec/changes/00009-02-monitor-store/design.md`).
 *
 * A third, independent lineage alongside `tier1WalletMigrations` and `chainArchiveMigrations`,
 * following the precedent `design/full-chain-storage-design.md` §5 set for Tier-1.5: its own
 * schema (conventionally `shielded_monitor`), its own numbering starting again at `000`, and
 * `000_schema.ts` reused UNCHANGED as the bootstrap step — that migration's `up(sql, schema)` is
 * already fully schema-parameterised, so running it against a third schema bootstraps a third
 * independent `_migrations` table. The same migration `name` appearing in three schemas'
 * `_migrations` tables is not a collision; each is a distinct, schema-qualified physical table.
 *
 * Why a separate lineage rather than more tables in an existing schema: owner **Rule B**
 * (spec US5/FR-025) requires project B to write only its own schema, never an archive table, and
 * to stay restorable on its own so it can later run in a separate process or TEE. Two schemas
 * with no shared table is the mechanical form of that rule, and it is what
 * `test/shielded-monitor/schema-isolation.integration.test.ts` proves at runtime by driving the
 * whole B flow under a role that holds only `USAGE`/`SELECT` on `chain_archive`.
 *
 * `shielded-monitor/bootstrap.ts` is the executing path (the trusted harness invokes it, and the
 * integration tests exercise the same bootstrap against real PostgreSQL) — the same relationship
 * `chain-archive-sync/bootstrap.ts` has to `chainArchiveMigrations`.
 */
export const shieldedMonitorMigrations: Migration[] = [
  migration000,
  shieldedMonitorCore,
  // 00009-07: additive, nullable `associations.details` / `associations.block_timestamp_ms` plus
  // the partial index the details backfill works from. Appended, never inserted: the runner
  // applies this list in order and records each by name, so the order of already-applied entries
  // is part of the lineage's identity.
  shieldedMonitorAssociationDetails,
];
