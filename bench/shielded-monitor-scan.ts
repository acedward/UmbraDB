import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { PgArchiveReadContract } from "../src/postgres/archive-read-contract.js";
import { PgChainArchiveStore } from "../src/postgres/chain-archive-store.js";
import { createClient } from "../src/postgres/client.js";
import { runMigrations } from "../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../src/postgres/migrations/chain_archive/index.js";
import { bootstrapShieldedMonitorSchema } from "../storage-api/bootstrap.js";
import { LEDGER_BUILD_ID, loadLedger, MATCHING_RULE_VERSION } from "../shielded-monitor/offers.js";
import { ShieldedMonitorScanner } from "../shielded-monitor/scanner.js";
import { InMemoryScannerMetrics } from "../shielded-monitor/scanner-metrics.js";
import { ShieldedMonitorScannerService } from "../shielded-monitor/scanner-service.js";
import { pgListenWake } from "../storage-api/pg-wake.js";
import { PgShieldedMonitorStore } from "../storage-api/monitor-store-pg.js";
import { encodeViewingKey, parseViewingKey } from "../shielded-monitor/viewing-key.js";
import { buildCorpus } from "../test/fixtures/shielded-monitor/build-corpus.js";
import { POSTGRES_IMAGE } from "./environment.js";

/* eslint-disable no-console */

/**
 * SC-006's first measurement: relevance-scanning throughput at 1, 10 and 50 registered keys.
 *
 * **What is and is not measured, stated before the numbers so nobody over-reads them.**
 *
 * MEASURED: the whole production scan path — `readBlocksSince` through the archive read
 * contract, `EncryptionSecretKey.deserialize` once per batch per monitor, the ledger's real
 * `test(offer)` trial decryption over every transaction's guaranteed offer and every fallible
 * segment, and the fenced `advance` commit — against a real PostgreSQL 17 and real archived
 * ledger bytes.
 *
 * NOT MEASURED: a real chain's transaction mix. The corpus is synthesized (the plan explicitly
 * permits "a synthesized archive of a few thousand transactions"), so the offers are small and
 * uniform. A devnet or testnet corpus would have larger offers and more of them per transaction,
 * so **treat these figures as an upper bound on tx/s for this shape, not a prediction for
 * mainnet**. SC-006 says the plan sets a threshold once a first measurement exists; this is that
 * measurement, and the threshold is a separate decision.
 *
 * **Work is capped per measurement, and the table says by how much.** Scanning 2 000 archived
 * transactions with 50 keys is 100 000 trial decryptions, which is tens of minutes — most of it
 * re-deserializing the same transaction once per monitor. `BENCH_SCAN_MAX_EVALS` bounds each
 * row's work by scanning a PREFIX of the archive for the larger key counts; the row reports the
 * blocks and transactions it actually scanned, and the reported figure is a RATE, which is what
 * SC-006 asks for. Nothing is extrapolated.
 *
 * Run: `npx tsx bench/shielded-monitor-scan.ts` (Docker required).
 * Env: `BENCH_SCAN_BLOCKS` (default 500), `BENCH_SCAN_TX_PER_BLOCK` (default 4),
 *      `BENCH_SCAN_KEYS` (default "1,10,50"), `BENCH_SCAN_BATCH_BLOCKS` (default 16),
 *      `BENCH_SCAN_MAX_EVALS` (default 40000).
 */

const NET = "bench_scan";
const ARCHIVE_SCHEMA = "bench_chain_archive";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a whole number >= 1`);
  return value;
}

interface KeyResult {
  keys: number;
  blocks: number;
  transactions: number;
  /** Transactions scanned per second, summed across monitors (the process's total work rate). */
  aggregateTxPerSecond: number;
  /** Transactions per second PER KEY — the SC-006 figure. */
  txPerSecondPerKey: number;
  matches: number;
  wallMs: number;
  rssMb: number;
  peakRssMb: number;
}

async function main(): Promise<void> {
  const blocks = envInt("BENCH_SCAN_BLOCKS", 500);
  const txPerBlock = envInt("BENCH_SCAN_TX_PER_BLOCK", 4);
  const maxEvals = envInt("BENCH_SCAN_MAX_EVALS", 40_000);
  const batchBlocks = envInt("BENCH_SCAN_BATCH_BLOCKS", 16);
  const keyCounts = (process.env.BENCH_SCAN_KEYS ?? "1,10,50").split(",").map((s) => Number(s.trim()));

  console.log(
    `[bench] corpus: ${blocks} blocks x ${txPerBlock} transactions = ${blocks * txPerBlock} archived ` +
      `transactions; batchBlocks=${batchBlocks}; keys=${keyCounts.join(",")}`,
  );

  const corpus = await buildCorpus();
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCommand([
      "postgres",
      "-c", "shared_buffers=256MB", "-c", "work_mem=16MB", "-c", "max_wal_size=2GB",
      "-c", "max_parallel_workers_per_gather=0",
    ])
    .start();

  const results: KeyResult[] = [];
  try {
    const sql = createClient({
      connectionString: container.getConnectionUri(), schema: ARCHIVE_SCHEMA, maxConnections: 16,
    });
    await runMigrations(sql, { schema: ARCHIVE_SCHEMA, migrations: chainArchiveMigrations });
    const archiveStore = new PgChainArchiveStore(sql, ARCHIVE_SCHEMA);
    await archiveStore.ensureArchiveInstanceId(NET);

    // ── Archive the corpus once; every key count scans the SAME bytes ───────────────────────
    const seedTx = corpus.transactions.filter((t) => t.spec.shape === "standard");
    const archiveStart = Date.now();
    for (let height = 0; height < blocks; height++) {
      const blockHash = benchHash("block", height);
      await archiveStore.putBlockBundle({
        block: {
          net: NET, blockHash, height,
          parentHash: height === 0 ? "0".repeat(64) : benchHash("block", height - 1),
          stateRoot: benchHash("state", height), extrinsicsRoot: benchHash("ext", height),
          headerBytes: new TextEncoder().encode(`bench-header/${height}`),
          isCanonical: true, status: "canonical", finalized: true,
          timestampMs: 1_754_395_200_000 + height * 6_000,
        },
        transactions: Array.from({ length: txPerBlock }, (_, position) => ({
          net: NET, txHash: benchHash(`tx/${position}`, height), blockHeight: height, blockHash,
          position, kind: "regular" as const, protocolVersion: corpus.manifest.protocolVersion,
          rawBytes: seedTx[(height * txPerBlock + position) % seedTx.length]!.rawBytes,
        })),
        bridgeObservations: [],
        watermark: { key: `sync_cursor:${NET}`, value: { height } },
      });
    }
    console.log(`[bench] archived ${blocks * txPerBlock} transactions in ${Date.now() - archiveStart} ms`);

    const archive = new PgArchiveReadContract(sql, ARCHIVE_SCHEMA);
    let peakRssMb = 0;
    const sampleRss = setInterval(() => {
      peakRssMb = Math.max(peakRssMb, process.memoryUsage.rss() / 1024 / 1024);
    }, 100);
    sampleRss.unref?.();

    for (const keys of keyCounts) {
      // A fresh monitor schema per key count, so each measurement starts from zero coverage and
      // an empty association table rather than inheriting the previous run's rows.
      const monitorSchema = `bench_monitor_${keys}`;
      await bootstrapShieldedMonitorSchema(sql, monitorSchema);
      const store = new PgShieldedMonitorStore(sql, monitorSchema);
      for (let i = 0; i < keys; i++) {
        // Distinct REAL keys, one per monitor, so each monitor does a genuine trial decryption
        // that mostly FAILS — the realistic case, and the expensive one. Monitor 0 is the
        // corpus's own recipient key, so at least one monitor also exercises the association
        // write path; a benchmark where nothing ever matched would be measuring only the
        // negative path.
        const serialized = i === 0
          ? corpus.keyBytes.get("K")!
          : await serializeKeyFromSeed(benchSeed(i));
        const key = await parseViewingKey(encodeViewingKey(serialized, NET), NET);
        await store.register({
          key, net: NET, requestedStartHeight: 0n,
          matchingRuleVersion: MATCHING_RULE_VERSION, ledgerBuild: LEDGER_BUILD_ID, actor: "bench",
        });
      }

      // Bound this row's work: each monitor scans a prefix long enough to be a stable rate
      // measurement and short enough to finish. The row reports what it actually scanned.
      const blocksForRow = Math.max(
        batchBlocks,
        Math.min(blocks, Math.ceil(maxEvals / (keys * txPerBlock))),
      );
      const metrics = new InMemoryScannerMetrics();
      const scanner = new ShieldedMonitorScanner(archive, store, { net: NET, batchBlocks, metrics });
      const service = new ShieldedMonitorScannerService(scanner, store, pgListenWake(sql), {
        net: NET, concurrency: 4, pollMs: 1000, maxMonitors: keys,
        maxBatchesPerMonitorPerCycle: Math.ceil(blocksForRow / batchBlocks),
      });

      if (global.gc !== undefined) global.gc();
      const started = Date.now();
      await service.runCycle();
      const wallMs = Date.now() - started;
      const snapshot = metrics.snapshot(NET);
      const rssMb = process.memoryUsage.rss() / 1024 / 1024;

      results.push({
        keys,
        blocks: snapshot.blocksScanned / keys,
        transactions: snapshot.transactionsScanned,
        aggregateTxPerSecond: (snapshot.transactionsScanned * 1000) / wallMs,
        txPerSecondPerKey: (snapshot.transactionsScanned * 1000) / wallMs / keys,
        matches: snapshot.matches,
        wallMs,
        rssMb: Math.round(rssMb * 10) / 10,
        peakRssMb: Math.round(peakRssMb * 10) / 10,
      });
      console.log(`[bench] keys=${keys} done in ${wallMs} ms`);
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${monitorSchema} CASCADE`);
    }

    clearInterval(sampleRss);
    await sql.end({ timeout: 5 });
  } finally {
    await container.stop();
  }

  console.log("");
  console.log("| keys | blocks scanned per key | tx scanned (all keys) | wall ms | aggregate tx/s | tx/s per key | matches | RSS MB | peak RSS MB |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(
      `| ${r.keys} | ${r.blocks} | ${r.transactions} | ${r.wallMs} | ` +
        `${r.aggregateTxPerSecond.toFixed(0)} | ${r.txPerSecondPerKey.toFixed(0)} | ${r.matches} | ` +
        `${r.rssMb} | ${r.peakRssMb} |`,
    );
  }
  console.log("");
  console.log(JSON.stringify({ harness: "shielded-monitor-scan/v1", results }, null, 2));
}

/**
 * One real serialized encryption secret key from a seed.
 *
 * The WASM comes from the scanner's OWN memoized loader (`shielded-monitor/offers.ts`), not from
 * the sync app's decoder: `bench/` drives UmbraDB's own adapters and must not import an
 * ingest/consumer application to generate load (the G14 boundary guard,
 * `test/postgres/no-consumer-import-in-bench.test.ts`). Sharing the scanner's memo also means the
 * bench measures one WASM instance, which is what the process under measurement actually has.
 */
async function serializeKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledger = (await loadLedger()) as any;
  return Uint8Array.from(
    ledger.ZswapSecretKeys.fromSeed(seed).encryptionSecretKey
      .yesIKnowTheSecurityImplicationsOfThis_serialize(),
  );
}

/** A distinct fixture seed per bench monitor. Test/bench-only: never a real key. */
function benchSeed(i: number): Uint8Array {
  const seed = new Uint8Array(32).fill((i % 250) + 3);
  seed[1] = (i >> 8) & 0xff;
  seed[2] = i & 0xff;
  return seed;
}

function benchHash(scope: string, height: number): string {
  let a = 0x811c_9dc5;
  for (const ch of `${scope}#${height}`) {
    a ^= ch.charCodeAt(0);
    a = Math.imul(a, 0x0100_0193) >>> 0;
  }
  return a.toString(16).padStart(8, "0").repeat(8);
}

await main();
