import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillBlockTimestamps } from "../../chain-archive-sync/backfill-block-timestamps.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import type { BlockRecord } from "../../src/interfaces/chain-archive-store.js";

/**
 * Backfilling `blocks.timestamp_ms` (migration 008) for blocks archived before the column existed.
 *
 * The point of the backfill is that it is OFFLINE: it re-decodes the block's own archived body
 * against the archive's own runtime-metadata capture, with no node and no indexer. That property
 * is what makes it usable at all, because runtime metadata derives from historical state and the
 * archives most likely to hold pre-008 rows are precisely the ones whose source node has pruned
 * it. So this suite writes blocks the way the sync writer does, deliberately WITHOUT a timestamp,
 * and then runs the backfill against nothing but the database.
 *
 * The fixtures are real: the committed 1.0.0 runtime metadata
 * (`test/fixtures/runtime-metadata/`) and a real `Timestamp::set` inherent whose decoded value is
 * already pinned by `test/chain-archive-sync/runtime-metadata.test.ts`. A hand-built inherent
 * could drift into being merely plausible; this one is checked by two suites against the same
 * expected millisecond value.
 */
describe("backfillBlockTimestamps", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: PgChainArchiveStore;
  const schema = "backfill_timestamps_test";

  /** The real genesis `Timestamp::set` inherent a 1.0.0 devnet emits, and its decoded value --
   *  pinned identically in `runtime-metadata.test.ts`. */
  const TIMESTAMP_INHERENT = "0x280501000b004a1a7a9801";
  const TIMESTAMP_MS = 1_754_395_200_000;
  /** A second real inherent, from height 45 of the same devnet -- a different, later time. */
  const LATER_INHERENT = "0x280501000be07b93d89f01";

  const METADATA = new Uint8Array(readFileSync(
    new URL("../fixtures/runtime-metadata/midnight-node-1.0.0-protocol-1000000.scale", import.meta.url),
  ));

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
    store = new PgChainArchiveStore(sql, schema);
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  const hex = (seed: number, tag = 0): string =>
    (tag.toString(16).padStart(4, "0") + seed.toString(16).padStart(8, "0")).padStart(64, "0");

  /** `sync-service.ts` archives the header and body as stable-stringified JSON. Reproduced here
   *  rather than imported, because the backfill's whole job is to read THAT format back, and a
   *  test that shared the encoder with the decoder would not notice the two drifting apart. */
  function headerBlob(digestLogs: string[], parentHash: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
      digest: { logs: digestLogs },
      extrinsicsRoot: `0x${hex(2)}`,
      number: "0x0",
      parentHash: `0x${parentHash}`,
      stateRoot: `0x${hex(1)}`,
    }));
  }
  function bodyBlob(extrinsics: string[]): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(extrinsics));
  }

  /** The MNSV consensus digest item for protocol version 1_000_000, exactly as a real 1.0.0
   *  header carries it. */
  const MNSV_DIGEST_1_0_0 = "0x044d4e53561040420f00";

  async function archiveBlock(
    net: string, height: number, parentHash: string,
    opts: { extrinsics: string[]; digestLogs?: string[]; timestampMs?: number },
  ): Promise<string> {
    const blockHash = hex(height, 0xbb);
    const block: BlockRecord = {
      net, blockHash, height, parentHash,
      stateRoot: hex(1), extrinsicsRoot: hex(2),
      headerBytes: headerBlob(opts.digestLogs ?? [MNSV_DIGEST_1_0_0], parentHash),
      bodyBytes: bodyBlob(opts.extrinsics),
      isCanonical: true, status: "canonical", finalized: true,
      ...(opts.timestampMs === undefined ? {} : { timestampMs: opts.timestampMs }),
    };
    await store.putBlockBundle({ block, transactions: [], bridgeObservations: [] });
    return blockHash;
  }

  async function storedTimestamp(net: string, height: number): Promise<number | null> {
    const [row] = await sql<{ ts: string | null }[]>`
      SELECT timestamp_ms::text AS ts FROM ${sql(schema)}.blocks
      WHERE net = ${net} AND height = ${height}
    `;
    return row?.ts == null ? null : Number(row.ts);
  }

  it("fills a pre-008 block's timestamp from the archive alone, and is a no-op on a re-run", async () => {
    const net = "backfill_ok";
    await store.putRuntimeMetadata({
      net, specName: "midnight", specVersion: 1_000_000, firstSeenHeight: 0,
      metadataBytes: METADATA,
    });
    await archiveBlock(net, 0, hex(0), { extrinsics: [TIMESTAMP_INHERENT] });
    await archiveBlock(net, 1, hex(0, 0xbb), { extrinsics: [LATER_INHERENT] });
    expect(await storedTimestamp(net, 0)).toBeNull();

    const first = await backfillBlockTimestamps(sql, { net, schema });
    expect(first.scanned).toBe(2);
    expect(first.decoded).toBe(2);
    expect(first.updated).toBe(2);
    expect(first.unresolved).toEqual([]);
    expect(await storedTimestamp(net, 0)).toBe(TIMESTAMP_MS);
    // The second block's inherent is a DIFFERENT real time: a backfill that wrote one constant
    // for every block, or reused the first decode, would pass a single-block test.
    const second = await storedTimestamp(net, 1);
    expect(second).not.toBe(TIMESTAMP_MS);
    expect(second!).toBeGreaterThan(1_600_000_000_000);

    const rerun = await backfillBlockTimestamps(sql, { net, schema });
    expect({ scanned: rerun.scanned, updated: rerun.updated }).toEqual({ scanned: 0, updated: 0 });
    expect(await storedTimestamp(net, 0)).toBe(TIMESTAMP_MS);
  }, 120_000);

  it("never overwrites a timestamp the ingest path already wrote", async () => {
    const net = "backfill_no_overwrite";
    await store.putRuntimeMetadata({
      net, specName: "midnight", specVersion: 1_000_000, firstSeenHeight: 0,
      metadataBytes: METADATA,
    });
    // Archived WITH a timestamp that disagrees with what the body decodes to. The backfill must
    // not "correct" it: the ingest path saw the block live, and a backfill quietly rewriting
    // committed rows is a far worse failure than a stale one.
    await archiveBlock(net, 0, hex(0), { extrinsics: [TIMESTAMP_INHERENT], timestampMs: 1 });
    const result = await backfillBlockTimestamps(sql, { net, schema });
    expect(result.scanned).toBe(0);
    expect(await storedTimestamp(net, 0)).toBe(1);
  }, 120_000);

  it("reports a block it cannot decode instead of guessing, and keeps going", async () => {
    const net = "backfill_unresolved";
    await store.putRuntimeMetadata({
      net, specName: "midnight", specVersion: 1_000_000, firstSeenHeight: 0,
      metadataBytes: METADATA,
    });
    // Height 0: a block with no Timestamp::set inherent at all. Height 1: a decodable one, AFTER
    // it, so the run is proven to continue past the failure rather than stopping at it.
    await archiveBlock(net, 0, hex(0), { extrinsics: [] });
    await archiveBlock(net, 1, hex(0, 0xbb), { extrinsics: [TIMESTAMP_INHERENT] });

    const result = await backfillBlockTimestamps(sql, { net, schema });
    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.height).toBe(0);
    expect(await storedTimestamp(net, 0)).toBeNull();
    expect(await storedTimestamp(net, 1)).toBe(TIMESTAMP_MS);
  }, 120_000);

  it("falls back to the committed capture registry when the archive has no metadata of its own", async () => {
    // An archive that never captured runtime metadata (e.g. one built by indexer-sourced ingest,
    // which resolves none) can still be backfilled: the header's MNSV protocol version selects a
    // committed capture. This is the same last-resort path `BlockScopedMetadata` uses, and the
    // reason the backfill reads the header blob at all.
    const net = "backfill_registry";
    await archiveBlock(net, 0, hex(0), { extrinsics: [TIMESTAMP_INHERENT] });
    const result = await backfillBlockTimestamps(sql, { net, schema });
    expect(result.unresolved).toEqual([]);
    expect(await storedTimestamp(net, 0)).toBe(TIMESTAMP_MS);
  }, 120_000);

  it("reports rather than guesses when neither an archived capture nor the registry applies", async () => {
    // No archived metadata AND a header with no MNSV digest: nothing selects a capture, and
    // trying one anyway would decode the body against a layout that is not its own.
    const net = "backfill_no_capture";
    await archiveBlock(net, 0, hex(0), { extrinsics: [TIMESTAMP_INHERENT], digestLogs: [] });
    const result = await backfillBlockTimestamps(sql, { net, schema });
    expect(result.updated).toBe(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.reason).toMatch(/no MNSV protocol-version digest/);
    expect(await storedTimestamp(net, 0)).toBeNull();
  }, 120_000);

  it("dryRun decodes and reports without writing", async () => {
    const net = "backfill_dry";
    await archiveBlock(net, 0, hex(0), { extrinsics: [TIMESTAMP_INHERENT] });
    const result = await backfillBlockTimestamps(sql, { net, schema, dryRun: true });
    expect({ decoded: result.decoded, updated: result.updated }).toEqual({ decoded: 1, updated: 0 });
    expect(await storedTimestamp(net, 0)).toBeNull();
  }, 120_000);
});
