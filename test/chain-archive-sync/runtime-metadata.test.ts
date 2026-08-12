import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeBlockTimestampMs,
  decodeEventSystemTransactions,
  decodeExtrinsicWithMetadata,
  resolveMetadata,
} from "../../chain-archive-sync/runtime-metadata.js";
import { requireCallIndices } from "../../chain-archive-sync/extrinsic-decoder.js";

/**
 * Metadata decoding, against a committed fixture rather than a live chain.
 *
 * The fixture is real `state_getMetadata` output from a `midnight-node:1.0.0` devnet
 * (`test/fixtures/runtime-metadata/`, V14, 102,234 bytes). Using a committed artifact rather than
 * a running node is not a convenience: it is how the reference indexer works too -- it captures
 * metadata per node version offline and compiles decoders from it, rather than resolving at
 * runtime. It also means this suite can never skip for want of a service.
 *
 * The load-bearing assertion is the first one: metadata-derived indices must equal the pinned
 * constants this archive has been using. Those constants were verified only by observation, and
 * the runtime's own description of itself is an INDEPENDENT source for the same facts. If the two
 * ever disagree, one of them is wrong about how to classify a Midnight transaction, and
 * classifying wrongly means genuine transactions silently vanish from the archive.
 */
const METADATA = readFileSync(
  new URL("../fixtures/runtime-metadata/midnight-node-1.0.0-protocol-1000000.scale", import.meta.url),
);
/** A real `System::Events` blob from a live 1.0.0 block — three ordinary events, no system
 *  transaction. Captured alongside the metadata above, so the two genuinely belong together. */
const REAL_EVENTS = new Uint8Array(
  readFileSync(new URL("../fixtures/runtime-metadata/real-block-events-no-system-tx.bin", import.meta.url)),
);
const IDENTITY = { specName: "midnight", specVersion: 1_000_000 };
/** The protocol version the fixture's chain reports, whose pinned indices we cross-check against. */
const FIXTURE_PROTOCOL_VERSION = 1_000_000;

describe("runtime metadata decoding", () => {
  it("parses the committed fixture", () => {
    const resolved = resolveMetadata(METADATA, IDENTITY);
    expect(resolved.identity).toEqual(IDENTITY);
    expect(resolved.metadata.version).toBe(14);
  });

  it("derives indices equal to the pinned constants", () => {
    // The whole justification for this module. Two independent sources -- constants captured by
    // observation, and the runtime describing itself -- must agree.
    const fromMetadata = resolveMetadata(METADATA, IDENTITY).callIndices;
    // Height 0: the fixture is genesis metadata, and the argument only shapes the error message.
    const pinned = requireCallIndices(FIXTURE_PROTOCOL_VERSION, 0);
    expect(fromMetadata).toEqual(pinned);
  });

  it("derives the specific indices this runtime is known to use", () => {
    // Stated explicitly as well as by equality above: if BOTH sources drifted together (e.g. the
    // fixture were regenerated from a different chain), equality would still hold while both were
    // wrong. These are the values observed on midnight-node 1.0.0.
    const { callIndices } = resolveMetadata(METADATA, IDENTITY);
    expect(callIndices).toEqual({
      midnightPallet: 5,
      midnightSystemPallet: 6,
      sendTransactionCall: 0,
      sendSystemTransactionCall: 0,
    });
  });

  it("locates the SystemTransactionApplied event", () => {
    // The only place a runtime-GENERATED system transaction exists. Without its (pallet, variant)
    // coordinates, ingest can detect that such a transaction is present but never decode it.
    const { systemTransactionAppliedEvent } = resolveMetadata(METADATA, IDENTITY);
    expect(systemTransactionAppliedEvent).toEqual({ palletIndex: 6, variantIndex: 0 });
  });

  it("refuses metadata that is not a Midnight runtime, rather than guessing", () => {
    // Truncated bytes are not a Midnight runtime by any reading. The requirement is that an
    // unusable input FAILS -- silently returning defaults here would put invented pallet indices
    // into the classifier, which is the one place a wrong answer rewrites the archive.
    expect(() => resolveMetadata(METADATA.subarray(0, 2048), IDENTITY)).toThrow();
  });
});

/** SCALE compact-u32, for hand-encoding event fixtures. */
function compact(n: number): Buffer {
  if (n < 64) return Buffer.from([n << 2]);
  if (n < 2 ** 14) {
    const v = (n << 2) | 0b01;
    return Buffer.from([v & 0xff, (v >> 8) & 0xff]);
  }
  const v = (n << 2) | 0b10;
  return Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

/**
 * One `System::Events` blob holding a single `MidnightSystem::SystemTransactionApplied`.
 *
 * Hand-encoded rather than built with the decoding library's own constructors: a fixture produced
 * by the same library that decodes it can agree with itself while both are wrong about what a node
 * actually emits. These are the bytes a node puts in storage --
 * `EventRecord { phase, event, topics }` with the event as `(palletIndex, variantIndex, fields…)`.
 */
function eventsBlobWithSystemTransaction(hash: Buffer, payload: Buffer): Uint8Array {
  const record = Buffer.concat([
    Buffer.from([0x00]), Buffer.from([3, 0, 0, 0]), // phase = ApplyExtrinsic(3)
    Buffer.from([6, 0]),                            // MidnightSystem :: SystemTransactionApplied
    hash,                                           // hash_: [u8; 32]
    compact(payload.length), payload,               // serializedSystemTransaction: Vec<u8>
    compact(0),                                     // topics: []
  ]);
  return new Uint8Array(Buffer.concat([compact(1), record]));
}

describe("event-borne system transactions", () => {
  const HASH = Buffer.alloc(32, 0xab);
  const PAYLOAD = Buffer.from("midnight:system-transaction[v6]:deadbeef", "latin1");

  it("recovers the payload and the runtime's own hash", () => {
    const resolved = resolveMetadata(METADATA, IDENTITY);
    const found = decodeEventSystemTransactions(
      resolved, eventsBlobWithSystemTransaction(HASH, PAYLOAD),
    );
    expect(found).toHaveLength(1);
    // The payload must be the BARE transaction: `Bytes` re-prepends its SCALE length prefix on a
    // default encode, and archiving that would store bytes that are not the transaction.
    expect(Buffer.from(found[0]!.payload).equals(PAYLOAD)).toBe(true);
    // The hash assertion is the one that matters most. `codec.hash` is a BUILT-IN on every
    // polkadot codec -- the blake2 hash of the encoded value -- so reading the field as a plain
    // property returns that instead, and it is a 32-byte hex either way. An earlier version of
    // this decoder did exactly that: every event-borne system transaction would have been archived
    // under a fabricated key, permanently, since inserts are ON CONFLICT DO NOTHING. Only a
    // comparison against a KNOWN hash catches it.
    expect(found[0]!.txHash).toBe(HASH.toString("hex"));
  });

  it("ignores a real block's ordinary events", () => {
    // A REAL `System::Events` blob captured from a live 1.0.0 block: three ordinary events, none
    // of them a system transaction. Real bytes rather than a synthetic near-miss, because the
    // question is whether this decoder stays quiet on the traffic it will actually see -- and a
    // hand-built "some other event" is only ever as realistic as the guess behind it.
    const resolved = resolveMetadata(METADATA, IDENTITY);
    expect(decodeEventSystemTransactions(resolved, REAL_EVENTS)).toEqual([]);
  });

  it("refuses an events blob whose event index the runtime does not declare", () => {
    // Corrupt the pallet index to one this runtime has no events for. That means the metadata does
    // not describe these bytes -- i.e. it is metadata for the wrong block -- and continuing would
    // decode a block against a layout that is not its own. Failing is the only safe answer.
    const resolved = resolveMetadata(METADATA, IDENTITY);
    const blob = eventsBlobWithSystemTransaction(HASH, PAYLOAD);
    blob[6] = 0xfe; // vec prefix (1) + phase tag (1) + ApplyExtrinsic u32 (4) => pallet index at 6
    expect(() => decodeEventSystemTransactions(resolved, blob)).toThrow(/Unable to find Event/);
  });

  it("returns nothing for a block with no events", () => {
    const resolved = resolveMetadata(METADATA, IDENTITY);
    expect(decodeEventSystemTransactions(resolved, new Uint8Array(compact(0)))).toEqual([]);
  });

  it("refuses an events blob whose record count exceeds its bytes", () => {
    // A blob claiming more records than it carries is corrupt. Returning the records it managed to
    // read would under-report what the block contained -- and under-reporting is the exact failure
    // this whole decoding path exists to eliminate.
    const resolved = resolveMetadata(METADATA, IDENTITY);
    const truncated = eventsBlobWithSystemTransaction(HASH, PAYLOAD).slice(0, 12);
    expect(() => decodeEventSystemTransactions(resolved, truncated)).toThrow();
  });
});

/**
 * Reading the dispatched call out of EVERY framing -- the capability §5.2 was missing.
 *
 * The hand-rolled envelope decoder can only read a bare extrinsic. In a signed or "general"
 * framing the call sits behind an address, a signature and the transaction extensions, whose
 * layouts are chain configuration. Since `send_mn_transaction` ignores its origin, a signed
 * Midnight transaction is valid and the reference indexer archives it, so being unable to read one
 * meant dropping a real transaction or refusing the block.
 */
describe("decoding a call out of any extrinsic framing", () => {
  const resolved = resolveMetadata(METADATA, IDENTITY);

  // Real extrinsics captured from a live 1.0.0 devnet genesis, identical to the fixtures the
  // hand-rolled decoder's own suite uses -- so the two decoders are checked against the same bytes.
  const GENESIS_SYSTEM_TX =
    "0xb4050600a46d69646e696768743a73797374656d2d7472616e73616374696f6e5b76365d3a050f0080c6a47e8d03";
  const TIMESTAMP_INHERENT = "0x280501000be07b93d89f01";

  it("reads a bare system-transaction call, matching the hand-rolled decoder", () => {
    const d = decodeExtrinsicWithMetadata(resolved, GENESIS_SYSTEM_TX);
    expect(d.isSigned).toBe(false);
    expect({ pallet: d.palletIndex, call: d.callIndex }).toEqual({ pallet: 6, call: 0 });
    expect(Buffer.from(d.payload!).toString("latin1")).toMatch(/^midnight:system-transaction/);
  });

  it("reads a non-Midnight inherent without special-casing it", () => {
    // Timestamp::set. Classification is the caller's job; this must simply report what was
    // dispatched rather than deciding the extrinsic is uninteresting.
    const d = decodeExtrinsicWithMetadata(resolved, TIMESTAMP_INHERENT);
    expect({ pallet: d.palletIndex, call: d.callIndex }).toEqual({ pallet: 1, call: 0 });
  });

  it("reads a SIGNED Midnight call -- the case that used to force a refusal", () => {
    // Hand-built from the layout metadata itself describes: MultiAddress::Id, a Sr25519 signature,
    // then the only two extensions carrying payload bytes (Era, Compact nonce). Everything else in
    // this runtime's extension list has a Null payload and contributes nothing.
    const payload = Buffer.from("midnight:transaction[v9]:PRETEND", "latin1");
    const call = Buffer.concat([Buffer.from([5, 0]), compact(payload.length), payload]);
    const inner = Buffer.concat([
      Buffer.from([0x84]),                         // signed, v4
      Buffer.from([0x00]), Buffer.alloc(32, 0x11), // MultiAddress::Id
      Buffer.from([0x01]), Buffer.alloc(64, 0x22), // MultiSignature::Sr25519
      Buffer.from([0x00]),                         // CheckMortality: Era::Immortal
      compact(7),                                  // CheckNonce
      call,
    ]);
    const hex = "0x" + Buffer.concat([compact(inner.length), inner]).toString("hex");

    const d = decodeExtrinsicWithMetadata(resolved, hex);
    expect(d.isSigned).toBe(true);
    expect({ pallet: d.palletIndex, call: d.callIndex }).toEqual({ pallet: 5, call: 0 });
    // The payload must survive the framing byte-for-byte: it is what gets archived.
    expect(Buffer.from(d.payload!).equals(payload)).toBe(true);
  });

  it("throws rather than reporting 'not Midnight' when an extrinsic cannot be read", () => {
    // The distinction is load-bearing. "Not a Midnight call" is a routine skip; "could not be
    // read" means the archive may be missing a transaction. A caller that cannot tell them apart
    // will treat corruption as absence.
    expect(() => decodeExtrinsicWithMetadata(resolved, "0xff00ff00")).toThrow(
      /could not decode extrinsic/,
    );
  });
});

/**
 * The block's own time, read from its `Timestamp::set` inherent.
 *
 * This exists because of a bug that shipped and passed its tests: replay read a field that was
 * never assigned, so every block replayed at time 0. Genesis genuinely IS time 0, and genesis was
 * the only block the replay tests exercised -- so the single case incapable of detecting the bug
 * was the one covered. The lesson generalises past this fix: a test whose fixture cannot express
 * the failure proves nothing about it.
 */
describe("block timestamp decoding", () => {
  const resolved = resolveMetadata(METADATA, IDENTITY);

  /** The real height-45 `Timestamp::set` inherent from a 1.0.0 devnet. */
  const TIMESTAMP_INHERENT = "0x280501000be07b93d89f01";

  it("locates Timestamp::set in this runtime", () => {
    expect(resolved.timestampSetCall).toEqual({ palletIndex: 1, callIndex: 0 });
  });

  it("decodes a real inherent to a plausible wall-clock time", () => {
    const ms = decodeBlockTimestampMs(resolved, [TIMESTAMP_INHERENT]);
    expect(ms).toBeDefined();
    // Milliseconds, not seconds: a seconds value would land in 1970. Asserting the ORDER OF
    // MAGNITUDE is the point -- a unit error here shifts every replayed block by 54 years and
    // still "works".
    expect(ms!).toBeGreaterThan(1_600_000_000_000); // after Sept 2020
    expect(ms!).toBeLessThan(4_000_000_000_000);    // before 2096
  });

  it("returns undefined for a block with no timestamp inherent (genesis)", () => {
    // The caller must distinguish this from zero: genesis legitimately has no time, every other
    // block having none is a decode failure.
    expect(decodeBlockTimestampMs(resolved, [])).toBeUndefined();
  });
});
