import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import {
  ledgerSupportsSystemTransactionHash,
} from "../../chain-archive-sync/tx-replay-decoder.js";

/**
 * THE acceptance gate for replacing the indexer with the node.
 *
 * The goal of that work is not a feature — it is that ingesting a range from the node produces
 * the SAME archive the indexer-sourced path produced. This asserts exactly that, and nothing
 * else: ingest one range twice into two schemas on one chain, then compare every persisted
 * transaction field in order.
 *
 * It exists because the parity result was previously established by hand — two databases and a
 * diff, run once. A manual measurement stops being true the moment anything changes, and every
 * remaining piece of this work (event-borne system transactions, signed extrinsic framings,
 * metadata-derived call indices) will change exactly this behaviour. This is what tells us if one
 * of them breaks it.
 *
 * Comparison is ORDERED and field-by-field, not a set difference: `position` is part of the
 * archive's contract, and two archives holding the same transactions in different order are not
 * interchangeable for anything that reads by position.
 *
 * Requires both a node and an indexer, so it can only run while the indexer still exists — which
 * is the point. Skipped, never vacuously passed, when either is absent.
 */
const NODE_URL = process.env.MIDNIGHT_TEST_NODE_URL ?? "http://localhost:9944";
const INDEXER_URL = process.env.MIDNIGHT_TEST_INDEXER_URL ?? "http://localhost:8088/api/v3/graphql";
const NET = "parity";
/** Small enough to keep the gate quick, large enough to include genesis, whose system
 *  transactions are the case that used to differ. */
const BLOCKS = Number(process.env.PARITY_BLOCKS ?? "60");

async function reachable(url: string, body: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const nodeUp = await reachable(
  NODE_URL,
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system_chain", params: [] }),
);
const indexerUp = await reachable(INDEXER_URL, JSON.stringify({ query: "{ block { height } }" }));
// Gate on the CAPABILITY, not on configuration. Without the system-transaction hash export the
// node path refuses by design, so parity is not merely unverified -- it is untestable. That must
// show as a SKIP. An earlier version of this file returned early and PASSED in that case, which
// would have let CI stay green while never once comparing the two sources.
const haveSystemHash = await ledgerSupportsSystemTransactionHash();

interface Row {
  height: string;
  position: number;
  tx_hash: string;
  kind: string;
  protocol_version: number;
  raw: string;
}

describe.skipIf(!nodeUp || !indexerUp || !haveSystemHash)(
  "archive parity: node-sourced ingest equals indexer-sourced ingest",
  () => {
    let container: StartedPostgreSqlContainer;
    let sql: UmbraDBSql;

    beforeAll(async () => {
      container = await new PostgreSqlContainer("postgres:17-alpine").start();
    }, 120_000);

    afterAll(async () => {
      await sql?.end({ timeout: 5 });
      await container?.stop();
    }, 60_000);

    it("produces byte-identical transaction sequences from either source", async () => {
      sql = createClient({ connectionString: container.getConnectionUri(), schema: "public" });

      const ingest = async (schema: string, useIndexer: boolean): Promise<void> => {
        await bootstrapChainArchiveSchema(sql, schema);
        const service = new ChainArchiveSyncService({
          sql,
          net: NET,
          schema,
          node: { url: NODE_URL, timeoutMs: 30_000 },
          ...(useIndexer ? { indexer: { url: INDEXER_URL, timeoutMs: 30_000 } } : {}),
        });
        await service.syncOnce({ maxBlocks: BLOCKS });
      };

      // No refusal branch here: this suite only runs where the capability exists (see the
      // describe gate), so a refusal is a genuine failure rather than an expected outcome.
      await ingest("parity_indexer", true);
      await ingest("parity_node", false);

      const read = async (schema: string): Promise<Row[]> =>
        sql<Row[]>`
          SELECT t.block_height::text AS height, t.position, encode(t.tx_hash,'hex') AS tx_hash,
                 t.kind, t.protocol_version, encode(b.data,'hex') AS raw
          FROM ${sql(schema)}.transactions t
          JOIN ${sql(schema)}.chain_blobs b ON b.hash = t.raw_blob_hash
          WHERE t.net = ${NET}
          ORDER BY t.block_height, t.position
        `;

      const fromIndexer = await read("parity_indexer");
      const fromNode = await read("parity_node");

      // A range with no transactions would make every assertion below vacuously true.
      expect(fromIndexer.length, "the compared range must contain transactions").toBeGreaterThan(0);
      // Genesis carries system transactions on every Midnight chain; if they are absent the range
      // is not exercising the case that used to differ.
      expect(
        fromIndexer.some((r) => r.kind === "system"),
        "the compared range must contain a system transaction",
      ).toBe(true);

      expect(fromNode.length, "row count").toBe(fromIndexer.length);
      // Ordered, field by field, with the offending row identified rather than a bare mismatch.
      for (let i = 0; i < fromIndexer.length; i++) {
        const a = fromIndexer[i]!;
        const b = fromNode[i]!;
        expect(b, `row ${i} (height ${a.height}, position ${a.position})`).toEqual(a);
      }
    }, 600_000);
  },
);
