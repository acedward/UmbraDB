import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FINGERPRINT_DOMAIN,
  assertNetworkId,
  monitorFingerprint,
} from "../../shielded-monitor/fingerprint.js";

/**
 * The registration fingerprint (organizer spec FR-003/FR-004).
 *
 * The point of these tests is not that SHA-256 works. It is that the *pre-image construction*
 * cannot change silently: the domain string, the two `0x00` framing bytes and the field order
 * together determine every monitor's identity, so a change to any of them re-identifies every
 * registered monitor in an existing database. The pinned vector below is the tripwire.
 */

/** The reference indexer's committed viewing-key payload, decoded
 *  (`indexer-api/src/infra/api/v4/viewing_key.rs:66-71`). Used here purely as a fixed 32-byte
 *  input, so the pinned vector is tied to a real key rather than an arbitrary buffer. */
const REFERENCE_KEY_BYTES = Buffer.from(
  "6fc92f70f2e4b474b6a184ec0bc8d78aa19c3c153bd8283907b36a7a6556fcb1",
  "hex",
);

describe("monitorFingerprint", () => {
  it("is pinned: the reference key on `undeployed` has one fixed fingerprint", () => {
    // Computed from the implementation on 2026-09-10 and pinned here. If this value changes,
    // the pre-image changed, and every monitor row in every existing database has been
    // re-identified — which is a migration, not a refactor.
    expect(monitorFingerprint("undeployed", REFERENCE_KEY_BYTES).toString("hex")).toBe(
      "09b1613ac6548ce3b55bf66c83ae92592f028aec5c0e8474c13a662907334190",
    );
  });

  it("matches the documented construction exactly, recomputed independently", () => {
    const expected = createHash("sha256")
      .update(Buffer.from(FINGERPRINT_DOMAIN, "utf8"))
      .update(Buffer.of(0x00))
      .update(Buffer.from("undeployed", "utf8"))
      .update(Buffer.of(0x00))
      .update(REFERENCE_KEY_BYTES)
      .digest();
    expect(monitorFingerprint("undeployed", REFERENCE_KEY_BYTES)).toStrictEqual(expected);
  });

  it("pins the domain string itself", () => {
    expect(FINGERPRINT_DOMAIN).toBe("umbradb/shielded-monitor/fp/v1");
  });

  it("is 32 bytes and deterministic", () => {
    const a = monitorFingerprint("undeployed", REFERENCE_KEY_BYTES);
    const b = monitorFingerprint("undeployed", Uint8Array.from(REFERENCE_KEY_BYTES));
    expect(a.length).toBe(32);
    expect(a).toStrictEqual(b);
  });

  it("separates networks: the same key on two networks has two identities", () => {
    expect(monitorFingerprint("undeployed", REFERENCE_KEY_BYTES))
      .not.toStrictEqual(monitorFingerprint("preview", REFERENCE_KEY_BYTES));
  });

  it("separates keys: two keys on one network have two identities", () => {
    const other = Buffer.from(REFERENCE_KEY_BYTES);
    other[0] = other[0]! ^ 0x01;
    expect(monitorFingerprint("undeployed", REFERENCE_KEY_BYTES))
      .not.toStrictEqual(monitorFingerprint("undeployed", other));
  });

  /**
   * The property the `0x00` framing exists for. Without separators, `(net, key)` pairs whose
   * concatenations coincide would collide — and a collision across networks merges two monitors
   * that must stay distinct. With the framing and the network-id charset restriction, no two
   * distinct pairs can share a pre-image.
   */
  it("no two distinct (net, key) pairs collide", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
        fc.uint8Array({ minLength: 1, maxLength: 40 }),
        fc.uint8Array({ minLength: 1, maxLength: 40 }),
        (netA, netB, keyA, keyB) => {
          const same = netA === netB && Buffer.from(keyA).equals(Buffer.from(keyB));
          const equal = monitorFingerprint(netA, keyA).equals(monitorFingerprint(netB, keyB));
          expect(equal).toBe(same);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("refuses an empty key", () => {
    expect(() => monitorFingerprint("undeployed", new Uint8Array(0))).toThrow(/empty serialized key/);
  });

  describe("network id validation (what makes the 0x00 framing injective)", () => {
    for (const bad of ["", "has space", "has/slash", "has.dot", "x".repeat(65), "nul\u0000byte"]) {
      it(`refuses ${JSON.stringify(bad)}`, () => {
        expect(() => assertNetworkId(bad)).toThrow(/invalid network id/);
      });
    }
    for (const good of ["undeployed", "mainnet", "preview", "qanet", "pre-prod", "net_1"]) {
      it(`accepts ${JSON.stringify(good)}`, () => {
        expect(() => assertNetworkId(good)).not.toThrow();
      });
    }
  });
});
