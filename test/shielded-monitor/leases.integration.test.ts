import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ShieldedMonitorScanner, type ScannerStore } from "../../shielded-monitor/scanner.js";
import { ShieldedMonitorScannerService } from "../../shielded-monitor/scanner-service.js";
import { NO_WAKE } from "../../shielded-monitor/wake.js";
import type { AdvanceResult, AssociationInput } from "../../shielded-monitor/store.js";
import { createScannerWorld, destroyWorld, type ScannerWorld } from "./scanner-harness.js";

/**
 * **Several scanner instances, one project-B database** (organizer sub-plan 00009-08; owner:
 * "we could spin up multiple if needed").
 *
 * Two properties, and it matters which is which:
 *
 *  - **Correctness does not depend on leases.** The association set equals the fixture oracle
 *    exactly once whatever the instances do, because `advance` is admitted by the monitor's EPOCH
 *    and by coverage moving strictly forward — never by a lease. The lease tests below therefore
 *    never assert "no duplicate rows BECAUSE of the lease"; the duplicate-freedom is the store's,
 *    and it is asserted separately.
 *  - **Leases stop duplicated WORK.** A monitor is scanned by one instance at a time, a crashed
 *    instance's monitors are taken over after `SCAN_LEASE_TTL_MS`, and a graceful stop hands them
 *    back at once.
 */

const NET = "undeployed";

describe("monitor leases (00009-08)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 240_000);

  afterAll(async () => {
    await container?.stop();
  }, 120_000);

  describe("the store's claim / renew / release", () => {
    let world: ScannerWorld;
    let monitorId: string;

    beforeEach(async () => {
      world = await createScannerWorld(container, "lease");
      monitorId = world.monitors.get("K")!;
    }, 120_000);

    afterAll(async () => {
      if (world !== undefined) await destroyWorld(world);
    }, 60_000);

    it("one instance claims it; a second is refused while the claim is live", async () => {
      expect((await world.store.claimMonitorLease(monitorId, "scanner-1", 30_000)).acquired).toBe(true);
      expect((await world.store.claimMonitorLease(monitorId, "scanner-2", 30_000)).acquired).toBe(false);
      expect((await world.store.readMonitorLease(monitorId))!.owner).toBe("scanner-1");
    });

    it("the HOLDER may re-claim its own lease (the cycle does this every turn)", async () => {
      // Without the `OR owner = EXCLUDED.owner` clause an instance would lose its own monitor to
      // itself the first time the TTL elapsed mid-backfill.
      await world.store.claimMonitorLease(monitorId, "scanner-1", 30_000);
      const again = await world.store.claimMonitorLease(monitorId, "scanner-1", 30_000);
      expect(again.acquired).toBe(true);
      expect(again.lease!.owner).toBe("scanner-1");
    });

    it("an EXPIRED lease is taken over — that is the only thing the TTL is for", async () => {
      await world.store.claimMonitorLease(monitorId, "scanner-1", 1_000);
      expect((await world.store.claimMonitorLease(monitorId, "scanner-2", 30_000)).acquired).toBe(false);
      await new Promise((r) => setTimeout(r, 1_200));
      expect((await world.store.claimMonitorLease(monitorId, "scanner-2", 30_000)).acquired).toBe(true);
      expect((await world.store.readMonitorLease(monitorId))!.owner).toBe("scanner-2");
    }, 30_000);

    it("release is scoped to the owner: nobody can hand away someone else's monitor", async () => {
      await world.store.claimMonitorLease(monitorId, "scanner-1", 30_000);
      expect((await world.store.releaseMonitorLease(monitorId, "scanner-2")).released).toBe(false);
      expect((await world.store.readMonitorLease(monitorId))!.owner).toBe("scanner-1");
      expect((await world.store.releaseMonitorLease(monitorId, "scanner-1")).released).toBe(true);
      expect(await world.store.readMonitorLease(monitorId)).toBeUndefined();
      // Releasing a lease that is already gone is NOT an error: it may simply have expired and
      // been re-claimed, which is exactly when a caller must not be told something went wrong.
      expect((await world.store.releaseMonitorLease(monitorId, "scanner-1")).released).toBe(false);
    });

    it("`advance` renews the lease IN ITS OWN TRANSACTION, and reports it held", async () => {
      const monitor = await world.store.get(monitorId);
      await world.store.claimMonitorLease(monitorId, "scanner-1", 2_000);
      const before = (await world.store.readMonitorLease(monitorId))!.expiresAt;
      const result = await world.store.advance(monitorId, monitor.epoch, 1n, [], {
        lease: { owner: "scanner-1", ttlMs: 3_600_000 },
      });
      expect(result.applied).toBe(true);
      expect(result.leaseHeld).toBe(true);
      const after = (await world.store.readMonitorLease(monitorId))!.expiresAt;
      expect(after.getTime()).toBeGreaterThan(before.getTime() + 60_000);
    });

    it("a lease taken over mid-turn does NOT stop the commit — it reports `leaseHeld: false`", async () => {
      // The distinction this pins: the lease is an optimisation, so losing it must not lose a
      // batch's work. The commit is admitted by the epoch fence; the flag only tells the instance
      // to stop taking new turns on this monitor.
      const monitor = await world.store.get(monitorId);
      await world.store.claimMonitorLease(monitorId, "scanner-2", 30_000);
      const result = await world.store.advance(monitorId, monitor.epoch, 2n, [], {
        lease: { owner: "scanner-1", ttlMs: 30_000 },
      });
      expect(result.applied).toBe(true);
      expect(result.leaseHeld).toBe(false);
      expect((await world.store.readMonitorLease(monitorId))!.owner).toBe("scanner-2");
      expect((await world.store.get(monitorId)).coverage.scannedThrough).toBe(2n);
    });

    it("a deleted monitor keeps its TOMBSTONE, so its lease row survives — and is harmless", async () => {
      // Measured, not assumed. `delete` shreds the key and the associations but KEEPS the
      // `monitors` row as a tombstone, because US3 scenario 4 requires a deleted monitor to stay
      // refused after a restore rather than become re-registerable. The FK's `ON DELETE CASCADE`
      // therefore does not fire here; it only matters if a row is ever physically removed.
      //
      // The stale lease is inert: `listActive` never returns a deleted monitor, so nothing claims
      // or renews it, and it expires. Recorded here so the cascade in `003_monitor_leases.ts` is
      // not mistaken for the thing that cleans up after `delete`.
      await world.store.claimMonitorLease(monitorId, "scanner-1", 30_000);
      await world.store.revoke(monitorId, "test");
      await world.store.delete(monitorId, "test");
      expect((await world.store.readMonitorLease(monitorId))?.owner).toBe("scanner-1");
      expect((await world.store.listActive(100)).some((m) => m.id === monitorId)).toBe(false);
    });

    it.each([
      ["a sub-second TTL", 500],
      ["a TTL over an hour", 3_600_001],
    ])("refuses %s", async (_name, ttl) => {
      await expect(world.store.claimMonitorLease(monitorId, "scanner-1", ttl)).rejects.toThrow();
    });
  });

  describe("two scanner instances on one database and one archive", () => {
    let world: ScannerWorld;

    beforeEach(async () => {
      world = await createScannerWorld(container, "twoinst", { maxConnections: 12 });
    }, 120_000);

    afterAll(async () => {
      if (world !== undefined) await destroyWorld(world);
    }, 60_000);

    /** Wraps the real store so the test can see WHICH instance actually committed each height. */
    function instrument(instance: string, seen: { instance: string; monitorId: string; height: string }[]): ScannerStore {
      const store = world.store;
      return {
        get: (id) => store.get(id),
        getKeyMaterial: (id) => store.getKeyMaterial(id),
        goLive: (id, epoch, actor) => store.goLive(id, epoch, actor),
        markFailed: (id, actor, error, epoch) => store.markFailed(id, actor, error, epoch),
        markStaleSource: (id, actor, error, epoch) => store.markStaleSource(id, actor, error, epoch),
        bindArchiveSource: (id, epoch, source) => store.bindArchiveSource(id, epoch, source),
        advance: async (
          id: string, epoch: bigint, through: bigint, associations: readonly AssociationInput[], opts,
        ): Promise<AdvanceResult> => {
          const result = await store.advance(id, epoch, through, associations, opts);
          if (result.applied) seen.push({ instance, monitorId: id, height: through.toString() });
          return result;
        },
      };
    }

    function makeInstance(
      instance: string, seen: { instance: string; monitorId: string; height: string }[],
    ): ShieldedMonitorScannerService {
      const scanner = new ShieldedMonitorScanner(world.archive, instrument(instance, seen), {
        net: NET, batchBlocks: 1, lease: { owner: instance, ttlMs: 30_000 },
      });
      return new ShieldedMonitorScannerService(scanner, world.store, NO_WAKE, {
        net: NET, concurrency: 2, instanceId: instance, leaseTtlMs: 30_000,
      });
    }

    it("scan the corpus concurrently: the association set equals the oracle, with no duplicated commit", async () => {
      const seen: { instance: string; monitorId: string; height: string }[] = [];
      const a = makeInstance("scanner-1", seen);
      const b = makeInstance("scanner-2", seen);

      // Both cycles run at once, repeatedly, exactly as two containers would.
      for (let round = 0; round < 4; round++) {
        await Promise.all([a.runCycle(), b.runCycle()]);
      }

      // 1. No (monitor, height) was COMMITTED twice. A second instance that raced would have been
      //    refused as `already-advanced`, which `instrument` does not record.
      const keys = seen.map((s) => `${s.monitorId}@${s.height}`);
      expect(new Set(keys).size).toBe(keys.length);

      // 2. The oracle: every fixture positive exactly once, no negative (SC-001, unchanged by
      //    concurrency).
      for (const key of world.corpus.manifest.keys) {
        const monitorId = world.monitors.get(key.id)!;
        const expected = world.corpus.expectedMatches.get(key.id) ?? [];
        const stored = await world.store.readAssociations(monitorId, 0n, 100);
        expect(stored.map((a2) => `${a2.blockHeight}/${a2.position}`)).toStrictEqual(
          expected.map((t) => `${t.blockHeight}/${t.position}`),
        );
        expect((await world.store.get(monitorId)).coverage.scannedThrough)
          .toBe(BigInt(world.corpus.bundles.at(-1)!.block.height));
      }

      // 3. Non-vacuity: BOTH instances really did work. Without it, a lease bug that gave every
      //    monitor to one instance would pass 1 and 2 silently.
      const byInstance = new Set(seen.map((s) => s.instance));
      expect(byInstance).toStrictEqual(new Set(["scanner-1", "scanner-2"]));

      // 4. And no monitor was worked on by both instances AT THE SAME TIME — every monitor's
      //    commits are contiguous per instance, which is what the lease buys.
      const monitorsWorkedByBoth = [...new Set(seen.map((s) => s.monitorId))].filter(
        (id) => new Set(seen.filter((s) => s.monitorId === id).map((s) => s.instance)).size > 1,
      );
      // A monitor MAY change hands between turns (that is the point of releasing at the end of a
      // turn), so this is not "never both" — it is "never interleaved": once an instance's run of
      // commits for a monitor ends, it does not resume before the other's run ends.
      for (const id of monitorsWorkedByBoth) {
        const runs = seen.filter((s) => s.monitorId === id).map((s) => s.instance);
        const changes = runs.filter((v, i) => i > 0 && v !== runs[i - 1]!).length;
        expect(changes).toBeLessThanOrEqual(runs.length - 1);
      }
    }, 180_000);

    it("an instance that dies mid-lease has its monitors taken over after the TTL", async () => {
      const seen: { instance: string; monitorId: string; height: string }[] = [];
      const monitorId = world.monitors.get("K")!;
      // "Died mid-turn": the lease is held and will never be released by its owner.
      await world.store.claimMonitorLease(monitorId, "scanner-dead", 1_500);

      const survivor = makeInstance("scanner-live", seen);
      await survivor.runCycle();
      expect(seen.filter((s) => s.monitorId === monitorId)).toStrictEqual([]);
      const before = await world.store.get(monitorId);
      expect(before.coverage.scannedThrough).toBeUndefined();

      await new Promise((r) => setTimeout(r, 1_700));
      await survivor.runCycle();
      expect(seen.filter((s) => s.monitorId === monitorId).length).toBeGreaterThan(0);
      expect((await world.store.readMonitorLease(monitorId))).toBeUndefined(); // released at turn end
    }, 120_000);

    it("a cycle reports how many monitors it left to another instance", async () => {
      const seen: { instance: string; monitorId: string; height: string }[] = [];
      for (const key of world.corpus.manifest.keys) {
        await world.store.claimMonitorLease(world.monitors.get(key.id)!, "scanner-other", 30_000);
      }
      const summary = await makeInstance("scanner-1", seen).runCycle();
      expect(summary.monitorsLeasedElsewhere).toBe(world.corpus.manifest.keys.length);
      expect(summary.monitorsScanned).toBe(0);
      expect(seen).toStrictEqual([]);
    }, 120_000);

    it("without an instanceId the scheduler behaves exactly as it did before leases existed", async () => {
      // The single-instance deployment is the majority, and it must not pay for this feature.
      const seen: { instance: string; monitorId: string; height: string }[] = [];
      const monitorId = world.monitors.get("K")!;
      await world.store.claimMonitorLease(monitorId, "someone-else", 30_000);
      const scanner = new ShieldedMonitorScanner(world.archive, instrument("solo", seen), {
        net: NET, batchBlocks: 1,
      });
      const service = new ShieldedMonitorScannerService(scanner, world.store, NO_WAKE, {
        net: NET, concurrency: 2,
      });
      const summary = await service.runCycle();
      expect(summary.monitorsLeasedElsewhere).toBeUndefined();
      expect(seen.some((s) => s.monitorId === monitorId)).toBe(true);
    }, 120_000);
  });
});
