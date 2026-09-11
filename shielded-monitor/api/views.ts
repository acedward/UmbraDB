import type { MatchDetails } from "../match-details.js";
import type { AssociationRecord, MonitorCoverage, MonitorRecord } from "../store.js";
import { encodeCursor } from "./cursor.js";

/**
 * The wire shapes of the private API (organizer spec FR-017, FR-019, FR-020).
 *
 * Two rules govern every field below.
 *
 * **Heights are decimal strings, never JSON numbers.** Block heights, protocol versions and
 * association sequences are `bigint` throughout this repository (`src/postgres/client.ts`
 * configures `types.bigint` on the connection). JSON numbers are IEEE-754 doubles, so a value
 * above 2^53 rounds silently — a corruption that appears only on a long-lived chain and only in
 * the high bits, which is the worst possible time and place to discover it. A string cannot
 * round, and every consumer language can parse one into its own big integer.
 *
 * **Nothing derived from key material is ever present.** The monitor view carries no viewing key
 * and no fingerprint; `MonitorRecord` (00009-02) already excludes both by construction, and this
 * module builds views by naming fields explicitly rather than by spreading a record, so a future
 * field added to the store cannot reach the wire by accident.
 */

/** Coverage as four block heights (organizer spec FR-011). `null` means *not known*, which for
 *  `scannedFrom`/`scannedThrough` means "not scanned yet" and for `sourceTip` means "this
 *  deployment cannot observe the archive" (organizer question Q14). It never means zero. */
export interface CoverageView {
  readonly requestedStart: string;
  readonly scannedFrom: string | null;
  readonly scannedThrough: string | null;
  readonly sourceTip: string | null;
}

/** A monitor as a consumer sees it. */
export interface MonitorView {
  readonly monitorId: string;
  readonly net: string;
  readonly state: string;
  readonly coverage: CoverageView;
  readonly matchingRuleVersion: string;
  readonly ledgerBuild: string;
  /** Present only for `failed`/`stale_source`. Carries the failure CLASS and a non-secret
   *  message written by this repository — never a driver message and never caller input
   *  (organizer sub-plan: "failed/stale → status carries `lastError` class only"). */
  readonly lastError?: { readonly code: string; readonly atHeight?: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One relevant transaction observation (organizer spec FR-009). */
export interface MatchView {
  readonly cursor: string;
  readonly blockHeight: string;
  readonly blockHash: string;
  readonly position: number;
  readonly txHash: string;
  readonly protocolVersion: string;
  readonly matchedSegments: readonly number[];
  /** Always `"unknown"` in this project (organizer spec FR-009, assumption "applied outcomes are
   *  unknown"). Present as a literal rather than omitted, because a consumer must be able to see
   *  that the service is *not* claiming the transaction applied. */
  readonly appliedOutcome: "unknown";
  /** The archive's own replay verdict, when the archive recorded one. Advisory: it is the
   *  ARCHIVE's outcome for the transaction, not this monitor's, and it never replaces
   *  `appliedOutcome`. */
  readonly sourceOutcome?: string;
  readonly matchingRuleVersion: string;
  readonly ledgerBuild: string;
  /** The time of the block this observation sits in, in milliseconds since the epoch, as a
   *  decimal STRING for the same reason every height is one. `null` means the value is not
   *  recorded — a match written before 00009-07 that the backfill has not visited, or a block the
   *  archive itself has no timestamp for. Never a zero, and never "now".
   *
   *  Absent entirely (not `null`) when the caller asked for `?details=0`. */
  readonly blockTimestampMs?: string | null;
  /** The transaction's PUBLIC zswap data: output commitments, input nullifiers, transients,
   *  contract addresses and a three-valued "is this one yours" per entry
   *  (`shielded-monitor/match-details.ts`). `null` means "not recorded yet — run the backfill",
   *  never "this transaction had no outputs".
   *
   *  Absent entirely (not `null`) when the caller asked for `?details=0`. */
  readonly details?: MatchDetails | null;
}

/** A page of matches (organizer spec FR-019, FR-020). `coverage` travels with every page so a
 *  consumer can never read an empty `items` without also seeing how far the scan actually got. */
export interface MatchPageView {
  readonly items: readonly MatchView[];
  readonly nextCursor: string;
  readonly coverage: CoverageView;
}

function heightOrNull(value: bigint | undefined): string | null {
  return value === undefined ? null : value.toString(10);
}

export function coverageView(coverage: MonitorCoverage, sourceTip: bigint | undefined): CoverageView {
  return {
    requestedStart: coverage.requestedStart.toString(10),
    scannedFrom: heightOrNull(coverage.scannedFrom),
    scannedThrough: heightOrNull(coverage.scannedThrough),
    sourceTip: heightOrNull(sourceTip),
  };
}

export function monitorView(record: MonitorRecord, sourceTip: bigint | undefined): MonitorView {
  return {
    monitorId: record.id,
    net: record.net,
    state: record.state,
    coverage: coverageView(record.coverage, sourceTip),
    matchingRuleVersion: record.matchingRuleVersion,
    ledgerBuild: record.ledgerBuild,
    // Only the CLASS and the position reach the wire. `MonitorLastError.message` is written by
    // this repository and is not secret, but it is also not part of the contract, and the one
    // thing a consumer can act on is the code.
    ...(record.lastError !== undefined
      ? {
          lastError: {
            code: record.lastError.code,
            ...(record.lastError.atHeight !== undefined ? { atHeight: record.lastError.atHeight } : {}),
          },
        }
      : {}),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Options for {@link matchView}. */
export interface MatchViewOptions {
  /** `false` reproduces the pre-00009-07 item exactly: no `blockTimestampMs`, no `details`. That
   *  is what `?details=0` asks for — "give me the small shape" — so both fields go, not just the
   *  large one; a consumer that wants one of them is asking for the feature. */
  readonly details?: boolean;
}

export function matchView(
  monitorId: string, record: AssociationRecord, options: MatchViewOptions = {},
): MatchView {
  const withDetails = options.details !== false;
  return {
    cursor: encodeCursor(monitorId, record.seq),
    blockHeight: record.blockHeight.toString(10),
    blockHash: record.blockHash.toString("hex"),
    position: record.position,
    txHash: record.txHash.toString("hex"),
    protocolVersion: record.protocolVersion.toString(10),
    matchedSegments: [...record.matchedSegments],
    appliedOutcome: "unknown",
    ...(record.sourceOutcome !== undefined ? { sourceOutcome: record.sourceOutcome } : {}),
    matchingRuleVersion: record.matchingRuleVersion,
    ledgerBuild: record.ledgerBuild,
    ...(withDetails
      ? {
          // `null`, explicitly, rather than an omitted field: a consumer must be able to tell
          // "this deployment does not send details" from "this match has none recorded yet", and
          // an absent key cannot express the second.
          blockTimestampMs: record.blockTimestampMs === undefined
            ? null
            : record.blockTimestampMs.toString(10),
          details: record.details ?? null,
        }
      : {}),
  };
}
