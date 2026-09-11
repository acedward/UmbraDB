import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ArchiveDiscontinuityError } from "../../src/interfaces/archive-read-contract.js";
import type {
  ArchiveBlockPage,
  ArchiveIdentity,
} from "../../src/interfaces/archive-read-contract.js";
import {
  ARCHIVE_READ_WIRE_VERSION,
  ArchiveWireError,
  base64ToBytes,
  bytesToBase64,
  decodeBlockPage,
  decodeIdentity,
  decodeProgressEvent,
  encodeBlockPage,
  encodeIdentity,
} from "../../src/interfaces/archive-read-wire.js";

/**
 * The wire codec is the one piece of 00009-08 that BOTH processes depend on being right, and the
 * one whose failures are quiet: a field that decodes to `undefined` does not throw, it just makes
 * a block look like it has no timestamp, or a transaction look like it has no replay outcome.
 *
 * So this suite is a round-trip property (encode ∘ decode = identity over random pages) plus the
 * specific refusals: bad base64, a page whose blocks are not parent-linked, a wire version from
 * the future.
 */

const hex32 = (seed: number): string => seed.toString(16).padStart(64, "0");

function page(blocks: { height: number; txs: number; timestampMs?: number }[]): ArchiveBlockPage {
  return {
    blocks: blocks.map((b) => ({
      net: "undeployed",
      height: b.height,
      hash: hex32(b.height + 1),
      parentHash: hex32(b.height),
      ...(b.timestampMs === undefined ? {} : { timestampMs: b.timestampMs }),
      transactions: Array.from({ length: b.txs }, (_unused, i) => ({
        txHash: hex32(1000 + b.height * 100 + i),
        position: i,
        kind: "regular" as const,
        protocolVersion: 1_000_000,
        rawBytes: Uint8Array.from([b.height, i, 0xff, 0x00, 0x7f]),
      })),
    })),
    sourceTip: { height: 99, hash: hex32(999) },
  };
}

describe("archive read wire codec", () => {
  it("round-trips a page: every block, every transaction, every byte", () => {
    const original = page([
      { height: 0, txs: 0 },
      { height: 1, txs: 2, timestampMs: 1_754_395_200_000 },
      { height: 2, txs: 1 },
    ]);
    const decoded = decodeBlockPage(JSON.parse(JSON.stringify(encodeBlockPage(original))));
    expect(decoded).toStrictEqual(original);
  });

  it("round-trips random byte payloads through base64 (property)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        const back = base64ToBytes(bytesToBase64(bytes));
        expect(Array.from(back)).toStrictEqual(Array.from(bytes));
      }),
      { numRuns: 200 },
    );
  });

  it("decodes bytes into a COPY, not a view over Node's shared Buffer pool", () => {
    // A view would hand the caller a window into an 8 KiB slab shared with unrelated allocations,
    // which the scanner then holds for the life of an association.
    const bytes = base64ToBytes(bytesToBase64(Uint8Array.from([1, 2, 3])));
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(3);
  });

  it("omits absent optional fields rather than encoding them as null", () => {
    const encoded = encodeBlockPage({ blocks: page([{ height: 5, txs: 1 }]).blocks });
    expect(Object.keys(encoded)).toStrictEqual(["blocks"]);
    expect("timestampMs" in encoded.blocks[0]!).toBe(false);
    expect("result" in encoded.blocks[0]!.transactions[0]!).toBe(false);
  });

  it("carries the replay outcome when the archive recorded one", () => {
    const original = page([{ height: 1, txs: 1 }]);
    const withResult: ArchiveBlockPage = {
      ...original,
      blocks: [{ ...original.blocks[0]!, transactions: [{ ...original.blocks[0]!.transactions[0]!, result: "partial_success" }] }],
    };
    expect(decodeBlockPage(encodeBlockPage(withResult))).toStrictEqual(withResult);
  });

  it("refuses a payload that does not match the schema, naming the field", () => {
    expect(() => decodeBlockPage({ blocks: [{ net: "undeployed" }] })).toThrow(ArchiveWireError);
    try {
      decodeBlockPage({ blocks: [{ net: "undeployed" }] });
    } catch (err) {
      expect((err as ArchiveWireError).issues.some((i) => i.path.includes("height"))).toBe(true);
    }
  });

  it("refuses non-canonical base64 instead of silently decoding short bytes", () => {
    // `Buffer.from("!!!!", "base64")` is an EMPTY buffer, not an error. A transaction whose
    // payload arrived corrupted would then reach the ledger as zero bytes and be reported as an
    // undecodable transaction — a fail-closed monitor stop, blamed on the chain.
    expect(Buffer.from("!!!!", "base64").length).toBe(0); // the permissiveness this guards against
    const encoded = encodeBlockPage(page([{ height: 1, txs: 1 }]));
    (encoded.blocks[0]!.transactions[0] as { rawBytes: string }).rawBytes = "!!!!";
    expect(() => decodeBlockPage(encoded)).toThrow(/canonical base64/);
  });

  it("refuses a page whose blocks are not parent-linked (the same fail-closed rule the Pg reader applies)", () => {
    const encoded = encodeBlockPage(page([{ height: 1, txs: 0 }, { height: 2, txs: 0 }]));
    encoded.blocks[1]!.parentHash = hex32(4242);
    expect(() => decodeBlockPage(encoded)).toThrow(ArchiveDiscontinuityError);
  });

  it("refuses a page with a HEIGHT gap even when the hashes would chain", () => {
    const encoded = encodeBlockPage(page([{ height: 1, txs: 0 }, { height: 2, txs: 0 }]));
    encoded.blocks[1]!.height = 7;
    expect(() => decodeBlockPage(encoded)).toThrow(ArchiveDiscontinuityError);
  });

  it("round-trips identity and stamps the wire version", () => {
    const identity: ArchiveIdentity = {
      net: "undeployed",
      genesisHash: hex32(1),
      archiveInstanceId: "a".repeat(32),
    };
    const encoded = encodeIdentity(identity);
    expect(encoded.wireVersion).toBe(ARCHIVE_READ_WIRE_VERSION);
    expect(decodeIdentity(encoded)).toStrictEqual(identity);
  });

  it("refuses a server that speaks a LATER wire version rather than guessing at its fields", () => {
    const future = { ...encodeIdentity({ net: "undeployed", genesisHash: hex32(1), archiveInstanceId: "b".repeat(32) }), wireVersion: ARCHIVE_READ_WIRE_VERSION + 1 };
    expect(() => decodeIdentity(future)).toThrow(/wire version/);
  });

  it("accepts an identity with no wireVersion at all (an older server)", () => {
    expect(
      decodeIdentity({ net: "undeployed", genesisHash: hex32(1), archiveInstanceId: "c".repeat(32) }).net,
    ).toBe("undeployed");
  });

  it("decodes a progress event and refuses a malformed one", () => {
    expect(decodeProgressEvent({ net: "undeployed", height: 12 })).toStrictEqual({ net: "undeployed", height: 12 });
    expect(() => decodeProgressEvent({ net: "undeployed", height: -1 })).toThrow(ArchiveWireError);
  });
});
