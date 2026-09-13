import * as migration000 from "../000_schema.js";
import * as chainArchiveCore from "./001_chain_archive_core.js";
import * as transactionPositionKey from "./002_transaction_position_key.js";
import * as runtimeMetadata from "./003_runtime_metadata.js";
import * as replayCheckpoints from "./004_replay_checkpoints.js";
import * as replayCheckpointBlockTime from "./005_replay_checkpoint_block_time.js";
import * as replayCheckpointLedgerNetwork from "./006_replay_checkpoint_ledger_network.js";
import * as blobRoleGuardForwardFix from "./007_blob_role_guard_forward_fix.js";
import * as blockTimestamp from "./008_block_timestamp.js";
import type { Migration } from "../../migrate.js";

/**
 * The Tier-1.5 chain-archive migration lineage (`design/full-chain-storage-design.md` §5,
 * revised per the 3-reviewer design-council audit). Deliberately separate from
 * `tier1WalletMigrations`' `000_schema.ts`–`006_ckpt_chunks_size_bytes.ts` numbering — chain-scoped
 * archival data does not belong inside `tier1_wallet` (`design/design.md` §0), and it is
 * explicitly not the Tier-2 indexer-schema fork either, so it gets its own schema and its own
 * migration numbering starting again at `000`.
 *
 * Reuses `000_schema.ts` UNCHANGED rather than duplicating a second copy of the same schema-
 * bootstrap DDL: that migration's `up(sql, schema)` was already fully schema-parameterized
 * (`CREATE SCHEMA IF NOT EXISTS <schema>` + a `<schema>._migrations` bookkeeping table scoped
 * to whatever `schema` string is passed in) — nothing about it assumes `tier1_wallet`
 * specifically. Running it a second time against a *different* schema (e.g. `chain_archive`)
 * bootstraps an independent `_migrations` table scoped to that schema; the same migration
 * `name` ("000_schema") appearing in two different schemas' `_migrations` tables is not a
 * collision, since each is a distinct, schema-qualified physical table. This is the whole
 * "minimal addition" this Tier-1.5 split needed on the runner side — see `../../migrate.ts`'s
 * `RunMigrationsOptions.migrations` for the other half (letting a caller select this lineage
 * instead of the default one).
 *
 * `chain-archive-sync/bootstrap.ts` is the executing path: the packaged archive-sync CLI invokes
 * it before ingest, and integration tests exercise the same bootstrap against real PostgreSQL.
 */
export const chainArchiveMigrations: Migration[] = [
  migration000,
  chainArchiveCore,
  transactionPositionKey,
  runtimeMetadata,
  replayCheckpoints,
  replayCheckpointBlockTime,
  replayCheckpointLedgerNetwork,
  blobRoleGuardForwardFix,
  blockTimestamp,
];

// v3 note: `chainArchiveCore` now also creates `chain_archive_assert_blob_role` (a shared
// plpgsql helper) and one thin `BEFORE INSERT OR UPDATE` trigger per blob-referencing table
// (`blocks`, `transactions`, `bridge_observations`, `verifier_key_observations`) enforcing
// `chain_blob_roles` completeness, and `verifier_keys` was replaced by
// `verifier_key_observations` — see `001_chain_archive_core.ts`'s own header comment and the
// design doc's "Revision history — v3" note for the full reasoning.
//
// v4 note: `chainArchiveCore` additionally now creates `chain_blob_roles_guard_removal_trigger`
// (closes the delete/update-side blob-role gap), `blocks_finalized_monotonic_trigger` (rejects
// un-finalizing a previously-finalized block), and `verifier_key_observations`'s uniqueness key
// now includes `tag` (and no longer includes `first_seen_height`) — see
// `001_chain_archive_core.ts`'s own header comment and the design doc's "Revision history — v4"
// note for the full reasoning.
//
// Sprint 9 notes: 002 re-keys transactions on position; 003 persists runtime metadata; 004-006
// define replay checkpoints with time/network identity; and 007 forward-fixes the role-removal
// guard for databases that already recorded the earlier draft migrations.
//
// 00009-01 note: 008 adds the nullable `blocks.timestamp_ms` column the archive read contract
// (`src/interfaces/archive-read-contract.ts`, spec/00009 FR-028) exposes, so a consumer never
// re-decodes a block body to date it. Additive: no existing column, constraint or row changes,
// and pre-existing blocks keep `NULL` until `chain-archive-sync/backfill-block-timestamps.ts`
// re-decodes their archived bodies.
