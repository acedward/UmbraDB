import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, type TestDatabase } from "../helpers/test-database.ts";
import { readTape, tapeCompressionOf } from "../../chain-archive-sync/archive-tape.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { createTapeFetch, type TapeFetch } from "../../chain-archive-sync/tape-replay.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { archiveDigest, dumpArchive } from "./fixtures/stagenet-archive/archive-digest.js";
import { fixturePath, loadManifest, loadRangeTape } from "./fixtures/stagenet-archive/stagenet-fixtures.js";

/**
 * The recorded Stagenet ranges replayed with no HTTP server at all: each tape is read with the runtime-neutral reader
 * (`DecompressionStream`, the code a browser runs) and answered by the `fetch`-shaped tape replay
 * (`chain-archive-sync/tape-replay.ts`), handed to the UNCHANGED `ChainArchiveSyncService` as its clients'
 * `fetchImpl`. The archive it writes into the file's database (Postgres 17 or PGlite, `test/helpers/test-database.ts`)
 * must have exactly the digest of the archive the LIVE polite sync of the same range wrote at capture time, and a sync
 * that follows a finalized tip rising with a clock must build the same archive.
 */

const NET = "stagenet";
/** The live sync's archive digests (`manifest.json` → `ranges[].liveSync.archiveDigest.sha256`). */
const LIVE_DIGEST = {
  idx: "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119",
  u1: "fa89d909911b0408fd7651ad58be68430b96e8d1cada804683d5206eaface959",
} as const;

describe("Stagenet tape replay through fetchImpl = live archive", () => {
  let database: TestDatabase;
  const sqls: UmbraDBSql[] = [];

  beforeAll(async () => {
    database = await openTestDatabase();
  }, 180_000);

  afterAll(async () => {
    for (const s of sqls) await s.end({ timeout: 5 });
    await database?.stop();
  }, 60_000);

  async function freshSchema(schema: string): Promise<UmbraDBSql> {
    const sql = database.client(schema);
    sqls.push(sql);
    await bootstrapChainArchiveSchema(sql, schema);
    return sql;
  }

  function service(sql: UmbraDBSql, schema: string, t: TapeFetch, range: { startHeight: number; endHeight?: number; concurrency?: number }): ChainArchiveSyncService {
    return new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: t.nodeUrl, fetchImpl: t.fetchImpl }, indexer: { url: t.indexerUrl, fetchImpl: t.fetchImpl },
      ...range,
      backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
    });
  }

  it("[[archive.tape-replay.fetch-equals-live]] replaying each recorded range through the fetch-shaped tape replay, with no HTTP server, reproduces the live sync's archive digest (IDX cb0d5e21…, U1 fa89d909…)", async () => {
    const manifest = loadManifest();
    expect(manifest.ranges.map((r) => r.name)).toEqual(["idx", "u1"]);
    for (const range of manifest.ranges) {
      expect(range.liveSync.archiveDigest.sha256, range.name).toBe(LIVE_DIGEST[range.name as keyof typeof LIVE_DIGEST]);
      // The runtime-neutral reader gives exactly the tape the Node reader (node:zlib) gives.
      const tape = await readTape(new Uint8Array(readFileSync(fixturePath(range.file))), tapeCompressionOf(range.file));
      expect(tape, range.name).toEqual(loadRangeTape(range.name));

      const t = createTapeFetch(tape);
      const schema = `fetch_replay_${range.name}`;
      const sql = await freshSchema(schema);
      const svc = service(sql, schema, t, { startHeight: range.from, endHeight: range.to, concurrency: range.liveSync.concurrency });
      let reachedEnd = false;
      for (let batch = 0; batch < 20 && !reachedEnd; batch++) {
        reachedEnd = (await svc.syncOnce({ maxBlocks: 100 })).reachedEnd;
      }
      expect(reachedEnd, range.name).toBe(true);
      expect(await svc.getSyncCursor()).toEqual({ height: range.to, startHeight: range.from });
      // Each height was fetched exactly once.
      expect(t.counts.get("chain_getBlock")).toBe(range.blocks);
      expect(t.counts.get("indexer.block")).toBe(range.blocks);

      const digest = archiveDigest(await dumpArchive(sql, schema));
      expect(digest.tables.blocks!.rows, range.name).toBe(range.blocks);
      expect(digest.tables.transactions!.rows, range.name).toBe(range.transactions);
      expect(digest, range.name).toEqual(range.liveSync.archiveDigest);
      expect(digest.sha256, range.name).toBe(LIVE_DIGEST[range.name as keyof typeof LIVE_DIGEST]);
    }

    // Negative control: the same replay with ONE transaction outcome changed (U1's publish at 715433 reported as
    // PARTIAL_SUCCESS) does not match the live digest, and only the transactions table differs.
    const u1 = manifest.ranges.find((r) => r.name === "u1")!;
    const tape = loadRangeTape("u1");
    const changed = structuredClone(tape.blocks.find((b) => b.height === 715433)!.indexerBlock);
    changed.transactions[0]!.transactionResult = { status: "PARTIAL_SUCCESS", segments: [{ id: 1, success: true }] };
    const t = createTapeFetch(tape, { indexerOverrides: new Map([[715433, changed]]) });
    const sql = await freshSchema("fetch_replay_u1_changed");
    expect((await service(sql, "fetch_replay_u1_changed", t, { startHeight: u1.from, endHeight: u1.to, concurrency: 4 }).syncOnce({ maxBlocks: 100 })).reachedEnd).toBe(true);
    const digest = archiveDigest(await dumpArchive(sql, "fetch_replay_u1_changed"));
    expect(digest.sha256).not.toBe(u1.liveSync.archiveDigest.sha256);
    expect(Object.keys(digest.tables).filter((k) => digest.tables[k]!.sha256 !== u1.liveSync.archiveDigest.tables[k]!.sha256)).toEqual(["transactions"]);
  }, 300_000);

  it("[[archive.tape-replay.follows-advancing-tip]] a sync with no end height follows a finalized tip that rises with a clock: each round ingests up to the tip of that moment, never past it, and the finished archive equals the live U1 archive", async () => {
    const u1 = loadManifest().ranges.find((r) => r.name === "u1")!;
    let clock = 0;
    const t = createTapeFetch(loadRangeTape("u1"), { finalizedHeight: u1.from + 3, advance: { everyMs: 1_000, by: 5 }, now: () => clock });
    const sql = await freshSchema("fetch_follow_u1");
    const svc = service(sql, "fetch_follow_u1", t, { startHeight: u1.from, concurrency: 4 });

    const rounds: { tip: number | undefined; from: number | undefined; to: number | undefined; ingested: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await svc.syncOnce({ maxBlocks: 100 });
      expect(r.reachedEnd).toBe(false); // no end height: a follower never ends
      expect(r.targetTipHeight).toBe(t.finalizedHeight());
      rounds.push({ tip: r.targetTipHeight, from: r.fromHeight, to: r.toHeight, ingested: r.ingestedBlocks });
      expect((await svc.getSyncCursor())?.height).toBe(r.targetTipHeight);
      if (r.targetTipHeight === u1.to && r.ingestedBlocks === 0) break;
      clock += 1_000;
    }
    // 715405 first, then 5 blocks per second of the clock, until the tape's last height; then nothing more.
    expect(rounds.map((r) => r.tip)).toEqual([715405, 715410, 715415, 715420, 715425, 715430, 715433, 715433]);
    expect(rounds.map((r) => r.ingested)).toEqual([4, 5, 5, 5, 5, 5, 3, 0]);
    expect(rounds[0]).toMatchObject({ from: u1.from, to: 715405 });
    expect(await svc.getSyncCursor()).toEqual({ height: u1.to, startHeight: u1.from });
    expect(archiveDigest(await dumpArchive(sql, "fetch_follow_u1"))).toEqual(u1.liveSync.archiveDigest);
  }, 300_000);
});
