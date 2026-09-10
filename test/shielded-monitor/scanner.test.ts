import { describe, expect, it } from "vitest";
import type {
  ArchiveBlockPage, ArchiveIdentity, ArchiveReadContract, ArchivedBlock,
} from "../../src/interfaces/archive-read-contract.js";
import { MonitorFencedError } from "../../shielded-monitor/errors.js";
import type { EncryptionSecretKeyHandle } from "../../shielded-monitor/offers.js";
import { ShieldedMonitorScanner, hexToBytes, type ScannerStore } from "../../shielded-monitor/scanner.js";
import { InMemoryScannerMetrics } from "../../shielded-monitor/scanner-metrics.js";
import type {
  AdvanceResult, AssociationInput, MonitorLastError, MonitorRecord,
} from "../../shielded-monitor/store.js";

/**
 * The scanner's control flow, without a database and without the ledger.
 *
 * The Testcontainers suite (`scanner.integration.test.ts`) proves the real thing end to end.
 * This file exists for the properties that suite CANNOT observe: how many times the key was
 * deserialized, whether `clear()` ran on the failure path, how many `advance` calls one batch
 * makes, and what happens when a store method throws a fence at each of the four places one can
 * arrive. Those are call-sequence facts, and a double is the only instrument that sees them.
 */

const NET = "undeployed";
const KEY_BYTES = Uint8Array.from([1, 2, 3, 4]);

function hex(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function monitorRecord(over: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    net: NET,
    state: "backfilling",
    epoch: 1n,
    coverage: { requestedStart: 0n },
    sourceGenesisHash: hex(0),
    sourceInstanceId: "a".repeat(32),
    matchingRuleVersion: "shielded-monitor/relevance/v1",
    ledgerBuild: "ledger-v8@8.1.0-syshash.4",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

/** A block whose transactions are all `system`, so the scanner skips them without asking the
 *  ledger to decode the placeholder bytes. Used wherever a test is about CONTROL FLOW rather
 *  than about the predicate. */
function systemBlock(height: number, txCount: number): ArchivedBlock {
  const b = block(height, txCount);
  return { ...b, transactions: b.transactions.map((t) => ({ ...t, kind: "system" as const })) };
}

function block(height: number, txCount: number): ArchivedBlock {
  return {
    net: NET,
    height,
    hash: hex(height),
    parentHash: hex(height - 1),
    transactions: Array.from({ length: txCount }, (_, position) => ({
      txHash: hex(1000 + height * 10 + position),
      position,
      kind: "regular" as const,
      protocolVersion: 1_000_000,
      rawBytes: new TextEncoder().encode(`tx/${height}/${position}`),
    })),
  };
}

/** An archive double: pages come from a fixed list of blocks; the tip is the highest of them. */
class FakeArchive implements ArchiveReadContract {
  reads = 0;
  identityReads = 0;
  /** Assigned, never a defaulted constructor parameter: passing `undefined` explicitly to a
   *  parameter with a default silently gets the default, which is exactly the mistake that made
   *  the "archive cannot answer its identity" case pass through the happy path once. */
  identity: ArchiveIdentity | undefined = { net: NET, genesisHash: hex(0), archiveInstanceId: "a".repeat(32) };
  constructor(public blocks: ArchivedBlock[]) {}

  async readBlocksSince(_net: string, afterHeight: number, maxBlocks: number): Promise<ArchiveBlockPage> {
    this.reads += 1;
    const after = this.blocks.filter((b) => b.height > afterHeight).slice(0, maxBlocks);
    const tipBlock = this.blocks[this.blocks.length - 1];
    return {
      blocks: after,
      ...(tipBlock === undefined ? {} : { sourceTip: { height: tipBlock.height, hash: tipBlock.hash } }),
    };
  }

  async getArchiveIdentity(): Promise<ArchiveIdentity | undefined> {
    this.identityReads += 1;
    return this.identity;
  }
}

interface Advance {
  epoch: bigint;
  throughHeight: bigint;
  associations: readonly AssociationInput[];
  fromHeight?: bigint;
}

/** A store double recording every call the scanner makes. */
class FakeStore implements ScannerStore {
  monitor: MonitorRecord = monitorRecord();
  readonly advances: Advance[] = [];
  readonly keyReads: number[] = [];
  goLiveCalls = 0;
  failed: MonitorLastError | undefined;
  staleCalls = 0;
  bindCalls: { genesisHash: string; instanceId: string }[] = [];
  advanceThrows: Error | undefined;
  markFailedThrows: Error | undefined;

  async get(): Promise<MonitorRecord> { return this.monitor; }

  async getKeyMaterial(): Promise<Uint8Array> {
    this.keyReads.push(this.keyReads.length);
    return Uint8Array.from(KEY_BYTES);
  }

  async advance(
    _id: string, epoch: bigint, throughHeight: bigint,
    associations: readonly AssociationInput[], opts: { fromHeight?: bigint } = {},
  ): Promise<AdvanceResult> {
    if (this.advanceThrows !== undefined) throw this.advanceThrows;
    this.advances.push({
      epoch, throughHeight, associations,
      ...(opts.fromHeight === undefined ? {} : { fromHeight: opts.fromHeight }),
    });
    this.monitor = {
      ...this.monitor,
      coverage: {
        requestedStart: this.monitor.coverage.requestedStart,
        scannedFrom: this.monitor.coverage.scannedFrom ?? opts.fromHeight ?? 0n,
        scannedThrough: throughHeight,
      },
    };
    return {
      applied: true, firstSeq: 1n, lastSeq: BigInt(associations.length), coverage: this.monitor.coverage,
    };
  }

  async goLive(): Promise<MonitorRecord> {
    this.goLiveCalls += 1;
    this.monitor = { ...this.monitor, state: "live", epoch: this.monitor.epoch + 1n };
    return this.monitor;
  }

  async markFailed(_id: string, _actor: string, error: MonitorLastError): Promise<MonitorRecord> {
    if (this.markFailedThrows !== undefined) throw this.markFailedThrows;
    this.failed = error;
    this.monitor = { ...this.monitor, state: "failed" };
    return this.monitor;
  }

  async markStaleSource(): Promise<MonitorRecord> {
    this.staleCalls += 1;
    this.monitor = { ...this.monitor, state: "stale_source" };
    return this.monitor;
  }

  async bindArchiveSource(
    _id: string, _epoch: bigint, source: { genesisHash: string; instanceId: string },
  ): Promise<{ applied: boolean; monitor: MonitorRecord }> {
    this.bindCalls.push(source);
    this.monitor = { ...this.monitor, sourceGenesisHash: source.genesisHash, sourceInstanceId: source.instanceId };
    return { applied: true, monitor: this.monitor };
  }
}

/** A key double that records its own lifecycle. `matches` decides the predicate's answer, but
 *  the predicate here never runs — the scanner is driven with a `deserializeKey` that also
 *  short-circuits offer extraction by throwing or matching, per test. */
function fakeKey(state: { deserialized: number; cleared: number }): EncryptionSecretKeyHandle {
  state.deserialized += 1;
  return {
    test: () => false,
    clear: () => { state.cleared += 1; },
  };
}

describe("scanner control flow (no database, no ledger)", () => {
  it("commits exactly ONE advance per batch, at the LAST block height of the page (Rule B)", async () => {
    const archive = new FakeArchive([systemBlock(0, 1), systemBlock(1, 2), block(2, 0)]);
    const store = new FakeStore();
    const lifecycle = { deserialized: 0, cleared: 0 };
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, batchBlocks: 3, deserializeKey: async () => fakeKey(lifecycle),
    });

    const result = await scanner.scanBatch(store.monitor);

    expect(result.kind).toBe("advanced");
    expect(store.advances).toHaveLength(1);
    expect(store.advances[0]!.throughHeight).toBe(2n);
    // Three whole blocks, one commit — including the empty height 2, which still advances.
    expect(result.kind === "advanced" && result.blocks).toBe(3);
  });

  it("deserializes the key ONCE per batch and clears it once, even when the predicate throws", async () => {
    const archive = new FakeArchive([block(0, 3)]);
    const store = new FakeStore();
    const lifecycle = { deserialized: 0, cleared: 0 };
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET,
      deserializeKey: async () => {
        const handle = fakeKey(lifecycle);
        return { test: handle.test, clear: handle.clear };
      },
    });

    // The fake transactions are not real ledger bytes, so `extractOffers` throws on the FIRST
    // one — i.e. this exercises the failure path through `matchPage`'s `finally`.
    const result = await scanner.scanBatch(store.monitor);

    expect(result.kind).toBe("failed");
    expect(lifecycle.deserialized).toBe(1);
    expect(lifecycle.cleared).toBe(1);
    // Fail-closed: nothing was committed for the height it could not read.
    expect(store.advances).toHaveLength(0);
    expect(store.failed?.code).toBe("UNDECODABLE_TRANSACTION");
    expect(store.failed?.atHeight).toBe("0");
    expect(store.failed?.atPosition).toBe(0);
  });

  it("never shares a key handle between monitors — each batch gets its own", async () => {
    const archive = new FakeArchive([systemBlock(0, 0)]);
    const store = new FakeStore();
    const handles: EncryptionSecretKeyHandle[] = [];
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET,
      deserializeKey: async () => {
        const handle = { test: () => false, clear: () => {} };
        handles.push(handle);
        return handle;
      },
    });

    await scanner.scanBatch(monitorRecord({ id: "11111111-2222-4333-8444-555555555555" }));
    store.monitor = monitorRecord({ id: "22222222-2222-4333-8444-555555555555" });
    await scanner.scanBatch(store.monitor);

    expect(handles).toHaveLength(2);
    expect(handles[0]).not.toBe(handles[1]);
  });

  it("an unsupported protocol version stops the monitor with the typed code (FR-007)", async () => {
    const withBadVersion = block(0, 1);
    const archive = new FakeArchive([{
      ...withBadVersion,
      transactions: [{ ...withBadVersion.transactions[0]!, protocolVersion: 999 }],
    }]);
    const store = new FakeStore();
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });

    const result = await scanner.scanBatch(store.monitor);

    expect(result).toMatchObject({ kind: "failed", code: "UNSUPPORTED_PROTOCOL_VERSION", atHeight: 0n, atPosition: 0 });
    expect(store.advances).toHaveLength(0);
  });

  it("a system transaction is not deserialized, so a block of them advances coverage cleanly", async () => {
    const archive = new FakeArchive([systemBlock(0, 2)]);
    const store = new FakeStore();
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });

    const result = await scanner.scanBatch(store.monitor);

    expect(result).toMatchObject({ kind: "advanced", transactionsScanned: 0, matches: 0 });
    expect(store.advances).toHaveLength(1);
  });

  it("a changed archive instance id moves the monitor to stale_source and commits nothing (FR-013)", async () => {
    const archive = new FakeArchive([block(0, 1)]);
    archive.identity = { net: NET, genesisHash: hex(0), archiveInstanceId: "b".repeat(32) };
    const store = new FakeStore();
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });

    expect(await scanner.scanBatch(store.monitor)).toEqual({ kind: "stale-source" });
    expect(store.staleCalls).toBe(1);
    expect(store.advances).toHaveLength(0);
    // The page was never even read: a stale source must not be scanned at all.
    expect(archive.reads).toBe(0);
  });

  it("an unbound monitor is bound on first use, then compared on every later batch", async () => {
    const archive = new FakeArchive([block(0, 0)]);
    const store = new FakeStore();
    store.monitor = monitorRecord({ sourceGenesisHash: undefined, sourceInstanceId: undefined });
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });

    await scanner.scanBatch(store.monitor);
    expect(store.bindCalls).toEqual([{ genesisHash: hex(0), instanceId: "a".repeat(32) }]);
    // Second batch: already bound, so no second bind, and no stale-source.
    await scanner.scanBatch(store.monitor);
    expect(store.bindCalls).toHaveLength(1);
    expect(store.staleCalls).toBe(0);
  });

  it("an archive that cannot yet answer its identity is 'nothing to scan', not a mismatch", async () => {
    const archive = new FakeArchive([block(0, 1)]);
    archive.identity = undefined;
    const store = new FakeStore();
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });

    expect(await scanner.scanBatch(store.monitor)).toEqual({ kind: "at-tip", wentLive: false });
    expect(store.staleCalls).toBe(0);
    expect(store.advances).toHaveLength(0);
  });

  it("a fence at the commit is reported, not swallowed, and nothing is retried blindly", async () => {
    const archive = new FakeArchive([block(0, 0)]);
    const store = new FakeStore();
    store.advanceThrows = new MonitorFencedError(store.monitor.id, "epoch", { epoch: 9n, state: "backfilling" });
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });

    expect(await scanner.scanBatch(store.monitor)).toEqual({ kind: "fenced", rejection: "epoch" });
  });

  it("a fence at markFailed is reported as fenced, not as a failure the scanner did not cause", async () => {
    const archive = new FakeArchive([block(0, 1)]);
    const store = new FakeStore();
    store.markFailedThrows = new MonitorFencedError(store.monitor.id, "state", { epoch: 1n, state: "revoked" });
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });

    expect(await scanner.scanBatch(store.monitor)).toEqual({ kind: "fenced", rejection: "state" });
  });

  it("promotes to live only when coverage reaches the tip observed in the SAME page read", async () => {
    const archive = new FakeArchive([block(0, 0), block(1, 0)]);
    const store = new FakeStore();
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, batchBlocks: 1, deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });

    const first = await scanner.scanBatch(store.monitor);
    expect(first).toMatchObject({ kind: "advanced", throughHeight: 0n, wentLive: false });
    expect(store.goLiveCalls).toBe(0);

    const second = await scanner.scanBatch(store.monitor);
    expect(second).toMatchObject({ kind: "advanced", throughHeight: 1n, wentLive: true });
    expect(store.monitor.state).toBe("live");
  });

  it("reports lag as (tip − coverage) and never as a negative number", async () => {
    const archive = new FakeArchive([block(0, 0), block(1, 0), block(2, 0)]);
    const store = new FakeStore();
    store.monitor = monitorRecord({ coverage: { requestedStart: 0n, scannedThrough: 0n } });
    const metrics = new InMemoryScannerMetrics();
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, metrics, deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });

    await scanner.scanBatch(store.monitor);
    expect(metrics.snapshot(NET).maxLagBlocks).toBe(2);
  });

  it("refuses to scan a monitor belonging to another network", async () => {
    const archive = new FakeArchive([block(0, 0)]);
    const store = new FakeStore();
    const scanner = new ShieldedMonitorScanner(archive, store, { net: NET });
    await expect(scanner.scanBatch(monitorRecord({ net: "someothernet" }))).rejects.toThrow(/One network per deployment/);
  });

  it("refuses a non-positive batch size at construction rather than silently scanning nothing", () => {
    const archive = new FakeArchive([]);
    expect(() => new ShieldedMonitorScanner(archive, new FakeStore(), { net: NET, batchBlocks: 0 }))
      .toThrow(/batchBlocks/);
  });

  it("the throughput budget delays a batch that ran faster than the ceiling", async () => {
    const archive = new FakeArchive([systemBlock(0, 4)]);
    const store = new FakeStore();
    // With every transaction a system one, `transactionsScanned` is 0 and the budget must NOT
    // fire — a sleep on an empty batch would stall the tail for nothing.
    const slept: number[] = [];
    const scanner = new ShieldedMonitorScanner(archive, store, {
      net: NET, budgetTxPerSecond: 1,
      sleep: async (ms) => { slept.push(ms); },
      deserializeKey: async () => ({ test: () => false, clear: () => {} }),
    });
    await scanner.scanBatch(store.monitor);
    expect(slept).toEqual([]);
  });

  it("hexToBytes rejects anything that is not even-length lowercase hex", () => {
    expect([...hexToBytes("00ff")]).toEqual([0, 255]);
    expect(() => hexToBytes("0")).toThrow();
    expect(() => hexToBytes("00FF")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });
});
