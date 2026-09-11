import type { UmbraDBSql } from "../src/postgres/client.js";
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
 *     `inFlight` is that guarantee, held in this process because this process is the only
 *     scanner (Q4: one consumer, one deployment).
 *  2. **`SCAN_CONCURRENCY` monitors in parallel.** Monitors are independent — different keys,
 *     different rows, different commits — so the bound exists to cap database connections and
 *     WASM memory, not for correctness.
 *  3. **Live tail via `LISTEN`, with polling as the fallback, never instead of it.** The archive
 *     emits `NOTIFY chain_archive_progress, '<net>:<height>'` INSIDE the per-height transaction
 *     (00009-01), so an arrival means "this height is readable" and a rollback delivers nothing.
 *     But a notification can be missed — the listener connection can drop, and `LISTEN` has no
 *     replay — so `SCAN_POLL_MS` still fires. The notification makes the tail prompt; the poll
 *     makes it correct.
 */

/** The channel 00009-01's `putBlockBundle` notifies inside the height transaction. */
export const ARCHIVE_PROGRESS_CHANNEL = "chain_archive_progress";

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
}

export interface ScanCycleSummary {
  readonly monitorsConsidered: number;
  readonly monitorsScanned: number;
  readonly batches: number;
  readonly outcomes: Partial<Record<ScanBatchResult["kind"], number>>;
}

/** The one store operation the SCHEDULER needs. Narrow for the same reason
 *  {@link ScannerStore} is (`scanner.ts`): the scheduler must not be able to write anything. */
export interface ScannerServiceStore {
  listActive(limit?: number): Promise<MonitorRecord[]>;
}

export class ShieldedMonitorScannerService {
  private readonly net: string;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly maxMonitors: number;
  private readonly maxBatchesPerMonitorPerCycle: number;
  private readonly onCycle: (summary: ScanCycleSummary) => void;
  private readonly logger: (line: string) => void;

  private readonly inFlight = new Set<string>();
  private running = false;
  private loop?: Promise<void>;
  private wake: (() => void) | undefined;
  private woken = false;
  private listener?: { unlisten: () => Promise<unknown> };

  constructor(
    private readonly scanner: ShieldedMonitorScanner,
    private readonly store: ScannerServiceStore,
    /** B's OWN connection, used only to `LISTEN`. Rule B is not at risk: `LISTEN` is not a write
     *  and the channel is a name, not a table — but the wake-up is deliberately advisory, and
     *  every byte the scanner acts on still comes through the {@link ArchiveReadContract}. */
    private readonly sql: UmbraDBSql,
    options: ScannerServiceOptions,
  ) {
    this.net = options.net;
    this.concurrency = options.concurrency ?? 4;
    this.pollMs = options.pollMs ?? 2000;
    this.maxMonitors = options.maxMonitors ?? 100;
    this.maxBatchesPerMonitorPerCycle = options.maxBatchesPerMonitorPerCycle ?? 64;
    this.onCycle = options.onCycle ?? (() => {});
    this.logger = options.logger ?? (() => {});
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
      await this.listener.unlisten().catch(() => {});
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

    const queue = [...eligible];
    const worker = async (): Promise<void> => {
      for (;;) {
        const monitor = queue.shift();
        if (monitor === undefined) return;
        if (this.inFlight.has(monitor.id)) continue;
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
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, Math.max(queue.length, 1)) }, () => worker()),
    );
    const summary: ScanCycleSummary = {
      monitorsConsidered: monitors.length, monitorsScanned: scanned, batches, outcomes,
    };
    this.onCycle(summary);
    return summary;
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
      const handle = await this.sql.listen(ARCHIVE_PROGRESS_CHANNEL, (payload) => {
        // The payload is `<net>:<height>`. Only the net is used — the height is advisory, and
        // the scanner re-reads coverage from its own schema rather than trusting a message.
        if (!payload.startsWith(`${this.net}:`)) return;
        this.woken = true;
        this.wake?.();
      });
      this.listener = handle;
    } catch (err) {
      // A missing listener degrades to polling, which is the documented fallback — it must not
      // stop the scanner from running.
      this.logger(
        `[shielded-monitor-scanner] LISTEN ${ARCHIVE_PROGRESS_CHANNEL} unavailable, ` +
          `falling back to ${this.pollMs} ms polling: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
