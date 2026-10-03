// MIP-0018 constants (pinned text: midnightntwrk/midnight-improvement-proposals@78ecbb4b, "Event", "Payload",
// "Value types", "Token identity and authority").

/** The event name text; the 32-byte name is this text followed by zero bytes. */
export const EVENT_NAME_TEXT = 'mip-0018:token-metadata[v1]';

/** `pad(32, "mip-0018:token-metadata[v1]")`. */
export const EVENT_NAME: Uint8Array = (() => {
  const name = new Uint8Array(32);
  name.set(new TextEncoder().encode(EVENT_NAME_TEXT), 0);
  return name;
})();

/** MIP-0002 event type that carries MIP-0018 events. */
export const MISC_EVENT_TYPE = 'Misc';

export const NAME_SIZE = 32;
export const PAYLOAD_SIZE = 256;
export const HEADER_SIZE = 33;
export const DOMAIN_SEP_SIZE = 32;
export const KIND_OFFSET = 32;
export const RECORDS_OFFSET = 33;
/** The largest value: 256 − 33 (header) − 3 (keyLen, valType, valLen) − 1 (shortest key). */
export const MAX_VALUE_SIZE = 219;

export const ValType = {
  Bytes: 0,
  Utf8: 1,
  UInt: 2,
  Json: 3,
  Uri: 4,
  Null: 5,
} as const;
export type ValType = (typeof ValType)[keyof typeof ValType];

export const Kind = {
  NativeShielded: 1,
  NativeUnshielded: 2,
  Ledger: 3,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** Unsigned integers (valType 2) are 1–31 bytes, little-endian. */
export const UINT_MIN_BYTES = 1;
export const UINT_MAX_BYTES = 31;

/** Reasons a payload is rejected (repository-defined, informative; the MIP only says "reject"). */
export type RejectReason =
  /** The payload is longer than 256 bytes (a shorter one is zero-extended). */
  | 'bad-payload-length'
  | 'bad-kind'
  | 'no-records'
  | 'nonzero-padding'
  | 'key-out-of-bounds'
  | 'valtype-out-of-bounds'
  | 'vallen-out-of-bounds'
  | 'value-out-of-bounds'
  | 'reserved-valtype'
  | 'invalid-utf8'
  | 'invalid-json'
  | 'invalid-uri'
  | 'bad-integer-length'
  | 'bad-null-length';

/** Reasons an event is ignored (not a MIP-0018 v1 event at all). */
export type IgnoreReason = 'not-misc' | 'other-name';
