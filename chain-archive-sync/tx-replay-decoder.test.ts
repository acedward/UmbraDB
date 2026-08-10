import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeArchivedTransaction, isStandardTransaction, loadLedgerV9 } from "./tx-replay-decoder.js";

describe("rc.4 ledger-v9 replay decoder", () => {
  it("loads the pinned Node/WASM package from this repository", async () => {
    const ledger = await loadLedgerV9();
    expect(typeof ledger.Transaction.deserialize).toBe("function");
    expect(typeof ledger.SystemTransaction.deserialize).toBe("function");
  });

  it("recognizes the ledger-v9 family's version-bumped standard transaction tag", async () => {
    const ledger = await loadLedgerV9();
    const raw = ledger.Transaction.fromParts("undeployed").serialize() as Uint8Array;
    expect(Buffer.from(raw.subarray(0, 80)).toString("latin1")).toContain("midnight:transaction[");
    expect(isStandardTransaction(raw)).toBe(true);
  });

  it("decodes the captured rc.4 alice-to-bob transfer into the expected output", async () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./fixtures/rc4-transfer.raw.json", import.meta.url),
      "utf8",
    )) as { transaction: { raw: string } };
    const decoded = decodeArchivedTransaction(
      await loadLedgerV9(),
      Buffer.from(fixture.transaction.raw, "hex"),
    );
    expect(decoded.kind).toBe("standard");
    expect(decoded.unshieldedOutputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        owner: "45bb01c45163890c11520869198871f33d3a8e3f82512d3288a1eadeda425bcc",
        tokenType: "00".repeat(32),
        value: 1_000_000n,
      }),
    ]));
  });

  it("decodes a ledger-v9 genesis reward claim even though it has no intents", async () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./fixtures/rc4-genesis-reward.raw.json", import.meta.url),
      "utf8",
    )) as { transaction: { raw: string }; expected: {
      intentHash: string; owner: string; tokenType: string; value: string;
    } };
    const decoded = decodeArchivedTransaction(
      await loadLedgerV9(),
      Buffer.from(fixture.transaction.raw, "hex"),
    );
    expect(decoded.unshieldedOutputs).toEqual([expect.objectContaining({
      section: "reward",
      intentHash: fixture.expected.intentHash,
      owner: fixture.expected.owner,
      tokenType: fixture.expected.tokenType,
      value: BigInt(fixture.expected.value),
    })]);
  });
});
