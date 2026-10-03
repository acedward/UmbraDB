/**
 * Read helpers of UmbraDB's MIP-0018 metadata state in Postgres (project 00026, sub-plan B3) — the functions the
 * API of sub-plan C serves and the Postgres vector adapter reads the state back with. Pure queries, no writes.
 *
 * Every rule comes from the pure state module (`state.ts`): fields are returned in the module's own `IdentityState`
 * shape (current value, `usable` flag computed by `fieldUsable` when the value was set), groups are computed by
 * `symbolGroups`, amounts by `displayAmount`, marks and `standards` tags by `tokenMark` — so the Postgres path and the
 * pure adapter cannot disagree on a rule.
 *
 * "Not referenced at all" (MIP `274a84f` "Applying records", Q5/Q15/Q16): an identity exists only while it has a row
 * in `mip0018_fields`. Every helper below reads identities from those rows only, so an identity whose last field was
 * deleted appears in no listing, lookup, group, display or event view — as if it had never been described — while
 * the chain events themselves stay in the log (position, contract, classification, reason; `chainEvents` omits the
 * identity of an accepted event whose identity no longer exists and never returns event bytes).
 */
import { MIP0018_SCHEMA } from "../../src/postgres/migrations/mip0018/index.js";
import type { Queryable } from "./fields.ts";
import {
  COMMON_KEY_HEX,
  displayAmount,
  type Field,
  type GroupableIdentity,
  type IdentityRef,
  type IdentityState,
  type Rejection,
  type SymbolGroup,
  symbolGroups,
  tokenMark,
  type TokenMark,
  toHex,
} from "./state.ts";

const buf = (h: string): Buffer => Buffer.from(h.replace(/^0x/, "").toLowerCase(), "hex");
const SYMBOL_KEY = buf(COMMON_KEY_HEX.symbol);

interface FieldRow {
  contract_address: Buffer;
  domain_sep: Buffer;
  kind: number;
  key: Buffer;
  val_type: number;
  value: Buffer;
  uint_value: string | null;
  usable: boolean | null;
  updated_block: bigint;
  updated_tx: number;
  updated_event: number;
  updated_record: number;
}

/** Filter of `listIdentities`: one contract, one identity, or one kind. */
export interface IdentityFilter {
  contractAddress?: string;
  domainSep?: string;
  kind?: number;
}

/**
 * Every identity of a network that currently has at least one field, in the order (contract, domainSep, kind); its
 * fields keyed by key hex in the order their current values were set (as the pure module keeps them).
 */
export async function listIdentities(sql: Queryable, network: string, filter: IdentityFilter = {}, schema = MIP0018_SCHEMA): Promise<IdentityState[]> {
  const rows = await sql<FieldRow[]>`
    SELECT contract_address, domain_sep, kind, key, val_type, value, uint_value::text AS uint_value, usable,
           updated_block, updated_tx, updated_event, updated_record
    FROM ${sql(schema)}.mip0018_fields
    WHERE network = ${network}
      ${filter.contractAddress === undefined ? sql`` : sql`AND contract_address = ${buf(filter.contractAddress)}`}
      ${filter.domainSep === undefined ? sql`` : sql`AND domain_sep = ${buf(filter.domainSep)}`}
      ${filter.kind === undefined ? sql`` : sql`AND kind = ${filter.kind}`}
    ORDER BY contract_address, domain_sep, kind, updated_block, updated_tx, updated_event, updated_record`;
  const out: IdentityState[] = [];
  let current: { ref: IdentityRef; fields: Map<string, Field> } | undefined;
  for (const r of rows) {
    const ref: IdentityRef = { network, contractAddress: toHex(r.contract_address), domainSep: toHex(r.domain_sep), kind: r.kind };
    if (current === undefined || current.ref.contractAddress !== ref.contractAddress || current.ref.domainSep !== ref.domainSep || current.ref.kind !== ref.kind) {
      current = { ref, fields: new Map() };
      out.push({ ...current.ref, fields: current.fields });
    }
    const f: Field = {
      key: Uint8Array.from(r.key),
      valType: r.val_type,
      value: Uint8Array.from(r.value),
      position: { block: Number(r.updated_block), tx: r.updated_tx, event: r.updated_event, record: r.updated_record },
    };
    if (r.uint_value !== null) f.integer = BigInt(r.uint_value);
    if (r.usable !== null) f.usable = r.usable;
    current.fields.set(toHex(r.key), f);
  }
  return out;
}

/** One identity, or `undefined` when it has no field (then it is not referenced anywhere). */
export async function getIdentity(sql: Queryable, ref: IdentityRef, schema = MIP0018_SCHEMA): Promise<IdentityState | undefined> {
  const [id] = await listIdentities(sql, ref.network, { contractAddress: ref.contractAddress, domainSep: ref.domainSep, kind: ref.kind }, schema);
  return id;
}

/** Symbol groups of two or more members of a network (or of one contract), by the pure module's `symbolGroups`. */
export async function listGroups(sql: Queryable, network: string, filter: { contractAddress?: string } = {}, schema = MIP0018_SCHEMA): Promise<SymbolGroup[]> {
  const rows = await sql<{ contract_address: Buffer; domain_sep: Buffer; kind: number; value: Buffer; usable: boolean | null }[]>`
    SELECT contract_address, domain_sep, kind, value, usable FROM ${sql(schema)}.mip0018_fields
    WHERE network = ${network} AND key = ${SYMBOL_KEY} AND usable
      ${filter.contractAddress === undefined ? sql`` : sql`AND contract_address = ${buf(filter.contractAddress)}`}`;
  const identities: GroupableIdentity[] = rows.map((r) => ({
    network,
    contractAddress: toHex(r.contract_address),
    domainSep: toHex(r.domain_sep),
    kind: r.kind,
    fields: new Map([[COMMON_KEY_HEX.symbol, { value: Uint8Array.from(r.value), ...(r.usable === null ? {} : { usable: r.usable }) }]]),
  }));
  return symbolGroups(identities);
}

/** The group an identity belongs to, or `undefined` (no usable `symbol`, alone with it, or not described). */
export async function groupOf(sql: Queryable, ref: IdentityRef, schema = MIP0018_SCHEMA): Promise<SymbolGroup | undefined> {
  const domainSep = ref.domainSep.replace(/^0x/, "").toLowerCase();
  return (await listGroups(sql, ref.network, { contractAddress: ref.contractAddress }, schema)).find((g) =>
    g.members.some((m) => m.domainSep === domainSep && m.kind === ref.kind),
  );
}

/** `raw` displayed with the identity's usable `decimals` (MIP S8); `undefined` without one (no default). */
export async function displayAmountOf(sql: Queryable, ref: IdentityRef, raw: bigint, schema = MIP0018_SCHEMA): Promise<{ decimals: bigint; text: string } | undefined> {
  return displayAmount((await getIdentity(sql, ref, schema))?.fields, raw);
}

/** Rejected MIP-0018 events of a contract, in chain order (position and reason only — never their bytes). */
export async function contractRejections(sql: Queryable, network: string, contractAddress: string, schema = MIP0018_SCHEMA): Promise<Rejection[]> {
  const rows = await sql<{ block_height: bigint; tx_index: number; event_index: number; reason: string }[]>`
    SELECT block_height, tx_index, event_index, reason FROM ${sql(schema)}.mip0018_events
    WHERE network = ${network} AND contract_address = ${buf(contractAddress)} AND classification = 'reject'
    ORDER BY block_height, tx_index, event_index`;
  return rows.map((r) => ({ position: { block: Number(r.block_height), tx: r.tx_index, event: r.event_index }, reason: r.reason }));
}

/**
 * A token identity's MIP-0018 mark and `standards` tags (Q14 (a)), decided by the pure module's `tokenMark` from the
 * identity's current fields (none when it is not described) and its contract's rejected events.
 */
export async function tokenMarkOf(sql: Queryable, ref: IdentityRef, schema = MIP0018_SCHEMA): Promise<TokenMark> {
  const [identity, rejections] = await Promise.all([
    getIdentity(sql, ref, schema),
    contractRejections(sql, ref.network, ref.contractAddress, schema),
  ]);
  return tokenMark({ fields: identity?.fields, contractRejections: rejections.map((r) => r.reason) });
}

/** Contracts of a network with at least one described identity (derived from the field rows), by address. */
export async function listMetadataContracts(sql: Queryable, network: string, schema = MIP0018_SCHEMA): Promise<Array<{ contractAddress: string; identities: number }>> {
  const rows = await sql<{ contract_address: Buffer; identities: number }[]>`
    SELECT contract_address, count(DISTINCT (domain_sep, kind))::int AS identities FROM ${sql(schema)}.mip0018_fields
    WHERE network = ${network} GROUP BY contract_address ORDER BY contract_address`;
  return rows.map((r) => ({ contractAddress: toHex(r.contract_address), identities: r.identities }));
}

/** A chain event as it may be served (Q15): position, contract, classification, reason — never its bytes. */
export interface ChainEvent {
  height: number;
  txIndex: number;
  eventIndex: number;
  /** Empty for events that do not come from an archived transaction (vector inputs). */
  txHash: string;
  segment: number | undefined;
  phase: "guaranteed" | "fallible" | undefined;
  contractAddress: string;
  eventType: string;
  classification: "accept" | "reject" | "ignore";
  reason: string | undefined;
  /** The identity an ACCEPTED event described — only while that identity still has a field (else omitted). */
  identity?: { domainSep: string; kind: number };
}

/**
 * Chain events of a network in chain order, optionally of one contract / one transaction. By default only the
 * MIP-0018 events (`accept`, `reject`); `includeIgnored` adds the `ignore` rows (other names, other types; Q19).
 */
export async function chainEvents(
  sql: Queryable, network: string, filter: { contractAddress?: string; txHash?: string; includeIgnored?: boolean } = {}, schema = MIP0018_SCHEMA,
): Promise<ChainEvent[]> {
  const s = sql(schema);
  const rows = await sql<{
    block_height: bigint; tx_index: number; event_index: number; tx_hash: Buffer | null; segment_id: number | null; phase: string | null;
    contract_address: Buffer; event_type: string; classification: ChainEvent["classification"]; reason: string | null;
    domain_sep: Buffer | null; kind: number | null; described: boolean;
  }[]>`
    SELECT e.block_height, e.tx_index, e.event_index, e.tx_hash, e.segment_id, e.phase, e.contract_address, e.event_type,
           e.classification, e.reason, e.domain_sep, e.kind,
           (e.classification = 'accept' AND EXISTS (
             SELECT 1 FROM ${s}.mip0018_fields f
             WHERE f.network = e.network AND f.contract_address = e.contract_address AND f.domain_sep = e.domain_sep AND f.kind = e.kind
           )) AS described
    FROM ${s}.mip0018_events e
    WHERE e.network = ${network}
      ${filter.includeIgnored === true ? sql`` : sql`AND e.classification IN ('accept', 'reject')`}
      ${filter.contractAddress === undefined ? sql`` : sql`AND e.contract_address = ${buf(filter.contractAddress)}`}
      ${filter.txHash === undefined ? sql`` : sql`AND e.tx_hash = ${buf(filter.txHash)}`}
    ORDER BY e.block_height, e.tx_index, e.event_index`;
  return rows.map((r) => {
    const e: ChainEvent = {
      height: Number(r.block_height), txIndex: r.tx_index, eventIndex: r.event_index, txHash: r.tx_hash === null ? "" : toHex(r.tx_hash),
      segment: r.segment_id ?? undefined, phase: (r.phase ?? undefined) as ChainEvent["phase"],
      contractAddress: toHex(r.contract_address), eventType: r.event_type, classification: r.classification, reason: r.reason ?? undefined,
    };
    if (r.described && r.domain_sep !== null && r.kind !== null) e.identity = { domainSep: toHex(r.domain_sep), kind: r.kind };
    return e;
  });
}
