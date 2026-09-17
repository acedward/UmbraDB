import { pad32 } from "../color.js";

/**
 * Project 00020 — the `TokenMetadata` payload parser (spec §4.2, FR-005).
 *
 * One `Misc` contract event named `pad(32, "TokenMetadata")` carries exactly 256 bytes:
 *
 * ```
 *  offset  size  field
 *       0    32  domainSep   the token within the contract (the ERC-1155 id analogue)
 *      32     1  kind        bit 0: 0 unshielded / 1 shielded; bit 1: 0 native UTxO / 1 ledger
 *      33    32  key         UTF-8 key name, NUL-padded  (pad(32, "name"))
 *      65     1  len         meaningful bytes of `value`, 0 ≤ len ≤ 190
 *      66   190  value       the value bytes, NUL-padded after `len`
 * ```
 *
 * The event NAME is the version: a future incompatible layout uses a new name
 * (`TokenMetadata2`), never a reinterpretation of this one.
 *
 * ── Two stages, on purpose ─────────────────────────────────────────────────────────────────────
 * `decodeTokenMetadata` does the structural split and never judges; `validateTokenMetadata` judges.
 * That is what lets a REJECTED event still be stored with all of its fields (`domain_sep`,
 * `kind_byte`, `key`, `len`, `value` are `NOT NULL` in `token_metadata_events`) plus a
 * `reject_reason` — a contract's malformed claim is evidence about that contract, and the page
 * shows it. Only a payload LONGER than 256 bytes cannot be decoded at all.
 *
 * ── Deliberate leniency, recorded ──────────────────────────────────────────────────────────────
 * Bytes of `value` at or after `len` are NOT checked for being NUL. Spec §4.2 says the value is
 * "NUL-padded after `len`" but does not make padding junk a rejection rule, and rejecting it would
 * turn a harmless encoder quirk into a lost description. Everything downstream uses
 * `value.subarray(0, len)` only, so trailing junk can never reach a projected field.
 *
 * ── Trailing-NUL trimming, and why a SHORT payload is padded rather than rejected ──────────────
 * The on-chain VM hands a `Log` event's bytes out with **trailing NULs trimmed**, while the event
 * itself declares its serialized length (288 for a `Misc`, i.e. 32 name + 256 payload). Since the
 * payload's `value` field is NUL-padded after `len` by construction, a real event whose value does
 * not fill 190 bytes arrives SHORT — it is not malformed, it is the same bytes with zeros removed.
 * The indexer's GraphQL `payload` field re-pads to exactly 256 (`take_bytes(b, 32, 256)`), so this
 * does not arise through that source, but the second `EventSource` the owner has planned (reading
 * the node directly) sees the untrimmed form. `decodeTokenMetadata` therefore **zero-extends** a
 * short payload to 256 and records how short it was, and only a payload LONGER than 256 is an
 * error. Whatever is stored in `token_metadata_events.payload` is the padded 256 bytes, which is
 * what the column's own CHECK requires and what re-encoding reproduces.
 *
 * ── Deliberate strictness, recorded ────────────────────────────────────────────────────────────
 * A key whose bytes are not valid UTF-8, or which contains an interior NUL, is REJECTED
 * (`key_not_utf8` / `key_interior_nul`). `token_metadata_kv.key_text` is `NOT NULL` and part of the
 * primary key, so such a key has nowhere to live; rejecting it keeps it visible as evidence
 * instead of silently dropping it.
 */

export const TOKEN_METADATA_EVENT_NAME = "TokenMetadata";
/** `pad(32, "TokenMetadata")` as lowercase unprefixed hex — what `MiscContractEvent.name` carries. */
export const TOKEN_METADATA_NAME_HEX = Buffer.from(pad32(TOKEN_METADATA_EVENT_NAME)).toString("hex");

export const PAYLOAD_SIZE = 256;
export const VALUE_SIZE = 190;
export const MAX_LEN = VALUE_SIZE;
/** Owner decision Q6: `metadata/0 … metadata/15`, 16 parts × 190 B = 3 040 B. */
export const MAX_METADATA_PARTS = 16;

export type TokenKind = "shielded" | "unshielded";
export type TokenStorage = "native" | "ledger";

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
  /** The raw 32 key bytes, padding included — stored verbatim. */
  key: Uint8Array;
  /** The key with trailing NULs trimmed, decoded as UTF-8; `undefined` when that is not possible. */
  keyText: string | undefined;
  len: number;
  /** The raw 190 value bytes, padding included — stored verbatim. */
  value: Uint8Array;
  /** `value.subarray(0, len)` — the only bytes any projection may use. */
  valueBytes: Uint8Array;
  /** Derived from `kindByte` bit 0; meaningless if the byte is invalid, which validation catches. */
  kind: TokenKind;
  /** Derived from `kindByte` bit 1. */
  storage: TokenStorage;
}

/** Every reason this parser can refuse a payload. Stored verbatim in
 *  `token_metadata_events.reject_reason`, so each one is a stable, greppable token. */
export type RejectReason =
  | "payload_size"
  | "kind_reserved_bits"
  | "len_too_large"
  | "key_not_utf8"
  | "key_interior_nul"
  | "key_empty"
  | "name_empty"
  | "name_not_utf8"
  | "symbol_empty"
  | "symbol_too_long"
  | "symbol_not_utf8"
  | "decimals_len"
  | "decimals_range"
  | "metadata_too_short"
  | "metadata_not_json_object"
  | "metadata_part_index"
  | "token_uri_empty"
  | "token_uri_not_absolute_http";

export class PayloadSizeError extends Error {
  readonly reason = "payload_size" as const;
  constructor(readonly size: number) {
    super(`TokenMetadata payload must be at most ${PAYLOAD_SIZE} bytes, got ${size}`);
    this.name = "PayloadSizeError";
  }
}

/** True iff a `MiscContractEvent.name` (unprefixed hex) is this standard's event name. */
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
  const domainSep = payload.subarray(0, 32);
  const kindByte = payload[32]!;
  const key = payload.subarray(33, 65);
  const len = payload[65]!;
  const value = payload.subarray(66, 256);
  return {
    payload,
    paddedFrom,
    domainSep,
    kindByte,
    key,
    keyText: decodeKeyText(key),
    len,
    value,
    // `len` may exceed VALUE_SIZE on a malformed payload; clamp so the slice is always valid and
    // validation, not a range error, is what reports the problem.
    valueBytes: value.subarray(0, Math.min(len, VALUE_SIZE)),
    kind: (kindByte & 0b1) === 1 ? "shielded" : "unshielded",
    storage: (kindByte & 0b10) === 0b10 ? "ledger" : "native",
  };
}

/** The key with trailing NULs trimmed, as UTF-8; `undefined` if that is not a valid, NUL-free
 *  UTF-8 string. Strict UTF-8: `TextDecoder` with `fatal: true`, so lone surrogates and invalid
 *  sequences are refused rather than replaced by U+FFFD. */
function decodeKeyText(key: Uint8Array): string | undefined {
  let end = key.length;
  while (end > 0 && key[end - 1] === 0) end -= 1;
  const trimmed = key.subarray(0, end);
  if (trimmed.includes(0)) return undefined;
  return decodeUtf8(trimmed);
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** `metadata/<n>` → `n`, or `undefined` for any other key. `<n>` must be plain decimal with no
 *  leading zeros (so `metadata/01` is a distinct, invalid key rather than a second `metadata/1`). */
export function metadataPartIndex(keyText: string): number | undefined {
  const match = /^metadata\/(0|[1-9][0-9]*)$/.exec(keyText);
  if (match === null) return undefined;
  return Number(match[1]);
}

/**
 * Every rejection rule of spec §4.2, applied in a fixed order so a payload that breaks two rules
 * always reports the same one. Returns `undefined` when the event is applicable.
 */
export function validateTokenMetadata(decoded: DecodedTokenMetadata): RejectReason | undefined {
  // Bits 2-7 are reserved; a set bit rejects the event (§4.2). Values 0..3 only.
  if ((decoded.kindByte & 0b1111_1100) !== 0) return "kind_reserved_bits";
  if (decoded.len > MAX_LEN) return "len_too_large";
  if (decoded.keyText === undefined) {
    // Distinguish the two causes so the page can say which.
    let end = decoded.key.length;
    while (end > 0 && decoded.key[end - 1] === 0) end -= 1;
    return decoded.key.subarray(0, end).includes(0) ? "key_interior_nul" : "key_not_utf8";
  }
  if (decoded.keyText.length === 0) return "key_empty";

  const text = (): string | undefined => decodeUtf8(decoded.valueBytes);

  switch (decoded.keyText) {
    case "name":
      if (decoded.len < 1) return "name_empty";
      if (text() === undefined) return "name_not_utf8";
      return undefined;
    case "symbol":
      if (decoded.len < 1) return "symbol_empty";
      if (decoded.len > 32) return "symbol_too_long";
      if (text() === undefined) return "symbol_not_utf8";
      return undefined;
    case "decimals":
      if (decoded.len !== 1) return "decimals_len";
      if (decoded.value[0]! > 36) return "decimals_range";
      return undefined;
    case "metadata": {
      if (decoded.len < 2) return "metadata_too_short";
      const body = text();
      if (body === undefined || !isJsonObject(body)) return "metadata_not_json_object";
      return undefined;
    }
    case "tokenUri": {
      if (decoded.len < 1) return "token_uri_empty";
      const uri = text();
      if (uri === undefined || !isAbsoluteHttpUrl(uri)) return "token_uri_not_absolute_http";
      return undefined;
    }
    default: {
      const part = metadataPartIndex(decoded.keyText);
      if (decoded.keyText.startsWith("metadata/")) {
        // A `metadata/…` key that is not a well-formed part index is a malformed claim, not an
        // anonymous trait — otherwise `metadata/01` would quietly become an unrelated trait and
        // the JSON it belongs to would never assemble.
        if (part === undefined || part >= MAX_METADATA_PARTS) return "metadata_part_index";
        return undefined;
      }
      // Any other key is a trait (EIP-7496): stored verbatim, never validated, never projected.
      return undefined;
    }
  }
}

/** A JSON **object** — not an array, not a scalar. Spec §4.2: "parses as a JSON object". */
export function isJsonObject(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

/** An absolute `http(s)://` URL, which is what §4.2 requires of `tokenUri`. */
export function isAbsoluteHttpUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

export interface ParsedTokenMetadata extends DecodedTokenMetadata {
  applied: boolean;
  rejectReason: RejectReason | undefined;
  /** Non-`undefined` exactly when the key is a well-known UTF-8 one and the event was applied. */
  valueText: string | undefined;
}

/**
 * Decode + validate in one call — what the event lookup uses. Throws {@link PayloadSizeError} for
 * a payload of the wrong length (nothing can be stored for it); every other failure comes back as
 * `applied: false` with a reason, and the caller stores the row anyway.
 */
export function parseTokenMetadata(payload: Uint8Array): ParsedTokenMetadata {
  const decoded = decodeTokenMetadata(payload);
  const rejectReason = validateTokenMetadata(decoded);
  return {
    ...decoded,
    applied: rejectReason === undefined,
    rejectReason,
    valueText: rejectReason === undefined ? decodeUtf8(decoded.valueBytes) : undefined,
  };
}

/** The keys this standard projects into `tokens` columns. Everything else stays a trait. */
export const WELL_KNOWN_KEYS = ["name", "symbol", "decimals", "metadata", "tokenUri"] as const;
export type WellKnownKey = (typeof WELL_KNOWN_KEYS)[number];

export function isWellKnownKey(keyText: string): keyText is WellKnownKey {
  return (WELL_KNOWN_KEYS as readonly string[]).includes(keyText);
}

/**
 * Builds a 256-byte payload — the encoder side of the same layout. Used by the golden tests and by
 * the fixture generator; having the encoder here rather than in a test file is what makes
 * "encode(decode(x)) == x" a property the module itself guarantees.
 */
export function encodeTokenMetadata(fields: {
  domainSep: Uint8Array;
  kindByte: number;
  key: Uint8Array | string;
  len?: number;
  value: Uint8Array | string;
}): Uint8Array {
  const out = new Uint8Array(PAYLOAD_SIZE);
  if (fields.domainSep.length !== 32) throw new Error("domainSep must be 32 bytes");
  out.set(fields.domainSep, 0);
  out[32] = fields.kindByte;
  const key = typeof fields.key === "string" ? pad32(fields.key) : fields.key;
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  out.set(key, 33);
  const value = typeof fields.value === "string" ? new TextEncoder().encode(fields.value) : fields.value;
  if (value.length > VALUE_SIZE) throw new Error(`value must be at most ${VALUE_SIZE} bytes`);
  out[65] = fields.len ?? value.length;
  out.set(value, 66);
  return out;
}
