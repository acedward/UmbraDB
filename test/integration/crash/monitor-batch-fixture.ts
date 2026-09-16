import { createHash } from "node:crypto";
import type { BlockBundle, TransactionRecord } from "../../../src/interfaces/chain-archive-store.js";
import type { UmbraDBSql } from "../../../src/postgres/client.js";

/**
 * The world the Rule B crash suite scans, built identically in the parent test process and in
 * the crash worker child process (same discipline, same reason, as
 * `archive-bundle-fixture.ts`): a killed attempt and its unfaulted control must scan
 * BYTE-IDENTICAL input, or the control proves nothing about the killed run.
 *
 * Everything here is a pure function of its arguments plus the fixture corpus, so both processes
 * derive the same archive without exchanging it.
 */

export const CRASH_NET = "rule_b_scan";
export const GENESIS_PARENT_HASH = "0".repeat(64);

/** How many transactions height `h` carries, and which of them are relevant to the monitor's
 *  key. Deterministic in the height alone, so the child process can reproduce it. */
export interface HeightShape {
  height: number;
  /** Corpus transaction ids, in position order. */
  txIds: string[];
  /** Positions (indices into `txIds`) whose transaction is relevant to key `K`. */
  matchPositions: number[];
}

/**
 * The rotation of corpus transactions each height gets.
 *
 * Deliberately includes heights with ZERO matches and heights with TWO, because the two-state
 * claim has to hold for both: "no associations of H and coverage H−1" is indistinguishable from
 * "all of H and coverage H" when H has no matches unless coverage is checked, and that is
 * exactly the confusion the classifier must not make.
 */
const ROTATION: { txIds: string[]; matchPositions: number[] }[] = [
  { txIds: ["h1p0-guaranteed-to-K"], matchPositions: [0] },
  { txIds: ["h1p1-guaranteed-to-Kprime"], matchPositions: [] },
  {
    txIds: ["h1p0-guaranteed-to-K", "h3p0-fallible-segment-2-only-to-K"],
    matchPositions: [0, 1],
  },
  { txIds: [], matchPositions: [] },
  { txIds: ["h4p2-system-transaction", "h1p0-guaranteed-to-K"], matchPositions: [1] },
  { txIds: ["h2p0-guaranteed-to-Kthird"], matchPositions: [] },
];

export function heightShape(height: number): HeightShape {
  const slot = ROTATION[height % ROTATION.length]!;
  return { height, txIds: slot.txIds, matchPositions: slot.matchPositions };
}

export function crashBlockHash(height: number): string {
  return createHash("sha256").update(`umbradb/rule-b-crash/block/${height}`).digest("hex");
}

export function crashTxHash(height: number, position: number): string {
  return createHash("sha256").update(`umbradb/rule-b-crash/tx/${height}/${position}`).digest("hex");
}

/** The bundle for one height, given the corpus's raw bytes by transaction id. */
export function crashHeightBundle(
  height: number,
  rawById: Map<string, Uint8Array>,
  protocolVersion: number,
): BlockBundle {
  const shape = heightShape(height);
  const blockHash = crashBlockHash(height);
  const transactions: TransactionRecord[] = shape.txIds.map((id, position) => {
    const rawBytes = rawById.get(id);
    if (rawBytes === undefined) throw new Error(`crash fixture names an unknown corpus transaction: ${id}`);
    return {
      net: CRASH_NET,
      txHash: crashTxHash(height, position),
      blockHeight: height,
      blockHash,
      position,
      kind: id.includes("system") ? ("system" as const) : ("regular" as const),
      protocolVersion,
      rawBytes,
    };
  });
  return {
    block: {
      net: CRASH_NET,
      blockHash,
      height,
      parentHash: height === 0 ? GENESIS_PARENT_HASH : crashBlockHash(height - 1),
      stateRoot: createHash("sha256").update(`rule-b-state/${height}`).digest("hex"),
      extrinsicsRoot: createHash("sha256").update(`rule-b-extrinsics/${height}`).digest("hex"),
      headerBytes: new TextEncoder().encode(`rule-b-header/${height}`),
      isCanonical: true,
      status: "canonical" as const,
      finalized: true,
      timestampMs: 1_754_395_200_000 + height * 6_000,
    },
    transactions,
    bridgeObservations: [],
    watermark: { key: `sync_cursor:${CRASH_NET}`, value: { height } },
    notifyChannel: "chain_archive_progress",
  };
}

// ── What is observable about ONE height, for ONE monitor ────────────────────────────────────

/**
 * Rule B's two-state claim, stated as data.
 *
 * `associationRows` counts the rows the monitor holds AT height `H`; `coverageThrough` is the
 * monitor's persisted `scanned_through_height`. Both are read from a connection that had nothing
 * to do with the write.
 */
export interface MonitorHeightObservation {
  associationRows: number;
  coverageThrough: number | undefined;
  state: string;
  epoch: bigint;
  /** Total associations across ALL heights, so a duplicate written somewhere else is visible. */
  totalAssociationRows: number;
  /** Of the rows AT height `H`, how many carry the 00009-07 `details` document, and how many
   *  carry the block time. Rule B says a height's data commits as ONE unit; details are part of
   *  that height's data, so an "all-of-height" state in which a match exists WITHOUT its details
   *  would mean the details were written outside the batch transaction — the exact shape the
   *  classifier must refuse rather than tolerate. */
  associationRowsWithDetails: number;
  associationRowsWithBlockTime: number;
}

export async function observeMonitorHeight(
  sql: UmbraDBSql, schema: string, monitorId: string, height: number,
): Promise<MonitorHeightObservation> {
  const [assoc] = await sql<{ n: number; d: number; t: number }[]>`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE details IS NOT NULL)::int AS d,
           count(*) FILTER (WHERE block_timestamp_ms IS NOT NULL)::int AS t
      FROM ${sql(schema)}.associations
     WHERE monitor_id = ${monitorId} AND block_height = ${height}
  `;
  const [total] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${sql(schema)}.associations WHERE monitor_id = ${monitorId}
  `;
  const [monitor] = await sql<
    { scanned_through_height: bigint | null; state: string; epoch: bigint }[]
  >`
    SELECT scanned_through_height, state, epoch FROM ${sql(schema)}.monitors WHERE id = ${monitorId}
  `;
  return {
    associationRows: assoc?.n ?? 0,
    associationRowsWithDetails: assoc?.d ?? 0,
    associationRowsWithBlockTime: assoc?.t ?? 0,
    totalAssociationRows: total?.n ?? 0,
    coverageThrough: monitor?.scanned_through_height == null
      ? undefined
      : Number(monitor.scanned_through_height),
    state: monitor?.state ?? "(missing)",
    epoch: monitor?.epoch ?? -1n,
  };
}

/** The two — and only two — states Rule B permits for a height. */
export type RuleBState = "nothing-of-height" | "all-of-height";

/**
 * Classify an observation, or throw naming the partial state found.
 *
 * Throwing rather than returning a third value is the point: any state that is neither of the
 * two is a Rule B violation, and the message has to say WHICH half survived, because that is the
 * whole diagnostic.
 *
 * Note what makes the ZERO-MATCH heights non-trivial here: "no associations of H" is true of
 * them in both states, so the classification turns entirely on coverage — which is exactly the
 * property the spec insists on (a scanned-and-empty height must be distinguishable from an
 * unscanned one, FR-011).
 */
export function classifyRuleBState(
  observed: MonitorHeightObservation,
  expected: { height: number; associationRows: number; totalBefore: number },
): RuleBState {
  const nothing =
    observed.associationRows === 0 &&
    observed.totalAssociationRows === expected.totalBefore &&
    (observed.coverageThrough === undefined || observed.coverageThrough < expected.height);
  if (nothing) return "nothing-of-height";

  const all =
    observed.associationRows === expected.associationRows &&
    observed.totalAssociationRows === expected.totalBefore + expected.associationRows &&
    observed.coverageThrough === expected.height &&
    // 00009-07, a STRENGTHENING of this gate, never a relaxation: a height's associations, their
    // details, their block time and the coverage advance are one commit unit. A run in which the
    // matches survived a crash but their details did not would satisfy the three conditions above
    // and is now refused — which is the only way to tell "details are written inside the batch"
    // from "details are written soon afterwards and we got lucky".
    observed.associationRowsWithDetails === expected.associationRows &&
    observed.associationRowsWithBlockTime === expected.associationRows;
  if (all) return "all-of-height";

  throw new Error(
    `Rule B violation at height ${expected.height}: a PARTIAL batch is durably observable. ` +
      `Observed ${JSON.stringify(observed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}; ` +
      `a complete batch would be ${JSON.stringify({
        associationRows: expected.associationRows,
        associationRowsWithDetails: expected.associationRows,
        associationRowsWithBlockTime: expected.associationRows,
        totalAssociationRows: expected.totalBefore + expected.associationRows,
        coverageThrough: expected.height,
      })} and an absent one would be zero associations with coverage below ${expected.height} ` +
      `and the total still at ${expected.totalBefore}. A block height's associations and its ` +
      "coverage advance must commit in ONE transaction (owner Rule B).",
  );
}
