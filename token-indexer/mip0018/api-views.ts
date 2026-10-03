/**
 * Queries and JSON shapes of the MIP-0018 read-only API (project 00026, sub-plan C1; the contract is
 * `token-indexer/API.md`). Every function reads through the caller's `Queryable` — the API passes one read-only
 * REPEATABLE READ transaction per request, so all parts of one answer come from one database state.
 *
 * Rules are never decided here: fields, groups, display and marks come from the B3 read helpers (`metadata.ts`) and
 * the pure state module (`state.ts`: `tokenMark`, `displayAmount`, `parseStandards`); colors and NIGHT/DUST from the
 * A3 read helpers (`tokens.ts`). This module only selects rows and shapes JSON:
 *
 * - "Not referenced after withdrawal" (MIP `274a84f` "Applying records"): identities come from the field rows (B3)
 *   and the mint table only, so a withdrawn identity is shown exactly as if it had never been described.
 * - Events (mid-project audit QA2 (a), Q15, Q19): the event query selects position, contract, classification and
 *   reason of `accept`/`reject` rows only — the stored name, payload and header are never read by the API.
 * - Never fetches anything; heights only.
 */
import { MIP0018_SCHEMA } from "../../src/postgres/migrations/mip0018/index.js";
import type { ActivityItem } from "./activity.ts";
import type { Queryable } from "./fields.ts";
import { contractRejections, getIdentity, groupOf, listGroups, listIdentities } from "./metadata.ts";
import {
  COMMON_KEY_HEX,
  displayAmount,
  type Field,
  type IdentityRef,
  type IdentityState,
  parseStandards,
  type SymbolGroup,
  tokenMark,
} from "./state.ts";
import { type BuiltinToken, builtinTokens, lookupColor } from "./tokens.ts";

/** MIP-0018 text UmbraDB implements (PR #340 head, per-key tombstones). */
export const MIP_COMMIT = "274a84f221bcfc17e4b73e2c8b32fd8c028ea092";
/** The reference commit the codec, vectors and runner are vendored from (`token-indexer/vendor/mip0018/SOURCE.md`). */
export const VENDORED_REFERENCE = { repository: "https://github.com/midnight-experiments/mip-0018", commit: "daec1f19747b09f4e245885ab0dd9ecc789a82ce" } as const;
/** Genesis hashes of the networks this indexer knows (Q8: Stagenet only; verified by the D1 capture). */
export const KNOWN_GENESIS: Readonly<Record<string, string>> = {
  stagenet: "0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491",
};
/** At most this many rejection reasons are listed in a mark (all are counted in `reasonCount`; all are in the events). */
export const MAX_MARK_REASONS = 100;

export interface ViewContext {
  sql: Queryable;
  network: string;
  schema: string;
  archiveSchema: string;
}

// ── JSON shapes ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface PositionJson { height: number; txIndex: number; txHash: string }
export interface MintStatsJson { firstMint: PositionJson; mints: number; amount: string; amountDisplay: string | null }
export interface MarkJson { mark: "ok" | "partial" | "incorrect" | "none"; reasons: string[]; reasonCount: number; missing: string[]; tags: string[] }
export interface CommonJson { name: string | null; symbol: string | null; decimals: string | null; standards: string[] | null }
export interface BytesJson { hex: string; utf8: string | null }
export interface FieldJson {
  key: BytesJson;
  valType: number;
  valTypeName: string;
  value: { hex: string; text?: string; integer?: string };
  usable: boolean | null;
  updatedAt: { height: number; txIndex: number; eventIndex: number; record: number };
}
export interface GroupJson { symbol: BytesJson; members: Array<{ domainSep: string; kind: number }> }
export type KindName = "shielded" | "unshielded" | "ledger";
export interface TokenSummaryJson {
  id: string;
  source: "builtin" | "identity" | "seen";
  kind: number | null;
  kindName: KindName | null;
  color: string | null;
  contractAddress: string | null;
  domainSep: string | null;
  name: string | null;
  symbol: string | null;
  decimals: string | null;
  described: boolean;
  minted: MintStatsJson | null;
  firstSeen: PositionJson | null;
  evidence: string[];
  mark: MarkJson | null;
  note: string | null;
}
export interface IdentityDetailJson {
  network: string;
  contractAddress: string;
  domainSep: string;
  kind: number;
  kindName: KindName;
  color: string | null;
  minted: MintStatsJson | null;
  described: boolean;
  common: CommonJson;
  fields: FieldJson[];
  group: GroupJson | null;
  mark: MarkJson;
}
export interface BuiltinJson { symbol: string; name: string; decimals: string; color: string | null; note: string }
export interface Page<T> { items: T[]; nextCursor: string | null }

// ── Byte views ───────────────────────────────────────────────────────────────────────────────────────────────────

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const buf = (h: string): Buffer => Buffer.from(h, "hex");
const VAL_TYPE_NAMES = ["bytes", "utf8", "uint", "json", "uri"] as const;
const KIND_NAMES: Record<number, KindName> = { 1: "shielded", 2: "unshielded", 3: "ledger" };

/** Strict UTF-8 text of `bytes`, or `null` when they are not valid UTF-8 (then only the hex is served). */
export function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

const bytesJson = (b: Uint8Array): BytesJson => ({ hex: hexOf(b), utf8: utf8OrNull(b) });

/** One current field: hex always; a text view for the text types, an integer view for type 2 — never another type. */
export function fieldJson(f: Field): FieldJson {
  const value: FieldJson["value"] = { hex: hexOf(f.value) };
  if (f.valType === 1 || f.valType === 3 || f.valType === 4) {
    const text = utf8OrNull(f.value);
    if (text !== null) value.text = text;
  } else if (f.valType === 2 && f.integer !== undefined) {
    value.integer = f.integer.toString();
  }
  return {
    key: bytesJson(f.key),
    valType: f.valType,
    valTypeName: VAL_TYPE_NAMES[f.valType] ?? "reserved",
    value,
    usable: f.usable ?? null,
    updatedAt: { height: f.position.block, txIndex: f.position.tx, eventIndex: f.position.event, record: f.position.record },
  };
}

/** The usable common fields only (MIP "Common fields": no fallback, no default). */
export function commonJson(fields: ReadonlyMap<string, Field> | undefined): CommonJson {
  const usable = (key: keyof typeof COMMON_KEY_HEX): Field | undefined => {
    const f = fields?.get(COMMON_KEY_HEX[key]);
    return f !== undefined && f.usable === true ? f : undefined;
  };
  const text = (key: "name" | "symbol"): string | null => {
    const f = usable(key);
    return f === undefined ? null : utf8OrNull(f.value);
  };
  const decimals = usable("decimals");
  const standards = usable("standards");
  return {
    name: text("name"),
    symbol: text("symbol"),
    decimals: decimals?.integer === undefined ? null : decimals.integer.toString(),
    standards: standards === undefined ? null : (parseStandards(standards.value) ?? null),
  };
}

/** The Q14 mark of a token from its current fields and its contract's rejection reasons (`state.ts` `tokenMark`). */
export function markJson(fields: ReadonlyMap<string, Field> | undefined, reasons: readonly string[]): MarkJson {
  const m = tokenMark({ fields, contractRejections: reasons });
  return { mark: m.mark, reasons: m.reasons.slice(0, MAX_MARK_REASONS), reasonCount: m.reasons.length, missing: [...m.missing], tags: [...m.tags] };
}

export const groupJson = (g: SymbolGroup): GroupJson => ({ symbol: bytesJson(buf(g.symbol)), members: g.members.map((m) => ({ ...m })) });

const builtinJson = (b: BuiltinToken): BuiltinJson => ({ symbol: b.symbol, name: b.name, decimals: String(b.decimals), color: b.color ?? null, note: b.note });

// ── Cursors (opaque, bound to their endpoint and filter) ─────────────────────────────────────────────────────────

export const encodeCursor = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/** Decodes a cursor this API issued; `undefined` for anything else (the caller answers 400). */
export function decodeCursor(raw: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(raw)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    return encodeCursor(value) === raw ? value : undefined; // canonical form only
  } catch {
    return undefined;
  }
}

const isHex32 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isKind = (v: unknown): v is number => v === 1 || v === 2 || v === 3;

/** Token-list cursor: the section (0 NIGHT/DUST, 1 identities, 2 seen colors) and the last key returned in it. */
export type TokensCursor = { e: "tokens"; s: 0; k: [string] } | { e: "tokens"; s: 1; k: [string, string, number] } | { e: "tokens"; s: 2; k: [string] };

export function parseTokensCursor(v: unknown): TokensCursor | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const c = v as { e?: unknown; s?: unknown; k?: unknown };
  if (c.e !== "tokens" || !Array.isArray(c.k) || Object.keys(c).length !== 3) return undefined;
  if (c.s === 0 && c.k.length === 1 && (c.k[0] === "NIGHT" || c.k[0] === "DUST")) return c as TokensCursor;
  if (c.s === 1 && c.k.length === 3 && isHex32(c.k[0]) && isHex32(c.k[1]) && isKind(c.k[2])) return c as TokensCursor;
  if (c.s === 2 && c.k.length === 1 && isHex32(c.k[0])) return c as TokensCursor;
  return undefined;
}

export interface ContractTokensCursor { e: "contract-tokens"; c: string; k: [string, number] }

export function parseContractTokensCursor(v: unknown, contract: string): ContractTokensCursor | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const c = v as { e?: unknown; c?: unknown; k?: unknown };
  if (c.e !== "contract-tokens" || c.c !== contract || !Array.isArray(c.k) || c.k.length !== 2 || Object.keys(c).length !== 3) return undefined;
  return isHex32(c.k[0]) && isKind(c.k[1]) ? (c as ContractTokensCursor) : undefined;
}

export interface EventFilter { contract?: string; tx?: string }
export interface EventsCursor { e: "events"; f: [string | null, string | null]; k: [number, number, number] }

export function parseEventsCursor(v: unknown, filter: EventFilter): EventsCursor | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const c = v as { e?: unknown; f?: unknown; k?: unknown };
  if (c.e !== "events" || !Array.isArray(c.f) || !Array.isArray(c.k) || Object.keys(c).length !== 3) return undefined;
  if (c.f.length !== 2 || c.f[0] !== (filter.contract ?? null) || c.f[1] !== (filter.tx ?? null)) return undefined;
  return c.k.length === 3 && c.k.every(isUint) ? (c as EventsCursor) : undefined;
}

// ── Mints and sightings ──────────────────────────────────────────────────────────────────────────────────────────

interface MintAgg { color: string; contractAddress: string; domainSep: string; kind: number; mints: number; amount: string; first: PositionJson }

const identityKey = (contract: string, domainSep: string, kind: number): string => `${contract}/${domainSep}/${kind}`;

/** Mint aggregates per (contract, domainSep, kind) of the given contracts (optionally one domainSep / kind). */
async function mintAggregates(ctx: ViewContext, contracts: readonly string[], only?: { domainSep?: string; kind?: number }): Promise<Map<string, MintAgg>> {
  const out = new Map<string, MintAgg>();
  if (contracts.length === 0) return out;
  const { sql } = ctx;
  const rows = await sql<{
    color: Buffer; contract_address: Buffer; domain_sep: Buffer; kind: number; mints: number; amount: string;
    block_height: bigint; tx_index: number; tx_hash: Buffer;
  }[]>`
    SELECT DISTINCT ON (contract_address, domain_sep, kind)
           color, contract_address, domain_sep, kind, (count(*) OVER w)::int AS mints, (sum(amount) OVER w)::text AS amount,
           block_height, tx_index, tx_hash
    FROM ${sql(ctx.schema)}.mip0018_mints
    WHERE network = ${ctx.network}
      AND contract_address IN (SELECT decode(h, 'hex') FROM unnest(${sql.array([...contracts])}::text[]) AS h)
      ${only?.domainSep === undefined ? sql`` : sql`AND domain_sep = ${buf(only.domainSep)}`}
      ${only?.kind === undefined ? sql`` : sql`AND kind = ${only.kind}`}
    WINDOW w AS (PARTITION BY contract_address, domain_sep, kind)
    ORDER BY contract_address, domain_sep, kind, block_height, tx_index, mint_index`;
  for (const r of rows) {
    const a: MintAgg = {
      color: hexOf(r.color), contractAddress: hexOf(r.contract_address), domainSep: hexOf(r.domain_sep), kind: r.kind,
      mints: r.mints, amount: r.amount, first: { height: Number(r.block_height), txIndex: r.tx_index, txHash: hexOf(r.tx_hash) },
    };
    out.set(identityKey(a.contractAddress, a.domainSep, a.kind), a);
  }
  return out;
}

function mintStatsJson(m: MintAgg, fields: ReadonlyMap<string, Field> | undefined): MintStatsJson {
  return { firstMint: m.first, mints: m.mints, amount: m.amount, amountDisplay: displayAmount(fields, BigInt(m.amount))?.text ?? null };
}

interface Seen { color: string; firstSeen: PositionJson; evidence: string[] }

/**
 * Colors seen in public data: one color, or (`unmintedAfter`) a page of the colors with no indexed mint, by color.
 * `firstSeen` is the first sighting; `evidence` the kinds of public data that showed the color.
 */
async function sightings(ctx: ViewContext, o: { color?: string; unminted?: boolean; after?: string; limit?: number }): Promise<Seen[]> {
  const { sql } = ctx;
  const s = sql(ctx.schema);
  const rows = await sql<{ color: Buffer; h: bigint; i: number; x: Buffer; evidence: string[] }[]>`
    SELECT c.color,
           (array_agg(c.block_height ORDER BY c.block_height, c.tx_index))[1] AS h,
           (array_agg(c.tx_index ORDER BY c.block_height, c.tx_index))[1] AS i,
           (array_agg(c.tx_hash ORDER BY c.block_height, c.tx_index))[1] AS x,
           array_agg(DISTINCT c.evidence ORDER BY c.evidence) AS evidence
    FROM ${s}.mip0018_color_sightings c
    WHERE c.network = ${ctx.network}
      ${o.color === undefined ? sql`` : sql`AND c.color = ${buf(o.color)}`}
      ${o.after === undefined ? sql`` : sql`AND c.color > ${buf(o.after)}`}
      ${o.unminted === true ? sql`AND NOT EXISTS (SELECT 1 FROM ${s}.mip0018_mints m WHERE m.network = c.network AND m.color = c.color)` : sql``}
    GROUP BY c.color ORDER BY c.color
    ${o.limit === undefined ? sql`` : sql`LIMIT ${o.limit}`}`;
  return rows.map((r) => ({ color: hexOf(r.color), firstSeen: { height: Number(r.h), txIndex: r.i, txHash: hexOf(r.x) }, evidence: [...r.evidence] }));
}

// ── Identities ───────────────────────────────────────────────────────────────────────────────────────────────────

interface IdKey { contractAddress: string; domainSep: string; kind: number }

/** Identities that are described (field rows) or minted (mint table), in (contract, domainSep, kind) byte order. */
async function identityKeys(ctx: ViewContext, o: { contract?: string; after?: [string, string, number]; limit: number }): Promise<IdKey[]> {
  const { sql } = ctx;
  const s = sql(ctx.schema);
  const rows = await sql<{ contract_address: Buffer; domain_sep: Buffer; kind: number }[]>`
    SELECT contract_address, domain_sep, kind FROM (
      SELECT contract_address, domain_sep, kind FROM ${s}.mip0018_fields WHERE network = ${ctx.network}
      UNION
      SELECT contract_address, domain_sep, kind FROM ${s}.mip0018_mints WHERE network = ${ctx.network}
    ) ids
    WHERE TRUE
      ${o.contract === undefined ? sql`` : sql`AND contract_address = ${buf(o.contract)}`}
      ${o.after === undefined ? sql`` : sql`AND (contract_address, domain_sep, kind) > (${buf(o.after[0])}, ${buf(o.after[1])}, ${o.after[2]}::smallint)`}
    ORDER BY contract_address, domain_sep, kind
    LIMIT ${o.limit}`;
  return rows.map((r) => ({ contractAddress: hexOf(r.contract_address), domainSep: hexOf(r.domain_sep), kind: r.kind }));
}

/** List rows for the given identities (their current fields, mints and marks). */
async function identitySummaries(ctx: ViewContext, keys: readonly IdKey[]): Promise<TokenSummaryJson[]> {
  const contracts = [...new Set(keys.map((k) => k.contractAddress))];
  const mints = await mintAggregates(ctx, contracts);
  const reasons = new Map<string, string[]>();
  for (const c of contracts) reasons.set(c, (await contractRejections(ctx.sql, ctx.network, c, ctx.schema)).map((r) => r.reason));
  const out: TokenSummaryJson[] = [];
  for (const k of keys) {
    const identity = await getIdentity(ctx.sql, { network: ctx.network, ...k }, ctx.schema);
    const mint = mints.get(identityKey(k.contractAddress, k.domainSep, k.kind));
    const common = commonJson(identity?.fields);
    out.push({
      id: `identity/${k.contractAddress}/${k.domainSep}/${k.kind}`,
      source: "identity",
      kind: k.kind,
      kindName: KIND_NAMES[k.kind] ?? null,
      color: mint?.color ?? null,
      contractAddress: k.contractAddress,
      domainSep: k.domainSep,
      name: common.name,
      symbol: common.symbol,
      decimals: common.decimals,
      described: identity !== undefined,
      minted: mint === undefined ? null : mintStatsJson(mint, identity?.fields),
      firstSeen: null,
      evidence: [],
      mark: markJson(identity?.fields, reasons.get(k.contractAddress) ?? []),
      note: null,
    });
  }
  return out;
}

/**
 * One identity in full, or `undefined` when it is neither described nor minted (a withdrawn, never-minted identity
 * included: it is not referenced). `known` = the caller resolved it through the mint table (a lookup), so it is
 * answered even without a mint of that kind; `color` is then the held color.
 */
export async function identityDetail(ctx: ViewContext, ref: IdKey, o: { known?: { color: string } } = {}): Promise<IdentityDetailJson | undefined> {
  const full: IdentityRef = { network: ctx.network, ...ref };
  const identity: IdentityState | undefined = await getIdentity(ctx.sql, full, ctx.schema);
  const mint = ref.kind === 3 ? undefined : (await mintAggregates(ctx, [ref.contractAddress], { domainSep: ref.domainSep, kind: ref.kind })).get(identityKey(ref.contractAddress, ref.domainSep, ref.kind));
  if (identity === undefined && mint === undefined && o.known === undefined) return undefined;
  const reasons = (await contractRejections(ctx.sql, ctx.network, ref.contractAddress, ctx.schema)).map((r) => r.reason);
  const group = identity === undefined ? undefined : await groupOf(ctx.sql, full, ctx.schema);
  return {
    network: ctx.network,
    contractAddress: ref.contractAddress,
    domainSep: ref.domainSep,
    kind: ref.kind,
    kindName: KIND_NAMES[ref.kind]!,
    color: mint?.color ?? o.known?.color ?? null,
    minted: mint === undefined ? null : mintStatsJson(mint, identity?.fields),
    described: identity !== undefined,
    common: commonJson(identity?.fields),
    fields: identity === undefined ? [] : [...identity.fields.values()].map(fieldJson),
    group: group === undefined ? null : groupJson(group),
    mark: markJson(identity?.fields, reasons),
  };
}

// ── Endpoints ────────────────────────────────────────────────────────────────────────────────────────────────────

const BUILTIN_ORDER = ["NIGHT", "DUST"] as const;

function builtinSummary(b: BuiltinToken): TokenSummaryJson {
  return {
    id: `builtin/${b.symbol}`, source: "builtin", kind: null, kindName: null, color: b.color ?? null, contractAddress: null, domainSep: null,
    name: b.name, symbol: b.symbol, decimals: String(b.decimals), described: false, minted: null, firstSeen: null, evidence: [], mark: null, note: b.note,
  };
}

function seenSummary(s: Seen): TokenSummaryJson {
  return {
    id: `color/${s.color}`, source: "seen", kind: null, kindName: null, color: s.color, contractAddress: null, domainSep: null,
    name: null, symbol: null, decimals: null, described: false, minted: null, firstSeen: s.firstSeen, evidence: s.evidence,
    mark: markJson(undefined, []), note: null,
  };
}

/** `GET /v1/tokens`: NIGHT, DUST, then identities by (contract, domainSep, kind), then seen-only colors by color. */
export async function tokensPage(ctx: ViewContext, limit: number, cursor: TokensCursor | undefined): Promise<Page<TokenSummaryJson>> {
  const want = limit + 1;
  const rows: Array<{ item: TokenSummaryJson; cursor: TokensCursor }> = [];
  const section = cursor?.s ?? 0;
  if (section === 0) {
    const builtins = await builtinTokens(ctx.sql, ctx.network, ctx.schema);
    const start = cursor === undefined ? 0 : BUILTIN_ORDER.indexOf(cursor.k[0] as "NIGHT" | "DUST") + 1;
    for (const symbol of BUILTIN_ORDER.slice(start)) {
      const b = builtins.find((x) => x.symbol === symbol);
      if (b !== undefined && rows.length < want) rows.push({ item: builtinSummary(b), cursor: { e: "tokens", s: 0, k: [symbol] } });
    }
  }
  if (rows.length < want && section <= 1) {
    const keys = await identityKeys(ctx, { limit: want - rows.length, ...(cursor?.s === 1 ? { after: cursor.k } : {}) });
    const items = await identitySummaries(ctx, keys);
    items.forEach((item, i) => {
      const k = keys[i]!;
      rows.push({ item, cursor: { e: "tokens", s: 1, k: [k.contractAddress, k.domainSep, k.kind] } });
    });
  }
  if (rows.length < want) {
    const seen = await sightings(ctx, { unminted: true, limit: want - rows.length, ...(cursor?.s === 2 ? { after: cursor.k[0] } : {}) });
    for (const s of seen) rows.push({ item: seenSummary(s), cursor: { e: "tokens", s: 2, k: [s.color] } });
  }
  const page = rows.slice(0, limit);
  return { items: page.map((r) => r.item), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.cursor) : null };
}

export interface TokenByColorJson {
  color: string;
  builtin: BuiltinJson | null;
  contractAddress: string | null;
  domainSep: string | null;
  firstSeen: PositionJson | null;
  evidence: string[];
  identities: IdentityDetailJson[];
  related: Array<{ contractAddress: string; domainSep: string; kind: number }>;
}

/** `GET /v1/tokens/{color}`; `undefined` = no such color in the indexed range (404). */
export async function tokenByColor(ctx: ViewContext, color: string): Promise<TokenByColorJson | undefined> {
  const builtin = (await builtinTokens(ctx.sql, ctx.network, ctx.schema)).find((b) => b.color === color);
  if (builtin !== undefined)
    return { color, builtin: builtinJson(builtin), contractAddress: null, domainSep: null, firstSeen: null, evidence: [], identities: [], related: [] };
  const [found, seen] = await Promise.all([lookupColor(ctx.sql, ctx.network, color, ctx.schema), sightings(ctx, { color })]);
  const entry = found.entry;
  const sighting = seen[0];
  if (entry === undefined && sighting === undefined) return undefined;
  const firsts = [sighting?.firstSeen, entry?.shielded?.firstMint, entry?.unshielded?.firstMint].filter((p): p is PositionJson => p !== undefined);
  firsts.sort((a, b) => a.height - b.height || a.txIndex - b.txIndex);
  const out: TokenByColorJson = {
    color, builtin: null, contractAddress: entry?.contractAddress ?? null, domainSep: entry?.domainSep ?? null,
    firstSeen: firsts[0] ?? null, evidence: sighting?.evidence ?? [], identities: [], related: [],
  };
  if (entry !== undefined) {
    for (const kind of [1, 2]) {
      const d = await identityDetail(ctx, { contractAddress: entry.contractAddress, domainSep: entry.domainSep, kind });
      if (d !== undefined) out.identities.push(d);
    }
    const shown = new Set(out.identities.map((d) => d.kind));
    for (const id of await listIdentities(ctx.sql, ctx.network, { contractAddress: entry.contractAddress, domainSep: entry.domainSep }, ctx.schema))
      if (!shown.has(id.kind)) out.related.push({ contractAddress: id.contractAddress, domainSep: id.domainSep, kind: id.kind });
  }
  return out;
}

export interface ContractTokensJson extends Page<TokenSummaryJson> { contractAddress: string; groups: GroupJson[] }

/** Whether the scan saw the contract: an applied call, deploy or update, a mint, or a current field. */
async function contractKnown(ctx: ViewContext, contract: string): Promise<boolean> {
  const { sql } = ctx;
  const s = sql(ctx.schema);
  const address = buf(contract);
  const [known] = await sql<{ known: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM ${s}.mip0018_contract_actions WHERE network = ${ctx.network} AND contract_address = ${address})
        OR EXISTS (SELECT 1 FROM ${s}.mip0018_mints WHERE network = ${ctx.network} AND contract_address = ${address})
        OR EXISTS (SELECT 1 FROM ${s}.mip0018_fields WHERE network = ${ctx.network} AND contract_address = ${address}) AS known`;
  return known?.known === true;
}

/** `GET /v1/contracts/{address}/tokens`; `undefined` = the scan never saw the contract (404). */
export async function contractTokens(ctx: ViewContext, contract: string, limit: number, cursor: ContractTokensCursor | undefined): Promise<ContractTokensJson | undefined> {
  const { sql } = ctx;
  if (!(await contractKnown(ctx, contract))) return undefined;
  const keys = await identityKeys(ctx, { contract, limit: limit + 1, ...(cursor === undefined ? {} : { after: [contract, cursor.k[0], cursor.k[1]] as [string, string, number] }) });
  const page = keys.slice(0, limit);
  const last = page[page.length - 1];
  return {
    contractAddress: contract,
    groups: (await listGroups(sql, ctx.network, { contractAddress: contract }, ctx.schema)).map(groupJson),
    items: await identitySummaries(ctx, page),
    nextCursor: keys.length > limit && last !== undefined ? encodeCursor({ e: "contract-tokens", c: contract, k: [last.domainSep, last.kind] } satisfies ContractTokensCursor) : null,
  };
}

// ── Activity (sub-plan C2's rows and read helpers) ──────────────────────────────────────────────────────────────

/** Paging of the activity listings: C2's helpers validate the cursor (bound to its listing and order). */
export interface ActivityOptions { limit: number; cursor?: string; order?: "asc" | "desc" }

/** One activity row as C2's `activityItem` shapes it (wallets as Bech32m, bytes as hex, heights only). */
export type ActivityItemJson = ActivityItem;

export interface TokenActivityJson extends Page<ActivityItemJson> {
  color: string;
  /** The contract that minted the color (its metadata transactions are part of the listing), or `null`. */
  contractAddress: string | null;
}

export interface ContractActivityJson extends Page<ActivityItemJson> { contractAddress: string }

/** C2's module, loaded on first use (it imports ledger-v9; an API-only process loads it only for activity). */
const activityModule = () => import("./activity.ts");

/**
 * `GET /v1/tokens/{color}/activity`: the color's transactions (mint, UTXOs created/spent, contract in/out, offer
 * deltas) and the metadata transactions of its minting contract (Q26/A16), keyset-paginated; `undefined` = the color
 * is not known in the indexed range (404, as `/v1/tokens/{color}`).
 */
export async function tokenActivity(ctx: ViewContext, color: string, o: ActivityOptions): Promise<TokenActivityJson | undefined> {
  const builtin = (await builtinTokens(ctx.sql, ctx.network, ctx.schema)).some((b) => b.color === color);
  if (!builtin && !(await lookupColor(ctx.sql, ctx.network, color, ctx.schema)).found && (await sightings(ctx, { color })).length === 0) return undefined;
  const { activityForColor } = await activityModule();
  const p = await activityForColor(ctx.sql, ctx.network, color, o, ctx.schema);
  return { color, contractAddress: p.contract ?? null, items: p.items, nextCursor: p.nextCursor ?? null };
}

/**
 * `GET /v1/contracts/{address}/activity`: the contract's metadata transactions (one row per transaction with accepted
 * or rejected MIP-0018 events: counts and the event-log position, never values) — the activity of a kind-3 identity,
 * which has no color. `undefined` = the scan never saw the contract (404).
 */
export async function contractActivity(ctx: ViewContext, contract: string, o: ActivityOptions): Promise<ContractActivityJson | undefined> {
  if (!(await contractKnown(ctx, contract))) return undefined;
  const { metadataTransactionsForContract } = await activityModule();
  const p = await metadataTransactionsForContract(ctx.sql, ctx.network, contract, o, ctx.schema);
  return { contractAddress: contract, items: p.items, nextCursor: p.nextCursor ?? null };
}

export interface ScanRange { from: number; to: number }

/** The scan's range: first height and last scanned height (`undefined` before the first scanned block). */
async function scanRange(ctx: ViewContext): Promise<{ from: number; indexed: number | null } | undefined> {
  const { sql } = ctx;
  const [exists] = await sql<{ t: string | null }[]>`SELECT to_regclass(${`${ctx.schema}.mip0018_scan`})::text AS t`;
  if (exists?.t === null || exists?.t === undefined) return undefined;
  const [r] = await sql<{ from_height: bigint; next_height: bigint }[]>`
    SELECT from_height, next_height FROM ${sql(ctx.schema)}.mip0018_scan WHERE network = ${ctx.network}`;
  if (r === undefined) return undefined;
  return { from: Number(r.from_height), indexed: r.next_height > r.from_height ? Number(r.next_height) - 1 : null };
}

export interface LookupJson {
  color: string;
  held: "shielded" | "unshielded";
  found: boolean;
  result: "identity" | "builtin" | "not-minted-in-indexed-range";
  builtin: BuiltinJson | null;
  identity: IdentityDetailJson | null;
  seen: { firstSeen: PositionJson; evidence: string[] } | null;
  indexedRange: ScanRange | null;
}

/** `GET /v1/lookup/{color}?held=…` (MIP "Lookup": color → (contract, domainSep) through the mint table; kind from the holding). */
export async function lookup(ctx: ViewContext, color: string, held: "shielded" | "unshielded"): Promise<LookupJson> {
  const range = await scanRange(ctx);
  const base = {
    color, held, builtin: null, identity: null, seen: null,
    indexedRange: range === undefined || range.indexed === null ? null : { from: range.from, to: range.indexed },
  };
  const builtin = (await builtinTokens(ctx.sql, ctx.network, ctx.schema)).find((b) => b.color === color);
  if (builtin !== undefined) return { ...base, found: true, result: "builtin", builtin: builtinJson(builtin) };
  const { entry } = await lookupColor(ctx.sql, ctx.network, color, ctx.schema);
  if (entry === undefined) {
    const [s] = await sightings(ctx, { color });
    return { ...base, found: false, result: "not-minted-in-indexed-range", seen: s === undefined ? null : { firstSeen: s.firstSeen, evidence: s.evidence } };
  }
  const kind = held === "shielded" ? 1 : 2;
  const identity = await identityDetail(ctx, { contractAddress: entry.contractAddress, domainSep: entry.domainSep, kind }, { known: { color } });
  return { ...base, found: true, result: "identity", identity: identity ?? null };
}

export interface EventJson {
  height: number;
  txIndex: number;
  txHash: string;
  eventIndex: number;
  segment: number | null;
  phase: string | null;
  contractAddress: string;
  /** `unresolved` (final-audit F1): a `log` op whose logged value the raw transaction does not show; never applied. */
  classification: "accept" | "reject" | "unresolved";
  reason: string | null;
}

/**
 * `GET /v1/events`: MIP-0018-named events (accept/reject) and unresolved logs of a contract and/or a transaction, in
 * chain order. The query selects only position, contract, classification and reason (QA2 (a)): the stored name,
 * payload and header never leave the database through the API.
 */
export async function eventsPage(ctx: ViewContext, filter: EventFilter, limit: number, cursor: EventsCursor | undefined): Promise<Page<EventJson>> {
  const { sql } = ctx;
  const rows = await sql<{
    block_height: bigint; tx_index: number; event_index: number; tx_hash: Buffer | null; segment_id: number | null; phase: string | null;
    contract_address: Buffer; classification: EventJson["classification"]; reason: string | null;
  }[]>`
    SELECT block_height, tx_index, event_index, tx_hash, segment_id, phase, contract_address, classification, reason
    FROM ${sql(ctx.schema)}.mip0018_events
    WHERE network = ${ctx.network} AND classification IN ('accept', 'reject', 'unresolved')
      ${filter.contract === undefined ? sql`` : sql`AND contract_address = ${buf(filter.contract)}`}
      ${filter.tx === undefined ? sql`` : sql`AND tx_hash = ${buf(filter.tx)}`}
      ${cursor === undefined ? sql`` : sql`AND (block_height, tx_index, event_index) > (${cursor.k[0]}::bigint, ${cursor.k[1]}::int, ${cursor.k[2]}::int)`}
    ORDER BY block_height, tx_index, event_index
    LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map((r): EventJson => ({
    height: Number(r.block_height), txIndex: r.tx_index, txHash: r.tx_hash === null ? "" : hexOf(r.tx_hash), eventIndex: r.event_index,
    segment: r.segment_id, phase: r.phase, contractAddress: hexOf(r.contract_address), classification: r.classification, reason: r.reason,
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ e: "events", f: [filter.contract ?? null, filter.tx ?? null], k: [last.height, last.txIndex, last.eventIndex] } satisfies EventsCursor)
      : null,
  };
}

export type ScannerState = "following" | "stalled" | "off";

export interface StatusJson {
  network: string;
  genesisHash: string | null;
  startHeight: number | null;
  indexedHeight: number | null;
  archiveHeight: number | null;
  mip: { id: "MIP-0018"; commit: string };
  vendored: { repository: string; commit: string };
  scanner: ScannerState;
  /**
   * `log` ops whose logged value the raw transaction does not show (final-audit F1): stored as `unresolved`, never
   * applied; a contract's metadata may differ from what the ledger emitted while it has any. `null` before the scan's
   * schema exists.
   */
  unresolvedEvents: number | null;
}

/** `GET /v1/status`. */
export async function status(ctx: ViewContext, genesisHash: string | null, scanner: ScannerState): Promise<StatusJson> {
  const { sql } = ctx;
  const range = await scanRange(ctx);
  let archiveHeight: number | null = null;
  const [wm] = await sql<{ t: string | null }[]>`SELECT to_regclass(${`${ctx.archiveSchema}.watermarks`})::text AS t`;
  if (wm?.t !== null && wm?.t !== undefined) {
    const [r] = await sql<{ value: { height?: unknown } | null }[]>`
      SELECT value FROM ${sql(ctx.archiveSchema)}.watermarks WHERE kind = 'chain_archive' AND key = ${`sync_cursor:${ctx.network}`}`;
    const h = r?.value?.height;
    if (typeof h === "number" && Number.isSafeInteger(h)) archiveHeight = h;
  }
  let unresolvedEvents: number | null = null;
  if (range !== undefined) {
    const [u] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(ctx.schema)}.mip0018_events WHERE network = ${ctx.network} AND classification = 'unresolved'`;
    unresolvedEvents = u?.n ?? 0;
  }
  return {
    network: ctx.network,
    genesisHash,
    startHeight: range?.from ?? null,
    indexedHeight: range?.indexed ?? null,
    archiveHeight,
    mip: { id: "MIP-0018", commit: MIP_COMMIT },
    vendored: { ...VENDORED_REFERENCE },
    scanner,
    unresolvedEvents,
  };
}

/** Default schemas (the scan's and the chain archive's). */
export const DEFAULT_SCHEMAS = { schema: MIP0018_SCHEMA, archiveSchema: "chain_archive" } as const;
