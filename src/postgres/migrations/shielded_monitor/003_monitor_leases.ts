import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

/**
 * `monitor_leases`: which scanner instance is currently working on which monitor
 * (organizer sub-plan 00009-08 — "we could spin up multiple if needed").
 *
 * WHY. Until now exactly one scanner process ran per deployment, and the scheduler's in-process
 * `inFlight` set was enough to keep one ordered worker per monitor. Run a second instance against
 * the same B database and that set stops meaning anything: both instances list the same active
 * monitors, both read the same blocks, both deserialize the same transactions, and one of them
 * loses the race at the commit and throws all of it away. Nothing is corrupted — the epoch fence
 * and the monotonic coverage guard see to that, and they are unchanged by this migration — but
 * every duplicated batch is wasted ledger work, which is the expensive part of scanning.
 *
 * A lease is the cheapest thing that stops the waste: an instance claims a monitor before working
 * on it, renews the claim inside the same transaction that advances coverage, and releases it
 * when the turn ends. Another instance sees the claim and picks a different monitor.
 *
 * **A LEASE IS NOT A LOCK, AND CORRECTNESS DOES NOT DEPEND ON IT.** This is the one property
 * worth stating twice. Wall-clock expiry cannot be made safe: an instance can be paused by the
 * kernel for longer than any TTL and wake up believing it still holds a lease that has been
 * reassigned. So nothing in this schema is consulted by the write path. `advance` is admitted by
 * the monitor's EPOCH and by `scanned_through_height` moving strictly forward, exactly as before;
 * two instances that somehow work on the same monitor still produce the correct association set
 * exactly once, with one of them told `already-advanced`. The lease is an optimisation with a
 * clock in it, which is the only kind of optimisation a clock is safe for.
 *
 * WHY A TABLE AND NOT AN ADVISORY LOCK. A PostgreSQL advisory lock would be perfectly mutually
 * exclusive and would die with its session — attractive, and wrong here for two reasons. It is
 * held by a CONNECTION, so the scheduler would have to pin one connection per in-flight monitor
 * for the length of a backfill; and it is invisible to an operator, who cannot ask "which
 * instance is behind on which wallet?" without querying `pg_locks` and decoding a hashed key. A
 * row answers both, and this repository already owns `transaction-lease.ts` for the case where a
 * real mutual exclusion is needed.
 *
 * WHY `ON DELETE CASCADE`. A deleted monitor keeps a tombstone row in `monitors` (US3 scenario 4
 * requires it to be indistinguishable from one that never existed, so `delete` shreds the key and
 * the associations and leaves the row), and a lease outliving its monitor would be a row nothing
 * could ever clean up. The cascade is on the FK, so it costs nothing at scan time.
 *
 * ADDITIVE. One new table and one new index. No existing column, constraint, index or row is
 * touched; a deployment that never claims a lease behaves exactly as it did before this migration
 * (the scheduler's claim is a no-op it always wins), and every pre-00009-08 reader and writer
 * keeps working against a database that has run it.
 */
export const name = "003_monitor_leases";

export async function up(sql: ISql, schema: string): Promise<void> {
  // Defense in depth, matching every other migration in this repo: `runMigrations` already
  // validated `opts.schema`, but a caller invoking `up()` directly bypasses that gate.
  assertValidSchemaName(schema);

  // Discovery, not assumption — the preflight every additive migration in this lineage runs.
  const [table] = await sql<{ n: string }[]>`
    SELECT c.relname AS n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = ${schema} AND c.relname = 'monitors' AND c.relkind = 'r'
  `;
  if (table === undefined) {
    throw new Error(
      `${schema}.monitors does not exist as an ordinary table; refusing to continue, because ` +
        "this migration adds a table whose every row references the one 001_core was supposed to " +
        "have created.",
    );
  }

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(schema)}.monitor_leases (
      -- PRIMARY KEY on the monitor, so "at most one holder" is a constraint rather than a
      -- convention, and the claim below can be one INSERT ... ON CONFLICT.
      monitor_id  uuid        PRIMARY KEY REFERENCES ${sql(schema)}.monitors (id) ON DELETE CASCADE,
      -- The claiming instance's name (SCAN_INSTANCE_ID). Never a monitor id, never a key, never
      -- anything derived from one: it is an operator-chosen label or a random UUID, and it
      -- appears in logs.
      owner       text        NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
      claimed_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL
    )
  `;

  // The claim's own predicate is `expires_at < now()`, and the scheduler asks it once per monitor
  // per cycle. The index keeps that a lookup rather than a scan once a deployment holds many
  // monitors; it is not a uniqueness constraint and carries no semantics.
  await sql`
    CREATE INDEX IF NOT EXISTS monitor_leases_expires_at
      ON ${sql(schema)}.monitor_leases (expires_at)
  `;
}
