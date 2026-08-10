import { describe, expect, it } from "vitest";
import { foldUtxos, type FoldUtxo } from "./fold.js";

const alice = "mn_addr_alice";
const night = "00".repeat(32);
const genesis: FoldUtxo = {
  owner: alice,
  tokenType: night,
  value: 250_000_000_000_000n,
  intentHash: "11".repeat(32),
  outputIndex: 0,
  createdTransactionId: 1,
};

describe("unshielded UTXO fold", () => {
  it("deduplicates repeated creation delivery", () => {
    const once = foldUtxos([], { created: [genesis], spent: [] });
    const twice = foldUtxos(once.utxos.values(), { created: [genesis], spent: [] });
    expect(twice.utxos.size).toBe(1);
    expect(twice.balances.get(`${alice}:${night}`)).toBe(genesis.value);
  });

  it("does not resurrect an already-spent output when an old creation is redelivered", () => {
    const spent = { ...genesis, spentTransactionId: 2 };
    const afterSpend = foldUtxos([genesis], { created: [], spent: [spent] });
    const afterReplay = foldUtxos(afterSpend.utxos.values(), { created: [genesis], spent: [] });
    expect(afterReplay.balances.get(`${alice}:${night}`) ?? 0n).toBe(0n);
    expect(afterReplay.utxos.get(`${genesis.intentHash}:0`)?.spentTransactionId).toBe(2);
  });
});
