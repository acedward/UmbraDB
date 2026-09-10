import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgArchiveReadContract } from "../../src/postgres/archive-read-contract.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import {
  ArchiveDiscontinuityError, type ArchivedBlock,
} from "../../src/interfaces/archive-read-contract.js";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import type { BlockRecord, TransactionRecord } from "../../src/interfaces/chain-archive-store.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";

/**
 * `PgArchiveReadContract` against real Postgres 17 (`spec/00009` User Story 7, FR-027/FR-028).
 *
 * The property under test is the one the spec's own independent test names: paging the read
 * contract must equal the concatenation of the pre-existing read paths -- `getCanonicalChainRange`
 * for the blocks, `getTransactionsForBlock` for each block's transactions -- for ANY page size,
 * over archives of any shape. That oracle is deliberately built from methods that already existed
 * and are already covered: it makes the new call a re-packaging of proven reads rather than a
 * second, independently-fallible source of truth.
 *
 * Archive shapes generated: empty blocks, blocks with several transactions, and DUPLICATE
 * transaction hashes at different positions (legal since migration 002 keyed transactions by
 * position -- and a case a hash-keyed implementation would silently collapse).
 */
describe("PgArchiveReadContract: whole-block paging equals the canonical read paths", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: PgChainArchiveStore;
  let reader: PgArchiveReadContract;
  const schema = "archive_read_contract_test";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
    store = new PgChainArchiveStore(sql, schema);
    reader = new PgArchiveReadContract(sql, schema);
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  const hex = (n: number, tag = 0): string =>
    (tag.toString(16).padStart(4, "0") + n.toString(16).padStart(8, "0")).padStart(64, "0");

  /** One archive, written through the REAL bundle path (so the rows are exactly what production
   *  ingest produces, including migration 008's timestamp column and the folded watermark). */
  async function writeArchive(
    net: string, shape: readonly { txHashes: readonly number[] }[],
  ): Promise<void> {
    let parentHash = hex(0, 0xffff);
    for (const [height, block] of shape.entries()) {
      const blockHash = hex(height, 0xbb);
      const transactions: TransactionRecord[] = block.txHashes.map((hashSeed, position) => ({
        net,
        txHash: hex(hashSeed, 0xcc),
        blockHeight: height,
        blockHash,
        position,
        kind: "regular" as const,
        protocolVersion: 1_000_000,
        // Distinct bytes per (block, position) so a mis-paired raw payload is detectable, and
        // hash-verified on read by the contract itself.
        rawBytes: new TextEncoder().encode(`${net}/${height}/${position}/${hashSeed}`),
      }));
      const record: BlockRecord = {
        net, blockHash, height, parentHash,
        stateRoot: hex(height, 0x11), extrinsicsRoot: hex(height, 0x22),
        headerBytes: new TextEncoder().encode(`header-${net}-${height}`),
        bodyBytes: new TextEncoder().encode(`body-${net}-${height}`),
        isCanonical: true, status: "canonical", finalized: true,
        timestampMs: 1_754_395_200_000 + height * 6_000,
      };
      await store.putBlockBundle({
        block: record,
        transactions,
        bridgeObservations: [],
        watermark: { key: `sync_cursor:${net}`, value: { height } },
      });
      parentHash = blockHash;
    }
  }

  /** The oracle: the archive as the PRE-EXISTING read paths describe it. */
  async function oracleBlocks(net: string, blockCount: number): Promise<ArchivedBlock[]> {
    const metas = await store.getCanonicalChainRange(net, 0, blockCount - 1);
    const out: ArchivedBlock[] = [];
    for (const meta of metas) {
      const txs = await store.getTransactionsForBlock(net, meta.blockHash);
      out.push({
        net, height: meta.height, hash: meta.blockHash, parentHash: meta.parentHash,
        timestampMs: meta.timestampMs,
        transactions: await Promise.all(txs.map(async (t) => ({
          txHash: t.txHash, position: t.position, kind: t.kind,
          protocolVersion: t.protocolVersion, result: t.result,
          rawBytes: await store.getBlob(t.rawBlobHash),
        }))),
      });
    }
    return out;
  }

  /** Page the whole archive with a fixed page size, exactly as a scanner would. */
  async function pageAll(
    net: string, maxBlocks: number,
  ): Promise<{ blocks: ArchivedBlock[]; pageSizes: number[] }> {
    const blocks: ArchivedBlock[] = [];
    const pageSizes: number[] = [];
    let afterHeight = -1;
    for (;;) {
      const page = await reader.readBlocksSince(net, afterHeight, maxBlocks);
      if (page.blocks.length === 0) break;
      pageSizes.push(page.blocks.length);
      blocks.push(...page.blocks);
      afterHeight = page.blocks[page.blocks.length - 1]!.height;
    }
    return { blocks, pageSizes };
  }

  function normalize(blocks: readonly ArchivedBlock[]): unknown {
    return blocks.map((b) => ({
      net: b.net, height: b.height, hash: b.hash, parentHash: b.parentHash,
      timestampMs: b.timestampMs,
      transactions: b.transactions.map((t) => ({
        txHash: t.txHash, position: t.position, kind: t.kind,
        protocolVersion: t.protocolVersion, result: t.result ?? undefined,
        rawBytes: Buffer.from(t.rawBytes).toString("hex"),
      })),
    }));
  }

  let netCounter = 0;

  it("P-ARC-1: for any archive shape and any page size, paging equals the canonical read paths, block by block", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Blocks whose transaction counts include 0 (empty blocks) and whose hash seeds are drawn
        // from a small pool, so duplicate tx hashes at different positions occur naturally.
        fc.array(fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 0, maxLength: 4 }),
          { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 4 }),
        async (shape, maxBlocks) => {
          const net = `p_arc_${netCounter++}`;
          await writeArchive(net, shape.map((txHashes) => ({ txHashes })));

          const { blocks, pageSizes } = await pageAll(net, maxBlocks);
          expect(normalize(blocks)).toEqual(normalize(await oracleBlocks(net, shape.length)));

          // No page splits a block: every returned block carries its FULL transaction set, and
          // no height appears in two pages. (The per-block equality above already proves the
          // first; this states it as its own assertion so a regression names the right thing.)
          for (const [index, block] of blocks.entries()) {
            expect(block.transactions.length).toBe(shape[index]!.length);
            expect(block.height).toBe(index);
          }
          // Page sizes respect the cap, and only the LAST page may be short.
          for (const [index, size] of pageSizes.entries()) {
            expect(size).toBeLessThanOrEqual(maxBlocks);
            if (index < pageSizes.length - 1) expect(size).toBe(maxBlocks);
          }
        },
      ),
      { numRuns: 12, endOnFailure: true },
    );
  }, 300_000);

  it("P-ARC-2: resuming from a remembered height after a restart continues without gap or repeat", async () => {
    const net = `p_arc_resume_${netCounter++}`;
    await writeArchive(net, [
      { txHashes: [1, 2] }, { txHashes: [] }, { txHashes: [3] }, { txHashes: [1, 1] },
      { txHashes: [] }, { txHashes: [2, 3, 1] },
    ]);
    const whole = await pageAll(net, 2);

    // Read three blocks, then throw the reader away and build a new one from a NEW client -- the
    // restart. The only thing carried across is the remembered height, which is the entire
    // contract: results must continue from there without gap or repeat.
    const first = await reader.readBlocksSince(net, -1, 3);
    const remembered = first.blocks[first.blocks.length - 1]!.height;
    const secondSql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      const restarted = new PgArchiveReadContract(secondSql, schema);
      const rest: ArchivedBlock[] = [];
      let afterHeight = remembered;
      for (;;) {
        const page = await restarted.readBlocksSince(net, afterHeight, 2);
        if (page.blocks.length === 0) break;
        rest.push(...page.blocks);
        afterHeight = page.blocks[page.blocks.length - 1]!.height;
      }
      expect(normalize([...first.blocks, ...rest])).toEqual(normalize(whole.blocks));
    } finally {
      await secondSql.end({ timeout: 5 });
    }
  }, 120_000);

  it("P-ARC-3: sourceTip names the archive's own tip, and a reader at the tip gets an empty page rather than a repeat", async () => {
    const net = `p_arc_tip_${netCounter++}`;
    await writeArchive(net, [{ txHashes: [1] }, { txHashes: [] }, { txHashes: [2, 2] }]);

    const page = await reader.readBlocksSince(net, -1, 10);
    expect(page.sourceTip).toEqual({ height: 2, hash: page.blocks[2]!.hash });

    const atTip = await reader.readBlocksSince(net, 2, 10);
    expect(atTip.blocks).toEqual([]);
    // The tip is still reported: "nothing new" and "nothing at all" must stay distinguishable,
    // which is what lets a consumer tell "scanned, empty" from "not scanned yet" (FR-011).
    expect(atTip.sourceTip).toEqual({ height: 2, hash: page.blocks[2]!.hash });

    // A start height ABOVE the tip is a legitimate query, not an error (a monitor may be
    // registered with a future start height).
    const beyond = await reader.readBlocksSince(net, 99, 10);
    expect(beyond.blocks).toEqual([]);
    expect(beyond.sourceTip?.height).toBe(2);
  }, 120_000);

  it("P-ARC-4: an unknown net yields an empty page and no tip, never an error", async () => {
    const page = await reader.readBlocksSince("net_that_was_never_synced", -1, 10);
    expect(page).toEqual({ blocks: [], sourceTip: undefined });
  }, 60_000);

  it("P-ARC-5: non-finalized and orphaned blocks are never returned", async () => {
    const net = `p_arc_visibility_${netCounter++}`;
    await writeArchive(net, [{ txHashes: [1] }, { txHashes: [2] }]);
    // A competing, non-finalized block at height 2, plus a seen-only block at height 3. Neither
    // is canonical+finalized, so neither may appear: a page that could be retracted later is
    // worse than one that lags.
    await store.putBlock({
      net, blockHash: hex(2, 0xee), height: 2, parentHash: hex(1, 0xbb),
      stateRoot: hex(2, 0x11), extrinsicsRoot: hex(2, 0x22),
      headerBytes: new TextEncoder().encode(`header-${net}-2-fork`),
      isCanonical: false, status: "seen", finalized: false,
    });
    const page = await reader.readBlocksSince(net, -1, 10);
    expect(page.blocks.map((b) => b.height)).toEqual([0, 1]);
    expect(page.sourceTip?.height).toBe(1);
  }, 120_000);

  it("P-ARC-6: a hole in canonical history is refused, not silently skipped", async () => {
    const net = `p_arc_hole_${netCounter++}`;
    await writeArchive(net, [{ txHashes: [1] }, { txHashes: [] }, { txHashes: [3] }]);
    // Delete the middle block out of band: a state the archive's own writer cannot produce (it
    // ingests watermark+1 under a parent-continuity check), and the state a reader must never
    // read as contiguous history. Heights 0 and 2 remain, both canonical and finalized, so
    // without the parent-linkage check the page would look like an ordinary two-block answer.
    await sql`DELETE FROM ${sql(schema)}.blocks WHERE net = ${net} AND height = 1`;
    await expect(reader.readBlocksSince(net, -1, 10)).rejects.toBeInstanceOf(ArchiveDiscontinuityError);
  }, 120_000);

  it("P-ARC-6b: consecutive heights whose parent link is broken are refused too", async () => {
    const net = `p_arc_splice_${netCounter++}`;
    await writeArchive(net, [{ txHashes: [1] }, { txHashes: [2] }]);
    // A third block at the next height that descends from something else entirely -- what
    // splicing a foreign chain onto an existing archive would look like. The heights ascend
    // without a gap, so ONLY the parent-hash comparison can catch it.
    await store.putBlockBundle({
      block: {
        net, blockHash: hex(2, 0xbb), height: 2, parentHash: hex(9999, 0xdd),
        stateRoot: hex(2, 0x11), extrinsicsRoot: hex(2, 0x22),
        headerBytes: new TextEncoder().encode(`header-${net}-2-spliced`),
        isCanonical: true, status: "canonical", finalized: true,
      },
      transactions: [], bridgeObservations: [],
    });
    await expect(reader.readBlocksSince(net, -1, 10)).rejects.toBeInstanceOf(ArchiveDiscontinuityError);
  }, 120_000);

  it("P-ARC-7: paging arguments are validated rather than clamped", async () => {
    await expect(reader.readBlocksSince("any", -1, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(reader.readBlocksSince("any", -2, 10)).rejects.toBeInstanceOf(ValidationError);
    await expect(reader.readBlocksSince("any", 1.5, 10)).rejects.toBeInstanceOf(ValidationError);
  }, 60_000);

  it("P-ARC-8: the archive identity is stable across reads and changes only when the archive is re-bootstrapped", async () => {
    const net = `p_arc_identity_${netCounter++}`;
    // Before anything is archived there is no identity to bind to -- deliberately, so a consumer
    // cannot bind to half of one.
    expect(await reader.getArchiveIdentity(net)).toBeUndefined();

    const minted = await store.ensureArchiveInstanceId(net);
    expect(minted).toMatch(/^[0-9a-f]{32}$/);
    // Still undefined: genesis is not archived yet, so the CHAIN half of the identity is unknown.
    expect(await reader.getArchiveIdentity(net)).toBeUndefined();

    await writeArchive(net, [{ txHashes: [1] }, { txHashes: [] }]);
    const identity = await reader.getArchiveIdentity(net);
    expect(identity).toEqual({ net, genesisHash: hex(0, 0xbb), archiveInstanceId: minted });

    // Idempotent: a second bootstrap of the same archive keeps the first id.
    expect(await store.ensureArchiveInstanceId(net)).toBe(minted);
    expect((await reader.getArchiveIdentity(net))?.archiveInstanceId).toBe(minted);

    // Re-bootstrap = a NEW archive database holding the same chain. Same net, same genesis,
    // different instance id -- exactly the signal a scanner needs to enter `stale_source`
    // instead of reading a lower tip as its own archive going backwards (FR-013, US7 §3).
    const freshSchema = `${schema}_rebootstrapped`;
    const freshSql = createClient({ connectionString: container.getConnectionUri(), schema: freshSchema });
    try {
      await runMigrations(freshSql, { schema: freshSchema, migrations: chainArchiveMigrations });
      const freshStore = new PgChainArchiveStore(freshSql, freshSchema);
      const freshId = await freshStore.ensureArchiveInstanceId(net);
      expect(freshId).not.toBe(minted);
    } finally {
      await freshSql.end({ timeout: 5 });
    }
  }, 180_000);

  it("P-ARC-9: a corrupted raw payload is refused on read rather than returned", async () => {
    const net = `p_arc_integrity_${netCounter++}`;
    await writeArchive(net, [{ txHashes: [7] }]);
    const [row] = await sql<{ raw_blob_hash: Buffer }[]>`
      SELECT raw_blob_hash FROM ${sql(schema)}.transactions WHERE net = ${net}
    `;
    await sql`
      UPDATE ${sql(schema)}.chain_blobs SET data = ${Buffer.from("tampered")}
      WHERE hash = ${row!.raw_blob_hash}
    `;
    await expect(reader.readBlocksSince(net, -1, 10)).rejects.toThrow(/content hash mismatch/);
  }, 120_000);
});
