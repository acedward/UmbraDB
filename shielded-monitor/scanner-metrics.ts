/**
 * Scanner metrics (organizer spec FR-014, FR-023).
 *
 * **The label set is the security surface here, so it is a closed type rather than a
 * `Record<string, string>`.** FR-023 forbids viewing keys in metrics; US4's deferred hardening
 * additionally forbids exposing which monitor saw which transaction. A monitor id in a label is
 * not key material, but a metric series per monitor id leaks the association COUNT and TIMING
 * per wallet to anyone who can read the metrics endpoint — the same shape of leak the audit
 * called an anti-pattern in the reference indexer. Making the labels a fixed union means adding
 * one is a deliberate type change a reviewer sees, not a string a caller invents.
 *
 * Deliberately NOT a Prometheus client. This repository has no metrics dependency and adding one
 * for a scanner would be a bigger decision than this phase should make; the interface is what
 * matters (a process can adapt it to whatever the deployment exports), and
 * {@link InMemoryScannerMetrics} is enough for tests and for the CLI's periodic log line.
 */

/** The one dimension every counter may carry. `net` is deployment-wide, not per-consumer, so it
 *  reveals nothing about who registered what. */
export interface ScannerMetricLabels {
  readonly net: string;
}

/** What a scan batch did, as a metric dimension. Fixed set: an outcome that is not one of these
 *  is a coding error, not a new label value. */
export type ScanBatchOutcomeLabel =
  | "advanced"
  | "already-advanced"
  | "at-tip"
  | "fenced"
  | "failed"
  | "stale-source"
  | "error";

export interface ScannerMetrics {
  /** Transactions handed to the relevance predicate (excludes system transactions, which are
   *  skipped before deserialization). */
  observeTransactionsScanned(labels: ScannerMetricLabels, count: number): void;
  /** Associations recorded. A TOTAL across monitors — never per monitor. */
  observeMatches(labels: ScannerMetricLabels, count: number): void;
  /** Whole blocks whose coverage was committed. */
  observeBlocksScanned(labels: ScannerMetricLabels, count: number): void;
  /** Wall-clock duration of one batch, including the archive read and the commit. */
  observeBatchDuration(labels: ScannerMetricLabels, outcome: ScanBatchOutcomeLabel, ms: number): void;
  /** `sourceTip − scannedThrough` for one monitor, reported as an aggregate gauge: the scanner
   *  publishes the MAXIMUM lag across monitors, so the series says "the worst-served monitor is
   *  N blocks behind" without naming it. */
  observeLag(labels: ScannerMetricLabels, blocks: number): void;
}

/** Counters and gauges accumulated in memory. */
export interface ScannerMetricsSnapshot {
  transactionsScanned: number;
  matches: number;
  blocksScanned: number;
  batches: Record<ScanBatchOutcomeLabel, number>;
  batchMillisTotal: number;
  /** Highest lag observed since the last {@link InMemoryScannerMetrics.reset}. */
  maxLagBlocks: number;
  /** Derived, not stored: transactions per second across all batches measured. */
  transactionsPerSecond: number;
}

const ZERO_BATCHES = (): Record<ScanBatchOutcomeLabel, number> => ({
  advanced: 0, "already-advanced": 0, "at-tip": 0, fenced: 0, failed: 0, "stale-source": 0, error: 0,
});

/**
 * The default implementation: plain counters, keyed by `net` only.
 *
 * Used by the CLI for its periodic log line and by the benchmark for its throughput figure, so
 * the number the benchmark reports and the number an operator sees come from the same code.
 */
export class InMemoryScannerMetrics implements ScannerMetrics {
  private readonly byNet = new Map<string, ScannerMetricsSnapshot>();

  private slot(net: string): ScannerMetricsSnapshot {
    let snapshot = this.byNet.get(net);
    if (snapshot === undefined) {
      snapshot = {
        transactionsScanned: 0, matches: 0, blocksScanned: 0, batches: ZERO_BATCHES(),
        batchMillisTotal: 0, maxLagBlocks: 0, transactionsPerSecond: 0,
      };
      this.byNet.set(net, snapshot);
    }
    return snapshot;
  }

  observeTransactionsScanned({ net }: ScannerMetricLabels, count: number): void {
    this.slot(net).transactionsScanned += count;
  }

  observeMatches({ net }: ScannerMetricLabels, count: number): void {
    this.slot(net).matches += count;
  }

  observeBlocksScanned({ net }: ScannerMetricLabels, count: number): void {
    this.slot(net).blocksScanned += count;
  }

  observeBatchDuration({ net }: ScannerMetricLabels, outcome: ScanBatchOutcomeLabel, ms: number): void {
    const slot = this.slot(net);
    slot.batches[outcome] += 1;
    slot.batchMillisTotal += ms;
  }

  observeLag({ net }: ScannerMetricLabels, blocks: number): void {
    const slot = this.slot(net);
    if (blocks > slot.maxLagBlocks) slot.maxLagBlocks = blocks;
  }

  /** A read-only view for one net, with throughput derived at read time. */
  snapshot(net: string): ScannerMetricsSnapshot {
    const slot = this.slot(net);
    return {
      ...slot,
      batches: { ...slot.batches },
      transactionsPerSecond: slot.batchMillisTotal === 0
        ? 0
        : (slot.transactionsScanned * 1000) / slot.batchMillisTotal,
    };
  }

  /** Every net this process has observed. */
  nets(): string[] {
    return [...this.byNet.keys()];
  }

  reset(): void {
    this.byNet.clear();
  }
}

/** A metrics sink that records nothing, for callers that do not want the bookkeeping. */
export const NOOP_SCANNER_METRICS: ScannerMetrics = {
  observeTransactionsScanned: () => {},
  observeMatches: () => {},
  observeBlocksScanned: () => {},
  observeBatchDuration: () => {},
  observeLag: () => {},
};
