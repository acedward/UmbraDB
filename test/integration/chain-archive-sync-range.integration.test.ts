import { spawn, type ChildProcess } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import type { IndexerBlock } from "../../chain-archive-sync/indexer-client.js";
import { ChainArchiveSyncService, mapTransactionResult, SyncRangeError } from "../../chain-archive-sync/sync-service.js";
import { loadTape, startFakeChain, type FakeChain } from "./fixtures/stagenet-archive/fake-chain-server.js";

/**
 * Project 00026, sub-plan A2 (spec FR-001, FR-002; US6): `--from/--to` ranges, the atomic per-block
 * checkpoint, kill-and-resume and the per-transaction outcomes -- against REAL Stagenet data
 * recorded once (`fixtures/stagenet-archive/c04-714637-714663.tape.json`, case C04 of the MIP-0018
 * reference: deploy, shielded mint, unshielded mint, ledger mint, publish) and served back over
 * HTTP by `fake-chain-server.ts`, into a real Postgres 17 (Testcontainers). No network.
 */

const NET = "stagenet";
const FROM = 714637;
const TO = 714663;
const tape = loadTape("c04-714637-714663.tape.json");

const hex = (b: Buffer | null): string | null => (b === null ? null : b.toString("hex"));

/** Every archive table, every column except the wall-clock ones (`synced_at`, `created_at`,
 *  `updated_at`), in primary-key order -- what "byte-identical tables" means for a resumed run. */
async function dumpArchive(sql: UmbraDBSql, schema: string): Promise<Record<string, unknown[]>> {
  const s = sql(schema);
  const blocks = await sql`
    SELECT net, block_hash, height::text AS height, parent_hash, state_root, extrinsics_root, author,
           header_blob_hash, body_blob_hash, is_canonical, status, finalized
    FROM ${s}.blocks ORDER BY net, height, block_hash`;
  const transactions = await sql`
    SELECT net, tx_hash, block_height::text AS block_height, block_hash, position, kind, protocol_version,
           result, segments, raw_blob_hash
    FROM ${s}.transactions ORDER BY net, block_height, block_hash, tx_hash`;
  const bridge = await sql`
    SELECT net, block_height::text AS block_height, block_hash, observation_index, kind, raw_blob_hash
    FROM ${s}.bridge_observations ORDER BY net, block_height, block_hash, observation_index`;
  const blobs = await sql`SELECT hash, data, size_bytes FROM ${s}.chain_blobs ORDER BY hash`;
  const roles = await sql`SELECT blob_hash, role FROM ${s}.chain_blob_roles ORDER BY blob_hash, role`;
  const watermarks = await sql`SELECT kind, key, value FROM ${s}.watermarks ORDER BY kind, key`;
  const vks = await sql`SELECT count(*)::int AS n FROM ${s}.verifier_key_observations`;
  const norm = (rows: readonly Record<string, unknown>[]): unknown[] => rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? hex(v) : v])));
  return {
    blocks: norm(blocks), transactions: norm(transactions), bridge_observations: norm(bridge),
    chain_blobs: norm(blobs), chain_blob_roles: norm(roles), watermarks: norm(watermarks), verifier_key_observations: norm(vks),
  };
}

describe("chain-archive-sync ranges, resume and transaction outcomes on recorded Stagenet (00026 A2)", () => {
  let container: StartedPostgreSqlContainer;
  const sqls: UmbraDBSql[] = [];
  const fakes: FakeChain[] = [];
  const children: ChildProcess[] = [];
  let schemaCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterEach(async () => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    for (const f of fakes.splice(0)) await f.close();
  });

  afterAll(async () => {
    for (const s of sqls) await s.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function freshSchema(prefix: string): Promise<{ sql: UmbraDBSql; schema: string }> {
    const schema = `${prefix}_${schemaCounter++}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    sqls.push(sql);
    await bootstrapChainArchiveSchema(sql, schema);
    return { sql, schema };
  }

  async function fake(opts?: Parameters<typeof startFakeChain>[1]): Promise<FakeChain> {
    const f = await startFakeChain(tape, opts);
    fakes.push(f);
    return f;
  }

  function service(sql: UmbraDBSql, schema: string, f: FakeChain, extra: Partial<ConstructorParameters<typeof ChainArchiveSyncService>[0]> = {}) {
    return new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: f.nodeUrl }, indexer: { url: f.indexerUrl },
      backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
      ...extra,
    });
  }

  it("[[archive.sync.range-from-to]] ingests exactly [--from, --to], records the archive start, and refuses a gap or a backfill", async () => {
    const f = await fake();
    const { sql, schema } = await freshSchema("range");
    const svc = service(sql, schema, f, { startHeight: 714640, endHeight: 714650, concurrency: 3 });

    const first = await svc.syncOnce({ maxBlocks: 100 });
    expect(first).toMatchObject({ ingestedBlocks: 11, fromHeight: 714640, toHeight: 714650, reachedEnd: true });
    const heights = await sql<{ height: string }[]>`SELECT height::text AS height FROM ${sql(schema)}.blocks ORDER BY height`;
    expect(heights.map((r) => Number(r.height))).toEqual(Array.from({ length: 11 }, (_, i) => 714640 + i));
    expect(await svc.getSyncCursor()).toEqual({ height: 714650, startHeight: 714640 });

    // Range complete: no further work and not a single further request to the endpoints.
    const before = [...f.counts.values()].reduce((a, b) => a + b, 0);
    expect(await svc.syncOnce({ maxBlocks: 100 })).toMatchObject({ ingestedBlocks: 0, reachedEnd: true });
    expect([...f.counts.values()].reduce((a, b) => a + b, 0)).toBe(before);

    // A --from that would leave a gap, or that lies below the archive's first height, is refused
    // before any network call; a --from inside the archived range resumes at the cursor.
    await expect(service(sql, schema, f, { startHeight: 714652 }).syncOnce()).rejects.toBeInstanceOf(SyncRangeError);
    await expect(service(sql, schema, f, { startHeight: 714639 }).syncOnce()).rejects.toBeInstanceOf(SyncRangeError);
    const resumed = await service(sql, schema, f, { startHeight: 714645, endHeight: 714655 }).syncOnce({ maxBlocks: 100 });
    expect(resumed).toMatchObject({ ingestedBlocks: 5, fromHeight: 714651, toHeight: 714655, reachedEnd: true });
    expect(() => service(sql, schema, f, { startHeight: 10, endHeight: 9 })).toThrow(SyncRangeError);
  }, 120_000);

  it("[[archive.sync.outcomes-equal-indexer]] stores every transaction's result and per-segment outcomes exactly as the indexer reports them (recorded SUCCESS + synthetic PARTIAL_SUCCESS/FAILURE)", async () => {
    // Real recorded bytes; synthetic outcomes injected on two of the five C04 transactions.
    const overrides = new Map<number, IndexerBlock>();
    const withResult = (height: number, transactionResult: { status: string; segments: { id: number; success: boolean }[] | null }) => {
      const block = structuredClone(tape.blocks.find((b) => b.height === height)!.indexerBlock);
      block.transactions[0]!.transactionResult = transactionResult;
      overrides.set(height, block);
    };
    withResult(714643, { status: "PARTIAL_SUCCESS", segments: [{ id: 2, success: false }, { id: 1, success: true }] });
    withResult(714649, { status: "FAILURE", segments: null });
    const f = await fake({ indexerOverrides: overrides });
    const { sql, schema } = await freshSchema("outcomes");
    const svc = service(sql, schema, f, { startHeight: FROM, endHeight: TO, concurrency: 4 });
    expect((await svc.syncOnce({ maxBlocks: 100 })).ingestedBlocks).toBe(TO - FROM + 1);

    let compared = 0;
    for (const b of tape.blocks) {
      const indexerBlock = overrides.get(b.height) ?? b.indexerBlock;
      const stored = await svc.store.getTransactionsForBlock(NET, b.blockHash.replace(/^0x/, ""));
      expect(stored.map((t) => t.txHash)).toEqual(indexerBlock.transactions.map((t) => t.hash));
      indexerBlock.transactions.forEach((t, i) => {
        const expected = t.transactionResult ?? null;
        expect(stored[i]!.result).toBe(mapTransactionResult(expected?.status));
        const expectedSegments = expected?.segments === null || expected?.segments === undefined
          ? undefined
          : [...expected.segments].sort((x, y) => x.id - y.id);
        expect(stored[i]!.segments).toEqual(expectedSegments);
        compared++;
      });
    }
    expect(compared).toBe(5);
    const statuses = await sql<{ result: string; n: number }[]>`
      SELECT result, count(*)::int AS n FROM ${sql(schema)}.transactions GROUP BY result ORDER BY result`;
    expect(statuses).toEqual([
      { result: "failure", n: 1 }, { result: "partial_success", n: 1 }, { result: "success", n: 3 },
    ]);
  }, 120_000);

  it("[[archive.sync.outcomes-guard]] an unknown status or a regular transaction without a result stops the sync at that block with nothing written for it", async () => {
    for (const bad of [
      { status: "SOMETHING_NEW", segments: null },
      null,
    ]) {
      const block = structuredClone(tape.blocks.find((b) => b.height === 714643)!.indexerBlock);
      block.transactions[0]!.transactionResult = bad;
      const f = await fake({ indexerOverrides: new Map([[714643, block]]) });
      const { sql, schema } = await freshSchema("guard");
      const svc = service(sql, schema, f, { startHeight: FROM, endHeight: TO });
      await expect(svc.syncOnce({ maxBlocks: 100 })).rejects.toThrow(bad === null ? /no transactionResult/ : /unknown indexer TransactionResultStatus/);
      expect(await svc.getSyncedHeight()).toBe(714642);
      const at = await sql`SELECT 1 FROM ${sql(schema)}.blocks WHERE height = 714643`;
      expect(at).toHaveLength(0);
    }
  }, 120_000);

  it("[[archive.sync.polite-retry]] throttling (429 with Retry-After, 403, 503, an HTML 200) is retried with back-off and the range still completes", async () => {
    const f = await fake({
      throttles: [
        { operation: "chain_getBlock", times: 2, status: 429, retryAfter: "0" },
        { operation: "indexer.block", times: 1, status: 403 },
        { operation: "chain_getBlockHash", times: 1, status: 503 },
        { operation: "indexer.tip", times: 1, status: 200, htmlBody: true },
      ],
    });
    const { sql, schema } = await freshSchema("retry");
    const waits: { op: string; status: number | undefined }[] = [];
    const svc = service(sql, schema, f, {
      startHeight: FROM, endHeight: FROM + 4, concurrency: 2,
      backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5, onRetry: (i) => waits.push({ op: i.operation, status: i.httpStatus }) },
    });
    const result = await svc.syncOnce({ maxBlocks: 100 });
    expect(result).toMatchObject({ ingestedBlocks: 5, reachedEnd: true, retries: 5, throttled: 3 });
    expect(waits.map((w) => w.status).sort()).toEqual([403, 429, 429, 503, undefined]);
  }, 120_000);

  it("[[archive.sync.resume-kill-identical]] SIGKILL during a CLI --from/--to run, then a restart, leaves tables identical to an uninterrupted run", async () => {
    const f = await fake({ delayMs: 30 });
    const killed = await freshSchema("resume_killed");
    const clean = await freshSchema("resume_clean");

    const runCli = (schema: string): ChildProcess => {
      const child = spawn(process.execPath, [
        "--import", "tsx", "chain-archive-sync/sync-cli.ts",
        "--from", String(FROM), "--to", String(TO), "--concurrency", "2", "--max-blocks", "4",
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env, ARCHIVE_PG: container.getConnectionUri(), ARCHIVE_SCHEMA: schema, NET,
          NODE_URL: f.nodeUrl, INDEXER_URL: f.indexerUrl, SYNC_BACKOFF_BASE_MS: "50", SYNC_BACKOFF_MAX_MS: "200",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    };
    const exitOf = (child: ChildProcess): Promise<number | null> =>
      new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const cursorOf = async (sql: UmbraDBSql, schema: string): Promise<number | undefined> => {
      const rows = await sql<{ value: { height: number } }[]>`
        SELECT value FROM ${sql(schema)}.watermarks WHERE kind = 'chain_archive' AND key = ${"sync_cursor:" + NET}`;
      return rows[0]?.value.height;
    };

    // 1. Start, wait until the cursor is part-way, SIGKILL (no shutdown path runs).
    const first = runCli(killed.schema);
    const firstExit = exitOf(first);
    const deadline = Date.now() + 90_000;
    let atKill: number | undefined;
    for (;;) {
      atKill = await cursorOf(killed.sql, killed.schema);
      if (atKill !== undefined && atKill >= FROM + 8) break;
      if (Date.now() > deadline) throw new Error("the CLI made no progress");
      await new Promise((r) => setTimeout(r, 25));
    }
    first.kill("SIGKILL");
    await firstExit;
    const afterKill = (await cursorOf(killed.sql, killed.schema))!;
    expect(afterKill).toBeLessThan(TO); // killed mid-range
    const archivedAfterKill = await killed.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${killed.sql(killed.schema)}.blocks`;
    expect(archivedAfterKill[0]!.n).toBe(afterKill - FROM + 1); // the checkpoint never runs ahead of or behind the data

    // 2. Restart with the same arguments: it resumes at cursor + 1 and exits 0 at --to.
    const second = runCli(killed.schema);
    expect(await exitOf(second)).toBe(0);
    // 3. An uninterrupted run of the same range into another schema.
    const third = runCli(clean.schema);
    expect(await exitOf(third)).toBe(0);

    const a = await dumpArchive(killed.sql, killed.schema);
    const b = await dumpArchive(clean.sql, clean.schema);
    expect(a.blocks).toHaveLength(TO - FROM + 1);
    expect(a.transactions).toHaveLength(5);
    expect(a).toEqual(b);
  }, 180_000);
});
