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
