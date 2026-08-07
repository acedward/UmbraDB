import { SYSTEM_TX_TAG_PREFIX, STANDARD_TX_TAG_PREFIX } from "./tx-replay-decoder.js";

/**
 * Minimal, zero-dependency decoder for the OUTER Substrate extrinsic envelope around a
 * `pallet_midnight::send_mn_transaction` / `pallet_midnight_system::send_mn_system_transaction`
 * payload -- the node-only replacement for the one field the indexer used to be structurally
 * required for: the inner `tx_raw` bytes (`sync-service.ts`'s "exact suffix" finding).
 *
 * Grounded against the reference implementation, not guessed: the indexer's own node adapter
 * (`midnight-indexer/chain-indexer/src/infra/subxt_node/runtimes/v1_0_0.rs`,
 * `make_block_details`) obtains the same bytes by SCALE-decoding each extrinsic as a runtime
 * `Call` and matching `Call::Midnight(send_mn_transaction { midnight_tx })` /
 * `Call::MidnightSystem(send_mn_system_transaction { midnight_system_tx })`. Both calls carry
 * exactly ONE argument, a `Vec<u8>` (`midnight-node/pallets/midnight/src/lib.rs`,
 * `send_mn_transaction(_origin, midnight_tx: Vec<u8>)`, call_index 0), which is what makes the
 * envelope parse below well-defined without full runtime-metadata knowledge:
 *
 *   compact-u32 total length | version byte | pallet u8 | call u8 | compact-u32 arg length | bytes
 *
 * Confirmed byte-for-byte against the live devnet (`midnightntwrk/midnight-node:1.0.0`,
 * fixtures in `test/chain-archive-sync/extrinsic-decoder.test.ts`):
 *   - genesis extrinsic 0:  `b4 05 06 00 a4 6d69...` -- bare v5, pallet 6 (MidnightSystem),
 *     call 0, 41-byte `midnight:system-transaction[v6]:` payload;
 *   - genesis extrinsic 4:  `81 03 05 05 00 6d 03 6d69...` -- bare v5, pallet 5 (Midnight),
 *     call 0, 219-byte `midnight:transaction[v9](...)` payload;
 *   - block-45 extrinsic 3: `6d d8 04 05 00 59 d8 6d69...` -- bare v4 (the wallet SDK submits
 *     v4-framed extrinsics; the node's own inherents use v5), pallet 5, call 0.
 *
 * The decoder deliberately does NOT hardcode pallet indices (5/6 on this devnet runtime; a
 * different runtime build may renumber): the authoritative filter is the payload's own
 * `midnight:` self-tag (design doc §3.2 -- the payload is domain-separated ASCII-tagged), plus
 * the structural requirement that the single trailing `Vec<u8>` argument spans EXACTLY to the
 * extrinsic's end. A non-midnight extrinsic (Timestamp::set and the other inherents) fails the
 * tag check and returns `null`; a midnight extrinsic on a renumbered runtime still decodes.
 */

export interface DecodedMidnightExtrinsic {
  /** Extrinsic format version (observed live: 4 from wallet submissions, 5 from node-authored). */
  version: number;
  /** Runtime pallet index of the wrapping call (observed live: 5 = Midnight, 6 = MidnightSystem). */
  palletIndex: number;
  /** Call index within the pallet (observed live: 0 = send_mn_(system_)transaction). */
  callIndex: number;
  /** The inner self-tagged payload -- byte-identical to what the indexer served as
   *  `Transaction.raw` (proven: the indexer's raw is an exact suffix of the extrinsic, and this
   *  is that suffix). */
  payload: Uint8Array;
  /** Which self-tag the payload carries. */
  kind: "regular" | "system";
}

/** SCALE compact-u32 decode at `offset`: returns the value and how many bytes it occupied.
 *  Mode 3 (big-integer, first byte `0b11`) is supported up to `Number.MAX_SAFE_INTEGER` --
 *  far beyond any real extrinsic length -- and throws beyond that rather than truncating. */
export function decodeCompactU32(bytes: Uint8Array, offset: number): { value: number; size: number } {
  if (offset >= bytes.length) throw new Error("decodeCompactU32: offset past end of input");
  const first = bytes[offset]!;
  const mode = first & 0b11;
  if (mode === 0) return { value: first >>> 2, size: 1 };
  if (mode === 1) {
    if (offset + 2 > bytes.length) throw new Error("decodeCompactU32: truncated two-byte compact");
    return { value: (first | (bytes[offset + 1]! << 8)) >>> 2, size: 2 };
  }
  if (mode === 2) {
    if (offset + 4 > bytes.length) throw new Error("decodeCompactU32: truncated four-byte compact");
    const raw =
      (first | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
    return { value: raw >>> 2, size: 4 };
  }
  // Mode 3: the upper six bits of the first byte encode (byte count - 4) of a little-endian
  // integer that follows.
  const count = (first >>> 2) + 4;
  if (offset + 1 + count > bytes.length) throw new Error("decodeCompactU32: truncated big-integer compact");
  let value = 0;
  for (let i = count - 1; i >= 0; i--) {
    value = value * 256 + bytes[offset + 1 + i]!;
  }
  if (!Number.isSafeInteger(value)) throw new Error("decodeCompactU32: value exceeds MAX_SAFE_INTEGER");
  return { value, size: 1 + count };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array(Buffer.from(clean, "hex"));
}

function tagKindOf(payload: Uint8Array): "regular" | "system" | undefined {
  const head = Buffer.from(payload.subarray(0, SYSTEM_TX_TAG_PREFIX.length)).toString("latin1");
  // System first: its tag is longer and shares the `midnight:` prefix with the standard tag,
  // but the two are mutually exclusive on their full prefixes (`midnight:s...` vs `midnight:t...`).
  if (head.startsWith(SYSTEM_TX_TAG_PREFIX)) return "system";
  if (head.startsWith(STANDARD_TX_TAG_PREFIX)) return "regular";
  return undefined;
}

/**
 * Decodes one `chain_getBlock` extrinsic (0x-hex) into its inner midnight payload, or `null`
 * when the extrinsic is not a bare single-`Vec<u8>` midnight call (inherents, signed extrinsics,
 * any other pallet). Throws only on a malformed envelope (length prefix disagreeing with the
 * actual byte count), which indicates a corrupted input rather than a benign non-midnight
 * extrinsic.
 */
export function decodeMidnightExtrinsic(extrinsicHex: string): DecodedMidnightExtrinsic | null {
  const bytes = hexToBytes(extrinsicHex);
  const { value: bodyLen, size: lenSize } = decodeCompactU32(bytes, 0);
  if (lenSize + bodyLen !== bytes.length) {
    throw new Error(
      `decodeMidnightExtrinsic: envelope length prefix (${bodyLen}) disagrees with actual body ` +
        `size (${bytes.length - lenSize}) -- corrupted extrinsic bytes`,
    );
  }
  // Body must at least hold version + pallet + call + a 1-byte compact.
  if (bodyLen < 4) return null;

  const version = bytes[lenSize]!;
  // Bits 6-7 of the version byte are the extrinsic type: 00 = bare, 10 = signed, 01 = "general"
  // (v5). Midnight payload calls are submitted bare (observed live, both wallet- and
  // node-authored); anything else cannot be a plain single-argument wrap of the payload.
  if ((version & 0b1100_0000) !== 0) return null;
  const formatVersion = version & 0b0011_1111;
  if (formatVersion !== 4 && formatVersion !== 5) return null;

  const palletIndex = bytes[lenSize + 1]!;
  const callIndex = bytes[lenSize + 2]!;

  let arg: { value: number; size: number };
  try {
    arg = decodeCompactU32(bytes, lenSize + 3);
  } catch {
    return null; // truncated compact ⇒ not the shape we're looking for
  }
  const payloadStart = lenSize + 3 + arg.size;
  // The single Vec<u8> argument must span EXACTLY to the end of the extrinsic -- this is what
  // rules out multi-argument calls from other pallets that happen to start with byte patterns
  // resembling a compact length.
  if (payloadStart + arg.value !== bytes.length) return null;

  const payload = bytes.subarray(payloadStart);
  const kind = tagKindOf(payload);
  if (kind === undefined) return null;

  return { version: formatVersion, palletIndex, callIndex, payload, kind };
}

/** Engine id of the Midnight protocol-version consensus digest item: ASCII "MNSV"
 *  (`midnight-indexer/chain-indexer/src/infra/subxt_node/header.rs`). */
const MNSV = 0x4d4e5356;

/**
 * Extracts the Midnight protocol version (e.g. `1_000_000` for node 1.0.0) from a block header's
 * `digest.logs` as returned by `chain_getHeader`/`chain_getBlock` -- each log is a 0x-hex SCALE
 * `DigestItem`; the protocol version lives in the `Consensus("MNSV", scale(u32))` item
 * (`header.rs:17`, `protocol_version.rs:55-61`; confirmed live: genesis digest
 * `0x044d4e53561040420f00` ⇒ Consensus, "MNSV", compact-len 4, u32-LE 1_000_000).
 *
 * Returns `undefined` when no MNSV item is present (the indexer treats that as a hard error for
 * a block it must ingest -- callers should too).
 */
export function decodeProtocolVersionFromDigest(digestLogs: string[]): number | undefined {
  for (const logHex of digestLogs) {
    const bytes = hexToBytes(logHex);
    // DigestItem variant tags (SCALE enum): 6 PreRuntime, 4 Consensus, 5 Seal, 0 Other,
    // 8 RuntimeEnvironmentUpdated. Only Consensus can carry MNSV.
    //
    // The length floor is 6, not 5: variant byte + 4 engine-id bytes + AT LEAST ONE compact
    // byte for the payload length. With a floor of 5 a truncated 5-byte MNSV item passes this
    // guard and then makes `decodeCompactU32(bytes, 5)` read at offset === length, which throws
    // -- and that exception escapes this function entirely, aborting ingest with an opaque
    // "offset past end of input" instead of the `undefined` this function contracts to return
    // (which the caller turns into a clear "no MNSV protocol-version digest at height N").
    if (bytes.length < 1 + 4 + 1 || bytes[0] !== 4) continue;
    const engine = (bytes[1]! << 24) | (bytes[2]! << 16) | (bytes[3]! << 8) | bytes[4]!;
    if (engine !== MNSV) continue;
    const { value: len, size } = decodeCompactU32(bytes, 5);
    if (len < 4 || 5 + size + 4 > bytes.length) continue;
    const at = 5 + size;
    // SCALE u32 is little-endian.
    return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
  }
  return undefined;
}
