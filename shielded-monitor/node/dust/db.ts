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
 * and `SELECT` on `dust_events` and `blocks` — nothing else, and nothing at all in
 * `shielded_monitor`. `dust-reader-role.integration.test.ts` runs every query below as exactly
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
 * What the start-up parameter check (D2.6) could learn.
 *
 * `unavailable` is the ORDINARY answer under the role spec §5.3 defines: it grants `SELECT` on
 * `dust_events` and `blocks` and nothing else, while a replay checkpoint's serialized ledger
 * state lives in `replay_checkpoints` joined to `chain_blobs`. The check is therefore best-effort
 * by construction — see `index.ts` and question Q-15.
 */
export type DustCheckpointProbe =
  | { readonly status: "ok"; readonly state: Uint8Array; readonly height: bigint; readonly ledgerVersion: string }
  | { readonly status: "none" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface DustDb {
  /** The events after `afterId`, ascending, at most `limit` of them. */
  selectEventsAfter(net: string, afterId: bigint, limit: number): Promise<DustRawEvent[]>;
  /** The newest replay checkpoint's serialized ledger state, when this role may read it. */
  selectLatestCheckpoint(net: string): Promise<DustCheckpointProbe>;
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

    async selectLatestCheckpoint(net) {
      try {
        const rows = await sql<{ block_height: bigint; ledger_version: string; data: Uint8Array }[]>`
          SELECT rc.block_height, rc.ledger_version, blob.data
          FROM ${sql(`${schema}.replay_checkpoints`)} rc
          JOIN ${sql(`${schema}.chain_blobs`)} blob ON blob.hash = rc.state_blob_hash
          WHERE rc.net = ${net}
          ORDER BY rc.block_height DESC
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) return { status: "none" as const };
        return {
          status: "ok" as const,
          state: row.data,
          height: row.block_height,
          ledgerVersion: row.ledger_version,
        };
      } catch (err) {
        // The CODE, never the driver's message: this is the one query in the module that can be
        // refused for an ordinary, expected reason (`42501 insufficient_privilege` under the
        // minimal reader role), and a refusal must read as a fact rather than as an incident.
        const code = (err as { code?: string }).code;
        return { status: "unavailable" as const, reason: code ?? "unknown" };
      }
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
