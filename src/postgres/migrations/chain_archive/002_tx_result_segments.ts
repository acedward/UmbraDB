import type { ISql } from "postgres";

/**
 * Project 00020, spec FR-002 / owner decision Q8 — per-SEGMENT transaction results in the archive.
 *
 * ── Why the archive needs this ─────────────────────────────────────────────────────────────────
 * A contract call's mints live in two transcripts: the GUARANTEED one, whose effects apply unless
 * the whole transaction failed, and the FALLIBLE one, whose effects apply only if that call's
 * intent SEGMENT succeeded. A `PARTIAL_SUCCESS` transaction therefore has some segments applied and
 * some not, and counting a mint from a failed segment would put a token in the index that the
 * ledger never created. The indexer reports exactly this as
 * `RegularTransaction.transactionResult { status segments { id success } }`; the archive already has
 * a `result` column for `status` (it was simply never written — verified 2026-09-16) and had
 * nowhere to keep the per-segment detail.
 *
 * ── Why it is a separate, additive migration ───────────────────────────────────────────────────
 * `transactions` is RANGE-partitioned by `block_height`; `ALTER TABLE … ADD COLUMN` on the
 * partitioned parent propagates to every existing and future partition, so this is a metadata-only
 * change (no rewrite) and an archive migrated before this change upgrades in place, with the new
 * column NULL for every pre-existing row. `token-indexer`'s `backfill-results` fills those.
 *
 * ── Shape ──────────────────────────────────────────────────────────────────────────────────────
 * `segments` is `jsonb` holding the indexer's own array verbatim — `[{"id": 1, "success": true}, …]`
 * — rather than a normalised side table: it is read as a unit, by one consumer, keyed by the
 * transaction it belongs to, and it is `NULL` for a `SUCCESS` or `FAILURE` transaction (which is
 * exactly what the indexer sends: `segments` is only populated for `PARTIAL_SUCCESS`). The CHECK
 * only pins the JSON TYPE, so a future indexer field inside an element does not break the archive.
 *
 * ── Wiring ─────────────────────────────────────────────────────────────────────────────────────
 * NOT appended to `chainArchiveMigrations` in `./index.ts`: nothing under `src/` may be modified by
 * this project (the repo's hard rule, spec §1/FR-012), and an existing test pins that lineage's
 * exact contents. The consumer wires it instead — `chain-archive-sync/bootstrap.ts` exports
 * `chainArchiveMigrationsWithResults = [...chainArchiveMigrations, thisMigration]` and
 * `bootstrapChainArchiveSchema` applies that. `_migrations` tracks each file by name, so an archive
 * bootstrapped before this existed upgrades on the next start with no rewrite and no downtime.
 */
export const name = "002_tx_result_segments";

export async function up(sql: ISql, schema: string): Promise<void> {
  await sql`
    ALTER TABLE ${sql(schema)}.transactions
      ADD COLUMN IF NOT EXISTS segments jsonb
  `;
  // A jsonb array or nothing — never an object or a scalar. Postgres validates this per row on
  // write, which is where a malformed value would otherwise enter silently.
  await sql`
    ALTER TABLE ${sql(schema)}.transactions
      ADD CONSTRAINT transactions_segments_is_array
      CHECK (segments IS NULL OR jsonb_typeof(segments) = 'array')
  `;
}
