/**
 * The Postgres apply path of UmbraDB's MIP-0018 metadata state: the event log `mip0018_events` and the latest-value
 * rows `mip0018_fields` (one row per {network, contract, domainSep, kind, key}; no history).
 *
 * ONE state implementation: this module never decides a rule itself. Each accepted event is classified by the
 * vendored reference codec and its records are turned into ordered set/delete effects by `recordEffects` of the pure
 * state module (`state.ts`, which also computes the `usable` flag with `fieldUsable`); the effects are applied to rows:
 *
 * - `set` → the field's row is inserted or overwritten (latest wins; the replaced value is gone — no fallback);
 * - `delete` (a Null record, a per-key tombstone) → the field's row is deleted; a Null for a field without a row
 *   deletes nothing (no effect).
 *
 * An identity exists only while it has a row. Nothing else is stored for it: the token list entry of a kind-3
 * identity, a contract's metadata entry and the symbol groups are DERIVED from these rows by the read helpers
 * (`metadata.ts`), so they disappear with the identity's last row (the last tombstone removes the shared entries),
 * while mints, seen colors and NIGHT/DUST rows (other facts, other tables) stay.
 *
 * - Chain order: events are written strictly after the network's last stored event (`ChainOrderError` otherwise),
 *   inside the caller's transaction — the scan writes a block's events, its field changes and its cursor in ONE
 *   Postgres transaction (`scan.ts`).
 * - Recompute (MIP "Applying records", vector S4): `removeEventsAbove` deletes the events above a height and rebuilds
 *   exactly the identities those events touched, by re-applying that identity's remaining accepted events from the
 *   stored log (raw `name`/`payload` are kept for this) in chain order with the same `applyAccepted`. Identities
 *   are independent (MIP S6: an update to one leaves the others unchanged), so the rest of the table is untouched.
 *   `recomputeFields` rebuilds a whole network the same way (repair; test oracle).
 * - Only `accept` rows are ever applied; `reject` rows feed the mark, `ignore` rows nothing.
 * - Metadata history (MIP "Applying records": a withdrawn identity MUST NOT be referenced in metadata history, and "a
 *   later non-Null record describes it again, with only that field"): when a record deletes an identity's LAST field
 *   row, its withdrawal position is recorded (`mip0018_withdrawals`) and its listed accepted events are deleted from
 *   `mip0018_listed_events`; after each accepted event, the event is listed when its identity has a field. So an
 *   identity's history starts at its last revival: an event that withdrew it, a Null-only event while it had no field,
 *   and everything before its last withdrawal are never listed. Every rejected event is listed (it describes no
 *   identity). Activity reads only listed events (`activity.ts`). Each listed row is deleted at most once, so a
 *   withdrawal costs at most the rows its identity's current description added.
 */
import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../src/postgres/client.js";
import { classifyEvent, NAME_SIZE, PAYLOAD_SIZE, zeroExtend } from "../vendor/mip0018/codec/src/index.ts";
import { ChainOrderError, type ChainPosition, recordEffects } from "./state.ts";

/** Any postgres.js query function: a client, a reserved connection or a transaction. */
export type Queryable = ISql<{ bigint: bigint }>;

/** One `mip0018_events` row (column names as in `001_mip0018_core`). */
export interface EventRow {
  network: string;
  block_height: number;
  tx_index: number;
  event_index: number;
  tx_hash: Buffer | null;
  segment_id: number | null;
  phase: string | null;
  contract_address: Buffer;
  event_type: string;
  /** Zero-extended to 32 bytes; empty when the observed name was longer (never applied). */
  name: Buffer;
  /** Zero-extended to 256 bytes; empty when the observed payload was longer (never applied). */
  payload: Buffer;
  /** `unresolved`: a `log` op whose logged value the raw transaction does not show; never applied. */
  classification: "accept" | "reject" | "ignore" | "unresolved";
  reason: string | null;
  domain_sep: Buffer | null;
  kind: number | null;
}

/** The stored log disagrees with the codec, or a write would break the state's invariants. */
export class MetadataStoreError extends Error {
  override name = "MetadataStoreError";
}

const hexBuf = (h: string): Buffer => Buffer.from(h.replace(/^0x/, "").toLowerCase(), "hex");

/**
 * The event-log row of an observed event, classified with the vendored codec (MIP "Event", "Consuming": a shorter
 * `name`/`payload` is zero-extended; a longer name is another name, a longer payload is rejected). The bytes stored are
 * the zero-extended 32 + 256 bytes, or empty when the observed bytes exceed them (such an event is never accepted).
 * Used for events that do not come from the archive scan (vector inputs, tests); the scan builds the same row from the
 * applied-parts decoder.
 */
export function observedEventRow(e: {
  network: string;
  position: ChainPosition;
  contractAddress: string;
  type: string;
  name: Uint8Array;
  payload: Uint8Array;
  txHash?: string;
  segment?: number;
  phase?: "guaranteed" | "fallible";
}): EventRow {
  const c = classifyEvent({ type: e.type, name: e.name, payload: e.payload });
  const name = zeroExtend(e.name, NAME_SIZE);
  const payload = zeroExtend(e.payload, PAYLOAD_SIZE);
  return {
    network: e.network,
    block_height: e.position.block,
    tx_index: e.position.tx,
    event_index: e.position.event,
    tx_hash: e.txHash === undefined ? null : hexBuf(e.txHash),
    segment_id: e.segment ?? null,
    phase: e.phase ?? null,
    contract_address: hexBuf(e.contractAddress),
    event_type: e.type,
    name: name === undefined ? Buffer.alloc(0) : Buffer.from(name),
    payload: payload === undefined ? Buffer.alloc(0) : Buffer.from(payload),
    classification: c.result,
    reason: c.result === "accept" ? null : c.reason,
    domain_sep: c.result === "accept" ? Buffer.from(c.header.domainSep) : null,
    kind: c.result === "accept" ? c.header.kind : null,
  };
}

const positionOf = (r: { block_height: number | bigint; tx_index: number; event_index: number }): ChainPosition => ({
  block: Number(r.block_height),
  tx: r.tx_index,
  event: r.event_index,
});
const comparePosition = (a: ChainPosition, b: ChainPosition): number => a.block - b.block || a.tx - b.tx || a.event - b.event;

/**
 * Writes events to the log, in order, and applies each accepted one to `mip0018_fields` (in the caller's
 * transaction). Every event must come after the previous one on its network — after the network's last stored event
 * and after the previous row of `rows` (MIP "Applying records": state = accepted events applied in chain order).
 */
export async function writeEvents(tx: Queryable, schema: string, rows: readonly EventRow[]): Promise<{ events: number; accepted: number }> {
  assertValidSchemaName(schema);
  const last = new Map<string, ChainPosition | undefined>();
  let accepted = 0;
  for (const row of rows) {
    if (!last.has(row.network)) last.set(row.network, await lastEventPosition(tx, schema, row.network));
    const previous = last.get(row.network);
    const at = positionOf(row);
    if (previous !== undefined && comparePosition(at, previous) <= 0)
      throw new ChainOrderError(`event at ${JSON.stringify(at)} does not follow ${JSON.stringify(previous)} on ${row.network}`);
    last.set(row.network, at);
    await tx`INSERT INTO ${tx(schema)}.mip0018_events ${tx(row as unknown as Record<string, unknown>)}`;
    if (row.classification === "accept") {
      await applyAccepted(tx, schema, row);
      accepted++;
    } else if (row.classification === "reject") {
      await listEvent(tx, schema, row, null);
    }
  }
  return { events: rows.length, accepted };
}

async function lastEventPosition(tx: Queryable, schema: string, network: string): Promise<ChainPosition | undefined> {
  const rows = await tx<{ block_height: bigint; tx_index: number; event_index: number }[]>`
    SELECT block_height, tx_index, event_index FROM ${tx(schema)}.mip0018_events
    WHERE network = ${network} ORDER BY block_height DESC, tx_index DESC, event_index DESC LIMIT 1`;
  return rows[0] === undefined ? undefined : positionOf(rows[0]);
}

interface StoredAccepted {
  network: string;
  block_height: number | bigint;
  tx_index: number;
  event_index: number;
  contract_address: Buffer;
  event_type: string;
  name: Buffer;
  payload: Buffer;
  domain_sep: Buffer | null;
  kind: number | null;
}

interface IdentityKey { network: string; contract: Buffer; domainSep: Buffer; kind: number }

/** Lists an event as metadata history (`identity` = its identity for an accepted event, `null` for a rejected one). */
async function listEvent(
  tx: Queryable, schema: string, row: { network: string; block_height: number | bigint; tx_index: number; event_index: number; contract_address: Buffer },
  identity: IdentityKey | null,
): Promise<void> {
  await tx`
    INSERT INTO ${tx(schema)}.mip0018_listed_events
      (network, block_height, tx_index, event_index, contract_address, classification, domain_sep, kind)
    VALUES (${row.network}, ${row.block_height}, ${row.tx_index}, ${row.event_index}, ${row.contract_address},
            ${identity === null ? "reject" : "accept"}, ${identity?.domainSep ?? null}, ${identity?.kind ?? null})`;
}

async function hasField(tx: Queryable, schema: string, id: IdentityKey): Promise<boolean> {
  const rows = await tx`
    SELECT 1 FROM ${tx(schema)}.mip0018_fields
    WHERE network = ${id.network} AND contract_address = ${id.contract} AND domain_sep = ${id.domainSep} AND kind = ${id.kind} LIMIT 1`;
  return rows.length > 0;
}

/**
 * The identity's last field row was just deleted: record the withdrawal's position and delete the
 * identity's listed accepted events — its metadata history is gone (MIP "Applying records").
 */
async function withdraw(tx: Queryable, schema: string, id: IdentityKey, at: ChainPosition, record: number): Promise<void> {
  const t = tx(schema);
  await tx`
    INSERT INTO ${t}.mip0018_withdrawals (network, contract_address, domain_sep, kind, block_height, tx_index, event_index, record_index)
    VALUES (${id.network}, ${id.contract}, ${id.domainSep}, ${id.kind}, ${at.block}, ${at.tx}, ${at.event}, ${record})
    ON CONFLICT (network, contract_address, domain_sep, kind) DO UPDATE SET
      block_height = EXCLUDED.block_height, tx_index = EXCLUDED.tx_index, event_index = EXCLUDED.event_index, record_index = EXCLUDED.record_index`;
  await tx`
    DELETE FROM ${t}.mip0018_listed_events
    WHERE network = ${id.network} AND contract_address = ${id.contract} AND domain_sep = ${id.domainSep} AND kind = ${id.kind}
      AND classification = 'accept'`;
}

/**
 * Applies one accepted event's records to the latest-value rows: the codec decodes the stored bytes again, the pure
 * module's `recordEffects` gives the ordered set/delete effects, and each effect becomes one upsert or delete. A
 * delete that leaves the identity without a field is a withdrawal; the event is listed as metadata history when the
 * identity has a field after it.
 */
async function applyAccepted(tx: Queryable, schema: string, row: StoredAccepted): Promise<void> {
  const c = classifyEvent({ type: row.event_type, name: row.name, payload: row.payload });
  const at = positionOf(row);
  if (c.result !== "accept")
    throw new MetadataStoreError(`stored event ${JSON.stringify(at)} on ${row.network} is marked accepted but the codec says ${c.result} (${c.reason})`);
  if (row.domain_sep === null || !row.domain_sep.equals(Buffer.from(c.header.domainSep)) || row.kind !== c.header.kind)
    throw new MetadataStoreError(`stored event ${JSON.stringify(at)} on ${row.network}: its identity columns differ from its payload header`);
  const t = tx(schema);
  const id: IdentityKey = { network: row.network, contract: row.contract_address, domainSep: row.domain_sep, kind: row.kind };
  for (const e of recordEffects(c.records)) {
    const key = Buffer.from(e.key);
    if (e.op === "delete") {
      const deleted = await tx`
        DELETE FROM ${t}.mip0018_fields
        WHERE network = ${id.network} AND contract_address = ${id.contract} AND domain_sep = ${id.domainSep} AND kind = ${id.kind} AND key = ${key}`;
      if (deleted.count > 0 && !(await hasField(tx, schema, id))) await withdraw(tx, schema, id, at, e.record);
      continue;
    }
    const uint = e.integer === undefined ? null : e.integer.toString();
    const usable = e.usable ?? null;
    await tx`
      INSERT INTO ${t}.mip0018_fields
        (network, contract_address, domain_sep, kind, key, val_type, value, uint_value, usable,
         updated_block, updated_tx, updated_event, updated_record)
      VALUES (${id.network}, ${id.contract}, ${id.domainSep}, ${id.kind}, ${key}, ${e.valType}, ${Buffer.from(e.value)}, ${uint}, ${usable},
              ${at.block}, ${at.tx}, ${at.event}, ${e.record})
      ON CONFLICT (network, contract_address, domain_sep, kind, key) DO UPDATE SET
        val_type = EXCLUDED.val_type, value = EXCLUDED.value, uint_value = EXCLUDED.uint_value, usable = EXCLUDED.usable,
        updated_block = EXCLUDED.updated_block, updated_tx = EXCLUDED.updated_tx,
        updated_event = EXCLUDED.updated_event, updated_record = EXCLUDED.updated_record`;
  }
  if (await hasField(tx, schema, id)) await listEvent(tx, schema, row, id);
}

/** Deletes everything the apply path derived for one identity: fields, withdrawal row, listed accepted events. */
async function clearIdentity(tx: Queryable, schema: string, id: IdentityKey): Promise<void> {
  const t = tx(schema);
  const at = tx`network = ${id.network} AND contract_address = ${id.contract} AND domain_sep = ${id.domainSep} AND kind = ${id.kind}`;
  await tx`DELETE FROM ${t}.mip0018_fields WHERE ${at}`;
  await tx`DELETE FROM ${t}.mip0018_withdrawals WHERE ${at}`;
  await tx`DELETE FROM ${t}.mip0018_listed_events WHERE ${at} AND classification = 'accept'`;
}

/** Re-applies, in chain order, the stored accepted events of one identity (its rows must be gone already). */
async function replayIdentity(tx: Queryable, schema: string, network: string, contract: Buffer, domainSep: Buffer, kind: number): Promise<number> {
  const events = await tx<StoredAccepted[]>`
    SELECT network, block_height, tx_index, event_index, contract_address, event_type, name, payload, domain_sep, kind
    FROM ${tx(schema)}.mip0018_events
    WHERE network = ${network} AND classification = 'accept'
      AND contract_address = ${contract} AND domain_sep = ${domainSep} AND kind = ${kind}
    ORDER BY block_height, tx_index, event_index`;
  for (const e of events) await applyAccepted(tx, schema, e);
  return events.length;
}

/**
 * Removes every event above `height` on `network` and recomputes the fields of exactly the identities those events
 * touched, from the accepted events that remain (MIP S4: removing a tombstone block restores the earlier state; adding
 * it again applies the tombstones again). Runs in the caller's transaction. The listed events above the height go with
 * their events; each touched identity's withdrawal row and listed accepted events are rebuilt with its fields by the
 * same replay, so a removed withdrawal lists the identity's earlier history again exactly as before it.
 */
export async function removeEventsAbove(
  tx: Queryable, schema: string, network: string, height: number,
): Promise<{ removedEvents: number; recomputedIdentities: number; replayedEvents: number }> {
  assertValidSchemaName(schema);
  if (!Number.isSafeInteger(height) || height < -1) throw new MetadataStoreError(`height must be an integer ≥ -1, got ${height}`);
  const t = tx(schema);
  const touched = await tx<{ contract_address: Buffer; domain_sep: Buffer; kind: number }[]>`
    SELECT DISTINCT contract_address, domain_sep, kind FROM ${t}.mip0018_events
    WHERE network = ${network} AND block_height > ${height} AND classification = 'accept'
    ORDER BY contract_address, domain_sep, kind`;
  await tx`DELETE FROM ${t}.mip0018_listed_events WHERE network = ${network} AND block_height > ${height}`;
  const removed = await tx`DELETE FROM ${t}.mip0018_events WHERE network = ${network} AND block_height > ${height}`;
  let replayedEvents = 0;
  for (const id of touched) {
    await clearIdentity(tx, schema, { network, contract: id.contract_address, domainSep: id.domain_sep, kind: id.kind });
    replayedEvents += await replayIdentity(tx, schema, network, id.contract_address, id.domain_sep, id.kind);
  }
  return { removedEvents: removed.count, recomputedIdentities: touched.length, replayedEvents };
}

/**
 * Rebuilds every field of `network` from the stored accepted events (deletes the network's rows, then replays each
 * identity in chain order), with the withdrawal rows and the listed events (rejected events listed again from the log).
 * A repair tool and a test oracle: on a consistent store it changes nothing.
 */
export async function recomputeFields(tx: Queryable, schema: string, network: string): Promise<{ identities: number; replayedEvents: number }> {
  assertValidSchemaName(schema);
  const t = tx(schema);
  await tx`DELETE FROM ${t}.mip0018_fields WHERE network = ${network}`;
  await tx`DELETE FROM ${t}.mip0018_withdrawals WHERE network = ${network}`;
  await tx`DELETE FROM ${t}.mip0018_listed_events WHERE network = ${network}`;
  await tx`
    INSERT INTO ${t}.mip0018_listed_events (network, block_height, tx_index, event_index, contract_address, classification, domain_sep, kind)
    SELECT network, block_height, tx_index, event_index, contract_address, 'reject', NULL, NULL FROM ${t}.mip0018_events
    WHERE network = ${network} AND classification = 'reject'`;
  const ids = await tx<{ contract_address: Buffer; domain_sep: Buffer; kind: number }[]>`
    SELECT DISTINCT contract_address, domain_sep, kind FROM ${t}.mip0018_events
    WHERE network = ${network} AND classification = 'accept' ORDER BY contract_address, domain_sep, kind`;
  let replayedEvents = 0;
  for (const id of ids) replayedEvents += await replayIdentity(tx, schema, network, id.contract_address, id.domain_sep, id.kind);
  return { identities: ids.length, replayedEvents };
}
