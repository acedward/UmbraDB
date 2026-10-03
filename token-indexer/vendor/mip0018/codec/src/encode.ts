// Payload encoding: header ‖ records ‖ zero padding (MIP "Payload"). The encoder only produces payloads a conforming
// consumer accepts: it validates the header, every record and the total size before writing anything.
import { DOMAIN_SEP_SIZE, KIND_OFFSET, PAYLOAD_SIZE, RECORDS_OFFSET, ValType } from './constants.ts';
import type { Header, MetadataRecord } from './decode.ts';
import { checkValue, encodeUint, minimalUintWidth } from './values.ts';

/** The records do not fit in 256 bytes. */
export class PayloadTooLarge extends Error {
  override name = 'PayloadTooLarge';
  /** Bytes the header and records would need. */
  readonly size: number;
  constructor(size: number) {
    super(`payload needs ${size} bytes; the maximum is ${PAYLOAD_SIZE}`);
    this.size = size;
  }
}

/** A record (or the record list) breaks a MIP rule. */
export class InvalidRecord extends Error {
  override name = 'InvalidRecord';
  /** Index of the offending record, or -1 for the list as a whole. */
  readonly index: number;
  constructor(index: number, message: string) {
    super(index >= 0 ? `record ${index}: ${message}` : message);
    this.index = index;
  }
}

/** The header breaks a MIP rule (domainSep not 32 bytes, kind not 1/2/3). */
export class InvalidHeader extends Error {
  override name = 'InvalidHeader';
}

/** Encodes a payload. Throws `InvalidHeader`, `InvalidRecord` or `PayloadTooLarge`. */
export function encodePayload(header: Header, records: readonly MetadataRecord[]): Uint8Array {
  if (!(header.domainSep instanceof Uint8Array) || header.domainSep.length !== DOMAIN_SEP_SIZE)
    throw new InvalidHeader('domainSep must be 32 bytes');
  if (header.kind !== 1 && header.kind !== 2 && header.kind !== 3)
    throw new InvalidHeader(`kind must be 1, 2 or 3, got ${String(header.kind)}`);
  if (records.length === 0) throw new InvalidRecord(-1, 'at least one record is required');
  let size = RECORDS_OFFSET;
  records.forEach((r, i) => {
    if (!(r.key instanceof Uint8Array) || r.key.length < 1 || r.key.length > 255) throw new InvalidRecord(i, 'key must be 1-255 bytes');
    if (!(r.value instanceof Uint8Array) || r.value.length > 255) throw new InvalidRecord(i, 'value must be 0-255 bytes');
    if (!Number.isInteger(r.valType) || r.valType < 0 || r.valType > 5)
      throw new InvalidRecord(i, `valType must be 0-5, got ${String(r.valType)}`);
    const bad = checkValue(r.valType, r.value);
    if (bad !== undefined) throw new InvalidRecord(i, `value breaks its type rule (${bad})`);
    size += 3 + r.key.length + r.value.length;
  });
  if (size > PAYLOAD_SIZE) throw new PayloadTooLarge(size);

  const out = new Uint8Array(PAYLOAD_SIZE);
  out.set(header.domainSep, 0);
  out[KIND_OFFSET] = header.kind;
  let at = RECORDS_OFFSET;
  for (const r of records) {
    out[at] = r.key.length;
    out.set(r.key, at + 1);
    out[at + 1 + r.key.length] = r.valType;
    out[at + 2 + r.key.length] = r.value.length;
    out.set(r.value, at + 3 + r.key.length);
    at += 3 + r.key.length + r.value.length;
  }
  return out;
}

/** Size in bytes a list of records takes after the header. */
export function recordsSize(records: readonly MetadataRecord[]): number {
  return records.reduce((n, r) => n + 3 + r.key.length + r.value.length, 0);
}

const utf8 = (s: string | Uint8Array): Uint8Array => (typeof s === 'string' ? new TextEncoder().encode(s) : s);

/** Record constructors. Keys given as strings are UTF-8 encoded. */
export const record = {
  bytes: (key: string | Uint8Array, value: Uint8Array): MetadataRecord => ({ key: utf8(key), valType: ValType.Bytes, value }),
  utf8: (key: string | Uint8Array, text: string): MetadataRecord => ({ key: utf8(key), valType: ValType.Utf8, value: utf8(text) }),
  /** Unsigned integer; `width` defaults to the smallest that holds the value (1 byte for `decimals`, like `Uint<8>`). */
  uint: (key: string | Uint8Array, value: bigint | number, width?: number): MetadataRecord => ({
    key: utf8(key),
    valType: ValType.UInt,
    value: encodeUint(value, width ?? minimalUintWidth(value)),
  }),
  /** JSON text, stored as given (not re-serialised). */
  json: (key: string | Uint8Array, text: string): MetadataRecord => ({ key: utf8(key), valType: ValType.Json, value: utf8(text) }),
  uri: (key: string | Uint8Array, uri: string): MetadataRecord => ({ key: utf8(key), valType: ValType.Uri, value: utf8(uri) }),
  /** A tombstone: withdraws the whole token identity, whatever the key. */
  tombstone: (key: string | Uint8Array = 'retire'): MetadataRecord => ({ key: utf8(key), valType: ValType.Null, value: new Uint8Array(0) }),
};

/** The common fields (`name`, `symbol`, `decimals` as `Uint<8>`, optional `standards`) as records, in that order. */
export function commonRecords(fields: {
  name?: string;
  symbol?: string;
  decimals?: number | bigint;
  standards?: string | readonly string[];
}): MetadataRecord[] {
  const out: MetadataRecord[] = [];
  if (fields.name !== undefined) out.push(record.utf8('name', fields.name));
  if (fields.symbol !== undefined) out.push(record.utf8('symbol', fields.symbol));
  if (fields.decimals !== undefined) out.push(record.uint('decimals', fields.decimals, 1));
  if (fields.standards !== undefined)
    out.push(record.utf8('standards', typeof fields.standards === 'string' ? fields.standards : fields.standards.join(' ')));
  return out;
}
