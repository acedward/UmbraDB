import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, type TestDatabase } from "../helpers/test-database.ts";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { archiveDigest, dumpArchive } from "./fixtures/stagenet-archive/archive-digest.js";
import { startFakeChain } from "./fixtures/stagenet-archive/fake-chain-server.js";
import { loadManifest, loadRangeTape } from "./fixtures/stagenet-archive/stagenet-fixtures.js";

/**
 * CI's replay data source. Each recorded Stagenet range (the reference IDX scan 714485–715183 and
 * U1's 715402–715433) is served back over HTTP by `fake-chain-server.ts` and synced with the
 * UNCHANGED `ChainArchiveSyncService` into a fresh schema of the file's database (Postgres 17 or PGlite,
 * `test/helpers/test-database.ts`).
 * The archive it writes must have exactly the digest of the archive the LIVE polite sync of the
 * same range wrote at capture time (`manifest.json` → `ranges[].liveSync.archiveDigest`; every
 * table, every column but the wall-clock ones). No network.
 */

const NET = "stagenet";

describe("Stagenet fixture replay = live archive", () => {
  let database: TestDatabase;
  const sqls: UmbraDBSql[] = [];

  beforeAll(async () => {
    database = await openTestDatabase();
  }, 180_000);

  afterAll(async () => {
    for (const s of sqls) await s.end({ timeout: 5 });
    await database?.stop();
  }, 60_000);

  it("[[stagenet.fixtures.replay-equals-live]] replaying each recorded range through chain-archive-sync reproduces the live sync's archive digest", async () => {
    const manifest = loadManifest();
    expect(manifest.ranges.map((r) => r.name)).toEqual(["idx", "u1"]);
    for (const range of manifest.ranges) {
      const tape = loadRangeTape(range.name);
      const fake = await startFakeChain(tape);
      try {
        const schema = `replay_${range.name}`;
        const sql = database.client(schema);
        sqls.push(sql);
        await bootstrapChainArchiveSchema(sql, schema);
        const svc = new ChainArchiveSyncService({
          sql, net: NET, schema,
          node: { url: fake.nodeUrl }, indexer: { url: fake.indexerUrl },
          startHeight: range.from, endHeight: range.to, concurrency: range.liveSync.concurrency,
          backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
        });
        let reachedEnd = false;
        for (let batch = 0; batch < 20 && !reachedEnd; batch++) {
          reachedEnd = (await svc.syncOnce({ maxBlocks: 100 })).reachedEnd;
        }
        expect(reachedEnd, range.name).toBe(true);
        expect(await svc.getSyncCursor()).toEqual({ height: range.to, startHeight: range.from });
        // Each height was fetched exactly once: the tape needed no re-fetch.
        expect(fake.counts.get("chain_getBlock")).toBe(range.blocks);
        expect(fake.counts.get("indexer.block")).toBe(range.blocks);

        const digest = archiveDigest(await dumpArchive(sql, schema));
        expect(digest.tables.blocks!.rows, range.name).toBe(range.blocks);
        expect(digest.tables.transactions!.rows, range.name).toBe(range.transactions);
        expect(digest, range.name).toEqual(range.liveSync.archiveDigest);
      } finally {
        await fake.close();
      }
    }

    // Negative control: the same replay with ONE transaction outcome changed (U1's publish at
    // 715433 reported as PARTIAL_SUCCESS) does not match the live digest -- the comparison sees
    // a single stored field.
    const u1 = manifest.ranges.find((r) => r.name === "u1")!;
    const tape = loadRangeTape("u1");
    const changed = structuredClone(tape.blocks.find((b) => b.height === 715433)!.indexerBlock);
    changed.transactions[0]!.transactionResult = { status: "PARTIAL_SUCCESS", segments: [{ id: 1, success: true }] };
    const fake = await startFakeChain(tape, { indexerOverrides: new Map([[715433, changed]]) });
    try {
      const sql = database.client("replay_u1_changed");
      sqls.push(sql);
      await bootstrapChainArchiveSchema(sql, "replay_u1_changed");
      const svc = new ChainArchiveSyncService({
        sql, net: NET, schema: "replay_u1_changed",
        node: { url: fake.nodeUrl }, indexer: { url: fake.indexerUrl },
        startHeight: u1.from, endHeight: u1.to, concurrency: 4,
      });
      expect((await svc.syncOnce({ maxBlocks: 100 })).reachedEnd).toBe(true);
      const digest = archiveDigest(await dumpArchive(sql, "replay_u1_changed"));
      expect(digest.sha256).not.toBe(u1.liveSync.archiveDigest.sha256);
      const differing = Object.keys(digest.tables).filter((t) => digest.tables[t]!.sha256 !== u1.liveSync.archiveDigest.tables[t]!.sha256);
      expect(differing).toEqual(["transactions"]);
    } finally {
      await fake.close();
    }
  }, 300_000);
});
