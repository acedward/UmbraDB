import type { ISql } from "postgres";
import type { PackagePhase } from "../ingest/fold.js";
import { decodePublication, type DecodedPublication } from "./event.js";

/**
 * Project 00024-02 — the public-interface rows: where a publication is stored when the scanner
 * reads it (task C2) and how the current publication of a contract is chosen (derivation P2).
 *
 * ── Derivation P2 (`spec/00024-upstream-spec-changes.md`) ──────────────────────────────────────
 * [B] PR #6: "The consumer selects the newest applicable `[v1]` publication … A newer invalid or
 * unavailable publication is reported as such rather than silently presenting an older one as
 * current." [B] gives no order, and under UC-2 a publication is a [Y] package, for which [Y] gives
 * no position either. This indexer orders publications of one contract exactly as P1 orders
 * MIP-0018 packages: `(block height, transaction position in the block, execution position of the
 * FIRST part)`, the execution position being the first part's indexer event id (ledger emission
 * order inside a transaction). The last one is CURRENT — whatever its verification result (spec
 * FR-010, Q14); every earlier one is historical and keeps its own last result.
 *
 * The choice is made in the scan's database transaction, in {@link applyInterfacePublication},
 * with the guard of P1's kv upsert: a publication replaces the current one only if it sorts after
 * it, so the order in which the scanner meets packages (by segment inside one transaction) never
 * matters, and a re-scan changes nothing (the event row is `ON CONFLICT DO NOTHING`).
 */

/** One publication as the lookup hands it over: a [Y] package of the [B] name, with its place. */
export interface PublicationInput {
  /** The first part's indexer event id — the publication's identity (P2). */
  eventId: number;
  /** Every part's indexer event id, in ledger emission order; the first is `eventId`. */
  partEventIds: number[];
  contractAddress: string;
  txHash: string;
  blockHeight: number;
  txPosition: number;
  segment: number;
  phase: PackagePhase;
  /** The merged payload, `256 · parts` bytes. */
  payload: Uint8Array;
}

export interface PublicationOutcome {
  /** False when the row was already there (a re-scan) — nothing else was touched. */
  stored: boolean;
  /** True when this publication is now its contract's current one. */
  current: boolean;
  decoded: DecodedPublication;
}

/** P2: does position `a` come after position `b`? */
export function isNewerPublication(
  a: { blockHeight: number; txPosition: number; eventId: number },
  b: { blockHeight: number; txPosition: number; eventId: number },
): boolean {
  if (a.blockHeight !== b.blockHeight) return a.blockHeight > b.blockHeight;
  if (a.txPosition !== b.txPosition) return a.txPosition > b.txPosition;
  return a.eventId > b.eventId;
}

const hexBuf = (hex: string): Buffer => Buffer.from(hex, "hex");

/**
 * Stores one publication and, when it is the newest of its contract (P2), makes it current. Runs
 * on the caller's `sql` — the scan batch's transaction or the lookup drain's — so the publication,
 * the current pointer and the cursor commit together. The new publication is `pending` and due at
 * once; the verification drain picks it up outside this transaction (spec FR-011).
 */
export async function applyInterfacePublication(
  sql: ISql, schema: string, net: string, input: PublicationInput,
): Promise<PublicationOutcome> {
  if (input.partEventIds.length === 0 || input.partEventIds[0] !== input.eventId) {
    throw new Error(
      `applyInterfacePublication: publication ${input.eventId} must list its own id as its first part ` +
      `(got [${input.partEventIds.join(", ")}])`,
    );
  }
  const decoded = decodePublication(input.payload);
  const inserted = await sql`
    INSERT INTO ${sql(schema)}.public_interface_events
      (net, event_id, part_event_ids, parts, segment, phase, address, tx_hash, block_height,
       tx_position, payload, commitment, url_bytes, url, url_error, status, next_check_at)
    VALUES
      (${net}, ${input.eventId}, ${`{${input.partEventIds.join(",")}}`}::bigint[], ${decoded.parts},
       ${input.segment}, ${input.phase}, ${hexBuf(input.contractAddress)}, ${hexBuf(input.txHash)},
       ${input.blockHeight}, ${input.txPosition}, ${Buffer.from(input.payload)},
       ${Buffer.from(decoded.commitment)}, ${Buffer.from(decoded.urlBytes)}, ${decoded.url ?? null},
       ${decoded.urlError ?? null}, 'pending', now())
    ON CONFLICT (net, event_id) DO NOTHING
  `;
  if (inserted.count === 0) {
    const current = await sql<{ event_id: string }[]>`
      SELECT event_id::text FROM ${sql(schema)}.public_interfaces
      WHERE net = ${net} AND address = ${hexBuf(input.contractAddress)}
    `;
    return { stored: false, current: current[0]?.event_id === String(input.eventId), decoded };
  }

  const prev = await sql<{ event_id: string; block_height: string; tx_position: number }[]>`
    SELECT event_id::text, block_height::text, tx_position
    FROM ${sql(schema)}.public_interfaces
    WHERE net = ${net} AND address = ${hexBuf(input.contractAddress)}
    FOR UPDATE
  `;
  const previous = prev[0];
  if (previous === undefined) {
    await sql`
      INSERT INTO ${sql(schema)}.public_interfaces (net, address, event_id, block_height, tx_position, publications)
      VALUES (${net}, ${hexBuf(input.contractAddress)}, ${input.eventId}, ${input.blockHeight}, ${input.txPosition}, 1)
    `;
    return { stored: true, current: true, decoded };
  }
  const newer = isNewerPublication(input, {
    blockHeight: Number(previous.block_height), txPosition: previous.tx_position, eventId: Number(previous.event_id),
  });
  if (!newer) {
    // An older publication met later (two publications of one transaction reach this function in
    // segment order): stored as historical at once. It is still pending, so it gets its one check.
    await sql`
      UPDATE ${sql(schema)}.public_interfaces SET publications = publications + 1
      WHERE net = ${net} AND address = ${hexBuf(input.contractAddress)}
    `;
    return { stored: true, current: false, decoded };
  }
  await sql`
    UPDATE ${sql(schema)}.public_interfaces
    SET event_id = ${input.eventId}, block_height = ${input.blockHeight}, tx_position = ${input.txPosition},
        publications = publications + 1
    WHERE net = ${net} AND address = ${hexBuf(input.contractAddress)}
  `;
  // The one it replaces becomes historical: it is re-checked no more (FR-011b re-checks the
  // current publication). A publication never checked keeps its one pending check.
  await sql`
    UPDATE ${sql(schema)}.public_interface_events
    SET next_check_at = NULL
    WHERE net = ${net} AND event_id = ${Number(previous.event_id)} AND status <> 'pending'
  `;
  return { stored: true, current: true, decoded };
}
