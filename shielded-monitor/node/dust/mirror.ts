import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LEDGER_BUILD_ID, loadLedger } from "../../offers.js";
import type { DustConfig } from "./config.js";
import type { DustDb, DustParametersRow } from "./db.js";

/**
 * `DustStateMirror` — one key-less `DustLocalState` holding the chain's two DUST trees, folded
 * once from `dust_events` so that no wallet has to fold them again
 * (`spec/00016-dust-wallet-sync.md` Story 2, FR-011, FR-012, FR-013, FR-014; plan 00016 D2.2,
 * D2.5b).
 *
 * ── THE ONE RULE THIS FILE MUST NOT GET WRONG ───────────────────────────────────────────────
 * The replay is `replayRawEventsRetainingAll`, **never** `replayRawEvents`.
 *
 * The stock replay collapses every leaf the secret key does not own, and `MerkleTreeNode::collapse`
 * merges collapsed siblings upward, so a key-less mirror ends up holding a handful of large
 * aligned collapsed subtrees and none of the interior nodes a cut needs. Measured on the first
 * 5 000 preprod events (question Q-12): a stock mirror can serve the two segments around a
 * uniformly random wallet leaf in **0 of 200** draws; a retained mirror in **200 of 200**.
 *
 * And the two replays reach **identical roots**. So this mistake is invisible to every root
 * comparison — to the fixture's recorded roots, to a golden run against the SDK, to
 * `GET /v1/dust/tip` — and surfaces only the first time a real wallet asks for a segment. That is
 * why `dust-mirror.test.ts` cuts a random single-leaf range instead of comparing roots.
 *
 * ── Why the state is leased rather than simply swapped ──────────────────────────────────────
 * FR-014 requires one request to read one immutable state reference: a `DustLocalState` value
 * never changes, and the mirror publishes a new reference after each batch. But the retained
 * trees cost ≈ 2 KB of WebAssembly heap per leaf (question Q-14), and wasm-bindgen handles are
 * not collected promptly by V8 — so a mirror that merely dropped the old reference would hold
 * several copies of a multi-gigabyte tree until a GC it cannot schedule.
 *
 * Freeing the old handle eagerly is therefore mandatory, and freeing it while a segments request
 * is still cutting from it is a use-after-free that surfaces as `null pointer passed to rust`.
 * The two requirements meet at a lease count: a reader takes a lease, the mirror retires the old
 * state when it swaps, and whoever drops the last lease frees it. No request ever sees a tree
 * change under it, and no superseded tree outlives its last reader.
 *
 * ── What "ready" and "producer" mean ────────────────────────────────────────────────────────
 * `producer: "none"` means the table holds no DUST events for this net at all — an archive whose
 * ingest ran with `REPLAY_VALIDATION=0`. That is a deployment mistake, not a transient state, and
 * the routes say so with `503 DUST_NO_PRODUCER` (Story 2 scenario 4) rather than pretending to be
 * an empty chain.
 *
 * `ready` means the mirror has caught up with the table at least once. Before that the routes
 * answer `503 DUST_NOT_READY` (Story 2 scenario 3) — serving a tree that is missing the last
 * hundred thousand leaves would hand a wallet segments that cannot reproduce the chain's root,
 * which is worse than saying "not yet".
 *
 * ── Where the DUST parameters come from (question Q-22 option C) ────────────────────────────
 * From the archive's `dust_parameters` table, written by the ingest — never from a ledger state this
 * process deserializes. A `DustLocalState` takes its parameters from its constructor and ignores
 * parameter events entirely (Q-9), so the mirror has to be told, and the cheapest true source is
 * the row the ingest wrote while it already held the state.
 *
 * With no row (an archive whose ingest predates migration 010, or one that never ran replay
 * validation) the mirror falls back to `LedgerParameters.initialParameters().dust` and says so:
 * `parametersSource: "unknown"`. That fallback is right far more often than not — the values have
 * never changed on any Midnight network so far — but "probably right" and "read off the chain"
 * must not look the same on `/internal/status`.
 *
 * A row appearing ABOVE the one the state was built from is a real mid-chain parameter change, and
 * the only way to honour it is a REBUILD: `DustLocalState.params` is `readonly` in the WASM
 * bindings (verified against the vendored `.d.ts`), so there is no way to swap them in place. The
 * mirror therefore drops its trees and re-folds from zero — expensive, documented, and reserved
 * for an event that is a governance action rather than a routine one.
 *
 * ── Why a big snapshot is REFUSED rather than restored (question Q-23 option A) ──────────────
 * Measured on the real preprod archive at 146 253 retained leaves: restoring a 13 506 592 B
 * snapshot cost **639 s** of one synchronous WASM call — during which this process answered no
 * HTTP request at all — against **154 s** to fold the same state out of PostgreSQL from nothing,
 * staying responsive throughout. `DustLocalState.deserialize` of a retained state is superlinear
 * in its size, so the snapshot is a pessimisation in exactly the regime it was meant to help.
 *
 * Snapshots are still WRITTEN (≈ 0.2 s per 20 000 events, and on devnet or any small chain the
 * restore really is milliseconds). They are only RESTORED below `DUST_STATE_SNAPSHOT_MAX_BYTES`.
 */

/** How far the mirror's trees have been folded (FR-013). */
export interface DustMirrorApplied {
  readonly eventId: bigint;
  readonly height: bigint;
}

/**
 * What is written at the head of a snapshot file (FR-012).
 *
 * `parameters` (question Q-22 option C) records the DUST parameters the serialized state was
 * CONSTRUCTED with, because they are baked into it and cannot be changed afterwards. On load they
 * are compared with the archive's current row and a disagreement refuses the snapshot — the same
 * "refuse rather than migrate" discipline `net` and `ledgerVersion` already get. `null` means the
 * state was built from the ledger's initial parameters because the archive recorded none.
 *
 * A snapshot written before this field existed has it `undefined`, which is neither `null` nor a
 * match, so it is refused and replayed from zero. That is the correct, self-healing outcome.
 */
export interface DustSnapshotHeader {
  readonly net: string;
  readonly ledgerVersion: string;
  readonly eventId: string;
  readonly height: string;
  readonly parameters?: DustSnapshotParameters | null;
}

/** The identity of a `dust_parameters` row, as recorded in a snapshot header. */
export interface DustSnapshotParameters {
  readonly blockHeight: string;
  readonly nightDustRatio: string;
  readonly generationDecayRate: string;
  readonly dustGracePeriodSeconds: string;
}

/**
 * A borrowed reference to the mirror's current trees. Call {@link DustMirrorLease.release} in a
 * `finally`, exactly once: the state is unusable afterwards if this was the last lease on a
 * retired reference.
 */
export interface DustMirrorLease {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly state: any;
  readonly applied: DustMirrorApplied;
  release(): void;
}

export type DustProducer = "ingest" | "none";

export interface DustMirrorStatus {
  readonly producer: DustProducer;
  readonly ready: boolean;
  readonly applied: { readonly eventId: string; readonly height: string };
  readonly snapshotEventId: string | null;
  readonly lastError: string | null;
  /**
   * `chain` — built from a `dust_parameters` row; `unknown` — the archive records none, so the
   * ledger's initial parameters are in use; `changed-at-<height>` — a row appeared above the one
   * the state was built from and the mirror rebuilt for it (question Q-22 option C).
   */
  readonly parametersSource: string;
  /** The height of the row the state was built from, or `null` under `unknown`. */
  readonly parametersHeight: string | null;
  /** The three values the mirror was built with and `GET /v1/dust/tip` serves. */
  readonly parameters: DustServedParameters;
  /** Which path this start took (question Q-23 option A). */
  readonly startPath: "snapshot" | "replay";
  /** Milliseconds from `start()` to the first time the mirror was caught up, or `null` while it
   *  still is not. This is the number SC-003 is stated against. */
  readonly startMs: number | null;
}

/** The three DUST parameters as they go on the wire: decimal strings, spec §4 `params`. */
export interface DustServedParameters {
  readonly nightDustRatio: string;
  readonly generationDecayRate: string;
  readonly dustGracePeriodSeconds: string;
}

export interface DustStateMirrorDeps {
  readonly db: DustDb;
  readonly net: string;
  readonly config: DustConfig;
  readonly logger?: (line: string) => void;
  /** Injected in tests so a mirror can run against a loaded module without re-importing the WASM;
   *  production leaves it out and the memoized `loadLedger()` answers. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly ledger?: any;
  /** Injected so a test can drive the loop turn by turn instead of racing a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Retained so the reference cannot be freed while a request is still cutting from it. */
interface HeldState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly state: any;
  readonly applied: DustMirrorApplied;
  leases: number;
  retired: boolean;
}

const SNAPSHOT_MAGIC = Buffer.from("UMBRADUST1", "utf8");

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class DustStateMirror {
  readonly #deps: DustStateMirrorDeps;
  readonly #log: (line: string) => void;
  readonly #sleep: (ms: number) => Promise<void>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #ledger: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #key: any;
  #held: HeldState | undefined;
  #producer: DustProducer = "none";
  #ready = false;
  #lastError: string | undefined;
  #snapshotEventId: bigint | undefined;
  #eventsSinceSnapshot = 0n;
  #running = false;
  #loop: Promise<void> | undefined;
  /** The `dust_parameters` row this state was CONSTRUCTED from, or `undefined` when the archive
   *  records none and the ledger's initial parameters are in use (question Q-22 option C). */
  #parameters: DustParametersRow | undefined;
  #parametersSource = "unknown";
  /** Question Q-23 option A. */
  #startPath: "snapshot" | "replay" = "replay";
  #startedAt = 0;
  #startMs: number | undefined;

  constructor(deps: DustStateMirrorDeps) {
    this.#deps = deps;
    this.#log = deps.logger ?? (() => undefined);
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * Loads the newest usable snapshot (or starts from an empty state) and begins following the
   * table.
   *
   * `loops: false` boots the mirror WITHOUT the poll timer so a suite can call
   * {@link DustStateMirror.pumpOnce} and observe each batch, exactly as `MonitorNode.start` does
   * for its queues. It is the same mirror either way.
   */
  async start(opts: { readonly loops?: boolean } = {}): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#startedAt = Date.now();
    this.#startMs = undefined;
    this.#ledger = this.#deps.ledger ?? (await loadLedger());
    this.#key = this.#ledger.sampleDustSecretKey();
    // The parameters come FIRST: they decide what a blank state is constructed with, and what a
    // snapshot has to agree with to be usable. A read failure here is not fatal -- it leaves the
    // mirror on the ledger's initial parameters with `parametersSource: "unknown"`, which is the
    // same honest state as an archive that records none, and the routes still work.
    try {
      this.#parameters = await this.#deps.db.selectDustParametersAtOrBelow(this.#deps.net);
    } catch (err) {
      this.#parameters = undefined;
      // The SCHEMA NAME IS NOT TYPED HERE, not even in a log string. `schema-isolation`'s literal
      // scan strips comments and then fails on any occurrence of the archive schema's name in B's
      // source, and that scan is NOT part of the 00016 waiver -- `db.ts` imports the name from A's
      // `archive-conventions.ts` precisely so nobody in B asserts a convention B does not own.
      this.#log(
        `[dust] could not read the archive's DUST parameters table ` +
          `(${err instanceof Error ? err.message : String(err)}); using the ledger's initial DUST ` +
          "parameters and reporting parametersSource=unknown",
      );
    }
    this.#parametersSource = this.#parameters === undefined ? "unknown" : "chain";
    if (this.#parameters !== undefined) {
      this.#log(
        `[dust] DUST parameters from the archive at height ` +
          `${this.#parameters.blockHeight.toString(10)} (${this.#parameters.reason}): ` +
          `nightDustRatio=${this.#parameters.nightDustRatio} ` +
          `generationDecayRate=${this.#parameters.generationDecayRate} ` +
          `dustGracePeriodSeconds=${this.#parameters.dustGracePeriodSeconds}`,
      );
    }
    const restored = await this.#loadSnapshot();
    if (restored === undefined) {
      this.#startPath = "replay";
      this.#publish(this.#blankState(), { eventId: 0n, height: 0n });
    } else {
      this.#startPath = "snapshot";
      this.#publish(restored.state, restored.applied);
      this.#snapshotEventId = restored.applied.eventId;
    }
    if (opts.loops !== false) this.#loop = this.#runLoop();
  }

  /** Stops following, writes a final snapshot, and frees the trees. */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    await this.#loop?.catch(() => undefined);
    this.#loop = undefined;
    // A clean shutdown snapshots (FR-012) so a restart replays at most `DUST_STATE_SNAPSHOT_EVERY`
    // events rather than the whole chain. A failure here is logged and swallowed: refusing to shut
    // down because a disk is full would be worse than replaying on the next start.
    try {
      if (this.#held !== undefined && this.#held.applied.eventId > 0n) await this.#writeSnapshot(this.#held);
    } catch (err) {
      this.#log(`[dust] final snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const held = this.#held;
    this.#held = undefined;
    if (held !== undefined) {
      held.retired = true;
      if (held.leases === 0) held.state.free();
    }
    // The mirror's key is a random sample that matches nothing on chain, but it is still key
    // material in the WASM heap and this repository zeroes those rather than dropping them.
    try {
      this.#key?.clear?.();
    } catch {
      // `clear()` on an already-cleared handle throws; a shutdown must not fail on it.
    }
    this.#key?.free?.();
    this.#key = undefined;
  }

  /** `dust` for `/internal/status` (spec §4). Counts, heights and codes — nothing else. */
  status(): DustMirrorStatus {
    const applied = this.#held?.applied ?? { eventId: 0n, height: 0n };
    return {
      producer: this.#producer,
      ready: this.#ready,
      applied: { eventId: applied.eventId.toString(10), height: applied.height.toString(10) },
      snapshotEventId: this.#snapshotEventId === undefined ? null : this.#snapshotEventId.toString(10),
      lastError: this.#lastError ?? null,
      parametersSource: this.#parametersSource,
      parametersHeight: this.#parameters === undefined
        ? null
        : this.#parameters.blockHeight.toString(10),
      parameters: this.parameters,
      startPath: this.#startPath,
      startMs: this.#startMs ?? null,
    };
  }

  /**
   * The three DUST parameters this mirror was built with — what `GET /v1/dust/tip` serves
   * (question Q-22 option C).
   *
   * Read from the ROW, never from `state.params`. Two reasons: the row is the chain's own record,
   * and `state.params` is a wasm-bindgen getter that mints a handle on every access (the previous
   * implementation leaked one per `/v1/dust/tip` request). Under `parametersSource: "unknown"`
   * these are the ledger's initial parameters, which the status block says plainly.
   */
  get parameters(): DustServedParameters {
    if (this.#parameters !== undefined) {
      return {
        nightDustRatio: this.#parameters.nightDustRatio,
        generationDecayRate: this.#parameters.generationDecayRate,
        dustGracePeriodSeconds: this.#parameters.dustGracePeriodSeconds,
      };
    }
    return this.#initialParameters();
  }

  get producer(): DustProducer {
    return this.#producer;
  }

  get ready(): boolean {
    return this.#ready;
  }

  /**
   * Borrows the current trees for the duration of one request (FR-014).
   *
   * `undefined` before {@link DustStateMirror.start} has published anything. The caller MUST
   * release, in a `finally`.
   */
  acquire(): DustMirrorLease | undefined {
    const held = this.#held;
    if (held === undefined) return undefined;
    held.leases += 1;
    let released = false;
    return {
      state: held.state,
      applied: held.applied,
      release: () => {
        // Idempotent: a double release would drop another reader's claim and free a tree in use.
        if (released) return;
        released = true;
        held.leases -= 1;
        if (held.retired && held.leases === 0) held.state.free();
      },
    };
  }

  /**
   * One turn: read the next batch and fold it. Returns how many events were applied.
   *
   * Public so tests can drive it; the loop below is nothing but this plus a sleep.
   */
  async pumpOnce(): Promise<number> {
    const { db, net, config } = this.#deps;
    const held = this.#held;
    if (held === undefined) return 0;
    let events;
    try {
      events = await db.selectEventsAfter(net, held.applied.eventId, config.replayBatch);
      if (events.length === 0) {
        // Nothing new. Distinguish "the table is empty for this net" (a deployment whose ingest
        // never captured anything) from "we are at the tip", because the two answer differently.
        const tip = await db.selectTableTip(net);
        this.#producer = tip === undefined ? "none" : "ingest";
        if (tip !== undefined) this.#markReady();
        this.#lastError = undefined;
        // Caught up is exactly when a parameter change is worth looking for: the applied height is
        // the chain's, so a row above the one this state was built from is a real change rather
        // than the fold walking through history it has not reached yet.
        if (tip !== undefined) await this.#checkParametersChanged(held.applied.height);
        return 0;
      }
      this.#producer = "ingest";
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      return 0;
    }

    const bytes = Buffer.concat(events.map((event) => Buffer.from(event.raw)));
    const last = events[events.length - 1]!;
    let withChanges;
    try {
      // THE retain-all call. See the class note: `replayRawEvents` would reach the same roots and
      // leave the trees uncuttable.
      withChanges = held.state.replayRawEventsRetainingAll(this.#key, new Uint8Array(bytes));
    } catch (err) {
      // A refusal here is not transient — the same bytes will be read again next turn and fail
      // the same way — so it is recorded and the mirror stops advancing rather than spinning
      // silently. `NonLinearInsertion` is the expected shape when a table has a gap.
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#log(`[dust] replay refused at event ${held.applied.eventId.toString(10)}: ${this.#lastError}`);
      return 0;
    }
    // `.state` mints a NEW handle on every access, so it is read exactly once.
    const next = withChanges.state;
    withChanges.free();
    this.#publish(next, { eventId: last.id, height: last.blockHeight });
    this.#lastError = undefined;
    this.#eventsSinceSnapshot += BigInt(events.length);
    // A parameter change the fold just walked past (question Q-22 option C). Checked per BATCH,
    // not per event: it is one single-row index scan next to a thousand-event replay, so it is
    // noise against the ≈ 1 s the batch itself costs.
    if (await this.#checkParametersChanged(last.blockHeight)) return events.length;

    if (this.#eventsSinceSnapshot >= BigInt(config.snapshotEvery)) {
      this.#eventsSinceSnapshot = 0n;
      try {
        await this.#writeSnapshot(this.#held!);
      } catch (err) {
        // A snapshot is an optimisation: losing one costs replay time on the next start, never
        // correctness, so it must not stop the fold.
        this.#log(`[dust] snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return events.length;
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  /** First time the mirror is caught up, record how long getting there took (question Q-23). */
  #markReady(): void {
    if (this.#ready) return;
    this.#ready = true;
    this.#startMs = Date.now() - this.#startedAt;
    this.#log(
      `[dust] ready after ${this.#startMs} ms via the ${this.#startPath} path ` +
        `(${this.#held?.applied.eventId.toString(10) ?? "0"} events, height ` +
        `${this.#held?.applied.height.toString(10) ?? "0"})`,
    );
  }

  /**
   * Look for a `dust_parameters` row above the one this state was built from, and rebuild if there
   * is one (question Q-22 option C). Returns whether a rebuild happened.
   *
   * "At or below the applied height" is what makes this safe during a cold fold: while the mirror
   * is folding old history its applied height is low, so the newest row it can see is an OLD one,
   * which is never above the row it started from (that row is the newest in the table at start).
   * Only a row written AFTER this mirror started can trip it.
   *
   * A read failure is recorded and ignored: failing to notice a parameter change must not stop the
   * fold, and the next batch asks again.
   */
  async #checkParametersChanged(appliedHeight: bigint): Promise<boolean> {
    let row: DustParametersRow | undefined;
    try {
      row = await this.#deps.db.selectDustParametersAtOrBelow(this.#deps.net, appliedHeight);
    } catch {
      return false;
    }
    if (row === undefined) return false;
    if (this.#parameters !== undefined && row.blockHeight <= this.#parameters.blockHeight) return false;
    if (this.#parameters === undefined) {
      // The archive recorded NO parameters when this mirror started and now records some. The
      // state was built from the ledger's initial values; if the chain agrees with them, adopt the
      // row (it turns `unknown` into `chain`) without paying for a rebuild that would produce a
      // byte-identical state.
      const initial = this.#initialParameters();
      if (
        row.nightDustRatio === initial.nightDustRatio &&
        row.generationDecayRate === initial.generationDecayRate &&
        row.dustGracePeriodSeconds === initial.dustGracePeriodSeconds
      ) {
        this.#parameters = row;
        this.#parametersSource = "chain";
        this.#log(
          `[dust] DUST parameters now recorded by the archive at height ` +
            `${row.blockHeight.toString(10)} and equal to the ledger's initial values; ` +
            "parametersSource=chain, no rebuild needed",
        );
        return false;
      }
    }
    this.#rebuildForChangedParameters(row);
    return true;
  }

  /** The ledger's own initial DUST parameters, as decimal strings. The fallback when the archive
   *  records none — and the values every Midnight network has used so far. */
  #initialParameters(): DustServedParameters {
    const params = this.#ledger.LedgerParameters.initialParameters();
    const dust = params.dust;
    try {
      return {
        nightDustRatio: String(dust.nightDustRatio),
        generationDecayRate: String(dust.generationDecayRate),
        dustGracePeriodSeconds: String(dust.dustGracePeriodSeconds),
      };
    } finally {
      for (const handle of [dust, params]) {
        try {
          handle?.free?.();
        } catch {
          // Already freed; a status read must not fail on a handle it could not release.
        }
      }
    }
  }

  /**
   * A fresh, empty state carrying the parameters this mirror is configured for
   * (question Q-22 option C).
   *
   * They do not affect the TREES — a `DustLocalState` ignores parameter events entirely (Q-9) — so
   * this cannot change a root. It matters because the parameters are baked into the state at
   * construction and there is no setter, so building it with the chain's values is the only way a
   * state and the `params` this node serves can be the same configuration.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #blankState(): any {
    const wanted = this.parameters;
    const params = new this.#ledger.DustParameters(
      BigInt(wanted.nightDustRatio),
      BigInt(wanted.generationDecayRate),
      BigInt(wanted.dustGracePeriodSeconds),
    );
    try {
      return new this.#ledger.DustLocalState(params);
    } finally {
      try {
        params.free?.();
      } catch {
        // `DustLocalState`'s constructor may take the handle by value; freeing an already-consumed
        // one throws and is nothing to report.
      }
    }
  }

  /**
   * A `dust_parameters` row has appeared ABOVE the one this state was built from: the chain
   * changed its DUST parameters mid-chain (question Q-22 option C).
   *
   * The only correct response is a REBUILD FROM ZERO. `DustLocalState.params` is `readonly` in the
   * WASM bindings and the sole way parameters enter a state is its constructor, so they cannot be
   * swapped in place; and the snapshot on disk holds a state built with the OLD parameters, so
   * restoring it would reinstate exactly what is being replaced. Re-folding costs one cold start
   * (measured: 154 s at 134 667 events) and happens only when a governance action changes the
   * parameters, which has never yet happened on any Midnight network.
   *
   * The trees the re-fold produces are identical either way — parameters do not touch them — so
   * the cost buys consistency of the `params` a wallet is handed, not correctness of its segments.
   */
  #rebuildForChangedParameters(row: DustParametersRow): void {
    this.#log(
      `[dust] DUST parameters CHANGED at height ${row.blockHeight.toString(10)} ` +
        `(was height ${this.#parameters?.blockHeight.toString(10) ?? "none"}): ` +
        `nightDustRatio=${row.nightDustRatio} generationDecayRate=${row.generationDecayRate} ` +
        `dustGracePeriodSeconds=${row.dustGracePeriodSeconds}. A DustLocalState's parameters ` +
        "cannot be swapped in place, so the mirror rebuilds from zero; DUST routes answer " +
        "503 DUST_NOT_READY until it has caught up. See docs/shielded-monitor-node.md.",
    );
    this.#parameters = row;
    this.#parametersSource = `changed-at-${row.blockHeight.toString(10)}`;
    this.#ready = false;
    this.#eventsSinceSnapshot = 0n;
    this.#snapshotEventId = undefined;
    this.#startPath = "replay";
    this.#startedAt = Date.now();
    this.#startMs = undefined;
    this.#publish(this.#blankState(), { eventId: 0n, height: 0n });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #publish(state: any, applied: DustMirrorApplied): void {
    const previous = this.#held;
    this.#held = { state, applied, leases: 0, retired: false };
    if (previous === undefined) return;
    previous.retired = true;
    // Free NOW if nobody is reading it; otherwise the last reader's `release()` does it. Either
    // way the superseded trees do not wait for a garbage collection this process cannot schedule.
    if (previous.leases === 0) previous.state.free();
  }

  async #runLoop(): Promise<void> {
    while (this.#running) {
      try {
        const applied = await this.pumpOnce();
        // A full batch means there is almost certainly more: keep folding rather than sleeping a
        // poll interval per 1 000 events, which would make a cold start take days.
        if (applied >= this.#deps.config.replayBatch) {
          // ONE MACROTASK between batches, and it is not decoration (question Q-23 option A).
          // Each batch is ≈ 1 s of synchronous WASM; between them this process must actually let
          // its HTTP server answer, or a cold fold is indistinguishable from the multi-minute
          // deserialize stall Q-23 exists to remove. `await` alone does not guarantee it: against
          // a database client that resolves synchronously (a test's fake, a fully buffered pool)
          // the loop would be a chain of MICROTASKS, which starve I/O callbacks completely. A
          // zero-delay timer is a macrotask, so pending sockets are served before the next batch.
          await this.#sleep(0);
          continue;
        }
      } catch (err) {
        this.#lastError = err instanceof Error ? err.message : String(err);
      }
      await this.#sleep(this.#deps.config.pollMs);
    }
  }

  #snapshotPath(): string {
    return path.join(this.#deps.config.snapshotDir, `${this.#deps.net}.dust-state`);
  }

  /**
   * Writes `magic ‖ u32be(headerLength) ‖ header JSON ‖ DustLocalState.serialize()` to a temp
   * file in the same directory and renames it over the old one (FR-012).
   *
   * Same directory, because `rename` is only atomic within a filesystem; a temp file in `/tmp`
   * would degrade to copy-then-delete across a mount and could leave a half-written snapshot that
   * passes its own header check.
   */
  async #writeSnapshot(held: HeldState): Promise<void> {
    const dir = this.#deps.config.snapshotDir;
    await mkdir(dir, { recursive: true });
    const header: DustSnapshotHeader = {
      net: this.#deps.net,
      ledgerVersion: LEDGER_BUILD_ID,
      eventId: held.applied.eventId.toString(10),
      height: held.applied.height.toString(10),
      // The parameters are BAKED INTO the serialized state and cannot be changed on load, so the
      // header records which ones, and `#loadSnapshot` refuses a snapshot that disagrees with the
      // archive's current row (question Q-22 option C). `null` = built from the ledger's initial
      // parameters because the archive recorded none.
      parameters: this.#parameters === undefined ? null : {
        blockHeight: this.#parameters.blockHeight.toString(10),
        nightDustRatio: this.#parameters.nightDustRatio,
        generationDecayRate: this.#parameters.generationDecayRate,
        dustGracePeriodSeconds: this.#parameters.dustGracePeriodSeconds,
      },
    };
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.byteLength, 0);
    const body = Buffer.from(held.state.serialize() as Uint8Array);
    const target = this.#snapshotPath();
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, Buffer.concat([SNAPSHOT_MAGIC, length, headerBytes, body]));
    try {
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
    this.#snapshotEventId = held.applied.eventId;
    this.#log(`[dust] snapshot at event ${header.eventId} height ${header.height} (${body.byteLength} B)`);
  }

  /**
   * Reads the snapshot, or `undefined` when there is none or it cannot be trusted.
   *
   * Every refusal is the same outcome — replay from zero — and each is LOGGED with its reason,
   * because "the node took 40 minutes to start" is otherwise indistinguishable from "the node
   * silently ignored a snapshot written by a different ledger build". A snapshot from another
   * `net` or another `ledgerVersion` is refused rather than migrated: serialized ledger state is
   * a ledger-internal encoding, and a build that reads it differently produces wrong trees rather
   * than an error.
   */
  async #loadSnapshot(): Promise<{ state: unknown; applied: DustMirrorApplied } | undefined> {
    const target = this.#snapshotPath();
    const refuse = (reason: string): undefined => {
      this.#log(`[dust] ignoring ${target}: ${reason}; replaying from zero`);
      return undefined;
    };
    // ── The size gate (question Q-23 option A) ────────────────────────────────────────────────
    // Checked with `stat` BEFORE the file is read, because reading a 165 MB snapshot only to throw
    // it away would itself be the cost this avoids. Measured on preprod: restoring 13 506 592 B
    // took 639 s of one synchronous WASM call with the node answering nothing, against 154 s to
    // fold the same state out of PostgreSQL while staying responsive.
    let size: number;
    try {
      size = (await stat(target)).size;
    } catch {
      return undefined; // no snapshot yet: the ordinary first start
    }
    const max = this.#deps.config.snapshotMaxBytes;
    if (size > max) {
      this.#log(
        `[dust] snapshot skipped (${size} bytes > max ${max}): replaying from zero. ` +
          "Restoring a retained DustLocalState of this size is one multi-minute synchronous WASM " +
          "call during which this node answers nothing, and it is slower than re-folding the " +
          "events (question Q-23). Raise DUST_STATE_SNAPSHOT_MAX_BYTES only if you have measured " +
          "the restore on your own chain.",
      );
      return undefined;
    }
    let file: Buffer;
    try {
      file = await readFile(target);
    } catch {
      return undefined; // raced away between the stat and the read
    }
    if (file.byteLength < SNAPSHOT_MAGIC.byteLength + 4) return refuse("truncated");
    if (!file.subarray(0, SNAPSHOT_MAGIC.byteLength).equals(SNAPSHOT_MAGIC)) return refuse("not a DUST snapshot");
    const headerLength = file.readUInt32BE(SNAPSHOT_MAGIC.byteLength);
    const headerStart = SNAPSHOT_MAGIC.byteLength + 4;
    if (headerLength > 4096 || file.byteLength < headerStart + headerLength) return refuse("truncated header");
    let header: DustSnapshotHeader;
    try {
      header = JSON.parse(file.subarray(headerStart, headerStart + headerLength).toString("utf8")) as DustSnapshotHeader;
    } catch {
      return refuse("unreadable header");
    }
    if (header.net !== this.#deps.net) return refuse(`net ${String(header.net)} is not ${this.#deps.net}`);
    if (header.ledgerVersion !== LEDGER_BUILD_ID) {
      return refuse(`ledgerVersion ${String(header.ledgerVersion)} is not ${LEDGER_BUILD_ID}`);
    }
    // Question Q-22 option C: the serialized state carries the parameters it was BUILT with and
    // they cannot be changed on load, so a snapshot that disagrees with what this mirror is
    // configured for is refused rather than restored into a state whose `params` this node would
    // then misreport. `undefined` (a snapshot written before this field existed) is a disagreement
    // too -- self-healing, since the next write records it.
    const wanted = this.#parameters;
    const recorded = header.parameters;
    const parametersAgree = recorded === undefined
      ? false
      : recorded === null
        ? wanted === undefined
        : wanted !== undefined &&
          recorded.blockHeight === wanted.blockHeight.toString(10) &&
          recorded.nightDustRatio === wanted.nightDustRatio &&
          recorded.generationDecayRate === wanted.generationDecayRate &&
          recorded.dustGracePeriodSeconds === wanted.dustGracePeriodSeconds;
    if (!parametersAgree) {
      return refuse(
        recorded === undefined
          ? "it records no DUST parameters (written before they were tracked)"
          : `its DUST parameters are not the archive's current ones ` +
            `(snapshot ${JSON.stringify(recorded)}, archive ${
              wanted === undefined ? "none recorded" : `height ${wanted.blockHeight.toString(10)}`
            })`,
      );
    }
    try {
      const state = this.#ledger.DustLocalState.deserialize(
        new Uint8Array(file.subarray(headerStart + headerLength)),
      );
      const applied = { eventId: BigInt(header.eventId), height: BigInt(header.height) };
      this.#log(`[dust] resumed from ${target} at event ${header.eventId} height ${header.height}`);
      return { state, applied };
    } catch (err) {
      return refuse(`state did not deserialize (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
