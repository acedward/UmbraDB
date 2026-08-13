import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LedgerReplay, ReplayRefusalError } from "../../chain-archive-sync/ledger-replay.js";
import { loadLedgerV8 } from "../../chain-archive-sync/tx-replay-decoder.js";

/**
 * The §7 refusal-parity rows, closed by mechanism-equivalence: the same ledger the reference
 * uses (compiled to WASM), the same strictness, the same BlockContext, the same classification.
 *
 * The reference's row-versus-refusal rule, read from its source
 * (`indexer-common/src/domain/ledger/ledger_state.rs`) and reproduced here:
 *
 *   - bytes that do not deserialize        → block ABORTS  ("malformed payload" row of §7);
 *   - deserializes, fails `well_formed`    → block ABORTS  ("rejected by ledger replay" row);
 *   - applies with `Failure`               → **archived row**, cost uncounted — NOT a refusal;
 *   - Success / PartialSuccess             → archived row, cost counted.
 *
 * The third line is the finding worth a test on its own: a transaction can fail ledger
 * application and still be part of the archive. A replay engine that refused it would diverge
 * from the reference on every such block.
 *
 * All bytes are real: the five genesis system transactions the indexer recorded, and the genesis
 * regular transaction captured from a live 1.0.0 devnet. The corrupted case flips one byte inside
 * the proof, so it still deserializes and dies at exactly the validation stage.
 */
const FIXTURE = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
).trim().split("\n").map((l) => l.trim().split(/\s+/));
const SYSTEM_TXS = FIXTURE.map((f) => ({
  kind: "system" as const,
  rawBytes: new Uint8Array(Buffer.from(f[3]!, "hex")),
}));

/** The real genesis regular transaction (hex without envelope), and a copy with ONE byte flipped
 *  inside the proof region — deserializable, but not well-formed. */
const GOOD_REGULAR_HEX =
  "6d69646e696768743a7472616e73616374696f6e5b76395d287369676e61747572655b76315d2c70726f6f662c706564657273656e2d7363686e6f72725b76315d293a040051020128756e6465706c6f7965640b00203d88792d86f71b8a7a21bfe16a2bb2eab74475073fa5b773854f151ed548dba77a2c58157815f0843fc0701ec174828174fbc4e03d122b40fe97741dd131c92658f533496e48e284ce47644a1d68449ce51b8e20a4c624566827c2f437120e31ec4e628b94c4bcb7dec5a1dbd186677de26fdcacb19130f4126359efe37f471bb9c2496900";
const CORRUPTED_REGULAR_HEX = GOOD_REGULAR_HEX.replace("126359", "126959");

const regular = (hex: string) => ({
  kind: "regular" as const,
  rawBytes: new Uint8Array(Buffer.from(hex, "hex")),
});
const GENESIS_PARENT = "00".repeat(32);

async function genesisReplay(): Promise<LedgerReplay> {
  const replay = LedgerReplay.fromGenesis(await loadLedgerV8(), "undeployed");
  replay.applyBlock({
    transactions: [...SYSTEM_TXS, regular(GOOD_REGULAR_HEX)],
    blockTimestampMs: 0,
    parentBlockHashHex: GENESIS_PARENT,
    parentBlockTimestampMs: 0,
  });
  return replay;
}

describe("ledger replay: the reference's row-versus-refusal classification", () => {
  it("applies the real genesis block cleanly", async () => {
    const replay = LedgerReplay.fromGenesis(await loadLedgerV8(), "undeployed");
    const outcomes = replay.applyBlock({
      transactions: [...SYSTEM_TXS, regular(GOOD_REGULAR_HEX)],
      blockTimestampMs: 0,
      parentBlockHashHex: GENESIS_PARENT,
      parentBlockTimestampMs: 0,
    });
    expect(outcomes).toEqual([
      "system_applied", "system_applied", "system_applied", "system_applied", "system_applied",
      "success",
    ]);
  });

  it("archives an apply-Failure as a row -- it is NOT a refusal", async () => {
    // The same valid transaction applied a second time: well-formed (proofs verify), but its
    // ledger application fails against the advanced state. The reference records TransactionResult
    // Failure, does not count its cost, and keeps indexing. Refusing here would diverge on every
    // block containing a failed-but-valid transaction.
    const replay = await genesisReplay();
    const outcomes = replay.applyBlock({
      transactions: [regular(GOOD_REGULAR_HEX)],
      blockTimestampMs: 6000,
      parentBlockHashHex: "aa".repeat(32),
      parentBlockTimestampMs: 0,
    });
    expect(outcomes).toEqual(["failure"]);
  });

  it("refuses at well_formed for a deserializable-but-invalid payload (§7 replay-rejection row)", async () => {
    // One byte flipped inside the proof: still a structurally valid transaction, so it clears
    // deserialization and dies at exactly the stage the §7 row names.
    const replay = await genesisReplay();
    expect.assertions(2);
    try {
      replay.applyBlock({
        transactions: [regular(CORRUPTED_REGULAR_HEX)],
        blockTimestampMs: 6000,
        parentBlockHashHex: "aa".repeat(32),
        parentBlockTimestampMs: 0,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ReplayRefusalError);
      expect((e as ReplayRefusalError).stage).toBe("well_formed");
    }
  });

  it("refuses at deserialize for bytes that are not a transaction (§7 malformed row)", async () => {
    const replay = await genesisReplay();
    expect.assertions(2);
    try {
      replay.applyBlock({
        transactions: [{ kind: "regular", rawBytes: new Uint8Array([1, 2, 3]) }],
        blockTimestampMs: 6000,
        parentBlockHashHex: "aa".repeat(32),
        parentBlockTimestampMs: 0,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ReplayRefusalError);
      expect((e as ReplayRefusalError).stage).toBe("deserialize");
    }
  });

  it("supports checkpointing via serialize", async () => {
    // What makes restart-without-full-replay possible later: LedgerState.serialize() exists, so
    // replay progress can be checkpointed alongside the watermark when ingest wiring lands.
    const replay = await genesisReplay();
    const bytes = replay.serialize();
    expect(bytes.length).toBeGreaterThan(0);
  });
});

/**
 * T4: real block fullness.
 *
 * Replay used to hand `postBlockUpdate` a hardcoded zero, which two audit rounds did not catch --
 * zero is a plausible-looking number and nothing contradicted it. So these assert the EXACT values,
 * not merely that they are non-zero: a bound that only says "> 0" is satisfied by any arbitrary
 * constant, which is the shape of the bug being fixed.
 *
 * The genesis fixture is unusually good at discriminating wrong implementations, because positions
 * 2 and 24 are `OverwriteParameters`. The parameters therefore change TWICE mid-block, so:
 *
 *   - costing every transaction against `initialParameters` instead of the parameters in force
 *     when it ran gives a different `computeTime` (211772442694 rather than 266408149056);
 *   - reading the block limits from the initial parameters rather than from the state the block
 *     ends at gives a different `bytesChurned` fullness (0.903322 rather than 0.01827188) and a
 *     different overall (0.903322 rather than 0.37696).
 *
 * Both wrong implementations are ones a reasonable person would write, and both are caught here.
 */
describe("ledger replay: block fullness (T4)", () => {
  it("folds genesis to the reference's exact fullness", async () => {
    const replay = LedgerReplay.fromGenesis(await loadLedgerV8(), "undeployed");
    replay.applyBlock({
      transactions: [...SYSTEM_TXS, regular(GOOD_REGULAR_HEX)],
      blockTimestampMs: 0,
      parentBlockHashHex: GENESIS_PARENT,
      parentBlockTimestampMs: 0,
    });

    const fullness = replay.lastBlockFullness!;
    expect(fullness.accumulated).toEqual({
      readTime: 116450000000n,
      computeTime: 266408149056n,
      blockUsage: 0n,
      bytesWritten: 18848n,
      bytesChurned: 913594n,
    });
    expect(fullness.normalized).toEqual({
      readTime: 0.058225,
      computeTime: 0.133204074528,
      blockUsage: 0,
      bytesWritten: 0.37696,
      bytesChurned: 0.01827188,
    });
    // Overall is the MAX across dimensions, not a sum or an average -- both of which would be
    // wrong here and both of which produce a plausible number.
    expect(fullness.overall).toBe(0.37696);
    expect(fullness.overall).toBe(Math.max(...Object.values(fullness.normalized)));
  });

  it("counts the regular transaction's cost, not only the system transactions'", async () => {
    // Isolates the regular half. Without this, an implementation that accumulated ONLY system cost
    // would still satisfy every other assertion in this file -- genesis is mostly system cost, so
    // the totals barely move and "non-zero" stays true.
    const ledger = await loadLedgerV8();
    const systemOnly = LedgerReplay.fromGenesis(ledger, "undeployed");
    systemOnly.applyBlock({
      transactions: [...SYSTEM_TXS],
      blockTimestampMs: 0,
      parentBlockHashHex: GENESIS_PARENT,
      parentBlockTimestampMs: 0,
    });
    const withRegular = LedgerReplay.fromGenesis(ledger, "undeployed");
    withRegular.applyBlock({
      transactions: [...SYSTEM_TXS, regular(GOOD_REGULAR_HEX)],
      blockTimestampMs: 0,
      parentBlockHashHex: GENESIS_PARENT,
      parentBlockTimestampMs: 0,
    });

    expect(systemOnly.lastBlockFullness!.accumulated).toEqual({
      readTime: 115345000000n,
      computeTime: 265153822928n,
      blockUsage: 0n,
      bytesWritten: 18720n,
      bytesChurned: 903322n,
    });
    // The successful regular transaction must move every dimension it touches.
    const a = systemOnly.lastBlockFullness!.accumulated;
    const b = withRegular.lastBlockFullness!.accumulated;
    expect(b.readTime - a.readTime).toBe(1105000000n);
    expect(b.computeTime - a.computeTime).toBe(1254326128n);
    expect(b.bytesWritten - a.bytesWritten).toBe(128n);
    expect(b.bytesChurned - a.bytesChurned).toBe(10272n);
  });

  it("does NOT count the cost of a transaction whose application failed", async () => {
    // The reference's `should_count_cost`: Success and PartialSuccess count, Failure does not --
    // even though a Failure is still an archived row. The transaction here is well-formed and
    // costs something real (it is the same one counted above), so a zero total can only come from
    // the Failure rule being applied, not from the transaction being free.
    const replay = await genesisReplay();
    const outcomes = replay.applyBlock({
      transactions: [regular(GOOD_REGULAR_HEX)],
      blockTimestampMs: 6000,
      parentBlockHashHex: "aa".repeat(32),
      parentBlockTimestampMs: 0,
    });
    expect(outcomes).toEqual(["failure"]);
    expect(replay.lastBlockFullness!.accumulated).toEqual({
      readTime: 0n,
      computeTime: 0n,
      blockUsage: 0n,
      bytesWritten: 0n,
      bytesChurned: 0n,
    });
    expect(replay.lastBlockFullness!.overall).toBe(0);
  });

  it("resets fullness per block rather than accumulating across the chain", async () => {
    // The reference sets `block_fullness: Default::default()` after every `post_block_update`.
    // Carrying it forward would make every block look progressively fuller, drifting the fee
    // market -- and would still look "non-zero and plausible" throughout.
    const replay = await genesisReplay();
    const afterGenesis = replay.lastBlockFullness!.accumulated.bytesChurned;
    expect(afterGenesis).toBeGreaterThan(0n);

    replay.applyBlock({
      transactions: [],
      blockTimestampMs: 6000,
      parentBlockHashHex: "aa".repeat(32),
      parentBlockTimestampMs: 0,
    });
    expect(replay.lastBlockFullness!.accumulated.bytesChurned).toBe(0n);
    expect(replay.lastBlockFullness!.overall).toBe(0);
  });

  it("closes a block with exactly the fullness it reports, not the binding's 0.5 default", async () => {
    // Two assertions, in the order that makes the second one mean something.
    //
    // First: omitting the overall fullness is observably different from passing zero. The binding
    // substitutes 0.5 for an absent value (`ledger-wasm/src/state.rs:74-75`) rather than
    // defaulting to empty, so an omission silently invents a half-full block.
    //
    // Second -- and this is the one that guards `applyBlock` rather than the binding -- the state
    // `applyBlock` actually produces must equal a state closed with the reported values by hand.
    // Asserting only the first would leave `applyBlock` free to omit the argument: an earlier
    // version of this test did exactly that, and a mutation that passed `undefined` from
    // `applyBlock` went green through all ten tests. `lastBlockFullness` cannot catch it either,
    // since it reports what was COMPUTED, not what was PASSED. Only the resulting state can.
    const ledger = await loadLedgerV8();
    const tblock = new Date(6000);
    const zero = { readTime: 0, computeTime: 0, blockUsage: 0, bytesWritten: 0, bytesChurned: 0 };

    const baseline = await genesisReplay();
    const base = ledger.LedgerState.deserialize(baseline.serialize());
    const explicit = base.postBlockUpdate(tblock, zero, 0).serialize();
    const omitted = base.postBlockUpdate(tblock, zero, undefined).serialize();
    expect(
      Buffer.from(omitted).equals(Buffer.from(explicit)),
      "an absent overall fullness must not be equivalent to zero, or this test proves nothing",
    ).toBe(false);

    const replay = await genesisReplay();
    replay.applyBlock({
      transactions: [],
      blockTimestampMs: 6000,
      parentBlockHashHex: "aa".repeat(32),
      parentBlockTimestampMs: 0,
    });
    expect(replay.lastBlockFullness!.overall).toBe(0);
    expect(
      Buffer.from(replay.serialize()).equals(Buffer.from(explicit)),
      "applyBlock must pass the fullness it reports",
    ).toBe(true);
  });

  it("closes genesis with BOTH fullness arguments, on a block whose fullness is non-zero", async () => {
    // The empty-block test above cannot catch an omitted DETAILED fullness, because an empty
    // block's detailed fullness really is zero and the binding's substitute is `NormalizedCost::
    // ZERO` -- omitting it is genuinely equivalent there. Verified: a mutation passing `undefined`
    // for the detailed argument went green through that test.
    //
    // So this repeats the comparison on genesis, where the detailed fullness is non-zero in four
    // of five dimensions. The expected state is built by folding genesis's transactions
    // independently and closing with the constants pinned at the top of this describe -- so the
    // close arguments are checked against numbers, not against whatever the implementation chose.
    const ledger = await loadLedgerV8();
    const tblock = new Date(0);

    let state = ledger.LedgerState.blank("undeployed");
    for (const tx of SYSTEM_TXS) {
      const sysTx = ledger.SystemTransaction.deserialize(tx.rawBytes);
      const [next] = state.applySystemTx(sysTx, tblock);
      state = next;
    }
    const strictness = new ledger.WellFormedStrictness();
    strictness.enforceBalancing = false;
    const parsed = ledger.Transaction.deserialize(
      "signature", "proof", "binding", regular(GOOD_REGULAR_HEX).rawBytes,
    );
    const verified = parsed.wellFormed(state, strictness, tblock);
    const cx = new ledger.TransactionContext(state, {
      secondsSinceEpoch: 0,
      secondsSinceEpochErr: 30,
      parentBlockHash: GENESIS_PARENT,
      lastBlockTime: 0,
    }, undefined);
    const [applied] = state.apply(verified, cx);
    state = applied;

    const NORMALIZED = {
      readTime: 0.058225,
      computeTime: 0.133204074528,
      blockUsage: 0,
      bytesWritten: 0.37696,
      bytesChurned: 0.01827188,
    };
    const OVERALL = 0.37696;
    const expected = state.postBlockUpdate(tblock, NORMALIZED, OVERALL).serialize();

    const replay = LedgerReplay.fromGenesis(ledger, "undeployed");
    replay.applyBlock({
      transactions: [...SYSTEM_TXS, regular(GOOD_REGULAR_HEX)],
      blockTimestampMs: 0,
      parentBlockHashHex: GENESIS_PARENT,
      parentBlockTimestampMs: 0,
    });
    expect(
      Buffer.from(replay.serialize()).equals(Buffer.from(expected)),
      "applyBlock's closed state must match a close with the pinned fullness values",
    ).toBe(true);

    // Both substitutions must be observably different here, or the comparison above is vacuous.
    expect(
      Buffer.from(state.postBlockUpdate(tblock, undefined, OVERALL).serialize())
        .equals(Buffer.from(expected)),
      "omitting the detailed fullness must change the state",
    ).toBe(false);
    expect(
      Buffer.from(state.postBlockUpdate(tblock, NORMALIZED, undefined).serialize())
        .equals(Buffer.from(expected)),
      "omitting the overall fullness must change the state",
    ).toBe(false);
  });
});
