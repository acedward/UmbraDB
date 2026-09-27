import type { ISql } from "postgres";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { DEFAULT_RETRY_BACKOFF, type InterfaceConfig, type RetryBackoff } from "../config.js";
import { IndexerStateSource } from "./level2.js";
import {
  jsonbSafe, textSafe, verifyPublication, type CheckTrigger, type PublicationToVerify, type VerificationResult, type VerifierDeps,
} from "./verify.js";

/**
 * Project 00024-02 task C7 — the VERIFICATION DRAIN: public-interface publications are verified by a
 * loop of `serve`, OUTSIDE the scan's database transaction (spec FR-011): the scan only stores a
 * publication `pending` and due (`store.ts`); this loop fetches, verifies and writes the result in
 * its own short transaction. A slow host or a long Level 3 never holds the scanner.
 *
 * ── What is due ─────────────────────────────────────────────────────────────────────────────
 *  - a publication never checked (`initial`) — every publication gets its one check, the current
 *    one first;
 *  - a publication marked `stale` by a maintenance update (`stale`; FR-012);
 *  - the CURRENT publication again after `TOKEN_INTERFACE_RECHECK_MS` (default 24 h) (`recheck`;
 *    FR-011b), or sooner after a check that reached no conclusion — a host that did not deliver
 *    (`unreachable`, owner Q25), a limit (`unchecked`, US1 scenario 6) or a refused destination
 *    (`unfetchable`) — with EXPONENTIAL backoff (`retry`; {@link retryBackoffMs}). A retry is a whole
 *    new verification, so a host that delivers again is verified from Level 1;
 *  - on demand, `token-indexer verify-interfaces --address <hex>` (`on_demand`).
 * A historical publication is not re-checked: it keeps its own last result (FR-010).
 *
 * ── A result is written only if nothing invalidated it meanwhile ─────────────────────────────
 * Each row has a `generation`, bumped by a maintenance update (`markInterfaceStale`). The drain
 * reads it before verifying and writes the result only if it is unchanged (the row is locked
 * `FOR UPDATE` for the write); otherwise the result is DISCARDED and the row, still due, is checked
 * again — a check that read the old keys can never overwrite a `stale`.
 * Checks of one publication may also overlap (the `serve` drain and `verify-interfaces --address`
 * run in different processes). A result is SUPERSEDED — not written — when the row already holds
 * the result of a check that STARTED later (`checked_at` is a check's start): the newer observation
 * stands, so a long Level 3 that began before the host was breached can never overwrite the failure
 * a later check stored, move `checked_at` back or clear `verified_until` (audit 02 E2-F2).
 *
 * ── "Verified until" (FR-011b) ────────────────────────────────────────────────────────────────
 * `last_verified_at` is the last check that returned `verified`. When a later check does not, the
 * row keeps that time as `verified_until` — the time the earlier result held — and the new result is
 * the current one: nothing rolls back to an older publication (Q14). Every result is also appended
 * to `public_interface_checks`.
 *
 * ── One publication never holds up the others (audit 02 E2-F1) ────────────────────────────────
 * Every text written is made safe for `text` / `jsonb` first ({@link textSafe}); and if storing a
 * result still fails (a value the database refuses), an `unchecked` internal-error result is stored
 * in its place, so the row moves on to its backoff and the rest of the queue is checked in the same
 * pass. Only a failure of that write too — the database itself — stops the pass (the `serve` loop
 * logs it and tries again).
 */

/** The statuses that reached no conclusion and are retried with backoff (`attempts` counts them). */
export const RETRIED_STATUSES: ReadonlySet<string> = new Set(["unreachable", "unchecked", "unfetchable"]);

/**
 * The delay before the `attempts`-th consecutive retry (owner decision Q25: "exponential fallback"):
 * `baseMs · 2^(attempts − 1)` — with the defaults 30 s, 60 s, 120 s … — capped at `capMs` (default
 * 1 h; `TOKEN_INTERFACE_RETRY_BASE_MS` / `TOKEN_INTERFACE_RETRY_CAP_MS`) and never beyond the
 * re-check interval. Any attempt count gives a finite delay (2^n overflows to Infinity, the cap wins).
 */
export function retryBackoffMs(attempts: number, recheckMs: number, backoff: RetryBackoff = DEFAULT_RETRY_BACKOFF): number {
  return Math.min(backoff.baseMs * 2 ** Math.max(0, attempts - 1), backoff.capMs, recheckMs);
}

export interface DrainDeps extends VerifierDeps {
  /** The re-check interval of a current publication (FR-011b). */
  recheckMs: number;
  /** The retry backoff (owner Q25). Default {@link DEFAULT_RETRY_BACKOFF}: 30 s doubling to 1 h. */
  retryBackoff?: RetryBackoff;
  /** Test seam: the clock. */
  now?: () => Date;
}

/** The verifier's dependencies from the configuration (`serve`, `verify-interfaces`). */
export function drainDepsFromConfig(interfaces: InterfaceConfig, indexerHttp: string): DrainDeps {
  return {
    stateSource: new IndexerStateSource({ url: indexerHttp }),
    fetchPolicy: { allowPrivateHosts: interfaces.allowPrivateHosts, deadlineMs: interfaces.fetchDeadlineMs },
    limits: interfaces.limits,
    level3: { enabled: interfaces.level3.enabled, compactBin: interfaces.level3.compactBin, deadlineMs: interfaces.level3.deadlineMs },
    recheckMs: interfaces.recheckMs,
    retryBackoff: interfaces.retry,
  };
}

interface DueRow {
  event_id: string;
  part_event_ids: string[];
  address: Buffer;
  tx_hash: Buffer;
  block_height: string;
  tx_position: number;
  segment: number;
  parts: number;
  phase: string;
  commitment: Buffer;
  url: string | null;
  url_error: string | null;
  status: string;
  checks: number;
  generation: number;
  is_current: boolean;
}

const COLUMNS = (sql: ISql) => sql`
  e.event_id::text, e.part_event_ids::text[] AS part_event_ids, e.address, e.tx_hash, e.block_height::text,
  e.tx_position, e.segment, e.parts, e.phase, e.commitment, e.url, e.url_error, e.status, e.checks, e.generation,
  (pi.event_id IS NOT NULL) AS is_current
`;

const toVerify = (row: DueRow): PublicationToVerify => ({
  eventId: Number(row.event_id), partEventIds: row.part_event_ids.map(Number), address: row.address.toString("hex"),
  txHash: row.tx_hash.toString("hex"), blockHeight: Number(row.block_height), txPosition: row.tx_position,
  segment: row.segment, parts: row.parts, phase: row.phase, commitment: row.commitment, url: row.url, urlError: row.url_error,
});

function triggerOf(row: DueRow): CheckTrigger {
  if (row.status === "stale") return "stale";
  if (row.checks === 0) return "initial";
  if (RETRIED_STATUSES.has(row.status)) return "retry";
  return "recheck";
}

/** A verification that threw (a bug, or a provider error of an unexpected kind): recorded as
 *  `unchecked` with the error, retried with backoff — never a verdict on the bundle, never a stall. */
function internalError(error: unknown): VerificationResult {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    status: "unchecked", level: 0, l1: "not_run", l2: "not_run", l3: "not_run", l3Reason: null,
    reason: `the verification could not be completed (internal error: ${message.slice(0, 500)})`, failedLevel: null,
    report: jsonbSafe({ record: "internal error", error: message.slice(0, 2000) }), circuits: [], state: null,
  };
}

/** `discarded`: the generation moved (a maintenance update); `superseded`: a check that started
 *  later has already stored its result. Neither is written or recorded in the history. */
export type WriteOutcome = "written" | "discarded" | "superseded";

/** Writes one result under the generation guard, with its history row and the next check time: the
 *  re-check interval after a conclusion (verified / failed), the retry backoff after none. */
export async function writeCheckResult(
  sql: UmbraDBSql, schema: string, net: string,
  target: { eventId: number; generation: number }, trigger: CheckTrigger, result: VerificationResult,
  checkedAt: Date, schedule: Pick<DrainDeps, "recheckMs" | "retryBackoff">,
): Promise<WriteOutcome> {
  return sql.begin(async (tx) => {
    const locked = await tx<{ generation: number; checks: number; attempts: number; checked_at: Date | null; is_current: boolean }[]>`
      SELECT e.generation, e.checks, e.attempts, e.checked_at, (pi.event_id IS NOT NULL) AS is_current
      FROM ${tx(schema)}.public_interface_events e
      LEFT JOIN ${tx(schema)}.public_interfaces pi ON pi.net = e.net AND pi.event_id = e.event_id
      WHERE e.net = ${net} AND e.event_id = ${target.eventId}
      FOR UPDATE OF e
    `;
    const row = locked[0];
    if (row === undefined || row.generation !== target.generation) return "discarded";
    if (row.checked_at !== null && row.checked_at.getTime() > checkedAt.getTime()) return "superseded";
    const retried = RETRIED_STATUSES.has(result.status);
    const attempts = retried ? row.attempts + 1 : 0;
    const nextMs = !row.is_current ? null
      : retried ? retryBackoffMs(attempts, schedule.recheckMs, schedule.retryBackoff) : schedule.recheckMs;
    const next = nextMs === null ? null : new Date(checkedAt.getTime() + nextMs);
    const verified = result.status === "verified";
    await tx`
      UPDATE ${tx(schema)}.public_interface_events SET
        status = ${result.status}, level = ${result.level}, l1 = ${result.l1}, l2 = ${result.l2}, l3 = ${result.l3},
        l3_reason = ${textSafe(result.l3Reason)}, reason = ${textSafe(result.reason)}, failed_level = ${result.failedLevel},
        report = ${tx.json(result.report as never)}, circuits = ${tx.json(result.circuits as never)},
        state_block_height = ${result.state?.blockHeight ?? null},
        state_tx_hash = ${result.state?.txHash === null || result.state?.txHash === undefined ? null : Buffer.from(result.state.txHash, "hex")},
        checked_at = ${checkedAt}, checks = checks + 1, attempts = ${attempts}, next_check_at = ${next},
        verified_until = CASE WHEN ${verified} THEN NULL ELSE last_verified_at END,
        last_verified_at = CASE WHEN ${verified} THEN ${checkedAt}::timestamptz ELSE last_verified_at END
      WHERE net = ${net} AND event_id = ${target.eventId}
    `;
    await tx`
      INSERT INTO ${tx(schema)}.public_interface_checks
        (net, event_id, check_no, checked_at, trigger, status, level, l1, l2, l3, l3_reason, reason, state_block_height)
      VALUES (${net}, ${target.eventId}, ${row.checks + 1}, ${checkedAt}, ${trigger}, ${result.status}, ${result.level},
              ${result.l1}, ${result.l2}, ${result.l3}, ${textSafe(result.l3Reason)}, ${textSafe(result.reason)}, ${result.state?.blockHeight ?? null})
    `;
    return "written";
  }) as Promise<WriteOutcome>;
}

async function checkRow(sql: UmbraDBSql, schema: string, net: string, row: DueRow, trigger: CheckTrigger, deps: DrainDeps): Promise<{ write: WriteOutcome; result: VerificationResult }> {
  const checkedAt = deps.now?.() ?? new Date();
  let result: VerificationResult;
  try {
    result = await verifyPublication(net, toVerify(row), deps, trigger, checkedAt);
  } catch (error) {
    result = internalError(error);
  }
  const target = { eventId: Number(row.event_id), generation: row.generation };
  try {
    return { write: await writeCheckResult(sql, schema, net, target, trigger, result, checkedAt, deps), result };
  } catch (error) {
    // The database refused this result (E2-F1): store an internal-error result instead, so this row
    // moves on to its backoff and the others are still checked. If that fails too, it propagates.
    const fallback = internalError(new Error(`the result could not be stored: ${error instanceof Error ? error.message : String(error)}`));
    return { write: await writeCheckResult(sql, schema, net, target, trigger, fallback, checkedAt, deps), result: fallback };
  }
}

export interface InterfaceDrainOutcome {
  attempted: number;
  verified: number;
  failed: number;
  unchecked: number;
  unfetchable: number;
  /** The host did not deliver (owner Q25). */
  unreachable: number;
  /** Results dropped because the publication was invalidated while it was being checked, or
   *  because a check that started later had already stored its result (`superseded`). */
  discarded: number;
}

/** Verifies every due publication (at most `limit`), current publications first. */
export async function drainInterfaceVerifications(
  sql: UmbraDBSql, schema: string, net: string, deps: DrainDeps, opts: { limit?: number } = {},
): Promise<InterfaceDrainOutcome> {
  const now = deps.now?.() ?? new Date();
  const due = await sql<DueRow[]>`
    SELECT ${COLUMNS(sql)}
    FROM ${sql(schema)}.public_interface_events e
    LEFT JOIN ${sql(schema)}.public_interfaces pi ON pi.net = e.net AND pi.event_id = e.event_id
    WHERE e.net = ${net} AND e.next_check_at IS NOT NULL AND e.next_check_at <= ${now}
    ORDER BY (pi.event_id IS NULL), e.next_check_at, e.event_id
    LIMIT ${opts.limit ?? 10}
  `;
  const outcome: InterfaceDrainOutcome = { attempted: 0, verified: 0, failed: 0, unchecked: 0, unfetchable: 0, unreachable: 0, discarded: 0 };
  for (const row of due) {
    outcome.attempted++;
    const { write, result } = await checkRow(sql, schema, net, row, triggerOf(row), deps);
    if (write !== "written") { outcome.discarded++; continue; }
    outcome[result.status]++;
  }
  return outcome;
}

/**
 * `verify-interfaces --address <hex>` (FR-011b "and on demand"): checks the contract's CURRENT
 * publication now, whatever its schedule, and returns what was stored — or `undefined` when the
 * contract has never published an interface.
 */
export async function verifyInterfaceNow(
  sql: UmbraDBSql, schema: string, net: string, address: string, deps: DrainDeps,
): Promise<{ eventId: number; write: WriteOutcome; result: VerificationResult } | undefined> {
  const rows = await sql<DueRow[]>`
    SELECT ${COLUMNS(sql)}
    FROM ${sql(schema)}.public_interfaces pi
    JOIN ${sql(schema)}.public_interface_events e ON e.net = pi.net AND e.event_id = pi.event_id
    WHERE pi.net = ${net} AND pi.address = ${Buffer.from(address, "hex")}
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  const { write, result } = await checkRow(sql, schema, net, row, "on_demand", deps);
  return { eventId: Number(row.event_id), write, result };
}
