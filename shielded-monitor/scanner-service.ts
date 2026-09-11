import { ARCHIVE_PROGRESS_CHANNEL } from "../src/postgres/archive-conventions.js";
import type { ArchiveWakeSource, ArchiveWakeSubscription } from "./wake.js";
import type { MonitorRecord } from "./store.js";
import type { ScanBatchResult, ShieldedMonitorScanner } from "./scanner.js";

/**
 * The scheduler around {@link ShieldedMonitorScanner} (organizer spec FR-014, US2).
 *
 * Three rules, and they are the whole design:
 *
 *  1. **One ordered worker per monitor.** A monitor is scanned by at most one task at a time, and
 *     that task runs its batches in height order. Two workers on one monitor would not corrupt
 *     anything — the epoch fence and the monotonic coverage guard see to that — but one of them
 *     would burn its whole batch and lose the race at the commit, which is waste, not safety.
 *     `inFlight` is that guarantee WITHIN a process; since 00009-08 a **monitor lease** is the
 *     same guarantee ACROSS processes, so several scanner instances can share one B database
 *     (`src/postgres/migrations/shielded_monitor/003_monitor_leases.ts`). Both are optimisations:
 *     remove either and the associations are still exactly right, just computed twice.
 *  2. **`SCAN_CONCURRENCY` monitors in parallel.** Monitors are independent — different keys,
 *     different rows, different commits — so the bound exists to cap database connections and
 *     WASM memory, not for correctness.
 *  3. **Live tail via a wake-up source, with polling as the fallback, never instead of it.** The
 *     archive emits `NOTIFY chain_archive_progress, '<net>:<height>'` INSIDE the per-height
 *     transaction (00009-01), and 00009-08 republishes it as an SSE stream for a project B that
 *     has no connection to A's database at all. Either way an arrival means "this height is
 *     readable" and a rollback delivers nothing — but a wake-up can be MISSED (a listener
 *     connection drops, `LISTEN` has no replay, an SSE stream is cut), so `SCAN_POLL_MS` still
 *     fires. The wake-up makes the tail prompt; the poll makes it correct.
 */

/**
 * The channel 00009-01's `putBlockBundle` notifies inside the height transaction.
 *
 * Imported from the archive's own conventions module, never retyped here: B carries no archive
 * name of its own (owner Rule B / FR-025, enforced by
 * `test/shielded-monitor/schema-isolation.integration.test.ts`), and a second copy of the string
 * could drift from the writer's — leaving this scheduler listening on a channel nobody notifies
 * and silently falling back to `SCAN_POLL_MS` with nothing to show for it.
 */
export { ARCHIVE_PROGRESS_CHANNEL };

/** Rotates a list by a random offset, preserving relative order.
 *
 *  A rotation rather than a shuffle: `listActive` returns monitors oldest-first, and that order
 *  is worth keeping within a cycle (the oldest monitor is usually the furthest behind). All this
 *  needs to do is stop every instance from starting at the same element. */
export function rotateRandomly<T>(items: readonly T[]): T[] {
  if (items.length < 2) return [...items];
  const offset = Math.floor(Math.random() * items.length);
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/** Any UUID in a log line, which for this module means a monitor id. */
const MONITOR_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * An error rendered for the log: its class, its stable `code` when it carries one, and its
 * message with monitor ids redacted.
 *
 * The redaction is not theatre. Several of this project's own errors put the monitor id in the
 * message (`MonitorFencedError`, `MonitorNotFoundError`), and a scanner log line naming which
 * monitor failed and when is a per-wallet signal to anyone who can read the log — the same class
 * of leak the audit named in the reference indexer's plaintext associations, arriving by a
 * different route. Organizer spec FR-023 bans keys outright; ids are not keys, but there is no
 * diagnostic reason to print one, so this prints the failure class instead and keeps the rest of
 * the message, which is where the actual diagnosis lives.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err).replace(MONITOR_ID_PATTERN, "<monitor>");
  const code = (err as { code?: unknown }).code;
  const prefix = typeof code === "string" ? `${err.name}[${code}]` : err.name;
  return `${prefix}: ${err.message.replace(MONITOR_ID_PATTERN, "<monitor>")}`;
}

export interface ScannerServiceOptions {
  readonly net: string;
  /** Monitors scanned in parallel. Default 4. */
  readonly concurrency?: number;
  /** Fallback wake-up interval when no notification arrives. Default 2000 ms. */
  readonly pollMs?: number;
  /** Upper bound on monitors this process will pick up in one cycle (organizer spec FR-014's
   *  "bounded per process"; the spec's `MAX_MONITORS_PER_TENANT` with one tenant). Default 100. */
  readonly maxMonitors?: number;
  /** Batches a single monitor may run before the cycle moves on, so one badly-behind monitor
   *  cannot starve the others. Default 64. */
  readonly maxBatchesPerMonitorPerCycle?: number;
  /** Called after every cycle; used by tests and by the CLI's log line. */
  readonly onCycle?: (summary: ScanCycleSummary) => void;
  readonly logger?: (line: string) => void;
  /**
   * This instance's lease owner name (00009-08, `SCAN_INSTANCE_ID`). Required to claim leases;
   * omit it, and this scheduler behaves exactly as it did before leases existed — which is the
   * right behaviour for the single-instance deployments that are the majority.
   */
  readonly instanceId?: string;
  /** How long a claim survives without renewal. Default 30 s. */
  readonly leaseTtlMs?: number;
  /**
   * Shuffle the order monitors are attempted in (default: on when leases are in use).
   *
   * Without it, every instance walks `listActive`'s `created_at, id` order and races for the same
   * monitor first, every cycle. The instance that wins tends to keep winning, and a second
   * instance ends up doing the leftovers rather than half the work. A random rotation costs
   * nothing and makes the split even; the ORDER WITHIN a monitor is untouched, which is the only
   * ordering that matters for correctness.
   */
  readonly shuffleMonitors?: boolean;
}

export interface ScanCycleSummary {
  readonly monitorsConsidered: number;
  readonly monitorsScanned: number;
  readonly batches: number;
  readonly outcomes: Partial<Record<ScanBatchResult["kind"], number>>;
  /** Monitors another instance held a live lease on, and this one therefore left alone
   *  (00009-08). Zero in a single-instance deployment. */
  readonly monitorsLeasedElsewhere?: number;
}

/** Exactly what the SCHEDULER may do to the store. Narrow for the same reason
 *  {@link ScannerStore} is (`scanner.ts`): the scheduler must not be able to touch a monitor's
 *  coverage, associations or lifecycle. The two lease calls it gained in 00009-08 write only to
 *  `monitor_leases`, a table nothing else reads, and are optional so a store without them — an
 *  in-memory double, a pre-00009-08 deployment — still satisfies this interface. */
export interface ScannerServiceStore {
  listActive(limit?: number): Promise<MonitorRecord[]>;
  claimMonitorLease?(
    monitorId: string, owner: string, ttlMs: number,
  ): Promise<{ readonly acquired: boolean }>;
  releaseMonitorLease?(monitorId: string, owner: string): Promise<{ readonly released: boolean }>;
}

export class ShieldedMonitorScannerService {
  private readonly net: string;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly maxMonitors: number;
  private readonly maxBatchesPerMonitorPerCycle: number;
  private readonly onCycle: (summary: ScanCycleSummary) => void;
  private readonly logger: (line: string) => void;
  private readonly instanceId?: string;
  private readonly leaseTtlMs: number;
  private readonly shuffleMonitors: boolean;

  private readonly inFlight = new Set<string>();
  private running = false;
  private loop?: Promise<void>;
  private wake: (() => void) | undefined;
  private woken = false;
  private listener?: ArchiveWakeSubscription;

  constructor(
    private readonly scanner: ShieldedMonitorScanner,
    private readonly store: ScannerServiceStore,
    /** Where "the archive moved" comes from. Deliberately advisory: every byte the scanner acts
     *  on still arrives through the {@link ArchiveReadContract}, and {@link NO_WAKE} — polling
     *  only — is a correct implementation. */
    private readonly wakeSource: ArchiveWakeSource,
    options: ScannerServiceOptions,
  ) {
    this.net = options.net;
    this.concurrency = options.concurrency ?? 4;
    this.pollMs = options.pollMs ?? 2000;
    this.maxMonitors = options.maxMonitors ?? 100;
    this.maxBatchesPerMonitorPerCycle = options.maxBatchesPerMonitorPerCycle ?? 64;
    this.onCycle = options.onCycle ?? (() => {});
    this.logger = options.logger ?? (() => {});
    if (options.instanceId !== undefined) this.instanceId = options.instanceId;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.shuffleMonitors = options.shuffleMonitors ?? this.leasesEnabled;
    if (this.concurrency < 1) throw new Error(`concurrency must be >= 1; got ${this.concurrency}`);
    if (this.pollMs < 1) throw new Error(`pollMs must be >= 1; got ${this.pollMs}`);
  }

  /** Start the loop. Resolves once the listener is attached, not when the loop ends. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.attachListener();
    this.loop = this.run();
  }

  /** Stop the loop and detach the listener. Waits for the in-flight cycle to finish, so a stop
   *  never leaves a batch half-committed — there is no such state anyway (Rule B), but it also
   *  never leaves a WASM key handle unreleased. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop?.catch(() => {});
    this.loop = undefined;
    if (this.listener !== undefined) {
      await this.listener.close().catch(() => {});
      this.listener = undefined;
    }
  }

  /**
   * Run exactly one cycle: pick up every active monitor (bounded), scan each towards the tip
   * with at most `concurrency` in flight, and return what happened.
   *
   * Public because it is what the tests and the benchmark drive; the loop is this in a `while`.
   */
  async runCycle(): Promise<ScanCycleSummary> {
    const monitors = await this.store.listActive(this.maxMonitors);
    // Monitors for another network belong to another deployment's scanner (Q7: one network per
    // deployment). Filtered here rather than refused, so a stray row cannot stop this net's work.
    const eligible = monitors.filter((m) => m.net === this.net && !this.inFlight.has(m.id));
    const outcomes: Partial<Record<ScanBatchResult["kind"], number>> = {};
    let batches = 0;
    let scanned = 0;
    let leasedElsewhere = 0;

    const queue = this.shuffleMonitors ? rotateRandomly(eligible) : [...eligible];
    const worker = async (): Promise<void> => {
      for (;;) {
        const monitor = queue.shift();
        if (monitor === undefined) return;
        if (this.inFlight.has(monitor.id)) continue;
        // Claimed BEFORE the work, and only for the duration of this turn. A claim that fails
        // means another instance is already scanning this monitor; skipping is the entire point.
        // A claim that THROWS is not: it means the store is unhappy, and scanning without a lease
        // is still correct (the epoch fence admits the commit), so the turn proceeds rather than
        // letting an optimisation's failure stop a wallet from being scanned.
        if (!(await this.claimLease(monitor.id))) {
          leasedElsewhere += 1;
          continue;
        }
        this.inFlight.add(monitor.id);
        try {
          const result = await this.scanner.scanToTip(monitor.id, {
            maxBatches: this.maxBatchesPerMonitorPerCycle,
          });
          batches += result.batches;
          scanned += 1;
          outcomes[result.last.kind] = (outcomes[result.last.kind] ?? 0) + 1;
        } catch (err) {
          // One monitor's unexpected failure must not take the whole scanner down: the others
          // are independent, and a crash loop would stop every wallet in the deployment.
          this.logger(
            `[shielded-monitor-scanner] a monitor batch threw: ${describeError(err)}`,
          );
          outcomes.failed = (outcomes.failed ?? 0) + 1;
        } finally {
          this.inFlight.delete(monitor.id);
          // Released at the END OF THE TURN, not held until it expires. Holding would make the
          // assignment sticky and leave a second instance with the leftovers; releasing lets the
          // next cycle redistribute. A turn cut short by a crash releases nothing, which is
          // exactly when the TTL has to do the work instead.
          await this.releaseLease(monitor.id);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, Math.max(queue.length, 1)) }, () => worker()),
    );
    const summary: ScanCycleSummary = {
      monitorsConsidered: monitors.length,
      monitorsScanned: scanned,
      batches,
      outcomes,
      ...(this.leasesEnabled ? { monitorsLeasedElsewhere: leasedElsewhere } : {}),
    };
    this.onCycle(summary);
    return summary;
  }

  /** True when this instance is configured to claim leases AND the store implements them. Both
   *  halves matter: a store double without the methods must not turn a scheduler into a no-op. */
  private get leasesEnabled(): boolean {
    return this.instanceId !== undefined && typeof this.store.claimMonitorLease === "function";
  }

  private async claimLease(monitorId: string): Promise<boolean> {
    if (!this.leasesEnabled) return true;
    try {
      const claim = await this.store.claimMonitorLease!(monitorId, this.instanceId!, this.leaseTtlMs);
      return claim.acquired;
    } catch (err) {
      this.logger(
        `[shielded-monitor-scanner] could not claim a monitor lease (${describeError(err)}); ` +
          "scanning anyway — the lease is an optimisation and the epoch fence is what makes the " +
          "commit safe",
      );
      return true;
    }
  }

  private async releaseLease(monitorId: string): Promise<void> {
    if (!this.leasesEnabled) return;
    try {
      await this.store.releaseMonitorLease!(monitorId, this.instanceId!);
    } catch (err) {
      // A lease that is not released simply expires. Logged, never thrown: a failure to clean up
      // an optimisation must not surface as a scan failure.
      this.logger(`[shielded-monitor-scanner] could not release a monitor lease: ${describeError(err)}`);
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.runCycle();
      } catch (err) {
        this.logger(`[shielded-monitor-scanner] cycle failed: ${describeError(err)}`);
      }
      if (!this.running) return;
      await this.waitForWork();
    }
  }

  /** Sleep until `pollMs` elapses or a `chain_archive_progress` notification arrives. */
  private async waitForWork(): Promise<void> {
    if (this.woken) { this.woken = false; return; }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, this.pollMs);
      // `unref` so a running scanner never keeps a test process alive past its own teardown.
      timer.unref?.();
      this.wake = finish;
      function finish(): void {
        clearTimeout(timer);
        resolve();
      }
    });
    this.wake = undefined;
    this.woken = false;
  }

  private async attachListener(): Promise<void> {
    try {
      this.listener = await this.wakeSource.subscribe(this.net, () => {
        this.woken = true;
        this.wake?.();
      });
    } catch (err) {
      // A missing wake-up degrades to polling, which is the documented fallback — it must not
      // stop the scanner from running.
      this.logger(
        `[shielded-monitor-scanner] wake-up source (${this.wakeSource.describe}) unavailable, ` +
          `falling back to ${this.pollMs} ms polling: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
