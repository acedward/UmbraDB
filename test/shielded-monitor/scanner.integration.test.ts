import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEDGER_BUILD_ID, MATCHING_RULE_VERSION } from "../../shielded-monitor/offers.js";
import { ShieldedMonitorScanner } from "../../shielded-monitor/scanner.js";
import { InMemoryScannerMetrics } from "../../shielded-monitor/scanner-metrics.js";
import { ShieldedMonitorScannerService } from "../../shielded-monitor/scanner-service.js";
import { createScannerWorld, destroyWorld, type ScannerWorld } from "./scanner-harness.js";

/**
 * The scanner against a real archive and a real store (organizer spec SC-001, US1, US2, US3,
 * FR-006..FR-014).
 *
 * Every block here was written by the archive's OWN `putBlockBundle` and is read back through
 * the `ArchiveReadContract`, so what is exercised is the production path end to end: real ledger
 * bytes, real trial decryption, real fenced commit.
 */

const NET = "undeployed";

async function drain(scanner: ShieldedMonitorScanner, monitorId: string): Promise<void> {
  const result = await scanner.scanToTip(monitorId, { maxBatches: 64 });
  if (result.last.kind === "failed" || result.last.kind === "stale-source") {
    throw new Error(`drain ended in ${result.last.kind}: ${JSON.stringify(result.last)}`);
  }
}

describe("relevance scanner against a real archive (SC-001, US1, US2)", () => {
  let container: StartedPostgreSqlContainer;
  let world: ScannerWorld;
  let scanner: ShieldedMonitorScanner;
  let metrics: InMemoryScannerMetrics;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    world = await createScannerWorld(container, "scan");
    metrics = new InMemoryScannerMetrics();
    scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET, metrics });
  }, 300_000);

  afterAll(async () => {
    if (world !== undefined) await destroyWorld(world);
    await container?.stop();
  });

  it("[[shielded-monitor.relevance.matches-equal-the-fixture-manifest]] every monitor's associations equal the fixture manifest exactly — every positive once, no negative, correct segments (SC-001)", async () => {
    for (const key of world.corpus.manifest.keys) {
      const monitorId = world.monitors.get(key.id)!;
      await drain(scanner, monitorId);

      const associations = await world.store.readAssociations(monitorId, 0n, 1000);
      const expected = world.corpus.expectedMatches.get(key.id)!;

      expect(
        associations.length,
        `${key.id}: expected ${expected.length} matches (${expected.map((e) => e.id).join(", ")}), got ` +
          `${associations.length}`,
      ).toBe(expected.length);

      for (const [index, spec] of expected.entries()) {
        const got = associations[index]!;
        const wantTx = world.corpus.transactions.find((t) => t.spec.id === spec.id)!;
        expect(got.blockHeight, `${key.id}/${spec.id} height`).toBe(BigInt(spec.blockHeight));
        expect(got.position, `${key.id}/${spec.id} position`).toBe(spec.position);
        expect(got.txHash.toString("hex"), `${key.id}/${spec.id} tx hash`).toBe(wantTx.txHash);
        expect([...got.matchedSegments], `${key.id}/${spec.id} segments`).toEqual(spec.expected[key.id]);
        // FR-009: applied outcome is always "unknown"; nothing here claims funds were received.
        expect(got.appliedOutcome).toBe("unknown");
        expect(got.protocolVersion).toBe(BigInt(world.corpus.manifest.protocolVersion));
        expect(got.matchingRuleVersion).toBe(MATCHING_RULE_VERSION);
        expect(got.ledgerBuild).toBe(LEDGER_BUILD_ID);
        expect(got.net).toBe(NET);
      }

      // Ordering is `(blockHeight, position)` and the sequence is gapless (FR-019's cursor).
      const ordered = [...associations].sort((a, b) => (a.blockHeight === b.blockHeight
        ? a.position - b.position
        : a.blockHeight < b.blockHeight ? -1 : 1));
      expect(associations.map((a) => a.seq)).toEqual(ordered.map((a) => a.seq));
      expect(associations.map((a) => a.seq)).toEqual(
        associations.map((_, i) => BigInt(i + 1)),
      );
    }
  }, 300_000);

  it("every match carries its public zswap data and its block time, recorded at match time (00009-07)", async () => {
    for (const key of world.corpus.manifest.keys) {
      const monitorId = world.monitors.get(key.id)!;
      const associations = await world.store.readAssociations(monitorId, 0n, 1000);
      expect(associations.length, `${key.id} must have matches`).toBeGreaterThan(0);
      for (const got of associations) {
        const details = got.details;
        expect(details, `${key.id} seq ${got.seq} has no details`).toBeDefined();
        expect(details!.ledgerBuild).toBe(LEDGER_BUILD_ID);
        // The segments the details report as matched are exactly the association's own — the two
        // come from one evaluation, so they cannot disagree.
        expect(details!.segments.filter((seg) => seg.matched).map((seg) => seg.segment))
          .toStrictEqual([...got.matchedSegments]);
        // Every matched segment holds at least one entry the key could own, or the match would
        // have been impossible.
        for (const segment of details!.segments.filter((seg) => seg.matched)) {
          expect(segment.outputs.length + segment.transients.length).toBeGreaterThan(0);
        }
        // The block time is the archive's own value for that height, not a clock read.
        const bundle = world.corpus.bundles.find((b) => BigInt(b.block.height) === got.blockHeight)!;
        expect(got.blockTimestampMs).toBe(BigInt(bundle.block.timestampMs!));
      }
    }
  }, 300_000);

  it("no association carries a sourceOutcome when the archive recorded none — 'unknown' is never dressed up", async () => {
    // The corpus is archived by node-only ingest, which records no replay outcome, so
    // `sourceOutcome` must be ABSENT rather than invented. (The archive DOES persist outcomes
    // when replay validation runs; that path is 00009-01's.)
    for (const key of world.corpus.manifest.keys) {
      const associations = await world.store.readAssociations(world.monitors.get(key.id)!, 0n, 1000);
      for (const a of associations) expect(a.sourceOutcome).toBeUndefined();
    }
  });

  it("coverage reaches the archive tip and the monitor goes live (US2 scenario 3)", async () => {
    const monitorId = world.monitors.get("K")!;
    const monitor = await world.store.get(monitorId);
    const tipHeight = Math.max(...world.corpus.manifest.blocks.map((b) => b.height));
    expect(monitor.coverage.scannedThrough).toBe(BigInt(tipHeight));
    expect(monitor.coverage.scannedFrom).toBe(0n);
    expect(monitor.state).toBe("live");
  });

  it("a block with no matches still advances coverage (US2 scenario 1)", async () => {
    // Height 2 holds a transaction relevant only to the third key, and height 5 is empty.
    // Coverage above them is the proof they were scanned rather than skipped.
    const monitorId = world.monitors.get("K")!;
    const associations = await world.store.readAssociations(monitorId, 0n, 1000);
    expect(associations.some((a) => a.blockHeight === 2n)).toBe(false);
    expect((await world.store.get(monitorId)).coverage.scannedThrough).toBeGreaterThan(2n);
  });

  it("a newly archived block with a positive is picked up on the next batch (US2 scenario 2)", async () => {
    const monitorId = world.monitors.get("K")!;
    const before = await world.store.readAssociations(monitorId, 0n, 1000);
    const lastSeq = before[before.length - 1]!.seq;

    // Append a new height carrying a copy of the guaranteed-to-K transaction.
    const positive = world.corpus.transactions.find((t) => t.spec.id === "h1p0-guaranteed-to-K")!;
    const newHeight = Math.max(...world.corpus.manifest.blocks.map((b) => b.height)) + 1;
    const previous = world.corpus.bundles[world.corpus.bundles.length - 1]!;
    const blockHash = "f".repeat(63) + "1";
    await world.archiveStore.putBlockBundle({
      block: {
        net: NET, blockHash, height: newHeight, parentHash: previous.block.blockHash,
        stateRoot: "1".repeat(64), extrinsicsRoot: "2".repeat(64),
        headerBytes: new TextEncoder().encode(`header/${newHeight}`),
        isCanonical: true, status: "canonical", finalized: true,
        timestampMs: 1_754_395_200_000 + newHeight * 6_000,
      },
      transactions: [{
        net: NET, txHash: "3".repeat(64), blockHeight: newHeight, blockHash, position: 0,
        kind: "regular", protocolVersion: world.corpus.manifest.protocolVersion,
        rawBytes: positive.rawBytes,
      }],
      bridgeObservations: [],
      watermark: { key: `sync_cursor:${NET}`, value: { height: newHeight } },
      notifyChannel: "chain_archive_progress",
    });

    await drain(scanner, monitorId);

    const after = await world.store.readAssociations(monitorId, lastSeq, 1000);
    expect(after).toHaveLength(1);
    expect(after[0]!.blockHeight).toBe(BigInt(newHeight));
    expect(after[0]!.txHash.toString("hex")).toBe("3".repeat(64));
    // The cursor moved past it, and re-reading from the same cursor returns the same page.
    expect(await world.store.readAssociations(monitorId, lastSeq, 1000)).toHaveLength(1);
    expect(await world.store.readAssociations(monitorId, after[0]!.seq, 1000)).toHaveLength(0);
  }, 120_000);

  it("a re-scan from the same coverage is idempotent: no duplicate associations", async () => {
    const monitorId = world.monitors.get("K")!;
    const before = await world.store.readAssociations(monitorId, 0n, 1000);
    // Every batch from here is "already at the tip"; nothing may be written twice.
    await drain(scanner, monitorId);
    await drain(scanner, monitorId);
    const after = await world.store.readAssociations(monitorId, 0n, 1000);
    expect(after.map((a) => a.seq)).toEqual(before.map((a) => a.seq));
  }, 120_000);

  it("metrics carry counters and a lag, and no monitor id anywhere in them", () => {
    const snapshot = metrics.snapshot(NET);
    expect(snapshot.transactionsScanned).toBeGreaterThan(0);
    expect(snapshot.matches).toBeGreaterThan(0);
    expect(snapshot.blocksScanned).toBeGreaterThan(0);
    expect(snapshot.transactionsPerSecond).toBeGreaterThan(0);
    // Structural, not a string scan: the sink is keyed by `net` alone, so the only dimension a
    // caller CAN pass is the network. A monitor id has nowhere to go.
    expect(metrics.nets()).toEqual([NET]);
    const serialized = JSON.stringify(snapshot);
    for (const id of world.monitors.values()) expect(serialized).not.toContain(id);
  });
});

describe("scanner lifecycle interaction (US3, FR-012, FR-013)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 300_000);

  afterAll(async () => { await container?.stop(); });

  it("a pause landing between the load and the commit fences the batch, and resume continues with no duplicate and no gap (US3 scenarios 1 and 2)", async () => {
    const world = await createScannerWorld(container, "fence");
    try {
      const monitorId = world.monitors.get("K")!;
      const scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET });

      // Load the monitor the way a worker does...
      const loaded = await world.store.get(monitorId);
      // ...then a consumer pauses it while that worker is "mid-batch".
      await world.store.pause(monitorId, "consumer");

      const result = await scanner.scanBatch(loaded);
      expect(result).toEqual({ kind: "fenced", rejection: "state" });
      expect(await world.store.readAssociations(monitorId, 0n, 100)).toHaveLength(0);
      expect((await world.store.get(monitorId)).coverage.scannedThrough).toBeUndefined();

      // Resume, scan properly, and compare against the manifest: nothing skipped, nothing doubled.
      await world.store.resume(monitorId, "consumer");
      await drain(scanner, monitorId);
      const associations = await world.store.readAssociations(monitorId, 0n, 1000);
      expect(associations).toHaveLength(world.corpus.expectedMatches.get("K")!.length);
      expect(new Set(associations.map((a) => `${a.blockHeight}/${a.position}`)).size).toBe(associations.length);
    } finally {
      await destroyWorld(world);
    }
  }, 300_000);

  it("a revoke mid-batch stops the monitor and no worker advances it again (US3 scenario 3)", async () => {
    const world = await createScannerWorld(container, "revoke");
    try {
      const monitorId = world.monitors.get("K")!;
      const scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET });
      const loaded = await world.store.get(monitorId);
      await world.store.revoke(monitorId, "consumer");

      expect(await scanner.scanBatch(loaded)).toEqual({ kind: "fenced", rejection: "state" });
      // And the ordered worker refuses to even start on it.
      const drained = await scanner.scanToTip(monitorId, { maxBatches: 4 });
      expect(drained.batches).toBe(0);
      expect(drained.last).toEqual({ kind: "fenced", rejection: "state" });
    } finally {
      await destroyWorld(world);
    }
  }, 300_000);

  it("[[shielded-monitor.scanner.stale-source-stops-the-monitor]] a re-bootstrapped archive (new instance id) moves monitors to stale_source instead of mixing histories (US5 scenario 5, FR-013)", async () => {
    const world = await createScannerWorld(container, "stale");
    try {
      const monitorId = world.monitors.get("K")!;
      const scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET });

      // One clean batch first, so the monitor is genuinely bound and has coverage to protect.
      const first = await scanner.scanBatch(await world.store.get(monitorId));
      expect(first.kind).toBe("advanced");
      const boundCoverage = (await world.store.get(monitorId)).coverage.scannedThrough;
      const boundInstance = (await world.store.get(monitorId)).sourceInstanceId;
      expect(boundInstance).toBeDefined();

      // Re-bootstrap: the archive is re-synced from scratch, so the instance id changes while
      // the chain (and therefore the genesis hash) does not. Done by rewriting the identity row
      // directly — that is what a drop-and-recreate produces, without a 6-block re-ingest.
      const identityKey = `archive_identity:${NET}`;
      await world.sql`
        UPDATE ${world.sql(world.archiveSchema)}.watermarks
           SET value = ${world.sql.json({ archiveInstanceId: "9".repeat(32) } as never)}
         WHERE kind = 'chain_archive' AND key = ${identityKey}
      `;

      const second = await scanner.scanBatch(await world.store.get(monitorId));
      expect(second).toEqual({ kind: "stale-source" });
      const after = await world.store.get(monitorId);
      expect(after.state).toBe("stale_source");
      expect(after.lastError?.code).toBe("ARCHIVE_IDENTITY_CHANGED");
      // Coverage is frozen where it was: a stale source must not roll anything back OR advance.
      expect(after.coverage.scannedThrough).toBe(boundCoverage);
    } finally {
      await destroyWorld(world);
    }
  }, 300_000);

  it("[[shielded-monitor.scanner.fail-closed-on-undecodable-bytes]] an undecodable transaction stops the monitor at that position and claims no coverage (FR-007)", async () => {
    const world = await createScannerWorld(container, "failclosed", { archiveThrough: 0 });
    try {
      const monitorId = world.monitors.get("K")!;
      const scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET });

      // Height 1 carries a transaction the ledger cannot read. It is archived as `regular` with
      // a supported protocol version, so nothing but the bytes is wrong — exactly the shape a
      // corrupted or foreign payload would have.
      const blockHash = "e".repeat(63) + "1";
      await world.archiveStore.putBlockBundle({
        block: {
          net: NET, blockHash, height: 1, parentHash: world.corpus.bundles[0]!.block.blockHash,
          stateRoot: "4".repeat(64), extrinsicsRoot: "5".repeat(64),
          headerBytes: new TextEncoder().encode("header/bad"),
          isCanonical: true, status: "canonical", finalized: true, timestampMs: 1_754_395_206_000,
        },
        transactions: [{
          net: NET, txHash: "6".repeat(64), blockHeight: 1, blockHash, position: 0,
          kind: "regular", protocolVersion: 1_000_000,
          rawBytes: new TextEncoder().encode("midnight:transaction but not really"),
        }],
        bridgeObservations: [],
        watermark: { key: `sync_cursor:${NET}`, value: { height: 1 } },
        notifyChannel: "chain_archive_progress",
      });

      // Height 0 scans fine.
      expect((await scanner.scanBatch(await world.store.get(monitorId))).kind).toBe("advanced");
      const result = await scanner.scanBatch(await world.store.get(monitorId));

      expect(result).toMatchObject({ kind: "failed", atHeight: 1n, atPosition: 0 });
      const failed = await world.store.get(monitorId);
      expect(failed.state).toBe("failed");
      expect(failed.lastError?.atHeight).toBe("1");
      expect(failed.lastError?.atPosition).toBe(0);
      // THE point of fail-closed: coverage stayed at 0. The unreadable height is not recorded
      // as scanned-and-empty, so it is not silently lost.
      expect(failed.coverage.scannedThrough).toBe(0n);
      expect(failed.lastError?.message).not.toContain("mn_shield-esk");
    } finally {
      await destroyWorld(world);
    }
  }, 300_000);

  it("a start height above the archive tip leaves the monitor backfilling with nothing scanned", async () => {
    const world = await createScannerWorld(container, "future", { startHeight: 1000n });
    try {
      const monitorId = world.monitors.get("K")!;
      const scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET });
      const result = await scanner.scanBatch(await world.store.get(monitorId));
      expect(result.kind).toBe("at-tip");
      const monitor = await world.store.get(monitorId);
      expect(monitor.state).toBe("backfilling");
      expect(monitor.coverage.scannedThrough).toBeUndefined();
      expect(monitor.coverage.requestedStart).toBe(1000n);
    } finally {
      await destroyWorld(world);
    }
  }, 300_000);

  it("a start height above the earliest archived block scans only from there (coverage begins at the requested start)", async () => {
    const world = await createScannerWorld(container, "startat", { startHeight: 3n });
    try {
      const monitorId = world.monitors.get("K")!;
      const scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET });
      await drain(scanner, monitorId);
      const monitor = await world.store.get(monitorId);
      expect(monitor.coverage.scannedFrom).toBe(3n);
      const associations = await world.store.readAssociations(monitorId, 0n, 100);
      // Derived from the manifest rather than hard-coded, so the assertion tracks the corpus:
      // every positive at or above height 3, in order, and nothing below it.
      const expected = world.corpus.expectedMatches.get("K")!.filter((t) => t.blockHeight >= 3);
      expect(expected.length).toBeGreaterThan(0);
      expect(world.corpus.expectedMatches.get("K")!.length).toBeGreaterThan(expected.length);
      expect(associations.map((a) => Number(a.blockHeight))).toEqual(expected.map((t) => t.blockHeight));
    } finally {
      await destroyWorld(world);
    }
  }, 300_000);
});

describe("scanner scheduling (FR-014, US2)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 300_000);

  afterAll(async () => { await container?.stop(); });

  it("one cycle drives every active monitor to the tip, with concurrency bounded", async () => {
    const world = await createScannerWorld(container, "sched");
    try {
      const scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET });
      const service = new ShieldedMonitorScannerService(scanner, world.store, world.sql, {
        net: NET, concurrency: 2, pollMs: 50,
      });
      const summary = await service.runCycle();
      expect(summary.monitorsScanned).toBe(world.monitors.size);
      for (const key of world.corpus.manifest.keys) {
        const monitor = await world.store.get(world.monitors.get(key.id)!);
        expect(monitor.state, `${key.id} should be live after one cycle`).toBe("live");
      }
    } finally {
      await destroyWorld(world);
    }
  }, 300_000);

  it("a newly archived block wakes the running scanner through LISTEN rather than only on the poll timer", async () => {
    const world = await createScannerWorld(container, "tail");
    try {
      const scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET });
      // A poll interval far longer than the test: if the match appears, it appeared because the
      // NOTIFY woke the loop, not because the timer fired.
      //
      // Deliberately NOT in the required-tests manifest, unlike this phase's other scanner ids:
      // it is the one case whose pass/fail depends on wall-clock progress under whatever else
      // is running on the host, and a load-sensitive entry in a fail-closed gate makes the gate
      // less trustworthy rather than more. It still runs in every suite run.
      const service = new ShieldedMonitorScannerService(scanner, world.store, world.sql, {
        net: NET, concurrency: 2, pollMs: 600_000,
      });
      const monitorId = world.monitors.get("K")!;
      await service.start();
      try {
        // Wait for the first cycle to catch up to the existing tip.
        await waitFor(async () => (await world.store.get(monitorId)).state === "live", 60_000);
        const before = (await world.store.readAssociations(monitorId, 0n, 1000)).length;

        const positive = world.corpus.transactions.find((t) => t.spec.id === "h1p0-guaranteed-to-K")!;
        const newHeight = Math.max(...world.corpus.manifest.blocks.map((b) => b.height)) + 1;
        const blockHash = "a".repeat(63) + "7";
        await world.archiveStore.putBlockBundle({
          block: {
            net: NET, blockHash, height: newHeight,
            parentHash: world.corpus.bundles[world.corpus.bundles.length - 1]!.block.blockHash,
            stateRoot: "7".repeat(64), extrinsicsRoot: "8".repeat(64),
            headerBytes: new TextEncoder().encode(`header/${newHeight}`),
            isCanonical: true, status: "canonical", finalized: true,
            timestampMs: 1_754_395_200_000 + newHeight * 6_000,
          },
          transactions: [{
            net: NET, txHash: "9".repeat(64), blockHeight: newHeight, blockHash, position: 0,
            kind: "regular", protocolVersion: world.corpus.manifest.protocolVersion,
            rawBytes: positive.rawBytes,
          }],
          bridgeObservations: [],
          watermark: { key: `sync_cursor:${NET}`, value: { height: newHeight } },
          notifyChannel: "chain_archive_progress",
        });

        await waitFor(
          async () => (await world.store.readAssociations(monitorId, 0n, 1000)).length === before + 1,
          30_000,
        );
      } finally {
        await service.stop();
      }
    } finally {
      await destroyWorld(world);
    }
  }, 300_000);
});

/** Polls `predicate` until it is true or the budget runs out. */
async function waitFor(predicate: () => Promise<boolean>, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${budgetMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
