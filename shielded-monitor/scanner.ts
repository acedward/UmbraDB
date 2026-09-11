import type {
  ArchiveReadContract,
  ArchivedBlock,
  ArchivedTransaction,
} from "../src/interfaces/archive-read-contract.js";
import { MonitorFencedError, MonitorNotFoundError, MonitorRevokedError } from "./errors.js";
import {
  deserializeEncryptionSecretKey,
  isArchiveTransactionIdentityError,
  LEDGER_BUILD_ID,
  MATCHING_RULE_VERSION,
  type EncryptionSecretKeyHandle,
} from "./offers.js";
import type { MatchDetails } from "./match-details.js";
import { evaluateRelevance, isUnsupportedProtocolVersion } from "./relevance.js";
import {
  NOOP_SCANNER_METRICS,
  type ScanBatchOutcomeLabel,
  type ScannerMetrics,
} from "./scanner-metrics.js";
import type {
  AdvanceResult,
  AssociationInput,
  LeaseRenewal,
  MonitorLastError,
  MonitorRecord,
} from "./store.js";

/**
 * The relevance scanner: one batch of whole blocks, for one monitor, at a time
 * (organizer spec FR-006..FR-014, owner Rule B).
 *
 * **The whole point of this file is the shape of one batch**, so it is worth stating before the
 * code:
 *
 * ```text
 *   read the archive identity ──► compare with the monitor's binding ──► stale? stop.
 *   read ONE PAGE of WHOLE BLOCKS through the ArchiveReadContract (never SQL)
 *   deserialize the viewing key                       ┐
 *     for every regular transaction of every block:   │ key lives exactly this long
 *       guaranteed offer, then every fallible segment │
 *   clear() the key                                   ┘
 *   ONE store.advance(...) ──► this batch's associations AND the coverage advance,
 *                              one BEGIN…COMMIT, in shielded_monitor.* only, epoch-fenced
 * ```
 *
 * Four properties are load-bearing and each is enforced structurally rather than by convention:
 *
 * 1. **No SQL against the archive (Rule B, FR-025).** This module's only archive-shaped
 *    dependency is the {@link ArchiveReadContract} interface; it holds no archive schema name,
 *    no `postgres` handle for the archive, and could be handed an RPC implementation without a
 *    line changing. The import list is the proof.
 * 2. **Whole blocks, one commit (Rule B, FR-010).** A batch is `SCAN_BATCH_BLOCKS` WHOLE blocks
 *    (`readBlocksSince` never splits one), and everything it produces goes into a single
 *    {@link PgShieldedMonitorStore.advance} call, which is one transaction. A block with no
 *    matches still advances coverage — an empty association list is the normal shape, not a
 *    reason to skip the commit, because "scanned and empty" must be distinguishable from "not
 *    scanned" (FR-011).
 * 3. **Fail closed (FR-007).** An unsupported protocol version or an undecodable transaction
 *    stops the monitor at that position with a typed failure. It never advances coverage past a
 *    transaction it could not read: the difference between "no match" and "could not look" is
 *    invisible afterwards, and a monitor that recorded the range as scanned would never revisit
 *    it.
 * 4. **Key lifetime is one batch (FR-002's alpha posture, and plain hygiene).** The key is
 *    deserialized inside {@link ShieldedMonitorScanner.scanBatch} and `clear()`ed in a `finally`
 *    before the function returns. No handle is stored on the instance, so no handle can be
 *    shared between monitors — including by a future refactor that adds caching without
 *    thinking about it.
 */

/** How a batch ended. Every field a caller might act on is on the variant, so no caller has to
 *  re-read the monitor to find out what happened. */
export type ScanBatchResult =
  | {
      readonly kind: "advanced";
      /** Coverage now stands here. */
      readonly throughHeight: bigint;
      readonly blocks: number;
      /** Transactions handed to the predicate (system transactions are not). */
      readonly transactionsScanned: number;
      readonly matches: number;
      /** Coverage reached the tip in this batch and the monitor was promoted to `live`. */
      readonly wentLive: boolean;
      readonly sourceTip?: bigint;
      /** 00009-08: `false` when another instance had taken this monitor's lease before the
       *  commit. The commit still happened and is still correct — the epoch fence, never the
       *  lease, is what admits it — but this instance should stop working on this monitor. */
      readonly leaseHeld?: boolean;
    }
  /** The batch had already been committed (crash-retry path, US5 scenario 2). */
  | { readonly kind: "already-advanced"; readonly throughHeight: bigint }
  /** Nothing to do: the monitor's coverage is at the archive tip (or the archive is empty, or
   *  the requested start is above the tip). */
  | { readonly kind: "at-tip"; readonly sourceTip?: bigint; readonly wentLive: boolean }
  /** A lifecycle transition landed under the worker; the commit was refused (FR-012). */
  | { readonly kind: "fenced"; readonly rejection: "epoch" | "state" }
  /** The monitor was stopped fail-closed at a named position (FR-007). */
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly atHeight?: bigint;
      readonly atPosition?: number;
    }
  /** The archive is not the one this monitor was bound to (FR-013). */
  | { readonly kind: "stale-source" };

/**
 * Exactly the store operations a scanner may perform — and therefore, by construction, exactly
 * the writes it can make.
 *
 * `PgShieldedMonitorStore` satisfies this structurally; nothing needs to declare that it does.
 * Writing the dependency as a NARROW interface rather than the concrete class is part of the
 * Rule B argument: a reader checking "what can the scanner write" reads seven method names, not
 * a 1000-line class, and a new write path added to the store does not silently become available
 * to the scanner. It also lets the unit suite drive the scanner with an in-memory double and
 * assert the call sequence (one `advance` per batch, one key deserialization per batch) without
 * a database.
 */
export interface ScannerStore {
  get(id: string): Promise<MonitorRecord>;
  getKeyMaterial(id: string): Promise<Uint8Array>;
  advance(
    monitorId: string,
    epoch: bigint,
    throughHeight: bigint,
    associations: readonly AssociationInput[],
    opts?: { readonly fromHeight?: bigint; readonly lease?: LeaseRenewal },
  ): Promise<AdvanceResult>;
  goLive(id: string, expectedEpoch: bigint, actor: string): Promise<MonitorRecord>;
  markFailed(
    id: string, actor: string, error: MonitorLastError, expectedEpoch?: bigint,
  ): Promise<MonitorRecord>;
  markStaleSource(
    id: string, actor: string, error?: MonitorLastError, expectedEpoch?: bigint,
  ): Promise<MonitorRecord>;
  bindArchiveSource(
    id: string,
    expectedEpoch: bigint,
    source: { readonly genesisHash: string; readonly instanceId: string },
  ): Promise<{ readonly applied: boolean; readonly monitor: MonitorRecord }>;
}

export interface ShieldedMonitorScannerOptions {
  /** The one network this scanner serves (Q7: one network per deployment). */
  readonly net: string;
  /** Whole blocks per batch, and therefore per commit. Default 1 — the smallest unit Rule B
   *  admits, and the one that makes a crash lose the least work. */
  readonly batchBlocks?: number;
  /** Recorded in lifecycle events and audit rows. Never a key, never a monitor id. */
  readonly actor?: string;
  readonly metrics?: ScannerMetrics;
  /** Optional per-monitor throughput ceiling. After a batch that scanned N transactions the
   *  worker sleeps long enough that its average stays at or below this rate. Off by default. */
  readonly budgetTxPerSecond?: number;
  /** Injectable for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * How a serialized viewing key becomes a testable handle. Defaults to the vendored ledger's
   * `deserializeEncryptionSecretKey`.
   *
   * A seam rather than a hard call for two reasons that are not "so a test can mock it": a TEE
   * deployment would supply a handle backed by key material the process never sees in the clear,
   * and the unit suite uses it to ASSERT the key lifetime (exactly one deserialization per
   * batch, `clear()` exactly once, even when the predicate throws) — which is otherwise a
   * property no test can observe.
   */
  readonly deserializeKey?: (bytes: Uint8Array) => Promise<EncryptionSecretKeyHandle>;
  /**
   * Check every regular transaction's claimed `txHash` against the hash its bytes actually have
   * (organizer sub-plan 00009-08). Default OFF, and the composition root turns it ON whenever the
   * archive is reached over the network (`ARCHIVE_URL`).
   *
   * Why not always on: for the in-process implementation the claim and the bytes come out of the
   * same row, written by an ingest that had already recomputed the hash FROM those bytes and
   * refused the block if the two disagreed (`chain-archive-sync/sync-service.ts`, audit A1). The
   * check would re-do work already done, on every transaction of every scan. Over HTTP that
   * guarantee does not travel with the page, and there the check is the only thing binding a
   * transaction's identity to its content — so it is on.
   *
   * Why not free either way: it costs nothing at all. `extractOffers` already deserialized the
   * transaction and the ledger hands the hash back alongside the offers.
   */
  readonly verifyTxIdentity?: boolean;
  /**
   * Renew this instance's monitor lease inside every batch's own commit (00009-08).
   *
   * Set by the scheduler for the duration of one monitor's turn. The renewal travels in the SAME
   * transaction as the associations and the coverage advance, so there is no window in which a
   * height is durable under a lapsed claim.
   */
  readonly lease?: LeaseRenewal;
}

const DEFAULT_BATCH_BLOCKS = 1;

/**
 * A transaction could not be evaluated, with the position it sat at.
 *
 * Exists so the fail-closed stop (FR-007) can record `atHeight`/`atPosition` in the monitor's
 * `last_error`. The underlying ledger error is kept as `cause` and its message is what an
 * operator reads; nothing here is derived from a viewing key.
 */
export class TransactionScanError extends Error {
  readonly code = "TRANSACTION_SCAN_FAILED" as const;
  constructor(
    readonly atHeight: bigint,
    readonly atPosition: number,
    override readonly cause: unknown,
  ) {
    super(
      `failed to evaluate the transaction at height ${atHeight}, position ${atPosition}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/** Maps a result variant onto its metric label. Exhaustive by construction. */
function outcomeLabel(result: ScanBatchResult): ScanBatchOutcomeLabel {
  switch (result.kind) {
    case "advanced": return "advanced";
    case "already-advanced": return "already-advanced";
    case "at-tip": return "at-tip";
    case "fenced": return "fenced";
    case "failed": return "failed";
    case "stale-source": return "stale-source";
  }
}

/** 32 lowercase hex characters → bytes. The archive speaks hex at the contract boundary; the
 *  store speaks bytes. One conversion, in one place, so a caller cannot store a hex STRING into
 *  a `bytea` column and have it silently work with the wrong length. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error(`expected an even-length lowercase hex string, got ${JSON.stringify(hex)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class ShieldedMonitorScanner {
  private readonly net: string;
  private readonly batchBlocks: number;
  private readonly actor: string;
  private readonly metrics: ScannerMetrics;
  private readonly budgetTxPerSecond?: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly deserializeKey: (bytes: Uint8Array) => Promise<EncryptionSecretKeyHandle>;
  private readonly verifyTxIdentity: boolean;
  private readonly lease?: LeaseRenewal;

  constructor(
    private readonly archive: ArchiveReadContract,
    private readonly store: ScannerStore,
    options: ShieldedMonitorScannerOptions,
  ) {
    this.net = options.net;
    this.batchBlocks = options.batchBlocks ?? DEFAULT_BATCH_BLOCKS;
    if (!Number.isSafeInteger(this.batchBlocks) || this.batchBlocks < 1) {
      throw new Error(`batchBlocks must be a positive integer; got ${String(options.batchBlocks)}`);
    }
    this.actor = options.actor ?? "shielded-monitor-scanner";
    this.metrics = options.metrics ?? NOOP_SCANNER_METRICS;
    if (options.budgetTxPerSecond !== undefined) this.budgetTxPerSecond = options.budgetTxPerSecond;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.deserializeKey = options.deserializeKey ?? deserializeEncryptionSecretKey;
    this.verifyTxIdentity = options.verifyTxIdentity ?? false;
    if (options.lease !== undefined) this.lease = options.lease;
  }

  /**
   * Scan and commit ONE batch for ONE monitor.
   *
   * `monitor` is the worker's loaded view. Its `epoch` is the fence: every write this method
   * makes carries it, so a pause, revoke or delete that lands after the load and before the
   * commit refuses the commit rather than partially applying it (FR-012, US3 scenario 1).
   */
  async scanBatch(monitor: MonitorRecord): Promise<ScanBatchResult> {
    const started = this.now();
    const result = await this.scanBatchInner(monitor);
    this.metrics.observeBatchDuration({ net: this.net }, outcomeLabel(result), this.now() - started);
    if (result.kind === "advanced" && this.budgetTxPerSecond !== undefined && result.transactionsScanned > 0) {
      const elapsedMs = this.now() - started;
      const requiredMs = (result.transactionsScanned * 1000) / this.budgetTxPerSecond;
      if (requiredMs > elapsedMs) await this.sleep(requiredMs - elapsedMs);
    }
    return result;
  }

  private async scanBatchInner(monitor: MonitorRecord): Promise<ScanBatchResult> {
    if (monitor.net !== this.net) {
      throw new Error(
        `this scanner serves net ${JSON.stringify(this.net)} but was handed a monitor for ` +
          `${JSON.stringify(monitor.net)}. One network per deployment (organizer spec Q7); ` +
          "scanning a monitor against the wrong chain's archive would produce provenance that lies.",
      );
    }

    // ── 1. Archive identity (FR-013) ────────────────────────────────────────────────────────
    const binding = await this.checkArchiveIdentity(monitor);
    if (binding === "stale") return { kind: "stale-source" };
    if (binding === "fenced-epoch") return { kind: "fenced", rejection: "epoch" };
    if (binding === "fenced-state") return { kind: "fenced", rejection: "state" };
    if (binding === "archive-silent") return { kind: "at-tip", wentLive: false };

    // ── 2. One page of WHOLE blocks, through the contract only ──────────────────────────────
    const afterHeight = this.afterHeightFor(monitor);
    const page = await this.archive.readBlocksSince(this.net, afterHeight, this.batchBlocks);
    const sourceTip = page.sourceTip === undefined ? undefined : BigInt(page.sourceTip.height);
    if (sourceTip !== undefined) {
      // A monitor that has scanned nothing yet is not "zero behind": it has the whole range from
      // its requested start to the tip still to do, and that is the number an operator watching
      // a backfill needs. Measured from `requestedStart - 1` so the first block counts.
      const from = monitor.coverage.scannedThrough ?? (monitor.coverage.requestedStart - 1n);
      const lag = sourceTip - from;
      this.metrics.observeLag({ net: this.net }, lag > 0n ? Number(lag) : 0);
    }
    if (page.blocks.length === 0) {
      const wentLive = await this.promoteIfCaughtUp(monitor, sourceTip);
      return sourceTip === undefined ? { kind: "at-tip", wentLive } : { kind: "at-tip", sourceTip, wentLive };
    }

    // ── 3. The predicate, with the key alive for exactly this long ──────────────────────────
    let associations: AssociationInput[];
    try {
      associations = await this.matchPage(monitor, page.blocks);
    } catch (err) {
      // A page whose claimed identity contradicts its own bytes is a TRANSPORT fault, not a
      // property of this monitor or of the chain: it would refuse every monitor's page equally.
      // Re-thrown rather than turned into a fail-closed monitor stop, so the batch simply does
      // not advance and the scheduler reports it — `failMonitor` would mark ONE wallet terminally
      // failed for a fault none of the others had yet noticed. See
      // `ArchiveTransactionIdentityError`'s own doc.
      if (isArchiveTransactionIdentityError(err) ||
          isArchiveTransactionIdentityError((err as { cause?: unknown }).cause)) {
        throw isArchiveTransactionIdentityError(err) ? err : (err as { cause: unknown }).cause;
      }
      return await this.failMonitor(monitor, err);
    }

    // ── 4. ONE commit: this batch's associations AND the coverage advance (Rule B) ──────────
    const lastBlock = page.blocks[page.blocks.length - 1]!;
    const throughHeight = BigInt(lastBlock.height);
    const firstHeight = BigInt(page.blocks[0]!.height);
    const transactionsScanned = page.blocks.reduce(
      (n, block) => n + block.transactions.filter((tx) => tx.kind !== "system").length,
      0,
    );

    let advanced;
    try {
      advanced = await this.store.advance(monitor.id, monitor.epoch, throughHeight, associations, {
        // 00009-08. Absent in a single-instance deployment, and then `advance` behaves exactly as
        // it did before leases existed.
        ...(this.lease === undefined ? {} : { lease: this.lease }),
        // Only consulted on the very first advance (the store COALESCEs it away afterwards).
        //
        // It is the FIRST HEIGHT THIS BATCH ACTUALLY READ, never the requested start. The
        // archive's earliest retained height can legitimately be above the requested start, and
        // recording the requested start as `scannedFrom` in that case would claim coverage over
        // a range nothing ever read — exactly the gap FR-011 requires to stay visible. Where
        // there is no gap the two are equal, so this is only ever more honest, never different.
        fromHeight: firstHeight,
      });
    } catch (err) {
      if (err instanceof MonitorFencedError) return { kind: "fenced", rejection: err.rejection };
      throw err;
    }

    if (!advanced.applied) return { kind: "already-advanced", throughHeight };

    this.metrics.observeTransactionsScanned({ net: this.net }, transactionsScanned);
    this.metrics.observeMatches({ net: this.net }, associations.length);
    this.metrics.observeBlocksScanned({ net: this.net }, page.blocks.length);

    const wentLive = await this.promoteIfCaughtUp(
      { ...monitor, coverage: advanced.coverage }, sourceTip,
    );
    return {
      kind: "advanced",
      throughHeight,
      blocks: page.blocks.length,
      transactionsScanned,
      matches: associations.length,
      wentLive,
      ...(sourceTip === undefined ? {} : { sourceTip }),
      ...(advanced.leaseHeld === undefined ? {} : { leaseHeld: advanced.leaseHeld }),
    };
  }

  /**
   * Run batches for one monitor until it reaches the tip, fails, is fenced, or `maxBatches` is
   * exhausted. Re-reads the monitor between batches, so a lifecycle change is noticed at a batch
   * boundary rather than only at the fence.
   *
   * This is the ONE ordered worker per monitor: it is sequential by construction, and the
   * scheduler (`scanner-service.ts`) guarantees at most one of these runs per monitor at a time.
   */
  async scanToTip(
    monitorId: string,
    opts: { readonly maxBatches?: number } = {},
  ): Promise<{ readonly batches: number; readonly last: ScanBatchResult }> {
    const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
    let batches = 0;
    let last: ScanBatchResult = { kind: "at-tip", wentLive: false };
    while (batches < maxBatches) {
      let monitor: MonitorRecord | undefined;
      try {
        monitor = await this.store.get(monitorId);
      } catch (err) {
        if (err instanceof MonitorNotFoundError || err instanceof MonitorRevokedError) {
          return { batches, last: { kind: "fenced", rejection: "state" } };
        }
        throw err;
      }
      if (monitor.state !== "backfilling" && monitor.state !== "live") {
        return { batches, last: { kind: "fenced", rejection: "state" } };
      }
      last = await this.scanBatch(monitor);
      batches += 1;
      if (last.kind !== "advanced" && last.kind !== "already-advanced") break;
      // 00009-08: the lease was taken over mid-turn (this instance stalled long enough for its
      // TTL to lapse). Stop here and let the new holder continue rather than racing it for every
      // subsequent batch — nothing is at risk either way, it is simply wasted ledger work.
      if (last.kind === "advanced" && last.leaseHeld === false) break;
      if (last.kind === "advanced" && last.sourceTip !== undefined && last.throughHeight >= last.sourceTip) break;
    }
    return { batches, last };
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────

  /** `readBlocksSince` takes an EXCLUSIVE lower bound. A monitor that has scanned nothing yet
   *  starts one below its requested start; `-1` means "from genesis". */
  private afterHeightFor(monitor: MonitorRecord): number {
    const from = monitor.coverage.scannedThrough ?? (monitor.coverage.requestedStart - 1n);
    return from < -1n ? -1 : Number(from);
  }

  /**
   * Compare the archive's identity with the monitor's binding; bind it on first use.
   *
   * Read afresh every batch rather than memoized: a memo would let the scanner commit a batch
   * read from a REBUILT archive against the old binding for as long as the memo lived, which is
   * exactly the history-mixing FR-013 exists to prevent. The cost is one small read-only
   * transaction per batch, and `SCAN_BATCH_BLOCKS` amortizes it.
   */
  private async checkArchiveIdentity(
    monitor: MonitorRecord,
  ): Promise<"ok" | "stale" | "archive-silent" | "fenced-epoch" | "fenced-state"> {
    const identity = await this.archive.getArchiveIdentity(this.net);
    if (identity === undefined) {
      // The archive cannot answer yet (schema bootstrapped but no genesis block, or not
      // bootstrapped at all). Not a mismatch and not an error: there is simply nothing to scan.
      return "archive-silent";
    }
    const boundInstance = monitor.sourceInstanceId;
    const boundGenesis = monitor.sourceGenesisHash;
    if (boundInstance === undefined || boundGenesis === undefined) {
      try {
        const bound = await this.store.bindArchiveSource(monitor.id, monitor.epoch, {
          genesisHash: identity.genesisHash,
          instanceId: identity.archiveInstanceId,
        });
        if (bound.applied) return "ok";
        // Someone bound it first (or it was half-bound at registration). Fall through to the
        // comparison below against what is actually stored.
        return bound.monitor.sourceInstanceId === identity.archiveInstanceId &&
          bound.monitor.sourceGenesisHash === identity.genesisHash
          ? "ok"
          : await this.markStale(monitor, identity.archiveInstanceId);
      } catch (err) {
        if (err instanceof MonitorFencedError) {
          return err.rejection === "epoch" ? "fenced-epoch" : "fenced-state";
        }
        throw err;
      }
    }
    if (boundInstance === identity.archiveInstanceId && boundGenesis === identity.genesisHash) return "ok";
    return await this.markStale(monitor, identity.archiveInstanceId);
  }

  private async markStale(monitor: MonitorRecord, observedInstanceId: string): Promise<"stale" | "fenced-epoch" | "fenced-state"> {
    try {
      await this.store.markStaleSource(
        monitor.id,
        this.actor,
        {
          code: "ARCHIVE_IDENTITY_CHANGED",
          // Carries the two instance ids and nothing derived from the key. An instance id is a
          // random 128-bit label for a DATABASE, not for a wallet.
          message:
            `the archive serving net ${this.net} reports instance ${observedInstanceId}, but this ` +
            `monitor's coverage was accumulated against instance ${monitor.sourceInstanceId ?? "(unbound)"}. ` +
            "Stopping rather than mixing two histories.",
        },
        monitor.epoch,
      );
      return "stale";
    } catch (err) {
      if (err instanceof MonitorFencedError) return err.rejection === "epoch" ? "fenced-epoch" : "fenced-state";
      throw err;
    }
  }

  /**
   * The predicate over one page, with the key deserialized here and `clear()`ed here.
   *
   * The handle is a local, never an instance field: two monitors scanned concurrently by the
   * scheduler each get their own, and neither can observe the other's.
   */
  private async matchPage(
    monitor: MonitorRecord, blocks: readonly ArchivedBlock[],
  ): Promise<AssociationInput[]> {
    // No regular transaction in the whole page — a run of empty blocks, which is the NORMAL
    // shape of a quiet live tail. Loading and deserializing the key to test nothing would put
    // key material in the WASM heap once per block for no reason. The batch still commits its
    // coverage advance: the caller does that, not this method.
    if (!blocks.some((block) => block.transactions.some((tx) => tx.kind !== "system"))) return [];

    const keyBytes = await this.store.getKeyMaterial(monitor.id);
    const key = await this.deserializeKey(keyBytes);
    const associations: AssociationInput[] = [];
    try {
      for (const block of blocks) {
        for (const tx of block.transactions) {
          let outcome;
          try {
            // `details: true` costs nothing for a transaction that does not match, and for one
            // that does it reads the offers ALREADY extracted for the predicate — so a match's
            // public zswap data is produced by the same pass, from the same bytes, as the
            // decision to record it (00009-07).
            outcome = await evaluateRelevance(tx, key, {
              details: true,
              // 00009-08: only when the archive is remote. See `verifyTxIdentity`.
              ...(this.verifyTxIdentity ? { expectTxHash: tx.txHash } : {}),
            });
          } catch (err) {
            // Re-thrown with the POSITION attached, because "this monitor failed" is useless to
            // an operator without "at which transaction" — and because FR-007's typed failure is
            // required to name the position the monitor stopped at.
            throw new TransactionScanError(BigInt(block.height), tx.position, err);
          }
          if (outcome.kind !== "match") continue;
          associations.push(this.associationFor(block, tx, outcome.segments, outcome.details));
        }
      }
    } finally {
      // In a `finally`, so a throw partway through a page does not leave key material in the
      // WASM heap until the process exits.
      key.clear();
      keyBytes.fill(0);
    }
    return associations;
  }

  /** One association per (monitor, transaction observation), naming every matched segment
   *  (FR-008) and carrying FR-009 provenance. */
  private associationFor(
    block: ArchivedBlock,
    tx: ArchivedTransaction,
    segments: readonly number[],
    details?: MatchDetails,
  ): AssociationInput {
    return {
      net: this.net,
      blockHeight: BigInt(block.height),
      blockHash: hexToBytes(block.hash),
      position: tx.position,
      txHash: hexToBytes(tx.txHash),
      protocolVersion: BigInt(tx.protocolVersion),
      matchedSegments: segments,
      // 00009-07. Both optional and both travel in the SAME `store.advance` call as the coverage
      // advance, so Rule B's commit unit is unchanged: a height's associations, its details and
      // its coverage are one `BEGIN…COMMIT`. `timestampMs` is absent for a block the archive has
      // no time for (migration 008's unbackfilled rows) and is then recorded as absent, never as
      // a zero.
      ...(details === undefined ? {} : { details }),
      ...(block.timestampMs === undefined ? {} : { blockTimestampMs: BigInt(block.timestampMs) }),
      // `appliedOutcome` is fixed at "unknown" by the store; the archive's replay outcome is
      // surfaced only as `sourceOutcome`, and only when the archive actually recorded one
      // (FR-009). `undefined` here means "this archive recorded no outcome", NEVER "it failed".
      ...(tx.result === undefined ? {} : { sourceOutcome: tx.result }),
      matchingRuleVersion: MATCHING_RULE_VERSION,
      ledgerBuild: LEDGER_BUILD_ID,
    };
  }

  /** Turns a decode failure into the fail-closed stop FR-007 requires, keeping the position. */
  private async failMonitor(monitor: MonitorRecord, err: unknown): Promise<ScanBatchResult> {
    const located = err as { atHeight?: bigint; atPosition?: number; cause?: unknown };
    const cause = located.cause ?? err;
    const code = isUnsupportedProtocolVersion(cause)
      ? "UNSUPPORTED_PROTOCOL_VERSION"
      : "UNDECODABLE_TRANSACTION";
    const detail: {
      code: string; message: string; atHeight?: string; atPosition?: number;
    } = {
      code,
      // The ledger's own message, which describes BYTES, never a key. Truncated because a WASM
      // error can be long and `last_error` is read by an operator, not parsed.
      message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 500),
    };
    if (located.atHeight !== undefined) detail.atHeight = located.atHeight.toString();
    if (located.atPosition !== undefined) detail.atPosition = located.atPosition;
    try {
      await this.store.markFailed(monitor.id, this.actor, detail, monitor.epoch);
    } catch (markErr) {
      if (markErr instanceof MonitorFencedError) {
        return { kind: "fenced", rejection: markErr.rejection };
      }
      throw markErr;
    }
    return {
      kind: "failed",
      code,
      ...(located.atHeight === undefined ? {} : { atHeight: located.atHeight }),
      ...(located.atPosition === undefined ? {} : { atPosition: located.atPosition }),
    };
  }

  /** `backfilling → live` once coverage has reached the tip the archive reported in the SAME
   *  read as the page (FR-011: the two are one observation, so the promotion can never claim a
   *  tip the scanner did not actually reach). */
  private async promoteIfCaughtUp(monitor: MonitorRecord, sourceTip: bigint | undefined): Promise<boolean> {
    if (monitor.state !== "backfilling") return false;
    if (sourceTip === undefined) return false;
    const through = monitor.coverage.scannedThrough;
    if (through === undefined || through < sourceTip) return false;
    try {
      await this.store.goLive(monitor.id, monitor.epoch, this.actor);
      return true;
    } catch (err) {
      // A pause or revoke landing here is not an error for the batch that already committed.
      if (err instanceof MonitorFencedError) return false;
      throw err;
    }
  }
}
