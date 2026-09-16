import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `dust_parameters`: the three chain DUST parameters in force at a height, written by the ingest
 * that already holds the parsed `LedgerState` (question **Q-22 option C**, owner decision
 * 2026-09-16; plan `plans/00016-dust-wallet-sync.md` §7b).
 *
 * WHY THIS TABLE EXISTS. A `DustLocalState` takes its parameters from its constructor and never
 * learns about a parameter change from the events it replays (measured in Phase 1, question Q-9).
 * So the node's mirror has to be TOLD which parameters the chain uses, and it then serves them on
 * `GET /v1/dust/tip` for every wallet's `walletBalance` arithmetic.
 *
 * The first attempt at telling it (plan D2.6) had the node read the newest `replay_checkpoints`
 * blob and `LedgerState.deserialize` it. On a real archive that blob is 31 MB, deserializing it is
 * MINUTES of synchronous WASM on the node's single thread, and the node stops answering every HTTP
 * request while it runs — measured on preprod, question Q-22. Four numbers do not need a 31 MB
 * ledger state to travel in: the ingest parses one anyway, so it writes the three values down here
 * and the node reads one row.
 *
 * WHY IT IS SPARSE. One row per CHANGE, not one per block: DUST parameters change only through an
 * `OverwriteParameters` system transaction, which is a governance action. `genesis` is the row for
 * the state the fold starts from, `change` a row for a block that actually moved a value, and
 * `resume` one row written once when an archive that already holds blocks gains this table (the
 * values are true as of the resume point; whether they were also true earlier is unknown, and the
 * `reason` says so rather than pretending otherwise).
 *
 * WHY `numeric(39)`. `night_dust_ratio` and `generation_decay_rate` are `u128` in the ledger
 * (`DustParameters`'s constructor takes them as `bigint`), and 2^128 has 39 decimal digits.
 * `dust_grace_period_seconds` is a duration in seconds and fits `bigint`.
 *
 * THE FK targets the PARTITIONED PARENT `blocks (net, height, block_hash)`, exactly as
 * `004_replay_checkpoints` and `009_dust_events` do, so a row for a block this archive does not
 * hold is unstorable rather than merely unlikely — and a fork's rows stay distinguishable (same
 * height, different `block_hash`).
 *
 * NO BLOB, so — unlike 004 — this migration does not have to extend the `chain_blob_roles`
 * vocabulary or the role-removal guard's table enumeration. It adds one ordinary table and one
 * index and changes nothing that exists.
 *
 * The read-only role the TEE-side node uses is NOT created here (a migration must not mint
 * credentials): `docs/SCHEMA.md` and `docs/shielded-monitor-deployment.md` carry the operator's
 * `GRANT SELECT ON chain_archive.dust_parameters TO dust_reader` recipe.
 */
export const name = "010_dust_parameters";

export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);

  // Same discovery-not-assumption preflight as 003-005, 008 and 009: confirm the table this
  // migration attaches its foreign key to is the one it was written against, rather than failing
  // halfway through the CREATE.
  const [table] = await sql<{ n: string }[]>`
    SELECT c.relname AS n
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = ${schema} AND c.relname = 'blocks' AND c.relkind = 'p'
  `;
  if (table === undefined) {
    throw new Error(
      `${schema}.blocks does not exist as a partitioned table; refusing to continue, because this ` +
        "migration adds a foreign key to the table 001 was supposed to have created.",
    );
  }

  await sql`
    CREATE TABLE ${sql(schema)}.dust_parameters (
      net                       text     NOT NULL,
      block_height              bigint   NOT NULL CHECK (block_height >= 0),
      block_hash                bytea    NOT NULL CHECK (octet_length(block_hash) = 32),
      -- u128 in the ledger: 2^128 is 39 decimal digits. Decimal strings at the API boundary
      -- (spec 00016 section 4), because the WASM hands them over as BigInt.
      night_dust_ratio          numeric(39) NOT NULL CHECK (night_dust_ratio >= 0),
      generation_decay_rate     numeric(39) NOT NULL CHECK (generation_decay_rate >= 0),
      dust_grace_period_seconds bigint   NOT NULL CHECK (dust_grace_period_seconds >= 0),
      -- 'genesis': the state the fold starts from (the node's genesis snapshot, height 0).
      -- 'change':  a block whose replay moved at least one of the three values.
      -- 'resume':  written ONCE on an archive that already holds blocks and no rows yet; the
      --            values are true as of this height, and nothing is claimed about earlier ones.
      reason                    text     NOT NULL CHECK (reason IN ('genesis','change','resume')),
      created_at                timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (net, block_height, block_hash),
      FOREIGN KEY (net, block_height, block_hash)
        REFERENCES ${sql(schema)}.blocks (net, height, block_hash)
    )
  `;

  // "The newest row at or below height H for this net" is the only read path that matters: the
  // node runs it once at start and once whenever it checks for a change above its own height.
  await sql`
    CREATE INDEX dust_parameters_at_or_below
      ON ${sql(schema)}.dust_parameters (net, block_height DESC)
  `;
}
