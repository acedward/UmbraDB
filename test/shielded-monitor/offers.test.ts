import { describe, expect, it } from "vitest";
import {
  extractOffers,
  LEDGER_BUILD_ID,
  MATCHING_RULE_VERSION,
  NotAStandardTransactionError,
  UnsupportedProtocolVersionError,
  assertProtocolVersionSupported,
} from "../../shielded-monitor/offers.js";
import { isSupportedProtocolVersion } from "../../chain-archive-sync/extrinsic-decoder.js";

/**
 * The version gate and the payload gate on the one place project B touches the ledger.
 *
 * Both gates run BEFORE the WASM is loaded, which is what makes them testable here without the
 * vendored artifact and, more importantly, what makes them useful: a refusal that only happens
 * after a multi-megabyte module has been loaded and handed bytes it cannot read has already lost
 * the argument. The offer extraction itself is exercised against real transactions by the
 * scanner's own fixtures (00009-03), not here.
 */
describe("shielded-monitor/offers: refusals happen before the ledger is involved", () => {
  const standardPayload = (): Uint8Array =>
    new TextEncoder().encode("midnight:transaction[v9](signature[v1],proof,pedersen-schnorr):body");

  it("refuses a protocol version outside the vendored build's set, with the version named", async () => {
    // Midnight 2.x territory: v9 ledger bytes (`transaction[v12]`) that the vendored v8 codec
    // would either fail on opaquely or, worse, parse into something meaningless.
    await expect(extractOffers(standardPayload(), 2_000_000))
      .rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
    await expect(extractOffers(standardPayload(), 2_000_000))
      .rejects.toThrow(/2000000/);
  });

  it("accepts exactly the protocol versions ingest accepts -- one definition, not two", () => {
    // A reader that accepted MORE than ingest could decode would read rows nothing verified; a
    // reader that accepted less would stall on history the archive holds. Sharing the predicate
    // is what makes both impossible, so the sharing itself is asserted.
    for (const version of [22_000, 22_999, 1_000_000, 1_000_999]) {
      expect(isSupportedProtocolVersion(version)).toBe(true);
      expect(() => assertProtocolVersionSupported(version)).not.toThrow();
    }
    for (const version of [0, 21_999, 23_000, 999_999, 1_001_000, 2_000_000]) {
      expect(isSupportedProtocolVersion(version)).toBe(false);
      expect(() => assertProtocolVersionSupported(version))
        .toThrow(UnsupportedProtocolVersionError);
    }
  });

  it("refuses a non-standard payload rather than returning an empty offer set", async () => {
    // A system transaction has no zswap offers. Returning `{fallible: new Map()}` for it would
    // read as "examined, nothing relevant" -- indistinguishable from a real negative -- so the
    // caller is made to skip it by `kind` instead.
    const systemPayload = new TextEncoder().encode("midnight:system-transaction[v6]:body");
    await expect(extractOffers(systemPayload, 1_000_000))
      .rejects.toBeInstanceOf(NotAStandardTransactionError);
    await expect(extractOffers(new Uint8Array(64), 1_000_000))
      .rejects.toBeInstanceOf(NotAStandardTransactionError);
  });

  it("the version gate runs before the payload gate", async () => {
    // Both are wrong here. The version must win: it is the one that says "this build cannot read
    // these bytes at all", and reporting a tag mismatch for a v9 payload would send an operator
    // looking for corruption instead of for a ledger upgrade.
    await expect(extractOffers(new Uint8Array(8), 2_000_000))
      .rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
  });

  it("records the ledger build the archive itself replays with -- provenance that cannot drift", async () => {
    // A match stored under a build identifier that did not produce it is provenance that lies.
    // The sync service pins the same string for its replay checkpoints; reading it out of the
    // source is deliberate, so bumping the vendored ledger in one place and not the other fails
    // here rather than silently mislabelling associations.
    const { readFileSync } = await import("node:fs");
    const syncService = readFileSync(
      new URL("../../chain-archive-sync/sync-service.ts", import.meta.url), "utf8",
    );
    const pinned = /const LEDGER_STATE_VERSION = "([^"]+)"/.exec(syncService)?.[1];
    expect(pinned, "sync-service.ts must still pin a ledger build identifier").toBeDefined();
    expect(LEDGER_BUILD_ID).toBe(pinned);
    expect(MATCHING_RULE_VERSION).toMatch(/^shielded-monitor\/relevance\/v\d+$/);
  });
});
