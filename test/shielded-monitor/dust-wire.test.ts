import { describe, expect, it } from "vitest";
import { DustConfigError, loadDustConfig } from "../../shielded-monitor/node/dust/config.js";
import {
  DustHttpError,
  MAX_LOOKUP_BODY_BYTES,
  MAX_NULLIFIERS,
  MAX_RANGES,
  assertRangesWithin,
  decimalOf,
  dustErrorBody,
  hexOf,
  optionalCursor,
  optionalLimit,
  parseLookupBody,
  parseRanges,
  requireDecimal,
  requireNet,
  requireTree,
} from "../../shielded-monitor/node/dust/wire.js";

/**
 * The DUST module's pure halves: its configuration and its request contract
 * (`spec/00016-dust-wallet-sync.md` §4, FR-010, FR-014, FR-015).
 *
 * No database, no WASM, no HTTP — every rule that can refuse a request is decided here, so this
 * suite is the one that can afford to enumerate them.
 */

function params(query: string): URLSearchParams {
  return new URL(`http://x/?${query}`).searchParams;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DustHttpError) return `${err.status} ${err.code}`;
    throw err;
  }
  throw new Error("expected a DustHttpError, nothing was thrown");
}

describe("DUST configuration (FR-010)", () => {
  it("is absent when DUST_DATABASE_URL is unset or blank — the module is then disabled", () => {
    expect(loadDustConfig({})).toBeUndefined();
    expect(loadDustConfig({ DUST_DATABASE_URL: "   " })).toBeUndefined();
  });

  it("defaults everything spec §4 gives a default for", () => {
    const config = loadDustConfig({ DUST_DATABASE_URL: "postgres://r@h/db" })!;
    expect(config.snapshotDir).toBe("./dust-state");
    expect(config.pollMs).toBe(2_000);
    expect(config.snapshotEvery).toBe(20_000);
    expect(config.replayBatch).toBe(1_000);
    // Question Q-23 option A: 2 MiB. At the measured ~112 B per event that is ~18 700 events,
    // i.e. ~20 s of replay -- inside the regime where restoring is the cheaper of the two.
    expect(config.snapshotMaxBytes).toBe(2_097_152);
  });

  it("reads every override", () => {
    const config = loadDustConfig({
      DUST_DATABASE_URL: "postgresql://r@h/db",
      DUST_STATE_SNAPSHOT_DIR: "/var/lib/dust",
      DUST_STATE_POLL_MS: "500",
      DUST_STATE_SNAPSHOT_EVERY: "5000",
      DUST_REPLAY_BATCH: "250",
      DUST_STATE_SNAPSHOT_MAX_BYTES: "4194304",
    })!;
    expect(config).toStrictEqual({
      databaseUrl: "postgresql://r@h/db",
      snapshotDir: "/var/lib/dust",
      pollMs: 500,
      snapshotEvery: 5_000,
      replayBatch: 250,
      snapshotMaxBytes: 4_194_304,
    });
  });

  it("fails closed on a bad number, naming the variable", () => {
    expect(() => loadDustConfig({ DUST_DATABASE_URL: "postgres://r@h/db", DUST_STATE_POLL_MS: "0" }))
      .toThrow(DustConfigError);
    expect(() => loadDustConfig({ DUST_DATABASE_URL: "postgres://r@h/db", DUST_REPLAY_BATCH: "1e3" }))
      .toThrow(/DUST_REPLAY_BATCH/);
  });

  it("refuses a URL that is not postgres, and never quotes the value back", () => {
    // The value is a connection string: it normally carries a password, so no message may echo it.
    const secret = "http://user:hunter2@host/db";
    let message = "";
    try {
      loadDustConfig({ DUST_DATABASE_URL: secret });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("DUST_DATABASE_URL");
    expect(message).not.toContain("hunter2");

    let bad = "";
    try {
      loadDustConfig({ DUST_DATABASE_URL: "not a url at all" });
    } catch (err) {
      bad = (err as Error).message;
    }
    expect(bad).toContain("is not a URL");
    expect(bad).not.toContain("not a url at all");
  });

  it("does not use a name ending in _PG — no-database.ts would refuse the node at boot", () => {
    // Deliberately a test and not a comment: the refusal in `no-database.ts` is untouched by the
    // waiver, and renaming this variable to `DUST_PG` would make the node unstartable.
    const names = [
      "DUST_DATABASE_URL",
      "DUST_STATE_SNAPSHOT_DIR",
      "DUST_STATE_POLL_MS",
      "DUST_STATE_SNAPSHOT_EVERY",
      "DUST_REPLAY_BATCH",
      "DUST_STATE_SNAPSHOT_MAX_BYTES",
    ];
    expect(names.filter((n) => n.endsWith("_PG"))).toStrictEqual([]);
  });
});

describe("shared parameter validation (spec §4)", () => {
  it("requires net on every route", () => {
    expect(requireNet(params("net=preprod"))).toBe("preprod");
    expect(codeOf(() => requireNet(params("")))).toBe("400 DUST_BAD_PARAM");
    expect(codeOf(() => requireNet(params("net=a%20b")))).toBe("400 DUST_BAD_PARAM");
  });

  it("takes an owner only in its canonical decimal spelling", () => {
    expect(requireDecimal(params("owner=109"), "owner")).toBe("109");
    expect(requireDecimal(params("owner=0"), "owner")).toBe("0");
    // A leading zero is refused rather than normalised: the lookup route echoes the caller's own
    // strings back, and two spellings of one value would break a client matching on the echo.
    expect(codeOf(() => requireDecimal(params("owner=0109"), "owner"))).toBe("400 DUST_BAD_PARAM");
    expect(codeOf(() => requireDecimal(params("owner=0x10"), "owner"))).toBe("400 DUST_BAD_PARAM");
    expect(codeOf(() => requireDecimal(params("owner=-1"), "owner"))).toBe("400 DUST_BAD_PARAM");
    expect(codeOf(() => requireDecimal(params(""), "owner"))).toBe("400 DUST_BAD_PARAM");
  });

  it("treats an absent cursor as the start", () => {
    expect(optionalCursor(params(""), "afterId")).toBe(0n);
    expect(optionalCursor(params("afterId=41"), "afterId")).toBe(41n);
    expect(codeOf(() => optionalCursor(params("afterId=-1"), "afterId"))).toBe("400 DUST_BAD_PARAM");
  });

  it("refuses a limit above the cap rather than clamping it", () => {
    // A client that asked for 5 000 and silently got 1 000 would page wrongly.
    expect(optionalLimit(params(""), 100)).toBe(100);
    expect(optionalLimit(params("limit=1000"), 100)).toBe(1_000);
    expect(codeOf(() => optionalLimit(params("limit=1001"), 100))).toBe("400 DUST_BAD_PARAM");
    expect(codeOf(() => optionalLimit(params("limit=0"), 100))).toBe("400 DUST_BAD_PARAM");
  });

  it("accepts only the two tree names", () => {
    expect(requireTree(params("tree=commitment"))).toBe("commitment");
    expect(requireTree(params("tree=generation"))).toBe("generation");
    expect(codeOf(() => requireTree(params("tree=Commitment")))).toBe("400 DUST_BAD_PARAM");
  });

  it("encodes field elements as decimals, bytes as bare lowercase hex", () => {
    expect(decimalOf(10n ** 30n)).toBe("1000000000000000000000000000000");
    expect(hexOf(Buffer.from([0xab, 0x0f]))).toBe("ab0f");
    expect(hexOf("0xAB0F")).toBe("ab0f");
  });
});

describe("segments ranges (FR-014)", () => {
  it("parses an ascending, non-overlapping list", () => {
    expect(parseRanges("0-2,4-1191876")).toStrictEqual([
      { start: 0n, end: 2n },
      { start: 4n, end: 1_191_876n },
    ]);
  });

  it("accepts a single-leaf range", () => {
    expect(parseRanges("17-17")).toStrictEqual([{ start: 17n, end: 17n }]);
  });

  it("refuses more than 256 ranges", () => {
    const many = Array.from({ length: MAX_RANGES + 1 }, (_, i) => `${i * 2}-${i * 2}`).join(",");
    expect(codeOf(() => parseRanges(many))).toBe("400 DUST_RANGE_INVALID");
    const exactly = Array.from({ length: MAX_RANGES }, (_, i) => `${i * 2}-${i * 2}`).join(",");
    expect(parseRanges(exactly)).toHaveLength(MAX_RANGES);
  });

  it("refuses start > end, overlap, descending order and non-numeric input", () => {
    expect(codeOf(() => parseRanges("9-4"))).toBe("400 DUST_RANGE_INVALID");
    expect(codeOf(() => parseRanges("0-10,5-20"))).toBe("400 DUST_RANGE_INVALID");
    expect(codeOf(() => parseRanges("0-10,10-20"))).toBe("400 DUST_RANGE_INVALID");
    expect(codeOf(() => parseRanges("20-30,0-10"))).toBe("400 DUST_RANGE_INVALID");
    expect(codeOf(() => parseRanges("a-b"))).toBe("400 DUST_RANGE_INVALID");
    expect(codeOf(() => parseRanges("0x1-2"))).toBe("400 DUST_RANGE_INVALID");
    expect(codeOf(() => parseRanges(""))).toBe("400 DUST_RANGE_INVALID");
    expect(codeOf(() => parseRanges(null))).toBe("400 DUST_RANGE_INVALID");
  });

  it("refuses a range that ends at or past firstFree, and refuses everything on an empty tree", () => {
    assertRangesWithin([{ start: 0n, end: 8n }], 9n);
    expect(codeOf(() => assertRangesWithin([{ start: 0n, end: 9n }], 9n))).toBe("400 DUST_RANGE_INVALID");
    // `firstFree === 0` is a real state (devnet at genesis). `end >= firstFree` is the comparison
    // precisely so this does not underflow into "end > -1", which admits everything.
    expect(codeOf(() => assertRangesWithin([{ start: 0n, end: 0n }], 0n))).toBe("400 DUST_RANGE_INVALID");
  });
});

describe("lookup body (FR-015)", () => {
  const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");

  it("parses a well-formed body and preserves the caller's order, duplicates included", () => {
    const parsed = parseLookupBody(body({ net: "preprod", nullifiers: ["9082", "4411", "9082"] }));
    expect(parsed.net).toBe("preprod");
    expect(parsed.nullifiers).toStrictEqual(["9082", "4411", "9082"]);
  });

  it("refuses 1 001 nullifiers but accepts 1 000", () => {
    const ok = Array.from({ length: MAX_NULLIFIERS }, (_, i) => String(i));
    expect(parseLookupBody(body({ net: "preprod", nullifiers: ok })).nullifiers).toHaveLength(MAX_NULLIFIERS);
    expect(codeOf(() => parseLookupBody(body({ net: "preprod", nullifiers: [...ok, "1000"] }))))
      .toBe("400 DUST_LOOKUP_INVALID");
  });

  it("refuses a malformed decimal, an empty list, a missing net and non-JSON", () => {
    expect(codeOf(() => parseLookupBody(body({ net: "preprod", nullifiers: ["0x41"] }))))
      .toBe("400 DUST_LOOKUP_INVALID");
    expect(codeOf(() => parseLookupBody(body({ net: "preprod", nullifiers: [41] }))))
      .toBe("400 DUST_LOOKUP_INVALID");
    expect(codeOf(() => parseLookupBody(body({ net: "preprod", nullifiers: [] }))))
      .toBe("400 DUST_LOOKUP_INVALID");
    expect(codeOf(() => parseLookupBody(body({ nullifiers: ["41"] })))).toBe("400 DUST_LOOKUP_INVALID");
    expect(codeOf(() => parseLookupBody(Buffer.from("{", "utf8")))).toBe("400 DUST_LOOKUP_INVALID");
    expect(codeOf(() => parseLookupBody(body(["41"])))).toBe("400 DUST_LOOKUP_INVALID");
  });

  it("caps the body BEFORE parsing it", () => {
    const huge = Buffer.alloc(MAX_LOOKUP_BODY_BYTES + 1, 0x20);
    expect(codeOf(() => parseLookupBody(huge))).toBe("400 DUST_LOOKUP_INVALID");
  });

  it("NEVER quotes a nullifier back in a refusal (SC-006)", () => {
    // The whole custody promise of this route is that the value reaches one parameterised query
    // and nothing else. An error message is the easiest way for it to reach a log instead.
    const secret = "123456789012345678901234567890123456789012345678901234567890123456789012345678";
    let message = "";
    try {
      parseLookupBody(body({ net: "preprod", nullifiers: ["1", `${secret}x`] }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("nullifier at position 1 is not a decimal field element");
    expect(message).not.toContain(secret.slice(0, 20));
  });

  it("renders a refusal as spec §4's error body", () => {
    expect(dustErrorBody(new DustHttpError(503, "DUST_NOT_READY", "the mirror is still replaying")))
      .toStrictEqual({ error: { code: "DUST_NOT_READY", message: "the mirror is still replaying" } });
  });
});
