import postgres, { type Sql } from "postgres";
import { DEFAULT_ARCHIVE_SCHEMA } from "../../../src/postgres/archive-conventions.js";

/**
 * The DUST module's read-only view of the archive database
 * (`spec/00016-dust-wallet-sync.md` §5.7, FR-010, FR-015, FR-016).
 *
 * ── This file is the waiver ─────────────────────────────────────────────────────────────────
 * It is the ONLY place in project B that imports the `postgres` driver or anything under
 * `src/postgres/`, and it may do so because the owner waived Rule B for
 * `shielded-monitor/node/dust/` on 2026-09-15 (spec 00016 §1 "The waiver", FR-017). The waiver is
 * enforced as an allow-list, not as a hole: `test/shielded-monitor/import-boundary.test.ts`
 * reports exactly which banned modules this directory reaches and fails if the set grows, and
 * every other B file stays under the total ban.
 *
 * ── Two rules the waiver did NOT relax ──────────────────────────────────────────────────────
 * **The schema name is not typed here.** `DEFAULT_ARCHIVE_SCHEMA` is imported from A's
 * `archive-conventions.ts`, which exists precisely so a consumer does not assert a convention it
 * does not own. `schema-isolation.integration.test.ts` still fails if the literal appears in B's
 * source outside a comment, and it is NOT waived.
 *
 * **The role cannot write.** `DUST_DATABASE_URL` names a role with `USAGE` on the archive schema
 * and `SELECT` on `dust_events`, `dust_parameters` and `blocks` — nothing else, and nothing at all
 * in `shielded_monitor`. In particular NOT `replay_checkpoints` and NOT `chain_blobs`: question
 * Q-22 replaced the only query that wanted them. `dust-reader-role.integration.test.ts` runs every query below as exactly
 * that role and proves each write and each out-of-scope read is denied. That is the part of the
 * boundary that survives the waiver, and it is a privilege check rather than a code review.
 *
 * ── Custody ─────────────────────────────────────────────────────────────────────────────────
 * `selectSpendsByNullifiers` is the accepted leak (owner Q-2): the database sees the nullifiers a
 * wallet asks about. What is NOT accepted is anything more than that — the values travel as bound
 * parameters of one prepared statement, are never logged, never persisted and never written into
 * an error message. No query below is assembled by string concatenation.
 */

/** One row of the replay stream the mirror folds (FR-011). */
export interface DustRawEvent {
  readonly id: bigint;
  readonly blockHeight: bigint;
  readonly raw: Uint8Array;
}

/** The table's own tip, which may be ahead of the mirror's (Story 3 scenario 1). */
export interface DustTableTip {
  readonly eventId: bigint;
  readonly height: bigint;
}

/** A `dustInitialUtxo` row with its generation entry's LATEST end time merged in (FR-016). */
export interface DustInitialUtxoRow {
  readonly id: bigint;
  readonly blockHeight: bigint;
  readonly txHash: Uint8Array;
  readonly generationIndex: bigint;
  /** `payload.output` as the ingest wrote it — already in spec §4's encodings. */
  readonly output: Record<string, unknown>;
  /** `payload.generation`, with `dtime` replaced by the latest kind-2 value when one exists. */
  readonly generation: Record<string, unknown>;
}

/** A generation entry of one owner, with the same merge (FR-016). */
export interface DustGenerationRow {
  readonly generationIndex: bigint;
  readonly value: string;
  readonly owner: string;
  readonly nonce: string;
  readonly dtime: number | null;
}

/** A `dustSpendProcessed` row — the public `SpendRecord` of spec §4. */
export interface DustSpendRow {
  readonly id: bigint;
  readonly blockHeight: bigint;
  readonly txHash: Uint8Array;
  readonly nullifier: string;
  readonly commitment: string;
  readonly commitmentIndex: bigint;
  readonly vFee: string;
  readonly declaredTime: bigint;
  readonly blockTime: bigint;
}

/**
 * The chain's DUST parameters at a height, as the ingest recorded them
 * (`chain_archive.dust_parameters`, migration 010; question **Q-22 option C**).
 *
 * ── What this replaced, and why ─────────────────────────────────────────────────────────────
 * This module used to answer the same question by reading the newest `replay_checkpoints` blob and
 * calling `LedgerState.deserialize` on it. On a real archive that blob is **31 MB**, the
 * deserialize is minutes of synchronous WASM on the node's only thread, and the node answered
 * nothing at all while it ran (measured on preprod: question Q-22). It also needed `SELECT` on
 * `replay_checkpoints` AND `chain_blobs` — the archive's entire raw-bytes store — which is the
 * conflict question Q-15 was about.
 *
 * One row of three numbers replaces both problems: the ingest already holds the parsed ledger
 * state, so it writes them down, and the reader role needs `SELECT` on one more small table. No
 * ledger state is deserialized anywhere in project B any more.
 *
 * Decimal strings, not `bigint`: they are `u128` on chain, `numeric(39)` in the table, and decimal
 * strings on `GET /v1/dust/tip`. Nothing in the path can round them.
 */
export interface DustParametersRow {
  readonly blockHeight: bigint;
  readonly nightDustRatio: string;
  readonly generationDecayRate: string;
  readonly dustGracePeriodSeconds: string;
  readonly reason: string;
}

export interface DustDb {
  /** The events after `afterId`, ascending, at most `limit` of them. */
  selectEventsAfter(net: string, afterId: bigint, limit: number): Promise<DustRawEvent[]>;
  /**
   * The DUST parameters in force at `atHeight` — the newest row at or below it — or `undefined`
   * when the archive records none. `atHeight` omitted means "the newest row overall", which is
   * what a mirror asks before it has folded anything.
   */
  selectDustParametersAtOrBelow(net: string, atHeight?: bigint): Promise<DustParametersRow | undefined>;
  /** The table's newest event, or `undefined` when the table holds nothing for this net. */
  selectTableTip(net: string): Promise<DustTableTip | undefined>;
  selectInitialUtxosByOwner(
    net: string,
    owner: string,
    afterId: bigint,
    limit: number,
  ): Promise<DustInitialUtxoRow[]>;
  selectGenerationByOwner(
    net: string,
    owner: string,
    afterIndex: bigint,
    limit: number,
  ): Promise<DustGenerationRow[]>;
  selectSpendsByNullifiers(net: string, nullifiers: readonly string[]): Promise<DustSpendRow[]>;
  close(): Promise<void>;
}

/** What the driver hands back for a `dust_parameters` row: `numeric` as a string, `bigint` as a
 *  `bigint` (the pool sets `types.bigint`). */
interface DustParametersSqlRow {
  block_height: bigint;
  night_dust_ratio: string;
  generation_decay_rate: string;
  dust_grace_period_seconds: bigint;
  reason: string;
}

/** What the driver hands back for a `jsonb` payload column. */
interface PayloadShape {
  readonly output?: Record<string, unknown>;
  readonly generation?: Record<string, unknown>;
}

/**
 * Opens the read-only connection.
 *
 * `max: 4` (spec §5.7): the mirror holds one connection for its replay page, and the routes share
 * the rest. A bigger pool would only let a burst of lookups queue inside PostgreSQL instead of
 * inside this process, and this connection is a privilege the deployment would rather have little
 * of than a lot.
 *
 * Opening is LAZY in the sense FR-010 requires: `postgres()` does not connect, it builds a pool,
 * so a node whose DUST credential is wrong still starts and still serves every monitor-store
 * route — the failure surfaces as `503 DUST_DB_UNAVAILABLE` on the DUST routes alone.
 */
export function openDustDb(
  databaseUrl: string,
  options: { readonly schema?: string; readonly maxConnections?: number } = {},
): DustDb {
  const schema = options.schema ?? DEFAULT_ARCHIVE_SCHEMA;
  const sql: Sql<{ bigint: bigint }> = postgres(databaseUrl, {
    max: options.maxConnections ?? 4,
    connection: {
      search_path: schema,
      statement_timeout: 120_000,
      lock_timeout: 30_000,
      idle_in_transaction_session_timeout: 120_000,
    },
    // Without this, `bigint` columns come back as strings and every id comparison in the mirror
    // would be a string comparison — `"10" < "9"` — which is the kind of bug that only shows up
    // after ten thousand events.
    types: { bigint: postgres.BigInt },
  });
  const table = sql(`${schema}.dust_events`);
  const parametersTable = sql(`${schema}.dust_parameters`);

  /**
   * The latest end time of a generation entry, as a lateral join.
   *
   * A `LEFT JOIN LATERAL … LIMIT 1` rather than a scalar subquery so the answer distinguishes
   * "no kind-2 row exists" (`present` is null → keep the kind-1 value) from "a kind-2 row exists
   * and set no end time" (`present` is true, `dtime` null → the entry has no end time). A scalar
   * subquery returns null for both, and the two mean opposite things.
   *
   * `dust_events_gen_idx (net, generation_index, id) WHERE kind IN (1,2)` serves it directly.
   */
  const latestDtime = sql`
    LEFT JOIN LATERAL (
      SELECT u.dtime, true AS present
      FROM ${table} u
      WHERE u.net = e.net AND u.kind = 2 AND u.generation_index = e.generation_index
      ORDER BY u.id DESC
      LIMIT 1
    ) latest ON true
  `;

  function mergedGeneration(
    payload: PayloadShape,
    latestPresent: boolean | null,
    latestDtimeValue: bigint | null,
  ): Record<string, unknown> {
    const generation = { ...(payload.generation ?? {}) };
    if (latestPresent === true) {
      generation.dtime = latestDtimeValue === null ? null : Number(latestDtimeValue);
    }
    return generation;
  }

  return {
    async selectEventsAfter(net, afterId, limit) {
      const rows = await sql<{ id: bigint; block_height: bigint; raw: Uint8Array }[]>`
        SELECT id, block_height, raw
        FROM ${table}
        WHERE net = ${net} AND id > ${afterId}
        ORDER BY id
        LIMIT ${limit}
      `;
      return rows.map((row) => ({ id: row.id, blockHeight: row.block_height, raw: row.raw }));
    },

    async selectDustParametersAtOrBelow(net, atHeight) {
      // One index scan over `dust_parameters_at_or_below (net, block_height DESC)`. The height
      // bound is a separate branch rather than a synthetic upper bound so the planner sees a plain
      // range scan either way -- and so that "no height given" cannot accidentally become
      // "height 0".
      const rows = atHeight === undefined
        ? await sql<DustParametersSqlRow[]>`
            SELECT block_height, night_dust_ratio, generation_decay_rate,
                   dust_grace_period_seconds, reason
            FROM ${parametersTable}
            WHERE net = ${net}
            ORDER BY block_height DESC
            LIMIT 1
          `
        : await sql<DustParametersSqlRow[]>`
            SELECT block_height, night_dust_ratio, generation_decay_rate,
                   dust_grace_period_seconds, reason
            FROM ${parametersTable}
            WHERE net = ${net} AND block_height <= ${atHeight}
            ORDER BY block_height DESC
            LIMIT 1
          `;
      const row = rows[0];
      return row === undefined ? undefined : {
        blockHeight: row.block_height,
        // `numeric` arrives as a string from this driver, which is the representation this
        // interface wants all the way to the wire; `String()` is belt to that braces.
        nightDustRatio: String(row.night_dust_ratio),
        generationDecayRate: String(row.generation_decay_rate),
        dustGracePeriodSeconds: String(row.dust_grace_period_seconds),
        reason: String(row.reason),
      };
    },

    async selectTableTip(net) {
      // `ORDER BY id DESC LIMIT 1` over the primary key `(net, id)`, not `max(id)` plus a second
      // read for its height: one index scan answers both, and the two could otherwise disagree
      // with a concurrent insert between them.
      const rows = await sql<{ id: bigint; block_height: bigint }[]>`
        SELECT id, block_height
        FROM ${table}
        WHERE net = ${net}
        ORDER BY id DESC
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined ? undefined : { eventId: row.id, height: row.block_height };
    },

    async selectInitialUtxosByOwner(net, owner, afterId, limit) {
      const rows = await sql<
        {
          id: bigint;
          block_height: bigint;
          tx_hash: Uint8Array;
          generation_index: bigint;
          payload: PayloadShape;
          dtime: bigint | null;
          present: boolean | null;
        }[]
      >`
        SELECT e.id, e.block_height, e.tx_hash, e.generation_index, e.payload,
               latest.dtime, latest.present
        FROM ${table} e
        ${latestDtime}
        WHERE e.net = ${net} AND e.kind = 1 AND e.owner = ${owner}::numeric AND e.id > ${afterId}
        ORDER BY e.id
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        id: row.id,
        blockHeight: row.block_height,
        txHash: row.tx_hash,
        generationIndex: row.generation_index,
        output: row.payload.output ?? {},
        generation: mergedGeneration(row.payload, row.present, row.dtime),
      }));
    },

    async selectGenerationByOwner(net, owner, afterIndex, limit) {
      // The generation ENTRY is created by the kind-1 event, which is the only row carrying the
      // owner (migration 009 deliberately leaves kind 2 without one, so the same fact has one
      // home). So this reads kind-1 rows and merges the latest kind-2 end time onto them, exactly
      // as `initial-utxos` does — paged by index rather than by id, because that is the order the
      // client walks the generating tree in.
      const rows = await sql<
        {
          generation_index: bigint;
          payload: PayloadShape;
          dtime: bigint | null;
          present: boolean | null;
        }[]
      >`
        SELECT e.generation_index, e.payload, latest.dtime, latest.present
        FROM ${table} e
        ${latestDtime}
        WHERE e.net = ${net} AND e.kind = 1 AND e.owner = ${owner}::numeric
          AND e.generation_index > ${afterIndex}
        ORDER BY e.generation_index
        LIMIT ${limit}
      `;
      return rows.map((row) => {
        const generation = mergedGeneration(row.payload, row.present, row.dtime);
        return {
          generationIndex: row.generation_index,
          value: String(generation.value ?? "0"),
          owner: String(generation.owner ?? "0"),
          nonce: String(generation.nonce ?? ""),
          dtime: generation.dtime === undefined || generation.dtime === null ? null : Number(generation.dtime),
        };
      });
    },

    async selectSpendsByNullifiers(net, nullifiers) {
      // ONE indexed probe over the whole batch (FR-015), served by
      // `dust_events_nullifier_idx (net, nullifier) WHERE kind = 3`. The values are bound as a
      // single array parameter: they are never interpolated, never logged and never kept.
      const rows = await sql<
        {
          id: bigint;
          block_height: bigint;
          tx_hash: Uint8Array;
          nullifier: string;
          commitment: string;
          commitment_index: bigint;
          v_fee: string;
          declared_time: bigint;
          block_time: bigint;
        }[]
      >`
        SELECT id, block_height, tx_hash, nullifier, commitment, commitment_index,
               v_fee, declared_time, block_time
        FROM ${table}
        WHERE net = ${net} AND kind = 3 AND nullifier = ANY(${[...nullifiers]}::numeric[])
      `;
      return rows.map((row) => ({
        id: row.id,
        blockHeight: row.block_height,
        txHash: row.tx_hash,
        nullifier: row.nullifier,
        commitment: row.commitment,
        commitmentIndex: row.commitment_index,
        vFee: row.v_fee,
        declaredTime: row.declared_time,
        blockTime: row.block_time,
      }));
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
