import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import {
  ledgerSupportsSystemTransactionHash,
  ledgerV8EntryPath,
} from "../../chain-archive-sync/tx-replay-decoder.js";
import { skipUnlessRequired } from "./required-services.js";

/**
 * The node-only regression gate: ingest from a REAL Midnight node with no indexer involved, and
 * prove it.
 *
 * Why this file exists separately from `chain-archive-sync.integration.test.ts`: that suite
 * constructs an indexer-backed service, so a green run there says nothing about whether the
 * archive can be built without one. The headline claim of this branch had no test that could
 * fail if the indexer were secretly required -- an audit finding, and a fair one.
 *
 * What makes the proof real rather than asserted:
 *
 *   - the service is constructed with NO `indexer` option, so no IndexerClient exists;
 *   - `globalThis.fetch` is wrapped for the duration of the sync and every request URL recorded,
 *     then asserted to contain no indexer endpoint. A future refactor that reintroduced an
 *     indexer call would fail here even if it went around this module's own client;
 *   - the archived rows are checked for the properties the indexer used to supply -- ledger
 *     transaction hashes, raw payload bytes, kind, and contiguous positions -- so "it ran" is not
 *     mistaken for "it produced the right thing".
 *
 * Environment, matching the sibling suite's convention: `MIDNIGHT_TEST_NODE_URL`, defaulting to
 * the same local devnet. Skipped (never vacuously passed) when no node answers, and when the
 * ledger WASM is unavailable -- node-only ingest needs it to hash transactions.
 */
const NODE_URL = process.env.MIDNIGHT_TEST_NODE_URL ?? "http://localhost:9944";
const NET = "node_only_gate";
/** Anything that looks like an indexer endpoint. Deliberately broad: the point is to catch a
 *  request nobody intended, so a near-miss should still trip it. */
const INDEXER_SHAPED = /(:8088|:19088|\/api\/v\d+\/graphql|graphql)/i;

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
// The two outcomes below are SEPARATE required tests, gated on the capability rather than folded
// into one that accepts either. A single test that returns early on the refusal passes in both
// environments, so CI can be green having never exercised successful ingest -- which is exactly
// what an earlier version of this file did.
const haveSystemHash = haveLedger && (await ledgerSupportsSystemTransactionHash());

// Strict in CI, lenient locally -- see required-services.ts. The success path below is this
// branch's headline claim, so a CI run that skipped it would be asserting nothing.
const skip =
  skipUnlessRequired("a Midnight node", up, `Set MIDNIGHT_TEST_NODE_URL (tried ${NODE_URL}).`) ||
  skipUnlessRequired(
    "the ledger WASM", haveLedger,
    "The repo vendors one at vendor/ledger-v8-syshash; check that @midnight-ntwrk/ledger-v8 resolves.",
  ) ||
  skipUnlessRequired(
    "a ledger build exposing SystemTransaction.transactionHash()", haveSystemHash,
    "Without it the ingest path below cannot run at all.",
  );

describe.skipIf(skip)("node-only ingest against a real node (no indexer)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it.skipIf(!haveSystemHash)(
    "ingests from genesis including system transactions, with no indexer request",
    async () => {
      const schema = "node_only_gate";
      sql = createClient({ connectionString: container.getConnectionUri(), schema });
      await bootstrapChainArchiveSchema(sql, schema);

      const requested: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        requested.push(typeof input === "string" ? input : input.toString());
        return realFetch(input, init);
      }) as typeof fetch;

      let ingested = 0;
      try {
        const service = new ChainArchiveSyncService({
          sql, net: NET, schema, node: { url: NODE_URL, timeoutMs: 30_000 },
          replayValidation: true,
          ledgerNetworkId: "undeployed",
          replayCheckpointInterval: 1000,
        });
        ingested = (await service.syncOnce({ maxBlocks: 40 })).ingestedBlocks;
      } finally {
        globalThis.fetch = realFetch;
      }

      // The long-lived oracle node is required to have at least 40 finalized blocks in the final
      // gate. Requiring the exact requested count keeps a just-started node from turning this into
      // a genesis-only check while the test name and comment claim a multi-block replay.
      expect(ingested).toBe(40);
      const indexerCalls = requested.filter((u) => INDEXER_SHAPED.test(u));
      expect(indexerCalls, `unexpected indexer-shaped request(s): ${indexerCalls.join(", ")}`).toEqual([]);
      expect(requested.length).toBeGreaterThan(0);

      const txs = await sql<{ h: string; position: number; kind: string; hash_len: number }[]>`
        SELECT block_height::text AS h, position, kind, octet_length(tx_hash) AS hash_len
        FROM ${sql(schema)}.transactions WHERE net = ${NET} ORDER BY block_height, position
      `;
      // Genesis carries system transactions on every Midnight chain; archiving them is the point.
      expect(txs.some((t) => t.kind === "system")).toBe(true);
      for (const t of txs) expect(t.hash_len).toBe(32);
      // Positions contiguous from 0 across BOTH kinds -- the ordering the indexer uses.
      const byBlock = new Map<string, number[]>();
      for (const t of txs) byBlock.set(t.h, [...(byBlock.get(t.h) ?? []), t.position]);
      for (const [h, positions] of byBlock) {
        expect(positions, `positions in block ${h} must be contiguous from 0`).toEqual(
          positions.map((_, i) => i),
        );
      }

      // Replay validation now compares every post-block ledger state with the live node's custom
      // `midnight_ledgerStateRoot` at that historical hash. This 40-block run is the independent
      // success oracle for the synthetic mismatch fixture: it cannot pass by generating both
      // sides from the vendored WASM or by comparing the unrelated header state root.
    },
    180_000,
  );

  // The refusal counterpart of the test above -- "the ledger cannot hash a system transaction, so
  // ingest must refuse" -- deliberately does NOT live here any more.
  //
  // It was `it.skipIf(haveSystemHash)`, reached by the capability being ABSENT. Since the patched
  // ledger became the repo's own dependency, that condition can never hold from a fresh clone, so
  // the test could only ever skip: coverage that reports as present while never running. It now
  // lives in chain-archive-ledger-refusal.integration.test.ts, which CONSTRUCTS the condition by
  // pointing MIDNIGHT_LEDGER_WASM at the published 8.0.3, and therefore actually executes.

});
