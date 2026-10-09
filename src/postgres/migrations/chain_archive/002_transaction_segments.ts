import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../schema-name.js";

/**
 * Per-segment transaction outcomes in the chain archive.
 *
 * A Midnight transaction in a finalized block has an outcome — `SUCCESS`, `PARTIAL_SUCCESS` or
 * `FAILURE` — and its raw bytes keep every intent segment as submitted, including the transcripts
 * (`log` operations, mint effects) of a fallible segment that failed and was discarded by the
 * ledger. A consumer that decodes the archived raw bytes must therefore know, per segment, whether
 * it applied. The indexer reports it as `RegularTransaction.transactionResult { status segments {
 * id success } }`. `transactions.result` (created by `001_chain_archive_core`) holds `status`;
 * this migration adds `segments`, next to it on the same row, holding the indexer's list.
 *
 * Shape: `NULL` when the source reported no list (the indexer sends `null` for `SUCCESS` and
 * `FAILURE`, and a system transaction has no `transactionResult` at all); otherwise a JSON array
 * of `{"id": <segment id>, "success": <boolean>}` objects, written sorted by `id`. The CHECK pins
 * that shape element by element (a segment id is a ledger `u16`), so a malformed value cannot be
 * stored silently. A column on `transactions`, not a side table: it is read with its transaction,
 * written in the same INSERT (so it commits atomically with the row) and travels with the row
 * through the DEFAULT-partition rollover (`chain-archive-rollover.ts`) without a new foreign key.
 *
 * `ALTER TABLE … ADD COLUMN` on the RANGE-partitioned parent propagates to every existing and
 * future partition; the constraint name keeps the `transactions_` prefix so `errors.ts` routes a
 * violation to `ChainArchiveCheckViolationError`.
 */
export const name = "002_transaction_segments";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);
  await sql`
    ALTER TABLE ${sql(schema)}.transactions
      ADD COLUMN segments jsonb
  `;
  await sql`
    ALTER TABLE ${sql(schema)}.transactions
      ADD CONSTRAINT transactions_segments_shape CHECK (
        segments IS NULL OR (
          jsonb_typeof(segments) = 'array'
          AND NOT jsonb_path_exists(
            segments,
            '$[*] ? (!(@.type() == "object" && exists(@.id) && exists(@.success) && @.id.type() == "number" && @.success.type() == "boolean" && @.id >= 0 && @.id <= 65535 && @.id == @.id.floor()))'
          )
        )
      )
  `;
}
