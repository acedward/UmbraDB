#!/usr/bin/env node
import { pgArchiveProgressEvents } from "../archive-read-api/events.js";
import { PgArchiveReadContract } from "../src/postgres/archive-read-contract.js";
import { createClient, type UmbraDBSql } from "../src/postgres/client.js";
import { stderrLogger } from "../archive-read-api/server.js";
import { bootstrapShieldedMonitorSchema } from "./bootstrap.js";
import { loadStorageApiConfig, STORAGE_API_ENV_DOC } from "./config.js";
import { PgShieldedMonitorStore } from "./monitor-store-pg.js";
import { createStorageApi } from "./server.js";

/**
 * `umbradb-storage-api` — the storage process as a bin (sub-plan 00009-08 v2; owner question
 * Q25; `spec/00009` FR-025/FR-026).
 *
 * The **only** process in a split deployment that holds a credential for the main database. The
 * scanner, the private API, the dashboard and the details backfill hold `STORAGE_URL` and
 * nothing else, and their entry points refuse to start if a `*_PG` variable is present at all.
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `ARCHIVE_PG` | `PG*` environment | connection string for the main database |
 * | `MONITOR_PG` | `ARCHIVE_PG` | project B's schema, normally the same database |
 * | `ARCHIVE_SCHEMA` | `chain_archive` | the archive's schema |
 * | `MONITOR_SCHEMA` | `shielded_monitor` | project B's schema |
 * | `STORAGE_BOOTSTRAP` | unset | `1` applies project B's migration lineage at boot |
 * | `NET` | `undeployed` | the one network this deployment serves |
 * | `STORAGE_HOST` | `127.0.0.1` | bind address |
 * | `STORAGE_PORT` | `8788` | bind port (`0` asks the kernel for a free one) |
 * | `STORAGE_MAX_BLOCKS` | `64` | whole blocks per archive page |
 * | `STORAGE_HEARTBEAT_MS` | `15000` | SSE heartbeat interval |
 * | `STORAGE_MAX_BODY` | `16777216` | monitor-store request body cap |
 *
 * **Unauthenticated and unencrypted by design** (lean alpha, owner decisions Q3 and Q10/Q25).
 * Registration carries a viewing key in the clear over this hop. Bind it to loopback or to a
 * private network; `docs/shielded-monitor-deployment.md` states what the TEE step adds here.
 *
 * It migrates only project B's lineage, and only when asked. The archive's lineage belongs to
 * `umbradb-archive-sync`.
 */
export async function runStorageApi(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  const config = loadStorageApiConfig(env);

  // One pool for the one main database (owner Q25). Two only when a deployment really has put
  // the two schemas on different servers, which the separate variables leave possible.
  const archiveSql = createClient({
    ...(config.archiveConnectionString === undefined ? {} : { connectionString: config.archiveConnectionString }),
    schema: config.archiveSchema,
    // The request pool plus the one dedicated LISTEN connection postgres.js takes for the
    // progress subscription.
    maxConnections: 10,
  });
  const separateMonitorDatabase =
    config.monitorConnectionString !== undefined &&
    config.monitorConnectionString !== config.archiveConnectionString;
  const monitorSql: UmbraDBSql = separateMonitorDatabase
    ? createClient({
        connectionString: config.monitorConnectionString!,
        schema: config.monitorSchema,
        maxConnections: 10,
      })
    : archiveSql;

  if (config.bootstrap) await bootstrapShieldedMonitorSchema(monitorSql, config.monitorSchema);

  const api = createStorageApi({
    config,
    store: new PgShieldedMonitorStore(monitorSql, config.monitorSchema),
    archive: {
      archive: new PgArchiveReadContract(archiveSql, config.archiveSchema),
      config: {
        host: config.host,
        port: config.port,
        net: config.net,
        schema: config.archiveSchema,
        maxBlocksPerPage: config.maxBlocksPerPage,
        sseHeartbeatMs: config.sseHeartbeatMs,
      },
      events: pgArchiveProgressEvents(archiveSql),
    },
    logger: stderrLogger(),
  });

  const address = await api.listen();
  process.stderr.write(
    `${JSON.stringify({
      at: new Date().toISOString(),
      event: "listening",
      host: address.host,
      port: address.port,
      net: config.net,
      archiveSchema: config.archiveSchema,
      monitorSchema: config.monitorSchema,
      databases: separateMonitorDatabase ? 2 : 1,
      authentication: "none (lean alpha, owner decision Q3) — restrict network access at the deployment",
      encryption: "none (owner Q10/Q25) — viewing keys travel in the clear on this hop",
    })}\n`,
  );

  return async () => {
    await api.close();
    if (separateMonitorDatabase) await monitorSql.end({ timeout: 5 });
    await archiveSql.end({ timeout: 5 });
  };
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  // eslint-disable-next-line no-console
  console.log(STORAGE_API_ENV_DOC);
  process.exit(0);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runStorageApi().then(
    (shutdown) => {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          void shutdown().then(
            () => process.exit(0),
            () => process.exit(1),
          );
        });
      }
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
