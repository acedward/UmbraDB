import * as migration000 from "../000_schema.js";
import * as chainArchiveCore from "./001_chain_archive_core.js";
import * as zswapRoot from "./002_zswap_root.js";
import * as contractState from "./003_contract_state.js";
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
 * **Not wired into any executing path.** Nothing in this repo's application code imports this
 * array and calls `runMigrations(sql, { schema: "chain_archive", migrations:
 * chainArchiveMigrations })` — it is exported for the same reason `005_chain_archive.ts` used
 * to sit unregistered in the migrations directory: a genuine, syntactically-correct migration
 * lineage, design-stage only, gated on design-council ratification before any real wiring or
 * live apply.
 */
export const chainArchiveMigrations: Migration[] = [
  migration000,
  chainArchiveCore,
  zswapRoot,
  contractState,
];

// 003 note (sprint 9): `contractState` adds the `contract_states` table (+ its height
// partitions, blob-role trigger, and a `'contract_state'` branch in the v4 removal guard), the
// `'contract_state'` blob role, and the `feed_contract_states_v1` read view. It does NOT add
// `blocks.zswap_state_root` -- that column belongs to `002_zswap_root`, which owns block-level
// node readings; adding it in both made the two un-composable. See `003_contract_state.ts` for the full
// reasoning.

// v3 note: `chainArchiveCore` now also creates `chain_archive_assert_blob_role` (a shared
// plpgsql helper) and one thin `BEFORE INSERT OR UPDATE` trigger per blob-referencing table
// (`blocks`, `transactions`, `bridge_observations`, `verifier_key_observations`) enforcing
// `chain_blob_roles` completeness, and `verifier_keys` was replaced by
// `verifier_key_observations` — see `001_chain_archive_core.ts`'s own header comment and the
// design doc's "Revision history — v3" note for the full reasoning.
//
// Phase-1 note: `002_zswap_root` adds `blocks.zswap_state_root` / `blocks.timestamp_ms` and the
// first two versioned read views (`feed_blocks_v1`, `feed_zswap_roots_v1`) -- the read contract
// effectstream's `Midnight:ZswapRoot` primitive consumes in place of the indexer's GraphQL. It is
// deliberately narrow: everything else that primitive migration needs is an output of stateful
// ledger replay and gets its own migration when that engine lands.
//
// v4 note: `chainArchiveCore` additionally now creates `chain_blob_roles_guard_removal_trigger`
// (closes the delete/update-side blob-role gap), `blocks_finalized_monotonic_trigger` (rejects
// un-finalizing a previously-finalized block), and `verifier_key_observations`'s uniqueness key
// now includes `tag` (and no longer includes `first_seen_height`) — see
// `001_chain_archive_core.ts`'s own header comment and the design doc's "Revision history — v4"
// note for the full reasoning.
