/**
 * Read side of the event log `mip0018_events` (the API builds on it): every `Misc` event of an applied part, in the
 * MIP's chain order, with its classification. The event log is the chain-event record (position, contract,
 * classification, reason); the raw `name`/`payload` are returned for recomputation and tests and
 * must never be served as metadata.
 */
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { MIP0018_SCHEMA } from "../../src/postgres/migrations/mip0018/index.js";
import { hexToBytes, toHex } from "./bytes.ts";

export interface LoggedEvent {
  height: number;
  txIndex: number;
  /** Position among the applied `log` ops of the transaction (ledger order). */
  eventIndex: number;
  txHash: string;
  segment: number;
  phase: "guaranteed" | "fallible";
  contractAddress: string;
  eventType: string;
  /** Zero-extended `name` (32 bytes) and `payload` (256 bytes), hex; empty when the logged data was not one item. */
  name: string;
  payload: string;
  classification: "accept" | "reject" | "ignore" | "unresolved";
  reason: string | undefined;
  /** Accepted events only. */
  domainSep: string | undefined;
  kind: number | undefined;
}

const hex = toHex;
const buf = (h: string): Uint8Array => hexToBytes(h.replace(/^0x/, "").toLowerCase());

/** Events of a network in chain order, optionally of one contract and/or one transaction. */
export async function listEvents(
  sql: UmbraDBSql, network: string, filter: { contractAddress?: string; txHash?: string } = {}, schema = MIP0018_SCHEMA,
): Promise<LoggedEvent[]> {
  const rows = await sql<{
    block_height: bigint; tx_index: number; event_index: number; tx_hash: Uint8Array | null; segment_id: number | null; phase: string | null;
    contract_address: Uint8Array; event_type: string; name: Uint8Array; payload: Uint8Array; classification: LoggedEvent["classification"];
    reason: string | null; domain_sep: Uint8Array | null; kind: number | null;
  }[]>`
    SELECT block_height, tx_index, event_index, tx_hash, segment_id, phase, contract_address, event_type, name, payload,
           classification, reason, domain_sep, kind
    FROM ${sql(schema)}.mip0018_events
    WHERE network = ${network}
      ${filter.contractAddress === undefined ? sql`` : sql`AND contract_address = ${buf(filter.contractAddress)}`}
      ${filter.txHash === undefined ? sql`` : sql`AND tx_hash = ${buf(filter.txHash)}`}
    ORDER BY block_height, tx_index, event_index`;
  return rows.map((r) => ({
    height: Number(r.block_height), txIndex: r.tx_index, eventIndex: r.event_index,
    txHash: r.tx_hash === null ? "" : hex(r.tx_hash), segment: r.segment_id ?? 0, phase: (r.phase ?? "guaranteed") as LoggedEvent["phase"],
    contractAddress: hex(r.contract_address), eventType: r.event_type, name: hex(r.name), payload: hex(r.payload),
    classification: r.classification, reason: r.reason ?? undefined,
    domainSep: r.domain_sep === null ? undefined : hex(r.domain_sep), kind: r.kind ?? undefined,
  }));
}

/** Classification counts of a contract's events (accepted, rejected, ignored, unresolved), e.g. for the marks. */
export async function eventCounts(
  sql: UmbraDBSql, network: string, contractAddress: string, schema = MIP0018_SCHEMA,
): Promise<{ events: number; accepted: number; rejected: number; ignored: number; unresolved: number }> {
  const rows = await sql<{ classification: string; n: number }[]>`
    SELECT classification, count(*)::int AS n FROM ${sql(schema)}.mip0018_events
    WHERE network = ${network} AND contract_address = ${buf(contractAddress)} GROUP BY classification`;
  const n = (c: string): number => rows.find((r) => r.classification === c)?.n ?? 0;
  return {
    events: n("accept") + n("reject") + n("ignore") + n("unresolved"),
    accepted: n("accept"), rejected: n("reject"), ignored: n("ignore"), unresolved: n("unresolved"),
  };
}
