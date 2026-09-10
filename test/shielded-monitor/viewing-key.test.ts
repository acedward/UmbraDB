import { inspect, format } from "node:util";
import { describe, expect, it } from "vitest";
import { loadLedgerV8, ledgerV8EntryPath } from "../../chain-archive-sync/tx-replay-decoder.js";
import { decodeBech32m, encodeBech32m } from "../../shielded-monitor/bech32m.js";
import { INVALID_VIEWING_KEY_MESSAGE, InvalidViewingKeyError } from "../../shielded-monitor/errors.js";
import {
  LEDGER_BUILD_ID,
  REDACTED,
  ShieldedViewingKey,
  encodeViewingKey,
  hrpForNetwork,
  parseViewingKey,
} from "../../shielded-monitor/viewing-key.js";

/**
 * Viewing-key intake (organizer spec FR-001, FR-002, FR-023; SC-004).
 *
 * The vendored ledger artifact is a committed dependency of this repository
 * (`vendor/ledger-v8-syshash`), so these tests do not self-skip; `ledgerV8EntryPath()` is
 * asserted present up front, which turns a missing artifact into a named failure rather than a
 * silently green run.
 */

/**
 * The reference indexer's own committed test vector
 * (`indexer-api/src/infra/api/v4/viewing_key.rs:66-71`). Using the reference's vector rather than
 * one of ours is the point: it proves this implementation accepts what the system it replaces
 * accepts, and its 32-byte payload is a *different* canonical length from the 33-byte one
 * `ZswapSecretKeys.fromSeed` produces, so both branches of the ledger's variable-length encoding
 * are covered by real data.
 *
 * This is a published test vector from an open-source reference implementation, not a key with
 * any value; it guards no funds on any network.
 */
const REFERENCE_VECTOR =
  "mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h";

const UNDEPLOYED_HRP = "mn_shield-esk_undeployed";

function rejectionOf(err: unknown): string {
  expect(err).toBeInstanceOf(InvalidViewingKeyError);
  return (err as InvalidViewingKeyError).rejection;
}

async function expectRejected(encoded: unknown, net: string): Promise<InvalidViewingKeyError> {
  try {
    await parseViewingKey(encoded, net);
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidViewingKeyError);
    return err as InvalidViewingKeyError;
  }
  throw new Error(`expected ${String(encoded).slice(0, 24)}… to be rejected on ${net}`);
}

describe("viewing-key intake", () => {
  it("the vendored ledger artifact is present (so nothing below is vacuously skipped)", () => {
    expect(ledgerV8EntryPath()).toBeDefined();
  });

  describe("HRP rule (indexer-api/src/infra/api/v4.rs:149-158)", () => {
    it("uses the bare prefix on mainnet, case-insensitively", () => {
      expect(hrpForNetwork("mainnet")).toBe("mn_shield-esk");
      expect(hrpForNetwork("MAINNET")).toBe("mn_shield-esk");
    });

    it("suffixes every other network", () => {
      expect(hrpForNetwork("undeployed")).toBe(UNDEPLOYED_HRP);
      expect(hrpForNetwork("preview")).toBe("mn_shield-esk_preview");
      expect(hrpForNetwork("qanet")).toBe("mn_shield-esk_qanet");
    });

    it("refuses a network id that could not appear in a valid HRP", () => {
      expect(() => hrpForNetwork("has space")).toThrow(/invalid network id/);
    });
  });

  describe("accepts real keys", () => {
    it("accepts the reference indexer's committed vector on `undeployed`", async () => {
      const key = await parseViewingKey(REFERENCE_VECTOR, "undeployed");
      expect(key).toBeInstanceOf(ShieldedViewingKey);
      expect(key.net).toBe("undeployed");
      expect(key.serializedLength).toBe(32);
      expect(Buffer.from(key.yesIKnowTheSecurityImplicationsOfThis_serialized())).toStrictEqual(
        Buffer.from(decodeBech32m(REFERENCE_VECTOR).data),
      );
    });

    it("accepts a key derived from ZswapSecretKeys.fromSeed and round-trips its bytes", async () => {
      const ledger = (await loadLedgerV8()) as {
        ZswapSecretKeys: {
          fromSeed(seed: Uint8Array): {
            encryptionSecretKey: { yesIKnowTheSecurityImplicationsOfThis_serialize(): Uint8Array };
          };
        };
      };
      // A fixture seed, marked as such: it is a test constant, never a real key.
      const seed = new Uint8Array(32).fill(7);
      const serialized = ledger.ZswapSecretKeys.fromSeed(seed).encryptionSecretKey
        .yesIKnowTheSecurityImplicationsOfThis_serialize();
      // The ledger's encoding is variable-length: this key is 33 bytes where the reference
      // vector is 32. Both are canonical; asserting the difference keeps the test honest about
      // what the format is.
      expect(serialized.length).toBe(33);

      const encoded = encodeViewingKey(serialized, "undeployed");
      expect(encoded.startsWith(`${UNDEPLOYED_HRP}1`)).toBe(true);

      const key = await parseViewingKey(encoded, "undeployed");
      expect(Buffer.from(key.yesIKnowTheSecurityImplicationsOfThis_serialized()))
        .toStrictEqual(Buffer.from(serialized));
    });

    it("the same key on two networks yields two different fingerprints", async () => {
      const bytes = decodeBech32m(REFERENCE_VECTOR).data;
      const onUndeployed = await parseViewingKey(encodeViewingKey(bytes, "undeployed"), "undeployed");
      const onPreview = await parseViewingKey(encodeViewingKey(bytes, "preview"), "preview");
      expect(onUndeployed.fingerprint).not.toStrictEqual(onPreview.fingerprint);
    });

    it("pins the ledger build identifier recorded as provenance", () => {
      expect(LEDGER_BUILD_ID).toBe("ledger-v8@8.1.0-syshash.4");
    });
  });

  describe("refuses everything else, with ONE generic message (FR-001)", () => {
    it("refuses the reference vector on a different network (wrong HRP)", async () => {
      const err = await expectRejected(REFERENCE_VECTOR, "preview");
      expect(rejectionOf(err)).toBe("network-hrp");
    });

    it("refuses the reference vector on mainnet (bare-prefix HRP expected)", async () => {
      const err = await expectRejected(REFERENCE_VECTOR, "mainnet");
      expect(rejectionOf(err)).toBe("network-hrp");
    });

    it("refuses a garbage string", async () => {
      expect(rejectionOf(await expectRejected("not-a-key", "undeployed"))).toBe("bech32m");
    });

    it("refuses a corrupted checksum", async () => {
      const corrupted = REFERENCE_VECTOR.slice(0, -1) + (REFERENCE_VECTOR.endsWith("h") ? "g" : "h");
      expect(rejectionOf(await expectRejected(corrupted, "undeployed"))).toBe("bech32m");
    });

    it("refuses a non-string", async () => {
      expect(rejectionOf(await expectRejected(42, "undeployed"))).toBe("not-a-string");
      expect(rejectionOf(await expectRejected(undefined, "undeployed"))).toBe("not-a-string");
      expect(rejectionOf(await expectRejected(Buffer.alloc(32), "undeployed"))).toBe("not-a-string");
    });

    it("refuses a well-formed envelope whose payload the ledger rejects", async () => {
      const bogus = encodeBech32m(UNDEPLOYED_HRP, new Uint8Array(32).fill(0xff));
      expect(rejectionOf(await expectRejected(bogus, "undeployed"))).toBe("ledger-rejected");
    });

    /**
     * Every rejection above must be indistinguishable to a caller. This is the assertion that
     * makes FR-001's "one generic client error" real rather than aspirational: if a future edit
     * adds a helpful, specific message to any branch, this fails.
     */
    it("every rejection carries the identical message and no fragment of the input", async () => {
      const bogus = encodeBech32m(UNDEPLOYED_HRP, new Uint8Array(32).fill(0xff));
      const errors = [
        await expectRejected(REFERENCE_VECTOR, "preview"),
        await expectRejected("not-a-key", "undeployed"),
        await expectRejected(bogus, "undeployed"),
        await expectRejected(42, "undeployed"),
      ];
      for (const err of errors) {
        expect(err.message).toBe(INVALID_VIEWING_KEY_MESSAGE);
        expect(err.code).toBe("SHIELDED_MONITOR_INVALID_VIEWING_KEY");
        expect(err.retryable).toBe("non-retryable");
        const rendered = `${err.message} ${inspect(err)} ${String(err.cause ?? "")}`;
        expect(rendered).not.toContain(REFERENCE_VECTOR);
        expect(rendered).not.toContain(REFERENCE_VECTOR.slice(-20));
      }
      expect(new Set(errors.map((e) => e.message)).size).toBe(1);
    });
  });

  /**
   * Canonical-encoding enforcement (organizer question Q13). The ledger's `deserialize` reads a
   * compact length prefix and ignores trailing bytes, so without this rule one key would have
   * unboundedly many fingerprints and registration idempotency (FR-004) would be defeated by
   * appending a byte. Each case below is a behaviour measured against the vendored build.
   */
  describe("the payload must be the key's canonical encoding (Q13)", () => {
    it("refuses the reference key with one junk byte appended", async () => {
      const padded = encodeBech32m(UNDEPLOYED_HRP, new Uint8Array([...decodeBech32m(REFERENCE_VECTOR).data, 0xaa]));
      expect(rejectionOf(await expectRejected(padded, "undeployed"))).toBe("non-canonical");
    });

    it("refuses 32 zero bytes, whose canonical encoding is a single 0x00", async () => {
      const zeros = encodeBech32m(UNDEPLOYED_HRP, new Uint8Array(32));
      expect(rejectionOf(await expectRejected(zeros, "undeployed"))).toBe("non-canonical");
    });

    it("the padded and unpadded forms WOULD have had different fingerprints (why the rule exists)", async () => {
      const bytes = decodeBech32m(REFERENCE_VECTOR).data;
      const accepted = await parseViewingKey(REFERENCE_VECTOR, "undeployed");
      // Constructed directly, bypassing intake, purely to show what the rule prevents.
      const padded = new ShieldedViewingKey("undeployed", new Uint8Array([...bytes, 0xaa]));
      expect(padded.fingerprint).not.toStrictEqual(accepted.fingerprint);
    });
  });

  /**
   * Organizer spec FR-023 and SC-004: no viewing key in logs, metrics or error bodies. Every
   * path below is one a real logger actually takes.
   */
  describe("the key type redacts itself on every stringification path", () => {
    it("redacts under String, template interpolation, JSON, inspect and format specifiers", async () => {
      const key = await parseViewingKey(REFERENCE_VECTOR, "undeployed");
      const payloadHex = Buffer.from(key.yesIKnowTheSecurityImplicationsOfThis_serialized()).toString("hex");

      const renderings = [
        String(key),
        `${key}`,
        key.toString(),
        JSON.stringify(key),
        JSON.stringify({ nested: { key } }),
        inspect(key),
        inspect({ nested: { key } }, { depth: 10 }),
        format("%s", key),
        format("%o", key),
        format("%j", key),
        [key].join(","),
      ];

      for (const rendering of renderings) {
        expect(rendering).toContain(REDACTED);
        expect(rendering).not.toContain(payloadHex);
        expect(rendering).not.toContain(REFERENCE_VECTOR);
        // The raw byte values must not leak in any decimal/array rendering either.
        expect(rendering).not.toMatch(/111,\s*201,\s*47/); // 0x6f, 0xc9, 0x2f — the first three bytes
      }
    });

    /**
     * Positive control. Without it, the assertions above would still pass against an
     * implementation that renders the key as an empty string, or against a test whose "payload"
     * needle is something no rendering could ever contain.
     */
    it("POSITIVE CONTROL: the same assertions fail for a plain object holding the same bytes", async () => {
      const key = await parseViewingKey(REFERENCE_VECTOR, "undeployed");
      const payloadHex = Buffer.from(key.yesIKnowTheSecurityImplicationsOfThis_serialized()).toString("hex");
      const leaky = { serializedHex: payloadHex };
      expect(JSON.stringify(leaky)).toContain(payloadHex);
      expect(inspect(leaky)).toContain(payloadHex);
      expect(JSON.stringify(leaky)).not.toContain(REDACTED);
    });

    it("exposes only a length, never the bytes, through its public non-secret surface", async () => {
      const key = await parseViewingKey(REFERENCE_VECTOR, "undeployed");
      expect(key.serializedLength).toBe(32);
      expect(Object.keys(key)).toStrictEqual(["net", "fingerprint"]);
    });

    it("copies the caller's buffer, so a later mutation cannot change a registered key", async () => {
      const bytes = Uint8Array.from(decodeBech32m(REFERENCE_VECTOR).data);
      const key = new ShieldedViewingKey("undeployed", bytes);
      const before = Buffer.from(key.yesIKnowTheSecurityImplicationsOfThis_serialized());
      bytes[0] ^= 0xff;
      expect(Buffer.from(key.yesIKnowTheSecurityImplicationsOfThis_serialized())).toStrictEqual(before);
    });

    it("hands out a copy, so a caller cannot mutate the held key through the accessor", async () => {
      const key = await parseViewingKey(REFERENCE_VECTOR, "undeployed");
      const first = key.yesIKnowTheSecurityImplicationsOfThis_serialized();
      first[0] ^= 0xff;
      expect(key.yesIKnowTheSecurityImplicationsOfThis_serialized()[0]).not.toBe(first[0]);
    });
  });
});
