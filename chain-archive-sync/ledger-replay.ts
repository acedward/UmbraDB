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
 * FAITHFUL WHERE IT MATTERS. Everything above runs through the same ledger the reference uses,
 * compiled to WASM: `blank(networkId)` state, `wellFormed` with the reference's exact strictness
 * (defaults + `enforceBalancing=false`, `STRICTNESS_V8`), `apply` with the reference's exact
 * `BlockContext` (camelCase serde shape, `secondsSinceEpochErr: 30`), `applySystemTx`,
 * the ledger's atomic `closeBlock` export.
 *
 * BLOCK FULLNESS. This used to post ZERO fullness, because the vendored WASM could not cost a
 * system transaction and `normalizeFullness` throws where the reference clamps. Both gaps are
 * closed as of `ledger-v8@8.1.0-syshash.3`, and the fold now mirrors
 * `indexer-common/src/domain/ledger/ledger_state.rs` exactly:
 *
 *   - regular transactions: cost counted on Success and PartialSuccess, NOT on Failure
 *     (`should_count_cost` at :252-273, commented there as matching node behaviour);
 *   - system transactions: cost always counted (:316), computed against the parameters as they
 *     stand BEFORE the transaction is applied -- which matters, because `OverwriteParameters` is
 *     itself a system transaction and would otherwise be costed against the parameters it installs;
 *   - at block close (:493-513): pass the accumulated raw `SyntheticCost` to `closeBlock`, whose
 *     Rust implementation reads the limits from the state AFTER all transactions, clamps,
 *     normalizes, takes the max across all five Q64 dimensions, and calls `post_block_update`.
 *
 * The atomic close is load-bearing: `NormalizedCost` contains Q64 `FixedPoint` values whose serde
 * binding is an `f64`. Returning them to JavaScript and passing them back changes raw Q64 units and
 * therefore serialized ledger state. No normalized fullness value crosses JavaScript in this fold.
 */

/** Why a block cannot be archived: replay could not validate one of its transactions. Mirrors the
 *  reference's abort exactly -- carries which transaction and which stage said no. */
export class ReplayRefusalError extends Error {
  constructor(
    readonly position: number,
    readonly stage: "deserialize" | "well_formed" | "system_apply" | "cost",
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

/** The five dimensions of `SyntheticCost`/`NormalizedCost`, in the ledger's own field order. */
const COST_DIMENSIONS = [
  "readTime",
  "computeTime",
  "blockUsage",
  "bytesWritten",
  "bytesChurned",
] as const;

type CostDimension = (typeof COST_DIMENSIONS)[number];
type AccumulatedCost = Record<CostDimension, bigint>;

function zeroCost(): AccumulatedCost {
  return { readTime: 0n, computeTime: 0n, blockUsage: 0n, bytesWritten: 0n, bytesChurned: 0n };
}

/** Add one transaction's cost into the running block fullness, as the reference's
 *  `block_fullness + cost` does. The WASM returns each dimension as a BigInt (they are `u64` and
 *  `CostDuration(u64)` in Rust), so this accumulates in BigInt -- `Number` would start losing
 *  integer precision above 2^53, and picoseconds of compute time reach that range. */
function addCost(into: AccumulatedCost, cost: Record<string, unknown>): void {
  for (const d of COST_DIMENSIONS) into[d] += BigInt(cost[d] as bigint | number | string);
}

export interface ReplayBlockInput {
  /** In archive position order -- event-borne system transactions first, then extrinsic order. */
  transactions: readonly { kind: "regular" | "system"; rawBytes: Uint8Array }[];
  /** Block timestamp in ms (from `Timestamp::set`), including genesis on the target 1.0 node. */
  blockTimestampMs: number;
  parentBlockHashHex: string;
  parentBlockTimestampMs: number;
}

/** The raw fullness a block was closed from. Exact normalized Q64 values deliberately stay in Rust. */
export interface BlockFullness {
  /** Accumulated cost per dimension, before normalization. BigInt: these are `u64` in Rust. */
  readonly accumulated: Readonly<AccumulatedCost>;
}

export class LedgerReplay {
  private state: any;
  private readonly strictness: any;
  private lastFullness: BlockFullness | undefined;

  private constructor(private readonly ledger: any, networkId: string | undefined) {
    // `undefined` only from `fromSerialized`, which replaces `state` immediately.
    this.state = networkId === undefined ? undefined : ledger.LedgerState.blank(networkId);
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
    // The deserialized state carries its own network id, so the constructor's `blank()` call is
    // pure waste here -- and passing a placeholder through it (this previously passed the literal
    // "unused") builds a throwaway state against a network that does not exist. Construct with the
    // deserialized state directly.
    const replay = new LedgerReplay(ledger, undefined);
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

    // ATOMIC (audit round 3). This used to assign `this.state` after every transaction, so a block
    // that refused at transaction 3 left the first two already applied -- and since a refusal is
    // retried, the next attempt folded those two on TOP of themselves. Ledger state is a fold, so
    // that is silent divergence, not a visible error. All work happens on a local, and `this.state`
    // is replaced only once the whole block has succeeded; a throw leaves the engine exactly as the
    // block found it.
    let state = this.state;
    // The running block fullness, reset per block exactly as the reference resets it to
    // `Default::default()` after each `post_block_update`.
    const blockFullness = zeroCost();

    for (const [position, tx] of input.transactions.entries()) {
      if (tx.kind === "system") {
        let sysTx: any;
        try {
          sysTx = this.ledger.SystemTransaction.deserialize(tx.rawBytes);
        } catch (cause) {
          throw new ReplayRefusalError(position, "deserialize", cause);
        }
        // Costed against the parameters BEFORE this transaction is applied, as the reference does.
        // `OverwriteParameters` is a system transaction, so costing after would charge it at the
        // rates it installs rather than the ones in force when it ran.
        const sysCost = sysTx.cost(state.parameters);
        try {
          const [newState] = state.applySystemTx(sysTx, tblock);
          state = newState;
        } catch (cause) {
          // The reference treats a system-transaction apply error as fatal to the block
          // (`Error::SystemTransaction` propagates), unlike a regular transaction's Failure.
          throw new ReplayRefusalError(position, "system_apply", cause);
        }
        // Always counted -- a system transaction has no Failure outcome to withhold it for.
        addCost(blockFullness, sysCost);
        outcomes.push("system_applied");
        continue;
      }

      let parsed: any;
      try {
        parsed = this.ledger.Transaction.deserialize("signature", "proof", "binding", tx.rawBytes);
      } catch (cause) {
        throw new ReplayRefusalError(position, "deserialize", cause);
      }
      // Cost and fees come BEFORE `wellFormed`, matching the reference's order
      // (`ledger_state.rs:240-247`: cost, fees, then `well_formed`). They are not merely
      // informational: `cost` throwing is how the reference rejects a transaction whose cost cannot
      // be modelled. The order is observable -- a transaction that would fail both checks is
      // refused at the `cost` stage there, so refusing it at `well_formed` here would misreport
      // which rule rejected the block.
      let cost: any;
      try {
        cost = parsed.cost(state.parameters, true);
        parsed.fees(state.parameters, true);
      } catch (cause) {
        throw new ReplayRefusalError(position, "cost", cause);
      }
      let verified: any;
      try {
        verified = parsed.wellFormed(state, this.strictness, tblock);
      } catch (cause) {
        throw new ReplayRefusalError(position, "well_formed", cause);
      }
      const cx = new this.ledger.TransactionContext(state, {
        secondsSinceEpoch: Math.floor(input.blockTimestampMs / 1000),
        secondsSinceEpochErr: 30,
        parentBlockHash: input.parentBlockHashHex.replace(/^0x/, ""),
        lastBlockTime: Math.floor(input.parentBlockTimestampMs / 1000),
      }, undefined);
      const [newState, result] = state.apply(verified, cx);
      state = newState;
      const kind = String(result?.type ?? result);
      const outcome: ReplayOutcome = /partial/i.test(kind)
        ? "partial_success"
        : /fail/i.test(kind)
          ? "failure"
          : "success";
      // Success and PartialSuccess count toward fullness; Failure does not. The reference's
      // `should_count_cost` flag, whose own comment says this matches node behaviour. A Failure is
      // still an archived row -- withholding its cost is not the same as refusing it.
      if (outcome !== "failure") addCost(blockFullness, cost);
      outcomes.push(outcome);
    }

    // Atomic Rust close, mirroring the reference's `post_block_update` (`ledger_state.rs:493-513`).
    // Passing only raw integer cost is intentional: clamp -> normalize -> max-of-five ->
    // post_block_update stays inside Rust, so exact Q64 FixedPoint values never become JS numbers.
    // The export reads limits from `state`, which is the state AFTER all transactions.
    state = state.closeBlock(tblock, blockFullness);
    // Commit point: everything above either completed or threw, leaving `this.state` untouched.
    this.state = state;
    this.lastFullness = {
      accumulated: { ...blockFullness },
    };
    return outcomes;
  }

  /** The raw accumulated cost the last successfully applied block was closed from, or `undefined`
   *  before any. Normalized/overall Q64 values are intentionally not exposed: observing them in
   *  JavaScript would recreate the precision boundary the atomic export exists to remove. */
  get lastBlockFullness(): BlockFullness | undefined {
    return this.lastFullness;
  }

  /** Serialized state, so a caller can checkpoint replay progress. */
  serialize(): Uint8Array {
    return new Uint8Array(this.state.serialize());
  }
}
