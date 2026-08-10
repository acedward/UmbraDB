import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeEventSystemTransactions,
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

  it("refuses an events blob that does not match its runtime's metadata", () => {
    // A blob claiming more records than it carries is corrupt. Returning the records it managed to
    // read would under-report what the block contained -- and under-reporting is the exact failure
    // this whole decoding path exists to eliminate.
    const resolved = resolveMetadata(METADATA, IDENTITY);
    const truncated = eventsBlobWithSystemTransaction(HASH, PAYLOAD).slice(0, 12);
    expect(() => decodeEventSystemTransactions(resolved, truncated)).toThrow();
  });
});
