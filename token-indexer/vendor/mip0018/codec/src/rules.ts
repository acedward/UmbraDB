// The decoder's MIP rules as switches. Every switch is ON in the public API; they exist only so the rule-mutation
// test (SC-001) can disable one rule at a time and show that at least one normative vector then fails.
// Not part of the public API (exported from `@mip0018/codec/internal`).

export interface CodecRules {
  /** Consuming — a `name` shorter than 32 bytes and a `payload` shorter than 256 bytes are zero-extended first. */
  zeroExtend: boolean;
  /** "Must ignore" — only `Misc` events are considered. */
  typeCheck: boolean;
  /** "Must ignore" — only the exact 32-byte v1 name is considered. */
  nameCheck: boolean;
  /** Payload check 1 — `kind` is 1, 2 or 3. */
  kind: boolean;
  /** Payload check 2 — after a zero `keyLen`, every remaining byte is zero. */
  padding: boolean;
  /** Payload check 2 — key, `valType`, `valLen` and value fit within the 256 bytes. */
  bounds: boolean;
  /** Payload check 3 — at least one record. */
  minOneRecord: boolean;
  /** valType 6–255 reject the event. */
  reservedTypes: boolean;
  /** Types 1, 3, 4 must be valid UTF-8. */
  utf8: boolean;
  /** Type 3 must be one complete JSON value. */
  json: boolean;
  /** Type 4 must be an RFC 3986 `URI`. */
  uri: boolean;
  /** Type 2 must be 1–31 bytes. */
  integerLength: boolean;
  /** Type 5 must have `valLen` 0. */
  nullLength: boolean;
  /** Type 2 is little-endian. */
  littleEndian: boolean;
  /** Any failing check rejects the whole event (no partial application). */
  wholeEvent: boolean;
}

export const ALL_CODEC_RULES: Readonly<CodecRules> = Object.freeze({
  zeroExtend: true,
  typeCheck: true,
  nameCheck: true,
  kind: true,
  padding: true,
  bounds: true,
  minOneRecord: true,
  reservedTypes: true,
  utf8: true,
  json: true,
  uri: true,
  integerLength: true,
  nullLength: true,
  littleEndian: true,
  wholeEvent: true,
});

export function withCodecRules(partial: Partial<CodecRules> | undefined): CodecRules {
  return { ...ALL_CODEC_RULES, ...(partial ?? {}) };
}
