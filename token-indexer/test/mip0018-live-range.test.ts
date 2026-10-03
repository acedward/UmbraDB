/**
 * The recorded live range, checked in CI (project 00026, sub-plan D3; spec SC-003; owner Q11: CI uses recorded
 * fixtures, development syncs live ranges). `token-indexer/dev/live-range-check.ts` synced 714485–715183 live from
 * Stagenet (once uninterrupted, once killed with SIGKILL mid-range and resumed, archive and scan), replayed the D1 tape
 * through the same programs, found every table identical, and stored the LIVE tables' digests in
 * `fixtures/live-range/stagenet-714485-715183.json`. This test replays the D1 tape through the same sync service and
 * scanner (no network) and requires the same digest for every table of both schemas — archive and `mip0018` (blocks,
 * transactions, blobs, cursor, events, fields, mints, sightings, actions, activity, built-in rows, scan cursor).
 *
 * Sub-plan C4 changed column types (entry points and maintenance operations as `bytea`), so the range was synced live
 * once more with the changed code and the digests replaced by that run's (never regenerated from a replay). The
 * earlier recording is kept (`previousRecording`): its three runs were identical, its archive tables equal the new
 * live run's, and only the two tables whose columns C4 changed differ.
 *
 * What this file records and checks for the CURRENT schema is one uninterrupted live run = the replay. The killed-
 * and-resumed live run was repeated on the final code (`0061748`: sync SIGKILLed at 714800 and resumed, scan SIGKILLed
 * at cursor 714851 and resumed) and gave the same digest `550be4c5…19a1` for all 35 tables; that result is recorded in
 * the project's plan (00026 sub-plan D, assumption P03), not in this fixture. In CI, kill-and-resume is covered on
 * fixtures by `[[archive.sync.resume-kill-identical]]`, `[[mip0018.scan.resume-identical]]` and
 * `[[mip0018.activity.kill-resume]]` (final-audit N4: the test title claims only what is checked here).
 */
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadManifest, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { compareTables, rangeTables, type RangeTables } from "../dev/range-tables.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";

const NET = "stagenet";
const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/live-range/stagenet-714485-715183.json", import.meta.url), "utf8")) as {
  format: string; genesisHash: string; range: { from: number; to: number };
  comparison: { identical: Record<string, boolean>; sha256: Record<string, string> }; liveTables: RangeTables;
  previousRecording: { code: { commit: string }; comparison: { identical: Record<string, boolean>; sha256: Record<string, string> }; liveTables: RangeTables };
};

describe("recorded live range = fixture replay (00026 D3)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema: "replay_mip" });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("[[mip0018.live-range.replay-equals-live]] replaying the recorded 714485–715183 tape through the sync service and the scanner gives, table by table, the digests of the live Stagenet sync recorded with the current schema (every archive and mip0018 table; that live run = the replay); the earlier recording's live run, killed-and-resumed live run and replay were identical, and its archive tables equal the current ones; a changed row is caught", async () => {
    expect(RECORDED.format).toBe("umbradb-mip0018-live-range/1");
    expect(RECORDED.genesisHash).toBe(loadManifest().genesisHash);
    expect(RECORDED.comparison.identical).toEqual({ "liveUninterrupted=replay": true });
    expect(new Set(Object.values(RECORDED.comparison.sha256)).size).toBe(1);
    expect(Object.values(RECORDED.comparison.sha256)[0]).toBe(RECORDED.liveTables.sha256);
    // The earlier recording (code before sub-plan C4): live, killed-and-resumed live and replay were identical; two
    // independent live syncs agree on every archive table; only the tables whose columns C4 changed differ.
    const prev = RECORDED.previousRecording;
    expect(Object.values(prev.comparison.identical)).toEqual([true, true, true]);
    expect(new Set([...Object.values(prev.comparison.sha256), prev.liveTables.sha256]).size).toBe(1);
    expect(Object.keys(prev.liveTables.tables).sort()).toEqual(Object.keys(RECORDED.liveTables.tables).sort());
    expect(compareTables(prev.liveTables, RECORDED.liveTables).map((d) => d.split(":")[0]).sort())
      .toEqual(["mip0018.mip0018_activity", "mip0018.mip0018_contract_actions"]);
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
      "mip0018.mip0018_activity", "mip0018.mip0018_builtin_tokens", "mip0018.mip0018_scan"])
      expect(digest.tables[t]?.rows, t).toBeGreaterThan(0);

    // Negative control: one changed field value is reported for exactly that table.
    await sql`UPDATE ${sql("replay_mip")}.mip0018_fields SET value = value || '\\x00'::bytea
      WHERE ctid = (SELECT ctid FROM ${sql("replay_mip")}.mip0018_fields WHERE val_type = 1 LIMIT 1)`;
    const changed = await rangeTables(sql, archive, "replay_mip");
    expect(compareTables(changed.digest, RECORDED.liveTables).map((d) => d.split(":")[0])).toEqual(["mip0018.mip0018_fields"]);
  }, 300_000);
});
