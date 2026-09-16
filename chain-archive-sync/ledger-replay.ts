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

/**
 * One ledger event this block produced, kept rather than dropped (`spec/00016-dust-wallet-sync.md`
 * §5.1, FR-001).
 *
 * The events are already computed while a block is applied -- `TransactionResult.events` for a
 * regular transaction, the second element of `applySystemTx`'s tuple for a system one -- and were
 * being discarded. Keeping the three DUST tags is the "replay once" half of 00016: the node folds
 * them into its own trees once, instead of every wallet folding the chain's whole DUST history for
 * itself.
 *
 * `raw` is `Event.serialize()`, which is `tagged_serialize` in the ledger WASM
 * (`ledger-wasm/src/events.rs`), so a plain CONCATENATION of these byte strings is exactly what
 * `DustLocalState.replayRawEvents` consumes (FR-002 / A-3). Verified over the 78 DUST events of
 * the committed genesis vectors: raw-concatenated replay, object replay, and batched replay all
 * produce the same two tree roots.
 */
export interface LedgerEventRef {
  /** Index into {@link ReplayBlockInput.transactions} -- the LEDGER's execution order, which is
   *  deliberately not the archive's row order for system transactions. */
  readonly txPosition: number;
  /** Index within that transaction's own event list. */
  readonly eventIndex: number;
  readonly txKind: "regular" | "system";
  /**
   * `Event.source.transactionHash`: the transaction the ledger itself attributes the event to,
   * lowercase hex without `0x`.
   *
   * Read from the event rather than recomputed from the transaction. The ledger builds it from
   * the very same `TransactionHash` a caller gets out of `Transaction.transactionHash()` /
   * `SystemTransaction.transactionHash()` (both go through `to_hex_ser`), which is the value
   * `chain_archive.transactions.tx_hash` is keyed by -- so the two join, and a test asserts the
   * equality rather than this code assuming it.
   */
  readonly txHash: string;
  /** `Event.content.tag`, e.g. `dustInitialUtxo`. */
  readonly tag: string;
  /** `Event.serialize()` -- see the interface doc. */
  readonly raw: Uint8Array;
  /** `Event.content`, the WASM's JS projection of the event details. Read once, here, because
   *  the getter re-converts on every access. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly content: any;
}

/** How {@link LedgerReplay} is configured to keep events. */
export interface LedgerReplayOptions {
  /**
   * Tags of the events to keep in {@link LedgerReplay.lastBlockEvents}. Absent or empty means
   * KEEP NOTHING, which is what every caller that does not want DUST capture gets -- and the
   * reason plain replay validation pays nothing for this feature.
   *
   * The filter lives here, not in the caller, deliberately: `Event.serialize()` copies the whole
   * event out of WASM (a zswap output is ~750 B against a dust spend's ~140 B), so filtering
   * afterwards would pay that cost for every event on the chain to keep the ~0.3 % that are DUST.
   * SC-007 bounds the capture overhead at 2 % of block apply time, and this is what buys it.
   */
  readonly captureEventTags?: readonly string[];
}

export interface ReplayBlockInput {
  /** In ledger execution order. This may differ from archive position order, which follows the
   * reference indexer's event-first row contract. */
  transactions: readonly {
    kind: "regular" | "system";
    rawBytes: Uint8Array;
    /** Timestamp visible in pallet storage when THIS transaction executed. Usually the block's
     * own time; transactions before `Timestamp::set` (notably genesis) see the parent time. */
    executionTimestampMs?: number;
  }[];
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

/**
 * The three DUST parameters this replay's ledger state currently holds
 * (`LedgerState.parameters.dust`, i.e. `DustParameters`'s own three constructor arguments).
 *
 * DECIMAL STRINGS, not `bigint`: they are `u128` in the ledger, they are stored as `numeric(39)`,
 * and they are served verbatim on `GET /v1/dust/tip`. Carrying them as strings the whole way means
 * the value the chain set is the value a wallet reads, with no intermediate representation that
 * could round it. `timeToCapSeconds` is deliberately absent — it is derived from the other three,
 * so recording it would create a second place for one fact to be wrong.
 */
export interface DustParameterValues {
  readonly nightDustRatio: string;
  readonly generationDecayRate: string;
  readonly dustGracePeriodSeconds: string;
}

/** True when two parameter readings are the same chain configuration. */
export function dustParametersEqual(
  a: DustParameterValues | undefined, b: DustParameterValues | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.nightDustRatio === b.nightDustRatio &&
    a.generationDecayRate === b.generationDecayRate &&
    a.dustGracePeriodSeconds === b.dustGracePeriodSeconds;
}

export class LedgerReplay {
  private state: any;
  private readonly strictness: any;
  private lastFullness: BlockFullness | undefined;
  /** See {@link LedgerReplayOptions.captureEventTags}. Empty = capture disabled. */
  private readonly captureEventTags: ReadonlySet<string>;
  /** See {@link lastBlockEvents}. */
  private lastEvents: LedgerEventRef[] | undefined;

  private constructor(
    private readonly ledger: any, networkId: string | undefined, options?: LedgerReplayOptions,
  ) {
    // `undefined` only from `fromSerialized`, which replaces `state` immediately.
    this.state = networkId === undefined ? undefined : ledger.LedgerState.blank(networkId);
    // The reference's STRICTNESS_V8: defaults with balancing enforcement off.
    this.strictness = new ledger.WellFormedStrictness();
    this.strictness.enforceBalancing = false;
    this.captureEventTags = new Set(options?.captureEventTags ?? []);
  }

  /** Construct a blank state for isolated vectors and synthetic chain generation. Production
   * replay does not reconstruct block 0 this way: Midnight's genesis builder installs the
   * serialized `system_properties.genesis_state` snapshot without executing block-0 extrinsics. */
  static fromGenesis(ledger: any, networkId: string, options?: LedgerReplayOptions): LedgerReplay {
    return new LedgerReplay(ledger, networkId, options);
  }

  /**
   * A replay resuming from checkpointed state, so restart cost is proportional to the checkpoint
   * interval rather than to the whole chain.
   *
   * The caller must have verified the checkpoint's ledger build matches this one: serialized state
   * is a ledger-internal encoding, and this constructor cannot tell a foreign encoding from a
   * corrupt one.
   */
  static fromSerialized(
    ledger: any, stateBytes: Uint8Array, options?: LedgerReplayOptions,
  ): LedgerReplay {
    // The deserialized state carries its own network id, so the constructor's `blank()` call is
    // pure waste here -- and passing a placeholder through it (this previously passed the literal
    // "unused") builds a throwaway state against a network that does not exist. Construct with the
    // deserialized state directly.
    const replay = new LedgerReplay(ledger, undefined, options);
    replay.state = ledger.LedgerState.deserialize(stateBytes);
    return replay;
  }

  /**
   * Apply one block's transactions in ledger execution order and finalize, mutating replay state.
   *
   * Throws `ReplayRefusalError` where the reference would abort the block; the caller must write
   * nothing durable in that case. Returns each transaction's outcome otherwise -- including
   * `failure`, which the reference archives rather than refusing.
   */
  applyBlock(input: ReplayBlockInput): ReplayOutcome[] {
    // The reference converts ms to whole seconds (`Timestamp::from_secs(ms / 1000)`); flooring
    // before building the Date keeps sub-second parts from leaking into the WASM conversion.
    const closeTime = new Date(Math.floor(input.blockTimestampMs / 1000) * 1000);
    const outcomes: ReplayOutcome[] = [];
    // Cleared on ENTRY, not only on success: a refusal must not leave the previous block's events
    // attached to this height, the way an uncleared outcome list would attach the wrong results.
    // Re-published at the commit point below, next to `lastFullness`.
    this.lastEvents = undefined;
    const captured: LedgerEventRef[] = [];
    const capture = (
      events: unknown, txPosition: number, txKind: "regular" | "system",
    ): void => {
      if (this.captureEventTags.size === 0 || !Array.isArray(events)) return;
      for (const [eventIndex, event] of (events as any[]).entries()) {
        // `content` is a getter that re-converts the event on every access, so read it once.
        const content = event?.content;
        const tag = typeof content?.tag === "string" ? content.tag : "";
        if (!this.captureEventTags.has(tag)) continue;
        captured.push({
          txPosition,
          eventIndex,
          txKind,
          txHash: String(event.source?.transactionHash ?? "").replace(/^0x/, "").toLowerCase(),
          tag,
          // Serialized HERE, while the event is still owned by this code. Handing an `Event` to
          // anything that takes it by value (`DustLocalState.replayEvents`, for one) frees the
          // wasm-bindgen wrapper, and a later `serialize()` then throws "null pointer passed to
          // rust" -- measured, not theorised.
          raw: new Uint8Array(event.serialize()),
          content,
        });
      }
    };

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
      const executionTimestampMs = tx.executionTimestampMs ?? input.blockTimestampMs;
      const tblock = new Date(Math.floor(executionTimestampMs / 1000) * 1000);
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
          const [newState, events] = state.applySystemTx(sysTx, tblock);
          state = newState;
          capture(events, position, "system");
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
        secondsSinceEpoch: Math.floor(executionTimestampMs / 1000),
        secondsSinceEpochErr: 30,
        parentBlockHash: input.parentBlockHashHex.replace(/^0x/, ""),
        lastBlockTime: Math.floor(input.parentBlockTimestampMs / 1000),
      }, undefined);
      const [newState, result] = state.apply(verified, cx);
      state = newState;
      // A Failure carries no events at all (`TransactionResult::events` returns an empty slice
      // for it in the ledger), so this is naturally consistent with the fullness rule below.
      capture(result?.events, position, "regular");
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
    state = state.closeBlock(closeTime, blockFullness);
    // Commit point: everything above either completed or threw, leaving `this.state` untouched.
    this.state = state;
    this.lastFullness = {
      accumulated: { ...blockFullness },
    };
    // Same commit point as the fullness: a block that threw above published nothing, so a caller
    // can never persist events for a block the archive refused.
    this.lastEvents = this.captureEventTags.size === 0 ? undefined : captured;
    return outcomes;
  }

  /**
   * The captured ledger events of the last successfully applied block, in ledger execution order
   * (`spec/00016-dust-wallet-sync.md` FR-001).
   *
   * `undefined` means "this replay is not capturing events" (no
   * {@link LedgerReplayOptions.captureEventTags}) or "the last `applyBlock` refused" -- never
   * "the block had none", which is the empty array. The distinction is load-bearing: the ingest's
   * contiguity guard treats a block with no DUST events as covered, and a block whose events were
   * never captured as a hole.
   */
  get lastBlockEvents(): readonly LedgerEventRef[] | undefined {
    return this.lastEvents;
  }

  /** The raw accumulated cost the last successfully applied block was closed from, or `undefined`
   *  before any. Normalized/overall Q64 values are intentionally not exposed: observing them in
   *  JavaScript would recreate the precision boundary the atomic export exists to remove. */
  get lastBlockFullness(): BlockFullness | undefined {
    return this.lastFullness;
  }

  /**
   * The DUST parameters this replay's state holds RIGHT NOW
   * (`spec/00016-dust-wallet-sync.md` §4 `params`; question Q-22 option C).
   *
   * Valid at every point of the fold, not only after an `applyBlock`, and that is what the ingest
   * needs: on Midnight the genesis state is a snapshot installed by `fromSerialized`, never a
   * block that was applied, so the `genesis` parameters row can only be read straight off the
   * state the fold starts from.
   *
   * A parameter change arrives as an `OverwriteParameters` SYSTEM transaction, which `applyBlock`
   * applies like any other, so reading this after a block is what detects one. Nothing is cached:
   * `state.parameters` is a live view of the current state, and a stale copy would report the old
   * values for the block that changed them.
   *
   * The wasm-bindgen handles the two getters mint are freed here rather than left to a garbage
   * collection this process cannot schedule — this runs once per block on the ingest's hot path.
   * Both getters CLONE out of the state (verified: freeing them leaves `this.state` usable and its
   * next reading identical), so the free is a release of a copy, not of the state's own field.
   * A `free()` that throws is swallowed: a handle this method could not release is a leak, and a
   * leak must not refuse a block.
   */
  dustParameters(): DustParameterValues {
    const parameters = this.state.parameters;
    const dust = parameters.dust;
    try {
      return {
        nightDustRatio: String(dust.nightDustRatio),
        generationDecayRate: String(dust.generationDecayRate),
        dustGracePeriodSeconds: String(dust.dustGracePeriodSeconds),
      };
    } finally {
      for (const handle of [dust, parameters]) {
        try {
          handle?.free?.();
        } catch {
          // Already freed, or a build whose getters do not hand back owned handles.
        }
      }
    }
  }

  /** The node-comparable post-block ledger root: the untagged serialized typed arena key exposed
   * by `midnight_ledgerStateRoot`, deliberately distinct from the Substrate header state root. */
  ledgerStateRoot(): Uint8Array {
    if (typeof this.state?.ledgerStateRoot !== "function") {
      throw new Error(
        "the configured ledger build does not expose LedgerState.ledgerStateRoot(); replay can " +
          "apply transactions but cannot verify the resulting state against the chain commitment",
      );
    }
    return new Uint8Array(this.state.ledgerStateRoot());
  }

  /** Serialized state, so a caller can checkpoint replay progress. */
  serialize(): Uint8Array {
    return new Uint8Array(this.state.serialize());
  }
}
