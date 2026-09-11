import { describe, expect, it } from "vitest";
import { readScannerConfig, SCANNER_ENV_DOC } from "../../shielded-monitor/scanner-config.js";
import { InMemoryScannerMetrics, NOOP_SCANNER_METRICS } from "../../shielded-monitor/scanner-metrics.js";
import { describeError } from "../../shielded-monitor/scanner-service.js";
import { MonitorFencedError, MonitorNotFoundError } from "../../shielded-monitor/errors.js";

/**
 * The scanner process's configuration and its metrics sink.
 *
 * The configuration cases exist because of a real finding the archive CLI already carries as
 * audit item T6 (`chain-archive-sync/sync-cli.ts`): a mistyped bound that silently became the
 * default DISABLED the thing it was meant to limit, with no message. Every numeric setting here
 * refuses a bad value and names the variable, and these are the tests that keep it that way.
 */

const MINIMAL = { MONITOR_PG: "postgres://u:p@localhost:5432/db" } as NodeJS.ProcessEnv;

describe("scanner configuration", () => {
  it("defaults are exactly what the documentation says", () => {
    const config = readScannerConfig(MINIMAL);
    expect(config).toMatchObject({
      net: "undeployed",
      archiveSchema: "chain_archive",
      monitorSchema: "shielded_monitor",
      batchBlocks: 1,
      concurrency: 4,
      pollMs: 2000,
      maxMonitors: 100,
      maxBatchesPerMonitorPerCycle: 64,
      metricsLogSeconds: 30,
      once: false,
    });
    expect(config.budgetTxPerSecond).toBeUndefined();
    // The doc block is the operator's only reference, so it must actually name each default.
    for (const fragment of ["default 1", "default 4", "default 2000", "default 100", "default 64", "default 30"]) {
      expect(SCANNER_ENV_DOC).toContain(fragment);
    }
  });

  it("a missing connection string is refused with the documentation attached", () => {
    expect(() => readScannerConfig({})).toThrow(/MONITOR_PG is required/);
    expect(() => readScannerConfig({ MONITOR_PG: "   " })).toThrow(/MONITOR_PG is required/);
  });

  it.each([
    ["SCAN_BATCH_BLOCKS", "0"],
    ["SCAN_BATCH_BLOCKS", "-1"],
    ["SCAN_BATCH_BLOCKS", "1.5"],
    ["SCAN_BATCH_BLOCKS", "many"],
    ["SCAN_CONCURRENCY", "0"],
    ["SCAN_POLL_MS", "0"],
    ["MAX_MONITORS", "0"],
    ["SCAN_MAX_BATCHES", "0"],
  ])("%s=%s is REFUSED rather than silently replaced by the default", (name, value) => {
    expect(() => readScannerConfig({ ...MINIMAL, [name]: value })).toThrow(new RegExp(name));
  });

  it("a bad throughput ceiling is refused; a good one is a number, not a string", () => {
    expect(() => readScannerConfig({ ...MINIMAL, SCAN_BUDGET_TX_PER_S: "0" })).toThrow(/SCAN_BUDGET_TX_PER_S/);
    expect(() => readScannerConfig({ ...MINIMAL, SCAN_BUDGET_TX_PER_S: "-3" })).toThrow(/SCAN_BUDGET_TX_PER_S/);
    expect(readScannerConfig({ ...MINIMAL, SCAN_BUDGET_TX_PER_S: "12.5" }).budgetTxPerSecond).toBe(12.5);
  });

  it("metricsLogSeconds may be 0 (disabled) but not negative", () => {
    expect(readScannerConfig({ ...MINIMAL, SCAN_METRICS_LOG_S: "0" }).metricsLogSeconds).toBe(0);
    expect(() => readScannerConfig({ ...MINIMAL, SCAN_METRICS_LOG_S: "-1" })).toThrow(/SCAN_METRICS_LOG_S/);
  });

  it("every setting can be overridden", () => {
    const config = readScannerConfig({
      ...MINIMAL, NET: "preview", ARCHIVE_SCHEMA: "arc", MONITOR_SCHEMA: "mon",
      SCAN_BATCH_BLOCKS: "8", SCAN_CONCURRENCY: "2", SCAN_POLL_MS: "500", MAX_MONITORS: "7",
      SCAN_MAX_BATCHES: "3", SCAN_METRICS_LOG_S: "5", SCAN_ONCE: "1",
    });
    expect(config).toMatchObject({
      net: "preview", archiveSchema: "arc", monitorSchema: "mon", batchBlocks: 8,
      concurrency: 2, pollMs: 500, maxMonitors: 7, maxBatchesPerMonitorPerCycle: 3,
      metricsLogSeconds: 5, once: true,
    });
  });
});

describe("scanner metrics", () => {
  it("accumulates per net and derives throughput from the measured batch time", () => {
    const metrics = new InMemoryScannerMetrics();
    metrics.observeTransactionsScanned({ net: "a" }, 100);
    metrics.observeMatches({ net: "a" }, 3);
    metrics.observeBlocksScanned({ net: "a" }, 10);
    metrics.observeBatchDuration({ net: "a" }, "advanced", 500);
    metrics.observeBatchDuration({ net: "a" }, "at-tip", 500);
    const snapshot = metrics.snapshot("a");
    expect(snapshot.transactionsScanned).toBe(100);
    expect(snapshot.matches).toBe(3);
    expect(snapshot.blocksScanned).toBe(10);
    expect(snapshot.batches.advanced).toBe(1);
    expect(snapshot.batches["at-tip"]).toBe(1);
    expect(snapshot.transactionsPerSecond).toBe(100);
  });

  it("lag is the MAXIMUM observed, so the series names the worst-served monitor's distance and not which one", () => {
    const metrics = new InMemoryScannerMetrics();
    metrics.observeLag({ net: "a" }, 4);
    metrics.observeLag({ net: "a" }, 11);
    metrics.observeLag({ net: "a" }, 2);
    expect(metrics.snapshot("a").maxLagBlocks).toBe(11);
  });

  it("nets are isolated, and an unseen net reads as zeros rather than throwing", () => {
    const metrics = new InMemoryScannerMetrics();
    metrics.observeMatches({ net: "a" }, 2);
    expect(metrics.snapshot("b").matches).toBe(0);
    expect(metrics.nets().sort()).toEqual(["a", "b"]);
    expect(metrics.snapshot("a").transactionsPerSecond).toBe(0);
    metrics.reset();
    expect(metrics.nets()).toEqual([]);
  });

  it("the no-op sink accepts every call and records nothing", () => {
    expect(() => {
      NOOP_SCANNER_METRICS.observeTransactionsScanned({ net: "a" }, 1);
      NOOP_SCANNER_METRICS.observeMatches({ net: "a" }, 1);
      NOOP_SCANNER_METRICS.observeBlocksScanned({ net: "a" }, 1);
      NOOP_SCANNER_METRICS.observeBatchDuration({ net: "a" }, "error", 1);
      NOOP_SCANNER_METRICS.observeLag({ net: "a" }, 1);
    }).not.toThrow();
  });
});

describe("scanner log rendering", () => {
  const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  it("keeps the failure class and the diagnosis but never prints a monitor id", () => {
    // Both of these errors put the id in their own message, which is right for a caller
    // handling them and wrong for a log line an operator or an aggregator can read.
    const fenced = describeError(new MonitorFencedError(ID, "epoch", { epoch: 4n, state: "live" }));
    expect(fenced).not.toContain(ID);
    expect(fenced).toContain("<monitor>");
    expect(fenced).toContain("SHIELDED_MONITOR_FENCED");
    expect(fenced, "the diagnosis itself must survive").toContain("stored epoch 4");

    const missing = describeError(new MonitorNotFoundError(ID));
    expect(missing).not.toContain(ID);
    expect(missing).toContain("SHIELDED_MONITOR_NOT_FOUND");
  });

  it("renders an error without a code, and a non-Error throw, without losing the redaction", () => {
    expect(describeError(new Error(`boom for ${ID}`))).toBe("Error: boom for <monitor>");
    expect(describeError(`raw string mentioning ${ID}`)).toBe("raw string mentioning <monitor>");
  });
});
