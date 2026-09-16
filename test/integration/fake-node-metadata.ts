import { readFileSync } from "node:fs";

/**
 * Metadata support for fake-node test doubles.
 *
 * Node-only ingest resolves the block's runtime metadata before it can classify a call or decode
 * an event, so every fake node standing in for a real one must answer `state_getRuntimeVersion`
 * and `state_getMetadata`. Without them the service refuses -- correctly, since it cannot know
 * which runtime produced the block -- and a suite that has not been updated fails with a metadata
 * error rather than exercising whatever it meant to test.
 *
 * The metadata served is the committed real-node capture, not a stub. A hand-written stand-in
 * would decode only as well as its author guessed, and the decoding is precisely what these
 * suites are checking.
 */
export const FIXTURE_METADATA_HEX = `0x${readFileSync(
  new URL("../fixtures/runtime-metadata/midnight-node-1.0.0-protocol-1000000.scale", import.meta.url),
).toString("hex")}`;

/** The runtime identity that goes with the fixture above. `specVersion` is what a runtime upgrade
 *  bumps, so it is also the metadata cache key. */
export const FIXTURE_RUNTIME_VERSION = { specName: "midnight", specVersion: 1_000_000 };

/**
 * Answer the two metadata RPCs, or return `undefined` for anything else so the caller can handle
 * its own methods.
 *
 * Returns the JSON-RPC `result` value only; the caller wraps it in its own envelope.
 */
export function metadataRpcResult(method: string): unknown | undefined {
  switch (method) {
    case "state_getRuntimeVersion":
      return FIXTURE_RUNTIME_VERSION;
    case "state_getMetadata":
      return FIXTURE_METADATA_HEX;
    default:
      return undefined;
  }
}
