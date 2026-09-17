import { pad32 } from "../color.js";

/**
 * Project 00021 — the `mip-xxxx:token-metadata[v1]` payload parser (MIP PR #315 §§1, 2, 2.1, 2.2,
 * 3, 5.1; spec `00021-mip-315-alignment.md` FR-101/FR-102).
 *
 * One `Misc` contract event named `pad(32, "mip-xxxx:token-metadata[v1]")` carries exactly 256
 * bytes (MIP §2):
 *
 * ```
 *  offset  size  field
 *       0    32  domainSep   the token within the contract (the ERC-1155 id analogue)
 *      32     1  kind        0 unshielded native, 1 shielded native, 2 unshielded ledger,
 *                            3 shielded ledger — the FULL byte is part of the token identity
 *      33    32  key         UTF-8 key name, NUL-padded; compared after trimming trailing NULs
 *      65     1  val-type    0 opaque, 1 UTF-8 string, 2 unsigned big-endian integer,
 *                            3 UTF-8 JSON, 4 UTF-8 URI, 5..255 reserved
 *      66     1  val-len     meaningful bytes of `value`, 0 ≤ val-len ≤ 189
 *      67   189  value       the value bytes; bytes at or after `val-len` carry no meaning
 * ```
 *
 * The event NAME is the version (MIP §8): a future incompatible layout uses a new name
 * (`mip-xxxx:token-metadata[v2]`, or a fresh MIP's own name), never a reinterpretation of this one.
 *
 * ── The `xxxx` placeholder (spec D1/D12) ───────────────────────────────────────────────────────
 * `xxxx` is the four-digit MIP number, assigned when PR #315 is merged; the MIP says "the final
 * string is fixed at that point and this document is updated once". {@link TOKEN_METADATA_EVENT_NAME}
 * below is the ONE place this repository spells it, so the assignment is a one-line change here —
 * and a redeployment of every contract, since the name is a circuit literal on their side.
 *
 * ── The 00020 name is IGNORED, not rejected (MIP §1, spec Q1) ──────────────────────────────────
 * MIP §1: "Any other event MUST be ignored by a `TokenMetadata` consumer." The pre-MIP events this
 * project shipped under the name `TokenMetadata` are therefore not recognised at all: they are not
 * stored, not rejected and not counted as evidence. There is no legacy alias; `ingest/events.ts`
 * simply never hands them to this module.
 *
 * ── Two stages, on purpose ─────────────────────────────────────────────────────────────────────
 * {@link decodeTokenMetadata} does the structural split and never judges; {@link validateTokenMetadata}
 * judges, and only against the TRANSPORT rules of MIP §2.1/§2.2/§3/§5.1. That is what lets a
 * REJECTED event still be stored with all of its fields plus a stable `reject_reason` — a
 * contract's malformed claim is evidence about that contract, and the page shows it. Only a
 * payload LONGER than 256 bytes cannot be decoded at all.
 *
 * ── Appendix A is a PROJECTION rule, never a rejection rule (MIP §5.3, spec D7/FR-105) ─────────
 * A well-known key carrying the wrong `val-type`, or a value that breaks Appendix A's rule for it,
 * does NOT reject the event: the trait is stored verbatim (MIP §5.2) and the projection is flagged
 * with a {@link ProjectionError}. {@link projectionErrorFor} is that check, and it is deliberately
 * separate from {@link validateTokenMetadata} so the two can never be confused.
 *
 * ── Deliberate leniency, recorded ──────────────────────────────────────────────────────────────
 * Bytes of `value` at or after `val-len` are NOT checked for being NUL: MIP §2.2 says consumers
 * MUST ignore them and emitters SHOULD zero them — a SHOULD on the emitter is not a rejection rule
 * for the consumer. Everything downstream uses `value.subarray(0, val-len)` only.
 *
 * ── Trailing-NUL trimming, and why a SHORT payload is padded rather than rejected ──────────────
 * The on-chain VM hands a `Log` event's bytes out with **trailing NULs trimmed**, while the event
 * itself declares its serialized length. Since `value` is NUL-padded after `val-len` by
 * construction, a real event whose value does not fill 189 bytes arrives SHORT — it is not
 * malformed, it is the same bytes with zeros removed. The indexer's GraphQL `payload` field re-pads
 * to exactly 256, so this does not arise through that source, but the node-direct `EventSource` the
 * owner has planned sees the untrimmed form. {@link decodeTokenMetadata} therefore **zero-extends**
 * a short payload to 256 and records how short it was; only a payload LONGER than 256 is an error.
 *
 * ── Keys are bytes (MIP §5.1, spec D5) ─────────────────────────────────────────────────────────
 * "Keys SHOULD be valid UTF-8; consumers MUST NOT reject a key solely for not being valid UTF-8
 * (they MAY display it as hex)." So the key's identity is {@link DecodedTokenMetadata.keyHex} — the
 * trimmed bytes — and `keyText` is a convenience that is `undefined` when those bytes are not a
 * NUL-free valid UTF-8 string. An interior NUL keeps the key (it is part of the bytes) but not its
 * text: Postgres `text` cannot hold a NUL, and a key that cannot be spelled cannot be well-known.
 */

/**
 * The event name, spelled ONCE (spec D1/D12). `xxxx` is the placeholder for the MIP number that
 * PR #315 will be assigned; when it is assigned this literal changes here, the reference contracts
 * are recompiled and redeployed, and nothing else in this repository moves.
 */
export const TOKEN_METADATA_EVENT_NAME = "mip-xxxx:token-metadata[v1]";

/** `pad(32, TOKEN_METADATA_EVENT_NAME)` as lowercase unprefixed hex — what `MiscContractEvent.name`
 *  carries: 27 name bytes followed by 5 NULs (MIP §1). */
export const TOKEN_METADATA_NAME_HEX = Buffer.from(pad32(TOKEN_METADATA_EVENT_NAME)).toString("hex");

/** U+0000 as a string, built rather than written: a literal NUL byte in a source file makes the
 *  file binary to `grep` and invisible to half the tooling. */
const NUL = String.fromCharCode(0);

export const PAYLOAD_SIZE = 256;
/** Payload offsets, from MIP §2's table — spelled out so the decoder reads as the table does. */
export const OFFSET_DOMAIN_SEP = 0;
export const OFFSET_KIND = 32;
export const OFFSET_KEY = 33;
export const OFFSET_VAL_TYPE = 65;
export const OFFSET_VAL_LEN = 66;
export const OFFSET_VALUE = 67;
export const VALUE_SIZE = 189;
/** `val-len > 189` rejects (MIP §2.2). */
export const MAX_VAL_LEN = VALUE_SIZE;
/** `val-type` 2 carries an unsigned big-endian integer of `1 ≤ val-len ≤ 16` bytes (MIP §2.1). */
export const MAX_INTEGER_BYTES = 16;
/** Appendix A: `metadata/<n>` with `n ≤ 15` — 16 parts of at most 189 bytes each. */
export const MAX_METADATA_PARTS = 16;
/** Appendix A's cap on an assembled `metadata/<n>` document: 16 × 189 = 3 024 bytes. */
export const MAX_METADATA_BYTES = MAX_METADATA_PARTS * VALUE_SIZE;

/** The privacy half of the `kind` byte (MIP §3): which tag the value carries. */
export type TokenPrivacy = "shielded" | "unshielded";
/** The storage half of the `kind` byte (MIP §3): protocol UTXOs, or balances in contract state. */
export type TokenStorage = "native" | "ledger";
/** The four values MIP §3 defines; anything else rejects the event. */
export type TokenKindByte = 0 | 1 | 2 | 3;
/** MIP §2.1's closed enum. 5..255 are reserved and reject. */
export type ValType = 0 | 1 | 2 | 3 | 4;

export const KIND_UNSHIELDED_NATIVE = 0;
export const KIND_SHIELDED_NATIVE = 1;
export const KIND_UNSHIELDED_LEDGER = 2;
export const KIND_SHIELDED_LEDGER = 3;
export const KIND_BYTES: readonly TokenKindByte[] = [0, 1, 2, 3];
export const MAX_VAL_TYPE = 4;

/** True for the four values of MIP §3 and nothing else. */
export function isKindByte(kind: number): kind is TokenKindByte {
  return Number.isInteger(kind) && kind >= 0 && kind <= 3;
}

/** MIP §3: bit 0 is the privacy tag. */
export function privacyOfKind(kind: number): TokenPrivacy {
  return (kind & 0b1) === 1 ? "shielded" : "unshielded";
}

/** MIP §3: bit 1 is where the value lives. */
export function storageOfKind(kind: number): TokenStorage {
  return (kind & 0b10) === 0b10 ? "ledger" : "native";
}

/** Only kinds 0 and 1 have a colour, a mint effect, or any chance of being observed (MIP §3, §6.3). */
export function isNativeKind(kind: number): boolean {
  return storageOfKind(kind) === "native";
}

/** The kind byte as the page and the CLI print it: `1` → `shielded · native`. */
export function kindLabel(kind: number): string {
  return `${privacyOfKind(kind)} · ${storageOfKind(kind)}`;
}

/** A mint effect map is always native, and names the privacy (MIP §6.3): kind 0 or kind 1. */
export function kindOfMint(privacy: TokenPrivacy): 0 | 1 {
  return privacy === "shielded" ? KIND_SHIELDED_NATIVE : KIND_UNSHIELDED_NATIVE;
}

export interface DecodedTokenMetadata {
  /** The payload as decoded: exactly 256 bytes, zero-extended if the source delivered it with its
   *  trailing NULs trimmed. This is what gets stored. */
  payload: Uint8Array;
  /** The length the source actually delivered, when it was shorter than 256 — evidence that the
   *  trailing-NUL trimming happened, and `undefined` for a full-width payload. */
  paddedFrom: number | undefined;
  /** 32 bytes. */
  domainSep: Uint8Array;
  kindByte: number;
  /** The raw 32 key bytes, padding included — stored verbatim on the event row. */
  key: Uint8Array;
  /** The key with trailing NULs trimmed: its IDENTITY under MIP §5.1. */
  keyBytes: Uint8Array;
  /** `keyBytes` as lowercase hex — the primary-key form, since a key need not be text at all. */
  keyHex: string;
  /** `keyBytes` decoded as UTF-8; `undefined` when they are not a NUL-free valid UTF-8 string. */
  keyText: string | undefined;
  valType: number;
  valLen: number;
  /** The raw 189 value bytes, padding included — stored verbatim on the event row. */
  value: Uint8Array;
  /** `value.subarray(0, val-len)` — the only bytes any consumer may read (MIP §2.2). */
  valueBytes: Uint8Array;
  /** Derived from the kind byte; meaningless if the byte is invalid, which validation catches. */
  privacy: TokenPrivacy;
  storage: TokenStorage;
}

/**
 * Every reason this parser can refuse a payload — MIP §2.2 and §3 and nothing else (spec FR-102).
 * Stored verbatim in `token_metadata_events.reject_reason`, so each one is a stable, greppable
 * token. Appendix A failures are NOT here: they are {@link ProjectionError}s and never reject.
 */
export type RejectReason =
  | "payload_size"
  | "kind_unknown"
  | "key_empty"
  | "val_type_reserved"
  | "val_len_too_long"
  | "val_type_rule";

/**
 * Why a well-known key of Appendix A could not be projected into its column. The event is applied
 * and the trait is stored regardless (MIP §5.3); this is the flag beside it.
 */
export type ProjectionError =
  | "val_type_mismatch"
  | "name_len"
  | "symbol_len"
  | "decimals_len"
  | "decimals_range"
  | "metadata_len"
  | "metadata_not_json_object"
  | "metadata_part_index"
  | "token_uri_not_absolute_http"
  | "text_not_storable";

export class PayloadSizeError extends Error {
  readonly reason = "payload_size" as const;
  constructor(readonly size: number) {
    super(`token-metadata payload must be at most ${PAYLOAD_SIZE} bytes, got ${size}`);
    this.name = "PayloadSizeError";
  }
}

/** True iff a `MiscContractEvent.name` (unprefixed hex) is this MIP's event name (MIP §1). */
export function isTokenMetadataName(nameHex: string): boolean {
  return nameHex.toLowerCase() === TOKEN_METADATA_NAME_HEX;
}

/**
 * Structural decode. A payload SHORTER than 256 bytes is zero-extended (see the header: the VM
 * trims trailing NULs, and every short payload is a full one with zeros removed). A payload LONGER
 * than 256 throws {@link PayloadSizeError} — the one failure that leaves nothing storable, since
 * `token_metadata_events.payload` is `CHECK (octet_length(payload) = 256)` and truncating would
 * store bytes the chain never carried.
 */
export function decodeTokenMetadata(raw: Uint8Array): DecodedTokenMetadata {
  if (raw.length > PAYLOAD_SIZE) throw new PayloadSizeError(raw.length);
  let payload = raw;
  let paddedFrom: number | undefined;
  if (raw.length < PAYLOAD_SIZE) {
    paddedFrom = raw.length;
    payload = new Uint8Array(PAYLOAD_SIZE);
    payload.set(raw, 0);
  }
  const domainSep = payload.subarray(OFFSET_DOMAIN_SEP, OFFSET_KIND);
  const kindByte = payload[OFFSET_KIND]!;
  const key = payload.subarray(OFFSET_KEY, OFFSET_VAL_TYPE);
  const keyBytes = trimTrailingNuls(key);
  const valType = payload[OFFSET_VAL_TYPE]!;
  const valLen = payload[OFFSET_VAL_LEN]!;
  const value = payload.subarray(OFFSET_VALUE, PAYLOAD_SIZE);
  return {
    payload,
    paddedFrom,
    domainSep,
    kindByte,
    key,
    keyBytes,
    keyHex: Buffer.from(keyBytes).toString("hex"),
    keyText: keyTextOf(keyBytes),
    valType,
    valLen,
    value,
    // `val-len` may exceed VALUE_SIZE on a malformed payload; clamp so the slice is always valid
    // and validation, not a range error, is what reports the problem.
    valueBytes: value.subarray(0, Math.min(valLen, VALUE_SIZE)),
    privacy: privacyOfKind(kindByte),
    storage: storageOfKind(kindByte),
  };
}

/** MIP §5.1: "Trailing NUL bytes are trimmed from `key`, then the remaining bytes are compared
 *  exactly." Only TRAILING ones — an interior NUL is part of the key. */
export function trimTrailingNuls(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.subarray(0, end);
}

/** The trimmed key as text, or `undefined` when it is not a NUL-free valid UTF-8 string — in which
 *  case the key is still perfectly valid (MIP §5.1) and lives on as its hex. */
export function keyTextOf(keyBytes: Uint8Array): string | undefined {
  if (keyBytes.includes(0)) return undefined;
  return decodeUtf8(keyBytes);
}

/** Strict UTF-8: `TextDecoder` with `fatal: true`, so lone surrogates and invalid sequences are
 *  refused rather than replaced by U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** `metadata/<n>` → `n`, or `undefined` for any other key. `<n>` must be plain decimal with no
 *  leading zeros (so `metadata/01` is a distinct key rather than a second `metadata/1`). */
export function metadataPartIndex(keyText: string): number | undefined {
  const match = /^metadata\/(0|[1-9][0-9]*)$/.exec(keyText);
  if (match === null) return undefined;
  return Number(match[1]);
}

/**
 * MIP §2.1's per-type rule for `value`. A value that breaks it REJECTS the event (§2.2) — this is
 * transport validation, not Appendix A.
 */
export function valueMatchesType(valType: number, valLen: number, valueBytes: Uint8Array): boolean {
  switch (valType) {
    case 0:
      return true; // opaque bytes: no rule at all
    case 1:
      return decodeUtf8(valueBytes) !== undefined;
    case 2:
      return valLen >= 1 && valLen <= MAX_INTEGER_BYTES;
    case 3:
      // "valid UTF-8; the parse rule (object, array, part) is the key's to state" — so JSON-ness
      // is NOT a transport rule. `metadata`'s own rule lives in Appendix A.
      return decodeUtf8(valueBytes) !== undefined;
    case 4: {
      const text = decodeUtf8(valueBytes);
      return text !== undefined && isAbsoluteUri(text);
    }
    default:
      return false; // unreachable: a reserved type is rejected before this is asked
  }
}

/**
 * Every rejection rule of MIP §2.2, §2.1 and §3, applied in PAYLOAD-OFFSET order so a payload that
 * breaks two rules always reports the same one: `kind` (32) → `key` (33) → `val-type` (65) →
 * `val-len` (66) → `value` (67). Returns `undefined` when the event is applicable.
 */
export function validateTokenMetadata(decoded: DecodedTokenMetadata): RejectReason | undefined {
  if (!isKindByte(decoded.kindByte)) return "kind_unknown";
  if (decoded.keyBytes.length === 0) return "key_empty";
  if (decoded.valType > MAX_VAL_TYPE) return "val_type_reserved";
  if (decoded.valLen > MAX_VAL_LEN) return "val_len_too_long";
  if (!valueMatchesType(decoded.valType, decoded.valLen, decoded.valueBytes)) return "val_type_rule";
  return undefined;
}

/**
 * Appendix A's rule for one stored key/value, or `undefined` when there is nothing to complain
 * about — which includes every key Appendix A does not name (a trait has no rule to break).
 *
 * `text_not_storable` is this repository's own addition and is not an Appendix A rule: a value
 * that is valid UTF-8 but contains a NUL cannot go into a Postgres `text` column, so it is kept as
 * a trait (bytes) and flagged rather than crashing the fold.
 */
export function projectionErrorFor(
  keyText: string | undefined, valType: number, valLen: number, valueBytes: Uint8Array,
): ProjectionError | undefined {
  if (keyText === undefined) return undefined; // a key with no text can never be well-known
  const storableText = (): ProjectionError | undefined => {
    const text = decodeUtf8(valueBytes);
    return text === undefined || text.includes(NUL) ? "text_not_storable" : undefined;
  };

  switch (keyText) {
    case "name":
      if (valType !== 1) return "val_type_mismatch";
      if (valLen < 1 || valLen > 189) return "name_len";
      return storableText();
    case "symbol":
      if (valType !== 1) return "val_type_mismatch";
      if (valLen < 1 || valLen > 32) return "symbol_len";
      return storableText();
    case "decimals":
      if (valType !== 2) return "val_type_mismatch";
      if (valLen !== 1) return "decimals_len";
      if (valueBytes[0]! > 36) return "decimals_range";
      return undefined;
    case "metadata": {
      if (valType !== 3) return "val_type_mismatch";
      if (valLen < 2) return "metadata_len";
      const bad = storableText();
      if (bad !== undefined) return bad;
      return isJsonObject(decodeUtf8(valueBytes)!) ? undefined : "metadata_not_json_object";
    }
    case "tokenUri": {
      if (valType !== 4) return "val_type_mismatch";
      if (valLen < 1 || valLen > 189) return "token_uri_not_absolute_http";
      const bad = storableText();
      if (bad !== undefined) return bad;
      return isAbsoluteHttpUrl(decodeUtf8(valueBytes)!) ? undefined : "token_uri_not_absolute_http";
    }
    default: {
      if (!keyText.startsWith("metadata/")) return undefined; // an ordinary trait: no rule
      const part = metadataPartIndex(keyText);
      // `metadata/01` or `metadata/99` is a malformed part name, not an anonymous trait: the
      // document it claims to belong to would otherwise never assemble and nobody would be told.
      if (part === undefined || part >= MAX_METADATA_PARTS) return "metadata_part_index";
      // Every part must be type 3 (spec §2 edge case): a part of another type is a trait under its
      // own key and the assembly waits.
      if (valType !== 3) return "val_type_mismatch";
      return storableText();
    }
  }
}

/** A JSON **object** — not an array, not a scalar. Appendix A: "parses as a JSON object". */
export function isJsonObject(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

/** MIP §2.1 type 4: "parses as an absolute URI" — any scheme, which is weaker than Appendix A's
 *  `tokenUri` rule on purpose. `new URL` without a base accepts exactly the absolute forms. */
export function isAbsoluteUri(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** Appendix A's `tokenUri` rule: an absolute `http(s)://` URL. */
export function isAbsoluteHttpUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/** `val-type` 2's value as a decimal string — up to 16 big-endian bytes, so `bigint` and never a
 *  JSON number (2^128 does not survive a double). */
export function integerOfValue(valueBytes: Uint8Array): string {
  let out = 0n;
  for (const byte of valueBytes) out = (out << 8n) | BigInt(byte);
  return out.toString(10);
}

/** How a consumer renders an accepted value it does not otherwise understand (MIP §5.2): text for
 *  the textual types, `undefined` for an integer (use {@link integerOfValue}) and for opaque bytes. */
export function valueTextOf(valType: number, valueBytes: Uint8Array): string | undefined {
  if (valType !== 1 && valType !== 3 && valType !== 4) return undefined;
  return decodeUtf8(valueBytes);
}

export interface ParsedTokenMetadata extends DecodedTokenMetadata {
  applied: boolean;
  rejectReason: RejectReason | undefined;
  /** Appendix A's verdict on this key/value, when the event was applied: `undefined` means the
   *  value may be projected into its column. Never a rejection (MIP §5.3). */
  projectionError: ProjectionError | undefined;
  /** The value as text for `val-type` 1/3/4, when the event was applied and the bytes decode. */
  valueText: string | undefined;
}

/**
 * Decode + validate in one call — what the event lookup uses. Throws {@link PayloadSizeError} for a
 * payload longer than 256 bytes (nothing can be stored for it); every other transport failure comes
 * back as `applied: false` with a reason, and the caller stores the row anyway.
 */
export function parseTokenMetadata(payload: Uint8Array): ParsedTokenMetadata {
  const decoded = decodeTokenMetadata(payload);
  const rejectReason = validateTokenMetadata(decoded);
  const applied = rejectReason === undefined;
  return {
    ...decoded,
    applied,
    rejectReason,
    projectionError: applied
      ? projectionErrorFor(decoded.keyText, decoded.valType, decoded.valLen, decoded.valueBytes)
      : undefined,
    valueText: applied ? valueTextOf(decoded.valType, decoded.valueBytes) : undefined,
  };
}

/** The Appendix A keys this consumer projects into `tokens` columns. Everything else stays a
 *  trait (MIP §5.2), and `metadata/<n>` is handled by {@link metadataPartIndex}. */
export const WELL_KNOWN_KEYS = ["name", "symbol", "decimals", "metadata", "tokenUri"] as const;
export type WellKnownKey = (typeof WELL_KNOWN_KEYS)[number];

export function isWellKnownKey(keyText: string): keyText is WellKnownKey {
  return (WELL_KNOWN_KEYS as readonly string[]).includes(keyText);
}

/** Appendix A's `val-type` for each key it names — what an emitter SHOULD use and what a consumer
 *  checks before projecting. */
export const WELL_KNOWN_VAL_TYPES: Readonly<Record<WellKnownKey, ValType>> = {
  name: 1, symbol: 1, decimals: 2, metadata: 3, tokenUri: 4,
};

/**
 * Builds a 256-byte payload — the encoder side of the same layout. Used by the tests and by the
 * fixture tooling; having the encoder here rather than in a test file is what makes
 * "encode(decode(x)) == x" a property the module itself guarantees.
 *
 * `valType` and `valLen` are explicit so a test can build a payload no honest emitter would (a
 * reserved type, a length past the field) without the encoder second-guessing it.
 */
export function encodeTokenMetadata(fields: {
  domainSep: Uint8Array;
  kindByte: number;
  key: Uint8Array | string;
  valType: number;
  valLen?: number;
  value: Uint8Array | string;
}): Uint8Array {
  const out = new Uint8Array(PAYLOAD_SIZE);
  if (fields.domainSep.length !== 32) throw new Error("domainSep must be 32 bytes");
  out.set(fields.domainSep, OFFSET_DOMAIN_SEP);
  out[OFFSET_KIND] = fields.kindByte;
  const key = typeof fields.key === "string" ? pad32(fields.key) : fields.key;
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  out.set(key, OFFSET_KEY);
  const value = typeof fields.value === "string" ? new TextEncoder().encode(fields.value) : fields.value;
  if (value.length > VALUE_SIZE) throw new Error(`value must be at most ${VALUE_SIZE} bytes`);
  out[OFFSET_VAL_TYPE] = fields.valType;
  out[OFFSET_VAL_LEN] = fields.valLen ?? value.length;
  out.set(value, OFFSET_VALUE);
  return out;
}

/** The big-endian bytes of an unsigned integer, for `val-type` 2 — the encoder's companion. */
export function encodeInteger(value: bigint | number, byteLength = 1): Uint8Array {
  let rest = BigInt(value);
  const out = new Uint8Array(byteLength);
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new Error(`${value} does not fit in ${byteLength} bytes`);
  return out;
}
