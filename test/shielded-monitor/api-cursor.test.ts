import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CursorError, decodeCursor, encodeCursor } from "../../shielded-monitor/api/cursor.js";

/**
 * The matches cursor (organizer spec FR-019). No Docker: the codec is pure.
 *
 * The interesting assertions here are the negative ones. A cursor that round-trips is table
 * stakes; what FR-019 actually requires is that a cursor is *bound to its monitor*, and that
 * every malformed shape is refused rather than coerced into a plausible position.
 */
describe("matches cursor codec", () => {
  const ID_A = "1e3f4c8a-0b2d-4f6e-8a1b-2c3d4e5f6a7b";
  const ID_B = "2e3f4c8a-0b2d-4f6e-8a1b-2c3d4e5f6a7b";

  it("round-trips any (monitorId, seq) pair", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.bigInt({ min: 0n, max: 9_223_372_036_854_775_807n }),
        (id, seq) => {
          expect(decodeCursor(encodeCursor(id, seq), id)).toBe(seq);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never emits a character that needs escaping in a query string", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.bigInt({ min: 0n, max: 10_000_000n }), (id, seq) => {
        const cursor = encodeCursor(id, seq);
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(encodeURIComponent(cursor)).toBe(cursor);
      }),
      { numRuns: 200 },
    );
  });

  it("refuses a cursor minted for another monitor (FR-019: a cursor is bound to its monitor)", () => {
    const cursor = encodeCursor(ID_A, 17n);
    expect(() => decodeCursor(cursor, ID_B)).toThrowError(CursorError);
    try {
      decodeCursor(cursor, ID_B);
      expect.unreachable("a cross-monitor cursor must be refused");
    } catch (err) {
      expect((err as CursorError).rejection).toBe("monitor-mismatch");
    }
  });

  it("accepts the same cursor under a differently-cased spelling of the same id", () => {
    // `randomUUID()` is lowercase, but a consumer that upper-cases the id in its own path would
    // otherwise be told its own cursor belongs to another monitor.
    const cursor = encodeCursor(ID_A, 5n);
    expect(decodeCursor(cursor, ID_A.toUpperCase())).toBe(5n);
  });

  /** Each malformed class is asserted by its OWN rejection reason, not merely "threw" — a codec
   *  that rejected everything for one reason would pass a `toThrow`-only test while being unable
   *  to tell a forged cursor from a truncated one. */
  it.each([
    ["empty", "", "not-base64url"],
    ["standard base64 padding", "YWJjZA==", "not-base64url"],
    ["base64 '+' and '/'", "YW+/ZA", "not-base64url"],
    ["over the length bound", "A".repeat(257), "not-base64url"],
    ["no separator", Buffer.from(ID_A).toString("base64url"), "malformed"],
    ["two separators", Buffer.from(`${ID_A}:1:2`).toString("base64url"), "malformed"],
    ["leading separator", Buffer.from(`:${ID_A}`).toString("base64url"), "malformed"],
    ["non-uuid monitor id", Buffer.from("not-a-uuid:1").toString("base64url"), "malformed"],
    ["negative sequence", Buffer.from(`${ID_A}:-1`).toString("base64url"), "malformed"],
    ["hex sequence", Buffer.from(`${ID_A}:0x10`).toString("base64url"), "malformed"],
    ["padded sequence", Buffer.from(`${ID_A}: 1`).toString("base64url"), "malformed"],
    ["empty sequence", Buffer.from(`${ID_A}:`).toString("base64url"), "malformed"],
    [
      "sequence above int8",
      Buffer.from(`${ID_A}:9223372036854775808`).toString("base64url"),
      "sequence-out-of-range",
    ],
  ])("refuses %s", (_name, cursor, rejection) => {
    try {
      decodeCursor(cursor, ID_A);
      expect.unreachable(`${_name} must be refused`);
    } catch (err) {
      expect(err).toBeInstanceOf(CursorError);
      expect((err as CursorError).rejection).toBe(rejection);
    }
  });

  it("a freshly minted uuid's cursor decodes under that uuid and no other", () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    expect(decodeCursor(encodeCursor(mine, 0n), mine)).toBe(0n);
    expect(() => decodeCursor(encodeCursor(mine, 0n), theirs)).toThrowError(CursorError);
  });
});
