#!/usr/bin/env node
import { PgArchiveReadContract } from "../src/postgres/archive-read-contract.js";
import { createClient } from "../src/postgres/client.js";
import { ARCHIVE_READ_ENV_DOC, loadArchiveReadApiConfig } from "./config.js";
import { pgArchiveProgressEvents } from "./events.js";
import { createArchiveReadApi, stderrLogger } from "./server.js";

/**
 * `umbradb-archive-read-api` — the archive read contract as a process (organizer sub-plan
 * 00009-08; `spec/00009` FR-025/FR-026).
 *
 * A SEPARATE process from the ingester, like the scanner and the private API before it, and the
 * only one of the four that holds credentials for the archive's database in a split deployment.
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `ARCHIVE_PG` | `PG*` environment | PostgreSQL connection string for the ARCHIVE database |
 * | `ARCHIVE_SCHEMA` | `chain_archive` | the archive's schema |
 * | `NET` | `undeployed` | the one network this deployment serves |
 * | `ARCHIVE_READ_HOST` | `127.0.0.1` | bind address |
 * | `ARCHIVE_READ_PORT` | `8790` | bind port (`0` asks the kernel for a free one) |
 * | `ARCHIVE_READ_MAX_BLOCKS` | `64` | whole blocks per page (a larger `max` is clamped) |
 * | `ARCHIVE_READ_HEARTBEAT_MS` | `15000` | SSE heartbeat interval |
 *
 * **Unauthenticated by design** (lean alpha, owner decision Q3). Everything it serves is public
 * chain data; bind it to loopback or to a private network, and see
 * `docs/shielded-monitor-deployment.md` for what the TEE step adds here.
 *
 * It NEVER migrates. The archive's lineage belongs to `umbradb-archive-sync`; a read-only service
 * that could alter a schema would not be read-only.
 */
export async function runArchiveReadApi(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  const config = loadArchiveReadApiConfig(env);
  const sql = createClient({
    ...(config.connectionString === undefined ? {} : { connectionString: config.connectionString }),
    schema: config.schema,
    // The request pool plus the one dedicated LISTEN connection postgres.js takes for the
    // progress subscription.
    maxConnections: 6,
  });

  const api = createArchiveReadApi({
    archive: new PgArchiveReadContract(sql, config.schema),
    config,
    events: pgArchiveProgressEvents(sql),
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
      schema: config.schema,
      maxBlocksPerPage: config.maxBlocksPerPage,
      access: "read-only",
      authentication: "none (lean alpha, owner decision Q3) — restrict network access at the deployment",
    })}\n`,
  );

  return async () => {
    await api.close();
    await sql.end({ timeout: 5 });
  };
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  // eslint-disable-next-line no-console
  console.log(ARCHIVE_READ_ENV_DOC);
  process.exit(0);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runArchiveReadApi().then(
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
