import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { ledgerV8EntryPath } from "../../chain-archive-sync/tx-replay-decoder.js";
import { PgArchiveReadContract } from "../../src/postgres/archive-read-contract.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import type { ArchivedBlock } from "../../src/interfaces/archive-read-contract.js";
import { skipUnlessRequired } from "./required-services.js";

/**
 * The archive read contract against a REAL devnet archive (`spec/00009` User Story 7).
 *
 * The property suite (`test/postgres/archive-read-contract.property.test.ts`) proves the paging
 * laws over synthesised archives, where the test wrote every row and therefore knows exactly what
 * it should get back. This suite proves the same call against rows produced by the actual ingest
 * path from an actual chain -- real headers, real block bodies, real `Timestamp::set` inherents,
 * real transaction payloads and positions. The two failure classes are different: the property
 * suite catches a wrong paging law, this one catches a right law applied to a shape the fixtures
 * never produced.
 *
 * It is also the only place `blocks.timestamp_ms` is proven end to end: the property suite sets
 * the column itself, whereas here the value has to survive being decoded from a real body during
 * ingest and read back through the contract.
 *
 * Environment: `MIDNIGHT_TEST_NODE_URL` (the compose stack's node, or any 1.0.x devnet), matching
 * the sibling node-only suite. Skipped locally when no node answers; a hard failure under
 * `REQUIRE_LIVE_SERVICES=1`, where a silent skip would report success for a comparison that never
 * ran.
 */
const NODE_URL = process.env.MIDNIGHT_TEST_NODE_URL ?? "http://localhost:9944";
const NET = "archive_read_contract_devnet";
/** Enough blocks to cross several page boundaries with several page sizes, and to include the
 *  transaction-bearing genesis plus ordinary empty blocks. */
const BLOCKS = 60;

async function nodeIsUp(): Promise<boolean> {
  try {
    const res = await fetch(NODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system_chain", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await nodeIsUp();
const haveLedger = ledgerV8EntryPath() !== undefined;
const skip =
  skipUnlessRequired("a Midnight node", up, `Set MIDNIGHT_TEST_NODE_URL (tried ${NODE_URL}).`) ||
  skipUnlessRequired(
    "the ledger WASM", haveLedger,
    "The repo vendors one at vendor/ledger-v8-syshash; node-only ingest needs it to hash transactions.",
  );

describe.skipIf(skip)("the archive read contract over a real devnet archive", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: PgChainArchiveStore;
  let reader: PgArchiveReadContract;
  const schema = "chain_archive";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema, { net: NET });
    store = new PgChainArchiveStore(sql, schema);
    reader = new PgArchiveReadContract(sql, schema);

    // Node-only ingest, exactly as the production CLI runs it: no indexer, one bundle
    // transaction per height (owner Rule A), timestamps decoded from real bodies.
    const service = new ChainArchiveSyncService({ sql, net: NET, schema, node: { url: NODE_URL } });
    let ingested = 0;
    while (ingested < BLOCKS) {
      const result = await service.syncOnce({ maxBlocks: BLOCKS - ingested });
      if (result.ingestedBlocks === 0) break; // the devnet has not produced enough blocks yet
      ingested += result.ingestedBlocks;
    }
    expect(ingested, `the devnet must have produced at least ${BLOCKS} finalized blocks`)
      .toBeGreaterThanOrEqual(BLOCKS);
  }, 600_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  /** The oracle: the archive as the PRE-EXISTING read paths describe it. Same oracle the
   *  property suite uses, so a divergence here is about the DATA, not about the law. */
  async function oracleBlocks(): Promise<ArchivedBlock[]> {
    const metas = await store.getCanonicalChainRange(NET, 0, BLOCKS - 1);
    const out: ArchivedBlock[] = [];
    for (const meta of metas) {
      const txs = await store.getTransactionsForBlock(NET, meta.blockHash);
      out.push({
        net: NET, height: meta.height, hash: meta.blockHash, parentHash: meta.parentHash,
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

  function normalize(blocks: readonly ArchivedBlock[]): unknown {
    return blocks.map((b) => ({
      height: b.height, hash: b.hash, parentHash: b.parentHash, timestampMs: b.timestampMs,
      transactions: b.transactions.map((t) => ({
        txHash: t.txHash, position: t.position, kind: t.kind,
        protocolVersion: t.protocolVersion, result: t.result ?? undefined,
        rawBytes: Buffer.from(t.rawBytes).toString("hex"),
      })),
    }));
  }

  it("pages the first 60 real blocks identically at every page size, and identically to the pre-existing read paths", async () => {
    const oracle = await oracleBlocks();
    expect(oracle).toHaveLength(BLOCKS);

    for (const maxBlocks of [1, 7, 60, 500]) {
      const paged: ArchivedBlock[] = [];
      let afterHeight = -1;
      for (;;) {
        const page = await reader.readBlocksSince(NET, afterHeight, maxBlocks);
        if (page.blocks.length === 0) break;
        expect(page.blocks.length).toBeLessThanOrEqual(maxBlocks);
        paged.push(...page.blocks);
        afterHeight = page.blocks[page.blocks.length - 1]!.height;
        if (afterHeight >= BLOCKS - 1) break;
      }
      expect(normalize(paged.slice(0, BLOCKS)), `page size ${maxBlocks}`).toEqual(normalize(oracle));
    }
  }, 300_000);

  it("carries every real block's own decoded timestamp, ascending with height", async () => {
    // The end-to-end proof of migration 008 plus the ingest-side decode: the value is not written
    // by this test anywhere, it comes from the block body the node served.
    const page = await reader.readBlocksSince(NET, -1, BLOCKS);
    const timestamps = page.blocks.map((b) => b.timestampMs);
    expect(timestamps.every((t) => typeof t === "number")).toBe(true);
    // Milliseconds, not seconds: a unit error here shifts every block by decades and still
    // "works" (the same trap `runtime-metadata.test.ts` documents).
    expect(timestamps[0]!).toBeGreaterThan(1_600_000_000_000);
    expect(timestamps[0]!).toBeLessThan(4_000_000_000_000);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!, `height ${i} must not go back in time`)
        .toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  }, 120_000);

  it("reports the archive's identity, anchored on the chain's real genesis block", async () => {
    const identity = await reader.getArchiveIdentity(NET);
    expect(identity).toBeDefined();
    expect(identity!.net).toBe(NET);
    expect(identity!.archiveInstanceId).toMatch(/^[0-9a-f]{32}$/);
    const genesis = await store.getCanonicalBlockAtHeight(NET, 0);
    expect(identity!.genesisHash).toBe(genesis!.blockHash);
  }, 60_000);

  it("returns real transactions in position order with hash-verified bytes", async () => {
    // Genesis is the transaction-bearing block on this chain, so it is the one that exercises
    // per-block ordering against real data rather than against an empty list.
    const page = await reader.readBlocksSince(NET, -1, 1);
    const genesis = page.blocks[0]!;
    expect(genesis.height).toBe(0);
    expect(genesis.transactions.length).toBeGreaterThan(0);
    expect(genesis.transactions.map((t) => t.position))
      .toEqual(genesis.transactions.map((_, i) => i));
    for (const tx of genesis.transactions) {
      expect(tx.rawBytes.byteLength).toBeGreaterThan(0);
      expect(tx.protocolVersion).toBeGreaterThan(0);
      // Node-only ingest without replay validation records no outcome; `undefined` is the
      // honest answer and must not be reported as a value.
      expect(tx.result).toBeUndefined();
    }
  }, 120_000);

  it("advances the sync watermark to the tip it reports, in the same per-height transaction", async () => {
    const page = await reader.readBlocksSince(NET, BLOCKS - 1, 1);
    const watermark = await sql<{ height: string }[]>`
      SELECT value ->> 'height' AS height FROM ${sql(schema)}.watermarks
      WHERE kind = 'chain_archive' AND key = ${`sync_cursor:${NET}`}
    `;
    // Rule A in production terms: the archive's tip and its cursor cannot disagree, because they
    // were written together.
    expect(Number(watermark[0]!.height)).toBe(page.sourceTip!.height);
  }, 60_000);
});
