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
 * **Classification is by DISPATCHED CALL, not by payload content.** An earlier version of this
 * module deliberately ignored the pallet/call indices and filtered on the payload's own
 * `midnight:` self-tag, reasoning that a renumbered runtime should still decode. That is
 * backwards: the self-tag lives inside the payload, and a payload is only ever bytes that someone
 * put into some call. `LedgerApi::apply_transaction` is reached from exactly one call --
 * `pallet_midnight::send_mn_transaction`, call_index 0 -- so bytes carried by any OTHER call were
 * never applied to the ledger, whatever they are shaped like. The reference indexer selects
 * transactions the same way (`runtimes/v1_0_0.rs` matches the call variants; `_ => None`).
 *
 * The self-tag is kept as a corroborating check: a call and a payload that disagree are rejected
 * rather than archived.
 *
 * **Scope, so this is not oversold.** On the 1.0 runtime an ordinary user cannot get
 * midnight-tagged bytes into a non-Midnight call at all: `pallet_midnight` holds the runtime's
 * ONLY `ValidateUnsigned`, and its `pre_dispatch` admits only `send_mn_transaction`, so a BARE
 * non-Midnight call is refused by the node -- and an ordinary SIGNED one is refused by this
 * decoder before the pallet index is even read. The reachable cases are trusted-boundary
 * constructions (the genesis chain-spec itself builds a bare remark) and future runtimes that add
 * unsigned-validated calls taking a `Vec<u8>`. This is correctness hardening that matches the
 * authoritative source, NOT a fix for a live permissionless exploit; an earlier version of this
 * comment and of the sprint's security note claimed otherwise and was wrong.
 */

/**
 * Which `(pallet, call)` pairs actually carry Midnight transaction payloads on a given runtime.
 *
 * This is the security boundary. `apply_transaction` is reached from exactly ONE call --
 * `pallet_midnight::send_mn_transaction`, call_index 0 (`midnight-node/pallets/midnight/src/
 * lib.rs`) -- and the reference indexer selects transactions by matching that call variant
 * exactly, discarding everything else (`runtimes/v1_0_0.rs`, `_ => None`). Bytes carried by any
 * other call were never applied to the ledger, no matter what they look like.
 *
 * Classifying by the payload's `midnight:` self-tag instead, as this decoder originally did,
 * classifies by the CONTENT of the call rather than by the call itself -- so any call carrying a
 * `Vec<u8>` that happened to start with the tag would be archived as a transaction the ledger
 * never executed. See the module header for who can and cannot actually produce such a call on
 * the 1.0 runtime: on that runtime the answer is nobody, short of the trusted genesis
 * construction, which is why this is hardening rather than an exploit fix.
 */
export interface RuntimeCallIndices {
  /** Runtime index of `pallet_midnight`. */
  midnightPallet: number;
  /** Runtime index of `pallet_midnight_system`. */
  midnightSystemPallet: number;
  /** `send_mn_transaction`'s call index within `pallet_midnight`. */
  sendTransactionCall: number;
  /** `send_mn_system_transaction`'s call index within `pallet_midnight_system`. */
  sendSystemTransactionCall: number;
  /** Runtime index of `pallet_timestamp`. */
  timestampPallet: number;
  /** `set`'s call index within `pallet_timestamp`. */
  timestampSetCall: number;
}

/**
 * Call indices per protocol-version range, and ONLY for ranges whose indices have actually been
 * observed on a real node of that version. A supported ledger version with no entry here is
 * refused rather than guessed at -- see `callIndicesForProtocolVersion`.
 *
 * Pinning constants is sound precisely because ingest is already gated to known protocol
 * versions: within a version, the runtime's pallet numbering is fixed. It is deliberately
 * fail-closed -- if a runtime renumbers pallets inside a supported range, genuine transactions
 * stop being recognized (visible, fixable) rather than forged ones starting to be accepted
 * (silent, permanent). Resolving indices from runtime metadata removes the pinning entirely and
 * is the intended successor; this is the version that needs no new dependency.
 */
const CALL_INDICES_BY_PROTOCOL: readonly {
  readonly range: readonly [number, number];
  readonly indices: RuntimeCallIndices;
  readonly verifiedAgainst: string;
}[] = [
  {
    // node 1.0.x. Verified against a live 1.0.0 devnet: genesis extrinsic 0 is pallet 6 / call 0
    // carrying a `midnight:system-transaction[v6]` payload, and genesis extrinsic 4 is pallet 5 /
    // call 0 carrying a `midnight:transaction[v9]` payload. Both are fixtures in this decoder's
    // own test file, so the constants below are checked, not asserted.
    range: [1_000_000, 1_001_000],
    indices: {
      midnightPallet: 5,
      midnightSystemPallet: 6,
      sendTransactionCall: 0,
      sendSystemTransactionCall: 0,
      // Timestamp is pallet 1 / call 0 on this runtime, verified the same way: the block-45
      // inherent `0x280501000be07b93d89f01` is bare v5, pallet 1, call 0, one `Compact<u64>`
      // moment decoding to 1786044972000 ms. Also a fixture in this decoder's test file.
      timestampPallet: 1,
      timestampSetCall: 0,
    },
    verifiedAgainst: "midnightntwrk/midnight-node:1.0.0",
  },
  // node 0.22.x is INTENTIONALLY ABSENT. Its ledger codec is v8 and therefore decodable, but its
  // pallet indices have never been observed here, and guessing them would either silently
  // misclassify or silently reject. Add an entry once verified against a real 0.22 node.
];

/** The call indices for `version`, or `undefined` if this build has no verified mapping. */
export function callIndicesForProtocolVersion(version: number): RuntimeCallIndices | undefined {
  return CALL_INDICES_BY_PROTOCOL.find(
    ({ range: [lo, hi] }) => version >= lo && version < hi,
  )?.indices;
}

/**
 * Resolves call indices or throws. Separate from `isSupportedProtocolVersion` on purpose: whether
 * this archive can DECODE a ledger version and whether it knows that runtime's call NUMBERING are
 * two different questions, and conflating them is how 0.22 would end up silently misclassified.
 */
export function requireCallIndices(version: number, height: number): RuntimeCallIndices {
  const indices = callIndicesForProtocolVersion(version);
  if (indices !== undefined) return indices;
  throw new Error(
    `no verified runtime call indices for protocol version ${version} (height ${height}). The ` +
      "ledger codec for this version may be supported, but classifying transactions requires " +
      "knowing which pallet/call carries them, and guessing would either drop real transactions " +
      "or archive forged ones. Verify the indices against a node of this version and add them to " +
      "CALL_INDICES_BY_PROTOCOL.",
  );
}

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
export type ExtrinsicClassification =
  /** A genuine Midnight transaction call. */
  | { outcome: "midnight"; extrinsic: DecodedMidnightExtrinsic }
  /** The payload carries a `midnight:` self-tag but the DISPATCHED CALL is not a Midnight call,
   *  so the ledger never applied it. Normally impossible for a user to produce on the 1.0
   *  runtime (see the module header); a non-zero count means either a trusted-boundary
   *  construction or -- the case worth catching -- a runtime that renumbered its pallets, which
   *  would otherwise make genuine transactions vanish from the archive in silence. */
  | { outcome: "midnight_tagged_foreign_call"; palletIndex: number; callIndex: number }
  /** Anything else: inherents, signed extrinsics, non-`Vec<u8>` calls. The overwhelming majority. */
  | { outcome: "not_midnight" };

/** Convenience wrapper for callers that only care about genuine Midnight calls. */
export function decodeMidnightExtrinsic(
  extrinsicHex: string,
  indices: RuntimeCallIndices,
): DecodedMidnightExtrinsic | null {
  const c = classifyExtrinsic(extrinsicHex, indices);
  return c.outcome === "midnight" ? c.extrinsic : null;
}

export function classifyExtrinsic(
  extrinsicHex: string,
  indices: RuntimeCallIndices,
): ExtrinsicClassification {
  const bytes = hexToBytes(extrinsicHex);
  const { value: bodyLen, size: lenSize } = decodeCompactU32(bytes, 0);
  if (lenSize + bodyLen !== bytes.length) {
    throw new Error(
      `decodeMidnightExtrinsic: envelope length prefix (${bodyLen}) disagrees with actual body ` +
        `size (${bytes.length - lenSize}) -- corrupted extrinsic bytes`,
    );
  }
  // Body must at least hold version + pallet + call + a 1-byte compact.
  if (bodyLen < 4) return { outcome: "not_midnight" };

  const version = bytes[lenSize]!;
  // Bits 6-7 of the version byte are the extrinsic type: 00 = bare, 10 = signed, 01 = "general"
  // (v5). Midnight payload calls are submitted bare (observed live, both wallet- and
  // node-authored); anything else cannot be a plain single-argument wrap of the payload.
  if ((version & 0b1100_0000) !== 0) return { outcome: "not_midnight" };
  const formatVersion = version & 0b0011_1111;
  if (formatVersion !== 4 && formatVersion !== 5) return { outcome: "not_midnight" };

  const palletIndex = bytes[lenSize + 1]!;
  const callIndex = bytes[lenSize + 2]!;

  let arg: { value: number; size: number };
  try {
    arg = decodeCompactU32(bytes, lenSize + 3);
  } catch {
    return { outcome: "not_midnight" }; // truncated compact => not the shape we're looking for
  }
  const payloadStart = lenSize + 3 + arg.size;
  // The single Vec<u8> argument must span EXACTLY to the end of the extrinsic -- this is what
  // rules out multi-argument calls from other pallets that happen to start with byte patterns
  // resembling a compact length.
  if (payloadStart + arg.value !== bytes.length) return { outcome: "not_midnight" };

  const payload = bytes.subarray(payloadStart);

  // THE classification decision, and it is made by WHICH CALL carried the bytes -- never by the
  // bytes themselves. Any other (pallet, call) is not a Midnight transaction, however the payload
  // is shaped: a `System::remark` full of real transaction bytes is a no-op that the ledger never
  // saw, and archiving it would assert a transaction that did not happen.
  const kind: "regular" | "system" | undefined =
    palletIndex === indices.midnightPallet && callIndex === indices.sendTransactionCall
      ? "regular"
      : palletIndex === indices.midnightSystemPallet && callIndex === indices.sendSystemTransactionCall
        ? "system"
        : undefined;
  if (kind === undefined) {
    // Not a Midnight call. Distinguish the ordinary case (an inherent, another pallet) from the
    // one worth counting: a payload that CLAIMS to be a Midnight transaction while riding a
    // different call.
    return tagKindOf(payload) === undefined
      ? { outcome: "not_midnight" }
      : { outcome: "midnight_tagged_foreign_call", palletIndex, callIndex };
  }

  // The self-tag is a corroborating check, not the classifier. A genuine Midnight call always
  // carries the matching tag, so a disagreement means the payload is not what the call says it
  // is -- reject rather than archive it.
  if (tagKindOf(payload) !== kind) {
    return { outcome: "midnight_tagged_foreign_call", palletIndex, callIndex };
  }

  return {
    outcome: "midnight",
    extrinsic: { version: formatVersion, palletIndex, callIndex, payload, kind },
  };
}

/**
 * Milliseconds since the Unix epoch for the block whose extrinsics these are, decoded from its
 * own `pallet_timestamp::set` inherent, or `undefined` if the block carries none.
 *
 * Why the block needs a timestamp at all: consumers place a block on the root chain's clock from
 * it (effectstream's `MidnightSyncState.toRootPage`), and stateful ledger replay will need it as
 * `BlockContext.tblock`. The node exposes it nowhere else -- it is not in the header, only in the
 * body as the first inherent -- so decoding it here is the only node-only route.
 *
 * Shape (verified live, block 45): `28 05 01 00 0b e07b93d89f01` -- compact body length, bare v5
 * version byte, pallet 1, call 0, then ONE `Compact<u64>` argument in big-integer mode (`0x0b` =>
 * six little-endian bytes) decoding to 1786044972000.
 *
 * Classification is by dispatched call, exactly as for transaction payloads: an extrinsic is the
 * timestamp inherent because it *is* `Timestamp::set`, never because its bytes look like a
 * plausible moment. Anything malformed is skipped rather than thrown, since a block without a
 * decodable timestamp must degrade to a NULL column, not halt ingest.
 */
export function decodeBlockTimestampMs(
  extrinsicHexes: readonly string[],
  indices: RuntimeCallIndices,
): number | undefined {
  for (const hex of extrinsicHexes) {
    let bytes: Uint8Array;
    let bodyLen: number;
    let lenSize: number;
    try {
      bytes = hexToBytes(hex);
      ({ value: bodyLen, size: lenSize } = decodeCompactU32(bytes, 0));
    } catch {
      continue;
    }
    if (lenSize + bodyLen !== bytes.length || bodyLen < 4) continue;

    const version = bytes[lenSize]!;
    if ((version & 0b1100_0000) !== 0) continue; // inherents are bare
    const formatVersion = version & 0b0011_1111;
    if (formatVersion !== 4 && formatVersion !== 5) continue;
    if (bytes[lenSize + 1] !== indices.timestampPallet) continue;
    if (bytes[lenSize + 2] !== indices.timestampSetCall) continue;

    let moment: { value: number; size: number };
    try {
      // `decodeCompactU32` handles every SCALE compact mode including big-integer, and rejects
      // anything past MAX_SAFE_INTEGER rather than truncating -- ms-since-epoch (~1.8e12) is four
      // orders of magnitude inside that bound, so the u32 in the name is a misnomer here, not a
      // limit.
      moment = decodeCompactU32(bytes, lenSize + 3);
    } catch {
      continue;
    }
    // The single argument must span exactly to the end, same shape check as a payload call: this
    // is what rules out a multi-argument call that merely begins with a plausible compact.
    if (lenSize + 3 + moment.size !== bytes.length) continue;
    return moment.value;
  }
  return undefined;
}

/** Engine id of the Midnight protocol-version consensus digest item: ASCII "MNSV"
 *  (`midnight-indexer/chain-indexer/src/infra/subxt_node/header.rs`). */
const MNSV = 0x4d4e5356;

/**
 * Protocol-version ranges this archive knows how to decode, mirroring the reference
 * implementation's own gate (`midnight-indexer/indexer-common/src/domain/protocol_version.rs`,
 * `TryFrom<u32> for ProtocolVersion`): node 0.22.x is `0_022_000..0_023_000` and node 1.0.x is
 * `1_000_000..1_001_000`. Both map to ledger version V8, which is the ONE ledger implementation
 * `tx-replay-decoder.ts` is wired to.
 *
 * The ranges exist because the version alone decides which ledger codec is correct. Accepting an
 * unknown version would silently decode a future ledger (v9+) with the v8 deserializer -- either
 * garbage that still parses, or an opaque WASM error attributed to the wrong cause. Failing
 * loudly on an unrecognized version is the only safe response, and matches what the reference
 * does rather than being a local invention.
 */
// Written as 22_000 rather than the reference's `0_022_000`: TypeScript rejects a numeric
// separator directly after a leading zero. Same values.
const SUPPORTED_PROTOCOL_RANGES: readonly (readonly [number, number])[] = [
  [22_000, 23_000],
  [1_000_000, 1_001_000],
];

/** True if `version` falls in a range whose ledger codec this archive actually implements. */
export function isSupportedProtocolVersion(version: number): boolean {
  return SUPPORTED_PROTOCOL_RANGES.some(([lo, hi]) => version >= lo && version < hi);
}

/**
 * Throws unless `version` is one this archive can decode. Called at ingest, before any payload is
 * handed to the ledger WASM, so a protocol upgrade halts the archive with a version-named error
 * instead of quietly producing wrong rows.
 */
export function assertSupportedProtocolVersion(version: number, height: number): void {
  if (isSupportedProtocolVersion(version)) return;
  throw new Error(
    `unsupported Midnight protocol version ${version} at height ${height}: this archive decodes ` +
      `only ${SUPPORTED_PROTOCOL_RANGES.map(([lo, hi]) => `[${lo},${hi})`).join(" and ")} ` +
      "(all ledger v8). Ingest stops rather than decode an unknown ledger with the v8 codec.",
  );
}

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
