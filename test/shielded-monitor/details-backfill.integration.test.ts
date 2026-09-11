import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShieldedMonitorDetailsBackfill } from "../../shielded-monitor/details-backfill.js";
import { MATCH_DETAILS_VERSION } from "../../shielded-monitor/match-details.js";
import { LEDGER_BUILD_ID } from "../../shielded-monitor/offers.js";
import { ShieldedMonitorScanner } from "../../shielded-monitor/scanner.js";
import { createScannerWorld, destroyWorld, type ScannerWorld } from "./scanner-harness.js";

/**
 * The details backfill against a real archive and a real store (organizer sub-plan 00009-07).
 *
 * The world is the SAME one the scanner suite uses: real ledger bytes written by the archive's
 * own `putBlockBundle` and read back through the `ArchiveReadContract`. The pre-00009-07 state is
 * reproduced by scanning normally and then NULLing the two columns migration 002 added — which is
 * exactly what a database that was running before this change looks like, and is a stronger
 * starting point than hand-inserted rows, because every other column is then real.
 */

const NET = "undeployed";

describe("match-details backfill", () => {
  let container: StartedPostgreSqlContainer;
  let world: ScannerWorld;
  let scanner: ShieldedMonitorScanner;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    world = await createScannerWorld(container, "backfill");
    scanner = new ShieldedMonitorScanner(world.archive, world.store, { net: NET });
    for (const monitorId of world.monitors.values()) {
      await scanner.scanToTip(monitorId, { maxBatches: 64 });
    }
  }, 300_000);

  afterAll(async () => {
    if (world !== undefined) await destroyWorld(world);
    await container?.stop();
  });

  /** Puts the whole schema back into its pre-00009-07 shape. */
  async function clearAllDetails(): Promise<void> {
    await world.sql`
      UPDATE ${world.sql(world.monitorSchema)}.associations
         SET details = NULL, block_timestamp_ms = NULL
    `;
  }

  async function countMissing(): Promise<number> {
    const [row] = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${world.sql(world.monitorSchema)}.associations
       WHERE details IS NULL
    `;
    return row?.n ?? 0;
  }

  const backfill = (): ShieldedMonitorDetailsBackfill =>
    new ShieldedMonitorDetailsBackfill(world.archive, world.store, { net: NET, batchRows: 2 });

  it("[[shielded-monitor.backfill.fills-existing-matches-and-is-idempotent]] fills every pre-existing match exactly once, and a second run fills nothing", async () => {
    await clearAllDetails();
    const before = await countMissing();
    expect(before, "the world must hold matches, or this proves nothing").toBeGreaterThan(0);

    const first = await backfill().runAll();
    expect(first.filled).toBe(before);
    expect(first.examined).toBe(before);
    expect(first.refused).toBe(0);
    expect(first.fenced).toBe(0);
    expect(Object.values(first.skipped).every((n) => n === 0)).toBe(true);
    expect(await countMissing()).toBe(0);

    // Idempotent: nothing left to do, and nothing re-read that is already filled (the partial
    // index this walks is empty now).
    const second = await backfill().runAll();
    expect(second).toMatchObject({ examined: 0, filled: 0, refused: 0, fenced: 0 });
    expect(await countMissing()).toBe(0);
  }, 300_000);

  it("recomputes exactly what the scanner would have recorded at match time", async () => {
    // The real claim of a backfill: a filled row is indistinguishable from one recorded live.
    // Taken by comparing the two side by side, not by asserting a shape twice.
    const monitorId = world.monitors.get("K")!;
    const live = await world.store.readAssociations(monitorId, 0n, 1000);
    expect(live.every((a) => a.details !== undefined)).toBe(true);

    await clearAllDetails();
    await backfill().runAll();
    const filled = await world.store.readAssociations(monitorId, 0n, 1000);

    expect(filled.map((a) => a.seq)).toStrictEqual(live.map((a) => a.seq));
    for (const [index, row] of filled.entries()) {
      expect(row.details, `seq ${row.seq}`).toStrictEqual(live[index]!.details);
      expect(row.blockTimestampMs).toBe(live[index]!.blockTimestampMs);
      expect(row.details!.version).toBe(MATCH_DETAILS_VERSION);
      expect(row.details!.ledgerBuild).toBe(LEDGER_BUILD_ID);
      // Untouched: a backfill may not rewrite the match itself.
      expect(row.blockHeight).toBe(live[index]!.blockHeight);
      expect(row.position).toBe(live[index]!.position);
      expect([...row.matchedSegments]).toStrictEqual([...live[index]!.matchedSegments]);
      expect(row.appliedOutcome).toBe("unknown");
    }
  }, 300_000);

  it("carries the block time the ARCHIVE recorded, not a value of its own", async () => {
    await clearAllDetails();
    await backfill().runAll();
    const monitorId = world.monitors.get("K")!;
    for (const row of await world.store.readAssociations(monitorId, 0n, 1000)) {
      const page = await world.archive.readBlocksSince(NET, Number(row.blockHeight) - 1, 1);
      const block = page.blocks.find((b) => BigInt(b.height) === row.blockHeight)!;
      expect(row.blockTimestampMs).toBe(BigInt(block.timestampMs!));
    }
  }, 300_000);

  it("leaves a row alone when the archive no longer holds the block it names, and walks past it", async () => {
    await clearAllDetails();
    const monitorId = world.monitors.get("K")!;
    const rows = await world.store.readAssociations(monitorId, 0n, 1000);
    const victim = rows[0]!;
    // Rewrite the association's block hash so the archive's block at that height is no longer the
    // one it names — what a re-synced archive looks like from B's side. The row must be skipped,
    // NOT filled from a block that belongs to a different history.
    await world.sql`
      UPDATE ${world.sql(world.monitorSchema)}.associations
         SET block_hash = ${Buffer.alloc(32, 0xee)}
       WHERE monitor_id = ${monitorId} AND seq = ${victim.seq}
    `;

    const summary = await backfill().runMonitor(monitorId);
    expect(summary.skipped["block-hash-differs"]).toBe(1);
    // Every OTHER row of that monitor was still filled: one unfillable row does not stall the
    // walk, which is the reason the work list is paged by `seq` rather than always taken from the
    // head.
    expect(summary.filled).toBe(rows.length - 1);
    const after = await world.store.readAssociations(monitorId, 0n, 1000);
    expect(after.find((a) => a.seq === victim.seq)!.details).toBeUndefined();
    expect(after.filter((a) => a.seq !== victim.seq).every((a) => a.details !== undefined)).toBe(true);

    // Restore, so the suite's later cases see a consistent world.
    await world.sql`
      UPDATE ${world.sql(world.monitorSchema)}.associations
         SET block_hash = ${Buffer.from(victim.blockHash)}
       WHERE monitor_id = ${monitorId} AND seq = ${victim.seq}
    `;
    const repaired = await backfill().runMonitor(monitorId);
    expect(repaired.filled).toBe(1);
  }, 300_000);

  it("writes only to the shielded_monitor schema — it reads the archive and never touches it", async () => {
    // The Rule B claim for this new writer, taken the same way the scanner's is: by counting the
    // archive's rows across the run rather than by reading the code.
    await clearAllDetails();
    const archiveSignature = async (): Promise<string> => {
      const rows = await world.sql<{ t: string; n: number }[]>`
        SELECT relname AS t, n_live_tup::int AS n
          FROM pg_stat_user_tables WHERE schemaname = ${world.archiveSchema} ORDER BY relname
      `;
      return JSON.stringify(rows);
    };
    // `pg_stat_user_tables` is approximate, so the real check is a content hash of the archive's
    // own rows; the stat read is only here to make an accidental TRUNCATE obvious.
    const contentBefore = await world.sql<{ h: string }[]>`
      SELECT md5(string_agg(t.h, ',' ORDER BY t.h)) AS h
        FROM (
          SELECT md5(blocks::text) AS h FROM ${world.sql(world.archiveSchema)}.blocks
          UNION ALL
          SELECT md5(transactions::text) AS h FROM ${world.sql(world.archiveSchema)}.transactions
        ) AS t
    `;
    const statsBefore = await archiveSignature();

    await backfill().runAll();

    const contentAfter = await world.sql<{ h: string }[]>`
      SELECT md5(string_agg(t.h, ',' ORDER BY t.h)) AS h
        FROM (
          SELECT md5(blocks::text) AS h FROM ${world.sql(world.archiveSchema)}.blocks
          UNION ALL
          SELECT md5(transactions::text) AS h FROM ${world.sql(world.archiveSchema)}.transactions
        ) AS t
    `;
    expect(contentAfter[0]!.h).toBe(contentBefore[0]!.h);
    expect(contentBefore[0]!.h, "the archive must hold rows, or this hash proves nothing").not.toBeNull();
    expect(await archiveSignature()).toBe(statsBefore);
    // And it really did fill something in that same run.
    expect(await countMissing()).toBe(0);
  }, 300_000);

  it("refuses a closed monitor — before the run and mid-page — and keeps going with the rest", async () => {
    // Two refusal paths in one case, because what matters about both is the SAME thing: a closed
    // monitor is that monitor's answer, never the run's.
    //
    //   Kthird — revoked BEFORE the run starts, so `runMonitor` refuses at its first read.
    //   Kprime — revoked BETWEEN the page read and the key load, which is the narrow race the
    //            backfill has to survive. Injected through the store seam rather than by timing,
    //            so the case is deterministic.
    //
    // Monitors are visited in registration order (K, Kprime, Kthird), so `refused === 2` is what
    // proves the run CONTINUED past Kprime's mid-page refusal and still reached Kthird.
    await clearAllDetails();
    const racedId = world.monitors.get("Kprime")!;
    const preRevokedId = world.monitors.get("Kthird")!;
    await world.store.revoke(preRevokedId, "backfill-test");

    let raced = false;
    const racingStore = {
      listAll: (limit: number) => world.store.listAll(limit),
      get: (id: string) => world.store.get(id),
      readAssociationsMissingDetails: (id: string, afterSeq: bigint, limit: number) =>
        world.store.readAssociationsMissingDetails(id, afterSeq, limit),
      updateAssociationDetails: (id: string, epoch: bigint, updates: never) =>
        world.store.updateAssociationDetails(id, epoch, updates),
      getKeyMaterial: async (id: string) => {
        if (id === racedId && !raced) {
          raced = true;
          await world.store.revoke(id, "backfill-race");
        }
        return world.store.getKeyMaterial(id);
      },
    };
    const summary = await new ShieldedMonitorDetailsBackfill(
      world.archive, racingStore as never, { net: NET, batchRows: 2 },
    ).runAll();

    expect(raced, "the race was never triggered, so this case proves nothing").toBe(true);
    expect(summary.refused).toBe(2);

    // The healthy monitor was filled.
    const healthy = world.monitors.get("K")!;
    const rows = await world.store.readAssociations(healthy, 0n, 1000);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.details !== undefined)).toBe(true);

    // Neither refused monitor was left half-filled.
    for (const closed of [racedId, preRevokedId]) {
      const [row] = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${world.sql(world.monitorSchema)}.associations
         WHERE monitor_id = ${closed} AND details IS NOT NULL
      `;
      expect(row!.n).toBe(0);
    }
    // Both monitors STAY revoked: `revoked` is absorbing (US3 scenario 3) and the only way out is
    // `delete`. This case therefore runs last in the file, and nothing after it may assume the
    // whole schema is fillable.
  }, 300_000);
});
