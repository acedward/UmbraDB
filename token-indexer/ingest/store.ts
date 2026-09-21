import type { ISql } from "postgres";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import type { TokenIndexerConfig } from "../config.js";

/**
 * Project 00020 — every read and write of `token_index.*` that is not a single route's own query.
 * Kept in one module so the scanner, the event lookup, the fold and the API agree on the shapes
 * and on the cursor convention, exactly as `evm-rpc/logs/store.ts` does for Part C.
 *
 * `ISql` rather than `UmbraDBSql` on the write helpers: every one of them is called BOTH standalone
 * and inside a `sql.begin(tx => …)` block, and `tx` is an `ISql`. That is what lets the scanner
 * write rows, events and the cursor in one database transaction (spec FR-014).
 */

/** The scanner's position in the archive. `position` is the transaction's index within its block,
 *  so a batch can stop in the middle of a block and resume exactly there. */
export interface DecodeCursor {
  height: number;
  position: number;
}

export const DECODE_CURSOR_KIND = "decode";

/** The cursor of a net that has never scanned anything: before block 0, transaction 0. */
export const CURSOR_ZERO: DecodeCursor = { height: 0, position: -1 };

export async function readDecodeCursor(
  sql: ISql, schema: string, net: string,
): Promise<DecodeCursor> {
  const rows = await sql<{ value: DecodeCursor }[]>`
    SELECT value FROM ${sql(schema)}.cursors WHERE net = ${net} AND kind = ${DECODE_CURSOR_KIND}
  `;
  const value = rows[0]?.value;
  if (value === undefined) return { ...CURSOR_ZERO };
  return { height: Number(value.height), position: Number(value.position) };
}

/** Last write wins — the scanner only ever moves forward, and it writes the cursor in the same
 *  transaction as the rows that justified it. */
export async function writeDecodeCursor(
  sql: ISql, schema: string, net: string, cursor: DecodeCursor,
): Promise<void> {
  await sql`
    INSERT INTO ${sql(schema)}.cursors (net, kind, value, updated_at)
    VALUES (${net}, ${DECODE_CURSOR_KIND}, ${sql.json({ height: cursor.height, position: cursor.position })}, now())
    ON CONFLICT (net, kind) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

export interface PendingLookupRow {
  txHash: string;
  address: string;
  blockHeight: number;
  expected: number;
  got: number;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
}

export interface TokenIndexStatus {
  net: string;
  archiveTip: number | null;
  decodeCursor: DecodeCursor;
  contracts: number;
  tokens: number;
  pendingLookups: PendingLookupRow[];
  counters: {
    mints: number;
    eventsApplied: number;
    eventsRejected: number;
    lookupsOk: number;
    lookupsShort: number;
    /** Project 00023, FR-013 — the five activity counters. Every one is a COUNT over the stored
     *  rows rather than an in-memory tally, so a restart does not reset them and `rebuild` makes
     *  them agree with a live run by construction. */
    activityRows: number;
    /** Rows of status `seen`: colours public data proves exist whose issuer is not knowable (US5).
     *  SC-009 is that this equals the number of distinct unresolved colours in `token_activity`. */
    seenTokens: number;
    shieldedOffers: number;
    /** …of which the colour is NOT public, because the offer is balanced (spec §0, FR-018). */
    undisclosedShieldedOffers: number;
    contractCalls: number;
  };
}

/**
 * `GET /internal/status` and `token-indexer status` (spec §5, FR-009).
 *
 * `archiveTip` is read from the archive itself — the highest canonical block height this net has —
 * so "is the decoder keeping up with the chain" is answerable from one call. It is `null` when the
 * archive schema has no rows yet (or does not exist), which is a legitimate cold state, not an
 * error.
 *
 * `lookupsOk` / `lookupsShort` are DERIVED, not counted in memory: `lookupsShort` is the number of
 * `(transaction, contract)` pairs still waiting in `pending_event_lookups`, and `lookupsOk` the
 * number of distinct pairs that produced at least one stored event. A restart therefore does not
 * reset them, which is what makes the number useful on a long-running `serve`.
 */
export async function readStatus(
  sql: UmbraDBSql, config: TokenIndexerConfig,
): Promise<TokenIndexStatus> {
  const { schema, archiveSchema, net } = config;
  const [cursor, archiveTip, counts, pending] = await Promise.all([
    readDecodeCursor(sql, schema, net),
    readArchiveTip(sql, archiveSchema, net),
    sql<{
      contracts: string; tokens: string; mints: string;
      events_applied: string; events_rejected: string; lookups_ok: string;
      activity_rows: string; seen_tokens: string; shielded_offers: string;
      undisclosed_shielded_offers: string; contract_calls: string;
    }[]>`
      SELECT
        (SELECT count(*) FROM ${sql(schema)}.contracts WHERE net = ${net})                       AS contracts,
        (SELECT count(*) FROM ${sql(schema)}.tokens    WHERE net = ${net})                       AS tokens,
        (SELECT count(*) FROM ${sql(schema)}.token_mints WHERE net = ${net})                     AS mints,
        (SELECT count(*) FROM ${sql(schema)}.token_metadata_events WHERE net = ${net} AND applied)     AS events_applied,
        (SELECT count(*) FROM ${sql(schema)}.token_metadata_events WHERE net = ${net} AND NOT applied) AS events_rejected,
        (SELECT count(*) FROM (
           SELECT 1 FROM ${sql(schema)}.token_metadata_events WHERE net = ${net}
           GROUP BY tx_hash, address
         ) pairs)                                                                                AS lookups_ok,
        (SELECT count(*) FROM ${sql(schema)}.token_activity  WHERE net = ${net})                 AS activity_rows,
        (SELECT count(*) FROM ${sql(schema)}.tokens WHERE net = ${net} AND status = 'seen')       AS seen_tokens,
        (SELECT count(*) FROM ${sql(schema)}.shielded_offers WHERE net = ${net})                 AS shielded_offers,
        (SELECT count(*) FROM ${sql(schema)}.shielded_offers WHERE net = ${net} AND undisclosed) AS undisclosed_shielded_offers,
        (SELECT count(*) FROM ${sql(schema)}.contract_calls  WHERE net = ${net})                 AS contract_calls
    `,
    readPendingLookups(sql, schema, net, 50),
  ]);
  const row = counts[0]!;
  return {
    net,
    archiveTip,
    decodeCursor: cursor,
    contracts: Number(row.contracts),
    tokens: Number(row.tokens),
    pendingLookups: pending,
    counters: {
      mints: Number(row.mints),
      eventsApplied: Number(row.events_applied),
      eventsRejected: Number(row.events_rejected),
      lookupsOk: Number(row.lookups_ok),
      lookupsShort: pending.length,
      activityRows: Number(row.activity_rows),
      seenTokens: Number(row.seen_tokens),
      shieldedOffers: Number(row.shielded_offers),
      undisclosedShieldedOffers: Number(row.undisclosed_shielded_offers),
      contractCalls: Number(row.contract_calls),
    },
  };
}

/** The highest canonical archived height for this net, or `null` when the archive is empty or
 *  absent. `to_regclass` returns NULL rather than raising for a missing relation, so a token API
 *  pointed at a database whose archive has not been bootstrapped yet still answers. */
export async function readArchiveTip(
  sql: ISql, archiveSchema: string, net: string,
): Promise<number | null> {
  const exists = await sql<{ present: boolean }[]>`
    SELECT to_regclass(${`${archiveSchema}.blocks`}) IS NOT NULL AS present
  `;
  if (exists[0]?.present !== true) return null;
  const rows = await sql<{ tip: string | null }[]>`
    SELECT max(height)::text AS tip FROM ${sql(archiveSchema)}.blocks
    WHERE net = ${net} AND is_canonical
  `;
  const tip = rows[0]?.tip;
  return tip === null || tip === undefined ? null : Number(tip);
}

export async function readPendingLookups(
  sql: ISql, schema: string, net: string, limit: number,
): Promise<PendingLookupRow[]> {
  const rows = await sql<{
    tx_hash: Buffer; address: Buffer; block_height: string; expected_events: number;
    got_events: number; attempts: number; next_attempt_at: Date; last_error: string | null;
  }[]>`
    SELECT tx_hash, address, block_height, expected_events, got_events, attempts, next_attempt_at, last_error
    FROM ${sql(schema)}.pending_event_lookups
    WHERE net = ${net}
    ORDER BY block_height, tx_hash
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    txHash: r.tx_hash.toString("hex"),
    address: r.address.toString("hex"),
    blockHeight: Number(r.block_height),
    expected: r.expected_events,
    got: r.got_events,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at.toISOString(),
    lastError: r.last_error,
  }));
}
