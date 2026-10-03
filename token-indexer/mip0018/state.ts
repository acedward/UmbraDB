/**
 * UmbraDB's MIP-0018 metadata state rules — one pure module (no database, no I/O), used by the pure vector adapter
 * and, through `recordEffects`, `fieldUsable` and `tokenMark`, by the Postgres apply path.
 *
 * Authority: MIP-0018 PR #340 head `274a84f221bcfc17e4b73e2c8b32fd8c028ea092` (per-key tombstones), sections
 * "Applying records", "Common fields" and "Symbol grouping"; owner decisions of project 00026: Q5 (only the latest
 * value per key, no history), Q6 (groups of two or more members), Q14 (marks), Q15/Q16 (a Null record deletes its
 * key's row; an identity whose last field is deleted is not referenced anywhere). Classification and decoding are the
 * vendored reference codec's (`token-indexer/vendor/mip0018/codec`, verbatim; Q2/Q17); everything below is UmbraDB's
 * own code — the reference consumer (whole-identity tombstones of `78ecbb4`) is not used.
 *
 * - Applying records: accepted events in chain order (block, transaction, event, then record). A non-Null record
 *   sets its field's current value (latest wins; the replaced value is dropped, never a fallback). A Null record
 *   deletes its field; a Null for a field without a value has no effect. An identity exists only while one of its
 *   fields has a value; with none left it is absent from every listing, lookup and group. A later record describes it
 *   again with only that field.
 * - Reorganization (S4): every classified event is retained per network; `rollbackTo` drops the events above a block
 *   and recomputes that network's state from the retained events (UmbraDB itself follows finalized blocks only).
 * - Common fields: `name`/`symbol` usable when a non-empty UTF-8 string, `decimals` when an unsigned integer,
 *   `standards` when a well-formed list; an unusable field shows no value and never falls back; no defaults.
 * - Symbol grouping: identities of one (network, contractAddress) with the same usable `symbol` bytes; only groups of
 *   two or more members are reported.
 */
import {
  type Classification,
  classifyEvent,
  type DecodedRecord,
  fromHex,
  type Header,
  toHex,
  ValType,
} from "../vendor/mip0018/codec/src/index.ts";

// ── Common fields ────────────────────────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The MIP's common keys, as hex. */
export const COMMON_KEY_HEX = {
  name: toHex(enc.encode("name")),
  symbol: toHex(enc.encode("symbol")),
  decimals: toHex(enc.encode("decimals")),
  standards: toHex(enc.encode("standards")),
} as const;
const COMMON_KEYS: ReadonlySet<string> = new Set(Object.values(COMMON_KEY_HEX));

/**
 * `standards` (MIP "Common fields"): identifiers separated by single spaces (0x20); an identifier is non-empty and has
 * no byte in 0x00–0x20 or 0x7f. An empty value is the empty list (no standards claimed). Returns `undefined` for a
 * malformed value (unusable, not empty). The value is valid UTF-8 already (a type-1 value of an accepted event).
 */
export function parseStandards(value: Uint8Array): string[] | undefined {
  if (value.length === 0) return [];
  const ids: string[] = [];
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const b = i < value.length ? (value[i] as number) : 0x20;
    if (b === 0x20) {
      if (i === start) return undefined; // an empty identifier: leading, trailing or double space
      const id = decodeText(value.subarray(start, i));
      if (id === undefined) return undefined;
      ids.push(id);
      start = i + 1;
    } else if (b < 0x20 || b === 0x7f) {
      return undefined;
    }
  }
  return ids;
}

function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Whether a field's current value is usable (MIP "Common fields"); `undefined` for a key that is not a common key
 * (the MIP gives no form to other keys). Never looks at earlier values.
 */
export function fieldUsable(keyHex: string, valType: number, value: Uint8Array): boolean | undefined {
  switch (keyHex) {
    case COMMON_KEY_HEX.name:
    case COMMON_KEY_HEX.symbol:
      return valType === ValType.Utf8 && value.length > 0;
    case COMMON_KEY_HEX.decimals:
      return valType === ValType.UInt;
    case COMMON_KEY_HEX.standards:
      return valType === ValType.Utf8 && parseStandards(value) !== undefined;
    default:
      return undefined;
  }
}

/** Above this many decimals an amount is shown in exact scientific form instead of a fixed-point string. */
export const MAX_FIXED_POINT_DECIMALS = 1000n;

/**
 * Displays a raw amount with `decimals` (MIP S8: 123456 with 2 decimals is "1234.56"). Exact (bigint); every fraction
 * digit is kept. `decimals` is not capped (it can be up to 2^248 − 1): above `MAX_FIXED_POINT_DECIMALS` the exact form
 * `<raw>e-<decimals>` is returned so that rendering stays bounded.
 */
export function formatAmount(raw: bigint, decimals: bigint): string {
  if (raw < 0n || decimals < 0n) throw new RangeError("amounts and decimals are unsigned");
  if (decimals === 0n) return raw.toString();
  if (decimals > MAX_FIXED_POINT_DECIMALS) return `${raw.toString()}e-${decimals.toString()}`;
  const d = Number(decimals);
  const digits = raw.toString().padStart(d + 1, "0");
  return `${digits.slice(0, digits.length - d)}.${digits.slice(digits.length - d)}`;
}

// ── Applying records ─────────────────────────────────────────────────────────────────────────────────────────────

/** What one record of an accepted event does to its field, in record order. */
export type FieldEffect =
  | {
      op: "set";
      record: number;
      keyHex: string;
      key: Uint8Array;
      valType: number;
      value: Uint8Array;
      /** valType 2 only: the little-endian unsigned integer. */
      integer?: bigint;
      usable?: boolean;
    }
  | { op: "delete"; record: number; keyHex: string; key: Uint8Array };

/** The field effects of an accepted event's records, in order (MIP "Applying records"). */
export function recordEffects(records: readonly DecodedRecord[]): FieldEffect[] {
  return records.map((r, record) => {
    const keyHex = toHex(r.key);
    if (r.valType === ValType.Null) return { op: "delete", record, keyHex, key: r.key };
    const effect: FieldEffect = { op: "set", record, keyHex, key: r.key, valType: r.valType, value: r.value };
    if (r.valType === ValType.UInt) effect.integer = r.integer;
    const usable = fieldUsable(keyHex, r.valType, r.value);
    if (usable !== undefined) effect.usable = usable;
    return effect;
  });
}

/** Position of an event on its network: block, transaction within the block, event within the transaction. */
export interface ChainPosition {
  block: number;
  tx: number;
  event: number;
}

function comparePosition(a: ChainPosition, b: ChainPosition): number {
  return a.block - b.block || a.tx - b.tx || a.event - b.event;
}

/** An observed `Misc`-or-other event, bound to its contract by the event record (never by the payload). */
export interface ObservedEvent {
  network: string;
  position: ChainPosition;
  /** 32-byte contract address, hex. */
  contractAddress: string;
  type: string;
  name: Uint8Array;
  payload: Uint8Array;
}

export interface IdentityRef {
  network: string;
  /** hex, lowercase */
  contractAddress: string;
  /** hex, lowercase */
  domainSep: string;
  kind: number;
}

export interface Field {
  key: Uint8Array;
  valType: number;
  value: Uint8Array;
  integer?: bigint;
  /** Given for the four common keys only. */
  usable?: boolean;
  /** Where the current value was set. */
  position: ChainPosition & { record: number };
}

export interface IdentityState extends IdentityRef {
  /** Fields by key hex; never empty (an identity without fields does not exist). */
  fields: ReadonlyMap<string, Field>;
}

export interface SymbolGroup {
  network: string;
  contractAddress: string;
  /** The exact `symbol` bytes, hex. */
  symbol: string;
  /** Sorted by (domainSep, kind); always two or more (Q6). */
  members: Array<{ domainSep: string; kind: number }>;
}

export interface Rejection {
  position: ChainPosition;
  reason: string;
}

/** Thrown when an event does not come after the previous one on its network (chain order is the caller's duty). */
export class ChainOrderError extends Error {
  override name = "ChainOrderError";
}

interface Retained {
  event: ObservedEvent;
  classification: Exclude<Classification, { result: "ignore" }>;
}

const identityKey = (r: IdentityRef): string => JSON.stringify([r.network, r.contractAddress, r.domainSep, r.kind]);

/**
 * In-memory MIP-0018 metadata state over any number of networks. Pure: no database, no clock, no I/O. The Postgres
 * apply path keeps the same rules by applying `recordEffects` to rows, and is tested against this class.
 */
export class MetadataState {
  private readonly identitiesByKey = new Map<string, { ref: IdentityRef; fields: Map<string, Field> }>();
  private readonly retained = new Map<string, Retained[]>();
  private readonly last = new Map<string, ChainPosition>();

  /** Classifies an event with the vendored codec and, when accepted, applies its records. */
  apply(event: ObservedEvent): Classification {
    const previous = this.last.get(event.network);
    if (previous !== undefined && comparePosition(event.position, previous) <= 0)
      throw new ChainOrderError(`event at ${JSON.stringify(event.position)} does not follow ${JSON.stringify(previous)} on ${event.network}`);
    this.last.set(event.network, { ...event.position });
    const classification = classifyEvent({ type: event.type, name: event.name, payload: event.payload });
    if (classification.result === "ignore") return classification;
    const list = this.retained.get(event.network) ?? [];
    list.push({ event, classification });
    this.retained.set(event.network, list);
    if (classification.result === "accept") this.applyAccepted(event, classification.header, classification.records);
    return classification;
  }

  /**
   * Removes every block above `toBlock` on `network` (MIP S4) and recomputes that network's state from the events that
   * remain. The next event on the network must be above `toBlock`.
   */
  rollbackTo(network: string, toBlock: number): void {
    const kept = (this.retained.get(network) ?? []).filter((r) => r.event.position.block <= toBlock);
    this.retained.set(network, kept);
    for (const [k, v] of this.identitiesByKey) if (v.ref.network === network) this.identitiesByKey.delete(k);
    for (const r of kept)
      if (r.classification.result === "accept")
        this.applyAccepted(r.event, r.classification.header, r.classification.records);
    this.last.set(network, { block: toBlock, tx: Number.MAX_SAFE_INTEGER, event: Number.MAX_SAFE_INTEGER });
  }

  private applyAccepted(event: ObservedEvent, header: Header, records: readonly DecodedRecord[]): void {
    const ref: IdentityRef = {
      network: event.network,
      contractAddress: event.contractAddress.toLowerCase(),
      domainSep: toHex(header.domainSep),
      kind: header.kind,
    };
    const k = identityKey(ref);
    const fields = this.identitiesByKey.get(k)?.fields ?? new Map<string, Field>();
    for (const e of recordEffects(records)) {
      if (e.op === "delete") {
        fields.delete(e.keyHex); // a Null for a key without a value changes nothing
        continue;
      }
      const f: Field = { key: e.key, valType: e.valType, value: e.value, position: { ...event.position, record: e.record } };
      if (e.integer !== undefined) f.integer = e.integer;
      if (e.usable !== undefined) f.usable = e.usable;
      fields.delete(e.keyHex); // keep insertion order = order of the current values
      fields.set(e.keyHex, f);
    }
    if (fields.size === 0) this.identitiesByKey.delete(k);
    else this.identitiesByKey.set(k, { ref, fields });
  }

  /** Every identity that currently has at least one field, sorted by (network, contract, domainSep, kind). */
  identities(): IdentityState[] {
    return [...this.identitiesByKey.values()]
      .map(({ ref, fields }) => ({ ...ref, fields }))
      .sort((a, b) => identityKey(a).localeCompare(identityKey(b)));
  }

  /** One identity, or `undefined` when it has no field (then it is not referenced anywhere). */
  identity(ref: IdentityRef): IdentityState | undefined {
    const v = this.identitiesByKey.get(identityKey({ ...ref, contractAddress: ref.contractAddress.toLowerCase(), domainSep: ref.domainSep.toLowerCase() }));
    return v === undefined ? undefined : { ...v.ref, fields: v.fields };
  }

  /** Symbol groups of two or more members (MIP "Symbol grouping", Q6). */
  groups(): SymbolGroup[] {
    const byKey = new Map<string, SymbolGroup>();
    for (const id of this.identities()) {
      const symbol = id.fields.get(COMMON_KEY_HEX.symbol);
      if (symbol === undefined || symbol.usable !== true) continue;
      const g: SymbolGroup = { network: id.network, contractAddress: id.contractAddress, symbol: toHex(symbol.value), members: [] };
      const k = JSON.stringify([g.network, g.contractAddress, g.symbol]);
      const group = byKey.get(k) ?? g;
      group.members.push({ domainSep: id.domainSep, kind: id.kind });
      byKey.set(k, group);
    }
    return [...byKey.values()]
      .filter((g) => g.members.length >= 2)
      .map((g) => ({ ...g, members: g.members.sort((a, b) => a.domainSep.localeCompare(b.domainSep) || a.kind - b.kind) }))
      .sort((a, b) => JSON.stringify([a.network, a.contractAddress, a.symbol]).localeCompare(JSON.stringify([b.network, b.contractAddress, b.symbol])));
  }

  /** Rejected MIP-0018 events of a contract on a network, in chain order (for the Q14 mark). */
  rejections(network: string, contractAddress: string): Rejection[] {
    const contract = contractAddress.toLowerCase();
    return (this.retained.get(network) ?? [])
      .filter((r) => r.classification.result === "reject" && r.event.contractAddress.toLowerCase() === contract)
      .map((r) => ({ position: r.event.position, reason: (r.classification as { reason: string }).reason }));
  }

  /** Whether the contract has any accepted or rejected MIP-0018 event on the network. */
  hasEvents(network: string, contractAddress: string): boolean {
    const contract = contractAddress.toLowerCase();
    return (this.retained.get(network) ?? []).some((r) => r.event.contractAddress.toLowerCase() === contract);
  }

  /** `raw` displayed with the identity's usable `decimals`; `undefined` when there is none (no default, MIP). */
  display(ref: IdentityRef, raw: bigint): { decimals: bigint; text: string } | undefined {
    const d = this.identity(ref)?.fields.get(COMMON_KEY_HEX.decimals);
    if (d === undefined || d.usable !== true || d.integer === undefined) return undefined;
    return { decimals: d.integer, text: formatAmount(raw, d.integer) };
  }
}

// ── Marks (Q14) ──────────────────────────────────────────────────────────────────────────────────────────────────

export type MarkKind = "ok" | "partial" | "incorrect" | "none";

export interface TokenMark {
  /** ✓ ok, ⚠ partial, ⚠ incorrect, or no mark. */
  mark: MarkKind;
  /** `incorrect`: the reasons of the contract's rejected MIP-0018 events, in chain order. */
  reasons: string[];
  /** `partial`: which of `name`, `symbol`, `decimals` are missing or unusable. */
  missing: Array<"name" | "symbol" | "decimals">;
  /** The usable `standards` identifiers, deduplicated in order (shown as tags; self-declared, never proof). */
  tags: string[];
}

export interface MarkInput {
  /** The token's identity fields, or `undefined` when the identity has none (absent: never described or withdrawn). */
  fields: ReadonlyMap<string, Pick<Field, "valType" | "value" | "usable">> | undefined;
  /** Reasons of every rejected MIP-0018 event of the token's contract (on its network), in chain order. */
  contractRejections: readonly string[];
}

/**
 * The one place that decides a token's MIP-0018 mark (Q14 (a), owner-confirmed 2026-10-02):
 * - ⚠ incorrect — the token's contract has a rejected MIP-0018 event (the reasons are shown);
 * - ✓ ok — the identity exists with usable `name`, `symbol` and `decimals` (the keys the MIP says issuers SHOULD
 *   publish) and its contract has no rejected event;
 * - ⚠ partial — the identity exists but one of the three is missing or unusable;
 * - no mark — neither (no MIP-0018 event, or an identity withdrawn by per-key tombstones and never revived).
 * Usable `standards` identifiers are returned as tags. A future standard declared in `standards` may redefine what
 * the marks mean for its tokens (Q14); none exists now, so no identifier changes the result.
 */
export function tokenMark(input: MarkInput): TokenMark {
  const fields = input.fields;
  const tags: string[] = [];
  const standards = fields?.get(COMMON_KEY_HEX.standards);
  if (standards !== undefined && standards.usable === true)
    for (const id of parseStandards(standards.value) ?? []) if (!tags.includes(id)) tags.push(id);
  const missing: TokenMark["missing"] = [];
  if (fields !== undefined)
    for (const name of ["name", "symbol", "decimals"] as const) if (fields.get(COMMON_KEY_HEX[name])?.usable !== true) missing.push(name);
  if (input.contractRejections.length > 0) return { mark: "incorrect", reasons: [...input.contractRejections], missing, tags };
  if (fields === undefined || fields.size === 0) return { mark: "none", reasons: [], missing: [], tags: [] };
  return { mark: missing.length === 0 ? "ok" : "partial", reasons: [], missing, tags };
}

// ── Helpers for adapters ─────────────────────────────────────────────────────────────────────────────────────────

/** Whether a key hex is one of the four common keys. */
export function isCommonKey(keyHex: string): boolean {
  return COMMON_KEYS.has(keyHex);
}

/** Hex → bytes (strict; `0x` prefix allowed), re-exported so adapters need no second hex helper. */
export { fromHex, toHex };
