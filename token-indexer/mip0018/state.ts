/**
 * UmbraDB's MIP-0018 metadata state rules — one pure module (no database, no I/O), used by the pure vector adapter
 * and, through `recordEffects` (with `fieldUsable`), `symbolGroups`, `displayAmount` and `tokenMark`, by the Postgres
 * apply path (`fields.ts`) and its read helpers (`metadata.ts`) — so both paths share every rule.
 *
 * Authority: MIP-0018 as in PR #372 (per-key tombstones), sections "Keys", "Applying records", "Common fields" and
 * "Symbol grouping": only the latest value per key, no history; groups of two or more members; a Null record deletes
 * its key's row; only defined keys are served and make an identity exist; an identity without a defined key is not
 * referenced anywhere; plus UmbraDB's ✓/⚠ marks. Classification is `classify.ts` (the vendored reference codec,
 * verbatim in `token-indexer/vendor/mip0018/codec`, plus the UTF-8 key rule); everything below is UmbraDB's own code —
 * the reference consumer is not used.
 *
 * - Applying records: accepted events in chain order (block, transaction, event, then record). A non-Null record
 *   sets its field's current value (latest wins; the replaced value is dropped, never a fallback). A Null record
 *   deletes its field; a Null for a field without a value has no effect.
 * - Keys: every key is stored, but a key is served only when it is DEFINED — a common-field key (`name`, `symbol`,
 *   `decimals`, `standards`, `image`, `image_sha256`) or a key of a standard the identity currently declares in a
 *   usable `standards` (`STANDARD_KEYS`; no MIP defines keys today). An identity exists only while a defined key has a
 *   value; without one it is absent from every listing, lookup and group, even when undefined keys remain. Dropping a
 *   standard from `standards` stops its keys counting. A later record of a defined key describes it again.
 * - Reorganization (S4): every classified event is retained per network; `rollbackTo` drops the events above a block
 *   and recomputes that network's state from the retained events (UmbraDB itself follows finalized blocks only).
 * - Lengths: a `name` keeps its first 64 and a `symbol` its first 12 characters (grapheme clusters, UAX #29, Node's
 *   `Intl.Segmenter`), cut before storing; an over-length value stays usable.
 * - Common fields: `name`/`symbol` usable when a non-empty UTF-8 string, `decimals` when an unsigned integer,
 *   `standards` when a well-formed list, `image` when a URI (type 4), `image_sha256` when exactly 32 bytes (type 0); an
 *   unusable field shows no value and never falls back; no defaults; the image keys never affect a mark.
 * - Symbol grouping: identities of one (network, contractAddress) with the same usable `symbol` bytes; only groups of
 *   two or more members are reported.
 */
import {
  type Classification,
  type DecodedRecord,
  fromHex,
  type Header,
  toHex,
  ValType,
} from "../vendor/mip0018/codec/src/index.ts";
import { classifyMip0018Event } from "./classify.ts";

// ── Common fields ────────────────────────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The common keys a token list row and a mark read (`name`, `symbol`, `decimals`, `standards`), as hex. */
export const COMMON_KEY_HEX = {
  name: toHex(enc.encode("name")),
  symbol: toHex(enc.encode("symbol")),
  decimals: toHex(enc.encode("decimals")),
  standards: toHex(enc.encode("standards")),
} as const;
/** The image keys of the common fields (`image`, `image_sha256`), as hex. Neither affects a mark. */
export const IMAGE_KEY_HEX = {
  image: toHex(enc.encode("image")),
  imageSha256: toHex(enc.encode("image_sha256")),
} as const;
/** Every key of the MIP's common fields: `name`, `symbol`, `decimals`, `standards`, `image`, `image_sha256`. */
const COMMON_KEYS: ReadonlySet<string> = new Set([...Object.values(COMMON_KEY_HEX), ...Object.values(IMAGE_KEY_HEX)]);
/** `image_sha256` is usable only as exactly this many bytes (MIP "Common fields", Testing S12). */
export const IMAGE_SHA256_BYTES = 32;

// ── Defined keys (MIP "Keys") ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Keys defined by standards: standard identifier (as declared in `standards`) → the keys (hex) that standard defines.
 * MIP "Keys": consumers MUST NOT serve a key that is neither a common field nor defined by a standard the token
 * currently declares; an event carrying such a key is still valid, and what is stored is up to the consumer.
 */
export type StandardKeys = ReadonlyMap<string, ReadonlySet<string>>;
/** The keys standards define. No MIP defines keys today; a MIP that does adds its identifier and keys here. */
export const STANDARD_KEYS: StandardKeys = new Map();

/** Every key some standard of `standardKeys` defines: the keys whose served status a `standards` change can flip. */
export function standardDefinedKeys(standardKeys: StandardKeys = STANDARD_KEYS): Set<string> {
  const out = new Set<string>();
  for (const keys of standardKeys.values()) for (const k of keys) out.add(k);
  return out;
}

/** The standards an identity currently declares: the identifiers of its usable `standards` field (none without one). */
export function declaredStandards(fields: ReadonlyMap<string, Pick<Field, "value" | "usable">>): string[] {
  const f = fields.get(COMMON_KEY_HEX.standards);
  return f?.usable === true ? (parseStandards(f.value) ?? []) : [];
}

/** Whether a key is defined for an identity that declares `declared`: a common-field key, or a key of a declared standard. */
export function isDefinedKey(keyHex: string, declared: readonly string[], standardKeys: StandardKeys = STANDARD_KEYS): boolean {
  if (COMMON_KEYS.has(keyHex)) return true;
  for (const id of declared) if (standardKeys.get(id)?.has(keyHex) === true) return true;
  return false;
}

/**
 * The fields an identity serves — its defined keys only, in their order. An identity exists only while this is not
 * empty: undefined keys are stored but never served and never make an identity exist.
 */
export function servedFields<F extends Pick<Field, "value" | "usable">>(
  fields: ReadonlyMap<string, F>, standardKeys: StandardKeys = STANDARD_KEYS,
): Map<string, F> {
  const declared = standardKeys.size === 0 ? [] : declaredStandards(fields);
  return new Map([...fields].filter(([k]) => isDefinedKey(k, declared, standardKeys)));
}

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
    case IMAGE_KEY_HEX.image:
      return valType === ValType.Uri; // an accepted type-4 value is a valid RFC 3986 URI (the codec checked it)
    case IMAGE_KEY_HEX.imageSha256:
      return valType === ValType.Bytes && value.length === IMAGE_SHA256_BYTES;
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

// ── Lengths (MIP "Common fields": `name` 1–64 and `symbol` 1–12 characters) ─────────────────────────────────────

/** The most characters a value keeps, by key hex: `name` 64, `symbol` 12 (a character is a grapheme cluster, UAX #29). */
export const MAX_CHARACTERS: Readonly<Record<string, number>> = { [COMMON_KEY_HEX.name]: 64, [COMMON_KEY_HEX.symbol]: 12 };
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** The first `max` characters (grapheme clusters, Node's `Intl.Segmenter`) of `text`; never splits a cluster. */
export function firstCharacters(text: string, max: number): string {
  if (text.length <= max) return text; // fewer UTF-16 code units than `max` means fewer clusters too
  let out = "";
  let n = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (n === max) break;
    out += segment;
    n++;
  }
  return out;
}

/**
 * A `name` or `symbol` text value (type 1) cut to its first 64 / 12 characters ("consumers SHOULD discard any extra
 * characters"); every other value unchanged. The cut happens before the value is stored, so the stored, served,
 * grouped and marked value is the cut one; a cut value stays usable.
 */
export function lengthLimited(keyHex: string, valType: number, value: Uint8Array): Uint8Array {
  const max = MAX_CHARACTERS[keyHex];
  if (max === undefined || valType !== ValType.Utf8) return value;
  const text = decodeText(value);
  if (text === undefined) return value; // not reached for an accepted event: type-1 values are valid UTF-8
  const kept = firstCharacters(text, max);
  return kept.length === text.length ? value : enc.encode(kept);
}

/** The field effects of an accepted event's records, in order (MIP "Applying records"); `name`/`symbol` cut to length. */
export function recordEffects(records: readonly DecodedRecord[]): FieldEffect[] {
  return records.map((r, record) => {
    const keyHex = toHex(r.key);
    if (r.valType === ValType.Null) return { op: "delete", record, keyHex, key: r.key };
    const value = lengthLimited(keyHex, r.valType, r.value);
    const effect: FieldEffect = { op: "set", record, keyHex, key: r.key, valType: r.valType, value };
    if (r.valType === ValType.UInt) effect.integer = r.integer;
    const usable = fieldUsable(keyHex, r.valType, value);
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
  /** Given for the keys of the common fields only. */
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
  /** Sorted by (domainSep, kind); always two or more. */
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
/** Code-unit order (locale-independent, deterministic). */
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * In-memory MIP-0018 metadata state over any number of networks. Pure: no database, no clock, no I/O. The Postgres
 * apply path keeps the same rules by applying `recordEffects` to rows, and is tested against this class.
 */
export class MetadataState {
  /** Every stored field per identity — defined and undefined keys alike (an identity is kept while it stores any). */
  private readonly identitiesByKey = new Map<string, { ref: IdentityRef; fields: Map<string, Field> }>();
  private readonly retained = new Map<string, Retained[]>();
  private readonly last = new Map<string, ChainPosition>();

  private readonly standardKeys: StandardKeys;

  /** `standardKeys`: the keys standards define (default: the MIPs' registry, empty today; tests pass synthetic ones). */
  constructor(standardKeys: StandardKeys = STANDARD_KEYS) {
    this.standardKeys = standardKeys;
  }

  /** Classifies an event with the vendored codec and, when accepted, applies its records. */
  apply(event: ObservedEvent): Classification {
    const previous = this.last.get(event.network);
    if (previous !== undefined && comparePosition(event.position, previous) <= 0)
      throw new ChainOrderError(`event at ${JSON.stringify(event.position)} does not follow ${JSON.stringify(previous)} on ${event.network}`);
    this.last.set(event.network, { ...event.position });
    const classification = classifyMip0018Event({ type: event.type, name: event.name, payload: event.payload });
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

  /**
   * Every identity that exists — at least one defined key has a value — sorted by (network, contract, domainSep, kind),
   * with its served (defined) fields only. Each `fields` is a snapshot (a copy): later events never change a map
   * already handed out.
   */
  identities(): IdentityState[] {
    return [...this.identitiesByKey.values()]
      .map(({ ref, fields }) => ({ ...ref, fields: servedFields(fields, this.standardKeys) }))
      .filter((id) => id.fields.size > 0)
      .sort((a, b) => byString(identityKey(a), identityKey(b)));
  }

  /**
   * One identity with its served fields (a snapshot), or `undefined` when no defined key has a value (then it is not
   * referenced anywhere).
   */
  identity(ref: IdentityRef): IdentityState | undefined {
    const v = this.stored(ref);
    if (v === undefined) return undefined;
    const fields = servedFields(v.fields, this.standardKeys);
    return fields.size === 0 ? undefined : { ...v.ref, fields };
  }

  /** Every field an identity stores, undefined keys included (a snapshot), or `undefined` when it stores none. Never served. */
  storedFields(ref: IdentityRef): ReadonlyMap<string, Field> | undefined {
    const v = this.stored(ref);
    return v === undefined ? undefined : new Map(v.fields);
  }

  private stored(ref: IdentityRef): { ref: IdentityRef; fields: Map<string, Field> } | undefined {
    return this.identitiesByKey.get(identityKey({ ...ref, contractAddress: ref.contractAddress.toLowerCase(), domainSep: ref.domainSep.toLowerCase() }));
  }

  /** Symbol groups of two or more members (MIP "Symbol grouping"). */
  groups(): SymbolGroup[] {
    return symbolGroups(this.identities());
  }

  /** Rejected MIP-0018 events of a contract on a network, in chain order (for the mark). */
  rejections(network: string, contractAddress: string): Rejection[] {
    const contract = contractAddress.toLowerCase();
    return (this.retained.get(network) ?? [])
      .filter((r) => r.classification.result === "reject" && r.event.contractAddress.toLowerCase() === contract)
      .map((r) => ({ position: r.event.position, reason: (r.classification as { reason: string }).reason }));
  }

  /**
   * Whether the contract has any accepted or rejected MIP-0018 event on the network — contract-level chain activity
   * only. Never an input to a mark or a listing: it stays `true` after every identity of the contract was
   * withdrawn, and a withdrawn identity must read exactly like one never described.
   */
  hasEvents(network: string, contractAddress: string): boolean {
    const contract = contractAddress.toLowerCase();
    return (this.retained.get(network) ?? []).some((r) => r.event.contractAddress.toLowerCase() === contract);
  }

  /** `raw` displayed with the identity's usable `decimals`; `undefined` when there is none (no default, MIP). */
  display(ref: IdentityRef, raw: bigint): { decimals: bigint; text: string } | undefined {
    return displayAmount(this.identity(ref)?.fields, raw);
  }
}

// ── Grouping and display (shared by `MetadataState` and the Postgres read helpers, `metadata.ts`) ───────────────

/** What symbol grouping needs from an identity: its reference and (at least) its `symbol` field. */
export interface GroupableIdentity extends IdentityRef {
  fields: ReadonlyMap<string, Pick<Field, "value" | "usable">>;
}

/**
 * The one symbol-grouping rule (MIP "Symbol grouping"): identities of one (network, contractAddress) whose
 * `symbol` is usable and has the same exact bytes form a group; only groups of two or more members are reported. An
 * identity without a usable `symbol` is ungrouped. Members sorted by (domainSep, kind); groups by (network, contract,
 * symbol). Input order does not matter.
 */
export function symbolGroups(identities: Iterable<GroupableIdentity>): SymbolGroup[] {
  const byKey = new Map<string, SymbolGroup>();
  for (const id of identities) {
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
    .map((g) => ({ ...g, members: g.members.sort((a, b) => byString(a.domainSep, b.domainSep) || a.kind - b.kind) }))
    .sort((a, b) => byString(JSON.stringify([a.network, a.contractAddress, a.symbol]), JSON.stringify([b.network, b.contractAddress, b.symbol])));
}

/**
 * The one display rule (MIP S8, "Common fields"): `raw` shown with the identity's usable `decimals`; `undefined` when
 * the identity has no fields or no usable `decimals` (no default such as 0 or 18).
 */
export function displayAmount(
  fields: ReadonlyMap<string, Pick<Field, "usable" | "integer">> | undefined, raw: bigint,
): { decimals: bigint; text: string } | undefined {
  const d = fields?.get(COMMON_KEY_HEX.decimals);
  if (d === undefined || d.usable !== true || d.integer === undefined) return undefined;
  return { decimals: d.integer, text: formatAmount(raw, d.integer) };
}

// ── Marks ──────────────────────────────────────────────────────────────────────────────────────────────────

export type MarkKind = "ok" | "partial" | "incorrect" | "unresolved" | "none";

/**
 * The reason a mark carries when the token's contract has `unresolved` logs: `log` ops whose
 * logged value the raw transaction does not show, so the contract may have published, renamed or withdrawn metadata
 * that this indexer cannot read.
 */
export const UNRESOLVED_LOG_REASON = "unresolved-log";

export interface TokenMark {
  /** ✓ ok, ⚠ partial, ⚠ incorrect, ⚠ unresolved, or no mark. */
  mark: MarkKind;
  /**
   * The reasons of the contract's rejected MIP-0018 events, in chain order (`incorrect`), followed by
   * {@link UNRESOLVED_LOG_REASON} once when the contract has unresolved logs (`unresolved`, or `incorrect` with both).
   */
  reasons: string[];
  /** `partial`: which of `name`, `symbol`, `decimals` are missing or unusable. */
  missing: Array<"name" | "symbol" | "decimals">;
  /** The usable `standards` identifiers, deduplicated in order (shown as tags; self-declared, never proof). */
  tags: string[];
}

export interface MarkInput {
  /**
   * The token's identity fields, or `undefined` when the identity has none (absent: never described or withdrawn). An
   * empty map means the same as `undefined` (one normal form).
   */
  fields: ReadonlyMap<string, Pick<Field, "valType" | "value" | "usable">> | undefined;
  /**
   * Whether the identity exists (has a defined field), when `fields` holds only some of them (the API reads only the
   * four common keys); omitted = decided from `fields`.
   */
  described?: boolean;
  /**
   * Reasons of the rejected MIP-0018 events of the token's contract (on its network), in chain order — all of them, or
   * the first ones (the mark only needs to know whether there is one; the API lists at most 100 and counts the rest).
   */
  contractRejections: readonly string[];
  /**
   * How many `unresolved` logs the token's contract has on its network (default 0): `log` ops of applied parts whose
   * logged value the raw transaction does not show (never applied).
   */
  contractUnresolvedLogs?: number;
}

/**
 * The one place that decides a token's MIP-0018 mark:
 * - ⚠ incorrect — the token's contract has a rejected MIP-0018 event (the reasons are shown);
 * - ⚠ unresolved — the token's contract has no rejected event but has an `unresolved` log: a `log` op whose value the
 *   raw transaction does not show, so the contract may have published, renamed or withdrawn metadata this indexer
 *   cannot read; the reason `unresolved-log` is shown. A ⚠ variant of its own rather than ⚠ incorrect: nothing says the
 *   contract published anything malformed, only that UmbraDB cannot verify what it published — but a token of such a
 *   contract never keeps a clean ✓;
 * - ✓ ok — the identity exists with usable `name`, `symbol` and `decimals` (the keys the MIP says issuers SHOULD
 *   publish) and its contract has no rejected event and no unresolved log;
 * - ⚠ partial — the identity exists but one of the three is missing or unusable;
 * - no mark — none of these (no MIP-0018 event, or an identity withdrawn by per-key tombstones and never revived).
 * Precedence: incorrect, then unresolved, then the identity's own fields. When the contract has both rejected events
 * and unresolved logs, the mark is ⚠ incorrect and its reasons end with `unresolved-log`.
 * The mark depends on CURRENT state only: an absent identity —
 * never described, or withdrawn — has no fields, no `missing` list and no tags, and is marked from its contract's
 * rejections and unresolved logs alone (⚠ incorrect, ⚠ unresolved, otherwise no mark); its history is never consulted.
 * Usable `standards` identifiers are returned as tags. A future standard declared in `standards` may redefine what
 * the marks mean for its tokens; none exists now, so no identifier changes the result.
 */
export function tokenMark(input: MarkInput): TokenMark {
  const described = input.described ?? (input.fields !== undefined && input.fields.size > 0);
  const fields = described ? (input.fields ?? new Map<string, Pick<Field, "valType" | "value" | "usable">>()) : undefined;
  const tags: string[] = [];
  const standards = fields?.get(COMMON_KEY_HEX.standards);
  if (standards !== undefined && standards.usable === true)
    for (const id of parseStandards(standards.value) ?? []) if (!tags.includes(id)) tags.push(id);
  const missing: TokenMark["missing"] = [];
  if (fields !== undefined)
    for (const name of ["name", "symbol", "decimals"] as const) if (fields.get(COMMON_KEY_HEX[name])?.usable !== true) missing.push(name);
  const unresolved = (input.contractUnresolvedLogs ?? 0) > 0 ? [UNRESOLVED_LOG_REASON] : [];
  if (input.contractRejections.length > 0) return { mark: "incorrect", reasons: [...input.contractRejections, ...unresolved], missing, tags };
  if (unresolved.length > 0) return { mark: "unresolved", reasons: unresolved, missing, tags };
  if (fields === undefined) return { mark: "none", reasons: [], missing: [], tags: [] };
  return { mark: missing.length === 0 ? "ok" : "partial", reasons: [], missing, tags };
}

// ── Helpers for adapters ─────────────────────────────────────────────────────────────────────────────────────────

/** Whether a key hex is a key of the common fields (the six keys the MIP defines). */
export function isCommonKey(keyHex: string): boolean {
  return COMMON_KEYS.has(keyHex);
}

/** Hex → bytes (strict; `0x` prefix allowed), re-exported so adapters need no second hex helper. */
export { fromHex, toHex };
