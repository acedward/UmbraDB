import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `replay_checkpoints.ledger_network_id`: the LEDGER network a checkpoint's state belongs to.
 *
 * WHY (audit finding T2). Resume compared a checkpoint's `ledger_version` and nothing else. The
 * network the state was folded under -- `undeployed`, `devnet`, `testnet`, ... -- is embedded in
 * the serialized `LedgerState`, and the resuming code trusted it implicitly while ignoring the
 * `ledgerNetworkId` the process was actually configured with. So a checkpoint folded under one
 * network resumed silently under another, as long as the ledger BUILD matched. Every wrong-network
 * checkpoint written before this carries exactly the same `ledger_version` marker as a right one,
 * which is why the existing guard could not tell them apart.
 *
 * Recording the configured network explicitly, rather than reading it back out of the state, is
 * deliberate: the WASM exposes no accessor for a `LedgerState`'s network id, so there is nothing to
 * read. An explicit column is also the stronger form -- it records what the WRITER was configured
 * for, which is the thing a reader needs to agree with.
 *
 * WHY A SEPARATE MIGRATION from 005. Same rule 005 states for itself: migrations are immutable
 * once applied, and the runner records them by name, so a database that recorded 005 would never
 * see an edit to it. 005 and 006 land together in one change, but they are still two migrations.
 *
 * WHY `NOT NULL` AND EXISTING ROWS DELETED. Identical reasoning to 005: the network cannot be
 * recovered from the row, so back-filling would mean inventing it. `replay_checkpoints` is a
 * derived cache, rebuildable by replaying from genesis. On a fresh database this deletes nothing,
 * because 001-006 apply in sequence against an empty table.
 */
export const name = "006_replay_checkpoint_ledger_network";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  const [table] = await sql<{ n: string }[]>`
    SELECT c.relname AS n
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = ${schema} AND c.relname = 'replay_checkpoints' AND c.relkind = 'r'
  `;
  if (table === undefined) {
    throw new Error(
      `${schema}.replay_checkpoints does not exist; refusing to continue, because this migration ` +
        "adds a column to a table 004 was supposed to have created.",
    );
  }

  await sql`DELETE FROM ${sql(schema)}.replay_checkpoints`;

  await sql`
    ALTER TABLE ${sql(schema)}.replay_checkpoints
      ADD COLUMN ledger_network_id text NOT NULL CHECK (length(ledger_network_id) > 0)
  `;
}
