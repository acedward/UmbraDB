import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveMetadata } from "../../chain-archive-sync/runtime-metadata.js";
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
