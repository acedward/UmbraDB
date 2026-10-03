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
 * identity of an accepted event that is not in its identity's current metadata history — the identity no longer
 * exists, or the event came before its last withdrawal (re-check R2) — and never returns event bytes).
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
 * identity's current fields (none when it is not described), its contract's rejected events and its contract's
 * unresolved logs (final-audit re-check R1).
 */
export async function tokenMarkOf(sql: Queryable, ref: IdentityRef, schema = MIP0018_SCHEMA): Promise<TokenMark> {
  const [identity, rejections, unresolved] = await Promise.all([
    getIdentity(sql, ref, schema),
    contractRejections(sql, ref.network, ref.contractAddress, schema),
    contractUnresolvedSummary(sql, ref.network, ref.contractAddress, 0, schema),
  ]);
  return tokenMark({ fields: identity?.fields, contractRejections: rejections.map((r) => r.reason), contractUnresolvedLogs: unresolved.count });
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
  classification: "accept" | "reject" | "ignore" | "unresolved";
  reason: string | undefined;
  /**
   * The identity an ACCEPTED event described — only while the event belongs to the identity's current metadata
   * history (the identity has a field, and the event came after its last withdrawal: re-check R2); else omitted.
   */
  identity?: { domainSep: string; kind: number };
}

/**
 * Chain events of a network in chain order, optionally of one contract / one transaction. By default the MIP-0018
 * events (`accept`, `reject`) and the `unresolved` logs (final-audit F1: what they log is not in the raw transaction);
 * `includeIgnored` adds the `ignore` rows (other names, other types; Q19).
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
             SELECT 1 FROM ${s}.mip0018_listed_events l
             WHERE l.network = e.network AND l.contract_address = e.contract_address
               AND l.block_height = e.block_height AND l.tx_index = e.tx_index AND l.event_index = e.event_index
           )) AS described
    FROM ${s}.mip0018_events e
    WHERE e.network = ${network}
      ${filter.includeIgnored === true ? sql`` : sql`AND e.classification IN ('accept', 'reject', 'unresolved')`}
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

// ── Bounded reads for the API (final-audit F2) ─────────────────────────────────────────────────────────────────────
//
// How many keys an identity carries, how many identities share a symbol and how many events a contract has rejected
// are chosen by whoever calls that contract. The API therefore never reads all of them: list rows and marks read only
// the four common keys, rejections as a count plus the first reasons, an identity's fields one keyset page at a time,
// a group as a member count plus the first members. Every query below is an index range scan bounded by its LIMIT
// (or an index-only count).

const COMMON_KEY_BYTES: readonly Buffer[] = [COMMON_KEY_HEX.name, COMMON_KEY_HEX.symbol, COMMON_KEY_HEX.decimals, COMMON_KEY_HEX.standards].map(buf);
const FIELD_COLUMNS = (sql: Queryable) => sql`
  f.contract_address, f.domain_sep, f.kind, f.key, f.val_type, f.value, f.uint_value::text AS uint_value, f.usable,
  f.updated_block, f.updated_tx, f.updated_event, f.updated_record`;

function fieldOf(r: FieldRow): Field {
  const f: Field = {
    key: Uint8Array.from(r.key),
    valType: r.val_type,
    value: Uint8Array.from(r.value),
    position: { block: Number(r.updated_block), tx: r.updated_tx, event: r.updated_event, record: r.updated_record },
  };
  if (r.uint_value !== null) f.integer = BigInt(r.uint_value);
  if (r.usable !== null) f.usable = r.usable;
  return f;
}

/** An identity key as the API keeps it: lowercase hex and the kind. */
export interface IdentityKey { contractAddress: string; domainSep: string; kind: number }
export const identityKeyOf = (k: IdentityKey): string => `${k.contractAddress}/${k.domainSep}/${k.kind}`;

/** What a list row and a mark need of an identity: its common fields only, and whether it has any field at all. */
export interface IdentityCommon { described: boolean; fields: Map<string, Field> }

/** The common fields (`name`, `symbol`, `decimals`, `standards`) and the described flag of each given identity. */
export async function identityCommons(
  sql: Queryable, network: string, keys: readonly IdentityKey[], schema = MIP0018_SCHEMA,
): Promise<Map<string, IdentityCommon>> {
  const out = new Map<string, IdentityCommon>(keys.map((k) => [identityKeyOf(k), { described: false, fields: new Map() }]));
  if (keys.length === 0) return out;
  const s = sql(schema);
  const cs = sql.array(keys.map((k) => k.contractAddress));
  const ds = sql.array(keys.map((k) => k.domainSep));
  const ks = sql.array(keys.map((k) => String(k.kind)));
  const described = await sql<{ c: string; d: string; k: number }[]>`
    SELECT i.c, i.d, i.k FROM unnest(${cs}::text[], ${ds}::text[], ${ks}::text[]::int[]) AS i(c, d, k)
    WHERE EXISTS (SELECT 1 FROM ${s}.mip0018_fields f
                  WHERE f.network = ${network} AND f.contract_address = decode(i.c, 'hex') AND f.domain_sep = decode(i.d, 'hex') AND f.kind = i.k)`;
  for (const r of described) out.get(`${r.c}/${r.d}/${r.k}`)!.described = true;
  const rows = await sql<FieldRow[]>`
    SELECT ${FIELD_COLUMNS(sql)}
    FROM unnest(${cs}::text[], ${ds}::text[], ${ks}::text[]::int[]) AS i(c, d, k)
    JOIN ${s}.mip0018_fields f
      ON f.network = ${network} AND f.contract_address = decode(i.c, 'hex') AND f.domain_sep = decode(i.d, 'hex') AND f.kind = i.k
     AND f.key IN (${COMMON_KEY_BYTES[0]!}, ${COMMON_KEY_BYTES[1]!}, ${COMMON_KEY_BYTES[2]!}, ${COMMON_KEY_BYTES[3]!})
    ORDER BY f.contract_address, f.domain_sep, f.kind, f.updated_block, f.updated_tx, f.updated_event, f.updated_record`;
  for (const r of rows) out.get(identityKeyOf({ contractAddress: toHex(r.contract_address), domainSep: toHex(r.domain_sep), kind: r.kind }))!.fields.set(toHex(r.key), fieldOf(r));
  return out;
}

/** A contract's rejected MIP-0018 events for a mark: how many, and the reasons of the first `limit` in chain order. */
export async function contractRejectionSummary(
  sql: Queryable, network: string, contractAddress: string, limit: number, schema = MIP0018_SCHEMA,
): Promise<{ count: number; reasons: string[] }> {
  const s = sql(schema);
  const contract = buf(contractAddress);
  const [c] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${s}.mip0018_events WHERE network = ${network} AND contract_address = ${contract} AND classification = 'reject'`;
  const rows = await sql<{ reason: string }[]>`
    SELECT reason FROM ${s}.mip0018_events WHERE network = ${network} AND contract_address = ${contract} AND classification = 'reject'
    ORDER BY block_height, tx_index, event_index LIMIT ${limit}`;
  return { count: c?.n ?? 0, reasons: rows.map((r) => r.reason) };
}

/**
 * A contract's `unresolved` logs for a mark (final-audit re-check R1): how many, and the chain positions of the first
 * `limit` in chain order — from the partial index of unresolved rows alone (bounded like the rejections: the count is
 * an index-only scan, the positions a LIMIT).
 */
export async function contractUnresolvedSummary(
  sql: Queryable, network: string, contractAddress: string, limit: number, schema = MIP0018_SCHEMA,
): Promise<{ count: number; positions: Array<{ height: number; txIndex: number; eventIndex: number }> }> {
  const s = sql(schema);
  const contract = buf(contractAddress);
  const [c] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${s}.mip0018_events WHERE network = ${network} AND contract_address = ${contract} AND classification = 'unresolved'`;
  const rows = limit <= 0 || (c?.n ?? 0) === 0 ? [] : await sql<{ block_height: bigint; tx_index: number; event_index: number }[]>`
    SELECT block_height, tx_index, event_index FROM ${s}.mip0018_events
    WHERE network = ${network} AND contract_address = ${contract} AND classification = 'unresolved'
    ORDER BY block_height, tx_index, event_index LIMIT ${limit}`;
  return { count: c?.n ?? 0, positions: rows.map((r) => ({ height: Number(r.block_height), txIndex: r.tx_index, eventIndex: r.event_index })) };
}

/**
 * One keyset page of an identity's current fields, in key byte order (stable while the scan writes: a key never
 * moves), after `afterKeyHex`; `count` is the identity's number of fields.
 */
export async function identityFieldsPage(
  sql: Queryable, ref: IdentityRef, o: { limit: number; afterKeyHex?: string }, schema = MIP0018_SCHEMA,
): Promise<{ fields: Field[]; more: boolean; count: number }> {
  const s = sql(schema);
  const at = sql`f.network = ${ref.network} AND f.contract_address = ${buf(ref.contractAddress)} AND f.domain_sep = ${buf(ref.domainSep)} AND f.kind = ${ref.kind}`;
  const rows = await sql<FieldRow[]>`
    SELECT ${FIELD_COLUMNS(sql)} FROM ${s}.mip0018_fields f
    WHERE ${at} ${o.afterKeyHex === undefined ? sql`` : sql`AND f.key > ${buf(o.afterKeyHex)}`}
    ORDER BY f.key LIMIT ${o.limit + 1}`;
  const [c] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${s}.mip0018_fields f WHERE ${at}`;
  return { fields: rows.slice(0, o.limit).map(fieldOf), more: rows.length > o.limit, count: c?.n ?? 0 };
}

/**
 * The symbol group of an identity whose usable `symbol` is `symbol`: its member count and its first `limit` members
 * by (domainSep, kind); `undefined` when it has fewer than two members. The grouping rule stays `symbolGroups`'s:
 * the members read are the rows with that exact usable symbol in the contract, and the pure rule groups them.
 */
export async function boundedGroup(
  sql: Queryable, ref: IdentityRef, symbol: Uint8Array, limit: number, schema = MIP0018_SCHEMA,
): Promise<(SymbolGroup & { memberCount: number }) | undefined> {
  const s = sql(schema);
  const at = sql`network = ${ref.network} AND contract_address = ${buf(ref.contractAddress)} AND key = ${SYMBOL_KEY} AND usable AND value = ${Buffer.from(symbol)}`;
  const [c] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${s}.mip0018_fields WHERE ${at}`;
  const memberCount = c?.n ?? 0;
  if (memberCount < 2) return undefined;
  const rows = await sql<{ domain_sep: Buffer; kind: number; value: Buffer; usable: boolean | null }[]>`
    SELECT domain_sep, kind, value, usable FROM ${s}.mip0018_fields WHERE ${at} ORDER BY domain_sep, kind LIMIT ${Math.max(limit, 2)}`;
  const [group] = symbolGroups(rows.map((r) => ({
    network: ref.network, contractAddress: ref.contractAddress.replace(/^0x/, "").toLowerCase(), domainSep: toHex(r.domain_sep), kind: r.kind,
    fields: new Map([[COMMON_KEY_HEX.symbol, { value: Uint8Array.from(r.value), ...(r.usable === null ? {} : { usable: r.usable }) }]]),
  })));
  return group === undefined ? undefined : { ...group, members: group.members.slice(0, limit), memberCount };
}

/** The kinds described for one (contract, domainSep) — at most three rows, whatever the number of keys. */
export async function describedKinds(sql: Queryable, network: string, contractAddress: string, domainSep: string, schema = MIP0018_SCHEMA): Promise<number[]> {
  const s = sql(schema);
  const out: number[] = [];
  for (const kind of [1, 2, 3]) {
    const [r] = await sql<{ e: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM ${s}.mip0018_fields WHERE network = ${network} AND contract_address = ${buf(contractAddress)}
                     AND domain_sep = ${buf(domainSep)} AND kind = ${kind}) AS e`;
    if (r?.e === true) out.push(kind);
  }
  return out;
}
