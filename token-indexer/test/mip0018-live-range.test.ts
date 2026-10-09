/**
 * The recorded live range, checked in CI (CI uses recorded fixtures; development syncs live ranges).
 * `token-indexer/dev/live-range-check.ts` synced 714485–715183 live from Stagenet and scanned it, replayed the recorded
 * tape through the same programs, found every table identical, and stored the LIVE tables' digests in
 * `fixtures/live-range/stagenet-714485-715183.json`. This test replays the tape through the same sync service and
 * scanner (no network) and requires the same digest for every table of both schemas — archive and `mip0018` (blocks,
 * transactions, blobs, cursor, events, fields, withdrawals, listed events, mints, sightings, actions, activity,
 * built-in rows, scan cursor).
 *
 * Kill-and-resume is covered on fixtures by `[[archive.sync.resume-kill-identical]]`, `[[mip0018.scan.resume-identical]]`
 * and `[[mip0018.activity.kill-resume]]`.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, type TestDatabase } from "../../test/helpers/test-database.ts";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadManifest, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { compareTables, rangeTables, type RangeTables } from "../dev/range-tables.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";

const NET = "stagenet";
const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/live-range/stagenet-714485-715183.json", import.meta.url), "utf8")) as {
  format: string; genesisHash: string; range: { from: number; to: number };
  comparison: { identical: Record<string, boolean>; sha256: Record<string, string> }; liveTables: RangeTables;
};

describe("recorded live range = fixture replay", () => {
  let database: TestDatabase;
  let sql: UmbraDBSql;

  beforeAll(async () => {
    database = await openTestDatabase();
    sql = database.client("replay_mip");
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.stop();
  }, 60_000);

  it("[[mip0018.live-range.replay-equals-live]] replaying the recorded 714485–715183 tape through the sync service and the scanner gives, table by table, the digests of the recorded live Stagenet sync (every archive and mip0018 table; that live run = the replay); a changed row is caught", async () => {
    expect(RECORDED.format).toBe("umbradb-mip0018-live-range/1");
    expect(RECORDED.genesisHash).toBe(loadManifest().genesisHash);
    expect(RECORDED.comparison.identical).toEqual({ "liveUninterrupted=replay": true });
    expect(new Set(Object.values(RECORDED.comparison.sha256)).size).toBe(1);
    expect(Object.values(RECORDED.comparison.sha256)[0]).toBe(RECORDED.liveTables.sha256);
    expect(Object.keys(RECORDED.comparison.sha256).sort()).toEqual(["liveUninterrupted", "replay"]);
    expect(Object.keys(RECORDED.liveTables.tables)).toHaveLength(37);
    const { from, to } = RECORDED.range;

    const archive = "replay_archive";
    await bootstrapChainArchiveSchema(sql, archive);
    const f = await startFakeChain(loadRangeTape("idx"));
    try {
      const svc = new ChainArchiveSyncService({
        sql, net: NET, schema: archive, node: { url: f.nodeUrl }, indexer: { url: f.indexerUrl },
        startHeight: from, endHeight: to, concurrency: 4, backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
      });
      expect((await svc.syncOnce({ maxBlocks: 1_000 })).reachedEnd).toBe(true);
    } finally {
      await f.close();
    }
    // As the dev script ran it: scan-cli.ts --from <from> --to <to>, in batches.
    const scanner = new Mip0018Scanner({ sql, network: NET, schema: "replay_mip", archiveSchema: archive, fromHeight: from, toHeight: to });
    await scanner.bootstrap();
    for (;;) {
      const r = await scanner.scanOnce({ maxBlocks: 100 });
      if (r.scannedBlocks === 0 || r.reachedEnd) break;
    }

    const { digest } = await rangeTables(sql, archive, "replay_mip");
    expect(compareTables(digest, RECORDED.liveTables)).toEqual([]);
    expect(digest.sha256).toBe(RECORDED.liveTables.sha256);
    // Every table of both schemas was compared, including the token tables the scan writes.
    for (const t of ["archive.blocks", "archive.transactions", "archive.chain_blobs", "archive.watermarks", "mip0018.mip0018_events",
      "mip0018.mip0018_fields", "mip0018.mip0018_mints", "mip0018.mip0018_color_sightings", "mip0018.mip0018_contract_actions",
      "mip0018.mip0018_activity", "mip0018.mip0018_builtin_tokens", "mip0018.mip0018_scan", "mip0018.mip0018_listed_events"])
      expect(digest.tables[t]?.rows, t).toBeGreaterThan(0);
    expect(digest.tables["mip0018.mip0018_withdrawals"]?.rows).toBe(0); // C06 deletes one key at a time: never a whole withdrawal

    // Negative control: one changed field value is reported for exactly that table.
    await sql`UPDATE ${sql("replay_mip")}.mip0018_fields SET value = value || '\\x00'::bytea
      WHERE ctid = (SELECT ctid FROM ${sql("replay_mip")}.mip0018_fields WHERE val_type = 1 LIMIT 1)`;
    const changed = await rangeTables(sql, archive, "replay_mip");
    expect(compareTables(changed.digest, RECORDED.liveTables).map((d) => d.split(":")[0])).toEqual(["mip0018.mip0018_fields"]);
  }, 300_000);
});
