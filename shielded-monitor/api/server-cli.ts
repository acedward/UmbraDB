#!/usr/bin/env node
import { createClient } from "../../src/postgres/client.js";
import { bootstrapShieldedMonitorSchema } from "../bootstrap.js";
import { PgShieldedMonitorStore } from "../store.js";
import { loadApiConfig } from "./config.js";
import { createShieldedMonitorApi, stderrLogger } from "./server.js";

/**
 * `umbradb-shielded-monitor-api` — the private API as a process (organizer spec FR-026).
 *
 * A separate process from the archive ingester and from the scanner, sharing only the database.
 * Everything is configured through the environment, so the process needs no argument parsing and
 * a container image needs no entrypoint script:
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `SHIELDED_MONITOR_PG` | `PG*` environment | PostgreSQL connection string |
 * | `SHIELDED_MONITOR_SCHEMA` | `shielded_monitor` | schema project B owns |
 * | `SHIELDED_MONITOR_NET` | `undeployed` | the one network this deployment serves |
 * | `SHIELDED_MONITOR_BOOTSTRAP` | unset | `1` applies the migration lineage at boot |
 * | `API_HOST` | `127.0.0.1` | bind address |
 * | `API_PORT` | `8787` | bind port (`0` asks the kernel for a free one) |
 * | `API_MAX_BODY_BYTES` | `65536` | request body cap |
 * | `API_MAX_PAGE` | `200` | matches page cap |
 * | `API_DEFAULT_PAGE` | `50` | matches page size when the caller does not ask |
 *
 * **This API has no authentication** (owner decision Q3). The default bind is loopback and a
 * deployment that changes it must restrict network access itself — see `README.md` and
 * `docs/shielded-monitor-api.md`.
 */
export async function runApiServer(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  const config = loadApiConfig(env);
  const connectionString = env.SHIELDED_MONITOR_PG;
  const sql = createClient({
    ...(connectionString !== undefined ? { connectionString } : {}),
    schema: config.schema,
  });

  // Opt-in rather than automatic: a service that silently migrates on boot is a service that can
  // migrate a production database because someone started it with the wrong connection string.
  if (env.SHIELDED_MONITOR_BOOTSTRAP === "1") {
    await bootstrapShieldedMonitorSchema(sql, config.schema);
  }

  const api = createShieldedMonitorApi({
    store: new PgShieldedMonitorStore(sql, config.schema),
    config,
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
      authentication: "none (owner decision Q3) — restrict network access at the deployment",
    })}\n`,
  );

  return async () => {
    await api.close();
    await sql.end({ timeout: 5 });
  };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runApiServer().then(
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
      // The message only: a boot failure is a configuration or connection fault, and a stack
      // trace here is noise in a container log.
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
