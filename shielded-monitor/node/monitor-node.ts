import type { ArchiveReadContract } from "../../src/interfaces/archive-read-contract.js";
import { MonitorFencedError, MonitorNotFoundError } from "../errors.js";
import { isScannable } from "../lifecycle.js";
import { isArchiveTransactionIdentityError, LEDGER_BUILD_ID, MATCHING_RULE_VERSION } from "../offers.js";
import { isUnsupportedProtocolVersion } from "../relevance.js";
import { hexToBytes, ShieldedMonitorScanner } from "../scanner.js";
import type {
  AdvanceBatchItem,
  AdvanceBatchResult,
  MonitorGap,
  MonitorRecord,
  ShieldedMonitorStore,
} from "../store.js";
import type { ShieldedViewingKey } from "../viewing-key.js";
import type { ArchiveWakeSource, ArchiveWakeSubscription } from "../wake.js";
import { BlockScanError, scanBlock } from "./block-scan.js";
import { MonitorKeyStore, type DeserializeKey, type HeldKey, type KeyPhase } from "./key-store.js";

/**
 * **The monitor-node**: the private API's process, the scanner's process and the key custodian,
 * merged into one (00009-09; owner decision Q28).
 *
 * ── The two queues, and why there are exactly two ───────────────────────────────────────────
 *
 * ```text
 *  Queue A (always running)          Queue B (always running, FIFO)
 *  ─────────────────────────         ──────────────────────────────
 *  get-tip  every SCAN_POLL_MS       sync-key(fp)   catch ONE new key up to liveWatermark
 *    │      or on an SSE height        │            page by page, one `advance` per block
 *    ▼                                 ▼
 *  scan-phase: for each block H      back-sync(fp, from, to)
 *    deserialize each tx ONCE          re-read a range the key missed, one `fill-gap` per block
 *    test EVERY live key
 *    ONE advance-batch for H
 *    liveWatermark = H
 * ```
 *
 * A key cannot be in both at once, and that is what the `phase` field on a held key is for. While
 * Queue B is catching a key up (`syncing`) Queue A skips it; the moment its coverage reaches the
 * watermark it becomes `live` and Queue A takes over. Queue B re-reads the watermark after every
 * page precisely because Queue A keeps moving it: the hand-off has to converge, not chase.
 *
 * ── HAS_SCANNED_ONCE: the whole desync detector ─────────────────────────────────────────────
 * The hand-off above is not atomic, and it cannot be: Queue A commits blocks while Queue B is
 * finishing. So a key can join the live set at height H with its coverage standing at some
 * H′ < H − 1. Rather than lock the two queues against each other, the node checks: on a key's
 * FIRST Queue A pass it compares that key's stored `scannedThrough` with `H − 1`, and if it is
 * lower it records `[scannedThrough + 1, H − 1]` as a gap **in the same transaction that moves
 * coverage to H** and queues a `back-sync`. One comparison, once per key, and the window closes
 * itself.
 *
 * ── Keys ────────────────────────────────────────────────────────────────────────────────────
 * They arrive only through {@link MonitorNode.register} — there is no other way in, because there
 * is nowhere else they exist. They leave on delete, on a fenced `not-found` drop, or on shutdown,
 * always through {@link MonitorKeyStore.remove}, which clears the WASM handle. A key whose monitor
 * merely STOPPED (`failed`, `stale_source`) is kept and skipped: its matches stay readable, and
 * nothing about it is a reason to destroy a key its owner has not asked to delete.
 *
 * ── How a deleted key leaves ────────────────────────────────────────────────────────────────
 * A consumer has exactly one lifecycle operation, `DELETE` (owner decision Q33), and it must
 * destroy the key here, not merely the rows over there. Two things carry it: the balancer's
 * best-effort `POST /internal/events {stateChanged}` to the holder, which is immediate, and the
 * `not-found` fence on this node's next `advance-batch`, which cannot be lost. So a deleted key
 * is cleared at once, or by the next block at the latest.
 *
 * ── Rule B ──────────────────────────────────────────────────────────────────────────────────
 * Unchanged and, for the live path, stronger: one block is one `BEGIN … COMMIT` for the node as a
 * whole rather than one per monitor. This module reaches the archive only through
 * {@link ArchiveReadContract} and its own state only through {@link ShieldedMonitorStore}; it
 * imports no driver and knows no schema name.
 */

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_SYNC_BATCH_BLOCKS = 8;
/** How many blocks one Queue A turn commits before yielding, so a node that is far behind still
 *  answers `/internal/*` and serves the dashboard while it catches up. */
const DEFAULT_LIVE_BLOCKS_PER_TURN = 64;

export interface MonitorNodeOptions {
  /** The one network this node serves (Q7: one network per deployment). */
  readonly net: string;
  /** This node's name, as the balancer and the dashboard see it. An operator-chosen label; never
   *  a key, never a monitor id. */
  readonly nodeId: string;
  readonly pollMs?: number;
  /** Whole blocks per Queue B page. Queue A is always one block per commit. */
  readonly syncBatchBlocks?: number;
  readonly liveBlocksPerTurn?: number;
  readonly actor?: string;
  readonly logger?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly deserializeKey?: DeserializeKey;
  /** Q23: check each transaction's claimed hash against its bytes. On by default, because in this
   *  topology the archive is always remote. */
  readonly verifyTxIdentity?: boolean;
}

/** `GET /internal/status` (§5.2). Every field is a count, a height or this node's own name —
 *  nothing here is derived from a key. */
export interface MonitorNodeStatus {
  readonly nodeId: string;
  readonly net: string;
  readonly keysHeld: number;
  readonly live: number;
  readonly syncing: number;
  /** Keys whose monitor stopped (`failed`, `stale_source`): held, readable, never scanned. */
  readonly failed: number;
  /** Jobs waiting in Queue B, including the one being worked on. */
  readonly queueB: number;
  /** The last height Queue A committed, as a decimal string. `null` before boot completes. */
  readonly liveWatermark: string | null;
  /** `archiveTip − liveWatermark`, or `null` when the tip is not known. */
  readonly lagBlocks: string | null;
}

/** `GET /internal/holds` (§5.2). */
export interface HoldsAnswer {
  readonly holds: boolean;
  readonly phase?: KeyPhase;
}

/** `POST /internal/events` (§5.2). Best effort in both directions: a lost event costs at most one
 *  poll interval of staleness, because the next `advance-batch` fences anyway. */
export interface MonitorNodeEvent {
  readonly type: "found" | "stateChanged";
  readonly monitorId: string;
  readonly height?: string;
}

type QueueBJob =
  | { readonly kind: "sync-key"; readonly fingerprintHex: string }
  | { readonly kind: "back-sync"; readonly fingerprintHex: string; readonly from: bigint; readonly to: bigint };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

export class MonitorNode {
  readonly keys: MonitorKeyStore;
  readonly #archive: ArchiveReadContract;
  readonly #store: ShieldedMonitorStore;
  readonly #wake: ArchiveWakeSource;
  readonly #options: Required<Omit<MonitorNodeOptions, "logger" | "sleep" | "deserializeKey">> & {
    readonly logger: (line: string) => void;
    readonly sleep: (ms: number) => Promise<void>;
  };

  /** The last height Queue A has committed. `undefined` until {@link MonitorNode.start} has read
   *  the archive tip — a node that guessed 0 here would replay the whole chain on every restart. */
  #liveWatermark: bigint | undefined;
  #archiveTip: bigint | undefined;
  readonly #queueB: QueueBJob[] = [];
  #queueBBusy = false;
  #running = false;
  #wakeSignal = false;
  #subscription: ArchiveWakeSubscription | undefined;
  #loops: Promise<void>[] = [];

  constructor(
    archive: ArchiveReadContract,
    store: ShieldedMonitorStore,
    wake: ArchiveWakeSource,
    options: MonitorNodeOptions,
  ) {
    this.#archive = archive;
    this.#store = store;
    this.#wake = wake;
    this.#options = {
      net: options.net,
      nodeId: options.nodeId,
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      syncBatchBlocks: options.syncBatchBlocks ?? DEFAULT_SYNC_BATCH_BLOCKS,
      liveBlocksPerTurn: options.liveBlocksPerTurn ?? DEFAULT_LIVE_BLOCKS_PER_TURN,
      actor: options.actor ?? "shielded-monitor-node",
      verifyTxIdentity: options.verifyTxIdentity ?? true,
      logger: options.logger ?? (() => undefined),
      sleep: options.sleep ?? defaultSleep,
    };
    this.keys = new MonitorKeyStore(options.deserializeKey);
  }

  get nodeId(): string {
    return this.#options.nodeId;
  }

  get liveWatermark(): bigint | undefined {
    return this.#liveWatermark;
  }

  // ── Boot and shutdown ──────────────────────────────────────────────────────────────────────

  /**
   * Reads the archive tip, sets the live watermark to it, and starts both queues.
   *
   * **`liveWatermark = tip`, not 0.** A node holds no keys at boot, so there is nothing to scan
   * the history for; starting at 0 would make Queue A walk the whole chain testing an empty key
   * set, which is pure waste and would delay every subsequently registered key behind it. History
   * is Queue B's job, per key, from that key's own coverage.
   */
  async start(opts: { readonly loops?: boolean } = {}): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#liveWatermark = await this.readArchiveTip() ?? 0n;
    this.#log(
      `[monitor-node] ${this.#options.nodeId} net=${this.#options.net} ` +
        `liveWatermark=${this.#liveWatermark} pollMs=${this.#options.pollMs} database=none`,
    );
    this.#subscription = await this.#wake.subscribe(this.#options.net, () => {
      this.#wakeSignal = true;
    });
    // `loops: false` boots the node — watermark, wake subscription, key store — WITHOUT the two
    // timer-driven workers, so a suite can call `runQueueAOnce`/`runQueueBOnce` and observe each
    // turn instead of racing a poll interval. It is the same node either way; what differs is who
    // decides when a turn happens.
    if (opts.loops !== false) this.#loops = [this.#runQueueALoop(), this.#runQueueBLoop()];
  }

  /**
   * Stops both queues and **clears every key**.
   *
   * The clearing is the part that matters and is why this is not just "close the server": on
   * SIGTERM the process is about to be replaced, and the keys it holds must not survive into a
   * core dump. Everything the node persisted is already durable — coverage moves inside the same
   * transaction as the associations — so there is nothing to flush, only to destroy.
   */
  async stop(): Promise<void> {
    this.#running = false;
    await this.#subscription?.close().catch(() => undefined);
    this.#subscription = undefined;
    await Promise.all(this.#loops).catch(() => undefined);
    this.#loops = [];
    const cleared = this.keys.clearAll();
    this.#log(`[monitor-node] ${this.#options.nodeId} stopped; cleared ${cleared} key(s)`);
  }

  // ── Registration ───────────────────────────────────────────────────────────────────────────

  /**
   * Takes custody of a validated viewing key and returns the monitor it identifies (§4.1 step 3).
   *
   * The order is deliberate: the fingerprint is registered with the storage API FIRST, so that a
   * node which crashes between the two holds no key for a monitor that does not exist; then the
   * key enters this node's RAM; then `sync-key` is queued. The registration is an upsert on
   * `(net, fingerprint)`, so re-sending a key after a node died reaches the SAME monitor with its
   * coverage and gaps intact — which is what makes §4.6's recovery a re-send rather than a rescan.
   *
   * `key` is **shredded** before this returns, whatever happens: its bytes are in the ledger
   * handle now (or the registration failed and they are worth nothing).
   */
  async register(key: ShieldedViewingKey, requestedStartHeight: bigint): Promise<MonitorRecord> {
    try {
      const monitor = await this.#store.register({
        fingerprint: key.fingerprint,
        net: this.#options.net,
        requestedStartHeight,
        matchingRuleVersion: MATCHING_RULE_VERSION,
        ledgerBuild: LEDGER_BUILD_ID,
        actor: this.#options.actor,
      });
      const held = await this.keys.add(key, monitor.id);
      // A key this node already holds needs no second sync: it is either already live or already
      // queued. Re-queuing it would be harmless but would make a client's retry loop grow Queue B
      // without bound.
      if (held.phase === "syncing" && !this.#queueB.some(
        (job) => job.kind === "sync-key" && job.fingerprintHex === held.fingerprintHex,
      )) {
        this.#queueB.push({ kind: "sync-key", fingerprintHex: held.fingerprintHex });
      }
      return monitor;
    } finally {
      key.shred();
    }
  }

  // ── The balancer's view (§5.2) ─────────────────────────────────────────────────────────────

  holds(fingerprintHex: string): HoldsAnswer {
    const held = this.keys.get(fingerprintHex);
    return held === undefined ? { holds: false } : { holds: true, phase: held.phase };
  }

  holdsMonitor(monitorId: string): HoldsAnswer {
    const held = this.keys.byMonitorId(monitorId);
    return held === undefined ? { holds: false } : { holds: true, phase: held.phase };
  }

  /** Every monitor this node holds a key for, so the balancer can fill `heldBy` for a whole list
   *  in one request per node instead of one per monitor per node. */
  heldMonitors(): { readonly monitorId: string; readonly phase: KeyPhase }[] {
    return this.keys.all().map((k) => ({ monitorId: k.monitorId, phase: k.phase }));
  }

  status(): MonitorNodeStatus {
    const counts = this.keys.counts();
    const watermark = this.#liveWatermark;
    const tip = this.#archiveTip;
    return {
      nodeId: this.#options.nodeId,
      net: this.#options.net,
      keysHeld: this.keys.size,
      ...counts,
      queueB: this.#queueB.length + (this.#queueBBusy ? 1 : 0),
      liveWatermark: watermark === undefined ? null : watermark.toString(10),
      lagBlocks: tip === undefined || watermark === undefined
        ? null
        : (tip > watermark ? tip - watermark : 0n).toString(10),
    };
  }

  /**
   * A best-effort peer notification (§4.5, §5.2).
   *
   * `stateChanged` makes a holder notice a pause or revoke immediately rather than at its next
   * `advance-batch`; `found` is informational. Neither is load-bearing — the fence in
   * `advance-batch` is what actually enforces a lifecycle change — so this method never throws and
   * never blocks the caller: an event that is lost costs one poll interval of staleness.
   */
  onEvent(event: MonitorNodeEvent): void {
    if (event.type !== "stateChanged") return;
    const held = this.keys.byMonitorId(event.monitorId);
    if (held === undefined) return;
    void this.refreshHeldMonitor(held).catch(() => undefined);
  }

  /**
   * Re-reads one held monitor and applies its state to the key.
   *
   * Two outcomes, which is all the give/delete lifecycle can produce (Q33): a monitor that is
   * **gone** — deleted, or no longer in the store at all — takes its key with it, cleared here;
   * a monitor that is merely **stopped** (`failed`, `stale_source`) keeps its key and leaves the
   * live set, because nothing may advance its coverage and the operator may still want to read
   * its matches. A scannable monitor changes nothing: it is already being scanned.
   *
   * The same decision `advance-batch`'s fences make, taken early because an event said so.
   */
  async refreshHeldMonitor(held: HeldKey): Promise<void> {
    try {
      const monitor = await this.#store.getIncludingDeleted(held.monitorId);
      if (monitor === undefined || monitor.state === "deleted") {
        this.#dropKey(held, monitor === undefined ? "not-found" : "deleted");
        return;
      }
      if (!isScannable(monitor.state)) held.phase = "failed";
    } catch {
      // A storage hiccup is not a reason to drop a key. The next `advance-batch` fences anyway.
    }
  }

  // ── Queue A ────────────────────────────────────────────────────────────────────────────────

  async #runQueueALoop(): Promise<void> {
    while (this.#running) {
      try {
        await this.runQueueAOnce();
      } catch (err) {
        this.#log(`[monitor-node] queue A: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.#running) break;
      // An SSE height that arrived while the turn was running short-circuits the wait, so a block
      // is never sat on for a whole poll interval just because it landed at the wrong moment.
      if (this.#wakeSignal) this.#wakeSignal = false;
      else await this.#options.sleep(this.#options.pollMs);
    }
  }

  /**
   * One Queue A turn: `get-tip`, then `scan-phase` for every block up to the tip.
   *
   * Exposed rather than private so a test can drive the node deterministically — the loop above is
   * a timer around this, and a suite that had to race a timer to observe a block would be a flaky
   * suite.
   */
  async runQueueAOnce(): Promise<{ readonly blocks: number; readonly matches: number }> {
    const tip = await this.readArchiveTip();
    if (tip === undefined || this.#liveWatermark === undefined) return { blocks: 0, matches: 0 };

    let blocks = 0;
    let matches = 0;
    while (this.#running || blocks === 0) {
      if (this.#liveWatermark >= tip) break;
      if (blocks >= this.#options.liveBlocksPerTurn) break;
      const next = this.#liveWatermark + 1n;
      const outcome = await this.#scanPhase(next);
      if (outcome === undefined) break;
      blocks += 1;
      matches += outcome.matches;
    }
    return { blocks, matches };
  }

  /**
   * One block: read it, test every live key against it, commit it for all of them.
   *
   * Returns `undefined` when the block could not be committed at all, which stops the turn rather
   * than skipping a height — a watermark that stepped over a block nobody read would claim
   * coverage no one has.
   */
  async #scanPhase(height: bigint): Promise<{ readonly matches: number } | undefined> {
    const page = await this.#archive.readBlocksSince(this.#options.net, Number(height) - 1, 1);
    const block = page.blocks[0];
    if (block === undefined || BigInt(block.height) !== height) return undefined;

    const live = this.keys.live();
    let matchesFound = 0;
    let byKey;
    try {
      byKey = await scanBlock(block, live, {
        net: this.#options.net,
        verifyTxIdentity: this.#options.verifyTxIdentity,
      });
    } catch (err) {
      if (isArchiveTransactionIdentityError(err)) {
        // A transport fault: the page's claimed identity contradicts its own bytes. Do not
        // advance, do not fail a monitor — it would hit every key equally. The turn stops and the
        // next poll tries again.
        this.#log(`[monitor-node] block ${height}: ${err.message}`);
        return undefined;
      }
      await this.#failAllForBlock(height, err, live);
      return undefined;
    }

    const items: AdvanceBatchItem[] = [];
    for (const held of live) {
      const associations = byKey.get(held.fingerprintHex) ?? [];
      matchesFound += associations.length;
      const monitor = await this.#loadForBatch(held);
      if (monitor === undefined) continue;
      const newGaps = this.#gapsOnFirstPass(held, monitor, height);
      items.push({
        monitorId: held.monitorId,
        expectedEpoch: monitor.epoch,
        associations,
        ...(newGaps === undefined ? {} : { newGaps: [newGaps] }),
      });
    }

    // ONE transaction for the whole block, even when it is empty: the watermark must only move
    // over a height the storage API has actually recorded for every monitor this node holds.
    const result: AdvanceBatchResult = items.length === 0
      ? { advanced: [], fenced: [] }
      : await this.#store.advanceBatch(this.#options.net, height, hexToBytes(block.hash), items);

    for (const held of live) {
      if (items.some((item) => item.monitorId === held.monitorId)) held.hasScannedOnce = true;
    }
    for (const fenced of result.fenced) {
      const held = this.keys.all().find((k) => k.monitorId === fenced.id);
      if (held === undefined) continue;
      if (fenced.reason === "not-found") this.#dropKey(held, "not-found");
      else if (fenced.reason === "state") await this.refreshHeldMonitor(held);
      // `epoch` and `already-advanced` need nothing: the next turn re-reads the monitor, and the
      // second is the idempotent replay path.
    }

    this.#liveWatermark = height;
    return { matches: matchesFound };
  }

  /**
   * The `HAS_SCANNED_ONCE` check (§4.3), for ONE key, exactly once.
   *
   * Returns the range that was never read for this key, or `undefined` when there is none — which
   * is the normal case, because `sync-key` usually lands the key exactly at the watermark.
   */
  #gapsOnFirstPass(
    held: HeldKey, monitor: MonitorRecord, height: bigint,
  ): { readonly from: bigint; readonly to: bigint } | undefined {
    if (held.hasScannedOnce) return undefined;
    const through = monitor.coverage.scannedThrough;
    // Never scanned at all: the whole span from the requested start is the hole.
    const firstUnscanned = through === undefined ? monitor.coverage.requestedStart : through + 1n;
    if (firstUnscanned > height - 1n) return undefined;
    const gap = { from: firstUnscanned, to: height - 1n };
    this.#log(
      `[monitor-node] recorded a gap of ${gap.to - gap.from + 1n} block(s) below height ${height}; ` +
        "queueing a back-sync",
    );
    this.#queueB.push({ kind: "back-sync", fingerprintHex: held.fingerprintHex, from: gap.from, to: gap.to });
    return gap;
  }

  /** Reads a held monitor for a batch item. A monitor that has vanished or been closed takes its
   *  key with it, which is the one place the block loop may drop a key. */
  async #loadForBatch(held: HeldKey): Promise<MonitorRecord | undefined> {
    try {
      const monitor = await this.#store.get(held.monitorId);
      if (monitor.state !== "backfilling" && monitor.state !== "live") {
        await this.refreshHeldMonitor(held);
        return undefined;
      }
      return monitor;
    } catch (err) {
      if (err instanceof MonitorNotFoundError) {
        this.#dropKey(held, "not-found");
        return undefined;
      }
      throw err;
    }
  }

  /** A block that could not be read at all fails every monitor the node was scanning it for
   *  (FR-007's fail-closed stop), each one fenced on its own epoch. */
  async #failAllForBlock(height: bigint, err: unknown, live: readonly HeldKey[]): Promise<void> {
    const located = err instanceof BlockScanError ? err : undefined;
    const cause = located?.cause ?? err;
    const code = isUnsupportedProtocolVersion(cause)
      ? "UNSUPPORTED_PROTOCOL_VERSION"
      : "UNDECODABLE_TRANSACTION";
    const detail = {
      code,
      // The ledger's own message, which describes BYTES, never a key.
      message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 500),
      atHeight: height.toString(10),
      ...(located === undefined ? {} : { atPosition: located.atPosition }),
    };
    this.#log(`[monitor-node] block ${height} is undecodable (${code}); stopping ${live.length} monitor(s)`);
    for (const held of live) {
      try {
        const monitor = await this.#store.get(held.monitorId);
        await this.#store.markFailed(held.monitorId, this.#options.actor, detail, monitor.epoch);
      } catch {
        // Fenced or gone underneath us: the next turn re-reads it.
      }
      held.phase = "failed";
    }
  }

  // ── Queue B ────────────────────────────────────────────────────────────────────────────────

  async #runQueueBLoop(): Promise<void> {
    while (this.#running) {
      const job = this.#queueB.shift();
      if (job === undefined) {
        await this.#options.sleep(Math.min(this.#options.pollMs, 500));
        continue;
      }
      this.#queueBBusy = true;
      try {
        await this.runQueueBJob(job);
      } catch (err) {
        this.#log(`[monitor-node] queue B: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.#queueBBusy = false;
      }
    }
  }

  /** Runs the next Queue B job, if any. Exposed for the same reason {@link runQueueAOnce} is. */
  async runQueueBOnce(): Promise<boolean> {
    const job = this.#queueB.shift();
    if (job === undefined) return false;
    this.#queueBBusy = true;
    try {
      await this.runQueueBJob(job);
    } finally {
      this.#queueBBusy = false;
    }
    return true;
  }

  async runQueueBJob(job: QueueBJob): Promise<void> {
    const held = this.keys.get(job.fingerprintHex);
    // The key was deleted or dropped while the job waited. Nothing to do, and nothing to report:
    // the job is the only thing that referenced it.
    if (held === undefined) return;
    if (job.kind === "sync-key") await this.#syncKey(held);
    else await this.#backSync(held, job.from, job.to);
  }

  /**
   * `sync-key(fp)` (§4.2): catch ONE key up from its coverage to the node's live watermark, then
   * hand it to Queue A.
   *
   * The watermark is re-read after every page — that is the `maxHeight` seam on the scanner — so
   * this converges on a moving target instead of chasing it: each page closes part of the distance,
   * and Queue A only ever adds blocks at the far end.
   *
   * When it finishes, `phase = "live"` and `hasScannedOnce = false`. The second half of that is
   * not redundant with the first: it is what arms the `HAS_SCANNED_ONCE` check for the handoff
   * window this method cannot close by itself.
   *
   * It also re-queues the back-sync for every hole the record already carries (organizer question
   * Q32). A gap is only ever DISCOVERED once, by the `HAS_SCANNED_ONCE` check, and before this the
   * job that fills it existed only in the RAM of the node that discovered it: a node that died, or
   * a back-sync that failed its transport, left a row in `monitor_gaps` with nothing anywhere
   * scheduled to clear it. Taking a hold of a key is the natural moment to pick those up, because
   * a hold is exactly when a node has the key the range must be re-read with.
   */
  async #syncKey(held: HeldKey): Promise<void> {
    const scanner = new ShieldedMonitorScanner(this.#archive, this.#store, {
      net: this.#options.net,
      batchBlocks: this.#options.syncBatchBlocks,
      actor: this.#options.actor,
      key: held.esk,
      verifyTxIdentity: this.#options.verifyTxIdentity,
      maxHeight: () => this.#liveWatermark,
    });
    const run = await scanner.scanToTip(held.monitorId);
    if (run.last.kind === "fenced") {
      // A lifecycle change landed under the sync. Ask the store what it was rather than guessing:
      // a stopped monitor keeps its key, a deleted one clears it.
      await this.refreshHeldMonitor(held);
      return;
    }
    if (run.last.kind === "failed" || run.last.kind === "stale-source") {
      held.phase = "failed";
      return;
    }
    held.phase = "live";
    held.hasScannedOnce = false;
    this.#log(`[monitor-node] a key finished syncing after ${run.batches} batch(es); now live`);
    await this.#queueRecordedGaps(held);
  }

  /** Queues a `back-sync` for every gap the monitor's record still carries and that is not already
   *  in Queue B. A storage hiccup here costs nothing: the gap rows stay, and the next hold of this
   *  key tries again. */
  async #queueRecordedGaps(held: HeldKey): Promise<void> {
    let gaps: readonly MonitorGap[];
    try {
      gaps = (await this.#store.get(held.monitorId)).gaps;
    } catch {
      return;
    }
    let queued = 0;
    for (const gap of gaps) {
      const already = this.#queueB.some((job) =>
        job.kind === "back-sync" && job.fingerprintHex === held.fingerprintHex
        && job.from === gap.from && job.to === gap.to);
      if (already) continue;
      this.#queueB.push({ kind: "back-sync", fingerprintHex: held.fingerprintHex, from: gap.from, to: gap.to });
      queued += 1;
    }
    if (queued > 0) {
      this.#log(`[monitor-node] queued a back-sync for ${queued} gap(s) already recorded for this key`);
    }
  }

  /**
   * `back-sync(fp, from, to)` (§4.4): re-read a range this key missed, one `fill-gap` per block.
   *
   * Coverage is never moved — it is already above this range — so the commit per block is
   * `fill-gap`, which writes the associations and shrinks the gap row in one transaction. The
   * dashboard shows the gap shrinking, and it disappears when the range is done.
   */
  async #backSync(held: HeldKey, from: bigint, to: bigint): Promise<void> {
    for (let height = from; height <= to; height += 1n) {
      if (!this.#running && height > from) return;
      const current = this.keys.get(held.fingerprintHex);
      if (current === undefined) return;
      let monitor: MonitorRecord;
      try {
        monitor = await this.#store.get(held.monitorId);
      } catch {
        return;
      }
      const page = await this.#archive.readBlocksSince(this.#options.net, Number(height) - 1, 1);
      const block = page.blocks[0];
      if (block === undefined || BigInt(block.height) !== height) return;
      let byKey;
      try {
        byKey = await scanBlock(block, [held], {
          net: this.#options.net,
          verifyTxIdentity: this.#options.verifyTxIdentity,
        });
      } catch (err) {
        this.#log(`[monitor-node] back-sync stopped at ${height}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      try {
        await this.#store.fillGap(held.monitorId, {
          expectedEpoch: monitor.epoch,
          from: height,
          to: height,
          associations: byKey.get(held.fingerprintHex) ?? [],
        });
      } catch (err) {
        if (err instanceof MonitorFencedError || err instanceof MonitorNotFoundError) {
          await this.refreshHeldMonitor(held);
          return;
        }
        throw err;
      }
    }
    this.#log(`[monitor-node] back-sync finished for the range [${from}, ${to}]`);
  }

  #enqueueSync(fingerprintHex: string): void {
    if (this.#queueB.some((job) => job.kind === "sync-key" && job.fingerprintHex === fingerprintHex)) return;
    this.#queueB.push({ kind: "sync-key", fingerprintHex });
  }

  #dropKey(held: HeldKey, why: string): void {
    this.keys.remove(held.fingerprintHex);
    this.#log(`[monitor-node] dropped a key (${why}); ${this.keys.size} remain`);
  }

  /** The archive's tip, remembered for `/internal/status`'s `lagBlocks`. A read failure is not an
   *  error here: it means "unknown", and the caller waits for the next poll. */
  async readArchiveTip(): Promise<bigint | undefined> {
    try {
      const page = await this.#archive.readBlocksSince(this.#options.net, Number.MAX_SAFE_INTEGER - 1, 1);
      this.#archiveTip = page.sourceTip === undefined ? undefined : BigInt(page.sourceTip.height);
      return this.#archiveTip;
    } catch {
      return undefined;
    }
  }

  #log(line: string): void {
    this.#options.logger(line);
  }
}
