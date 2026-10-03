// @mip0018/codec — dependency-free MIP-0018 TokenMetadata codec.
// Pinned text: midnightntwrk/midnight-improvement-proposals@78ecbb4b1ba57371e84fe45f705991ab7b996a61 (PR #340).
export {
  DOMAIN_SEP_SIZE,
  EVENT_NAME,
  EVENT_NAME_TEXT,
  HEADER_SIZE,
  Kind,
  MAX_VALUE_SIZE,
  MISC_EVENT_TYPE,
  NAME_SIZE,
  PAYLOAD_SIZE,
  UINT_MAX_BYTES,
  UINT_MIN_BYTES,
  ValType,
  type IgnoreReason,
  type RejectReason,
} from './constants.ts';
export {
  decodePayload,
  type DecodedRecord,
  type DecodeFail,
  type DecodeOk,
  type DecodeResult,
  type Header,
  type MetadataRecord,
} from './decode.ts';
export { commonRecords, encodePayload, InvalidHeader, InvalidRecord, PayloadTooLarge, record, recordsSize } from './encode.ts';
export { classifyEvent, isMip0018Name, splitMiscData, type Classification, type ObservedMisc } from './classify.ts';
export { checkValue, decodeUint, decodeUtf8, encodeUint, minimalUintWidth } from './values.ts';
export { isRfc3986Uri, RFC3986_URI } from './uri.ts';
export { bytesEqual, fromHex, toHex, zeroExtend } from './hex.ts';
