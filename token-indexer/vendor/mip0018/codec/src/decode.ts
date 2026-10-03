// Payload decoding (MIP "Payload": the three checks, value types, whole-event rejection).
//
// Hardening: every length is bounds-checked before any byte is read or sliced; every byte read goes through
// `byteAt`, which throws on an out-of-bounds index — an invariant the fuzz tests assert is never violated. Returned
// keys/values are copies, so callers never alias the input buffer.
import { DOMAIN_SEP_SIZE, KIND_OFFSET, PAYLOAD_SIZE, RECORDS_OFFSET, type RejectReason, ValType } from './constants.ts';
import { zeroExtend } from './hex.ts';
import { ALL_CODEC_RULES, type CodecRules } from './rules.ts';
import { checkValue, decodeUintWith } from './values.ts';

export interface Header {
  /** 32 bytes identifying the token within its contract. */
  domainSep: Uint8Array;
  /** 1 = native shielded, 2 = native unshielded, 3 = ledger. */
  kind: number;
}

export interface MetadataRecord {
  key: Uint8Array;
  valType: number;
  value: Uint8Array;
}

export interface DecodedRecord extends MetadataRecord {
  /** Offset of the record's `keyLen` byte in the payload. */
  offset: number;
  /** valType 2 only: the little-endian unsigned integer. */
  integer?: bigint;
}

export interface DecodeOk {
  ok: true;
  header: Header;
  records: DecodedRecord[];
  /** Offset right after the last record (start of the zero padding, or 256). */
  contentEnd: number;
}

export interface DecodeFail {
  ok: false;
  reason: RejectReason;
  /** Informative: where the failing check looked (the record's offset for record-level failures). */
  offset: number;
}

export type DecodeResult = DecodeOk | DecodeFail;

/** Thrown only if an internal bounds invariant is broken (never for any input — asserted by the fuzz tests). */
export class BoundsInvariantError extends Error {
  override name = 'BoundsInvariantError';
}

function byteAt(buf: Uint8Array, index: number): number {
  if (index < 0 || index >= buf.length) throw new BoundsInvariantError(`read at ${index} outside 0..${buf.length - 1}`);
  return buf[index] as number;
}

function copy(buf: Uint8Array, start: number, end: number): Uint8Array {
  if (start < 0 || end > buf.length || start > end) throw new BoundsInvariantError(`slice ${start}..${end} outside 0..${buf.length}`);
  return buf.slice(start, end);
}

/**
 * Decodes and validates a MIP-0018 payload. A payload shorter than 256 bytes is zero-extended first (MIP "Consuming":
 * some sources drop trailing zero bytes); a longer one is rejected (`bad-payload-length`). Never throws for any
 * `Uint8Array` input; returns either the header and records or the first failing check. Throws `TypeError` only when
 * `payload` is not a `Uint8Array`.
 */
export function decodePayload(payload: Uint8Array): DecodeResult {
  return decodePayloadWith(payload, ALL_CODEC_RULES);
}

/** `decodePayload` with explicit rule switches (rule-mutation testing only). */
export function decodePayloadWith(input: Uint8Array, rules: CodecRules): DecodeResult {
  if (!(input instanceof Uint8Array)) throw new TypeError('payload must be a Uint8Array');
  // Consuming: missing trailing bytes are zero. Mutation only (`zeroExtend: false`): a short payload is rejected.
  const extended = rules.zeroExtend || input.length >= PAYLOAD_SIZE ? zeroExtend(input, PAYLOAD_SIZE) : undefined;
  if (extended === undefined) return { ok: false, reason: 'bad-payload-length', offset: 0 };
  const payload: Uint8Array = extended;

  // Check 1: kind.
  const kind = byteAt(payload, KIND_OFFSET);
  if (rules.kind && kind !== 1 && kind !== 2 && kind !== 3) return { ok: false, reason: 'bad-kind', offset: KIND_OFFSET };

  // Check 2: records, then zero padding.
  const records: DecodedRecord[] = [];
  let at = RECORDS_OFFSET;
  while (at < PAYLOAD_SIZE) {
    const keyLen = byteAt(payload, at);
    if (keyLen === 0) {
      if (rules.padding) {
        for (let i = at + 1; i < PAYLOAD_SIZE; i++)
          if (byteAt(payload, i) !== 0) return { ok: false, reason: 'nonzero-padding', offset: i };
      }
      break;
    }
    const keyStart = at + 1;
    const keyEnd = keyStart + keyLen; // exclusive
    const valTypeAt = keyEnd;
    const valLenAt = keyEnd + 1;
    let valType: number;
    let valLen: number;
    if (rules.bounds) {
      if (keyEnd > PAYLOAD_SIZE) return failOrStop('key-out-of-bounds');
      if (valTypeAt >= PAYLOAD_SIZE) return failOrStop('valtype-out-of-bounds');
      if (valLenAt >= PAYLOAD_SIZE) return failOrStop('vallen-out-of-bounds');
      valType = byteAt(payload, valTypeAt);
      valLen = byteAt(payload, valLenAt);
      if (valLenAt + 1 + valLen > PAYLOAD_SIZE) return failOrStop('value-out-of-bounds');
    } else {
      // Mutation only: read past the end as zeros and truncate.
      valType = payload[valTypeAt] ?? 0;
      valLen = payload[valLenAt] ?? 0;
    }
    const valStart = valLenAt + 1;
    const valEnd = valStart + valLen;
    const key = copy(payload, keyStart, Math.min(keyEnd, PAYLOAD_SIZE));
    const value = copy(payload, Math.min(valStart, PAYLOAD_SIZE), Math.min(valEnd, PAYLOAD_SIZE));
    const bad = checkValue(valType, value, rules);
    if (bad !== undefined) return failOrStop(bad);
    const r: DecodedRecord = { offset: at, key, valType, value };
    if (valType === ValType.UInt) r.integer = decodeUintWith(value, rules);
    records.push(r);
    at = valEnd;
  }

  // Check 3: at least one record.
  if (rules.minOneRecord && records.length === 0) return { ok: false, reason: 'no-records', offset: RECORDS_OFFSET };
  return { ok: true, header: { domainSep: copy(payload, 0, DOMAIN_SEP_SIZE), kind }, records, contentEnd: Math.min(at, PAYLOAD_SIZE) };

  function failOrStop(reason: RejectReason): DecodeResult {
    if (rules.wholeEvent) return { ok: false, reason, offset: at };
    // Mutation only (`wholeEvent: false`): keep the records read so far.
    if (rules.minOneRecord && records.length === 0) return { ok: false, reason, offset: at };
    return { ok: true, header: { domainSep: copy(payload, 0, DOMAIN_SEP_SIZE), kind }, records, contentEnd: at };
  }
}
