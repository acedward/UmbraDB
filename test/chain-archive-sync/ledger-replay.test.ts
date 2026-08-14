import { createHash } from "node:crypto";
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
const [, NATIVE_GENESIS_CLOSE_HASH, ROUNDED_GENESIS_CLOSE_HASH] = readFileSync(
  new URL("../fixtures/ledger-vectors/native-close-block-oracles.txt", import.meta.url),
  "utf8",
).split("\n").find((line) => line.startsWith("genesis-system-transactions "))!
  .split(/\s+/);
const stateHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex");

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

describe("ledger replay: block time is load-bearing (T1)", () => {
  it("folds a different state for a different block timestamp", async () => {
    // The premise of T1's refusal-rather-than-guess rule, stated as a fact rather than assumed.
    // If the block's own time did not reach the fold, exempting genesis from needing one would be
    // harmless and the whole finding would be moot -- so this is the assertion that makes the
    // refusal worth having. Genesis really does carry 1754395200000 on the target node, and
    // folding it at 0 instead produces a demonstrably different ledger state.
    const ledger = await loadLedgerV8();
    const fold = (blockTimestampMs: number) => {
      const replay = LedgerReplay.fromGenesis(ledger, "undeployed");
      replay.applyBlock({
        transactions: [...SYSTEM_TXS, regular(GOOD_REGULAR_HEX)],
        blockTimestampMs,
        parentBlockHashHex: GENESIS_PARENT,
        parentBlockTimestampMs: 0,
      });
      return Buffer.from(replay.serialize());
    };
    expect(fold(0).equals(fold(1754395200000))).toBe(false);
  });

  it("matches node parent-time semantics on a dust-affecting fold, not the indexer restart sentinel", async () => {
    type ParentTimeOracle = {
      networkId: string;
      prestateHex: string;
      transactionHex: string;
      parentHash: string;
      blockTimestampMs: number;
      nodeParentTimestampMs: number;
      sentinelParentTimestampMs: number;
      nodeOutcome: string;
      sentinelOutcome: string;
      nodeDustHash: string;
      sentinelDustHash: string;
      nodeStateHash: string;
      sentinelStateHash: string;
    };
    const oracle = JSON.parse(readFileSync(
      new URL("../fixtures/ledger-vectors/parent-time-dust-oracle.json", import.meta.url),
      "utf8",
    )) as ParentTimeOracle;
    const ledger = await loadLedgerV8();
    const fold = (parentBlockTimestampMs: number) => {
      const replay = LedgerReplay.fromSerialized(
        ledger,
        new Uint8Array(Buffer.from(oracle.prestateHex, "hex")),
      );
      const outcomes = replay.applyBlock({
        transactions: [regular(oracle.transactionHex)],
        blockTimestampMs: oracle.blockTimestampMs,
        parentBlockHashHex: oracle.parentHash,
        parentBlockTimestampMs,
      });
      const stateBytes = replay.serialize();
      const dustBytes = ledger.LedgerState.deserialize(stateBytes).dust.serialize();
      return {
        outcome: outcomes[0],
        stateHash: stateHash(stateBytes),
        dustHash: stateHash(dustBytes),
      };
    };

    const node = fold(oracle.nodeParentTimestampMs);
    const sentinel = fold(oracle.sentinelParentTimestampMs);

    expect(node).toEqual({
      outcome: oracle.nodeOutcome,
      stateHash: oracle.nodeStateHash,
      dustHash: oracle.nodeDustHash,
    });
    expect(sentinel).toEqual({
      outcome: oracle.sentinelOutcome,
      stateHash: oracle.sentinelStateHash,
      dustHash: oracle.sentinelDustHash,
    });
    expect(node.dustHash).not.toBe(sentinel.dustHash);

    // This fixture was assembled and folded by native Rust. Its guaranteed transcript reads
    // QueryContext[7] (`last_block_time`) and gates a signed dust registration: with the real
    // parent it succeeds and changes dust; after an indexer process restart, the zero cursor makes
    // that implementation substitute the CURRENT block time, the guaranteed segment fails, and
    // dust stays unchanged. The expected hashes never pass through LedgerReplay or WASM.
    //
    // The proof marker is structural because this is the post-validation fold boundary: the node
    // function used as authority consumes a VerifiedTransaction, and the vendored WASM replay is
    // compiled without proof verification. Signature, binding, transcript, result classification,
    // dust effects, and block close are all real ledger paths; cryptographic admission is
    // deliberately orthogonal to the parent-time semantic being discriminated.
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
  it("accumulates genesis's exact raw cost", async () => {
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
    // Normalized Q64 values are deliberately absent here. Returning them to JS was the T4a bug:
    // serde converted them to f64 and changed the state when they crossed back into Rust.
    expect(Object.keys(fullness)).toEqual(["accumulated"]);
  });

  it("matches the committed native-Rust close oracle, not the rounded JS counterweight", async () => {
    // The expectation was precomputed by an independently assembled native Rust fold in the
    // ledger fork. It is not derived through closeBlock or through the old normalization binding,
    // which closes the committed-oracle trap that let both sides share the same f64 rounding bug.
    const replay = LedgerReplay.fromGenesis(await loadLedgerV8(), "undeployed");
    replay.applyBlock({
      transactions: SYSTEM_TXS,
      blockTimestampMs: 0,
      parentBlockHashHex: GENESIS_PARENT,
      parentBlockTimestampMs: 0,
    });
    const got = stateHash(replay.serialize());
    expect(got).toBe(NATIVE_GENESIS_CLOSE_HASH);
    expect(got).not.toBe(ROUNDED_GENESIS_CLOSE_HASH);
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
  });

  it("counts cost when the binding returns PartialSuccess (T4b)", () => {
    const partialCost = {
      readTime: 11n,
      computeTime: 22n,
      blockUsage: 33n,
      bytesWritten: 44n,
      bytesChurned: 55n,
    };
    const state = {
      parameters: {},
      apply: () => [state, { type: "partialSuccess" }],
      closeBlock: () => state,
      serialize: () => new Uint8Array([1]),
    };
    const fakeLedger = {
      LedgerState: { blank: () => state },
      WellFormedStrictness: class { enforceBalancing = true; },
      Transaction: {
        deserialize: () => ({
          cost: () => partialCost,
          fees: () => 0n,
          wellFormed: () => ({}),
        }),
      },
      TransactionContext: class {},
    };
    const replay = LedgerReplay.fromGenesis(fakeLedger, "partial-success-fixture");
    const outcomes = replay.applyBlock({
      transactions: [regular("00")],
      blockTimestampMs: 6000,
      parentBlockHashHex: GENESIS_PARENT,
      parentBlockTimestampMs: 0,
    });

    expect(outcomes).toEqual(["partial_success"]);
    expect(replay.lastBlockFullness!.accumulated).toEqual(partialCost);

    // This is a production-branch test, not a cryptographic transaction-construction test: the
    // fake returns the binding's actual public discriminator (`partialSuccess`) and non-zero cost.
    // Changing accumulation to `outcome === "success"` makes this exact assertion red, while the
    // real genesis/Failure fixtures above keep their independent integration coverage.
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
  });
});
