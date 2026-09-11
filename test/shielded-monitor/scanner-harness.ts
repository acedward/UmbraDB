import { randomUUID } from "node:crypto";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PgArchiveReadContract } from "../../src/postgres/archive-read-contract.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import { bootstrapShieldedMonitorSchema } from "../../shielded-monitor/bootstrap.js";
import { LEDGER_BUILD_ID, MATCHING_RULE_VERSION } from "../../shielded-monitor/offers.js";
import { PgShieldedMonitorStore } from "../../shielded-monitor/store.js";
import { encodeViewingKey, parseViewingKey } from "../../shielded-monitor/viewing-key.js";
import { buildCorpus, type BuiltCorpus } from "../fixtures/shielded-monitor/build-corpus.js";

/**
 * Shared setup for the scanner's integration suites: both schemas in one container, the fixture
 * corpus archived through the REAL `putBlockBundle` (Rule A shape, watermark and NOTIFY
 * included), and monitors registered with the corpus's own keys.
 *
 * Not a test file. It exists so the scanner suite, the crash suite and the isolation suite build
 * the same world, and so "the archive the scanner reads" is always one produced by the archive's
 * own writer rather than by hand-inserted rows.
 */

export interface ScannerWorld {
  sql: UmbraDBSql;
  archiveSchema: string;
  monitorSchema: string;
  archive: PgArchiveReadContract;
  archiveStore: PgChainArchiveStore;
  store: PgShieldedMonitorStore;
  corpus: BuiltCorpus;
  /** Monitor id per corpus key id. */
  monitors: Map<string, string>;
}

export function uniqueSchemas(prefix: string): { archiveSchema: string; monitorSchema: string } {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  return { archiveSchema: `${prefix}_arc_${suffix}`, monitorSchema: `${prefix}_mon_${suffix}` };
}

/** Bootstraps both lineages and returns handles. Does NOT archive anything. */
export async function createWorldSchemas(
  container: StartedPostgreSqlContainer,
  prefix: string,
  opts: { net?: string; maxConnections?: number } = {},
): Promise<Omit<ScannerWorld, "corpus" | "monitors">> {
  const { archiveSchema, monitorSchema } = uniqueSchemas(prefix);
  const sql = createClient({
    connectionString: container.getConnectionUri(),
    schema: monitorSchema,
    maxConnections: opts.maxConnections ?? 8,
  });
  await runMigrations(sql, { schema: archiveSchema, migrations: chainArchiveMigrations });
  await bootstrapShieldedMonitorSchema(sql, monitorSchema);
  const archiveStore = new PgChainArchiveStore(sql, archiveSchema);
  // Mints the archive instance id the scanner binds monitors to (00009-01).
  await archiveStore.ensureArchiveInstanceId(opts.net ?? "undeployed");
  return {
    sql,
    archiveSchema,
    monitorSchema,
    archive: new PgArchiveReadContract(sql, archiveSchema),
    archiveStore,
    store: new PgShieldedMonitorStore(sql, monitorSchema),
  };
}

/** Archives the corpus blocks up to and including `throughHeight` (default: all of them). */
export async function archiveCorpusBlocks(
  world: Pick<ScannerWorld, "archiveStore">,
  corpus: BuiltCorpus,
  throughHeight = Number.POSITIVE_INFINITY,
): Promise<void> {
  for (const bundle of corpus.bundles) {
    if (bundle.block.height > throughHeight) continue;
    await world.archiveStore.putBlockBundle(bundle);
  }
}

/** Registers one monitor per corpus key, with the corpus's own serialized keys. */
export async function registerCorpusMonitors(
  store: PgShieldedMonitorStore,
  corpus: BuiltCorpus,
  opts: { startHeight?: bigint; net?: string } = {},
): Promise<Map<string, string>> {
  const net = opts.net ?? corpus.manifest.net;
  const monitors = new Map<string, string>();
  for (const key of corpus.manifest.keys) {
    const serialized = corpus.keyBytes.get(key.id)!;
    const viewingKey = await parseViewingKey(encodeViewingKey(serialized, net), net);
    const monitor = await store.register({
      key: viewingKey,
      net,
      requestedStartHeight: opts.startHeight ?? 0n,
      matchingRuleVersion: MATCHING_RULE_VERSION,
      ledgerBuild: LEDGER_BUILD_ID,
      actor: "scanner-test",
    });
    monitors.set(key.id, monitor.id);
  }
  return monitors;
}

/** The whole world: schemas, corpus archived, monitors registered. */
export async function createScannerWorld(
  container: StartedPostgreSqlContainer,
  prefix: string,
  opts: { startHeight?: bigint; archiveThrough?: number; maxConnections?: number } = {},
): Promise<ScannerWorld> {
  const corpus = await buildCorpus();
  const base = await createWorldSchemas(container, prefix, {
    net: corpus.manifest.net,
    ...(opts.maxConnections === undefined ? {} : { maxConnections: opts.maxConnections }),
  });
  await archiveCorpusBlocks(base, corpus, opts.archiveThrough ?? Number.POSITIVE_INFINITY);
  const monitors = await registerCorpusMonitors(base.store, corpus, {
    ...(opts.startHeight === undefined ? {} : { startHeight: opts.startHeight }),
  });
  return { ...base, corpus, monitors };
}

/** Tears down one world's schemas and its pool. */
export async function destroyWorld(world: Pick<ScannerWorld, "sql" | "archiveSchema" | "monitorSchema">): Promise<void> {
  await world.sql.unsafe(`DROP SCHEMA IF EXISTS ${world.monitorSchema} CASCADE`).catch(() => {});
  await world.sql.unsafe(`DROP SCHEMA IF EXISTS ${world.archiveSchema} CASCADE`).catch(() => {});
  await world.sql.end({ timeout: 5 });
}
