import { describe, expect, it } from "vitest";
import {
  MAX_NULLIFIERS_PER_REQUEST,
  MAX_RANGES_PER_REQUEST,
  bytesFromHex,
  chunk,
  dateFromSeconds,
  gapRanges,
  generationFromWire,
  qdoFromWire,
  rangesParam,
  secondsFromDate,
  toBigInt,
} from "../src/encode.js";
import { DustSyncError } from "../src/errors.js";

/**
 * The wire↔WASM conversions and the range arithmetic of `spec/00016-dust-wallet-sync.md` §4 and
 * §5.5 steps 3 and 6.
 *
 * Small, and the part of the client most likely to be wrong in a way no root comparison catches:
 * a `ctime` read as milliseconds still produces a VALID `Date`, and a wallet would only find out
 * when its balance came out wrong months later.
 */

describe("encodings (§4)", () => {
  it("reads decimal strings and refuses everything else", () => {
    expect(toBigInt("0", "x")).toBe(0n);
    expect(toBigInt("10938471209384710293847", "x")).toBe(10938471209384710293847n);
    for (const bad of ["", "0x10", "-1", "01", " 7", "1.0", "1e3"]) {
      expect(() => toBigInt(bad, "x"), bad).toThrow(DustSyncError);
    }
  });

  it("treats timestamps as unix SECONDS in both directions", () => {
    expect(dateFromSeconds(1_757_900_000, "t").getTime()).toBe(1_757_900_000_000);
    expect(secondsFromDate(new Date(1_757_900_000_123))).toBe(1_757_900_000);
    expect(() => dateFromSeconds(1.5, "t")).toThrow(DustSyncError);
  });

  it("builds a QualifiedDustOutput the WASM bindings accept", () => {
    const qdo = qdoFromWire({
      initialValue: "5000000",
      owner: "1093",
      nonce: "77",
      seq: "3",
      ctime: 1_757_900_000,
      backingNight: "9f0a",
      mtIndex: "12",
    });
    expect(qdo).toStrictEqual({
      initialValue: 5_000_000n,
      owner: 1093n,
      nonce: 77n,
      seq: 3, // a NUMBER: `PreQualifiedDustOutput.seq` is a u32, not a BigInt
      ctime: new Date(1_757_900_000_000),
      backingNight: "9f0a",
      mtIndex: 12n,
    });
  });

  it("maps a null dtime to undefined, which is the ledger's 'no end time'", () => {
    expect(generationFromWire({ generationIndex: "3", value: "1", owner: "2", nonce: "ab", dtime: null }).dtime)
      .toBeUndefined();
    expect(
      generationFromWire({ generationIndex: "3", value: "1", owner: "2", nonce: "ab", dtime: 1_757_900_000 }).dtime,
    ).toStrictEqual(new Date(1_757_900_000_000));
  });

  it("refuses hex that is not lowercase, unprefixed and whole-byte", () => {
    expect(bytesFromHex("00ff", "x")).toStrictEqual(new Uint8Array([0, 255]));
    for (const bad of ["0xff", "FF", "abc"]) {
      expect(() => bytesFromHex(bad, "x"), bad).toThrow(DustSyncError);
    }
  });
});

describe("gap ranges (§5.5 steps 3 and 6)", () => {
  it("is the complement of the own leaves within [0, firstFree-1]", () => {
    expect(gapRanges([3n], 10n)).toStrictEqual([
      { start: 0n, end: 2n },
      { start: 4n, end: 9n },
    ]);
    expect(rangesParam(gapRanges([3n], 10n))).toBe("0-2,4-9");
  });

  it("emits no range between adjacent own leaves, and none after a trailing own leaf", () => {
    expect(gapRanges([3n, 4n], 10n)).toStrictEqual([
      { start: 0n, end: 2n },
      { start: 5n, end: 9n },
    ]);
    expect(gapRanges([9n], 10n)).toStrictEqual([{ start: 0n, end: 8n }]);
    expect(gapRanges([0n], 1n)).toStrictEqual([]);
  });

  it("covers the whole tree when the wallet owns nothing, and nothing when the tree is empty", () => {
    expect(gapRanges([], 10n)).toStrictEqual([{ start: 0n, end: 9n }]);
    expect(gapRanges([], 0n)).toStrictEqual([]);
  });

  it("reports an own leaf at or past firstFree as index lag, not as a bad range", () => {
    // This is the mirror-behind-the-table case: the leaf is real, the tree has not reached it.
    // Emitting a `[x, firstFree]` range instead would earn a 400 that says nothing useful.
    expect(() => gapRanges([10n], 10n)).toThrowError(
      expect.objectContaining({ code: "DUST_SYNC_INDEX_LAG" }),
    );
  });

  it("refuses unsorted own indices rather than emitting an inverted range", () => {
    expect(() => gapRanges([5n, 2n], 10n)).toThrowError(
      expect.objectContaining({ code: "DUST_SYNC_INVALID_INPUT" }),
    );
  });
});

describe("request caps (§4, FR-015)", () => {
  it("are the node's own", () => {
    expect(MAX_RANGES_PER_REQUEST).toBe(256);
    expect(MAX_NULLIFIERS_PER_REQUEST).toBe(1_000);
  });

  it("splits 1 001 nullifiers into two requests and 257 ranges into two", () => {
    const nullifiers = Array.from({ length: 1_001 }, (_, i) => i);
    const parts = chunk(nullifiers, MAX_NULLIFIERS_PER_REQUEST);
    expect(parts.map((part) => part.length)).toStrictEqual([1_000, 1]);
    expect(parts.flat()).toStrictEqual(nullifiers);

    const ranges = Array.from({ length: 257 }, (_, i) => ({ start: BigInt(i * 2), end: BigInt(i * 2) }));
    expect(chunk(ranges, MAX_RANGES_PER_REQUEST).map((part) => part.length)).toStrictEqual([256, 1]);
  });
});
