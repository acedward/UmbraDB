import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadLedgerV9 } from "../../chain-archive-sync/tx-replay-decoder.js";
import { NIGHT_COLOR_HEX, tokenColorHex } from "../color.js";
import { decodeTokenFlows, type DecodedTokenFlows } from "../ingest/decode.js";
import { fixtureResult, loadActivityFixture, loadActivityFixtures } from "./helpers/archive-fixture.js";
import { fakeLedger, fakeRawTransaction } from "./helpers/fake-ledger.js";

/**
 * Project 00023, sub-plan 01 task A2.3 — `decodeTokenFlows` over the four recorded Stagenet
 * transactions, through the REAL ledger-v9 WASM, plus the shape rules no real transaction can
 * exercise (the fake ledger seam `scan.test.ts`/`events.test.ts` already established).
 *
 * The four fixtures were fetched by hash from the public Stagenet indexer on 2026-09-21; see
 * `fixtures/activity/SOURCE.md`. Nothing here is hand-built: every expected number below was first
 * read off the chain with `.local-00023/probe-tx-detail.mts` and is repeated here so a decoder
 * change that moves it fails loudly.
 *
 * ── Goldens (task A2.4) ────────────────────────────────────────────────────────────────────────
 * `fixtures/activity/<label>.rows.json` and `<label>.view.json` are asserted equal on every run and
 * REWRITTEN when the environment variable `UPDATE_ACTIVITY_GOLDENS=1` is set:
 *
 * ```
 * UPDATE_ACTIVITY_GOLDENS=1 npx vitest run token-indexer/test/activity-decode.test.ts
 * ```
 *
 * Review the diff before committing it — a golden that changed silently is a decoder that changed
 * silently.
 */

const GOLDEN_DIR = new URL("./fixtures/activity/", import.meta.url);
const UPDATE = process.env.UPDATE_ACTIVITY_GOLDENS === "1";

/** `bigint` has no JSON form; every amount in a golden is a decimal STRING, as on the wire. */
function jsonable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

function golden(label: string, suffix: "rows" | "view", actual: unknown): void {
  const file = new URL(`${label}.${suffix}.json`, GOLDEN_DIR);
  const body = `${JSON.stringify(jsonable(actual), null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, body);
    return;
  }
  const expected: unknown = JSON.parse(readFileSync(file, "utf8"));
  expect(jsonable(actual), `${label}.${suffix}.json`).toEqual(expected);
}

describe("decodeTokenFlows over recorded Stagenet transactions", () => {
  let ledger: unknown;

  beforeAll(async () => {
    ledger = await loadLedgerV9();
  }, 180_000);

  function flowsOf(label: string): DecodedTokenFlows {
    const fixture = loadActivityFixture(label);
    return decodeTokenFlows(
      ledger,
      new Uint8Array(Buffer.from(fixture.transaction.raw, "hex")),
      fixtureResult(fixture),
      fixture.transaction.transactionResult?.segments ?? null,
      fixture.transaction.hash,
    );
  }

  it("[[token-activity-decode-utxo]] an unshielded deposit into a contract yields exactly one utxo_in and one contract_in, with the spent UTXO's identity and the spender's address", () => {
    const fixture = loadActivityFixture("deposit-toMap");
    const out = flowsOf("deposit-toMap");
    const COLOR = "254fc19366d929e7a5813f04a89fbc68195046f5261428e721e5d16daca8bc47";
    const OWNER = "db563c77b3b6ab6702720f7c1d9e2d0bfd4204c3f841460b6d03cb0079af585f";

    // Spec US1 scenario 1: two rows "and nothing else".
    expect(out.activity).toHaveLength(2);
    expect(out.activity[0]).toEqual({
      segment: 63196, section: "fallible", role: "utxo_in", itemIndex: 0,
      color: COLOR, kind: 0, amount: 200000n, direction: "out",
      owner: OWNER,
      ownerKey: "schnorr:68e8d35974b5b8999722d88ef1bd6d4118dcbfaf882e623f186683d3aa19020e",
      // The UTXO being SPENT, named exactly as the ledger names it.
      intentHash: "61cfd2c6bcfb2ab52404f9e7f6a5bcb19171e56feaa0decad41ba25b87ea9c78",
      outputNo: 0,
      address: undefined, entryPoint: undefined, callIndex: undefined, domainSep: undefined,
    });
    expect(out.activity[1]).toEqual({
      segment: 63196, section: "fallible", role: "contract_in", itemIndex: 0,
      color: COLOR, kind: 0, amount: 200000n, direction: "in",
      owner: undefined, ownerKey: undefined, intentHash: undefined, outputNo: undefined,
      address: "bc4fa552ea7ed042c54043f732bec591297c8cb0408b7ab54365e36b0dda094b",
      entryPoint: "toMap", callIndex: 0, domainSep: undefined,
    });

    // The colour, the amount and the owner the ledger gave us are the same three facts the INDEXER
    // reports for the same spend — including the owner, which it serves as Bech32m (Q9).
    const spent = fixture.unshieldedSpentOutputs ?? [];
    expect(spent).toHaveLength(1);
    expect(spent[0]!.tokenType).toBe(COLOR);
    expect(spent[0]!.value).toBe("200000");
    expect(spent[0]!.intentHash).toBe("61cfd2c6bcfb2ab52404f9e7f6a5bcb19171e56feaa0decad41ba25b87ea9c78");
    expect(spent[0]!.owner).toMatch(/^mn_addr_stagenet1/);

    // One call, in the fallible transcript, with its public counters.
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({ segment: 63196, callIndex: 0, entryPoint: "toMap" });
    expect(out.calls[0]!.guaranteed).toBeUndefined();
    expect(out.calls[0]!.fallible).toMatchObject({ ops: 62, logOps: 1, counted: true });
    expect(out.calls[0]!.fallible!.gas).toEqual({
      readTime: "4794000000", computeTime: "8537697918", bytesWritten: "2458", bytesDeleted: "2458",
    });
    // No zswap offer at all: this transaction moved an UNSHIELDED token.
    expect(out.offers).toEqual([]);
    // The transaction says its own hash is the one the archive filed it under.
    expect(out.view.selfReportedTxHash).toBe(fixture.transaction.hash);
    golden("deposit-toMap", "rows", out.activity);
    golden("deposit-toMap", "view", out.view);
  }, 60_000);

  it("[[token-activity-decode-delta]] a shielded mint publishes its colour and exact amount through the offer delta, and the mint effect derives the same colour", () => {
    const out = flowsOf("shielded-mint-delta");
    const COLOR = "d086a9e29154d03f507a589c89ea61a453f444c2881b8d0d88192f2965fa2cea";
    const CONTRACT = "4fc92e152e8d854ef9337275504244e18bd6e3d7d41fd81ed2dabf62be78e92f";
    const DOMAIN_SEP = "6f747269782d6c6f79616c74792d726577617264000000000000000000000000";

    expect(out.activity).toHaveLength(2);
    // The delta is NEGATIVE on chain (−1): one unit ENTERED the shielded pool. The row carries the
    // magnitude and says so in `direction`, never a signed amount.
    expect(out.activity[0]).toMatchObject({
      segment: 0, section: "guaranteed", role: "shielded_delta", itemIndex: 0,
      color: COLOR, kind: 1, amount: 1n, direction: "pool_in",
    });
    expect(out.activity[1]).toMatchObject({
      segment: 40256, section: "guaranteed", role: "mint", itemIndex: 0,
      color: COLOR, kind: 1, amount: 1n, direction: "in",
      address: CONTRACT, entryPoint: "mint_shielded", callIndex: 0, domainSep: DOMAIN_SEP,
    });
    // The two rows agree about the colour WITHOUT being told to: one read it off the offer, the
    // other derived it from `(domainSep, contract)`. That is the whole attribution argument.
    expect(tokenColorHex(DOMAIN_SEP, CONTRACT)).toBe(COLOR);
    expect(Buffer.from(DOMAIN_SEP, "hex").toString("utf8").replace(/\0+$/, "")).toBe("otrix-loyalty-reward");

    // The offer itself: one user output commitment, no input, no contract address, one delta.
    expect(out.offers).toEqual([{
      section: "guaranteed", segment: 0, inputs: 0, outputs: 1, transients: 0, deltas: 1, counted: true,
    }]);
    const offer = out.view.offers[0]!;
    expect(offer.deltas).toEqual([{ color: COLOR, delta: "-1", direction: "pool_in" }]);
    expect(offer.outputs).toEqual([
      { commitment: "a94f9761201cc907466b20f2944b5372fcdc2068f352c2a43bdafd3838ab27f6", contractAddress: null },
    ]);
    expect(offer.inputs).toEqual([]);
    expect(offer.transients).toEqual([]);
    golden("shielded-mint-delta", "rows", out.activity);
    golden("shielded-mint-delta", "view", out.view);
  }, 60_000);

  it("[[token-activity-decode-effects]] NIGHT passing through a contract yields all four roles — the UTXO spent and re-created, and the contract's own declared inflow and outflow", () => {
    const fixture = loadActivityFixture("night-passthrough");
    const out = flowsOf("night-passthrough");
    const OWNER = "578d30979c33af7f74fd9fbdb331ea2057ae3ca6b5b51c144c6da501cabb968e";
    const CONTRACT = "29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116";

    expect(out.activity.map((a) => [a.role, a.amount, a.direction])).toEqual([
      ["utxo_in", 10n, "out"],
      ["utxo_out", 10n, "in"],
      ["contract_in", 10n, "in"],
      ["contract_out", 10n, "out"],
    ]);
    // Every one of them is NIGHT — the zero colour, kind 0 — and in the same fallible segment.
    for (const row of out.activity) {
      expect(row.color).toBe(NIGHT_COLOR_HEX);
      expect(row.kind).toBe(0);
      expect(row.segment).toBe(15274);
      expect(row.section).toBe("fallible");
    }
    expect(out.activity[1]).toMatchObject({
      role: "utxo_out", owner: OWNER,
      // THIS transaction's intent hash, and the intent-wide output index (guaranteed first, then
      // fallible) — the numbering the indexer uses for `unshielded_created_outputs`.
      intentHash: "9b9ec88f5b09676801cf7b30be07c9d34d377dacac6312956da2f0648d721a65",
      outputNo: 0,
    });
    expect(out.activity[0]).toMatchObject({
      role: "utxo_in", owner: OWNER,
      intentHash: "e84038c806b3567b5155fbb18f7678abf0ca0ab16879f8402ad47766b6f160d5",
      outputNo: 0,
    });
    for (const row of out.activity.slice(2)) {
      expect(row).toMatchObject({ address: CONTRACT, entryPoint: "register_domain_for", callIndex: 0 });
    }

    // The indexer's own record of the created output agrees about the colour, the value and the
    // intent hash — and serves the owner as Bech32m, which is what the API renders (Q9).
    const created = fixture.unshieldedCreatedOutputs;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tokenType: NIGHT_COLOR_HEX, value: "10", outputIndex: 0,
      intentHash: "9b9ec88f5b09676801cf7b30be07c9d34d377dacac6312956da2f0648d721a65",
    });
    expect(created[0]!.owner).toMatch(/^mn_addr_stagenet1/);

    // The effect maps are keyed by `{tag, raw}` OBJECTS, not by hex strings — the decoder read
    // `.raw` and produced a colour rather than the string "[object Object]".
    expect(out.calls[0]!.fallible!.effects.unshieldedInputs).toEqual([{ color: NIGHT_COLOR_HEX, amount: "10" }]);
    expect(out.calls[0]!.fallible!.effects.unshieldedOutputs).toEqual([{ color: NIGHT_COLOR_HEX, amount: "10" }]);
    golden("night-passthrough", "rows", out.activity);
    golden("night-passthrough", "view", out.view);

    // ---- the two roles no archived transaction carries -------------------------------------
    // Neither shape exists in the archive (0 ClaimRewards transactions in 13 471 blocks, and no
    // archived intent carries unshielded outputs in BOTH sections), so both are proven on the
    // injected ledger seam rather than left untested. They belong to this id because they are the
    // same requirement — FR-001's roles — on the cases the chain has not produced yet.
    // Neither shape exists in the archive (0 ClaimRewards transactions in 13 471 blocks, and no
    // archived intent carries unshielded outputs in BOTH sections), so both are proven here on the
    // injected ledger seam rather than left untested. Same id as the fixture-driven effects test
    // above: it is the same requirement (FR-001's roles), proven on the cases the chain has not
    // produced yet.
    const raw = new Uint8Array(fakeRawTransaction("rewards"));
    const OWNER_KEY = "11".repeat(32);
    const FAKE_OWNER = "22".repeat(32);
    const FAKE_COLOR = "33".repeat(32);

    const rewarded = decodeTokenFlows(fakeLedger({
      rewards: { value: 5_000_000n, ownerKey: OWNER_KEY, nonce: "44".repeat(32), kind: "Reward" },
      addresses: { [OWNER_KEY]: FAKE_OWNER },
      identifiers: [`01${"55".repeat(32)}`, `00${"66".repeat(32)}`],
    }), raw, "success", null, "aa".repeat(32));
    expect(rewarded.activity).toEqual([{
      segment: 0, section: "guaranteed", role: "reward", itemIndex: 0,
      color: NIGHT_COLOR_HEX, kind: 0, amount: 5_000_000n, direction: "in",
      owner: FAKE_OWNER, ownerKey: `schnorr:${OWNER_KEY}`,
      intentHash: "55".repeat(32), outputNo: 0,
      address: undefined, entryPoint: undefined, callIndex: undefined, domainSep: undefined,
    }]);
    expect(rewarded.view.rewards).toEqual({
      value: "5000000", owner: FAKE_OWNER, ownerKey: `schnorr:${OWNER_KEY}`,
      nonce: "44".repeat(32), kind: "Reward",
    });
    // A failed transaction rewards nobody.
    expect(decodeTokenFlows(fakeLedger({
      rewards: { value: 5_000_000n, ownerKey: OWNER_KEY, nonce: "44".repeat(32) },
      addresses: { [OWNER_KEY]: FAKE_OWNER },
    }), raw, "failure", null, "aa".repeat(32)).activity).toEqual([]);

    // The intent-wide output index runs guaranteed-first, then fallible — one counter across both
    // sections, as the indexer numbers `unshielded_created_outputs`.
    const twoSections = decodeTokenFlows(fakeLedger({
      unshielded: [
        { segment: 9, section: "guaranteed", outputs: [{ value: 1n, type: FAKE_COLOR, owner: FAKE_OWNER }] },
        {
          segment: 9, section: "fallible",
          outputs: [{ value: 2n, type: FAKE_COLOR, owner: FAKE_OWNER }, { value: 3n, type: FAKE_COLOR, owner: FAKE_OWNER }],
        },
      ],
    }), raw, "success", null, "bb".repeat(32));
    expect(twoSections.activity.map((a) => [a.section, a.itemIndex, a.outputNo, a.amount])).toEqual([
      ["guaranteed", 0, 0, 1n],
      ["fallible", 0, 1, 2n],
      ["fallible", 1, 2, 3n],
    ]);
  }, 60_000);

  it("[[token-activity-dust-not-tracked]] a transaction that pays a DUST fee produces no DUST row of any kind, while its view lists the spend in full", () => {
    const out = flowsOf("deposit-toMap");

    // 681 of the archive's 683 transactions pay a DUST fee. Not one activity row may come from one.
    expect(out.activity.every((a) => a.role !== "reward")).toBe(true);
    expect(out.activity.map((a) => a.role)).toEqual(["utxo_in", "contract_in"]);
    // Nothing colourless can even exist in the list: DUST is the only token type on this ledger
    // that carries no bytes, and every row has a 32-byte colour.
    for (const row of out.activity) expect(row.color).toMatch(/^[0-9a-f]{64}$/);

    // …and the fee is nevertheless fully visible in the transaction's own view (spec §4).
    const feeIntent = out.view.intents.find((i) => i.dustActions !== null);
    expect(feeIntent).toBeDefined();
    expect(feeIntent!.segment).toBe(1);
    expect(feeIntent!.dustActions!.spends).toEqual([{
      vFee: "248379650240359",
      oldNullifier: "44848361396400679315705836926637186588757455602819015310153542903923345081870",
      newCommitment: "6958064847893218231813871360206557767766271850779445843169258496923566241806",
    }]);
    expect(feeIntent!.dustActions!.registrations).toEqual([]);
    // `ctime` is a WALLET-set time inside the transaction, shown as the transaction's own field and
    // never as the block's time — this lineage's archive has no block time at all (Q1).
    expect(feeIntent!.dustActions!.ctime).toBe("2026-09-17T11:38:18.000Z");
    expect(out.view.feeSpeck).toBe("248379650240359");

    // VERIFY (spec §4): the sum of `vFee` does NOT equal the indexer's `fee`. Measured on all four
    // fixtures 2026-09-21; the offered amount exceeds the required one, which is what a wallet's
    // fee margin looks like. Recorded as question Q15 — the field is what §4 defines it to be, and
    // the archive stores no other fee at all.
    for (const fixture of loadActivityFixtures()) {
      const flows = flowsOf(fixture.label);
      const indexerFee = BigInt(fixture.transaction.fee ?? "0");
      expect(indexerFee > 0n, `${fixture.label} indexer fee`).toBe(true);
      expect(BigInt(flows.view.feeSpeck) > indexerFee, `${fixture.label} vFee vs indexer fee`).toBe(true);
    }
  }, 120_000);

  it("[[token-activity-balanced-invisible]] a balanced shielded offer publishes no colour at all: zero activity rows, an undisclosed offer, and the commitments still on the record", () => {
    const out = flowsOf("balanced-offer-contract");

    // The negative case the whole disclosure panel rests on. The transaction moved shielded value
    // — two inputs, one output, one transient — and the ledger says nothing about WHICH colour.
    expect(out.activity).toEqual([]);
    expect(out.offers).toEqual([{
      section: "guaranteed", segment: 0, inputs: 2, outputs: 1, transients: 1, deltas: 0, counted: true,
    }]);
    const offer = out.view.offers[0]!;
    expect(offer.deltas).toEqual([]);
    expect(offer.deltaCount).toBe(0);

    // What IS public: every commitment, every nullifier, and the contract addresses on them.
    expect(offer.inputs).toEqual([
      {
        nullifier: "95856af4bb2d18f5524d103df01b83774c594bdf9037afed460423e9b5b57f7b",
        contractAddress: "ef8b7033a24a0efd823320cda6c241ce59c52845a176ea90a872615fbc677c8d",
      },
      {
        nullifier: "a55d4320626cf3fffaeccad26fe0b07a18b2333def3e167a739119365d2ba935",
        contractAddress: null,
      },
    ]);
    expect(offer.outputs).toEqual([{
      commitment: "9cc1e90e50d2704d6e1bd7b5c17956286c4cca1b731d58e8d81faac5cd1bb165",
      contractAddress: "ef8b7033a24a0efd823320cda6c241ce59c52845a176ea90a872615fbc677c8d",
    }]);
    expect(offer.transients).toEqual([{
      commitment: "61a11b053dd1b37484a55fe3c6ba3530c5ecd0f23917badb7ecdbee12d8433c7",
      nullifier: "88848cb452d2ee1ad07a1ac5524c494e142380b9a588eece328cd9f86c2bbad7",
      contractAddress: "ef8b7033a24a0efd823320cda6c241ce59c52845a176ea90a872615fbc677c8d",
    }]);
    // The call is recorded too, with the claimed-commitment counts that are its only public trace.
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({ segment: 25074, callIndex: 0, entryPoint: "deposit_shielded" });
    expect(out.calls[0]!.guaranteed!.effects.claimedShieldedReceives).toHaveLength(2);
    expect(out.calls[0]!.guaranteed!.effects.claimedShieldedSpends).toHaveLength(1);
    expect(out.calls[0]!.guaranteed!.effects.claimedNullifiers).toHaveLength(2);
    golden("balanced-offer-contract", "rows", out.activity);
    golden("balanced-offer-contract", "view", out.view);
  }, 60_000);

  it("[[token-activity-unknown-shape-throws]] an effect key of an unrecognised shape throws, naming the transaction — while the chain's two real key shapes, and a DUST key, do not", () => {
    const CONTRACT = "ab".repeat(32);
    const COLOR = "cd".repeat(32);
    const raw = new Uint8Array(fakeRawTransaction("effect-keys"));
    const decode = (ledgerModule: unknown): DecodedTokenFlows =>
      decodeTokenFlows(ledgerModule, raw, "success", null, "deadbeef".repeat(8));

    // The shape the chain really uses: `{tag: 'unshielded', raw}` objects (spec §0).
    const objectKeys = decode(fakeLedger({
      calls: [{ address: CONTRACT, entryPoint: "flow", guaranteed: { inFlows: { [COLOR]: 5n } } }],
    }));
    expect(objectKeys.activity.map((a) => [a.role, a.color, a.amount])).toEqual([["contract_in", COLOR, 5n]]);

    // A bare hex string is accepted too — the "future build" the spec's edge case allows for.
    const stringKeys = decode(fakeLedger({
      calls: [{ address: CONTRACT, entryPoint: "flow", guaranteed: { inFlows: { [COLOR]: 5n }, stringFlowKeys: true } }],
    }));
    expect(stringKeys.activity.map((a) => [a.role, a.color, a.amount])).toEqual([["contract_in", COLOR, 5n]]);

    // A DUST key is the ONE unrecognised-looking key that is skipped rather than thrown on: DUST is
    // deliberately not tracked (Q13), so its absence is a decision, not a loss.
    const dustKey = decode(fakeLedger({
      calls: [{ address: CONTRACT, entryPoint: "flow", guaranteed: { inFlows: { [COLOR]: 5n }, dustFlowKey: true } }],
    }));
    expect(dustKey.activity.map((a) => a.color)).toEqual([COLOR]);

    // Anything else is an error that NAMES the transaction — never a silently dropped movement.
    for (const broken of [42, null, { tag: "unshielded" }, { raw: 7 }, true] as unknown[]) {
      expect(() => decode(fakeLedger({
        calls: [{ address: CONTRACT, entryPoint: "flow", guaranteed: { brokenFlowKey: broken } }],
      })), `key ${JSON.stringify(broken)}`).toThrow(/deadbeef.*unrecognised shape|unrecognised shape/s);
    }
    expect(() => decode(fakeLedger({
      calls: [{ address: CONTRACT, entryPoint: "flow", guaranteed: { brokenFlowKey: 42 } }],
    }))).toThrow(/effects\.unshieldedInputs/);
  });

});
