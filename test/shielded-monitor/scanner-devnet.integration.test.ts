import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { ledgerV8EntryPath } from "../../chain-archive-sync/tx-replay-decoder.js";
import { PgArchiveReadContract } from "../../src/postgres/archive-read-contract.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapShieldedMonitorSchema } from "../../storage-api/bootstrap.js";
import { LEDGER_BUILD_ID, MATCHING_RULE_VERSION } from "../../shielded-monitor/offers.js";
import { ShieldedMonitorScanner } from "../../shielded-monitor/scanner.js";
import { InMemoryScannerMetrics } from "../../shielded-monitor/scanner-metrics.js";
import { PgShieldedMonitorStore } from "../../storage-api/monitor-store-pg.js";
import { encodeViewingKey, parseViewingKey } from "../../shielded-monitor/viewing-key.js";
import { skipUnlessRequired } from "../integration/required-services.js";
import { fixtureViewingKey } from "./helpers.js";

/**
 * The scanner against a REAL devnet archive.
 *
 * **What this proves, and what it deliberately does not.** The fixture suites scan
 * mock-proven transactions this repository synthesized; this one scans an archive produced by
 * the real ingest path from a real chain — real headers, real bodies, real transaction payloads
 * at real positions, a real genesis hash, a real tip. It therefore covers the failure class the
 * fixtures cannot: a correct rule applied to a shape the fixtures never produced.
 *
 * It does NOT prove a real shielded transfer is matched. That needs a wallet to build, prove
 * (against the proof server) and submit a transfer encrypted to the registered key, which needs
 * the Midnight wallet SDK this package does not depend on. That is organizer spec **SC-005** and
 * belongs to Phase 5; claiming it here by asserting something weaker would be worse than saying
 * so. What is asserted below is exactly what an idle devnet can support: real bytes, real
 * identity binding, real coverage to the real tip, real system transactions skipped on `kind`,
 * and zero false positives against a key nobody sent anything to.
 *
 * **`MIDNIGHT_TEST_NODE_URL` has NO default, on purpose.** The sibling archive suites default to
 * `http://localhost:9944`, and on this shared machine an UNRELATED project publishes a devnet
 * there (the master plan records the mis-binding). A suite that silently bound to a foreign
 * chain would produce evidence about somebody else's data. Point this at THIS project's own
 * Compose stack.
 */
const NODE_URL = process.env.MIDNIGHT_TEST_NODE_URL;
const NET = "shielded_monitor_devnet";
const ARCHIVE_SCHEMA = "chain_archive";
const MONITOR_SCHEMA = "shielded_monitor";
/** Enough real blocks to cross several batch boundaries and include the transaction-bearing
 *  genesis plus ordinary empty blocks. */
const BLOCKS = 40;

async function nodeIsUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
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

const up = NODE_URL !== undefined && NODE_URL !== "" && (await nodeIsUp(NODE_URL));
const skip =
  skipUnlessRequired(
    "a Midnight node", up,
    "Set MIDNIGHT_TEST_NODE_URL to THIS project's own compose stack (there is deliberately no " +
      "default: a shared machine may have a foreign devnet on the conventional port).",
  ) ||
  skipUnlessRequired(
    "the ledger WASM", ledgerV8EntryPath() !== undefined,
    "The repo vendors one at vendor/ledger-v8-syshash.",
  );

describe.skipIf(skip)("the relevance scanner over a real devnet archive", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: PgShieldedMonitorStore;
  let archive: PgArchiveReadContract;
  let monitorId: string;
  let tipHeight: number;
  let metrics: InMemoryScannerMetrics;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema: ARCHIVE_SCHEMA });
    await bootstrapChainArchiveSchema(sql, ARCHIVE_SCHEMA, { net: NET });
    await bootstrapShieldedMonitorSchema(sql, MONITOR_SCHEMA);

    // Node-only ingest, exactly as the production CLI runs it (owner Rule A per height).
    const service = new ChainArchiveSyncService({ sql, net: NET, schema: ARCHIVE_SCHEMA, node: { url: NODE_URL! } });
    let ingested = 0;
    while (ingested < BLOCKS) {
      const result = await service.syncOnce({ maxBlocks: BLOCKS - ingested });
      if (result.ingestedBlocks === 0) break;
      ingested += result.ingestedBlocks;
    }
    expect(ingested, "the devnet must have produced blocks to scan").toBeGreaterThan(0);
    tipHeight = ingested - 1;

    archive = new PgArchiveReadContract(sql, ARCHIVE_SCHEMA);
    store = new PgShieldedMonitorStore(sql, MONITOR_SCHEMA);
    const key = await fixtureViewingKey(21, NET);
    const monitor = await store.register({
      key: await parseViewingKey(
        encodeViewingKey(key.yesIKnowTheSecurityImplicationsOfThis_serialized(), NET), NET,
      ),
      net: NET,
      requestedStartHeight: 0n,
      matchingRuleVersion: MATCHING_RULE_VERSION,
      ledgerBuild: LEDGER_BUILD_ID,
      actor: "devnet-test",
    });
    monitorId = monitor.id;
    metrics = new InMemoryScannerMetrics();
  }, 600_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  it("scans the real archive to its real tip, binds the real archive identity, and goes live", async () => {
    const scanner = new ShieldedMonitorScanner(archive, store, { net: NET, batchBlocks: 7, metrics });
    const drained = await scanner.scanToTip(monitorId, { maxBatches: 64 });
    const rendered = JSON.stringify(drained.last, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(drained.last.kind, rendered).not.toBe("failed");
    expect(drained.last.kind).not.toBe("stale-source");

    const monitor = await store.get(monitorId);
    expect(monitor.coverage.scannedThrough).toBe(BigInt(tipHeight));
    expect(monitor.state).toBe("live");

    // The binding is the chain's OWN genesis hash and this archive's minted instance id.
    const identity = (await archive.getArchiveIdentity(NET))!;
    expect(monitor.sourceGenesisHash).toBe(identity.genesisHash);
    expect(monitor.sourceInstanceId).toBe(identity.archiveInstanceId);
    expect(identity.genesisHash).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.genesisHash).not.toBe("0".repeat(64));
  }, 600_000);

  it("produces no false positive against real chain bytes, and really did look at them", async () => {
    const associations = await store.readAssociations(monitorId, 0n, 1000);
    // Nobody sent this key anything: every association would be a false positive.
    expect(associations).toHaveLength(0);

    // ...and the scan was not vacuous. The archive genuinely holds transactions, and the
    // scanner genuinely paged every block of it.
    const [row] = await sql<{ n: number; system: number }[]>`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE kind = 'system')::int AS system
        FROM ${sql(ARCHIVE_SCHEMA)}.transactions WHERE net = ${NET}
    `;
    // Printed, because a live-gated suite's value depends on WHAT it found: a reader of the run
    // log needs the corpus shape to judge what the pass actually covered.
    // eslint-disable-next-line no-console
    console.log(
      `[devnet] scanned ${tipHeight + 1} real blocks; archive holds ${row!.n} transactions ` +
        `(${row!.system} system, ${row!.n - row!.system} regular); associations: 0`,
    );
    expect(row!.n, "a devnet archive with no transactions at all would prove nothing").toBeGreaterThan(0);
    expect(metrics.snapshot(NET).blocksScanned).toBe(tipHeight + 1);
    // Real system transactions were skipped on `kind` rather than handed to the standard codec
    // (which would have thrown and failed the monitor — the previous case asserts it did not).
    expect(row!.system).toBeGreaterThan(0);
    expect(metrics.snapshot(NET).transactionsScanned).toBe(row!.n - row!.system);
  }, 300_000);
});
