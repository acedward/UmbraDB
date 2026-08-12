/**
 * Ledger replay: advancing real ledger state across archived blocks, the way the reference
 * indexer does while indexing.
 *
 * WHY. The reference does not merely extract transactions -- it deserializes each one and applies
 * it to its own ledger state (`indexer-common/src/domain/ledger/ledger_state.rs:213-350`), and the
 * OUTCOME of that pipeline decides row-versus-refusal, which is part of what byte-parity means:
 *
 *   - deserialize failure          → the reference block ABORTS (no row, no write);
 *   - `well_formed` rejection      → the reference block ABORTS;
 *   - apply returns `Failure`      → the transaction IS archived (result Failure, cost not counted);
 *   - apply Success/PartialSuccess → archived, cost counted toward block fullness.
 *
 * The third line is the one worth double-taking on: a transaction that FAILS ledger application is
 * a row, not a refusal. Only inputs the reference could not even validate abort its block. This
 * classification was read from the reference source, not assumed (§7's two refusal-parity rows).
 *
 * FAITHFUL WHERE IT MATTERS, EXPLICIT WHERE IT CANNOT BE. Everything above runs through the same
 * ledger the reference uses, compiled to WASM: `blank(networkId)` state, `wellFormed` with the
 * reference's exact strictness (defaults + `enforceBalancing=false`, `STRICTNESS_V8`), `apply`
 * with the reference's exact `BlockContext` (camelCase serde shape, `secondsSinceEpochErr: 30`),
 * `applySystemTx`, `postBlockUpdate`. One deviation is unavoidable today: the reference normalizes
 * accumulated block fullness against `parameters.limits.block_limits`, and the WASM exposes no
 * accessor for block limits (the same class of gap as the missing `SystemTransaction.
 * transactionHash` export -- a candidate second upstream fix). Until it exists, `postBlockUpdate`
 * receives ZERO fullness. On near-empty blocks (every reachable devnet) the difference is nil; on
 * blocks approaching capacity the fee-market parameter updates would diverge from the reference.
 * Stated here and in the plan rather than discovered later.
 */

/** Why a block cannot be archived: replay could not validate one of its transactions. Mirrors the
 *  reference's abort exactly -- carries which transaction and which stage said no. */
export class ReplayRefusalError extends Error {
  constructor(
    readonly position: number,
    readonly stage: "deserialize" | "well_formed" | "system_apply",
    cause: unknown,
  ) {
    super(
      `ledger replay refuses this block: transaction at position ${position} failed at the ` +
        `${stage} stage: ${(cause as Error)?.message ?? String(cause)}. The reference indexer ` +
        "aborts a block whose transaction it cannot validate, so archiving it would diverge from " +
        "the source this archive is defined against.",
      { cause },
    );
    this.name = "ReplayRefusalError";
  }
}

/** Outcome for one archived transaction, as the reference records it. `failure` is an archived
 *  row whose application failed -- NOT a refusal. */
export type ReplayOutcome = "success" | "partial_success" | "failure" | "system_applied";

export interface ReplayBlockInput {
  /** In archive position order -- event-borne system transactions first, then extrinsic order. */
  transactions: readonly { kind: "regular" | "system"; rawBytes: Uint8Array }[];
  /** Block timestamp in ms (from `Timestamp::set`); 0 for genesis, which has no timestamp. */
  blockTimestampMs: number;
  parentBlockHashHex: string;
  parentBlockTimestampMs: number;
}

export class LedgerReplay {
  private state: any;
  private readonly strictness: any;

  private constructor(private readonly ledger: any, networkId: string) {
    this.state = ledger.LedgerState.blank(networkId);
    // The reference's STRICTNESS_V8: defaults with balancing enforcement off.
    this.strictness = new ledger.WellFormedStrictness();
    this.strictness.enforceBalancing = false;
  }

  /** A replay starting from a blank genesis state -- the only valid starting point when no
   *  checkpoint exists, which is why the archive's genesis-start-only policy is a prerequisite of
   *  replay rather than a coincidence. */
  static fromGenesis(ledger: any, networkId: string): LedgerReplay {
    return new LedgerReplay(ledger, networkId);
  }

  /**
   * A replay resuming from checkpointed state, so restart cost is proportional to the checkpoint
   * interval rather than to the whole chain.
   *
   * The caller must have verified the checkpoint's ledger build matches this one: serialized state
   * is a ledger-internal encoding, and this constructor cannot tell a foreign encoding from a
   * corrupt one.
   */
  static fromSerialized(ledger: any, stateBytes: Uint8Array): LedgerReplay {
    const replay = new LedgerReplay(ledger, "unused");
    replay.state = ledger.LedgerState.deserialize(stateBytes);
    return replay;
  }

  /**
   * Apply one block's transactions in archive order and finalize, mutating the replay state.
   *
   * Throws `ReplayRefusalError` where the reference would abort the block; the caller must write
   * nothing durable in that case. Returns each transaction's outcome otherwise -- including
   * `failure`, which the reference archives rather than refusing.
   */
  applyBlock(input: ReplayBlockInput): ReplayOutcome[] {
    // The reference converts ms to whole seconds (`Timestamp::from_secs(ms / 1000)`); flooring
    // before building the Date keeps sub-second parts from leaking into the WASM conversion.
    const tblock = new Date(Math.floor(input.blockTimestampMs / 1000) * 1000);
    const outcomes: ReplayOutcome[] = [];

    for (const [position, tx] of input.transactions.entries()) {
      if (tx.kind === "system") {
        let sysTx: any;
        try {
          sysTx = this.ledger.SystemTransaction.deserialize(tx.rawBytes);
        } catch (cause) {
          throw new ReplayRefusalError(position, "deserialize", cause);
        }
        try {
          const [newState] = this.state.applySystemTx(sysTx, tblock);
          this.state = newState;
        } catch (cause) {
          // The reference treats a system-transaction apply error as fatal to the block
          // (`Error::SystemTransaction` propagates), unlike a regular transaction's Failure.
          throw new ReplayRefusalError(position, "system_apply", cause);
        }
        outcomes.push("system_applied");
        continue;
      }

      let parsed: any;
      try {
        parsed = this.ledger.Transaction.deserialize("signature", "proof", "binding", tx.rawBytes);
      } catch (cause) {
        throw new ReplayRefusalError(position, "deserialize", cause);
      }
      let verified: any;
      try {
        verified = parsed.wellFormed(this.state, this.strictness, tblock);
      } catch (cause) {
        throw new ReplayRefusalError(position, "well_formed", cause);
      }
      const cx = new this.ledger.TransactionContext(this.state, {
        secondsSinceEpoch: Math.floor(input.blockTimestampMs / 1000),
        secondsSinceEpochErr: 30,
        parentBlockHash: input.parentBlockHashHex.replace(/^0x/, ""),
        lastBlockTime: Math.floor(input.parentBlockTimestampMs / 1000),
      }, undefined);
      const [newState, result] = this.state.apply(verified, cx);
      this.state = newState;
      const kind = String(result?.type ?? result);
      outcomes.push(
        /partial/i.test(kind) ? "partial_success" : /fail/i.test(kind) ? "failure" : "success",
      );
    }

    // Zero fullness -- the documented deviation (module doc). The reference normalizes real
    // accumulated cost against block limits the WASM does not expose.
    const zero = { readTime: 0, computeTime: 0, blockUsage: 0, bytesWritten: 0, bytesChurned: 0 };
    this.state = this.state.postBlockUpdate(tblock, zero, 0);
    return outcomes;
  }

  /** Serialized state, so a caller can checkpoint replay progress. */
  serialize(): Uint8Array {
    return new Uint8Array(this.state.serialize());
  }
}
