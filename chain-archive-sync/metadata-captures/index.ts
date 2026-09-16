import { readFileSync } from "node:fs";

/**
 * Committed runtime-metadata captures, keyed by MNSV protocol-version range.
 *
 * This is the reference indexer's `.node/<version>/metadata.scale` directory ported, and it exists
 * for one case the live-fetch path cannot serve: a **pruned node**. Runtime metadata is derived
 * from historical state, so once a chain's history is pruned everywhere, those bytes exist nowhere
 * except in a prior capture. There is no cleverer answer available -- every path bottoms out here.
 *
 * WHY THE KEY IS COARSE, deliberately and only here. Everywhere else this codebase keys metadata
 * on the runtime's own `(specName, specVersion)`, because that is exactly what an upgrade bumps.
 * That requires `state_getRuntimeVersion`, which needs the same historical state a pruned node has
 * discarded -- so on the very path this registry exists to serve, it is unavailable. The MNSV
 * protocol version comes from the block HEADER, which a node always has. Falling back to the same
 * granularity the reference indexer dispatches on (`NodeVersion::V0_22` / `V1_0`) is therefore not
 * a compromise of parity: it IS the reference's granularity.
 *
 * Because it is coarse, this is the LAST resort in the resolution order, and any capture used is
 * cross-checked byte-for-byte against a live answer whenever one can be obtained.
 */
export interface MetadataCapture {
  /** Inclusive-exclusive MNSV protocol-version range this capture describes. */
  range: readonly [number, number];
  /** Node release the bytes were captured from. */
  nodeVersion: string;
  /** Where the bytes came from, so a decode traced back here can be audited. */
  provenance: string;
  file: string;
}

export const METADATA_CAPTURES: readonly MetadataCapture[] = [
  {
    range: [22_000, 23_000],
    nodeVersion: "0.22.0",
    // Not our capture: taken from the reference indexer's own committed artifact, which is the
    // same file its build.rs compiles decoders from. Resolving it with this repo's resolver
    // yielded indices identical to 1.0.x (Midnight=5, MidnightSystem=6, both calls 0), which is
    // what settled plan B5 without a running 0.22 node. Note it is metadata V16 where 1.0.0's is
    // V14 -- the decoder handles both, and that difference is why this file is worth carrying
    // rather than assuming 1.0.0's layout generalises.
    provenance:
      "midnight-reference-mainnet/v1.0.0/midnight-indexer/.node/0.22.0/metadata.scale",
    file: "midnight-node-0.22.0.scale",
  },
  {
    range: [1_000_000, 1_001_000],
    nodeVersion: "1.0.0",
    provenance: "state_getMetadata at genesis of a midnightntwrk/midnight-node:1.0.0 devnet",
    file: "midnight-node-1.0.0.scale",
  },
];

/**
 * The capture covering `protocolVersion`, or `undefined` if none does.
 *
 * `undefined` is a legitimate answer, and the caller must refuse rather than substitute a
 * neighbouring capture: metadata from the wrong runtime decodes a block against layouts that are
 * not its own, and the failure is silent -- pallet indices simply mean something else.
 */
export function captureForProtocolVersion(
  protocolVersion: number,
): { capture: MetadataCapture; bytes: Uint8Array } | undefined {
  const capture = METADATA_CAPTURES.find(
    (c) => protocolVersion >= c.range[0] && protocolVersion < c.range[1],
  );
  if (capture === undefined) return undefined;
  const bytes = new Uint8Array(
    readFileSync(new URL(`./${capture.file}`, import.meta.url)),
  );
  return { capture, bytes };
}
